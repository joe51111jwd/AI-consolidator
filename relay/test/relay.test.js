// node --test (from relay/). Runs the relay on a local port with in-memory storage and talks to it
// the way Grok Bot (an MCP client) and the Switchboard app (plain HTTP) do.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handler, setStore } from '../lib/app.js';
import { memoryStore, upstashStore, postgresStore, storeFromEnv } from '../lib/store.js';
import { agentKey } from '../lib/util.js';

process.env.BOT_TOKEN = 'bot-secret';
process.env.APP_TOKEN = 'app-secret';
let server, base;

before(async () => {
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));
beforeEach(() => setStore(memoryStore()));

const appApi = async (method, path, body, token = 'app-secret') => {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
// The agents' own events; `all` also has the "connected" event each MCP client's initialize leaves.
const events = async (since = 0) => {
  const b = (await appApi('GET', `/api/events?since=${since}`)).body;
  return { ...b, all: b.events, events: b.events.filter((e) => e.type !== 'connected') };
};

// A fake agent: a real MCP client. By default a Grok bot sending its token in a header; `path` and
// `header: false` connect the way Claude's connectors do (app and key in the address).
async function bot(token = 'bot-secret', { path = '/mcp?app=grok-bot', header = true } = {}) {
  const client = new Client({ name: 'fake-agent', version: '1.0.0' });
  const headers = header ? { Authorization: `Bearer ${token}` } : {};
  await client.connect(new StreamableHTTPClientTransport(new URL(base + path), { requestInit: { headers } }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name} failed: ${JSON.stringify(r.content)}`);
    return r.content.map((c) => c.text).join('\n');
  };
  return { client, call };
}

test('rejects missing or wrong tokens with 401', async () => {
  const mcp = (headers) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.equal((await mcp({})).status, 401);
  assert.equal((await mcp({ Authorization: 'Bearer nope' })).status, 401);
  assert.equal((await mcp({ Authorization: 'Bearer app-secret' })).status, 401, 'the app token does not open the bot connector');
  assert.equal((await fetch(`${base}/api/events`)).status, 401);
  assert.equal((await appApi('GET', '/api/events', null, 'bot-secret')).status, 401, 'the bot token does not open the app API');
  assert.equal((await appApi('POST', '/api/tasks', { agent: 'x', text: 'y' }, 'wrong')).status, 401);
  await assert.rejects(() => bot('wrong'), 'an MCP client with the wrong token cannot connect');
  delete process.env.APP_TOKEN;
  try { assert.equal((await appApi('GET', '/api/health')).status, 401, 'an unset token never matches'); } finally { process.env.APP_TOKEN = 'app-secret'; }
});

test('health reports storage and warns about memory storage', async () => {
  const r = await appApi('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.storage, 'memory');
  assert.ok(r.body.warnings.some((w) => /memory/.test(w)));
  assert.equal((await appApi('POST', '/api/health')).status, 405);
  assert.equal((await appApi('GET', '/api/nope')).status, 404);
});

test('lists the tools with instructions to report on their own', async () => {
  const { client } = await bot();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['add_to_brain', 'get_tasks', 'log_action', 'log_subagent', 'post_output', 'read_board', 'report_status']);
  assert.match(client.getInstructions(), /without being asked/);
  await client.close();
});

test('GET and DELETE on /mcp answer 405 (stateless)', async () => {
  for (const method of ['GET', 'DELETE']) {
    const r = await fetch(`${base}/mcp`, { method, headers: { Authorization: 'Bearer bot-secret' } });
    assert.equal(r.status, 405);
  }
});

test('report_status, log_action, log_subagent, post_output and add_to_brain become events', async () => {
  const { client, call } = await bot();
  await call('report_status', { agent: 'Marketing', status: 'working', doing: 'Drafting the spring promo', client: 'Harbor Coffee' });
  await call('log_action', { agent: 'Marketing', kind: 'browser', text: 'Opened the pricing page' });
  await call('log_subagent', { agent: 'Marketing', id: 'run-1', title: 'Fix the footer', status: 'running', kind: 'claude-cli', lastText: 'Editing footer.tsx', prUrl: 'https://github.com/o/r/pull/1' });
  await call('post_output', { agent: 'Marketing', title: 'Promo plan', content: '# Plan\n- Week 1', url: 'javascript:alert(1)' });
  await call('add_to_brain', { agent: 'Marketing', text: 'Harbor wants Friday delivery' });
  const { events: ev, cursor } = await events();
  assert.deepEqual(ev.map((e) => e.type), ['status', 'action', 'subagent', 'output', 'brain']);
  assert.equal(cursor, 6, 'after the connected event');
  assert.ok(ev.every((e) => e.agent === 'Marketing' && e.app === 'grok-bot' && e.ts > 0 && e.id > 0));
  assert.deepEqual([ev[0].status, ev[0].doing, ev[0].client], ['working', 'Drafting the spring promo', 'Harbor Coffee']);
  assert.deepEqual([ev[1].kind, ev[1].text], ['browser', 'Opened the pricing page']);
  assert.deepEqual(ev[2].sub, { id: 'run-1', title: 'Fix the footer', status: 'running', kind: 'claude-cli', lastText: 'Editing footer.tsx', prUrl: 'https://github.com/o/r/pull/1' });
  assert.equal(ev[3].title, 'Promo plan');
  assert.equal(ev[3].url, undefined, 'only http(s) links are kept');
  assert.equal(ev[4].text, 'Harbor wants Friday delivery');
  await client.close();
});

test('an app adding the connector is recorded once per connect, under the app in its address', async () => {
  const grok = await bot();
  const claude = await bot('bot-secret', { path: '/mcp?app=claude&key=bot-secret', header: false });
  await grok.client.listTools();
  const hello = (await events()).all.filter((e) => e.type === 'connected');
  assert.deepEqual(hello.map((e) => [e.app, e.agent]), [['grok-bot', 'fake-agent'], ['claude', 'fake-agent']], 'initialize only, not every request');
  await grok.client.close(); await claude.client.close();
});

test('invalid tool input is refused', async () => {
  const { client } = await bot();
  const r = await client.callTool({ name: 'report_status', arguments: { agent: 'Marketing', status: 'sleeping' } }).catch((e) => ({ isError: true, e }));
  assert.ok(r.isError);
  assert.equal((await events()).events.length, 0);
  await client.close();
});

test('a queued task is delivered once, by bot name', async () => {
  const q = await appApi('POST', '/api/tasks', { agent: 'Marketing', app: 'grok-bot', agentId: 'bot_mkt', text: 'Check the Fieldline repo for open PRs' });
  assert.equal(q.status, 200);
  assert.ok(q.body.task.id);
  assert.equal((await appApi('POST', '/api/tasks', { agent: 'Marketing' })).status, 400, 'text is required');
  const { client, call } = await bot();
  assert.match(await call('get_tasks', { agent: 'Calendar' }), /No new messages/, 'other bots get nothing');
  const got = await call('get_tasks', { agent: '  marketing ' });
  assert.match(got, /One message from the user/);
  assert.match(got, /Check the Fieldline repo for open PRs/);
  assert.match(await call('get_tasks', { agent: 'Marketing' }), /No new messages/, 'delivered only once');
  const d = (await events()).events.find((e) => e.type === 'delivered');
  assert.ok(d && d.agent === 'marketing' && d.app === 'grok-bot' && d.tasks.length === 1 && /Fieldline/.test(d.tasks[0].text), 'the app learns it was picked up');
  await client.close();
});

test('read_board returns the summary the app uploaded', async () => {
  const { client, call } = await bot();
  assert.match(await call('read_board'), /not shared/);
  assert.equal((await appApi('POST', '/api/board', { summary: '- Harbor site (Claude): fixing the menu page' })).status, 200);
  assert.match(await call('read_board'), /Harbor site \(Claude\): fixing the menu page/);
  await client.close();
});

test('events are cursored, paged and restart after a storage reset', async () => {
  const { client, call } = await bot();
  for (let i = 1; i <= 5; i++) await call('log_action', { agent: 'Calendar', kind: 'note', text: `step ${i}` });
  const first = await events(0);
  assert.equal(first.events.length, 5);
  assert.equal((await events(first.cursor)).events.length, 0, 'nothing new after the cursor');
  await call('log_action', { agent: 'Calendar', kind: 'note', text: 'step 6' });
  const next = await events(first.cursor);
  assert.deepEqual(next.events.map((e) => e.text), ['step 6']);
  assert.equal(next.cursor, first.cursor + 1);
  const page = (await appApi('GET', '/api/events?since=0&limit=2')).body;
  assert.deepEqual([page.events.length, page.cursor, page.more], [2, 2, true]);
  const reset = await events(9999);
  assert.equal(reset.events.length, 6, 'a cursor past the end starts over');
  await client.close();
});

test('events stop at a fresh gap so an in-flight write is not skipped', async () => {
  const s = memoryStore();
  setStore({ ...s, async eventsAfter(c, l) { return (await s.eventsAfter(c, l)).filter((e) => e.id !== 2); } });
  for (let i = 0; i < 3; i++) await s.addEvent({ type: 'action', agent: 'B', kind: 'note', text: `${i}`, ts: Date.now() });
  const r = await events(0);
  assert.deepEqual([r.events.length, r.cursor], [1, 1]);
});

test('agent keys ignore case and punctuation', () => {
  assert.equal(agentKey(' Marketing Bot! '), 'marketing-bot');
  assert.equal(agentKey('Café 2'), 'café-2');
  assert.equal(agentKey('***'), 'agent');
});

test('clients without headers (Claude connectors) pass the token as ?key=, and the address names the app', async () => {
  const mcp = (path) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.equal((await mcp('/mcp?app=claude&key=nope')).status, 401);
  assert.equal((await mcp('/mcp?app=claude&key=app-secret')).status, 401, 'the app token does not work as a key');
  assert.equal((await fetch(`${base}/api/events?key=app-secret`)).status, 401, 'the app API takes no key in the address');
  const { client, call } = await bot('bot-secret', { path: '/mcp?app=claude&key=bot-secret', header: false });
  await call('report_status', { agent: 'Launch planning', status: 'working', doing: 'Outlining the launch', app: 'cursor' });
  const e = (await events()).events[0];
  assert.deepEqual([e.agent, e.app], ['Launch planning', 'claude'], 'the address wins over what the model says');
  await client.close();
  const other = await bot('bot-secret', { path: '/mcp' });
  await other.call('log_action', { agent: 'Helper', kind: 'note', text: 'hi', app: 'codex' });
  await other.call('log_action', { agent: 'Helper', kind: 'note', text: 'hi' });
  assert.deepEqual((await events()).events.slice(1).map((x) => x.app), ['codex', 'other'], 'without one in the address, the call names the app or it is "other"');
  await other.client.close();
});

test('report_status carries the project (a Claude Project) into the event, and it is optional', async () => {
  const claude = await bot('bot-secret', { path: '/mcp?app=claude&key=bot-secret', header: false });
  const schema = (await claude.client.listTools()).tools.find((t) => t.name === 'report_status').inputSchema;
  assert.equal(schema.properties.project.type, 'string');
  assert.ok(!(schema.required || []).includes('project'), 'project is optional');
  assert.match(schema.properties.project.description, /Claude Project/);
  assert.match(claude.client.getInstructions(), /Claude Project/, 'the server tells agents to report their Project');
  assert.match(claude.client.getInstructions(), /You are a chat in the Claude app/, 'a Claude connector gets the Claude note');
  await claude.call('report_status', { agent: 'Menu ideas', status: 'working', doing: 'Drafting the spring menu', project: '  Harbor Coffee Launch  ' });
  await claude.call('report_status', { agent: 'Menu ideas', status: 'idle' });
  await claude.call('report_status', { agent: 'Long one', status: 'idle', project: 'x'.repeat(300) });
  const ev = (await events()).events;
  assert.deepEqual([ev[0].app, ev[0].agent, ev[0].project], ['claude', 'Menu ideas', 'Harbor Coffee Launch'], 'trimmed and stored with the event');
  assert.equal(ev[1].project, undefined, 'left out when the chat is not in a Project');
  assert.equal(ev[2].project.length, 120, 'clipped');
  await claude.client.close();
  const grokBot = await bot();
  assert.doesNotMatch(grokBot.client.getInstructions(), /You are a chat in the Claude app/, 'other apps do not get the Claude note');
  await grokBot.client.close();
});

test('the project survives the Postgres and Upstash stores', async () => {
  const { fetchImpl } = fakeUpstash();
  setStore(upstashStore('https://kv.example.com/', 'kv-token', fetchImpl));
  const claude = await bot('bot-secret', { path: '/mcp?app=claude&key=bot-secret', header: false });
  await claude.call('report_status', { agent: 'Menu ideas', status: 'working', project: 'Harbor Coffee Launch' });
  assert.equal((await events()).events[0].project, 'Harbor Coffee Launch');
  await claude.client.close();
  const rows = [];
  const query = async (text, params) => {
    if (text.startsWith('INSERT INTO events')) { rows.push({ id: String(rows.length + 1), data: params[1] }); return [{ id: String(rows.length) }]; }
    if (text.startsWith('SELECT id, data FROM events')) return rows;
    return [];
  };
  const pg = postgresStore('postgres://x', query);
  await pg.addEvent({ type: 'status', agent: 'Menu ideas', app: 'claude', project: 'Harbor Coffee Launch' });
  assert.equal((await pg.eventsAfter(0, 10))[0].project, 'Harbor Coffee Launch');
});

test('tasks are kept apart per app', async () => {
  await appApi('POST', '/api/tasks', { agent: 'Research', app: 'claude', text: 'For the Claude chat' });
  await appApi('POST', '/api/tasks', { agent: 'Research', app: 'grok-bot', text: 'For the Grok bot' });
  const grokBot = await bot();
  assert.match(await grokBot.call('get_tasks', { agent: 'Research' }), /For the Grok bot/);
  assert.match(await grokBot.call('get_tasks', { agent: 'Research' }), /No new messages/);
  const claude = await bot('bot-secret', { path: '/mcp?app=claude&key=bot-secret', header: false });
  assert.match(await claude.call('get_tasks', { agent: 'Research' }), /For the Claude chat/);
  await grokBot.client.close(); await claude.client.close();
});

// A stand-in for Upstash's REST API (single commands and /multi-exec), enough to check the commands
// the Redis store sends.
function fakeUpstash() {
  const kv = new Map();
  const zset = (k) => kv.get(k) || [];
  const list = (k) => kv.get(k) || [];
  const run = ([c, ...a]) => {
    switch (c.toUpperCase()) {
      case 'INCR': { const v = (Number(kv.get(a[0])) || 0) + 1; kv.set(a[0], String(v)); return v; }
      case 'GET': return kv.get(a[0]) ?? null;
      case 'SET': kv.set(a[0], a[1]); return 'OK';
      case 'EXPIRE': return 1;
      case 'DEL': return kv.delete(a[0]) ? 1 : 0;
      case 'ZADD': kv.set(a[0], [...zset(a[0]), [Number(a[1]), a[2]]].sort((x, y) => x[0] - y[0])); return 1;
      case 'ZREMRANGEBYRANK': { const z = zset(a[0]); const stop = a[2] < 0 ? z.length + a[2] : a[2]; kv.set(a[0], z.filter((_, i) => i < a[1] || i > stop)); return 0; }
      case 'ZRANGEBYSCORE': { const min = Number(String(a[1]).replace('(', '')); return zset(a[0]).filter(([s]) => s > min).slice(a[4], a[4] + a[5]).map(([, m]) => m); }
      case 'RPUSH': kv.set(a[0], [...list(a[0]), a[1]]); return list(a[0]).length;
      case 'LTRIM': kv.set(a[0], list(a[0]).slice(a[1])); return 'OK';
      case 'LRANGE': return list(a[0]).slice(a[1], a[2] === -1 ? undefined : a[2] + 1);
      default: throw new Error(`unsupported ${c}`);
    }
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer kv-token');
    const body = JSON.parse(init.body);
    calls.push(body);
    const out = url.endsWith('/multi-exec') ? body.map((cmd) => ({ result: run(cmd) })) : { result: run(body) };
    return { ok: true, status: 200, json: async () => out };
  };
  return { fetchImpl, calls };
}

test('the Upstash store keeps events, tasks and the board through Redis commands', async () => {
  const { fetchImpl, calls } = fakeUpstash();
  setStore(upstashStore('https://kv.example.com/', 'kv-token', fetchImpl));
  const { client, call } = await bot();
  await call('report_status', { agent: 'Marketing', status: 'idle' });
  await call('log_action', { agent: 'Marketing', kind: 'email', text: 'Sent the invoice' });
  const r = await events(0);
  assert.deepEqual(r.events.map((e) => e.type), ['status', 'action']);
  assert.equal((await events(r.cursor)).events.length, 0);
  await appApi('POST', '/api/tasks', { agent: 'Marketing', app: 'grok-bot', text: 'Ship it' });
  assert.match(await call('get_tasks', { agent: 'Marketing' }), /Ship it/);
  assert.match(await call('get_tasks', { agent: 'Marketing' }), /No new messages/);
  await appApi('POST', '/api/board', { summary: 'Board summary' });
  assert.match(await call('read_board'), /Board summary/);
  assert.equal((await appApi('GET', '/api/health')).body.storage, 'upstash');
  assert.ok(calls.some((c) => Array.isArray(c[0]) && c[0][0] === 'ZADD'), 'events written in a transaction');
  await client.close();
});

test('storage is picked from the environment: Upstash, then Postgres, then memory', () => {
  const kv = { KV_REST_API_URL: 'https://kv.example.com', KV_REST_API_TOKEN: 't' };
  const pg = 'postgres://u:p@db.example.com/x';
  assert.equal(storeFromEnv({ ...kv, DATABASE_URL: pg }).kind, 'upstash');
  assert.equal(storeFromEnv({ DATABASE_URL: pg }).kind, 'postgres');
  assert.equal(storeFromEnv({ POSTGRES_URL: pg }).kind, 'postgres');
  assert.equal(storeFromEnv({ KV_REST_API_URL: 'https://kv.example.com' }).kind, 'memory');
  assert.equal(storeFromEnv({}).kind, 'memory');
});

test('the Postgres store creates its tables once and maps rows back to events', async () => {
  const sent = [];
  const query = async (text, params) => {
    sent.push(text);
    if (text.startsWith('INSERT INTO events')) return [{ id: '7' }];
    if (text.startsWith('SELECT id, data FROM events')) return [{ id: '7', data: { type: 'action', text: 'hi' } }];
    if (text.startsWith('DELETE FROM tasks WHERE key = $1 RETURNING')) return [{ id: '2', ts: String(Date.now()), data: { text: 'b' } }, { id: '1', ts: String(Date.now()), data: { text: 'a' } }];
    if (text.includes('events_id_seq')) return [{ v: '7' }];
    return [];
  };
  const s = postgresStore('postgres://x', query);
  assert.equal(s.kind, 'postgres');
  assert.deepEqual(await s.addEvent({ type: 'action', text: 'hi' }), { type: 'action', text: 'hi', id: 7 });
  assert.deepEqual(await s.eventsAfter(0, 10), [{ type: 'action', text: 'hi', id: 7 }]);
  assert.equal(await s.head(), 7);
  assert.deepEqual((await s.takeTasks('k')).map((t) => t.text), ['a', 'b']);
  assert.equal(sent.filter((t) => t.startsWith('CREATE TABLE')).length, 3);
});
