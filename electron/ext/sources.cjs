'use strict';
// Which kinds of account are set up, so the UI only offers what you actually use
// (no Codex buttons or filters without a Codex account, for example).
const hub = require('../hub.cjs');

module.exports = {
  handlers: {
    'sources:active': () => ({ kinds: [...new Set(hub.accounts().map((a) => a.kind))] }),
  },
};
