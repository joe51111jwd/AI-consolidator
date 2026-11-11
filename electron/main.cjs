'use strict';
const { app, BrowserWindow, ipcMain, shell, nativeTheme, Menu } = require('electron');
// macOS ignores $HOME for Electron's profile folder, so tests and sandboxes pass their own.
if (process.env.SB_USER_DATA) app.setPath('userData', process.env.SB_USER_DATA);
const fs = require('fs');
const path = require('path');
const util = require('./util.cjs');

util.fixPath();
const db = require('./db.cjs');
db.open(process.env.SB_DB || undefined);
const hub = require('./hub.cjs');
const bus = require('./bus.cjs');
const claudeCode = require('./sources/claudeCode.cjs');

let win;
const isDev = !!process.env.SB_DEV;

function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 940, minWidth: 980, minHeight: 640,
    title: `Switchboard v${app.getVersion().split('.').slice(0, 2).join('.')}`, backgroundColor: '#FFFFFF',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
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
    if (a.kind === 'codex') dirs.push(util.expand(a.config.home || '~/.codex') + '/sessions');
    if (a.kind === 'granola') dirs.push(path.join(util.HOME, 'Library', 'Application Support', 'Granola'));
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

function installCli() {
  const binDir = path.join(util.APP_DIR, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const target = path.join(binDir, 'sb');
  const script = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${path.join(__dirname, 'cli', 'sb.cjs')}" "$@"\n`;
  fs.writeFileSync(target, script, { mode: 0o755 });
  return target;
}

async function addMcpToAgents() {
  const sb = installCli();
  const results = [];
  for (const a of hub.accounts()) {
    if (a.kind === 'claude-code') {
      const bin = a.config.bin || util.which('claude'); if (!bin) { results.push(`${a.label}: claude command not found`); continue; }
      const env = claudeCode.childEnv(a);
      // Rewriting ~/.claude.json while sessions run is risky, so only touch it when the entry is missing or stale.
      const have = await util.run(bin, ['mcp', 'get', 'switchboard'], { env }).catch(() => ({ code: 1, stdout: '' }));
      if (have.code === 0 && (have.stdout || '').includes(sb) && (have.stdout || '').includes(`ac:${a.id}`)) { results.push(`${a.label}: already added`); continue; }
      if (have.code === 0) await util.run(bin, ['mcp', 'remove', '--scope', 'user', 'switchboard'], { env }).catch(() => {});
      const r = await util.run(bin, ['mcp', 'add', '--scope', 'user', 'switchboard', '-e', `SB_FROM=ac:${a.id}`, '--', sb, 'mcp'], { env });
      results.push(`${a.label}: ${r.code === 0 ? 'added' : util.truncate(r.stderr || r.stdout, 120)}`);
    }
    if (a.kind === 'codex') {
      const bin = util.which('codex'); if (!bin) { results.push(`${a.label}: codex command not found`); continue; }
      const r = await util.run(bin, ['mcp', 'add', 'switchboard', '--env', `SB_FROM=ac:${a.id}`, '--', sb, 'mcp']);
      results.push(`${a.label}: ${r.code === 0 ? 'added' : util.truncate(r.stderr || r.stdout, 120)}`);
    }
  }
  return { sb, results };
}

function openLoginTerminal(accountId) {
  const a = hub.account(accountId);
  if (!a || a.kind !== 'claude-code') return;
  const dir = claudeCode.configDir(a);
  fs.mkdirSync(dir, { recursive: true });
  const cmd = `CLAUDE_CONFIG_DIR='${dir}' claude`;
  if (process.platform === 'darwin') util.run('osascript', ['-e', `tell application "Terminal" to do script "${cmd.replace(/"/g, '\\"')}"`, '-e', 'tell application "Terminal" to activate']);
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
  // macOS always has the Keychain. On Linux without a keyring (only used for development and
  // tests) fall back to Electron's built-in key so the app still runs.
  const { safeStorage } = require('electron');
  if (process.platform === 'linux' && !safeStorage.isEncryptionAvailable()) safeStorage.setUsePlainTextEncryption(true);
  hub.firstRunSetup();
  bus.start(Number(process.env.SB_PORT || 47821));
  try { installCli(); } catch {}
  watchSources();
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]));
  }
  createWindow();
  for (const x of exts) { try { x.start && x.start({ hub, db, send }); } catch (e) { console.error('ext start', e.message); } }
  setInterval(() => { hub.invalidate(); send({ type: 'entities-changed' }); }, 30000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
