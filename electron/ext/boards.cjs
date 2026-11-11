'use strict';
// Saved boards: named snapshots of the card layout and lines, so you can switch between setups.
const db = require('../db.cjs');
const hub = require('../hub.cjs');
const claudeCode = require('../sources/claudeCode.cjs');

const KEY = 'savedBoards';
let send = () => {};

const list = () => db.getSetting(KEY, []) || [];
const snapshot = () => ({
  nodes: db.all('SELECT * FROM board_nodes'),
  edges: db.all('SELECT * FROM edges'),
});

function restore({ nodes = [], edges = [] }) {
  db.exec('DELETE FROM board_nodes');
  db.exec('DELETE FROM edges');
  for (const n of nodes) {
    db.exec('INSERT INTO board_nodes(id, x, y, w, h, parent_id, data, hidden) VALUES(?,?,?,?,?,?,?,?)',
      n.id, n.x, n.y, n.w ?? null, n.h ?? null, n.parent_id ?? null, n.data || '{}', n.hidden ? 1 : 0);
  }
  for (const e of edges) {
    db.exec('INSERT INTO edges(id, source, target, kind, data, created_at) VALUES(?,?,?,?,?,?)',
      e.id, e.source, e.target, e.kind, e.data || '{}', e.created_at ?? Date.now());
  }
  send({ type: 'board-changed' });
  send({ type: 'entities-changed' });
}

function upsert(name, snap, auto = false) {
  const boards = list().filter((b) => (auto ? !b.auto && b.name !== 'Autosave' : b.name !== name));
  boards.unshift({ id: `b${Date.now().toString(36)}`, name, ts: Date.now(), ...(auto ? { auto: true } : {}), ...snap });
  db.setSetting(KEY, boards.slice(0, 30));
}

const parse = (d) => { try { return typeof d === 'string' ? JSON.parse(d) : d || {}; } catch { return {}; } };
const clean = (s) => String(s || '').replace(/^Example\s*·\s*/i, '').replace(/\s+/g, ' ').trim();
const short = (s, n = 22) => (s.length > n ? `${s.slice(0, n - 1).trim()}…` : s);

// A name from what the board holds: biggest frames first, then clients on it, then a card count.
function smartName({ nodes = [] } = snapshot()) {
  const shown = nodes.filter((n) => !n.hidden);
  const frames = shown.filter((n) => String(n.id).startsWith('grp:'))
    .sort((a, b) => (b.w || 0) * (b.h || 0) - (a.w || 0) * (a.h || 0))
    .map((n) => clean(parse(n.data).label)).filter(Boolean);
  const ids = new Set(shown.map((n) => String(n.id)));
  let clients = [];
  try { clients = db.all('SELECT id, name FROM clients').filter((c) => ids.has(c.id) || ids.has(`client:${c.id}`) || ids.has(`cl:${c.id}`)).map((c) => clean(c.name)); } catch {}
  const parts = [...new Set([...frames, ...clients])].slice(0, 2).map((s) => short(s));
  const cards = shown.filter((n) => !String(n.id).startsWith('grp:')).length;
  const head = parts.length ? parts.join(' + ') : cards ? `${cards} cards` : 'Blank board';
  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${head} · ${date}`;
}

function viewHide(rows, at) {
  for (const r of rows) {
    const d = parse(r.data);
    d.viewHidden = at;
    db.exec('UPDATE board_nodes SET hidden = 1, parent_id = NULL, data = ? WHERE id = ?', JSON.stringify(d), r.id);
  }
}

// Older blank boards hid everything with no mark, so new work never came back. Rows a blank board
// hid sit outside any frame (a card you delete keeps its frame), so mark those once.
function migrateHidden() {
  if (db.getSetting('boardViewHiddenMarked', false)) return;
  const rows = db.all("SELECT * FROM board_nodes WHERE hidden = 1 AND parent_id IS NULL AND id NOT LIKE 'grp:%' AND id NOT LIKE 'nt:%' AND id NOT LIKE 'out:%'")
    .filter((r) => parse(r.data).viewHidden == null);
  viewHide(rows, 0); // as if hidden long ago, so work active right now comes back on the first revive
  db.setSetting('boardViewHiddenMarked', true);
}

const needsLook = (e) => e.status === 'running' || e.status === 'waiting' || (e.meta && (e.meta.unread > 0 || e.meta.awaiting));

// A card a blank board hid comes back when it changes after it was hidden and is running, waiting
// on you or has unread replies. Its row is dropped, so the board places it again in its project's
// frame. Rows for Switchboard's own runs are removed outright.
const RECENT = 3 * 86400000;
// One-time: earlier blank boards hid chats you were still using. Bring back the last 3 days.
async function restoreRecent() {
  if (db.getSetting('recentChatsRestored', false)) return 0;
  const list = await hub.entities();
  const byId = new Map(list.map((e) => [e.id, e]));
  let n = 0;
  for (const r of db.all('SELECT id, hidden, data FROM board_nodes WHERE hidden = 1')) {
    const e = byId.get(r.id);
    if (!e || e.kind !== 'session' || parse(r.data).viewHidden == null || Date.now() - (e.updatedAt || 0) > RECENT) continue;
    db.exec('DELETE FROM board_nodes WHERE id = ?', r.id); n++;
  }
  db.setSetting('recentChatsRestored', true);
  if (n) { send({ type: 'board-changed' }); send({ type: 'entities-changed' }); }
  return n;
}

async function revive() {
  const list = await hub.entities();
  const byId = new Map(list.map((e) => [e.id, e]));
  const internal = claudeCode.internalSessions();
  let changed = 0;
  for (const r of db.all('SELECT id, hidden, data FROM board_nodes')) {
    const sid = String(r.id).startsWith('cc:') ? String(r.id).split(':').pop() : null;
    if (sid && internal.has(sid)) { db.exec('DELETE FROM board_nodes WHERE id = ?', r.id); changed++; continue; }
    if (!r.hidden) continue;
    const at = parse(r.data).viewHidden;
    const e = at != null && byId.get(r.id);
    if (!e || (e.updatedAt || 0) <= at || !(needsLook(e) || e.kind === 'session')) continue;
    db.exec('DELETE FROM board_nodes WHERE id = ?', r.id); changed++;
  }
  if (changed) { send({ type: 'board-changed' }); send({ type: 'entities-changed' }); }
  return changed;
}

function autosave() { const snap = snapshot(); upsert(`Autosave · ${smartName(snap)}`, snap, true); }

const summary = () => list().map(({ id, name, ts, auto, nodes }) => ({ id, name, ts, auto: !!auto, cards: (nodes || []).filter((n) => !String(n.id).startsWith('grp:') && !n.hidden).length }));

module.exports = {
  handlers: {
    'boards:list': () => ({ boards: summary(), current: db.getSetting('currentBoard', null) }),
    'boards:smartName': () => smartName(),
    'boards:save': (name) => {
      const n = String(name || '').trim() || smartName();
      upsert(n, snapshot());
      db.setSetting('currentBoard', n);
      return summary();
    },
    'boards:load': (id) => {
      const b = list().find((x) => x.id === id);
      if (!b) throw new Error('Board not found');
      autosave();
      restore(b);
      db.setSetting('currentBoard', b.name);
      return summary();
    },
    // A blank board keeps every card you already have, just hidden, so nothing respawns. Unlike a
    // card you delete, a card hidden this way (data.viewHidden = when) comes back once it is
    // active again; see revive().
    'boards:blank': () => {
      autosave();
      db.exec("DELETE FROM board_nodes WHERE id LIKE 'grp:%'");
      viewHide(db.all('SELECT * FROM board_nodes WHERE hidden = 0'), Date.now());
      db.exec('DELETE FROM edges');
      db.setSetting('currentBoard', null);
      send({ type: 'board-changed' });
      return summary();
    },
    'boards:delete': (id) => {
      db.setSetting(KEY, list().filter((b) => b.id !== id));
      return summary();
    },
  },
  start(ctx) {
    send = ctx.send;
    try { migrateHidden(); } catch (e) { console.error('board migrate:', e.message); }
    let t = null;
    hub.events.on('event', (e) => {
      if (e.type !== 'entities-changed') return;
      if (t) return; // throttle, not debounce: a session that writes every second must not starve it
      t = setTimeout(() => { t = null; revive().catch((err) => console.error('board revive:', err.message)); }, 1500);
    });
    setTimeout(() => restoreRecent().then(revive).catch(() => {}), 5000);
  },
  revive,
};
