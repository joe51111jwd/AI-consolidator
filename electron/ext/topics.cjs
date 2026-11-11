'use strict';
// Topics: the home sorts what you have going on this week by what the work is about, as a tree:
// clients (or, for work with no client, an area such as "Switchboard app") holding projects, each
// project holding the chats, meetings and emails working on the same thing. `topics` stays the flat
// list of projects; `clients` is the tree. A rule of thumb answers at once; Claude (no tools, no
// user hooks, least-used account, run inside ~/.switchboard so it never shows up as a chat)
// refines it in the background, when the set changes, from each chat's AI summary (who it is for,
// what the work is: ext/context.cjs) or, for chats not summarized yet, what it asked and answered.
const path = require('path');
const hub = require('../hub.cjs');
const db = require('../db.cjs');
const claudeCode = require('../sources/claudeCode.cjs');
const { APP_DIR, HOME, truncate } = require('../util.cjs');

const DAY = 86400000;
const WINDOW = 7 * DAY;
const SETTLE = 30000;
const NOISE = /\/scratch-workspaces\/|^(\/private)?\/tmp(\/|$)|^(\/private)?\/var\/folders\//;
const NO_REPLY = /no-?reply|notifications?@|mailer|daemon|calendar-notification|updates?@|news(letter)?@/i;

const KEYWORDS = [
  [/\bseo\b|keyword|backlink|serp|rank(ing)?s?\b|search console/i, 'SEO tools'],
  [/outreach|cold (email|dm)|linkedin|prospect|lead(s|gen)?\b|follow[- ]?up|newsletter/i, 'Outreach'],
  [/calendar|meeting|schedul|invoice|expense|admin|inbox|email|taxes?\b|booking/i, 'Calendar & admin'],
  [/website|landing|site\b|homepage|webflow|wordpress|shopify/i, 'Websites'],
  [/\b(ad|ads|tiktok|instagram|video|reel|social|content|post(s)?)\b/i, 'Content & social'],
  [/research|paper|study|analy[sz]/i, 'Research'],
  [/trad(e|ing)|market|polymarket|stock|crypto/i, 'Markets'],
];
// Where an item that matches nothing else goes, by kind.
const FALLBACK = { meeting: 'Meetings', thread: 'Inbox' };
const NO_AREA = 'Other';
// The top level stays small: people (clients) first, then a few broad areas, then Other.
const MAX_GROUPS = 6;
const MARKETING = 'Marketing';
const MAIN_BOT = 'Grok Bot · calendar';
const MINE = 'My projects';
const MARKETING_RE = /\bseo\b|keyword|backlink|serp|search console|outreach|cold (email|dm)|linkedin|prospect|lead(s|gen)?\b|newsletter|marketing|\b(ads?|tiktok|instagram|twitter|tweets?|reels?|social|posts?|posting|repl(y|ies|ying))\b/i;
// Capitalised words that follow "for", "with" etc. but are not people.
const NOT_PEOPLE = new Set(('the this that these my our your his her their a an all any each every some new next last today tomorrow monday tuesday wednesday thursday friday saturday sunday '
  + 'january february march april may june july august september october november december claude grok codex cursor chatgpt openai anthropic switchboard google gmail granola slack notion '
  + 'github vercel react electron next node python figma shopify webflow wordpress tiktok instagram linkedin twitter youtube seo api ui ux mcp ai me us it').split(' '));
const PERSON_RE = /\b(?:for|with|from|to|client|call|meeting|email|tell|ask)\s+([A-Z][a-z]{2,15})\b|\b([A-Z][a-z]{2,15})['’]s\b/g;

let sendFn = null;
let inflight = null;
let pending = null; // { key, at }: a changed set of items waiting to settle

const emitChanged = () => {
  const e = { type: 'topics-changed' };
  if (sendFn) sendFn(e); else hub.events.emit('event', e);
};

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';
// The AI summary of a chat (ext/context.cjs): { about, client, project, status, nextStep, people }.
// When a chat has one, it is what the grouping reads instead of the first ask and latest reply.
const ctxOf = (e) => { const c = e && e.meta && e.meta.context; return c && typeof c === 'object' && c.about ? c : null; };
const isRunning = (e) => e.status === 'running' || !!(e.meta && e.meta.activity && e.meta.activity.running);
const isLive = (e) => e.status === 'waiting' || isRunning(e);
const clientLabel = (c) => c.company || c.name;
const words = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

function isNoise(e) {
  const m = e.meta || {};
  return typeof m.noise === 'boolean' ? m.noise : NOISE.test(m.cwd || '');
}

const meetingAt = (e) => (e.meta && e.meta.at) || e.updatedAt || 0;
function needsReply(e) {
  if (e.kind !== 'thread') return false;
  const m = e.meta || {};
  if (typeof m.needsReply === 'boolean') return m.needsReply;
  return !m.lastFromMe && (!m.participants || m.participants.some((p) => !NO_REPLY.test(p)));
}

// The work on the home this week: chats touched in the last 7 days (or running / waiting), meetings
// from the last 7 days (and the coming week) and threads waiting on a reply. Notes, outputs, client
// and account cards are not work in progress and stay out.
// Switchboard's own background runs (grouping, the main agent) and chats that only hold an error
// say nothing about the owner's work, so they never shape the groups.
function isJunk(e) {
  const m = e.meta || {};
  const cwd = String(m.cwd || '');
  if (cwd && path.resolve(cwd) === path.resolve(APP_DIR)) return true;
  const text = `${e.title || ''} ${e.preview || ''}`.trim();
  return /^(API Error|Error:|Connection error|Request failed)/i.test(e.title || '') || (!!text && /^API Error\b/i.test(e.preview || '') && (m.messages || 0) <= 2);
}

function gather(all, now = Date.now()) {
  const since = now - WINDOW;
  const chats = all.filter((e) => e.kind === 'session' && !(e.meta && e.meta.archived) && !isNoise(e) && !isJunk(e)
    && ((e.updatedAt || 0) >= since || isLive(e)));
  const meetings = all.filter((e) => e.kind === 'meeting' && meetingAt(e) >= since && meetingAt(e) <= now + WINDOW);
  const threads = all.filter((e) => needsReply(e) && (e.updatedAt || 0) >= since);
  return [...chats, ...meetings, ...threads];
}

async function current() {
  return { list: gather(await hub.entities()), clients: hub.clients() };
}

// The set of items, and who / what each summarized chat is for, so topics are redone once when
// summaries land or a chat turns out to be for someone else (not on every new summary line).
const keyOf = (list) => list.map((e) => { const c = ctxOf(e); return c ? `${e.id}#${slug(c.client || '')}/${slug(c.project || '')}` : e.id; }).sort().join('|');

// The owner's own top-level groups ({ groups: [{ label, hint }] }), or null when none are set.
function rulesOf() {
  const r = db.getSetting('groupRules', null);
  const groups = r && Array.isArray(r.groups) ? r.groups.filter((g) => g && String(g.label || '').trim()) : [];
  return groups.length ? groups.map((g) => ({ label: String(g.label).trim(), hint: String(g.hint || '').trim() })) : null;
}
const rulesKey = (rules) => (rules ? JSON.stringify(rules) : '');

function cleanRules(input) {
  const seen = new Set();
  const groups = [];
  for (const g of (input && Array.isArray(input.groups) ? input.groups : [])) {
    const label = truncate(String((g && g.label) || '').replace(/\s+/g, ' ').trim(), 40);
    if (!label || seen.has(label.toLowerCase()) || label.toLowerCase() === NO_AREA.toLowerCase()) continue;
    seen.add(label.toLowerCase());
    groups.push({ label, hint: truncate(String((g && g.hint) || '').replace(/\s+/g, ' ').trim(), 200) });
  }
  return { groups: groups.slice(0, 12) };
}

function matches(c, email) {
  if (!email) return false;
  const e = String(email).toLowerCase();
  return (c.emails || []).includes(e) || (c.domains || []).includes(e.split('@')[1]);
}

// A client named in the text, as a whole word ("Harbor Coffee", not "harbor" inside "harbors").
function namedClient(text, clients) {
  const t = words(text);
  const hit = clients.find((c) => [c.company, c.name].some((n) => n && n.length >= 3 && t.includes(words(n))));
  return hit ? clientLabel(hit) : null;
}

// The client the summary names: the CRM client it matches, else the name as the summary gave it.
function ctxClient(e, clients) {
  const c = ctxOf(e);
  if (!c || !c.client) return null;
  return namedClient(c.client, clients) || truncate(String(c.client).replace(/\s+/g, ' ').trim(), 40);
}

function clientOf(e, clients) {
  const m = e.meta || {};
  if (m.client && (m.client.company || m.client.name)) return clientLabel(m.client);
  if (e.kind === 'session') {
    const hit = clients.find((c) => m.cwd && (c.project_paths || []).some((p) => m.cwd === p || m.cwd.startsWith(p + path.sep)));
    return hit ? clientLabel(hit) : ctxClient(e, clients);
  }
  const emails = e.kind === 'meeting' ? (m.attendees || []).map((a) => a && a.email) : e.kind === 'thread' ? m.participants || [] : [];
  const hit = clients.find((c) => emails.some((x) => matches(c, x)));
  if (hit) return clientLabel(hit);
  return namedClient(`${e.title || ''} ${e.preview || ''}`, clients);
}

const textOf = (e) => {
  const m = e.meta || {};
  const c = ctxOf(e);
  if (c) return [e.title, c.about, c.client, c.project].filter(Boolean).join(' ');
  const act = m.activity && typeof m.activity === 'object' ? m.activity.text : m.activity;
  return `${e.title || ''} ${e.preview || ''} ${typeof act === 'string' ? act : ''}`;
};

function peopleIn(text) {
  const out = new Set();
  for (const m of String(text).matchAll(PERSON_RE)) {
    const n = m[1] || m[2];
    if (n && !NOT_PEOPLE.has(n.toLowerCase())) out.add(n);
  }
  return out;
}

// People the work is for: names that come up as people ("for Michael", "Andrew's site") in at least
// two items, and are not already a known client.
function peopleOf(list, clients) {
  const count = new Map();
  for (const e of list) for (const n of peopleIn(textOf(e))) count.set(n, (count.get(n) || 0) + 1);
  const knownWords = words(clients.map((c) => `${c.company || ''} ${c.name || ''}`).join(' '));
  return new Set([...count].filter(([n, k]) => k >= 2 && !knownWords.includes(words(n))).map(([n]) => n));
}

function personOf(e, people) {
  if (!people.size) return null;
  for (const n of peopleIn(textOf(e))) if (people.has(n)) return n;
  return null;
}

// The broad area of work with no client: marketing bots and chats, the main Grok bot, my own work.
function areaOf(e) {
  if (MARKETING_RE.test(textOf(e))) return MARKETING;
  if (e.source === 'grok-bot') return MAIN_BOT;
  return e.kind === 'session' ? MINE : null;
}

// With owner-defined groups: the one whose label or hint shares the most words with the item.
const STOP = new Set('anything everything stuff work things thing about with from that this for and the his her their company client clients project projects'.split(' '));
function ruleOf(e, clients, rules) {
  const t = words(`${textOf(e)} ${folderOf(e) || ''} ${clientOf(e, clients) || ''} ${e.source || ''}`);
  let best = null, top = 0;
  for (const r of rules) {
    const tokens = words(`${r.label} ${r.hint}`).trim().split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
    const score = (t.includes(words(r.label)) ? 3 : 0) + tokens.filter((w) => t.includes(` ${w} `)).length;
    if (score > top) { top = score; best = r.label; }
  }
  return best;
}

function groupOf(e, clients, people, rules) {
  if (rules) { const g = ruleOf(e, clients, rules); return g ? { group: g, client: true } : null; }
  const client = clientOf(e, clients) || personOf(e, people);
  if (client) return { group: client, client: true };
  const area = areaOf(e);
  return area ? { group: area, client: false } : null;
}

function folderOf(e) {
  const m = e.meta || {};
  if (typeof m.project === 'string' && m.project && !m.project.startsWith('pj:')) return m.project;
  if (!m.cwd || m.cwd === HOME || NOISE.test(m.cwd)) return null;
  const base = path.basename(m.cwd);
  return /^scratch-|^[0-9a-f-]{20,}$|^Desktop$|^Documents$|^Downloads$/.test(base) ? null : base;
}

function keywordOf(e) {
  const c = ctxOf(e);
  const text = c ? `${e.title || ''} ${c.about} ${c.project || ''}` : `${e.title || ''} ${e.preview || ''}`;
  const hit = KEYWORDS.find(([re]) => re.test(text));
  return hit ? hit[1] : null;
}

const ctxProject = (e) => { const c = ctxOf(e); return c && c.project ? truncate(String(c.project).trim(), 40) : null; };

// The project a chat belongs to: its folder, the project its summary names, a Grok bot by its name,
// else words in its title.
function projectOf(e, clients) {
  const folder = folderOf(e);
  if (folder) return folder;
  const named = ctxProject(e);
  if (named) return named;
  if (e.source === 'grok-bot') return e.title || 'Grok bot';
  return keywordOf(e) || clientOf(e, clients) || 'Other';
}

// Meetings and threads: the project of a chat for the same client, then a project named in the
// title, then words in the title, then a home of their kind.
function projectOther(e, client, projects) {
  const mine = projects.filter((p) => p.group === client);
  if (client && mine.length === 1) return mine[0].label;
  const t = words(e.title);
  const named = projects.find((p) => p.label.length >= 4 && (!client || p.group === client) && t.includes(words(p.label)));
  if (named) return named.label;
  return client || keywordOf(e) || FALLBACK[e.kind] || 'Other';
}

function summaryOf(items) {
  const sorted = [...items].sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || Number(b.kind === 'session') - Number(a.kind === 'session') || (b.updatedAt || 0) - (a.updatedAt || 0));
  const lead = sorted[0];
  if (!lead) return '';
  const working = items.filter(isRunning).length;
  const what = truncate(String(lead.title || 'Untitled').replace(/\s+/g, ' '), 70);
  return working ? `${working} working · latest: ${what}` : `Last: ${what}`;
}

const topicId = (group, label) => `t:${slug(group)}:${slug(label)}`;

// Rules: the client by email, domain, folder, name or a person the work is for; else marketing, the
// main Grok bot or my own projects; the project by folder, bot or title words. With owner-defined
// groups, those are the only top level.
function heuristic(list, clients, rules = rulesOf()) {
  const people = rules ? new Set() : peopleOf(list, clients);
  const projects = new Map();
  const add = (e, group, label, client) => {
    const id = topicId(group, label);
    const p = projects.get(id) || { id, label, group, client, items: [] };
    p.items.push(e); projects.set(id, p);
  };
  for (const e of list.filter((x) => x.kind === 'session')) {
    const g = groupOf(e, clients, people, rules);
    const label = g && g.client && !folderOf(e) && !ctxProject(e) && e.source !== 'grok-bot' ? g.group : projectOf(e, clients);
    if (g) add(e, g.group, label, g.client);
    else add(e, NO_AREA, label, false);
  }
  const chatProjects = [...projects.values()];
  for (const e of list.filter((x) => x.kind !== 'session')) {
    const g = groupOf(e, clients, people, rules);
    const client = g && g.client ? g.group : null;
    const label = projectOther(e, client, chatProjects);
    const home = chatProjects.find((p) => p.label === label && (!client || p.group === client));
    if (home) add(e, home.group, label, home.client);
    else add(e, g ? g.group : NO_AREA, label, !!client);
  }
  const out = [...projects.values()].map((p) => ({ id: p.id, label: p.label, group: p.group, client: p.client, summary: summaryOf(p.items), ids: p.items.map((e) => e.id) }));
  return capGroups(out, rules);
}

// At most MAX_GROUPS top-level groups (or exactly the owner's): the rest fold into Other.
function capGroups(topics, rules = rulesOf()) {
  const size = new Map();
  const isClient = new Map();
  for (const t of topics) { size.set(t.group, (size.get(t.group) || 0) + t.ids.length); if (t.client) isClient.set(t.group, true); }
  const keep = rules ? new Set(rules.map((r) => r.label))
    : new Set([...size.keys()].filter((g) => g !== NO_AREA)
      .sort((a, b) => Number(!!isClient.get(b)) - Number(!!isClient.get(a)) || size.get(b) - size.get(a)).slice(0, MAX_GROUPS));
  const out = [];
  for (const t of topics) {
    const group = keep.has(t.group) ? t.group : NO_AREA;
    const id = topicId(group, t.label);
    const same = out.find((x) => x.id === id);
    if (same) { same.ids.push(...t.ids); continue; }
    out.push({ ...t, id, group, client: group === NO_AREA ? false : t.client, ids: [...t.ids] });
  }
  return out;
}

// The flat projects as the client / area tree, biggest first.
function tree(topics) {
  const groups = new Map();
  for (const t of topics) {
    const id = `c:${slug(t.group || NO_AREA)}`;
    const g = groups.get(id) || { id, label: t.group || NO_AREA, client: !!t.client, projects: [] };
    g.projects.push({ id: t.id, label: t.label, summary: t.summary, ids: t.ids });
    groups.set(id, g);
  }
  const size = (g) => g.projects.reduce((n, p) => n + p.ids.length, 0);
  return [...groups.values()].sort((a, b) => Number(a.label === NO_AREA) - Number(b.label === NO_AREA) || Number(b.client) - Number(a.client) || size(b) - size(a));
}

// What each topic holds right now: how many items are working, how many need you, and by kind.
function decorate(topics, list) {
  const byId = new Map(list.map((e) => [e.id, e]));
  return topics.map((t) => {
    const items = t.ids.map((id) => byId.get(id)).filter(Boolean);
    const kinds = {};
    for (const e of items) { const k = e.kind === 'session' ? 'chat' : e.kind; kinds[k] = (kinds[k] || 0) + 1; }
    const needsYou = items.filter((e) => e.status === 'waiting' || needsReply(e)).length;
    return { ...t, summary: t.summary || summaryOf(items), counts: { working: items.filter(isRunning).length, needsYou }, kinds };
  });
}

function leastUsedAccount() {
  const claude = hub.accounts().filter((a) => a.kind === 'claude-code');
  if (!claude.length) return null;
  let usage = [];
  try { usage = hub.usageSummary(); } catch {}
  const h5 = (a) => ((usage.find((u) => u.id === a.id) || {}).usage || {}).h5 || 0;
  return [...claude].sort((x, y) => h5(x) - h5(y))[0];
}

// What a chat is about: its first real prompt and the latest reply, from the transcript when it can
// be read, else from the card.
function contentOf(e) {
  const m = e.meta || {};
  let first = m.asked || e.title || '', last = (m.activity && typeof m.activity === 'object' ? m.activity.text : m.activity) || e.preview || '';
  if (m.file && (e.source === 'claude-code' || e.source === 'claude-app')) {
    try {
      const s = claudeCode.parseSession(m.file);
      const ask = s.messages.find((x) => x.role === 'user' && !x.kind && String(x.text || '').trim().length > 3);
      const reply = [...s.messages].reverse().find((x) => x.role === 'assistant' && (!x.kind || x.kind === 'recap'));
      if (ask) first = ask.text;
      if (reply) last = reply.text;
    } catch {}
  }
  // Grok bots: what they've been saying lately is where the client names are.
  if (e.source === 'grok-bot' && Array.isArray(m.actions)) {
    const said = m.actions.filter((a) => a && a.text && (a.kind === 'message' || a.kind === 'agent')).slice(0, 4).map((a) => a.text).join(' · ');
    if (said) last = `${last} · ${said}`;
  }
  const flat = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  return { first: truncate(flat(first), 300), last: truncate(flat(last), e.source === 'grok-bot' ? 600 : 300) };
}

// ---- Asking Claude. The prompt pieces and the answer repair are shared with smart group and
// scripts/try-grouping.cjs, so all three ask the same way.

// At most this many items go into one prompt (the most recent first); the rest are placed by rule.
const MAX_ITEMS = 80;
const SOURCE_KIND = { 'claude-code': 'Claude chat', 'claude-app': 'Claude chat', codex: 'Codex chat', cursor: 'Cursor agent', 'grok-bot': 'Grok bot', granola: 'meeting', gmail: 'email' };
const ENTITY_KIND = { meeting: 'meeting', thread: 'email', output: 'note', note: 'note', account: 'agent', client: 'client card', project: 'project' };
const kindLabel = (e) => SOURCE_KIND[e.source] || ENTITY_KIND[e.kind] || 'chat';

// One line per item: "12. [Claude chat] Title | folder: x | client: y | asked: … | latest: …".
// " | " separates the fields, so it is kept out of the values.
const clip = (s, n) => truncate(String(s || '').replace(/\s*\|\s*/g, ' / ').replace(/\s+/g, ' ').trim(), n);
function itemLine(n, { kind, title, folder, client, status, who, linked, asked, latest }) {
  const fields = [
    folder && `folder: ${clip(folder, 40)}`, client && `client: ${clip(client, 40)}`, status && `status: ${clip(status, 20)}`,
    who && `with: ${clip(who, 60)}`, linked && `linked to: ${clip(linked, 80)}`, asked && `asked: ${clip(asked, 160)}`, latest && `latest: ${clip(latest, kind === 'Grok bot' ? 280 : 200)}`,
  ].filter(Boolean);
  return [`${n}. [${kind}] ${clip(title, 80) || 'Untitled'}`, ...fields].join(' | ');
}

const CRITERIA = `1. My clients are PEOPLE (Michael, Andrew, …) and almost all my work is for one of them. Give each client one group named after them, with "client": true. The client is often named only inside "asked" or "latest" ("the listing page for Michael's agency"), not in the title or folder, so read those.
2. Marketing bots and chats (posting, replying, checking posts, outreach, SEO, social) all go in ONE group: "${MARKETING}".
3. My main Grok bot (the one that handles my calendar: scheduling, invites, reminders) goes alone in a small group "${MAIN_BOT}". Never spread it into other groups, even when it names a client.
4. Research goes with the client or project it is about.
5. My own personal and dev work with no client goes in ONE group: "${MINE}".
6. Group by what the work is ABOUT, not by folder or app: a chat, a bot, a meeting and an email about the same thing belong together.
7. At most ${MAX_GROUPS} groups. Fewer and broader is better; merge near-duplicates. Use "${NO_AREA}" only for what fits nowhere.`;

// Worked examples are indented so they never read as real items.
const EXAMPLE_ITEMS = [
  ['Example A items:', [
    itemLine(1, { kind: 'Claude chat', title: 'Hero copy tweaks', folder: 'web-builds', asked: "tighten the hero on the listing page for Michael's agency", latest: 'Rewrote the headline and CTA' }),
    itemLine(2, { kind: 'meeting', title: 'Site review', who: 'Michael Reyes', latest: 'Agreed to launch the agency site Friday' }),
  ]],
  ['Example B items:', [
    itemLine(1, { kind: 'Grok bot', title: 'Outreach', latest: 'Posted 3 threads, sent 12 cold DMs, checked replies' }),
    itemLine(2, { kind: 'Grok bot', title: 'Grok Bot', latest: 'Moved the Thursday call with Andrew to 3pm' }),
    itemLine(3, { kind: 'Claude chat', title: 'Fix sidebar scroll', folder: 'switchboard', asked: 'the sidebar loses its scroll position on refresh' }),
  ]],
];
const indent = (s) => s.split('\n').map((l) => `  ${l}`).join('\n');
function examples(answers) {
  return EXAMPLE_ITEMS.map(([head, lines], i) => `${head}\n${indent(lines.join('\n'))}\nAnswer:\n${indent(answers[i])}`).join('\n');
}
const TOPIC_ANSWERS = [
  JSON.stringify({ clients: [{ label: 'Michael', client: true, projects: [{ label: 'Agency website', summary: 'Hero rewritten, launch set for Friday', items: [1, 2] }] }] }),
  JSON.stringify({ clients: [
    { label: MARKETING, client: false, projects: [{ label: 'Outreach', summary: 'Threads posted, 12 DMs sent', items: [1] }] },
    { label: MAIN_BOT, client: false, projects: [{ label: 'Calendar', summary: 'Thursday call moved to 3pm', items: [2] }] },
    { label: MINE, client: false, projects: [{ label: 'Switchboard', summary: 'Fixing sidebar scroll', items: [3] }] },
  ] }),
];

const known = (clients) => clients.map((c) => [clientLabel(c), ...(c.emails || []), ...(c.domains || [])].filter(Boolean).join(' / ')).filter(Boolean).slice(0, 40);

// The items worth asking about first: live ones, then the most recent.
const forPrompt = (list) => [...list].sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, MAX_ITEMS);

function describe(e, i, clients) {
  const m = e.meta || {};
  const base = { kind: kindLabel(e), title: e.title, client: clientOf(e, clients) };
  if (e.kind === 'session') {
    const status = isLive(e) ? String(e.status || 'running') : '';
    // With an AI summary of the chat, say what the work is and what's next, not the raw first ask.
    const ctx = ctxOf(e);
    if (ctx) {
      return itemLine(i + 1, { ...base, client: base.client || ctx.client || null, folder: folderOf(e), status: status || ctx.status || '',
        who: (ctx.people || []).slice(0, 3).join(', '), asked: `about: ${ctx.about}${ctx.project ? ` (project ${ctx.project})` : ''}`, latest: ctx.nextStep ? `next: ${ctx.nextStep}` : '' });
    }
    const c = contentOf(e);
    return itemLine(i + 1, { ...base, folder: folderOf(e), status, asked: c.first !== e.title ? c.first : '', latest: c.last });
  }
  if (e.kind === 'meeting') {
    const who = (m.attendees || []).slice(0, 3).map((a) => a && (a.name || a.email)).filter(Boolean).join(' & ');
    return itemLine(i + 1, { ...base, who, latest: e.preview });
  }
  return itemLine(i + 1, { ...base, who: (m.participants || [])[0], latest: e.preview });
}

// The whole topics prompt for these items (already cut to MAX_ITEMS).
function topicsPrompt(items, clients, rules = null) {
  const names = known(clients);
  const how = rules
    ? `Use EXACTLY these top-level groups, with "client": true, and no others (plus "${NO_AREA}" for items that fit none):\n${rules.map((r) => `  "${r.label}"${r.hint ? `: ${r.hint}` : ''}`).join('\n')}\nInside a group, items about the same thing go in one project.`
    : `${CRITERIA}\nInside a group, items about the same thing (same site, product, feature or task) go in one project.`;
  return `You sort my AI chats, bots, meetings and emails from this week so I can see at a glance what I'm working on and for whom.
Sort them into 2 to 8 topics as a tree: a few top-level groups (clients or areas), each holding projects.
${how}
${names.length ? `Known clients: ${names.join('; ')}.\n` : ''}Each item: number, [kind], title, then folder / client / with / asked (first request) / latest (latest reply), when known.
${rules ? '' : `${examples(TOPIC_ANSWERS)}\n`}Reply with JSON only, no prose, no code fence: {"clients":[{"label":"Michael","client":true,"projects":[{"label":"Short name","summary":"What is happening now, under 12 words","items":[1,2]}]}]}
Use every item number exactly once. Labels are 1 to 4 plain words, no emoji.

Items:
${items.map((e, i) => describe(e, i, clients)).join('\n')}`;
}

// The JSON object in Claude's answer, forgiving a code fence, prose around it and trailing commas.
function readJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude did not answer with JSON');
  try { return JSON.parse(m[0]); } catch { return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')); }
}

const itemNo = (x) => Number(x && typeof x === 'object' ? x.n ?? x.item ?? x.id : x);
const cleanLabel = (s) => truncate(String(s || '').replace(/[\u{1F000}-\u{1FFFF}☀-➿]/gu, '').replace(/^\s*\d+[.)]\s*/, '').replace(/\s+/g, ' ').trim(), 40);

// Strict reading of a grouped answer: [{ label, client, projects: [{ label, summary, items }] }] over
// items 1..count. Bad numbers are dropped, an item placed twice stays where it came first, groups and
// projects with the same name merge, items left out go to "Other", and past `max` groups the
// smallest fold into "Other".
function repair(groups, count, max = MAX_GROUPS) {
  const used = new Set();
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    const label = cleanLabel(g && g.label) || NO_AREA;
    let group = out.find((x) => x.label.toLowerCase() === label.toLowerCase());
    if (!group) { group = { label, client: !!(g && g.client) && label !== NO_AREA, projects: [] }; out.push(group); }
    const projects = g && Array.isArray(g.projects) ? g.projects : [g];
    for (const p of projects) {
      const items = ((p && (p.items || p.ids)) || []).map(itemNo).filter((n) => Number.isInteger(n) && n >= 1 && n <= count && !used.has(n) && used.add(n));
      if (!items.length) continue;
      const plabel = cleanLabel(p && p.label) || label;
      const same = group.projects.find((x) => x.label.toLowerCase() === plabel.toLowerCase());
      if (same) same.items.push(...items);
      else group.projects.push({ label: plabel, summary: truncate(String((p && p.summary) || ''), 90), items });
    }
  }
  const missing = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !used.has(n));
  const otherOf = () => out.find((g) => g.label === NO_AREA) || (out.push({ label: NO_AREA, client: false, projects: [] }), out[out.length - 1]);
  const addOther = (p) => {
    const o = otherOf();
    const same = o.projects.find((x) => x.label.toLowerCase() === p.label.toLowerCase());
    if (same) same.items.push(...p.items); else o.projects.push({ ...p, items: [...p.items] });
  };
  if (missing.length) addOther({ label: NO_AREA, summary: '', items: missing });
  const size = (g) => g.projects.reduce((n, p) => n + p.items.length, 0);
  const named = out.filter((g) => g.label !== NO_AREA && size(g));
  if (named.length > max) {
    const drop = new Set([...named].sort((a, b) => size(b) - size(a)).slice(max));
    for (const g of drop) for (const p of g.projects) addOther(p);
    return out.filter((g) => !drop.has(g) && size(g));
  }
  return out.filter((g) => size(g));
}

// Claude's topics answer as flat topics over `items`. An older flat answer ({topics:[...]}) reads
// as one project per topic, each its own group.
function readTopics(text, items, clients, rules = null) {
  const parsed = readJson(text);
  const raw = Array.isArray(parsed.clients) ? parsed.clients : Array.isArray(parsed.groups) ? parsed.groups
    : (parsed.topics || []).map((t) => ({ label: t && t.label, client: false, projects: [t] }));
  const topics = [];
  for (const g of repair(raw, items.length, rules ? rules.length : MAX_GROUPS)) {
    const rule = rules && rules.find((r) => words(r.label) === words(g.label));
    const group = rules ? (rule ? rule.label : NO_AREA) : g.label;
    const isClient = !!rule || (group !== NO_AREA && (g.client || clients.some((c) => words(clientLabel(c)) === words(group))));
    for (const p of g.projects) {
      const id = topicId(group, p.label);
      const ids = p.items.map((n) => items[n - 1].id);
      const same = topics.find((x) => x.id === id);
      if (same) same.ids.push(...ids); else topics.push({ id, label: p.label, group, client: isClient, summary: p.summary, ids });
    }
  }
  if (!topics.length) throw new Error('Claude returned no topics');
  return topics;
}

async function askClaude(list, clients, rules = rulesOf()) {
  const a = leastUsedAccount();
  if (!a) throw new Error('No Claude account');
  const items = forPrompt(list);
  const quiet = { ...a, config: { ...a.config, permissionMode: undefined } };
  const res = await claudeCode.prompt(quiet, { cwd: APP_DIR, text: topicsPrompt(items, clients, rules), signal: AbortSignal.timeout(25000), extraArgs: ['--model', 'sonnet', '--tools', '', ...hub.internalArgs()] });
  const topics = readTopics(res.text, items, clients, rules);
  const asked = new Set(items.map((e) => e.id));
  return mergeRest(topics, list.filter((e) => !asked.has(e.id)), clients);
}

// Items the AI topics don't cover (left out, or new since) join the topic with the same name, or
// get one of their own.
function mergeRest(topics, rest, clients) {
  const out = topics.map((t) => ({ ...t, ids: [...t.ids] }));
  for (const g of heuristic(rest, clients)) {
    const same = out.find((t) => t.id === g.id || t.label.toLowerCase() === g.label.toLowerCase())
      || (g.client && out.filter((t) => t.group === g.group).length === 1 && out.find((t) => t.group === g.group));
    if (same) same.ids.push(...g.ids); else out.push(g);
  }
  return out;
}

function cached() {
  const c = db.getSetting('topics', null);
  return c && Array.isArray(c.topics) && c.topics.every((t) => t && 'group' in t) && (c.rules || '') === rulesKey(rulesOf()) ? c : null;
}

// The cached AI topics, trimmed to the items that are still current, with newcomers placed by rule.
function project(c, list, clients) {
  const have = new Set(list.map((e) => e.id));
  const placed = new Set();
  const topics = c.topics.map((t) => ({ ...t, ids: (t.ids || []).filter((id) => have.has(id) && !placed.has(id) && placed.add(id)) }))
    .filter((t) => t.ids.length);
  return mergeRest(topics, list.filter((e) => !placed.has(e.id)), clients);
}

const strip = (topics) => topics.map(({ id, label, group, client, summary, ids }) => ({ id, label, group, client, summary, ids }));
const answer = (topics, list, extra) => {
  const flat = decorate(capGroups(topics), list);
  return { topics: flat, clients: tree(flat), ...extra };
};

async function recompute({ ai = true } = {}) {
  if (inflight) return inflight;
  inflight = (async () => {
    const { list, clients } = await current();
    const key = keyOf(list);
    const rules = rulesOf();
    let topics = null, via = 'rules';
    if (ai && list.length >= 2) {
      try { topics = capGroups(await askClaude(list, clients, rules), rules); via = 'ai'; } catch (e) { console.error('topics: falling back to rules:', e.message); }
    }
    if (!topics) topics = heuristic(list, clients, rules);
    const at = Date.now();
    db.setSetting('topics', { topics: strip(topics), at, key, via, rules: rulesKey(rules) });
    pending = null;
    emitChanged();
    return answer(topics, list, { at, key, via });
  })().finally(() => { inflight = null; });
  return inflight;
}

// The set of items changed: wait until it has held still for 30 seconds before asking Claude again.
function schedule(key) {
  if (inflight) return;
  if (!pending || pending.key !== key) { pending = { key, at: Date.now() }; return; }
  if (Date.now() - pending.at >= SETTLE) recompute().catch(() => {});
}

async function get() {
  const { list, clients } = await current();
  const key = keyOf(list);
  const c = cached();
  if (c && c.key === key) return answer(c.topics, list, { at: c.at, via: c.via });
  if (!c) recompute().catch(() => {}); else schedule(key);
  const topics = c ? project(c, list, clients) : heuristic(list, clients);
  return answer(topics, list, { at: Date.now(), via: 'rules', stale: true });
}

async function tick() {
  try {
    const { list } = await current();
    const key = keyOf(list);
    const c = cached();
    if (!c) { recompute().catch(() => {}); return; }
    if (c.key !== key) schedule(key);
  } catch (e) { console.error('topics:', e.message); }
}

function start({ send }) {
  sendFn = send;
  setTimeout(tick, 8000);
  setInterval(tick, SETTLE);
}

module.exports = {
  handlers: {
    'topics:get': () => get(),
    'topics:refresh': () => recompute(),
    'groupRules:get': () => db.getSetting('groupRules', null) || { groups: [] },
    'groupRules:set': (input) => {
      const rules = cleanRules(input);
      db.setSetting('groupRules', rules);
      emitChanged();
      Promise.resolve(inflight).catch(() => {}).then(() => recompute()).catch(() => {});
      return rules;
    },
  },
  start,
  prompt: { MAX_ITEMS, MAX_GROUPS, CRITERIA, MARKETING, MAIN_BOT, MINE, kindLabel, itemLine, contentOf, examples, topicsPrompt, readTopics, readJson, repair, forPrompt },
  _test: { heuristic, capGroups, peopleOf, ruleOf, cleanRules, projectOf, projectOther, project, keyOf, gather, decorate, describe, clientOf, tree },
};
