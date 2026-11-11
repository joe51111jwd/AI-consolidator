'use strict';
// Folders for the New chat sheet: the ones this week's sessions ran in, and a native picker.
const path = require('path');
const os = require('os');
const hub = require('../hub.cjs');

const WEEK = 7 * 86400000;

async function recent() {
  const since = Date.now() - WEEK;
  const home = os.homedir();
  const by = new Map();
  for (const e of await hub.entities()) {
    const cwd = e.kind === 'session' && e.meta && e.meta.cwd;
    if (!cwd || cwd === home || e.meta.noise || e.meta.category === 'desktop' || e.updatedAt < since) continue;
    by.set(cwd, Math.max(by.get(cwd) || 0, e.updatedAt));
  }
  return [...by].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([p, lastUsed]) => ({ path: p, name: path.basename(p), lastUsed }));
}

async function pick() {
  const { dialog, BrowserWindow } = require('electron');
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  return { path: p, name: path.basename(p), lastUsed: Date.now() };
}

module.exports = { handlers: { 'folders:recent': recent, 'folders:pick': pick } };
