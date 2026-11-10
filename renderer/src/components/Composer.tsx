import React, { useState } from 'react';
import { ArrowUp, Paperclip, X } from 'lucide-react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';

// The small prompt box on a card. Attached outputs (dragged in from elsewhere) show as chips.
export default function Composer({ id, placeholder, multiline = false, from }: { id: string; placeholder: string; multiline?: boolean; from?: string }) {
  const [text, setText] = useState('');
  const attach = useStore((s) => s.attach[id]) || [];
  const clearAttach = useStore((s) => s.clearAttach);
  const notify = useStore((s) => s.notify);
  const live = useStore((s) => s.liveByEntity[id]);
  const busy = live && live.status === 'running';

  async function send() {
    const t = text.trim() || (attach.length ? 'Use the attached context.' : '');
    if (!t || busy) return;
    setText('');
    const src = attach.find((a) => a.sourceId)?.sourceId || from;
    try {
      await api.prompt(id, t, { attach, from: src });
      clearAttach(id);
    } catch (e: any) { notify(e.message); }
  }
  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };
  return (
    <div className="composer nodrag nowheel" onDoubleClick={(e) => e.stopPropagation()}>
      {attach.length > 0 && (
        <div className="att">
          {attach.map((a, i) => (
            <span key={i} className="chip green"><Paperclip size={11} />{(a.title || 'Output').slice(0, 34)}</span>
          ))}
          <button className="chip" onClick={() => clearAttach(id)}><X size={11} />Clear</button>
        </div>
      )}
      <div className="row">
        {multiline ? (
          <textarea rows={1} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
        ) : (
          <input value={text} placeholder={busy ? 'Working…' : placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
        )}
        <button className="send" disabled={busy || (!text.trim() && !attach.length)} onClick={send} title="Send (Enter)"><ArrowUp size={15} /></button>
      </div>
    </div>
  );
}
