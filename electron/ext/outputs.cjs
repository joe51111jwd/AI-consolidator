'use strict';
// Latest replies from every agent session in the last 3 days, for the Outputs drawer.
const hub = require('../hub.cjs');
const claudeCode = require('../sources/claudeCode.cjs');

const WINDOW = 3 * 86400000;

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

async function recent(limit = 40) {
  const since = Date.now() - WINDOW;
  const list = await hub.entities();
  const out = [];
  for (const e of list) {
    if (e.kind !== 'session' || (e.updatedAt || 0) < since || (e.meta && e.meta.noise)) continue;
    const r = lastReply(e);
    if (!r || r.ts < since) continue;
    out.push({ id: e.id, title: e.title, source: e.source, text: r.text, ts: r.ts });
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, Math.max(1, Math.min(Number(limit) || 40, 200)));
}

module.exports = { handlers: { 'outputs:recent': (limit) => recent(limit) } };
