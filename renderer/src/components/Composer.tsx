import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Paperclip, X, Image as ImageIcon, Square } from 'lucide-react';
import { api, Attach } from '../lib/api';
import { useStore } from '../lib/store';
import { sendPrompt } from '../lib/send';
import { MODELS, savedModel, saveModel, takesModel, onModelChange } from '../lib/models';
import { AgentLogo } from './Logos';
import './panels.css';

const PIN_LIMIT = 12000;
const FILE_LIMIT = 200000;
const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|ya?ml|toml|ini|env\.example|log|xml|html?|css|scss|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|zsh|sql|graphql|vue|svelte)$/i;

type Picked = { kind: 'text'; title: string; text: string } | { kind: 'image'; title: string; path: string };

const filePath = (f: File) => (window as any).electron?.webUtils?.getPathForFile?.(f) || (f as any).path || f.name;

// Files picked or dropped: text is read here and sent as context; images go by path for now.
async function readFiles(list: FileList | File[]): Promise<{ picked: Picked[]; skipped: string[] }> {
  const picked: Picked[] = []; const skipped: string[] = [];
  for (const f of Array.from(list)) {
    if (f.type.startsWith('image/')) { picked.push({ kind: 'image', title: f.name, path: filePath(f) }); continue; }
    if (!(f.type.startsWith('text/') || f.type === 'application/json' || TEXT_EXT.test(f.name))) { skipped.push(f.name); continue; }
    const t = await f.text();
    picked.push({ kind: 'text', title: f.name, text: t.length > FILE_LIMIT ? `${t.slice(0, FILE_LIMIT)}\n…` : t });
  }
  return { picked, skipped };
}

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
    el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text, multiline]);

  const unpin = (pid: string) => useStore.getState().set({ pins: useStore.getState().pins.filter((p) => p !== pid) });

  const [files, setFiles] = useState<Picked[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const addFiles = async (list: FileList | File[]) => {
    const { picked, skipped } = await readFiles(list);
    if (picked.length) setFiles((f) => [...f, ...picked]);
    if (skipped.length) notify(`Can't attach ${skipped.join(', ')} yet`);
  };
  const onDrop = (ev: React.DragEvent) => {
    if (!ev.dataTransfer.files.length) return;
    ev.preventDefault(); ev.stopPropagation(); setDragging(false);
    addFiles(ev.dataTransfer.files);
  };
  const onDragOver = (ev: React.DragEvent) => {
    if (!Array.from(ev.dataTransfer.types).includes('Files')) return;
    ev.preventDefault(); ev.stopPropagation(); setDragging(true);
  };

  // The Claude model for this card's messages, remembered per card. Cards that don't run Claude Code
  // (Codex, API chats, Grok bots…) have no picker and send without one.
  const accounts = useStore((s) => s.accounts);
  const pickModel = takesModel(id, accounts);
  const [model, setModelState] = useState(() => savedModel(id));
  useEffect(() => { setModelState(savedModel(id)); return onModelChange((cid, m) => { if (cid === id) setModelState(m); }); }, [id]);
  const withModel = pickModel && model ? { model } : {};

  const [queued, setQueued] = useState<string | null>(null);
  useEffect(() => {
    if (busy || !queued) return;
    const q = queued; setQueued(null);
    sendPrompt(id, q, { from, ...withModel }).then(() => onSent?.(q)).catch((e: any) => notify(e.message));
  }, [busy, queued]);

  // Stop ends the running reply. Anything queued comes back into the box instead of being sent.
  const [stopping, setStopping] = useState(false);
  useEffect(() => { if (!busy) setStopping(false); }, [busy]);
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    if (queued) { const q = queued; setQueued(null); setText((t) => (t.trim() ? `${q}\n\n${t}` : q)); }
    try { await api.stopRun(id); } catch (e: any) { setStopping(false); notify(e.message || 'Could not stop it'); }
  };

  async function send() {
    const usePins = pins.filter((p) => p !== id);
    const raw = text;
    const sentFiles = files;
    const images = sentFiles.flatMap((f) => (f.kind === 'image' ? [`[Image attached: ${f.path}]`] : []));
    const fileAtt: Attach[] = sentFiles.flatMap((f) => (f.kind === 'text' ? [{ title: f.title, text: f.text }] : []));
    let t = raw.trim() || (attach.length || usePins.length || sentFiles.length ? 'Use the attached context.' : '');
    if (!t) return;
    if (images.length) t = `${t}\n\n${images.join('\n')}`;
    if (busy && !fileAtt.length) { setQueued((q) => (q ? `${q}\n\n${t}` : t)); setText(''); setFiles([]); return; }
    if (busy) { notify('Still working. Send files once it finishes.'); return; }
    setText(''); setFiles([]);
    try {
      const all = [...attach, ...fileAtt, ...(await Promise.all(usePins.map(pinAttach)))];
      const src = all.find((a) => a.sourceId)?.sourceId || from;
      await sendPrompt(id, t, { attach: all, from: src, ...withModel });
      clearAttach(id);
      if (usePins.length) useStore.getState().set({ pins: [] });
      onSent?.(t);
    } catch (e: any) { setText(raw); setFiles(sentFiles); notify(e.message); }
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (!e.metaKey && !e.ctrlKey && e.key !== 'Escape') e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };
  const ready = !!text.trim() || attach.length > 0 || files.length > 0 || (showPins && pins.some((p) => p !== id));
  return (
    <div className={`composer pn-composer nodrag ${multiline ? 'multi' : ''} ${dragging ? 'dropping' : ''}`} onDoubleClick={(e) => e.stopPropagation()}
      onDragOver={onDragOver} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }} onDrop={onDrop}
      onFocus={() => setFocused(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(false); }}>
      {(attach.length > 0 || showPins || files.length > 0) && (
        <div className="att">
          {attach.map((a, i) => (
            <span key={i} className="chip green"><Paperclip size={11} />{(a.title || 'Output').slice(0, 34)}</span>
          ))}
          {attach.length > 0 && <button className="chip" onClick={() => clearAttach(id)} title="Remove attachments"><X size={11} /></button>}
          {files.map((f, i) => (
            <span key={`f${i}`} className="chip pin" title={f.kind === 'image' ? f.path : f.title}>
              {f.kind === 'image' ? <ImageIcon size={11} /> : <Paperclip size={11} />}
              <span className="pin-t">{f.title.slice(0, 30)}</span>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} title="Remove"><X size={10} /></button>
            </span>
          ))}
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
        {multiline && (
          <>
            <button className="attach" onClick={() => picker.current?.click()} title="Attach files"><Paperclip size={15} /></button>
            <input ref={picker} type="file" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
          </>
        )}
        {multiline ? (
          <textarea ref={field} rows={1} value={text} placeholder={queued ? 'Queued, sends when it finishes' : busy ? 'Working… (you can queue a message)' : placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
        ) : (
          <input ref={field} value={text} placeholder={queued ? 'Queued, sends when it finishes' : busy ? 'Working… (you can queue a message)' : placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
        )}
        {multiline && pickModel && (
          <select className="model" value={model} onChange={(e) => { setModelState(e.target.value); saveModel(id, e.target.value); }}
            onKeyDown={(e) => { if (!e.metaKey && !e.ctrlKey && e.key !== 'Escape') e.stopPropagation(); }}
            title="Model for this chat" aria-label="Model" data-testid="model-pick">
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        )}
        {busy && (
          <button className="stop" onClick={stop} disabled={stopping} title="Stop" aria-label="Stop" data-testid="stop-run">
            <Square size={multiline ? 11 : 9} fill="currentColor" strokeWidth={0} />
          </button>
        )}
        <button className="send" disabled={!ready} onClick={send} title={busy ? 'Queue (Enter)' : 'Send (Enter)'}><ArrowUp size={15} /></button>
      </div>
    </div>
  );
}
