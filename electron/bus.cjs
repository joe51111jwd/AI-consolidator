'use strict';
// Local message bus on 127.0.0.1. The `sb` command and its MCP server talk to it, so
// Grok Bot, Claude Code or any script on this Mac can send work to a card and the
// board shows the message travelling. Every request needs the token in ~/.switchboard/bus-token.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const hub = require('./hub.cjs');
const { APP_DIR } = require('./util.cjs');

const TOKEN_FILE = path.join(APP_DIR, 'bus-token');
const PORT_FILE = path.join(APP_DIR, 'bus-port');

function token() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}

// Accept an id, or a card title / account name, and find the card.
async function resolve(ref) {
  if (!ref) return null;
  const list = await hub.entities();
  if (list.find((e) => e.id === ref)) return ref;
  const r = ref.toLowerCase();
  // "grok-bot", "grok", "codex" or "claude" mean that kind of account's card.
  const alias = { grok: 'grok-bot', grokbot: 'grok-bot', 'grok bot': 'grok-bot', 'grok-bot': 'grok-bot', claude: 'claude-code', 'claude-code': 'claude-code', codex: 'codex', granola: 'granola' }[r];
  if (alias) { const a = list.find((e) => e.kind === 'account' && e.source === alias); if (a) return a.id; }
  const exact = list.find((e) => e.title && e.title.toLowerCase() === r);
  if (exact) return exact.id;
  const part = list.filter((e) => e.title && e.title.toLowerCase().includes(r)).sort((a, b) => b.updatedAt - a.updatedAt);
  return part.length ? part[0].id : null;
}

function waitRun(runId, timeoutMs = 10 * 60000) {
  return new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      const r = hub.runs.get(runId);
      if (r && r.status !== 'running') return res(r);
      if (Date.now() - t0 > timeoutMs) return res(r);
      setTimeout(tick, 400);
    };
    tick();
  });
}

function start(port = 47821) {
  const tok = token();
  const srv = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${tok}`) return send(401, { error: 'bad token' });
    let body = '';
    for await (const c of req) { body += c; if (body.length > 2e6) return send(413, { error: 'too large' }); }
    let j = {}; try { j = body ? JSON.parse(body) : {}; } catch { return send(400, { error: 'bad json' }); }
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/cards') {
        const list = await hub.entities();
        return send(200, list.filter((e) => e.kind !== 'error' && !(e.meta && e.meta.noise)).map((e) => ({ id: e.id, kind: e.kind, source: e.source, title: e.title, updatedAt: e.updatedAt })));
      }
      if (req.method === 'GET' && url.pathname === '/card') {
        const id = await resolve(url.searchParams.get('id'));
        if (!id) return send(404, { error: 'no such card' });
        const t = await hub.transcriptFor(id);
        return send(200, { id, title: hub.label(id), messages: t.slice(-Number(url.searchParams.get('n') || 20)) });
      }
      if (req.method === 'POST' && url.pathname === '/send') {
        const to = await resolve(j.to);
        if (!to) return send(404, { error: `No card matches "${j.to}"` });
        const from = (await resolve(j.from)) || (j.from ? `ext:${j.from}` : 'ext:terminal');
        const runId = hub.prompt(to, j.text, { from, via: 'bus', includeBrain: !!j.brain });
        if (!j.wait) return send(200, { ok: true, to, runId });
        const r = await waitRun(runId);
        if (r && r.status === 'done') hub.recordFlow(to, from, r.text, 'bus');
        return send(200, { ok: r && r.status === 'done', to, runId, text: r && r.text, error: r && r.error });
      }
      if (req.method === 'POST' && url.pathname === '/log') {
        const from = (await resolve(j.from)) || `ext:${j.from || 'terminal'}`;
        const to = (await resolve(j.to)) || `ext:${j.to || 'unknown'}`;
        hub.recordFlow(from, to, j.text || '', 'bus');
        return send(200, { ok: true });
      }
      if (url.pathname === '/brain') {
        if (req.method === 'POST') { if (j.replace != null) hub.setBrain(j.replace); else hub.appendBrain(j.text || '', j.from); }
        return send(200, { text: hub.brain() });
      }
      if (req.method === 'POST' && url.pathname === '/output') {
        const id = hub.saveOutput({ title: j.title, content: j.text || '', source: j.from });
        hub.events.emit('event', { type: 'entities-changed' });
        return send(200, { id });
      }
      if (req.method === 'POST' && url.pathname === '/board') {
        const from = (await resolve(j.from)) || (j.from ? `ext:${j.from}` : null);
        return send(200, { ok: true, ...hub.makeBoard({ title: j.title, nodes: j.nodes, edges: j.edges, from }) });
      }
      if (req.method === 'POST' && url.pathname === '/group') return send(200, hub.requestRegroup(j.instruction));
      if (req.method === 'GET' && url.pathname === '/due') return send(200, await hub.due());
      return send(404, { error: 'unknown route' });
    } catch (e) { return send(500, { error: e.message }); }
  });
  srv.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && port !== 0) { console.error(`bus port ${port} in use, picking a free one`); port = 0; srv.listen(0, '127.0.0.1'); return; }
    console.error('bus error', e.message);
  });
  srv.on('listening', () => fs.writeFileSync(PORT_FILE, String(srv.address().port)));
  srv.listen(port, '127.0.0.1');
  return srv;
}

module.exports = { start, token, TOKEN_FILE, PORT_FILE };
