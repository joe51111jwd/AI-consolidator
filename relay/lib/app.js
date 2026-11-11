// Every route of the relay in one handler: (req, res) for Node's http server and Vercel functions.
//   /mcp              the MCP connector for Grok bots      Authorization: Bearer <BOT_TOKEN>
//   /api/events       GET  ?since=<cursor> → { events, cursor, more }    Bearer <APP_TOKEN>
//   /api/tasks        POST { bot, text } queues a message for a bot
//   /api/board        POST { summary } stores the board summary bots read
//   /api/health       GET  checks the URL and token
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { storeFromEnv, TTL_DAYS } from './store.js';
import { handleMcp } from './mcp.js';
import { botKey, clip } from './util.js';

const MAX_BODY = 1024 * 1024;
const PAGE = 500;
// An event id the counter handed out but whose write hasn't landed yet leaves a gap. Reads stop at
// a fresh gap so the cursor never skips it; a gap older than this is a failed write and is passed.
const GAP_MS = 10000;

let store = null;
export const getStore = () => (store ||= storeFromEnv());
export const setStore = (s) => { store = s; };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

const digest = (s) => createHash('sha256').update(String(s)).digest();
function authorized(req, envName) {
  const want = process.env[envName];
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '');
  // Hashing first makes the comparison constant-time whatever the lengths.
  return !!want && !!m && timingSafeEqual(digest(m[1]), digest(want));
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

// Vercel parses JSON bodies onto req.body; Node's own server leaves the stream to read.
async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return undefined;
  if (req.body !== undefined) {
    if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) return parse(String(req.body));
    return req.body;
  }
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Body too large');
    chunks.push(c);
  }
  return chunks.length ? parse(Buffer.concat(chunks).toString('utf8')) : undefined;
}
function parse(s) { try { return JSON.parse(s); } catch { throw new HttpError(400, 'Body is not valid JSON'); } }

function text(v, name, max) {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${name} is required`);
  return clip(v, max);
}

async function events({ url, store }) {
  let since = Math.max(0, parseInt(url.searchParams.get('since'), 10) || 0);
  const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || PAGE));
  // A cursor past the counter means the relay's storage was reset: start over.
  if (since > (await store.head())) since = 0;
  const list = await store.eventsAfter(since, limit);
  const now = Date.now();
  const oldest = now - TTL_DAYS * 86400000;
  const out = [];
  let cursor = since;
  for (const e of list) {
    if (e.id !== cursor + 1 && now - (e.ts || 0) < GAP_MS) break;
    cursor = e.id;
    if ((e.ts || 0) >= oldest) out.push(e);
  }
  return { events: out, cursor, more: list.length === limit && cursor === (list[list.length - 1] || {}).id };
}

async function queueTask({ body, store }) {
  const bot = text(body && body.bot, 'bot', 80);
  const task = { id: randomUUID(), bot, text: text(body.text, 'text', 20000), ts: Date.now() };
  if (typeof body.botId === 'string' && body.botId) task.botId = clip(body.botId, 128);
  await store.pushTask(botKey(bot), task);
  return { ok: true, task: { id: task.id, bot: task.bot, ts: task.ts } };
}

async function saveBoard({ body, store }) {
  const summary = text(body && body.summary, 'summary', 40000);
  await store.setBoard({ summary, ts: Date.now() });
  return { ok: true };
}

async function health({ store }) {
  const warnings = [];
  if (!process.env.BOT_TOKEN) warnings.push('BOT_TOKEN is not set, so bots cannot connect.');
  else if (process.env.BOT_TOKEN === process.env.APP_TOKEN) warnings.push('BOT_TOKEN and APP_TOKEN are the same. Use two different tokens.');
  if (store.kind === 'memory') warnings.push('No Redis configured: events are kept in memory and lost when the function restarts. Add Upstash Redis.');
  return { ok: true, storage: store.kind, cursor: await store.head(), warnings };
}

const ROUTES = {
  events: { GET: events },
  tasks: { POST: queueTask },
  board: { POST: saveBoard },
  health: { GET: health },
};

export async function handler(req, res) {
  try {
    const url = new URL(req.url || '/', 'http://relay.local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/mcp' || path === '/api/mcp') {
      if (!authorized(req, 'BOT_TOKEN')) return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      return await handleMcp(req, res, getStore(), await readBody(req));
    }
    const route = ROUTES[path.replace(/^\/api\//, '')];
    if (!route || !path.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    if (!authorized(req, 'APP_TOKEN')) return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    const fn = route[req.method];
    if (!fn) return send(res, 405, { error: 'Method not allowed' }, { Allow: Object.keys(route).join(', ') });
    return send(res, 200, await fn({ url, body: await readBody(req), store: getStore() }));
  } catch (e) {
    if (!(e instanceof HttpError)) console.error('relay:', e);
    return send(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'Internal error' });
  }
}

export default handler;
