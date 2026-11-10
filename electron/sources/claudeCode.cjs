'use strict';
// Claude Code: one "account" per config directory (CLAUDE_CONFIG_DIR, default ~/.claude).
// Sessions are read from <configDir>/projects/<encoded cwd>/<sessionId>.jsonl.
// Prompting runs the user's own `claude` CLI in print mode, so it uses that account's login.
const fs = require('fs');
const path = require('path');
const { HOME, expand, exists, readJsonl, walk, truncate, run, which } = require('../util.cjs');

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

// Send a prompt. Resumes `sessionId` when given, otherwise starts a new session in cwd.
async function prompt(account, { sessionId, cwd, text, onText, signal, extraArgs = [] }) {
  const bin = account.config.bin || which('claude');
  if (!bin) throw new Error('Claude Code (the `claude` command) was not found on this Mac.');
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (sessionId) args.push('--resume', sessionId);
  const mode = account.config.permissionMode;
  if (mode && mode !== 'default') args.push('--permission-mode', mode);
  args.push(...extraArgs);
  const env = {};
  const dir = configDir(account);
  if (path.resolve(dir) !== path.resolve(path.join(HOME, '.claude'))) env.CLAUDE_CONFIG_DIR = dir;
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

module.exports = { list, transcript, usage, detect, prompt, configDir };
