'use strict';
// "Add example board": a working example built from your own recent Claude sessions. Two sessions
// sit in a frame with a goal, the first auto-forwards to the second, an instruction note steers the
// first, a repeating note prompts the second every morning, and an output card shows what came back.
const hub = require('../hub.cjs');
const recurring = require('./recurring.cjs');
const { uid } = require('../util.cjs');

const W = 260, H = 150, COL = 320, ROW = 200, PAD = 32, HEAD = 64;

const TEXT = {
  instruction: 'Instruction · a line from this note into an agent adds it to every prompt you send that agent.\n\nAnswer in bullets; end with next steps.',
  daily: 'Repeats daily at 9am · sends this note to the agent it points at.\n\nDaily 9am: summarize progress',
  placeholderA: 'Session A · your first Claude chat goes here. Its replies auto-forward along the line to Session B.',
  placeholderB: 'Session B · receives whatever Session A finishes with and keeps going.',
};
const OUTPUT = 'Output · replies you keep land here and in the Outputs drawer.\n\n- Hero copy drafted\n- Pricing section built\n- Next: deploy preview and share the link';

async function addExamples() {
  let sessions = [];
  try {
    const list = await hub.entities({ force: true });
    sessions = list.filter((e) => e.kind === 'session' && (e.source === 'claude-code' || e.source === 'claude-app') && !(e.meta && (e.meta.noise || e.meta.archived)))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 2);
  } catch {}
  const [a, b] = [sessions[0]?.id || hub.saveNote({ text: TEXT.placeholderA }), sessions[1]?.id || hub.saveNote({ text: TEXT.placeholderB })];
  const instruction = hub.saveNote({ text: TEXT.instruction });
  const daily = hub.saveNote({ text: TEXT.daily });
  const output = hub.saveOutput({ title: 'Example output', content: OUTPUT, source: b });

  const tops = hub.board().filter((r) => !r.parent_id && !r.hidden);
  const x0 = tops.length ? Math.min(...tops.map((r) => r.x)) : 0;
  const y0 = tops.length ? Math.max(...tops.map((r) => r.y + (r.h || 260))) + 80 : 0;
  const frameId = `grp:ex:${uid()}`;
  const at = (c, r) => ({ x: PAD + c * COL, y: HEAD + r * ROW });
  hub.saveBoard([
    { id: frameId, x: x0, y: y0, w: PAD * 2 + 2 * COL + W, h: HEAD + ROW + H + PAD, parent_id: null,
      data: { label: 'Example · Ship the landing page', goal: 'Ship the landing page today', color: '#4E6E7E', smart: false } },
    { id: instruction, ...at(0, 0), parent_id: frameId, data: {} },
    { id: a, ...at(0, 1), parent_id: frameId, data: {} },
    { id: daily, ...at(1, 0), parent_id: frameId, data: {} },
    { id: b, ...at(1, 1), parent_id: frameId, data: {} },
    { id: output, ...at(2, 1), parent_id: frameId, data: {} },
  ]);
  const edges = [
    hub.saveEdge({ source: a, target: b, kind: 'link', data: { autoForward: true, label: 'auto-forward' } }),
    hub.saveEdge({ source: instruction, target: a, kind: 'link', data: { instruction: true, label: 'instruction' } }),
    hub.saveEdge({ source: daily, target: b, kind: 'link', data: { label: 'daily 9am' } }),
    hub.saveEdge({ source: b, target: output, kind: 'link', data: { label: 'output' } }),
  ];
  recurring.handlers['recurring:set'](daily, 'daily');
  hub.invalidate();
  hub.events.emit('event', { type: 'board-changed', frameId });
  hub.events.emit('event', { type: 'entities-changed' });
  return { frameId, ids: [a, b, instruction, daily, output], edges, real: sessions.length };
}

module.exports = { handlers: { 'examples:add': addExamples } };
