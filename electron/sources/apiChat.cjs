'use strict';
// Chats with model APIs (Anthropic, or any OpenAI-compatible API such as xAI's Grok).
// Conversations are stored locally; keys stay in the Keychain-backed store.
const secrets = require('../secrets.cjs');
const db = require('../db.cjs');
const { uid, truncate } = require('../util.cjs');

function listChats(account) {
  return db.all('SELECT * FROM chats WHERE account_id = ? ORDER BY updated_at DESC LIMIT 40', account.id).map((c) => {
    const last = db.get('SELECT role, content FROM chat_messages WHERE chat_id = ? ORDER BY ts DESC LIMIT 1', c.id);
    return {
      id: `lc:${account.id}:${c.id}`, kind: 'session', source: account.kind, accountId: account.id,
      title: c.title || 'New chat', preview: last ? truncate(last.content, 220) : '', updatedAt: c.updated_at,
      status: 'idle', meta: { chatId: c.id },
    };
  });
}

function transcript(chatId) {
  return db.all('SELECT id, role, content AS text, ts FROM chat_messages WHERE chat_id = ? ORDER BY ts', chatId);
}

function newChat(account, title) {
  const id = uid('c');
  db.exec('INSERT INTO chats(id, account_id, title, created_at, updated_at) VALUES(?,?,?,?,?)', id, account.id, title || 'New chat', Date.now(), Date.now());
  return id;
}

async function sse(r, onEvent) {
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line.startsWith('data:')) { const d = line.slice(5).trim(); if (d && d !== '[DONE]') { try { onEvent(JSON.parse(d)); } catch {} } }
    }
  }
}

// One completion over a message list. Used by chats and by the overall agent.
async function complete(account, { system, messages, onText, signal }) {
  const key = secrets.get(`api:${account.id}:key`);
  if (!key) throw new Error(`Add an API key for ${account.label}`);
  let acc = ''; let usage = { input: 0, output: 0 };
  if (account.kind === 'anthropic-api') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: account.config.model || 'claude-sonnet-5-5', max_tokens: 8192, stream: true, system, messages }),
    });
    if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${truncate(await r.text(), 300)}`);
    await sse(r, (e) => {
      if (e.type === 'content_block_delta' && e.delta && e.delta.text) { acc += e.delta.text; onText && onText(acc); }
      if (e.type === 'message_start' && e.message && e.message.usage) usage.input = e.message.usage.input_tokens || 0;
      if (e.type === 'message_delta' && e.usage) usage.output = e.usage.output_tokens || 0;
    });
  } else {
    const base = (account.config.baseUrl || 'https://api.x.ai/v1').replace(/\/$/, '');
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: account.config.model || 'grok-4', stream: true, stream_options: { include_usage: true }, messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages] }),
    });
    if (!r.ok) throw new Error(`API ${r.status}: ${truncate(await r.text(), 300)}`);
    await sse(r, (e) => {
      const d = e.choices && e.choices[0] && e.choices[0].delta;
      if (d && d.content) { acc += d.content; onText && onText(acc); }
      if (e.usage) usage = { input: e.usage.prompt_tokens || 0, output: e.usage.completion_tokens || 0 };
    });
  }
  db.exec('INSERT INTO usage_events(id, account_id, ts, input, output) VALUES(?,?,?,?,?)', uid('u'), account.id, Date.now(), usage.input, usage.output);
  return { text: acc, usage };
}

async function prompt(account, { chatId, text, onText, signal, system }) {
  if (!chatId) chatId = newChat(account, truncate(text, 60));
  db.exec('INSERT INTO chat_messages(id, chat_id, role, content, ts) VALUES(?,?,?,?,?)', uid('m'), chatId, 'user', text, Date.now());
  const history = transcript(chatId).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }));
  const res = await complete(account, { system, messages: history, onText, signal });
  db.exec('INSERT INTO chat_messages(id, chat_id, role, content, ts) VALUES(?,?,?,?,?)', uid('m'), chatId, 'assistant', res.text, Date.now());
  db.exec('UPDATE chats SET updated_at = ? WHERE id = ?', Date.now(), chatId);
  return { text: res.text, chatId };
}

function usage(account) {
  const now = Date.now();
  const rows = db.all('SELECT ts, input, output FROM usage_events WHERE account_id = ? AND ts > ?', account.id, now - 7 * 86400000);
  const w = { h5: 0, d1: 0, d7: 0, out7: 0, sessions: rows.length, byModel: {} };
  for (const r of rows) { const t = r.input + r.output; if (now - r.ts < 5 * 3600000) w.h5 += t; if (now - r.ts < 86400000) w.d1 += t; w.d7 += t; w.out7 += r.output; }
  return w;
}

module.exports = { listChats, transcript, prompt, complete, usage, newChat };
