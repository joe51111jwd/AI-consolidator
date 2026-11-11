import React, { useEffect, useRef, useState } from 'react';
import { Funnel, Sparkles, Check, ChevronDown, Plus, Save, X, Loader2 } from 'lucide-react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import { AgentLogo } from './Logos';
import { SOURCE } from '../lib/format';
import { srcKey } from '../lib/layout';

const KINDS: [string, string][] = [['coding', 'Coding sessions'], ['chat', 'Chats'], ['mail', 'Mail'], ['meetings', 'Meetings'], ['notes', 'Notes & outputs']];
const AGENTS = ['claude-code', 'grok-bot', 'cursor', 'codex', 'openai-compatible'];

function Row({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon?: React.ReactNode; label: string }) {
  return (
    <button className={`bt-row ${on ? 'on' : ''}`} onClick={onClick}>
      {icon}<span className="bt-label">{label}</span><span className="bt-check">{on && <Check size={11} strokeWidth={3} />}</span>
    </button>
  );
}

function FilterPanel({ off, toggle, reset, onClose }: { off: string[]; toggle: (k: string) => void; reset: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const accounts = useStore((s) => s.accounts);
  const kinds = new Set(accounts.map((a) => srcKey(a.kind)));
  const sources = AGENTS.filter((k) => kinds.has(k) || (k === 'claude-code' && !kinds.size));
  useEffect(() => {
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.bt-filter')) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [onClose]);
  return (
    <div className="bt-panel" ref={ref}>
      <div className="bt-h">Show</div>
      {KINDS.map(([k, label]) => <Row key={k} on={!off.includes(k)} onClick={() => toggle(k)} label={label} />)}
      {sources.length > 0 && <div className="bt-h">Agents</div>}
      {sources.map((k) => (
        <Row key={k} on={!off.includes('src:' + k)} onClick={() => toggle('src:' + k)} label={SOURCE[k]?.label || k}
          icon={<AgentLogo source={k} size={13} color={SOURCE[k]?.color} />} />
      ))}
      {off.length > 0 && <button className="bt-reset" onClick={reset}>Show everything</button>}
    </div>
  );
}

type Saved = { id: string; name: string; ts: number; cards: number };

function useAway(ref: React.RefObject<HTMLDivElement | null>, onClose: () => void, keep: string) {
  useEffect(() => {
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest(keep)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [onClose]);
}

// Saved boards: snapshot the layout under a name, switch between them, or start blank.
function BoardSwitcher() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Saved[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const notify = useStore((s) => s.notify);
  const load = () => api.call<{ boards: Saved[]; current: string | null }>('boards:list').then((r) => { setList(r?.boards || []); setCurrent(r?.current || null); }).catch(() => {});
  useEffect(() => { load(); }, []);
  useAway(ref, () => { setOpen(false); setNaming(false); }, '.bt-boards');
  const after = async (msg: string) => { await load(); const s = useStore.getState(); await s.refreshBoard(); await s.refresh(true); notify(msg); setOpen(false); setNaming(false); };
  const save = async () => { const n = name.trim(); if (!n) return; await api.call('boards:save', n); await after(`Saved “${n}”`); setName(''); };
  return (
    <div className="bt-wrap">
      <button className="bt-btn bt-boards" onClick={() => { setOpen(!open); if (!open) load(); }} title="Saved boards">
        <span className="bt-board-name">{current || 'Board'}</span><ChevronDown size={13} />
      </button>
      {open && (
        <div className="bt-panel bt-board-panel" ref={ref}>
          {naming ? (
            <form className="bt-name" onSubmit={(e) => { e.preventDefault(); save(); }}>
              <input autoFocus value={name} placeholder="Board name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              <button type="submit" className="bt-mini" disabled={!name.trim()}>Save</button>
            </form>
          ) : (
            <button className="bt-row" onClick={() => { setName(current || ''); setNaming(true); }}><Save size={13} /><span className="bt-label">Save board as…</span></button>
          )}
          <button className="bt-row" onClick={async () => { await api.call('boards:blank'); await after('New blank board. Your last one is in Autosave.'); }}><Plus size={13} /><span className="bt-label">New blank board</span></button>
          {list.length > 0 && <div className="bt-h">Saved</div>}
          {list.map((b) => (
            <div key={b.id} className={`bt-row bt-saved ${b.name === current ? 'on' : ''}`} onClick={async () => { await api.call('boards:load', b.id); await after(`Loaded “${b.name}”`); }}>
              <span className="bt-label">{b.name}</span><span className="bt-count">{b.cards}</span>
              <button className="bt-del" title="Delete saved board" onClick={async (e) => { e.stopPropagation(); setList(await api.call('boards:delete', b.id)); }}><X size={11} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Floating board controls under the shell's top-right cluster: filter and AI grouping.
export default function BoardTools({ busy, onSmart, off, setOff }: { busy: boolean; onSmart: () => void; off: string[]; setOff: (o: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const toggle = (k: string) => setOff(off.includes(k) ? off.filter((x) => x !== k) : [...off, k]);
  return (
    <div className="board-tools" onClick={(e) => e.stopPropagation()}>
      <BoardSwitcher />
      <div className="bt-wrap">
        <button className={`bt-btn bt-filter ${off.length ? 'active' : ''}`} title="Filter the board" onClick={() => setOpen(!open)}>
          <Funnel size={14} />{off.length > 0 && <i className="bt-dot" />}
        </button>
        {open && <FilterPanel off={off} toggle={toggle} reset={() => setOff([])} onClose={() => setOpen(false)} />}
      </div>
      <button className={`bt-btn bt-smart ${busy ? 'busy' : ''}`} onClick={onSmart} disabled={busy} title="Let AI sort the board into groups">
        {busy ? <Loader2 size={14} className="bt-spin" /> : <Sparkles size={14} />}<span>{busy ? 'Grouping…' : 'Smart group'}</span>
      </button>
    </div>
  );
}
