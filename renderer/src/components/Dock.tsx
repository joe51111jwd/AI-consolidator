import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, ArrowUp, StickyNote, X } from 'lucide-react';
import { useStore } from '../lib/store';
import { api, Account } from '../lib/api';
import { AgentLogo } from './Logos';
import { useUsage, weeklyPct } from './UsagePill';
import './shell.css';

const AUTO = 'auto';

function placeholder(a: Account, auto: boolean) {
  if (a.kind === 'grok-bot') return 'Hand something to Grok Bot';
  if (auto) return `New session · ${a.label}`;
  return `New session on ${a.label}`;
}

// Bottom-center quick start: pick an account bubble, type, Enter.
export default function Dock() {
  const accounts = useStore((s) => s.accounts);
  const entities = useStore((s) => s.entities);
  const byId = useStore((s) => s.byId);
  const live = useStore((s) => s.liveByEntity);
  const pins = useStore((s) => s.pins);
  const { set, notify } = useStore();
  const { rows, budgets } = useUsage();
  const [pick, setPick] = useState<string | null>(null);
  const [text, setText] = useState('');
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const claude = accounts.filter((a) => a.kind === 'claude-code');
  const others = accounts.filter((a) => a.kind === 'grok-bot' || a.kind === 'codex');
  const bubbles = [...claude, ...others];

  const busy = useMemo(() => {
    const s = new Set<string>();
    for (const e of entities) if (e.status === 'running' && e.accountId) s.add(e.accountId);
    for (const [id, r] of Object.entries(live)) {
      if (r.status !== 'running') continue;
      const acc = id.startsWith('ac:') ? id.slice(3) : byId[id]?.accountId;
      if (acc) s.add(acc);
    }
    return s;
  }, [entities, live, byId]);

  const least = useMemo(() => {
    if (!claude.length) return null;
    const ready = claude.filter((a) => a.config?.auth?.loggedIn !== false);
    const scored = (ready.length ? ready : claude).map((a) => {
      const r = rows.find((x) => x.id === a.id);
      return { a, p: r ? weeklyPct(r, accounts, budgets) : 0 };
    });
    return scored.sort((x, y) => x.p - y.p)[0].a;
  }, [accounts, rows, budgets]);

  const target = pick === AUTO ? least : accounts.find((a) => a.id === pick) || null;

  useEffect(() => {
    if (!pick) return;
    requestAnimationFrame(() => input.current?.focus());
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setPick(null); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [pick]);
  useEffect(() => { if (pick && pick !== AUTO && !accounts.some((a) => a.id === pick)) setPick(null); }, [accounts]);

  const choose = (id: string) => setPick(pick === id ? null : id);
  const send = async () => {
    const t = text.trim();
    if (!t || !target) return;
    const attach = pins.map((id) => ({ id, title: byId[id]?.title }));
    setText(''); setPick(null);
    try {
      await api.prompt(`ac:${target.id}`, t, attach.length ? { attach } : {});
      if (attach.length) set({ pins: [] });
      notify(target.kind === 'grok-bot' ? 'Copied for Grok Bot' : `Started on ${target.label}`);
    } catch (e: any) { notify(e.message); }
  };
  const addNote = async () => {
    await api.saveNote({ text: '' });
    await useStore.getState().refresh(true); await useStore.getState().refreshBoard();
    notify('Note added');
  };

  return (
    <div ref={wrap} className={`dock ${target ? 'open' : ''}`} data-testid="dock">
      {bubbles.map((a) => {
        const auth = a.config?.auth;
        const off = a.kind === 'claude-code' && auth && auth.loggedIn === false;
        return (
          <button key={a.id} className={`dock-b ${pick === a.id ? 'on' : ''} ${off ? 'off' : ''}`} style={{ '--ring': a.color } as React.CSSProperties}
            data-tip={off ? `${a.label} · not signed in` : a.label} aria-label={a.label} data-testid={`dock-${a.id}`} onClick={() => choose(a.id)}>
            <AgentLogo source={a.kind} size={18} color={a.kind === 'claude-code' ? undefined : '#18181B'} working={busy.has(a.id)} />
            {off && <i className="warn" />}
          </button>
        );
      })}
      {least ? (
        <button className={`dock-b add ${pick === AUTO ? 'on' : ''}`} data-tip={`New session · ${least.label}`} aria-label="New session" data-testid="dock-new" onClick={() => choose(AUTO)}>
          <Plus size={18} strokeWidth={2.2} />
        </button>
      ) : (
        <button className="dock-b add" data-tip="Add a Claude account" aria-label="Add a Claude account" onClick={() => set({ settingsTab: 'accounts' })}>
          <Plus size={18} strokeWidth={2.2} />
        </button>
      )}
      <div className="dock-in" aria-hidden={!target}>
        {pins.length > 0 && (
          <button className="chip" title="Clear tagged context" onClick={() => set({ pins: [] })}>{pins.length} tagged<X size={11} /></button>
        )}
        <input ref={input} value={text} data-testid="dock-input" tabIndex={target ? 0 : -1}
          placeholder={target ? placeholder(target, pick === AUTO) : ''}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (!e.metaKey && !e.ctrlKey) e.stopPropagation(); if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } if (e.key === 'Escape') setPick(null); }} />
        <button className="send" disabled={!text.trim()} onClick={send} title="Start (Enter)" tabIndex={target ? 0 : -1}><ArrowUp size={15} /></button>
      </div>
      {!target && <span className="dock-sep" />}
      {!target && (
        <button className="dock-b ghost" data-tip="Note" aria-label="Add a note" onClick={addNote}><StickyNote size={16} /></button>
      )}
    </div>
  );
}
