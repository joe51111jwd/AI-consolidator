import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Maximize2, Copy, FileOutput, Brain, GripVertical, ExternalLink, Send, FolderOpen, Terminal, Tag, Paperclip, ArrowRight, User } from 'lucide-react';
import { useStore } from '../lib/store';
import { api, Message, Flow, Entity, Account } from '../lib/api';
import { ago, md, SOURCE, PROMPTABLE } from '../lib/format';
import { dragOutput } from '../nodes/nodes';
import { AgentLogo } from './Logos';
import Composer from './Composer';
import FullChat from './FullChat';
import { ChatApprovals } from './Approval';
import './panels.css';

type Who = { key: string; name: string; source?: string; color?: string; you?: boolean };
type Item = Message & { who: Who; body: string; ctx?: { title: string; body: string }[]; to?: string; live?: boolean };

const YOU: Who = { key: 'you', name: 'You', you: true };
const CTX = /^Context from (.+?):\n"""\n([\s\S]*?)\n"""\n\n/;
const MAIL = /^\*\*(.+?)\*\*(?: · [^\n]*)?\n\n/;
const head = (t: string) => t.trim().slice(0, 120);

function splitContext(text: string) {
  const ctx: { title: string; body: string }[] = [];
  let rest = text;
  for (let m = rest.match(CTX); m; m = rest.match(CTX)) { ctx.push({ title: m[1], body: m[2] }); rest = rest.slice(m[0].length); }
  return { ctx, rest };
}

function cardWho(id: string, byId: Record<string, Entity>, accounts: Account[]): Who {
  const e = byId[id];
  if (!e) return { key: id, name: 'Another card', source: 'note' };
  const acc = e.accountId ? accounts.find((a) => a.id === e.accountId) : undefined;
  return { key: id, name: e.title, source: e.source, color: acc?.color || SOURCE[e.source]?.color };
}

// Who said each message: you, this card's agent, or another card whose output flowed in.
function build(e: Entity, agent: Who, raw: Message[], rawFlows: Flow[], byId: Record<string, Entity>, accounts: Account[]): Item[] {
  const who = (id: string) => cardWho(id, byId, accounts);
  const msgs = raw.map((m) => ({ ...m, text: m.text || '' }));
  const flows = rawFlows.map((f) => ({ ...f, content: f.content || '' }));
  if (e.kind === 'account' && e.source === 'grok-bot') {
    return flows.map((f) => ({ id: f.id, role: f.source === e.id ? 'assistant' : 'user', text: f.content, body: f.content, ts: f.ts, who: f.source === e.id ? agent : who(f.source), to: f.source === e.id ? byId[f.target]?.title : undefined }));
  }
  const incoming = e.kind === 'output' ? [] : flows.filter((f) => f.target === e.id && f.source !== e.id && f.via !== 'drag' && f.content.trim());
  const used = new Set<string>();
  const items: Item[] = msgs.map((m) => {
    if (m.kind === 'tool' || m.kind === 'plan' || m.kind === 'recap') return { ...m, who: agent, body: m.text };
    if (e.source === 'gmail') {
      const h = m.text.match(MAIL);
      return { ...m, body: h ? m.text.slice(h[0].length) : m.text, who: m.role === 'user' ? YOU : { key: `mail:${h?.[1]}`, name: h?.[1] || 'Sender', source: 'gmail', color: SOURCE.gmail.color } };
    }
    if (e.kind === 'output') return { ...m, body: m.text, who: e.meta?.from && byId[e.meta.from] ? who(e.meta.from) : { key: 'output', name: 'Output', source: 'output' } };
    if (e.kind === 'meeting') {
      return { ...m, body: m.text, who: m.role === 'user' ? { ...YOU, name: 'Your notes' } : { key: m.role, name: m.role === 'system' ? 'Transcript' : 'Granola', source: 'granola', color: SOURCE.granola.color } };
    }
    if (m.role !== 'user') return { ...m, body: m.text, who: agent };
    const { ctx, rest } = splitContext(m.text);
    const probe = head(rest);
    const f = incoming.find((x) => !used.has(x.id) && (head(x.content) === probe || m.text.includes(head(x.content))));
    if (f) used.add(f.id);
    return { ...m, body: rest, ctx, who: f ? who(f.source) : YOU };
  });
  for (const f of incoming) if (!used.has(f.id)) items.push({ id: f.id, role: 'user', text: f.content, body: f.content, ts: f.ts, who: who(f.source) });
  return items.sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

function Avatar({ who, working }: { who: Who; working?: boolean }) {
  if (who.you) return <span className="pn-you"><User size={9} strokeWidth={2.6} /></span>;
  return <AgentLogo source={who.source || 'note'} color={who.color} size={16} working={working} />;
}

const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');

// The open card: its whole conversation with who said what, and a composer ready to type into.
export default function Inspector() {
  const id = useStore((s) => s.inspector);
  const e = useStore((s) => (id ? s.byId[id] : undefined));
  const live = useStore((s) => (id ? s.liveByEntity[id] : undefined));
  const { open, notify, entities, byId, accounts, pins, outputsOpen, set } = useStore();
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [echo, setEcho] = useState<Message | null>(null);
  const [sendMenu, setSendMenu] = useState<{ text: string; x: number; y: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => Number(localStorage.getItem('sb.inspectorW')) || 480);
  const [resizing, setResizing] = useState(false);
  const [full, setFull] = useState(false);

  // Publish how much of the window the inspector covers, so the board can centre cards in the free area.
  useEffect(() => {
    const root = document.documentElement;
    (window as any).__sbInspectorW = Math.min(width, window.innerWidth - 24) + 12;
    root.style.setProperty('--insp-open-w', `${(window as any).__sbInspectorW}px`);
    return () => { (window as any).__sbInspectorW = 0; root.style.removeProperty('--insp-open-w'); };
  }, [width]);

  // Notes edit inline on the board; they never open here.
  useEffect(() => { if (e?.kind === 'note') open(null); }, [e?.kind]);

  const startResize = (ev: React.PointerEvent) => {
    ev.preventDefault();
    const x0 = ev.clientX, w0 = width;
    let w = w0;
    setResizing(true);
    const move = (m: PointerEvent) => { w = Math.round(Math.max(360, Math.min(window.innerWidth - 40, 1100, w0 + x0 - m.clientX))); setWidth(w); };
    const up = () => {
      setResizing(false); localStorage.setItem('sb.inspectorW', String(w));
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  useEffect(() => { setMsgs([]); setFlows([]); setEcho(null); setSendMenu(null); if (!id) setFull(false); }, [id]);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    setLoading(true);
    api.transcript(id).then((m) => alive && setMsgs(m)).catch((err) => alive && notify(err.message)).finally(() => alive && setLoading(false));
    api.flows(id).then((f) => alive && setFlows(f)).catch(() => {});
    // Keep the open chat in sync with the session file, like the Claude app does.
    const t = setInterval(() => { api.transcript(id).then((m) => alive && setMsgs((prev) => (prev.length === m.length && prev[prev.length - 1]?.text === m[m.length - 1]?.text ? prev : m))).catch(() => {}); }, full ? 2000 : 3000);
    return () => { alive = false; clearInterval(t); };
  }, [id, e?.updatedAt, live?.status, full]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (useStore.getState().paletteOpen) return;
      const t = ev.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
      if ((ev.key === 'f' || ev.key === 'F') && !typing && !ev.metaKey && !ev.ctrlKey && !ev.altKey && useStore.getState().inspector) { ev.preventDefault(); setFull(true); return; }
      if (ev.key !== 'Escape') return;
      if (sendMenu) { setSendMenu(null); return; }
      if (full) { setFull(false); return; }
      if (!t.closest?.('.inspector') && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      open(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sendMenu, full]);

  // Double-clicking a chat card opens it full size.
  useEffect(() => {
    const onDbl = (ev: MouseEvent) => {
      const el = ev.target as HTMLElement;
      const n = el.closest?.('.react-flow__node');
      if (!n || n.classList.contains('react-flow__node-note') || n.classList.contains('react-flow__node-group')) return;
      if (el.closest('input, textarea, [contenteditable="true"], .composer')) return;
      setTimeout(() => { const s = useStore.getState(); if (s.inspector && s.byId[s.inspector]?.kind !== 'note') setFull(true); }, 0);
    };
    window.addEventListener('dblclick', onDbl);
    return () => window.removeEventListener('dblclick', onDbl);
  }, []);

  const acc = e?.accountId ? accounts.find((a) => a.id === e.accountId) : undefined;
  const src = (e && SOURCE[e.source]) || { label: e?.source || '', color: '#999' };
  const agent: Who = { key: 'agent', name: acc?.label || src.label, source: e?.source, color: acc?.color || src.color };

  const items = useMemo(() => {
    if (!e) return [];
    const all = build(e, agent, msgs, flows, byId, accounts);
    if (echo && !all.some((m) => m.role === 'user' && (head(m.body) === head(echo.text) || m.text.includes(head(echo.text))))) all.push({ ...echo, who: YOU, body: echo.text });
    const shown = (t: string) => msgs.some((m) => m.role === 'assistant' && m.text?.trim() && (m.ts || 0) >= (live?.startedAt || 0) - 2000 && (m.text.includes(head(t)) || t.includes(head(m.text))));
    const recent = live && live.status === 'done' && live.text && Date.now() - live.startedAt < 600000 && !shown(live.text);
    if (live && (live.status === 'running' || recent)) {
      all.push({ id: `live:${live.id}`, role: 'assistant', text: live.text, body: live.text || 'Working…', ts: live.startedAt, who: agent, live: live.status === 'running' });
    }
    return all;
  }, [e, msgs, flows, echo, live, byId, accounts]);

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [items.length, live?.text]);

  const linked = useMemo(() => {
    if (!id) return [];
    const ids = [...new Set(flows.map((f) => (f.source === id ? f.target : f.source)))].filter((x) => x !== id && byId[x]);
    return ids.slice(0, 6).map((x) => ({ id: x, who: cardWho(x, byId, accounts) }));
  }, [flows, id, byId, accounts]);

  if (!id || !e || e.kind === 'note') return null;
  const working = live?.status === 'running' || e.status === 'running';
  const pinned = pins.includes(id);
  const spawned = live?.status === 'done' && live.result?.entityId && live.result.entityId !== id && byId[live.result.entityId] ? live.result.entityId as string : null;

  const saveOutput = async (text: string) => {
    const oid = await api.saveOutput({ title: `From ${e.title}`.slice(0, 80), content: text, source: id });
    await api.recordFlow(id, oid, text);
    await useStore.getState().refresh(true); await useStore.getState().refreshBoard();
    notify('Saved as an output');
  };
  const toBrain = async (text: string) => { await api.appendBrain(text, e.title); notify('Added to the shared brain'); };
  const togglePin = () => { set({ pins: pinned ? pins.filter((p) => p !== id) : [...pins, id] }); notify(pinned ? 'Removed from context' : 'Tagged as context'); };
  const targets = entities.filter((x) => PROMPTABLE(x.id) && x.id !== id && !x.meta?.noise && (x.kind === 'session' || x.kind === 'account')).slice(0, 14);

  let prev: Item | null = null;
  const rows: React.ReactNode[] = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (it.kind === 'plan') {
      // Only the newest plan update shows in the stream; older ones are history.
      if (items.slice(k + 1).some((x) => x.kind === 'plan')) continue;
      rows.push(<PlanCard key={`plan:${it.id}`} plan={(it as any).plan || []} />);
      continue;
    }
    if (it.kind === 'recap') {
      rows.push(<div key={`recap:${it.id}`} className="pn-recap"><span>Recap</span>{it.body}</div>);
      continue;
    }
    if (it.kind === 'tool') {
      const steps: Item[] = [];
      while (k < items.length && items[k].kind === 'tool') steps.push(items[k++]);
      k--;
      rows.push(
        <details key={`steps:${it.id}`} className="pn-steps">
          <summary>{steps.length === 1 ? steps[0].text.replace(/^⟢\s*/, '').slice(0, 70) : `${steps.length} steps`}</summary>
          {steps.map((s) => <div key={s.id} className="pn-step mono">{s.text}</div>)}
        </details>,
      );
      continue;
    }
    const showWho = !prev || prev.who.key !== it.who.key || (it.ts || 0) - (prev.ts || 0) > 900000;
    prev = it;
    const payload = it.role === 'user' ? it.body : it.text;
    rows.push(
      <div key={it.id} className={`msg ${it.role} ${showWho ? 'first' : ''} ${it.live ? 'streaming' : ''}`}>
        {showWho && (
          <div className="who">
            <Avatar who={it.who} working={it.live} />
            <b>{it.who.name}</b>
            {it.to && <span className="pn-to"><ArrowRight size={10} />{it.to}</span>}
            <span className="ts">{it.ts ? ago(it.ts) : ''}</span>
          </div>
        )}
        {it.ctx && it.ctx.length > 0 && (
          <div className="pn-ctxs">
            {it.ctx.map((c, i) => <details key={i} className="pn-ctx"><summary><Paperclip size={11} />{c.title}</summary><div className="pn-ctx-b">{c.body}</div></details>)}
          </div>
        )}
        {it.role === 'system'
          ? <details className="pn-tr"><summary>Show transcript</summary><div className="body">{it.body}</div></details>
          : it.body.trim() ? <div className="body md" dangerouslySetInnerHTML={{ __html: md(it.body) }} /> : null}
        {!it.live && payload && (
          <div className="tools">
            <button draggable onDragStart={(ev) => dragOutput(ev, { text: payload, title: `From ${e.title}`.slice(0, 80), sourceId: id })} title="Drag onto a card"><GripVertical size={13} /></button>
            <button onClick={(ev) => setSendMenu({ text: payload, x: ev.clientX, y: ev.clientY })} title="Send to another card"><Send size={13} /></button>
            <button onClick={() => { api.copy(payload); notify('Copied'); }} title="Copy"><Copy size={13} /></button>
            <button onClick={() => saveOutput(payload)} title="Save as output card"><FileOutput size={13} /></button>
            <button onClick={() => toBrain(payload)} title="Add to shared brain"><Brain size={13} /></button>
          </div>
        )}
      </div>,
    );
  }

  const latestPlan = (() => { for (let k = items.length - 1; k >= 0; k--) if (items[k].kind === 'plan') return (items[k] as any).plan as { content: string; status: string }[]; return null; })();

  const subs = Array.isArray(e.meta?.subagents) ? e.meta.subagents : [];
  // What the chat is waiting for your OK on sits right above the message box.
  const composer = PROMPTABLE(id) ? (<>
    <ChatApprovals id={id} />
    <Composer key={id} id={id} multiline autoFocus placeholder={e.kind === 'account' ? 'Start a new session…' : 'Message…'}
      onSent={(t) => setEcho({ id: `echo:${Date.now()}`, role: 'user', text: t, ts: Date.now() })} />
  </>) : null;
  const sendMenuEl = sendMenu && (
    <div className="menu pn-menu" style={{ position: 'fixed', zIndex: 60, left: Math.min(sendMenu.x, window.innerWidth - 280), top: Math.min(sendMenu.y, window.innerHeight - 400) }} onMouseLeave={() => setSendMenu(null)}>
      <div className="hint">Attach to…</div>
      {targets.map((t) => (
        <button key={t.id} onClick={() => { useStore.getState().addAttach(t.id, { text: sendMenu.text, title: `From ${e.title}`.slice(0, 80), sourceId: id }); setSendMenu(null); notify(`Attached to ${t.title}`); }}>
          <Avatar who={cardWho(t.id, byId, accounts)} />
          <span className="pn-ell">{t.title}</span>
        </button>
      ))}
    </div>
  );

  if (full) {
    const tail = [...rows];
    if (live?.status === 'error') tail.push(<div key="err" className="well err">{live.error}</div>);
    if (spawned) tail.push(<button key="spawned" className="pn-follow" onClick={() => open(spawned)}>Open the new session<ArrowRight size={13} /></button>);
    return (
      <>
        <FullChat title={e.title} source={e.source} color={agent.color} agentName={agent.name} working={working}
          rows={tail} streaming={live?.text || ''} plan={latestPlan} subs={subs} composer={composer} onClose={() => setFull(false)} />
        {sendMenuEl}
      </>
    );
  }

  return (
    <div className={`inspector pn ${outputsOpen ? 'shift' : ''} ${resizing ? 'resizing' : ''}`} style={{ width: Math.min(width, window.innerWidth - 24) }}
      onKeyDown={(ev) => { if (ev.key === 'Delete' || ev.key === 'Backspace') ev.stopPropagation(); }}>
      <div className="pn-resize" onPointerDown={startResize} onDoubleClick={() => { setWidth(480); localStorage.setItem('sb.inspectorW', '480'); }} title="Drag to resize" />
      <div className="insp-head">
        <div className="pn-bar">
          <span className="pn-src"><AgentLogo source={e.source} color={agent.color} working={working} size={14} />{agent.name}</span>
          {working ? <span className="pn-state on">Working</span> : e.status === 'waiting' && e.kind === 'session' ? <span className="pn-state">Your turn</span> : null}
          <span className="pn-when">{ago(e.updatedAt)}</span>
          <span className="pn-acts">
            {e.meta?.url && <button className="icon-btn" onClick={() => api.openExternal(e.meta.url)} title={`Open in ${src.label}`}><ExternalLink size={14} /></button>}
            {e.meta?.cwd && <button className="icon-btn" onClick={() => api.openPath(e.meta.cwd)} title="Open folder"><FolderOpen size={14} /></button>}
            {e.meta?.sessionId && e.source === 'claude-code' && <button className="icon-btn" onClick={() => { api.copy(`claude --resume ${e.meta.sessionId}`); notify('Resume command copied'); }} title="Copy resume command"><Terminal size={14} /></button>}
            <button className="icon-btn" onClick={() => setFull(true)} title="Expand (F)" data-testid="expand-chat"><Maximize2 size={14} /></button>
            <button className={`icon-btn ${pinned ? 'on' : ''}`} onClick={togglePin} title={pinned ? 'Remove from context' : 'Tag as context'}><Tag size={14} /></button>
            <button className="icon-btn" onClick={() => open(null)} title="Close"><X size={16} /></button>
          </span>
        </div>
        <div className="title">{e.title}</div>
        {(e.meta?.cwd || linked.length > 0) && (
          <div className="pn-meta">
            {e.meta?.cwd && <span className="mono">{shortPath(e.meta.cwd)}{e.meta.gitBranch ? ` · ${e.meta.gitBranch}` : ''}</span>}
            {linked.length > 0 && (
              <span className="pn-linked">
                {linked.map((l) => <button key={l.id} onClick={() => open(l.id)} title={l.who.name}><Avatar who={l.who} /></button>)}
              </span>
            )}
          </div>
        )}
      </div>
      {latestPlan && <PlanCard plan={latestPlan} pinned />}
      <div className="msgs" key={id}>
        {loading && !items.length && <div className="empty">Loading…</div>}
        {!loading && !items.length && <div className="empty">Nothing here yet.</div>}
        {rows}
        {live?.status === 'error' && <div className="well err">{live.error}</div>}
        {spawned && <button className="pn-follow" onClick={() => open(spawned)}>Open the new session<ArrowRight size={13} /></button>}
        <div ref={end} />
      </div>
      {composer && <div className="insp-foot">{composer}</div>}
      {sendMenuEl}
    </div>
  );
}

// The plan as the Claude app shows it: done, current and next steps.
function PlanCard({ plan, pinned }: { plan: { content: string; status: string }[]; pinned?: boolean }) {
  const [open, setOpen] = useState(!pinned || plan.length <= 6);
  if (!plan.length) return null;
  const done = plan.filter((t) => t.status === 'completed').length;
  return (
    <div className={`pn-plan ${pinned ? 'pinned' : ''}`} data-testid={pinned ? 'plan-pinned' : 'plan-card'}>
      <button className="pn-plan-h" onClick={() => setOpen(!open)}><span>Plan</span><span className="pn-plan-n">{done}/{plan.length}</span></button>
      {open && plan.map((t, i) => (
        <div key={i} className={`pn-plan-row ${t.status}`}>
          <i>{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '' : ''}</i><span>{t.content}</span>
        </div>
      ))}
    </div>
  );
}
