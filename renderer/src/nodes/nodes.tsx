import React, { memo, useEffect, useState } from 'react';
import { Handle, Position, NodeResizer, NodeProps } from '@xyflow/react';
import { GripVertical, FolderGit2, Mail, CalendarDays, FileText, StickyNote, Building2, AlertTriangle, ExternalLink } from 'lucide-react';
import { useStore } from '../lib/store';
import { useShallow } from 'zustand/react/shallow';
import { api, Entity } from '../lib/api';
import { ago, tokens, md, SOURCE, dueLabel } from '../lib/format';
import Composer from '../components/Composer';
import ClaudeMark, { isClaude } from '../components/ClaudeMark';

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

function Top({ e, color, label }: { e: Entity; color?: string; label?: string }) {
  const acc = accountOf(e);
  const src = SOURCE[e.source] || { label: e.source, color: '#999' };
  return (
    <div className="card-top">
      <span className="src">{isClaude(e.source) ? <ClaudeMark color={color || acc?.color || src.color} /> : <i style={{ background: color || acc?.color || src.color }} />}{label || (acc ? acc.label : src.label)}</span>
      {e.status && e.kind === 'session' && <span className={`status ${e.status}`}><i />{e.status === 'running' ? 'Working' : e.status === 'waiting' ? 'Your turn' : ''}</span>}
      <span className="when">{ago(e.updatedAt)}</span>
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
        {live.text && <span className="grip" draggable onDragStart={(ev) => dragOutput(ev, { text: live.text, title: `Reply from ${title}`, sourceId: id })} title="Drag this reply onto another card"><GripVertical size={13} /></span>}
      </div>
    );
  }
  if (!preview) return null;
  return (
    <div className="well clamp">
      {preview}
      <span className="grip nodrag" draggable onDragStart={async (ev) => {
        dragOutput(ev, { text: preview, title: `From ${title}`, sourceId: id });
      }} title="Drag onto another card"><GripVertical size={13} /></span>
    </div>
  );
}

export const SessionNode = memo(({ id }: NodeProps) => {
  const e = useEntity(id); if (!e) return <Gone />;
  return (
    <div className="card" style={{ width: 300, borderLeft: `3px solid ${accountOf(e)?.color || SOURCE[e.source]?.color || 'transparent'}` }}>
      <Handles />
      <Top e={e} />
      <div className="card-title">{e.title}</div>
      {e.meta?.cwd && <div className="card-sub mono">{shortPath(e.meta.cwd)}{e.meta.gitBranch ? ` · ${e.meta.gitBranch}` : ''}</div>}
      <LiveOrPreview id={id} preview={e.preview} title={e.title} />
      <Composer id={id} placeholder={e.source === 'gmail' ? 'Ask about this thread…' : 'Reply…'} />
    </div>
  );
});

function shortPath(p: string) { return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~'); }

export const AccountNode = memo(({ id }: NodeProps) => {
  const e = useEntity(id); const allUsage = useStore(useShallow((s) => s.entities.filter((x) => x.kind === 'account').map((x) => x.meta?.usage?.h5 || 0)));
  const sessions = useStore(useShallow((s) => s.entities.filter((x) => x.accountId === e?.accountId && x.kind !== 'account' && x.kind !== 'error')));
  if (!e) return <Gone />;
  const src = SOURCE[e.source] || { label: e.source, color: '#888' };
  const u = e.meta?.usage;
  const max = Math.max(1, ...allUsage);
  const running = sessions.filter((s) => s.status === 'running').length;
  const color = e.meta?.color || src.color;
  const auth = e.meta?.config?.auth;
  const sub = e.source === 'claude-code'
    ? (auth?.loggedIn ? [auth.org, auth.plan && auth.plan[0].toUpperCase() + auth.plan.slice(1)].filter(Boolean).join(' · ') || auth.email || 'Signed in' : auth ? 'Not signed in' : (e.meta?.config?.configDir || '~/.claude'))
    : src.label;
  return (
    <div className="card" style={{ width: 280, borderLeft: `3px solid ${color}` }}>
      <Handles />
      <div className="acc-head">
        <div className="avatar" style={{ background: color }}>{isClaude(e.source) ? <ClaudeMark size={18} color="#fff" /> : e.title.slice(0, 1)}</div>
        <div style={{ minWidth: 0 }}>
          <div className="t">{e.title}</div>
          <div className={`s ${e.source === 'claude-code' && !auth ? 'mono' : ''}`} title={auth?.email || e.meta?.config?.configDir || ''}>{sub}</div>
        </div>
      </div>
      {u ? (
        <div className="meter">
          <div className="meter-row"><span>5 hr</span><div className="bar"><i style={{ width: `${(u.h5 / max) * 100}%`, background: color }} /></div><b>{tokens(u.h5)}</b></div>
          <div className="stats"><span><b>{tokens(u.d1)}</b> today</span><span><b>{tokens(u.d7)}</b> 7 days</span></div>
        </div>
      ) : e.source === 'grok-bot' ? (
        <div className="well">No public API. Grok Bot reaches your other agents with the <span className="mono">sb</span> command, and those messages show up here.</div>
      ) : null}
      <LiveOrPreview id={id} title={e.title} />
      {(e.source === 'claude-code' || e.source === 'codex' || e.source === 'cursor' || e.source.endsWith('api') || e.source === 'openai-compatible' || e.source === 'gmail' || e.source === 'granola') && (
        <div className="stats"><span><b>{sessions.length}</b> {e.source === 'gmail' ? 'threads' : e.source === 'granola' ? 'meetings' : 'sessions'}</span>{running > 0 && <span className="status running"><i /><b>{running}</b>&nbsp;working</span>}</div>
      )}
      {['claude-code', 'codex', 'anthropic-api', 'openai-compatible', 'grok-bot'].includes(e.source) && (
        <Composer id={id} placeholder={e.source === 'grok-bot' ? 'Hand something to Grok Bot…' : 'Start a new session…'} />
      )}
    </div>
  );
});

export const ProjectNode = memo(({ id }: NodeProps) => {
  const e = useEntity(id); if (!e) return <Gone />;
  const branches: any[] = e.meta?.branches || [];
  const agentColor: Record<string, string> = { grok: SOURCE['grok-bot'].color, claude: SOURCE['claude-code'].color, codex: SOURCE.codex.color, cursor: SOURCE.cursor.color };
  return (
    <div className="card" style={{ width: 300 }}>
      <Handles />
      <div className="acc-head">
        <div className="avatar" style={{ background: 'var(--accent)' }}><FolderGit2 size={17} /></div>
        <div style={{ minWidth: 0 }}>
          <div className="t">{e.title}</div>
          <div className="s mono">{e.preview}</div>
        </div>
      </div>
      <div className="stats"><span><b>{e.meta?.sessions?.length || 0}</b> sessions</span><span>active {ago(e.updatedAt)}</span></div>
      {branches.length > 0 && (
        <div className="branches">
          {branches.slice(0, 4).map((b) => (
            <div className="branch" key={b.name}>
              <span className="chip" style={b.agent ? { background: agentColor[b.agent] || 'var(--ink)', color: '#fff' } : {}}>{b.agent || 'branch'}</span>
              <span className="mono">{b.name}</span><span className="when">{ago(b.at)}</span>
            </div>
          ))}
        </div>
      )}
      <Composer id={id} placeholder="New task in this project…" />
    </div>
  );
});

export const MeetingNode = memo(({ id }: NodeProps) => {
  const e = useEntity(id); if (!e) return <Gone />;
  const people: any[] = e.meta?.attendees || [];
  const tints = ['#C0603E', '#3F7A5E', '#7A5A8C', '#B08A2E', '#4E6E7E'];
  return (
    <div className="card" style={{ width: 280 }}>
      <Handles />
      <div className="card-top"><span className="src"><CalendarDays size={12} />{new Date(e.meta?.at || e.updatedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span><span className="when">Granola</span></div>
      <div className="card-title">{e.title}</div>
      {people.length > 0 && <div className="people">{people.slice(0, 5).map((p, i) => <span key={p.email} title={p.name || p.email} style={{ background: tints[i % tints.length] }}>{(p.name || p.email).slice(0, 1).toUpperCase()}</span>)}</div>}
      <LiveOrPreview id={id} preview={e.preview} title={e.title} />
    </div>
  );
});

export const ThreadNode = memo(({ id }: NodeProps) => {
  const e = useEntity(id); if (!e) return <Gone />;
  return (
    <div className="card" style={{ width: 290 }}>
      <Handles />
      <div className="card-top"><span className="src"><Mail size={12} />{accountOf(e)?.label || 'Gmail'}</span>{e.status === 'waiting' && <span className="chip amber">Waiting on you</span>}<span className="when">{ago(e.updatedAt)}</span></div>
      <div className="card-title">{e.title}</div>
      <LiveOrPreview id={id} preview={e.preview} title={e.title} />
    </div>
  );
});

export const ClientNode = memo(({ id }: NodeProps) => {
  const e = useEntity(id); const due = useStore(useShallow((s) => s.due.filter((d) => `cl:${d.clientId}` === id)));
  if (!e) return <Gone />;
  const c = e.meta.client;
  const tone = c.status === 'lead' ? 'amber' : c.status === 'active' ? 'green' : '';
  return (
    <div className="card" style={{ width: 280 }}>
      <Handles />
      <div className="acc-head">
        <div className="avatar" style={{ background: '#2F6B55' }}><Building2 size={16} /></div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="t">{c.name}</div>
          <div className="s">{c.company || c.domains[0] || c.emails[0] || 'Client'}</div>
        </div>
        <span className={`chip ${tone}`}>{c.status}</span>
      </div>
      {due.length > 0 ? (
        <div className="due-list">
          {due.slice(0, 3).map((d) => (
            <div key={d.id} className="branch"><span className={`chip ${d.overdue ? 'red' : 'amber'}`}>{dueLabel(d.due) || 'Open'}</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span></div>
          ))}
        </div>
      ) : <div className="card-sub">Nothing due</div>}
      {c.value ? <div className="stats"><span><b>${Number(c.value).toLocaleString()}</b> deal</span></div> : null}
      <Composer id={id} placeholder="Ask an agent to work on this client…" />
    </div>
  );
});

export const OutputNode = memo(({ id }: NodeProps) => {
  const e = useEntity(id); const [full, setFull] = useState('');
  useEffect(() => { api.transcript(id).then((t) => setFull(t[0]?.text || '')).catch(() => {}); }, [id, e?.updatedAt]);
  if (!e) return <Gone />;
  return (
    <div className="card output-card" style={{ width: 300 }}>
      <Handles />
      <div className="card-top"><span className="src"><FileText size={12} />Output</span><span className="when">{ago(e.updatedAt)}</span></div>
      <div className="card-title">{e.title}</div>
      <div className="md" dangerouslySetInnerHTML={{ __html: md(full || e.preview || '') }} />
      <span className="grip nodrag" style={{ opacity: 1 }} draggable onDragStart={(ev) => dragOutput(ev, { text: full, title: e.title, sourceId: id })} title="Drag onto a card to send it"><GripVertical size={13} /></span>
    </div>
  );
});

export const NoteNode = memo(({ id }: NodeProps) => {
  const e = useEntity(id); const [text, setText] = useState(e?.preview || '');
  useEffect(() => { setText(e?.preview || ''); }, [e?.updatedAt]);
  if (!e) return <Gone />;
  return (
    <div className="card note-card" style={{ width: 240 }}>
      <Handles />
      <div className="card-top"><span className="src"><StickyNote size={12} />Note</span></div>
      <textarea className="nodrag nowheel" value={text} placeholder="Write something…" onChange={(ev) => setText(ev.target.value)} onBlur={() => api.saveNote({ id, text })} onKeyDown={(ev) => ev.stopPropagation()} />
    </div>
  );
});

export const ErrorNode = memo(({ id }: NodeProps) => {
  const e = useEntity(id); if (!e) return <Gone />;
  return <div className="card" style={{ width: 280 }}><div className="card-top"><span className="src"><AlertTriangle size={12} />Couldn't load</span></div><div className="well err">{e.title}</div></div>;
});

export const GroupNode = memo(({ id, data, selected }: NodeProps) => {
  const d: any = data;
  const [label, setLabel] = useState(d.label || 'Group');
  return (
    <div className="group">
      <NodeResizer isVisible={selected} minWidth={240} minHeight={160} onResizeEnd={(_, p) => api.saveBoard([{ id, x: p.x, y: p.y, w: p.width, h: p.height, parent_id: null, data: d }])} />
      <div className="group-label">
        <i style={{ width: 8, height: 8, borderRadius: 3, background: d.color || 'var(--ink-3)', display: 'inline-block' }} />
        <input className="nodrag" value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => api.saveBoard([{ id, x: d.x, y: d.y, w: d.w, h: d.h, parent_id: null, data: { ...d, label } }])} onKeyDown={(e) => e.stopPropagation()} />
        {d.count != null && <span className="n">{d.count}</span>}
      </div>
    </div>
  );
});

function Gone() { return <div className="card" style={{ width: 220, opacity: .6 }}><div className="card-sub">No longer available</div></div>; }

export const nodeTypes = {
  session: SessionNode, account: AccountNode, project: ProjectNode, meeting: MeetingNode, thread: ThreadNode,
  client: ClientNode, output: OutputNode, note: NoteNode, error: ErrorNode, group: GroupNode,
};
