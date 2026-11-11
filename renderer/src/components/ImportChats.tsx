import React, { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Check, Plus, Search, X } from 'lucide-react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { ago } from '../lib/format';
import { ClaudeLogo } from './Logos';
import { placeOnBoard } from './Palette';
import './import.css';

export const useImport = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));

interface Item { id: string; title: string; accountLabel: string; cwd: string | null; updatedAt: number; preview: string; messages: number }

// Pick past chats from every Claude account (any age) and put them on the board.
export default function ImportChats() {
  const { open, set } = useImport();
  const notify = useStore((s) => s.notify);
  const onBoard = useStore((s) => s.board);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState<Record<string, boolean>>({});
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const t = setTimeout(() => {
      api.call<{ items: Item[] }>('history:list', { q, limit: 60 })
        .then((r) => setItems(r.items || [])).catch(() => setItems([])).finally(() => setLoading(false));
    }, q ? 220 : 0);
    return () => clearTimeout(t);
  }, [open, q]);
  useEffect(() => { if (open) setTimeout(() => field.current?.focus(), 30); else { setQ(''); setAdded({}); } }, [open]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') set(false); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open]);
  if (!open) return null;

  const visible = new Set(onBoard.filter((r) => !r.hidden).map((r) => r.id));
  const add = async (it: Item) => {
    try {
      await api.call('history:import', it.id);
      await useStore.getState().refresh(true);
      await placeOnBoard(it.id);
      setAdded((a) => ({ ...a, [it.id]: true }));
      notify(`Added "${it.title}" to the board`);
    } catch (e: any) { notify(e.message || 'Could not add that chat'); }
  };

  return (
    <div className="imp-back" onMouseDown={() => set(false)}>
      <div className="imp" role="dialog" aria-label="Import chats" data-testid="import-chats" onMouseDown={(e) => e.stopPropagation()}>
        <div className="imp-head">
          <b>Import chats</b><span>Every Claude chat on this Mac, any age</span>
          <button className="imp-x" onClick={() => set(false)} aria-label="Close"><X size={15} /></button>
        </div>
        <label className="imp-search">
          <Search size={14} />
          <input ref={field} value={q} placeholder="Search titles, folders, messages" data-testid="import-search"
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </label>
        <div className="imp-list">
          {loading && !items.length && <div className="imp-empty">Looking…</div>}
          {!loading && !items.length && <div className="imp-empty">{q ? 'No chats match.' : 'No past chats found.'}</div>}
          {items.map((it) => {
            const done = added[it.id] || visible.has(it.id);
            return (
              <div key={it.id} className="imp-row" data-testid="import-row" data-id={it.id}>
                <ClaudeLogo size={14} />
                <div className="imp-main">
                  <div className="imp-title">{it.title}</div>
                  <div className="imp-meta">{[it.accountLabel, it.cwd ? it.cwd.split('/').pop() : null, ago(it.updatedAt)].filter(Boolean).join(' · ')}</div>
                </div>
                <button className={`imp-add ${done ? 'done' : ''}`} disabled={done} onClick={() => add(it)} data-testid="import-add">
                  {done ? <><Check size={13} />On board</> : <><Plus size={13} />Add</>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
