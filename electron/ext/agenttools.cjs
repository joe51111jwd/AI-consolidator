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

function claudeHas(a, sb) {
  const dir = claudeCode.configDir(a);
  const def = path.resolve(dir) === path.resolve(path.join(util.HOME, '.claude'));
  try {
    const j = JSON.parse(fs.readFileSync(def ? path.join(util.HOME, '.claude.json') : path.join(dir, '.claude.json'), 'utf8'));
    const s = j.mcpServers && j.mcpServers.switchboard;
    return !!s && s.command === sb && (s.env || {}).SB_FROM === `ac:${a.id}`;
  } catch { return false; }
}
function codexHas(a, sb) {
  try {
    const t = fs.readFileSync(path.join(util.expand(a.config.home || '~/.codex'), 'config.toml'), 'utf8');
    return /\[mcp_servers\.switchboard\]/.test(t) && t.includes(sb) && t.includes(`ac:${a.id}`);
  } catch { return false; }
}

async function apply(on, { force = false } = {}) {
  const sb = sbPath();
  const results = [];
  for (const a of ctx.hub.accounts()) {
    if (a.kind === 'claude-code') {
      const bin = a.config.bin || util.which('claude'); if (!bin) { results.push(`${a.label}: claude command not found`); continue; }
      const env = claudeCode.childEnv(a);
      if (on && !force && claudeHas(a, sb)) { results.push(`${a.label}: ready`); continue; }
      await util.run(bin, ['mcp', 'remove', '--scope', 'user', 'switchboard'], { env }).catch(() => {});
      if (!on) { results.push(`${a.label}: removed`); continue; }
      const r = await util.run(bin, ['mcp', 'add', '--scope', 'user', 'switchboard', '-e', `SB_FROM=ac:${a.id}`, '--', sb, 'mcp'], { env }).catch((e) => ({ code: 1, stderr: e.message }));
      results.push(`${a.label}: ${r.code === 0 ? 'added' : util.truncate(r.stderr || r.stdout, 120)}`);
    }
    if (a.kind === 'codex') {
      const bin = util.which('codex'); if (!bin) { results.push(`${a.label}: codex command not found`); continue; }
      if (on && !force && codexHas(a, sb)) { results.push(`${a.label}: ready`); continue; }
      await util.run(bin, ['mcp', 'remove', 'switchboard']).catch(() => {});
      if (!on) { results.push(`${a.label}: removed`); continue; }
      const r = await util.run(bin, ['mcp', 'add', 'switchboard', '--env', `SB_FROM=ac:${a.id}`, '--', sb, 'mcp']).catch((e) => ({ code: 1, stderr: e.message }));
      results.push(`${a.label}: ${r.code === 0 ? 'added' : util.truncate(r.stderr || r.stdout, 120)}`);
    }
  }
  last = { at: Date.now(), results };
  return last;
}

function queue(on, opts) {
  const job = chain.then(() => apply(on, opts));
  chain = job.catch(() => {});
  return job;
}

module.exports = {
  handlers: {
    'agentTools:get': () => ({ on: isOn(), ...last, sb: sbPath() }),
    'agentTools:set': async (on) => { ctx.db.setSetting('autoAgentTools', !!on); return { on: !!on, ...(await queue(!!on, { force: true })) }; },
  },
  start(c) {
    ctx = c;
    // Also picks up accounts added later (cheap: it only reads config files when nothing is missing).
    const tick = () => { if (isOn() && fs.existsSync(sbPath())) queue(true).catch(() => {}); };
    setTimeout(tick, 3000);
    setInterval(tick, 5 * 60000);
  },
};
