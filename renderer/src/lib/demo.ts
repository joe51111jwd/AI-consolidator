import { create } from 'zustand';
import { applyNodeChanges, Edge, Node, NodeChange } from '@xyflow/react';
import { useStore } from './store';

// Showcase: a mock board that plays by itself. Three clients, each with Claude/Codex sessions on
// different accounts, a Granola meeting, a Gmail thread waiting on a reply, a client card and an
// output, plus three Grok bots, all wired together with messages travelling along the lines.
// Nothing here touches the backend or gets saved.

export type DemoStatus = 'running' | 'waiting' | 'done' | 'idle';
export interface DemoAction { kind: 'message' | 'event' | 'tool' | 'connector' | 'agent' | 'notice'; text: string; ts: number; tool?: string }
export interface DemoSub { title: string; status: 'running' | 'done'; line: string }
export interface DemoAccount { label: string; color: string }
type Feed = [DemoAction['kind'], string, string?];

export type DemoSpec =
  | { kind: 'session'; agent: 'claude-code' | 'codex'; title: string; account: DemoAccount; prompt: string; reply: string; script: string[]; subs: [string, string[]][] }
  | { kind: 'meeting'; title: string; attendees: string[]; items: string[]; live?: boolean }
  | { kind: 'mail'; from: string; subject: string; snippets: string[]; age: string }
  | { kind: 'client'; name: string; statuses: string[]; next: string[]; due: string }
  | { kind: 'output'; title: string; lines: string[] }
  | { kind: 'grok'; name: string; avatar: { color: string; shape: string }; feed: Feed[]; hub?: boolean; cli?: string[] };

// One shape for every card's moving parts; each kind uses the fields it needs.
export interface CardSim { status: DemoStatus; label?: string; now: string; attention: boolean; i: number; n: number; chars: number; hold: number; subs: DemoSub[]; feed: DemoAction[] }

const ACC = {
  work: { label: 'Work', color: '#D97757' },
  personal: { label: 'Personal', color: '#3B82F6' },
  agency: { label: 'Agency', color: '#10B981' },
  codex: { label: 'Codex', color: '#18181B' },
};

interface ClientDef {
  key: string; name: string; tone: string; handoff?: number;
  sessions: Extract<DemoSpec, { kind: 'session' }>[];
  meeting: Extract<DemoSpec, { kind: 'meeting' }>;
  mail: Extract<DemoSpec, { kind: 'mail' }>;
  client: Extract<DemoSpec, { kind: 'client' }>;
  output: Extract<DemoSpec, { kind: 'output' }>;
}

const session = (agent: 'claude-code' | 'codex', title: string, account: DemoAccount, prompt: string, reply: string, script: string[], subs: [string, string[]][]) =>
  ({ kind: 'session', agent, title, account, prompt, reply, script, subs } as const);

const CLIENTS: ClientDef[] = [
  {
    key: 'harbor', name: 'Harbor Coffee', tone: '#B45309', handoff: 1,
    sessions: [
      session('claude-code', 'Spring menu landing page', ACC.work, 'Build the spring menu page from the Figma export.',
        'Hero and menu grid are in. Lighthouse is at 94. I need your OK to deploy the preview.',
        ['Reading Figma export', 'Building hero section', 'Wiring the menu grid', 'Running Lighthouse (94)', '?Wants OK to deploy preview', '✓Preview deployed'],
        [['Explore', ['Mapping 38 files', 'Found menu data', 'Done']], ['Test runner', ['Running 12 specs', '12 passed', 'Re-running flaky test']]]),
      session('claude-code', 'Wholesale price sheet', ACC.personal, 'Update the wholesale sheet with the new supplier costs.',
        'Margins recomputed for 24 SKUs. Two drop under 30%, flagged in yellow.',
        ['Parsing supplier CSV', 'Recomputing margins', 'Flagging low-margin SKUs', 'Formatting PDF', '✓Sheet ready'],
        [['Calculator', ['24 SKUs priced', 'Checking totals', 'Done']]]),
    ],
    meeting: { kind: 'meeting', title: 'Harbor weekly sync', attendees: ['MR', 'TK', 'JC'], items: ['Ship landing page by Fri', 'Send wholesale sheet', 'Book photo shoot'] },
    mail: { kind: 'mail', from: 'Maya Reyes', subject: 'Re: Menu photos, final picks?', age: '2h', snippets: ['Can you confirm the 6 shots by tomorrow?', 'Also, can we swap the oat latte photo?'] },
    client: { kind: 'client', name: 'Harbor Coffee', statuses: ['On track', 'On track', 'In review'], next: ['Landing page review', 'Photo shoot Tue', 'Send price sheet'], due: 'Fri' },
    output: { kind: 'output', title: 'Landing page copy', lines: ['Hero headline and subhead', 'Menu section, 14 items', 'Wholesale CTA', 'SEO meta tags', 'Preview link'] },
  },
  {
    key: 'fern', name: 'Fern Studio', tone: '#15803D', handoff: 1,
    sessions: [
      session('claude-code', 'Brand guidelines v2', ACC.agency, 'Draft v2 of the brand guidelines from the kickoff notes.',
        'Researcher pulled 6 references, Writer is on the type section and Reviewer is checking tone.',
        ['Reading kickoff notes', 'Researcher pulled 6 refs', 'Writing type section', 'Writing colour section', '?Pick a primary green', 'Reviewer checking tone'],
        [['Researcher', ['6 references', 'Reading moodboard', 'Done']], ['Writer', ['Type section', 'Colour section', 'Logo usage']], ['Reviewer', ['Waiting for draft', 'Left 3 comments', 'Approved']]]),
      session('claude-code', 'Instagram grid plan', ACC.work, 'Plan the next 9 posts for the Fern grid.',
        'Nine posts planned across 3 themes. Captions are with Marketing.',
        ['Reviewing last 30 posts', 'Planning 9-post grid', 'Writing captions', '✓Grid plan ready'],
        [['Explore', ['Scanning feed', 'Top 5 posts found', 'Done']]]),
      session('claude-code', 'Website copy refresh', ACC.agency, 'Refresh the About and Services copy.',
        'About page rewritten in the new voice. Services next.',
        ['Reading current site', 'Rewriting About page', 'Rewriting Services', 'Checking voice guide'],
        []),
    ],
    meeting: { kind: 'meeting', title: 'Fern kickoff', attendees: ['IC', 'LB', 'JC', 'RM'], items: ['Guidelines v2 draft', 'Pick primary green', 'Instagram grid plan', 'New About copy'], live: true },
    mail: { kind: 'mail', from: 'Ivy Chen', subject: 'Contract redlines attached', age: '1d', snippets: ['Redlines on section 4, can you take a look?', 'Legal signed off, just need your initials.'] },
    client: { kind: 'client', name: 'Fern Studio', statuses: ['In review', 'On track', 'In review'], next: ['Send guideline draft', 'Sign contract', 'Grid sign-off'], due: 'Tomorrow' },
    output: { kind: 'output', title: 'Guidelines PDF', lines: ['Logo and clear space', 'Type scale', 'Colour palette', 'Photo direction', 'Voice and tone'] },
  },
  {
    key: 'north', name: 'Northwind', tone: '#1D4ED8',
    sessions: [
      session('codex', 'API v2 migration', ACC.codex, 'Migrate the billing endpoints to API v2.',
        'Four of seven endpoints moved. Tests pass. SSO callback still failing on staging.',
        ['Reading billing routes', 'Migrating /invoices', 'Migrating /customers', 'Running test suite', '?SSO callback failing on staging', 'Patching SSO callback'],
        [['Tests', ['118 passed', '2 failing', 'Re-running']]]),
      session('claude-code', 'QBR deck', ACC.personal, 'Build the Q3 business review deck from the usage export.',
        'Usage is up 18%. Churn risk slide drafted, needs the renewal numbers.',
        ['Reading usage export', 'Charting monthly active', 'Drafting churn slide', 'Writing exec summary', '✓Deck drafted'],
        [['Analyst', ['Usage up 18%', 'Cohort chart', 'Done']]]),
    ],
    meeting: { kind: 'meeting', title: 'Northwind QBR prep', attendees: ['SO', 'JC'], items: ['Fix SSO before Monday', 'Renewal numbers', 'Deck to Sam by Sun'] },
    mail: { kind: 'mail', from: 'Sam Ortiz', subject: 'Invoice #1042 question', age: '3h', snippets: ['Why did seats go from 40 to 46?', 'Thanks! Can you send the updated PDF?'] },
    client: { kind: 'client', name: 'Northwind', statuses: ['At risk', 'At risk', 'On track'], next: ['Fix SSO bug', 'Answer invoice email', 'QBR on Mon'], due: 'Today' },
    output: { kind: 'output', title: 'QBR deck', lines: ['Exec summary', 'Usage trends', 'Churn risk', 'Renewal plan', 'Next quarter goals'] },
  },
];

const GROKS: Record<'mkt' | 'outreach' | 'cal', Extract<DemoSpec, { kind: 'grok' }>> = {
  mkt: {
    kind: 'grok', name: 'Marketing', avatar: { color: '#8B5CF6', shape: 'cloud' }, hub: true,
    feed: [['tool', 'Opened x.com/compose', 'browser'], ['message', 'Drafted Harbor spring thread'], ['agent', 'Handed landing copy to Claude'], ['connector', 'Pulled photos from Drive', 'drive'],
      ['tool', 'Scheduled 3 posts', 'buffer'], ['event', 'Fern teaser got 210 likes'], ['agent', 'Asked Claude for IG captions'], ['notice', 'Rate limit, waiting 30s']],
    cli: ['$ claude -p "3 captions for the Fern teaser"', '⏺ Read brand/voice.md', '⏺ Read posts/teaser.png', '⏺ Writing captions…', '✓ captions.md saved',
      '$ claude -p "resize hero for Instagram"', '⏺ Bash sips -Z 1080 hero.png', '✓ hero-1080.png'],
  },
  outreach: {
    kind: 'grok', name: 'Outreach', avatar: { color: '#F07A2E', shape: 'gumdrop' },
    feed: [['connector', 'Read inbox', 'gmail'], ['message', 'Drafted reply to Maya'], ['tool', 'Sent follow-up', 'gmail'], ['event', 'Ivy replied'], ['agent', 'Asked Calendar for slots'], ['message', 'Drafted reply to Sam']],
  },
  cal: {
    kind: 'grok', name: 'Calendar bot', avatar: { color: '#EC4899', shape: 'egg' },
    feed: [['connector', 'Checked 3 calendars', 'gcal'], ['message', 'Held Thu 10:00 for Fern'], ['notice', 'Fri 2pm is double-booked'], ['event', 'QBR moved to Monday'], ['message', 'Sent invite to Maya']],
  },
};

// Layout, in board units.
const CW = 260, GAP = 70, PAD = 24, HEAD = 52, SLOT = 116, FRAME_GAP = 60;
const COLS = [PAD, PAD + CW + GAP, PAD + 2 * (CW + GAP)];
const FW = COLS[2] + CW + PAD;
const GROK_X = FW + 150;
export const SHOWCASE_SIZE = { w: GROK_X + 320 + 120 + CW, h: 1200 };

const E = (a: string, b: string, label?: string, handles?: { s?: string; t?: string }): Edge => ({
  id: `demo:e-${a}>${b}`, source: `demo:${a}`, target: `demo:${b}`, type: 'flow',
  sourceHandle: handles?.s, targetHandle: handles?.t, data: { kind: 'flow', label, demo: true },
});

interface Pulse { edge: string; preview: string; target?: string; effect?: string }
interface Built { nodes: Node[]; edges: Edge[]; specs: Record<string, DemoSpec>; pulses: Pulse[] }

function buildClient(c: ClientDef, x: number, y: number, out: Built): number {
  const rows = Math.max(c.sessions.length, 2);
  const h = HEAD + rows * SLOT + 4;
  const fid = `demo:f-${c.key}`;
  out.nodes.push({ id: fid, type: 'demoFrame', position: { x, y }, data: { name: c.name, tone: c.tone, prefix: `demo:${c.key}-`, agents: c.sessions.length },
    style: { width: FW, height: h }, dragHandle: '.dm-frame-head', className: 'dm-frame-node', selectable: false });
  const put = (suffix: string, col: number, row: number, spec: DemoSpec) => {
    const id = `demo:${c.key}-${suffix}`;
    out.specs[id] = spec;
    out.nodes.push({ id, type: 'demoCard', parentId: fid, position: { x: COLS[col], y: HEAD + row * SLOT }, data: { spec }, style: { width: CW }, className: 'dm-node' });
  };
  put('meet', 0, 0, c.meeting); put('client', 0, 1, c.client);
  c.sessions.forEach((s, i) => put(`s${i}`, 1, i, s));
  put('out', 2, 0, c.output); put('mail', 2, 1, c.mail);

  const k = c.key;
  out.edges.push(E(`${k}-meet`, `${k}-s0`, 'action items'), E(`${k}-mail`, 'outreach'));
  out.pulses.push({ edge: `${k}-meet>${k}-s0`, preview: `${c.meeting.items.length} action items`, target: `${k}-s0`, effect: 'Picking up action items' });
  out.pulses.push({ edge: `${k}-mail>outreach`, preview: `${c.mail.from.split(' ')[0]}: ${c.mail.subject.replace(/^Re: /, '')}`, target: 'outreach', effect: `Reading ${c.mail.from.split(' ')[0]}'s email` });
  c.sessions.forEach((s, i) => {
    out.edges.push(E(`${k}-s${i}`, `${k}-out`));
    out.pulses.push({ edge: `${k}-s${i}>${k}-out`, preview: s.script[Math.min(2, s.script.length - 1)].replace(/^[?✓]/, '') });
  });
  if (c.handoff != null) {
    const s = `${k}-s${c.handoff}`;
    out.edges.push(E('mkt', s, 'hand-off', { s: 'l', t: 'r' }));
    out.pulses.push({ edge: `mkt>${s}`, preview: 'Brief from Marketing', target: s, effect: 'Hand-off from Marketing' });
  }
  return h;
}

function build(): Built {
  const board = useStore.getState().board;
  const roots = board.filter((b) => !b.parent_id);
  const right = roots.length ? Math.max(...roots.map((b) => b.x + (b.w || 400))) : 0;
  const x = Math.max(right + 400, 2400), y0 = 0;
  const out: Built = { nodes: [], edges: [], specs: {}, pulses: [] };
  out.nodes.push({ id: 'demo:header', type: 'demoHeader', position: { x, y: y0 - 80 }, data: {}, style: { width: SHOWCASE_SIZE.w }, selectable: false, draggable: false });
  let y = y0;
  for (const c of CLIENTS) y += buildClient(c, x, y, out) + FRAME_GAP;
  const total = y - FRAME_GAP - y0;
  const grok = (id: keyof typeof GROKS, gx: number, gy: number, w: number) => {
    out.specs[`demo:${id}`] = GROKS[id];
    out.nodes.push({ id: `demo:${id}`, type: GROKS[id].hub ? 'demoHub' : 'demoCard', position: { x: x + gx, y: y0 + gy }, data: { spec: GROKS[id] }, style: { width: w }, className: 'dm-node' });
  };
  grok('mkt', GROK_X, 40, 320);
  grok('outreach', GROK_X, total - 300, CW);
  grok('cal', GROK_X + 320 + 120, total - 300, CW);
  out.edges.push(E('outreach', 'cal', 'book a call'));
  out.pulses.push({ edge: 'outreach>cal', preview: 'Find 30 min with Ivy', target: 'cal', effect: 'Finding a slot with Ivy' });
  SHOWCASE_SIZE.h = total + 80;
  out.nodes.push({ id: 'demo:anchor', type: 'demoAnchor', position: { x: x + SHOWCASE_SIZE.w / 2, y: y0 - 80 + SHOWCASE_SIZE.h / 2 }, data: {}, style: { width: 1, height: 1 }, selectable: false, draggable: false, focusable: false });
  return out;
}

const blank = (now: string, status: DemoStatus = 'running'): CardSim => ({ status, now, attention: false, i: 0, n: 0, chars: 0, hold: 0, subs: [], feed: [] });
const clean = (s: string) => s.replace(/^[?✓]\s*/, '');
const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

function initial(spec: DemoSpec): CardSim {
  switch (spec.kind) {
    case 'session': return { ...blank(clean(spec.script[0])), chars: 12, subs: spec.subs.map(([title, lines], k) => ({ title, status: k ? 'done' : 'running', line: lines[0] })) };
    case 'meeting': return spec.live ? { ...blank('Live · listening') } : { ...blank(`${spec.items.length} action items`, 'done'), label: 'Ended' };
    case 'mail': return { ...blank(spec.snippets[0], 'waiting'), attention: true, label: 'Awaiting reply' };
    case 'client': return { ...blank(`Next: ${spec.next[0]}`, 'idle'), label: spec.statuses[0] };
    case 'output': return { ...blank('Filling in'), n: 1 };
    case 'grok': return { ...blank(spec.feed[0][1]), feed: [{ kind: spec.feed[0][0], text: spec.feed[0][1], tool: spec.feed[0][2], ts: Date.now() }] };
  }
}

function tickSession(spec: Extract<DemoSpec, { kind: 'session' }>, c: CardSim, due: boolean): CardSim {
  const typing = c.status !== 'waiting' && c.chars < spec.reply.length;
  const base = typing ? { ...c, chars: Math.min(spec.reply.length, c.chars + 6) } : c;
  if (base.hold > 0) return { ...base, hold: base.hold - 1 };
  if (!due) return base;
  const i = (c.i + 1) % spec.script.length;
  const raw = spec.script[i];
  const status: DemoStatus = raw.startsWith('?') ? 'waiting' : raw.startsWith('✓') ? 'done' : 'running';
  const subs = base.subs.map((s, k): DemoSub => {
    if ((i + k) % 2) return s;
    const lines = spec.subs[k][1];
    return { ...s, status: s.status === 'running' ? 'done' : 'running', line: lines[(i + k) % lines.length] };
  });
  return { ...base, i, now: clean(raw), status, attention: status === 'waiting', subs, hold: status === 'waiting' ? 5 : status === 'done' ? 3 : 0, chars: i === 0 ? 0 : base.chars };
}

function tickMeeting(spec: Extract<DemoSpec, { kind: 'meeting' }>, c: CardSim): CardSim {
  if (c.hold > 0) return { ...c, hold: c.hold - 1 };
  const n = c.n + 1;
  if (n > spec.items.length) return { ...c, n: 0, now: spec.live ? 'Live · listening' : `${spec.items.length} action items` };
  if (spec.live) return { ...c, n, now: `Live · ${n} action item${n > 1 ? 's' : ''} so far`, hold: n === spec.items.length ? 3 : 0 };
  return { ...c, n, now: n === spec.items.length ? 'All action items picked up' : `${spec.items.length - n} action items open`, hold: n === spec.items.length ? 3 : 0 };
}

function tickMail(spec: Extract<DemoSpec, { kind: 'mail' }>, c: CardSim): CardSim {
  const i = c.i + 1;
  const phase = i % 3;
  if (phase === 1) return { ...c, i, status: 'running', label: 'Drafting', attention: false, now: 'Outreach is drafting a reply' };
  if (phase === 2) return { ...c, i, status: 'done', label: 'Replied', attention: false, now: 'Reply sent by Outreach' };
  return { ...c, i, status: 'waiting', label: 'Awaiting reply', attention: true, now: spec.snippets[(i / 3) % spec.snippets.length] };
}

function tickGrok(spec: Extract<DemoSpec, { kind: 'grok' }>, c: CardSim, due: boolean): CardSim {
  const base = spec.cli ? { ...c, n: c.n + 1 } : c;
  if (!due) return base;
  const i = (c.i + 1) % spec.feed.length;
  const [kind, text, tool] = spec.feed[i];
  const feed = [{ kind, text, tool, ts: Date.now() }, ...c.feed].slice(0, 12);
  const alert = kind === 'notice' && !spec.hub;
  return { ...base, i, feed, now: text, status: alert ? 'waiting' : 'running', attention: alert };
}

function tick(spec: DemoSpec, c: CardSim, step: number, seed: number): CardSim {
  const every = (p: number) => (step + seed) % p === 0;
  switch (spec.kind) {
    case 'session': return tickSession(spec, c, every(5 + (seed % 3)));
    case 'meeting': return every(spec.live ? 6 : 9) ? tickMeeting(spec, c) : c;
    case 'mail': return every(11 + (seed % 4)) ? tickMail(spec, c) : c;
    case 'client': {
      if (!every(17)) return c;
      const i = c.i + 1;
      return { ...c, i, label: spec.statuses[i % spec.statuses.length], now: `Next: ${spec.next[i % spec.next.length]}` };
    }
    case 'output': {
      if (!every(6)) return c;
      if (c.hold > 0) return { ...c, hold: c.hold - 1 };
      if (c.n >= spec.lines.length) return { ...c, n: 0, status: 'running', now: 'Filling in' };
      const n = c.n + 1;
      return n === spec.lines.length ? { ...c, n, status: 'done', now: 'Ready to send', hold: 3 } : { ...c, n, now: `Adding ${spec.lines[n].toLowerCase()}` };
    }
    case 'grok': return tickGrok(spec, c, every(spec.hub ? 4 : 6 + (seed % 3)));
  }
}

function setPulse(edgeId: string, preview: string) {
  const until = Date.now() + 2400;
  useStore.setState((st) => ({ activeEdges: { ...st.activeEdges, [edgeId]: { until, preview } } }));
  setTimeout(() => useStore.setState((st) => {
    const n = { ...st.activeEdges }; if (n[edgeId] && n[edgeId].until <= Date.now()) delete n[edgeId]; return { activeEdges: n };
  }), 2500);
}

interface DemoState {
  active: boolean;
  nodes: Node[];
  edges: Edge[];
  sim: Record<string, CardSim>;
  step: number;
  start: () => void;
  stop: () => void;
  onNodesChange: (changes: NodeChange[]) => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let pulseTimer: ReturnType<typeof setTimeout> | null = null;
let specs: Record<string, DemoSpec> = {};
let pulses: Pulse[] = [];

function firePulse(get: () => DemoState, set: (p: Partial<DemoState>) => void) {
  if (!get().active) return;
  const busy = useStore.getState().activeEdges;
  const free = pulses.filter((p) => !busy[`demo:e-${p.edge}`]);
  const p = free[Math.floor(Math.random() * free.length)];
  if (!p) return;
  setPulse(`demo:e-${p.edge}`, p.preview);
  const id = p.target && `demo:${p.target}`;
  const c = id && get().sim[id];
  if (id && c && p.effect && c.status !== 'waiting') set({ sim: { ...get().sim, [id]: { ...c, now: p.effect, status: 'running', hold: Math.max(c.hold, 2) } } });
}

function clearTimers() {
  if (timer) clearInterval(timer);
  if (pulseTimer) clearTimeout(pulseTimer);
  timer = null; pulseTimer = null;
}

export const useDemo = create<DemoState>((set, get) => ({
  active: false, nodes: [], edges: [], sim: {}, step: 0,
  start: () => {
    clearTimers();
    const built = build();
    specs = built.specs; pulses = built.pulses;
    const sim: Record<string, CardSim> = {};
    for (const [id, spec] of Object.entries(specs)) sim[id] = initial(spec);
    set({ active: true, nodes: built.nodes, edges: built.edges, sim, step: 0 });
    timer = setInterval(() => {
      const { sim: cur, step } = get();
      const next: Record<string, CardSim> = {};
      for (const [id, c] of Object.entries(cur)) next[id] = specs[id] ? tick(specs[id], c, step + 1, hash(id) % 13) : c;
      set({ sim: next, step: step + 1 });
    }, 700);
    const loop = () => { pulseTimer = setTimeout(() => { firePulse(get, set); loop(); }, 1500 + Math.random() * 1500); };
    setTimeout(() => firePulse(get, set), 400);
    loop();
  },
  stop: () => {
    clearTimers();
    useStore.setState((st) => {
      const n = { ...st.activeEdges }; for (const k of Object.keys(n)) if (k.startsWith('demo:')) delete n[k]; return { activeEdges: n };
    });
    set({ active: false, nodes: [], edges: [], sim: {} });
  },
  // Board routes changes for 'demo:' ids here so demo cards drag and select without being saved.
  onNodesChange: (changes) => {
    const mine = changes.filter((c) => 'id' in c && String(c.id).startsWith('demo:') && c.type !== 'remove');
    if (mine.length) set({ nodes: applyNodeChanges(mine, get().nodes) });
  },
}));

// Zoom that fits the whole showcase in the window.
export function showcaseZoom() {
  // Leave room for the toolbars above and the dock below.
  const z = Math.min((window.innerWidth - 160) / SHOWCASE_SIZE.w, (window.innerHeight - 250) / SHOWCASE_SIZE.h);
  return Math.max(0.25, Math.min(0.85, z));
}

export const isDemoId = (id: string) => id.startsWith('demo:');
