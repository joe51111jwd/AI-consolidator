'use strict';
// claude.ai history: your chats and Projects from claude.ai and the Claude app, imported from
// claude.ai's own data export (Settings → Privacy → Export data), since they are not kept on the Mac
// in a form the app can read. Settings → Accounts → "Import claude.ai history" picks the zip(s) or the
// unzipped folder; sources/claudeAi.cjs reads them. Everything is kept in the app's database
// (claudeai_* tables, made here) and importing again updates chats by their id, so nothing doubles.
//
// Each chat is a read-only card (source 'claude-ai', id ca:<uuid>) that opens in the chat panel, is
// found by ⌘K (titles, summaries, Project names and every message) and sorts into topics. Projects
// are groups: a chat's meta.project is its Project's name, and topics.cjs keeps a Project's threads
// together, joined by Claude chats that report the same Project through Switchboard Relay.
//
// The export does not say which Project a chat is in, so that comes from, strongest first:
//   you      set by hand on the card (never overwritten);
//   export   a project id in the chat itself (claude.ai's API has it; today's export does not);
//   knowledge the chat searched a Project's files (project knowledge search names the files);
//   ai       Claude read each chat's title and summary next to the Projects' names, descriptions,
//            instructions and file names, and picked one (or none), like topics.cjs sorts the home.
const hub = require('../hub.cjs');
const db = require('../db.cjs');
const search = require('./search.cjs');
const topics = require('./topics.cjs');
const reader = require('../sources/claudeAi.cjs');
const { truncate } = require('../util.cjs');

const MAX_CARDS = 3000;      // newest chats listed as cards; older ones are still found and opened by id
const PROJECT_THREADS = 60;  // threads of one Project the topics tree holds
const SHOW_ON_BOARD = 24;    // threads "Show on board" puts on the board
const MATCH_BATCH = 80;
const MATCH_LIMIT = 800;     // chats Claude is asked about per run, newest first
const MAX_BODY = 300000;     // text kept per chat for search
const RANK = { you: 4, export: 3, knowledge: 2, ai: 1 };
const PINNED = 'claudeAiPinned';
const LAST = 'claudeAiLastImport';

const emit = (e) => hub.events.emit('event', e);
let cache = null;
const changed = () => { cache = null; hub.invalidate(); emit({ type: 'entities-changed' }); };

// ---------- storage ----------
let ready = false;
function schema() {
  if (ready) return;
  db.db.exec(`
CREATE TABLE IF NOT EXISTS claudeai_accounts (uuid TEXT PRIMARY KEY, name TEXT, email TEXT, imported_at INTEGER);
CREATE TABLE IF NOT EXISTS claudeai_projects (
  uuid TEXT PRIMARY KEY, account_uuid TEXT, name TEXT, description TEXT, instructions TEXT,
  docs TEXT NOT NULL DEFAULT '[]', created_at INTEGER, updated_at INTEGER, imported_at INTEGER);
CREATE TABLE IF NOT EXISTS claudeai_chats (
  uuid TEXT PRIMARY KEY, account_uuid TEXT, name TEXT, summary TEXT, created_at INTEGER, updated_at INTEGER,
  messages INTEGER, first_prompt TEXT, preview TEXT, knowledge TEXT NOT NULL DEFAULT '[]',
  project_uuid TEXT, project_name TEXT, project_via TEXT, ai_checked INTEGER, imported_at INTEGER);
CREATE TABLE IF NOT EXISTS claudeai_messages (
  chat_uuid TEXT NOT NULL, idx INTEGER NOT NULL, role TEXT, kind TEXT, text TEXT, ts INTEGER, PRIMARY KEY (chat_uuid, idx));
CREATE TABLE IF NOT EXISTS claudeai_search (chat_uuid TEXT PRIMARY KEY, body TEXT);
CREATE INDEX IF NOT EXISTS claudeai_chats_updated ON claudeai_chats(updated_at);
CREATE INDEX IF NOT EXISTS claudeai_chats_project ON claudeai_chats(project_uuid);
`);
  ready = true;
}

// One synchronous transaction: nothing else can write in between, so a failure rolls back only this.
function tx(fn) {
  db.db.exec('BEGIN');
  try { const r = fn(); db.db.exec('COMMIT'); return r; } catch (e) { try { db.db.exec('ROLLBACK'); } catch {} throw e; }
}

function saveUser(u, now) {
  db.exec(`INSERT INTO claudeai_accounts(uuid, name, email, imported_at) VALUES(?,?,?,?)
    ON CONFLICT(uuid) DO UPDATE SET name = excluded.name, email = excluded.email, imported_at = excluded.imported_at`, u.uuid, u.name, u.email, now);
}

function saveProject(p, user, now) {
  db.exec(`INSERT INTO claudeai_projects(uuid, account_uuid, name, description, instructions, docs, created_at, updated_at, imported_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(uuid) DO UPDATE SET account_uuid = COALESCE(excluded.account_uuid, claudeai_projects.account_uuid),
    name = excluded.name, description = excluded.description, instructions = excluded.instructions, docs = excluded.docs,
    created_at = excluded.created_at, updated_at = excluded.updated_at, imported_at = excluded.imported_at`,
  p.uuid, user ? user.uuid : null, p.name, p.description, p.instructions, JSON.stringify(p.docs), p.createdAt, p.updatedAt, now);
}

// Project files by name and id -> the Projects holding them (a name in two Projects proves nothing).
function docIndex() {
  const idx = new Map();
  for (const p of db.all('SELECT uuid, docs FROM claudeai_projects')) {
    for (const d of db.J(p.docs, [])) {
      for (const k of [d.filename, d.uuid]) {
        if (!k) continue;
        const key = String(k).toLowerCase();
        idx.set(key, new Set([...(idx.get(key) || []), p.uuid]));
      }
    }
  }
  return idx;
}
function knowledgeProject(refs, idx) {
  const hits = new Set();
  for (const r of refs || []) for (const p of idx.get(r) || []) hits.add(p);
  return hits.size === 1 ? [...hits][0] : null;
}

let insMsg = null;
function saveChat(c, now, idx) {
  const prev = db.get('SELECT updated_at, messages, project_uuid, project_via FROM claudeai_chats WHERE uuid = ?', c.uuid);
  let pu = prev ? prev.project_uuid : null;
  let via = prev ? prev.project_via : null;
  const offer = (uuid, how) => { if (uuid && RANK[how] > (RANK[via] || 0)) { pu = uuid; via = how; } };
  offer(c.projectUuid, 'export');
  offer(knowledgeProject(c.knowledge, idx), 'knowledge');
  const same = !!prev && prev.updated_at === c.updatedAt && prev.messages === c.messages;
  db.exec(`INSERT INTO claudeai_chats(uuid, account_uuid, name, summary, created_at, updated_at, messages, first_prompt, preview, knowledge, project_uuid, project_name, project_via, imported_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(uuid) DO UPDATE SET account_uuid = excluded.account_uuid, name = excluded.name, summary = excluded.summary,
    created_at = excluded.created_at, updated_at = excluded.updated_at, messages = excluded.messages, first_prompt = excluded.first_prompt, preview = excluded.preview,
    knowledge = excluded.knowledge, project_uuid = excluded.project_uuid, project_name = excluded.project_name, project_via = excluded.project_via, imported_at = excluded.imported_at`,
  c.uuid, c.account || null, c.name, c.summary, c.createdAt, c.updatedAt, c.messages, c.firstPrompt, c.preview, JSON.stringify(c.knowledge),
  pu || null, c.projectName || null, via || null, now);
  if (same) return 'same';
  // A chat with new messages may now be plainly about a Project: Claude looks at it again.
  if (!via) db.exec('UPDATE claudeai_chats SET ai_checked = NULL WHERE uuid = ?', c.uuid);
  db.exec('DELETE FROM claudeai_messages WHERE chat_uuid = ?', c.uuid);
  insMsg = insMsg || db.db.prepare('INSERT INTO claudeai_messages(chat_uuid, idx, role, kind, text, ts) VALUES(?,?,?,?,?,?)');
  c.rows.forEach((r, i) => insMsg.run(c.uuid, i, r.role, r.kind || null, r.text, r.ts || null));
  const body = [c.name, c.summary, ...c.rows.filter((r) => !r.kind).map((r) => r.text)].filter(Boolean).join('\n').slice(0, MAX_BODY);
  db.exec('INSERT INTO claudeai_search(chat_uuid, body) VALUES(?,?) ON CONFLICT(chat_uuid) DO UPDATE SET body = excluded.body', c.uuid, body);
  return prev ? 'updated' : 'added';
}

// ---------- importing ----------
let importing = null;
const state = { importing: false, matching: false, progress: null };
const publish = () => emit({ type: 'claudeai', status: status() });

async function importFrom(paths) {
  if (importing) throw new Error('An import is already running.');
  schema();
  importing = (async () => {
    const now = Date.now();
    const stats = { added: 0, updated: 0, same: 0 };
    let pending = [];
    let idx = null;
    state.importing = true; state.progress = { chats: 0 }; publish();
    const flush = () => {
      if (!pending.length) return;
      const batch = pending; pending = [];
      tx(() => { for (const c of batch) stats[saveChat(c, now, idx)]++; });
      state.progress = { chats: stats.added + stats.updated + stats.same };
      publish();
    };
    let r;
    try {
      r = await reader.read(paths, {
        onUser: (u) => saveUser(u, now),
        onProject: (p, user) => saveProject(p, user, now),
        onConversation: (c) => {
          if (!c) return;
          if (!idx) idx = docIndex();
          pending.push(c);
          if (pending.length >= 50) flush();
        },
      });
      flush();
    } finally { state.importing = false; state.progress = null; }
    const result = {
      at: now, ...stats, skipped: r.skipped, projects: r.projects, accounts: r.users.map((u) => u.email || u.name).filter(Boolean),
      missing: r.missing, problems: r.problems,
    };
    db.setSetting(LAST, result);
    changed();
    publish();
    // Which Project each new chat is in: Claude suggests it in the background.
    if (r.conversations && db.get('SELECT 1 AS x FROM claudeai_projects LIMIT 1')) matchProjects().catch(() => {});
    return result;
  })().finally(() => { importing = null; });
  return importing;
}

async function pick() {
  const { dialog, BrowserWindow } = require('electron');
  const mac = process.platform === 'darwin';
  const opts = {
    title: 'Import claude.ai history',
    message: 'Pick the zip file(s) from claude.ai’s export email, or the folder you unzipped them into.',
    buttonLabel: 'Import',
    properties: mac ? ['openFile', 'openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
    filters: [{ name: 'claude.ai export', extensions: ['zip', 'json'] }],
  };
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const r = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
  return r.canceled ? null : r.filePaths;
}

// ---------- cards ----------
function titleOf(r) {
  const line = (s) => truncate(String(s || '').split('\n')[0].replace(/\s+/g, ' ').trim(), 80);
  return line(r.name) || line(r.summary) || line(r.first_prompt) || 'Untitled chat';
}

function load() {
  if (cache) return cache;
  schema();
  const rows = db.all(`SELECT c.uuid, c.name, c.summary, c.created_at, c.updated_at, c.messages, c.first_prompt, c.preview, c.project_uuid, c.project_via,
      COALESCE(p.name, NULLIF(c.project_name, '')) AS project, a.email
    FROM claudeai_chats c LEFT JOIN claudeai_projects p ON p.uuid = c.project_uuid LEFT JOIN claudeai_accounts a ON a.uuid = c.account_uuid
    ORDER BY c.updated_at DESC`);
  const list = rows.map((r) => ({
    id: `ca:${r.uuid}`, kind: 'session', source: 'claude-ai', title: titleOf(r),
    preview: r.preview || truncate(r.summary || '', 240), updatedAt: r.updated_at, status: 'idle',
    meta: {
      claudeAi: true, readOnly: true, category: 'chat', noise: false, uuid: r.uuid, url: `https://claude.ai/chat/${r.uuid}`,
      account: r.email ? `claude.ai · ${r.email}` : 'claude.ai', messages: r.messages || 0, firstPrompt: r.first_prompt || '', asked: r.first_prompt || '',
      summary: r.summary || '', createdAt: r.created_at,
      ...(r.project ? { project: r.project, projectUuid: r.project_uuid || null, projectVia: r.project_via || 'export' } : {}),
    },
  }));
  cache = { list, byId: new Map(list.map((e) => [e.id, e])) };
  return cache;
}
const copy = (e) => ({ ...e, meta: { ...e.meta } });

// The newest chats, plus any you put on the board however old.
function cards() {
  const { list, byId } = load();
  if (!list.length) return [];
  const out = list.slice(0, MAX_CARDS);
  if (list.length > MAX_CARDS) {
    const have = new Set(out.map((e) => e.id));
    for (const r of db.all("SELECT id FROM board_nodes WHERE id LIKE 'ca:%' AND hidden = 0")) if (!have.has(r.id) && byId.has(r.id)) out.push(byId.get(r.id));
  }
  return out.map(copy);
}
hub.addExtraEntities(cards);
hub.addFinder((id) => (id.startsWith('ca:') && load().byId.has(id) ? copy(load().byId.get(id)) : null));

function transcript(id) {
  if (!id.startsWith('ca:')) return undefined;
  schema();
  const uuid = id.slice(3);
  return db.all('SELECT idx, role, kind, text, ts FROM claudeai_messages WHERE chat_uuid = ? ORDER BY idx', uuid)
    .map((m) => ({ id: `${id}:${m.idx}`, role: m.role, text: m.text, ts: m.ts, ...(m.kind ? { kind: m.kind } : {}) }));
}
hub.use({
  transcript,
  dispatch: (id) => {
    if (!id.startsWith('ca:')) return undefined;
    throw new Error('This chat was imported from claude.ai and is read-only here. Open it on claude.ai to continue it.');
  },
});

// ---------- ⌘K ----------
// Chats are matched on their title, summary, Project and every message; those matching in the title
// or Project rank with the board's own results, the rest follow.
const PREFIX = /^(claude|chat|chats|history|project|projects)(?::|\s)\s*/i;
const like = (t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
function searchChats(terms, limit) {
  schema();
  const where = terms.map(() => "(s.body LIKE ? ESCAPE '\\' OR COALESCE(p.name, c.project_name, '') LIKE ? ESCAPE '\\')").join(' AND ');
  const rows = db.all(`SELECT c.uuid, c.name, c.summary, c.first_prompt, c.updated_at, COALESCE(p.name, c.project_name, '') AS project, substr(s.body, 1, 60000) AS body
    FROM claudeai_chats c JOIN claudeai_search s ON s.chat_uuid = c.uuid LEFT JOIN claudeai_projects p ON p.uuid = c.project_uuid
    WHERE ${where} ORDER BY c.updated_at DESC LIMIT 150`, ...terms.flatMap((t) => [like(t), like(t)]));
  const now = Date.now();
  return rows.map((r) => {
    const title = titleOf(r);
    const low = { title: title.toLowerCase(), project: r.project.toLowerCase(), summary: (r.summary || '').toLowerCase() };
    let score = 3 * Math.exp(-(now - (r.updated_at || 0)) / (7 * 86400000));
    let at = -1;
    const body = r.body.toLowerCase();
    for (const t of terms) {
      if (low.title.includes(t)) score += 9;
      else if (low.project.includes(t)) score += 6;
      else if (low.summary.includes(t)) score += 4;
      else score += 2;
      const i = body.indexOf(t);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    const flat = (s) => s.replace(/\s+/g, ' ');
    const snippet = at < 0 ? (r.project ? `${r.project} · ` : '') + flat(r.summary || r.first_prompt || '').slice(0, 140)
      : (at > 50 ? '…' : '') + flat(r.body.slice(Math.max(0, at - 50), at + 110)) + (at + 110 < r.body.length ? '…' : '');
    return { id: `ca:${r.uuid}`, title, source: 'claude-ai', kind: 'session', snippet, updatedAt: r.updated_at, score };
  }).sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt).slice(0, limit);
}
const baseQuery = search.handlers['search:query'];
search.handlers['search:query'] = async (q, opts = {}) => {
  const hits = await baseQuery(q, opts);
  const raw = String(q || '').trim();
  if (/^[a-z]+:/i.test(raw) && !PREFIX.test(raw)) return hits;
  const terms = raw.replace(PREFIX, '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return hits;
  let extra = [];
  try { extra = searchChats(terms, opts.limit || 40); } catch (e) { console.error('claude.ai search:', e.message); }
  if (!extra.length) return hits;
  const seen = new Map(hits.map((h) => [h.id, h]));
  for (const x of extra) { const h = seen.get(x.id); if (h) { h.score = Math.max(h.score || 0, x.score); if (!h.snippet) h.snippet = x.snippet; } }
  return [...hits, ...extra.filter((x) => !seen.has(x.id))]
    .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, opts.limit || 40);
};

// ---------- Projects ----------
const pinned = () => { const v = db.getSetting(PINNED, []); return Array.isArray(v) ? v : []; };

// The topics tree keeps each Project with its threads: the Projects with work this week, and those
// you put on the board, bring their other threads along (newest first).
topics.addProjectThreads((names) => {
  const { list } = load();
  if (!list.length) return [];
  const want = new Set(names.map((n) => n.toLowerCase()));
  const pins = new Set(pinned());
  const shown = new Set(cards().map((e) => e.id));
  const by = new Map();
  for (const e of list) {
    const p = e.meta.project;
    if (!p || !shown.has(e.id) || !(want.has(p.toLowerCase()) || pins.has(e.meta.projectUuid))) continue;
    const l = by.get(p.toLowerCase()) || [];
    if (l.length < PROJECT_THREADS) l.push(e);
    by.set(p.toLowerCase(), l);
  }
  return [...by.values()].map((items) => ({ project: items[0].meta.project, items }));
});

function projects() {
  schema();
  const counts = new Map(db.all(`SELECT project_uuid AS uuid, COUNT(*) AS n, MAX(updated_at) AS latest,
      SUM(project_via = 'ai') AS ai, SUM(project_via = 'knowledge') AS knowledge, SUM(project_via = 'you') AS you
    FROM claudeai_chats WHERE project_uuid IS NOT NULL AND project_uuid != '' GROUP BY project_uuid`).map((r) => [r.uuid, r]));
  const pins = new Set(pinned());
  return db.all('SELECT uuid, name, description, docs, created_at, updated_at FROM claudeai_projects ORDER BY updated_at DESC').map((p) => {
    const c = counts.get(p.uuid) || {};
    return {
      uuid: p.uuid, name: p.name, description: p.description || '', files: db.J(p.docs, []).length, chats: c.n || 0,
      latest: Math.max(c.latest || 0, p.updated_at || 0), by: { ai: c.ai || 0, knowledge: c.knowledge || 0, you: c.you || 0 }, onBoard: pins.has(p.uuid),
    };
  });
}

// You put a chat in a Project (or in none): that wins over anything found or suggested.
function assign(id, projectUuid) {
  schema();
  const uuid = String(id || '').replace(/^ca:/, '');
  if (!db.get('SELECT 1 AS x FROM claudeai_chats WHERE uuid = ?', uuid)) throw new Error('Chat not found');
  if (projectUuid && !db.get('SELECT 1 AS x FROM claudeai_projects WHERE uuid = ?', projectUuid)) throw new Error('Project not found');
  db.exec("UPDATE claudeai_chats SET project_uuid = ?, project_via = 'you' WHERE uuid = ?", projectUuid || null, uuid);
  changed();
  return load().byId.get(`ca:${uuid}`) ? copy(load().byId.get(`ca:${uuid}`)) : null;
}

// Puts a Project's newest threads on the board (or takes them off). The window lays out the week
// afterwards, and the Project's threads sit together under it.
function showOnBoard(projectUuid, on = true) {
  schema();
  const p = db.get('SELECT uuid, name FROM claudeai_projects WHERE uuid = ?', projectUuid);
  if (!p) throw new Error('Project not found');
  const ids = db.all('SELECT uuid FROM claudeai_chats WHERE project_uuid = ? ORDER BY updated_at DESC LIMIT ?', p.uuid, on ? SHOW_ON_BOARD : 100000).map((r) => `ca:${r.uuid}`);
  const imported = new Set(db.getSetting('importedChats', []) || []);
  const pins = new Set(pinned());
  if (on) {
    pins.add(p.uuid);
    const rows = hub.board();
    const at = new Map(rows.map((r) => [r.id, r]));
    hub.saveBoard(ids.map((id, i) => ({ ...(at.get(id) || { x: (i % 4) * 280, y: 4000 + Math.floor(i / 4) * 130, parent_id: null, data: {} }), id, hidden: 0 })));
    for (const id of ids) imported.add(id);
  } else {
    pins.delete(p.uuid);
    hub.deleteBoardNodes(ids);
    for (const id of ids) imported.delete(id);
  }
  db.setSetting(PINNED, [...pins]);
  db.setSetting('importedChats', [...imported]);
  changed();
  emit({ type: 'board-changed' });
  return { ids, project: p.name, onBoard: on };
}

// ---------- matching chats to Projects with Claude ----------
let matching = null;
const oneLine = (s, n) => truncate(String(s || '').replace(/\s+/g, ' ').trim(), n);

function matchPrompt(list, chats) {
  const projectsText = list.map((p, i) => {
    const files = db.J(p.docs, []).map((d) => d.filename).filter(Boolean).slice(0, 12).join(', ');
    return `P${i + 1}. ${oneLine(p.name, 80)}${p.description ? ` | about: ${oneLine(p.description, 240)}` : ''}${p.instructions ? ` | instructions: ${oneLine(p.instructions, 300)}` : ''}${files ? ` | files: ${files}` : ''}`;
  }).join('\n');
  const chatsText = chats.map((c, i) => `${i + 1}. ${oneLine(titleOf(c), 90)}${c.summary ? ` | summary: ${oneLine(c.summary, 260)}` : ''}${c.first_prompt ? ` | asked: ${oneLine(c.first_prompt, 160)}` : ''}`).join('\n');
  return `Which of my Claude Projects does each chat belong to? These come from my claude.ai data export, which doesn't say.
Only match a chat that is plainly about that Project's subject. Most chats belong to no Project: use null for them. Never guess.
Reply with JSON only, no prose: {"chats":[{"chat":1,"project":"P2"},{"chat":2,"project":null}]}

Projects:
${projectsText}

Chats:
${chatsText}`;
}

function parseMatch(text, chats, list) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude did not answer with JSON');
  const out = new Map();
  for (const x of (JSON.parse(m[0]).chats || [])) {
    const i = Number(x && x.chat);
    const p = /^P(\d+)$/i.exec(String((x && x.project) || ''));
    if (!Number.isInteger(i) || i < 1 || i > chats.length) continue;
    out.set(chats[i - 1].uuid, p && list[Number(p[1]) - 1] ? list[Number(p[1]) - 1].uuid : null);
  }
  return out;
}

async function matchProjects() {
  if (matching) return matching;
  matching = (async () => {
    schema();
    const list = db.all("SELECT uuid, name, description, instructions, docs FROM claudeai_projects ORDER BY updated_at DESC LIMIT 60");
    const chats = list.length ? db.all(`SELECT uuid, name, summary, first_prompt FROM claudeai_chats
      WHERE project_via IS NULL AND ai_checked IS NULL ORDER BY updated_at DESC LIMIT ?`, MATCH_LIMIT) : [];
    const result = { at: Date.now(), asked: 0, matched: 0, error: null };
    if (!chats.length) return result;
    state.matching = true; publish();
    try {
      for (let i = 0; i < chats.length; i += MATCH_BATCH) {
        const batch = chats.slice(i, i + MATCH_BATCH);
        let found;
        try { found = parseMatch(await hub.quickAsk(matchPrompt(list, batch), { timeoutMs: 120000, model: 'sonnet' }), batch, list); } catch (e) { result.error = e.message; break; }
        const now = Date.now();
        tx(() => {
          for (const c of batch) {
            const p = found.get(c.uuid);
            if (p) { db.exec("UPDATE claudeai_chats SET project_uuid = ?, project_via = 'ai' WHERE uuid = ? AND project_via IS NULL", p, c.uuid); result.matched++; }
            if (found.has(c.uuid)) db.exec('UPDATE claudeai_chats SET ai_checked = ? WHERE uuid = ?', now, c.uuid);
          }
        });
        result.asked += batch.length;
        changed();
      }
    } finally {
      state.matching = false;
      db.setSetting('claudeAiLastMatch', result);
      publish();
    }
    return result;
  })().finally(() => { matching = null; });
  return matching;
}

// ---------- status ----------
function status() {
  schema();
  const n = (sql) => (db.get(sql) || {}).n || 0;
  return {
    chats: n('SELECT COUNT(*) AS n FROM claudeai_chats'),
    projects: n('SELECT COUNT(*) AS n FROM claudeai_projects'),
    inProjects: n("SELECT COUNT(*) AS n FROM claudeai_chats WHERE project_uuid IS NOT NULL AND project_uuid != ''"),
    unchecked: n('SELECT COUNT(*) AS n FROM claudeai_chats WHERE project_via IS NULL AND ai_checked IS NULL'),
    accounts: db.all('SELECT email, name FROM claudeai_accounts ORDER BY imported_at DESC').map((a) => a.email || a.name).filter(Boolean),
    lastImport: db.getSetting(LAST, null), lastMatch: db.getSetting('claudeAiLastMatch', null),
    importing: state.importing, progress: state.progress, matching: state.matching,
  };
}

function clear() {
  schema();
  tx(() => { for (const t of ['claudeai_messages', 'claudeai_search', 'claudeai_chats', 'claudeai_projects', 'claudeai_accounts']) db.exec(`DELETE FROM ${t}`); });
  db.exec("DELETE FROM board_nodes WHERE id LIKE 'ca:%'");
  db.setSetting('importedChats', (db.getSetting('importedChats', []) || []).filter((id) => !String(id).startsWith('ca:')));
  for (const k of [PINNED, LAST, 'claudeAiLastMatch']) db.setSetting(k, null);
  changed();
  emit({ type: 'board-changed' });
  publish();
  return status();
}

module.exports = {
  handlers: {
    'claudeai:status': () => status(),
    // paths: the zips, folders or JSON files to read; without them a file picker opens.
    'claudeai:import': async (paths) => {
      const list = Array.isArray(paths) && paths.length ? paths.map(String) : await pick();
      return list ? importFrom(list) : null;
    },
    'claudeai:projects': () => projects(),
    'claudeai:assign': (id, projectUuid) => assign(id, projectUuid),
    'claudeai:showOnBoard': (projectUuid, on) => showOnBoard(projectUuid, on !== false),
    'claudeai:match': () => matchProjects(),
    'claudeai:clear': () => clear(),
  },
  _test: { matchPrompt, parseMatch, titleOf },
};
