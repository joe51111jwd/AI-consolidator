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

function upsert(name, snap) {
  const boards = list().filter((b) => b.name !== name);
  boards.unshift({ id: `b${Date.now().toString(36)}`, name, ts: Date.now(), ...snap });
  db.setSetting(KEY, boards.slice(0, 30));
}

const summary = () => list().map(({ id, name, ts, nodes }) => ({ id, name, ts, cards: (nodes || []).filter((n) => !String(n.id).startsWith('grp:') && !n.hidden).length }));

module.exports = {
  handlers: {
    'boards:list': () => ({ boards: summary(), current: db.getSetting('currentBoard', null) }),
    'boards:save': (name) => {
      const n = String(name || '').trim() || 'Untitled board';
      upsert(n, snapshot());
      db.setSetting('currentBoard', n);
      return summary();
    },
    'boards:load': (id) => {
      const b = list().find((x) => x.id === id);
      if (!b) throw new Error('Board not found');
      upsert('Autosave', snapshot());
      restore(b);
      db.setSetting('currentBoard', b.name);
      return summary();
    },
    // A blank board keeps every card you already have, just hidden, so nothing respawns.
    'boards:blank': () => {
      upsert('Autosave', snapshot());
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
