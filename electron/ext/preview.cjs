'use strict';
// Preview mode: open a second copy of the app on sample data (scripts/preview-data) so the owner's
// real window stays as it is, and keep the preview's "running" chats looking live.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow } = require('electron');
const util = require('../util.cjs');

const isPreview = process.env.SB_PREVIEW === '1';
const TITLE = 'Switchboard — Preview (sample data)';

function openPreview() {
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), '--preview'];
  const env = { ...process.env, SB_PREVIEW: '1' };
  delete env.SB_USER_DATA; delete env.SB_DB; delete env.SB_PORT;
  const child = spawn(process.execPath, args, { env, detached: true, stdio: 'ignore' });
  child.unref();
  return true;
}

function keepAlive() {
  let files = [];
  try { files = JSON.parse(fs.readFileSync(path.join(util.APP_DIR, 'preview-running.json'), 'utf8')); } catch { return; }
  const touch = () => { const t = Date.now() / 1000; for (const f of files) try { fs.utimesSync(f, t, t); } catch {} };
  touch();
  setInterval(touch, 30000);
}

function start() {
  if (!isPreview) return;
  for (const w of BrowserWindow.getAllWindows()) {
    w.setTitle(TITLE);
    w.on('page-title-updated', (e) => { e.preventDefault(); w.setTitle(TITLE); });
  }
  keepAlive();
}

module.exports = {
  handlers: {
    'preview:open': () => openPreview(),
    'app:isPreview': () => isPreview,
  },
  start,
};
