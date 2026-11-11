#!/usr/bin/env node
'use strict';
// Rebuilds the renderer for the tests only when a source file is newer than the last build.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist-renderer', 'index.html');

function newest(p) {
  let st;
  try { st = fs.statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.mtimeMs;
  return fs.readdirSync(p).reduce((m, n) => Math.max(m, newest(path.join(p, n))), st.mtimeMs);
}

let built = 0;
try { built = fs.statSync(OUT).mtimeMs; } catch {}
const sources = Math.max(newest(path.join(ROOT, 'renderer')), newest(path.join(ROOT, 'vite.config.mjs')), newest(path.join(ROOT, 'package-lock.json')));
if (built && built > sources) {
  console.log('Renderer build is up to date.');
} else {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.config.mjs', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
}
