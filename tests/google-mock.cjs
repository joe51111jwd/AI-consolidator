'use strict';
// A stand-in for Google's OAuth token endpoint and the parts of the Gmail API the app reads,
// so the Gmail sign-in, token refresh and CRM can be tested without a real Google account.
// All addresses and mail here are made up.
const http = require('http');

function start() {
  const state = {
    tokenRequests: [], // every POST to /token, as parsed form fields
    apiRequests: [], // every Gmail API call: { path, auth }
    validAccess: new Set(),
    refreshToken: 'rt-1',
    revoked: false, // when true, refreshing fails with invalid_grant
    expireNextApiCall: false, // when true, the next API call returns 401 once
    me: 'owner@example.com',
  };
  const H = 3600000, now = Date.now();
  const msg = (id, from, to, subject, ts, body, unread) => ({
    id, threadId: null, internalDate: String(ts), snippet: body.slice(0, 90), labelIds: unread ? ['UNREAD', 'INBOX'] : ['INBOX'],
    payload: { mimeType: 'text/plain', headers: [
      { name: 'From', value: from }, { name: 'To', value: to }, { name: 'Subject', value: subject }, { name: 'Date', value: new Date(ts).toUTCString() },
    ], body: { data: Buffer.from(body).toString('base64') } },
  });
  // t1: Maya (client c1) wrote last, 9 hours ago: a reply is owed.
  // t2: Dev (client c2) wrote, then the owner answered: nothing owed, and it counts as follow-up.
  // t3: someone new the owner has been writing to: should show as a suggested client.
  const threads = {
    t1: [
      msg('t1a', 'Owner <owner@example.com>', 'maya@harborcoffee.example', 'Menu page preview', now - 30 * H, 'Here is the first look at the menu page.'),
      msg('t1b', 'Maya Lin <maya@harborcoffee.example>', 'owner@example.com', 'Re: Menu page preview', now - 9 * H, 'Looks great. Can we move the pastries above the drinks?', true),
    ],
    t2: [
      msg('t2a', 'Dev Patel <dev@fieldline.example>', 'owner@example.com', 'Release 2.3', now - 20 * H, 'Can we ship Friday?'),
      msg('t2b', 'Owner <owner@example.com>', 'dev@fieldline.example', 'Re: Release 2.3', now - 2 * H, 'Yes, Friday works.'),
    ],
    t3: [
      msg('t3a', 'Owner <owner@example.com>', 'sam@northbakery.example', 'Website quote', now - 50 * H, 'Here is the quote we talked about.'),
      msg('t3b', 'Sam Ortiz <sam@northbakery.example>', 'owner@example.com', 'Re: Website quote', now - 40 * H, 'Thanks, reviewing with my partner.'),
    ],
  };
  let n = 0;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const json = (code, o) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && u.pathname === '/token') {
      let raw = ''; req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        const f = Object.fromEntries(new URLSearchParams(raw));
        state.tokenRequests.push(f);
        if (f.grant_type === 'authorization_code') {
          if (f.code !== 'good-code' || !f.code_verifier) return json(400, { error: 'invalid_grant' });
          const at = `at-${++n}`; state.validAccess.add(at);
          return json(200, { access_token: at, expires_in: 3599, refresh_token: state.refreshToken, scope: 'https://www.googleapis.com/auth/gmail.readonly', token_type: 'Bearer' });
        }
        if (f.grant_type === 'refresh_token') {
          if (state.revoked || f.refresh_token !== state.refreshToken) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
          const at = `at-${++n}`; state.validAccess.add(at);
          return json(200, { access_token: at, expires_in: 3599, token_type: 'Bearer' });
        }
        return json(400, { error: 'unsupported_grant_type' });
      });
      return;
    }
    if (u.pathname.startsWith('/gmail/')) {
      const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
      state.apiRequests.push({ path: u.pathname + u.search, auth });
      if (state.expireNextApiCall) { state.expireNextApiCall = false; state.validAccess.delete(auth); }
      if (!state.validAccess.has(auth)) return json(401, { error: { code: 401, message: 'Invalid Credentials' } });
      const p = u.pathname.slice('/gmail/'.length);
      if (p === 'profile') return json(200, { emailAddress: state.me, messagesTotal: 6 });
      if (p === 'threads') return json(200, { threads: Object.keys(threads).map((id) => ({ id })) });
      const m = p.match(/^threads\/(\w+)$/);
      if (m && threads[m[1]]) return json(200, { id: m[1], messages: threads[m[1]].map((x) => ({ ...x, threadId: m[1] })) });
      return json(404, { error: { code: 404 } });
    }
    json(404, {});
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    resolve({ base, state, close: () => srv.close(), env: { SB_GOOGLE_AUTH_URL: `${base}/auth`, SB_GOOGLE_TOKEN_URL: `${base}/token`, SB_GMAIL_API_URL: `${base}/gmail` } });
  }));
}

module.exports = { start };
