#!/usr/bin/env node
'use strict';
// Smoke test for a built app: opens it on an empty, throwaway home folder and checks that
// - the window loads and shows its version tag in the bottom-right corner,
// - the board's tools never sit on top of the search and Board | List buttons, at any window width,
// - a key saved with safeStorage (Keychain, Windows DPAPI, a Linux keyring or Electron's own key)
//   is still readable after a restart,
// - nothing logged an error.
//
//   node tests/smoke.cjs                       this checkout (run `npm run build` first)
//   node tests/smoke.cjs <app executable>      a packaged app (Switchboard.exe, an AppImage, ...)
//
// On Linux without a screen: xvfb-run -a -s "-screen 0 1920x1080x24" node tests/smoke.cjs ...
// SB_SMOKE_DESKTOP=GNOME pretends to be a desktop whose keyring is missing (no D-Bus session).
// SB_SMOKE_SHOT=<file.png> keeps a screenshot of the window.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const exe = process.argv[2] ? path.resolve(process.argv[2]) : null;
const want = `v${require('../package.json').version.split('.').slice(0, 2).join('.')}`;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-smoke-'));
// Lines the app itself prints when something it loads or starts breaks.
const BAD = /failed to load|ext start|Uncaught|TypeError|ReferenceError|SyntaxError|Cannot find module|secrets:/;
const problems = [];
const out = [];

async function launch() {
  const env = {
    ...process.env, HOME, USERPROFILE: HOME, APPDATA: path.join(HOME, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(HOME, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(HOME, '.config'), SB_USER_DATA: path.join(HOME, 'electron-profile'), SB_PORT: String(48900 + (process.pid % 900)),
    APPIMAGE_EXTRACT_AND_RUN: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.SB_SMOKE_DESKTOP) { env.XDG_CURRENT_DESKTOP = process.env.SB_SMOKE_DESKTOP; delete env.DBUS_SESSION_BUS_ADDRESS; }
  const args = exe ? [] : [ROOT];
  // A packaged app starts as a user would start it: the AppImage turns the sandbox off by itself
  // where Linux doesn't allow it, and the deb installs an AppArmor profile. node_modules' Electron
  // has neither.
  if (process.platform === 'linux' && !exe) args.unshift('--no-sandbox');
  if (process.platform === 'darwin') args.unshift('--use-mock-keychain');
  const app = await _electron.launch({ executablePath: exe || require('electron'), args, env, timeout: 90000 });
  for (const s of [app.process().stdout, app.process().stderr]) s.on('data', (d) => out.push(...String(d).split('\n').filter(Boolean)));
  const page = await app.firstWindow({ timeout: 90000 });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  await page.getByTestId('version-tag').waitFor({ state: 'visible', timeout: 60000 });
  return { app, page };
}

// Runs electron/secrets.cjs in the app's main process: the same module instance the app uses.
function secrets(app, op, key, value) {
  return app.evaluate(async ({ app: electronApp, safeStorage }, [op, key, value]) => {
    const { createRequire } = process.getBuiltinModule('module');
    const { join } = process.getBuiltinModule('path');
    const s = createRequire(join(electronApp.getAppPath(), 'electron', 'main.cjs'))('./secrets.cjs');
    if (op === 'set') { await s.set(key, value); await s.flush(); }
    if (op === 'get') await s.warm();
    return { value: s.get(key), saved: s.has(key), where: s.where(), backend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null };
  }, [op, key, value]);
}

async function checkVersionTag(page) {
  const tag = page.getByTestId('version-tag');
  const text = (await tag.innerText()).trim();
  if (text !== want) problems.push(`the version tag says "${text}", not "${want}"`);
  const box = await tag.boundingBox();
  const vp = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  if (!box || box.x < vp.width / 2 || box.y < vp.height / 2) problems.push(`the version tag is not in the bottom-right corner (${JSON.stringify(box)} in ${vp.width}×${vp.height})`);
  console.log(`Window "${await page.title()}" (${vp.width}×${vp.height}) shows ${text} in the bottom-right corner.`);
}

// The board tools (centred in the top bar on wide windows, below it on narrow ones) must not cover
// the search pill or Board | List.
async function checkTopBar(app, page) {
  for (const width of [null, 1440, 1366, 1280, 1190, 1100]) {
    if (width) {
      await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w, 900), width);
      await page.waitForFunction((w) => Math.abs(window.outerWidth - w) < 40 || window.innerWidth < w, width, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
    const hit = await page.evaluate(() => {
      const tools = document.querySelector('.board-tools');
      if (!tools) return null;
      const t = tools.getBoundingClientRect();
      for (const sel of ['.tl-pill', '.mode-seg']) {
        const el = document.querySelector(sel); if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.left < t.right && t.left < r.right && r.top < t.bottom && t.top < r.bottom) return `${sel} [${Math.round(r.left)}–${Math.round(r.right)}] under the board tools [${Math.round(t.left)}–${Math.round(t.right)}] at ${innerWidth} px`;
      }
      return `ok at ${innerWidth} px`;
    });
    if (hit === null) problems.push('the board tools are missing');
    else if (!hit.startsWith('ok')) problems.push(hit);
    else console.log(`Top bar: nothing overlaps (${hit.slice(3)}).`);
  }
}

async function main() {
  let { app, page } = await launch();
  try {
    await checkVersionTag(page);
    if (process.env.SB_SMOKE_SHOT) await page.screenshot({ path: process.env.SB_SMOKE_SHOT });
    await checkTopBar(app, page);
    // What safeStorage reports here, for the log.
    const report = await app.evaluate(async ({ safeStorage }) => {
      const r = { backend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null, available: safeStorage.isEncryptionAvailable() };
      r.asyncAvailable = await safeStorage.isAsyncEncryptionAvailable().catch((e) => `error: ${e.message}`);
      return r;
    });
    console.log(`safeStorage: ${JSON.stringify(report)}`);
    const saved = await secrets(app, 'set', 'smoke:key', 'smoke-value-42');
    console.log(`Saved a key${saved.backend ? ` (Linux storage backend: ${saved.backend})` : ''}. Settings says: "${saved.where}"`);
    if (!saved.saved) problems.push('a saved key did not reach the database');
    // Let the start-up work (sync, background checks) run for a moment so its errors show too.
    await page.waitForTimeout(3000);
  } finally {
    await app.close().catch(() => {});
  }
  ({ app, page } = await launch());
  try {
    const read = await secrets(app, 'get', 'smoke:key');
    if (read.value !== 'smoke-value-42') problems.push(`after a restart the saved key reads as ${JSON.stringify(read.value)}`);
    else console.log('After a restart the saved key reads back unchanged.');
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  problems.push(...out.filter((l) => BAD.test(l)).map((l) => `app log: ${l}`));
  if (problems.length) {
    console.error(`Smoke test failed:\n  ${problems.join('\n  ')}\n\nApp output:\n  ${out.join('\n  ')}`);
    process.exit(1);
  }
  console.log('Smoke test passed.');
}

main().catch((e) => { console.error('Smoke test failed:', e, `\n\nApp output:\n  ${out.join('\n  ')}`); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });
