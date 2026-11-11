import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, StickyNote, Sparkles, Inbox, Settings, Users, BookOpen, LayoutGrid, Tag, Plus, Check, X, Shapes, Sun, Download, Compass } from 'lucide-react';
import { useStore } from '../lib/store';
import { useImport } from './ImportChats';
import { api, Entity, BoardRow } from '../lib/api';
import { SOURCE, ago } from '../lib/format';
import { suppressed } from '../lib/layout';
import { AgentLogo } from './Logos';
import { useTour } from './Tour';
import './panels.css';

interface Hit { id: string; title: string; source: string; kind: string; snippet?: string; updatedAt: number }
type Row = { type: 'hit'; hit: Hit } | { type: 'cmd'; cmd: Cmd };
interface Cmd { id: string; label: string; icon: any; keys?: string; run: () => void | Promise<void> }

const PREFIX: Record<string, { label: string; source: string; sources?: string[]; kinds?: string[] }> = {
  claude: { label: 'Claude', source: 'claude-code', sources: ['claude-code', 'anthropic-api'] },
  grok: { label: 'Grok', source: 'grok-bot', sources: ['grok-bot'] },
  granola: { label: 'Granola', source: 'granola', sources: ['granola'] },
  meeting: { label: 'Granola', source: 'granola', sources: ['granola'] },
  gmail: { label: 'Gmail', source: 'gmail', sources: ['gmail'] },
  mail: { label: 'Gmail', source: 'gmail', sources: ['gmail'] },
  cursor: { label: 'Cursor', source: 'cursor', sources: ['cursor'] },
  codex: { label: 'Codex', source: 'codex', sources: ['codex'] },
  client: { label: 'Clients', source: 'crm', kinds: ['client'] },
  clients: { label: 'Clients', source: 'crm', kinds: ['client'] },
  output: { label: 'Outputs', source: 'output', kinds: ['output'] },
  note: { label: 'Notes', source: 'note', kinds: ['note'] },
};
const CHIPS = ['claude', 'grok', 'granola', 'gmail', 'cursor', 'codex', 'client'];
const GROUP: Record<string, string> = {
  'claude-code': 'Claude', 'anthropic-api': 'Claude', 'grok-bot': 'Grok', granola: 'Meetings', gmail: 'Mail',
  cursor: 'Cursor', codex: 'Codex', 'openai-compatible': 'Chats', crm: 'Clients', output: 'Outputs', note: 'Notes',
};

function parse(q: string) {
  const m = q.match(/^([a-z]+)(?::|\s)\s*(.*)$/is);
  const key = m?.[1].toLowerCase();
  return key && PREFIX[key] ? { pre: key, text: (m?.[2] || '').trim(), rest: m?.[2] || '' } : { pre: null, text: q.trim(), rest: q };
}

// Instant results from what the app already has, while the deeper search runs.
function localHits(entities: Entity[], q: string): Hit[] {
  const { pre, text } = parse(q);
  const f = pre ? PREFIX[pre] : null;
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  return entities
    .filter((e) => e.kind !== 'error' && !(e.kind === 'output' && !(e.preview || '').trim()) && (f ? (!f.sources || f.sources.includes(e.source)) && (!f.kinds || f.kinds.includes(e.kind)) : e.kind !== 'project'))
    .filter((e) => { const h = `${e.title} ${e.preview || ''}`.toLowerCase(); return terms.every((t) => h.includes(t)); })
    .filter((e) => terms.length || !e.meta?.noise)
    .sort((a, b) => {
      const at = terms.every((t) => a.title.toLowerCase().includes(t)) ? 1 : 0, bt = terms.every((t) => b.title.toLowerCase().includes(t)) ? 1 : 0;
      return (bt - at) || (b.updatedAt - a.updatedAt);
    })
    .slice(0, 40)
    .map((e) => ({ id: e.id, title: e.title, source: e.source, kind: e.kind, snippet: e.preview, updatedAt: e.updatedAt }));
}

function viewportCentre() {
  let vp = { x: 40, y: 76, zoom: 0.78 };
  try { vp = { ...vp, ...JSON.parse(localStorage.getItem('sb.viewport') || '{}') }; } catch {}
  return { x: (window.innerWidth / 2 - vp.x) / vp.zoom, y: (window.innerHeight / 2 - vp.y) / vp.zoom };
}

// Puts a card back on the board (or on it for the first time) near the middle of the screen.
export async function placeOnBoard(id: string) {
  const s = useStore.getState();
  const row = s.board.find((r) => r.id === id);
  if (row && !row.hidden) return false;
  const c = viewportCentre();
  const spot = freeSpot(s.board, c.x - 130, c.y - 55);
  const next: BoardRow = { id, x: spot.x, y: spot.y, parent_id: null, data: row?.data || {}, hidden: 0 };
  await api.saveBoard([next]);
  await s.refreshBoard();
  return true;
}

// The nearest empty spot to (x, y), searching outwards in card-sized steps, so a card that comes
// back never lands on top of another one.
function freeSpot(board: BoardRow[], x: number, y: number) {
  const W = 260, H = 120, GAP = 20;
  const byId = new Map(board.map((r) => [r.id, r]));
  const rects = board.filter((r) => !r.hidden).map((r) => {
    const p = r.parent_id ? byId.get(r.parent_id) : null;
    const ax = r.x + (p ? p.x : 0), ay = r.y + (p ? p.y : 0);
    return { x: ax, y: ay, w: r.w || (r.id.startsWith('grp:') ? 0 : W), h: r.h || (r.id.startsWith('grp:') ? 0 : H) };
  }).filter((q) => q.w && q.h);
  const free = (px: number, py: number) => rects.every((q) => px + W + GAP <= q.x || px >= q.x + q.w + GAP || py + H + GAP <= q.y || py >= q.y + q.h + GAP);
  for (let ring = 0; ring < 12; ring++) {
    for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
      const px = x + dx * (W + GAP), py = y + dy * (H + GAP);
      if (free(px, py)) return { x: px, y: py };
    }
  }
  return { x, y };
}

const centre = (id: string) => setTimeout(() => (window as any).__sbCenter?.(id), 200);

// ⌘K (or ⌥Space): search everything, then open it, put it on the board, or tag it as context.
export default function Palette() {
  const { paletteOpen, set, entities, byId, board, accounts, pins, open, notify } = useStore();
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const [remote, setRemote] = useState<{ q: string; hits: Hit[] } | null>(null);
  const seq = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (paletteOpen) { setQ(''); setI(0); setRemote(null); } }, [paletteOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'Space') { e.preventDefault(); set({ paletteOpen: !useStore.getState().paletteOpen }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!paletteOpen) return;
    const n = ++seq.current;
    const t = setTimeout(() => {
      api.call<Hit[]>('search:query', q, { limit: 40 }).then((hits) => { if (n === seq.current && Array.isArray(hits)) setRemote({ q, hits }); }).catch(() => {});
    }, q ? 110 : 0);
    return () => clearTimeout(t);
  }, [q, paletteOpen]);

  const { pre, text, rest } = parse(q);
  const commands: Cmd[] = [
    { id: 'import', label: 'Import chats', icon: Download, run: async () => { useImport.getState().set(true); } },
    { id: 'examples', label: 'Add example board', icon: Shapes, run: async () => {
      try {
        const r = await api.call<{ frameId: string }>('examples:add');
        set({ view: 'board', settingsTab: null });
        await (window as any).__sbRefresh?.();
        if (r?.frameId) centre(r.frameId);
        notify('Example board added');
      } catch (err: any) { notify(err?.message || 'Could not add the examples'); }
    } },
    { id: 'note', label: 'New note', icon: StickyNote, run: async () => { const id = await api.saveNote({ text: '' }); await placeOnBoard(id); await useStore.getState().refresh(true); centre(id); } },
    { id: 'settings', label: 'Open settings', icon: Settings, keys: '⌘,', run: () => set({ settingsTab: 'accounts' }) },
    { id: 'chief', label: 'Ask across all agents', icon: Sparkles, keys: '⌘J', run: () => set({ chiefOpen: true, chiefMin: false }) },
    { id: 'outputs', label: 'Outputs', icon: Inbox, run: () => set({ outputsOpen: true }) },
    ...((window as any).__sbRegroup ? [{ id: 'smart', label: 'Smart group', icon: LayoutGrid, run: () => (window as any).__sbRegroup() }] : []),
    { id: 'accounts', label: 'Accounts', icon: Settings, run: () => set({ settingsTab: 'accounts' }) },
    { id: 'clients', label: 'Clients', icon: Users, run: () => set({ settingsTab: 'clients' }) },
    { id: 'brain', label: 'Shared brain', icon: BookOpen, run: () => set({ settingsTab: 'brain' }) },
    { id: 'tour', label: 'Take the tour', icon: Compass, run: () => useTour.getState().start() },
    { id: 'recap', label: 'Daily recap', icon: Sun, run: async () => {
      notify('Writing your recap…');
      try {
        const text = await api.call<string>('proactive:recap');
        if (!text?.trim()) { notify('Nothing to recap yet'); return; }
        await api.saveOutput({ title: `Daily recap · ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`, content: text });
        await useStore.getState().refresh(true);
        set({ outputsOpen: true });
      } catch (err: any) { notify(err?.message || 'Recap failed'); }
    } },
  ];
  const STARTERS = ['examples', 'note', 'smart', 'recap', 'settings', 'tour'];

  const rows = useMemo<Row[]>(() => {
    const local = localHits(entities, q);
    const fresh = remote && remote.q === q ? remote.hits : [];
    const seen = new Set(fresh.map((h) => h.id));
    const hits = [...fresh, ...local.filter((h) => !seen.has(h.id))].slice(0, 40);
    const order: string[] = [];
    const groups: Record<string, Hit[]> = {};
    for (const h of hits) { const g = GROUP[h.source] || 'Other'; if (!groups[g]) { groups[g] = []; order.push(g); } groups[g].push(h); }
    const out: Row[] = order.flatMap((g) => groups[g].map((hit) => ({ type: 'hit' as const, hit })));
    const ql = text.toLowerCase();
    if (!pre && ql) for (const cmd of commands) if (cmd.label.toLowerCase().includes(ql)) out.push({ type: 'cmd', cmd });
    if (!q) return [...STARTERS.map((id) => commands.find((c) => c.id === id)).filter((c): c is Cmd => !!c).map((cmd) => ({ type: 'cmd' as const, cmd })), ...out];
    return out;
  }, [q, remote, entities]);

  useEffect(() => { if (i >= rows.length) setI(Math.max(0, rows.length - 1)); }, [rows.length]);
  useEffect(() => { list.current?.querySelector('.item.on')?.scrollIntoView({ block: 'nearest' }); }, [i]);

  if (!paletteOpen) return null;
  const close = () => set({ paletteOpen: false });
  const onBoard = (id: string) => { const r = board.find((b) => b.id === id); return !!r && !r.hidden; };
  // Scratch sessions and project folders never render on the board, so they only open.
  const boardable = (id: string) => !byId[id] || !suppressed(byId[id]);

  const openHit = async (h: Hit) => {
    close();
    if (boardable(h.id) && await placeOnBoard(h.id)) notify('Added to the board');
    set({ view: 'board', settingsTab: null }); open(h.id);
    centre(h.id);
  };
  const addHit = async (h: Hit) => {
    if (!boardable(h.id)) return openHit(h);
    close();
    notify(await placeOnBoard(h.id) ? 'Added to the board' : 'Already on the board');
    set({ view: 'board', settingsTab: null });
    centre(h.id);
  };
  const tagHit = (h: Hit) => {
    const on = pins.includes(h.id);
    set({ pins: on ? pins.filter((p) => p !== h.id) : [...pins, h.id] });
    notify(on ? 'Removed from context' : 'Tagged as context');
  };
  const choose = async (k: number, how: 'open' | 'add' | 'tag' = 'open') => {
    const r = rows[k]; if (!r) return;
    if (r.type === 'cmd') { if (how === 'open') { close(); await r.cmd.run(); } return; }
    if (how === 'tag') tagHit(r.hit); else if (how === 'add') await addHit(r.hit); else await openHit(r.hit);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(i, mod ? 'add' : 'open'); }
    else if (mod && e.key.toLowerCase() === 't') { e.preventDefault(); choose(i, 'tag'); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };

  const present = new Set(entities.map((e) => e.source));
  let lastGroup = '';
  return (
    <div className="overlay pn-overlay" onClick={close}>
      <div className="palette pn" onClick={(e) => e.stopPropagation()}>
        <div className="pn-q">
          {pre ? <span className="pn-pre"><AgentLogo source={PREFIX[pre].source} size={12} />{PREFIX[pre].label}</span> : <Search size={16} className="pn-q-ic" />}
          <input ref={input} autoFocus value={rest} placeholder={pre ? 'Search…' : 'Search everything'}
            onChange={(e) => { setQ(pre ? `${pre} ${e.target.value}` : e.target.value); setI(0); }}
            onKeyDown={(e) => { if (pre && !rest && e.key === 'Backspace') { e.preventDefault(); setQ(''); return; } onKey(e); }} />
        </div>
        {!q && (
          <div className="pn-chips">
            {CHIPS.filter((c) => present.has(PREFIX[c].source)).map((c) => (
              <button key={c} onMouseDown={(e) => e.preventDefault()} onClick={() => { setQ(`${c} `); setI(0); input.current?.focus(); }}><AgentLogo source={PREFIX[c].source} size={12} />{PREFIX[c].label}</button>
            ))}
          </div>
        )}
        <div className="list" ref={list}>
          {rows.length === 0 && <div className="pn-none">No matches</div>}
          {rows.map((r, k) => {
            const g = r.type === 'cmd' ? 'Commands' : GROUP[r.hit.source] || 'Other';
            const sec = g !== lastGroup ? <div className="sec" key={`sec:${g}`}>{g}</div> : null;
            lastGroup = g;
            if (r.type === 'cmd') {
              return (
                <React.Fragment key={r.cmd.id}>
                  {sec}
                  <div className={`item cmd ${k === i ? 'on' : ''}`} onMouseMove={() => k !== i && setI(k)} onClick={() => choose(k)}>
                    <r.cmd.icon size={14} /><span className="t">{r.cmd.label}</span><span className="s">{r.cmd.keys || ''}</span>
                  </div>
                </React.Fragment>
              );
            }
            const h = r.hit; const e = byId[h.id];
            const acc = e?.accountId ? accounts.find((a) => a.id === e.accountId) : undefined;
            const tagged = pins.includes(h.id);
            return (
              <React.Fragment key={h.id}>
                {sec}
                <div className={`item ${k === i ? 'on' : ''}`} onMouseMove={() => k !== i && setI(k)} onClick={() => choose(k)}>
                  <AgentLogo source={h.source} size={14} color={acc?.color || SOURCE[h.source]?.color} working={e?.status === 'running'} />
                  <span className="pn-main">
                    <span className="t">{h.title}</span>
                    {k === i && h.snippet && h.snippet !== h.title && <span className="pn-snip">{h.snippet}</span>}
                  </span>
                  <span className="s">
                    {tagged && <Check size={11} className="pn-tagged" />}
                    {[acc?.label, ago(h.updatedAt)].filter(Boolean).join(' · ')}{onBoard(h.id) || !boardable(h.id) ? '' : ' · not on board'}
                  </span>
                  {k === i && (
                    <span className="pn-acts" onClick={(ev) => ev.stopPropagation()}>
                      <button onClick={() => choose(k, 'tag')} title={tagged ? 'Remove from context (⌘T)' : 'Tag as context (⌘T)'} className={tagged ? 'on' : ''}><Tag size={12} /></button>
                      <button onClick={() => choose(k, 'add')} title="Add to board (⌘↵)"><Plus size={13} /></button>
                    </span>
                  )}
                </div>
              </React.Fragment>
            );
          })}
          {!q && <div className="pn-tip">Tip: ⌥Space opens this from anywhere in the app</div>}
        </div>
        <div className="pn-foot">
          {pins.length > 0 ? (
            <span className="pn-pins">
              <Tag size={11} />{pins.length} tagged
              <button onClick={() => set({ pins: [] })} title="Clear tags"><X size={11} /></button>
            </span>
          ) : <span />}
          <span className="pn-keys"><kbd>↵</kbd> open · <kbd>⌘↵</kbd> add to board · <kbd>⌘T</kbd> tag</span>
        </div>
      </div>
    </div>
  );
}
