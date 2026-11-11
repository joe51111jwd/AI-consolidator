import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, ChevronRight, X, GripVertical, Copy, FileOutput, MessageSquarePlus, StickyNote, LayoutTemplate, Compass, Plug } from 'lucide-react';
import { useStore } from '../lib/store';
import { api, Message } from '../lib/api';
import { md } from '../lib/format';
import { AgentLogo } from './Logos';
import { useTour } from './Tour';
import ConnectAgents, { useConnectAgents } from './ConnectAgents';
import NewChat, { openNewChat } from './NewChat';
import './chief.css';

export interface Nudge {
  id: string; kind: 'waiting' | 'reply' | 'followup' | 'idle' | 'tip'; title: string;
  detail?: string; ref?: string; action?: string; tone?: 'error'; ts?: number;
}

const SHOWN = 3;

// The Switchboard agent mark: a hub with three lines out. Orbits while it works.
export function ChiefGlyph({ size = 18, working }: { size?: number; working?: boolean }) {
  const pts: [number, number][] = [[12, 3.5], [19.36, 16.25], [4.64, 16.25]];
  return (
    <svg className={`chief-glyph ${working ? 'on' : ''}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <g className="cg-orbit">
        {pts.map(([x, y]) => <line key={x} x1="12" y1="12" x2={x} y2={y} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />)}
        {pts.map(([x, y]) => <circle key={`c${x}`} cx={x} cy={y} r="2.5" fill="currentColor" />)}
      </g>
      <circle className="cg-core" cx="12" cy="12" r="3.3" fill="currentColor" />
    </svg>
  );
}

function useNudges() {
  const [items, setItems] = useState<Nudge[]>([]);
  useEffect(() => {
    let t: any;
    const load = () => api.call<Nudge[]>('proactive:list').then((r) => setItems(Array.isArray(r) ? r : [])).catch(() => {});
    load();
    const off = api.onEvent((e) => {
      if (e.type === 'proactive') { if (Array.isArray(e.items)) setItems(e.items); else load(); }
      if (e.type === 'entities-changed') { clearTimeout(t); t = setTimeout(load, 3000); }
    });
    return () => { clearTimeout(t); off(); };
  }, []);
  const dismiss = (id: string) => { setItems((xs) => xs.filter((x) => x.id !== id)); api.call('proactive:dismiss', id).catch(() => {}); };
  return { items, dismiss };
}

function NudgeIcon({ n }: { n: Nudge }) {
  const e = useStore((s) => (n.ref ? s.byId[n.ref] : undefined));
  if (e && e.source !== 'crm') return <AgentLogo source={e.source} size={14} />;
  if (n.kind === 'reply') return <AgentLogo source="gmail" size={14} />;
  if (n.ref?.startsWith('gr:')) return <AgentLogo source="granola" size={14} />;
  return <i className={`cf-dot k-${n.tone || n.kind}`} />;
}

function NudgeRow({ n, onAct, onDismiss }: { n: Nudge; onAct: (n: Nudge) => void; onDismiss: (id: string) => void }) {
  return (
    <div className={`cf-item ${n.tone || ''} ${n.kind === 'tip' ? 'tip' : ''}`} role="button" tabIndex={0} onClick={() => onAct(n)} onKeyDown={(e) => { if (e.key === 'Enter') onAct(n); }}>
      <span className="cf-ico"><NudgeIcon n={n} /></span>
      <span className="cf-txt"><span className="cf-t">{n.title}</span>{n.detail && <span className="cf-d">{n.detail}</span>}</span>
      <button className="cf-x" title="Dismiss" onClick={(e) => { e.stopPropagation(); onDismiss(n.id); }}><X size={12} /></button>
    </div>
  );
}

const TIPS_SEEN = 'sb.tipsSeen';
const seenTips = (): string[] => { try { return JSON.parse(localStorage.getItem(TIPS_SEEN) || '[]'); } catch { return []; } };

// Suggestions ("Connect Gmail") are not things that need you: they sit greyed under their own heading,
// open the first time they appear and folded after that.
function Suggestions({ tips, onAct, onDismiss }: { tips: Nudge[]; onAct: (n: Nudge) => void; onDismiss: (id: string) => void }) {
  const [open, setOpen] = useState(() => { const seen = new Set(seenTips()); return tips.some((t) => !seen.has(t.id)); });
  useEffect(() => {
    if (!tips.length) return;
    localStorage.setItem(TIPS_SEEN, JSON.stringify([...new Set([...seenTips(), ...tips.map((t) => t.id)])].slice(-100)));
  }, [tips.map((t) => t.id).join('|')]);
  if (!tips.length) return null;
  return (
    <div className="cf-tips">
      <button className="cf-label" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}Suggestions<span className="cf-count">{tips.length}</span>
      </button>
      {open && tips.map((n) => <NudgeRow key={n.id} n={n} onAct={onAct} onDismiss={onDismiss} />)}
    </div>
  );
}

function Needs({ items, tips, onAct, onDismiss }: { items: Nudge[]; tips: Nudge[]; onAct: (n: Nudge) => void; onDismiss: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (!items.length && !tips.length) return null;
  const shown = hidden ? [] : all ? items : items.slice(0, SHOWN);
  return (
    <div className="cf-needs">
      {items.length > 0 && (
        <button className="cf-label" onClick={() => setHidden(!hidden)} aria-expanded={!hidden}>
          {hidden ? <ChevronRight size={12} /> : <ChevronDown size={12} />}Needs you<span className="cf-count">{items.length}</span>
        </button>
      )}
      {shown.map((n) => <NudgeRow key={n.id} n={n} onAct={onAct} onDismiss={onDismiss} />)}
      {!hidden && items.length > SHOWN && <button className="cf-more" onClick={() => setAll(!all)}>{all ? 'Show less' : `${items.length - SHOWN} more`}</button>}
      <Suggestions tips={tips} onAct={onAct} onDismiss={onDismiss} />
    </div>
  );
}

// One fresh line about the board, shown when the panel opens instead of an old reply.
function StatusLine({ needs }: { needs: number }) {
  const entities = useStore((s) => s.entities);
  const live = useStore((s) => s.liveByEntity);
  const working = useMemo(() => {
    const ids = new Set<string>();
    for (const e of entities) if (e.kind === 'session' && e.status === 'running') ids.add(e.id);
    for (const [id, r] of Object.entries(live)) if (r.status === 'running' && id !== 'chief') ids.add(id);
    return ids.size;
  }, [entities, live]);
  const parts = [working ? `${working} working` : 'Nothing running', needs ? `${needs} need${needs === 1 ? 's' : ''} you` : 'nothing needs you'];
  return <div className="cf-status" data-testid="chief-status"><ChiefGlyph size={14} working={working > 0} /><span>{parts.join(' · ')}</span></div>;
}

function ChiefMsg({ m }: { m: Message }) {
  const notify = useStore((s) => s.notify);
  const [full, setFull] = useState(false);
  if (m.role === 'user') return <div className="msg user"><div className={`body ${full ? '' : 'clamp'}`} onClick={() => setFull(!full)}>{m.text}</div></div>;
  const drag = (ev: React.DragEvent) => {
    ev.dataTransfer.setData('application/x-sb', JSON.stringify({ text: m.text, title: 'From the overall agent', sourceId: 'chief' }));
    ev.dataTransfer.setData('text/plain', m.text);
    ev.dataTransfer.effectAllowed = 'copy';
  };
  const save = async () => {
    await api.saveOutput({ title: 'From the overall agent', content: m.text, source: 'chief' });
    await useStore.getState().refresh(true); notify('Saved as an output');
  };
  return (
    <div className="msg assistant">
      <div className="body md" dangerouslySetInnerHTML={{ __html: md(m.text) }} />
      <div className="tools">
        <button draggable onDragStart={drag} title="Drag onto a card"><GripVertical size={13} /></button>
        <button onClick={() => { api.copy(m.text); notify('Copied'); }} title="Copy"><Copy size={13} /></button>
        <button onClick={save} title="Save as output"><FileOutput size={13} /></button>
      </div>
    </div>
  );
}

function reloadAll() {
  const st = useStore.getState();
  return st.refresh(true).then(() => st.refreshBoard());
}

// Quick actions across the top of the agent panel.
function Actions({ onDone }: { onDone: () => void }) {
  const notify = useStore((s) => s.notify);
  const run = (label: string, fn: () => Promise<any>) => async () => {
    try { await fn(); await reloadAll(); notify(label); } catch (e: any) { notify(e.message || 'Something went wrong'); }
  };
  return (
    <div className="cf-actions">
      <button className="cf-act" data-testid="dock-new" title="New chat  ⌘N" onClick={() => { onDone(); openNewChat(); }}><MessageSquarePlus size={14} />New chat</button>
      <button className="cf-act" onClick={run('Blank board', () => api.call('boards:blank'))}><LayoutTemplate size={14} />New blank board</button>
      <button className="cf-act" data-testid="chief-tour" onClick={() => { onDone(); useTour.getState().start(); }}><Compass size={14} />Tour</button>
      <button className="cf-act" data-testid="chief-connect" onClick={() => { onDone(); useConnectAgents.getState().set(true); }}><Plug size={14} />Connect your agents</button>
    </div>
  );
}

// The overall agent: opened from the dock's "+", it slides in on the right like an open card,
// with quick actions, "Needs you" and the conversation.
export default function Chief() {
  const open = useStore((s) => s.chiefOpen);
  const selected = useStore((s) => s.selected);
  const byId = useStore((s) => s.byId);
  const { set, notify } = useStore.getState();
  const live = useStore((s) => s.liveByEntity['chief']);
  const running = live?.status === 'running';
  const { items: nudges, dismiss } = useNudges();
  const items = useMemo(() => nudges.filter((n) => n.kind !== 'tip'), [nudges]);
  const tips = useMemo(() => nudges.filter((n) => n.kind === 'tip'), [nudges]);
  const [since, setSince] = useState(() => Date.now());
  const [showEarlier, setShowEarlier] = useState(false);
  const [q, setQ] = useState('');
  const [hist, setHist] = useState<Message[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<{ id: string; text: string; tone?: 'error' }[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const msgs = useRef<HTMLDivElement>(null);

  useEffect(() => { if (open) api.chiefHistory().then(setHist).catch(() => {}); }, [open, live?.status]);
  // Each time the panel opens, the old conversation folds behind "Earlier".
  useEffect(() => { if (open) { setSince(Date.now() - 1000); setShowEarlier(false); } }, [open]);
  useEffect(() => { const el = msgs.current; if (el && !showEarlier) el.scrollTop = el.scrollHeight; }, [hist.length, live?.text, open, notes.length, busy]);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => input.current?.focus({ preventScroll: true }), 90);
    return () => clearTimeout(t);
  }, [open]);
  useEffect(() => { (window as any).__sbChief = (v?: boolean) => set({ chiefOpen: v ?? !useStore.getState().chiefOpen }); }, []);

  const close = () => { input.current?.blur(); set({ chiefOpen: false }); };
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !useStore.getState().settingsTab) close(); };
    const away = (e: MouseEvent) => {
      const t = e.target as Element;
      if (root.current?.contains(t) || t.closest?.('[data-testid="dock-plus"], .settings, .palette, .toast')) return;
      close();
    };
    document.addEventListener('keydown', esc);
    document.addEventListener('mousedown', away);
    return () => { document.removeEventListener('keydown', esc); document.removeEventListener('mousedown', away); };
  }, [open]);
  const note = (text: string, tone?: 'error') => setNotes((n) => [...n.slice(-4), { id: 'n' + Date.now(), text, tone }]);
  const ask = async (text: string) => {
    if (!text.trim() || running) return;
    set({ chiefOpen: true }); setQ('');
    setHist((h) => [...h, { id: 'q' + Date.now(), role: 'user', text, ts: Date.now() }]);
    try { await api.chief(text, { selected }); } catch (e: any) { notify(e.message); }
  };
  const act = (n: Nudge) => {
    if (n.action?.startsWith('settings:')) { set({ settingsTab: n.action.slice(9) as any }); return; }
    if (!n.ref) return;
    useStore.getState().open(n.ref);
    setTimeout(() => (window as any).__sbCenter?.(n.ref), 60);
  };
  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); set({ chiefOpen: true });
    try { await fn(); } catch (e: any) { note(e.message || 'Something went wrong', 'error'); } finally { setBusy(null); }
  };
  const recap = () => withBusy('recap', async () => {
    const text = await api.call<string>('proactive:recap');
    const h = await api.chiefHistory().catch(() => [] as Message[]);
    const last = [...h].reverse().find((m) => m.role === 'assistant');
    if (!text && !last) { note('Nothing to recap yet.'); return; }
    setHist(!text || last?.text === text ? h : [...h, { id: 'recap' + Date.now(), role: 'assistant', text, ts: Date.now() }]);
  });
  const organize = () => withBusy('organize', async () => {
    const fn = (window as any).__sbRegroup;
    if (!fn) throw new Error('Open the board first');
    const r = await fn();
    note(typeof r === 'string' && r ? r : 'Board organized.');
  });
  const needsMe = () => {
    const flagged = items.slice(0, 8).map((i) => `- ${i.title}${i.detail ? ` (${i.detail})` : ''}`).join('\n');
    ask(`What needs me right now?${flagged ? `\n\nSwitchboard flagged:\n${flagged}` : ''}`);
  };
  const chips: { key: string; label: string; run: () => void }[] = selected.length > 1
    ? [{ key: 'cmp', label: 'Compare these', run: () => ask('Compare these and tell me which is better') },
      { key: 'merge', label: 'Merge into one plan', run: () => ask('Merge these into one plan') },
      { key: 'each', label: 'What did each do?', run: () => ask('What did each of these agents get done?') }]
    : selected.length === 1
      ? [{ key: 'where', label: 'Where does this stand?', run: () => ask('Summarize where this stands') },
        { key: 'next', label: 'Next prompt', run: () => ask('Write the next prompt for this agent') },
        { key: 'recap', label: 'Daily recap', run: recap }]
      : [{ key: 'needs', label: 'What needs me?', run: needsMe },
        { key: 'recap', label: 'Daily recap', run: recap },
        { key: 'organize', label: 'Organize board', run: organize }];

  const busyLabel = busy === 'recap' ? 'Writing your daily recap' : busy === 'organize' ? 'Organizing the board' : '';
  const late = items.some((i) => i.tone === 'error');
  const earlier = hist.filter((m) => (m.ts || 0) < since);
  const fresh = hist.filter((m) => (m.ts || 0) >= since);
  const shownHist = showEarlier ? hist : fresh;
  const quiet = !fresh.length && !running && live?.status !== 'error' && !notes.length && !busy;
  return (
    <div ref={root} className={`sb-chief ${open ? 'open' : ''} ${running ? 'working' : ''}`} aria-hidden={!open}
      onKeyDown={(e) => { if (e.key === 'Escape' && open) close(); }}>
      <div className="chief-panel">
        <div className="cf-head">
          <div className="cf-titlebar">
            <ChiefGlyph size={16} working={running} />
            <span className="cf-title">Agent</span>
            {items.length > 0 && <span className={`cf-badge ${late ? 'hot' : ''}`} title="Needs you">{items.length}</span>}
            <button className="icon-btn" title="Close  (Esc, ⌘J)" aria-label="Close" onClick={close}><ChevronRight size={16} /></button>
          </div>
          <Actions onDone={close} />
        </div>
        <Needs items={items} tips={tips} onAct={act} onDismiss={dismiss} />
        <div className="cf-msgs" ref={msgs}>
          {earlier.length > 0 && (
            <button className="cf-earlier" onClick={() => setShowEarlier(!showEarlier)}>
              {showEarlier ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{showEarlier ? 'Hide earlier' : `Earlier (${earlier.length})`}
            </button>
          )}
          {quiet && !showEarlier && <StatusLine needs={items.length} />}
          {shownHist.map((m) => <ChiefMsg key={m.id} m={m} />)}
          {running && (live?.text ? <ChiefMsg m={{ id: 'live', role: 'assistant', text: live.text, ts: Date.now() }} />
            : <div className="cf-thinking"><i /><i /><i /></div>)}
          {live?.status === 'error' && <div className="cf-err">{live.error}</div>}
          {notes.map((n) => <div key={n.id} className={n.tone === 'error' ? 'cf-err' : 'cf-note'}>{n.text}</div>)}
          {busy && busyLabel && <div className="cf-progress"><ChiefGlyph size={13} working /><span>{busyLabel}…</span></div>}
        </div>
        {selected.length > 0 && (
          <div className="cf-ctx">
            {selected.slice(0, 3).map((id) => byId[id] && <span key={id} className="cf-tag"><AgentLogo source={byId[id].source} size={11} /><span>{byId[id].title}</span></span>)}
            {selected.length > 3 && <span className="cf-tag">+{selected.length - 3}</span>}
          </div>
        )}
        <div className="cf-chips">
          {chips.map((c) => <button key={c.key} className={`cf-chip ${busy === c.key ? 'busy' : ''}`} disabled={!!busy || running} onClick={c.run}>{c.label}</button>)}
        </div>
        <div className="chief-bar">
          <input ref={input} value={q} tabIndex={open ? 0 : -1} placeholder={selected.length ? 'Ask about these cards…' : 'Ask across all agents…'}
            onChange={(e) => { setQ(e.target.value); if (!useStore.getState().chiefOpen) set({ chiefOpen: true }); }} onFocus={() => { if (!useStore.getState().chiefOpen) set({ chiefOpen: true }); }}
            onKeyDown={(e) => { if (!e.metaKey && !e.ctrlKey) e.stopPropagation(); if (e.key === 'Enter') ask(q); if (e.key === 'Escape') close(); }} />
          <button className="cf-go" disabled={!q.trim() || running} onClick={() => ask(q)} title="Send"><ArrowUp size={15} /></button>
        </div>
      </div>
      <ConnectAgents />
      <NewChat />
    </div>
  );
}
