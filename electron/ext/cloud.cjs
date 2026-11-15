'use strict';
// Cloud sessions: Claude Code sessions on claude.ai/code (and on any other computer) stream their
// conversation, and their sub-agents', to Switchboard Relay as Claude writes it
// (relay/cloud/switchboard-sync.cjs, started by a hook in each session). This pulls it back, about a
// second behind while a session works, into ~/.switchboard/cloud/<session>/projects/… in Claude
// Code's own transcript layout, so each session is a full chat card (cs:<session id>) read by the same
// parser as local Claude Code sessions: messages, steps, plan, sub-agents, usage.
//   Reply: the user's own Claude Code CLI posts it into the session (`claude -p --cloud <session>`),
//          through the Claude account the session runs as.
//   Stop:  queued on the relay; the session's streamer picks it up and its next tool step ends the turn.
//   Open:  the session on claude.ai/code.
// Sub-agents (of cloud and local Claude Code sessions) open as their own read-only chats
// (sa:<agent id>@<parent card id>).
// Settings: cloudSessions (what is mirrored), cloudCursor. Needs Switchboard Relay connected.
const fs = require('fs');
const path = require('path');
const db = require('../db.cjs');
const hub = require('../hub.cjs');
const claudeCode = require('../sources/claudeCode.cjs');
const classify = require('../sources/classify.cjs');
const relay = require('./relay.cjs');
const { APP_DIR, HOME, which, run, truncate } = require('../util.cjs');

const ROOT = path.join(APP_DIR, 'cloud');
const FAST_MS = 1000; // while a session works
const SLOW_MS = 8000; // otherwise
const OLD_RELAY_MS = 120000; // a relay without cloud routes is asked again this rarely
const LIVE_MS = 120000; // a session that reported within this long keeps the fast pace
const ALIVE_MS = 60000; // a streamer beats at least every 15 s; past this the container is gone
const SHOW_DAYS = 14; // cards for sessions heard from this recently
const SID = /^[\w.-]{1,128}$/;

const emit = (e) => hub.events.emit('event', e);
let changedTimer = null;
const changed = () => {
  hub.invalidate();
  if (changedTimer) return;
  changedTimer = setTimeout(() => { changedTimer = null; emit({ type: 'entities-changed' }); }, 150);
};

// ---------- what is mirrored ----------
let sessions = null; // id -> { meta, ts, seq, files: { rel: count } }
const state = () => (sessions ||= new Map(Object.entries(db.getSetting('cloudSessions', {}) || {})));
let saveTimer = null;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => db.setSetting('cloudSessions', Object.fromEntries(state())), 500); };

// Where a file of a session lives on this computer. Both parts were checked by the relay, and are
// checked again here: nothing from the relay may write outside the session's own folder.
function localPath(sid, rel) {
  if (!SID.test(sid) || typeof rel !== 'string' || !rel.endsWith('.jsonl') || rel.startsWith('/') || rel.includes('\\') || rel.split('/').some((p) => !p || p === '.' || p === '..')) return null;
  const dir = path.join(ROOT, sid, 'projects');
  const p = path.join(dir, ...rel.split('/'));
  return p.startsWith(dir + path.sep) ? p : null;
}
const isSide = (rel) => /\/(subagents|workflows)\//.test(rel);
// The session's own transcript: its top-level file with the most lines (a /clear starts another).
function mainFile(s, sid) {
  let best = null;
  for (const [rel, n] of Object.entries(s.files || {})) {
    if (isSide(rel) || !n) continue;
    const p = localPath(sid, rel);
    let m = 0; try { m = fs.statSync(p).mtimeMs; } catch { continue; }
    if (!best || m > best.m) best = { rel, p, m };
  }
  return best;
}

// ---------- pulling ----------
let cursor = Number(db.getSetting('cloudCursor', 0)) || 0;
let timer = null;
let busy = false;
let lastError = null;
let relayHasCloud = true;
let lastPull = 0;

function schedule(ms) { clearTimeout(timer); timer = setTimeout(tick, ms); }

function liveNow() {
  const now = Date.now();
  for (const s of state().values()) if (now - (s.ts || 0) < LIVE_MS && s.meta && s.meta.active) return true;
  return false;
}

async function tick() {
  if (busy) return;
  if (!relay.enabled()) { schedule(SLOW_MS); return; }
  busy = true;
  let next = SLOW_MS;
  try {
    await pull();
    lastError = null;
    relayHasCloud = true;
    next = liveNow() ? FAST_MS : SLOW_MS;
  } catch (e) {
    lastError = e.message;
    if (/answered 404/.test(e.message)) { relayHasCloud = false; next = OLD_RELAY_MS; }
  } finally {
    busy = false;
    lastPull = Date.now();
    schedule(next);
  }
}

async function pull() {
  let any = false;
  for (let page = 0; page < 10; page++) {
    const r = await relay.request('GET', `/api/cloud/changes?since=${cursor}`);
    if (r.reset) { cursor = 0; }
    const want = [];
    for (const s of Array.isArray(r.sessions) ? r.sessions : []) {
      if (!s || !SID.test(s.id)) continue;
      const cur = state().get(s.id) || { meta: {}, ts: 0, seq: 0, files: {} };
      const metaChanged = JSON.stringify(cur.meta) !== JSON.stringify({ ...cur.meta, ...(s.meta || {}) }) || cur.ts !== s.ts;
      cur.meta = { ...cur.meta, ...(s.meta || {}) };
      cur.ts = Number(s.ts) || cur.ts;
      cur.seq = Number(s.seq) || cur.seq;
      for (const [rel, n] of Object.entries(s.files || {})) {
        const p = localPath(s.id, rel);
        if (!p) continue;
        // This computer's copy went missing (the folder was cleared): fetch it again from the start.
        if (cur.files[rel] && !fs.existsSync(p)) cur.files[rel] = 0;
        const have = cur.files[rel] || 0;
        // The relay has fewer lines than this copy: it was reset or the transcript was rewritten.
        if (n < have) { try { fs.rmSync(p, { force: true }); } catch {} cur.files[rel] = 0; }
        if (n > (cur.files[rel] || 0)) want.push({ session: s.id, file: rel, from: cur.files[rel] || 0, until: n });
      }
      state().set(s.id, cur);
      if (metaChanged) any = true;
    }
    any = (await fetchLines(want)) || any;
    cursor = Math.max(cursor, Number(r.cursor) || 0);
    db.setSetting('cloudCursor', cursor);
    if (!r.more) break;
  }
  if (any) { save(); changed(); }
}

// The newest timestamp among transcript lines (lines without one, like a title, have none).
function lastTime(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /"timestamp":"([^"]+)"/.exec(String(lines[i]));
    const t = m ? Date.parse(m[1]) : NaN;
    if (Number.isFinite(t)) return new Date(Math.min(t, Date.now()));
  }
  return null;
}

// New lines for each file that is behind, appended to this computer's copy. A pull returns at most
// a few MB, so a long session comes in over a few rounds.
async function fetchLines(want) {
  let wrote = false;
  for (let round = 0; want.length && round < 20; round++) {
    const r = await relay.request('POST', '/api/cloud/pull', { want: want.map(({ session, file, from }) => ({ session, file, from })) });
    const next = [];
    for (const g of Array.isArray(r.got) ? r.got : []) {
      const w = want.find((x) => x.session === g.session && x.file === g.file);
      const cur = state().get(g.session);
      const p = localPath(g.session, g.file);
      if (!w || !cur || !p || !Array.isArray(g.lines) || g.from !== (cur.files[g.file] || 0)) continue;
      if (g.lines.length) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        let before = null; try { before = fs.statSync(p).mtime; } catch {}
        fs.appendFileSync(p, g.lines.map((l) => String(l).replace(/\n/g, ' ')).join('\n') + '\n');
        // The copy's time is when the session wrote its newest line, not when it got here: "working",
        // "updated 3 min ago" and a sub-agent's running dot all read the file's time.
        const at = lastTime(g.lines) || before;
        if (at) { try { fs.utimesSync(p, new Date(), at); } catch {} }
        cur.files[g.file] = g.from + g.lines.length;
        wrote = true;
      }
      if (g.lines.length && cur.files[g.file] < w.until) next.push({ ...w, from: cur.files[g.file] });
    }
    want = next;
  }
  return wrote;
}

// ---------- cards ----------
const CLOUD_ACCOUNT = { id: 'cloud', label: 'Claude Code (cloud)', kind: 'claude-code', config: {} };

function claudeAccounts() { return hub.accounts().filter((a) => a.kind === 'claude-code'); }
// The Claude account a session runs as: the card whose sign-in has the session's email (and org, when
// two plans share an email); otherwise the first Claude account.
function accountFor(meta) {
  const list = claudeAccounts();
  const email = String((meta && meta.email) || '').toLowerCase();
  const same = list.filter((a) => a.config.auth && String(a.config.auth.email || '').toLowerCase() === email);
  return (meta && meta.org && same.find((a) => a.config.auth.orgId === meta.org)) || same[0] || list[0] || null;
}

function card(sid, s) {
  const main = mainFile(s, sid);
  if (!main) return null;
  const e = claudeCode.entityFor(CLOUD_ACCOUNT, main.p);
  if (!e) return null;
  const m = s.meta || {};
  const acc = accountFor(m);
  const now = Date.now();
  const alive = now - (s.ts || 0) < ALIVE_MS;
  const cwd = e.meta.cwd || '';
  const repo = cwd && cwd !== '/home/user' && cwd !== '/' ? path.basename(cwd) : '';
  e.id = `cs:${sid}`;
  e.accountId = acc ? acc.id : undefined;
  if (m.title) e.title = truncate(m.title, 80);
  // The streamer beats while its container runs; once it stops, nothing there can still be running.
  if (!alive && e.status === 'running') e.status = 'idle';
  if (!alive && e.meta.activity) e.meta.activity = { ...e.meta.activity, running: false };
  // A cloud session works in a checked-out repository: a coding session, filed under the repo.
  const category = repo ? 'coding' : classify.category(cwd, e.meta.gitBranch);
  Object.assign(e.meta, {
    cloud: { id: sid, url: m.url || null, email: m.email || null, environment: m.environment || null, alive, at: s.ts || 0, onCloud: !!m.cloud },
    url: m.url || undefined,
    account: `${acc ? acc.label : 'Claude Code'} · ${m.cloud ? 'cloud' : (m.host || 'other computer')}`,
    category, categoryLabel: classify.CATEGORY_LABEL[category], noise: false, fromDesktopApp: false,
    ...(repo ? { project: repo } : {}),
  });
  return e;
}

function decorate(list) {
  if (!state().size) return;
  const since = Date.now() - SHOW_DAYS * 86400000;
  for (const [sid, s] of state()) {
    if ((s.ts || 0) < since) continue;
    try { const e = card(sid, s); if (e) list.push(e); } catch (err) { console.error('cloud card:', err.message); }
  }
}

// Older cloud sessions (History, ⌘K) and sub-agents are found by id.
function findCard(id) {
  if (id.startsWith('cs:')) { const sid = id.slice(3); const s = state().get(sid); return s ? card(sid, s) : null; }
  if (id.startsWith('sa:')) return subagentCard(id);
  return null;
}

// ---------- sub-agents as their own chats ----------
// sa:<agent id>@<parent card id>; the parent is any Claude Code card with a transcript file.
function parseSub(id) {
  const m = /^sa:([\w.-]+)@(.+)$/.exec(id);
  return m ? { agentId: m[1], parentId: m[2] } : null;
}
function subFile(id) {
  const p = parseSub(id);
  if (!p) return null;
  const parent = hub.find(p.parentId) || (p.parentId.startsWith('cs:') ? findCard(p.parentId) : null);
  if (!parent || !parent.meta || !parent.meta.file || !parent.meta.sessionId) return null;
  const f = claudeCode.subagentFile(parent.meta.file, parent.meta.sessionId, p.agentId);
  return f ? { file: f, parent, ...p } : null;
}
function subagentCard(id) {
  const s = subFile(id);
  if (!s) return null;
  let st; try { st = fs.statSync(s.file); } catch { return null; }
  const info = claudeCode.subagentInfo(s.file, st);
  const running = Date.now() - st.mtimeMs < 60000;
  return {
    id, kind: 'session', source: 'claude-code', accountId: s.parent.accountId,
    title: info.title, preview: info.lastText || '', updatedAt: st.mtimeMs, status: running ? 'running' : 'idle',
    meta: {
      file: s.file, subagentOf: s.parentId, parentTitle: s.parent.title, readOnly: true, noise: true,
      account: s.parent.meta.account ? `${s.parent.meta.account} · sub-agent` : 'Sub-agent',
      activity: { prompt: '', tool: '', text: info.lastText || '', running },
      ...(s.parent.meta.url ? { url: s.parent.meta.url } : {}),
    },
  };
}

function transcript(id) {
  if (id.startsWith('sa:')) { const s = subFile(id); return s ? claudeCode.subagentTranscript(s.file) : undefined; }
  if (!id.startsWith('cs:')) return undefined;
  const sid = id.slice(3);
  const s = state().get(sid);
  const main = s && mainFile(s, sid);
  return main ? claudeCode.transcript(null, main.p) : [];
}

// ---------- replying and stopping ----------
async function dispatch(id, text, opts = {}) {
  if (id.startsWith('sa:')) throw new Error("A sub-agent can't take messages. Write to the chat that started it.");
  if (!id.startsWith('cs:')) return undefined;
  const sid = id.slice(3);
  const s = state().get(sid);
  if (!s) throw new Error('That cloud session is no longer here.');
  const m = s.meta || {};
  if (!m.cloud) throw new Error(`This session runs on ${m.host || 'another computer'}. Reply to it there.`);
  const acc = accountFor(m);
  if (!acc) throw new Error('Add the Claude account this session runs as first (Settings → Accounts).');
  const bin = acc.config.bin || which('claude');
  if (!bin) throw new Error("Claude Code (the `claude` command) isn't installed on this computer, and it's what sends a reply to a cloud session.");
  // Anthropic's documented way to post into a cloud session: one message, then it exits. The reply
  // itself streams back in through the relay as the session works.
  const r = await run(bin, ['-p', '--cloud', m.url || sid, '--output-format', 'json', '--', text], { env: claudeCode.childEnv(acc), cwd: HOME, signal: opts.signal });
  let j = null; try { j = JSON.parse(String(r.stdout).trim().split('\n').filter(Boolean).pop()); } catch {}
  if (r.code !== 0 || (j && j.ok === false)) {
    const why = truncate(String((j && (j.error || j.message)) || r.stderr || r.stdout || `claude exited with ${r.code}`).trim(), 300);
    throw new Error(`Couldn't send to the cloud session: ${why}`);
  }
  // Show the message right away; the session's own copy replaces it once it streams in.
  s.ts = Math.max(s.ts || 0, Date.now());
  s.meta = { ...m, active: true };
  schedule(FAST_MS);
  return { text: '', entityId: id };
}

async function stop(id) {
  const sid = String(id || '').replace(/^cs:/, '');
  const s = state().get(sid);
  if (!s) throw new Error('That cloud session is no longer here.');
  await relay.request('POST', '/api/cloud/command', { session: sid, type: 'stop' });
  schedule(FAST_MS);
  return { stopped: 1, cloud: true };
}

async function forget(id) {
  const sid = String(id || '').replace(/^cs:/, '');
  if (!SID.test(sid)) throw new Error('Not a cloud session');
  await relay.request('POST', '/api/cloud/forget', { session: sid }).catch(() => {});
  state().delete(sid);
  fs.rmSync(path.join(ROOT, sid), { recursive: true, force: true });
  save(); changed();
  return { ok: true };
}

hub.use({
  decorate, dispatch, transcript,
  canPrompt: (id) => id.startsWith('cs:') && !!state().get(id.slice(3)) && !!(state().get(id.slice(3)).meta || {}).cloud,
});
hub.addFinder(findCard);

// ---------- setup ----------
// What a cloud environment needs, for Settings: the setup script line, the host to allow and the
// key to save as the environment's network secret (BOT_TOKEN, sent as Authorization: Bearer).
function setup() {
  const u = relay.status().url;
  const host = u ? new URL(u).host : null;
  const script = u ? `mkdir -p ~/.switchboard-cloud && curl -fsSL ${u}/sync.cjs -o ~/.switchboard-cloud/switchboard-sync.cjs && node ~/.switchboard-cloud/switchboard-sync.cjs install --relay ${u}` : null;
  return { relayUrl: u || null, host, script };
}

function status() {
  const now = Date.now();
  const list = [...state()].map(([id, s]) => ({ id, title: (s.meta && s.meta.title) || id, at: s.ts || 0, alive: now - (s.ts || 0) < ALIVE_MS, cloud: !!(s.meta && s.meta.cloud) }))
    .sort((a, b) => b.at - a.at);
  return { enabled: relay.enabled(), relayHasCloud, lastPull, error: lastError, sessions: list, ...setup() };
}

module.exports = {
  handlers: {
    'cloud:status': () => status(),
    'cloud:sync': async () => { await pull(); return status(); },
    'cloud:stop': (id) => stop(id),
    'cloud:forget': (id) => forget(id),
    'entity:get': (id) => (typeof id === 'string' ? hub.find(id) || findCard(id) || null : null),
  },
  stop,
  start() { schedule(500); },
};
