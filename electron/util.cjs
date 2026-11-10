'use strict';
// Shared helpers for the main process.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const HOME = os.homedir();
const APP_DIR = path.join(HOME, '.switchboard');
fs.mkdirSync(APP_DIR, { recursive: true });

function expand(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(HOME, p.slice(1)) : p;
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

// GUI apps on macOS don't inherit the shell PATH, so `claude`, `codex` and `git`
// would not be found. Ask the login shell once for its PATH.
function fixPath() {
  if (process.platform === 'win32') return;
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-ilc', 'printf "__SBPATH__%s__SBPATH__" "$PATH"'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/__SBPATH__(.*)__SBPATH__/);
    if (m && m[1]) process.env.PATH = m[1];
  } catch { /* keep existing PATH */ }
  const extra = [path.join(HOME, '.local/bin'), path.join(HOME, '.claude/local'), '/opt/homebrew/bin', '/usr/local/bin'];
  const parts = new Set((process.env.PATH || '').split(':'));
  for (const e of extra) if (!parts.has(e)) process.env.PATH += ':' + e;
}

function which(cmd) {
  for (const dir of (process.env.PATH || '').split(':')) {
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

// Read a JSONL file into parsed objects, skipping bad lines.
function readJsonl(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

// Recursively list files matching a predicate, newer than `sinceMs`.
function walk(dir, pred, sinceMs = 0, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, sinceMs, out, depth + 1);
    else if (pred(e.name)) {
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= sinceMs) out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
      } catch {}
    }
  }
  return out;
}

function truncate(s, n) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Spawn a process, stream stdout lines to onLine, resolve with {code, stdout, stderr}.
function run(cmd, args, { cwd, env, input, onLine, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return reject(e); }
    let stdout = '', stderr = '', buf = '';
    child.stdout.on('data', (d) => {
      const s = d.toString(); stdout += s; buf += s;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (onLine && line.trim()) onLine(line);
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (buf.trim() && onLine) onLine(buf);
      resolve({ code, stdout, stderr });
    });
    if (signal) signal.addEventListener('abort', () => child.kill('SIGTERM'));
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

// Small concurrency pool.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } }
  }));
  return out;
}

module.exports = { HOME, APP_DIR, expand, exists, fixPath, which, readJsonl, walk, truncate, uid, run, pool };
