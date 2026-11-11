'use strict';
// "Add example board": a frame of sample notes that shows how the board works: two stand-in agent
// cards joined by an auto-send line, an instruction note, a note marked to repeat daily and an
// output card. Everything in it is a sample note. It never links to, forwards into or schedules
// anything for your real cards (cc:/gb:/cx:/cu:/ac:): those lines only exist where you draw them,
// and the repeating note is labelled, not scheduled.
const hub = require('../hub.cjs');
const db = require('../db.cjs');
const { uid } = require('../util.cjs');

const W = 260, H = 150, COL = 320, ROW = 200, PAD = 32, HEAD = 64;

const TEXT = {
  instruction: 'Instruction · draw a line from a note like this into an agent and it is added to every prompt you send that agent.\n\nAnswer in bullets; end with next steps.',
  daily: 'Repeats · daily at 9am · set a note to repeat and it is sent to the agents it points at.\n\nThis sample is not scheduled.',
  placeholderA: 'Sample agent A · stands in for one of your chats. A line marked auto-send passes its finished reply to the next card.',
  placeholderB: 'Sample agent B · receives what agent A finishes with and keeps going.',
};
const OUTPUT = 'Output · replies you keep land here and in the Outputs drawer.\n\n- Hero copy drafted\n- Pricing section built\n- Next: deploy preview and share the link';

async function addExamples() {
  const a = hub.saveNote({ text: TEXT.placeholderA });
  const b = hub.saveNote({ text: TEXT.placeholderB });
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
      data: { label: 'Example · Ship the landing page', goal: 'Ship the landing page today', color: '#4E6E7E', smart: false, example: true } },
    { id: instruction, ...at(0, 0), parent_id: frameId, data: {} },
    { id: a, ...at(0, 1), parent_id: frameId, data: {} },
    { id: daily, ...at(1, 0), parent_id: frameId, data: {} },
    { id: b, ...at(1, 1), parent_id: frameId, data: {} },
    { id: output, ...at(2, 1), parent_id: frameId, data: {} },
  ]);
  // Note-to-note lines only: nothing here can reach a real agent.
  const edges = [
    hub.saveEdge({ source: a, target: b, kind: 'link', data: { label: 'auto-send', example: true } }),
    hub.saveEdge({ source: instruction, target: a, kind: 'link', data: { instruction: true, label: 'instruction', example: true } }),
    hub.saveEdge({ source: daily, target: b, kind: 'link', data: { label: 'daily 9am', example: true } }),
    hub.saveEdge({ source: b, target: output, kind: 'link', data: { label: 'output', example: true } }),
  ];
  hub.invalidate();
  hub.events.emit('event', { type: 'board-changed', frameId });
  hub.events.emit('event', { type: 'entities-changed' });
  return { frameId, ids: [a, b, instruction, daily, output], edges, real: 0 };
}

const REAL = /^(cc|gb|cx|cu|ac):/;
const SAMPLE_TEXT = /^(Instruction · a line from this note into an agent|Repeats daily at 9am · sends this note|Session [AB] · )/;

// Example boards from older versions put your real sessions and Grok bots in the frame, wired
// them to sample notes and scheduled a daily prompt into one. Undo that once: drop the sample
// lines and schedules that touch real cards and take real cards out of example frames.
function cleanOldExamples() {
  const done = db.getSetting('exampleCleanup', 0);
  if (done >= 1) return;
  const sampleNotes = new Set(db.all('SELECT id, text FROM notes').filter((n) => SAMPLE_TEXT.test(n.text || '')).map((n) => `nt:${n.id}`));
  const exFrames = new Set(hub.board().filter((r) => String(r.id).startsWith('grp:ex:')).map((r) => r.id));
  for (const e of hub.edges()) {
    const fromSample = sampleNotes.has(e.source) || sampleNotes.has(e.target);
    const touchesReal = REAL.test(e.source) || REAL.test(e.target);
    if (touchesReal && (fromSample || e.data.example)) hub.deleteEdge(e.id);
    else if (touchesReal && e.data.autoForward && e.data.label === 'auto-forward' && REAL.test(e.source) && REAL.test(e.target)) {
      const inEx = hub.board().filter((r) => (r.id === e.source || r.id === e.target) && exFrames.has(r.parent_id));
      if (inEx.length === 2) hub.deleteEdge(e.id);
    }
  }
  const sched = db.getSetting('recurringNotes', {}) || {};
  let changed = false;
  for (const id of Object.keys(sched)) if (sampleNotes.has(id)) { delete sched[id]; changed = true; }
  if (changed) db.setSetting('recurringNotes', sched);
  for (const r of hub.board()) {
    if (exFrames.has(r.parent_id) && REAL.test(r.id)) db.exec('DELETE FROM board_nodes WHERE id = ?', r.id);
  }
  db.setSetting('exampleCleanup', 1);
}

module.exports = {
  handlers: { 'examples:add': addExamples },
  start() { try { cleanOldExamples(); } catch (e) { console.error('example cleanup:', e.message); } },
};
