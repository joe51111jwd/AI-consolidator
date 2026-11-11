'use strict';
// History: every past Claude session from every Claude account (no 7-day cutoff), plus the
// Claude desktop app's agent sessions, paged newest first. The board keeps showing recent work
// only; older sessions are found here, by ⌘K, and open/resume by id like any other card.
const path = require('path');
const hub = require('../hub.cjs');
const claudeCode = require('../sources/claudeCode.cjs');
const search = require('./search.cjs');

const index = new Map(); // id -> card, for every session seen so far

function files(accountId) {
  const out = [];
  for (const a of hub.accounts()) {
    if (a.kind !== 'claude-code' || (accountId && accountId !== a.id)) continue;
    for (const f of claudeCode.sessionFiles(a, null)) out.push({ ...f, account: a });
  }
  return out;
}

function desktop(accountId) {
  if (accountId && accountId !== 'claude-app') return [];
  try { return claudeCode.desktopList({ days: null }); } catch { return []; }
}

function remember(e) { if (e) index.set(e.id, e); return e; }

function item(e) {
  const a = e.accountId && hub.account(e.accountId);
  return {
    id: e.id, title: e.title, source: e.source, accountId: e.accountId, accountLabel: a ? a.label : 'Claude app',
    cwd: e.meta.cwd || null, category: e.meta.category || null, updatedAt: e.updatedAt, preview: e.preview || '',
    messages: e.meta.messages || 0, archived: !!e.meta.archived, readOnly: !!e.meta.readOnly,
  };
}

function matches(e, terms) {
  if (!terms.length) return true;
  const hay = [e.title, e.preview, e.meta.cwd, e.meta.gitBranch].filter(Boolean).join(' ').toLowerCase();
  if (terms.every((t) => hay.includes(t))) return true;
  let body = '';
  try { body = claudeCode.parseSession(e.meta.file).messages.filter((m) => m.kind !== 'tool').map((m) => m.text).join('\n').toLowerCase(); } catch {}
  return terms.every((t) => body.includes(t));
}

// history:list({ accountId?, q?, limit = 50, before? }) -> { items, nextBefore }
function list({ accountId, q, limit = 50, before } = {}) {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const cutoff = before || Infinity;
  const cands = [
    ...files(accountId).map((f) => ({ at: f.mtimeMs, load: () => claudeCode.entityFor(f.account, f.path) })),
    ...desktop(accountId).map((e) => ({ at: e.updatedAt, load: () => e })),
  ].filter((c) => c.at < cutoff).sort((x, y) => y.at - x.at);
  const items = [];
  let i = 0;
  for (; i < cands.length && items.length < limit; i++) {
    const e = remember(cands[i].load());
    if (e && matches(e, terms)) items.push(item(e));
  }
  return { items, nextBefore: i < cands.length ? cands[i - 1].at : null };
}

// Finds a session card by id when it isn't on the board (too old for the board's window).
function resolve(id) {
  if (index.has(id)) return index.get(id);
  const [kind, accId, ...rest] = id.split(':');
  const ref = rest.join(':');
  if (kind === 'cc') {
    const a = hub.account(accId);
    if (!a || a.kind !== 'claude-code') return null;
    const f = claudeCode.sessionFiles(a, null).find((x) => path.basename(x.path, '.jsonl') === ref);
    return f ? remember(claudeCode.entityFor(a, f.path)) : null;
  }
  if (kind === 'cd') return remember(desktop().find((e) => e.id === id)) || null;
  return null;
}
hub.addFinder(resolve);

// Imported chats: older sessions the user brought onto the board. They stay cards even though the
// sources only list the last week.
const db = require('../db.cjs');
const IMPORTED = 'importedChats';
const imported = () => db.getSetting(IMPORTED, []) || [];
hub.addExtraEntities(() => imported().map((id) => { try { return resolve(id); } catch { return null; } }).filter(Boolean));
function importChat(id) {
  const e = resolve(id);
  if (!e) throw new Error('Chat not found');
  const ids = imported();
  if (!ids.includes(id)) db.setSetting(IMPORTED, [...ids, id].slice(-200));
  hub.invalidate();
  return item(e);
}

// ⌘K also finds older sessions: they are added after the board's own results, matched on title,
// preview and folder from the sessions History has already read.
const HISTORY_PREFIX = /^(claude|chat|chats|code|coding|history)(?::|\s)\s*/i;
const baseQuery = search.handlers['search:query'];
search.handlers['search:query'] = async (q, opts = {}) => {
  const hits = await baseQuery(q, opts);
  const raw = String(q || '').trim();
  const other = /^[a-z]+:/i.test(raw) && !HISTORY_PREFIX.test(raw);
  const terms = raw.replace(HISTORY_PREFIX, '').toLowerCase().split(/\s+/).filter(Boolean);
  if (other || !terms.length) return hits;
  const seen = new Set(hits.map((h) => h.id));
  const limit = opts.limit || 40;
  const extra = [...index.values()]
    .filter((e) => !seen.has(e.id) && terms.every((t) => [e.title, e.preview, e.meta.cwd].filter(Boolean).join(' ').toLowerCase().includes(t)))
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(0, limit - hits.length))
    .map((e) => ({ id: e.id, title: e.title, source: e.source, kind: e.kind, snippet: e.preview || '', updatedAt: e.updatedAt, score: 0, history: true }));
  return [...hits, ...extra];
};

// Reads every session once in the background, a file at a time, so History and ⌘K are quick.
function warm() {
  const queue = [
    ...files().map((f) => () => remember(claudeCode.entityFor(f.account, f.path))),
    ...desktop().map((e) => () => remember(e)),
  ];
  const step = () => {
    const job = queue.shift();
    if (!job) return;
    try { job(); } catch {}
    setTimeout(step, 5);
  };
  step();
}

module.exports = {
  handlers: {
    'history:list': (opts) => list(opts || {}),
    'history:get': (id) => { const e = resolve(id); return e ? item(e) : null; },
    'history:import': (id) => importChat(id),
  },
  start() { setTimeout(warm, 4000); },
};
