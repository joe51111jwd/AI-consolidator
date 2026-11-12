'use strict';
// Switches this process into Preview mode before anything reads HOME: a sample-data home under
// <appData>/Switchboard Preview (~/Library/Application Support on macOS), its own Electron profile,
// the stub `claude` and `codex` from tests/fixtures/bin first on PATH, and Grok/Google links logged
// instead of opened.
const fs = require('fs');
const path = require('path');

const STUBS = { claude: path.join(__dirname, 'bin', 'claude'), codex: path.join(__dirname, '..', '..', 'tests', 'fixtures', 'bin', 'codex') };

// The stubs are Node scripts. Small launchers run them with this app's own executable as Node, so
// the preview works without Node installed, and on Windows, which can't run a script by its #! line.
function launchers(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, stub] of Object.entries(STUBS)) {
    if (process.platform === 'win32') fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${stub}" %*\r\n`);
    else fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${stub}" "$@"\n`, { mode: 0o755 });
  }
  return dir;
}

function enter(app) {
  const ROOT = path.join(app.getPath('appData'), 'Switchboard Preview');
  const HOME = path.join(ROOT, 'home');
  process.env.SB_PREVIEW = '1';
  process.env.HOME = HOME;
  // Where the sample Granola and Grok Bot data is read from (see appDataDir in electron/util.cjs).
  if (process.platform === 'win32') Object.assign(process.env, { USERPROFILE: HOME, APPDATA: path.join(HOME, 'AppData', 'Roaming') });
  if (process.platform === 'linux') process.env.XDG_CONFIG_HOME = path.join(HOME, '.config');
  process.env.SB_USER_DATA = path.join(ROOT, 'profile');
  process.env.PATH = [launchers(path.join(ROOT, 'bin')), process.env.PATH || ''].join(path.delimiter);
  process.env.SB_TEST_OPEN_LOG = path.join(ROOT, 'opened.log');
  process.env.SB_TEST_ACCESSIBILITY = '0';
  process.env.SB_GOOGLE_AUTH_URL = 'http://127.0.0.1:9/auth';
  process.env.SB_GOOGLE_TOKEN_URL = 'http://127.0.0.1:9/token';
  process.env.SB_GMAIL_API_URL = 'http://127.0.0.1:9/gmail';
  process.env.SB_PORT = process.env.SB_PORT || '47898';
  delete process.env.CLAUDE_CONFIG_DIR;
  // Re-seeded on every launch so timestamps stay relative to now and the running chats look live.
  require('./seed-preview.cjs').seedPreview(HOME);
  if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
}

module.exports = { enter };
