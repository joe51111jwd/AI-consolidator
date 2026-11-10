'use strict';
// Gmail, read-only, through Google's OAuth for desktop apps (loopback redirect + PKCE).
// The user creates their own Google OAuth client (Desktop app) and pastes its ID and secret.
const http = require('http');
const crypto = require('crypto');
const { shell } = require('electron');
const secrets = require('../secrets.cjs');
const { truncate, pool } = require('../util.cjs');

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const tokenCache = new Map(); // accountId -> { access, exp }
const threadCache = new Map(); // accountId -> { at, threads }

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

async function connect(account) {
  const clientId = secrets.get(`gmail:${account.id}:client_id`);
  const clientSecret = secrets.get(`gmail:${account.id}:client_secret`);
  if (!clientId) throw new Error('Add your Google OAuth client ID first (see README, "Gmail").');
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const { code, redirect } = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/oauth') { res.end(); return; }
      res.setHeader('content-type', 'text/html');
      if (u.searchParams.get('state') !== state || !u.searchParams.get('code')) {
        res.end('<p style="font-family:sans-serif">Sign-in did not complete. You can close this tab.</p>');
        srv.close(); return reject(new Error(u.searchParams.get('error') || 'Sign-in was cancelled'));
      }
      res.end('<p style="font-family:sans-serif">Gmail is connected to Switchboard. You can close this tab.</p>');
      srv.close();
      resolve({ code: u.searchParams.get('code'), redirect: `http://127.0.0.1:${srv.address().port}/oauth` });
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      const p = new URLSearchParams({
        client_id: clientId, redirect_uri: `http://127.0.0.1:${port}/oauth`, response_type: 'code', scope: SCOPE,
        access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state,
      });
      shell.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${p}`);
    });
    setTimeout(() => { srv.close(); reject(new Error('Sign-in timed out')); }, 5 * 60000);
  });
  const body = new URLSearchParams({ code, client_id: clientId, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect });
  if (clientSecret) body.set('client_secret', clientSecret);
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
  const j = await r.json();
  if (!j.refresh_token) throw new Error(j.error_description || 'Google did not return a refresh token');
  secrets.set(`gmail:${account.id}:refresh`, j.refresh_token);
  tokenCache.set(account.id, { access: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
  const prof = await api(account, 'profile');
  return prof.emailAddress;
}

async function accessToken(account) {
  const c = tokenCache.get(account.id);
  if (c && c.exp > Date.now()) return c.access;
  const refresh = secrets.get(`gmail:${account.id}:refresh`);
  if (!refresh) throw new Error('Gmail is not connected');
  const body = new URLSearchParams({ client_id: secrets.get(`gmail:${account.id}:client_id`), refresh_token: refresh, grant_type: 'refresh_token' });
  const cs = secrets.get(`gmail:${account.id}:client_secret`); if (cs) body.set('client_secret', cs);
  const j = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body })).json();
  if (!j.access_token) throw new Error(j.error_description || 'Could not refresh Gmail access');
  tokenCache.set(account.id, { access: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
  return j.access_token;
}

async function api(account, p) {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${p}`, { headers: { authorization: `Bearer ${await accessToken(account)}` } });
  if (!r.ok) throw new Error(`Gmail ${r.status}`);
  return r.json();
}

const hdr = (m, n) => { const h = (m.payload && m.payload.headers || []).find((x) => x.name.toLowerCase() === n); return h ? h.value : ''; };
const addr = (s) => { const m = (s || '').match(/<([^>]+)>/); return (m ? m[1] : s || '').trim().toLowerCase(); };
const addrs = (s) => (s || '').split(',').map(addr).filter(Boolean);
const nameOf = (s) => { const m = (s || '').match(/^\s*"?([^"<]+?)"?\s*</); return m ? m[1].trim() : addr(s); };

async function threads(account, { force = false } = {}) {
  const c = threadCache.get(account.id);
  if (!force && c && Date.now() - c.at < 5 * 60000) return c.threads;
  if (!secrets.has(`gmail:${account.id}:refresh`)) return [];
  const me = (account.config.email || '').toLowerCase();
  const q = encodeURIComponent(account.config.query || 'newer_than:30d -category:promotions -category:social -category:updates -category:forums');
  const list = await api(account, `threads?maxResults=80&q=${q}`);
  const ids = (list.threads || []).map((t) => t.id);
  const out = await pool(ids, 8, async (id) => {
    const t = await api(account, `threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`);
    const msgs = (t.messages || []).map((m) => ({
      id: m.id, from: addr(hdr(m, 'from')), fromName: nameOf(hdr(m, 'from')), to: addrs(hdr(m, 'to')).concat(addrs(hdr(m, 'cc'))),
      subject: hdr(m, 'subject'), ts: Number(m.internalDate), snippet: m.snippet || '', unread: (m.labelIds || []).includes('UNREAD'),
    }));
    if (!msgs.length) return null;
    const last = msgs[msgs.length - 1];
    const participants = [...new Set(msgs.flatMap((m) => [m.from, ...m.to]))].filter((a) => a && a !== me);
    return { id, subject: msgs[0].subject || '(no subject)', messages: msgs, last, participants, lastFromMe: last.from === me, updatedAt: last.ts };
  });
  const res = out.filter(Boolean);
  threadCache.set(account.id, { at: Date.now(), threads: res });
  return res;
}

async function list(account) {
  const ts = await threads(account);
  return ts.slice(0, 40).map((t) => ({
    id: `gm:${account.id}:${t.id}`, kind: 'thread', source: 'gmail', accountId: account.id,
    title: t.subject, preview: truncate(`${t.last.fromName}: ${t.last.snippet}`, 220), updatedAt: t.updatedAt,
    status: t.lastFromMe ? 'idle' : 'waiting',
    meta: { threadId: t.id, participants: t.participants, lastFromMe: t.lastFromMe, url: `https://mail.google.com/mail/u/${encodeURIComponent(account.config.email || '0')}/#all/${t.id}` },
  }));
}

async function transcript(account, threadId) {
  const t = await api(account, `threads/${threadId}?format=full`);
  const me = (account.config.email || '').toLowerCase();
  return (t.messages || []).map((m) => {
    const body = extractBody(m.payload) || m.snippet || '';
    const from = addr(hdr(m, 'from'));
    return { id: m.id, role: from === me ? 'user' : 'assistant', text: `**${nameOf(hdr(m, 'from'))}** · ${hdr(m, 'subject')}\n\n${body.trim()}`, ts: Number(m.internalDate) };
  });
}

function extractBody(p) {
  if (!p) return '';
  if (p.mimeType === 'text/plain' && p.body && p.body.data) return Buffer.from(p.body.data, 'base64').toString('utf8').replace(/\n>.*$/gs, '');
  for (const part of p.parts || []) { const t = extractBody(part); if (t) return t; }
  return '';
}

module.exports = { connect, threads, list, transcript };
