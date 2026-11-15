// node --test (from relay/). Cloud sessions: the streamer (cloud/switchboard-sync.cjs) sending a
// Claude Code session's transcript to the relay, and the app pulling it back.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { handler, setStore } from '../lib/app.js';
import { memoryStore, postgresStore, plan } from '../lib/store.js';

const require = createRequire(import.meta.url);
const SYNC = fileURLToPath(new URL('../cloud/switchboard-sync.cjs', import.meta.url));
const { slim } = require(SYNC);

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

const api = async (method, p, body, token = 'app-secret', headers = {}) => {
  const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const bot = (method, p, body) => api(method, p, body, 'bot-secret');
const line = (o) => JSON.stringify(o);
const SID = 'session_01TestCloudSession';
const MAIN = '-home-user-repo/abc.jsonl';
const SUB = '-home-user-repo/abc/subagents/agent-1.jsonl';

test('plan: overlapping batches are de-duplicated, a batch past the end adds nothing, reset starts over', () => {
  assert.deepEqual(plan(0, { from: 0, lines: ['a', 'b'] }), { drop: false, start: 0, add: ['a', 'b'], count: 2 });
  assert.deepEqual(plan(2, { from: 1, lines: ['b', 'c'] }), { drop: false, start: 2, add: ['c'], count: 3 });
  assert.deepEqual(plan(3, { from: 5, lines: ['f'] }), { drop: false, start: 3, add: [], count: 3 });
  assert.deepEqual(plan(3, { from: 0, lines: ['x'], reset: true }), { drop: true, start: 0, add: ['x'], count: 1 });
});

test('a session streams in and the app pulls it: changes, pull, state, and only the new lines', async () => {
  let r = await bot('POST', '/api/cloud/ingest', { session: { id: SID, cloud: true, url: `https://claude.ai/code/${SID}`, email: 'me@example.com', title: 'Fix the build' }, files: [{ file: MAIN, from: 0, lines: ['1', '2'] }, { file: SUB, from: 0, lines: ['s1'] }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.files, { [MAIN]: 2, [SUB]: 1 });

  // The same lines again (a retry) and one more: only the new one is added.
  r = await bot('POST', '/api/cloud/ingest', { session: { id: SID }, files: [{ file: MAIN, from: 1, lines: ['2', '3'] }] });
  assert.equal(r.body.files[MAIN], 3);

  // A batch that starts past what the relay has (it lost lines) adds nothing and says where to resume.
  r = await bot('POST', '/api/cloud/ingest', { session: { id: SID }, files: [{ file: MAIN, from: 9, lines: ['x'] }] });
  assert.equal(r.body.files[MAIN], 3);

  r = await bot('GET', `/api/cloud/state?session=${SID}`);
  assert.deepEqual(r.body.files, { [MAIN]: 3, [SUB]: 1 });

  r = await api('GET', '/api/cloud/changes?since=0');
  assert.equal(r.status, 200);
  assert.equal(r.body.sessions.length, 1);
  const s = r.body.sessions[0];
  assert.equal(s.id, SID);
  assert.equal(s.meta.title, 'Fix the build');
  assert.equal(s.meta.email, 'me@example.com');
  assert.equal(s.meta.url, `https://claude.ai/code/${SID}`);
  assert.deepEqual(s.files, { [MAIN]: 3, [SUB]: 1 });
  assert.ok(r.body.cursor >= s.seq);

  r = await api('POST', '/api/cloud/pull', { want: [{ session: SID, file: MAIN, from: 1 }, { session: SID, file: SUB, from: 0 }] });
  assert.deepEqual(r.body.got.map((g) => g.lines), [['2', '3'], ['s1']]);

  // Nothing changed since the cursor (and the session isn't "recent" any more): an empty list.
  const cursor = (await api('GET', '/api/cloud/changes?since=0')).body.cursor;
  await new Promise((res) => setTimeout(res, 10));
  const store = memoryStore();
  setStore(store);
  r = await api('GET', `/api/cloud/changes?since=${cursor}`);
  assert.equal(r.body.reset, true, 'a cursor past the counter means the relay was reset');
});

test('reset: a rewritten transcript replaces the relay\'s copy', async () => {
  await bot('POST', '/api/cloud/ingest', { session: { id: SID }, files: [{ file: MAIN, from: 0, lines: ['a', 'b', 'c'] }] });
  const r = await bot('POST', '/api/cloud/ingest', { session: { id: SID }, files: [{ file: MAIN, from: 0, lines: ['z'], reset: true }] });
  assert.equal(r.body.files[MAIN], 1);
  const p = await api('POST', '/api/cloud/pull', { want: [{ session: SID, file: MAIN, from: 0 }] });
  assert.deepEqual(p.body.got[0].lines, ['z']);
});

test('tokens: the agent side takes only BOT_TOKEN, the app side only APP_TOKEN', async () => {
  assert.equal((await api('POST', '/api/cloud/ingest', { session: { id: SID }, files: [] })).status, 401);
  assert.equal((await api('GET', `/api/cloud/state?session=${SID}`)).status, 401);
  assert.equal((await bot('GET', '/api/cloud/changes?since=0')).status, 401);
  assert.equal((await bot('POST', '/api/cloud/pull', { want: [] })).status, 401);
  assert.equal((await bot('POST', '/api/cloud/command', { session: SID, type: 'stop' })).status, 401);
  assert.equal((await api('POST', '/api/cloud/ingest', { session: { id: SID }, files: [] }, 'nope')).status, 401);
});

test('bad input is refused: session ids, file paths, line types', async () => {
  assert.equal((await bot('POST', '/api/cloud/ingest', { session: { id: '../x' }, files: [] })).status, 400);
  for (const file of ['../etc/passwd.jsonl', '/abs.jsonl', 'a/../b.jsonl', 'notes.txt', 'a//b.jsonl']) {
    assert.equal((await bot('POST', '/api/cloud/ingest', { session: { id: SID }, files: [{ file, from: 0, lines: ['x'] }] })).status, 400, file);
  }
  assert.equal((await bot('POST', '/api/cloud/ingest', { session: { id: SID }, files: [{ file: MAIN, from: 0, lines: [{ not: 'a string' }] }] })).status, 400);
  assert.equal((await api('POST', '/api/cloud/command', { session: SID, type: 'delete-everything' })).status, 400);
  // A claude.ai link is kept; anything else in url is dropped.
  await bot('POST', '/api/cloud/ingest', { session: { id: SID, url: 'https://evil.example.com/x' }, files: [] });
  const s = (await api('GET', '/api/cloud/changes?since=0')).body.sessions[0];
  assert.equal(s.meta.url, undefined);
});

test('a gzipped batch (how the streamer sends big ones) is unpacked', async () => {
  const body = zlib.gzipSync(Buffer.from(JSON.stringify({ session: { id: SID }, files: [{ file: MAIN, from: 0, lines: Array.from({ length: 500 }, (_, i) => line({ i })) }] })));
  const r = await fetch(`${base}/api/cloud/ingest`, { method: 'POST', headers: { Authorization: 'Bearer bot-secret', 'Content-Type': 'application/octet-stream', 'X-SB-Encoding': 'gzip' }, body });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).files[MAIN], 500);
  const bad = await fetch(`${base}/api/cloud/ingest`, { method: 'POST', headers: { Authorization: 'Bearer bot-secret', 'Content-Type': 'application/octet-stream', 'X-SB-Encoding': 'gzip' }, body: 'not gzip' });
  assert.equal(bad.status, 400);
});

test('stop: the app asks, the session gets it once with its next batch', async () => {
  await bot('POST', '/api/cloud/ingest', { session: { id: SID }, files: [] });
  const c = await api('POST', '/api/cloud/command', { session: SID, type: 'stop' });
  assert.equal(c.status, 200);
  let r = await bot('POST', '/api/cloud/ingest', { session: { id: SID }, files: [] });
  assert.equal(r.body.commands.length, 1);
  assert.equal(r.body.commands[0].type, 'stop');
  r = await bot('POST', '/api/cloud/ingest', { session: { id: SID }, files: [] });
  assert.equal(r.body.commands.length, 0);
});

test('forget removes a session', async () => {
  await bot('POST', '/api/cloud/ingest', { session: { id: SID }, files: [{ file: MAIN, from: 0, lines: ['a'] }] });
  assert.equal((await api('POST', '/api/cloud/forget', { session: SID })).status, 200);
  assert.deepEqual((await bot('GET', `/api/cloud/state?session=${SID}`)).body.files, {});
});

test('the streamer script is served without a token', async () => {
  const r = await fetch(`${base}/sync.cjs`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  assert.match(await r.text(), /Switchboard cloud sync/);
});

test('slim keeps what Switchboard reads and drops images, thinking and harness bookkeeping', () => {
  assert.equal(slim(line({ type: 'attachment', attachment: { big: 'x' } })), null);
  assert.equal(slim(line({ type: 'queue-operation' })), null);
  assert.equal(slim('not json'), null);
  const s = JSON.parse(slim(line({
    type: 'assistant', uuid: 'u1', sessionId: 'abc', timestamp: '2026-11-15T00:00:00Z', cwd: '/home/user/repo', serverClassifierRequest: { huge: true }, toolUseResult: { stdout: 'x'.repeat(100000) },
    message: { id: 'm1', role: 'assistant', model: 'claude', usage: { output_tokens: 3 }, content: [
      { type: 'thinking', thinking: 'secret thoughts', signature: 'sig' },
      { type: 'text', text: 'Done.' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls', description: 'List' } },
    ] },
  })));
  assert.equal(s.serverClassifierRequest, undefined);
  assert.equal(s.toolUseResult, undefined);
  assert.equal(s.cwd, '/home/user/repo');
  assert.deepEqual(s.message.content.map((b) => b.type), ['text', 'tool_use']);
  const u = JSON.parse(slim(line({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'y'.repeat(20000) }, { type: 'image', source: { data: 'AAAA' } }] },
    { type: 'image', source: { type: 'base64', data: 'B'.repeat(50000) } },
  ] } })));
  assert.ok(u.message.content[0].content[0].text.length < 9000);
  assert.equal(u.message.content[0].content[1].text, '[Image]');
  assert.equal(u.message.content[1].text, '[Image]');
});

// The real thing: the streamer runs as it would in a cloud session, against this relay.
function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sync-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-home-user-repo', 'abc', 'subagents'), { recursive: true });
  return home;
}
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 100)); }
};

test('the streamer sends a session live, with its sub-agent, picks up a restart where it left off, and takes a stop', { timeout: 30000 }, async () => {
  const home = tmpHome();
  const proj = path.join(home, '.claude', 'projects', '-home-user-repo');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), SWITCHBOARD_RELAY_URL: base, SWITCHBOARD_RELAY_TOKEN: 'bot-secret', CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_01StreamTest', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_CODE_USER_EMAIL: 'me@example.com', HTTPS_PROXY: '', https_proxy: '' };
  const sid = 'session_01StreamTest';
  const main = path.join(proj, 'abc.jsonl');
  fs.writeFileSync(main, `${line({ type: 'user', uuid: 'u1', sessionId: 'abc', message: { role: 'user', content: 'Fix the build' } })}\n${line({ type: 'attachment', x: 1 })}\n`);
  let d = spawn(process.execPath, [SYNC, 'daemon'], { env, stdio: 'ignore' });
  try {
    const counts = () => bot('GET', `/api/cloud/state?session=${sid}`).then((r) => r.body.files);
    await until(async () => (await counts())['-home-user-repo/abc.jsonl'] === 1);

    // Lines arrive as they are written: a reply, half a line (held back until it's whole), a title, a sub-agent.
    fs.appendFileSync(main, `${line({ type: 'assistant', uuid: 'a1', sessionId: 'abc', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } })}\n{"type":"ai-ti`);
    fs.writeFileSync(path.join(proj, 'abc', 'subagents', 'agent-1.jsonl'), `${line({ type: 'user', isSidechain: true, sessionId: 'abc', message: { role: 'user', content: 'Look at the tests' } })}\n`);
    await until(async () => { const c = await counts(); return c['-home-user-repo/abc.jsonl'] === 2 && c['-home-user-repo/abc/subagents/agent-1.jsonl'] === 1; });
    fs.appendFileSync(main, `tle","aiTitle":"Fixing the build","sessionId":"abc"}\n`);
    await until(async () => (await counts())['-home-user-repo/abc.jsonl'] === 3);
    const ch = await until(async () => (await api('GET', '/api/cloud/changes?since=0')).body.sessions.find((s) => s.id === sid && s.meta.title === 'Fixing the build'));
    assert.equal(ch.meta.email, 'me@example.com');
    assert.equal(ch.meta.url, `https://claude.ai/code/${sid}`);
    assert.equal(ch.meta.cloud, true);

    // Restart (a resumed container): nothing is sent twice.
    d.kill(); await new Promise((r) => d.once('exit', r));
    fs.appendFileSync(main, `${line({ type: 'user', uuid: 'u2', sessionId: 'abc', message: { role: 'user', content: 'Thanks' } })}\n`);
    d = spawn(process.execPath, [SYNC, 'daemon'], { env, stdio: 'ignore' });
    await until(async () => (await counts())['-home-user-repo/abc.jsonl'] === 4);
    const all = (await api('POST', '/api/cloud/pull', { want: [{ session: sid, file: '-home-user-repo/abc.jsonl', from: 0 }] })).body.got[0].lines.map((l) => JSON.parse(l));
    assert.deepEqual(all.map((l) => l.uuid || l.type), ['u1', 'a1', 'ai-title', 'u2']);

    // Stop: the app asks, the streamer leaves the flag, and the next tool step ends the turn.
    await api('POST', '/api/cloud/command', { session: sid, type: 'stop' });
    const flag = path.join(home, '.switchboard-cloud', 'stop');
    await until(() => fs.existsSync(flag), 20000);
    const h = spawnSync(process.execPath, [SYNC, 'hook'], { env, input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }) });
    assert.deepEqual(JSON.parse(String(h.stdout)), { continue: false, stopReason: 'Stopped from Switchboard.', suppressOutput: true });
    assert.equal(fs.existsSync(flag), false, 'a stop is used once');
    const again = spawnSync(process.execPath, [SYNC, 'hook'], { env, input: JSON.stringify({ hook_event_name: 'PreToolUse' }) });
    assert.equal(String(again.stdout), '');
  } finally {
    d.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install adds the hooks once, keeps other hooks, and SessionStart starts one streamer', { timeout: 20000 }, async () => {
  const home = tmpHome();
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), SWITCHBOARD_RELAY_URL: '', SWITCHBOARD_RELAY_TOKEN: 'bot-secret', CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_01InstallTest', HTTPS_PROXY: '', https_proxy: '' };
  const settingsFile = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  try {
    for (let i = 0; i < 2; i++) {
      const r = spawnSync(process.execPath, [SYNC, 'install', '--relay', `${base}/`], { env });
      assert.equal(r.status, 0, String(r.stderr));
    }
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(s.model, 'opus');
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreToolUse', 'PostToolUse']) {
      const ours = s.hooks[ev].filter((h) => h.hooks.some((x) => x.command.includes('switchboard-sync.cjs')));
      assert.equal(ours.length, 1, `${ev} has our hook once`);
    }
    assert.ok(s.hooks.PreToolUse.some((h) => h.hooks.some((x) => x.command === 'echo mine')), 'other hooks are kept');
    const installed = path.join(home, '.switchboard-cloud', 'switchboard-sync.cjs');
    assert.ok(fs.existsSync(installed));
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.switchboard-cloud', 'config.json'), 'utf8')).relay, base);

    // The tool hooks cost nothing while no stop waits: the file test fails and the command is `true`.
    const toolCmd = s.hooks.PreToolUse.find((h) => h.matcher === '*').hooks[0].command;
    const t = spawnSync('sh', ['-c', toolCmd], { env, input: '{}' });
    assert.equal(t.status, 0);
    assert.equal(String(t.stdout), '');

    // SessionStart starts the streamer (once), from the saved address.
    for (let i = 0; i < 2; i++) spawnSync(process.execPath, [installed, 'hook'], { env, input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }) });
    const pid = Number(fs.readFileSync(path.join(home, '.switchboard-cloud', 'daemon.pid'), 'utf8'));
    assert.ok(pid > 0);
    process.kill(pid, 0);
    await until(async () => (await api('GET', '/api/cloud/changes?since=0')).body.sessions.some((x) => x.id === 'session_01InstallTest'));
    process.kill(pid);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the Postgres store runs the cloud queries in order and maps rows back', async () => {
  const sent = [];
  const rows = { files: [] };
  const query = async (text, params) => {
    sent.push(text.replace(/\s+/g, ' ').trim());
    if (text.startsWith('SELECT file, count FROM cloud_files')) return rows.files;
    if (text.startsWith('DELETE FROM cloud_cmds WHERE session = $1 RETURNING')) return [{ id: '2', data: { type: 'stop', id: 'b' } }, { id: '1', data: { type: 'stop', id: 'a' } }];
    if (text.includes('cloud_seq") ') || text.includes('FROM cloud_seq')) return [{ v: '5' }];
    if (text.includes('FROM cloud_sessions s WHERE')) return [{ id: SID, seq: '5', ts: '100', meta: { title: 'T' }, files: { [MAIN]: '2' } }];
    if (text.startsWith('SELECT line FROM cloud_lines')) return [{ line: 'a' }, { line: 'b' }];
    return [];
  };
  const s = postgresStore('postgres://x', query);
  rows.files = [{ file: MAIN, count: '1' }];
  const r = await s.cloudIngest({ id: SID, title: 'T' }, [{ file: MAIN, from: 0, lines: ['a', 'b'] }]);
  assert.deepEqual(r.files, { [MAIN]: 2 });
  assert.deepEqual(r.commands.map((c) => c.id), ['a', 'b']);
  const ins = sent.find((t) => t.startsWith('INSERT INTO cloud_lines'));
  assert.ok(ins, 'lines inserted');
  const c = await s.cloudChanges(0, 0, 10);
  assert.deepEqual(c, { head: 5, sessions: [{ id: SID, seq: 5, ts: 100, meta: { title: 'T' }, files: { [MAIN]: 2 } }] });
  assert.deepEqual(await s.cloudLines(SID, MAIN, 0, 10), ['a', 'b']);
});
