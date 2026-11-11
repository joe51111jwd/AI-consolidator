'use strict';
// OpenAI Codex CLI: sessions are JSONL "rollout" files under ~/.codex/sessions/YYYY/MM/DD/.
const fs = require('fs');
const path = require('path');
const { expand, exists, readJsonl, walk, truncate, run, which, HOME } = require('../util.cjs');
const classify = require('./classify.cjs');

const cache = new Map();
const DAY = 86400000;

function home(account) { return expand(account.config.home || '~/.codex'); }

function contentText(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => b.text || '').filter(Boolean).join('\n');
}

function parse(file) {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.parsed;
  const lines = readJsonl(file);
  let id = null, cwd = null, branch = null; const messages = []; let tokens = { input: 0, output: 0 };
  for (const l of lines) {
    const p = l.payload || l;
    const ts = l.timestamp ? Date.parse(l.timestamp) : st.mtimeMs;
    if (l.type === 'session_meta' || (!l.type && l.id && l.timestamp && !id)) { id = p.id || id; cwd = p.cwd || cwd; branch = (p.git && p.git.branch) || branch; }
    if (p.type === 'turn_context' && p.cwd) cwd = p.cwd;
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const text = contentText(p.content);
      if (!text || /^<(environment_context|user_instructions)/.test(text.trim())) continue;
      messages.push({ id: String(messages.length), role: p.role, text, ts });
    }
    if (p.type === 'token_count' && p.info && p.info.total_token_usage) {
      const t = p.info.total_token_usage;
      tokens = { input: t.input_tokens || 0, output: t.output_tokens || 0 };
    }
  }
  if (!id) { const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27})/i); id = m ? m[1] : path.basename(file, '.jsonl'); }
  const first = messages.find((m) => m.role === 'user');
  const last = messages[messages.length - 1];
  const parsed = { id, cwd, branch, messages, tokens, title: truncate(first ? first.text : 'Codex session', 80), preview: last ? truncate(last.text, 220) : '', lastRole: last && last.role, updatedAt: st.mtimeMs };
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, parsed });
  return parsed;
}

function files(account, days) {
  return walk(path.join(home(account), 'sessions'), (n) => n.endsWith('.jsonl'), Date.now() - days * DAY);
}

function list(account, { days = 21, max = 40 } = {}) {
  return files(account, days).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, max).map((f) => {
    let s; try { s = parse(f.path); } catch { return null; }
    if (!s.messages.length) return null;
    return {
      id: `cx:${account.id}:${s.id}`, kind: 'session', source: 'codex', accountId: account.id,
      title: s.title, preview: s.preview, updatedAt: s.updatedAt,
      status: Date.now() - s.updatedAt < 45000 ? 'running' : (s.lastRole === 'assistant' ? 'idle' : 'waiting'),
      meta: { cwd: s.cwd, gitBranch: s.branch, file: f.path, sessionId: s.id, messages: s.messages.length, category: classify.category(s.cwd, s.branch), noise: classify.isNoise(s.cwd) },
    };
  }).filter(Boolean);
}

function transcript(account, file) { return parse(file).messages; }

function usage(account) {
  const now = Date.now(); const w = { h5: 0, d1: 0, d7: 0, out7: 0, sessions: 0, byModel: {} };
  for (const f of files(account, 7)) {
    let s; try { s = parse(f.path); } catch { continue; }
    const t = s.tokens.input + s.tokens.output; w.sessions++;
    if (now - s.updatedAt < 5 * 3600000) w.h5 += t;
    if (now - s.updatedAt < DAY) w.d1 += t;
    w.d7 += t; w.out7 += s.tokens.output;
  }
  return w;
}

async function prompt(account, { sessionId, cwd, text, onText, signal }) {
  const bin = account.config.bin || which('codex');
  if (!bin) throw new Error('The Codex CLI (`codex`) was not found on this Mac.');
  const args = sessionId ? ['exec', '--json', 'resume', sessionId, '-'] : ['exec', '--json', '-'];
  let acc = '';
  const env = {}; if (account.config.home) env.CODEX_HOME = home(account);
  const res = await run(bin, args, {
    cwd: cwd && exists(cwd) ? cwd : HOME, env, input: text, signal,
    onLine: (line) => {
      let ev; try { ev = JSON.parse(line); } catch { return; }
      const item = ev.item || (ev.msg) || {};
      const t = (item.type === 'agent_message' && (item.text || item.message)) || null;
      if (t) { acc += (acc ? '\n\n' : '') + t; onText && onText(acc); }
    },
  });
  if (!acc && res.code !== 0) throw new Error(truncate(res.stderr || `codex exited with ${res.code}`, 400));
  return { text: acc || res.stdout.trim(), sessionId };
}

// Only counts as installed when Codex has actually been used (at least one session file).
function hasSessions(dir = path.join(HOME, '.codex', 'sessions'), depth = 0) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  if (entries.some((e) => e.isFile() && e.name.endsWith('.jsonl'))) return true;
  return depth < 5 && entries.some((e) => e.isDirectory() && hasSessions(path.join(dir, e.name), depth + 1));
}
function detect() { return hasSessions() ? ['~/.codex'] : []; }

module.exports = { list, transcript, usage, prompt, detect, hasSessions };
