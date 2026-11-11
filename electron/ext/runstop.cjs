'use strict';
// Stop for the chat panel: 'run:stop' aborts what is running on a card (or one run, by its run id).
// The hub keeps an AbortController per run; stopping kills the agent's process and marks the run
// 'stopped', keeping what it had said so far.
const hub = require('../hub.cjs');

module.exports = {
  handlers: {
    'run:stop': (key) => {
      if (typeof key !== 'string' || !key) throw new Error('Nothing to stop');
      return hub.stopRun(key);
    },
  },
};
