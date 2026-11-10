'use strict';
// API keys and tokens, encrypted with Electron safeStorage (a key kept in the macOS Keychain).
// Values never leave the main process; the window only learns whether a key is set.
const { safeStorage } = require('electron');
const db = require('./db.cjs');

function set(key, value) {
  if (!value) { db.exec('DELETE FROM secrets WHERE key = ?', key); return; }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Keychain encryption is not available');
  const enc = safeStorage.encryptString(String(value));
  db.exec('INSERT INTO secrets(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, enc);
}
function get(key) {
  const r = db.get('SELECT value FROM secrets WHERE key = ?', key);
  if (!r) return null;
  try { return safeStorage.decryptString(Buffer.from(r.value)); } catch { return null; }
}
function has(key) { return !!db.get('SELECT 1 AS x FROM secrets WHERE key = ?', key); }

module.exports = { set, get, has };
