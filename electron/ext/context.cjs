'use strict';
// Chat context: a short AI-written summary of every chat Switchboard shows (Claude Code sessions on
// every account, Claude desktop-app chats, Grok bots, Cursor, Codex and relay agents), so the home's
// grouping, the cards and ⌘K know who a chat is for and where it stands, not just its first ask:
//   { about, client, project, status, nextStep, people }
// Summaries come from the owner's own `claude` CLI through hub.quickAsk (no tools, no user hooks, run
// inside ~/.switchboard so it never shows up as a chat) on a small model: up to 8 chats per call, at
// most one call every 20 seconds, and only for chats whose transcript changed since their last
// summary. They are kept in the chat_context table and attached to the cards as meta.context.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const hub = require('../hub.cjs');
const db = require('../db.cjs');
const claudeCode = require('../sources/claudeCode.cjs');
const grokbot = require('../sources/grokbot.cjs');
const { HOME, truncate } = require('../util.cjs');

const SETTING = 'chatContext';
const MODEL = 'haiku';
const BATCH = 8;
const GAP = 20000;                 // at most one call this often
const INPUT = 2500;                // characters of each chat sent, biased to its latest turns
const RUNNING_EVERY = 10 * 60000;  // a chat that is still working is re-read at most this often
const START_DELAY = 12000;         // let the app open (and the topics run) first
const MAX_BACKOFF = 10 * 60000;
// The first words of every summary prompt; the e2e stand-in for `claude` answers it by this.
const MARKER = 'Summarize each of these AI chats for my dashboard';
const STATUSES = ['working', 'waiting on you', 'done', 'stuck'];
const STATUS_ALIAS = {
  waiting: 'waiting on you', 'needs you': 'waiting on you', 'needs input': 'waiting on you', 'your turn': 'waiting on you',
  blocked: 'stuck', error: 'stuck', failed: 'stuck', finished: 'done', complete: 'done', completed: 'done',
  'in progress': 'working', running: 'working', active: 'working',
};
const NONE = /^(null|none|n\/a|na|unknown|nobody|no one|me|myself|self|personal|internal|owner|the user|user|-+)?$/i;
const SOURCE_NAME = {
  'claude-code': 'Claude Code', 'claude-app': 'Claude desktop-app agent', 'grok-bot': 'Grok bot', cursor: 'Cursor agent',
  codex: 'Codex', 'anthropic-api': 'Claude API chat', 'openai-compatible': 'API chat',
};

let sendFn = null;
let rows = null;          // id -> { row, view }
let timer = null;
let lastCall = 0;
let backoff = 0;
let lastError = null;
const failed = new Map(); // id -> { sig, n }: chats the answer left out, so one bad chat can't loop

const enabled = () => db.getSetting(SETTING, true) !== false;
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const hash = (s) => crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 12);
const isWrapper = (t) => { const s = String(t || '').trim(); return !s || s.startsWith('<') || s.startsWith('Caveat:'); };
const isRunning = (e) => e.status === 'running' || !!(e.meta && e.meta.activity && e.meta.activity.running);

function emit(e) { if (sendFn) sendFn(e); else hub.events.emit('event', e); }

// ---------- storage ----------
function viewOf(r) {
  return {
    about: r.about || '', client: r.client || null, project: r.project || null, status: r.status || null,
    nextStep: r.next_step || '', people: db.J(r.people, []), at: r.ts,
  };
}
function load() {
  if (!rows) {
    rows = new Map();
    try { for (const r of db.all('SELECT * FROM chat_context')) rows.set(r.id, { row: r, view: viewOf(r) }); } catch (e) { console.error('context:', e.message); }
  }
  return rows;
}
function store(id, sig, c) {
  const row = { id, sig, about: c.about, client: c.client, project: c.project, status: c.status, next_step: c.nextStep, people: JSON.stringify(c.people), model: MODEL, ts: Date.now() };
  db.exec(`INSERT INTO chat_context(id, sig, about, client, project, status, next_step, people, model, ts) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET sig = excluded.sig, about = excluded.about, client = excluded.client, project = excluded.project,
    status = excluded.status, next_step = excluded.next_step, people = excluded.people, model = excluded.model, ts = excluded.ts`,
  row.id, row.sig, row.about, row.client, row.project, row.status, row.next_step, row.people, row.model, row.ts);
  load().set(id, { row, view: viewOf(row) });
  failed.delete(id);
}

// The hub calls this on every list of cards it builds: each chat gets its stored summary (the last
// one, even while a newer one is on its way). With the setting off, cards show none.
function attach(list) {
  const on = enabled();
  const m = on ? load() : null;
  for (const e of list) {
    if (!e || e.kind !== 'session' || !e.meta) continue;
    const c = m && m.get(e.id);
    if (c) e.meta.context = c.view;
    else if (e.meta.context) delete e.meta.context;
  }
}
hub.use({ finish: attach });

// ---------- what changed ----------
const isClaude = (e) => (e.source === 'claude-code' || e.source === 'claude-app') && e.meta && e.meta.file;

// A chat's transcript key: for Claude, its newest message that isn't a tool call (so a long tool run
// doesn't count as new); for other files, size and time; for Grok bots, their latest actions. Plus
// whether it is working or waiting, so a summary taken mid-run is redone once the run ends.
function sigOf(e) {
  const m = e.meta || {};
  const state = isRunning(e) ? 'r' : e.status === 'waiting' ? 'w' : 'i';
  return `${state}:${transcriptKey(e, m)}`;
}
function transcriptKey(e, m) {
  if (isClaude(e)) {
    try {
      const msgs = claudeCode.parseSession(m.file).messages;
      let last = null, n = 0;
      for (const x of msgs) if (x.kind !== 'tool') { last = x; n++; }
      return `c:${n}:${last ? last.id : ''}:${last ? hash(last.text) : ''}`;
    } catch {}
  }
  if (m.file) { try { const st = fs.statSync(m.file); return `f:${st.size}:${Math.floor(st.mtimeMs)}`; } catch {} }
  if (e.source === 'grok-bot') {
    const acts = Array.isArray(m.actions) ? m.actions.slice(0, 3) : [];
    return `g:${m.lastActivityAt || e.updatedAt || 0}:${hash(acts.map((a) => `${a.ts}${a.text}`).join('|'))}`;
  }
  return `u:${e.updatedAt || 0}:${hash(e.preview)}`;
}

function eligible(e) {
  const m = (e && e.meta) || {};
  return !!e && e.kind === 'session' && !m.noise && !m.archived && !m.unused;
}

// Chats to summarize: never summarized first, then the most recently active. A chat that is still
// working waits until it settles, or until its summary is ten minutes old.
function due(list, now = Date.now()) {
  const m = load();
  const out = [];
  for (const e of list) {
    if (!eligible(e)) continue;
    const sig = sigOf(e);
    const have = m.get(e.id);
    if (have && have.row.sig === sig) continue;
    const f = failed.get(e.id);
    if (f && f.sig === sig && f.n >= 2) continue;
    if (have && isRunning(e) && now - (have.row.ts || 0) < RUNNING_EVERY) continue;
    out.push({ e, sig, fresh: !have });
  }
  return out.sort((a, b) => Number(b.fresh) - Number(a.fresh) || (b.e.updatedAt || 0) - (a.e.updatedAt || 0));
}

// ---------- what each chat said ----------
async function messagesOf(e) {
  const m = e.meta || {};
  if (isClaude(e)) return claudeCode.parseSession(m.file).messages;
  if (e.source === 'grok-bot') {
    const t = m.agentId ? grokbot.transcript(m.agentId) : [];
    if (t.length) return t;
    // No transcript cached: the bot's recent actions (newest first) are all there is.
    return (Array.isArray(m.actions) ? m.actions : []).slice().reverse()
      .map((a) => (/^You: /.test(a.text) ? { role: 'user', text: a.text.slice(5) } : { role: 'assistant', text: a.text, kind: a.kind === 'message' ? undefined : 'tool' }));
  }
  return hub.transcriptFor(e.id);
}

function folderOf(e) {
  const m = e.meta || {};
  if (!m.cwd || m.cwd === HOME || m.category === 'desktop' || /\/scratch-workspaces\//.test(m.cwd)) return null;
  const base = path.basename(m.cwd);
  return /^scratch-|^[0-9a-f-]{20,}$/.test(base) ? null : base;
}

// The chat as the summarizer reads it, about INPUT characters: what it is, the first thing asked, the
// current plan, then as many of the latest turns as fit. Tool calls and widgets are left out.
function inputOf(e, msgs) {
  const m = e.meta || {};
  const head = [`Title: ${truncate(flat(e.title) || 'Untitled', 120)}`];
  const src = e.source === 'claude-code' && m.category === 'desktop' ? 'Claude desktop-app chat' : SOURCE_NAME[e.source] || e.source;
  head.push(`Source: ${src}${m.account ? ` (${truncate(flat(m.account), 40)})` : ''}`);
  const folder = folderOf(e);
  if (folder) head.push(`Folder: ${folder}${m.gitBranch && !['main', 'master', 'HEAD'].includes(m.gitBranch) ? ` (branch ${m.gitBranch})` : ''}`);
  if (e.source === 'grok-bot' && m.description) head.push(`Bot's job: ${truncate(flat(m.description), 200)}`);
  if (e.status === 'running' || e.status === 'waiting') head.push(`Right now: ${e.status === 'running' ? 'working' : 'waiting on me'}`);

  const turns = (Array.isArray(msgs) ? msgs : []).filter((x) => x && x.text && x.kind !== 'tool' && x.kind !== 'event' && x.kind !== 'notice'
    && !(x.role === 'user' && isWrapper(x.text)));
  const first = turns.find((x) => x.role === 'user' && !x.kind);
  const plan = [...turns].reverse().find((x) => x.kind === 'plan');
  const lines = [...head];
  if (first) lines.push(`First ask: ${truncate(flat(first.text), 500)}`);
  if (plan) lines.push(`Plan: ${truncate(flat(plan.text), 300)}`);
  let budget = INPUT - lines.join('\n').length;
  const tail = [];
  let i = turns.length - 1;
  for (; i >= 0 && budget > 60; i--) {
    const x = turns[i];
    if (x === first || x.kind === 'plan') continue;
    const who = x.role === 'user' ? 'Me' : x.kind === 'recap' ? 'AI (recap)' : 'AI';
    const line = `${who}: ${truncate(flat(x.text), Math.min(600, budget - who.length - 2))}`;
    tail.unshift(line);
    budget -= line.length + 1;
  }
  if (!first && !tail.length) return '';
  if (tail.length && turns.slice(0, i + 1).some((x) => x !== first && x.kind !== 'plan')) tail.unshift('…');
  return [...lines, ...(tail.length ? ['Latest:', ...tail] : [])].join('\n');
}

// The owner's own name never counts as a client (bots they run name them all the time). Setting
// 'ownerName', else git's user.name on this Mac.
let gitName;
function ownerNames() {
  if (gitName === undefined) {
    try { gitName = require('child_process').execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8', timeout: 3000 }).trim(); } catch { gitName = ''; }
  }
  return [db.getSetting('ownerName', ''), gitName].map((x) => String(x || '').trim()).filter((x) => x.length > 2);
}
const isOwner = (name) => { const n = String(name || '').toLowerCase().trim(); return !!n && ownerNames().some((o) => { const x = o.toLowerCase(); return n === x || n.includes(x) || x.includes(n) && n.split(/\s+/).length > 1; }); };

function promptFor(items, clients) {
  const names = (clients || []).map((c) => (c.company && c.company !== c.name ? `${c.name} (${c.company})` : c.name)).filter(Boolean).slice(0, 40);
  return `${MARKER}. They are my AI chats and agents, many doing work for my clients; I want to see at a glance who each one is for and where it stands.
For every chat give one JSON object:
{"n": <chat number>, "about": "<one line, under 12 words: what the work is>", "client": "<the person, company or school the work is for, or null when it is my own work>", "project": "<short project name, 1 to 4 words>", "status": "working" | "waiting on you" | "done" | "stuck", "nextStep": "<one line: the next thing to do>", "people": ["<names of people involved>"]}
- client is a real person or organization, never the AI, an app, or me${ownerNames()[0] ? ` (I am ${ownerNames()[0]})` : ''}. ${names.length ? 'Use the names from my client list when they match.' : ''}
- status: "waiting on you" when the AI asked me something or needs my answer or approval; "stuck" when it hit an error or blocker it could not get past; "done" when the task is finished; else "working".
- Use only what the chat says. Plain words, no emoji.
Reply with a JSON array only, no prose, one object per chat.
${names.length ? `My clients: ${names.join('; ')}.\n` : ''}
${items.map((b, i) => `### Chat ${i + 1}\n${b.input}`).join('\n\n')}`;
}

// ---------- the answer ----------
function parse(text) {
  const s = String(text || '');
  const arr = s.match(/\[[\s\S]*\]/);
  if (arr) { try { const v = JSON.parse(arr[0]); if (Array.isArray(v)) return v; } catch {} }
  const obj = s.match(/\{[\s\S]*\}/);
  if (obj) {
    const v = JSON.parse(obj[0]);
    const list = Array.isArray(v) ? v : Object.values(v || {}).find(Array.isArray);
    if (list) return list;
  }
  throw new Error('The summary was not a JSON list');
}

function clean(o) {
  const s = (v, n) => truncate(flat(typeof v === 'string' ? v : ''), n);
  const client = isOwner(o.client) ? '' : s(o.client, 60);
  const project = s(o.project, 40);
  const st = flat(o.status).toLowerCase();
  return {
    about: s(o.about, 140),
    client: NONE.test(client) ? null : client,
    project: NONE.test(project) ? null : project,
    status: STATUSES.includes(st) ? st : STATUS_ALIAS[st] || null,
    nextStep: s(o.nextStep ?? o.next_step ?? o.next, 160),
    people: [...new Set((Array.isArray(o.people) ? o.people : []).map((p) => s(p, 40)).filter((p) => p && !NONE.test(p)))].slice(0, 6),
  };
}

function fail(b) {
  const f = failed.get(b.e.id);
  failed.set(b.e.id, { sig: b.sig, n: f && f.sig === b.sig ? f.n + 1 : 1 });
}

// One call for up to BATCH chats. Resolves with how many summaries were stored.
function run(batch) {
  return (async () => {
    lastCall = Date.now();
    const items = [];
    for (const b of batch) {
      try { const input = inputOf(b.e, await messagesOf(b.e)); if (input) items.push({ ...b, input }); else fail(b); } catch { fail(b); }
    }
    if (!items.length) return 0;
    let got;
    try {
      got = parse(await hub.quickAsk(promptFor(items, hub.clients()), { model: MODEL, timeoutMs: 90000 }));
    } catch (e) {
      backoff = Math.min(backoff ? backoff * 2 : GAP, MAX_BACKOFF);
      lastError = e.message;
      throw e;
    }
    backoff = 0; lastError = null;
    const numbered = got.some((o) => o && o.n != null);
    let n = 0;
    items.forEach((b, i) => {
      const o = numbered ? got.find((x) => x && Number(x.n) === i + 1) : got[i];
      const c = o && typeof o === 'object' ? clean(o) : null;
      if (!c || !c.about) { fail(b); return; }
      store(b.e.id, b.sig, c);
      n++;
    });
    if (n) {
      hub.invalidate();
      emit({ type: 'context-changed', ids: items.map((b) => b.e.id) });
      emit({ type: 'entities-changed' });
    }
    return n;
  })();
}

// One pass at a time, start to finish (picking the chats included), so the background loop and a
// refresh never send the same chat twice.
let queue = Promise.resolve();
let busy = 0;
function serial(fn) {
  busy++;
  const p = queue.then(fn);
  queue = p.then(() => {}, () => {}).then(() => { busy--; });
  return p;
}

async function pass({ ids } = {}) {
  const list = await hub.entities();
  let cands;
  if (ids) {
    cands = ids.map((id) => list.find((e) => e.id === id) || hub.find(id)).filter(eligible).map((e) => ({ e, sig: sigOf(e) }));
  } else cands = due(list);
  if (process.env.SB_DEBUG_CONTEXT) console.log(`context: ${list.length} cards, ${list.filter(eligible).length} eligible, ${cands.length} due`);
  if (!cands.length) return { summarized: 0, pending: 0 };
  const batch = cands.slice(0, BATCH);
  const summarized = await run(batch);
  return { summarized, pending: cands.length - batch.length };
}

// ---------- the background loop ----------
function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(tick, Math.max(250, ms));
  if (timer.unref) timer.unref();
}
async function tick() {
  let next = GAP;
  if (process.env.SB_DEBUG_CONTEXT) console.log(`context tick: enabled=${enabled()} busy=${busy} wait=${lastCall + GAP + backoff - Date.now()}`);
  try {
    if (enabled() && !busy) {
      const wait = lastCall + GAP + backoff - Date.now();
      if (wait > 0) next = wait;
      else await serial(() => pass());
    }
  } catch (e) { console.error('context:', e.message); }
  schedule(next);
}

// ---------- handlers ----------
async function get(id) {
  const c = load().get(id);
  if (!c) return null;
  const e = (await hub.entities()).find((x) => x.id === id) || hub.find(id);
  return { ...c.view, stale: !!e && sigOf(e) !== c.row.sig };
}

async function refresh(id) {
  if (!enabled()) throw new Error('Turn on "Summarize chats with AI" in Settings first');
  if (id) {
    await serial(() => pass({ ids: [id] }));
    return get(id);
  }
  return serial(() => pass());
}

async function status() {
  let pending = 0;
  try { pending = due(await hub.entities()).length; } catch {}
  return { enabled: enabled(), summarized: load().size, pending, model: MODEL, batch: BATCH, everySeconds: GAP / 1000, lastAt: lastCall || null, error: lastError };
}

function setEnabled(on) {
  db.setSetting(SETTING, !!on);
  hub.invalidate();
  emit({ type: 'entities-changed' });
  emit({ type: 'context-changed', ids: [] });
  if (on) schedule(1000);
  return status();
}

function start({ send }) {
  sendFn = send;
  schedule(START_DELAY);
}

module.exports = {
  handlers: {
    'context:get': (id) => get(id),
    'context:refresh': (id) => refresh(id),
    'context:status': () => status(),
    'context:setEnabled': (on) => setEnabled(on),
  },
  start,
  MARKER,
  _test: { inputOf, promptFor, parse, clean, sigOf, due, attach },
};
