'use strict';
// API keys and tokens, encrypted with Electron safeStorage (a key kept in the macOS Keychain).
// Values never leave the main process; the window only learns whether a key is set.
//
// The Keychain is only touched asynchronously: macOS asks the owner for permission whenever the
// app's signature changes (every update of an unsigned build), and the old synchronous calls froze
// the whole app (no syncing, no quitting) until that prompt was answered. warm() decrypts every
// saved secret once, in the background, into memory; get() reads that copy. If the owner denies
// the prompt, the secrets that couldn't be read are tried again later instead of staying missing.
const { safeStorage } = require('electron');
const db = require('./db.cjs');

const cache = new Map();
const unread = new Set();   // keys saved in the db that the Keychain wouldn't decrypt yet
const writes = new Set();   // saves still being encrypted, so quitting can wait for them
const RETRY_MS = 60000;
let warming = null;
let lastWarm = 0;
let onLocked = () => {};

async function decryptAll() {
  for (const r of db.all('SELECT key, value FROM secrets')) {
    if (cache.has(r.key)) { unread.delete(r.key); continue; }
    try { cache.set(r.key, (await safeStorage.decryptStringAsync(Buffer.from(r.value))).result); unread.delete(r.key); } catch { unread.add(r.key); }
  }
  lastWarm = Date.now();
  if (unread.size) onLocked([...unread]);
}

function warm() {
  if (!warming) warming = decryptAll().finally(() => { warming = null; });
  return warming;
}

// Called when saved sign-ins can't be read (the Keychain prompt was denied or dismissed).
function onUnreadable(fn) { onLocked = fn; }

function set(key, value) {
  if (!value) { cache.delete(key); unread.delete(key); db.exec('DELETE FROM secrets WHERE key = ?', key); return Promise.resolve(); }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Keychain encryption is not available');
  const v = String(value);
  cache.set(key, v);
  unread.delete(key);
  const p = safeStorage.encryptStringAsync(v)
    .then((enc) => { if (cache.get(key) === v) db.exec('INSERT INTO secrets(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, enc); })
    .catch((e) => console.error('secrets: could not save', key, e.message))
    .finally(() => writes.delete(p));
  writes.add(p);
  return p;
}

// Null while a secret hasn't been read yet. A secret the Keychain refused is tried again (at most
// once a minute) the next time something asks for it.
function get(key) {
  if (cache.has(key)) return cache.get(key);
  if (unread.has(key) && Date.now() - lastWarm > RETRY_MS) warm().catch(() => {});
  return null;
}
function has(key) { return cache.has(key) || !!db.get('SELECT 1 AS x FROM secrets WHERE key = ?', key); }

// Resolves once every save in flight is written (bounded, so quitting never hangs).
function flush(ms = 3000) {
  if (!writes.size) return Promise.resolve();
  return Promise.race([Promise.allSettled([...writes]), new Promise((r) => setTimeout(r, ms))]);
}

module.exports = { set, get, has, warm, flush, onUnreadable };
