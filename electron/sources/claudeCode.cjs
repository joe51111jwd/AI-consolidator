'use strict';
// Claude Code: one "account" per config directory (CLAUDE_CONFIG_DIR, default ~/.claude).
// Sessions are read from <configDir>/projects/<encoded cwd>/<sessionId>.jsonl.
// Prompting runs the user's own `claude` CLI in print mode, so it uses that account's login.
const fs = require('fs');
const path = require('path');
const { HOME, APP_DIR, expand, exists, readJsonl, walk, truncate, plain, run, which } = require('../util.cjs');
const classify = require('./classify.cjs');
const claudeDesktop = require('./claudeDesktop.cjs');

const realDir = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const cache = new Map(); // file -> { mtimeMs, size, parsed }
const DAY = 86400000;

function configDir(account) {
  return expand(account.config.configDir || '~/.claude');
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    if (b.type === 'text') return b.text;
    if (b.type === 'tool_use') return `⟢ ${b.name}${b.input && b.input.command ? ': ' + truncate(b.input.command, 120) : b.input && b.input.file_path ? ': ' + b.input.file_path : ''}`;
    return '';
  }).filter(Boolean).join('\n');
}

function isNoise(text) {
  return !text || /^<(command-|local-command|system-reminder|user-memory)/.test(text.trim()) || text.startsWith('Caveat:');
}
// System, hook and harness wrappers (<task-notification>, <system-reminder>, Caveat: ...) are not
// something the user typed, so they never become a title.
const isWrapper = (text) => { const t = String(text || '').trim(); return !t || t.startsWith('<') || t.startsWith('Caveat:'); };

const base = (f) => String(f || '').split(/[\\/]/).pop();
// What a tool call is doing, as a short verb phrase. Raw shell arguments are never shown.
function commandVerb(cmd) {
  const c = String(cmd || '');
  if (/\b(test|jest|vitest|pytest|mocha|e2e|playwright)\b/i.test(c)) return 'Running tests';
  if (/\b(tsc|eslint|lint|ruff|mypy|prettier)\b/i.test(c)) return 'Checking the code';
  if (/\b(build|vite|webpack|next build|cargo build|make)\b/i.test(c)) return 'Building';
  if (/\b(npm|pnpm|yarn|pip|brew|bun)\s+(i|install|add)\b/i.test(c)) return 'Installing packages';
  if (/^\s*git\b|\bgh\b/.test(c)) return 'Using git';
  if (/\b(curl|wget)\b/.test(c)) return 'Fetching a URL';
  if (/^\s*(ls|cat|head|tail|find|grep|rg|sed -n|wc)\b/.test(c)) return 'Looking through files';
  return 'Running a command';
}
// The plan as the Claude app shows it: TodoWrite lists, or update_plan items with advance/done/start.
function applyPlan(plan, b) {
  const i = b.input || {};
  if (b.name === 'TodoWrite' && Array.isArray(i.todos)) return i.todos.map((t) => ({ content: String(t.content || t.activeForm || ''), status: t.status || 'pending' }));
  if (!/update_plan$/.test(b.name || '')) return null;
  if (Array.isArray(i.items)) return i.items.map((t) => ({ content: String(t.content || ''), status: t.status || 'pending' }));
  if (!plan) return null;
  const next = plan.map((t) => ({ ...t }));
  const cur = next.findIndex((t) => t.status === 'in_progress');
  if (i.advance) {
    if (cur >= 0) next[cur].status = 'completed';
    const after = next.findIndex((t, k) => k > cur && t.status === 'pending');
    if (after >= 0) next[after].status = 'in_progress';
  }
  for (const n of Array.isArray(i.done) ? i.done : []) if (next[n - 1]) next[n - 1].status = 'completed';
  if (i.start && next[i.start - 1]) { next.forEach((t) => { if (t.status === 'in_progress') t.status = 'pending'; }); next[i.start - 1].status = 'in_progress'; }
  return next;
}
function planText(plan) { return plan.map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'} ${t.content}`).join('\n'); }
// One short detail after the step label: the file, command, query or URL it worked on.
function toolDetail(b) {
  const i = b.input || {};
  const d = i.description && i.command ? i.command : i.file_path || i.notebook_path || i.pattern || i.query || i.url || (i.prompt && b.name !== 'Task' && b.name !== 'Agent' ? i.prompt : '') || '';
  return d ? ` · ${truncate(String(d).replace(/\s+/g, ' '), 140)}` : '';
}

function toolLabel(b) {
  const i = b.input || {};
  const file = i.file_path || i.notebook_path ? base(i.file_path || i.notebook_path) : '';
  switch (b.name) {
    case 'Bash': return truncate(i.description ? String(i.description) : commandVerb(i.command), 60);
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return truncate(file ? `Editing ${file}` : 'Editing files', 60);
    case 'Read': return truncate(file ? `Reading ${file}` : 'Reading files', 60);
    case 'Grep': case 'Glob': return 'Searching the code';
    case 'WebFetch': return 'Reading a web page';
    case 'WebSearch': return truncate(i.query ? `Searching the web for ${i.query}` : 'Searching the web', 60);
    case 'Task': case 'Agent': return truncate(i.description ? `Subagent: ${i.description}` : 'Running a subagent', 60);
    case 'TodoWrite': return 'Updating the plan';
    case 'Skill': return truncate(i.skill ? `Using ${i.skill}` : 'Using a skill', 60);
    default: return truncate(String(b.name || 'Tool').replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').replace(/[_-]+/g, ' '), 60);
  }
}

function parseSession(file) {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.parsed;
  const lines = readJsonl(file);
  const messages = [];
  const usage = []; // {ts, model, input, output}
  const seenUsage = new Set();
  let cwd = null, summary = null, gitBranch = null, sessionId = path.basename(file, '.jsonl');
  const act = { prompt: '', tool: '', text: '', last: null, textAt: 0 };
  let plan = null; // [{ content, status }] — the latest plan, as the Claude app shows it
  for (const l of lines) {
    if (l.type === 'summary' && l.summary) summary = l.summary;
    if (l.cwd) cwd = l.cwd;
    if (l.gitBranch) gitBranch = l.gitBranch;
    if (l.sessionId) sessionId = l.sessionId;
    if ((l.type === 'user' || l.type === 'assistant') && l.message && !l.isSidechain) {
      const ts = l.timestamp ? Date.parse(l.timestamp) : st.mtimeMs;
      const m = l.message;
      if (l.type === 'assistant' && m.usage && m.id && !seenUsage.has(m.id)) {
        seenUsage.add(m.id);
        const u = m.usage;
        usage.push({ ts, model: m.model, input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cacheRead: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 });
      }
      // Skip tool results (user turns that only carry tool output).
      if (l.type === 'user' && Array.isArray(m.content) && m.content.every((b) => b.type === 'tool_result')) { act.last = 'result'; continue; }
      const text = textOf(m.content);
      if (l.isMeta || isNoise(text)) continue;
      if (l.type === 'user') { if (!isWrapper(text)) act.prompt = truncate(text, 160); act.tool = ''; act.last = 'prompt'; }
      else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_use') { act.tool = toolLabel(b); act.last = 'tool'; }
          else if (b.type === 'text' && b.text && b.text.trim()) { act.text = truncate(plain(b.text), 200); act.last = 'text'; act.textAt = ts; }
        }
      } else if (text) { act.text = truncate(plain(text), 200); act.last = 'text'; act.textAt = ts; }
      const isTool = l.type === 'assistant' && Array.isArray(m.content) && m.content.every((b) => b.type !== 'text');
      if (isTool) {
        // Plan steps and end-of-turn recaps read like the Claude app shows them, not as raw tool calls.
        for (const b of m.content) {
          if (b.type !== 'tool_use') continue;
          const step = applyPlan(plan, b);
          if (step) { plan = step; messages.push({ id: `${l.uuid || messages.length}:plan:${b.id || ''}`, role: 'assistant', text: planText(plan), ts, kind: 'plan', plan }); continue; }
          const recap = /wrap_up$/.test(b.name || '') && b.input && b.input.recap;
          if (recap) { messages.push({ id: `${l.uuid || messages.length}:recap`, role: 'assistant', text: String(recap), ts, kind: 'recap' }); continue; }
          messages.push({ id: `${l.uuid || messages.length}:${b.id || messages.length}`, role: 'assistant', text: `⟢ ${toolLabel(b)}${toolDetail(b)}`, ts, kind: 'tool' });
        }
        continue;
      }
      messages.push({ id: l.uuid || `${messages.length}`, role: m.role || l.type, text, ts });
    }
  }
  const firstUser = messages.find((m) => m.role === 'user' && !isWrapper(m.text));
  const lastText = [...messages].reverse().find((m) => !m.kind || m.kind === 'recap');
  // The card shows the newest reply, not the user's own prompt or an old summary.
  const lastReply = [...messages].reverse().find((m) => (!m.kind || m.kind === 'recap') && m.role === 'assistant');
  const shown = lastReply || lastText;
  const parsed = {
    sessionId, cwd, gitBranch, messages, usage,
    title: truncate((firstUser && firstUser.text) || summary || 'Untitled session', 80),
    preview: shown ? truncate(plain(shown.text), 220) : '',
    previewAt: shown ? shown.ts : null,
    lastRole: lastText ? lastText.role : null,
    updatedAt: st.mtimeMs,
    act,
    plan,
  };
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, parsed });
  return parsed;
}

// What the session is doing right now. Recomputed on every read since "running" depends on the clock.
// A sentence the agent wrote in the last 30 s says more than the tool it then reached for.
function activityOf(s) {
  const a = s.act || {};
  const now = Date.now();
  const running = !!a.last && a.last !== 'text' && now - s.updatedAt < 90000;
  const fresh = a.text && a.textAt && now - a.textAt < 30000;
  return { prompt: a.prompt || '', tool: !fresh && (a.last === 'tool' || a.last === 'result') ? a.tool : '', text: a.text || '', running };
}

// Read only the start or end of a big file, as JSONL lines (a cut first/last line is dropped).
function readSlice(file, bytes, fromEnd) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fromEnd ? size - len : 0);
    let lines = buf.toString('utf8').split('\n');
    if (fromEnd && len < size) lines = lines.slice(1);
    if (!fromEnd && len < size) lines = lines.slice(0, -1);
    const out = [];
    for (const line of lines) { if (line.trim()) { try { out.push(JSON.parse(line)); } catch {} } }
    return out;
  } catch { return []; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}

const subCache = new Map(); // file -> { mtimeMs, size, info }
function subagentInfo(file, st) {
  const hit = subCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.info;
  const head = readSlice(file, 16384, false);
  const first = head.find((l) => l.type === 'user' && l.message);
  let title = '';
  try { title = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')).description || ''; } catch {}
  if (!title && first) title = textOf(first.message.content);
  let lastText = '';
  const tail = readSlice(file, 65536, true);
  for (let i = tail.length - 1; i >= 0 && !lastText; i--) {
    const l = tail[i];
    if (l.type !== 'assistant' || !l.message) continue;
    const c = l.message.content;
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
    if (t.trim()) lastText = truncate(plain(t), 200);
  }
  const info = { id: path.basename(file, '.jsonl'), title: truncate(title || 'Subagent', 80), lastText, parent: (head.find((l) => l.sessionId) || {}).sessionId || null };
  subCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, info });
  return info;
}

// Subagents of one session: <project>/<sessionId>/subagents/*.jsonl, workflow workers in
// <sessionId>/subagents/workflows/<run>/agent-*.jsonl, plus the older layout of agent-*.jsonl
// sidechain files next to the session that name it as their sessionId. Files are stat'ed first and
// only the newest 20 are read.
const SUB_RUNNING_MS = 60000;
function subagentsFor(file, sessionId) {
  const cands = [];
  const stat = (f, extra) => { try { cands.push({ f, st: fs.statSync(f), ...extra }); } catch {} };
  const jsonl = (dir) => { try { return fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n)); } catch { return []; } };
  const subDir = path.join(path.dirname(file), sessionId, 'subagents');
  for (const f of jsonl(subDir)) stat(f, { kind: 'subagent' });
  let runs = []; try { runs = fs.readdirSync(path.join(subDir, 'workflows')); } catch {}
  for (const r of runs) for (const f of jsonl(path.join(subDir, 'workflows', r))) stat(f, { kind: 'workflow', workflow: r });
  for (const f of jsonl(path.dirname(file))) if (/^agent-.*\.jsonl$/.test(path.basename(f))) stat(f, { kind: 'subagent', filter: true });
  const out = [];
  for (const c of cands.sort((x, y) => y.st.mtimeMs - x.st.mtimeMs)) {
    if (out.length >= 20) break;
    const info = subagentInfo(c.f, c.st);
    if (c.filter && info.parent !== sessionId) continue;
    const s = { id: info.id, kind: c.kind, title: info.title, lastText: info.lastText, updatedAt: c.st.mtimeMs, status: Date.now() - c.st.mtimeMs < SUB_RUNNING_MS ? 'running' : 'done' };
    if (c.workflow) s.workflow = c.workflow;
    out.push(s);
  }
  return out;
}

// Subagent and workflow side-threads are never cards, so skip them before parsing.
const SIDE = /[/\\](subagents|workflows)[/\\]/;
function sessionFiles(account, days = 21) {
  const dir = path.join(configDir(account), 'projects');
  return walk(dir, (n) => n.endsWith('.jsonl') && !n.startsWith('agent-'), days == null ? 0 : Date.now() - days * DAY).filter((f) => !SIDE.test(f.path));
}

// Switchboard's own runs (the overall agent, smart group, topics) are not cards of their own. They run in
// ~/.switchboard, and older ones are known by how their prompt starts. Their ids are kept so the
// board can drop rows it saved for them.
const INTERNAL_PROMPT = /^(You are the overall agent inside Switchboard|Group these cards from my work whiteboard|These are my (current )?AI chats)/;
const internal = new Set();
const internalSessions = () => internal;
function isInternal(s) {
  if (s.cwd) { const d = realDir(s.cwd), app = realDir(APP_DIR); if (d === app || d.startsWith(app + path.sep)) return true; }
  const first = s.messages.find((m) => m.role === 'user' && !isWrapper(m.text));
  return !!first && INTERNAL_PROMPT.test(first.text.trim());
}

// The desktop app names chats started from the phone "Remote Control session (from a project)";
// the first prompt says more.
function titleOf(app, s) {
  const t = app && app.title;
  if (t && !/^Remote Control session/i.test(t)) return t;
  if (s.title && s.title !== 'Untitled session') return s.title;
  return t || (s.preview ? truncate(s.preview, 80) : s.title);
}

// One session file as a card, or null when it has nothing to show.
function entityFor(account, file) {
  let s;
  try { s = parseSession(file); } catch { return null; }
  if (!s.messages.length) return null;
  if (isInternal(s)) { internal.add(s.sessionId); return null; }
  const app = claudeDesktop.titleFor(s.sessionId);
  const activity = activityOf(s);
  const subagents = subagentsFor(file, s.sessionId);
  const running = activity.running || subagents.some((a) => a.status === 'running');
  const category = classify.category(s.cwd, s.gitBranch);
  return {
    id: `cc:${account.id}:${s.sessionId}`,
    kind: 'session', source: 'claude-code', accountId: account.id,
    title: titleOf(app, s), preview: s.preview, updatedAt: s.updatedAt,
    status: running ? 'running' : (s.lastRole === 'assistant' ? 'idle' : 'waiting'),
    meta: {
      cwd: s.cwd, gitBranch: s.gitBranch, file, sessionId: s.sessionId, messages: s.messages.length,
      category, categoryLabel: classify.CATEGORY_LABEL[category], noise: classify.isNoise(s.cwd),
      account: account.label || null, fromDesktopApp: !!app || category === 'desktop',
      archived: !!(app && app.archived), previewAt: s.previewAt, activity, subagents,
    },
  };
}

// The board shows the last week; History reads every session through sessionFiles(account, null).
function list(account, { days = 7, max = 80 } = {}) {
  const files = sessionFiles(account, days).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, max);
  return files.map((f) => entityFor(account, f.path)).filter(Boolean);
}

// Agent (Cowork) sessions from the Claude desktop app, read-only, as 'claude-app' cards.
function desktopEntity(d) {
  if (!d.file) return null;
  let s; try { s = parseSession(d.file); } catch { return null; }
  if (!s.messages.length) return null;
  const activity = activityOf(s);
  const category = classify.category(d.cwd || s.cwd, null);
  return {
    id: d.id, kind: 'session', source: 'claude-app', accountId: null,
    title: titleOf({ title: d.title }, s) || truncate(d.initialMessage, 80) || 'Claude app session', preview: s.preview, updatedAt: d.updatedAt || s.updatedAt,
    status: activity.running ? 'running' : 'idle',
    meta: {
      activity, cwd: d.cwd || s.cwd, file: d.file, sessionId: s.sessionId, messages: s.messages.length,
      category, categoryLabel: classify.CATEGORY_LABEL[category], noise: false, archived: d.archived, readOnly: true,
      appAccount: `${d.acct.slice(0, 8)}/${d.org.slice(0, 8)}`, account: d.accountName ? `Claude app · ${d.accountName}` : 'Claude app',
    },
  };
}
function desktopList({ days = 7 } = {}) {
  const since = days == null ? 0 : Date.now() - days * DAY;
  return claudeDesktop.agentSessions().filter((d) => d.updatedAt >= since).map(desktopEntity).filter(Boolean);
}

function transcript(account, file) {
  return parseSession(file).messages;
}

// Token usage in rolling windows, from every session touched in the last 7 days.
function usage(account) {
  const now = Date.now();
  const w = { h5: 0, d1: 0, d7: 0, out7: 0, sessions: 0, byModel: {} };
  for (const f of sessionFiles(account, 7)) {
    let s; try { s = parseSession(f.path); } catch { continue; }
    w.sessions++;
    for (const u of s.usage) {
      const t = u.input + u.output;
      if (now - u.ts < 5 * 3600000) w.h5 += t;
      if (now - u.ts < DAY) w.d1 += t;
      if (now - u.ts < 7 * DAY) { w.d7 += t; w.out7 += u.output; w.byModel[u.model || 'unknown'] = (w.byModel[u.model || 'unknown'] || 0) + t; }
    }
  }
  // The real weekly % from the Claude app's plan meter, when it tracks this account's org.
  const plan = planFor(account);
  if (plan) Object.assign(w, { weekPct: plan.week, fiveHourPct: plan.fiveHour, resetsAt: plan.resetsAt, planAt: plan.at, org: plan.org, exact: true });
  return w;
}

function orgOf(account) {
  const auth = account.config && account.config.auth;
  if (auth && auth.orgId) return auth.orgId;
  const f = readAccountFile(account);
  return (f && f.organizationUuid) || null;
}
function planFor(account) {
  const org = orgOf(account);
  return org ? claudeDesktop.planUsage().find((p) => p.org === org) || null : null;
}

function detect() {
  // Suggest config dirs that look like Claude Code homes (~/.claude, ~/.claude-*).
  const found = [];
  let entries = [];
  try { entries = fs.readdirSync(HOME); } catch {}
  for (const name of entries) {
    if (!/^\.claude([-_.].+)?$/.test(name)) continue;
    const p = path.join(HOME, name);
    if (exists(path.join(p, 'projects'))) found.push('~/' + name);
  }
  return found;
}

// Environment for a `claude` process that runs as this account and nothing else.
// Each account card has its own config folder, which Claude Code uses for that login's
// credentials (its own Keychain entry on macOS), settings and session history. Variables that
// would override the folder's login (an API key or token in your shell) are removed.
const OVERRIDES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CCR_OAUTH_TOKEN_FILE', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID'];
function isDefaultDir(dir) { return path.resolve(dir) === path.resolve(path.join(HOME, '.claude')); }
function childEnv(account) {
  const env = {};
  for (const k of OVERRIDES) env[k] = undefined;
  const dir = configDir(account);
  if (!isDefaultDir(dir)) env.CLAUDE_CONFIG_DIR = dir;
  return env;
}

// Who this folder is signed in as. Uses `claude auth status` (JSON), and falls back to the
// account details Claude Code keeps in .claude.json. Field names vary by version, so read loosely.
function pick(obj, re) {
  if (!obj || typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj)) {
    if (re.test(k) && (typeof v === 'string' || typeof v === 'number') && v !== '') return String(v);
  }
  for (const v of Object.values(obj)) { if (v && typeof v === 'object') { const r = pick(v, re); if (r) return r; } }
  return null;
}
function readAccountFile(account) {
  const dir = configDir(account);
  const f = isDefaultDir(dir) ? path.join(HOME, '.claude.json') : path.join(dir, '.claude.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).oauthAccount || null; } catch { return null; }
}
async function authStatus(account) {
  const bin = account.config.bin || which('claude');
  let j = null, loggedIn = null;
  if (bin) {
    const r = await run(bin, ['auth', 'status'], { env: childEnv(account), cwd: HOME, signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (r) {
      try { j = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop()); } catch {}
      loggedIn = j && typeof j.loggedIn === 'boolean' ? j.loggedIn : (j && j.authMethod ? j.authMethod !== 'none' : r.code === 0);
    }
  }
  const f = readAccountFile(account);
  const status = {
    loggedIn: loggedIn == null ? !!f : loggedIn,
    method: (j && j.authMethod) || (f ? 'claude.ai' : null),
    // `claude auth status` (Claude Code 2.x) prints email, orgId, orgName and subscriptionType
    // for a claude.ai login. Older versions print less, so fall back to the folder's .claude.json.
    email: (j && j.email) || pick(j, /email/i) || (f && f.emailAddress) || null,
    org: (j && j.orgName) || pick(j, /^org(anization)?_?name$|organizationName/i) || (f && (f.organizationName || null)) || null,
    orgId: (j && j.orgId) || (f && f.organizationUuid) || null,
    plan: (j && (j.subscriptionType || j.planTier)) || pick(j, /subscription|plan|tier|billing/i) || (f && (f.subscriptionType || f.billingType || null)) || null,
    dir: configDir(account), cli: !!bin, checkedAt: Date.now(),
  };
  if (status.loggedIn === false) { status.email = null; status.org = null; status.orgId = null; status.plan = null; }
  return status;
}

// Sign this folder in. `claude auth login` opens the browser; on claude.ai you choose which
// account and organization (for example your Team org or your personal plan) this card uses.
function login(account, { email, onOutput, signal } = {}) {
  const bin = account.config.bin || which('claude');
  if (!bin) return Promise.reject(new Error('Claude Code (the `claude` command) was not found on this Mac. Install it first: npm install -g @anthropic-ai/claude-code'));
  fs.mkdirSync(configDir(account), { recursive: true });
  const args = ['auth', 'login'];
  if (email) args.push('--email', email);
  return run(bin, args, { env: childEnv(account), cwd: HOME, onLine: onOutput, signal }).then((r) => {
    if (signal && signal.aborted) throw new Error('Sign-in cancelled');
    if (r.code !== 0) throw new Error(truncate(r.stderr || r.stdout || 'Sign-in did not finish', 300));
    return authStatus(account);
  });
}
async function logout(account) {
  const bin = account.config.bin || which('claude');
  if (!bin) throw new Error('Claude Code was not found on this Mac');
  await run(bin, ['auth', 'logout'], { env: childEnv(account), cwd: HOME });
  return authStatus(account);
}

// The models a chat can pick per message (Claude Code's own aliases). Empty or 'default' means
// "whatever the account uses"; anything else is refused, so nothing odd reaches the command line.
const MODELS = ['opus', 'sonnet', 'haiku'];
function modelName(m) {
  if (m == null) return null;
  const k = String(m).trim().toLowerCase();
  if (!k || k === 'default') return null;
  if (!MODELS.includes(k)) throw new Error(`Unknown model "${truncate(String(m), 40)}". Pick Opus, Sonnet or Haiku.`);
  return k;
}

// Send a prompt. Resumes `sessionId` when given, otherwise starts a new session in cwd.
// `model` is one of MODELS (or empty for the account's default); `signal` stops the run.
async function prompt(account, { sessionId, cwd, text, onText, signal, model, extraArgs = [] }) {
  const bin = account.config.bin || which('claude');
  if (!bin) throw new Error('Claude Code (the `claude` command) was not found on this Mac.');
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (sessionId) args.push('--resume', sessionId);
  const mode = account.config.permissionMode;
  if (mode && mode !== 'default') args.push('--permission-mode', mode);
  const m = modelName(model);
  if (m) args.push('--model', m);
  args.push(...extraArgs);
  const env = childEnv(account);
  let acc = '', final = null, newSession = sessionId, usageOut = null;
  const res = await run(bin, args, {
    cwd: cwd && exists(cwd) ? cwd : HOME, env, input: text, signal,
    onLine: (line) => {
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (ev.session_id) newSession = ev.session_id;
      if (ev.type === 'assistant' && ev.message) {
        const t = textOf(ev.message.content);
        if (t) { acc += (acc ? '\n\n' : '') + t; onText && onText(acc); }
      }
      if (ev.type === 'result') { final = ev.result; usageOut = ev.usage || null; }
    },
  });
  if (res.code !== 0 && !acc && !final) throw new Error(truncate(res.stderr || res.stdout || `claude exited with ${res.code}`, 400));
  return { text: final || acc, sessionId: newSession, usage: usageOut };
}

module.exports = { orgOf, internalSessions, list, entityFor, sessionFiles, desktopList, desktopEntity, parseSession, transcript, usage, detect, prompt, MODELS, modelName, configDir, childEnv, authStatus, login, logout };
