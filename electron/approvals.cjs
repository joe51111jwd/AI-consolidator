'use strict';
// Permission requests from Claude Code chats started or continued in Switchboard, answered in
// Switchboard instead of the Claude app. Each such chat runs with
//   --mcp-config <file> --permission-prompt-tool mcp__switchboard__approve_tool
// so when Claude wants to run a command or edit a file, Claude Code calls approve_tool in `sb mcp`
// (electron/cli/sb.cjs). That posts to the local bus (POST /approve, electron/bus.cjs), which waits
// here until the owner presses Allow once, Always allow, or Deny on the chat, or 10 minutes pass.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const db = require('./db.cjs');
const { APP_DIR, exists, truncate } = require('./util.cjs');

const PROMPT_TOOL = 'mcp__switchboard__approve_tool';
const TIMEOUT_MS = 10 * 60000;
const RULES_KEY = 'approvalRules'; // setting: chat card id -> tools always allowed in that chat
const DIR = path.join(APP_DIR, 'approvals');

const events = new EventEmitter();
const runs = new Map();    // run key -> { key, chat, origin, accountId, rules: Set }
const pending = new Map(); // approval id -> { approval, input, run, resolve, timer }

const rules = () => db.getSetting(RULES_KEY, {}) || {};
function emit(added) {
  events.emit('event', { type: 'approvals', approvals: list(), rules: rules(), ...(added ? { added } : {}) });
}

// ---------- what the request is about, for the card ----------
const base = (f) => String(f || '').split(/[\\/]/).pop();
const MAX_DIFF = 60;
// Changed lines only: the lines both sides share at the start and end are left out, but one of
// them is kept on each side as context.
function diffOf(before, after) {
  const a = before == null || before === '' ? [] : String(before).split('\n');
  const b = after == null || after === '' ? [] : String(after).split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const lines = [];
  if (s > 0) lines.push([' ', a[s - 1]]);
  for (const l of a.slice(s, a.length - e)) lines.push(['-', l]);
  for (const l of b.slice(s, b.length - e)) lines.push(['+', l]);
  if (e > 0) lines.push([' ', a[a.length - e]]);
  const removed = a.length - e - s, added = b.length - e - s;
  // Indentation matters in code, so long lines are cut, never squeezed.
  const cut = (l) => (l.length > 400 ? `${l.slice(0, 399)}…` : l);
  return { lines: lines.slice(0, MAX_DIFF).map(([t, l]) => [t, cut(l)]), added, removed, more: Math.max(0, lines.length - MAX_DIFF) };
}
function joinDiffs(ds) {
  const lines = [];
  for (const d of ds) { if (lines.length) lines.push(['…', '']); lines.push(...d.lines); }
  return { lines: lines.slice(0, MAX_DIFF), added: ds.reduce((n, d) => n + d.added, 0), removed: ds.reduce((n, d) => n + d.removed, 0), more: Math.max(0, lines.length - MAX_DIFF) + ds.reduce((n, d) => n + d.more, 0) };
}
const json = (v) => { try { return truncate(JSON.stringify(v), 600); } catch { return ''; } };

// { kind, title, line, command?, file?, detail?, diff? }: `line` is the one-line version the
// to-do list shows after "Approve:".
function describe(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  const file = String(i.file_path || i.notebook_path || '');
  switch (tool) {
    case 'Bash': {
      const command = String(i.command || '');
      return { kind: 'command', title: i.description ? truncate(i.description, 120) : 'Run a command', line: truncate(command, 90) || 'Run a command', command: command.slice(0, 4000) };
    }
    case 'Edit': return { kind: 'edit', title: `Edit ${base(file)}`, line: `Edit ${base(file)}`, file, diff: diffOf(i.old_string, i.new_string) };
    case 'MultiEdit': return { kind: 'edit', title: `Edit ${base(file)}`, line: `Edit ${base(file)}`, file, diff: joinDiffs((Array.isArray(i.edits) ? i.edits : []).map((x) => diffOf(x && x.old_string, x && x.new_string))) };
    case 'NotebookEdit': return { kind: 'edit', title: `Edit ${base(file)}`, line: `Edit ${base(file)}`, file, diff: diffOf('', i.new_source) };
    case 'Write': {
      const verb = file && exists(file) ? 'Overwrite' : 'Create';
      return { kind: 'write', title: `${verb} ${base(file)}`, line: `${verb} ${base(file)}`, file, diff: diffOf('', i.content) };
    }
    case 'WebFetch': {
      let host = ''; try { host = new URL(String(i.url)).host; } catch {}
      return { kind: 'web', title: `Open ${host || 'a web page'}`, line: `Open ${host || 'a web page'}`, detail: truncate(i.url, 300) };
    }
    case 'WebSearch': return { kind: 'web', title: 'Search the web', line: `Search the web for ${truncate(i.query, 60)}`, detail: truncate(i.query, 300) };
    default: {
      const m = String(tool || '').match(/^mcp__(.+?)__(.+)$/);
      const name = m ? `${m[2].replace(/[_-]+/g, ' ')} (${m[1]})` : String(tool || 'a tool');
      return { kind: 'tool', title: `Use ${name}`, line: `Use ${name}`, detail: json(i) };
    }
  }
}

// ---------- runs ----------
// A Switchboard run of a Claude chat. Returns what claudeCode.prompt needs to send the chat's
// permission questions here, or null when the `sb` command isn't installed (the run then goes on
// without asking, as before). `origin` is the card the prompt was sent to; the chat's own card id is
// known for a resumed chat, and learned from Claude Code's first event for a new one.
function openRun({ origin, accountId }) {
  const sb = path.join(APP_DIR, 'bin', 'sb');
  if (!exists(sb)) return null;
  const key = crypto.randomBytes(9).toString('hex');
  const run = { key, origin: origin || null, accountId: accountId || null, chat: origin && origin.startsWith('cc:') ? origin : null, rules: new Set() };
  runs.set(key, run);
  fs.mkdirSync(DIR, { recursive: true });
  const mcpConfig = path.join(DIR, `${key}.json`);
  // SB_ASK goes both in the MCP server's own env and in Claude's, which Claude Code passes on to the
  // servers it starts, so the question finds its chat even if a user-level `switchboard` server wins.
  const env = { SB_ASK: key };
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { switchboard: { command: sb, args: ['mcp'], env: { SB_FROM: run.chat || run.origin || 'mcp', ...env } } } }, null, 2), { mode: 0o600 });
  return {
    key, mcpConfig, env, tool: PROMPT_TOOL,
    onSession(sessionId) {
      if (!sessionId || !run.accountId) return;
      const chat = `cc:${run.accountId}:${sessionId}`;
      if (run.chat === chat) return;
      run.chat = chat;
      // Questions asked before the session id was known move to the chat's own card.
      let moved = false;
      for (const p of pending.values()) if (p.run === run && p.approval.chat !== chat) { p.approval.chat = chat; moved = true; }
      if (moved) emit();
    },
    close() {
      runs.delete(key);
      try { fs.rmSync(mcpConfig, { force: true }); } catch {}
      // The chat's process has ended, so nobody waits for these answers any more.
      let gone = false;
      for (const [id, p] of pending) if (p.run === run) { clearTimeout(p.timer); pending.delete(id); p.resolve({ behavior: 'deny', message: 'The chat stopped before the owner answered.' }); gone = true; }
      if (gone) emit();
    },
  };
}

// ---------- requests and answers ----------
function allowedAlways(run, chat, tool) {
  if (run && run.rules.has(tool)) return true;
  return !!chat && (rules()[chat] || []).includes(tool);
}

// A permission question from Claude Code, as approve_tool passes it on. Returns the approval's id
// (null when an "Always allow" already answers it) and a promise of Claude Code's answer:
// { behavior: 'allow', updatedInput } or { behavior: 'deny', message }.
function request({ ask, from, tool_name: tool, input, tool_use_id: toolUseId } = {}) {
  const run = (ask && runs.get(ask)) || null;
  const chat = run ? run.chat : null;
  input = input && typeof input === 'object' ? input : {};
  tool = String(tool || 'unknown tool');
  if (allowedAlways(run, chat, tool)) return { id: null, answer: Promise.resolve({ behavior: 'allow', updatedInput: input }) };
  const id = `ap_${crypto.randomBytes(6).toString('hex')}`;
  const now = Date.now();
  const approval = {
    id, tool, toolUseId: toolUseId || null, chat,
    origin: (run && run.origin) || (typeof from === 'string' && from !== 'mcp' && !from.startsWith('ext:') ? from : null),
    accountId: run ? run.accountId : null,
    summary: describe(tool, input), createdAt: now, expiresAt: now + TIMEOUT_MS,
  };
  let resolve;
  const answer = new Promise((r) => { resolve = r; });
  const timer = setTimeout(() => settle(id, { behavior: 'deny', message: 'The owner did not answer in Switchboard within 10 minutes, so this did not run. Ask again if it is still needed.' }), TIMEOUT_MS);
  if (timer.unref) timer.unref();
  pending.set(id, { approval, input, run, resolve, timer });
  emit(approval);
  return { id, answer };
}

function settle(id, result) {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(result);
  emit();
  return true;
}

function remember(chat, run, tool) {
  if (!chat) { if (run) run.rules.add(tool); return; }
  const all = rules();
  all[chat] = [...new Set([...(all[chat] || []), tool])];
  const keep = Object.entries(all).slice(-300);
  db.setSetting(RULES_KEY, Object.fromEntries(keep));
}

// choice: 'once' | 'always' | 'deny'. "Always" also lets through any other question for the same
// tool that this chat is already waiting on.
function answer(id, choice, message) {
  const p = pending.get(id);
  if (!p) throw new Error('That request was already answered or has expired.');
  if (choice === 'deny') {
    const why = typeof message === 'string' && message.trim() ? `The owner said no in Switchboard: ${message.trim().slice(0, 1000)}` : 'The owner said no in Switchboard.';
    return settle(id, { behavior: 'deny', message: why });
  }
  if (choice === 'always') {
    const { chat, tool } = p.approval;
    remember(chat, p.run, tool);
    for (const [other, q] of [...pending]) {
      if (other !== id && q.approval.tool === tool && ((chat && q.approval.chat === chat) || (!chat && q.run && q.run === p.run))) settle(other, { behavior: 'allow', updatedInput: q.input });
    }
  }
  return settle(id, { behavior: 'allow', updatedInput: p.input });
}

// The bus calls this when approve_tool hangs up (Claude Code stopped) before an answer.
function withdraw(id) {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve({ behavior: 'deny', message: 'Claude Code stopped waiting for an answer.' });
  emit();
  return true;
}

function list() { return [...pending.values()].map((p) => p.approval).sort((a, b) => a.createdAt - b.createdAt); }

function forget(chat, tool) {
  const all = rules();
  if (!all[chat]) return all;
  all[chat] = tool ? all[chat].filter((t) => t !== tool) : [];
  if (!all[chat].length) delete all[chat];
  db.setSetting(RULES_KEY, all);
  emit();
  return all;
}

module.exports = { PROMPT_TOOL, TIMEOUT_MS, events, openRun, request, answer, withdraw, list, rules, forget, describe };
