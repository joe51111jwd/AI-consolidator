'use strict';
// Clients find themselves: people you email back and forth with are added as leads on their own,
// and the list is rescanned whenever the board changes (and every two minutes). A client you
// delete is remembered and never added again. Everything stays editable in Settings.
const hub = require('../hub.cjs');
const db = require('../db.cjs');

const EVERY = 120000, MIN_GAP = 30000, SETTLE = 5000;
let timer = null, running = null, lastRun = 0;

const keysOf = (c) => [...c.domains, ...c.emails].map((k) => k.toLowerCase());
const titleCase = (s) => s.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()).trim();
function companyOf(domain) {
  const parts = domain.split('.');
  let i = Math.max(0, parts.length - 2);
  if (i > 0 && parts[i].length <= 3 && parts[parts.length - 1].length === 2) i--;
  return titleCase(parts[i]);
}

function nameOf(s) {
  if (s.name && !s.name.includes('@')) return s.name;
  return s.domain ? companyOf(s.domain) : titleCase(s.email.split('@')[0]);
}

async function scan() {
  lastRun = Date.now();
  // Addresses that belonged to a client last time but no longer do were deleted by you: never re-add.
  const current = new Set(hub.clients().flatMap(keysOf));
  const dismissed = new Set(db.getSetting('clientsDismissed', []));
  for (const k of db.getSetting('clientsKnown', [])) if (!current.has(k)) dismissed.add(k);
  const added = [];
  for (const s of await hub.suggestions()) {
    const keys = [s.domain, s.email].filter(Boolean).map((k) => k.toLowerCase());
    if (!keys.length || keys.some((k) => dismissed.has(k) || current.has(k))) continue;
    const id = hub.saveClient({
      name: nameOf(s), company: s.domain ? companyOf(s.domain) : null,
      emails: [s.email], domains: s.domain ? [s.domain] : [], status: 'lead',
      notes: s.subject ? `Found in your email: "${s.subject}"` : null,
    });
    keys.forEach((k) => current.add(k));
    added.push({ id: `cl:${id}`, name: nameOf(s) });
  }
  db.setSetting('clientsDismissed', [...dismissed]);
  db.setSetting('clientsKnown', [...new Set(hub.clients().flatMap(keysOf))]);
  if (added.length) hub.events.emit('event', { type: 'entities-changed' });
  return { added, count: hub.clients().length };
}

function rescan() {
  if (!running) running = scan().finally(() => { running = null; });
  return running;
}

function schedule(delay = SETTLE) {
  clearTimeout(timer);
  timer = setTimeout(() => rescan().catch((e) => console.error('clients rescan:', e.message)), Math.max(delay, lastRun + MIN_GAP - Date.now()));
}

module.exports = {
  handlers: {
    'clients:rescan': () => rescan(),
  },
  start() {
    schedule(8000);
    setInterval(() => schedule(0), EVERY);
    hub.events.on('event', (e) => { if (e.type === 'entities-changed') schedule(); });
  },
};
