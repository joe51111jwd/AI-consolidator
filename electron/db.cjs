'use strict';
// Local database. Uses the SQLite built into Electron's Node (no native module to rebuild).
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { APP_DIR } = require('./util.cjs');

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value BLOB);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, color TEXT,
  config TEXT NOT NULL DEFAULT '{}', created_at INTEGER);
CREATE TABLE IF NOT EXISTS board_nodes (
  id TEXT PRIMARY KEY, x REAL, y REAL, w REAL, h REAL, parent_id TEXT,
  data TEXT NOT NULL DEFAULT '{}', hidden INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}', created_at INTEGER);
CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY, source TEXT, target TEXT, preview TEXT, content TEXT, via TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, company TEXT, emails TEXT DEFAULT '[]',
  domains TEXT DEFAULT '[]', status TEXT DEFAULT 'active', value REAL, next_action TEXT,
  due TEXT, notes TEXT, project_paths TEXT DEFAULT '[]', created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, account_id TEXT, title TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY, chat_id TEXT, role TEXT, content TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY, account_id TEXT, ts INTEGER, input INTEGER, output INTEGER);
CREATE TABLE IF NOT EXISTS outputs (
  id TEXT PRIMARY KEY, title TEXT, content TEXT, source TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, text TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS flows_ts ON flows(ts);
CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages(chat_id, ts);
`;

function open(file = path.join(APP_DIR, 'switchboard.db')) {
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const exec = (sql, ...p) => db.prepare(sql).run(...p);

function getSetting(key, fallback) {
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  if (!r) return fallback;
  try { return JSON.parse(r.value); } catch { return fallback; }
}
function setSetting(key, value) {
  exec('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

const J = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

module.exports = { open, all, get, exec, getSetting, setSetting, J, get db() { return db; } };
