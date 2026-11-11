'use strict';
// Switchboard Relay (relay/ in this repo, deployed to Vercel): an always-on MCP connector that any
// agent reports to from wherever it runs: Grok bots on Cursor's cloud, Claude chats (claude.ai, the
// Claude app), Claude Code in the cloud or on other computers, Cursor, Codex, ChatGPT. While it is
// on, this pulls the relay's events every 20 s and merges them onto the cards: what each agent is
// doing, its steps, the helper agents it started. Grok bots land on their Grok Bot card when this
// Mac's Grok Bot app knows them; every other agent gets its own card (rl:<app>:<name>). Messages to an
// agent are queued on the relay and collected with get_tasks. Outputs become output cards, brain
// notes go to the shared brain, and the app uploads a short board summary agents read with read_board.
// Gmail and Granola are read through their own APIs and sign-ins, not through the relay.
// Settings: relayUrl, relayEnabled, relayCursor, relayAgents, relaySync. Tokens live in the Keychain.
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
// How each app's agents show on the board (relay/lib/util.js APPS).
const APPS = {
  'grok-bot': { source: 'grok-bot', label: 'Grok Bot', category: 'chat' },
  claude: { source: 'claude-code', label: 'Claude', category: 'chat' },
  'claude-code': { source: 'claude-code', label: 'Claude Code', category: 'coding' },
  cursor: { source: 'cursor', label: 'Cursor', category: 'coding' },
  codex: { source: 'codex', label: 'Codex', category: 'coding' },
  chatgpt: { source: 'chatgpt', label: 'ChatGPT', category: 'chat' },
  other: { source: 'relay', label: 'Agent', category: 'chat' },
};

const emit = (e) => hub.events.emit('event', e);
const changed = () => { hub.invalidate(); emit({ type: 'entities-changed' }); };
const on = () => db.getSetting('relayEnabled', false) === true;
const url = () => db.getSetting('relayUrl', '') || '';
const enabled = () => on() && !!url() && secrets.has(APP_TOKEN);
// The same key the relay files tasks under (relay/lib/util.js agentKey).
const agentKey = (name) => String(name || '').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'agent';
const appOf = (a) => (APPS[a] ? a : 'other');

// ---------- what the relay has told us, per agent ----------
let agents = null; // "<app>:<key>" -> { id, app, key, name, agentId, status, doing, client, statusAt, at, last, actions, subagents }
function state() {
  if (!agents) agents = new Map(Object.entries(db.getSetting('relayAgents', {}) || {}));
  return agents;
}
const save = () => db.setSetting('relayAgents', Object.fromEntries(state()));
function agentFor(name, app, agentId) {
  const key = agentKey(name);
  const id = `${appOf(app)}:${key}`;
  let a = state().get(id);
  if (!a) { a = { id, app: appOf(app), key, name: truncate(String(name).trim(), 80), at: 0, actions: [], subagents: [] }; state().set(id, a); }
  if (agentId) a.agentId = agentId;
  return a;
}
function act(a, kind, text, ts) {
  if (!text) return;
  a.actions = [{ kind, text: truncate(String(text), 200), ts }, ...a.actions].sort((x, y) => y.ts - x.ts).slice(0, MAX_ACTIONS);
  if (!a.last || ts >= a.last.ts) a.last = { text: truncate(String(text), 220), ts };
}

// A Grok bot shows on its Grok Bot card from this Mac's cache if the names (or ids) match.
function localCard(list, a) {
  if (a.app !== 'grok-bot') return null;
  return list.find((e) => e.source === 'grok-bot' && e.kind === 'session' && e.id.startsWith('gb:')
    && ((a.agentId && e.meta && e.meta.agentId === a.agentId) || agentKey(e.title) === a.key)) || null;
}
const cardId = (list, a) => { const c = localCard(list, a); return c ? c.id : `rl:${a.id}`; };

async function apply(events) {
  const list = await hub.entities().catch(() => []);
  for (const ev of events) {
    if (!ev || typeof ev.agent !== 'string' || !ev.agent.trim()) continue;
    const a = agentFor(ev.agent, ev.app, ev.agentId);
    if (ev.type !== 'delivered') a.name = truncate(ev.agent.trim(), 80); // the agent's latest own spelling
    const ts = Number(ev.ts) || Date.now();
    a.at = Math.max(a.at || 0, ts);
    switch (ev.type) {
      case 'status':
        Object.assign(a, { status: ev.status, doing: ev.doing || '', client: ev.client || '', statusAt: ts });
        if (ev.doing) a.last = { text: truncate(ev.doing, 220), ts };
        break;
      case 'action': act(a, ACTION_KIND[ev.kind] || 'notice', ev.text, ts); break;
      case 'subagent': {
        const s = ev.sub || {};
        if (!s.id) break;
        const prev = a.subagents.find((x) => x.id === s.id);
        if (!prev) act(a, 'agent', `Started ${s.kind === 'claude-cli' ? 'Claude Code' : s.kind === 'cursor-agent' ? 'a Cursor agent' : 'a helper'}: ${s.title}`, ts);
        const sub = { id: s.id, kind: s.kind || 'other', title: s.title || 'Helper agent', status: s.status, updatedAt: ts, lastText: s.lastText || (prev && prev.lastText) || s.title };
        if (s.prUrl || (prev && prev.prUrl)) sub.prUrl = s.prUrl || prev.prUrl;
        a.subagents = [sub, ...a.subagents.filter((x) => x.id !== s.id)].slice(0, MAX_SUBS);
        break;
      }
      case 'output':
        hub.saveOutput({ title: ev.title, content: ev.url ? `${ev.content || ''}\n\n${ev.url}` : ev.content || '', source: cardId(list, a) });
        act(a, 'notice', `Posted “${ev.title}”`, ts);
        break;
      case 'brain':
        if (ev.text) { hub.appendBrain(ev.text, `${a.name} (${APPS[a.app].label})`); act(a, 'notice', 'Added a note to the shared brain', ts); }
        break;
      case 'delivered': {
        const t = Array.isArray(ev.tasks) ? ev.tasks : [];
        act(a, 'message', t.length === 1 ? `Picked up your message: ${t[0].text}` : `Picked up ${t.length} messages from you`, ts);
        break;
      }
      default: break;
    }
  }
}

// ---------- merging onto the cards ----------
function statusOf(a, now) {
  if (a.status === 'working') return now - (a.statusAt || 0) < STALE_MS ? 'running' : 'idle';
  return a.status === 'waiting' ? 'waiting' : a.status === 'error' ? 'error' : 'idle';
}
function activityOf(a, now) {
  const st = statusOf(a, now);
  const doing = [a.doing, a.client].filter(Boolean).join(' · ');
  const text = st === 'running' ? doing || 'Working'
    : st === 'waiting' ? (doing ? `Waiting on you: ${doing}` : 'Waiting on you')
      : st === 'error' ? (doing ? `Failed: ${doing}` : 'Something failed')
        : (a.last && a.last.text) || doing || 'Idle';
  return { text, running: st === 'running' };
}
const subsOf = (a, now) => a.subagents.map((s) => ({ ...s, status: s.status === 'running' && now - s.updatedAt > SUB_STALE_MS ? 'done' : s.status }));
const byTime = (x, y) => (y.ts || y.updatedAt || 0) - (x.ts || x.updatedAt || 0);
const color = (key) => AVATARS[crypto.createHash('sha1').update(key).digest()[0] % AVATARS.length];

function merge(e, a, now) {
  const m = e.meta || (e.meta = {});
  m.relay = true;
  m.actions = [...a.actions, ...(m.actions || [])].sort(byTime).slice(0, 15);
  const ids = new Set(a.subagents.map((s) => s.id));
  m.subagents = [...subsOf(a, now), ...(m.subagents || []).filter((s) => !ids.has(s.id))].sort(byTime);
  // The newer of the two wins what the bot is doing now: the relay, or the Grok Bot app's cache.
  if ((a.at || 0) >= (e.updatedAt || 0)) {
    e.status = statusOf(a, now);
    m.activity = activityOf(a, now);
    if (a.last && a.last.text) e.preview = a.last.text;
    e.updatedAt = a.at;
  }
}

function card(a, accs, now) {
  const app = APPS[a.app];
  const acc = a.app === 'grok-bot' ? accs.find((x) => x.kind === 'grok-bot') : null;
  return {
    id: `rl:${a.id}`, kind: 'session', source: app.source, accountId: acc ? acc.id : undefined,
    title: a.name, preview: (a.last && a.last.text) || a.doing || '', updatedAt: a.at, status: statusOf(a, now),
    meta: {
      relay: true, app: a.app, agentName: a.name, agentId: a.agentId, category: app.category, account: acc ? acc.label : app.label, unread: 0,
      ...(a.app === 'grok-bot' ? { avatarColor: color(a.key) } : {}),
      activity: activityOf(a, now), actions: a.actions.slice(0, 15), subagents: subsOf(a, now),
    },
  };
}

function decorate(list, accs) {
  if (!enabled() || !state().size) return;
  const now = Date.now();
  for (const a of state().values()) {
    const local = localCard(list, a);
    if (local) merge(local, a, now); else list.push(card(a, accs, now));
  }
}

// ---------- sending ----------
// Which agent a card means: a relay card, a Grok Bot card from this Mac, or the Grok Bot account
// card (the bot selected in the Grok Bot app).
function target(id) {
  const [kind, accId, ...rest] = id.split(':');
  if (kind === 'rl') { const a = state().get(id.slice(3)); return a ? { name: a.name, app: a.app, agentId: a.agentId } : null; }
  if (kind === 'gb') {
    const e = hub.find(id);
    if (e) return { name: e.title, app: 'grok-bot', agentId: e.meta && e.meta.agentId };
    const b = grok.bots().find((x) => x.id === rest.join(':'));
    return b ? { name: b.name, app: 'grok-bot', agentId: b.id } : null;
  }
  if (kind === 'ac') {
    const acc = hub.account(accId);
    if (!acc || acc.kind !== 'grok-bot') return null;
    const sel = grok.selectedAgent();
    const b = sel && grok.bots().find((x) => x.id === sel);
    return b ? { name: b.name, app: 'grok-bot', agentId: b.id } : null;
  }
  return null;
}

async function dispatch(id, text) {
  if (!enabled()) return undefined;
  const t = target(id);
  if (!t) return undefined;
  await request('POST', '/api/tasks', { agent: t.name, app: t.app, agentId: t.agentId || undefined, text });
  const a = agentFor(t.name, t.app, t.agentId);
  a.at = Math.max(a.at || 0, Date.now());
  act(a, 'message', `You: ${text}`, Date.now());
  save(); changed();
  return { text: `Queued for ${t.name} on Switchboard Relay. ${t.name} picks it up the next time it checks in.` };
}

// A relay card's conversation: what the agent reported, oldest first.
function transcript(id) {
  if (!id.startsWith('rl:')) return undefined;
  const a = state().get(id.slice(3));
  if (!a) return [];
  return [...a.actions].reverse().map((x, i) => {
    const mine = x.text.startsWith('You: ');
    return { id: `${id}:${i}`, role: mine ? 'user' : 'assistant', text: mine ? x.text.slice(5) : x.kind === 'message' ? x.text : `[${x.text}]`, ts: x.ts, kind: x.kind === 'message' ? undefined : 'tool' };
  });
}

hub.use({ decorate, dispatch, transcript, canPrompt: (id) => id.startsWith('rl:') && enabled() });

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

// What agents see with read_board: the agents and chats active in the last three days and the clients.
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
  let s = String(u || '').trim().replace(/\?.*$/, '').replace(/\/+$/, '').replace(/\/mcp$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let x;
  try { x = new URL(s); } catch { throw new Error('That relay address is not a valid URL.'); }
  if (x.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)) throw new Error('Use an https:// address for the relay.');
  return `${x.origin}${x.pathname.replace(/\/+$/, '')}`;
}

function status() {
  const u = url();
  const list = [...state().values()].sort((a, b) => b.at - a.at).map((a) => ({ name: a.name, app: a.app, at: a.at }));
  return {
    url: u, mcpUrl: u ? `${u}/mcp` : '', enabled: on(), active: enabled(),
    hasToken: secrets.has(APP_TOKEN), hasBotToken: secrets.has(BOT_TOKEN),
    lastSync: db.getSetting('relaySync', null), agents: list,
  };
}

let ticker = null;
function schedule() {
  clearInterval(ticker);
  ticker = enabled() ? setInterval(() => sync().catch(() => {}), POLL_MS) : null;
}

// A deploy script can leave ~/.switchboard/relay-setup.json ({ url, appToken, botToken }) once:
// the tokens move into the Keychain and the file is deleted.
async function importSetup() {
  const f = require('path').join(require('../util.cjs').APP_DIR, 'relay-setup.json');
  const fs = require('fs');
  if (!fs.existsSync(f)) return;
  let j = null;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  if (j && j.url && j.appToken) await configure({ url: j.url, appToken: j.appToken, botToken: j.botToken, enabled: true });
  fs.rmSync(f, { force: true });
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

// Copies a setup line with {MCP} (the connector address) and {TOKEN} (the agent token) filled in
// here, so the token never reaches the window. Without a saved token it stays a placeholder.
function copy(template) {
  const t = secrets.get(BOT_TOKEN);
  const mcp = url() ? `${url()}/mcp` : 'https://<your-relay>.vercel.app/mcp';
  require('electron').clipboard.writeText(String(template || '').replaceAll('{MCP}', mcp).replaceAll('{TOKEN}', t || '<BOT_TOKEN>'));
  return { full: !!t };
}

module.exports = {
  handlers: {
    'relay:status': () => status(),
    'relay:configure': (opts) => configure(opts || {}),
    'relay:test': () => test(),
    'relay:sync': () => sync(),
    'relay:copy': (template) => copy(template),
  },
  start() {
    importSetup().catch((e) => console.error('relay setup import:', e.message));
    schedule();
    sync().catch(() => {});
  },
};
