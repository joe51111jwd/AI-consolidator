#!/usr/bin/env node
'use strict';
// Dev tool: builds the home's exact topics prompt and runs it through the claude CLI once, then prints
// the groups. Spends one Sonnet call on whatever account `claude` is signed in to.
//   node scripts/try-grouping.cjs --items sample.json   items from a file (see below)
//   node scripts/try-grouping.cjs --recent              Claude Code sessions from ~/.claude*/projects, last 7 days
//   add --prompt to print the prompt, --dry to print it and stop before calling Claude,
//   --clients clients.json for known clients ([{ "name": "Michael", "company": "Reyes Realty" }]).
// An item is a Switchboard entity, or the short form
//   { "kind": "Claude chat" | "Grok bot" | "meeting" | "email", "title", "folder", "client", "asked", "latest", "with" }.
// Try: PATH=tests/fixtures/bin:$PATH node scripts/try-grouping.cjs --items sample.json
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const claudeCode = require('../electron/sources/claudeCode.cjs');
const { which } = require('../electron/util.cjs');
const { prompt: P } = require('../electron/ext/topics.cjs');

const DAY = 86400000;
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const SHORT = { 'claude chat': ['session', 'claude-code'], 'grok bot': ['session', 'grok-bot'], meeting: ['meeting', 'granola'], email: ['thread', 'gmail'] };
function fromShort(x, i) {
  if (x.meta || !SHORT[String(x.kind || '').toLowerCase()]) return { id: x.id || `item-${i + 1}`, meta: {}, ...x };
  const [kind, source] = SHORT[String(x.kind).toLowerCase()];
  const who = x.with ? [].concat(x.with) : [];
  return {
    id: x.id || `item-${i + 1}`, kind, source, title: x.title || 'Untitled', preview: x.latest || '', updatedAt: x.updatedAt || Date.now() - i,
    meta: {
      cwd: x.folder ? path.join('/work', x.folder) : undefined, project: x.folder || undefined, asked: x.asked || undefined, activity: x.latest || undefined,
      client: x.client ? { name: x.client } : undefined,
      attendees: kind === 'meeting' ? who.map((name) => ({ name })) : undefined, participants: kind === 'thread' ? who : undefined,
    },
  };
}

function recentSessions() {
  const since = Date.now() - 7 * DAY;
  const out = [];
  for (const d of fs.readdirSync(os.homedir()).filter((n) => /^\.claude(-.+)?$/.test(n))) {
    const root = path.join(os.homedir(), d, 'projects');
    if (!fs.existsSync(root)) continue;
    for (const proj of fs.readdirSync(root)) {
      const dir = path.join(root, proj);
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)); } catch { continue; }
      for (const file of files) {
        if (fs.statSync(file).mtimeMs < since) continue;
        try {
          const s = claudeCode.parseSession(file);
          if (!s.messages.length || /\/scratch-workspaces\/|\.switchboard$/.test(s.cwd || '')) continue;
          out.push({ id: s.sessionId, kind: 'session', source: 'claude-code', title: s.title, preview: s.preview, updatedAt: s.updatedAt, meta: { cwd: s.cwd, file } });
        } catch (e) { console.error(`skipped ${file}: ${e.message}`); }
      }
    }
  }
  return out;
}

// One `claude -p` call without tools or the user's hooks; answers the final text.
function ask(text) {
  const settings = path.join(os.tmpdir(), `try-grouping-${process.pid}.json`);
  fs.writeFileSync(settings, JSON.stringify({ disableAllHooks: true }));
  const bin = which('claude');
  if (!bin) return Promise.reject(new Error('The claude command was not found on PATH'));
  return new Promise((resolve, reject) => {
    const p = spawn(path.resolve(bin), ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--tools', '', '--settings', settings], { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      fs.rmSync(settings, { force: true });
      let result = null, acc = '';
      for (const line of out.split('\n')) {
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'result') result = ev.result;
        if (ev.type === 'assistant' && ev.message) acc += (ev.message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      }
      if (result || acc) resolve(result || acc); else reject(new Error(`claude exited with ${code} and no answer`));
    });
    p.stdin.end(text);
  });
}

async function main() {
  const file = val('--items');
  if (!file && !flag('--recent')) { console.error('Usage: node scripts/try-grouping.cjs --items <file.json> | --recent [--clients <file.json>] [--prompt] [--dry]'); process.exit(2); }
  const raw = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : recentSessions();
  const list = (Array.isArray(raw) ? raw : raw.items || []).map(fromShort);
  const clients = val('--clients') ? JSON.parse(fs.readFileSync(val('--clients'), 'utf8')) : [];
  if (!list.length) { console.error('No items.'); process.exit(1); }
  const items = P.forPrompt(list);
  const text = P.topicsPrompt(items, clients);
  if (flag('--prompt') || flag('--dry')) console.log(`${text}\n\n(${text.length} characters, ${items.length} of ${list.length} items)\n`);
  if (flag('--dry')) return;
  const answer = await ask(text);
  const topics = P.readTopics(answer, items, clients);
  const byId = new Map(items.map((e) => [e.id, e]));
  const groups = new Map();
  for (const t of topics) groups.set(t.group, [...(groups.get(t.group) || []), t]);
  for (const [group, ts] of groups) {
    console.log(`\n${group}${ts[0].client ? ' (client)' : ''}`);
    for (const t of ts) {
      console.log(`  ${t.label}${t.summary ? ` - ${t.summary}` : ''}`);
      for (const id of t.ids) console.log(`    · ${byId.get(id).title}`);
    }
  }
  if (list.length > items.length) console.log(`\n(${list.length - items.length} older items were left out of the prompt)`);
}

main().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
