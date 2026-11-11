'use strict';
// Proactive nudges for the overall agent: whose turn it is, what failed, replies owed,
// stalled work and small "you're missing X" tips. Recomputed on a timer and on changes.
const hub = require('../hub.cjs');
const db = require('../db.cjs');
const { truncate } = require('../util.cjs');

const DAY = 86400000;
const AGENTS = new Set(['claude-code', 'codex', 'cursor', 'anthropic-api', 'openai-compatible']);
const UNFINISHED = /\?\s*$|next steps?|to-?do|remaining|not yet|still (need|to)|left to|want me to|should i|shall i|let me know|blocked|failing/i;
const RANK = { waiting: 0, reply: 1, followup: 2, idle: 3, tip: 4 };
const DISMISSED = 'proactive.dismissed';
const KEEP = 14 * DAY;

let memo = { at: 0, items: [] };
let inflight = null;

const short = (s, n = 64) => truncate(s || 'Untitled', n);
const isNoise = (e) => !!(e.meta && e.meta.noise);

function dismissed() {
  const d = db.getSetting(DISMISSED, {});
  return d && typeof d === 'object' ? d : {};
}

function dismiss(id) {
  const d = dismissed();
  for (const k of Object.keys(d)) if (d[k] < Date.now() - KEEP) delete d[k];
  d[id] = Date.now();
  db.setSetting(DISMISSED, d);
  memo.items = memo.items.filter((i) => i.id !== id);
  return true;
}

function turnItems(sessions, now) {
  const out = [];
  for (const e of sessions) {
    if (e.status === 'running' || now - e.updatedAt > 2 * DAY) continue;
    const asks = e.status === 'idle' && AGENTS.has(e.source) && /\?\s*$/.test(e.preview || '');
    if (e.status !== 'waiting' && !asks) continue;
    out.push({ id: `wait:${e.id}:${e.updatedAt}`, kind: 'waiting', title: short(e.title), detail: asks ? 'Asked you something' : 'Your turn', ref: e.id, ts: e.updatedAt });
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, 5);
}

function errorItems(ents, now) {
  const out = ents.filter((e) => e.kind === 'error').map((e) => ({ id: `err:${e.id}`, kind: 'waiting', tone: 'error', title: short(e.title), detail: 'Not loading', action: 'settings:accounts', ts: e.updatedAt }));
  const latest = new Map();
  for (const r of hub.runs.values()) {
    if (r.entityId === 'chief') continue;
    const p = latest.get(r.entityId);
    if (!p || r.startedAt > p.startedAt) latest.set(r.entityId, r);
  }
  for (const r of latest.values()) {
    if (r.status !== 'error' || now - r.startedAt > 6 * 3600000) continue;
    out.push({ id: `run:${r.id}`, kind: 'waiting', tone: 'error', title: short(hub.label(r.entityId)), detail: `Failed: ${truncate(r.error, 70)}`, ref: r.entityId, ts: r.startedAt });
  }
  return out;
}

function dueItems(items, now) {
  return items
    .filter((d) => d.kind !== 'action' || d.overdue || (d.due && d.due < now + DAY))
    .slice(0, 8)
    .map((d) => ({ id: `due:${d.id}`, kind: d.kind === 'reply' ? 'reply' : 'followup', title: short(d.title, 72), detail: `${d.client}${d.overdue ? ' · late' : ''}`, ref: d.ref, ts: d.due || now }));
}

function idleItems(sessions, now) {
  return sessions
    .filter((e) => AGENTS.has(e.source) && now - e.updatedAt > 2 * DAY && now - e.updatedAt < 14 * DAY && (e.status === 'waiting' || UNFINISHED.test(e.preview || '')))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3)
    .map((e) => ({ id: `idle:${e.id}:${e.updatedAt}`, kind: 'idle', title: short(e.title), detail: `Quiet ${Math.round((now - e.updatedAt) / DAY)}d, unfinished`, ref: e.id, ts: e.updatedAt }));
}

function tipItems() {
  const out = [];
  const open = hub.clients().filter((c) => c.status !== 'done' && c.status !== 'lost');
  for (const c of open.filter((c) => c.status !== 'lead' && !c.next_action).slice(0, 3)) {
    out.push({ id: `nostep:${c.id}`, kind: 'tip', title: `No next step for ${short(c.name, 40)}`, ref: `cl:${c.id}`, ts: c.updated_at || 0 });
  }
  const leads = open.filter((c) => c.status === 'lead' && !c.next_action);
  if (leads.length) out.push({ id: `leads:${leads.length}`, kind: 'tip', title: leads.length === 1 ? `New lead: ${short(leads[0].name, 40)}` : `${leads.length} new leads to review`, action: 'settings:clients', ts: 0 });
  const accs = hub.accounts();
  for (const a of accs.filter((a) => a.kind === 'claude-code' && a.config.auth && a.config.auth.loggedIn === false)) {
    out.push({ id: `signin:${a.id}`, kind: 'tip', title: `Sign in to ${a.label}`, detail: 'Signed out', action: 'settings:accounts', ts: 0 });
  }
  if (!accs.some((a) => a.kind === 'gmail')) out.push({ id: 'tip:gmail', kind: 'tip', title: 'Connect Gmail', detail: 'To track replies you owe', action: 'settings:accounts', ts: 0 });
  return out;
}

function sessionsOf(ents) {
  const hidden = new Set(hub.board().filter((n) => n.hidden).map((n) => n.id));
  return ents.filter((e) => e.kind === 'session' && !isNoise(e) && !hidden.has(e.id));
}

// One line per thing: a failed run outranks "your turn" on the same card.
function rank(items, now) {
  const hide = dismissed();
  const ids = new Set(), refs = new Set();
  return items
    .filter((i) => !(hide[i.id] > now - KEEP))
    .sort((a, b) => (RANK[a.kind] - RANK[b.kind]) || ((b.tone ? 1 : 0) - (a.tone ? 1 : 0)) || (b.ts - a.ts))
    .filter((i) => {
      if (ids.has(i.id) || (i.kind === 'waiting' && i.ref && refs.has(i.ref))) return false;
      ids.add(i.id); if (i.kind === 'waiting' && i.ref) refs.add(i.ref);
      return true;
    })
    .slice(0, 14);
}

async function compute() {
  const now = Date.now();
  const [ents, due] = await Promise.all([hub.entities().catch(() => []), hub.due().catch(() => [])]);
  const sessions = sessionsOf(ents);
  const items = rank([...errorItems(ents, now), ...turnItems(sessions, now), ...dueItems(due, now), ...idleItems(sessions, now), ...tipItems()], now);
  memo = { at: Date.now(), items };
  return items;
}

function list() {
  if (Date.now() - memo.at < 5000) return memo.items;
  if (!inflight) inflight = compute().finally(() => { inflight = null; });
  return inflight;
}

function waitRun(runId, ms) {
  return new Promise((resolve) => {
    let t;
    const done = (r) => { clearTimeout(t); hub.events.off('event', on); resolve(r); };
    const on = (e) => { if (e.type === 'run' && e.run.id === runId && e.run.status !== 'running') done(e.run); };
    t = setTimeout(() => done(hub.runs.get(runId)), ms);
    hub.events.on('event', on);
  });
}

function plainRecap(items, active) {
  const lines = [`**Last day:** ${active.length ? `${active.length} agent${active.length > 1 ? 's' : ''} active` : 'quiet'}.`];
  const needs = items.filter((i) => i.kind !== 'tip').slice(0, 5);
  if (needs.length) lines.push('**Needs you:**', ...needs.map((i) => `- ${i.title}${i.detail ? ` (${i.detail})` : ''}`));
  else lines.push('Nothing needs you right now.');
  if (needs[0]) lines.push(`**Next:** ${needs[0].title}`);
  return lines.join('\n');
}

async function recap() {
  memo.at = 0;
  const items = await list();
  const now = Date.now();
  const active = sessionsOf(await hub.entities().catch(() => [])).filter((e) => now - e.updatedAt < DAY).slice(0, 15);
  const flagged = items.slice(0, 10).map((i) => `- ${i.title}${i.detail ? ` (${i.detail})` : ''}`).join('\n');
  const worked = active.map((e) => `- ${short(e.title, 60)}: ${truncate(e.preview, 140)}`).join('\n');
  const q = `Daily recap: what got done, what needs me, and the one thing to do next. Under 120 words.\n\nFlagged:\n${flagged || '- nothing'}\n\nActive in the last day:\n${worked || '- nothing'}`;
  try {
    const r = await waitRun(hub.chief(q, {}), 240000);
    if (r && r.status === 'done' && r.text) return r.text;
  } catch {}
  return plainRecap(items, active);
}

function start({ send }) {
  let t;
  const tick = async () => {
    try { memo.at = 0; const items = await list(); send({ type: 'proactive', count: items.length, items }); } catch {}
  };
  const soon = () => { clearTimeout(t); t = setTimeout(tick, 2500); };
  hub.events.on('event', (e) => {
    if (e.type === 'entities-changed' || e.type === 'auth') soon();
    if (e.type === 'run' && e.run.status !== 'running' && e.run.entityId !== 'chief') soon();
  });
  setTimeout(tick, 4000);
  setInterval(tick, 60000);
}

module.exports = {
  handlers: {
    'proactive:list': () => list(),
    'proactive:dismiss': (id) => dismiss(id),
    'proactive:recap': () => recap(),
  },
  start,
};
