'use strict';
// Gmail, read-only, through Google's OAuth for desktop apps (loopback redirect + PKCE).
// The user creates their own Google OAuth client (Desktop app) and pastes its ID and secret.
const http = require('http');
const crypto = require('crypto');
const { shell } = require('electron');
const secrets = require('../secrets.cjs');
const { truncate, pool } = require('../util.cjs');

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
// Overridable only so the tests can stand in for Google.
const AUTH_URL = process.env.SB_GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.SB_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const API_URL = process.env.SB_GMAIL_API_URL || 'https://gmail.googleapis.com/gmail/v1/users/me';
const db = require('../db.cjs');

// One Google OAuth client can serve all your Gmail accounts, so a second Gmail card reuses the
// client ID and secret you pasted for the first unless it has its own.
function client(account, k) {
  const own = secrets.get(`gmail:${account.id}:${k}`);
  if (own) return own;
  for (const r of db.all("SELECT key FROM secrets WHERE key LIKE 'gmail:%:' || ?", k)) { const v = secrets.get(r.key); if (v) return v; }
  return null;
}
function openBrowser(url) {
  if (process.env.SB_TEST_OPEN_LOG) { require('fs').appendFileSync(process.env.SB_TEST_OPEN_LOG, url + '\n'); return; }
  shell.openExternal(url);
}
const tokenCache = new Map(); // accountId -> { access, exp }
const threadCache = new Map(); // accountId -> { at, threads }

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

async function connect(account) {
  const clientId = client(account, 'client_id');
  const clientSecret = client(account, 'client_secret');
  if (!clientId) throw new Error('Add your Google OAuth client ID first (see README, "Gmail").');
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const { code, redirect } = await new Promise((resolve, reject) => {
    let port = 0, done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); srv.close(); err ? reject(err) : resolve(val); };
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/oauth') { res.statusCode = 404; res.end(); return; }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      const page = (msg) => `<!doctype html><title>Switchboard</title><body style="font:15px -apple-system,sans-serif;display:grid;place-items:center;height:90vh;color:#1C1B19;background:#F3F1EC"><p>${msg}</p></body>`;
      if (u.searchParams.get('state') !== state || !u.searchParams.get('code')) {
        res.end(page('Sign-in did not complete. You can close this tab and try again in Switchboard.'));
        return finish(new Error(u.searchParams.get('error') === 'access_denied' ? 'Google sign-in was cancelled' : (u.searchParams.get('error') || 'Sign-in did not complete')));
      }
      res.end(page('Gmail is connected to Switchboard. You can close this tab.'));
      finish(null, { code: u.searchParams.get('code'), redirect: `http://127.0.0.1:${port}/oauth` });
    });
    const timer = setTimeout(() => finish(new Error('Google sign-in timed out. Try again.')), 5 * 60000);
    srv.on('error', (e) => finish(e));
    srv.listen(0, '127.0.0.1', () => {
      port = srv.address().port;
      const p = new URLSearchParams({
        client_id: clientId, redirect_uri: `http://127.0.0.1:${port}/oauth`, response_type: 'code', scope: SCOPE,
        access_type: 'offline', prompt: 'consent select_account', code_challenge: challenge, code_challenge_method: 'S256', state,
      });
      if (account.config.email) p.set('login_hint', account.config.email);
      openBrowser(`${AUTH_URL}?${p}`);
    });
  });
  const body = new URLSearchParams({ code, client_id: clientId, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect });
  if (clientSecret) body.set('client_secret', clientSecret);
  const r = await fetch(TOKEN_URL, { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
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
  const body = new URLSearchParams({ client_id: client(account, 'client_id'), refresh_token: refresh, grant_type: 'refresh_token' });
  const cs = client(account, 'client_secret'); if (cs) body.set('client_secret', cs);
  const j = await (await fetch(TOKEN_URL, { method: 'POST', body })).json().catch(() => ({}));
  if (!j.access_token) {
    if (j.error === 'invalid_grant') { secrets.set(`gmail:${account.id}:refresh`, null); throw new Error('Gmail sign-in expired. Press Reconnect on the Accounts page.'); }
    throw new Error(j.error_description || 'Could not refresh Gmail access');
  }
  tokenCache.set(account.id, { access: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
  return j.access_token;
}

async function api(account, p) {
  let r = await fetch(`${API_URL}/${p}`, { headers: { authorization: `Bearer ${await accessToken(account)}` } });
  if (r.status === 401) { tokenCache.delete(account.id); r = await fetch(`${API_URL}/${p}`, { headers: { authorization: `Bearer ${await accessToken(account)}` } }); }
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
