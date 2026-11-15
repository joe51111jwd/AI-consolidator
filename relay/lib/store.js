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
// Cloud sessions (cloud/switchboard-sync.cjs streams each Claude Code session's transcript here):
// one row per session (who it is, its title, when it was last heard from, a change number the app
// pulls by) and the transcript lines of each of its files (the session and its sub-agents), kept
// in order with their index. A session nobody heard from in CLOUD_TTL_DAYS is dropped.
export const CLOUD_TTL_DAYS = 30;
const CLOUD_TTL_S = CLOUD_TTL_DAYS * 86400;
const MAX_CMDS = 50;
// What one ingest does to a file's lines, whatever the storage: `from` is the index of the first
// line sent. Lines the store already has are skipped; a batch that starts past the end (the store
// lost lines) adds nothing, and the reply's count tells the sender where to resume.
export function plan(have, { from = 0, lines = [], reset = false }) {
  if (reset && from === 0) return { drop: true, start: 0, add: lines, count: lines.length };
  if (from > have) return { drop: false, start: have, add: [], count: have };
  const add = lines.slice(have - from);
  return { drop: false, start: have, add, count: have + add.length };
}
const sessionMeta = (m) => {
  const out = {};
  for (const k of ['id', 'cloud', 'url', 'email', 'org', 'cliSessionId', 'entrypoint', 'environment', 'host', 'version', 'title', 'active']) if (m && m[k] !== undefined) out[k] = m[k];
  return out;
};

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
    ...memoryCloud(),
  };
}

function memoryCloud() {
  let seq = 0;
  const sessions = new Map(); // id -> { id, seq, ts, meta, files: Map(file -> [lines]) }
  const cmds = new Map();
  const counts = (s) => Object.fromEntries([...s.files].map(([f, l]) => [f, l.length]));
  return {
    async cloudIngest(meta, files, now = Date.now()) {
      const id = meta.id;
      let s = sessions.get(id);
      if (!s) { s = { id, seq: 0, ts: 0, meta: {}, files: new Map() }; sessions.set(id, s); }
      for (const f of files) {
        const have = (s.files.get(f.file) || []).length;
        const p = plan(have, f);
        const list = p.drop ? [] : s.files.get(f.file) || [];
        list.push(...p.add);
        s.files.set(f.file, list);
      }
      s.meta = { ...s.meta, ...sessionMeta(meta) };
      s.ts = now;
      s.seq = ++seq;
      const c = cmds.get(id) || [];
      cmds.delete(id);
      return { files: counts(s), commands: c };
    },
    async cloudState(id) { const s = sessions.get(id); return s ? counts(s) : {}; },
    async cloudChanges(since, recentSince, limit) {
      const rows = [...sessions.values()].filter((s) => s.seq > since || s.ts > recentSince).sort((a, b) => a.seq - b.seq).slice(0, limit);
      return { head: seq, sessions: rows.map((s) => ({ id: s.id, seq: s.seq, ts: s.ts, meta: s.meta, files: counts(s) })) };
    },
    async cloudLines(id, file, from, limit) { const s = sessions.get(id); return s ? (s.files.get(file) || []).slice(from, from + limit) : []; },
    async cloudPushCmd(id, cmd) { const l = cmds.get(id) || []; l.push(cmd); cmds.set(id, l.slice(-MAX_CMDS)); },
    async cloudForget(id) { sessions.delete(id); cmds.delete(id); },
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
    // Cloud sessions: sb:cloud:s:<id> (meta JSON), sb:cloud:f:<id> (file -> count),
    // sb:cloud:l:<id>:<file> (the lines, a list), sb:cloud:seq and the sorted set sb:cloud:ch
    // (session -> change number), sb:cloud:ts (session -> last heard from), sb:cloud:c:<id> (commands).
    async cloudIngest(meta, files, now = Date.now()) {
      const id = meta.id;
      const counts = await cmd('HGETALL', `sb:cloud:f:${id}`);
      const have = {};
      for (let i = 0; i + 1 < (counts || []).length; i += 2) have[counts[i]] = Number(counts[i + 1]) || 0;
      const ops = [];
      for (const f of files) {
        const p = plan(have[f.file] || 0, f);
        const lk = `sb:cloud:l:${id}:${f.file}`;
        if (p.drop) ops.push(['DEL', lk]);
        if (p.add.length) ops.push(['RPUSH', lk, ...p.add]);
        ops.push(['EXPIRE', lk, CLOUD_TTL_S]);
        have[f.file] = p.count;
        ops.push(['HSET', `sb:cloud:f:${id}`, f.file, p.count]);
      }
      const prev = parse(await cmd('GET', `sb:cloud:s:${id}`)) || {};
      const n = Number(await cmd('INCR', 'sb:cloud:seq'));
      ops.push(['SET', `sb:cloud:s:${id}`, JSON.stringify({ ...prev, ...sessionMeta(meta) }), 'EX', CLOUD_TTL_S], ['EXPIRE', `sb:cloud:f:${id}`, CLOUD_TTL_S],
        ['ZADD', 'sb:cloud:ch', n, id], ['ZADD', 'sb:cloud:ts', now, id], ['LRANGE', `sb:cloud:c:${id}`, 0, -1], ['DEL', `sb:cloud:c:${id}`]);
      const res = await multi(...ops);
      const commands = (res[res.length - 2] || []).map(parse).filter(Boolean);
      return { files: have, commands };
    },
    async cloudState(id) {
      const counts = await cmd('HGETALL', `sb:cloud:f:${id}`);
      const out = {};
      for (let i = 0; i + 1 < (counts || []).length; i += 2) out[counts[i]] = Number(counts[i + 1]) || 0;
      return out;
    },
    async cloudChanges(since, recentSince, limit) {
      const head = Number(await cmd('GET', 'sb:cloud:seq')) || 0;
      const changed = await cmd('ZRANGEBYSCORE', 'sb:cloud:ch', `(${since}`, '+inf', 'WITHSCORES', 'LIMIT', 0, limit);
      const recent = await cmd('ZRANGEBYSCORE', 'sb:cloud:ts', `(${recentSince}`, '+inf');
      const seqs = new Map();
      for (let i = 0; i + 1 < (changed || []).length; i += 2) seqs.set(changed[i], Number(changed[i + 1]));
      for (const id of recent || []) if (!seqs.has(id)) seqs.set(id, Number(await cmd('ZSCORE', 'sb:cloud:ch', id)) || 0);
      const out = [];
      for (const [id, n] of seqs) {
        const [m, ts] = await multi(['GET', `sb:cloud:s:${id}`], ['ZSCORE', 'sb:cloud:ts', id]);
        if (!m) continue;
        out.push({ id, seq: n, ts: Number(ts) || 0, meta: parse(m) || {}, files: await this.cloudState(id) });
      }
      return { head, sessions: out.sort((a, b) => a.seq - b.seq) };
    },
    async cloudLines(id, file, from, limit) { return (await cmd('LRANGE', `sb:cloud:l:${id}:${file}`, from, from + limit - 1)) || []; },
    async cloudPushCmd(id, c) {
      const k = `sb:cloud:c:${id}`;
      await multi(['RPUSH', k, JSON.stringify(c)], ['LTRIM', k, -MAX_CMDS, -1], ['EXPIRE', k, 3600]);
    },
    async cloudForget(id) {
      const files = Object.keys(await this.cloudState(id));
      await multi(...files.map((f) => ['DEL', `sb:cloud:l:${id}:${f}`]), ['DEL', `sb:cloud:f:${id}`, `sb:cloud:s:${id}`, `sb:cloud:c:${id}`], ['ZREM', 'sb:cloud:ch', id], ['ZREM', 'sb:cloud:ts', id]);
    },
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
    await query('CREATE SEQUENCE IF NOT EXISTS cloud_seq');
    await query('CREATE TABLE IF NOT EXISTS cloud_sessions (id text PRIMARY KEY, seq bigint NOT NULL, ts bigint NOT NULL, meta jsonb NOT NULL)');
    await query('CREATE INDEX IF NOT EXISTS cloud_sessions_seq ON cloud_sessions (seq)');
    await query('CREATE INDEX IF NOT EXISTS cloud_sessions_ts ON cloud_sessions (ts)');
    await query('CREATE TABLE IF NOT EXISTS cloud_files (session text NOT NULL, file text NOT NULL, count integer NOT NULL, PRIMARY KEY (session, file))');
    await query('CREATE TABLE IF NOT EXISTS cloud_lines (session text NOT NULL, file text NOT NULL, idx integer NOT NULL, line text NOT NULL, PRIMARY KEY (session, file, idx))');
    await query('CREATE TABLE IF NOT EXISTS cloud_cmds (id bigserial PRIMARY KEY, session text NOT NULL, ts bigint NOT NULL, data jsonb NOT NULL)');
    await query('CREATE INDEX IF NOT EXISTS cloud_cmds_session ON cloud_cmds (session, id)');
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
    async cloudIngest(meta, files, now = Date.now()) {
      const id = meta.id;
      const have = await this.cloudState(id);
      for (const f of files) {
        const p = plan(have[f.file] || 0, f);
        if (p.drop) await q('DELETE FROM cloud_lines WHERE session = $1 AND file = $2', [id, f.file]);
        if (p.add.length) {
          await q('INSERT INTO cloud_lines (session, file, idx, line) SELECT $1, $2, $3 + t.ord - 1, t.line FROM unnest($4::text[]) WITH ORDINALITY AS t(line, ord) ON CONFLICT DO NOTHING',
            [id, f.file, p.start, p.add]);
        }
        if (p.drop || p.add.length || have[f.file] === undefined) {
          await q('INSERT INTO cloud_files (session, file, count) VALUES ($1, $2, $3) ON CONFLICT (session, file) DO UPDATE SET count = EXCLUDED.count', [id, f.file, p.count]);
        }
        have[f.file] = p.count;
      }
      await q("INSERT INTO cloud_sessions (id, seq, ts, meta) VALUES ($1, nextval('cloud_seq'), $2, $3) ON CONFLICT (id) DO UPDATE SET seq = nextval('cloud_seq'), ts = EXCLUDED.ts, meta = cloud_sessions.meta || EXCLUDED.meta",
        [id, now, JSON.stringify(sessionMeta(meta))]);
      const cmds = await q('DELETE FROM cloud_cmds WHERE session = $1 RETURNING id, data', [id]);
      // Now and then, drop sessions nobody has heard from in a month.
      if (Math.random() < 0.01) await this.cloudPrune(now).catch(() => {});
      return { files: have, commands: cmds.sort((a, b) => Number(a.id) - Number(b.id)).map((r) => asJson(r.data)) };
    },
    async cloudState(id) {
      const rows = await q('SELECT file, count FROM cloud_files WHERE session = $1', [id]);
      return Object.fromEntries(rows.map((r) => [r.file, Number(r.count)]));
    },
    async cloudChanges(since, recentSince, limit) {
      const [h] = await q("SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS v FROM cloud_seq");
      const rows = await q(`SELECT s.id, s.seq, s.ts, s.meta, COALESCE((SELECT json_object_agg(f.file, f.count) FROM cloud_files f WHERE f.session = s.id), '{}'::json) AS files
        FROM cloud_sessions s WHERE s.seq > $1 OR s.ts > $2 ORDER BY s.seq LIMIT $3`, [since, recentSince, limit]);
      return { head: Number(h && h.v) || 0, sessions: rows.map((r) => ({ id: r.id, seq: Number(r.seq), ts: Number(r.ts), meta: asJson(r.meta), files: Object.fromEntries(Object.entries(asJson(r.files) || {}).map(([k, v]) => [k, Number(v)])) })) };
    },
    async cloudLines(id, file, from, limit) {
      const rows = await q('SELECT line FROM cloud_lines WHERE session = $1 AND file = $2 AND idx >= $3 ORDER BY idx LIMIT $4', [id, file, from, limit]);
      return rows.map((r) => r.line);
    },
    async cloudPushCmd(id, c) {
      await q('INSERT INTO cloud_cmds (session, ts, data) VALUES ($1, $2, $3)', [id, Date.now(), JSON.stringify(c)]);
      await q('DELETE FROM cloud_cmds WHERE ts < $1', [Date.now() - 3600000]);
    },
    async cloudForget(id) {
      await q('DELETE FROM cloud_lines WHERE session = $1', [id]);
      await q('DELETE FROM cloud_files WHERE session = $1', [id]);
      await q('DELETE FROM cloud_cmds WHERE session = $1', [id]);
      await q('DELETE FROM cloud_sessions WHERE id = $1', [id]);
    },
    async cloudPrune(now = Date.now()) {
      const old = await q('SELECT id FROM cloud_sessions WHERE ts < $1', [now - CLOUD_TTL_S * 1000]);
      for (const r of old) await this.cloudForget(r.id);
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
