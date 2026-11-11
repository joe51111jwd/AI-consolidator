'use strict';
// Switches this process into Preview mode before anything reads HOME: a sample-data home under
// ~/Library/Application Support/Switchboard Preview, its own Electron profile, the stub `claude`
// and `codex` from tests/fixtures/bin first on PATH, and Grok/Google links logged instead of opened.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'Switchboard Preview');

function enter(app) {
  const HOME = path.join(ROOT, 'home');
  process.env.SB_PREVIEW = '1';
  process.env.HOME = HOME;
  process.env.SB_USER_DATA = path.join(ROOT, 'profile');
  process.env.PATH = [path.join(__dirname, 'bin'), path.join(__dirname, '..', '..', 'tests', 'fixtures', 'bin'), process.env.PATH || ''].join(':');
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

module.exports = { enter, ROOT };
