'use strict';
// Claude Code: one "account" per config directory (CLAUDE_CONFIG_DIR, default ~/.claude).
// Sessions are read from <configDir>/projects/<encoded cwd>/<sessionId>.jsonl.
// Prompting runs the user's own `claude` CLI in print mode, so it uses that account's login.
const fs = require('fs');
const path = require('path');
const { HOME, APP_DIR, expand, exists, readJsonl, walk, truncate, run, which } = require('../util.cjs');

const cache = new Map(); // file -> { mtimeMs, size, parsed }
const DAY = 86400000;

function configDir(account) {
  return expand(account.config.configDir || '~/.claude');
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    if (b.type === 'text') return b.text;
    if (b.type === 'tool_use') return `⟢ ${b.name}${b.input && b.input.command ? ': ' + truncate(b.input.command, 120) : b.input && b.input.file_path ? ': ' + b.input.file_path : ''}`;
    return '';
  }).filter(Boolean).join('\n');
}

function isNoise(text) {
  return !text || /^<(command-|local-command|system-reminder|user-memory)/.test(text.trim()) || text.startsWith('Caveat:');
}

function parseSession(file) {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.parsed;
  const lines = readJsonl(file);
  const messages = [];
  const usage = []; // {ts, model, input, output}
  const seenUsage = new Set();
  let cwd = null, summary = null, gitBranch = null, sessionId = path.basename(file, '.jsonl');
  for (const l of lines) {
    if (l.type === 'summary' && l.summary) summary = l.summary;
    if (l.cwd) cwd = l.cwd;
    if (l.gitBranch) gitBranch = l.gitBranch;
    if (l.sessionId) sessionId = l.sessionId;
    if ((l.type === 'user' || l.type === 'assistant') && l.message && !l.isSidechain) {
      const ts = l.timestamp ? Date.parse(l.timestamp) : st.mtimeMs;
      const m = l.message;
      if (l.type === 'assistant' && m.usage && m.id && !seenUsage.has(m.id)) {
        seenUsage.add(m.id);
        const u = m.usage;
        usage.push({ ts, model: m.model, input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cacheRead: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 });
      }
      // Skip tool results (user turns that only carry tool output).
      if (l.type === 'user' && Array.isArray(m.content) && m.content.every((b) => b.type === 'tool_result')) continue;
      const text = textOf(m.content);
      if (l.isMeta || isNoise(text)) continue;
      const isTool = l.type === 'assistant' && Array.isArray(m.content) && m.content.every((b) => b.type !== 'text');
      messages.push({ id: l.uuid || `${messages.length}`, role: m.role || l.type, text, ts, kind: isTool ? 'tool' : undefined });
    }
  }
  const firstUser = messages.find((m) => m.role === 'user');
  const lastText = [...messages].reverse().find((m) => m.kind !== 'tool');
  const parsed = {
    sessionId, cwd, gitBranch, messages, usage,
    title: truncate(summary || (firstUser && firstUser.text) || 'Untitled session', 80),
    preview: lastText ? truncate(lastText.text, 220) : '',
    lastRole: lastText ? lastText.role : null,
    updatedAt: st.mtimeMs,
  };
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, parsed });
  return parsed;
}

function sessionFiles(account, days = 21) {
  const dir = path.join(configDir(account), 'projects');
  return walk(dir, (n) => n.endsWith('.jsonl'), Date.now() - days * DAY);
}

function list(account, { days = 21, max = 60 } = {}) {
  const files = sessionFiles(account, days).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, max);
  const out = [];
  for (const f of files) {
    let s;
    try { s = parseSession(f.path); } catch { continue; }
    if (!s.messages.length) continue;
    // The overall agent runs Claude Code inside ~/.switchboard; those runs are not cards of their own.
    if (s.cwd && path.resolve(s.cwd) === path.resolve(APP_DIR)) continue;
    out.push({
      id: `cc:${account.id}:${s.sessionId}`,
      kind: 'session', source: 'claude-code', accountId: account.id,
      title: s.title, preview: s.preview, updatedAt: s.updatedAt,
      status: Date.now() - s.updatedAt < 45000 ? 'running' : (s.lastRole === 'assistant' ? 'idle' : 'waiting'),
      meta: { cwd: s.cwd, gitBranch: s.gitBranch, file: f.path, sessionId: s.sessionId, messages: s.messages.length },
    });
  }
  return out;
}

function transcript(account, file) {
  return parseSession(file).messages;
}

// Token usage in rolling windows, from every session touched in the last 7 days.
function usage(account) {
  const now = Date.now();
  const w = { h5: 0, d1: 0, d7: 0, out7: 0, sessions: 0, byModel: {} };
  for (const f of sessionFiles(account, 7)) {
    let s; try { s = parseSession(f.path); } catch { continue; }
    w.sessions++;
    for (const u of s.usage) {
      const t = u.input + u.output;
      if (now - u.ts < 5 * 3600000) w.h5 += t;
      if (now - u.ts < DAY) w.d1 += t;
      if (now - u.ts < 7 * DAY) { w.d7 += t; w.out7 += u.output; w.byModel[u.model || 'unknown'] = (w.byModel[u.model || 'unknown'] || 0) + t; }
    }
  }
  return w;
}

function detect() {
  // Suggest config dirs that look like Claude Code homes (~/.claude, ~/.claude-*).
  const found = [];
  let entries = [];
  try { entries = fs.readdirSync(HOME); } catch {}
  for (const name of entries) {
    if (!/^\.claude([-_.].+)?$/.test(name)) continue;
    const p = path.join(HOME, name);
    if (exists(path.join(p, 'projects'))) found.push('~/' + name);
  }
  return found;
}

// Environment for a `claude` process that runs as this account and nothing else.
// Each account card has its own config folder, which Claude Code uses for that login's
// credentials (its own Keychain entry on macOS), settings and session history. Variables that
// would override the folder's login (an API key or token in your shell) are removed.
const OVERRIDES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CCR_OAUTH_TOKEN_FILE', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID'];
function isDefaultDir(dir) { return path.resolve(dir) === path.resolve(path.join(HOME, '.claude')); }
function childEnv(account) {
  const env = {};
  for (const k of OVERRIDES) env[k] = undefined;
  const dir = configDir(account);
  if (!isDefaultDir(dir)) env.CLAUDE_CONFIG_DIR = dir;
  return env;
}

// Who this folder is signed in as. Uses `claude auth status` (JSON), and falls back to the
// account details Claude Code keeps in .claude.json. Field names vary by version, so read loosely.
function pick(obj, re) {
  if (!obj || typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj)) {
    if (re.test(k) && (typeof v === 'string' || typeof v === 'number') && v !== '') return String(v);
  }
  for (const v of Object.values(obj)) { if (v && typeof v === 'object') { const r = pick(v, re); if (r) return r; } }
  return null;
}
function readAccountFile(account) {
  const dir = configDir(account);
  const f = isDefaultDir(dir) ? path.join(HOME, '.claude.json') : path.join(dir, '.claude.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).oauthAccount || null; } catch { return null; }
}
async function authStatus(account) {
  const bin = account.config.bin || which('claude');
  let j = null, loggedIn = null;
  if (bin) {
    const r = await run(bin, ['auth', 'status'], { env: childEnv(account), cwd: HOME, signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (r) {
      try { j = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop()); } catch {}
      loggedIn = j && typeof j.loggedIn === 'boolean' ? j.loggedIn : (j && j.authMethod ? j.authMethod !== 'none' : r.code === 0);
    }
  }
  const f = readAccountFile(account);
  const status = {
    loggedIn: loggedIn == null ? !!f : loggedIn,
    method: (j && j.authMethod) || (f ? 'claude.ai' : null),
    // `claude auth status` (Claude Code 2.x) prints email, orgId, orgName and subscriptionType
    // for a claude.ai login. Older versions print less, so fall back to the folder's .claude.json.
    email: (j && j.email) || pick(j, /email/i) || (f && f.emailAddress) || null,
    org: (j && j.orgName) || pick(j, /^org(anization)?_?name$|organizationName/i) || (f && (f.organizationName || null)) || null,
    orgId: (j && j.orgId) || (f && f.organizationUuid) || null,
    plan: (j && (j.subscriptionType || j.planTier)) || pick(j, /subscription|plan|tier|billing/i) || (f && (f.subscriptionType || f.billingType || null)) || null,
    dir: configDir(account), cli: !!bin, checkedAt: Date.now(),
  };
  if (status.loggedIn === false) { status.email = null; status.org = null; status.orgId = null; status.plan = null; }
  return status;
}

// Sign this folder in. `claude auth login` opens the browser; on claude.ai you choose which
// account and organization (for example your Team org or your personal plan) this card uses.
function login(account, { email, onOutput, signal } = {}) {
  const bin = account.config.bin || which('claude');
  if (!bin) return Promise.reject(new Error('Claude Code (the `claude` command) was not found on this Mac. Install it first: npm install -g @anthropic-ai/claude-code'));
  fs.mkdirSync(configDir(account), { recursive: true });
  const args = ['auth', 'login'];
  if (email) args.push('--email', email);
  return run(bin, args, { env: childEnv(account), cwd: HOME, onLine: onOutput, signal }).then((r) => {
    if (signal && signal.aborted) throw new Error('Sign-in cancelled');
    if (r.code !== 0) throw new Error(truncate(r.stderr || r.stdout || 'Sign-in did not finish', 300));
    return authStatus(account);
  });
}
async function logout(account) {
  const bin = account.config.bin || which('claude');
  if (!bin) throw new Error('Claude Code was not found on this Mac');
  await run(bin, ['auth', 'logout'], { env: childEnv(account), cwd: HOME });
  return authStatus(account);
}

// Send a prompt. Resumes `sessionId` when given, otherwise starts a new session in cwd.
async function prompt(account, { sessionId, cwd, text, onText, signal, extraArgs = [] }) {
  const bin = account.config.bin || which('claude');
  if (!bin) throw new Error('Claude Code (the `claude` command) was not found on this Mac.');
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (sessionId) args.push('--resume', sessionId);
  const mode = account.config.permissionMode;
  if (mode && mode !== 'default') args.push('--permission-mode', mode);
  args.push(...extraArgs);
  const env = childEnv(account);
  let acc = '', final = null, newSession = sessionId, usageOut = null;
  const res = await run(bin, args, {
    cwd: cwd && exists(cwd) ? cwd : HOME, env, input: text, signal,
    onLine: (line) => {
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (ev.session_id) newSession = ev.session_id;
      if (ev.type === 'assistant' && ev.message) {
        const t = textOf(ev.message.content);
        if (t) { acc += (acc ? '\n\n' : '') + t; onText && onText(acc); }
      }
      if (ev.type === 'result') { final = ev.result; usageOut = ev.usage || null; }
    },
  });
  if (res.code !== 0 && !acc && !final) throw new Error(truncate(res.stderr || res.stdout || `claude exited with ${res.code}`, 400));
  return { text: final || acc, sessionId: newSession, usage: usageOut };
}

module.exports = { list, transcript, usage, detect, prompt, configDir, childEnv, authStatus, login, logout };
