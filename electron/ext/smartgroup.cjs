'use strict';
// "Smart group": sorts the cards you pick into a few named groups by client, project or purpose.
// Asks Claude (no tools, short timeout) and falls back to a rule of thumb, so it always answers.
const path = require('path');
const hub = require('../hub.cjs');
const { HOME, truncate } = require('../util.cjs');
const P = require('./topics.cjs').prompt;

const COLORS = ['#3F7A5E', '#7A5A8C', '#C0603E', '#4E6E7E', '#B08A2E', '#9A4B5B', '#5E7F3A', '#8A6B52'];
const colorFor = (label) => COLORS[[...label.toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
const RULE_MAX_GROUPS = 8;

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

// Each card as one line, in the same shape as the home's topics prompt.
function describe(e, i, clients, links) {
  const m = e.meta || {};
  const c = clientOf(e, clients);
  const content = e.kind === 'session' ? P.contentOf(e) : { first: '', last: e.preview };
  return P.itemLine(i + 1, {
    kind: P.kindLabel(e), title: e.title, folder: m.cwd && m.cwd !== HOME && !m.noise ? path.basename(m.cwd) : '',
    client: c ? c.name : '', linked: (links.get(e.id) || []).slice(0, 3).join(', '),
    asked: content.first !== e.title ? content.first : '', latest: content.last,
  });
}

function linksFor(list) {
  const title = new Map(list.map((e) => [e.id, truncate(e.title, 40)]));
  const links = new Map();
  for (const ed of hub.edges()) {
    for (const [a, b] of [[ed.source, ed.target], [ed.target, ed.source]]) {
      if (!title.has(a) || !title.has(b)) continue;
      links.set(a, [...(links.get(a) || []), title.get(b)]);
    }
  }
  return links;
}

const SMART_ANSWERS = [
  JSON.stringify({ groups: [{ label: 'Michael', items: [1, 2] }] }),
  JSON.stringify({ groups: [{ label: P.MARKETING, items: [1] }, { label: P.MAIN_BOT, items: [2] }, { label: P.MINE, items: [3] }] }),
];

function smartPrompt(items, clients, rule) {
  const links = linksFor(items);
  const max = rule ? RULE_MAX_GROUPS : P.MAX_GROUPS;
  return `You sort the cards on my work whiteboard into a few named groups so I can see what I'm working on and for whom.
Group these cards from my work whiteboard into 2 to ${max} groups${rule ? ', following my rule below exactly' : ''}.
${rule ? `My rule: "${truncate(rule, 400)}"\nMy rule wins. Where it says nothing, group by what the work is about.` : P.CRITERIA}
Each card: number, [kind], title, then folder / client / with / linked to / asked (first request) / latest (latest reply), when known.
${rule ? '' : `${P.examples(SMART_ANSWERS)}\n`}Reply with JSON only, no prose, no code fence: {"groups":[{"label":"Short name","items":[1,2]}]}
Use every item number exactly once. Labels are 1 to 3 plain words, no numbers or emoji.

Items:
${items.map((e, i) => describe(e, i, clients, links)).join('\n')}`;
}

async function askClaude(list, clients, instruction) {
  const rule = String(instruction || '').trim();
  const items = P.forPrompt(list);
  const parsed = P.readJson(await hub.quickAsk(smartPrompt(items, clients, rule)));
  const raw = Array.isArray(parsed.groups) ? parsed.groups : Array.isArray(parsed.clients) ? parsed.clients : [];
  const groups = P.repair(raw, items.length, rule ? RULE_MAX_GROUPS : P.MAX_GROUPS).map((g) => ({
    label: g.label, color: colorFor(g.label), ids: g.projects.flatMap((p) => p.items.map((n) => items[n - 1].id)),
  }));
  if (!groups.length) throw new Error('Claude returned no groups');
  const asked = new Set(items.map((e) => e.id));
  return { groups, rest: list.filter((e) => !asked.has(e.id)) };
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

async function group(ids, { ai = true, instruction = '' } = {}) {
  const all = await hub.entities();
  const byId = new Map(all.map((e) => [e.id, e]));
  const list = [...new Set(Array.isArray(ids) ? ids : [])].map((id) => byId.get(id)).filter(Boolean);
  if (!list.length) return { groups: [], via: 'none' };
  const clients = hub.clients();
  if (ai && list.length > 2) {
    try {
      const { groups, rest } = await askClaude(list, clients, instruction);
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
  prompt: { smartPrompt },
};
