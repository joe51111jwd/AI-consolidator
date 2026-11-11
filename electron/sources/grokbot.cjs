'use strict';
// Grok Bot (Cursor's desktop app for cloud bots). It has no local API, so:
// - Reading: the app keeps a plain-JSON cache of every bot and its conversation in
//   ~/Library/Application Support/Grok Bot/sand-client-persistence/<base32(key)>.blob.
//   Only the roster, cloud-agent runs and transcript replicas are read; every other key
//   (and the app's secrets, cookies and tokens) is never opened.
// - Sending: the app's own grokbot://app/v1/prompt link opens a bot with the text in its message
//   box (opened with `open -g`, so it stays in the background), then a Return keypress (System
//   Events, needs Accessibility permission) sends it: Grok Bot comes forward for that keypress
//   only, is hidden again, and focus goes back to the app that had it. Sending with no window
//   flash at all needs an MCP connector in Grok Bot plus a tunnel (not built yet).
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
    id: r.id, name: r.name || 'Grok bot', description: r.description || '', color: r.avatarColor || null, shape: typeof r.avatarShape === 'string' ? r.avatarShape : null,
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

// 'send-message' entries are the bot talking (text or a widget); 'message' entries carry a role
// and plain string content. Only plain text is shown. Email drafts, forms, secret requests and
// other widgets can hold sensitive data, so they appear as a one-line label.
const WIDGET_LABEL = {
  'email-draft': 'Drafted an email', 'email-offer': 'Offered to send an email', 'user-form': 'Asked you to fill a form',
  'secret-request': 'Asked for a secret', 'onepassword-connect': 'Asked to connect 1Password', connector: 'Used a connector',
  'cursor-agent': 'Started a Cursor agent', attachment: 'Sent a file', widget: 'Showed a widget',
};
const WIDGET_KIND = { connector: 'connector', 'onepassword-connect': 'connector', 'cursor-agent': 'agent' };
const COLORS = {
  black: '#1F1F1F', white: '#E8E8E8', gray: '#8A8A8A', grey: '#8A8A8A', red: '#E5484D', orange: '#F76B15', yellow: '#F5C400',
  green: '#30A46C', teal: '#12A594', cyan: '#00A2C7', blue: '#3E63DD', indigo: '#5B5BD6', purple: '#8E4EC6', violet: '#6E56CF',
  magenta: '#D6409F', pink: '#E93D82', brown: '#A18072',
};
const hexColor = (c) => (typeof c !== 'string' || !c ? null : /^#[0-9a-f]{3,8}$/i.test(c) ? c : COLORS[c.toLowerCase()] || null);

function describe(e) {
  if (e.kind === 'message') {
    const text = typeof e.content === 'string' ? e.content : textOf(e);
    return text ? { kind: 'message', role: e.role === 'user' ? 'user' : 'assistant', text } : null;
  }
  if (e.kind === 'send-message') {
    const type = e.message && e.message.type;
    if (type === 'text') { const text = textOf(e.message); return text ? { kind: 'message', role: 'assistant', text } : null; }
    const label = WIDGET_LABEL[type] || (type ? `Used ${String(type).replace(/-/g, ' ')}` : 'Did something');
    const title = type === 'cursor-agent' && typeof e.message.title === 'string' ? `: ${e.message.title}` : '';
    return { kind: WIDGET_KIND[type] || 'tool', role: 'assistant', text: label + title, tool: type, bcId: type === 'cursor-agent' ? e.message.bcId : undefined };
  }
  if (e.kind === 'event') {
    const ev = e.event || {};
    const text = ev.type === 'automation-changed' ? `${ev.action || 'Changed'} automation${ev.automationName ? ` ${ev.automationName}` : ''}` : String(ev.type || 'event').replace(/-/g, ' ');
    return { kind: 'event', role: 'assistant', text };
  }
  if (e.kind === 'notice' && typeof e.text === 'string') return { kind: 'notice', role: 'assistant', text: e.text };
  if (e.kind === 'user-attachment') return { kind: 'message', role: 'user', text: 'Attached a file' };
  if (e.kind === 'voice-call') return { kind: 'event', role: 'assistant', text: 'Voice call' };
  return null;
}

function transcript(agentId, limit = 200) {
  const out = [];
  for (const e of replica(agentId)) {
    if (e.kind !== 'send-message' && e.kind !== 'message') continue;
    const d = describe(e);
    if (!d) continue;
    out.push({ id: e.id || String(e.seq), role: d.role, text: d.kind === 'message' ? d.text : `[${d.text}]`, ts: e.timestampMs || 0, kind: d.kind === 'message' ? undefined : 'tool' });
  }
  return out.slice(-limit);
}

function actions(entries) {
  const out = [];
  for (let i = entries.length - 1; i >= 0 && out.length < 15; i--) {
    const d = describe(entries[i]);
    if (!d) continue;
    out.push({ kind: d.kind, text: truncate(d.role === 'user' ? `You: ${d.text}` : d.text, 200), ts: entries[i].timestampMs || 0 });
  }
  return out;
}

function activity(b, entries, running) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const d = describe(entries[i]);
    if (!d || d.kind === 'notice') continue;
    if (b.awaiting) return { text: d.kind === 'message' ? truncate(d.text, 140) : `Waiting on you: ${d.text}`, tool: d.tool, running: false };
    if (d.role === 'user') return { text: running ? 'Working on your message' : 'Read your message', running };
    return { text: truncate(d.text, 140), tool: d.tool, running };
  }
  return { text: b.description ? truncate(b.description, 140) : 'Idle', running };
}

// Cursor agent runs belong to the bot whose chat started them; any others go to the first bot.
function subagentsByBot(visible, replicas) {
  const owner = new Map();
  for (const b of visible) for (const e of replicas.get(b.id) || []) {
    const t = e.kind === 'send-message' && e.message && e.message.type === 'cursor-agent' ? e.message.bcId : null;
    if (t) owner.set(t, b.id);
  }
  const by = new Map();
  for (const r of cloudRuns()) {
    if (!r.id) continue;
    const id = owner.get(r.id) || (visible[0] && visible[0].id);
    if (!id) continue;
    const done = r.status !== 'running';
    const lastText = r.status === 'error' ? 'Failed' : done && r.filesChanged != null ? `${r.filesChanged} files · +${r.linesAdded || 0} −${r.linesRemoved || 0}` : done ? 'Finished' : 'Working';
    const s = { id: r.id, title: r.name || r.branch || 'Cursor agent', status: done ? 'done' : 'running', updatedAt: r.lastActivityAt || 0, lastText };
    if (r.prUrl) s.prUrl = r.prUrl;
    if (!by.has(id)) by.set(id, []);
    by.get(id).push(s);
  }
  for (const list of by.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
  return by;
}

function list(account) {
  if (!enabled()) return [];
  const now = Date.now();
  const all = bots();
  const visible = all.filter((b) => !b.hidden);
  const replicas = new Map(all.map((b) => [b.id, replica(b.id)]));
  const subs = subagentsByBot(visible, replicas);
  return visible.map((b) => {
    const entries = replicas.get(b.id) || [];
    const running = !b.awaiting && now - (b.lastActivityAt || 0) < 60000 && b.lastKind !== 'message';
    return {
      id: `gb:${account.id}:${b.id}`, kind: 'session', source: 'grok-bot', accountId: account.id,
      title: b.name, preview: truncate(b.lastText || b.description, 220), updatedAt: b.lastActivityAt || 0,
      status: b.awaiting ? 'waiting' : running ? 'running' : 'idle',
      meta: {
        agentId: b.id, description: b.description, unread: b.unread, color: b.color, category: 'chat',
        avatarColor: hexColor(b.color) || undefined, avatarShape: b.shape || undefined,
        activity: activity(b, entries, running), actions: actions(entries), subagents: subs.get(b.id) || [],
      },
    };
  });
}

function link(p) { return `grokbot://app${p}`; }
function open(url) {
  if (process.env.SB_TEST_OPEN_LOG) { fs.appendFileSync(process.env.SB_TEST_OPEN_LOG, url + '\n'); return Promise.resolve(); }
  return run('open', ['-g', url]).then((r) => { if (r.code !== 0) throw new Error(truncate(r.stderr || 'Grok Bot did not open', 200)); });
}
function openBot(agentId) { return open(ID_RE.test(agentId || '') ? link(`/v1/agent?id=${agentId}`) : link('/v1/open')); }

const sentCount = (agentId) => replica(agentId).filter((e) => e.kind === 'message' && e.role === 'user').length;
const PRESS_RETURN = `
set prev to ""
try
  tell application "System Events" to set prev to name of first application process whose frontmost is true
end try
tell application "Grok Bot" to activate
delay 0.3
tell application "System Events" to keystroke return
delay 0.15
try
  tell application "System Events" to set visible of process "Grok Bot" to false
end try
if prev is not "" and prev is not "Grok Bot" then
  try
    tell application "System Events" to set frontmost of process prev to true
  end try
end if`;
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
  const r = await run('osascript', ['-e', PRESS_RETURN]).catch((e) => ({ code: 1, stderr: e.message }));
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
