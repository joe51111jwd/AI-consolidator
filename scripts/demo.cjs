#!/usr/bin/env node
'use strict';
// Opens the app with made-up sample data, in a throwaway home folder, so you can try it
// without touching your real accounts. Run: npm run demo
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const HOME = path.join(os.tmpdir(), 'switchboard-demo');
process.env.HOME = HOME;
require('./seed.cjs').seed(HOME);
const electron = require('electron');
// The demo's made-up accounts must never touch your real Keychain (and macOS would ask for access).
const flags = process.platform === 'darwin' ? ['--use-mock-keychain'] : [];
const child = spawn(electron, [...flags, path.join(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, HOME, SB_PORT: process.env.SB_PORT || '47899' } });
child.on('exit', (c) => process.exit(c || 0));
