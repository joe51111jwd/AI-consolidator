// Cloud sessions: cloud/switchboard-sync.cjs runs inside each Claude Code session (claude.ai/code
// cloud sessions, or another computer) and streams its transcript here; the Switchboard app pulls it.
//   Agent side (BOT_TOKEN, or the environment's network adding it):
//     POST /api/cloud/ingest  { session: {id, title, …}, files: [{ file, from, lines, reset? }] }
//                             → { ok, files: { file: count }, commands: [...] }   (a stop waits here)
//     GET  /api/cloud/state?session=<id>   → { files: { file: count } }  (where a restarted streamer resumes)
//   App side (APP_TOKEN):
//     GET  /api/cloud/changes?since=<n>    → { cursor, sessions: [{ id, seq, ts, meta, files }] }
//     POST /api/cloud/pull     { want: [{ session, file, from }] } → { got: [{ session, file, from, lines }] }
//     POST /api/cloud/command  { session, type: 'stop' }
//     POST /api/cloud/forget   { session }
//   Public:
//     GET  /sync.cjs           the streamer itself, so a setup script can fetch it
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export class CloudError extends Error { constructor(status, message) { super(message); this.status = status; } }

const SESSION = /^[\w.-]{1,128}$/;
const MAX_LINE = 1024 * 1024;
const MAX_LINES = 20000;
const PULL_BYTES = 3 * 1024 * 1024;
const PULL_LINES = 5000;
// A session that reported within this long also comes back on every changes call, so one whose
// write landed after a newer change number was handed out is never skipped.
const RECENT_MS = 4000;

const sessionId = (v) => {
  if (typeof v !== 'string' || !SESSION.test(v)) throw new CloudError(400, 'session must be a session id');
  return v;
};
// A transcript file relative to the session's projects folder: <project>/<id>.jsonl, or a
// sub-agent's <project>/<id>/subagents/agent-….jsonl.
const fileName = (v) => {
  if (typeof v !== 'string' || !v || v.length > 400 || !v.endsWith('.jsonl') || v.startsWith('/') || v.includes('\\') || v.split('/').some((p) => !p || p === '..' || p === '.')) {
    throw new CloudError(400, 'file must be a relative .jsonl path');
  }
  return v;
};
const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);

function meta(s) {
  if (!s || typeof s !== 'object') throw new CloudError(400, 'session is required');
  const url = typeof s.url === 'string' && /^https:\/\/claude\.ai\/\S+$/.test(s.url) ? s.url.slice(0, 300) : undefined;
  return {
    id: sessionId(s.id), cloud: !!s.cloud, url,
    email: str(s.email, 200), org: str(s.org, 80), cliSessionId: str(s.cliSessionId, 80), entrypoint: str(s.entrypoint, 60),
    environment: str(s.environment, 60), host: str(s.host, 120), version: str(s.version, 20), title: str(s.title, 200),
    active: typeof s.active === 'boolean' ? s.active : undefined,
  };
}

async function ingest({ body, store }) {
  const m = meta(body && body.session);
  const files = Array.isArray(body.files) ? body.files : [];
  let total = 0;
  const clean = files.map((f) => {
    const lines = Array.isArray(f && f.lines) ? f.lines : [];
    if (lines.some((l) => typeof l !== 'string' || l.length > MAX_LINE)) throw new CloudError(400, 'lines must be strings under 1 MB');
    total += lines.length;
    const from = Number.isInteger(f.from) && f.from >= 0 ? f.from : 0;
    return { file: fileName(f.file), from, lines, reset: f.reset === true };
  });
  if (total > MAX_LINES) throw new CloudError(413, 'Too many lines in one batch');
  const r = await store.cloudIngest(m, clean);
  return { ok: true, files: r.files, commands: r.commands || [] };
}

async function state({ url, store }) {
  return { files: await store.cloudState(sessionId(url.searchParams.get('session'))) };
}

async function changes({ url, store }) {
  const since = Math.max(0, parseInt(url.searchParams.get('since'), 10) || 0);
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 200));
  const r = await store.cloudChanges(since, Date.now() - RECENT_MS, limit);
  // A cursor past the counter means the relay's storage was reset: start over.
  const reset = since > r.head;
  const list = reset ? (await store.cloudChanges(0, Date.now() - RECENT_MS, limit)).sessions : r.sessions;
  const cursor = list.reduce((n, s) => Math.max(n, s.seq), reset ? 0 : since);
  return { cursor, reset, more: list.length === limit, sessions: list };
}

async function pull({ body, store }) {
  const want = Array.isArray(body && body.want) ? body.want.slice(0, 200) : [];
  const got = [];
  let bytes = 0;
  for (const w of want) {
    if (bytes >= PULL_BYTES) break;
    const session = sessionId(w && w.session);
    const file = fileName(w.file);
    const from = Number.isInteger(w.from) && w.from >= 0 ? w.from : 0;
    const lines = [];
    for (const l of await store.cloudLines(session, file, from, PULL_LINES)) {
      if (bytes >= PULL_BYTES && lines.length) break;
      bytes += l.length;
      lines.push(l);
    }
    got.push({ session, file, from, lines });
  }
  return { got };
}

async function command({ body, store }) {
  const session = sessionId(body && body.session);
  if (body.type !== 'stop') throw new CloudError(400, 'type must be "stop"');
  const c = { id: randomUUID(), type: 'stop', ts: Date.now() };
  await store.cloudPushCmd(session, c);
  return { ok: true, command: c };
}

async function forget({ body, store }) {
  await store.cloudForget(sessionId(body && body.session));
  return { ok: true };
}

let script = null;
export function syncScript() {
  if (script == null) script = readFileSync(new URL('../cloud/switchboard-sync.cjs', import.meta.url), 'utf8');
  return script;
}

export const BOT_ROUTES = {
  'cloud/ingest': { POST: ingest },
  'cloud/state': { GET: state },
};
export const APP_ROUTES = {
  'cloud/changes': { GET: changes },
  'cloud/pull': { POST: pull },
  'cloud/command': { POST: command },
  'cloud/forget': { POST: forget },
};
