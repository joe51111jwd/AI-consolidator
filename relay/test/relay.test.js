// node --test (from relay/). Runs the relay on a local port with in-memory storage and talks to it
// the way Grok Bot (an MCP client) and the Switchboard app (plain HTTP) do.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handler, setStore } from '../lib/app.js';
import { memoryStore, upstashStore } from '../lib/store.js';
import { botKey } from '../lib/util.js';

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
const events = async (since = 0) => (await appApi('GET', `/api/events?since=${since}`)).body;

async function bot(token = 'bot-secret') {
  const client = new Client({ name: 'fake-grok-bot', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
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
  assert.equal((await appApi('POST', '/api/tasks', { bot: 'x', text: 'y' }, 'wrong')).status, 401);
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
  await call('report_status', { bot: 'Marketing', status: 'working', doing: 'Drafting the spring promo', client: 'Harbor Coffee' });
  await call('log_action', { bot: 'Marketing', kind: 'browser', text: 'Opened the pricing page' });
  await call('log_subagent', { bot: 'Marketing', id: 'run-1', title: 'Fix the footer', status: 'running', kind: 'claude-cli', lastText: 'Editing footer.tsx', prUrl: 'https://github.com/o/r/pull/1' });
  await call('post_output', { bot: 'Marketing', title: 'Promo plan', content: '# Plan\n- Week 1', url: 'javascript:alert(1)' });
  await call('add_to_brain', { bot: 'Marketing', text: 'Harbor wants Friday delivery' });
  const { events: ev, cursor } = await events();
  assert.deepEqual(ev.map((e) => e.type), ['status', 'action', 'subagent', 'output', 'brain']);
  assert.equal(cursor, 5);
  assert.ok(ev.every((e) => e.bot === 'Marketing' && e.ts > 0 && e.id > 0));
  assert.deepEqual([ev[0].status, ev[0].doing, ev[0].client], ['working', 'Drafting the spring promo', 'Harbor Coffee']);
  assert.deepEqual([ev[1].kind, ev[1].text], ['browser', 'Opened the pricing page']);
  assert.deepEqual(ev[2].sub, { id: 'run-1', title: 'Fix the footer', status: 'running', kind: 'claude-cli', lastText: 'Editing footer.tsx', prUrl: 'https://github.com/o/r/pull/1' });
  assert.equal(ev[3].title, 'Promo plan');
  assert.equal(ev[3].url, undefined, 'only http(s) links are kept');
  assert.equal(ev[4].text, 'Harbor wants Friday delivery');
  await client.close();
});

test('invalid tool input is refused', async () => {
  const { client } = await bot();
  const r = await client.callTool({ name: 'report_status', arguments: { bot: 'Marketing', status: 'sleeping' } }).catch((e) => ({ isError: true, e }));
  assert.ok(r.isError);
  assert.equal((await events()).events.length, 0);
  await client.close();
});

test('a queued task is delivered once, by bot name', async () => {
  const q = await appApi('POST', '/api/tasks', { bot: 'Marketing', botId: 'bot_mkt', text: 'Check the Fieldline repo for open PRs' });
  assert.equal(q.status, 200);
  assert.ok(q.body.task.id);
  assert.equal((await appApi('POST', '/api/tasks', { bot: 'Marketing' })).status, 400, 'text is required');
  const { client, call } = await bot();
  assert.match(await call('get_tasks', { bot: 'Calendar' }), /No new messages/, 'other bots get nothing');
  const got = await call('get_tasks', { bot: '  marketing ' });
  assert.match(got, /One message from the user/);
  assert.match(got, /Check the Fieldline repo for open PRs/);
  assert.match(await call('get_tasks', { bot: 'Marketing' }), /No new messages/, 'delivered only once');
  const d = (await events()).events.find((e) => e.type === 'delivered');
  assert.ok(d && d.bot === 'marketing' && d.tasks.length === 1 && /Fieldline/.test(d.tasks[0].text), 'the app learns it was picked up');
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
  for (let i = 1; i <= 5; i++) await call('log_action', { bot: 'Calendar', kind: 'note', text: `step ${i}` });
  const first = await events(0);
  assert.equal(first.events.length, 5);
  assert.equal((await events(first.cursor)).events.length, 0, 'nothing new after the cursor');
  await call('log_action', { bot: 'Calendar', kind: 'note', text: 'step 6' });
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
  for (let i = 0; i < 3; i++) await s.addEvent({ type: 'action', bot: 'B', kind: 'note', text: `${i}`, ts: Date.now() });
  const r = await events(0);
  assert.deepEqual([r.events.length, r.cursor], [1, 1]);
});

test('bot keys ignore case and punctuation', () => {
  assert.equal(botKey(' Marketing Bot! '), 'marketing-bot');
  assert.equal(botKey('Café 2'), 'café-2');
  assert.equal(botKey('***'), 'bot');
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
  await call('report_status', { bot: 'Marketing', status: 'idle' });
  await call('log_action', { bot: 'Marketing', kind: 'email', text: 'Sent the invoice' });
  const r = await events(0);
  assert.deepEqual(r.events.map((e) => e.type), ['status', 'action']);
  assert.equal((await events(r.cursor)).events.length, 0);
  await appApi('POST', '/api/tasks', { bot: 'Marketing', text: 'Ship it' });
  assert.match(await call('get_tasks', { bot: 'Marketing' }), /Ship it/);
  assert.match(await call('get_tasks', { bot: 'Marketing' }), /No new messages/);
  await appApi('POST', '/api/board', { summary: 'Board summary' });
  assert.match(await call('read_board'), /Board summary/);
  assert.equal((await appApi('GET', '/api/health')).body.storage, 'upstash');
  assert.ok(calls.some((c) => Array.isArray(c[0]) && c[0][0] === 'ZADD'), 'events written in a transaction');
  await client.close();
});
