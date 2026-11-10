import { Entity, BoardRow, Client } from './api';

export type GroupMode = 'project' | 'source' | 'client';
const COL = 320, ROW = 300, AGENT_ROW = 200, PAD = 24, HEAD = 52, GAP = 48, MAXW = 2300;
const DAY = 86400000;

// Which cards show up on the board without the user placing them.
export function defaultVisible(e: Entity, now = Date.now()) {
  switch (e.kind) {
    case 'account': case 'client': case 'output': case 'note': case 'error': return true;
    case 'project': return now - e.updatedAt < 14 * DAY;
    case 'session': return now - e.updatedAt < 7 * DAY;
    case 'meeting': return now - e.updatedAt < 5 * DAY;
    case 'thread': return e.status === 'waiting' && now - e.updatedAt < 7 * DAY;
    default: return false;
  }
}

interface Bucket { key: string; label: string; color?: string; ids: string[] }

function matchesClient(c: Client, email: string) {
  if (!email) return false; email = email.toLowerCase();
  return c.emails.includes(email) || c.domains.includes(email.split('@')[1]);
}

export function buckets(mode: GroupMode, list: Entity[], accounts: { id: string; label: string; color: string }[]): Bucket[] {
  const by = new Map<string, Bucket>();
  const put = (key: string, label: string, id: string, color?: string) => {
    const b = by.get(key) || { key, label, color, ids: [] }; b.ids.push(id); by.set(key, b);
  };
  const ordered = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  const clients = ordered.filter((e) => e.kind === 'client').map((e) => e.meta.client as Client);
  for (const e of ordered) {
    if (mode === 'project') {
      if (e.kind === 'account') put('agents', 'Agents & accounts', e.id, '#7A5A8C');
      else if (e.kind === 'project') put(e.id, e.title, e.id, '#2F6B55');
      else if (e.kind === 'session' && e.meta?.project && list.some((x) => x.id === e.meta.project)) put(e.meta.project, '', e.id);
      else if (e.kind === 'session') put('chats', 'Other chats', e.id, '#C0603E');
      else if (e.kind === 'client' || e.kind === 'thread' || e.kind === 'meeting') put('clients', 'Clients, mail & meetings', e.id, '#9A4B5B');
      else put('outputs', 'Outputs & notes', e.id, '#B08A2E');
    } else if (mode === 'source') {
      if (e.accountId) { const a = accounts.find((x) => x.id === e.accountId); put('src:' + e.accountId, a?.label || e.source, e.id, a?.color); }
      else if (e.kind === 'project') put('projects', 'Code projects', e.id, '#2F6B55');
      else if (e.kind === 'client') put('clients', 'Clients', e.id, '#9A4B5B');
      else put('outputs', 'Outputs & notes', e.id, '#B08A2E');
    } else {
      let key = '', label = '';
      if (e.kind === 'client') { key = e.id; label = e.title; }
      else {
        const c = clients.find((c) =>
          (e.kind === 'thread' && (e.meta?.participants || []).some((p: string) => matchesClient(c, p))) ||
          (e.kind === 'meeting' && (e.meta?.attendees || []).some((p: any) => matchesClient(c, p.email))) ||
          (e.kind === 'project' && c.project_paths.includes(e.meta?.cwd)) ||
          (e.kind === 'session' && e.meta?.cwd && c.project_paths.some((p) => e.meta.cwd.startsWith(p))));
        if (c) { key = 'cl:' + c.id; label = c.name; }
      }
      if (key) put(key, label, e.id, '#2F6B55');
      else if (e.kind === 'account') put('agents', 'Agents & accounts', e.id, '#7A5A8C');
      else put('other', 'Not tied to a client', e.id, '#96918A');
    }
  }
  // Fill in project group labels and order: agents first, projects by recency, then the rest.
  const out = [...by.values()];
  for (const b of out) if (!b.label) b.label = list.find((x) => x.id === b.key)?.title || b.key;
  const rank = (b: Bucket) => (b.key === 'agents' ? 0 : b.key === 'clients' ? 2 : b.key === 'outputs' || b.key === 'other' ? 3 : b.key === 'chats' ? 2.5 : 1);
  out.sort((a, b) => rank(a) - rank(b));
  return out;
}

// Lay buckets out as group frames packed left to right, wrapping rows.
export function smartLayout(mode: GroupMode, list: Entity[], accounts: any[]): BoardRow[] {
  const rows: BoardRow[] = [];
  let x = 0, y = 0, rowH = 0;
  for (const b of buckets(mode, list, accounts)) {
    const cols = b.key === 'agents' ? Math.min(b.ids.length, 4) : Math.min(3, Math.max(1, Math.ceil(Math.sqrt(b.ids.length))));
    const nrows = Math.ceil(b.ids.length / cols);
    const w = PAD * 2 + cols * COL - (COL - 296);
    const rh = b.key === 'agents' ? AGENT_ROW : ROW;
    const h = HEAD + nrows * rh + PAD - 30;
    if (x > 0 && x + w > MAXW) { x = 0; y += rowH + GAP; rowH = 0; }
    const gid = `grp:${mode}:${b.key}`;
    rows.push({ id: gid, x, y, w, h, parent_id: null, data: { label: b.label, color: b.color, smart: true, count: b.ids.length } });
    b.ids.forEach((id, i) => rows.push({ id, x: PAD + (i % cols) * COL, y: HEAD + Math.floor(i / cols) * rh, parent_id: gid, data: {} }));
    x += w + GAP; rowH = Math.max(rowH, h);
  }
  return rows;
}

// Where to put a card that appeared since the last layout.
export function placeNew(ids: string[], existing: BoardRow[]): BoardRow[] {
  const tops = existing.filter((r) => !r.parent_id);
  const maxX = tops.reduce((m, r) => Math.max(m, r.x + (r.w || 320)), 0);
  return ids.map((id, i) => ({ id, x: maxX + GAP + Math.floor(i / 6) * COL, y: (i % 6) * ROW, parent_id: null, data: {} }));
}
