import React, { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, NodeResizer, NodeProps } from '@xyflow/react';
import { GripVertical, FolderGit2, FileText, StickyNote, AlertTriangle, Target, Play, Clock, UserRound, MessageSquare, Zap, Wrench, Plug, Bot, Info, GitPullRequest, Monitor } from 'lucide-react';
import { useStore } from '../lib/store';
import { useShallow } from 'zustand/react/shallow';
import { api, BoardRow, Entity } from '../lib/api';
import { ago, tokens, md, SOURCE, dueLabel, categoryOf, baseName, colorOf, PROMPTABLE } from '../lib/format';
import { sendPrompt } from '../lib/send';
import Composer from '../components/Composer';
import { AgentLogo, GrokLogo } from '../components/Logos';
import ComputerPreview from '../components/demo/DemoNodes';

const Handles = () => (
  <>
    <Handle type="target" position={Position.Left} />
    <Handle type="source" position={Position.Right} />
  </>
);

function useEntity(id: string): Entity | undefined { return useStore((s) => s.byId[id]); }

function accountOf(e?: Entity) {
  const accounts = useStore.getState().accounts;
  return e?.accountId ? accounts.find((a) => a.id === e.accountId) : undefined;
}

export function dragOutput(ev: React.DragEvent, payload: { text: string; title?: string; sourceId?: string }) {
  ev.stopPropagation();
  ev.dataTransfer.setData('application/x-sb', JSON.stringify(payload));
  ev.dataTransfer.setData('text/plain', payload.text);
  ev.dataTransfer.effectAllowed = 'copy';
}

// Textareas only keep the wheel (block board panning) while being edited and actually scrollable.
function useEditWheel() {
  const [cls, setCls] = useState('');
  const check = (el: HTMLTextAreaElement | null) => setCls(el && document.activeElement === el && el.scrollHeight > el.clientHeight + 1 ? 'nowheel' : '');
  return { cls, check, clear: () => setCls('') };
}

// A note the board just created by double-click focuses itself once it renders.
let focusNext: string | null = null;
export const focusNote = (id: string) => { focusNext = id; };

// Saves a card's new size (and position, since resizing from the left/top moves it) locally and to disk.
function saveSize(id: string, p: { x: number; y: number; width: number; height: number }) {
  const s = useStore.getState();
  const r = s.board.find((b) => b.id === id); if (!r) return;
  const row = { ...r, x: p.x, y: p.y, w: Math.round(p.width), h: Math.round(p.height) };
  useStore.setState({ board: s.board.map((b) => (b.id === id ? row : b)) });
  api.saveBoard([row]);
}

function Card({ id, selected, stripe, className = '', minW = 220, minH = 110, children }: { id: string; selected?: boolean; stripe?: string; className?: string; minW?: number; minH?: number; children: React.ReactNode }) {
  const sized = useStore((s) => !!s.board.find((b) => b.id === id)?.h);
  return (
    <div className={`card ${sized ? 'sized' : ''} ${className}`} style={{ ['--stripe' as any]: stripe }}>
      <NodeResizer isVisible={!!selected} minWidth={minW} minHeight={minH} lineClassName="card-resize-line" handleClassName="card-resize-handle"
        onResizeEnd={(_, p) => saveSize(id, p)} />
      {stripe && <span className="card-stripe" />}
      <Handles />
      {children}
    </div>
  );
}

function useRunning(e: Entity) {
  const live = useStore((s) => s.liveByEntity[e.id]?.status === 'running');
  return live || e.status === 'running';
}

function Top({ e, color, label, icon }: { e: Entity; color?: string; label?: string; icon?: React.ReactNode }) {
  const acc = accountOf(e);
  const running = useRunning(e);
  const src = SOURCE[e.source] || { label: e.source, color: '#71717A' };
  return (
    <div className="card-top">
      <span className="src">{icon || <AgentLogo source={e.source} color={color || acc?.color || src.color} working={running} />}<span className="src-name">{label || acc?.label || src.label}</span></span>
      <span className="when">
        {running ? <span className="status running"><i />Working</span>
          : e.status === 'waiting' ? <span className="status waiting"><i />Your turn</span>
          : ago(e.updatedAt)}
      </span>
    </div>
  );
}

function LiveOrPreview({ id, preview, title }: { id: string; preview?: string; title: string }) {
  const live = useStore((s) => s.liveByEntity[id]);
  if (live && (live.status === 'running' || Date.now() - live.startedAt < 120000)) {
    if (live.status === 'error') return <div className="well err">{live.error}</div>;
    return (
      <div className={`well clamp ${live.status === 'running' ? 'live' : ''}`}>
        {live.text ? live.text.slice(-400) : 'Working…'}
        {live.text && <span className="grip nodrag" draggable onDragStart={(ev) => dragOutput(ev, { text: live.text, title: `Reply from ${title}`, sourceId: id })} title="Drag onto another card"><GripVertical size={13} /></span>}
      </div>
    );
  }
  if (!preview) return null;
  return (
    <div className="well clamp">
      {preview}
      <span className="grip nodrag" draggable onDragStart={(ev) => dragOutput(ev, { text: preview, title: `From ${title}`, sourceId: id })} title="Drag onto another card"><GripVertical size={13} /></span>
    </div>
  );
}

type Activity = { prompt?: string; tool?: string; text?: string; running?: boolean };
type Sub = { id: string; title: string; status: 'running' | 'done'; updatedAt?: number; lastText?: string };

function ActivityLine({ e }: { e: Entity }) {
  const running = useRunning(e);
  const a: Activity | undefined = e.meta?.activity;
  if (!a || !(running || a.running)) return null;
  const now = a.tool || a.text?.split('\n').filter(Boolean).pop() || 'Thinking';
  return (
    <div className="activity">
      {a.prompt && <div className="act-prompt" title={a.prompt}>{a.prompt}</div>}
      <div className="act-now" title={now}>▸ <span className="shimmer">{now}</span></div>
    </div>
  );
}

function Subagents({ e }: { e: Entity }) {
  const subs: Sub[] = Array.isArray(e.meta?.subagents) ? e.meta.subagents : [];
  if (!subs.length) return null;
  const sorted = [...subs].sort((a, b) => (a.status === b.status ? (b.updatedAt || 0) - (a.updatedAt || 0) : a.status === 'running' ? -1 : 1));
  const open = (ev: React.MouseEvent) => { ev.stopPropagation(); useStore.getState().open(e.id); };
  return (
    <div className="subagents">
      {sorted.slice(0, 4).map((s) => (
        <button key={s.id} className="sub-row nodrag" onClick={open} title={s.lastText || s.title}>
          <i className={`sub-dot ${s.status}`} /><span className="sub-t">{s.title}</span><span className="sub-age">{ago(s.updatedAt)}</span>
        </button>
      ))}
      {sorted.length > 4 && <button className="sub-more nodrag" onClick={open}>{sorted.length - 4} more</button>}
    </div>
  );
}

type GrokAction = { kind: 'message' | 'event' | 'tool' | 'connector' | 'agent' | 'notice'; text: string; ts?: number };
type GrokSub = Sub & { prUrl?: string };
const ACTION_ICON: Record<string, React.ReactNode> = {
  message: <MessageSquare size={11} />, event: <Zap size={11} />, tool: <Wrench size={11} />,
  connector: <Plug size={11} />, agent: <Bot size={11} />, notice: <Info size={11} />,
};

// A Grok bot is a hub: its own avatar, what it's doing now, what it did, and the agents it launched.
function GrokNode({ id, e, selected }: { id: string; e: Entity; selected?: boolean }) {
  const running = useRunning(e);
  const [screen, setScreen] = useState(false);
  const color: string = e.meta?.avatarColor || colorOf(e, useStore.getState().accounts);
  const shape: string = e.meta?.avatarShape || 'circle';
  const a: { text?: string; tool?: string; running?: boolean } | undefined = e.meta?.activity;
  const actions: GrokAction[] = Array.isArray(e.meta?.actions) ? e.meta.actions : [];
  const subs: GrokSub[] = Array.isArray(e.meta?.subagents) ? e.meta.subagents : [];
  const live = running || !!a?.running;
  const now = a?.tool || a?.text;
  const open = (ev: React.MouseEvent) => { ev.stopPropagation(); useStore.getState().open(id); };
  return (
    <Card id={id} selected={selected} stripe={color} className="grok-card" minH={160}>
      <div className="grok-head">
        <div className={`grok-avatar shape-${shape}`} style={{ background: color }}>
          {(e.title || '?').slice(0, 1).toUpperCase()}
          <span className="grok-badge"><GrokLogo size={10} /></span>
        </div>
        <div className="card-title">{e.title}</div>
        <span className="when">{live ? <span className="status running"><i />Working</span> : ago(e.updatedAt)}</span>
      </div>
      {now && <div className="act-now" title={now}>▸ <span className={live ? 'shimmer' : ''}>{now}</span></div>}
      {actions.length > 0 && (
        <div className="grok-feed nowheel">
          {actions.slice(0, 15).map((x, i) => (
            <div key={`${x.ts}-${i}`} className={`grok-act ${i >= 5 ? 'extra' : ''}`} title={x.text}>
              <span className="ic">{ACTION_ICON[x.kind] || ACTION_ICON.notice}</span><span className="t">{x.text}</span><span className="age">{ago(x.ts)}</span>
            </div>
          ))}
        </div>
      )}
      {subs.length > 0 && (
        <div className="subagents">
          {[...subs].sort((p, q) => (p.status === q.status ? (q.updatedAt || 0) - (p.updatedAt || 0) : p.status === 'running' ? -1 : 1)).slice(0, 4).map((s) => (
            <button key={s.id} className="sub-row nodrag" onClick={open} title={s.lastText || s.title}>
              <i className={`sub-dot ${s.status}`} /><span className="sub-t">{s.title}</span>
              {s.prUrl && <a className="sub-pr" href={s.prUrl} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()} title="Pull request"><GitPullRequest size={11} /></a>}
              <span className="sub-age">{ago(s.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}
      <button className={`grok-screen-toggle nodrag ${screen ? 'on' : ''}`} onClick={(ev) => { ev.stopPropagation(); setScreen(!screen); }} title="Show its computer">
        <Monitor size={11} />Computer
      </button>
      {screen && <div className="grok-screen nodrag"><ComputerPreview name={e.title} color={color} live={live} /></div>}
      <Composer id={id} placeholder="Message…" />
    </Card>
  );
}

export const SessionNode = memo(({ id, selected }: NodeProps) => {
  const e = useEntity(id); if (!e) return <Gone />;
  if (e.source === 'grok-bot') return <GrokNode id={id} e={e} selected={selected} />;
  const cat = categoryOf(e);
  const folder = cat === 'coding' ? baseName(e.meta?.cwd) : '';
  const branch = e.meta?.gitBranch && !['main', 'master', 'HEAD'].includes(e.meta.gitBranch) ? e.meta.gitBranch : '';
  return (
    <Card id={id} selected={selected} stripe={colorOf(e, useStore.getState().accounts)}>
      <Top e={e} />
      <div className="card-title">{e.title}</div>
      {cat && (
        <div className="card-meta">
          <span className={`kind-chip ${cat}`}>{cat === 'coding' ? 'Code' : 'Chat'}</span>
          {folder && <span className="mono" title={e.meta?.cwd}>{folder}{branch && <em> · {branch}</em>}</span>}
        </div>
      )}
      <ActivityLine e={e} />
      <LiveOrPreview id={id} preview={e.preview} title={e.title} />
      <Subagents e={e} />
      <Composer id={id} placeholder="Reply…" />
    </Card>
  );
});

const PROMPT_ACCOUNTS = ['claude-code', 'codex', 'anthropic-api', 'openai-compatible', 'grok-bot'];

export const AccountNode = memo(({ id, selected }: NodeProps) => {
  const e = useEntity(id);
  const week = useStore(useShallow((s) => s.entities.filter((x) => x.kind === 'account').map((x) => x.meta?.usage?.d7 || 0)));
  const running = useStore((s) => s.entities.filter((x) => x.accountId === e?.accountId && x.kind === 'session' && x.status === 'running').length);
  if (!e) return <Gone />;
  const src = SOURCE[e.source] || { label: e.source, color: '#71717A' };
  const u = e.meta?.usage;
  const color = e.meta?.color || src.color;
  const auth = e.meta?.config?.auth;
  const sub = e.source === 'claude-code'
    ? (auth?.loggedIn ? [auth.org, auth.plan && auth.plan[0].toUpperCase() + auth.plan.slice(1)].filter(Boolean).join(' · ') || auth.email || 'Signed in' : auth ? 'Not signed in' : '')
    : e.source === 'grok-bot' ? 'Reaches your agents through sb' : src.label;
  const total = week.reduce((a, b) => a + b, 0);
  const pct = u?.weekPct != null ? Math.round(u.weekPct) : total ? Math.round(((u?.d7 || 0) / total) * 100) : 0;
  const promptable = PROMPT_ACCOUNTS.includes(e.source);
  return (
    <Card id={id} selected={selected} stripe={color} className="account-card">
      <div className="acc-head">
        <div className="avatar" style={{ background: color }}><AgentLogo source={e.source} size={17} color="#fff" working={running > 0} /></div>
        <div className="acc-id">
          <div className="t">{e.title}</div>
          <div className="s" title={[sub, auth?.email || e.meta?.config?.configDir].filter(Boolean).join(' · ')}>{promptable && e.source !== 'grok-bot' ? 'New chats start here' : sub}</div>
        </div>
        {running > 0 && <span className="status running"><i />Working</span>}
      </div>
      {u && (u.d7 > 0 || u.h5 > 0) && (
        <div className="acc-usage" title={`${tokens(u.h5)} in the last 5 hours · ${tokens(u.d1)} today · ${tokens(u.d7)} this week${u.weekPct == null ? ' (share of all accounts)' : ''}`}>
          <div className="bar"><i style={{ width: `${Math.max(2, pct)}%`, background: color }} /></div>
          <span>{pct}% this week</span>
        </div>
      )}
      <LiveOrPreview id={id} title={e.title} />
      {promptable && <Composer id={id} placeholder={e.source === 'grok-bot' ? 'Hand off to Grok Bot…' : 'New session…'} />}
    </Card>
  );
});

export const ProjectNode = memo(({ id, selected }: NodeProps) => {
  const e = useEntity(id); if (!e) return <Gone />;
  return (
    <Card id={id} selected={selected}>
      <Top e={e} icon={<FolderGit2 size={13} />} label={e.title} />
      <div className="card-sub mono">{e.preview}</div>
      <Composer id={id} placeholder="New task in this project…" />
    </Card>
  );
});

const TINTS = ['#D97757', '#2F6B55', '#6D5BD0', '#B08A2E', '#3F5E8C'];

export const MeetingNode = memo(({ id, selected }: NodeProps) => {
  const e = useEntity(id); if (!e) return <Gone />;
  const people: any[] = e.meta?.attendees || [];
  const day = new Date(e.meta?.at || e.updatedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return (
    <Card id={id} selected={selected} stripe={SOURCE.granola.color}>
      <Top e={e} label={day} />
      <div className="card-title">{e.title}</div>
      {people.length > 0 && <div className="people">{people.slice(0, 5).map((p, i) => <span key={p.email || i} title={p.name || p.email} style={{ background: TINTS[i % TINTS.length] }}>{(p.name || p.email || '?').slice(0, 1).toUpperCase()}</span>)}</div>}
      <LiveOrPreview id={id} preview={e.preview} title={e.title} />
    </Card>
  );
});

export const ThreadNode = memo(({ id, selected }: NodeProps) => {
  const e = useEntity(id); if (!e) return <Gone />;
  return (
    <Card id={id} selected={selected} stripe={colorOf(e, useStore.getState().accounts)}>
      <Top e={e} label={accountOf(e)?.label || 'Gmail'} />
      <div className="card-title">{e.title}</div>
      <LiveOrPreview id={id} preview={e.preview} title={e.title} />
    </Card>
  );
});

export const ClientNode = memo(({ id, selected }: NodeProps) => {
  const e = useEntity(id); const due = useStore(useShallow((s) => s.due.filter((d) => `cl:${d.clientId}` === id)));
  if (!e) return <Gone />;
  const c = e.meta.client;
  const tone = c.status === 'lead' ? 'amber' : c.status === 'active' ? 'green' : '';
  return (
    <Card id={id} selected={selected} stripe="#2F6B55">
      <div className="acc-head">
        <div className="avatar" style={{ background: '#2F6B55' }}>{(c.name || '?').slice(0, 1).toUpperCase()}</div>
        <div className="acc-id">
          <div className="t">{c.name}</div>
          <div className="s">{c.company || c.domains?.[0] || c.emails?.[0] || 'Client'}</div>
        </div>
        <span className={`chip ${tone}`}>{c.status}</span>
      </div>
      {due.length > 0 && (
        <div className="due-lines">
          {due.slice(0, 2).map((d) => (
            <div key={d.id} className="due-line"><span className={`chip ${d.overdue ? 'red' : 'amber'}`}>{dueLabel(d.due) || 'Open'}</span><span className="txt">{d.title}</span></div>
          ))}
        </div>
      )}
      <Composer id={id} placeholder="Ask an agent about this client…" />
    </Card>
  );
});

// Swaps an empty output for a new one holding what was typed (outputs can't be edited in place).
async function fillOutput(id: string, text: string) {
  const s = useStore.getState();
  const row = s.board.find((r) => r.id === id);
  const nid = await api.saveOutput({ title: text.split('\n')[0].slice(0, 60), content: text });
  if (row) await api.saveBoard([{ ...row, id: nid }]);
  await api.deleteEntity(id);
  await s.refreshBoard(); await s.refresh(true);
}

export const OutputNode = memo(({ id, selected }: NodeProps) => {
  const e = useEntity(id); const [full, setFull] = useState(''); const [draft, setDraft] = useState(''); const wheel = useEditWheel();
  useEffect(() => { api.transcript(id).then((t) => setFull(t[0]?.text || '')).catch(() => {}); }, [id, e?.updatedAt]);
  if (!e) return <Gone />;
  const text = full || e.preview || '';
  if (!text.trim()) {
    return (
      <Card id={id} selected={selected} className="output-card empty" stripe={SOURCE.output.color}>
        <Top e={e} icon={<FileText size={13} />} label="Output" />
        <textarea className={`nodrag ${wheel.cls}`} rows={3} value={draft} placeholder="Write something…"
          onFocus={(ev) => wheel.check(ev.currentTarget)} onChange={(ev) => { setDraft(ev.target.value); wheel.check(ev.currentTarget); }} onKeyDown={(ev) => { if (!ev.metaKey && !ev.ctrlKey) ev.stopPropagation(); }}
          onBlur={() => { wheel.clear(); if (draft.trim()) fillOutput(id, draft.trim()); }} />
      </Card>
    );
  }
  return (
    <Card id={id} selected={selected} className="output-card" stripe={SOURCE.output.color}>
      <Top e={e} icon={<FileText size={13} />} label="Output" />
      <div className="card-title">{e.title}</div>
      <div className="md" dangerouslySetInnerHTML={{ __html: md(text) }} />
      <span className="grip nodrag" draggable onDragStart={(ev) => dragOutput(ev, { text, title: e.title, sourceId: id })} title="Drag onto a card to send it"><GripVertical size={13} /></span>
    </Card>
  );
});

const REPEATS = ['off', '15m', '1h', 'daily'] as const;
const REPEAT_LABEL: Record<string, string> = { '15m': 'Every 15 min', '1h': 'Every hour', daily: 'Daily 9am' };
type Sched = { every: string; next: number | null };
const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

// Notes edit in place: typing updates locally and saves after a short pause, without touching the board.
export const NoteNode = memo(({ id, selected }: NodeProps) => {
  const e = useEntity(id); const [text, setText] = useState(e?.preview || '');
  const ref = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(false); const saved = useRef(e?.preview || ''); const timer = useRef<any>(null);
  const [sched, setSched] = useState<Sched | null>(null);
  const target = useStore((s) => { const ed = s.edges.find((x) => x.source === id && PROMPTABLE(x.target) && x.data?.instruction !== false); return ed ? (s.byId[ed.target]?.title || 'agent') : ''; });
  const linked = !!target;
  const wheel = useEditWheel();
  useEffect(() => { if (!focused.current && e && e.preview !== saved.current) { saved.current = e.preview || ''; setText(saved.current); } }, [e?.preview]);
  useEffect(() => { if (focusNext === id && ref.current) { focusNext = null; ref.current.focus(); } });
  useEffect(() => {
    const load = () => api.call<Record<string, Sched>>('recurring:list').then((m) => setSched(m?.[id] || null)).catch(() => {});
    load(); const t = setInterval(load, 60000);
    return () => { clearInterval(t); clearTimeout(timer.current); };
  }, [id]);
  if (!e) return <Gone />;
  const save = (v: string) => { clearTimeout(timer.current); if (v === saved.current) return; saved.current = v; api.saveNote({ id, text: v }); };
  const cycle = async () => {
    const cur = sched?.every || 'off';
    const nxt = REPEATS[(REPEATS.indexOf(cur as any) + 1) % REPEATS.length];
    const m = await api.call<Record<string, Sched>>('recurring:set', id, nxt).catch(() => null);
    setSched(m?.[id] || null);
  };
  const repeating = !!sched && sched.every !== 'off';
  return (
    <Card id={id} selected={selected} className="note-card" minW={180} minH={100}>
      <div className="card-top">
        <span className="src"><StickyNote size={13} /><span className="src-name">Note</span></span>
        {repeating ? <span className="note-badge">Repeats</span> : linked ? <span className="note-badge" title={`Added to every prompt sent to ${target}`}>Instruction → {target}</span> : null}
        <button className={`note-clock nodrag ${repeating ? 'on' : ''}`} onClick={cycle}
          title={repeating ? `${REPEAT_LABEL[sched!.every]} — click to change` : 'Repeat: send this note to the connected agent on a schedule'}>
          <Clock size={12} />{repeating && <span>{REPEAT_LABEL[sched!.every]}</span>}
        </button>
      </div>
      <textarea ref={ref} className={`nodrag ${wheel.cls}`} value={text} placeholder="Write something…"
        onFocus={(ev) => { focused.current = true; wheel.check(ev.currentTarget); }}
        onChange={(ev) => { const v = ev.target.value; setText(v); wheel.check(ev.currentTarget); clearTimeout(timer.current); timer.current = setTimeout(() => save(v), 500); }}
        onBlur={() => { focused.current = false; wheel.clear(); save(text); }}
        onKeyDown={(ev) => { if (ev.key === 'Escape') ev.currentTarget.blur(); if (!ev.metaKey && !ev.ctrlKey) ev.stopPropagation(); }} />
      {repeating && sched!.next && <div className="note-next">{linked ? `Next run ${clock(sched!.next)}` : 'Draw a line to an agent to run it'}</div>}
    </Card>
  );
});

export const ErrorNode = memo(({ id, selected }: NodeProps) => {
  const e = useEntity(id); if (!e) return <Gone />;
  return <Card id={id} selected={selected}><div className="card-top"><span className="src"><AlertTriangle size={13} /><span className="src-name">Couldn't load</span></span></div><div className="well err">{e.title}</div></Card>;
});

function saveGroup(id: string, patch: Partial<BoardRow>, data: Record<string, any> = {}) {
  const s = useStore.getState();
  const r = s.board.find((b) => b.id === id); if (!r) return;
  const row = { ...r, ...patch, data: { ...r.data, ...data } };
  useStore.setState({ board: s.board.map((b) => (b.id === id ? row : b)) });
  return api.saveBoard([row]);
}

// A frame: soft tinted area with a name tab on its top edge and an optional goal the cards inside work toward.
export const GroupNode = memo(({ id, data, selected }: NodeProps) => {
  const d: any = data;
  const [label, setLabel] = useState(d.label || 'Group');
  const [editing, setEditing] = useState(false);
  const [goal, setGoal] = useState(d.goal || '');
  const [editGoal, setEditGoal] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef(false);
  const [pickAcc, setPickAcc] = useState(false);
  const claude = useStore(useShallow((s) => s.accounts.filter((a) => a.kind === 'claude-code').map((a) => `${a.id}\t${a.label}`)));
  const hasClaude = useStore((s) => s.board.some((r) => r.parent_id === id && !r.hidden && s.byId[r.id]?.source === 'claude-code' && s.byId[r.id]?.kind === 'session'));
  useEffect(() => { if (!editing) setLabel(d.label || 'Group'); }, [d.label]);
  useEffect(() => { if (!editGoal) setGoal(d.goal || ''); }, [d.goal]);
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);

  const commit = () => {
    setEditing(false);
    if (cancel.current) { cancel.current = false; setLabel(d.label || 'Group'); return; }
    const v = label.trim() || 'Group'; setLabel(v); if (v !== d.label) saveGroup(id, {}, { label: v });
  };
  const commitGoal = () => {
    setEditGoal(false);
    if (cancel.current) { cancel.current = false; setGoal(d.goal || ''); return; }
    const v = goal.trim(); setGoal(v); if (v !== (d.goal || '')) saveGroup(id, {}, { goal: v });
  };
  const keys = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    ev.stopPropagation();
    if (ev.key === 'Escape') cancel.current = true;
    if (ev.key === 'Enter' || ev.key === 'Escape') ev.currentTarget.blur();
  };
  const work = async () => {
    const s = useStore.getState();
    const targets = s.board.filter((r) => r.parent_id === id && !r.hidden && s.byId[r.id] && PROMPTABLE(r.id)).map((r) => r.id);
    if (!targets.length) { s.notify('No agents in this group'); return; }
    const text = `Goal for "${label}": ${goal}\n\nDo your part toward this goal, then reply with a short update.`;
    await Promise.all(targets.map((t) => sendPrompt(t, text, d.accountId ? { accountId: d.accountId } : {}).catch(() => null)));
    s.notify('Goal sent to the group');
  };

  return (
    <div className="frame" style={{ ['--g' as any]: d.color || '#71717A' }}>
      <NodeResizer isVisible={selected} minWidth={240} minHeight={140} lineClassName="frame-resize-line" handleClassName="frame-resize-handle"
        onResizeEnd={(_, p) => saveGroup(id, { x: p.x, y: p.y, w: p.width, h: p.height })} />
      <div className="frame-tab group-label" onDoubleClick={(ev) => { ev.stopPropagation(); setEditing(true); }} title="Double-click to rename">
        <i className="dot" />
        {editing ? (
          <input ref={input} className="nodrag" value={label} size={Math.max(4, label.length + 1)} onChange={(ev) => setLabel(ev.target.value)} onBlur={commit} onKeyDown={keys} />
        ) : <span className="name">{label}</span>}
        {claude.length > 0 && hasClaude && (d.accountId || pickAcc ? (
          <select className="frame-acc nodrag" value={d.accountId || ''} title="Agents in this frame run on this account" autoFocus={pickAcc && !d.accountId}
            onChange={(ev) => { setPickAcc(false); saveGroup(id, {}, { accountId: ev.target.value || null }); }} onBlur={() => setPickAcc(false)} onClick={(ev) => ev.stopPropagation()}>
            <option value="">No account</option>
            {claude.map((c) => { const [aid, l] = c.split('\t'); return <option key={aid} value={aid}>{l}</option>; })}
          </select>
        ) : (
          <button className="frame-acc-add nodrag" title="Dedicate this frame to an account" onClick={(ev) => { ev.stopPropagation(); setPickAcc(true); }}><UserRound size={11} /></button>
        ))}
      </div>
      <div className="frame-goal nodrag">
        {editGoal ? (
          <span className="goal-edit"><Target size={12} /><input autoFocus value={goal} placeholder="What should this group get done?" onChange={(ev) => setGoal(ev.target.value)} onBlur={commitGoal} onKeyDown={keys} /></span>
        ) : goal ? (<>
          <button className="goal-text" onClick={() => setEditGoal(true)} title="Edit goal"><Target size={12} /><span>{goal}</span></button>
          <button className="goal-go" onClick={work} title="Prompt every agent in this group with the goal"><Play size={10} />Work toward goal</button>
        </>) : (
          <button className={`goal-add ${selected ? 'on' : ''}`} onClick={() => setEditGoal(true)}><Target size={12} />Goal</button>
        )}
      </div>
    </div>
  );
});

function Gone() { return <div className="card gone" style={{ width: 220 }}><div className="card-sub">Gone</div></div>; }

export const nodeTypes = {
  session: SessionNode, account: AccountNode, project: ProjectNode, meeting: MeetingNode, thread: ThreadNode,
  client: ClientNode, output: OutputNode, note: NoteNode, error: ErrorNode, group: GroupNode,
};
