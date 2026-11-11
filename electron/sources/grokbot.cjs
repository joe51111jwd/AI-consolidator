'use strict';
// Grok Bot (Cursor's desktop app for cloud bots). It has no local API, so:
// - Reading: the app keeps a plain-JSON cache of every bot and its conversation in
//   ~/Library/Application Support/Grok Bot/sand-client-persistence/<base32(key)>.blob.
//   Only the roster, cloud-agent runs and transcript replicas are read; every other key
//   (and the app's secrets, cookies and tokens) is never opened.
// - Sending: the app's own grokbot://app/v1/prompt link opens a bot with the text in its message
//   box, then a Return keypress (System Events, needs Accessibility permission) sends it.
const fs = require('fs');
const path = require('path');
const { HOME, truncate, run } = require('../util.cjs');
const db = require('../db.cjs');

const APP_SUPPORT = path.join(HOME, 'Library', 'Application Support', 'Grok Bot');
const PERSIST = path.join(APP_SUPPORT, 'sand-client-persistence');
const STATUS_FILE = path.join(APP_SUPPORT, 'desktop-status.json');
const MAX_TEXT = 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const WANTED = /\.roster\.last-roster$|\.cloud-agents\.infos$|\.transcript\.replicas\.[A-Za-z0-9_-]+$|\.selection\.last-agent$|\.send-journal$/;

const enabled = () => db.getSetting('grokEnabled', true) !== false;

function base32decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0; const out = [];
  for (const ch of s.toUpperCase()) {
    const i = A.indexOf(ch); if (i < 0) return null;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out).toString('utf8');
}

// key -> file, for the keys we read. Rebuilt when the folder changes (cheap: names only).
let index = { at: 0, keys: new Map() };
function keys() {
  if (Date.now() - index.at < 1500) return index.keys;
  const m = new Map();
  let names = [];
  try { names = fs.readdirSync(PERSIST); } catch {}
  for (const n of names) {
    if (!n.endsWith('.blob')) continue;
    const key = base32decode(n.slice(0, -5));
    if (key && WANTED.test(key)) m.set(key, path.join(PERSIST, n));
  }
  index = { at: Date.now(), keys: m };
  return m;
}

const cache = new Map(); // file -> { mtimeMs, value }
function readKey(suffixRe) {
  for (const [k, f] of keys()) {
    if (!suffixRe.test(k)) continue;
    try {
      const st = fs.statSync(f);
      const hit = cache.get(f);
      if (hit && hit.mtimeMs === st.mtimeMs) return hit.value;
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      // Versions differ per key (roster is 4, others 1); shapes are checked where they are read.
      if (!j || typeof j.schemaVersion !== 'number' || !j.value || typeof j.value !== 'object') return null;
      cache.set(f, { mtimeMs: st.mtimeMs, value: j.value });
      return j.value;
    } catch { return null; }
  }
  return null;
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function status() {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch {}
  const installed = fs.existsSync('/Applications/Grok Bot.app') || fs.existsSync(path.join(HOME, 'Applications', 'Grok Bot.app')) || fs.existsSync(APP_SUPPORT);
  const roster = readKey(/\.roster\.last-roster$/);
  return {
    enabled: enabled(), installed,
    running: !!(s && s.pid && pidAlive(s.pid)),
    signedIn: !!(s && s.signedIn), appVersion: (s && s.appVersion) || null,
    bots: roster && Array.isArray(roster.rows) ? roster.rows.filter((r) => !r.isRemovedFromSidebar).length : 0,
    cache: fs.existsSync(PERSIST),
  };
}

function bots() {
  const roster = readKey(/\.roster\.last-roster$/);
  const rows = roster && Array.isArray(roster.rows) ? roster.rows : [];
  return rows.filter((r) => r && r.id && !r.isRemovedFromSidebar).map((r) => ({
    id: r.id, name: r.name || 'Grok bot', description: r.description || '', color: r.avatarColor || null,
    lastText: r.lastEntry && typeof r.lastEntry.text === 'string' ? r.lastEntry.text : '',
    lastKind: r.lastEntry ? r.lastEntry.kind : null,
    unread: r.unreadCount || 0, awaiting: !!r.awaitingUserResponse, hidden: !!r.isHiddenFromSidebar,
    lastActivityAt: r.lastActivityAt || 0,
  }));
}

function cloudRuns() {
  const v = readKey(/\.cloud-agents\.infos$/);
  return (v && Array.isArray(v.entries) ? v.entries : []).map((e) => e && e.info).filter(Boolean).map((i) => ({
    id: i.bcId, name: i.name, status: i.status, branch: i.branchName, prUrl: i.prUrl, prState: i.prState, prNumber: i.prNumber,
    filesChanged: i.filesChanged, linesAdded: i.linesAdded, linesRemoved: i.linesRemoved, lastActivityAt: i.lastActivityAtMs || 0,
  }));
}

function selectedAgent() { const v = readKey(/\.selection\.last-agent$/); return v && v.agentId ? v.agentId : null; }

function textOf(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (c && typeof c.text === 'string') return c.text;
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : b && typeof b.text === 'string' ? b.text : '')).join('');
  return '';
}

function replica(agentId) {
  if (!ID_RE.test(agentId || '')) return [];
  const esc = agentId.replace(/[-]/g, '\\-');
  const v = readKey(new RegExp(`\\.transcript\\.replicas\\.${esc}$`));
  return v && Array.isArray(v.entries) ? v.entries : [];
}

// Only plain text messages are shown. Email drafts, forms, secret requests and other widgets
// can hold sensitive data, so they appear as a one-line placeholder.
function transcript(agentId, limit = 200) {
  const out = [];
  for (const e of replica(agentId)) {
    if (e.kind !== 'send-message' && e.kind !== 'message') continue;
    const type = e.message && e.message.type;
    const text = type === 'text' ? textOf(e.message) : `[${type || 'item'}]`;
    if (!text) continue;
    out.push({ id: e.id || String(e.seq), role: e.kind === 'send-message' ? 'user' : 'assistant', text, ts: e.timestampMs || 0, kind: type === 'text' ? undefined : 'tool' });
  }
  return out.slice(-limit);
}

function list(account) {
  if (!enabled()) return [];
  const now = Date.now();
  return bots().filter((b) => !b.hidden).map((b) => ({
    id: `gb:${account.id}:${b.id}`, kind: 'session', source: 'grok-bot', accountId: account.id,
    title: b.name, preview: truncate(b.lastText || b.description, 220), updatedAt: b.lastActivityAt || 0,
    status: b.awaiting ? 'waiting' : now - (b.lastActivityAt || 0) < 60000 && b.lastKind !== 'message' ? 'running' : 'idle',
    meta: { agentId: b.id, description: b.description, unread: b.unread, color: b.color, category: 'chat' },
  }));
}

function link(p) { return `grokbot://app${p}`; }
function open(url) {
  if (process.env.SB_TEST_OPEN_LOG) { fs.appendFileSync(process.env.SB_TEST_OPEN_LOG, url + '\n'); return Promise.resolve(); }
  return run('open', [url]).then((r) => { if (r.code !== 0) throw new Error(truncate(r.stderr || 'Grok Bot did not open', 200)); });
}
function openBot(agentId) { return open(ID_RE.test(agentId || '') ? link(`/v1/agent?id=${agentId}`) : link('/v1/open')); }

const sentCount = (agentId) => replica(agentId).filter((e) => e.kind === 'send-message').length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Puts the text in the bot's message box and (unless prefillOnly or the "Press Return for me"
// setting is off) presses Return in Grok Bot, then checks the bot's transcript for the new message.
async function send(agentId, text, { prefillOnly } = {}) {
  if (!enabled()) throw new Error('The Grok Bot connection is off. Turn it on in Accounts.');
  const name = (bots().find((b) => b.id === agentId) || {}).name || 'the bot';
  if (!ID_RE.test(agentId || '')) throw new Error('Pick a Grok bot card to send to (each bot has its own card).');
  const body = String(text || '').trim();
  if (!body) throw new Error('Nothing to send');
  if (body.length > MAX_TEXT) {
    await openBot(agentId);
    return { text: `That message is ${body.length} characters. Grok Bot only accepts up to ${MAX_TEXT} from another app, so nothing was sent. Opened ${name} in Grok Bot: shorten it, or paste it there yourself.` };
  }
  const st = status();
  const before = sentCount(agentId);
  await open(link(`/v1/prompt?id=${agentId}&text=${encodeURIComponent(body)}`));
  const autoSend = !prefillOnly && db.getSetting('grokAutoSend', true) !== false;
  if (!autoSend) return { text: `Put it in ${name}'s message box in Grok Bot. Press Return there to send.` };
  if (!st.running) return { text: `Grok Bot was not running, so it is opening with the message in ${name}'s box. Press Return there to send.` };
  if (process.platform !== 'darwin' || process.env.SB_TEST_OPEN_LOG) return { text: `Put it in ${name}'s message box in Grok Bot.` };
  await sleep(700);
  const r = await run('osascript', ['-e', 'tell application "Grok Bot" to activate', '-e', 'delay 0.3', '-e', 'tell application "System Events" to keystroke return']).catch((e) => ({ code: 1, stderr: e.message }));
  if (r.code !== 0) {
    return { text: `Put it in ${name}'s message box, but Switchboard can't press Return yet. Allow Switchboard in System Settings → Privacy & Security → Accessibility, or press Return in Grok Bot yourself.` };
  }
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    index.at = 0;
    if (sentCount(agentId) > before) return { text: `Sent to ${name} in Grok Bot. Its reply will show on the card.` };
  }
  return { text: `Pressed Return in Grok Bot but couldn't confirm ${name} got it. If the bot already had a draft, Grok Bot keeps that draft instead: check the app.` };
}

module.exports = { PERSIST, status, bots, cloudRuns, selectedAgent, transcript, list, send, openBot, enabled, MAX_TEXT };
