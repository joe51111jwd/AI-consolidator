'use strict';
// node --test tests/*.test.cjs — first launch connects nothing (electron/onboarding.cjs): onboarding
// opens on a brand-new install and (while EVERY_BUILD is on) once per new build, never adds or
// removes accounts by itself, and what it offers matches what was found on the computer.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-onboarding-home-'));
process.env.HOME = HOME; // before util.cjs reads the home folder
process.env.USERPROFILE = HOME;
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require(path.join(__dirname, '..', 'electron', 'db.cjs'));
const onboarding = require(path.join(__dirname, '..', 'electron', 'onboarding.cjs'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

let n = 0;
beforeEach(() => db.open(path.join(HOME, `db-${n++}.sqlite`)));
const addAccount = () => db.exec("INSERT INTO accounts(id, kind, label, config) VALUES('a1', 'claude-code', 'Claude', '{}')");
const accountCount = () => db.get('SELECT COUNT(*) AS n FROM accounts').n;

// Each launch passes its build id; `once` is onboarding without EVERY_BUILD (only a brand-new install).
const launch = (build = 'b1') => onboarding.firstRun({ build, everyBuild: true });
const once = (build = 'b1') => onboarding.firstRun({ build, everyBuild: false });

test('first launch on a new install opens onboarding and connects nothing', () => {
  launch();
  assert.equal(onboarding.pending(), true);
  assert.equal(accountCount(), 0);
  assert.equal(db.getSetting('claudeAppSessions', true), false);
});

test('shown only on a new install: an install that already has accounts never sees it and keeps its settings', () => {
  addAccount();
  once();
  assert.equal(onboarding.pending(), false);
  assert.equal(db.getSetting('claudeAppSessions', 'unset'), 'unset');
});

test('finishing onboarding is remembered for that build, even if every account is removed later', () => {
  launch();
  onboarding.finish();
  launch();
  assert.equal(onboarding.pending(), false);
});

test('each new build opens onboarding again, keeping the accounts and the Claude desktop app setting', () => {
  addAccount();
  db.setSetting('claudeAppSessions', true);
  launch('b1');
  assert.equal(onboarding.pending(), true, 'the first build seen opens it, accounts or not');
  onboarding.finish();
  launch('b1');
  assert.equal(onboarding.pending(), false, 'a relaunch of the same build does not');
  launch('b2');
  assert.equal(onboarding.pending(), true, 'the next build does');
  assert.equal(accountCount(), 1);
  assert.equal(db.getSetting('claudeAppSessions', false), true);
});

test('shown only on a new install: a new build does not open it again', () => {
  once('b1');
  onboarding.finish();
  once('b2');
  assert.equal(onboarding.pending(), false);
});

test('a run with no build (npm run dev) does not open it again', () => {
  launch(null);
  onboarding.finish();
  launch(null);
  assert.equal(onboarding.pending(), false);
});

test('connecting an account during onboarding does not close it on the next launch', () => {
  launch();
  addAccount();
  launch();
  assert.equal(onboarding.pending(), true);
});

test('a Claude desktop app choice made before onboarding is kept', () => {
  db.setSetting('claudeAppSessions', true);
  launch();
  assert.equal(db.getSetting('claudeAppSessions', false), true);
});

test('nothing found offers nothing', () => {
  assert.deepEqual(onboarding.items({}), []);
  assert.deepEqual(onboarding.items({ claude: [], codex: false, granola: false, grokBot: false, claudeApp: false }), []);
});

test('every found source is offered with the account it would add', () => {
  const list = onboarding.items({ claude: ['~/.claude', '~/.claude-2'], codex: true, granola: true, grokBot: true, claudeApp: true });
  assert.deepEqual(list.map((i) => i.id), ['claude-code:~/.claude', 'claude-code:~/.claude-2', 'codex', 'granola', 'grok-bot', 'claude-app']);
  assert.deepEqual(list[0].account, { kind: 'claude-code', label: 'Claude', config: { configDir: '~/.claude' } });
  assert.equal(list[1].account.label, 'Claude 2');
  assert.equal(list[1].account.config.configDir, '~/.claude-2');
  assert.equal(list.find((i) => i.id === 'claude-app').setting, 'claudeAppSessions');
  assert.equal(list.find((i) => i.id === 'claude-app').account, undefined);
});
