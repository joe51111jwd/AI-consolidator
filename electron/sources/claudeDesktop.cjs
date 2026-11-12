'use strict';
// The Claude desktop app's own session index (read-only).
// - claude-code-sessions/<account>/<org>/local_<id>.json: titles the app shows for Claude Code
//   sessions; cliSessionId matches ~/.claude/projects/**/<cliSessionId>.jsonl.
// - local-agent-mode-sessions/<account>/<org>/local_<id>.json: agent (Cowork) sessions, with full
//   transcripts in local_<id>/.claude/projects/**/*.jsonl (same format as Claude Code).
// Only these metadata files and transcripts are read: never config.json, Cookies, token files,
// claude_desktop_config.json or the leveldb/IndexedDB stores. claude.ai web chats are not kept
// locally in a usable form, so they are not listed here.
const fs = require('fs');
const path = require('path');
const { appDataDir, walk } = require('../util.cjs');

// ~/Library/Application Support/Claude on macOS, %APPDATA%\Claude on Windows, ~/.config/Claude on Linux.
const ROOT = path.join(appDataDir(), 'Claude');
let memo = { at: 0, titles: new Map(), agents: [] };

function readIndex(sub) {
  const base = path.join(ROOT, sub);
  const out = [];
  let accts = [];
  try { accts = fs.readdirSync(base); } catch { return out; }
  for (const acct of accts) {
    let orgs = []; try { orgs = fs.readdirSync(path.join(base, acct)); } catch { continue; }
    for (const org of orgs) {
      const dir = path.join(base, acct, org);
      let files = []; try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!/^local_[\w-]+\.json$/.test(f)) continue;
        try { out.push({ ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), localId: f.slice(0, -5), dir, acct, org }); } catch {}
      }
    }
  }
  return out;
}

const ts = (v) => (typeof v === 'number' ? v : Date.parse(v) || 0);

function load() {
  if (Date.now() - memo.at < 5000) return memo;
  const titles = new Map();
  for (const s of readIndex('claude-code-sessions')) if (s.cliSessionId) titles.set(s.cliSessionId, { title: s.title || null, archived: !!s.isArchived });
  const agents = readIndex('local-agent-mode-sessions').map((s) => {
    const files = walk(path.join(s.dir, s.localId, '.claude', 'projects'), (n) => n.endsWith('.jsonl'))
      .filter((f) => !/[/\\](subagents|workflows)[/\\]/.test(f.path)).sort((a, b) => b.mtimeMs - a.mtimeMs);
    return {
      id: `cd:${s.acct.slice(0, 8)}-${s.org.slice(0, 8)}:${s.localId}`, localId: s.localId, acct: s.acct, org: s.org,
      title: s.title || null, cwd: s.cwd || (s.userSelectedFolders && s.userSelectedFolders[0]) || null,
      createdAt: ts(s.createdAt), updatedAt: Math.max(ts(s.lastActivityAt), files[0] ? files[0].mtimeMs : 0),
      archived: !!s.isArchived, file: files[0] ? files[0].path : null, accountName: typeof s.accountName === 'string' ? s.accountName : null, initialMessage: typeof s.initialMessage === 'string' ? s.initialMessage : '',
    };
  });
  memo = { at: Date.now(), titles, agents };
  return memo;
}

function titleFor(cliSessionId) { return load().titles.get(cliSessionId) || null; }
function agentSessions() { return load().agents; }

// The app's own plan meter: plan-usage-history.json holds samples { t, org, u: { sd, fh } } where
// sd is the weekly (seven-day) % and fh the five-hour %. The newest sample per org is the real
// number; the weekly reset is estimated from the last big drop in sd, rolled forward by a week.
const WEEK = 7 * 86400000;
let planMemo = { at: 0, mtimeMs: -1, value: [] };
function planUsage(now = Date.now()) {
  const file = path.join(ROOT, 'plan-usage-history.json');
  let st; try { st = fs.statSync(file); } catch { return []; }
  if (st.mtimeMs === planMemo.mtimeMs && now - planMemo.at < 60000) return planMemo.value;
  let samples = [];
  try { samples = JSON.parse(fs.readFileSync(file, 'utf8')).samples || []; } catch { return planMemo.value; }
  const byOrg = new Map();
  for (const s of samples) {
    if (!s || typeof s.org !== 'string' || !s.u || typeof s.t !== 'number') continue;
    if (!byOrg.has(s.org)) byOrg.set(s.org, []);
    byOrg.get(s.org).push(s);
  }
  const names = new Map();
  for (const a of agentSessions()) if (a.accountName && !names.has(a.org)) names.set(a.org, a.accountName);
  const value = [];
  for (const [org, list] of byOrg) {
    list.sort((a, b) => a.t - b.t);
    const last = list[list.length - 1];
    let reset = null;
    for (let i = 1; i < list.length; i++) if ((list[i - 1].u.sd || 0) - (list[i].u.sd || 0) >= 10) reset = list[i].t;
    let resetsAt = null;
    if (reset) { resetsAt = reset + WEEK; while (resetsAt < now) resetsAt += WEEK; }
    value.push({ org, name: names.get(org) || null, week: Number(last.u.sd) || 0, fiveHour: Number(last.u.fh) || 0, at: last.t, resetsAt });
  }
  value.sort((a, b) => b.week - a.week);
  planMemo = { at: now, mtimeMs: st.mtimeMs, value };
  return value;
}

module.exports = { ROOT, titleFor, agentSessions, planUsage };
