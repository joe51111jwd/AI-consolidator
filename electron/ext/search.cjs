'use strict';
// ⌘K smart search: ranks every card's title, AI summary (what it's about, client, project), preview
// and metadata, then looks inside local transcripts (Claude, Codex, Granola, chats, outputs, Grok
// Bot) for the best candidates.
const hub = require('../hub.cjs');

const PREFIX = {
  claude: { sources: ['claude-code', 'anthropic-api', 'claude-ai'] },
  chat: { sources: ['claude-code', 'codex', 'claude-ai'], category: 'chat' },
  chats: { sources: ['claude-code', 'codex', 'claude-ai'], category: 'chat' },
  code: { sources: ['claude-code', 'codex'], category: 'coding' },
  coding: { sources: ['claude-code', 'codex'], category: 'coding' },
  grok: { sources: ['grok-bot'] },
  granola: { sources: ['granola'] },
  meeting: { sources: ['granola'] },
  meetings: { sources: ['granola'] },
  gmail: { sources: ['gmail'] },
  mail: { sources: ['gmail'] },
  email: { sources: ['gmail'] },
  cursor: { sources: ['cursor'] },
  codex: { sources: ['codex'] },
  client: { kinds: ['client'] },
  clients: { kinds: ['client'] },
  output: { kinds: ['output'] },
  outputs: { kinds: ['output'] },
  note: { kinds: ['note'] },
  notes: { kinds: ['note'] },
  project: { kinds: ['project'] },
  projects: { kinds: ['project'] },
};
// Transcripts that are read from disk or the local database (Gmail and Cursor would hit the network).
const LOCAL = /^(cc|cx|gr|lc|out|nt):/;
const DAY = 86400000;
const cache = new Map();

function parse(q) {
  const raw = String(q || '').trim();
  const m = String(q || '').trimStart().match(/^([a-z]+)(?::|\s)\s*(.*)$/is);
  const key = m && m[1].toLowerCase();
  if (key && PREFIX[key]) return { filter: PREFIX[key], text: m[2].trim() };
  return { filter: null, text: raw };
}

function passes(e, filter) {
  if (e.kind === 'error' || (e.kind === 'output' && !(e.preview || '').trim())) return false;
  if (!filter) return e.kind !== 'project';
  if (filter.kinds && !filter.kinds.includes(e.kind)) return false;
  if (filter.sources && !filter.sources.includes(e.source)) return false;
  if (filter.category && e.meta && e.meta.category && e.meta.category !== filter.category) return false;
  return true;
}

// A chat's AI summary (ext/context.cjs): what the work is, who it's for, the project and people.
function contextText(e) {
  const c = e.meta && e.meta.context;
  if (!c || typeof c !== 'object') return '';
  return [c.about, c.client, c.project, ...(Array.isArray(c.people) ? c.people : [])].filter(Boolean).join(' ').toLowerCase();
}
const contextSnippet = (e) => { const c = e.meta.context; return [c.about, [c.client, c.project].filter(Boolean).join(' · ')].filter(Boolean).join(' — '); };

function metaText(e) {
  const m = e.meta || {};
  const parts = [m.cwd, m.gitBranch, m.from, m.category, e.source];
  if (m.client) { const c = m.client; parts.push(c.company, c.notes, c.next_action, ...(c.emails || []), ...(c.domains || [])); }
  for (const p of m.attendees || []) parts.push(p.name, p.email);
  if (e.accountId) { const a = hub.account(e.accountId); if (a) parts.push(a.label); }
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function snippet(text, terms) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const low = flat.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return flat.slice(0, 140);
  const start = Math.max(0, at - 50);
  return (start > 0 ? '…' : '') + flat.slice(start, at + 110) + (at + 110 < flat.length ? '…' : '');
}

async function transcriptText(e) {
  const hit = cache.get(e.id);
  if (hit && hit.u === e.updatedAt) return hit.text;
  let msgs = [];
  if (e.kind === 'account' && e.source === 'grok-bot') msgs = hub.flowsFor(e.id).map((f) => ({ text: f.content }));
  else msgs = await hub.transcriptFor(e.id).catch(() => []);
  const text = msgs.filter((m) => m.kind !== 'tool').map((m) => m.text).join('\n').slice(-80000);
  cache.set(e.id, { u: e.updatedAt, text });
  if (cache.size > 250) cache.delete(cache.keys().next().value);
  return text;
}

function rank(e, terms, phrase, now) {
  const title = (e.title || '').toLowerCase();
  const preview = (e.preview || '').toLowerCase();
  const meta = metaText(e);
  const context = contextText(e);
  let score = 0; const missing = []; let where = 'title';
  for (const t of terms) {
    if (title.includes(t)) score += title.startsWith(t) || title.includes(' ' + t) ? 12 : 9;
    else if (context.includes(t)) { score += 5; if (where === 'title') where = 'context'; }
    else if (preview.includes(t)) { score += 4; if (where === 'title') where = 'preview'; }
    else if (meta.includes(t)) score += 3;
    else missing.push(t);
  }
  if (phrase.length > 2 && title.includes(phrase)) score += 10;
  score += 3 * Math.exp(-(now - (e.updatedAt || 0)) / (7 * DAY));
  if (e.meta && e.meta.noise) score -= 4;
  return { score, missing, where };
}

const out = (e, score, snip) => ({ id: e.id, title: e.title, source: e.source, kind: e.kind, snippet: snip || '', updatedAt: e.updatedAt, score });

async function query(q, { limit = 40, deadline = 450 } = {}) {
  const t0 = Date.now();
  const { filter, text } = parse(q);
  const list = (await hub.entities()).filter((e) => passes(e, filter));
  const now = Date.now();
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) {
    return list.filter((e) => !(e.meta && e.meta.noise)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, limit)
      .map((e) => out(e, 0, e.preview ? snippet(e.preview, []) : ''));
  }
  const phrase = text.toLowerCase();
  const hits = []; const partial = [];
  for (const e of list) {
    const r = rank(e, terms, phrase, now);
    if (!r.missing.length) hits.push(out(e, r.score, r.where === 'context' ? contextSnippet(e) : r.where === 'preview' ? snippet(e.preview, terms) : (e.preview ? snippet(e.preview, []) : '')));
    else if (LOCAL.test(e.id) || (e.kind === 'account' && e.source === 'grok-bot')) partial.push({ e, r });
  }
  // Look inside transcripts for the most promising cards that metadata alone didn't fully match.
  if (phrase.length >= 3) {
    partial.sort((a, b) => (b.r.score - a.r.score) || ((b.e.updatedAt || 0) - (a.e.updatedAt || 0)));
    const queue = partial.slice(0, 60);
    const worker = async () => {
      while (queue.length && Date.now() - t0 < deadline) {
        const { e, r } = queue.shift();
        const body = await transcriptText(e);
        const low = body.toLowerCase();
        if (!low || !r.missing.every((t) => low.includes(t))) continue;
        hits.push(out(e, r.score + 2 * r.missing.length, snippet(body, r.missing)));
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }
  return hits.sort((a, b) => (b.score - a.score) || ((b.updatedAt || 0) - (a.updatedAt || 0))).slice(0, limit);
}

module.exports = {
  handlers: { 'search:query': (q, opts) => query(q, opts || {}) },
};
