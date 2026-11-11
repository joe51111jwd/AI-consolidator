'use strict';
// Topics: the home sorts what you have going on this week by what it is about ("Harbor Coffee site",
// "Outreach"), not by which app it lives in. Besides chats, a topic holds the week's Granola
// meetings, Gmail threads waiting on your reply, clients with work this week and outputs, each next
// to the chats for the same client or project. A rule of thumb answers at once; Claude (no tools,
// no user hooks, least-used account, run inside ~/.switchboard so it never shows up as a chat)
// refines it in the background when the set of items changes.
const path = require('path');
const hub = require('../hub.cjs');
const db = require('../db.cjs');
const claudeCode = require('../sources/claudeCode.cjs');
const { APP_DIR, HOME, truncate } = require('../util.cjs');

const DAY = 86400000;
const WINDOW = 7 * DAY;
const SETTLE = 30000;
const AI_LIMIT = 120;
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
const FALLBACK = { meeting: 'Meetings', thread: 'Inbox', output: 'Outputs' };
// How each kind is labelled for Claude.
const KIND_TAG = { meeting: 'meeting', thread: 'email waiting on my reply', client: 'client', output: 'output' };

let sendFn = null;
let inflight = null;
let pending = null; // { key, at }: a changed set of items waiting to settle

const emitChanged = () => {
  const e = { type: 'topics-changed' };
  if (sendFn) sendFn(e); else hub.events.emit('event', e);
};

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';
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

function overdue(c, now = Date.now()) {
  const d = c.due ? Date.parse(c.due) : NaN;
  return !!c.next_action && Number.isFinite(d) && d < now - DAY + 1;
}
function dueThisWeek(c, now = Date.now()) {
  const d = c.due ? Date.parse(c.due) : NaN;
  return !!c.next_action && Number.isFinite(d) && d <= now + WINDOW;
}

// Everything on the home this week: chats touched in the last 7 days (or running / waiting),
// meetings from the last 7 days (and the coming week), threads waiting on a reply, outputs, and the
// clients any of those belong to or that have something due.
function gather(all, clients, now = Date.now()) {
  const since = now - WINDOW;
  const chats = all.filter((e) => e.kind === 'session' && !(e.meta && e.meta.archived) && !isNoise(e)
    && ((e.updatedAt || 0) >= since || isLive(e)));
  const meetings = all.filter((e) => e.kind === 'meeting' && meetingAt(e) >= since && meetingAt(e) <= now + WINDOW);
  const threads = all.filter((e) => needsReply(e) && (e.updatedAt || 0) >= since);
  const outputs = all.filter((e) => e.kind === 'output' && (e.updatedAt || 0) >= since);
  const base = [...chats, ...meetings, ...threads, ...outputs];
  const used = new Set(base.map((e) => clientOf(e, clients)).filter(Boolean));
  const cards = all.filter((e) => {
    if (e.kind !== 'client') return false;
    const c = (e.meta && e.meta.client) || {};
    if (c.status === 'done' || c.status === 'lost') return false;
    return used.has(clientLabel(c)) || dueThisWeek(c, now) || (c.created_at || 0) >= since;
  });
  return [...base, ...cards];
}

async function current() {
  const clients = hub.clients();
  return { list: gather(await hub.entities(), clients), clients };
}

const keyOf = (list) => list.map((e) => e.id).sort().join('|');

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

function clientOf(e, clients) {
  const m = e.meta || {};
  if (m.client && (m.client.company || m.client.name)) return clientLabel(m.client);
  if (e.kind === 'session') {
    const hit = clients.find((c) => m.cwd && (c.project_paths || []).some((p) => m.cwd === p || m.cwd.startsWith(p + path.sep)));
    return hit ? clientLabel(hit) : null;
  }
  const emails = e.kind === 'meeting' ? (m.attendees || []).map((a) => a && a.email) : e.kind === 'thread' ? m.participants || [] : [];
  const hit = clients.find((c) => emails.some((x) => matches(c, x)));
  if (hit) return clientLabel(hit);
  return namedClient(`${e.title || ''} ${e.kind === 'output' ? '' : e.preview || ''}`, clients);
}

function folderOf(e) {
  const m = e.meta || {};
  if (typeof m.project === 'string' && m.project && !m.project.startsWith('pj:')) return m.project;
  if (!m.cwd || m.cwd === HOME || NOISE.test(m.cwd)) return null;
  const base = path.basename(m.cwd);
  return /^scratch-|^[0-9a-f-]{20,}$|^Desktop$|^Documents$|^Downloads$/.test(base) ? null : base;
}

function keywordOf(e) {
  const text = `${e.title || ''} ${e.preview || ''}`;
  const hit = KEYWORDS.find(([re]) => re.test(text));
  return hit ? hit[1] : null;
}

// Chats: client, then project folder, then a Grok bot as its own hub, then words in the title.
function placeOf(e, clients) {
  const client = clientOf(e, clients);
  if (client) return client;
  const folder = folderOf(e);
  if (folder) return folder;
  if (e.source === 'grok-bot') return e.title || 'Grok bot';
  return keywordOf(e) || 'Other';
}

// Meetings, threads and outputs: client, then the chat it came from (outputs), then a topic the
// chats already have whose name is in the title, then words in the title, then a home of its kind.
function placeOther(e, clients, labels, placed) {
  const client = clientOf(e, clients);
  if (client) return client;
  const from = e.meta && e.meta.from;
  if (from && placed.has(from)) return placed.get(from);
  const t = words(e.title);
  const named = labels.find((l) => l.length >= 4 && !/^(other|outputs|inbox|meetings)$/i.test(l) && t.includes(words(l)));
  if (named) return named;
  return keywordOf(e) || FALLBACK[e.kind] || 'Other';
}

function summaryOf(items) {
  const rank = (e) => (e.kind === 'session' ? 2 : e.kind === 'client' ? 0 : 1);
  const sorted = [...items].sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || rank(b) - rank(a) || (b.updatedAt || 0) - (a.updatedAt || 0));
  const lead = sorted[0];
  if (!lead) return '';
  const working = items.filter(isRunning).length;
  const what = truncate(String(lead.title || 'Untitled').replace(/\s+/g, ' '), 70);
  return working ? `${working} working · latest: ${what}` : `Last: ${what}`;
}

function heuristic(list, clients) {
  const groups = new Map();
  const placed = new Map();
  const add = (e, label) => {
    const g = groups.get(label) || { label, items: [] };
    g.items.push(e); groups.set(label, g); placed.set(e.id, label);
  };
  const isChat = (e) => e.kind === 'session';
  for (const e of list.filter(isChat)) add(e, placeOf(e, clients));
  for (const e of list.filter((x) => x.kind === 'client')) add(e, clientLabel(e.meta.client));
  const labels = [...groups.keys()];
  for (const e of list.filter((x) => !isChat(x) && x.kind !== 'client' && x.kind !== 'output')) add(e, placeOther(e, clients, labels, placed));
  for (const e of list.filter((x) => x.kind === 'output')) add(e, placeOther(e, clients, labels, placed));
  return [...groups.values()].map((g) => ({ id: `t:${slug(g.label)}`, label: g.label, summary: summaryOf(g.items), ids: g.items.map((e) => e.id) }));
}

// What each topic holds right now: how many items are working, how many need you, and by kind.
function decorate(topics, list) {
  const byId = new Map(list.map((e) => [e.id, e]));
  return topics.map((t) => {
    const items = t.ids.map((id) => byId.get(id)).filter(Boolean);
    const kinds = {};
    for (const e of items) { const k = e.kind === 'session' ? 'chat' : e.kind; kinds[k] = (kinds[k] || 0) + 1; }
    const needsYou = items.filter((e) => e.status === 'waiting' || needsReply(e) || (e.kind === 'client' && overdue(e.meta.client))).length;
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

// Parentheses and commas separate the details Claude reads, so they are kept out of the values.
const bit = (s, n = 60) => truncate(String(s || '').replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim(), n);

function describe(e, i, clients) {
  const m = e.meta || {};
  const client = clientOf(e, clients);
  let bits, latest;
  if (e.kind === 'session') {
    const act = m.activity && typeof m.activity === 'object' ? m.activity.text : m.activity;
    bits = [e.source, folderOf(e) ? `folder ${bit(folderOf(e))}` : '', client ? `client ${bit(client)}` : '', isLive(e) ? String(e.status || 'running') : ''];
    latest = act || e.preview;
  } else if (e.kind === 'meeting') {
    const who = (m.attendees || []).slice(0, 3).map((a) => a && (a.name || a.email)).filter(Boolean).map((x) => bit(x, 30)).join(' & ');
    bits = ['granola', client ? `client ${bit(client)}` : '', who ? `with ${who}` : ''];
    latest = e.preview;
  } else if (e.kind === 'thread') {
    bits = ['gmail', client ? `client ${bit(client)}` : '', (m.participants || [])[0] ? `from ${bit(m.participants[0], 40)}` : ''];
    latest = e.preview;
  } else if (e.kind === 'client') {
    const c = m.client || {};
    bits = ['crm', `client ${bit(clientLabel(c))}`, c.next_action ? `next ${bit(c.next_action)}` : ''];
    latest = '';
  } else {
    bits = [e.source || e.kind, client ? `client ${bit(client)}` : ''];
    latest = e.preview;
  }
  const tag = KIND_TAG[e.kind] ? `[${KIND_TAG[e.kind]}] ` : '';
  const line = truncate(String(latest || '').replace(/\s+/g, ' '), 110);
  return `${i + 1}. ${tag}${bit(e.title || 'Untitled', 80)} (${bits.filter(Boolean).join(', ')})${line ? ` - ${line}` : ''}`;
}

async function askClaude(list, clients) {
  const a = leastUsedAccount();
  if (!a) throw new Error('No Claude account');
  const text = `These are my AI chats and agents from this week, with my meetings, emails waiting on my reply, clients and outputs.
Sort them into 2 to 8 topics by what they are about (a client, product, project or kind of work), e.g. "Harbor Coffee site", "SEO tools", "Outreach", "Calendar & admin".
Put each meeting, email, client and output in the same topic as the chats for that client or project.
Reply with JSON only, no prose: {"topics":[{"label":"Short name","summary":"What is happening in this topic right now, under 12 words","items":[1,2]}]}
Use every item number exactly once. Labels are 1 to 4 plain words, no emoji.

${list.map((e, i) => describe(e, i, clients)).join('\n')}`;
  const quiet = { ...a, config: { ...a.config, permissionMode: undefined } };
  const res = await claudeCode.prompt(quiet, { cwd: APP_DIR, text, signal: AbortSignal.timeout(25000), extraArgs: ['--model', 'sonnet', '--tools', '', ...hub.internalArgs()] });
  const m = String(res.text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude did not answer with JSON');
  const used = new Set();
  const topics = [];
  for (const t of JSON.parse(m[0]).topics || []) {
    const label = truncate(String((t && t.label) || '').trim(), 40);
    const ids = ((t && (t.items || t.ids)) || []).map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= list.length && !used.has(n))
      .map((n) => { used.add(n); return list[n - 1].id; });
    if (!label || !ids.length) continue;
    const summary = truncate(String((t && t.summary) || '').replace(/\s+/g, ' ').trim(), 90);
    const same = topics.find((x) => x.id === `t:${slug(label)}`);
    if (same) { same.ids.push(...ids); continue; }
    topics.push({ id: `t:${slug(label)}`, label, summary, ids });
  }
  if (!topics.length) throw new Error('Claude returned no topics');
  return mergeRest(topics, list.filter((_, i) => !used.has(i + 1)), clients);
}

// Items the AI topics don't cover (left out, or new since) join the topic with the same name, or
// get one of their own.
function mergeRest(topics, rest, clients) {
  const out = topics.map((t) => ({ ...t, ids: [...t.ids] }));
  for (const g of heuristic(rest, clients)) {
    const same = out.find((t) => t.id === g.id || t.label.toLowerCase() === g.label.toLowerCase());
    if (same) same.ids.push(...g.ids); else out.push(g);
  }
  return out;
}

function cached() {
  const c = db.getSetting('topics', null);
  return c && Array.isArray(c.topics) ? c : null;
}

// The cached AI topics, trimmed to the items that are still current, with newcomers placed by rule.
function project(c, list, clients) {
  const have = new Set(list.map((e) => e.id));
  const placed = new Set();
  const topics = c.topics.map((t) => ({ ...t, ids: (t.ids || []).filter((id) => have.has(id) && !placed.has(id) && placed.add(id)) }))
    .filter((t) => t.ids.length);
  return mergeRest(topics, list.filter((e) => !placed.has(e.id)), clients);
}

const strip = (topics) => topics.map(({ id, label, summary, ids }) => ({ id, label, summary, ids }));

async function recompute({ ai = true } = {}) {
  if (inflight) return inflight;
  inflight = (async () => {
    const { list, clients } = await current();
    const key = keyOf(list);
    let topics = null, via = 'rules';
    if (ai && list.length >= 2 && list.length <= AI_LIMIT) {
      try { topics = await askClaude(list, clients); via = 'ai'; } catch (e) { console.error('topics: falling back to rules:', e.message); }
    }
    if (!topics) topics = heuristic(list, clients);
    const at = Date.now();
    db.setSetting('topics', { topics: strip(topics), at, key, via });
    pending = null;
    emitChanged();
    return { topics: decorate(topics, list), at, key, via };
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
  if (c && c.key === key) return { topics: decorate(c.topics, list), at: c.at, via: c.via };
  if (!c) recompute().catch(() => {}); else schedule(key);
  const topics = c ? project(c, list, clients) : heuristic(list, clients);
  return { topics: decorate(topics, list), at: Date.now(), via: 'rules', stale: true };
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
  },
  start,
  _test: { heuristic, placeOf, placeOther, project, keyOf, gather, decorate, describe, clientOf },
};
