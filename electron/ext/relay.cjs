'use strict';
// Switchboard Relay (relay/ in this repo, deployed to Vercel): an always-on MCP connector that Grok
// bots report to from Cursor's cloud. While it is on, this pulls the relay's events every 20 s and
// merges them onto the Grok bot cards (what each bot is doing, its steps, its helper agents), so the
// cards keep moving with the Grok Bot app closed or on another Mac. A bot this Mac doesn't know gets
// its own card (grk:<name>). Messages to a bot are queued on the relay; the bot collects them with
// get_tasks. Outputs become output cards and brain notes go to the shared brain. The app also uploads
// a short board summary that bots read with read_board.
// Settings: relayUrl, relayEnabled, relayCursor, relayBots, relaySync. Tokens live in the Keychain.
const crypto = require('crypto');
const db = require('../db.cjs');
const secrets = require('../secrets.cjs');
const hub = require('../hub.cjs');
const grok = require('../sources/grokbot.cjs');
const { truncate } = require('../util.cjs');

const POLL_MS = 20000;
const APP_TOKEN = 'relay:appToken';
const BOT_TOKEN = 'relay:botToken';
const MAX_ACTIONS = 30;
const MAX_SUBS = 20;
const STALE_MS = 10 * 60000; // "working" with no report for this long shows as idle
const SUB_STALE_MS = 30 * 60000; // a helper agent with no news for this long shows as done
const ACTION_KIND = { message: 'message', email: 'message', tool: 'tool', browser: 'tool', connector: 'connector', note: 'notice', agent: 'agent' };
const AVATARS = ['#8E4EC6', '#E93D82', '#3E63DD', '#30A46C', '#F76B15', '#12A594', '#5B5BD6', '#A18072'];

const emit = (e) => hub.events.emit('event', e);
const changed = () => { hub.invalidate(); emit({ type: 'entities-changed' }); };
const on = () => db.getSetting('relayEnabled', false) === true;
const url = () => db.getSetting('relayUrl', '') || '';
const enabled = () => on() && !!url() && secrets.has(APP_TOKEN);
// The same key the relay files tasks under (relay/lib/util.js botKey).
const botKey = (name) => String(name || '').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'bot';

// ---------- what the relay has told us, per bot ----------
let bots = null; // key -> { key, name, botId, status, doing, client, statusAt, at, last, actions, subagents }
function state() {
  if (!bots) bots = new Map(Object.entries(db.getSetting('relayBots', {}) || {}));
  return bots;
}
const save = () => db.setSetting('relayBots', Object.fromEntries(state()));
function botFor(name, botId) {
  const key = botKey(name);
  let b = state().get(key);
  if (!b) { b = { key, name: truncate(String(name).trim(), 80), at: 0, actions: [], subagents: [] }; state().set(key, b); }
  if (botId) b.botId = botId;
  return b;
}
function act(b, kind, text, ts) {
  if (!text) return;
  b.actions = [{ kind, text: truncate(String(text), 200), ts }, ...b.actions].sort((x, y) => y.ts - x.ts).slice(0, MAX_ACTIONS);
  if (!b.last || ts >= b.last.ts) b.last = { text: truncate(String(text), 220), ts };
}

// The card a bot shows on: its Grok Bot card from this Mac's cache if the names match, else its own.
function localCard(list, b) {
  return list.find((e) => e.source === 'grok-bot' && e.kind === 'session' && e.id.startsWith('gb:')
    && ((b.botId && e.meta && e.meta.agentId === b.botId) || botKey(e.title) === b.key));
}

async function apply(events) {
  const list = await hub.entities().catch(() => []);
  for (const ev of events) {
    if (!ev || typeof ev.bot !== 'string' || !ev.bot.trim()) continue;
    const b = botFor(ev.bot, ev.botId);
    if (ev.type !== 'delivered') b.name = truncate(ev.bot.trim(), 80); // the bot's latest own spelling
    const ts = Number(ev.ts) || Date.now();
    b.at = Math.max(b.at || 0, ts);
    switch (ev.type) {
      case 'status':
        Object.assign(b, { status: ev.status, doing: ev.doing || '', client: ev.client || '', statusAt: ts });
        if (ev.doing) b.last = { text: truncate(ev.doing, 220), ts };
        break;
      case 'action': act(b, ACTION_KIND[ev.kind] || 'notice', ev.text, ts); break;
      case 'subagent': {
        const s = ev.sub || {};
        if (!s.id) break;
        const prev = b.subagents.find((x) => x.id === s.id);
        if (!prev) act(b, 'agent', `Started ${s.kind === 'claude-cli' ? 'Claude Code' : s.kind === 'cursor-agent' ? 'a Cursor agent' : 'a helper'}: ${s.title}`, ts);
        const sub = { id: s.id, kind: s.kind || 'other', title: s.title || 'Helper agent', status: s.status, updatedAt: ts, lastText: s.lastText || (prev && prev.lastText) || s.title };
        if (s.prUrl || (prev && prev.prUrl)) sub.prUrl = s.prUrl || prev.prUrl;
        b.subagents = [sub, ...b.subagents.filter((x) => x.id !== s.id)].slice(0, MAX_SUBS);
        break;
      }
      case 'output': {
        const card = localCard(list, b);
        hub.saveOutput({ title: ev.title, content: ev.url ? `${ev.content || ''}\n\n${ev.url}` : ev.content || '', source: card ? card.id : `grk:${b.key}` });
        act(b, 'notice', `Posted “${ev.title}”`, ts);
        break;
      }
      case 'brain':
        if (ev.text) { hub.appendBrain(ev.text, `${b.name} (Grok)`); act(b, 'notice', 'Added a note to the shared brain', ts); }
        break;
      case 'delivered': {
        const t = Array.isArray(ev.tasks) ? ev.tasks : [];
        act(b, 'message', t.length === 1 ? `Picked up your message: ${t[0].text}` : `Picked up ${t.length} messages from you`, ts);
        break;
      }
      default: break;
    }
  }
}

// ---------- merging onto the cards ----------
function statusOf(b, now) {
  if (b.status === 'working') return now - (b.statusAt || 0) < STALE_MS ? 'running' : 'idle';
  return b.status === 'waiting' ? 'waiting' : b.status === 'error' ? 'error' : 'idle';
}
function activityOf(b, now) {
  const st = statusOf(b, now);
  const doing = [b.doing, b.client].filter(Boolean).join(' · ');
  const text = st === 'running' ? doing || 'Working'
    : st === 'waiting' ? (doing ? `Waiting on you: ${doing}` : 'Waiting on you')
      : st === 'error' ? (doing ? `Failed: ${doing}` : 'Something failed')
        : (b.last && b.last.text) || doing || 'Idle';
  return { text, running: st === 'running' };
}
const subsOf = (b, now) => b.subagents.map((s) => ({ ...s, status: s.status === 'running' && now - s.updatedAt > SUB_STALE_MS ? 'done' : s.status }));
const byTime = (x, y) => (y.ts || y.updatedAt || 0) - (x.ts || x.updatedAt || 0);
const color = (key) => AVATARS[crypto.createHash('sha1').update(key).digest()[0] % AVATARS.length];

function merge(e, b, now) {
  const m = e.meta || (e.meta = {});
  m.relay = true;
  m.actions = [...b.actions, ...(m.actions || [])].sort(byTime).slice(0, 15);
  const ids = new Set(b.subagents.map((s) => s.id));
  m.subagents = [...subsOf(b, now), ...(m.subagents || []).filter((s) => !ids.has(s.id))].sort(byTime);
  // The newer of the two wins what the bot is doing now: the relay, or the Grok Bot app's cache.
  if ((b.at || 0) >= (e.updatedAt || 0)) {
    e.status = statusOf(b, now);
    m.activity = activityOf(b, now);
    if (b.last && b.last.text) e.preview = b.last.text;
    e.updatedAt = b.at;
  }
}

function card(b, acc, now) {
  return {
    id: `grk:${b.key}`, kind: 'session', source: 'grok-bot', accountId: acc ? acc.id : undefined,
    title: b.name, preview: (b.last && b.last.text) || b.doing || '', updatedAt: b.at, status: statusOf(b, now),
    meta: {
      relay: true, botName: b.name, botId: b.botId, category: 'chat', account: acc ? acc.label : 'Grok Bot', unread: 0,
      avatarColor: color(b.key), activity: activityOf(b, now), actions: b.actions.slice(0, 15), subagents: subsOf(b, now),
    },
  };
}

function decorate(list, accs) {
  if (!enabled() || !state().size) return;
  const now = Date.now();
  const acc = accs.find((a) => a.kind === 'grok-bot');
  for (const b of state().values()) {
    const local = localCard(list, b);
    if (local) merge(local, b, now); else list.push(card(b, acc, now));
  }
}

// ---------- sending ----------
// Which bot a card means: a relay card, a Grok Bot card from this Mac, or the Grok Bot account card
// (the bot selected in the Grok Bot app).
function target(id) {
  const [kind, accId, ...rest] = id.split(':');
  if (kind === 'grk') { const b = state().get(accId); return b ? { name: b.name, botId: b.botId } : null; }
  if (kind === 'gb') {
    const e = hub.find(id);
    const b = e ? null : grok.bots().find((x) => x.id === rest.join(':'));
    return e ? { name: e.title, botId: e.meta && e.meta.agentId } : b ? { name: b.name, botId: b.id } : null;
  }
  if (kind === 'ac') {
    const a = hub.account(accId);
    if (!a || a.kind !== 'grok-bot') return null;
    const sel = grok.selectedAgent();
    const b = sel && grok.bots().find((x) => x.id === sel);
    return b ? { name: b.name, botId: b.id } : null;
  }
  return null;
}

async function dispatch(id, text) {
  if (!enabled()) return undefined;
  const t = target(id);
  if (!t) return undefined;
  await request('POST', '/api/tasks', { bot: t.name, botId: t.botId || undefined, text });
  const b = botFor(t.name, t.botId);
  b.at = Math.max(b.at || 0, Date.now());
  act(b, 'message', `You: ${text}`, Date.now());
  save(); changed();
  return { text: `Queued for ${t.name} on Switchboard Relay. ${t.name} picks it up the next time it checks in.` };
}

// A relay card's conversation: what the bot reported, oldest first.
function transcript(id) {
  if (!id.startsWith('grk:')) return undefined;
  const b = state().get(id.slice(4));
  if (!b) return [];
  return [...b.actions].reverse().map((a, i) => {
    const mine = a.text.startsWith('You: ');
    return { id: `${id}:${i}`, role: mine ? 'user' : 'assistant', text: mine ? a.text.slice(5) : a.kind === 'message' ? a.text : `[${a.text}]`, ts: a.ts, kind: a.kind === 'message' ? undefined : 'tool' };
  });
}

hub.use({ decorate, dispatch, transcript, canPrompt: (id) => id.startsWith('grk:') && enabled() });

// ---------- talking to the relay ----------
async function request(method, path, body) {
  const base = url();
  const token = secrets.get(APP_TOKEN);
  if (!base || !token) throw new Error('Add the relay URL and app token first.');
  let r;
  try {
    r = await fetch(base + path, {
      method, signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`Couldn't reach the relay at ${new URL(base).host}${e.cause && e.cause.code ? ` (${e.cause.code})` : ''}.`);
  }
  const j = await r.json().catch(() => null);
  if (r.status === 401) {
    throw new Error(j && j.error ? 'The relay refused the app token. It must match APP_TOKEN on Vercel.'
      : 'Vercel asked for a login. Use the production address (…vercel.app) or turn off Deployment Protection for the relay.');
  }
  if (!r.ok || !j) throw new Error(`The relay answered ${r.status}${j && j.error ? `: ${j.error}` : ''}.`);
  return j;
}

let syncing = null;
let boardHash = null;
function setSync(s) { db.setSetting('relaySync', s); emit({ type: 'relay', status: status() }); }

async function pull() {
  let count = 0;
  try {
    let cursor = Number(db.getSetting('relayCursor', 0)) || 0;
    for (let page = 0; page < 20; page++) {
      const r = await request('GET', `/api/events?since=${cursor}`);
      const evs = Array.isArray(r.events) ? r.events : [];
      if (evs.length) { await apply(evs); count += evs.length; save(); }
      cursor = Number(r.cursor) || 0;
      db.setSetting('relayCursor', cursor);
      if (!r.more) break;
    }
    if (count) changed();
    await shareBoard().catch(() => {});
    setSync({ at: Date.now(), ok: true, count });
  } catch (e) {
    setSync({ at: Date.now(), ok: false, error: e.message });
    throw e;
  }
  return status();
}
function sync() {
  if (!enabled()) return Promise.resolve(status());
  if (!syncing) syncing = pull().finally(() => { syncing = null; });
  return syncing;
}

// What bots see with read_board: the agents and chats active in the last three days and the clients.
async function boardSummary() {
  const now = Date.now();
  const list = await hub.entities();
  const label = (e) => (e.meta && e.meta.account) || e.source;
  const sessions = list.filter((e) => e.kind === 'session' && !(e.meta && e.meta.noise) && now - (e.updatedAt || 0) < 3 * 86400000)
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 60)
    .map((e) => {
      const doing = (e.meta && e.meta.activity && e.meta.activity.text) || e.preview || '';
      return `- ${e.title} (${label(e)}) [${e.status || 'idle'}]${doing ? `: ${truncate(String(doing).replace(/\s+/g, ' '), 160)}` : ''}`;
    });
  const clients = hub.clients().filter((c) => c.status !== 'done' && c.status !== 'lost').slice(0, 30)
    .map((c) => `- ${c.name}${c.company ? ` (${c.company})` : ''}${c.next_action ? `, next: ${truncate(c.next_action, 120)}${c.due ? ` (due ${c.due})` : ''}` : ''}`);
  return [sessions.length && `Agents and chats, newest first:\n${sessions.join('\n')}`, clients.length && `Clients:\n${clients.join('\n')}`].filter(Boolean).join('\n\n');
}
async function shareBoard() {
  const summary = await boardSummary();
  const h = crypto.createHash('sha1').update(url() + summary).digest('hex');
  if (!summary || h === boardHash) return;
  await request('POST', '/api/board', { summary });
  boardHash = h;
}

// ---------- settings ----------
function normalize(u) {
  let s = String(u || '').trim().replace(/\/+$/, '').replace(/\/mcp$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let x;
  try { x = new URL(s); } catch { throw new Error('That relay address is not a valid URL.'); }
  if (x.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)) throw new Error('Use an https:// address for the relay.');
  return `${x.origin}${x.pathname.replace(/\/+$/, '')}`;
}

function status() {
  const u = url();
  const list = [...state().values()].sort((a, b) => b.at - a.at).map((b) => ({ name: b.name, at: b.at }));
  return {
    url: u, mcpUrl: u ? `${u}/mcp` : '', enabled: on(), active: enabled(),
    hasToken: secrets.has(APP_TOKEN), hasBotToken: secrets.has(BOT_TOKEN),
    lastSync: db.getSetting('relaySync', null), bots: list,
  };
}

let ticker = null;
function schedule() {
  clearInterval(ticker);
  ticker = enabled() ? setInterval(() => sync().catch(() => {}), POLL_MS) : null;
}

async function configure({ url: u, appToken, botToken, enabled: en } = {}) {
  if (u !== undefined) {
    const n = normalize(u);
    if (n !== url()) { db.setSetting('relayUrl', n); db.setSetting('relayCursor', 0); boardHash = null; }
  }
  // A string sets a token, null removes it, anything else leaves it as it is.
  if (typeof appToken === 'string' && appToken.trim()) secrets.set(APP_TOKEN, appToken.trim()); else if (appToken === null) secrets.set(APP_TOKEN, null);
  if (typeof botToken === 'string' && botToken.trim()) secrets.set(BOT_TOKEN, botToken.trim()); else if (botToken === null) secrets.set(BOT_TOKEN, null);
  if (en !== undefined) db.setSetting('relayEnabled', !!en);
  schedule();
  changed();
  if (enabled()) await sync().catch(() => {});
  return status();
}

async function test() {
  const h = await request('GET', '/api/health');
  return { ok: true, storage: h.storage, warnings: Array.isArray(h.warnings) ? h.warnings : [] };
}

// The header value for Grok Bot's connector settings, copied here so the bot token never reaches the window.
function copyHeader() {
  const t = secrets.get(BOT_TOKEN);
  require('electron').clipboard.writeText(`Bearer ${t || '<BOT_TOKEN>'}`);
  return { full: !!t };
}

module.exports = {
  handlers: {
    'relay:status': () => status(),
    'relay:configure': (opts) => configure(opts || {}),
    'relay:test': () => test(),
    'relay:sync': () => sync(),
    'relay:copyHeader': () => copyHeader(),
  },
  start() {
    schedule();
    sync().catch(() => {});
  },
};
