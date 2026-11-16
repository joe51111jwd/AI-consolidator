'use strict';
// First launch connects nothing. Onboarding lists what is on this computer and connects only what the
// person picks; until they turn it on, the Claude desktop app's sessions stay off too.
const fs = require('fs');
const path = require('path');
const db = require('./db.cjs');

const PENDING = 'onboardingPending';
const BUILD = 'onboardingBuild';

// While the app is being built: every new build opens Welcome (and then the tour) again, as a new
// person would see it, without touching connected accounts. Set to false to show it only on a
// brand-new install.
const EVERY_BUILD = true;

// The id `npm run build` stamps into dist-renderer/build.json (see vite.config.mjs). A run with no
// build (npm run dev) has none. SB_TEST_BUILD_ID stands in for a new build in the e2e tests.
function buildId() {
  if (process.env.SB_TEST_BUILD_ID) return process.env.SB_TEST_BUILD_ID;
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dist-renderer', 'build.json'), 'utf8')).id || null; } catch { return null; }
}

// Runs on every launch. Onboarding opens on a brand-new install (no accounts, never onboarded) and,
// with EVERY_BUILD, the first time each new build opens. Accounts are never added or removed here,
// and the Claude desktop app setting is only changed on a brand-new install.
function firstRun({ build = buildId(), everyBuild = EVERY_BUILD } = {}) {
  if (db.getSetting(PENDING, null) === null) {
    const fresh = db.get('SELECT COUNT(*) AS n FROM accounts').n === 0;
    db.setSetting(PENDING, fresh);
    if (fresh && db.getSetting('claudeAppSessions', null) === null) db.setSetting('claudeAppSessions', false);
  }
  if (everyBuild && build && db.getSetting(BUILD, null) !== build) {
    db.setSetting(BUILD, build);
    db.setSetting(PENDING, true);
  }
}

const pending = () => db.getSetting(PENDING, false) === true;
const finish = () => db.setSetting(PENDING, false);

// What onboarding offers, from what was found: { claude: ['~/.claude', ...], codex, granola, grokBot, claudeApp }.
// Each item carries the account to save when the person clicks Connect (or the setting to turn on).
function items(found) {
  const out = (found.claude || []).map((dir, i) => ({
    id: `claude-code:${dir}`, kind: 'claude-code', label: i === 0 ? 'Claude Code' : `Claude Code ${i + 1}`, detail: dir,
    account: { kind: 'claude-code', label: i === 0 ? 'Claude' : `Claude ${i + 1}`, config: { configDir: dir } },
  }));
  if (found.codex) out.push({ id: 'codex', kind: 'codex', label: 'Codex', detail: '~/.codex', account: { kind: 'codex', label: 'Codex', config: {} } });
  if (found.granola) out.push({ id: 'granola', kind: 'granola', label: 'Granola', detail: 'Meeting notes', account: { kind: 'granola', label: 'Granola', config: {} } });
  if (found.grokBot) out.push({ id: 'grok-bot', kind: 'grok-bot', label: 'Grok Bot', detail: 'Mac app', account: { kind: 'grok-bot', label: 'Grok Bot', config: {} } });
  if (found.claudeApp) out.push({ id: 'claude-app', kind: 'claude-app', label: 'Claude desktop app', detail: 'Agent sessions, read-only', setting: 'claudeAppSessions' });
  return out;
}

module.exports = { PENDING, BUILD, EVERY_BUILD, buildId, firstRun, pending, finish, items };
