'use strict';
// The hub: gathers every source into one list of "entities" (cards), routes prompts,
// records flows between cards, and keeps the CRM, shared brain and usage.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const db = require('./db.cjs');
const secrets = require('./secrets.cjs');
const { APP_DIR, HOME, exists, truncate, uid, run, which } = require('./util.cjs');
const claudeCode = require('./sources/claudeCode.cjs');
const codex = require('./sources/codex.cjs');
const granola = require('./sources/granola.cjs');
const gmail = require('./sources/gmail.cjs');
const cursor = require('./sources/cursor.cjs');
const apiChat = require('./sources/apiChat.cjs');
const grokbot = require('./sources/grokbot.cjs');
const claudeDesktop = require('./sources/claudeDesktop.cjs');
const approvals = require('./approvals.cjs');

const events = new EventEmitter();
const emit = (e) => events.emit('event', e);
approvals.events.on('event', emit);
const BRAIN = path.join(APP_DIR, 'brain.md');
const runs = new Map();
let entityCache = { at: 0, list: [] };
const branchCache = new Map();

const PALETTE = ['#C0603E', '#3F7A5E', '#7A5A8C', '#B08A2E', '#4E6E7E', '#9A4B5B', '#5E7F3A', '#8A6B52'];

// ---------- accounts ----------
function accounts() {
  return db.all('SELECT * FROM accounts ORDER BY created_at').map((a) => ({ ...a, config: db.J(a.config, {}) }));
}
function account(id) { return accounts().find((a) => a.id === id); }

function publicAccount(a) {
  const keys = {
    'anthropic-api': [`api:${a.id}:key`], 'openai-compatible': [`api:${a.id}:key`],
    cursor: [`cursor:${a.id}:key`], gmail: [`gmail:${a.id}:client_id`, `gmail:${a.id}:refresh`],
  }[a.kind] || [];
  const has = (k) => secrets.has(k) || (a.kind === 'gmail' && k.endsWith(':client_id') && !!db.get("SELECT 1 AS x FROM secrets WHERE key LIKE 'gmail:%:client_id'"));
  return { ...a, secrets: Object.fromEntries(keys.map((k) => [k.split(':').pop(), has(k)])) };
}

function saveAccount(a) {
  const id = a.id || uid('a');
  if (a.kind === 'claude-code') {
    const dir = path.resolve(claudeCode.configDir(a));
    const clash = accounts().find((b) => b.id !== id && b.kind === 'claude-code' && path.resolve(claudeCode.configDir(b)) === dir);
    if (clash) throw new Error(`${clash.label} already uses ${a.config.configDir || '~/.claude'}. Give this account its own folder, like ~/.claude-2.`);
    const prev = account(id);
    if (prev && prev.config.auth && !a.config.auth && path.resolve(claudeCode.configDir(prev)) === dir) a.config.auth = prev.config.auth;
  }
  const n = db.get('SELECT COUNT(*) AS n FROM accounts').n;
  const prev = account(id);
  db.exec(`INSERT INTO accounts(id, kind, label, color, config, created_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET label = excluded.label, color = excluded.color, config = excluded.config`,
  id, a.kind, a.label, a.color || (prev && prev.color) || PALETTE[n % PALETTE.length], JSON.stringify(a.config || {}), Date.now());
  for (const [k, v] of Object.entries(a.secrets || {})) if (v) secrets.set(secretKey(a.kind, id, k), v);
  invalidate();
  return id;
}
function secretKey(kind, id, k) {
  if (kind === 'gmail') return `gmail:${id}:${k}`;
  if (kind === 'cursor') return `cursor:${id}:${k}`;
  return `api:${id}:${k}`;
}
function deleteAccount(id) {
  db.exec('DELETE FROM accounts WHERE id = ?', id);
  db.exec("DELETE FROM secrets WHERE key LIKE ?", `%:${id}:%`);
  db.exec('DELETE FROM board_nodes WHERE id = ?', `ac:${id}`);
  invalidate();
}

// ---------- Claude sign-ins (one per account card, each in its own config folder) ----------
const logins = new Map(); // account id -> AbortController
function setAuth(id, auth) {
  const a = account(id); if (!a) return;
  a.config.auth = auth;
  db.exec('UPDATE accounts SET config = ? WHERE id = ?', JSON.stringify(a.config), id);
}
async function claudeStatus(id) {
  const a = account(id);
  if (!a || a.kind !== 'claude-code') throw new Error('Not a Claude account');
  const st = await claudeCode.authStatus(a);
  setAuth(id, st); invalidate();
  emit({ type: 'auth', accountId: id, phase: 'status', status: st });
  return st;
}
async function claudeLogin(id, { email } = {}) {
  const a = account(id);
  if (!a || a.kind !== 'claude-code') throw new Error('Not a Claude account');
  if (logins.has(id)) logins.get(id).abort();
  const ctl = new AbortController(); logins.set(id, ctl);
  emit({ type: 'auth', accountId: id, phase: 'waiting' });
  try {
    const st = await claudeCode.login(a, {
      email, signal: ctl.signal,
      onOutput: (line) => { const m = line.match(/https:\/\/(?:claude\.ai|console\.anthropic\.com|platform\.claude\.com)\/\S+/); if (m) emit({ type: 'auth', accountId: id, phase: 'waiting', url: m[0] }); },
    });
    setAuth(id, st); invalidate();
    emit({ type: 'auth', accountId: id, phase: 'done', status: st });
    emit({ type: 'entities-changed' });
    return st;
  } catch (e) {
    emit({ type: 'auth', accountId: id, phase: 'error', error: ctl.signal.aborted ? 'Sign-in cancelled' : e.message });
    throw ctl.signal.aborted ? new Error('Sign-in cancelled') : e;
  } finally { if (logins.get(id) === ctl) logins.delete(id); }
}
function claudeLoginCancel(id) { const c = logins.get(id); if (c) c.abort(); }
async function claudeLogout(id) {
  const a = account(id);
  const st = await claudeCode.logout(a);
  setAuth(id, st); invalidate(); emit({ type: 'auth', accountId: id, phase: 'status', status: st }); emit({ type: 'entities-changed' });
  return st;
}

function firstRunSetup() {
  if (db.get('SELECT COUNT(*) AS n FROM accounts').n > 0) return;
  claudeCode.detect().forEach((dir, i) => saveAccount({ kind: 'claude-code', label: i === 0 ? 'Claude' : `Claude ${i + 1}`, config: { configDir: dir } }));
  if (codex.hasSessions()) saveAccount({ kind: 'codex', label: 'Codex', config: {} });
  if (granola.detect().length) saveAccount({ kind: 'granola', label: 'Granola', config: {} });
  saveAccount({ kind: 'grok-bot', label: 'Grok Bot', config: {} });
}

// ---------- entities ----------
function invalidate() { entityCache.at = 0; }

// Feature modules can add to the cards (decorate), take prompts (dispatch) and serve transcripts
// for their own cards; see ext/relay.cjs. dispatch/transcript return undefined to pass. finish runs
// last, on the whole list (extras included); see ext/context.cjs.
const plugins = [];
function use(p) { plugins.push(p); }

// Liveness. main.cjs watches the Claude Code / Codex / Granola folders; the hub also watches Grok
// Bot's cache and the Claude desktop app's session index, and while anything is running it re-checks
// shortly after, so a card flips from running to idle without waiting for the 30 s refresh.
const FRESH_MS = 120000;
const SETTLE_MS = 15000;
let extraWatchers = null;
let liveTimer = null;
let changeTimer = null;
function changed() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => { invalidate(); emit({ type: 'entities-changed' }); }, 700);
  if (changeTimer.unref) changeTimer.unref();
}
function watchExtra() {
  if (extraWatchers) return;
  extraWatchers = [];
  const dirs = [grokbot.PERSIST, path.join(claudeDesktop.ROOT, 'claude-code-sessions'), path.join(claudeDesktop.ROOT, 'local-agent-mode-sessions')];
  for (const d of dirs) {
    if (!exists(d)) continue;
    try {
      const w = fs.watch(d, { recursive: true }, changed);
      w.on('error', () => {});
      if (w.unref) w.unref();
      extraWatchers.push(w);
    } catch {}
  }
}
function scheduleSettle(list) {
  if (liveTimer || !list.some((e) => e.kind === 'session' && e.status === 'running')) return;
  liveTimer = setTimeout(() => { liveTimer = null; invalidate(); emit({ type: 'entities-changed' }); }, SETTLE_MS);
  if (liveTimer.unref) liveTimer.unref();
}
const cacheTtl = (list) => (list.some((e) => e.kind === 'session' && Date.now() - (e.updatedAt || 0) < FRESH_MS) ? 1500 : 4000);

async function sourceList(a) {
  try {
    switch (a.kind) {
      case 'claude-code': return claudeCode.list(a);
      case 'codex': return codex.list(a);
      case 'granola': return granola.list(a);
      case 'gmail': return await gmail.list(a);
      case 'cursor': return await cursor.list(a);
      case 'anthropic-api': case 'openai-compatible': return apiChat.listChats(a);
      case 'grok-bot': return grokbot.list(a);
      default: return [];
    }
  } catch (e) {
    return [{ id: `err:${a.id}`, kind: 'error', source: a.kind, accountId: a.id, title: `${a.label}: ${e.message}`, updatedAt: Date.now(), meta: {} }];
  }
}

function usageFor(a) {
  try {
    if (a.kind === 'claude-code') return claudeCode.usage(a);
    if (a.kind === 'codex') return codex.usage(a);
    if (a.kind === 'anthropic-api' || a.kind === 'openai-compatible') return apiChat.usage(a);
  } catch {}
  return null;
}

function gitBranches(cwd) {
  const c = branchCache.get(cwd);
  if (c && Date.now() - c.at < 120000) return c.value;
  branchCache.set(cwd, { at: Date.now(), value: c ? c.value : null });
  const git = which('git');
  if (git && exists(path.join(cwd, '.git'))) {
    run(git, ['-C', cwd, 'for-each-ref', '--sort=-committerdate', '--count=40', '--format=%(refname:short)|%(committerdate:unix)', 'refs/heads', 'refs/remotes'])
      .then((r) => {
        const seen = new Set(); const out = [];
        for (const line of r.stdout.split('\n')) {
          const [ref, t] = line.split('|'); if (!ref) continue;
          const name = ref.replace(/^origin\//, ''); if (seen.has(name) || name === 'HEAD' || name === 'origin') continue; seen.add(name);
          const agent = (name.match(/^(grok|claude|codex|cursor|copilot|devin)[/-]/i) || [])[1];
          out.push({ name, at: Number(t) * 1000, agent: agent ? agent.toLowerCase() : null });
        }
        branchCache.set(cwd, { at: Date.now(), value: out.slice(0, 12) });
        emit({ type: 'entities-changed' });
      }).catch(() => {});
  }
  return c ? c.value : null;
}

async function entities({ force = false } = {}) {
  if (!force && Date.now() - entityCache.at < cacheTtl(entityCache.list)) return entityCache.list;
  watchExtra();
  const accs = accounts();
  const lists = await Promise.all(accs.map(sourceList));
  const list = [];
  const projects = new Map();
  accs.forEach((a, i) => {
    list.push({ id: `ac:${a.id}`, kind: 'account', source: a.kind, accountId: a.id, title: a.label, updatedAt: a.created_at, status: 'idle', meta: { usage: usageFor(a), color: a.color, config: a.config } });
    for (const e of lists[i]) {
      list.push(e);
      if (e.kind === 'session' && e.meta && !e.meta.account) e.meta.account = a.label;
      const cwd = e.meta && e.meta.cwd;
      // Claude app chats without a folder run in a per-chat scratch folder: not a project.
      if (cwd && cwd !== HOME && !e.meta.noise && e.meta.category !== 'desktop' && (e.source === 'claude-code' || e.source === 'codex')) {
        const p = projects.get(cwd) || { sessions: [], updatedAt: 0 };
        p.sessions.push(e.id); p.updatedAt = Math.max(p.updatedAt, e.updatedAt);
        projects.set(cwd, p);
        e.meta.project = `pj:${cwd}`;
      }
    }
  });
  // Agent sessions from the Claude desktop app (read-only), recent ones only; History has the rest.
  if (db.getSetting('claudeAppSessions', true) !== false) { try { list.push(...claudeCode.desktopList()); } catch {} }
  for (const p of plugins) { try { if (p.decorate) p.decorate(list, accs); } catch (e) { console.error('decorate:', e.message); } }
  for (const [cwd, p] of projects) {
    list.push({ id: `pj:${cwd}`, kind: 'project', source: 'project', title: path.basename(cwd), preview: cwd.replace(HOME, '~'), updatedAt: p.updatedAt, status: 'idle', meta: { cwd, sessions: p.sessions, branches: gitBranches(cwd) } });
  }
  for (const c of clients()) {
    list.push({ id: `cl:${c.id}`, kind: 'client', source: 'crm', title: c.name, preview: c.next_action || c.company || '', updatedAt: c.updated_at, status: c.status, meta: { client: c } });
  }
  for (const o of db.all('SELECT * FROM outputs ORDER BY ts DESC LIMIT 200')) {
    list.push({ id: `out:${o.id}`, kind: 'output', source: 'output', title: o.title, preview: truncate(o.content, 300), updatedAt: o.ts, status: 'idle', meta: { from: o.source } });
  }
  for (const n of db.all('SELECT * FROM notes ORDER BY ts DESC LIMIT 200')) {
    list.push({ id: `nt:${n.id}`, kind: 'note', source: 'note', title: truncate(n.text.split('\n')[0], 60) || 'Note', preview: n.text, updatedAt: n.ts, status: 'idle', meta: {} });
  }
  const have = new Set(list.map((e) => e.id));
  for (const fn of extras) { try { for (const e of fn() || []) if (e && !have.has(e.id)) { list.push(e); have.add(e.id); } } catch {} }
  for (const p of plugins) { try { if (p.finish) p.finish(list); } catch (e) { console.error('finish:', e.message); } }
  entityCache = { at: Date.now(), list };
  scheduleSettle(list);
  return list;
}

// Feature modules can add cards the sources don't list (e.g. older chats the user imported).
const extras = [];
function addExtraEntities(fn) { extras.push(fn); }

// Cards that aren't in the current list (older sessions opened from History or ⌘K) are looked up
// by finders that feature modules register.
const finders = [];
function addFinder(fn) { finders.push(fn); }
function find(id) {
  const hit = entityCache.list.find((e) => e.id === id);
  if (hit) return hit;
  for (const f of finders) { try { const e = f(id); if (e) return e; } catch {} }
  return undefined;
}

// ---------- transcripts ----------
async function transcriptFor(id) {
  for (const p of plugins) { const t = p.transcript && (await p.transcript(id)); if (t) return t; }
  const [kind, accId, ...rest] = id.split(':');
  const ref = rest.join(':');
  const a = account(accId);
  const e = find(id);
  switch (kind) {
    case 'cc': if (!e) throw new Error('Session not found'); return claudeCode.transcript(a, e.meta.file);
    case 'cd': if (!e) throw new Error('Session not found'); return claudeCode.transcript(null, e.meta.file);
    case 'gb': return grokbot.transcript(ref);
    case 'cx': if (!e) throw new Error('Session not found'); return codex.transcript(a, e.meta.file);
    case 'gr': return granola.transcript(a, ref);
    case 'gm': return gmail.transcript(a, ref);
    case 'cu': return cursor.transcript(a, ref);
    case 'lc': return apiChat.transcript(ref);
    case 'out': { const o = db.get('SELECT * FROM outputs WHERE id = ?', accId); return o ? [{ id: o.id, role: 'assistant', text: o.content, ts: o.ts }] : []; }
    case 'nt': { const n = db.get('SELECT * FROM notes WHERE id = ?', accId); return n ? [{ id: n.id, role: 'user', text: n.text, ts: n.ts }] : []; }
    case 'ac': {
      const acct = account(accId);
      if (acct && acct.kind === 'grok-bot') return flowsFor(id).map((f) => ({ id: f.id, role: f.source === id ? 'assistant' : 'user', text: `${f.source === id ? '→ ' + label(f.target) : '← ' + label(f.source)}\n\n${f.content}`, ts: f.ts }));
      return [];
    }
    case 'cl': return [];
    default: return [];
  }
}

function label(id) { const e = find(id); return e ? e.title : id; }

// ---------- flows & edges ----------
function flowsFor(id) { return db.all('SELECT * FROM flows WHERE source = ? OR target = ? ORDER BY ts DESC LIMIT 100', id, id).reverse(); }

function recordFlow(source, target, content, via = 'app') {
  if (!source || !target || source === target) return;
  const f = { id: uid('f'), source, target, preview: truncate(content, 140), content, via, ts: Date.now() };
  db.exec('INSERT INTO flows(id, source, target, preview, content, via, ts) VALUES(?,?,?,?,?,?,?)', f.id, f.source, f.target, f.preview, f.content, f.via, f.ts);
  // The overall agent is the bar at the bottom, not a card, so its reads are logged without a line.
  if (source === CHIEF_ID || target === CHIEF_ID) { emit({ type: 'flow', flow: f }); return f; }
  let edge = db.get("SELECT * FROM edges WHERE source = ? AND target = ? ORDER BY kind = 'link' DESC", source, target);
  if (!edge) {
    const eid = uid('e');
    db.exec('INSERT INTO edges(id, source, target, kind, data, created_at) VALUES(?,?,?,?,?,?)', eid, source, target, 'flow', JSON.stringify({ count: 0 }), Date.now());
    edge = db.get('SELECT * FROM edges WHERE id = ?', eid);
  }
  const d = db.J(edge.data, {}); d.count = (d.count || 0) + 1; d.last = f.preview; d.lastTs = f.ts;
  db.exec('UPDATE edges SET data = ? WHERE id = ?', JSON.stringify(d), edge.id);
  emit({ type: 'flow', flow: f, edgeId: edge.id });
  return f;
}

function edges() { return db.all('SELECT * FROM edges').map((e) => ({ ...e, data: db.J(e.data, {}) })); }
// The renderer saves a line with the data it last saw, so keep the counters and forwarding
// bookkeeping the hub wrote since. armedAt marks when auto-send was switched on.
function saveEdge(e) {
  const id = e.id || uid('e');
  const prev = db.get('SELECT data FROM edges WHERE id = ?', id);
  const old = prev ? db.J(prev.data, {}) : {};
  const data = { ...(e.data || {}) };
  if ((old.lastTs || 0) > (data.lastTs || 0)) Object.assign(data, { count: old.count, last: old.last, lastTs: old.lastTs });
  if ((old.lastForwardAt || 0) > (data.lastForwardAt || 0)) Object.assign(data, { lastForwardAt: old.lastForwardAt, lastForwardHash: old.lastForwardHash });
  if (data.autoForward) data.armedAt = (old.autoForward && old.armedAt) || Date.now();
  else delete data.armedAt;
  db.exec(`INSERT INTO edges(id, source, target, kind, data, created_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, kind = excluded.kind`, id, e.source, e.target, e.kind || 'link', JSON.stringify(data), Date.now());
  return id;
}
function deleteEdge(id) { db.exec('DELETE FROM edges WHERE id = ?', id); }

// ---------- prompting ----------
// Picks the account for new work, in this order: the account asked for (opts.accountId); the
// account dedicated to the folder (setting accountForPath, longest matching folder wins) or to the
// board group (accountForGroup); then the first kind in the list that you have (so Claude accounts
// come before Codex or API keys), and with "split usage" on, the one that has used the least in
// the last 5 hours.
function dedicatedAccount(kinds, { accountId, cwd, group } = {}) {
  const ok = (id) => { const a = id && account(id); return a && kinds.includes(a.kind) ? a : null; };
  if (ok(accountId)) return ok(accountId);
  if (cwd) {
    const map = db.getSetting('accountForPath', {}) || {};
    const norm = (p) => path.resolve(String(p).replace(/^~(?=$|\/)/, HOME)).replace(/\/+$/, '');
    const dir = norm(cwd);
    const best = Object.keys(map).map((k) => ({ k, p: norm(k) })).filter(({ p }) => dir === p || dir.startsWith(p + '/'))
      .sort((x, y) => y.p.length - x.p.length).map(({ k }) => ok(map[k])).find(Boolean);
    if (best) return best;
  }
  if (group) { const g = db.getSetting('accountForGroup', {}) || {}; if (ok(g[group])) return ok(g[group]); }
  return null;
}
function pickAccount(kinds = ['claude-code'], opts = {}) {
  const dedicated = dedicatedAccount(kinds, opts);
  if (dedicated) return dedicated;
  const all = accounts();
  const kind = kinds.find((k) => all.some((a) => a.kind === k));
  const cands = all.filter((a) => a.kind === kind);
  if (!cands.length) return null;
  const pref = db.getSetting('defaultAccount', null);
  if (db.getSetting('splitUsage', true)) {
    const scored = cands.map((a) => ({ a, u: (usageFor(a) || { h5: 0 }).h5 }));
    scored.sort((x, y) => x.u - y.u);
    return scored[0].a;
  }
  return cands.find((a) => a.id === pref) || cands[0];
}

function brain() { try { return fs.readFileSync(BRAIN, 'utf8'); } catch { return ''; } }
function setBrain(text) { fs.writeFileSync(BRAIN, text); emit({ type: 'brain-changed' }); }
function appendBrain(text, sourceLabel) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  fs.appendFileSync(BRAIN, `\n\n## ${stamp}${sourceLabel ? ' · ' + sourceLabel : ''}\n${text.trim()}\n`);
  emit({ type: 'brain-changed' });
}

async function buildText(text, { attach = [], includeBrain = false } = {}) {
  let pre = '';
  if (includeBrain) { const b = brain().trim(); if (b) pre += `Shared notes (from Switchboard's shared brain):\n${truncate(b, 12000)}\n\n`; }
  for (const a of attach) {
    if (a.text) { pre += `Context from ${a.title || 'another card'}:\n"""\n${a.text}\n"""\n\n`; continue; }
    const t = await transcriptFor(a.id).catch(() => []);
    const body = t.slice(-12).map((m) => `${m.role}: ${m.text}`).join('\n\n');
    pre += `Context from ${label(a.id)}:\n"""\n${truncate(body, 16000)}\n"""\n\n`;
  }
  return pre + text;
}

// Cards whose latest reply answers work sent from Switchboard; kept across restarts for the Outputs drawer.
function markSent(id) {
  if (id === CHIEF_ID) return;
  const sent = { ...(db.getSetting('sentReplies', {}) || {}), [id]: Date.now() };
  const keep = Object.entries(sent).sort((x, y) => y[1] - x[1]).slice(0, 200);
  db.setSetting('sentReplies', Object.fromEntries(keep));
}
const sentReplies = () => db.getSetting('sentReplies', {}) || {};

// Runs still in flight, so Stop can abort them: run id -> AbortController. A run stays here until
// its process has exited, even after Stop marked it 'stopped'.
const controllers = new Map();

// Prompt any card. Returns a run id at once; progress arrives as events. opts.model (opus, sonnet
// or haiku) picks the Claude model for this message; an unknown one is refused before anything runs.
function prompt(id, text, opts = {}) {
  const model = claudeCode.modelName(opts.model);
  const runId = uid('r');
  const ctl = new AbortController();
  controllers.set(runId, ctl);
  runs.set(runId, { id: runId, entityId: id, text: '', status: 'running', startedAt: Date.now(), model });
  emit({ type: 'run', run: runs.get(runId) });
  if (opts.from) recordFlow(opts.from, id, text, opts.via || 'app');
  const stopped = () => ctl.signal.aborted;
  (async () => {
    const full = await buildText(text, opts);
    if (stopped()) return;
    const onText = (t) => { const r = runs.get(runId); if (r.status !== 'running') return; r.text = t; emit({ type: 'run', run: r }); };
    let res;
    try { res = await dispatch(id, full, onText, { ...opts, model, signal: ctl.signal }); } catch (err) { if (!stopped()) runEnded([id], ''); throw err; }
    const r = runs.get(runId);
    if (stopped()) {
      // Stopped: keep what it said so far and where it went (a new session's card), forward nothing.
      if (res && res.entityId) { r.result = res; emit({ type: 'run', run: r }); }
      runEnded([id, res && res.entityId].filter(Boolean), '');
      invalidate(); emit({ type: 'entities-changed' });
      return;
    }
    r.text = res.text || r.text; r.status = 'done'; r.result = res;
    emit({ type: 'run', run: r });
    invalidate(); emit({ type: 'entities-changed' });
    const resultId = res.entityId || id;
    markSent(resultId);
    runEnded([id, resultId], r.text, { depth: opts.depth || 0, chain: [...(opts.chain || []), id, resultId] });
  })().catch((err) => {
    if (stopped()) { runEnded([id], ''); return; }
    const r = runs.get(runId); r.status = 'error'; r.error = err.message; emit({ type: 'run', run: r });
  }).finally(() => controllers.delete(runId));
  return runId;
}

// Stop what is running on a card (or one run, by its id): the CLI process is told to stop and the
// run is marked 'stopped' at once, keeping the text it had streamed. Returns how many it stopped.
function stopRun(key) {
  let stopped = 0;
  for (const r of runs.values()) {
    if (r.status !== 'running' || (r.id !== key && r.entityId !== key)) continue;
    const ctl = controllers.get(r.id);
    if (!ctl) continue;
    ctl.abort();
    r.status = 'stopped'; r.error = 'Stopped'; r.stoppedAt = Date.now();
    emit({ type: 'run', run: r });
    runEnded([r.entityId], '');
    stopped++;
  }
  return { stopped };
}

// ---------- auto-send along lines ----------
// When a card finishes, its output goes to every card it has an auto-send line to, as an
// attachment. Chains stop after MAX_HOPS, never loop back to a card already in the chain, and
// the same output is never sent twice down one line.
const MAX_HOPS = 3;
const lastRunEnd = new Map(); // entity id -> when a Switchboard run on it last ended
const hash = (t) => crypto.createHash('sha1').update(t).digest('hex');
const PROMPTABLE = new Set(['claude-code', 'codex', 'anthropic-api', 'openai-compatible', 'grok-bot']);

function canTakePrompt(id) {
  const [kind, accId] = id.split(':');
  if (kind === 'ac') { const a = account(accId); return !!a && PROMPTABLE.has(a.kind); }
  return ['cc', 'cx', 'cu', 'lc', 'pj', 'cl', 'gb'].includes(kind) || plugins.some((p) => p.canPrompt && p.canPrompt(id));
}
function autoEdgesFrom(ids) { return edges().filter((e) => ids.includes(e.source) && e.kind === 'link' && e.data.autoForward); }

function runEnded(ids, text, opts) {
  const now = Date.now();
  for (const id of ids) lastRunEnd.set(id, now);
  forwardAlong(autoEdgesFrom(ids), text, opts);
}

function forwardAlong(lines, text, { depth = 0, chain = [] } = {}) {
  const h = text ? hash(text) : null;
  const sent = new Set();
  for (const e of lines) {
    const row = db.get('SELECT data FROM edges WHERE id = ?', e.id);
    if (!row) continue;
    const d = { ...db.J(row.data, {}), lastForwardAt: Date.now() };
    const go = !!text && depth < MAX_HOPS && !chain.includes(e.target) && !sent.has(e.target) && d.lastForwardHash !== h;
    if (go) d.lastForwardHash = h;
    db.exec('UPDATE edges SET data = ? WHERE id = ?', JSON.stringify(d), e.id);
    if (!go) continue;
    sent.add(e.target);
    recordFlow(e.source, e.target, text, 'route');
    if (!canTakePrompt(e.target)) continue;
    const from = label(e.source);
    const ask = d.instruction || `"${from}" just finished. Its output is attached above. Use it to continue your work.`;
    prompt(e.target, ask, { attach: [{ title: from, text: truncate(text, 16000) }], depth: depth + 1, chain: [...chain, e.source], via: 'route' });
  }
}

// The newest assistant reply of a session (everything it said after the last user turn), or
// null while it is still in the middle of a tool call.
async function lastReply(id) {
  const msgs = await transcriptFor(id).catch(() => []);
  if (msgs.length && msgs[msgs.length - 1].kind === 'tool') return null;
  let i = msgs.length - 1;
  while (i >= 0 && msgs[i].role !== 'user') i--;
  return msgs.slice(i + 1).filter((m) => m.role === 'assistant' && m.kind !== 'tool').map((m) => m.text).join('\n\n').trim();
}

// Sessions you run outside Switchboard (in a terminal or the Claude app) also send their output
// down auto-send lines once they finish, so a line works the same however the card was driven.
let finishing = null;
function forwardFinished() {
  if (!finishing) finishing = checkFinished().finally(() => { finishing = null; });
  return finishing;
}
async function checkFinished() {
  const lines = edges().filter((e) => e.kind === 'link' && e.data.autoForward && !e.data.example && /^(cc|cx):/.test(e.source));
  if (!lines.length) return 0;
  const now = Date.now();
  for (const e of lines.filter((x) => !x.data.armedAt)) {
    e.data.armedAt = now;
    db.exec('UPDATE edges SET data = ? WHERE id = ?', JSON.stringify(e.data), e.id);
  }
  const list = await entities();
  // A stopped run counts as busy until its process has exited, so its last words aren't forwarded.
  const busy = new Set([...runs.values()].filter((r) => r.status === 'running' || controllers.has(r.id)).map((r) => r.entityId));
  let n = 0;
  for (const src of new Set(lines.map((e) => e.source))) {
    const ent = list.find((x) => x.id === src);
    if (!ent || ent.status !== 'idle' || busy.has(src) || now - ent.updatedAt > 2 * 3600000) continue;
    const due = lines.filter((e) => e.source === src && ent.updatedAt > Math.max(e.data.armedAt || 0, e.data.lastForwardAt || 0, lastRunEnd.get(src) || 0));
    if (!due.length) continue;
    const text = await lastReply(src);
    if (text == null) continue;
    forwardAlong(due, text, { chain: [src] });
    if (text) n++;
  }
  return n;
}

// Sends to the card's agent. opts.signal stops the run; opts.model (already checked by prompt) goes
// to Claude Code as --model, the same way for an existing chat and for a new one.
async function dispatch(id, text, onText, opts = {}) {
  for (const p of plugins) { const r = p.dispatch && (await p.dispatch(id, text, opts)); if (r) return r; }
  const [kind, accId, ...rest] = id.split(':');
  const ref = rest.join(':');
  const e = find(id) || { meta: {} };
  const { signal, model } = opts;
  if (kind === 'cc') return claudeChat(account(accId), id, { sessionId: e.meta.sessionId, cwd: e.meta.cwd, text, onText, signal, model });
  if (kind === 'cx') { const a = account(accId); return codex.prompt(a, { sessionId: e.meta.sessionId, cwd: e.meta.cwd, text, onText, signal }); }
  if (kind === 'cu') return cursor.prompt(account(accId), { agentId: ref, text });
  if (kind === 'lc') return apiChat.prompt(account(accId), { chatId: ref, text, onText, signal });
  if (kind === 'gb') return grokbot.send(ref, text, { prefillOnly: opts.prefillOnly });
  if (kind === 'cd') throw new Error('Claude app sessions are read-only here. Open them in the Claude app.');
  if (kind === 'pj' || kind === 'ac' || kind === 'cl') {
    let a, cwd = HOME;
    if (kind === 'ac') a = account(accId);
    const pickOpts = { accountId: opts.accountId, group: opts.group };
    if (kind === 'pj') { cwd = id.slice(3); a = pickAccount(['claude-code', 'codex', 'anthropic-api', 'openai-compatible'], { ...pickOpts, cwd }); }
    if (kind === 'cl') { const c = clients().find((x) => x.id === accId); const p = c && c.project_paths[0]; if (p) cwd = p; a = pickAccount(['claude-code', 'anthropic-api', 'openai-compatible'], { ...pickOpts, cwd: p || null }); }
    if (!a) throw new Error('Add a Claude account first');
    if (a.kind === 'claude-code') return claudeChat(a, id, { cwd, text, onText, signal, model });
    if (a.kind === 'codex') return codex.prompt(a, { cwd, text, onText, signal });
    if (a.kind === 'anthropic-api' || a.kind === 'openai-compatible') { const r = await apiChat.prompt(a, { text, onText, signal }); return { ...r, entityId: `lc:${a.id}:${r.chatId}` }; }
    if (a.kind === 'grok-bot') return grokAccountSend(text, opts);
    throw new Error(`${a.label} can't take prompts`);
  }
  if (kind === 'out' || kind === 'nt') throw new Error('Drop this on an agent or chat to send it');
  throw new Error('This card cannot take prompts');
}

// A Claude chat run from Switchboard (a reply to a chat, or a new chat from an account, folder or
// client). Whatever Claude would ask permission for in the Claude app is asked on the chat's card
// instead (electron/approvals.cjs), as long as the run lasts.
async function claudeChat(a, origin, opts) {
  if (!a) throw new Error('That Claude account is no longer in Switchboard.');
  const ask = approvals.openRun({ origin, accountId: a.id });
  try {
    const r = await claudeCode.prompt(a, { ...opts, ask });
    return { ...r, entityId: `cc:${a.id}:${r.sessionId}` };
  } finally { if (ask) ask.close(); }
}

// The Grok Bot account card sends to the bot that is selected in the Grok Bot app. Nothing is
// copied to the clipboard: if it can't send, it says so and the card offers "Open in Grok Bot".
async function grokAccountSend(text, opts = {}) {
  if (!grokbot.enabled()) throw new Error('The Grok Bot connection is off. Turn it on in Accounts.');
  const st = grokbot.status();
  if (!st.installed) throw new Error("Grok Bot isn't installed on this Mac, so nothing was sent.");
  const agentId = grokbot.selectedAgent();
  if (!agentId) throw new Error("Couldn't tell which Grok bot to send to. Send from that bot's own card, or open Grok Bot and pick the bot first.");
  return grokbot.send(agentId, text, { prefillOnly: opts.prefillOnly });
}

// ---------- diagrams agents draw on the board ----------
// Notes joined by labelled links inside a new frame, laid out left to right by how far each
// note is from the start of the arrows.
const DG = { COL: 280, ROW: 160, PAD: 28, HEAD: 56, CARD_W: 240, CARD_H: 130, GAP: 80, MAX: 80 };

// Arrows that loop back (found by a depth-first walk from the notes nothing points to) don't push
// notes further right, so cycles still lay out cleanly.
function diagramLayers(n, arrows) {
  const out = Array.from({ length: n }, () => []);
  const indeg = new Array(n).fill(0);
  for (const { a, b } of arrows) { out[a].push(b); indeg[b]++; }
  const state = new Array(n).fill(0);
  const forward = [];
  const visit = (u) => {
    state[u] = 1;
    for (const v of out[u]) { if (state[v] === 1) continue; forward.push([u, v]); if (!state[v]) visit(v); }
    state[u] = 2;
  };
  for (const u of [...Array(n).keys()].sort((x, y) => (indeg[x] > 0) - (indeg[y] > 0))) if (!state[u]) visit(u);
  const d = new Array(n).fill(0);
  for (let pass = 0; pass < n; pass++) {
    let changed = false;
    for (const [a, b] of forward) if (d[a] + 1 > d[b]) { d[b] = d[a] + 1; changed = true; }
    if (!changed) break;
  }
  const levels = [...new Set(d)].sort((x, y) => x - y);
  return d.map((v) => levels.indexOf(v));
}

function makeBoard({ title, nodes = [], edges: links = [], from } = {}) {
  const spec = [];
  const index = new Map();
  for (const [i, n] of (Array.isArray(nodes) ? nodes : []).slice(0, DG.MAX).entries()) {
    const node = typeof n === 'string' ? { id: `n${i + 1}`, text: n } : { id: String((n && n.id) ?? `n${i + 1}`), text: String((n && (n.text ?? n.label ?? n.title)) ?? '').trim() };
    if (index.has(node.id)) continue;
    index.set(node.id, spec.length); spec.push({ ...node, text: node.text || node.id });
  }
  if (!spec.length) throw new Error('A board needs at least one node');
  const arrows = (Array.isArray(links) ? links : []).map((e) => e && ({ a: index.get(String(e.from ?? e.source)), b: index.get(String(e.to ?? e.target)), label: e.label ? truncate(e.label, 60) : '' }))
    .filter((e) => e && e.a != null && e.b != null && e.a !== e.b);
  const col = diagramLayers(spec.length, arrows);
  const cols = Math.max(...col) + 1;
  const stacks = Array.from({ length: cols }, () => []);
  spec.forEach((_, i) => stacks[col[i]].push(i));
  const tall = Math.max(...stacks.map((s) => s.length));

  const tops = board().filter((r) => !r.parent_id && !r.hidden);
  const x0 = tops.length ? Math.min(...tops.map((r) => r.x)) : 0;
  const y0 = tops.length ? Math.max(...tops.map((r) => r.y + (r.h || 260))) + DG.GAP : 0;
  const frameId = `grp:ai:${uid()}`;
  const frames = tops.filter((r) => r.id.startsWith('grp:ai:')).length;
  const ids = spec.map((n) => saveNote({ text: n.text }));
  const rows = [{
    id: frameId, x: x0, y: y0, w: DG.PAD * 2 + (cols - 1) * DG.COL + DG.CARD_W, h: DG.HEAD + (tall - 1) * DG.ROW + DG.CARD_H + DG.PAD,
    parent_id: null, data: { label: truncate(title || 'Diagram', 80), color: PALETTE[(frames + 4) % PALETTE.length], smart: false, ai: true, from: from || null, count: ids.length },
  }];
  stacks.forEach((stack, c) => stack.forEach((i, r) => rows.push({
    id: ids[i], x: DG.PAD + c * DG.COL, y: DG.HEAD + r * DG.ROW + ((tall - stack.length) * DG.ROW) / 2, parent_id: frameId, data: {},
  })));
  saveBoard(rows);
  const edgeIds = arrows.map((e) => saveEdge({ source: ids[e.a], target: ids[e.b], kind: 'link', data: { label: e.label, diagram: frameId } }));
  invalidate();
  emit({ type: 'board-changed', frameId });
  // The renderer reloads board rows on a lit line; do that before it sees the new note cards,
  // so it doesn't place them itself.
  emit({ type: 'flow', flow: { id: uid('f'), source: from || '', target: frameId, preview: truncate(title || '', 140), content: '', via: 'board', ts: Date.now() }, edgeId: edgeIds[0] || frameId });
  emit({ type: 'entities-changed' });
  return { frameId, ids, edges: edgeIds };
}

// ---------- outputs & notes ----------
function saveOutput({ title, content, source }) {
  const id = uid('o');
  db.exec('INSERT INTO outputs(id, title, content, source, ts) VALUES(?,?,?,?,?)', id, title || truncate(content, 60), content, source || null, Date.now());
  invalidate();
  return `out:${id}`;
}
function deleteEntity(id) {
  const [kind, a] = id.split(':');
  if (kind === 'out') db.exec('DELETE FROM outputs WHERE id = ?', a);
  if (kind === 'nt') db.exec('DELETE FROM notes WHERE id = ?', a);
  if (kind === 'cl') db.exec('DELETE FROM clients WHERE id = ?', a);
  db.exec('DELETE FROM board_nodes WHERE id = ?', id);
  invalidate();
}
function saveNote({ id, text }) {
  if (id) db.exec('UPDATE notes SET text = ?, ts = ? WHERE id = ?', text, Date.now(), id.replace(/^nt:/, ''));
  else { id = 'nt:' + uid('n'); db.exec('INSERT INTO notes(id, text, ts) VALUES(?,?,?)', id.slice(3), text, Date.now()); }
  invalidate();
  return id;
}

// ---------- board layout ----------
function board() { return db.all('SELECT * FROM board_nodes').map((n) => ({ ...n, data: db.J(n.data, {}) })); }
// A row shown again is no longer hidden by a blank board (data.viewHidden, see ext/boards.cjs).
function saveBoard(nodes) {
  for (let n of nodes) {
    if (!n.hidden && n.data && n.data.viewHidden != null) { n = { ...n, data: { ...n.data } }; delete n.data.viewHidden; }
    db.exec(`INSERT INTO board_nodes(id, x, y, w, h, parent_id, data, hidden) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h, parent_id = excluded.parent_id, data = excluded.data, hidden = excluded.hidden`,
    n.id, n.x, n.y, n.w ?? null, n.h ?? null, n.parent_id ?? null, JSON.stringify(n.data || {}), n.hidden ? 1 : 0);
  }
}
function deleteBoardNodes(ids) { for (const id of ids) db.exec('DELETE FROM board_nodes WHERE id = ?', id); }

// ---------- CRM ----------
function clients() {
  return db.all('SELECT * FROM clients ORDER BY updated_at DESC').map((c) => ({ ...c, emails: db.J(c.emails, []), domains: db.J(c.domains, []), project_paths: db.J(c.project_paths, []) }));
}
function saveClient(c) {
  const id = c.id || uid('cl');
  const emails = (c.emails || []).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const domains = [...new Set([...(c.domains || []), ...emails.map((e) => e.split('@')[1])].map((d) => (d || '').trim().toLowerCase()).filter((d) => d && !GENERIC.has(d)))];
  db.exec(`INSERT INTO clients(id, name, company, emails, domains, status, value, next_action, due, notes, project_paths, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, company = excluded.company, emails = excluded.emails,
    domains = excluded.domains, status = excluded.status, value = excluded.value, next_action = excluded.next_action, due = excluded.due,
    notes = excluded.notes, project_paths = excluded.project_paths, updated_at = excluded.updated_at`,
  id, c.name, c.company || null, JSON.stringify(emails), JSON.stringify(domains), c.status || 'active', c.value ?? null, c.next_action || null, c.due || null, c.notes || null, JSON.stringify(c.project_paths || []), c.created_at || Date.now(), Date.now());
  invalidate();
  return id;
}

const GENERIC = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'live.com']);

function matchesClient(c, email) {
  if (!email) return false;
  email = email.toLowerCase();
  return c.emails.includes(email) || c.domains.includes(email.split('@')[1]);
}

async function allThreads() {
  const out = [];
  for (const a of accounts().filter((a) => a.kind === 'gmail')) {
    try { for (const t of await gmail.threads(a)) out.push({ ...t, accountId: a.id }); } catch {}
  }
  return out;
}
function allMeetings() {
  const out = [];
  for (const a of accounts().filter((a) => a.kind === 'granola')) { try { for (const d of granola.load(a)) out.push({ ...d, accountId: a.id }); } catch {} }
  return out;
}

async function due() {
  const items = [];
  const now = Date.now();
  const cs = clients();
  const threads = await allThreads();
  const meetings = allMeetings();
  const myEmails = new Set(accounts().filter((a) => a.kind === 'gmail').map((a) => (a.config.email || '').toLowerCase()));
  for (const c of cs) {
    if (c.status === 'done' || c.status === 'lost') continue;
    if (c.next_action) {
      const d = c.due ? Date.parse(c.due) : null;
      items.push({ id: `act:${c.id}`, clientId: c.id, client: c.name, kind: 'action', title: c.next_action, due: d, overdue: d ? d < now - 86400000 + 1 : false, ref: `cl:${c.id}` });
    }
    const theirs = threads.filter((t) => t.participants.some((p) => matchesClient(c, p)));
    for (const t of theirs) {
      if (!t.lastFromMe && now - t.updatedAt > 6 * 3600000) {
        items.push({ id: `reply:${t.id}`, clientId: c.id, client: c.name, kind: 'reply', title: `Reply to ${t.last.fromName}: ${t.subject}`, due: t.updatedAt + 86400000, overdue: now - t.updatedAt > 2 * 86400000, ref: `gm:${t.accountId}:${t.id}` });
      }
    }
    const lastOut = Math.max(0, ...theirs.flatMap((t) => t.messages.filter((m) => myEmails.has(m.from)).map((m) => m.ts)));
    for (const m of meetings.filter((m) => now - m.at < 14 * 86400000 && m.at < now && m.attendees.some((a) => matchesClient(c, a.email)))) {
      if (lastOut < m.at) items.push({ id: `fu:${m.id}:${c.id}`, clientId: c.id, client: c.name, kind: 'followup', title: `Follow up after "${m.title}"`, due: m.at + 2 * 86400000, overdue: now - m.at > 3 * 86400000, ref: `gr:${m.accountId}:${m.id}` });
    }
  }
  items.sort((a, b) => (a.due || Infinity) - (b.due || Infinity));
  return items;
}

// People you write back and forth with who aren't clients yet.
async function suggestions() {
  const cs = clients();
  const me = new Set(accounts().filter((a) => a.kind === 'gmail').map((a) => (a.config.email || '').toLowerCase()));
  const byKey = new Map();
  for (const t of await allThreads()) {
    const iReplied = t.messages.some((m) => me.has(m.from));
    if (!iReplied) continue;
    for (const p of t.participants) {
      if (me.has(p) || /no-?reply|notifications?|mailer|support@|billing@|calendar/i.test(p)) continue;
      if (cs.some((c) => matchesClient(c, p))) continue;
      const dom = p.split('@')[1];
      const key = GENERIC.has(dom) ? p : dom;
      const s = byKey.get(key) || { key, email: p, domain: GENERIC.has(dom) ? null : dom, name: '', threads: 0, last: 0, subject: '' };
      const msg = t.messages.find((m) => m.from === p);
      if (msg && !s.name) s.name = msg.fromName;
      s.threads++; if (t.updatedAt > s.last) { s.last = t.updatedAt; s.subject = t.subject; }
      byKey.set(key, s);
    }
  }
  return [...byKey.values()].filter((s) => s.threads >= 1).sort((a, b) => b.last - a.last).slice(0, 20);
}

// ---------- usage ----------
// One row per account, plus a 'claude-app' row for each Claude org the desktop app meters that no
// account card covers (usage.weekPct / fiveHourPct are the app's real plan percentages).
function usageSummary() {
  const rows = accounts().map((a) => ({ id: a.id, label: a.label, kind: a.kind, color: a.color, usage: usageFor(a) }));
  const covered = new Set(rows.map((r) => r.usage && r.usage.org).filter(Boolean));
  let plans = []; try { plans = claudeDesktop.planUsage(); } catch {}
  for (const p of plans) {
    if (covered.has(p.org)) continue;
    rows.push({ id: `org:${p.org}`, label: p.name ? `Claude · ${p.name}` : `Claude org ${p.org.slice(0, 8)}`, kind: 'claude-app', color: null,
      usage: { h5: 0, d1: 0, d7: 0, out7: 0, sessions: 0, byModel: {}, weekPct: p.week, fiveHourPct: p.fiveHour, resetsAt: p.resetsAt, planAt: p.at, org: p.org, exact: true } });
  }
  return rows;
}

// ---------- the overall agent ----------
const CHIEF_ID = 'chief';
function chiefHistory() {
  return db.all("SELECT id, role, content AS text, ts FROM chat_messages WHERE chat_id = 'chief' ORDER BY ts DESC LIMIT 30").reverse();
}

async function chiefContext(selected) {
  const parts = [];
  const items = await due().catch(() => []);
  if (items.length) parts.push('What is due (from the CRM, Gmail and Granola):\n' + items.slice(0, 20).map((d) => `- ${d.client}: ${d.title}${d.due ? ` (due ${new Date(d.due).toDateString()})` : ''}`).join('\n'));
  const b = brain().trim(); if (b) parts.push('Shared brain:\n' + truncate(b, 8000));
  const cs = clients(); if (cs.length) parts.push('Clients:\n' + cs.map((c) => `- ${c.name}${c.company ? ` (${c.company})` : ''} [${c.status}]${c.next_action ? ` next: ${c.next_action}` : ''}`).join('\n'));
  for (const id of selected || []) {
    const t = await transcriptFor(id).catch(() => []);
    parts.push(`Card "${label(id)}" (${id}), latest messages:\n` + truncate(t.slice(-10).map((m) => `${m.role}: ${m.text}`).join('\n\n'), 12000));
  }
  const ents = await entities();
  parts.push('Cards on the board:\n' + ents.filter((e) => ['session', 'project', 'account', 'client'].includes(e.kind) && !(e.meta && e.meta.noise)).slice(0, 80).map((e) => `- ${e.id} · ${e.title}`).join('\n'));
  return parts.join('\n\n');
}

const CHIEF_SYSTEM = `You are the overall agent inside Switchboard, a local whiteboard where the user sees all their AI agents, chats, code projects and clients.
You can read the context below. Be brief and concrete: lead with the answer. When you compare outputs, say which is better and why in a few lines.
When the user asks you to hand work to another card, use the switchboard tools if you have them (send_to_card), otherwise write the exact prompt they should send.
When the user asks to organize, group, sort or arrange the board, call group_board with their rule in their own words (for example "by client or by the work being done; Grok bots in their own group unless they belong to one project"). Never draw notes or frames to describe groups instead.
Never send email or take actions outside Switchboard.`;

// Asks the open window to regroup the board by the user's rule (the window owns the layout).
function requestRegroup(instruction) {
  emit({ type: 'regroup', instruction: String(instruction || '').slice(0, 400) });
  return { ok: true };
}

function chief(question, { selected = [], accountId } = {}) {
  const runId = uid('r');
  runs.set(runId, { id: runId, entityId: CHIEF_ID, text: '', status: 'running', startedAt: Date.now() });
  emit({ type: 'run', run: runs.get(runId) });
  db.exec('INSERT INTO chat_messages(id, chat_id, role, content, ts) VALUES(?,?,?,?,?)', uid('m'), 'chief', 'user', question, Date.now());
  (async () => {
    const a = (accountId && account(accountId)) || pickAccount(['claude-code', 'anthropic-api', 'openai-compatible']);
    if (!a) throw new Error('Add a Claude account or an API key so the overall agent can run');
    const ctx = await chiefContext(selected);
    const history = chiefHistory();
    const onText = (t) => { const r = runs.get(runId); r.text = t; emit({ type: 'run', run: r }); };
    let res;
    if (a.kind === 'claude-code') {
      const convo = history.slice(0, -1).slice(-10).map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.text}`).join('\n\n');
      const text = `${CHIEF_SYSTEM}\n\n${ctx}\n\n${convo ? 'Conversation so far:\n' + convo + '\n\n' : ''}User: ${question}`;
      const mcp = mcpConfigPath();
      const extra = [...(mcp ? ['--mcp-config', mcp, '--allowedTools', 'mcp__switchboard'] : []), ...internalArgs()];
      res = await claudeCode.prompt(a, { cwd: APP_DIR, text, onText, extraArgs: extra });
    } else {
      const messages = history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }));
      res = await apiChat.complete(a, { system: CHIEF_SYSTEM + '\n\n' + ctx, messages, onText });
    }
    db.exec('INSERT INTO chat_messages(id, chat_id, role, content, ts) VALUES(?,?,?,?,?)', uid('m'), 'chief', 'assistant', res.text, Date.now());
    const r = runs.get(runId); r.text = res.text; r.status = 'done'; emit({ type: 'run', run: r });
    for (const id of selected) recordFlow(id, CHIEF_ID, `Read by the overall agent: ${question}`, 'chief');
  })().catch((err) => { const r = runs.get(runId); r.status = 'error'; r.error = err.message; emit({ type: 'run', run: r }); });
  return runId;
}

// A quick one-off question to Claude (no tools, short timeout) for helpers like smart grouping.
// Runs inside ~/.switchboard so it never shows up as a card.
// Switchboard's own Claude runs (main agent, grouping, topics) must not pick up the user's personal
// hooks, which inject routing advice and other text into the answer.
function internalArgs() {
  const f = path.join(APP_DIR, 'internal-settings.json');
  try { if (!exists(f)) fs.writeFileSync(f, JSON.stringify({ disableAllHooks: true })); } catch {}
  return ['--settings', f];
}

async function quickAsk(text, { timeoutMs = 25000, model = 'sonnet' } = {}) {
  const a = pickAccount(['claude-code']);
  if (!a) throw new Error('No Claude account');
  const quiet = { ...a, config: { ...a.config, permissionMode: undefined } };
  const res = await claudeCode.prompt(quiet, { cwd: APP_DIR, text, signal: AbortSignal.timeout(timeoutMs), extraArgs: ['--model', model, '--tools', '', ...internalArgs()] });
  return res.text || '';
}

let mcpPathMemo = null;
function mcpConfigPath() {
  const sb = path.join(APP_DIR, 'bin', 'sb');
  if (!exists(sb)) return null;
  if (!mcpPathMemo) {
    mcpPathMemo = path.join(APP_DIR, 'mcp.json');
    fs.writeFileSync(mcpPathMemo, JSON.stringify({ mcpServers: { switchboard: { command: sb, args: ['mcp'], env: { SB_FROM: CHIEF_ID } } } }, null, 2));
  }
  return mcpPathMemo;
}

module.exports = {
  events, accounts, publicAccount, account, saveAccount, deleteAccount, firstRunSetup,
  claudeStatus, claudeLogin, claudeLoginCancel, claudeLogout,
  entities, invalidate, transcriptFor, find, label,
  prompt, stopRun, runs, sentReplies, recordFlow, flowsFor, edges, saveEdge, deleteEdge, forwardFinished, makeBoard, quickAsk, internalArgs,
  brain, setBrain, appendBrain, saveOutput, saveNote, deleteEntity,
  board, saveBoard, deleteBoardNodes,
  clients, saveClient, due, suggestions, usageSummary, chief, chiefHistory, pickAccount, addFinder, addExtraEntities, requestRegroup, use,
  gmailConnect: (id) => gmail.connect(account(id)).then((email) => { const a = account(id); a.config.email = email; saveAccount(a); return email; }),
  BRAIN,
};
