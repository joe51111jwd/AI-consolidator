import React, { useEffect, useRef, useState } from 'react';
import { X, Copy, FileOutput, Brain, GripVertical, ExternalLink, Send, FolderOpen } from 'lucide-react';
import { useStore } from '../lib/store';
import { api, Message, Flow } from '../lib/api';
import { ago, md, SOURCE, PROMPTABLE } from '../lib/format';
import { dragOutput } from '../nodes/nodes';
import Composer from './Composer';

// Opens a card full size: the whole conversation or document, with outputs you can drag, copy or save.
export default function Inspector() {
  const id = useStore((s) => s.inspector);
  const e = useStore((s) => (id ? s.byId[id] : undefined));
  const live = useStore((s) => (id ? s.liveByEntity[id] : undefined));
  const { open, notify, entities } = useStore();
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [sendMenu, setSendMenu] = useState<{ text: string; x: number; y: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api.transcript(id).then(setMsgs).catch((err) => notify(err.message)).finally(() => setLoading(false));
    api.flows(id).then(setFlows).catch(() => {});
  }, [id, e?.updatedAt, live?.status]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs.length, live?.text]);

  if (!id || !e) return null;
  const src = SOURCE[e.source] || { label: e.source, color: '#999' };
  const acc = useStore.getState().accounts.find((a) => a.id === e.accountId);

  const saveOutput = async (text: string) => {
    const oid = await api.saveOutput({ title: `From ${e.title}`.slice(0, 80), content: text, source: id });
    await api.recordFlow(id, oid, text);
    await useStore.getState().refresh(true); await useStore.getState().refreshBoard();
    notify('Saved as an output card on the board');
  };
  const toBrain = async (text: string) => { await api.appendBrain(text, e.title); notify('Added to the shared brain'); };
  const targets = entities.filter((x) => PROMPTABLE(x.id) && x.id !== id && (x.kind === 'session' || x.kind === 'account' || x.kind === 'project')).slice(0, 14);

  const all: Message[] = [...msgs];
  if (live && live.status === 'running' && live.text) all.push({ id: 'live', role: 'assistant', text: live.text, ts: Date.now() });

  return (
    <div className="inspector" onKeyDown={(ev) => ev.stopPropagation()}>
      <div className="insp-head">
        <div className="card-top">
          <span className="src"><i style={{ background: acc?.color || src.color }} />{acc ? `${acc.label} · ${src.label}` : src.label}</span>
          <span className="when">{ago(e.updatedAt)}</span>
          <button className="icon-btn" onClick={() => open(null)} title="Close"><X size={16} /></button>
        </div>
        <div className="title">{e.title}</div>
        {e.meta?.cwd && <div className="card-sub mono">{e.meta.cwd}</div>}
        <div className="insp-actions">
          {e.meta?.url && <button className="btn" onClick={() => api.openExternal(e.meta.url)}><ExternalLink size={13} />Open in {src.label}</button>}
          {e.meta?.cwd && <button className="btn" onClick={() => api.openPath(e.meta.cwd)}><FolderOpen size={13} />Folder</button>}
          {e.meta?.sessionId && e.source === 'claude-code' && <button className="btn" onClick={() => { api.copy(`claude --resume ${e.meta.sessionId}`); notify('Resume command copied'); }}><Copy size={13} />Resume command</button>}
          {flows.length > 0 && <span className="chip">{flows.length} messages with other cards</span>}
        </div>
      </div>
      <div className="msgs">
        {loading && !all.length && <div className="empty">Loading…</div>}
        {!loading && !all.length && <div className="empty">Nothing here yet.{PROMPTABLE(id) ? ' Send something below to start.' : ''}</div>}
        {all.map((m) => (
          <div key={m.id} className={`msg ${m.kind === 'tool' ? 'tool' : m.role}`}>
            {m.kind !== 'tool' && <div className="who">{m.role === 'user' ? 'You' : m.role === 'system' ? 'Transcript' : (acc?.label || src.label)}<span>{m.ts ? ago(m.ts) : ''}</span></div>}
            {m.kind === 'tool' ? <div className="body">{m.text}</div> : <div className="body md" dangerouslySetInnerHTML={{ __html: md(m.text) }} />}
            {m.kind !== 'tool' && (
              <div className="tools">
                <button draggable onDragStart={(ev) => dragOutput(ev, { text: m.text, title: `From ${e.title}`.slice(0, 80), sourceId: id })} title="Drag onto a card"><GripVertical size={13} /></button>
                <button onClick={(ev) => setSendMenu({ text: m.text, x: ev.clientX, y: ev.clientY })} title="Send to another card"><Send size={13} /></button>
                <button onClick={() => { api.copy(m.text); notify('Copied'); }} title="Copy"><Copy size={13} /></button>
                <button onClick={() => saveOutput(m.text)} title="Save as output card"><FileOutput size={13} /></button>
                <button onClick={() => toBrain(m.text)} title="Add to shared brain"><Brain size={13} /></button>
              </div>
            )}
          </div>
        ))}
        {live?.status === 'error' && <div className="well err">{live.error}</div>}
        <div ref={end} />
      </div>
      {PROMPTABLE(id) && <div className="insp-foot"><Composer id={id} multiline placeholder={e.kind === 'account' ? 'Start a new session…' : 'Message…'} /><div className="hint" style={{ marginTop: 6 }}>Enter to send · Shift+Enter for a new line · drag any message onto a card</div></div>}
      {sendMenu && (
        <div className="menu" style={{ position: 'fixed', left: Math.min(sendMenu.x, window.innerWidth - 280), top: Math.min(sendMenu.y, window.innerHeight - 400), maxHeight: 380, overflowY: 'auto' }} onMouseLeave={() => setSendMenu(null)}>
          <div className="hint" style={{ padding: '6px 10px' }}>Attach to…</div>
          {targets.map((t) => (
            <button key={t.id} onClick={() => { useStore.getState().addAttach(t.id, { text: sendMenu.text, title: `From ${e.title}`.slice(0, 80), sourceId: id }); setSendMenu(null); notify(`Attached to ${t.title}. Add a note there and press Enter.`); }}>
              <i style={{ width: 7, height: 7, borderRadius: '50%', background: SOURCE[t.source]?.color || '#999', display: 'inline-block' }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
