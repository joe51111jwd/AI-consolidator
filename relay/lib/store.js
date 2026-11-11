// Storage for the relay. Upstash Redis over its REST API when configured (the Vercel Marketplace
// integration sets KV_REST_API_URL/TOKEN, a direct Upstash database UPSTASH_REDIS_REST_URL/TOKEN),
// otherwise memory, which is for tests and local runs: it is lost whenever the function restarts.
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

export function storeFromEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? upstashStore(url, token) : memoryStore();
}
