'use strict';
// Notifications: tells the owner when something needs them, so they never go check each app.
// - A chat finished a reply (a Switchboard run, or a chat going from working to idle on its own).
// - A chat is waiting on the owner (or failed).
// - A Grok bot (or another agent reporting to the relay) posted something new: a message, an output.
// - Something new landed in the to-do (a reply owed, a follow-up, a client's next step).
// Nothing shows for the chat that's open while Switchboard is in front, and, with "Only when
// Switchboard isn't in front", nothing at all while it is. Events are gathered for a moment and
// shown together ("3 chats finished"), at most one notification per card per minute. Clicking one
// brings the window forward and opens that card. The Dock badge shows the window's attention count
// (renderer/src/lib/attention.ts), which the window reports with 'notify:state'.
// SB_TEST_NOTIFY_LOG=<file>: tests log what would be shown there (one JSON line each) instead.
const fs = require('fs');
const { app, BrowserWindow, Notification } = require('electron');
const { truncate, uid } = require('../util.cjs');

const KEY = 'notifications';
const DEFAULTS = { finished: true, waiting: true, grok: true, todo: true, onlyAway: false, badge: true };
const KINDS = ['finished', 'waiting', 'grok', 'todo'];
const RANK = { waiting: 0, grok: 1, finished: 2, todo: 3 }; // which one a card keeps when several land at once
const BATCH_MS = Number(process.env.SB_NOTIFY_BATCH_MS) || 2000;
const COOLDOWN_MS = 60000; // at most one notification per card per minute
const RECENT_MS = 10 * 60000; // a card seen for the first time only counts if it changed this recently
const DUE_EVERY_MS = 120000;
const DUE_MIN_GAP_MS = 60000;
const POLL_MS = 20000; // look at the cards ourselves if nothing else has for this long (window closed)
const LOG = process.env.SB_TEST_NOTIFY_LOG || '';

let ctx = null;
let snap = null; // card id -> what it looked like last time
let outputsSeen = null;
let dueSeen = null;
let dueAt = 0;
let builtAt = 0;
let pending = new Map(); // card id -> event, until the batch is shown
let timer = null;
const lastShown = new Map(); // card id -> when it was last in a notification
const recent = []; // newest first: what was shown, for clicks (and tests)
const live = new Map(); // key -> Notification, kept so clicks still arrive after garbage collection
const runsDone = new Set();
let openCard = null; // the card open in the window, as the window reports it
let attention = 0;
let badge = null;
let pendingOpen = null; // a card to open once a new window has loaded
let testFront = null;

// ---------- settings ----------
function prefs() {
  const v = ctx ? ctx.db.getSetting(KEY, {}) : {};
  return { ...DEFAULTS, ...(v && typeof v === 'object' ? v : {}) };
}
function setPrefs(patch) {
  const next = { ...prefs() };
  for (const [k, v] of Object.entries(patch || {})) if (k in DEFAULTS) next[k] = !!v;
  ctx.db.setSetting(KEY, next);
  applyBadge();
  return next;
}

// ---------- Dock badge ----------
function applyBadge() {
  const n = prefs().badge ? attention : 0;
  if (n === badge) return;
  badge = n;
  let ok = false;
  try { ok = app.setBadgeCount(n); } catch {}
  if (!ok && process.platform === 'darwin' && app.dock) { try { app.dock.setBadge(n ? String(n) : ''); } catch {} }
}

// ---------- is the owner looking? ----------
function front() {
  if (testFront !== null) return testFront;
  const w = BrowserWindow.getFocusedWindow();
  return !!(w && !w.isDestroyed() && w.isVisible() && !w.isMinimized());
}

// ---------- what changed on the cards ----------
// One plain line: no Markdown headings, quotes, bullets, bold or code marks.
const clean = (t) => String(t || '').replace(/^[ \t]*(?:#+|>|[-*+]|\d+\.)[ \t]+/gm, '').replace(/[`*]+/g, '').replace(/\s+/g, ' ').trim();
// Grok bots (from Grok Bot on this Mac or the relay) post; other agents on the relay are chats.
const isBot = (e) => e.source === 'grok-bot';
const reports = (e) => isBot(e) || String(e.id).startsWith('rl:');
const mine = (t) => /^You: /.test(t || '');

// The newest message a bot wrote itself (its own steps, your messages and pick-ups don't count).
function botPost(e) {
  let ts = 0; let text = '';
  for (const a of (e.meta && e.meta.actions) || []) {
    if (!a || a.kind !== 'message' || typeof a.text !== 'string' || mine(a.text) || /^Picked up /.test(a.text)) continue;
    if ((Number(a.ts) || 0) > ts) { ts = Number(a.ts) || 0; text = a.text; }
  }
  return { ts, text };
}

function shape(e, now) {
  const m = e.meta || {};
  const bot = isBot(e);
  const post = bot ? botPost(e) : { ts: 0, text: '' };
  return { status: e.status || 'idle', updatedAt: Number(e.updatedAt) || 0, preview: String(e.preview || ''), unread: Number(m.unread) || 0, bot, postTs: post.ts, postText: post.text, seen: now };
}

function detail(e) {
  const m = e.meta || {};
  return clean((m.activity && m.activity.text) || e.preview || '');
}

function changes(e, prev, cur, now) {
  const name = e.title || 'A chat';
  const waiting = (s) => s === 'waiting' || s === 'error';
  const waitEv = () => ({ kind: 'waiting', card: e.id, open: e.id, name, error: cur.status === 'error', body: detail(e) });
  const postEv = (text) => ({ kind: 'grok', card: e.id, open: e.id, name, body: clean(text) || detail(e) });
  if (!prev) {
    // A card that just appeared (a new chat, or a bot first reporting to the relay).
    if (now - cur.updatedAt > RECENT_MS) return null;
    if (waiting(cur.status)) return waitEv();
    if (cur.bot && cur.postTs && now - cur.postTs < RECENT_MS) return postEv(cur.postText);
    return null;
  }
  if (waiting(cur.status) && cur.status !== prev.status) return waitEv();
  if (cur.bot) {
    if (cur.postTs > prev.postTs) return postEv(cur.postText);
    if (cur.unread > prev.unread && cur.updatedAt > prev.updatedAt) return postEv(cur.preview);
    if (prev.status === 'running' && cur.status === 'idle' && cur.preview && cur.preview !== prev.preview && !mine(cur.preview)) return postEv(cur.preview);
    return null;
  }
  if (prev.status === 'running' && cur.status === 'idle') return { kind: 'finished', card: e.id, open: e.id, name, body: clean(e.preview) };
  return null;
}

function observe(list) {
  const now = Date.now();
  builtAt = now;
  const first = !snap;
  const next = new Map(snap || []);
  const outs = new Set();
  const agents = new Map();
  const events = [];
  for (const e of list) {
    if (!e || !e.id) continue;
    if (e.kind === 'output') { outs.add(e.id); continue; }
    if (e.kind !== 'session' || (e.meta && (e.meta.noise || e.meta.unused))) continue;
    const cur = shape(e, now);
    if (reports(e)) agents.set(e.id, e);
    if (!first) { const ev = changes(e, snap.get(e.id), cur, now); if (ev) events.push(ev); }
    next.set(e.id, cur);
  }
  // Outputs an agent posted through the relay (post_output): the notification opens the output.
  if (!first && outputsSeen) {
    for (const o of list) {
      if (o.kind !== 'output' || outputsSeen.has(o.id) || now - (Number(o.updatedAt) || 0) > RECENT_MS) continue;
      const from = o.meta && o.meta.from;
      const a = from && agents.get(from);
      if (a) events.push({ kind: isBot(a) ? 'grok' : 'finished', card: from, open: o.id, name: a.title, title: `${truncate(clean(a.title), 60)} posted “${truncate(o.title || 'an output', 60)}”`, body: clean(o.preview) });
    }
  }
  for (const [id, s] of next) if (now - s.seen > 2 * 86400000) next.delete(id);
  snap = next;
  outputsSeen = new Set([...[...(outputsSeen || [])].slice(-2000), ...outs]);
  for (const ev of events) queue(ev);
  if (now - dueAt > DUE_MIN_GAP_MS) checkDue();
}

// Watches each card list the hub builds (for the window or anyone else) without building more.
function decorate(list) { setImmediate(() => { try { observe(list); } catch (e) { console.error('notify:', e.message); } }); }

async function poll() {
  if (Date.now() - builtAt < POLL_MS) return;
  try { await ctx.hub.entities(); } catch {}
}

// Runs started from Switchboard: the reply is in when the run is done. Grok bots, the relay and
// Cursor only take the message here, so their replies show up on their cards instead.
function onRun(r) {
  if (!r || r.status !== 'done' || runsDone.has(r.id)) return;
  runsDone.add(r.id);
  if (runsDone.size > 500) runsDone.delete(runsDone.values().next().value);
  const id = (r.result && r.result.entityId) || r.entityId;
  if (!id || r.entityId === 'chief' || id === 'chief' || id.startsWith('rl:')) return;
  const e = ctx.hub.find(id) || ctx.hub.find(r.entityId);
  if (e && (reports(e) || e.source === 'cursor')) return;
  queue({ kind: 'finished', card: id, open: id, name: e && e.kind === 'session' ? e.title : null, body: clean(r.text) });
}

// ---------- the to-do ----------
const dueKey = (d) => `${d.id}|${d.title}|${d.due || ''}`;
async function checkDue() {
  dueAt = Date.now();
  try {
    const items = await ctx.hub.due();
    if (!Array.isArray(items)) return;
    const keys = items.map(dueKey);
    if (dueSeen) {
      items.forEach((d, i) => {
        if (dueSeen.has(keys[i])) return;
        queue({ kind: 'todo', card: d.ref || d.id, open: d.ref || null, name: d.client || 'To do', title: d.client ? `New to-do for ${d.client}` : 'New to-do', body: clean(d.title) });
      });
    }
    // Remembered even after they drop off the list, so a Gmail hiccup doesn't bring them all back.
    dueSeen = new Set([...[...(dueSeen || [])].slice(-2000), ...keys]);
  } catch (e) { console.error('notify due:', e.message); }
}

// ---------- gathering and showing ----------
function queue(ev) {
  ev.at = Date.now();
  const had = pending.get(ev.card);
  if (had && RANK[had.kind] < RANK[ev.kind]) return;
  pending.set(ev.card, ev);
  if (!timer) timer = setTimeout(flush, BATCH_MS);
}

function flush() {
  timer = null;
  const batch = [...pending.values()];
  pending = new Map();
  const p = prefs();
  const now = Date.now();
  const isFront = front();
  const items = batch.filter((ev) => p[ev.kind]
    && !(isFront && (p.onlyAway || ev.card === openCard || ev.open === openCard))
    && now - (lastShown.get(ev.card) || 0) >= COOLDOWN_MS);
  if (!items.length) return;
  for (const ev of items) {
    lastShown.set(ev.card, now);
    if (!ev.name) { const e = ctx.hub.find(ev.card); ev.name = (e && e.title) || 'A chat'; }
    ev.name = truncate(clean(ev.name), 60);
  }
  if (lastShown.size > 1000) for (const [k, t] of lastShown) if (now - t > COOLDOWN_MS) lastShown.delete(k);
  show(compose(items));
}

const plural = (n, one, many) => (n === 1 ? one : many.replace('#', n));
const PART = {
  finished: (n) => plural(n, '1 chat finished', '# chats finished'),
  waiting: (n) => `${n} waiting on you`,
  grok: (n) => plural(n, '1 bot update', '# bot updates'),
  todo: (n) => plural(n, '1 new to-do', '# new to-dos'),
};
const ALL = {
  finished: (n) => `${n} chats finished`,
  waiting: (n) => `${n} chats are waiting on you`,
  grok: (n) => `${n} new posts from your bots`,
  todo: (n) => `${n} new to-dos`,
};
function single(ev) {
  if (ev.title) return ev.title;
  if (ev.kind === 'finished') return `${ev.name} finished`;
  if (ev.kind === 'waiting') return ev.error ? `${ev.name} hit a problem` : `${ev.name} is waiting on you`;
  return ev.name;
}
function names(items) {
  const n = items.map((i) => i.name);
  return n.length <= 4 ? n.join(', ') : `${n.slice(0, 3).join(', ')} and ${n.length - 3} more`;
}

function compose(items) {
  items.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.at - a.at);
  const base = { key: uid('n'), ids: items.map((i) => i.card), open: items[0].open, at: Date.now() };
  if (items.length === 1) {
    const ev = items[0];
    const body = ev.kind === 'finished' && !ev.body ? 'Reply is in.' : ev.body || '';
    return { ...base, kind: ev.kind, title: single(ev), body: truncate(body, 180) };
  }
  const kinds = KINDS.filter((k) => items.some((i) => i.kind === k));
  if (kinds.length === 1) return { ...base, kind: kinds[0], title: ALL[kinds[0]](items.length), body: names(items) };
  const title = kinds.map((k) => PART[k](items.filter((i) => i.kind === k).length)).join(', ');
  const lines = items.slice(0, 4).map((i) => `${single(i)}${i.kind === 'todo' && i.body ? `: ${truncate(i.body, 60)}` : ''}`);
  if (items.length > 4) lines.push(`and ${items.length - 4} more`);
  return { ...base, kind: 'summary', title: title[0].toUpperCase() + title.slice(1), body: lines.join('\n') };
}

function show(n) {
  recent.unshift(n);
  if (recent.length > 30) recent.length = 30;
  if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify(n) + '\n'); } catch {} return; }
  try {
    if (!Notification.isSupported()) return;
    const x = new Notification({ title: n.title, body: n.body });
    x.on('click', () => click(n.key));
    x.on('close', () => live.delete(n.key));
    live.set(n.key, x);
    if (live.size > 30) live.delete(live.keys().next().value);
    x.show();
  } catch (e) { console.error('notify show:', e.message); }
}

// ---------- clicks ----------
function reveal(id) {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
  if (!w) { pendingOpen = id || null; app.emit('activate'); return; } // main.cjs opens a window on activate
  if (w.isMinimized()) w.restore();
  w.show(); w.focus();
  if (process.platform === 'darwin') { try { app.focus({ steal: true }); } catch {} }
  if (id) ctx.send({ type: 'notify-open', id });
}
function click(key) {
  const n = recent.find((x) => x.key === key);
  if (!n) return false;
  reveal(n.open);
  return true;
}

function status() {
  return { settings: prefs(), badge: badge || 0, attention, front: front(), open: openCard, recent: recent.slice(0, 20) };
}

const handlers = {
  'notify:settings': () => prefs(),
  'notify:set': (patch) => setPrefs(patch),
  'notify:status': () => status(),
  // The window reports the card it has open and how many cards need the owner (the blue dots).
  'notify:state': (s) => {
    s = s || {};
    if ('open' in s) openCard = s.open || null;
    if (Number.isFinite(s.attention)) { attention = Math.max(0, Math.floor(s.attention)); applyBadge(); }
    return true;
  },
  'notify:click': (key) => click(key),
  // A card a notification asked to open before the window had loaded.
  'notify:pending': () => { const id = pendingOpen; pendingOpen = null; return id; },
  'notify:sample': () => {
    const n = { key: uid('n'), kind: 'sample', title: 'Notifications are on', body: 'Switchboard will tell you here when a chat finishes or needs you.', ids: [], open: null, at: Date.now() };
    show(n);
    return LOG ? true : Notification.isSupported();
  },
};
// Tests only: pretend the window is (or isn't) in front, forget recent notifications, look now.
if (LOG) {
  handlers['notify:test'] = async ({ front: f, reset, check } = {}) => {
    if (f !== undefined) testFront = f === null ? null : !!f;
    if (reset) { lastShown.clear(); pending.clear(); clearTimeout(timer); timer = null; recent.length = 0; }
    if (check) { ctx.hub.invalidate(); await ctx.hub.entities({ force: true }); await new Promise((r) => setImmediate(r)); await checkDue(); }
    return status();
  };
}

module.exports = {
  handlers,
  start(c) {
    ctx = c;
    ctx.hub.use({ decorate });
    ctx.hub.events.on('event', (e) => { if (e && e.type === 'run') onRun(e.run); });
    checkDue();
    const t1 = setInterval(poll, POLL_MS);
    const t2 = setInterval(() => { if (Date.now() - dueAt >= DUE_EVERY_MS - 1000) checkDue(); }, DUE_EVERY_MS);
    for (const t of [t1, t2]) if (t.unref) t.unref();
  },
};
