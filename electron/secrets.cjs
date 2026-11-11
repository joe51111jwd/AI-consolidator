'use strict';
// API keys and tokens, encrypted with Electron safeStorage (a key kept in the macOS Keychain).
// Values never leave the main process; the window only learns whether a key is set.
//
// The Keychain is only touched asynchronously: macOS asks the owner for permission whenever the
// app's signature changes (every update of an unsigned build), and the old synchronous calls froze
// the whole app (no syncing, no quitting) until that prompt was answered. warm() decrypts every
// saved secret once, in the background, into memory; get() reads that copy.
const { safeStorage } = require('electron');
const db = require('./db.cjs');

const cache = new Map();
let warmed = false;
let warming = null;

function warm() {
  if (warming) return warming;
  warming = (async () => {
    for (const r of db.all('SELECT key, value FROM secrets')) {
      if (cache.has(r.key)) continue;
      try { cache.set(r.key, (await safeStorage.decryptStringAsync(Buffer.from(r.value))).result); } catch {}
    }
    warmed = true;
  })();
  return warming;
}

function set(key, value) {
  if (!value) { cache.delete(key); db.exec('DELETE FROM secrets WHERE key = ?', key); return; }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Keychain encryption is not available');
  const v = String(value);
  cache.set(key, v);
  safeStorage.encryptStringAsync(v)
    .then((enc) => { if (cache.get(key) === v) db.exec('INSERT INTO secrets(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, enc); })
    .catch((e) => console.error('secrets: could not save', key, e.message));
}

// Null until warm() has finished, so callers simply skip work that needs a token until then.
function get(key) {
  if (cache.has(key)) return cache.get(key);
  return null;
}
function has(key) { return cache.has(key) || !!db.get('SELECT 1 AS x FROM secrets WHERE key = ?', key); }
const ready = () => warmed;

module.exports = { set, get, has, warm, ready };
