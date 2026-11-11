import React, { useEffect, useRef, useState } from 'react';
import { Funnel, Sparkles, Check } from 'lucide-react';
import { useStore } from '../lib/store';
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

// Floating board controls under the shell's top-right cluster: filter and AI grouping.
export default function BoardTools({ busy, onSmart, off, setOff }: { busy: boolean; onSmart: () => void; off: string[]; setOff: (o: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const toggle = (k: string) => setOff(off.includes(k) ? off.filter((x) => x !== k) : [...off, k]);
  return (
    <div className="board-tools" onClick={(e) => e.stopPropagation()}>
      <div className="bt-wrap">
        <button className={`bt-btn bt-filter ${off.length ? 'active' : ''}`} title="Filter the board" onClick={() => setOpen(!open)}>
          <Funnel size={14} />{off.length > 0 && <i className="bt-dot" />}
        </button>
        {open && <FilterPanel off={off} toggle={toggle} reset={() => setOff([])} onClose={() => setOpen(false)} />}
      </div>
      <button className={`bt-btn bt-smart ${busy ? 'busy' : ''}`} onClick={onSmart} disabled={busy} title="Let AI sort the board into groups">
        <Sparkles size={14} /><span>{busy ? 'Grouping…' : 'Smart group'}</span>
      </button>
    </div>
  );
}
