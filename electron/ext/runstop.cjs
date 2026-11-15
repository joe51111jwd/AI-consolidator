'use strict';
// Stop for the chat panel: 'run:stop' aborts what is running on a card (or one run, by its run id).
// The hub keeps an AbortController per run; stopping kills the agent's process and marks the run
// 'stopped', keeping what it had said so far.
const hub = require('../hub.cjs');

module.exports = {
  handlers: {
    'run:stop': (key) => {
      if (typeof key !== 'string' || !key) throw new Error('Nothing to stop');
      // A cloud session runs on claude.ai, not here: the stop goes to it through the relay.
      if (key.startsWith('cs:')) { hub.stopRun(key); return require('./cloud.cjs').stop(key); }
      return hub.stopRun(key);
    },
  },
};
