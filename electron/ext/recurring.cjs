'use strict';
// Notes wired into agents. A note with a line into an agent card is a standing instruction,
// prepended to every prompt sent through 'prompt:withInstructions'. A note set to repeat is
// instead sent to the agents it points at on a schedule (every 15m, hourly, or daily at 9am).
const hub = require('../hub.cjs');
const db = require('../db.cjs');

const PROMPTABLE = /^(cc|cx|cu|lc|pj|ac|cl):/;
const EVERY = { '15m': 15 * 60000, '1h': 3600000 };
const KEY = 'recurringNotes';

const schedules = () => db.getSetting(KEY, {}) || {};
const noteText = (id) => db.get('SELECT text FROM notes WHERE id = ?', id.replace(/^nt:/, ''))?.text || '';
const allEdges = () => db.all('SELECT * FROM edges').map((e) => ({ ...e, data: db.J(e.data, {}) }));

function nextRun(s, now = Date.now()) {
  if (!s || !s.every || s.every === 'off') return null;
  if (EVERY[s.every]) return (s.last || s.since || now) + EVERY[s.every];
  const d = new Date(s.last || s.since || now);
  d.setHours(9, 0, 0, 0);
  if (d.getTime() <= (s.last || s.since || now)) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function instructionsFor(id) {
  const sched = schedules();
  const notes = allEdges()
    .filter((e) => e.target === id && e.source.startsWith('nt:') && e.data?.instruction !== false && !e.data?.example && !nextRun(sched[e.source]))
    .map((e) => noteText(e.source).trim()).filter(Boolean);
  return notes.join('\n\n');
}

function withInstructions(id, text, opts = {}) {
  const ins = instructionsFor(id);
  const full = ins ? `Standing instructions:\n${ins}\n\n---\n\n${text}` : text;
  return hub.prompt(id, full, opts);
}

function listSchedules() {
  const out = {};
  for (const [id, s] of Object.entries(schedules())) out[id] = { ...s, next: nextRun(s) };
  return out;
}

function setSchedule(id, every) {
  const all = schedules();
  if (!every || every === 'off') delete all[id];
  else all[id] = { every, since: Date.now(), last: null };
  db.setSetting(KEY, all);
  return listSchedules();
}

async function tick() {
  const all = schedules();
  const now = Date.now();
  const edges = allEdges();
  let changed = false;
  for (const [id, s] of Object.entries(all)) {
    const due = nextRun(s);
    if (!due || due > now) continue;
    const text = noteText(id).trim();
    // Only lines you drew: sample lines from the example board never reach a real agent.
    const targets = edges.filter((e) => e.source === id && PROMPTABLE.test(e.target) && !e.data?.example).map((e) => e.target);
    s.last = now; changed = true;
    if (!text) continue;
    for (const t of targets) {
      try { hub.prompt(t, text, { from: id, via: 'recurring' }); } catch (e) { console.error('recurring prompt:', e.message); }
    }
  }
  if (changed) db.setSetting(KEY, all);
}

module.exports = {
  handlers: {
    'notes:instructionsFor': (id) => instructionsFor(id),
    'prompt:withInstructions': (id, text, opts) => withInstructions(id, text, opts || {}),
    'recurring:list': () => listSchedules(),
    'recurring:set': (id, every) => setSchedule(id, every),
  },
  instructionsFor,
  withInstructions,
  start() {
    setInterval(() => tick().catch((e) => console.error('recurring:', e.message)), 60000);
  },
};
