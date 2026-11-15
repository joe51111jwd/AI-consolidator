#!/usr/bin/env node
'use strict';
// Switchboard cloud sync. Runs inside a Claude Code session (claude.ai/code cloud sessions, or any
// other computer) and streams the session's conversation, and its sub-agents', to your Switchboard
// Relay as Claude writes it, so Switchboard shows the session live. It also lets Switchboard stop the
// session: the Relay hands back a stop, and the next tool step ends the turn.
//
//   node switchboard-sync.cjs install --relay https://<your-relay>.vercel.app
//       Once per container (a cloud environment's setup script): saves the Relay address and adds
//       the hooks below to ~/.claude/settings.json. Re-running it changes nothing.
//   node switchboard-sync.cjs hook
//       The hooks: SessionStart starts the streamer, UserPromptSubmit clears an old stop, and
//       PreToolUse/PostToolUse end the turn when Switchboard asked to stop. Reads the hook's JSON on
//       stdin and prints nothing unless it stops the turn.
//   node switchboard-sync.cjs daemon
//       The streamer itself, started by the SessionStart hook. Runs until the container stops.
//   node switchboard-sync.cjs status
//       Prints whether the streamer runs, where it sends and what it sent.
//
// Where it sends: SWITCHBOARD_RELAY_URL, or the address `install` saved. The Relay wants the agent
// token (BOT_TOKEN): SWITCHBOARD_RELAY_TOKEN if set, otherwise none is sent, for cloud environments
// whose network adds it to every request to the Relay (an environment network secret), so the token
// never sits in the container. Nothing but the conversation lines is sent: never files, keys or the
// environment. Images are replaced by a placeholder and very long tool output is cut.
// No dependencies; Node 18 or newer.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const zlib = require('zlib');
const { spawn } = require('child_process');

const VERSION = '1.0.0';
const HOME = os.homedir();
const STATE = path.join(HOME, '.switchboard-cloud');
const CONFIG = path.join(STATE, 'config.json');
const PID = path.join(STATE, 'daemon.pid');
const LOG = path.join(STATE, 'daemon.log');
const STOP = path.join(STATE, 'stop');
const STATUS = path.join(STATE, 'status.json');
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const PROJECTS = path.join(CLAUDE_DIR, 'projects');

const TICK_MS = 250; // how often the files are checked
const SEND_MS = 700; // at most one batch this often
const ACTIVE_POLL_MS = 1500; // while the session works, ask for a stop this often even without news
const IDLE_BEAT_MS = 15000; // otherwise, say it's still here this often
const ACTIVE_FOR_MS = 30000; // new lines within this long count as working
const MAX_BATCH = 2 * 1024 * 1024; // uncompressed bytes per request
const MAX_TEXT = 60000; // a text block longer than this is cut
const MAX_TOOL_OUT = 8000; // tool output longer than this is cut
// The lines Switchboard reads; everything else in the transcript (attachments, the harness's own
// bookkeeping) stays here. The choice only depends on the line, so a restart picks the same lines.
const KEEP_TYPES = new Set(['user', 'assistant', 'system', 'summary', 'ai-title', 'custom-title']);
const KEEP_FIELDS = ['type', 'uuid', 'parentUuid', 'isSidechain', 'isMeta', 'isCompactSummary', 'sessionId', 'agentId', 'timestamp', 'cwd', 'gitBranch', 'version', 'message', 'summary', 'leafUuid', 'aiTitle', 'customTitle', 'subtype', 'content', 'level', 'toolUseID'];
const KEEP_MESSAGE = ['id', 'role', 'model', 'content', 'usage', 'stop_reason'];

// ---------- config ----------
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, f); }
function config() {
  const c = readJson(CONFIG, {}) || {};
  const relay = String(process.env.SWITCHBOARD_RELAY_URL || c.relay || '').trim().replace(/\/+$/, '').replace(/\/mcp$/, '');
  const token = String(process.env.SWITCHBOARD_RELAY_TOKEN || c.token || '').trim();
  return { relay, token };
}

// Who this session is. In a claude.ai/code cloud session the harness says which session it is;
// claude.ai's links use session_<id> for the same id.
function identity() {
  const remote = process.env.CLAUDE_CODE_REMOTE_SESSION_ID || '';
  const cli = process.env.CLAUDE_CODE_SESSION_ID || '';
  const id = remote ? remote.replace(/^cse_/, 'session_') : `local_${os.hostname().replace(/[^\w.-]+/g, '-')}_${cli || process.pid}`;
  return {
    id,
    cloud: !!remote,
    url: remote ? `https://claude.ai/code/${id}` : undefined,
    email: process.env.CLAUDE_CODE_USER_EMAIL || undefined,
    org: process.env.CLAUDE_CODE_ORGANIZATION_UUID || undefined,
    cliSessionId: cli || undefined,
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT || undefined,
    environment: process.env.CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE || undefined,
    host: remote ? undefined : os.hostname(),
    version: VERSION,
  };
}

// ---------- HTTPS, through the container's proxy when it has one ----------
let extraCa = null;
function caList() {
  if (extraCa !== null) return extraCa;
  extraCa = undefined;
  for (const f of [process.env.NODE_EXTRA_CA_CERTS, process.env.SSL_CERT_FILE, process.env.REQUESTS_CA_BUNDLE]) {
    if (!f) continue;
    try { extraCa = [...tls.rootCertificates, fs.readFileSync(f, 'utf8')]; break; } catch {}
  }
  return extraCa;
}
function proxyFor(u) {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  if (!p) return null;
  const no = String(process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const h = u.hostname.toLowerCase();
  if (no.some((n) => n === '*' || h === n.replace(/^\./, '') || h.endsWith(n.startsWith('.') ? n : `.${n}`))) return null;
  try { return new URL(p); } catch { return null; }
}
function tunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${host}:${port}` };
    if (proxy.username) headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
    const mod = proxy.protocol === 'https:' ? https : http;
    const req = mod.request({ host: proxy.hostname, port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80), method: 'CONNECT', path: `${host}:${port}`, headers });
    req.setTimeout(15000, () => req.destroy(new Error('proxy timeout')));
    req.once('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else { socket.destroy(); reject(new Error(`proxy refused (${res.statusCode})`)); }
    });
    req.once('error', reject);
    req.end();
  });
}
async function request(method, url, body, { timeout = 20000 } = {}) {
  const u = new URL(url);
  const { token } = config();
  const headers = { Accept: 'application/json', 'User-Agent': `switchboard-sync/${VERSION}` };
  if (token) headers.Authorization = `Bearer ${token}`;
  let data = null;
  if (body !== undefined) {
    const raw = Buffer.from(JSON.stringify(body));
    if (raw.length > 16384) { data = zlib.gzipSync(raw); headers['Content-Type'] = 'application/octet-stream'; headers['X-SB-Encoding'] = 'gzip'; } else { data = raw; headers['Content-Type'] = 'application/json'; }
    headers['Content-Length'] = data.length;
  }
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const proxy = u.protocol === 'https:' ? proxyFor(u) : null;
  const socket = proxy ? await tunnel(proxy, u.hostname, port) : null;
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const opts = { method, hostname: u.hostname, port, path: u.pathname + u.search, headers, agent: false };
    if (u.protocol === 'https:') { opts.ca = caList(); opts.servername = u.hostname; }
    if (socket) opts.createConnection = () => tls.connect({ socket, servername: u.hostname, ca: caList() });
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300 && json) resolve(json);
        else reject(Object.assign(new Error(`relay answered ${res.statusCode}${json && json.error ? `: ${json.error}` : ''}`), { status: res.statusCode }));
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---------- what is sent from each line ----------
function cut(s, n) { return typeof s === 'string' && s.length > n ? `${s.slice(0, n)}\n… [cut by Switchboard sync: ${s.length - n} more characters]` : s; }
function slimBlock(b) {
  if (!b || typeof b !== 'object') return b;
  if (b.type === 'image' || b.type === 'document') return { type: 'text', text: `[${b.type === 'image' ? 'Image' : 'Document'}]` };
  if (b.type === 'thinking' || b.type === 'redacted_thinking') return null;
  if (b.type === 'text') return { type: 'text', text: cut(b.text, MAX_TEXT) };
  if (b.type === 'tool_result') {
    let c = b.content;
    if (Array.isArray(c)) c = c.map((x) => (x && x.type === 'text' ? { type: 'text', text: cut(x.text, MAX_TOOL_OUT) } : x && x.type === 'image' ? { type: 'text', text: '[Image]' } : null)).filter(Boolean);
    else c = cut(c, MAX_TOOL_OUT);
    return { type: 'tool_result', tool_use_id: b.tool_use_id, is_error: b.is_error || undefined, content: c };
  }
  if (b.type === 'tool_use') {
    const input = {};
    for (const [k, v] of Object.entries(b.input || {})) input[k] = typeof v === 'string' ? cut(v, MAX_TOOL_OUT) : v;
    return { type: 'tool_use', id: b.id, name: b.name, input };
  }
  return b;
}
// One transcript line as Switchboard gets it, or null when it isn't sent.
function slim(line) {
  let l; try { l = JSON.parse(line); } catch { return null; }
  if (!l || !KEEP_TYPES.has(l.type)) return null;
  const out = {};
  for (const k of KEEP_FIELDS) if (l[k] !== undefined) out[k] = l[k];
  if (l.message && typeof l.message === 'object') {
    const m = {};
    for (const k of KEEP_MESSAGE) if (l.message[k] !== undefined) m[k] = l.message[k];
    if (Array.isArray(m.content)) m.content = m.content.map(slimBlock).filter(Boolean);
    else if (typeof m.content === 'string') m.content = cut(m.content, MAX_TEXT);
    out.message = m;
  }
  if (typeof out.content === 'string') out.content = cut(out.content, MAX_TOOL_OUT);
  return JSON.stringify(out);
}

// ---------- the streamer ----------
function log(...a) {
  try {
    const st = fs.statSync(LOG);
    if (st.size > 512 * 1024) fs.renameSync(LOG, `${LOG}.1`);
  } catch {}
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${a.join(' ')}\n`); } catch {}
}

function walk(dir, out = []) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of names) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (d.isFile() && d.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

async function daemon() {
  fs.mkdirSync(STATE, { recursive: true });
  const me = identity();
  const files = new Map(); // rel -> { offset, partial, count (lines kept so far), sent (acked by the relay), skipTo, queue: [lines] }
  let lastData = 0; // when a new line was last read
  let lastSend = 0;
  let inFlight = false;
  let failures = 0;
  let retryAt = 0;
  let known = false; // the relay's counts are in
  let aiTitle = null;
  let customTitle = null;
  let stats = { sent: 0, batches: 0, errors: 0, lastOk: 0, lastError: '' };
  log(`start ${me.id} relay=${config().relay || '(none)'}`);

  const fileState = (rel) => {
    let f = files.get(rel);
    if (!f) { f = { offset: 0, partial: '', count: 0, sent: 0, skipTo: 0, queue: [] }; files.set(rel, f); }
    return f;
  };

  function read() {
    for (const abs of walk(PROJECTS)) {
      const rel = path.relative(PROJECTS, abs).split(path.sep).join('/');
      const f = fileState(rel);
      let st; try { st = fs.statSync(abs); } catch { continue; }
      if (st.size < f.offset) { // rewritten from scratch: start over, the relay is told to drop its copy
        Object.assign(f, { offset: 0, partial: '', count: 0, sent: 0, skipTo: 0, queue: [], reset: true });
      }
      if (st.size === f.offset) continue;
      let buf;
      try {
        const fd = fs.openSync(abs, 'r');
        try { buf = Buffer.alloc(Math.min(st.size - f.offset, 8 * 1024 * 1024)); fs.readSync(fd, buf, 0, buf.length, f.offset); } finally { fs.closeSync(fd); }
      } catch { continue; }
      f.offset += buf.length;
      const parts = (f.partial + buf.toString('utf8')).split('\n');
      f.partial = parts.pop();
      for (const line of parts) {
        if (!line.trim()) continue;
        const s = slim(line);
        if (s == null) continue;
        if (!rel.includes('/subagents/')) {
          try { const o = JSON.parse(s); if (o.type === 'custom-title' && o.customTitle) customTitle = o.customTitle; else if (o.type === 'ai-title' && o.aiTitle) aiTitle = o.aiTitle; } catch {}
        }
        const idx = f.count++;
        if (idx < f.skipTo) continue; // the relay already has it
        f.queue.push(s);
        lastData = Date.now();
      }
    }
  }

  function batch() {
    const out = [];
    let size = 0;
    for (const [rel, f] of files) {
      if (!f.queue.length && !f.reset) continue;
      const lines = [];
      while (f.queue.length && (size < MAX_BATCH || !lines.length)) { size += f.queue[0].length; lines.push(f.queue.shift()); }
      const from = f.sent;
      out.push({ file: rel, from, lines, ...(f.reset ? { reset: true } : {}) });
      f.pending = { lines, reset: !!f.reset };
      f.reset = false;
      if (size >= MAX_BATCH) break;
    }
    return out;
  }

  function settle(res, sentFiles) {
    const counts = (res && res.files) || {};
    for (const p of sentFiles) {
      const f = files.get(p.file);
      if (!f) continue;
      const have = Number(counts[p.file]);
      f.pending = null;
      if (!Number.isFinite(have)) { f.sent = p.from + p.lines.length; continue; }
      if (have >= p.from + p.lines.length) { f.sent = have; continue; }
      // The relay has fewer lines than this side sent: it lost some (or never got the start).
      // Read the file again from the top and send from what it has.
      log(`gap in ${p.file}: relay has ${have}, sent up to ${p.from + p.lines.length}`);
      Object.assign(f, { offset: 0, partial: '', count: 0, sent: have, skipTo: have, queue: [] });
    }
    if (res && Array.isArray(res.commands)) for (const c of res.commands) command(c);
  }

  function requeue(sentFiles) {
    for (const p of sentFiles) {
      const f = files.get(p.file);
      if (!f || !f.pending) continue;
      f.queue.unshift(...f.pending.lines);
      if (f.pending.reset) f.reset = true;
      f.pending = null;
    }
  }

  function command(c) {
    if (!c || typeof c !== 'object') return;
    if (c.type === 'stop') {
      log(`stop asked ${c.id || ''}`);
      try { fs.writeFileSync(STOP, JSON.stringify({ id: c.id || null, at: Date.now(), session: me.id })); } catch {}
    }
  }

  async function hello() {
    const { relay } = config();
    if (!relay) return;
    try {
      const r = await request('GET', `${relay}/api/cloud/state?session=${encodeURIComponent(me.id)}`);
      for (const [rel, n] of Object.entries((r && r.files) || {})) { const f = fileState(rel); f.skipTo = Math.max(f.skipTo, Number(n) || 0); f.sent = Math.max(f.sent, Number(n) || 0); }
      known = true;
      failures = 0;
    } catch (e) {
      failures++; retryAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(failures, 6));
      stats.errors++; stats.lastError = e.message;
      log(`state failed: ${e.message}`);
    }
  }

  async function tick() {
    const { relay } = config();
    if (!relay) return;
    if (!known) { if (Date.now() >= retryAt) await hello(); if (!known) return; }
    read();
    if (inFlight || Date.now() < retryAt) return;
    const now = Date.now();
    const hasData = [...files.values()].some((f) => f.queue.length || f.reset);
    const active = now - lastData < ACTIVE_FOR_MS;
    const due = hasData ? now - lastSend >= SEND_MS : now - lastSend >= (active ? ACTIVE_POLL_MS : IDLE_BEAT_MS);
    if (!due) return;
    const sentFiles = hasData ? batch() : [];
    inFlight = true;
    lastSend = now;
    try {
      const body = { session: { ...me, title: customTitle || aiTitle || undefined, active, sync: { at: now } }, files: sentFiles };
      const res = await request('POST', `${relay}/api/cloud/ingest`, body);
      settle(res, sentFiles);
      failures = 0;
      stats.batches++; stats.sent += sentFiles.reduce((n, p) => n + p.lines.length, 0); stats.lastOk = Date.now();
    } catch (e) {
      requeue(sentFiles);
      failures++; retryAt = Date.now() + Math.min(60000, 500 * 2 ** Math.min(failures, 7));
      stats.errors++; stats.lastError = e.message;
      if (failures <= 3 || failures % 20 === 0) log(`send failed (${failures}): ${e.message}`);
    } finally {
      inFlight = false;
      try { writeJson(STATUS, { ...stats, session: me.id, relay, files: Object.fromEntries([...files].map(([k, f]) => [k, { read: f.count, sent: f.sent, queued: f.queue.length }])), at: Date.now() }); } catch {}
    }
  }

  const loop = async () => {
    try { await tick(); } catch (e) { log(`tick: ${e.stack || e.message}`); }
    setTimeout(loop, TICK_MS);
  };
  loop();
}

// ---------- hooks ----------
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function running() { const pid = Number(String(readText(PID)).trim()); return pid > 0 && alive(pid) ? pid : 0; }
function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }

function ensureDaemon() {
  if (running()) return;
  if (!config().relay) return;
  fs.mkdirSync(STATE, { recursive: true });
  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [__filename, 'daemon'], { detached: true, stdio: ['ignore', out, out], env: process.env, cwd: HOME });
  fs.writeFileSync(PID, String(child.pid));
  child.unref();
}

function readStdin(ms = 1500) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let s = '';
    const t = setTimeout(() => resolve(s), ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => { clearTimeout(t); resolve(s); });
    process.stdin.on('error', () => { clearTimeout(t); resolve(s); });
  });
}

async function hook() {
  const raw = await readStdin();
  let input = {}; try { input = JSON.parse(raw || '{}'); } catch {}
  const event = input.hook_event_name || '';
  if (event === 'SessionStart') { ensureDaemon(); return; }
  if (event === 'UserPromptSubmit' || event === 'Stop' || event === 'SessionEnd') {
    // A new message starts a new turn: an older stop no longer applies. A finished turn has stopped.
    try { fs.rmSync(STOP, { force: true }); } catch {}
    if (event !== 'SessionEnd') ensureDaemon();
    return;
  }
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    const s = readJson(STOP, null);
    if (!s) return;
    try { fs.rmSync(STOP, { force: true }); } catch {}
    // A stop older than ten minutes was meant for a turn that is long over.
    if (Date.now() - (Number(s.at) || 0) > 600000) return;
    process.stdout.write(JSON.stringify({ continue: false, stopReason: 'Stopped from Switchboard.', suppressOutput: true }));
  }
}

// ---------- install ----------
function q(s) { return `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`; }
function install(args) {
  const i = args.indexOf('--relay');
  const relay = (i >= 0 ? args[i + 1] : process.env.SWITCHBOARD_RELAY_URL || '').trim().replace(/\/+$/, '').replace(/\/mcp$/, '');
  if (!/^https?:\/\/\S+$/.test(relay)) { console.error('Usage: switchboard-sync.cjs install --relay https://<your-relay>.vercel.app'); process.exit(2); }
  fs.mkdirSync(STATE, { recursive: true });
  const self = path.join(STATE, 'switchboard-sync.cjs');
  if (path.resolve(__filename) !== self) fs.copyFileSync(__filename, self);
  writeJson(CONFIG, { ...(readJson(CONFIG, {}) || {}), relay });
  const node = process.execPath;
  const cmd = `${q(node)} ${q(self)} hook`;
  // The tool hooks are a file test first, so a tool step costs no Node start unless a stop is waiting.
  const toolCmd = `test -f ${q(STOP)} && ${cmd} || true`;
  const settingsFile = path.join(CLAUDE_DIR, 'settings.json');
  const settings = readJson(settingsFile, {}) || {};
  settings.hooks = settings.hooks || {};
  const add = (event, command, matcher) => {
    const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const mine = (h) => Array.isArray(h.hooks) && h.hooks.some((x) => typeof x.command === 'string' && x.command.includes('switchboard-sync.cjs'));
    const kept = list.filter((h) => !mine(h));
    kept.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: 10 }] });
    settings.hooks[event] = kept;
  };
  add('SessionStart', cmd);
  add('UserPromptSubmit', cmd);
  add('Stop', cmd);
  add('PreToolUse', toolCmd, '*');
  add('PostToolUse', toolCmd, '*');
  writeJson(settingsFile, settings);
  console.log(`Switchboard sync installed: sends to ${relay}; hooks added to ${settingsFile}.`);
}

function status() {
  const pid = running();
  const s = readJson(STATUS, null);
  console.log(JSON.stringify({ running: !!pid, pid: pid || undefined, relay: config().relay || null, session: identity().id, last: s }, null, 2));
}

// ---------- main ----------
const [mode, ...rest] = process.argv.slice(2);
if (require.main === module) {
  if (mode === 'daemon') daemon();
  else if (mode === 'hook') hook().catch(() => {}).finally(() => process.exit(0));
  else if (mode === 'install') install(rest);
  else if (mode === 'status') status();
  else { console.error('Usage: switchboard-sync.cjs install --relay <url> | hook | daemon | status'); process.exit(2); }
}

module.exports = { slim, identity, request, VERSION };
