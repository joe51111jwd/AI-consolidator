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
const { HOME, truncate, plain, run } = require('../util.cjs');
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
    lastActivityAt: r.lastActivityAt || 0, createdAt: r.createdAt || r.localActivityAt || 0,
    isGroup: !!r.isGroup, memberIds: Array.isArray(r.memberIds) ? r.memberIds.filter((m) => typeof m === 'string') : [],
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

// Bots the cache gives no avatar get a stable one from their id, in Grok's own palette and shapes.
const AVATAR_COLORS = ['#8B5CF6', '#F07A2E', '#EF4444', '#8B5E3C', '#EC4899', '#3B82F6', '#4ADE80', '#2DD4BF', '#F59E0B'];
const AVATAR_SHAPES = ['cloud', 'circle', 'gumdrop', 'egg', 'squircle', 'star', 'hexagon', 'bean'];
function idHash(id) {
  let h = 2166136261;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function avatarOf(b) {
  const h = idHash(b.id);
  return {
    color: hexColor(b.color) || AVATAR_COLORS[h % AVATAR_COLORS.length],
    shape: b.shape || AVATAR_SHAPES[Math.floor(h / AVATAR_COLORS.length) % AVATAR_SHAPES.length],
  };
}

// A group chat's roster name is a comma list that starts with the owner. Title it from the member
// bots instead, and give the board their avatars to cluster.
function groupInfo(b, byId) {
  const bots = b.memberIds.map((m) => byId.get(m)).filter(Boolean);
  const names = bots.map((m) => m.name);
  const fallback = String(b.name || '').split(',').map((x) => x.trim()).filter(Boolean);
  const title = names.length ? names.join(', ') : (fallback.length > 1 ? fallback.slice(1).join(', ') : b.name);
  return { title: title || 'Group chat', members: bots.slice(0, 4).map(avatarOf) };
}

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

// Claude Code runs a bot starts with the `claude` CLI on its own (cloud) computer. Grok Bot keeps no
// structured record of them, so they are read from what the bot says and does: a command line
// (`claude -p ...`, claude --print/--resume/--continue), a sentence about running Claude Code, or a
// Cursor agent titled for Claude. Plain mentions ("Claude's pricing page", "a note for Claude") are
// not runs. Entries that can carry private data (email drafts, forms, secret requests, connectors)
// are never read, and anything shaped like a key or token is masked.
const CLI_RUN_MS = 120000;
const PRIVATE_TYPES = new Set(['email-draft', 'email-offer', 'user-form', 'secret-request', 'onepassword-connect', 'connector', 'attachment']);
const CLI_CMD = /(?:^|[\s`$>(])(claude\s+(?:-p|--print|--resume|-r|--continue|-c|--model|--output-format|--permission-mode|--dangerously-skip-permissions)\b[^\n`]*)/i;
const CLI_TICK = /`(claude\s+[^`\n]+)`/i;
const CLI_SAY = /\b(?:run|runs|running|ran|start|starts|started|starting|kick(?:s|ed|ing)? off|launch(?:es|ed|ing)?|spun up|spin(?:ning)? up|fire[sd]? up|firing up|hand(?:ed|ing)? (?:it|this|that) (?:off )?to)\s+(?:up\s+)?(?:a\s+|an\s+|the\s+|my\s+)?(?:new\s+|fresh\s+)?Claude Code\b(?!['’]s)|\bClaude Code (?:is|was) (?:now )?(?:running|working|done|finished|building|fixing)\b|\bvia (?:the )?Claude (?:Code )?CLI\b/i;
const SECRETISH = /\b(?:sk|pk|rk|ghp|gho|xox[abp]|AKIA|AIza)[-_A-Za-z0-9]{12,}\b|\b[A-Za-z0-9+/_-]{32,}={0,2}\b|\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS))=\S+/g;
const mask = (t) => String(t || '').replace(SECRETISH, (m, name) => (name ? `${name}=•••` : '•••'));

function entryText(e) {
  if (e.kind === 'notice') return typeof e.text === 'string' ? e.text : '';
  if (e.kind === 'message') return e.role === 'user' ? '' : typeof e.content === 'string' ? e.content : textOf(e);
  if (e.kind === 'send-message') {
    const m = e.message || {};
    if (PRIVATE_TYPES.has(m.type)) return '';
    if (m.type === 'text') return textOf(m);
    if (m.type === 'cursor-agent') return typeof m.title === 'string' ? m.title : '';
    return '';
  }
  if (e.kind === 'event') {
    const ev = e.event || {};
    return ['command', 'text', 'title', 'summary', 'description'].map((k) => (typeof ev[k] === 'string' ? ev[k] : '')).filter(Boolean).join('\n');
  }
  return '';
}

function cliTitle(text) {
  const cmd = text.match(CLI_CMD) || text.match(CLI_TICK);
  if (cmd) {
    const line = cmd[1].trim();
    const quoted = line.match(/["“']([^"”']{4,})["”']/);
    return quoted ? quoted[1] : line;
  }
  const sentence = text.split(/(?<=[.!?])\s+|\n+/).find((x) => CLI_SAY.test(x)) || text;
  return sentence.trim();
}
const lastLine = (text) => (String(text || '').split('\n').map((x) => x.trim()).filter(Boolean).pop() || '');

function claudeRuns(entries, now = Date.now()) {
  const runs = [];
  let cur = null;
  for (const e of entries) {
    const text = entryText(e);
    const isAgent = e.kind === 'send-message' && e.message && e.message.type === 'cursor-agent';
    const hit = text && (CLI_CMD.test(text) || CLI_TICK.test(text) || CLI_SAY.test(text) || (isAgent && /\bclaude\b/i.test(text)));
    const ts = e.timestampMs || 0;
    if (hit) {
      cur = { id: `claude-cli:${e.id || e.seq}`, kind: 'claude-cli', title: truncate(mask(cliTitle(text)), 100) || 'Claude Code run', startedAt: ts, updatedAt: ts, lastText: '' };
      runs.push(cur);
      continue;
    }
    // Later bot lines (until the user speaks again) are that run's output.
    if (!cur) continue;
    if (e.kind === 'message' && e.role === 'user') { cur = null; continue; }
    if (text) { cur.lastText = truncate(mask(lastLine(text)), 160); cur.updatedAt = ts || cur.updatedAt; }
  }
  return runs.slice(-10).reverse().map((r) => ({
    id: r.id, kind: r.kind, title: r.title, updatedAt: r.updatedAt,
    status: now - r.updatedAt < CLI_RUN_MS ? 'running' : 'done', lastText: r.lastText || r.title,
  }));
}

// Only with SB_DEMO=1 and nothing real to show: one clearly-marked sample, so the layout is visible.
function sampleRun(now = Date.now()) {
  return { id: 'claude-cli:sample', kind: 'claude-cli', sample: true, title: 'Sample: claude -p "Tidy the pricing page copy"', updatedAt: now, status: 'running', lastText: 'Sample run (SB_DEMO=1): not a real Claude Code session' };
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
    const s = { id: r.id, kind: 'cursor-agent', title: r.name || r.branch || 'Cursor agent', status: done ? 'done' : 'running', updatedAt: r.lastActivityAt || 0, lastText };
    if (r.prUrl) s.prUrl = r.prUrl;
    if (!by.has(id)) by.set(id, []);
    by.get(id).push(s);
  }
  let found = false;
  for (const b of visible) {
    const cli = claudeRuns(replicas.get(b.id) || []);
    if (!cli.length) continue;
    found = true;
    if (!by.has(b.id)) by.set(b.id, []);
    by.get(b.id).push(...cli);
  }
  if (!found && process.env.SB_DEMO === '1' && visible[0]) {
    if (!by.has(visible[0].id)) by.set(visible[0].id, []);
    by.get(visible[0].id).push(sampleRun());
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
  const byId = new Map(all.map((b) => [b.id, b]));
  return visible.map((b) => {
    const entries = replicas.get(b.id) || [];
    const mine = subs.get(b.id) || [];
    // A Claude CLI run or Cursor agent the bot started counts as the bot working, as it does for
    // Claude Code sessions with live subagents.
    const running = !b.awaiting && ((now - (b.lastActivityAt || 0) < 60000 && b.lastKind !== 'message') || mine.some((x) => x.status === 'running'));
    // Never used, or nothing recorded since: no activity time. Kept off the board and Live (the
    // cache gives these updatedAt 0, which would show as Jan 1).
    const unused = !b.lastActivityAt;
    const av = avatarOf(b);
    const group = b.isGroup ? groupInfo(b, byId) : null;
    const live = !b.awaiting && mine.find((x) => x.status === 'running');
    const act = live ? { text: truncate(`${live.kind === 'claude-cli' ? 'Running Claude Code' : 'Cursor agent'} · ${live.title}`, 140), tool: live.kind, running: true } : activity(b, entries, running);
    return {
      id: `gb:${account.id}:${b.id}`, kind: 'session', source: 'grok-bot', accountId: account.id,
      title: group ? group.title : b.name, preview: truncate(plain(b.lastText || b.description), 220), updatedAt: b.lastActivityAt || b.createdAt || 0,
      status: b.awaiting ? 'waiting' : running ? 'running' : 'idle',
      meta: {
        agentId: b.id, description: b.description, unread: b.unread, color: b.color, category: 'chat',
        avatarColor: av.color, avatarShape: av.shape, avatarDerived: !hexColor(b.color) || !b.shape,
        lastActivityAt: b.lastActivityAt || 0, createdAt: b.createdAt || 0,
        ...(unused ? { unused: true, noise: true } : {}),
        ...(group ? { isGroup: true, members: group.members } : {}),
        activity: act, actions: actions(entries), subagents: mine,
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

module.exports = { PERSIST, claudeRuns, status, bots, cloudRuns, selectedAgent, transcript, list, send, openBot, enabled, MAX_TEXT };
