import { create } from 'zustand';
import { applyNodeChanges, Edge, Node, NodeChange } from '@xyflow/react';
import { useStore } from './store';

// A mock board that plays by itself: a Claude chat with subagents, two Grok bots and an output,
// with messages travelling along the lines. Nothing here touches the backend or gets saved.

export type SubStatus = 'running' | 'done';
export interface DemoAction { kind: 'message' | 'event' | 'tool' | 'connector' | 'agent' | 'notice'; text: string; ts: number }
export interface DemoSim {
  step: number;
  claudeChars: number;
  subs: { id: string; title: string; status: SubStatus; line: string }[];
  marketing: { activity: string; tool?: string; actions: DemoAction[] };
  outreach: { activity: string; tool?: string; actions: DemoAction[] };
  outputLines: number;
}

export const CLAUDE_TEXT = 'Planning the launch. Explore is mapping the repo, Test runner is checking the signup flow and Reviewer will read the diff. Handing the brief to Marketing so posts go out when the build is green.';
export const OUTPUT_LINES = ['Launch post drafted for X and LinkedIn', '42 leads pulled from the waitlist', 'Signup flow passes 18/18 tests', 'PR #214 approved, ready to merge', 'Outreach queued for 9:00 tomorrow'];

const MARKETING_FEED: [DemoAction['kind'], string, string?][] = [
  ['tool', 'Opened x.com/compose', 'browser'], ['message', 'Drafted launch thread (4 posts)'], ['connector', 'Pulled screenshots from Figma', 'figma'],
  ['tool', 'Scheduled post for 9:00', 'browser'], ['agent', 'Asked Outreach for lead list'], ['event', 'Thread got 120 likes'],
  ['tool', 'Replying to top comments', 'browser'], ['message', 'Wrote LinkedIn version'], ['notice', 'Rate limit, waiting 30s'],
];
const OUTREACH_FEED: [DemoAction['kind'], string, string?][] = [
  ['connector', 'Read waitlist from Sheets', 'sheets'], ['tool', 'Enriching 42 leads', 'apollo'], ['message', 'Drafted intro email'],
  ['tool', 'Sending batch 1 of 3', 'gmail'], ['event', '3 replies so far'],
];
const SUB_LINES: Record<string, string[]> = {
  explore: ['Reading src/auth', 'Found 3 signup routes', 'Mapped 41 files'],
  test: ['Running signup.spec.ts', '18 passed', 'Re-running flaky test'],
  review: ['Reading diff (212 lines)', 'Left 2 comments', 'Approved'],
};

const fresh = (): DemoSim => ({
  step: 0, claudeChars: 0, outputLines: 0,
  subs: [
    { id: 'explore', title: 'Explore', status: 'running', line: SUB_LINES.explore[0] },
    { id: 'test', title: 'Test runner', status: 'running', line: SUB_LINES.test[0] },
    { id: 'review', title: 'Reviewer', status: 'done', line: 'Waiting for diff' },
  ],
  marketing: { activity: 'Opening the browser', tool: 'browser', actions: [] },
  outreach: { activity: 'Waiting for the brief', actions: [] },
});

const E = (id: string, source: string, target: string, label?: string): Edge => ({
  id: `demo:e-${id}`, source, target, type: 'flow', data: { kind: 'flow', label, demo: true },
});

function layout(): { nodes: Node[]; edges: Edge[] } {
  const board = useStore.getState().board;
  const right = board.length ? Math.max(...board.filter((b) => !b.parent_id).map((b) => b.x + (b.w || 400))) : 0;
  const x = Math.max(right + 400, 2400), y = 0;
  const nodes: Node[] = [
    { id: 'demo:header', type: 'demoHeader', position: { x, y: y - 90 }, data: {}, style: { width: 1300 }, selectable: false },
    { id: 'demo:claude', type: 'demoClaude', position: { x, y }, data: {}, style: { width: 360 } },
    { id: 'demo:marketing', type: 'demoGrok', position: { x: x + 470, y: y - 10 }, data: { bot: 'marketing', name: 'Marketing', color: '#18181B' }, style: { width: 380 } },
    { id: 'demo:outreach', type: 'demoGrok', position: { x: x + 470, y: y + 600 }, data: { bot: 'outreach', name: 'Outreach', color: '#52525B' }, style: { width: 380 } },
    { id: 'demo:output', type: 'demoOutput', position: { x: x + 960, y: y + 200 }, data: {}, style: { width: 340 } },
  ];
  const edges = [
    E('cm', 'demo:claude', 'demo:marketing', 'brief'), E('mo', 'demo:marketing', 'demo:outreach', 'leads'),
    E('co', 'demo:claude', 'demo:output'), E('mout', 'demo:marketing', 'demo:output'), E('oout', 'demo:outreach', 'demo:output'),
  ];
  return { nodes, edges };
}

const PULSES: [string, string][] = [
  ['demo:e-cm', 'Brief: launch posts'], ['demo:e-mo', '42 leads'], ['demo:e-mout', 'Thread drafted'],
  ['demo:e-co', 'Tests green'], ['demo:e-oout', 'Batch 1 sent'],
];

function pulse(edgeId: string, preview: string) {
  const until = Date.now() + 2600;
  useStore.setState((st) => ({ activeEdges: { ...st.activeEdges, [edgeId]: { until, preview } } }));
  setTimeout(() => useStore.setState((st) => {
    const n = { ...st.activeEdges }; if (n[edgeId] && n[edgeId].until <= Date.now()) delete n[edgeId]; return { activeEdges: n };
  }), 2700);
}

const push = (list: DemoAction[], [kind, text]: [DemoAction['kind'], string, string?]) => [{ kind, text, ts: Date.now() }, ...list].slice(0, 15);

function advance(s: DemoSim): DemoSim {
  const step = s.step + 1;
  const claudeChars = s.claudeChars >= CLAUDE_TEXT.length + 40 ? 0 : s.claudeChars + 9;
  const subs = s.subs.map((sub, i) => {
    if ((step + i * 3) % 7 !== 0) return sub;
    const lines = SUB_LINES[sub.id];
    const status: SubStatus = sub.status === 'running' ? 'done' : 'running';
    return { ...sub, status, line: lines[(step + i) % lines.length] };
  });
  let { marketing, outreach } = s;
  if (step % 3 === 0) {
    const a = MARKETING_FEED[(step / 3) % MARKETING_FEED.length];
    marketing = { activity: a[1], tool: a[2], actions: push(marketing.actions, a) };
  }
  if (step % 5 === 2) {
    const a = OUTREACH_FEED[Math.floor(step / 5) % OUTREACH_FEED.length];
    outreach = { activity: a[1], tool: a[2], actions: push(outreach.actions, a) };
  }
  const outputLines = step % 6 === 0 ? (s.outputLines >= OUTPUT_LINES.length ? 0 : s.outputLines + 1) : s.outputLines;
  if (step % 4 === 0) { const [id, p] = PULSES[(step / 4) % PULSES.length]; pulse(id, p); }
  return { step, claudeChars, subs, marketing, outreach, outputLines };
}

interface DemoState {
  active: boolean;
  nodes: Node[];
  edges: Edge[];
  sim: DemoSim;
  start: () => void;
  stop: () => void;
  onNodesChange: (changes: NodeChange[]) => void;
}

let timer: ReturnType<typeof setInterval> | null = null;

export const useDemo = create<DemoState>((set, get) => ({
  active: false, nodes: [], edges: [], sim: fresh(),
  start: () => {
    if (timer) clearInterval(timer);
    const { nodes, edges } = layout();
    set({ active: true, nodes, edges, sim: fresh() });
    timer = setInterval(() => set({ sim: advance(get().sim) }), 450);
  },
  stop: () => {
    if (timer) clearInterval(timer);
    timer = null;
    useStore.setState((st) => {
      const n = { ...st.activeEdges }; for (const k of Object.keys(n)) if (k.startsWith('demo:')) delete n[k]; return { activeEdges: n };
    });
    set({ active: false, nodes: [], edges: [] });
  },
  // Board can route changes for 'demo:' ids here so demo cards drag and select without being saved.
  onNodesChange: (changes) => {
    const mine = changes.filter((c) => 'id' in c && String(c.id).startsWith('demo:') && c.type !== 'remove');
    if (mine.length) set({ nodes: applyNodeChanges(mine, get().nodes) });
  },
}));

export const isDemoId = (id: string) => id.startsWith('demo:');
