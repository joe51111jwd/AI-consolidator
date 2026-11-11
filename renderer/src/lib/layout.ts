import { Entity, BoardRow, Client } from './api';
import { baseName, categoryOf, isNoise } from './format';

export const CARD_W = 260, GUTTER = 16, PAD = 20, HEAD = 52, GAP = 56, COMPACT_H = 88;
const MAXW = 2200, COL = CARD_W + GUTTER, DAY = 86400000;
export const PALETTE = ['#D97757', '#6D5BD0', '#2F6B55', '#3F5E8C', '#B08A2E', '#9A4B5B', '#4E6E7E', '#52525B'];

const blank = (e: Entity) => !(e.preview || '').trim();

// Runs Switchboard itself started (the overall agent, smart grouping) are plumbing, not the user's work.
const INTERNAL_RE = /^\s*(You are the overall agent inside Switchboard|Group these cards from my work whiteboard)/;
const APP_DIR_RE = /[\\/]\.switchboard([\\/]|$)/;
export const isInternal = (e: Entity) =>
  e.kind === 'session' && (
    (typeof e.meta?.cwd === 'string' && APP_DIR_RE.test(e.meta.cwd))
    || [e.title, e.preview, e.meta?.activity?.prompt, e.meta?.firstPrompt].some((t) => typeof t === 'string' && INTERNAL_RE.test(t)));

// Which cards show up on the board without the user placing them.
export function defaultVisible(e: Entity, now = Date.now()) {
  if (isNoise(e) || isInternal(e)) return false;
  // The board is this week: Grok bots quiet for a week stay off it until they're active again or you add them back.
  if (e.source === 'grok-bot' && e.kind === 'session') return now - (e.meta?.lastActivityAt || e.updatedAt) < 7 * DAY;
  switch (e.kind) {
    case 'account': case 'client': case 'note': case 'error': return true;
    case 'output': return !blank(e) || now - e.updatedAt < 120000;
    case 'session': return now - e.updatedAt < 7 * DAY;
    case 'meeting': return now - e.updatedAt < 7 * DAY;
    case 'thread': return e.status === 'waiting' && now - e.updatedAt < 7 * DAY;
    default: return false;
  }
}

// Cards that never render, even if an older layout placed them.
export function suppressed(e: Entity, now = Date.now()) {
  return e.kind === 'project' || isNoise(e) || isInternal(e) || (e.kind === 'output' && blank(e) && now - e.updatedAt > 600000);
}

// ---------- filter ----------
export const srcKey = (s: string) => (s === 'anthropic-api' || s === 'claude-ai' ? 'claude-code' : s);
export function filterKeys(e: Entity): string[] {
  const keys = ['src:' + srcKey(e.source)];
  const cat = categoryOf(e);
  if (cat) keys.push(cat);
  if (e.kind === 'thread') keys.push('mail');
  if (e.kind === 'meeting') keys.push('meetings');
  if (e.kind === 'output' || e.kind === 'note') keys.push('notes');
  return keys;
}
export const passesFilter = (e: Entity, off: Set<string>) => !off.size || !filterKeys(e).some((k) => off.has(k));

// Rough card heights before the cards have rendered; real measurements are used when known.
// Agent, chat, meeting, mail, client and output cards are a fixed compact height (their drawer floats).
export function estH(e?: Entity): number {
  if (!e) return COMPACT_H;
  switch (e.kind) {
    case 'account': return ['claude-code', 'codex', 'anthropic-api', 'openai-compatible', 'grok-bot'].includes(e.source) ? 136 : 72;
    case 'session': case 'meeting': case 'thread': case 'client': return COMPACT_H;
    case 'output': return blank(e) ? 132 : COMPACT_H;
    case 'note': return 150;
    default: return 120;
  }
}

// ---------- grouping ----------
export interface GroupSpec { label: string; color?: string; ids: string[]; topic?: string }

function matchesClient(c: Client, email: string) {
  if (!email) return false; email = email.toLowerCase();
  return c.emails.includes(email) || c.domains.includes(email.split('@')[1]);
}

function clientFor(e: Entity, clients: Client[]) {
  return clients.find((c) =>
    (e.kind === 'thread' && (e.meta?.participants || []).some((p: string) => matchesClient(c, p))) ||
    (e.kind === 'meeting' && (e.meta?.attendees || []).some((p: any) => matchesClient(c, p.email))) ||
    (e.kind === 'session' && e.meta?.cwd && (c.project_paths || []).some((p) => e.meta.cwd.startsWith(p))));
}

// Deterministic grouping used when the AI grouping isn't available: agents, then client, project folder, chats, mail, notes.
export function heuristicGroups(list: Entity[], all: Record<string, Entity> = {}): GroupSpec[] {
  const by = new Map<string, GroupSpec & { rank: number }>();
  const put = (key: string, label: string, rank: number, id: string, color?: string) => {
    const g = by.get(key) || { label, color, rank, ids: [] }; g.ids.push(id); by.set(key, g);
  };
  const ordered = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  const clients = ordered.filter((e) => e.kind === 'client' && e.meta?.client).map((e) => e.meta.client as Client);
  for (const e of ordered) {
    const c = e.kind === 'client' ? (e.meta?.client as Client) : clientFor(e, clients);
    if (e.kind === 'account') put('agents', 'Agents', 0, e.id, '#18181B');
    else if (c) put('cl:' + c.id, c.name, 2, e.id, '#2F6B55');
    else if (e.kind === 'session' && categoryOf(e) === 'coding') {
      const name = all[e.meta?.project]?.title || baseName(e.meta?.cwd) || 'Code';
      put('pj:' + name, name, 1, e.id);
    } else if (e.kind === 'session') put('chats', 'Chats', 3, e.id, '#D97757');
    else if (e.kind === 'thread' || e.kind === 'meeting') put('inbox', 'Mail & meetings', 4, e.id, '#9A4B5B');
    else put('notes', 'Notes', 5, e.id, '#B08A2E');
  }
  // Fold one-card projects together so the board isn't a wall of tiny frames.
  const solo = [...by.entries()].filter(([k, g]) => k.startsWith('pj:') && g.ids.length === 1);
  if (solo.length >= 3) {
    for (const [k] of solo) by.delete(k);
    by.set('pj:*', { label: 'Code', rank: 1.5, ids: solo.map(([, g]) => g.ids[0]) });
  }
  let i = 0;
  return [...by.values()].sort((a, b) => a.rank - b.rank).map(({ label, color, ids }) => ({ label, ids, color: color || PALETTE[i++ % PALETTE.length] }));
}

// ---------- the week board ----------
export const ARRANGED_KEY = 'boardArranged';
export const GROK_TOPIC = 'grok';
export interface WeekTopic { id: string; label: string; ids: string[] }
export interface WeekFlags { attn: (id: string) => boolean; running: (id: string) => boolean }

const isBot = (e?: Entity) => !!e && e.source === 'grok-bot' && e.kind === 'session';

// Topics become frames, ordered: needing you first, then working, then the rest by latest activity.
// Grok bots not tied to a topic (none, or a topic that is just that bot) share a "Grok bots" frame;
// anything no topic covers falls back to the quick grouping, after the topics.
export function weekGroups(ids: string[], topics: WeekTopic[], byId: Record<string, Entity>, f: WeekFlags): GroupSpec[] {
  const want = new Set(ids.filter((id) => byId[id])), used = new Set<string>();
  const ranked: (GroupSpec & { attn: number; work: number; latest: number })[] = [];
  const bots: string[] = [];
  const add = (label: string, list: string[], topic: string) => {
    const at = (id: string) => byId[id]?.updatedAt || 0;
    const score = (id: string) => (f.attn(id) ? 2 : 0) + (f.running(id) ? 1 : 0);
    const sorted = [...list].sort((a, b) => score(b) - score(a) || at(b) - at(a));
    ranked.push({ label, ids: sorted, topic, attn: list.filter(f.attn).length, work: list.filter(f.running).length, latest: Math.max(0, ...list.map(at)) });
  };
  for (const t of topics) {
    const mine = (t.ids || []).filter((id) => want.has(id) && !used.has(id));
    if (!mine.length) continue;
    mine.forEach((id) => used.add(id));
    const solo = mine.every((id) => isBot(byId[id])) && (mine.length === 1 || mine.some((id) => byId[id].title === t.label));
    if (solo) bots.push(...mine); else add(String(t.label || 'Topic').slice(0, 60), mine, t.id);
  }
  for (const id of want) if (!used.has(id) && isBot(byId[id])) { used.add(id); bots.push(id); }
  if (bots.length) add('Grok bots', bots, GROK_TOPIC);
  ranked.sort((a, b) => Number(b.attn > 0) - Number(a.attn > 0) || Number(b.work > 0) - Number(a.work > 0) || b.latest - a.latest);
  const rest = heuristicGroups([...want].filter((id) => !used.has(id)).map((id) => byId[id]), byId);
  return [...ranked.map(({ label, ids: gids, topic }, i) => ({ label, ids: gids, topic, color: PALETTE[i % PALETTE.length] })), ...rest];
}

// Keeps only known ids, each once; anything the grouping missed lands in a final group.
export function cleanGroups(raw: any, ids: string[]): GroupSpec[] {
  const want = new Set(ids), seen = new Set<string>();
  const out: GroupSpec[] = [];
  for (const g of Array.isArray(raw) ? raw : []) {
    const gids: string[] = [];
    for (const id of Array.isArray(g?.ids) ? g.ids : []) if (typeof id === 'string' && want.has(id) && !seen.has(id)) { seen.add(id); gids.push(id); }
    if (!gids.length) continue;
    const color = typeof g.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(g.color) ? g.color : PALETTE[out.length % PALETTE.length];
    out.push({ label: String(g.label || 'Group').slice(0, 60), color, ids: gids, ...(typeof g.topic === 'string' ? { topic: g.topic } : {}) });
  }
  const rest = ids.filter((id) => !seen.has(id));
  if (rest.length) out.push({ label: 'Other', color: '#71717A', ids: rest });
  return out;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'g';

// Lays groups out as frames, packed left to right in shelves; cards inside a frame flow into the shortest column.
export function frameLayout(groups: GroupSpec[], heightOf: (id: string) => number, origin = { x: 0, y: 0 }): { rows: BoardRow[]; bottom: number } {
  const rows: BoardRow[] = [];
  let x = 0, y = 0, shelf = 0;
  groups.forEach((g, gi) => {
    const n = g.ids.length; if (!n) return;
    const short = g.ids.reduce((t, id) => t + heightOf(id), 0) / n < 120;
    const cols = short ? (n <= 3 ? n : n <= 8 ? Math.ceil(n / 2) : Math.min(5, Math.ceil(Math.sqrt(n * 2))))
      : n <= 3 ? n : n <= 6 ? 2 : n <= 12 ? 3 : 4;
    const colH = new Array(cols).fill(0);
    const gid = `grp:smart:${slug(g.label)}-${gi}`;
    const kids: BoardRow[] = g.ids.map((id) => {
      const c = colH.indexOf(Math.min(...colH));
      const r = { id, x: PAD + c * COL, y: HEAD + colH[c], parent_id: gid, data: {} };
      colH[c] += heightOf(id) + GUTTER;
      return r;
    });
    const w = PAD * 2 + cols * CARD_W + (cols - 1) * GUTTER;
    const h = HEAD + Math.max(...colH) - GUTTER + PAD;
    if (x > 0 && x + w > MAXW) { x = 0; y += shelf + GAP; shelf = 0; }
    rows.push({ id: gid, x: origin.x + x, y: origin.y + y, w, h, parent_id: null, data: { label: g.label, color: g.color || PALETTE[gi % PALETTE.length], smart: true, ...(g.topic ? { topic: g.topic } : {}) } }, ...kids);
    x += w + GAP; shelf = Math.max(shelf, h);
  });
  return { rows, bottom: origin.y + y + shelf };
}

function rowSize(r: BoardRow, byId: Record<string, Entity>) {
  return { w: r.w || CARD_W, h: r.h || estH(byId[r.id]) };
}
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// The frame a new card belongs in: one already holding a sibling (same folder, or the same kind of card
// outside any client's frame). Clients and diagrams never adopt strays.
function homeFrame(e: Entity, rows: BoardRow[], byId: Record<string, Entity>) {
  if (e.kind === 'client') return undefined;
  const clientFrames = new Set(rows.filter((r) => r.parent_id && byId[r.id]?.kind === 'client').map((r) => r.parent_id));
  const placed = rows.filter((r) => r.parent_id && !r.hidden && byId[r.id] && !r.parent_id.startsWith('grp:ai:'));
  const same = (pred: (o: Entity) => boolean, anyFrame = false) =>
    placed.find((r) => (anyFrame || !clientFrames.has(r.parent_id)) && pred(byId[r.id]))?.parent_id;
  if (e.kind === 'session' && e.meta?.cwd && categoryOf(e) === 'coding') return same((o) => o.kind === 'session' && o.meta?.cwd === e.meta.cwd, true);
  if (e.kind === 'session') return same((o) => o.kind === 'session' && categoryOf(o) === 'chat');
  if (e.kind === 'output' || e.kind === 'note') return same((o) => o.kind === 'output' || o.kind === 'note');
  if (e.kind === 'thread' || e.kind === 'meeting') return same((o) => o.kind === 'thread' || o.kind === 'meeting');
  return same((o) => o.kind === e.kind);
}

// Where to put cards that appeared since the last layout: in their home frame if it can grow without
// running into anything, otherwise in a column to the right of everything.
// `prefer` names a frame to try first (the card's topic frame on the week board).
export function placeNew(ids: string[], existing: BoardRow[], byId: Record<string, Entity>, prefer?: (e: Entity) => string | undefined): BoardRow[] {
  const rows = existing.filter((r) => !r.hidden).map((r) => ({ ...r }));
  const out = new Map<string, BoardRow>();
  const tops = rows.filter((r) => !r.parent_id);
  const right = tops.reduce((m, r) => Math.max(m, r.x + rowSize(r, byId).w), 0) + GAP;
  let col = 0, colY = 0;
  for (const id of ids) {
    const e = byId[id];
    const want = e && ((prefer && prefer(e)) || homeFrame(e, rows, byId));
    const g = want ? rows.find((r) => r.id === want && r.w && r.h) : undefined;
    if (g && e) {
      const cols = Math.max(1, Math.round((g.w! - 2 * PAD + GUTTER) / COL));
      const bottoms = new Array(cols).fill(HEAD);
      for (const k of rows.filter((r) => r.parent_id === g.id)) {
        const c = Math.min(cols - 1, Math.max(0, Math.round((k.x - PAD) / COL)));
        bottoms[c] = Math.max(bottoms[c], k.y + estH(byId[k.id]) + GUTTER);
      }
      const c = bottoms.indexOf(Math.min(...bottoms));
      const r: BoardRow = { id, x: PAD + c * COL, y: bottoms[c], parent_id: g.id, data: {} };
      const h = Math.max(g.h!, r.y + estH(e) + PAD);
      const grown = { x: g.x, y: g.y, w: g.w!, h };
      if (!tops.some((t) => t.id !== g.id && overlaps(grown, { x: t.x, y: t.y, ...rowSize(t, byId) }))) {
        g.h = h; rows.push(r); out.set(id, r); out.set(g.id, g);
        continue;
      }
    }
    const r: BoardRow = { id, x: right + col * COL, y: colY, parent_id: null, data: {} };
    colY += estH(e) + GUTTER;
    if (colY > 1500) { col++; colY = 0; }
    rows.push(r); tops.push(r); out.set(id, r);
  }
  return [...out.values()];
}

// Grows a frame so every card inside it fits.
export function fitFrame(g: BoardRow, kids: { x: number; y: number; w: number; h: number }[]): BoardRow | null {
  if (!kids.length) return null;
  const w = Math.max(g.w || 0, ...kids.map((k) => k.x + k.w + PAD));
  const h = Math.max(g.h || 0, ...kids.map((k) => k.y + k.h + PAD));
  return w > (g.w || 0) + 0.5 || h > (g.h || 0) + 0.5 ? { ...g, w, h } : null;
}

// Cards grow after they're placed (a reply streams in, a usage bar appears). Pushes whatever a card
// now covers further down inside its frame, grows the frame, then moves frames off each other.
// Loose cards are left where you put them.
type Box = { id: string; x: number; y: number; w: number; h: number };
export interface SettleNode { id: string; type?: string; parentId?: string; position: { x: number; y: number }; measured?: { width?: number; height?: number }; style?: any; dragging?: boolean }

function spread(list: Box[], changed: Set<string>) {
  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    list.sort((a, b) => a.y - b.y || a.x - b.x);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && b.y < a.y + a.h - 1) { b.y = a.y + a.h + GUTTER; changed.add(b.id); moved = true; }
    }
    if (!moved) return;
  }
}

export function unoverlap(nodes: SettleNode[], board: BoardRow[]): BoardRow[] {
  const rowOf = new Map(board.map((r) => [r.id, r]));
  const frames = new Map<string, Box>();
  const kids = new Map<string, Box[]>();
  for (const n of nodes) {
    if (!rowOf.has(n.id)) continue;
    if (n.type === 'group') { frames.set(n.id, { id: n.id, x: n.position.x, y: n.position.y, w: Number(n.style?.width) || 400, h: Number(n.style?.height) || 300 }); continue; }
    if (!n.parentId) continue;
    if (!n.measured?.height) return [];
    kids.set(n.parentId, [...(kids.get(n.parentId) || []), { id: n.id, x: n.position.x, y: n.position.y, w: n.measured.width || CARD_W, h: n.measured.height }]);
  }
  const changed = new Set<string>();
  const out: BoardRow[] = [];
  for (const [gid, list] of kids) {
    const before = changed.size;
    spread(list, changed);
    const g = frames.get(gid);
    if (!g || changed.size === before) continue;
    const fit = fitFrame({ ...rowOf.get(gid)!, w: g.w, h: g.h }, list);
    if (fit) { g.w = fit.w!; g.h = fit.h!; changed.add(gid); }
  }
  spread([...frames.values()], changed);
  for (const b of [...frames.values(), ...[...kids.values()].flat()]) {
    if (!changed.has(b.id)) continue;
    const r = rowOf.get(b.id)!;
    out.push(frames.has(b.id) ? { ...r, x: b.x, y: b.y, w: b.w, h: b.h } : { ...r, x: b.x, y: b.y });
  }
  return out;
}

// ---------- the flowchart week board ----------
// What the week board shows: this week's chats, meetings and mail (or anything running or waiting on you),
// plus notes and outputs from this week. Account cards and older notes stay off it.
export function onWeekBoard(e: Entity, now = Date.now()) {
  if (e.kind === 'account' || e.kind === 'client' || e.kind === 'project' || e.kind === 'error') return false;
  if (e.status === 'running' || e.status === 'waiting') return true;
  if (e.kind === 'note') return false;
  if (e.kind === 'output') return now - (e.meta?.createdAt || e.updatedAt) < 7 * DAY;
  return true;
}
export const OLD_FRAMES = new Set(['agents', 'notes', 'other']);

export interface WeekProject { id: string; label: string; ids: string[] }
export interface WeekClient { id: string; label: string; projects: WeekProject[] }
export interface TreeData { client: { x: number; y: number }; projects: (WeekProject & { x: number; y: number })[] }

export const PILL_W = 168, PILL_H = 34;
const LANE = 56, PER_ROW = 3, TREE_GAP = 140, TREE_MAXW = 3600;

// Accepts the `clients` hierarchy from topics:get in a few likely shapes; empty when absent.
export function parseClients(raw: any): WeekClient[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: any, d: string) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : d);
  return raw.map((c: any, i: number): WeekClient => {
    const list = Array.isArray(c?.projects) ? c.projects : Array.isArray(c?.topics) ? c.topics : [];
    const projects = list.map((p: any, j: number) => ({ id: str(p?.id, `p${j}`), label: str(p?.label ?? p?.name, 'Project'), ids: Array.isArray(p?.ids) ? p.ids.filter((x: any) => typeof x === 'string') : [] }));
    return { id: str(c?.id, `c${i}`), label: str(c?.label ?? c?.name, 'Client'), projects };
  }).filter((c) => c.projects.length);
}

// One frame per client, laid out as a small flowchart: client pill, then a pill per project,
// then that project's chats in rows to its right. Frames pack left to right with wide gaps.
export function treeLayout(clients: WeekClient[], heightOf: (id: string) => number): { rows: BoardRow[]; bottom: number } {
  const rows: BoardRow[] = [];
  let x = 0, y = 0, shelf = 0;
  clients.forEach((c, ci) => {
    const projects = c.projects.filter((p) => p.ids.length);
    if (!projects.length) return;
    const gid = `grp:smart:${slug(c.label)}-${ci}`;
    const px = PAD + PILL_W + LANE, cx = px + PILL_W + LANE;
    let cy = HEAD + 8;
    const tree: TreeData = { client: { x: PAD, y: 0 }, projects: [] };
    for (const p of projects) {
      const top = cy;
      let firstH = 0;
      for (let r = 0; r * PER_ROW < p.ids.length; r++) {
        const row = p.ids.slice(r * PER_ROW, (r + 1) * PER_ROW);
        const rh = Math.max(...row.map(heightOf));
        if (!r) firstH = rh;
        row.forEach((id, k) => rows.push({ id, x: cx + k * COL, y: cy, parent_id: gid, data: {} }));
        cy += rh + GUTTER;
      }
      tree.projects.push({ ...p, x: px, y: top + (firstH - PILL_H) / 2 });
      cy += GUTTER * 2;
    }
    const ys = tree.projects.map((p) => p.y);
    tree.client.y = (Math.min(...ys) + Math.max(...ys)) / 2;
    const most = Math.min(PER_ROW, Math.max(...projects.map((p) => p.ids.length)));
    const w = cx + most * COL - GUTTER + PAD;
    const h = cy - GUTTER * 3 + PAD;
    if (x > 0 && x + w > TREE_MAXW) { x = 0; y += shelf + TREE_GAP; shelf = 0; }
    rows.push({ id: gid, x, y, w, h, parent_id: null, data: { label: c.label, color: PALETTE[ci % PALETTE.length], smart: true, topic: c.id, tree } });
    x += w + TREE_GAP; shelf = Math.max(shelf, h);
  });
  return { rows, bottom: y + shelf };
}

// Builds the client → project hierarchy for this week's cards, what needs you first.
// Without a hierarchy, each topic becomes its own client with one project; uncovered cards
// go to a "This week" frame split by the quick grouping.
export function weekClients(ids: string[], clients: WeekClient[], topics: WeekTopic[], byId: Record<string, Entity>, f: WeekFlags): WeekClient[] {
  const want = new Set(ids.filter((id) => byId[id])), used = new Set<string>();
  const src: WeekClient[] = clients.length ? clients : topics.map((t) => ({ id: t.id, label: t.label, projects: [{ id: t.id, label: t.label, ids: t.ids }] }));
  const at = (id: string) => byId[id]?.updatedAt || 0;
  const score = (id: string) => (f.attn(id) ? 2 : 0) + (f.running(id) ? 1 : 0);
  const sortIds = (l: string[]) => [...l].sort((a, b) => score(b) - score(a) || at(b) - at(a));
  const out: WeekClient[] = [];
  for (const c of src) {
    const projects = c.projects.map((p) => {
      const mine = sortIds(p.ids.filter((id) => want.has(id) && !used.has(id)));
      mine.forEach((id) => used.add(id));
      return { ...p, ids: mine };
    }).filter((p) => p.ids.length);
    if (projects.length) out.push({ ...c, projects });
  }
  const rest = [...want].filter((id) => !used.has(id));
  if (rest.length) {
    const groups = heuristicGroups(rest.map((id) => byId[id]), byId);
    out.push({ id: 'week', label: 'This week', projects: groups.map((g, i) => ({ id: `h${i}`, label: g.label, ids: sortIds(g.ids) })) });
  }
  const rank = (c: WeekClient) => {
    const all = c.projects.flatMap((p) => p.ids);
    return [Number(all.some(f.attn)), Number(all.some(f.running)), Math.max(0, ...all.map(at))];
  };
  return out.map((c) => ({ c, r: rank(c) })).sort((a, b) => b.r[0] - a.r[0] || b.r[1] - a.r[1] || b.r[2] - a.r[2]).map(({ c }) => c);
}
