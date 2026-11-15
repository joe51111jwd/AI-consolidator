// Every route of the relay in one handler: (req, res) for Node's http server and Vercel functions.
//   /mcp?app=<app>    the MCP connector agents call        Authorization: Bearer <BOT_TOKEN>
//                     (or ?key=<BOT_TOKEN> for clients that can't send headers, like Claude's connectors)
//   /api/events       GET  ?since=<cursor> → { events, cursor, more }    Bearer <APP_TOKEN>
//   /api/tasks        POST { agent, app, text } queues a message for an agent
//   /api/board        POST { summary } stores the board summary bots read
//   /api/health       GET  checks the URL and token
//   /api/cloud/*      cloud sessions streaming their transcripts (lib/cloud.js); /sync.cjs serves the streamer
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { storeFromEnv, TTL_DAYS } from './store.js';
import { handleMcp } from './mcp.js';
import { BOT_ROUTES, APP_ROUTES, CloudError, syncScript } from './cloud.js';
import { agentKey, appOf, clip } from './util.js';

const MAX_BODY = 1024 * 1024;
// A streamer's batch comes gzipped (X-SB-Encoding: gzip, sent as octet-stream so nothing in between
// parses it): up to 4 MB on the wire, 24 MB unpacked.
const MAX_GZIP = 4 * 1024 * 1024;
const MAX_UNZIPPED = 24 * 1024 * 1024;
const PAGE = 500;
// An event id the counter handed out but whose write hasn't landed yet leaves a gap. Reads stop at
// a fresh gap so the cursor never skips it; a gap older than this is a failed write and is passed.
const GAP_MS = 10000;

let store = null;
export const getStore = () => (store ||= storeFromEnv());
export const setStore = (s) => { store = s; };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

const digest = (s) => createHash('sha256').update(String(s)).digest();
// The token comes in the Authorization header, or for the MCP connector also as ?key= in its address.
function authorized(req, envName, url) {
  const want = process.env[envName];
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '');
  const got = m ? m[1] : url ? url.searchParams.get('key') : null;
  // Hashing first makes the comparison constant-time whatever the lengths.
  return !!want && !!got && timingSafeEqual(digest(got), digest(want));
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

// Vercel parses JSON bodies onto req.body (and leaves others as a Buffer); Node's own server leaves
// the stream to read.
async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return undefined;
  const gz = String(req.headers['x-sb-encoding'] || '').toLowerCase() === 'gzip';
  const limit = gz ? MAX_GZIP : MAX_BODY;
  let buf;
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) buf = req.body;
    else if (typeof req.body === 'string') buf = Buffer.from(req.body);
    else return req.body;
    if (buf.length > limit) throw new HttpError(413, 'Body too large');
  } else {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new HttpError(413, 'Body too large');
      chunks.push(c);
    }
    buf = Buffer.concat(chunks);
  }
  if (gz && buf.length) {
    try { buf = gunzipSync(buf, { maxOutputLength: MAX_UNZIPPED }); } catch { throw new HttpError(400, 'Body is not valid gzip'); }
  }
  return buf.length ? parse(buf.toString('utf8')) : undefined;
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
  const agent = text(body && body.agent, 'agent', 80);
  const app = appOf(body.app) || 'other';
  const task = { id: randomUUID(), agent, app, text: text(body.text, 'text', 20000), ts: Date.now() };
  if (typeof body.agentId === 'string' && body.agentId) task.agentId = clip(body.agentId, 128);
  await store.pushTask(`${app}:${agentKey(agent)}`, task);
  return { ok: true, task: { id: task.id, agent, app, ts: task.ts } };
}

async function saveBoard({ body, store }) {
  const summary = text(body && body.summary, 'summary', 40000);
  await store.setBoard({ summary, ts: Date.now() });
  return { ok: true };
}

async function health({ store }) {
  const warnings = [];
  if (!process.env.BOT_TOKEN) warnings.push('BOT_TOKEN is not set, so agents cannot connect.');
  else if (process.env.BOT_TOKEN === process.env.APP_TOKEN) warnings.push('BOT_TOKEN and APP_TOKEN are the same. Use two different tokens.');
  if (store.kind === 'memory') warnings.push('No database configured: events are kept in memory and lost when the function restarts. Add Neon (Postgres) or Upstash Redis.');
  return { ok: true, storage: store.kind, cursor: await store.head(), warnings };
}

const ROUTES = {
  events: { GET: events },
  tasks: { POST: queueTask },
  board: { POST: saveBoard },
  health: { GET: health },
  ...APP_ROUTES,
};

async function serve(res, route, req, url) {
  const fn = route[req.method];
  if (!fn) return send(res, 405, { error: 'Method not allowed' }, { Allow: Object.keys(route).join(', ') });
  return send(res, 200, await fn({ url, body: await readBody(req), store: getStore() }));
}

export async function handler(req, res) {
  try {
    const url = new URL(req.url || '/', 'http://relay.local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/mcp' || path === '/api/mcp') {
      if (!authorized(req, 'BOT_TOKEN', url)) return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      return await handleMcp(req, res, getStore(), await readBody(req), { app: appOf(url.searchParams.get('app')) });
    }
    // The cloud streamer is public (it holds no secret), so a setup script can fetch it.
    if (path === '/sync.cjs' || path === '/api/sync') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      return res.end(req.method === 'HEAD' ? undefined : syncScript());
    }
    const key = path.replace(/^\/api\//, '');
    if (path.startsWith('/api/') && BOT_ROUTES[key]) {
      if (!authorized(req, 'BOT_TOKEN')) return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      return await serve(res, BOT_ROUTES[key], req, url);
    }
    const route = ROUTES[key];
    if (!route || !path.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    if (!authorized(req, 'APP_TOKEN')) return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    return await serve(res, route, req, url);
  } catch (e) {
    const known = e instanceof HttpError || e instanceof CloudError;
    if (!known) console.error('relay:', e);
    return send(res, known ? e.status : 500, { error: known ? e.message : 'Internal error' });
  }
}

export default handler;
