'use strict';
// Sorts agent sessions by where they ran: "coding" (a repo or project folder) or "chat", and flags
// throwaway ones (scratch workspaces and temp folders) as noise so the board can leave them out.
const os = require('os');
const path = require('path');
const { HOME, exists } = require('../util.cjs');

// macOS reports /private/var/... and /var/... for the same folder, so compare without /private.
const strip = (p) => p.replace(/^\/private(?=\/(var|tmp)(\/|$))/, '');
const norm = (p) => strip(path.resolve(p));
const under = (p, base) => p === base || p.startsWith(base.endsWith('/') ? base : base + '/');

const HOME_N = norm(HOME);
const TEMP = [...new Set([os.tmpdir(), '/var/folders', '/tmp'].map(norm))];
const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Cargo.toml', 'go.mod', 'Gemfile', 'pom.xml', 'build.gradle', 'Package.swift', 'composer.json', 'deno.json', 'CMakeLists.txt', 'Makefile'];
const CODE_ROOTS = new Set(['code', 'projects', 'dev', 'src', 'repos', 'developer', 'github', 'git', 'workspace', 'workspaces', 'sites']);
const memo = new Map(); // cwd -> { at, coding }

function isNoise(cwd) {
  if (!cwd) return false;
  const p = norm(cwd);
  if (p.includes('/scratch-workspaces/')) return true;
  if (under(p, HOME_N)) return false;
  return TEMP.some((t) => under(p, t));
}

function looksLikeProject(cwd) {
  const p = norm(cwd);
  if (under(p, HOME_N)) {
    const first = path.relative(HOME_N, p).split(path.sep);
    if (first.length >= 2 && CODE_ROOTS.has(first[0].toLowerCase())) return true;
  }
  let dir = path.resolve(cwd);
  for (let i = 0; i < 8; i++) {
    if (norm(dir) === HOME_N) return false;
    if (MARKERS.some((m) => exists(path.join(dir, m)))) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
  return false;
}

function category(cwd, gitBranch) {
  if (!cwd || norm(cwd) === HOME_N) return 'chat';
  if (gitBranch && gitBranch !== 'HEAD') return 'coding';
  const hit = memo.get(cwd);
  if (hit && Date.now() - hit.at < 600000) return hit.coding ? 'coding' : 'chat';
  const coding = looksLikeProject(cwd);
  memo.set(cwd, { at: Date.now(), coding });
  return coding ? 'coding' : 'chat';
}

module.exports = { isNoise, category };
