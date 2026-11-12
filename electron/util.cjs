'use strict';
// Shared helpers for the main process.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const HOME = os.homedir();
const APP_DIR = path.join(HOME, '.switchboard');
fs.mkdirSync(APP_DIR, { recursive: true });
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
// What the app calls the computer it runs on, in messages to the owner.
const HERE = IS_MAC ? 'this Mac' : 'this computer';

// Where desktop apps keep their data (Electron's appData): ~/Library/Application Support on macOS,
// %APPDATA% on Windows, $XDG_CONFIG_HOME or ~/.config on Linux. The Claude desktop app, Granola and
// Grok Bot keep their files there. Given a home folder (sample data, tests), it is under that folder.
function appDataDir(home, { platform = process.platform, env = process.env } = {}) {
  const base = home || HOME;
  if (platform === 'darwin') return path.join(base, 'Library', 'Application Support');
  const fromEnv = platform === 'win32' ? env.APPDATA : env.XDG_CONFIG_HOME;
  if (!home && fromEnv) return fromEnv;
  return platform === 'win32' ? path.join(base, 'AppData', 'Roaming') : path.join(base, '.config');
}

function expand(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(HOME, p.slice(1)) : p;
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

// GUI apps on macOS don't inherit the shell PATH, so `claude`, `codex` and `git`
// would not be found. Ask the login shell once for its PATH. On Windows the app gets the user's
// PATH; add where Claude Code's installer and npm put commands, in case it changed since sign-in.
function fixPath() {
  if (IS_WIN) {
    const parts = (process.env.PATH || '').split(';').filter(Boolean);
    for (const e of [path.join(HOME, '.local', 'bin'), path.join(appDataDir(), 'npm')]) if (!parts.includes(e)) parts.push(e);
    process.env.PATH = parts.join(';');
    return;
  }
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-ilc', 'printf "__SBPATH__%s__SBPATH__" "$PATH"'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/__SBPATH__(.*)__SBPATH__/);
    // Keep what we were started with first, then add the login shell's PATH (an app opened from
    // the Dock gets a bare PATH, so this is how we find `claude`, `codex`, `node` and `git`).
    if (m && m[1]) process.env.PATH = [process.env.PATH || '', m[1]].filter(Boolean).join(':');
  } catch { /* keep existing PATH */ }
  const extra = [path.join(HOME, '.local/bin'), path.join(HOME, '.claude/local'), path.join(HOME, '.npm-global/bin'), path.join(HOME, '.bun/bin'), path.join(HOME, '.volta/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const parts = (process.env.PATH || '').split(':').filter(Boolean);
  for (const e of extra) if (!parts.includes(e)) parts.push(e);
  process.env.PATH = [...new Set(parts)].join(':');
}

// The full path of a command on PATH, or null. On Windows commands have an extension (claude.exe,
// or npm's claude.cmd shim); the extensionless file npm puts beside it is a shell script Windows
// can't run, so only names with one of PATHEXT's extensions count.
function which(cmd, { env = process.env, platform = process.platform } = {}) {
  const win = platform === 'win32';
  const exts = win ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [];
  const names = win && !exts.includes(path.extname(cmd).toLowerCase()) ? exts.map((e) => cmd + e) : [cmd];
  for (const dir of (env.PATH || env.Path || '').split(win ? ';' : ':')) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}

// Windows starts .cmd and .bat files (npm's shims for claude and codex) only through cmd.exe, which
// reads the command line again: each argument is quoted, and cmd.exe's special characters escaped
// twice (once for cmd.exe, once more for the shim's own %*), so JSON and paths arrive unchanged.
// Same rules as cross-spawn (https://qntm.org/cmd).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function winQuote(arg) {
  const q = `"${String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return q.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}
function winShimCommand(cmd, args) {
  const line = [path.normalize(cmd).replace(CMD_META, '^$1'), ...args.map(winQuote)].join(' ');
  return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
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

// Markdown a one-line preview can't render: links become their text (a link cut short by an
// earlier truncation too), bare URLs and backticks go.
function plain(s) {
  return String(s || '').replace(/!?\[([^\]]*)\]\([^)\s]*\)?/g, '$1').replace(/\bhttps?:\/\/\S+/g, '').replace(/`+/g, '').replace(/[ \t]{2,}/g, ' ').trim();
}

function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Spawn a process, stream stdout lines to onLine, resolve with {code, stdout, stderr}.
function run(cmd, args, { cwd, env, input, onLine, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const full = { ...process.env, ...env };
      for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];
      const shim = IS_WIN && /\.(cmd|bat)$/i.test(cmd) ? winShimCommand(cmd, args) : null;
      child = shim
        ? spawn(shim.cmd, shim.args, { cwd, env: full, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: true, windowsHide: true })
        : spawn(cmd, args, { cwd, env: full, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
    // Aborting stops the process: SIGTERM first so it can save its work, SIGKILL if it hangs on.
    // Once it has exited, a stray grandchild still holding its output open doesn't keep the run going.
    let aborted = false;
    const stop = () => {
      aborted = true;
      // Windows has no SIGTERM, and stopping cmd.exe would leave the shim's own process running.
      if (IS_WIN) { try { spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }); } catch {} return; }
      child.kill('SIGTERM');
      const t = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
      if (t.unref) t.unref();
    };
    child.on('exit', () => {
      if (!aborted) return;
      const t = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 1000);
      if (t.unref) t.unref();
    });
    if (signal) { if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }); }
    child.stdin.on('error', () => {}); // a process stopped early closes stdin before it was written
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

// Linux: Chromium keeps saved keys in the desktop's keyring when it recognises the desktop (GNOME,
// XFCE, KDE...) and with its own built-in key when it doesn't. A recognised desktop whose keyring isn't
// running leaves encryption unavailable, so no key could be saved at all. True when D-Bus has neither
// the Secret Service (GNOME Keyring, KeePassXC) nor KWallet, running or startable, or there is no
// session bus; false when it can't tell (no dbus-send), which leaves the choice to Chromium.
function dbusNames() {
  const call = (m) => execFileSync('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', `org.freedesktop.DBus.${m}`], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  return call('ListNames') + call('ListActivatableNames');
}
function keyringMissing({ platform = process.platform, listNames = dbusNames } = {}) {
  if (platform !== 'linux') return false;
  let names;
  try { names = listNames(); } catch (e) { return Number.isInteger(e.status) && e.status !== 0; }
  return !/"(org\.freedesktop\.secrets|org\.kde\.kwalletd\d*)"/.test(names);
}

// How agents start Switchboard's MCP server (`sb mcp`): the sb script on macOS and Linux. On Windows
// sb.cmd is for terminals; MCP clients can't start a .cmd without a shell, so they run Switchboard's
// own executable as Node instead.
function sbLauncher({ platform = process.platform } = {}) {
  const win = platform === 'win32';
  const sb = path.join(APP_DIR, 'bin', win ? 'sb.cmd' : 'sb');
  if (!win) return { sb, command: sb, args: ['mcp'], env: {} };
  return { sb, command: process.execPath, args: [path.join(__dirname, 'cli', 'sb.cjs'), 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

module.exports = { HOME, APP_DIR, IS_MAC, IS_WIN, HERE, appDataDir, expand, exists, fixPath, which, winQuote, winShimCommand, keyringMissing, readJsonl, walk, truncate, plain, uid, run, pool, sbLauncher };
