import React, { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, NodeResizer, NodeProps } from '@xyflow/react';
import { GripVertical, FolderGit2, FileText, StickyNote, AlertTriangle, MessageSquare, Zap, Wrench, Plug, Bot, Info, GitPullRequest, EyeOff, MessageSquarePlus } from 'lucide-react';
import { useStore } from '../lib/store';
import { useShallow } from 'zustand/react/shallow';
import { api, BoardRow, Entity } from '../lib/api';
import { ago, tokens, md, SOURCE, dueLabel, categoryOf, baseName, colorOf } from '../lib/format';
import Composer from '../components/Composer';
import { AgentLogo } from '../components/Logos';
import { GrokAvatar, GroupAvatar, botLook } from '../components/GrokAvatar';
import { useAttention, needsAttention, useSeen } from '../lib/attention';
import { ARRANGED_KEY, COMPACT_H } from '../lib/layout';

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
  const busy = useStore((s) => s.liveByEntity[id]?.status === 'running' || s.byId[id]?.status === 'running');
  const attn = useAttention(id);
  return (
    <div className={`card ${sized ? 'sized' : ''} ${busy ? 'is-running' : ''} ${attn ? 'needs-you' : ''} ${className}`} style={{ ['--stripe' as any]: stripe }}>
      {attn && <span className="attn-dot" title="Needs you" />}
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
        {live.text ? live.text.slice(-400) : live.status === 'stopped' ? 'Stopped' : 'Working…'}
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
type Sub = { id: string; title: string; status: 'running' | 'done'; updatedAt?: number; lastText?: string; prUrl?: string };
type Pill = 'running' | 'waiting' | 'done' | 'error' | null;
const PILL_LABEL: Record<string, string> = { running: 'Working', waiting: 'Your turn', done: 'Done', error: 'Failed' };
const RECENT = 120000;

// Plain text for one-line previews: links keep their words, bare URLs and markdown symbols go.
const plain = (t?: unknown) => (typeof t === 'string' ? t : '')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/<?https?:\/\/[^\s)>]+>?/g, '')
  .replace(/[#*_`>]+/g, '')
  .replace(/\(\s*\)/g, '');
const oneLine = (t?: unknown) => plain(t).replace(/\s+/g, ' ').trim().slice(0, 240);
// The last line worth showing; a line that only introduces what follows ("…came in today:") is skipped.
const lastLine = (t?: string) => {
  const lines = (t || '').split('\n').map(oneLine).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) if (!lines[i].endsWith(':') || i === 0) return lines[i];
  return '';
};

function usePill(e: Entity, extraRunning = false): Pill {
  const live = useStore((s) => s.liveByEntity[e.id]);
  if (extraRunning || live?.status === 'running' || e.status === 'running') return 'running';
  if (e.status === 'waiting') return 'waiting';
  if (live?.status === 'error' || e.status === 'error') return 'error';
  if (live?.status === 'done' && Date.now() - live.startedAt < 10 * 60000) return 'done';
  return null;
}

// The latest thing a card said: a run that just streamed in wins over the stored preview.
function useLatest(id: string, preview?: string): { text: string; live: boolean; error?: string } {
  const live = useStore((s) => s.liveByEntity[id]);
  if (live && (live.status === 'running' || Date.now() - live.startedAt < RECENT)) {
    if (live.status === 'error') return { text: '', live: false, error: live.error || 'Failed' };
    if (live.status === 'stopped' && !live.text) return { text: preview || '', live: false };
    return { text: live.text || '', live: live.status === 'running' };
  }
  return { text: preview || '', live: false };
}

const sortSubs = <T extends Sub>(subs: T[]) =>
  [...subs].sort((a, b) => (a.status === b.status ? (b.updatedAt || 0) - (a.updatedAt || 0) : a.status === 'running' ? -1 : 1));

function subsLabel(subs: Sub[]) {
  if (!subs.length) return '';
  const run = subs.filter((s) => s.status === 'running').length;
  return `${subs.length} agent${subs.length === 1 ? '' : 's'}${run ? `, ${run} running` : ''}`;
}

function StatusPill({ pill }: { pill: Pill }) {
  if (!pill) return null;
  return <span className={`status-pill ${pill}`}>{pill === 'running' && <i />}{PILL_LABEL[pill]}</span>;
}

// Row 2: what it's doing right now (shimmering while it works), else the latest reply.
function NowLine({ running, now, fallback, error }: { running: boolean; now?: string; fallback?: string; error?: string }) {
  if (error) return <div className="card-now err" title={error}>{error}</div>;
  if (running) return <div className="card-now act-now" title={now}>▸ <span className="shimmer">{oneLine(now) || 'Thinking'}</span></div>;
  const t = oneLine(fallback);
  return <div className={`card-now ${t ? '' : 'empty'}`} title={t}>{t || 'Nothing yet'}</div>;
}

function Meta({ parts, chip }: { parts: (React.ReactNode | false | null | undefined | '')[]; chip?: string }) {
  const shown = parts.filter((x) => x !== false && x != null && x !== '');
  return (
    <div className="card-meta">
      {shown.map((p, i) => <React.Fragment key={i}>{i > 0 && <span className="sep">·</span>}<span className="m">{p}</span></React.Fragment>)}
      {chip && <span className="meta-chip">{chip}</span>}
    </div>
  );
}

function Reply({ id, text, title, live }: { id: string; text: string; title: string; live?: boolean }) {
  if (!text.trim()) return null;
  const shown = live ? text.slice(-700) : text.slice(0, 1600);
  return (
    <div className={`card-reply ${live ? 'live' : ''}`}>
      <div className="md" dangerouslySetInnerHTML={{ __html: md(shown) }} />
      <span className="grip nodrag" draggable onDragStart={(ev) => dragOutput(ev, { text, title: `Reply from ${title}`, sourceId: id })} title="Drag onto another card"><GripVertical size={13} /></span>
    </div>
  );
}

function SubRows({ id, subs }: { id: string; subs: Sub[] }) {
  if (!subs.length) return null;
  const sorted = sortSubs(subs);
  const open = (ev: React.MouseEvent) => { ev.stopPropagation(); useStore.getState().open(id); };
  return (
    <div className="subagents">
      {sorted.slice(0, 4).map((s) => (
        <button key={s.id} className="sub-row nodrag" onClick={open} title={s.lastText || s.title}>
          <i className={`sub-dot ${s.status}`} /><span className="sub-t">{s.title}</span>
          {s.prUrl && <a className="sub-pr" href={s.prUrl} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()} title="Pull request"><GitPullRequest size={11} /></a>}
          <span className="sub-age">{ago(s.updatedAt)}</span>
        </button>
      ))}
      {sorted.length > 4 && <button className="sub-more nodrag" onClick={open}>{sorted.length - 4} more</button>}
    </div>
  );
}

// What the drawer adds to the card's face: what was asked and the step before the current one.
function Steps({ steps }: { steps: [string, string | undefined][] }) {
  const shown = steps.filter(([, v]) => oneLine(v));
  if (!shown.length) return null;
  return (
    <div className="card-steps">
      {shown.map(([k, v]) => <div key={k} className="step" title={oneLine(v)}><b>{k}</b>{oneLine(v)}</div>)}
    </div>
  );
}

// The compact card: one line of who/what + status, one line of "now", one line of meta.
// Hover, select or focus opens the drawer (reply, agents, composer) over whatever sits below,
// so the card's footprint on the board never changes. Resized cards show the drawer in place.
function Compact({ id, selected, stripe, className = '', avatar, title, pill, extra, now, meta, children }: {
  id: string; selected?: boolean; stripe?: string; className?: string; avatar: React.ReactNode; title: string;
  pill?: Pill; extra?: React.ReactNode; now: React.ReactNode; meta: React.ReactNode; children?: React.ReactNode;
}) {
  const sized = useStore((s) => !!s.board.find((b) => b.id === id)?.h);
  const inspected = useStore((s) => s.inspector === id);
  const attn = useAttention(id);
  // While the card is open in the inspector, that is where you read and reply; the card stays compact.
  const drawer = !inspected && React.Children.toArray(children).length > 0;
  return (
    <div className={`card v2 ${sized ? 'sized' : ''} ${inspected ? 'inspected' : ''} ${pill === 'running' ? 'is-running' : ''} ${attn ? 'needs-you' : ''} ${className}`} style={{ ['--stripe' as any]: stripe }}>
      <NodeResizer isVisible={!!selected} minWidth={220} minHeight={COMPACT_H} lineClassName="card-resize-line" handleClassName="card-resize-handle"
        onResizeEnd={(_, p) => saveSize(id, p)} />
      <Handles />
      <div className="card-face">
        {stripe && <span className="card-stripe" />}
        {attn && <span className="attn-dot" title="Needs you" />}
        <div className="card-row">
          <span className="card-av">{avatar}</span>
          <div className="card-title" title={title}>{title}</div>
          <StatusPill pill={pill || null} />
          {extra}
        </div>
        {now}
        {meta}
        {drawer && <div className="card-more"><div className="card-more-in">{children}</div></div>}
      </div>
    </div>
  );
}

type GrokAction = { kind: 'message' | 'event' | 'tool' | 'connector' | 'agent' | 'notice'; text: string; ts?: number };
const ACTION_ICON: Record<string, React.ReactNode> = {
  message: <MessageSquare size={11} />, event: <Zap size={11} />, tool: <Wrench size={11} />,
  connector: <Plug size={11} />, agent: <Bot size={11} />, notice: <Info size={11} />,
};

// A Grok bot is a hub: its own avatar, what it's doing now, what it did, and the agents it launched.
// A group chat shows its bots as clustered avatars; people in it (you) are left out of the title.
function useGroupMembers(id: string, e: Entity) {
  const isGroup = !!e.meta?.isGroup || (e.title || '').includes(',');
  const bots = useStore(useShallow((s) => (isGroup ? s.entities.filter((x) => x.source === 'grok-bot' && x.kind === 'session' && x.id !== id && !(x.title || '').includes(','))
    .map((x) => `${x.id}\t${(x.title || '').trim().toLowerCase()}\t${x.title}\t${x.meta?.avatarColor || ''}\t${x.meta?.avatarShape || ''}`) : [])));
  if (!isGroup) return { isGroup, title: e.title, members: [] as { color?: string; shape?: string; seed?: string }[] };
  const parts = (e.title || '').split(',').map((t) => t.trim()).filter(Boolean);
  const known = parts.map((p) => bots.find((b) => b.split('\t')[1] === p.toLowerCase())).filter(Boolean).map((b) => b!.split('\t'));
  const members = Array.isArray(e.meta?.members) && e.meta.members.length ? e.meta.members
    : known.length ? known.map(([bid, , , color, shape]) => ({ seed: bid, color: color || undefined, shape: shape || undefined }))
    : parts.map((p) => ({ seed: p }));
  return { isGroup, title: known.length ? known.map((k) => k[2]).join(', ') : e.title, members };
}

function GrokNode({ id, e, selected }: { id: string; e: Entity; selected?: boolean }) {
  const running = useRunning(e);
  const look = botLook(id, e.meta?.avatarColor, e.meta?.avatarShape);
  const a: Activity | undefined = e.meta?.activity;
  const actions: GrokAction[] = Array.isArray(e.meta?.actions) ? e.meta.actions : [];
  const subs: Sub[] = Array.isArray(e.meta?.subagents) ? e.meta.subagents : [];
  // A Claude CLI run the bot launched counts as the bot working.
  const live = running || !!a?.running || subs.some((x) => x.status === 'running');
  const pill = usePill(e, live);
  const latest = useLatest(id, a?.text || actions[0]?.text || e.preview);
  const attn = useAttention(id);
  const group = useGroupMembers(id, e);
  const nowText = live ? (a?.tool || a?.text || subs.find((x) => x.status === 'running')?.title) : '';
  const shownNow = oneLine(live ? nowText : latest.text);
  // The card already shows the now line; previews are cut short, so compare their starts.
  const head = shownNow.replace(/…$/, '').slice(0, 60);
  const feed = actions.filter((x) => { const t = oneLine(x.text); return t && (!head || t.slice(0, head.length) !== head); });
  const when = e.meta?.lastActivityAt || e.updatedAt;
  return (
    <Compact id={id} selected={selected} stripe={look.color} className="grok-card" title={group.title} pill={pill}
      avatar={group.isGroup ? <GroupAvatar members={group.members} size={20} attention={attn} /> : <GrokAvatar color={look.color} shape={look.shape} seed={id} size={20} working={live} attention={attn} title={e.title} />}
      extra={<button className="grok-hide nodrag" title="Hide bot" onClick={(ev) => { ev.stopPropagation(); (window as any).__sbHide?.([id]); }}><EyeOff size={11} /></button>}
      now={<NowLine running={live} now={nowText} fallback={latest.text} error={latest.error} />}
      meta={<Meta parts={['Grok', e.meta?.unreadCount > 0 && `${e.meta.unreadCount} unread`, when > 0 ? ago(when) : '—']} chip={subsLabel(subs)} />}>
      {feed.length > 0 && (
        <div className="grok-feed nowheel">
          {feed.slice(0, 15).map((x, i) => (
            <div key={`${x.ts}-${i}`} className={`grok-act ${i >= 3 ? 'extra' : ''}`} title={oneLine(x.text)}>
              <span className="ic">{ACTION_ICON[x.kind] || ACTION_ICON.notice}</span><span className="t">{oneLine(x.text)}</span><span className="age">{ago(x.ts)}</span>
            </div>
          ))}
        </div>
      )}
      <SubRows id={id} subs={subs} />
      <Composer id={id} placeholder="Message…" />
    </Compact>
  );
}

export const SessionNode = memo(({ id, selected }: NodeProps) => {
  const e = useEntity(id); if (!e) return <Gone />;
  if (e.source === 'grok-bot') return <GrokNode id={id} e={e} selected={selected} />;
  return <AgentCard id={id} e={e} selected={selected} />;
});

function AgentCard({ id, e, selected }: { id: string; e: Entity; selected?: boolean }) {
  const pill = usePill(e);
  const latest = useLatest(id, e.preview);
  const acc = accountOf(e);
  const src = SOURCE[e.source] || { label: e.source, color: '#71717A' };
  const cat = categoryOf(e);
  const folder = cat === 'coding' ? baseName(e.meta?.cwd) : '';
  const branch = e.meta?.gitBranch && !['main', 'master', 'HEAD'].includes(e.meta.gitBranch) ? e.meta.gitBranch : '';
  const a: Activity | undefined = e.meta?.activity;
  const subs: Sub[] = Array.isArray(e.meta?.subagents) ? e.meta.subagents : [];
  const running = pill === 'running';
  const sized = useStore((s) => !!s.board.find((b) => b.id === id)?.h);
  const now = a?.tool || lastLine(a?.text) || lastLine(latest.text);
  return (
    <Compact id={id} selected={selected} stripe={colorOf(e, useStore.getState().accounts)} title={e.title} pill={pill}
      avatar={<AgentLogo source={e.source} size={16} color={acc?.color || src.color} working={running} />}
      now={<NowLine running={running} now={now} fallback={latest.text} error={latest.error} />}
      meta={<Meta parts={[acc?.label || src.label, cat && <span className={`kind-chip ${cat}`}>{cat === 'coding' ? 'Code' : 'Chat'}</span>, folder && <span className="mono" title={e.meta?.cwd}>{folder}{branch && <em> · {branch}</em>}</span>, ago(e.updatedAt)]} chip={subsLabel(subs)} />}>
      <Steps steps={[['Asked', a?.prompt], ['Said', running && a?.tool ? a?.text : undefined]]} />
      {sized && <Reply id={id} text={latest.text} title={e.title} live={latest.live} />}
      <SubRows id={id} subs={subs} />
      <Composer id={id} placeholder="Reply…" />
    </Compact>
  );
}

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
  return <MeetingCard id={id} e={e} selected={selected} />;
});

function MeetingCard({ id, e, selected }: { id: string; e: Entity; selected?: boolean }) {
  const latest = useLatest(id, e.preview);
  const pill = usePill(e);
  const people: any[] = e.meta?.attendees || [];
  const day = new Date(e.meta?.at || e.updatedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const faces = people.length > 0 && (
    <span className="people">{people.slice(0, 4).map((p, i) => <span key={p.email || i} title={p.name || p.email} style={{ background: TINTS[i % TINTS.length] }}>{(p.name || p.email || '?').slice(0, 1).toUpperCase()}</span>)}{people.length > 4 && <em>+{people.length - 4}</em>}</span>
  );
  return (
    <Compact id={id} selected={selected} stripe={SOURCE.granola.color} title={e.title} pill={pill}
      avatar={<AgentLogo source="granola" size={16} color={SOURCE.granola.color} working={pill === 'running'} />}
      now={<NowLine running={pill === 'running'} now={lastLine(latest.text)} fallback={latest.text} error={latest.error} />}
      meta={<Meta parts={[day, faces]} />}>
      <Reply id={id} text={latest.text} title={e.title} live={latest.live} />
    </Compact>
  );
}

export const ThreadNode = memo(({ id, selected }: NodeProps) => {
  const e = useEntity(id); if (!e) return <Gone />;
  return <ThreadCard id={id} e={e} selected={selected} />;
});

function ThreadCard({ id, e, selected }: { id: string; e: Entity; selected?: boolean }) {
  const latest = useLatest(id, e.preview);
  const pill = usePill(e);
  const color = colorOf(e, useStore.getState().accounts);
  return (
    <Compact id={id} selected={selected} stripe={color} title={e.title} pill={pill}
      avatar={<AgentLogo source={e.source} size={16} color={color} working={pill === 'running'} />}
      now={<NowLine running={pill === 'running'} now={lastLine(latest.text)} fallback={latest.text} error={latest.error} />}
      meta={<Meta parts={[accountOf(e)?.label || 'Gmail', ago(e.updatedAt)]} />}>
      <Reply id={id} text={latest.text} title={e.title} live={latest.live} />
    </Compact>
  );
}

export const ClientNode = memo(({ id, selected }: NodeProps) => {
  const e = useEntity(id); const due = useStore(useShallow((s) => s.due.filter((d) => `cl:${d.clientId}` === id)));
  const pill = useStore((s) => (s.liveByEntity[id]?.status === 'running' ? 'running' as const : null));
  if (!e) return <Gone />;
  const c = e.meta.client;
  const tone = c.status === 'lead' ? 'amber' : c.status === 'active' ? 'green' : '';
  const next = due[0];
  const company = c.company || c.domains?.[0] || c.emails?.[0] || 'Client';
  return (
    <Compact id={id} selected={selected} stripe="#2F6B55" title={c.name} pill={pill}
      avatar={<span className="client-av">{(c.name || '?').slice(0, 1).toUpperCase()}</span>}
      extra={!pill && c.status ? <span className={`status-pill client ${tone}`}>{c.status}</span> : null}
      now={next
        ? <div className="card-now" title={next.title}><span className={`due-tag ${next.overdue ? 'red' : ''}`}>{dueLabel(next.due) || 'Open'}</span>{next.title}</div>
        : <NowLine running={false} fallback={c.next_action || c.notes || company} />}
      meta={<Meta parts={[company, due.length > 1 && `${due.length} open`]} />}>
      {due.length > 1 && (
        <div className="due-lines">
          {due.slice(0, 4).map((d) => (
            <div key={d.id} className="due-line"><span className={`chip ${d.overdue ? 'red' : 'amber'}`}>{dueLabel(d.due) || 'Open'}</span><span className="txt">{d.title}</span></div>
          ))}
        </div>
      )}
      <Composer id={id} placeholder="Ask an agent about this client…" />
    </Compact>
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
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const body = lines[0] && oneLine(lines[0]) === oneLine(e.title) ? lines.slice(1).join(' ') : lines.join(' ');
  return (
    <Compact id={id} selected={selected} className="output-card" stripe={SOURCE.output.color} title={e.title}
      avatar={<FileText size={15} />}
      now={<NowLine running={false} fallback={body} />}
      meta={<Meta parts={['Output', ago(e.updatedAt)]} />}>
      <div className="card-reply">
        <div className="md" dangerouslySetInnerHTML={{ __html: md(text) }} />
        <span className="grip nodrag" draggable onDragStart={(ev) => dragOutput(ev, { text, title: e.title, sourceId: id })} title="Drag onto a card to send it"><GripVertical size={13} /></span>
      </div>
    </Compact>
  );
});

// Starts a new chat with the note's text and parks the new session card beside the note once it shows up.
async function startChatFromNote(noteId: string, accountId: string, text: string) {
  const st = useStore.getState();
  const before = new Set(st.entities.filter((x) => x.kind === 'session').map((x) => x.id));
  try { await api.prompt(`ac:${accountId}`, text); } catch (err: any) { st.notify(err.message); return; }
  st.notify('Chat started');
  for (let i = 0; i < 20; i++) {
    await new Promise((res) => setTimeout(res, 1500));
    const s = useStore.getState();
    const fresh = s.entities.find((x) => x.kind === 'session' && !before.has(x.id) && (!x.accountId || x.accountId === accountId));
    const note = s.board.find((b) => b.id === noteId);
    if (!fresh || !note) continue;
    await api.saveBoard([{ id: fresh.id, x: note.x + (note.w || 260) + 40, y: note.y, parent_id: note.parent_id || null, data: {} }]);
    await s.refreshBoard();
    return;
  }
}

// Notes edit in place: typing updates locally and saves after a short pause, without touching the board.
export const NoteNode = memo(({ id, selected }: NodeProps) => {
  const e = useEntity(id); const [text, setText] = useState(e?.preview || '');
  const ref = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(false); const saved = useRef(e?.preview || ''); const timer = useRef<any>(null);
  const [picking, setPicking] = useState(false);
  const claude = useStore(useShallow((s) => s.accounts.filter((a) => a.kind === 'claude-code').map((a) => `${a.id}\t${a.label}`)));
  const wheel = useEditWheel();
  useEffect(() => { if (!focused.current && e && e.preview !== saved.current) { saved.current = e.preview || ''; setText(saved.current); } }, [e?.preview]);
  useEffect(() => { if (focusNext === id && ref.current) { focusNext = null; ref.current.focus(); } });
  useEffect(() => () => clearTimeout(timer.current), [id]);
  if (!e) return <Gone />;
  const save = (v: string) => { clearTimeout(timer.current); if (v === saved.current) return; saved.current = v; api.saveNote({ id, text: v }); };
  const startChat = (aid: string) => { setPicking(false); if (text.trim()) startChatFromNote(id, aid, text.trim()); };
  return (
    <Card id={id} selected={selected} className="note-card" minW={180} minH={100}>
      <div className="card-top">
        <span className="src"><StickyNote size={13} /><span className="src-name">Note</span></span>
        {claude.length > 0 && (picking ? (
          <select className="note-chat nodrag" autoFocus value="" onChange={(ev) => startChat(ev.target.value)} onBlur={() => setPicking(false)} onClick={(ev) => ev.stopPropagation()}>
            <option value="" disabled>Start chat on…</option>
            {claude.map((c) => { const [aid, l] = c.split('\t'); return <option key={aid} value={aid}>{l}</option>; })}
          </select>
        ) : (
          <button className="note-clock nodrag" disabled={!text.trim()} onClick={(ev) => { ev.stopPropagation(); if (claude.length === 1) startChat(claude[0].split('\t')[0]); else setPicking(true); }} title="Start chat from this"><MessageSquarePlus size={12} /></button>
        ))}
      </div>
      <textarea ref={ref} className={`nodrag ${wheel.cls}`} value={text} placeholder="Write something…"
        onFocus={(ev) => { focused.current = true; wheel.check(ev.currentTarget); }}
        onChange={(ev) => { const v = ev.target.value; setText(v); wheel.check(ev.currentTarget); clearTimeout(timer.current); timer.current = setTimeout(() => save(v), 500); }}
        onBlur={() => { focused.current = false; wheel.clear(); save(text); }}
        onKeyDown={(ev) => { if (ev.key === 'Escape') ev.currentTarget.blur(); if (!ev.metaKey && !ev.ctrlKey) ev.stopPropagation(); }} />
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
  // Renaming or resizing a frame is arranging the board: opening the app keeps it.
  api.setSetting(ARRANGED_KEY, true).catch(() => {});
  return api.saveBoard([row]);
}

// A frame: soft tinted area with a name tab on its top edge.
export const GroupNode = memo(({ id, data, selected }: NodeProps) => {
  const d: any = data;
  const [label, setLabel] = useState(d.label || 'Group');
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef(false);
  const seen = useSeen((s) => s.seen); const base = useSeen((s) => s.base);
  const need = useStore((s) => s.board.filter((r) => r.parent_id === id && !r.hidden && needsAttention(s.byId[r.id], s.liveByEntity[r.id], seen[r.id] ?? base)).length);
  useEffect(() => { if (!editing) setLabel(d.label || 'Group'); }, [d.label]);
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);

  const commit = () => {
    setEditing(false);
    if (cancel.current) { cancel.current = false; setLabel(d.label || 'Group'); return; }
    const v = label.trim() || 'Group'; setLabel(v); if (v !== d.label) saveGroup(id, {}, { label: v });
  };
  const keys = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    ev.stopPropagation();
    if (ev.key === 'Escape') cancel.current = true;
    if (ev.key === 'Enter' || ev.key === 'Escape') ev.currentTarget.blur();
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
        {need > 0 && <span className="frame-attn" title={`${need} need${need === 1 ? 's' : ''} you`}>{need}</span>}
      </div>
    </div>
  );
});

// A client or project label in a frame's flowchart. Drawn from the frame's layout, never saved or opened.
export const ProjectPillNode = memo(({ data }: NodeProps) => {
  const d: any = data;
  return (
    <div className={`project-pill ${d.level === 'client' ? 'client' : ''}`} title={d.label}>
      <Handles />
      <span>{d.label}</span>
      {d.count > 1 && <i>{d.count}</i>}
    </div>
  );
});

function Gone() { return <div className="card gone" style={{ width: 220 }}><div className="card-sub">Gone</div></div>; }

export const nodeTypes = {
  session: SessionNode, account: AccountNode, project: ProjectNode, meeting: MeetingNode, thread: ThreadNode,
  client: ClientNode, output: OutputNode, note: NoteNode, error: ErrorNode, group: GroupNode, 'project-pill': ProjectPillNode,
};
