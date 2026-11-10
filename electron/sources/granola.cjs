'use strict';
// Granola: reads the meeting notes the Granola desktop app keeps in its local cache file.
// Read-only. The cache format is undocumented, so every field is optional.
const fs = require('fs');
const path = require('path');
const { HOME, expand, truncate } = require('../util.cjs');

const DEFAULT_DIR = path.join(HOME, 'Library', 'Application Support', 'Granola');
let memo = { file: null, mtimeMs: 0, docs: [] };

function findCache(account) {
  if (account.config.path) return expand(account.config.path);
  let names = [];
  try { names = fs.readdirSync(DEFAULT_DIR); } catch { return null; }
  const caches = names.filter((n) => /^cache(-v\d+)?\.json$/.test(n)).sort().reverse();
  return caches.length ? path.join(DEFAULT_DIR, caches[0]) : null;
}

function prosemirrorText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.text) return node.text;
  const kids = (node.content || []).map(prosemirrorText);
  const block = ['paragraph', 'heading', 'listItem', 'bulletList', 'orderedList'].includes(node.type);
  return kids.join(block ? '\n' : '');
}

function load(account) {
  const file = findCache(account);
  if (!file) return [];
  let st; try { st = fs.statSync(file); } catch { return []; }
  if (memo.file === file && memo.mtimeMs === st.mtimeMs) return memo.docs;
  let root; try { root = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  let cache = root.cache !== undefined ? root.cache : root;
  if (typeof cache === 'string') { try { cache = JSON.parse(cache); } catch { return []; } }
  const state = cache.state || cache;
  const docs = Object.values(state.documents || {}).filter((d) => d && !d.deleted_at);
  const transcripts = state.transcripts || {};
  const out = docs.map((d) => {
    const notes = d.notes_markdown || d.notes_plain || prosemirrorText(d.notes) || '';
    const panels = state.documentPanels && state.documentPanels[d.id];
    let summary = '';
    if (panels) for (const p of Object.values(panels)) { const t = p && (p.content ? prosemirrorText(p.content) : ''); if (t) { summary = t; break; } }
    const attendees = [];
    const people = (d.people && (d.people.attendees || [])) || [];
    for (const a of people) if (a && a.email) attendees.push({ email: a.email.toLowerCase(), name: a.name || (a.details && a.details.person && a.details.person.name && a.details.person.name.fullName) || '' });
    const ev = d.google_calendar_event;
    if (ev && ev.attendees) for (const a of ev.attendees) if (a.email && !attendees.find((x) => x.email === a.email.toLowerCase())) attendees.push({ email: a.email.toLowerCase(), name: a.displayName || '' });
    const tr = Array.isArray(transcripts[d.id]) ? transcripts[d.id] : null;
    return {
      id: d.id, title: d.title || 'Untitled meeting',
      at: Date.parse((ev && ev.start && ev.start.dateTime) || d.created_at || d.updated_at) || st.mtimeMs,
      updatedAt: Date.parse(d.updated_at || d.created_at) || st.mtimeMs,
      notes, summary, attendees,
      transcript: tr ? tr.map((t) => `${t.source === 'microphone' ? 'You' : 'Them'}: ${t.text}`).join('\n') : '',
    };
  }).sort((a, b) => b.at - a.at);
  memo = { file, mtimeMs: st.mtimeMs, docs: out };
  return out;
}

function list(account, { days = 30, max = 40 } = {}) {
  const since = Date.now() - days * 86400000;
  return load(account).filter((d) => d.at >= since).slice(0, max).map((d) => ({
    id: `gr:${account.id}:${d.id}`, kind: 'meeting', source: 'granola', accountId: account.id,
    title: d.title, preview: truncate(d.summary || d.notes, 220), updatedAt: d.at, status: 'idle',
    meta: { docId: d.id, attendees: d.attendees, at: d.at },
  }));
}

function transcript(account, docId) {
  const d = load(account).find((x) => x.id === docId);
  if (!d) return [];
  const msgs = [];
  if (d.summary) msgs.push({ id: 'summary', role: 'assistant', text: d.summary, ts: d.at });
  if (d.notes) msgs.push({ id: 'notes', role: 'user', text: d.notes, ts: d.at });
  if (d.transcript) msgs.push({ id: 'transcript', role: 'system', text: d.transcript, ts: d.at });
  return msgs;
}

function detect() { return findCache({ config: {} }) ? ['Granola on this Mac'] : []; }

module.exports = { list, transcript, load, detect };
