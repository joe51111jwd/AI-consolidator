import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, ArrowUp, X } from 'lucide-react';
import { useStore } from '../lib/store';
import { api, Account, Entity } from '../lib/api';
import { AgentLogo } from './Logos';
import { useUsage, weeklyPct } from './UsagePill';
import './shell.css';

const AUTO = 'auto';

function placeholder(a: Account, auto: boolean) {
  if (a.kind === 'grok-bot') return 'Hand something to Grok Bot';
  if (auto) return `New session · ${a.label}`;
  return `New session on ${a.label}`;
}

function oneLine(s?: string, n = 70) {
  const t = (s || '').replace(/[#*`_>|[\]]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? '…' + t.slice(-n) : t;
}

// Bottom-center: account bubbles (click to start a chat, hover to see what they are working on)
// and the "+" that opens the overall agent.
export default function Dock() {
  const accounts = useStore((s) => s.accounts);
  const entities = useStore((s) => s.entities);
  const byId = useStore((s) => s.byId);
  const live = useStore((s) => s.liveByEntity);
  const pins = useStore((s) => s.pins);
  const chiefOpen = useStore((s) => s.chiefOpen);
  const chiefRunning = useStore((s) => s.liveByEntity['chief']?.status === 'running');
  const { set, notify } = useStore();
  const { rows, budgets } = useUsage();
  const [pick, setPick] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [text, setText] = useState('');
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const hoverT = useRef<any>(null);

  const claude = accounts.filter((a) => a.kind === 'claude-code');
  const others = accounts.filter((a) => a.kind === 'grok-bot' || a.kind === 'codex');
  const bubbles = [...claude, ...others];

  const sessionsBy = useMemo(() => {
    const m: Record<string, Entity[]> = {};
    const runningIds = new Set(Object.entries(live).filter(([, r]) => r.status === 'running').map(([id]) => id));
    for (const e of entities) {
      if (e.kind !== 'session' || !e.accountId) continue;
      (m[e.accountId] ||= []).push(e);
    }
    const isRun = (e: Entity) => e.status === 'running' || runningIds.has(e.id);
    for (const k of Object.keys(m)) {
      m[k] = m[k].sort((x, y) => Number(isRun(y)) - Number(isRun(x)) || y.updatedAt - x.updatedAt).slice(0, 6);
    }
    return m;
  }, [entities, live]);

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

  const pct = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of accounts) { const r = rows.find((x) => x.id === a.id); if (r) m[a.id] = Math.round(weeklyPct(r, accounts, budgets)); }
    return m;
  }, [accounts, rows, budgets]);

  const least = useMemo(() => {
    if (!claude.length) return null;
    const ready = claude.filter((a) => a.config?.auth?.loggedIn !== false);
    return [...(ready.length ? ready : claude)].sort((x, y) => (pct[x.id] || 0) - (pct[y.id] || 0))[0];
  }, [accounts, pct]);

  const target = pick === AUTO ? least : accounts.find((a) => a.id === pick) || null;

  useEffect(() => { if (pick) requestAnimationFrame(() => input.current?.focus()); }, [pick]);
  useEffect(() => {
    if (!pick) return;
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setPick(null); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [pick]);
  useEffect(() => { if (pick && pick !== AUTO && !accounts.some((a) => a.id === pick)) setPick(null); }, [accounts]);
  useEffect(() => {
    const on = (e: Event) => setPick(String((e as CustomEvent).detail));
    window.addEventListener('sb:dock-pick', on);
    return () => window.removeEventListener('sb:dock-pick', on);
  }, []);
  useEffect(() => () => clearTimeout(hoverT.current), []);

  const enter = (id: string) => { clearTimeout(hoverT.current); setHover(id); };
  const leave = () => { clearTimeout(hoverT.current); hoverT.current = setTimeout(() => setHover(null), 220); };
  const choose = (id: string) => { set({ chiefOpen: false }); setPick(pick === id ? null : id); };
  const label = (a: Account, off: boolean) => off ? `${a.label} · not signed in` : pct[a.id] != null ? `${a.label} · ${pct[a.id]}% this week` : a.label;
  const activity = (e: Entity) => oneLine(e.meta?.activity) || (live[e.id]?.status === 'running' ? oneLine(live[e.id]?.text) : '') || oneLine(e.preview) || '—';
  const send = async () => {
    const t = text.trim();
    if (!t || !target) return;
    const attach = pins.map((id) => ({ id, title: byId[id]?.title }));
    setText(''); setPick(null);
    try {
      await api.prompt(`ac:${target.id}`, t, attach.length ? { attach } : {});
      if (attach.length) set({ pins: [] });
      notify(target.kind === 'grok-bot' ? 'Sent to Grok Bot' : `Started on ${target.label}`);
    } catch (e: any) { notify(e.message); }
  };
  const openSession = (id: string) => {
    setHover(null); setPick(null);
    useStore.getState().open(id);
    setTimeout(() => (window as any).__sbCenter?.(id), 60);
  };

  return (
    <div ref={wrap} className={`dock ${target ? 'open' : ''}`} data-testid="dock">
      {bubbles.map((a) => {
        const auth = a.config?.auth;
        const off = a.kind === 'claude-code' && auth && auth.loggedIn === false;
        const list = sessionsBy[a.id] || [];
        const working = busy.has(a.id);
        const pop = hover === a.id && !target && (working || list.length > 0);
        return (
          <span key={a.id} className="dock-slot" onMouseEnter={() => enter(a.id)} onMouseLeave={leave}>
            <button className={`dock-b ${pick === a.id ? 'on' : ''} ${off ? 'off' : ''} ${working ? 'busy' : ''}`}
              data-tip={pop ? undefined : label(a, !!off)} aria-label={a.label} data-testid={`dock-${a.id}`} onClick={() => choose(a.id)}>
              <AgentLogo source={a.kind} size={18} working={working} />
              {off && <i className="warn" />}
            </button>
            {pop && (
              <div className="dock-pop" onMouseEnter={() => enter(a.id)} onMouseLeave={leave}>
                <div className="dp-head"><span>{a.label}</span>{pct[a.id] != null && <em>{pct[a.id]}% this week</em>}</div>
                {list.map((e) => {
                  const run = e.status === 'running' || live[e.id]?.status === 'running';
                  return (
                    <button key={e.id} className={`dp-row ${run ? 'run' : ''}`} onClick={() => openSession(e.id)}>
                      <i className="dp-dot" />
                      <span className="dp-txt"><span className="dp-t">{e.title}</span><span className="dp-d">{activity(e)}</span></span>
                    </button>
                  );
                })}
                {working && !list.some((e) => e.status === 'running' || live[e.id]?.status === 'running') && (
                  <div className="dp-row run"><i className="dp-dot" /><span className="dp-txt"><span className="dp-t">New session</span><span className="dp-d">{oneLine(live[`ac:${a.id}`]?.text) || 'Starting…'}</span></span></div>
                )}
              </div>
            )}
          </span>
        );
      })}
      <button className={`dock-b add ${chiefOpen ? 'on' : ''} ${chiefRunning ? 'working' : ''}`} data-tip={chiefOpen ? undefined : 'Agent  ⌘J'} aria-label="Agent" aria-expanded={chiefOpen} data-testid="dock-plus"
        onClick={() => { setPick(null); set({ chiefOpen: !chiefOpen }); }}>
        <Plus size={18} strokeWidth={2.2} />
      </button>
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
    </div>
  );
}
