'use strict';
// First launch connects nothing. Onboarding lists what is on this computer and connects only what the
// person picks; until they turn it on, the Claude desktop app's sessions stay off too.
const db = require('./db.cjs');

const PENDING = 'onboardingPending';

// Runs on every launch; only the very first one (no accounts, never onboarded) opens onboarding.
// Installs that already have accounts are left exactly as they were.
function firstRun() {
  if (db.getSetting(PENDING, null) !== null) return;
  const fresh = db.get('SELECT COUNT(*) AS n FROM accounts').n === 0;
  db.setSetting(PENDING, fresh);
  if (fresh && db.getSetting('claudeAppSessions', null) === null) db.setSetting('claudeAppSessions', false);
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

module.exports = { PENDING, firstRun, pending, finish, items };
