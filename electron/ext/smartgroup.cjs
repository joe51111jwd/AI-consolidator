'use strict';
// "Smart group": sorts the cards you pick into a few named groups by client, project or purpose.
// Asks Claude (no tools, short timeout) and falls back to a rule of thumb, so it always answers.
const path = require('path');
const hub = require('../hub.cjs');
const { HOME, truncate } = require('../util.cjs');

const COLORS = ['#3F7A5E', '#7A5A8C', '#C0603E', '#4E6E7E', '#B08A2E', '#9A4B5B', '#5E7F3A', '#8A6B52'];
const colorFor = (label) => COLORS[[...label.toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
const AI_LIMIT = 150;

function matches(c, email) {
  if (!email) return false;
  email = String(email).toLowerCase();
  return c.emails.includes(email) || c.domains.includes(email.split('@')[1]);
}

function clientOf(e, clients) {
  if (!e) return null;
  if (e.kind === 'client') return clients.find((c) => `cl:${c.id}` === e.id) || null;
  const m = e.meta || {};
  return clients.find((c) =>
    (m.cwd && c.project_paths.some((p) => m.cwd === p || m.cwd.startsWith(p + path.sep))) ||
    (m.participants || []).some((p) => matches(c, p)) ||
    (m.attendees || []).some((a) => matches(c, a && a.email))) || null;
}

function sourceGroup(e) {
  if (e.kind === 'account') return 'Agents';
  if (e.kind === 'output' || e.kind === 'note') return 'Notes & outputs';
  if (e.kind === 'thread') return 'Email';
  if (e.kind === 'meeting') return 'Meetings';
  if (e.kind === 'client') return 'Clients';
  if (e.kind === 'project') return 'Projects';
  if (e.kind === 'session') return e.meta && e.meta.category === 'coding' ? 'Coding' : 'Chats';
  return 'Other';
}

// Client match first, then the project folder, then the kind of card.
function heuristic(list, all, clients) {
  const byId = new Map(all.map((e) => [e.id, e]));
  const placeOf = (e) => {
    const c = clientOf(e, clients);
    if (c) return { key: `cl:${c.id}`, label: c.company || c.name };
    const cwd = e && e.meta && e.meta.cwd;
    if (cwd && cwd !== HOME && !e.meta.noise) return { key: `pj:${cwd}`, label: path.basename(cwd), project: true };
    return null;
  };
  const picks = list.map((e) => placeOf(e) || (e.kind === 'output' && e.meta.from ? placeOf(byId.get(e.meta.from)) : null));
  const size = new Map();
  for (const p of picks) if (p) size.set(p.key, (size.get(p.key) || 0) + 1);
  const groups = new Map();
  list.forEach((e, i) => {
    let p = picks[i];
    if (!p || (p.project && size.get(p.key) < 2)) { const label = sourceGroup(e); p = { key: `src:${label}`, label }; }
    const g = groups.get(p.key) || { label: p.label, color: colorFor(p.label), ids: [] };
    g.ids.push(e.id); groups.set(p.key, g);
  });
  return [...groups.values()].sort((a, b) => b.ids.length - a.ids.length);
}

function describe(e, i, clients) {
  const m = e.meta || {};
  const c = clientOf(e, clients);
  const bits = [e.kind === 'session' ? `${m.category || ''} session` : e.kind, m.cwd && m.cwd !== HOME ? `folder ${path.basename(m.cwd)}` : '', c ? `client ${c.name}` : ''].filter(Boolean).join(', ');
  return `${i + 1}. ${truncate(e.title, 80)} (${bits})${e.preview ? ` - ${truncate(e.preview, 100)}` : ''}`;
}

async function askClaude(list, clients) {
  const text = `Group these cards from my work whiteboard into 2 to 6 groups by client, project or purpose.
Reply with JSON only, no prose: {"groups":[{"label":"Short name","items":[1,2]}]}
Use every item number exactly once. Labels are 1 to 3 plain words, no numbers or emoji.

${list.map((e, i) => describe(e, i, clients)).join('\n')}`;
  const out = await hub.quickAsk(text);
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude did not answer with JSON');
  const used = new Set();
  const groups = [];
  for (const g of JSON.parse(m[0]).groups || []) {
    const label = truncate(String((g && g.label) || ''), 40);
    const ids = ((g && (g.items || g.ids)) || []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= list.length && !used.has(n))
      .map((n) => { used.add(n); return list[n - 1].id; });
    if (label && ids.length) groups.push({ label, color: colorFor(label), ids });
  }
  if (!groups.length) throw new Error('Claude returned no groups');
  return { groups, rest: list.filter((_, i) => !used.has(i + 1)) };
}

// Notes and outputs follow the card they have a line to, so a line never crosses the board
// between groups. Groups left empty are dropped.
const FOLLOWS = /^(nt|out):/;
function keepLinked(groups) {
  const where = new Map();
  groups.forEach((g, i) => g.ids.forEach((id) => where.set(id, i)));
  for (const e of hub.edges()) {
    const [mover, anchor] = FOLLOWS.test(e.source) && !FOLLOWS.test(e.target) ? [e.source, e.target]
      : FOLLOWS.test(e.target) && !FOLLOWS.test(e.source) ? [e.target, e.source] : [null, null];
    if (!mover || !where.has(mover) || !where.has(anchor) || where.get(mover) === where.get(anchor)) continue;
    const from = groups[where.get(mover)], to = groups[where.get(anchor)];
    from.ids = from.ids.filter((id) => id !== mover);
    to.ids.push(mover);
    where.set(mover, where.get(anchor));
  }
  return groups.filter((g) => g.ids.length);
}

async function run(ids, opts = {}) {
  const r = await group(ids, opts);
  return { ...r, groups: keepLinked(r.groups) };
}

async function group(ids, { ai = true } = {}) {
  const all = await hub.entities();
  const byId = new Map(all.map((e) => [e.id, e]));
  const list = [...new Set(Array.isArray(ids) ? ids : [])].map((id) => byId.get(id)).filter(Boolean);
  if (!list.length) return { groups: [], via: 'none' };
  const clients = hub.clients();
  if (ai && list.length > 2 && list.length <= AI_LIMIT) {
    try {
      const { groups, rest } = await askClaude(list, clients);
      for (const g of heuristic(rest, all, clients)) {
        const same = groups.find((x) => x.label.toLowerCase() === g.label.toLowerCase());
        if (same) same.ids.push(...g.ids); else groups.push(g);
      }
      return { groups, via: 'ai' };
    } catch (e) { console.error('smart group: falling back to rules:', e.message); }
  }
  return { groups: heuristic(list, all, clients), via: 'rules' };
}

module.exports = {
  handlers: {
    'smartgroup:run': (ids, opts) => run(ids, opts || {}),
  },
};
