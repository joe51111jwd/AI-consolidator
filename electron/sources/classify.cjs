'use strict';
// Sorts agent sessions by where they ran: "coding" (a repo or project folder), "desktop" (a chat
// started from the Claude desktop app's Code tab without a folder: it runs in the app's
// scratch-workspaces folder) or "chat", and flags throwaway ones (temp and test folders) as noise
// so the board can leave them out.
const os = require('os');
const path = require('path');
const { HOME, appDataDir, exists } = require('../util.cjs');

// macOS reports /private/var/... and /var/... for the same folder, so compare without /private.
const strip = (p) => p.replace(/^\/private(?=\/(var|tmp)(\/|$))/, '');
const norm = (p) => strip(path.resolve(p));
const under = (p, base) => p === base || p.startsWith(base.endsWith(path.sep) ? base : base + path.sep);

const HOME_N = norm(HOME);
const TEMP = [...new Set([os.tmpdir(), '/var/folders', '/tmp'].map(norm))];
const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Cargo.toml', 'go.mod', 'Gemfile', 'pom.xml', 'build.gradle', 'Package.swift', 'composer.json', 'deno.json', 'CMakeLists.txt', 'Makefile'];
const CODE_ROOTS = new Set(['code', 'projects', 'dev', 'src', 'repos', 'developer', 'github', 'git', 'workspace', 'workspaces', 'sites']);
const DESKTOP_SCRATCH = norm(path.join(appDataDir(), 'Claude', 'scratch-workspaces'));
const TEST_DIRS = /[/\\](switchboard-e2e(-[0-9]+)?|switchboard-demo)([/\\]|$)/;
const memo = new Map(); // cwd -> { at, coding }

function isDesktopChat(cwd) {
  return !!cwd && under(norm(cwd), DESKTOP_SCRATCH);
}

// Anything under the home folder is real work (the e2e and demo runs use a temp folder as HOME, so
// their seeded sessions stay visible); outside it, temp and test folders are throwaway. Windows keeps
// its temp folder inside the home folder (AppData\Local\Temp), which is throwaway all the same.
const TEMP_IN_HOME = TEMP.filter((t) => under(t, HOME_N) && t !== HOME_N);
function isNoise(cwd) {
  if (!cwd) return false;
  const p = norm(cwd);
  if (TEMP_IN_HOME.some((t) => under(p, t))) return true;
  if (under(p, HOME_N)) return false;
  return TEST_DIRS.test(p) || TEMP.some((t) => under(p, t));
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
  if (isDesktopChat(cwd)) return 'desktop';
  if (gitBranch && gitBranch !== 'HEAD') return 'coding';
  const hit = memo.get(cwd);
  if (hit && Date.now() - hit.at < 600000) return hit.coding ? 'coding' : 'chat';
  const coding = looksLikeProject(cwd);
  memo.set(cwd, { at: Date.now(), coding });
  return coding ? 'coding' : 'chat';
}

const CATEGORY_LABEL = { coding: 'Coding', chat: 'Chat', desktop: 'Claude app' };

module.exports = { isNoise, isDesktopChat, category, CATEGORY_LABEL };
