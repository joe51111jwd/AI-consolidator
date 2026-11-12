#!/usr/bin/env node
'use strict';
// Opens the app with made-up sample data, in a throwaway home folder, so you can try it
// without touching your real accounts. Run: npm run demo
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const HOME = path.join(os.tmpdir(), 'switchboard-demo');
process.env.HOME = HOME;
// Windows takes the home folder from USERPROFILE and app data from APPDATA; Linux app data from XDG_CONFIG_HOME.
if (process.platform === 'win32') Object.assign(process.env, { USERPROFILE: HOME, APPDATA: path.join(HOME, 'AppData', 'Roaming') });
if (process.platform === 'linux') process.env.XDG_CONFIG_HOME = path.join(HOME, '.config');
require('./seed.cjs').seed(HOME);
const electron = require('electron');
// The demo's made-up accounts must never touch your real Keychain or keyring (and macOS would ask for access).
const flags = { darwin: ['--use-mock-keychain'], linux: ['--password-store=basic'] }[process.platform] || [];
const child = spawn(electron, [...flags, path.join(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, HOME, SB_PORT: process.env.SB_PORT || '47899' } });
child.on('exit', (c) => process.exit(c || 0));
