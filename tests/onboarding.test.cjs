'use strict';
// node --test tests/*.test.cjs — first launch connects nothing (electron/onboarding.cjs): onboarding
// opens only on a brand-new install, existing installs are left alone, and what it offers matches
// what was found on the computer.
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

test('first launch on a new install opens onboarding and connects nothing', () => {
  onboarding.firstRun();
  assert.equal(onboarding.pending(), true);
  assert.equal(accountCount(), 0);
  assert.equal(db.getSetting('claudeAppSessions', true), false);
});

test('an install that already has accounts never sees onboarding and keeps its settings', () => {
  addAccount();
  onboarding.firstRun();
  assert.equal(onboarding.pending(), false);
  assert.equal(db.getSetting('claudeAppSessions', 'unset'), 'unset');
});

test('finishing onboarding is remembered, even if every account is removed later', () => {
  onboarding.firstRun();
  onboarding.finish();
  onboarding.firstRun();
  assert.equal(onboarding.pending(), false);
});

test('connecting an account during onboarding does not close it on the next launch', () => {
  onboarding.firstRun();
  addAccount();
  onboarding.firstRun();
  assert.equal(onboarding.pending(), true);
});

test('a Claude desktop app choice made before onboarding is kept', () => {
  db.setSetting('claudeAppSessions', true);
  onboarding.firstRun();
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
