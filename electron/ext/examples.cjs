'use strict';
// "Add example board": drops a small Examples frame on the board showing how Switchboard is meant to be used.
const hub = require('../hub.cjs');

const NOTES = [
  { id: 'rule', text: 'Standing instruction\n\nAlways answer in bullet points and end with next steps.' },
  { id: 'standup', text: 'Daily standup (repeats 9am)\n\nSummarise what every agent did yesterday and what is blocked.' },
  { id: 'idea', text: 'Idea' },
  { id: 'plan', text: 'Plan' },
  { id: 'build', text: 'Build' },
  { id: 'review', text: 'Review' },
  { id: 'tip', text: "Press ⌘K, search 'granola', press ⌘T to tag a meeting as context." },
];

async function addExamples() {
  const board = hub.makeBoard({
    title: 'Examples',
    nodes: NOTES,
    edges: [{ from: 'idea', to: 'plan' }, { from: 'plan', to: 'build' }, { from: 'build', to: 'review' }],
  });
  let linked = null;
  try {
    const list = await hub.entities({ force: true });
    const claude = list.find((e) => e.kind === 'account' && (e.source === 'claude-code' || e.source === 'anthropic-api'));
    if (claude) {
      hub.saveEdge({ source: board.ids[0], target: claude.id, kind: 'link', data: { label: 'standing instruction' } });
      linked = claude.id;
    }
  } catch {}
  return { ...board, linked };
}

module.exports = { handlers: { 'examples:add': addExamples } };
