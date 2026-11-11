import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Minus, X, GripVertical, Copy, FileOutput } from 'lucide-react';
import { useStore } from '../lib/store';
import { api, Message } from '../lib/api';
import { md } from '../lib/format';
import { AgentLogo } from './Logos';
import './chief.css';

export interface Nudge {
  id: string; kind: 'waiting' | 'reply' | 'followup' | 'idle' | 'tip'; title: string;
  detail?: string; ref?: string; action?: string; tone?: 'error'; ts?: number;
}

const SHOWN = 3;
const OPEN_W = 384;

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

function tail(text: string) {
  const t = text.replace(/[#*`_>|[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length <= 44) return t;
  const cut = t.slice(-44);
  return '…' + cut.slice(cut.indexOf(' ') + 1);
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

const panelHeight = (vh: number) => Math.max(340, Math.min(540, vh - 120));

// Keeps the corner agent clear of right-docked panels (open card, outputs drawer, anything marked
// data-dock="right") that reach down into the space it needs: the small tab or the open panel.
function useRightInset(open: boolean, deps: any[]) {
  const [inset, setInset] = useState(18);
  const [vh, setVh] = useState(window.innerHeight);
  useEffect(() => {
    const measure = () => {
      const top = window.innerHeight - 18 - (open ? panelHeight(window.innerHeight) : 44);
      let r = 18;
      document.querySelectorAll<HTMLElement>('.inspector, .pn-outputs.open, [data-dock="right"]').forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.width > 0 && b.left < window.innerWidth && b.bottom > top) r = Math.max(r, window.innerWidth - b.left + 14);
      });
      setInset(r); setVh(window.innerHeight);
    };
    measure();
    const ts = [setTimeout(measure, 90), setTimeout(measure, 480)];
    window.addEventListener('resize', measure);
    return () => { ts.forEach(clearTimeout); window.removeEventListener('resize', measure); };
  }, [open, ...deps]);
  return { inset, vh };
}

function NudgeIcon({ n }: { n: Nudge }) {
  const e = useStore((s) => (n.ref ? s.byId[n.ref] : undefined));
  if (e && e.source !== 'crm') return <AgentLogo source={e.source} size={14} />;
  if (n.kind === 'reply') return <AgentLogo source="gmail" size={14} />;
  if (n.ref?.startsWith('gr:')) return <AgentLogo source="granola" size={14} />;
  return <i className={`cf-dot k-${n.tone || n.kind}`} />;
}

function Needs({ items, onAct, onDismiss }: { items: Nudge[]; onAct: (n: Nudge) => void; onDismiss: (id: string) => void }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <div className="cf-needs">
      <div className="cf-label">Needs you</div>
      {shown.map((n) => (
        <div key={n.id} className={`cf-item ${n.tone || ''}`} role="button" tabIndex={0} onClick={() => onAct(n)} onKeyDown={(e) => { if (e.key === 'Enter') onAct(n); }}>
          <span className="cf-ico"><NudgeIcon n={n} /></span>
          <span className="cf-txt"><span className="cf-t">{n.title}</span>{n.detail && <span className="cf-d">{n.detail}</span>}</span>
          <button className="cf-x" title="Dismiss" onClick={(e) => { e.stopPropagation(); onDismiss(n.id); }}><X size={12} /></button>
        </div>
      ))}
      {items.length > SHOWN && <button className="cf-more" onClick={() => setAll(!all)}>{all ? 'Show less' : `${items.length - SHOWN} more`}</button>}
    </div>
  );
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

// The overall agent: lives in the bottom-right corner. Minimized it is a small tab that shows what
// it is doing and how many things need you; open it morphs into a panel with "Needs you" and the chat.
export default function Chief() {
  const open = useStore((s) => s.chiefOpen);
  const selected = useStore((s) => s.selected);
  const byId = useStore((s) => s.byId);
  const inspector = useStore((s) => s.inspector);
  const outputsOpen = useStore((s) => s.outputsOpen);
  const { set, notify } = useStore.getState();
  const live = useStore((s) => s.liveByEntity['chief']);
  const running = live?.status === 'running';
  const { items, dismiss } = useNudges();
  const { inset, vh } = useRightInset(open, [inspector, outputsOpen]);
  const [q, setQ] = useState('');
  const [hist, setHist] = useState<Message[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [unseen, setUnseen] = useState<'done' | 'error' | null>(null);
  const [peek, setPeek] = useState<Nudge | null>(null);
  const [tabW, setTabW] = useState(44);
  const input = useRef<HTMLInputElement>(null);
  const msgs = useRef<HTMLDivElement>(null);
  const tabIn = useRef<HTMLSpanElement>(null);
  const seen = useRef<Set<string> | null>(null);
  const peekT = useRef<any>(null);
  const lastStatus = useRef(live?.status);

  useEffect(() => { if (open) api.chiefHistory().then(setHist).catch(() => {}); }, [open, live?.status]);
  useEffect(() => { const el = msgs.current; if (el) el.scrollTop = el.scrollHeight; }, [hist.length, live?.text, open]);
  useEffect(() => {
    if (!open) return;
    setUnseen(null); setPeek(null);
    const t = setTimeout(() => input.current?.focus({ preventScroll: true }), 90);
    return () => clearTimeout(t);
  }, [open]);
  useEffect(() => {
    const was = lastStatus.current; lastStatus.current = live?.status;
    if (was === 'running' && live && !running && !useStore.getState().chiefOpen) setUnseen(live.status === 'error' ? 'error' : 'done');
  }, [live?.status]);
  useEffect(() => {
    const prev = seen.current;
    seen.current = new Set(items.map((i) => i.id));
    const fresh = items.find((i) => i.kind !== 'tip' && !prev?.has(i.id));
    if (!fresh || useStore.getState().chiefOpen) return;
    setPeek(fresh); clearTimeout(peekT.current);
    peekT.current = setTimeout(() => setPeek(null), 7000);
  }, [items]);
  useEffect(() => () => clearTimeout(peekT.current), []);
  useEffect(() => { (window as any).__sbChief = (v?: boolean) => set({ chiefOpen: v ?? !useStore.getState().chiefOpen }); }, []);

  const streaming = running && !!live?.text;
  const status = running ? (live?.text ? tail(live.text) : 'Thinking…')
    : unseen === 'done' ? 'Answer ready' : unseen === 'error' ? "Couldn't answer"
    : !peek ? '' : peek.tone === 'error' ? `${peek.title} failed` : peek.kind === 'waiting' && peek.detail ? `${peek.detail} · ${peek.title}` : peek.title;
  useLayoutEffect(() => { if (tabIn.current) setTabW(Math.min(320, tabIn.current.offsetWidth)); }, [streaming || status, items.length]);

  const close = () => { input.current?.blur(); set({ chiefOpen: false }); };
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
    setBusy(key);
    try { await fn(); } catch (e: any) { notify(e.message); } finally { setBusy(null); }
  };
  const recap = () => withBusy('recap', async () => {
    const text = await api.call<string>('proactive:recap');
    const h = await api.chiefHistory().catch(() => [] as Message[]);
    const last = [...h].reverse().find((m) => m.role === 'assistant');
    setHist(!text || last?.text === text ? h : [...h, { id: 'recap' + Date.now(), role: 'assistant', text, ts: Date.now() }]);
  });
  const organize = () => withBusy('organize', async () => {
    const fn = (window as any).__sbRegroup;
    if (!fn) throw new Error('Open the board first');
    await fn();
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

  const late = items.some((i) => i.tone === 'error');
  const panelH = panelHeight(vh);
  const empty = !hist.length && !live && !items.length;
  return (
    <div className={`sb-chief ${open ? 'open' : ''} ${running ? 'working' : ''}`} style={{ right: inset, width: open ? OPEN_W : tabW, height: open ? panelH : 44 }}
      onKeyDown={(e) => { if (e.key === 'Escape' && open) close(); }}>
      <button className="chief-tab" onClick={() => set({ chiefOpen: true })} tabIndex={open ? -1 : 0} aria-hidden={open} title="Agent  ⌘J">
        <span className="cf-tabin" ref={tabIn}>
          <ChiefGlyph size={18} working={running} />
          {status && <span className={`cf-status ${running ? 'live' : ''} ${streaming ? 'stream' : ''}`}><span>{status}</span></span>}
          {items.length > 0 && <span className={`cf-badge ${late ? 'hot' : ''}`}>{items.length}</span>}
        </span>
      </button>
      <div className="chief-panel" style={{ height: panelH }}>
        <div className="cf-head">
          <ChiefGlyph size={16} working={running} />
          <span className="cf-title">Agent</span>
          <span className="cf-sub">{selected.length ? `${selected.length} card${selected.length > 1 ? 's' : ''}` : 'everything'}</span>
          <button className="icon-btn" title="Minimize  ⌘J" onClick={close}><Minus size={15} /></button>
        </div>
        <Needs items={items} onAct={act} onDismiss={dismiss} />
        <div className="cf-msgs" ref={msgs}>
          {empty && <div className="cf-empty"><ChiefGlyph size={22} /><span>All clear.</span></div>}
          {hist.map((m) => <ChiefMsg key={m.id} m={m} />)}
          {running && (live?.text ? <ChiefMsg m={{ id: 'live', role: 'assistant', text: live.text, ts: Date.now() }} />
            : <div className="cf-thinking"><i /><i /><i /></div>)}
          {live?.status === 'error' && <div className="cf-err">{live.error}</div>}
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
    </div>
  );
}
