'use strict';
// Grok Bot connection: watches the app's local cache so bot cards update live, and exposes
// status, bots and transcripts. The 'grokEnabled' setting turns it all off (and stops the watcher).
const fs = require('fs');
const grok = require('../sources/grokbot.cjs');

let watcher = null;
let timer = null;
let ctx = null;

function stopWatch() { if (watcher) { try { watcher.close(); } catch {} watcher = null; } }
function startWatch() {
  stopWatch();
  if (!ctx || !grok.enabled() || !fs.existsSync(grok.PERSIST)) return;
  try {
    watcher = fs.watch(grok.PERSIST, () => {
      clearTimeout(timer);
      timer = setTimeout(() => { ctx.hub.invalidate(); ctx.send({ type: 'entities-changed' }); }, 800);
    });
    watcher.on('error', stopWatch);
  } catch { watcher = null; }
}

function setEnabled(on) {
  ctx.db.setSetting('grokEnabled', !!on);
  if (on) startWatch(); else stopWatch();
  ctx.hub.invalidate(); ctx.send({ type: 'entities-changed' });
  return grok.status();
}

module.exports = {
  handlers: {
    'grokbot:status': () => grok.status(),
    'grokbot:bots': () => (grok.enabled() ? { bots: grok.bots(), runs: grok.cloudRuns(), selected: grok.selectedAgent() } : { bots: [], runs: [], selected: null }),
    'grokbot:transcript': (agentId, limit) => (grok.enabled() ? grok.transcript(agentId, limit || 200) : []),
    'grokbot:setEnabled': (on) => setEnabled(on),
    'grokbot:open': (agentId) => grok.openBot(agentId),
    'grokbot:send': (agentId, text, opts) => grok.send(agentId, text, opts || {}),
  },
  start(c) { ctx = c; startWatch(); },
};
