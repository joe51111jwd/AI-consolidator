'use strict';
// Cursor Cloud Agents API (public beta): https://api.cursor.com/v1/agents, API key as basic-auth user.
// Grok Bot itself has no public API; this covers the Cursor cloud agents on the same account.
const secrets = require('../secrets.cjs');
const { truncate } = require('../util.cjs');

const BASE = 'https://api.cursor.com';

async function call(account, path, init = {}) {
  const key = secrets.get(`cursor:${account.id}:key`);
  if (!key) throw new Error('Add a Cursor API key in Accounts');
  const r = await fetch(BASE + path, {
    ...init,
    headers: { authorization: 'Basic ' + Buffer.from(key + ':').toString('base64'), 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  if (!r.ok) throw new Error((j.error && (j.error.message || j.error)) || `Cursor API ${r.status}`);
  return j;
}

async function list(account) {
  if (!secrets.has(`cursor:${account.id}:key`)) return [];
  const j = await call(account, '/v1/agents?limit=40');
  return (j.items || j.agents || []).map((a) => ({
    id: `cu:${account.id}:${a.id}`, kind: 'session', source: 'cursor', accountId: account.id,
    title: a.name || 'Cursor agent', preview: a.summary ? truncate(a.summary, 220) : (a.status || ''),
    updatedAt: Date.parse(a.updatedAt || a.createdAt) || Date.now(),
    status: /RUNNING|CREATING/i.test(a.status || '') ? 'running' : 'idle',
    meta: { agentId: a.id, url: a.url || (a.target && a.target.url), latestRunId: a.latestRunId },
  }));
}

async function transcript(account, agentId) {
  const j = await call(account, `/v1/agents/${agentId}/runs?limit=20`);
  const runs = (j.items || j.runs || []).slice().reverse();
  const out = [];
  for (const r of runs) {
    const ts = Date.parse(r.createdAt) || Date.now();
    if (r.prompt && r.prompt.text) out.push({ id: r.id + ':p', role: 'user', text: r.prompt.text, ts });
    if (r.result) out.push({ id: r.id + ':r', role: 'assistant', text: r.result, ts: Date.parse(r.updatedAt) || ts });
  }
  return out;
}

async function prompt(account, { agentId, text }) {
  const r = await call(account, `/v1/agents/${agentId}/runs`, { method: 'POST', body: JSON.stringify({ prompt: { text } }) });
  return { text: `Sent to Cursor. Run ${r.id || ''} started; the reply appears here when it finishes.`, runId: r.id };
}

module.exports = { list, transcript, prompt };
