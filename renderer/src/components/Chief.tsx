import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, ArrowUp, X, GripVertical, Copy, FileOutput } from 'lucide-react';
import { useStore } from '../lib/store';
import { api, Message } from '../lib/api';
import { md } from '../lib/format';
import { dragOutput } from '../nodes/nodes';

// The overall agent: one Claude that can read across whichever cards are selected,
// plus the CRM, what's due and the shared brain.
export default function Chief() {
  const { chiefOpen, selected, set, byId, notify } = useStore();
  const live = useStore((s) => s.liveByEntity['chief']);
  const [q, setQ] = useState('');
  const [hist, setHist] = useState<Message[]>([]);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => { if (chiefOpen) api.chiefHistory().then(setHist).catch(() => {}); }, [chiefOpen, live?.status]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [hist.length, live?.text, chiefOpen]);

  const ask = async (text: string) => {
    if (!text.trim() || live?.status === 'running') return;
    set({ chiefOpen: true }); setQ('');
    setHist((h) => [...h, { id: 'q' + Date.now(), role: 'user', text, ts: Date.now() }]);
    try { await api.chief(text, { selected }); } catch (e: any) { notify(e.message); }
  };
  const ctx = selected.length ? `${selected.length} card${selected.length > 1 ? 's' : ''}` : 'Everything';
  const quick = selected.length > 1
    ? ['Compare these outputs and tell me which is better', 'Merge these into one plan', 'What did each of these agents get done?']
    : selected.length === 1 ? ['Summarize where this stands', 'What should happen next here?', 'Write the next prompt for this agent']
    : ["What's due for my clients today?", 'What are all my agents working on?', 'What needs me right now?'];

  return (
    <div className="chief">
      {chiefOpen && (
        <div className="chief-panel">
          <div className="head"><Sparkles size={15} />Overall agent<span className="s">reads {selected.length ? selected.map((id) => byId[id]?.title).filter(Boolean).slice(0, 3).join(', ') : 'your clients, what is due and the shared brain'}</span>
            <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => set({ chiefOpen: false })}><X size={15} /></button></div>
          <div className="msgs" style={{ maxHeight: '38vh' }}>
            {!hist.length && !live && <div className="empty">Select cards on the board and ask about them, or ask about everything.</div>}
            {hist.map((m) => <ChiefMsg key={m.id} m={m} />)}
            {live?.status === 'running' && <ChiefMsg m={{ id: 'live', role: 'assistant', text: live.text || 'Reading your cards…', ts: Date.now() }} />}
            {live?.status === 'error' && <div className="well err">{live.error}</div>}
            <div ref={end} />
          </div>
          <div className="quick" style={{ paddingBottom: 10 }}>{quick.map((t) => <button key={t} className="chip" onClick={() => ask(t)}>{t}</button>)}</div>
        </div>
      )}
      <div className="chief-bar">
        <Sparkles size={16} color="#CFE1D7" />
        <input value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => set({ chiefOpen: true })} placeholder="Ask across all your agents…" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') ask(q); if (e.key === 'Escape') set({ chiefOpen: false }); }} />
        <span className="ctx">{ctx}</span>
        <button className="go" onClick={() => ask(q)}><ArrowUp size={16} /></button>
      </div>
    </div>
  );

  function ChiefMsg({ m }: { m: Message }) {
    return (
      <div className={`msg ${m.role}`}>
        <div className="body md" dangerouslySetInnerHTML={{ __html: md(m.text) }} />
        {m.role === 'assistant' && (
          <div className="tools">
            <button draggable onDragStart={(ev) => dragOutput(ev, { text: m.text, title: 'From the overall agent', sourceId: 'chief' })} title="Drag onto a card"><GripVertical size={13} /></button>
            <button onClick={() => { api.copy(m.text); notify('Copied'); }}><Copy size={13} /></button>
            <button onClick={async () => { await api.saveOutput({ title: 'From the overall agent', content: m.text, source: 'chief' }); await useStore.getState().refresh(true); notify('Saved as an output card'); }}><FileOutput size={13} /></button>
          </div>
        )}
      </div>
    );
  }
}
