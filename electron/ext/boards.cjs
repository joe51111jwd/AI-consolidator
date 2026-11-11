'use strict';
// Saved boards: named snapshots of the card layout and lines, so you can switch between setups.
const db = require('../db.cjs');

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
    // A blank board keeps every card you already have, just hidden, so nothing respawns.
    'boards:blank': () => {
      autosave();
      db.exec("DELETE FROM board_nodes WHERE id LIKE 'grp:%'");
      db.exec('UPDATE board_nodes SET hidden = 1, parent_id = NULL');
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
  start(ctx) { send = ctx.send; },
};
