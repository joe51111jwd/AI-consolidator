import React, { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, NodeResizer, NodeProps } from '@xyflow/react';
import { GripVertical, FolderGit2, FileText, StickyNote, AlertTriangle, Target, Play } from 'lucide-react';
import { useStore } from '../lib/store';
import { useShallow } from 'zustand/react/shallow';
import { api, BoardRow, Entity } from '../lib/api';
import { ago, tokens, md, SOURCE, dueLabel, categoryOf, baseName, colorOf, PROMPTABLE } from '../lib/format';
import Composer from '../components/Composer';
import { AgentLogo } from '../components/Logos';

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

// A note the board just created by double-click focuses itself once it renders.
let focusNext: string | null = null;
export const focusNote = (id: string) => { focusNext = id; };

function Card({ w = 300, stripe, className = '', children }: { w?: number; stripe?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`card ${className}`} style={{ width: w, ['--stripe' as any]: stripe }}>
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

export const SessionNode = memo(({ id }: NodeProps) => {
  const e = useEntity(id); if (!e) return <Gone />;
  const cat = categoryOf(e);
  const folder = cat === 'coding' ? baseName(e.meta?.cwd) : '';
  const branch = e.meta?.gitBranch && !['main', 'master', 'HEAD'].includes(e.meta.gitBranch) ? e.meta.gitBranch : '';
  return (
    <Card stripe={colorOf(e, useStore.getState().accounts)}>
      <Top e={e} />
      <div className="card-title">{e.title}</div>
      {cat && (
        <div className="card-meta">
          <span className={`kind-chip ${cat}`}>{cat === 'coding' ? 'Code' : 'Chat'}</span>
          {folder && <span className="mono" title={e.meta?.cwd}>{folder}{branch && <em> · {branch}</em>}</span>}
        </div>
      )}
      <LiveOrPreview id={id} preview={e.preview} title={e.title} />
      <Composer id={id} placeholder="Reply…" />
    </Card>
  );
});

const PROMPT_ACCOUNTS = ['claude-code', 'codex', 'anthropic-api', 'openai-compatible', 'grok-bot'];

export const AccountNode = memo(({ id }: NodeProps) => {
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
  const max = Math.max(1, ...week);
  return (
    <Card stripe={color} className="account-card">
      <div className="acc-head">
        <div className="avatar" style={{ background: color }}><AgentLogo source={e.source} size={17} color="#fff" working={running > 0} /></div>
        <div className="acc-id">
          <div className="t">{e.title}</div>
          {sub && <div className="s" title={auth?.email || e.meta?.config?.configDir || ''}>{sub}</div>}
        </div>
        {running > 0 && <span className="status running"><i />Working</span>}
      </div>
      {u && (u.d7 > 0 || u.h5 > 0) && (
        <div className="acc-usage" title={`${tokens(u.h5)} in the last 5 hours · ${tokens(u.d1)} today · ${tokens(u.d7)} this week`}>
          <div className="bar"><i style={{ width: `${Math.max(2, (u.d7 / max) * 100)}%`, background: color }} /></div>
          <span>{tokens(u.d7)}</span>
        </div>
      )}
      <LiveOrPreview id={id} title={e.title} />
      {PROMPT_ACCOUNTS.includes(e.source) && <Composer id={id} placeholder={e.source === 'grok-bot' ? 'Hand off to Grok Bot…' : 'New session…'} />}
    </Card>
  );
});

export const ProjectNode = memo(({ id }: NodeProps) => {
  const e = useEntity(id); if (!e) return <Gone />;
  return (
    <Card>
      <Top e={e} icon={<FolderGit2 size={13} />} label={e.title} />
      <div className="card-sub mono">{e.preview}</div>
      <Composer id={id} placeholder="New task in this project…" />
    </Card>
  );
});

const TINTS = ['#D97757', '#2F6B55', '#6D5BD0', '#B08A2E', '#3F5E8C'];

export const MeetingNode = memo(({ id }: NodeProps) => {
  const e = useEntity(id); if (!e) return <Gone />;
  const people: any[] = e.meta?.attendees || [];
  const day = new Date(e.meta?.at || e.updatedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return (
    <Card stripe={SOURCE.granola.color}>
      <Top e={e} label={day} />
      <div className="card-title">{e.title}</div>
      {people.length > 0 && <div className="people">{people.slice(0, 5).map((p, i) => <span key={p.email || i} title={p.name || p.email} style={{ background: TINTS[i % TINTS.length] }}>{(p.name || p.email || '?').slice(0, 1).toUpperCase()}</span>)}</div>}
      <LiveOrPreview id={id} preview={e.preview} title={e.title} />
    </Card>
  );
});

export const ThreadNode = memo(({ id }: NodeProps) => {
  const e = useEntity(id); if (!e) return <Gone />;
  return (
    <Card stripe={colorOf(e, useStore.getState().accounts)}>
      <Top e={e} label={accountOf(e)?.label || 'Gmail'} />
      <div className="card-title">{e.title}</div>
      <LiveOrPreview id={id} preview={e.preview} title={e.title} />
    </Card>
  );
});

export const ClientNode = memo(({ id }: NodeProps) => {
  const e = useEntity(id); const due = useStore(useShallow((s) => s.due.filter((d) => `cl:${d.clientId}` === id)));
  if (!e) return <Gone />;
  const c = e.meta.client;
  const tone = c.status === 'lead' ? 'amber' : c.status === 'active' ? 'green' : '';
  return (
    <Card stripe="#2F6B55">
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

export const OutputNode = memo(({ id }: NodeProps) => {
  const e = useEntity(id); const [full, setFull] = useState(''); const [draft, setDraft] = useState('');
  useEffect(() => { api.transcript(id).then((t) => setFull(t[0]?.text || '')).catch(() => {}); }, [id, e?.updatedAt]);
  if (!e) return <Gone />;
  const text = full || e.preview || '';
  if (!text.trim()) {
    return (
      <Card className="output-card empty" stripe={SOURCE.output.color}>
        <Top e={e} icon={<FileText size={13} />} label="Output" />
        <textarea className="nodrag nowheel" rows={3} value={draft} placeholder="Write something…"
          onChange={(ev) => setDraft(ev.target.value)} onKeyDown={(ev) => { if (!ev.metaKey && !ev.ctrlKey) ev.stopPropagation(); }}
          onBlur={() => { if (draft.trim()) fillOutput(id, draft.trim()); }} />
      </Card>
    );
  }
  return (
    <Card className="output-card" stripe={SOURCE.output.color}>
      <Top e={e} icon={<FileText size={13} />} label="Output" />
      <div className="card-title">{e.title}</div>
      <div className="md" dangerouslySetInnerHTML={{ __html: md(text) }} />
      <span className="grip nodrag" draggable onDragStart={(ev) => dragOutput(ev, { text, title: e.title, sourceId: id })} title="Drag onto a card to send it"><GripVertical size={13} /></span>
    </Card>
  );
});

export const NoteNode = memo(({ id }: NodeProps) => {
  const e = useEntity(id); const [text, setText] = useState(e?.preview || '');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setText(e?.preview || ''); }, [e?.updatedAt]);
  useEffect(() => { if (focusNext === id && ref.current) { focusNext = null; ref.current.focus(); } });
  if (!e) return <Gone />;
  return (
    <Card w={260} className="note-card">
      <div className="card-top"><span className="src"><StickyNote size={13} /><span className="src-name">Note</span></span></div>
      <textarea ref={ref} className="nodrag nowheel" value={text} placeholder="Write something…" onChange={(ev) => setText(ev.target.value)} onBlur={() => { if (text !== (e.preview || '')) api.saveNote({ id, text }); }} onKeyDown={(ev) => { if (!ev.metaKey && !ev.ctrlKey) ev.stopPropagation(); }} />
    </Card>
  );
});

export const ErrorNode = memo(({ id }: NodeProps) => {
  const e = useEntity(id); if (!e) return <Gone />;
  return <Card><div className="card-top"><span className="src"><AlertTriangle size={13} /><span className="src-name">Couldn't load</span></span></div><div className="well err">{e.title}</div></Card>;
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
    await Promise.all(targets.map((t) => api.prompt(t, text).catch(() => null)));
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
