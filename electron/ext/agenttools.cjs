'use strict';
// "Let agents use Switchboard": registers the Switchboard MCP tools (the sb command) in every
// Claude account folder and Codex on startup, so agents can see cards, send work and add to the
// shared brain. Setting 'autoAgentTools' (default on). Idempotent: an account that already has the
// right entry is left alone, so startup normally runs no commands at all.
const fs = require('fs');
const path = require('path');
const util = require('../util.cjs');
const claudeCode = require('../sources/claudeCode.cjs');

let ctx = null;
let last = { at: 0, results: [] };
let chain = Promise.resolve();

const sbPath = () => path.join(util.APP_DIR, 'bin', 'sb');
const isOn = () => ctx.db.getSetting('autoAgentTools', true) !== false;

function claudeEntry(a) {
  const dir = claudeCode.configDir(a);
  const def = path.resolve(dir) === path.resolve(path.join(util.HOME, '.claude'));
  try {
    const j = JSON.parse(fs.readFileSync(def ? path.join(util.HOME, '.claude.json') : path.join(dir, '.claude.json'), 'utf8'));
    return (j.mcpServers && j.mcpServers.switchboard) || null;
  } catch { return null; }
}
const claudeOk = (s, a, sb) => !!s && s.command === sb && (s.env || {}).SB_FROM === `ac:${a.id}`;
function codexConfig(a) {
  try { return fs.readFileSync(path.join(util.expand(a.config.home || '~/.codex'), 'config.toml'), 'utf8'); } catch { return ''; }
}
const codexHasAny = (t) => /\[mcp_servers\.switchboard\]/.test(t);
const codexOk = (t, a, sb) => codexHasAny(t) && t.includes(sb) && t.includes(`ac:${a.id}`);

const fail = (e) => ({ code: 1, stderr: e.message });
const said = (r) => (r.code === 0 ? 'added' : util.truncate(r.stderr || r.stdout, 120));

// Never touches a config that is already right, and only removes an entry when one is there and
// differs (the CLIs refuse to add over it). If the add then fails, the old entry is put back, so
// a failed update never leaves an account without the server.
async function applyClaude(a, on, sb) {
  const bin = a.config.bin || util.which('claude'); if (!bin) return `${a.label}: claude command not found`;
  const env = claudeCode.childEnv(a);
  const cur = claudeEntry(a);
  if (!on) {
    if (cur) await util.run(bin, ['mcp', 'remove', '--scope', 'user', 'switchboard'], { env }).catch(() => {});
    return `${a.label}: removed`;
  }
  if (claudeOk(cur, a, sb)) return `${a.label}: ready`;
  if (cur) await util.run(bin, ['mcp', 'remove', '--scope', 'user', 'switchboard'], { env }).catch(() => {});
  const r = await util.run(bin, ['mcp', 'add', '--scope', 'user', 'switchboard', '-e', `SB_FROM=ac:${a.id}`, '--', sb, 'mcp'], { env }).catch(fail);
  if (r.code !== 0 && cur) await util.run(bin, ['mcp', 'add-json', '--scope', 'user', 'switchboard', JSON.stringify(cur)], { env }).catch(() => {});
  return `${a.label}: ${said(r)}`;
}

async function applyCodex(a, on, sb) {
  const bin = util.which('codex'); if (!bin) return `${a.label}: codex command not found`;
  const t = codexConfig(a);
  if (!on) {
    if (codexHasAny(t)) await util.run(bin, ['mcp', 'remove', 'switchboard']).catch(() => {});
    return `${a.label}: removed`;
  }
  if (codexOk(t, a, sb)) return `${a.label}: ready`;
  if (codexHasAny(t)) await util.run(bin, ['mcp', 'remove', 'switchboard']).catch(() => {});
  const r = await util.run(bin, ['mcp', 'add', 'switchboard', '--env', `SB_FROM=ac:${a.id}`, '--', sb, 'mcp']).catch(fail);
  return `${a.label}: ${said(r)}`;
}

async function apply(on) {
  const sb = sbPath();
  const results = [];
  for (const a of ctx.hub.accounts()) {
    if (a.kind === 'claude-code') results.push(await applyClaude(a, on, sb));
    if (a.kind === 'codex') results.push(await applyCodex(a, on, sb));
  }
  last = { at: Date.now(), results };
  return last;
}

function queue(on) {
  const job = chain.then(() => apply(on));
  chain = job.catch(() => {});
  return job;
}

module.exports = {
  handlers: {
    'agentTools:get': () => ({ on: isOn(), ...last, sb: sbPath() }),
    'agentTools:set': async (on) => { ctx.db.setSetting('autoAgentTools', !!on); return { on: !!on, ...(await queue(!!on)) }; },
  },
  start(c) {
    ctx = c;
    // Also picks up accounts added later (cheap: it only reads config files when nothing is missing).
    const tick = () => { if (isOn() && fs.existsSync(sbPath())) queue(true).catch(() => {}); };
    setTimeout(tick, 3000);
    setInterval(tick, 5 * 60000);
  },
};
