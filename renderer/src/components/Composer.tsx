import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Paperclip, X } from 'lucide-react';
import { api, Attach } from '../lib/api';
import { useStore } from '../lib/store';
import { sendPrompt } from '../lib/send';
import { AgentLogo } from './Logos';
import './panels.css';

const PIN_LIMIT = 12000;

// What a tagged card contributes as context: its recent conversation, or its summary when it has none.
async function pinAttach(id: string): Promise<Attach> {
  const e = useStore.getState().byId[id];
  let text = '';
  try {
    const msgs = await api.transcript(id);
    text = msgs.filter((m) => m.kind !== 'tool').slice(-12).map((m) => `${m.role}: ${m.text.slice(0, 4000)}`).join('\n\n');
  } catch {}
  const c = e?.kind === 'client' ? e.meta?.client : null;
  if (!text && c) text = [c.name, c.company, c.status, c.emails?.join(', '), c.next_action && `Next: ${c.next_action}`, c.notes].filter(Boolean).join('\n');
  if (!text) text = e?.preview || '';
  return { title: e?.title || id, text: text.length > PIN_LIMIT ? `${text.slice(0, PIN_LIMIT)}\n…` : text, sourceId: id };
}

// The prompt box used on cards and in the open card. Dragged-in outputs and tagged cards ride along as context.
export default function Composer({ id, placeholder, multiline = false, from, autoFocus = false, onSent }: {
  id: string; placeholder: string; multiline?: boolean; from?: string; autoFocus?: boolean; onSent?: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const attach = useStore((s) => s.attach[id]) || [];
  const pins = useStore((s) => s.pins);
  const clearAttach = useStore((s) => s.clearAttach);
  const notify = useStore((s) => s.notify);
  const live = useStore((s) => s.liveByEntity[id]);
  const busy = live && live.status === 'running';
  const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const showPins = pins.length > 0 && (multiline || focused);
  const byId = useStore.getState().byId;

  useEffect(() => {
    if (!autoFocus) return;
    // Don't pull the cursor away from a card's own composer the user just clicked into.
    const a = document.activeElement as HTMLElement | null;
    if (a && a !== field.current && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.closest('.react-flow__node')) return;
    field.current?.focus({ preventScroll: true });
  }, [autoFocus, id]);
  useLayoutEffect(() => {
    const el = field.current; if (!multiline || !el) return;
    el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text, multiline]);

  const unpin = (pid: string) => useStore.getState().set({ pins: useStore.getState().pins.filter((p) => p !== pid) });

  async function send() {
    const usePins = pins.filter((p) => p !== id);
    const raw = text;
    const t = raw.trim() || (attach.length || usePins.length ? 'Use the attached context.' : '');
    if (!t || busy) return;
    setText('');
    try {
      const all = [...attach, ...(await Promise.all(usePins.map(pinAttach)))];
      const src = all.find((a) => a.sourceId)?.sourceId || from;
      await sendPrompt(id, t, { attach: all, from: src });
      clearAttach(id);
      if (usePins.length) useStore.getState().set({ pins: [] });
      onSent?.(t);
    } catch (e: any) { setText(raw); notify(e.message); }
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (!e.metaKey && !e.ctrlKey && e.key !== 'Escape') e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };
  const ready = !!text.trim() || attach.length > 0 || (showPins && pins.some((p) => p !== id));
  return (
    <div className={`composer pn-composer nodrag ${multiline ? 'multi' : ''}`} onDoubleClick={(e) => e.stopPropagation()}
      onFocus={() => setFocused(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(false); }}>
      {(attach.length > 0 || showPins) && (
        <div className="att">
          {attach.map((a, i) => (
            <span key={i} className="chip green"><Paperclip size={11} />{(a.title || 'Output').slice(0, 34)}</span>
          ))}
          {attach.length > 0 && <button className="chip" onClick={() => clearAttach(id)} title="Remove attachments"><X size={11} /></button>}
          {showPins && pins.filter((p) => p !== id).map((p) => (
            <span key={p} className="chip pin" title="Tagged as context">
              <AgentLogo source={byId[p]?.source || 'note'} size={11} />
              <span className="pin-t">{(byId[p]?.title || p).slice(0, 30)}</span>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => unpin(p)} title="Remove"><X size={10} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="row">
        {multiline ? (
          <textarea ref={field} rows={1} value={text} placeholder={busy ? 'Working…' : placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
        ) : (
          <input ref={field} value={text} placeholder={busy ? 'Working…' : placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
        )}
        <button className="send" disabled={busy || !ready} onClick={send} title="Send (Enter)"><ArrowUp size={15} /></button>
      </div>
    </div>
  );
}
