'use strict';
// Topics: the chats home sorts what you have going on by what it is about ("Harbor Coffee site",
// "Outreach"), not by which app it lives in. A rule of thumb answers at once; Claude (no tools,
// least-used account, run inside ~/.switchboard so it never shows up as a chat) refines it in the
// background when the set of chats changes.
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

const KEYWORDS = [
  [/\bseo\b|keyword|backlink|serp|rank(ing)?s?\b|search console/i, 'SEO tools'],
  [/outreach|cold (email|dm)|linkedin|prospect|lead(s|gen)?\b|follow[- ]?up|newsletter/i, 'Outreach'],
  [/calendar|meeting|schedul|invoice|expense|admin|inbox|email|taxes?\b|booking/i, 'Calendar & admin'],
  [/website|landing|site\b|homepage|webflow|wordpress|shopify/i, 'Websites'],
  [/\b(ad|ads|tiktok|instagram|video|reel|social|content|post(s)?)\b/i, 'Content & social'],
  [/research|paper|study|analy[sz]/i, 'Research'],
  [/trad(e|ing)|market|polymarket|stock|crypto/i, 'Markets'],
];

let sendFn = null;
let inflight = null;
let pending = null; // { key, at }: a changed set of chats waiting to settle

const emitChanged = () => {
  const e = { type: 'topics-changed' };
  if (sendFn) sendFn(e); else hub.events.emit('event', e);
};

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';
const isLive = (e) => e.status === 'running' || e.status === 'waiting' || !!(e.meta && e.meta.activity && e.meta.activity.running);

function isNoise(e) {
  const m = e.meta || {};
  return typeof m.noise === 'boolean' ? m.noise : NOISE.test(m.cwd || '');
}

// Chats worth sorting: anything touched in the last week, plus whatever is running or waiting.
async function chats() {
  const since = Date.now() - WINDOW;
  return (await hub.entities()).filter((e) => e.kind === 'session' && !(e.meta && e.meta.archived) && !isNoise(e)
    && ((e.updatedAt || 0) >= since || isLive(e)));
}

const keyOf = (list) => list.map((e) => e.id).sort().join('|');

function clientOf(e, clients) {
  const m = e.meta || {};
  if (m.client && m.client.name) return m.client.company || m.client.name;
  const hit = clients.find((c) => m.cwd && (c.project_paths || []).some((p) => m.cwd === p || m.cwd.startsWith(p + path.sep)));
  return hit ? hit.company || hit.name : null;
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

// Client, then project folder, then a Grok bot as its own hub, then words in the title.
function placeOf(e, clients) {
  const client = clientOf(e, clients);
  if (client) return client;
  const folder = folderOf(e);
  if (folder) return folder;
  if (e.source === 'grok-bot') return e.title || 'Grok bot';
  return keywordOf(e) || 'Other';
}

function summaryOf(items) {
  const sorted = [...items].sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || (b.updatedAt || 0) - (a.updatedAt || 0));
  const lead = sorted[0];
  if (!lead) return '';
  const working = items.filter((e) => e.status === 'running' || (e.meta && e.meta.activity && e.meta.activity.running)).length;
  const what = truncate(String(lead.title || 'Untitled').replace(/\s+/g, ' '), 70);
  return working ? `${working} working · latest: ${what}` : `Last: ${what}`;
}

function heuristic(list, clients) {
  const groups = new Map();
  for (const e of list) {
    const label = placeOf(e, clients);
    const g = groups.get(label) || { label, items: [] };
    g.items.push(e); groups.set(label, g);
  }
  return [...groups.values()].map((g) => ({ id: `t:${slug(g.label)}`, label: g.label, summary: summaryOf(g.items), ids: g.items.map((e) => e.id) }));
}

function leastUsedAccount() {
  const claude = hub.accounts().filter((a) => a.kind === 'claude-code');
  if (!claude.length) return null;
  let usage = [];
  try { usage = hub.usageSummary(); } catch {}
  const h5 = (a) => ((usage.find((u) => u.id === a.id) || {}).usage || {}).h5 || 0;
  return [...claude].sort((x, y) => h5(x) - h5(y))[0];
}

function describe(e, i, clients) {
  const m = e.meta || {};
  const act = m.activity && typeof m.activity === 'object' ? m.activity.text : m.activity;
  const bits = [
    e.source,
    folderOf(e) ? `folder ${folderOf(e)}` : '',
    clientOf(e, clients) ? `client ${clientOf(e, clients)}` : '',
    isLive(e) ? String(e.status || 'running') : '',
  ].filter(Boolean).join(', ');
  const latest = truncate(String(act || e.preview || '').replace(/\s+/g, ' '), 110);
  return `${i + 1}. ${truncate(e.title || 'Untitled', 80)} (${bits})${latest ? ` - ${latest}` : ''}`;
}

async function askClaude(list, clients) {
  const a = leastUsedAccount();
  if (!a) throw new Error('No Claude account');
  const text = `These are my current AI chats and agents. Sort them into 2 to 8 topics by what they are working on
(a client, product, project or kind of work), e.g. "Harbor Coffee site", "SEO tools", "Outreach", "Calendar & admin".
Reply with JSON only, no prose: {"topics":[{"label":"Short name","summary":"What is happening in this topic right now, under 12 words","items":[1,2]}]}
Use every item number exactly once. Labels are 1 to 4 plain words, no emoji.

${list.map((e, i) => describe(e, i, clients)).join('\n')}`;
  const quiet = { ...a, config: { ...a.config, permissionMode: undefined } };
  const res = await claudeCode.prompt(quiet, { cwd: APP_DIR, text, signal: AbortSignal.timeout(25000), extraArgs: ['--model', 'sonnet', '--tools', ''] });
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
    topics.push({ id: `t:${slug(label)}`, label, summary, ids });
  }
  if (!topics.length) throw new Error('Claude returned no topics');
  return mergeRest(topics, list.filter((_, i) => !used.has(i + 1)), clients);
}

// Chats the AI topics don't cover (left out, or new since) join the topic with the same name, or
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

// The cached AI topics, trimmed to the chats that are still current, with newcomers placed by rule.
function project(c, list, clients) {
  const have = new Set(list.map((e) => e.id));
  const placed = new Set();
  const topics = c.topics.map((t) => ({ ...t, ids: (t.ids || []).filter((id) => have.has(id) && !placed.has(id) && placed.add(id)) }))
    .filter((t) => t.ids.length);
  return mergeRest(topics, list.filter((e) => !placed.has(e.id)), clients);
}

async function recompute({ ai = true } = {}) {
  if (inflight) return inflight;
  inflight = (async () => {
    const list = await chats();
    const key = keyOf(list);
    const clients = hub.clients();
    let topics = null, via = 'rules';
    if (ai && list.length >= 2 && list.length <= AI_LIMIT) {
      try { topics = await askClaude(list, clients); via = 'ai'; } catch (e) { console.error('topics: falling back to rules:', e.message); }
    }
    if (!topics) topics = heuristic(list, clients);
    const value = { topics, at: Date.now(), key, via };
    db.setSetting('topics', value);
    pending = null;
    emitChanged();
    return value;
  })().finally(() => { inflight = null; });
  return inflight;
}

// The set of chats changed: wait until it has held still for 30 seconds before asking Claude again.
function schedule(key) {
  if (inflight) return;
  if (!pending || pending.key !== key) { pending = { key, at: Date.now() }; return; }
  if (Date.now() - pending.at >= SETTLE) recompute().catch(() => {});
}

async function get() {
  const list = await chats();
  const key = keyOf(list);
  const clients = hub.clients();
  const c = cached();
  if (c && c.key === key) return { topics: c.topics, at: c.at, via: c.via };
  if (!c) recompute().catch(() => {}); else schedule(key);
  const topics = c ? project(c, list, clients) : heuristic(list, clients);
  return { topics, at: Date.now(), via: 'rules', stale: true };
}

async function tick() {
  try {
    const list = await chats();
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
  _test: { heuristic, placeOf, project, keyOf },
};
