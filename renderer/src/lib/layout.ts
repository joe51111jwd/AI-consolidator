import { Entity, BoardRow, Client } from './api';
import { baseName, categoryOf, isNoise } from './format';

export const CARD_W = 300, GUTTER = 22, PAD = 24, HEAD = 56, GAP = 72;
const MAXW = 2400, COL = CARD_W + GUTTER, DAY = 86400000;
export const PALETTE = ['#D97757', '#6D5BD0', '#2F6B55', '#3F5E8C', '#B08A2E', '#9A4B5B', '#4E6E7E', '#52525B'];

const blank = (e: Entity) => !(e.preview || '').trim();

// Which cards show up on the board without the user placing them.
export function defaultVisible(e: Entity, now = Date.now()) {
  if (isNoise(e)) return false;
  switch (e.kind) {
    case 'account': case 'client': case 'note': case 'error': return true;
    case 'output': return !blank(e) || now - e.updatedAt < 120000;
    case 'session': return now - e.updatedAt < 7 * DAY;
    case 'meeting': return now - e.updatedAt < 5 * DAY;
    case 'thread': return e.status === 'waiting' && now - e.updatedAt < 7 * DAY;
    default: return false;
  }
}

// Cards that never render, even if an older layout placed them.
export function suppressed(e: Entity, now = Date.now()) {
  return e.kind === 'project' || isNoise(e) || (e.kind === 'output' && blank(e) && now - e.updatedAt > 600000);
}

// ---------- filter ----------
export const srcKey = (s: string) => (s === 'anthropic-api' ? 'claude-code' : s);
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
export function estH(e?: Entity): number {
  if (!e) return 160;
  const prev = !blank(e);
  switch (e.kind) {
    case 'account': return ['claude-code', 'codex', 'anthropic-api', 'openai-compatible', 'grok-bot'].includes(e.source) ? 136 : 72;
    case 'session': return prev ? 228 : 150;
    case 'meeting': return prev ? 196 : 112;
    case 'thread': return prev ? 172 : 100;
    case 'client': return 150;
    case 'output': return prev ? 248 : 132;
    case 'note': return 150;
    default: return 120;
  }
}

// ---------- grouping ----------
export interface GroupSpec { label: string; color?: string; ids: string[] }

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

// Keeps only known ids, each once; anything the grouping missed lands in a final group.
export function cleanGroups(raw: any, ids: string[]): GroupSpec[] {
  const want = new Set(ids), seen = new Set<string>();
  const out: GroupSpec[] = [];
  for (const g of Array.isArray(raw) ? raw : []) {
    const gids: string[] = [];
    for (const id of Array.isArray(g?.ids) ? g.ids : []) if (typeof id === 'string' && want.has(id) && !seen.has(id)) { seen.add(id); gids.push(id); }
    if (!gids.length) continue;
    const color = typeof g.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(g.color) ? g.color : PALETTE[out.length % PALETTE.length];
    out.push({ label: String(g.label || 'Group').slice(0, 60), color, ids: gids });
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
    const short = g.ids.reduce((t, id) => t + heightOf(id), 0) / n < 150;
    const cols = short ? Math.min(n, 4) : n <= 3 ? n : n <= 6 ? 2 : n <= 12 ? 3 : 4;
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
    rows.push({ id: gid, x: origin.x + x, y: origin.y + y, w, h, parent_id: null, data: { label: g.label, color: g.color || PALETTE[gi % PALETTE.length], smart: true } }, ...kids);
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
export function placeNew(ids: string[], existing: BoardRow[], byId: Record<string, Entity>): BoardRow[] {
  const rows = existing.filter((r) => !r.hidden).map((r) => ({ ...r }));
  const out = new Map<string, BoardRow>();
  const tops = rows.filter((r) => !r.parent_id);
  const right = tops.reduce((m, r) => Math.max(m, r.x + rowSize(r, byId).w), 0) + GAP;
  let col = 0, colY = 0;
  for (const id of ids) {
    const e = byId[id];
    const g = e && rows.find((r) => r.id === homeFrame(e, rows, byId) && r.w && r.h);
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
