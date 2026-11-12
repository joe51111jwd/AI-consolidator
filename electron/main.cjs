'use strict';
const { app, BrowserWindow, ipcMain, shell, nativeTheme, Menu } = require('electron');
// Preview mode (SB_PREVIEW=1 or --preview): sample data in its own home folder, stub CLIs, no real
// Claude/Grok/Google. Must run before util.cjs, which reads HOME when it loads.
if (process.env.SB_PREVIEW === '1' || process.argv.includes('--preview')) require('../scripts/preview-data/preview-env.cjs').enter(app);
// macOS ignores $HOME for Electron's profile folder, so tests and sandboxes pass their own.
if (process.env.SB_USER_DATA) app.setPath('userData', process.env.SB_USER_DATA);
// Opening Switchboard again on Linux or Windows brings the open window forward instead of starting a
// second copy on the same database and port (macOS does this by itself). One lock per profile folder.
if (process.platform !== 'darwin' && !app.requestSingleInstanceLock()) {
  console.log('Switchboard is already open; bringing its window forward.');
  app.quit();
  return;
}
const fs = require('fs');
const path = require('path');
const util = require('./util.cjs');

util.fixPath();
// Linux on a desktop whose keyring isn't running: use Chromium's built-in key (decided before the app
// is ready, when Chromium picks where keys go), so sign-ins can still be saved. See keyringMissing.
if (process.platform === 'linux' && !app.commandLine.hasSwitch('password-store') && util.keyringMissing()) app.commandLine.appendSwitch('password-store', 'basic');
// Windows shows notifications only for an app whose ID matches its Start menu shortcut, which the
// installer gives build.appId from package.json (electron-builder leaves `build` out of the app's copy).
if (util.IS_WIN) app.setAppUserModelId('com.switchboard.desktop');
const db = require('./db.cjs');
db.open(process.env.SB_DB || undefined);
const hub = require('./hub.cjs');
const bus = require('./bus.cjs');
const claudeCode = require('./sources/claudeCode.cjs');

let win;
const isDev = !!process.env.SB_DEV;

// macOS: the board runs under the traffic lights (hiddenInset). Linux and Windows: the normal window
// frame, with the menu bar hidden until Alt is pressed (the app has its own top bar).
const chrome = util.IS_MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } } : { autoHideMenuBar: true };

function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 940, minWidth: 980, minHeight: 640,
    title: `Switchboard v${app.getVersion().split('.').slice(0, 2).join('.')}`, backgroundColor: '#FFFFFF',
    ...chrome,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false, nodeIntegration: false },
  });
  if (isDev) win.loadURL('http://localhost:5173');
  else win.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'));
  if (process.env.SB_LOG) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.level || '', e.message));
    win.webContents.on('did-fail-load', (_e, code, desc, url) => console.log('[load failed]', code, desc, url));
    win.webContents.on('render-process-gone', (_e, d) => console.log('[renderer gone]', d.reason));
  }
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:') && !url.startsWith('http://localhost:5173')) { e.preventDefault(); shell.openExternal(url); } });
  if (process.env.SB_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const shots = process.env.SB_SCREENSHOT.split(',');
      for (let i = 0; i < shots.length; i++) {
        if (i > 0) { await win.webContents.executeJavaScript(`window.__sbScene && window.__sbScene(${i})`); await new Promise((r) => setTimeout(r, 1800)); }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(shots[i], img.toPNG());
      }
      app.quit();
    }, Number(process.env.SB_SCREENSHOT_DELAY || 4000)));
  }
}

const send = (e) => { if (win && !win.isDestroyed()) win.webContents.send('sb:event', e); };
hub.events.on('event', send);

// Watch session folders so the board updates live.
let watchers = [];
let pending = null;
function watchSources() {
  for (const w of watchers) try { w.close(); } catch {}
  watchers = [];
  const dirs = [];
  for (const a of hub.accounts()) {
    if (a.kind === 'claude-code') dirs.push(path.join(claudeCode.configDir(a), 'projects'));
    if (a.kind === 'codex') dirs.push(path.join(util.expand(a.config.home || '~/.codex'), 'sessions'));
    if (a.kind === 'granola') dirs.push(require('./sources/granola.cjs').DEFAULT_DIR);
  }
  for (const d of dirs) {
    if (!util.exists(d)) continue;
    try {
      watchers.push(fs.watch(d, { recursive: true }, () => {
        clearTimeout(pending);
        pending = setTimeout(() => { hub.invalidate(); send({ type: 'entities-changed' }); }, 700);
      }));
    } catch {}
  }
}

// The `sb` command for terminals and agents: a shell script, or sb.cmd on Windows. Both run
// electron/cli/sb.cjs with Switchboard's own executable acting as Node.
function installCli() {
  const target = util.sbLauncher().sb;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const cli = path.join(__dirname, 'cli', 'sb.cjs');
  if (util.IS_WIN) {
    fs.writeFileSync(target, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${cli}" %*\r\n`);
    return target;
  }
  fs.writeFileSync(target, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 });
  return target;
}

async function addMcpToAgents() {
  installCli();
  const sb = util.sbLauncher();
  const env = (flag, a) => Object.entries({ SB_FROM: `ac:${a.id}`, ...sb.env }).flatMap(([k, v]) => [flag, `${k}=${v}`]);
  const results = [];
  for (const a of hub.accounts()) {
    if (a.kind === 'claude-code') {
      const bin = a.config.bin || util.which('claude'); if (!bin) { results.push(`${a.label}: claude command not found`); continue; }
      const childEnv = claudeCode.childEnv(a);
      // Rewriting ~/.claude.json while sessions run is risky, so only touch it when the entry is missing or stale.
      const have = await util.run(bin, ['mcp', 'get', 'switchboard'], { env: childEnv }).catch(() => ({ code: 1, stdout: '' }));
      if (have.code === 0 && (have.stdout || '').includes(sb.command) && (have.stdout || '').includes(`ac:${a.id}`)) { results.push(`${a.label}: already added`); continue; }
      if (have.code === 0) await util.run(bin, ['mcp', 'remove', '--scope', 'user', 'switchboard'], { env: childEnv }).catch(() => {});
      const r = await util.run(bin, ['mcp', 'add', '--scope', 'user', 'switchboard', ...env('-e', a), '--', sb.command, ...sb.args], { env: childEnv });
      results.push(`${a.label}: ${r.code === 0 ? 'added' : util.truncate(r.stderr || r.stdout, 120)}`);
    }
    if (a.kind === 'codex') {
      const bin = util.which('codex'); if (!bin) { results.push(`${a.label}: codex command not found`); continue; }
      const r = await util.run(bin, ['mcp', 'add', 'switchboard', ...env('--env', a), '--', sb.command, ...sb.args]);
      results.push(`${a.label}: ${r.code === 0 ? 'added' : util.truncate(r.stderr || r.stdout, 120)}`);
    }
  }
  return { sb: sb.sb, results };
}

// macOS opens Terminal with the command typed in; elsewhere the window shows the command to run
// (PowerShell's syntax on Windows).
function openLoginTerminal(accountId) {
  const a = hub.account(accountId);
  if (!a || a.kind !== 'claude-code') return;
  const dir = claudeCode.configDir(a);
  fs.mkdirSync(dir, { recursive: true });
  if (util.IS_WIN) return `$env:CLAUDE_CONFIG_DIR='${dir.replace(/'/g, "''")}'; claude`;
  const cmd = `CLAUDE_CONFIG_DIR='${dir}' claude`;
  if (util.IS_MAC) util.run('osascript', ['-e', `tell application "Terminal" to do script "${cmd.replace(/"/g, '\\"')}"`, '-e', 'tell application "Terminal" to activate']);
  return cmd;
}

const handlers = {
  'entities': (opts) => hub.entities(opts),
  'transcript': (id) => hub.transcriptFor(id),
  'prompt': (id, text, opts) => hub.prompt(id, text, opts),
  'runs': () => [...hub.runs.values()].filter((r) => Date.now() - r.startedAt < 3600000),
  'accounts': () => hub.accounts().map(hub.publicAccount),
  'account:save': (a) => { const id = hub.saveAccount(a); watchSources(); return id; },
  'account:delete': (id) => { hub.deleteAccount(id); watchSources(); },
  'account:login': (id) => openLoginTerminal(id),
  'claude:status': (id) => hub.claudeStatus(id),
  'claude:login': (id, opts) => hub.claudeLogin(id, opts),
  'claude:loginCancel': (id) => hub.claudeLoginCancel(id),
  'claude:logout': (id) => hub.claudeLogout(id),
  'account:detect': () => ({ claude: claudeCode.detect() }),
  'gmail:connect': (id) => hub.gmailConnect(id),
  'board': () => hub.board(),
  'board:save': (nodes) => hub.saveBoard(nodes),
  'board:delete': (ids) => hub.deleteBoardNodes(ids),
  'edges': () => hub.edges(),
  'edge:save': (e) => hub.saveEdge(e),
  'edge:delete': (id) => hub.deleteEdge(id),
  'flows': (id) => hub.flowsFor(id),
  'flow:record': (s, t, text) => hub.recordFlow(s, t, text, 'drag'),
  'output:save': (o) => hub.saveOutput(o),
  'note:save': (n) => hub.saveNote(n),
  'entity:delete': (id) => hub.deleteEntity(id),
  'brain': () => hub.brain(),
  'brain:set': (t) => hub.setBrain(t),
  'brain:append': (t, from) => hub.appendBrain(t, from),
  'brain:path': () => hub.BRAIN,
  'clients': () => hub.clients(),
  'client:save': (c) => hub.saveClient(c),
  'due': () => hub.due(),
  'suggestions': () => hub.suggestions(),
  'usage': () => hub.usageSummary(),
  'chief': (q, opts) => hub.chief(q, opts),
  'chief:history': () => hub.chiefHistory(),
  'settings:get': (k, d) => db.getSetting(k, d),
  'settings:set': (k, v) => db.setSetting(k, v),
  'cli:install': () => installCli(),
  'mcp:install': () => addMcpToAgents(),
  'bus:info': () => ({ tokenFile: bus.TOKEN_FILE, port: (() => { try { return fs.readFileSync(bus.PORT_FILE, 'utf8'); } catch { return null; } })() }),
  'open:external': (url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); },
  'open:path': (p) => shell.openPath(p),
  'clipboard': (t) => require('electron').clipboard.writeText(t),
  'secrets:where': () => require('./secrets.cjs').where(),
};
// Feature modules in electron/ext/*.cjs each export { handlers, start? } and plug in here.
const extDir = path.join(__dirname, 'ext');
const exts = fs.existsSync(extDir) ? fs.readdirSync(extDir).filter((f) => f.endsWith('.cjs')).sort().map((f) => { try { return require(path.join(extDir, f)); } catch (e) { console.error(`ext ${f} failed to load:`, e.message); return {}; } }) : [];
for (const x of exts) Object.assign(handlers, x.handlers || {});
for (const [ch, fn] of Object.entries(handlers)) {
  ipcMain.handle('sb:' + ch, async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) }; } catch (err) { return { ok: false, error: err.message }; }
  });
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'light';
  // macOS always has the Keychain and Windows DPAPI. On Linux without a desktop keyring (no GNOME
  // Keyring or KWallet running) fall back to Electron's built-in key, so sign-ins can still be saved.
  const { safeStorage } = require('electron');
  if (process.platform === 'linux' && !safeStorage.isEncryptionAvailable()) safeStorage.setUsePlainTextEncryption(true);
  // Saved sign-ins are read in the background (macOS may ask for the Keychain first); work that
  // needs a token picks up once they are in, and nothing waits on the prompt.
  const secrets = require('./secrets.cjs');
  const unreadable = util.IS_MAC
    ? "Switchboard couldn't read your saved sign-ins. Allow it in the Keychain prompt; it will try again in a minute."
    : "Switchboard couldn't read your saved sign-ins. It will try again in a minute; if it keeps happening, unlock your keyring or sign in again in Settings.";
  secrets.onUnreadable(() => send({ type: 'toast', text: unreadable }));
  secrets.warm().then(() => { hub.invalidate(); send({ type: 'entities-changed' }); }).catch((e) => console.error('secrets:', e.message));
  hub.firstRunSetup();
  bus.start(Number(process.env.SB_PORT || 47821));
  try { installCli(); } catch {}
  watchSources();
  const viewMenu = { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] };
  // Linux and Windows get the same short menu instead of Electron's default one, whose Ctrl+W would
  // close the board.
  Menu.setApplicationMenu(Menu.buildFromTemplate(util.IS_MAC
    ? [{ role: 'appMenu' }, { role: 'editMenu' }, viewMenu, { role: 'windowMenu' }]
    : [{ role: 'editMenu' }, viewMenu, { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'quit' }] }]));
  createWindow();
  for (const x of exts) { try { x.start && x.start({ hub, db, send }); } catch (e) { console.error('ext start', e.message); } }
  setInterval(() => { hub.invalidate(); send({ type: 'entities-changed' }); }, 30000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on('second-instance', () => { if (!win || win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// A token saved a moment ago may still be encrypting: let it reach the database before quitting.
let flushed = false;
app.on('before-quit', (e) => {
  if (flushed) return;
  e.preventDefault();
  flushed = true;
  require('./secrets.cjs').flush().finally(() => app.quit());
});
