'use strict';
// When the user last opened each card, so the board can mark what changed since (the blue dot).
const db = require('../db.cjs');

const KEY = 'attentionSeen';
const load = () => db.getSetting(KEY, {}) || {};

module.exports = {
  handlers: {
    'attention:seen': () => load(),
    'attention:mark': (id, ts) => {
      if (!id) return load();
      const m = load(); m[id] = Number(ts) || Date.now();
      db.setSetting(KEY, m);
      return m;
    },
  },
};
