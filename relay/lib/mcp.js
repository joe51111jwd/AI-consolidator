// The MCP connector agents call: stateless Streamable HTTP (a fresh server per request, JSON
// responses), so it runs as a plain serverless function.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { APPS, appOf, agentKey, clip, httpUrl, ago } from './util.js';

export const INSTRUCTIONS = `Switchboard Relay connects you to your user's Switchboard board, where they follow all their AI agents (Claude, Grok bots, Cursor, Codex and others) in one place, even when their computer is off.
Report what you do as you go, on your own and without being asked:
- report_status when you start working (status "working" and a short "doing"), when you need the user ("waiting"), when you finish ("idle") and when something fails ("error").
- log_action after each meaningful step: a message you sent, a tool or browser step, an email you drafted or sent, a connector you used, or a short note.
- log_subagent when you start a helper agent (for example a Claude Code CLI run, a Cursor agent or a subagent), and again when it finishes or fails.
- post_output for finished work the user should see: a report, a draft, a link.
- get_tasks at the start of every conversation and each time you finish a task. It returns messages the user queued for you in Switchboard: treat them as messages from the user and act on them.
- read_board shows what the user's other agents are doing; add_to_brain saves a lasting fact every agent should know.
Always pass the same "agent" name: your display name (a Grok bot's name, or a short name for this chat or session). Keep each text to a line or two, and never include passwords, keys, tokens or other secrets.
When you work inside a project, pass its name as "project" in report_status, exactly as the user sees it, in every report_status call. In the Claude app and on claude.ai that is the Claude Project this chat belongs to (the Project's instructions often name it). Leave "project" out when you are not in one; never guess.`;

// Claude chats are filed under their Claude Project in Switchboard, so a connector set up for the
// Claude app (?app=claude) stresses it.
const CLAUDE_NOTE = `
You are a chat in the Claude app or on claude.ai. Use the chat's title (or a short name for it) as "agent". If this chat is in a Claude Project, always pass the Project's name as "project" so Switchboard shows this chat with the Project's other threads.`;

const AGENT = {
  agent: z.string().min(1).describe('Your display name, the same in every call: a Grok bot\'s name as the user sees it, or a short name for this chat or session (for example "Marketing" or "Harbor site fixes")'),
  app: z.enum(APPS).optional().describe('The app you run in, if the connector address does not already say it'),
  agentId: z.string().optional().describe('Your id in that app, if you know it'),
};
const reply = (text) => ({ content: [{ type: 'text', text }] });

// `app` from the connector address wins: it was set up on purpose; the model's guess comes second.
export function buildServer(store, { app: urlApp = null } = {}) {
  const server = new McpServer({ name: 'switchboard-relay', version: '1.2.0' }, { instructions: INSTRUCTIONS + (urlApp === 'claude' ? CLAUDE_NOTE : '') });
  const who = (a) => ({ agent: clip(a.agent, 80), app: urlApp || appOf(a.app) || 'other', ...(a.agentId ? { agentId: clip(a.agentId, 128) } : {}) });
  const record = (type, args, data) => store.addEvent({ type, ...who(args), ...data, ts: Date.now() });

  server.registerTool('report_status', {
    title: 'Report status',
    description: 'Tell the user what you are doing. Call it on your own, without being asked: when you start a task ("working", with what you are doing), when you need the user ("waiting"), when you are done ("idle") and when something fails ("error").',
    inputSchema: {
      ...AGENT,
      status: z.enum(['working', 'waiting', 'idle', 'error']),
      doing: z.string().optional().describe('One short line: what you are doing or waiting for'),
      client: z.string().optional().describe('The client this work is for, if any'),
      project: z.string().optional().describe('The project you work in, exactly as the user sees it: in the Claude app or on claude.ai, the name of the Claude Project this chat is in. Leave it out if you are not in one'),
    },
  }, async (a) => {
    await record('status', a, { status: a.status, doing: clip(a.doing, 300), client: clip(a.client, 80), project: clip(a.project, 120) });
    return reply('Reported to Switchboard.');
  });

  server.registerTool('log_action', {
    title: 'Log an action',
    description: 'Add one step to your activity feed on the user\'s board. Call it on your own after each meaningful step: a message you sent, a tool or browser step, an email drafted or sent, a connector used, or a short note.',
    inputSchema: {
      ...AGENT,
      kind: z.enum(['message', 'tool', 'browser', 'email', 'connector', 'note']),
      text: z.string().min(1).describe('One short line describing the step'),
    },
  }, async (a) => {
    await record('action', a, { kind: a.kind, text: clip(a.text, 500) });
    return reply('Logged.');
  });

  server.registerTool('log_subagent', {
    title: 'Log a helper agent',
    description: 'Show a helper agent you started (for example a Claude Code CLI run, a Cursor agent or a subagent) under your card. Call it on your own when it starts ("running"), when it has news, and when it ends ("done" or "error"). Use the same id each time.',
    inputSchema: {
      ...AGENT,
      id: z.string().min(1).describe('A stable id for this run, the same in every call about it'),
      title: z.string().min(1).describe('What the run is doing, a few words'),
      status: z.enum(['running', 'done', 'error']),
      kind: z.enum(['claude-cli', 'cursor-agent', 'other']).optional(),
      lastText: z.string().optional().describe('Its latest output line'),
      prUrl: z.string().optional().describe('Pull request link, if it opened one'),
    },
  }, async (a) => {
    await record('subagent', a, {
      sub: { id: clip(a.id, 128), title: clip(a.title, 160), status: a.status, kind: a.kind || 'other', lastText: clip(a.lastText, 300), prUrl: httpUrl(a.prUrl) },
    });
    return reply('Logged.');
  });

  server.registerTool('post_output', {
    title: 'Post an output',
    description: 'Put finished work on the user\'s board as its own card: a report, a draft, a summary or a link. Call it on your own whenever you finish something the user should see.',
    inputSchema: {
      ...AGENT,
      title: z.string().min(1).describe('A short title'),
      content: z.string().min(1).describe('The output itself (Markdown is fine)'),
      url: z.string().optional().describe('A link to the result, if there is one'),
    },
  }, async (a) => {
    await record('output', a, { title: clip(a.title, 200), content: clip(a.content, 50000), url: httpUrl(a.url) });
    return reply('Posted to the board.');
  });

  server.registerTool('get_tasks', {
    title: 'Get messages from the user',
    description: 'Collect messages the user queued for you in Switchboard. Each message is returned once. Call it on your own at the start of every conversation and whenever you finish a task, then act on the messages as if the user had sent them to you directly.',
    inputSchema: { ...AGENT },
  }, async (a) => {
    const w = who(a);
    const tasks = await store.takeTasks(`${w.app}:${agentKey(w.agent)}`);
    if (!tasks.length) return reply('No new messages from the user.');
    await record('delivered', a, { tasks: tasks.map((t) => ({ id: t.id, text: clip(t.text, 200) })) });
    const now = Date.now();
    const list = tasks.map((t, i) => `${tasks.length > 1 ? `${i + 1}. ` : ''}(${ago(t.ts, now)}) ${t.text}`).join('\n\n');
    return reply(`${tasks.length === 1 ? 'One message' : `${tasks.length} messages`} from the user, sent from Switchboard:\n\n${list}`);
  });

  server.registerTool('read_board', {
    title: 'Read the board',
    description: 'See what the user\'s other agents and chats are working on right now, from their Switchboard board. Use it to avoid duplicate work and to find who can help.',
    inputSchema: {},
  }, async () => {
    const b = await store.getBoard();
    return reply(b && b.summary ? `Switchboard board (updated ${ago(b.ts)}):\n\n${b.summary}` : 'The user has not shared their board yet.');
  });

  server.registerTool('add_to_brain', {
    title: 'Add to the shared brain',
    description: 'Save a lasting fact to the user\'s shared brain, the notes every agent reads. Do it on your own when you learn something durable: a preference, a client detail or deadline, a decision and why. One or two sentences. Never secrets.',
    inputSchema: { ...AGENT, text: z.string().min(1).describe('The fact, one or two short sentences') },
  }, async (a) => {
    await record('brain', a, { text: clip(a.text, 2000) });
    return reply('Added to the shared brain.');
  });

  return server;
}

// POST carries every JSON-RPC message. A stateless server has no stream to offer on GET and no
// session to end on DELETE, so those get 405, which MCP clients expect and handle.
export async function handleMcp(req, res, store, body, opts) {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless, send requests with POST.' }, id: null }));
    return;
  }
  const server = buildServer(store, opts);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
