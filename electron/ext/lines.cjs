'use strict';
// Lines between cards: sessions driven outside Switchboard still send their output down
// auto-send lines once they finish, and agents (or the app) can draw diagrams on the board.
const hub = require('../hub.cjs');

let timer = null;
const check = () => hub.forwardFinished().catch((e) => console.error('auto-send:', e.message));

module.exports = {
  handlers: {
    'autoforward:check': () => hub.forwardFinished(),
    'board:make': (spec) => hub.makeBoard(spec || {}),
  },
  start() {
    setInterval(check, 20000);
    hub.events.on('event', (e) => {
      if (e.type !== 'entities-changed') return;
      clearTimeout(timer); timer = setTimeout(check, 3000);
    });
  },
};
