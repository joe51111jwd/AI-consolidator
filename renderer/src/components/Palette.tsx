import React, { useEffect, useMemo, useState } from 'react';
import { Search, Plus, StickyNote, UserPlus, LayoutGrid, Sparkles, Eye } from 'lucide-react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import { SOURCE, ago } from '../lib/format';

// ⌘K: find any card (including ones not on the board), or run a command.
export default function Palette() {
  const { paletteOpen, set, entities, board, open, notify } = useStore();
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  useEffect(() => { if (paletteOpen) { setQ(''); setI(0); } }, [paletteOpen]);

  const commands = [
    { id: 'note', label: 'New note', icon: StickyNote, run: async () => { const id = await api.saveNote({ text: '' }); await useStore.getState().refresh(true); } },
    { id: 'client', label: 'New client', icon: UserPlus, run: () => set({ view: 'clients' }) },
    { id: 'chief', label: 'Ask the overall agent', icon: Sparkles, run: () => set({ chiefOpen: true }) },
    { id: 'g-project', label: 'Group board by project', icon: LayoutGrid, run: () => (window as any).__sbRegroup?.('project') },
    { id: 'g-source', label: 'Group board by account', icon: LayoutGrid, run: () => (window as any).__sbRegroup?.('source') },
    { id: 'g-client', label: 'Group board by client', icon: LayoutGrid, run: () => (window as any).__sbRegroup?.('client') },
  ];
  const ql = q.toLowerCase();
  const items = useMemo(() => {
    const ents = entities.filter((e) => e.kind !== 'error' && (!ql || e.title.toLowerCase().includes(ql) || (e.preview || '').toLowerCase().includes(ql))).slice(0, 40);
    const cmds = commands.filter((c) => !ql || c.label.toLowerCase().includes(ql));
    return [...cmds.map((c) => ({ type: 'cmd' as const, c })), ...ents.map((e) => ({ type: 'ent' as const, e }))];
  }, [ql, entities]);

  if (!paletteOpen) return null;
  const choose = async (k: number) => {
    const it = items[k]; if (!it) return;
    set({ paletteOpen: false });
    if (it.type === 'cmd') { await it.c.run(); return; }
    const row = board.find((r) => r.id === it.e.id);
    if (!row || row.hidden) {
      await api.saveBoard([{ id: it.e.id, x: (row?.x ?? 0), y: (row?.y ?? -400), parent_id: null, data: {}, hidden: 0 }]);
      await useStore.getState().refreshBoard();
      notify('Added to the board');
    }
    set({ view: 'board' }); open(it.e.id);
  };
  return (
    <div className="overlay" onClick={() => set({ paletteOpen: false })}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input autoFocus value={q} placeholder="Search agents, chats, projects, clients…" onChange={(e) => { setQ(e.target.value); setI(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, items.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
            if (e.key === 'Enter') choose(i);
            if (e.key === 'Escape') set({ paletteOpen: false });
          }} />
        <div className="list">
          {items.map((it, k) => it.type === 'cmd' ? (
            <div key={it.c.id} className={`item ${k === i ? 'on' : ''}`} onMouseEnter={() => setI(k)} onClick={() => choose(k)}>
              <it.c.icon size={15} /><span className="t">{it.c.label}</span><span className="s">Command</span>
            </div>
          ) : (
            <div key={it.e.id} className={`item ${k === i ? 'on' : ''}`} onMouseEnter={() => setI(k)} onClick={() => choose(k)}>
              <i style={{ width: 8, height: 8, borderRadius: '50%', background: SOURCE[it.e.source]?.color || '#999', justifySelf: 'center' }} />
              <span className="t">{it.e.title}</span>
              <span className="s">{(SOURCE[it.e.source]?.label || it.e.source)} · {ago(it.e.updatedAt)}{(() => { const r = board.find((b) => b.id === it.e.id); return !r || r.hidden ? ' · not on board' : ''; })()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
