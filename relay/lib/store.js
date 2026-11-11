// Storage for the relay. Upstash Redis over its REST API when configured (the Vercel Marketplace
// integration sets KV_REST_API_URL/TOKEN, a direct Upstash database UPSTASH_REDIS_REST_URL/TOKEN),
// then Postgres (Neon via the Marketplace sets DATABASE_URL/POSTGRES_URL), otherwise memory, which
// is for tests and local runs: it is lost whenever the function restarts.
//
// Events carry an increasing id (the cursor the app pulls from). Only the newest MAX_EVENTS are
// kept, and nothing older than TTL_DAYS is returned.
export const MAX_EVENTS = 5000;
export const TTL_DAYS = 14;
const TTL_S = TTL_DAYS * 86400;
const MAX_TASKS = 200;

export function memoryStore() {
  let seq = 0;
  let events = [];
  const tasks = new Map();
  let board = null;
  return {
    kind: 'memory',
    async addEvent(ev) {
      const e = { ...ev, id: ++seq };
      events.push(e);
      if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
      return e;
    },
    async head() { return seq; },
    async eventsAfter(cursor, limit) { return events.filter((e) => e.id > cursor).slice(0, limit); },
    async pushTask(key, task) { const l = tasks.get(key) || []; l.push(task); tasks.set(key, l.slice(-MAX_TASKS)); },
    async takeTasks(key) { const l = tasks.get(key) || []; tasks.delete(key); return l; },
    async setBoard(b) { board = b; },
    async getBoard() { return board; },
  };
}

export function upstashStore(url, token, fetchImpl = globalThis.fetch) {
  const base = url.replace(/\/+$/, '');
  async function post(path, body) {
    const r = await fetchImpl(base + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (!r.ok || j == null) throw new Error(`Upstash ${r.status}${j && j.error ? `: ${j.error}` : ''}`);
    return j;
  }
  const cmd = async (...args) => { const j = await post('', args); if (j.error) throw new Error(j.error); return j.result; };
  const multi = async (...cmds) => (await post('/multi-exec', cmds)).map((x) => { if (x.error) throw new Error(x.error); return x.result; });
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  return {
    kind: 'upstash',
    async addEvent(ev) {
      // The counter never expires: the app's cursor must keep pointing into the same sequence.
      const id = Number(await cmd('INCR', 'sb:seq'));
      const e = { ...ev, id };
      await multi(['ZADD', 'sb:events', id, JSON.stringify(e)], ['ZREMRANGEBYRANK', 'sb:events', 0, -(MAX_EVENTS + 1)], ['EXPIRE', 'sb:events', TTL_S]);
      return e;
    },
    async head() { return Number(await cmd('GET', 'sb:seq')) || 0; },
    async eventsAfter(cursor, limit) {
      const rows = await cmd('ZRANGEBYSCORE', 'sb:events', `(${cursor}`, '+inf', 'LIMIT', 0, limit);
      return (rows || []).map(parse).filter(Boolean);
    },
    async pushTask(key, task) {
      const k = `sb:tasks:${key}`;
      await multi(['RPUSH', k, JSON.stringify(task)], ['LTRIM', k, -MAX_TASKS, -1], ['EXPIRE', k, TTL_S]);
    },
    async takeTasks(key) {
      const k = `sb:tasks:${key}`;
      const [rows] = await multi(['LRANGE', k, 0, -1], ['DEL', k]);
      return (rows || []).map(parse).filter(Boolean);
    },
    async setBoard(b) { await cmd('SET', 'sb:board', JSON.stringify(b), 'EX', TTL_S); },
    async getBoard() { const s = await cmd('GET', 'sb:board'); return s ? parse(s) : null; },
  };
}

// query(text, params) resolves to the result rows. By default it is Neon's HTTP driver, loaded only
// when Postgres is actually used so other backends never need it.
export function postgresStore(url, query = neonQuery(url)) {
  const cutoff = () => Date.now() - TTL_S * 1000;
  let ready = null;
  const init = () => (ready ||= (async () => {
    await query('CREATE TABLE IF NOT EXISTS events (id bigserial PRIMARY KEY, ts bigint NOT NULL, data jsonb NOT NULL)');
    await query('CREATE TABLE IF NOT EXISTS tasks (id bigserial PRIMARY KEY, key text NOT NULL, ts bigint NOT NULL, data jsonb NOT NULL)');
    await query('CREATE INDEX IF NOT EXISTS tasks_key ON tasks (key, id)');
    await query('CREATE TABLE IF NOT EXISTS kv (key text PRIMARY KEY, ts bigint NOT NULL, value jsonb)');
  })().catch((e) => { ready = null; throw e; }));
  const q = async (text, params = []) => { await init(); return query(text, params); };
  return {
    kind: 'postgres',
    async addEvent(ev) {
      const [row] = await q('INSERT INTO events (ts, data) VALUES ($1, $2) RETURNING id', [Date.now(), JSON.stringify(ev)]);
      const id = Number(row.id);
      await q('DELETE FROM events WHERE id <= $1 OR ts < $2', [id - MAX_EVENTS, cutoff()]);
      return { ...ev, id };
    },
    // The sequence, not max(id): the app's cursor must keep pointing into the same sequence after pruning.
    async head() {
      const [row] = await q("SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS v FROM events_id_seq");
      return Number(row && row.v) || 0;
    },
    async eventsAfter(cursor, limit) {
      const rows = await q('SELECT id, data FROM events WHERE id > $1 AND ts >= $2 ORDER BY id LIMIT $3', [cursor, cutoff(), limit]);
      return rows.map((r) => ({ ...asJson(r.data), id: Number(r.id) }));
    },
    async pushTask(key, task) {
      await q('INSERT INTO tasks (key, ts, data) VALUES ($1, $2, $3)', [key, Date.now(), JSON.stringify(task)]);
      await q('DELETE FROM tasks WHERE key = $1 AND (ts < $2 OR id NOT IN (SELECT id FROM tasks WHERE key = $1 ORDER BY id DESC LIMIT $3))', [key, cutoff(), MAX_TASKS]);
    },
    async takeTasks(key) {
      const rows = await q('DELETE FROM tasks WHERE key = $1 RETURNING id, ts, data', [key]);
      return rows.filter((r) => Number(r.ts) >= cutoff()).sort((a, b) => Number(a.id) - Number(b.id)).map((r) => asJson(r.data));
    },
    async setBoard(b) {
      await q('INSERT INTO kv (key, ts, value) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET ts = EXCLUDED.ts, value = EXCLUDED.value', ['board', Date.now(), JSON.stringify(b)]);
    },
    async getBoard() {
      const [row] = await q('SELECT value FROM kv WHERE key = $1 AND ts >= $2', ['board', cutoff()]);
      return row ? asJson(row.value) : null;
    },
  };
}

const asJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

function neonQuery(url) {
  let sql = null;
  return async (text, params) => {
    if (!sql) { const { neon } = await import('@neondatabase/serverless'); sql = neon(url); }
    return sql.query(text, params);
  };
}

export function storeFromEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return upstashStore(url, token);
  const pg = env.DATABASE_URL || env.POSTGRES_URL;
  return pg ? postgresStore(pg) : memoryStore();
}
