'use strict';
// Recent results for the Outputs drawer, from the last 3 days: replies to work you sent from
// Switchboard, plus finished agent sessions whose last reply looks like a deliverable. Progress
// chatter from running sessions, Grok small talk and Switchboard's own runs are left out.
const hub = require('../hub.cjs');
const claudeCode = require('../sources/claudeCode.cjs');
const { plain, truncate } = require('../util.cjs');

const WINDOW = 3 * 86400000;
const MIN_LEN = 200;
const CHIEF = 'chief';

function lastReply(e) {
  if (e.meta && e.meta.file && (e.source === 'claude-code' || e.source === 'claude-app')) {
    try {
      const msgs = claudeCode.parseSession(e.meta.file).messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === 'assistant' && m.kind !== 'tool' && m.text.trim()) return { text: m.text, ts: m.ts };
      }
    } catch {}
    return null;
  }
  const text = (e.preview || '').trim();
  return text ? { text, ts: (e.meta && e.meta.previewAt) || e.updatedAt } : null;
}

// A link, a file path, a heading or a list: something was made, not just said.
const MARKER = /(\]\(|https?:\/\/|(^|\s)(~|\.{0,2})\/[\w.-]+\/[\w./-]+|^#{1,4} |^\s*([-*•]|\d+[.)]) )/m;
function isDeliverable(text) {
  const t = String(text || '').trim();
  return t.length > MIN_LEN && MARKER.test(t);
}

const titleOf = (s) => truncate(plain(s), 80) || 'Untitled';

async function recent(limit = 40) {
  const since = Date.now() - WINDOW;
  const list = await hub.entities();
  const out = [];
  const seen = new Set();
  for (const r of hub.runs.values()) {
    if (r.status !== 'done' || !r.text || r.entityId === CHIEF || (r.startedAt || 0) < since) continue;
    const id = (r.result && r.result.entityId) || r.entityId;
    const e = hub.find(id);
    out.push({ id, title: titleOf(e ? e.title : hub.label(id)), source: e ? e.source : 'app', text: r.text, ts: r.startedAt, sent: true });
    seen.add(r.text.trim());
  }
  const sentTo = hub.sentReplies();
  for (const e of list) {
    if (e.kind !== 'session' || e.source === 'grok-bot' || e.status === 'running' || (e.updatedAt || 0) < since) continue;
    if (e.meta && (e.meta.noise || e.meta.archived)) continue;
    const r = lastReply(e);
    if (!r || r.ts < since || seen.has(r.text.trim())) continue;
    const sent = (sentTo[e.id] || 0) >= since && r.ts >= sentTo[e.id] - 60000;
    if (!sent && !isDeliverable(r.text)) continue;
    out.push({ id: e.id, title: titleOf(e.title), source: e.source, text: r.text, ts: r.ts, ...(sent ? { sent: true } : {}) });
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, Math.max(1, Math.min(Number(limit) || 40, 200)));
}

module.exports = { handlers: { 'outputs:recent': (limit) => recent(limit) }, isDeliverable };
