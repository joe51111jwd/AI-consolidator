'use strict';
// node --test tests/*.test.cjs — where Switchboard looks for things on macOS, Linux and Windows
// (electron/util.cjs): other apps' data folders, commands on PATH, starting npm's .cmd shims through
// cmd.exe, and how agents start `sb mcp`. Every platform is checked on whichever one runs the tests.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-platform-home-'));
process.env.HOME = HOME; // before util.cjs reads the home folder
process.env.USERPROFILE = HOME;
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const util = require(path.join(__dirname, '..', 'electron', 'util.cjs'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

test('app data lives in Application Support on macOS, ~/.config on Linux and AppData\\Roaming on Windows', () => {
  const h = path.join(HOME, 'someone');
  assert.equal(util.appDataDir(h, { platform: 'darwin' }), path.join(h, 'Library', 'Application Support'));
  assert.equal(util.appDataDir(h, { platform: 'linux' }), path.join(h, '.config'));
  assert.equal(util.appDataDir(h, { platform: 'win32' }), path.join(h, 'AppData', 'Roaming'));
});

test('app data follows XDG_CONFIG_HOME and APPDATA, but not for a home folder given explicitly', () => {
  const env = { XDG_CONFIG_HOME: '/cfg', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' };
  assert.equal(util.appDataDir(undefined, { platform: 'linux', env }), '/cfg');
  assert.equal(util.appDataDir(undefined, { platform: 'win32', env }), env.APPDATA);
  assert.equal(util.appDataDir(undefined, { platform: 'linux', env: {} }), path.join(HOME, '.config'));
  assert.equal(util.appDataDir(undefined, { platform: 'darwin', env }), path.join(HOME, 'Library', 'Application Support'));
  assert.equal(util.appDataDir(path.join(HOME, 'test-home'), { platform: 'linux', env }), path.join(HOME, 'test-home', '.config'));
});

function binDir(files) {
  const dir = fs.mkdtempSync(path.join(HOME, 'bin-'));
  for (const f of files) fs.writeFileSync(path.join(dir, f), '', { mode: 0o755 });
  return dir;
}

test('which finds a command on PATH on macOS and Linux', () => {
  const dir = binDir(['claude']);
  fs.mkdirSync(path.join(dir, 'codex'));
  const env = { PATH: ['/nowhere', dir].join(':') };
  assert.equal(util.which('claude', { platform: 'linux', env }), path.join(dir, 'claude'));
  assert.equal(util.which('codex', { platform: 'linux', env }), null, 'a folder with the name is not a command');
  assert.equal(util.which('gemini', { platform: 'linux', env }), null);
});

test("which on Windows takes npm's claude.cmd, never the extensionless shell script beside it", () => {
  const dir = binDir(['claude', 'claude.cmd', 'claude.ps1', 'codex.exe']);
  const env = { PATH: ['C:\\nowhere', dir].join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(util.which('claude', { platform: 'win32', env }), path.join(dir, 'claude.cmd'));
  assert.equal(util.which('codex', { platform: 'win32', env }), path.join(dir, 'codex.exe'));
  assert.equal(util.which('claude.cmd', { platform: 'win32', env }), path.join(dir, 'claude.cmd'), 'a name with its extension is taken as is');
  assert.equal(util.which('claude', { platform: 'win32', env: { PATH: dir } }), path.join(dir, 'claude.cmd'), 'PATHEXT has a default');
});

test('arguments to a .cmd shim are quoted and escaped twice for cmd.exe, as cross-spawn does', () => {
  assert.equal(util.winQuote('hello'), '^^^"hello^^^"');
  assert.equal(util.winQuote('a "b" c\\'), '^^^"a^^^ \\^^^"b\\^^^"^^^ c\\\\^^^"');
  assert.equal(util.winQuote('50% & more | less'), '^^^"50^^^%^^^ ^^^&^^^ more^^^ ^^^|^^^ less^^^"');
  const c = util.winShimCommand('C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd', ['mcp', 'add', '{"a":1}']);
  assert.deepEqual(c.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.ok(c.args[3].startsWith('"') && c.args[3].endsWith('"'), 'the whole line is quoted once more for /s');
  assert.ok(c.args[3].includes('^^^"mcp^^^"') && c.args[3].includes('^^^"{\\^^^"a\\^^^":1}^^^"'), c.args[3]);
});

test('Linux falls back to the built-in key only when D-Bus has no keyring, or no session bus at all', () => {
  const names = (...n) => () => `method return\n   array [\n${n.map((x) => `      string "${x}"`).join('\n')}\n   ]\n`;
  const fails = (props) => () => { throw Object.assign(new Error('dbus-send failed'), props); };
  const missing = (listNames) => util.keyringMissing({ platform: 'linux', listNames });
  assert.equal(missing(names('org.freedesktop.DBus', ':1.4', 'org.freedesktop.secrets')), false, 'GNOME Keyring or KeePassXC');
  assert.equal(missing(names('org.freedesktop.DBus', 'org.kde.kwalletd6')), false, 'KWallet');
  assert.equal(missing(names('org.freedesktop.DBus', ':1.4', 'org.freedesktop.Notifications')), true, 'a bus without a keyring');
  assert.equal(missing(fails({ status: 1 })), true, 'no session bus to talk to');
  assert.equal(missing(fails({ code: 'ENOENT' })), false, 'no dbus-send: leave it to Chromium');
  assert.equal(missing(fails({ status: null, signal: 'SIGTERM' })), false, 'a bus too slow to answer: leave it to Chromium');
  assert.equal(util.keyringMissing({ platform: 'darwin', listNames: names() }), false, 'macOS has the Keychain');
  assert.equal(util.keyringMissing({ platform: 'win32', listNames: names() }), false, 'Windows has DPAPI');
});

test('agents start sb mcp with the sb script, or on Windows with Switchboard itself as Node', () => {
  const posix = util.sbLauncher({ platform: 'linux' });
  assert.equal(posix.sb, path.join(util.APP_DIR, 'bin', 'sb'));
  assert.deepEqual([posix.command, posix.args, posix.env], [posix.sb, ['mcp'], {}]);
  const win = util.sbLauncher({ platform: 'win32' });
  assert.equal(win.sb, path.join(util.APP_DIR, 'bin', 'sb.cmd'));
  assert.equal(win.command, process.execPath);
  assert.deepEqual(win.args, [path.join(__dirname, '..', 'electron', 'cli', 'sb.cjs'), 'mcp']);
  assert.deepEqual(win.env, { ELECTRON_RUN_AS_NODE: '1' });
});
