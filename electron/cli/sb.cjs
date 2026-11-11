#!/usr/bin/env node
'use strict';
// `sb`: talk to the Switchboard app from any terminal, script or agent on this Mac.
//   sb cards                         list cards
//   sb send <card> "text" [--from grok-bot] [--wait] [--brain]
//   sb read <card> [n]               latest messages of a card
//   sb log <from> <to> "text"        show a message on the board without routing it
//   sb brain [append "text"]         read or add to the shared brain
//   sb output "title" "text"         drop an output card on the board
//   sb board "title" --json '{"nodes":[{"id":"a","text":"..."}],"edges":[{"from":"a","to":"b","label":"..."}]}'
//                                    draw a diagram (notes and arrows in a frame) on the board
//   sb due                           what's due for clients
//   sb mcp                           run as an MCP server (stdio) for Claude Code, Codex, Grok Bot
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.switchboard');
function conf() {
  try {
    return { token: fs.readFileSync(path.join(DIR, 'bus-token'), 'utf8').trim(), port: fs.readFileSync(path.join(DIR, 'bus-port'), 'utf8').trim() };
  } catch { throw new Error('Switchboard is not running (open the app first).'); }
}

async function call(method, route, body) {
  const { token, port } = conf();
  const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function flag(args, name) { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; }
function bool(args, name) { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; }

async function mcp() {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = require('zod');
  const from = process.env.SB_FROM || 'mcp';
  const server = new McpServer({ name: 'switchboard', version: '1.0.0' });
  const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
  server.tool('list_cards', 'List every card on the Switchboard board (agents, sessions, projects, clients, outputs).', {}, async () => text(await call('GET', '/cards')));
  server.tool('read_card', 'Read the latest messages of a card by id or title.', { card: z.string(), n: z.number().optional() }, async ({ card, n }) => text(await call('GET', `/card?id=${encodeURIComponent(card)}&n=${n || 20}`)));
  server.tool('send_to_card', 'Send a prompt to another agent or chat card. Set wait to get its reply.', { card: z.string(), text: z.string(), wait: z.boolean().optional() }, async ({ card, text: t, wait }) => text(await call('POST', '/send', { to: card, text: t, from, wait: !!wait })));
  server.tool('read_brain', 'Read the shared brain: notes every agent on this Mac can see.', {}, async () => text((await call('GET', '/brain')).text || '(empty)'));
  server.tool('add_to_brain', 'Add a note to the shared brain.', { text: z.string() }, async ({ text: t }) => { await call('POST', '/brain', { text: t, from }); return text('Added.'); });
  server.tool('post_output', 'Put a finished output (report, draft, code) on the board as its own card.', { title: z.string(), text: z.string() }, async ({ title, text: t }) => text(await call('POST', '/output', { title, text: t, from })));
  server.tool('make_board',
    "Draw on the user's Switchboard whiteboard: short notes joined by labelled arrows, inside a titled frame, laid out left to right. Use it whenever a picture says more than text: a plan of steps, an architecture, how agents or services connect, a decision tree, a timeline, a summary of options. The user sees it on their board at once. Keep each note to a few words or two short lines, and give every note an id the edges can point to.",
    {
      title: z.string().describe('Frame title, a few words'),
      nodes: z.array(z.object({ id: z.string(), text: z.string() })).describe('The notes'),
      edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() })).optional().describe('Arrows between note ids'),
    },
    async ({ title, nodes, edges }) => { const r = await call('POST', '/board', { title, nodes, edges: edges || [], from }); return text(`Drew "${title}" on the board: ${r.ids.length} notes, ${r.edges.length} arrows.`); });
  server.tool('whats_due', 'List what is due for clients (CRM, email and meetings).', {}, async () => text(await call('GET', '/due')));
  await server.connect(new StdioServerTransport());
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  const from = flag(args, '--from') || process.env.SB_FROM || 'terminal';
  switch (cmd) {
    case 'cards': for (const c of await call('GET', '/cards')) console.log(`${c.id}\t${c.kind}\t${c.title}`); break;
    case 'send': {
      const wait = bool(args, '--wait'); const brain = bool(args, '--brain');
      const [to, ...rest] = args; const t = rest.join(' ') || fs.readFileSync(0, 'utf8');
      const r = await call('POST', '/send', { to, text: t, from, wait, brain });
      console.log(wait ? (r.text || r.error || '') : `Sent to ${r.to}`); break;
    }
    case 'read': { const r = await call('GET', `/card?id=${encodeURIComponent(args[0])}&n=${args[1] || 10}`); for (const m of r.messages) console.log(`[${m.role}] ${m.text}\n`); break; }
    case 'log': await call('POST', '/log', { from: args[0], to: args[1], text: args.slice(2).join(' ') }); break;
    case 'brain': if (args[0] === 'append') await call('POST', '/brain', { text: args.slice(1).join(' '), from }); else console.log((await call('GET', '/brain')).text); break;
    case 'output': { const r = await call('POST', '/output', { title: args[0], text: args.slice(1).join(' ') || fs.readFileSync(0, 'utf8'), from }); console.log(r.id); break; }
    case 'board': {
      const raw = flag(args, '--json') || fs.readFileSync(0, 'utf8');
      let spec; try { spec = JSON.parse(raw); } catch (e) { throw new Error(`--json is not valid JSON: ${e.message}`); }
      const r = await call('POST', '/board', { title: args.join(' ') || spec.title, nodes: spec.nodes, edges: spec.edges, from });
      console.log(`${r.frameId}\t${r.ids.length} notes\t${r.edges.length} arrows`); break;
    }
    case 'due': for (const d of await call('GET', '/due')) console.log(`${d.overdue ? '!' : '-'} ${d.client}: ${d.title}`); break;
    case 'mcp': await mcp(); break;
    default: console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
