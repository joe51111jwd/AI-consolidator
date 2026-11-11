import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, Folder, FolderOpen, MessageSquare, X } from 'lucide-react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import { AgentLogo } from './Logos';
import { useUsage, weeklyPct } from './UsagePill';
import { MODELS } from '../lib/models';
import './newchat.css';

interface Recent { path: string; name: string; lastUsed: number }

// The new chat keeps the model it starts with: lib/models.ts remembers it for the new card.
const OPEN_EVENT = 'sb:new-chat';

export const openNewChat = () => window.dispatchEvent(new Event(OPEN_EVENT));

// Waits up to 30s for the new session's card, then opens it in the Inspector.
function follow(runId: string, accountId: string, cwd: string | null, before: Set<string>) {
  const started = Date.now();
  let tick = 0;
  const t = setInterval(() => {
    const st = useStore.getState();
    const fromRun = st.runs[runId]?.result?.entityId as string | undefined;
    const found = (fromRun && st.byId[fromRun] ? fromRun : null) || st.entities.find((e) => e.kind === 'session' && e.accountId === accountId
      && !before.has(e.id) && (!cwd || e.meta?.cwd === cwd))?.id;
    if (found) { clearInterval(t); st.open(found); setTimeout(() => (window as any).__sbCenter?.(found), 60); return; }
    if (Date.now() - started > 30000) { clearInterval(t); return; }
    if (++tick % 3 === 0) (st as any).refresh?.();
  }, 1000);
}

// New chat sheet: account, folder, model, first message. Opens from ⌘N, the agent panel and the dock.
export default function NewChat() {
  const accounts = useStore((s) => s.accounts);
  const notify = useStore((s) => s.notify);
  const pins = useStore((s) => s.pins);
  const { rows, budgets } = useUsage();
  const [open, setOpen] = useState(false);
  const [acct, setAcct] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [text, setText] = useState('');
  const [recent, setRecent] = useState<Recent[]>([]);
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  const claude = accounts.filter((a) => a.kind === 'claude-code');
  const pct = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of claude) { const r = rows.find((x) => x.id === a.id); if (r) m[a.id] = Math.round(weeklyPct(r, accounts, budgets)); }
    return m;
  }, [accounts, rows, budgets]);
  const least = useMemo(() => {
    const ready = claude.filter((a) => a.config?.auth?.loggedIn !== false);
    return [...(ready.length ? ready : claude)].sort((x, y) => (pct[x.id] ?? 0) - (pct[y.id] ?? 0))[0] || null;
  }, [accounts, pct]);

  useEffect(() => {
    const show = () => setOpen((o) => !o);
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); show(); }
    };
    window.addEventListener(OPEN_EVENT, show);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener(OPEN_EVENT, show); window.removeEventListener('keydown', key); };
  }, []);

  useEffect(() => {
    if (!open) return;
    setAcct((a) => (a && claude.some((c) => c.id === a) ? a : least?.id || null));
    api.call<Recent[]>('folders:recent').then((r) => {
      const list = Array.isArray(r) ? r : [];
      setRecent(list);
      setCwd((c) => c ?? list[0]?.path ?? null);
    }).catch(() => setRecent([]));
    const t = setTimeout(() => box.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [open]);

  if (!open) return null;

  const close = () => { setOpen(false); setSending(false); };
  const choose = async () => {
    const r = await api.call<Recent | null>('folders:pick').catch(() => null);
    if (!r) return;
    setRecent((xs) => [r, ...xs.filter((x) => x.path !== r.path)]);
    setCwd(r.path);
  };
  const send = async () => {
    const t = text.trim();
    if (!t || !acct || sending) return;
    setSending(true);
    const before = new Set(useStore.getState().entities.map((e) => e.id));
    const opts: { accountId: string; model?: string; attach?: { id: string; title?: string }[] } = { accountId: acct };
    if (model) opts.model = model;
    // Cards tagged as context (⌘T) go along with the first message, as they do from the dock.
    if (pins.length) opts.attach = pins.map((id) => ({ id, title: useStore.getState().byId[id]?.title }));
    try {
      const runId = await api.call<string>('prompt', cwd ? `pj:${cwd}` : `ac:${acct}`, t, opts);
      if (pins.length) useStore.getState().set({ pins: [] });
      notify('Chat started');
      setText(''); close();
      follow(runId, acct, cwd, before);
    } catch (e: any) { notify(e.message || 'Could not start the chat'); setSending(false); }
  };
  const folders = cwd && !recent.some((r) => r.path === cwd) ? [{ path: cwd, name: cwd.split('/').pop() || cwd, lastUsed: 0 }, ...recent] : recent;

  return createPortal(
    <div className="nc-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="nc-sheet" role="dialog" aria-label="New chat" data-testid="new-chat"
        onKeyDown={(e) => { if (!e.metaKey && !e.ctrlKey) e.stopPropagation(); if (e.key === 'Escape') close(); }}>
        <div className="nc-head"><span>New chat</span><button className="icon-btn" aria-label="Close" onClick={close}><X size={15} /></button></div>

        <div className="nc-label">Account</div>
        <div className="nc-row">
          {claude.map((a) => (
            <button key={a.id} className={`nc-chip ${acct === a.id ? 'on' : ''}`} onClick={() => setAcct(a.id)}
              title={a.config?.auth?.loggedIn === false ? 'Not signed in' : undefined}>
              <AgentLogo source={a.kind} size={13} /><span>{a.label}</span>{pct[a.id] != null && <em>{pct[a.id]}%</em>}
            </button>
          ))}
          {!claude.length && <span className="nc-empty">Add a Claude account in Settings</span>}
        </div>

        <div className="nc-label">Folder</div>
        <div className="nc-folders">
          {folders.map((f) => (
            <button key={f.path} className={`nc-folder ${cwd === f.path ? 'on' : ''}`} title={f.path} onClick={() => setCwd(f.path)}>
              <Folder size={13} /><span>{f.name}</span>
            </button>
          ))}
          <button className="nc-folder" onClick={choose}><FolderOpen size={13} /><span>Choose folder…</span></button>
          <button className={`nc-folder ${cwd === null ? 'on' : ''}`} onClick={() => setCwd(null)}><MessageSquare size={13} /><span>No folder</span></button>
        </div>

        <div className="nc-label">Model</div>
        <div className="nc-seg">
          {MODELS.map((m) => <button key={m.id} className={model === m.id ? 'on' : ''} onClick={() => setModel(m.id)} data-model={m.id}>{m.label}</button>)}
        </div>

        {pins.length > 0 && (
          <div className="nc-row" data-testid="new-chat-tags">
            <button className="chip" title="Clear tagged context" onClick={() => useStore.getState().set({ pins: [] })}>{pins.length} tagged<X size={11} /></button>
          </div>
        )}

        <div className="nc-compose">
          <textarea ref={box} value={text} rows={3} placeholder="First message" data-testid="new-chat-input"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
          <button className="nc-send" disabled={!text.trim() || !acct || sending} onClick={send} title="Start (Enter)"><ArrowUp size={15} /></button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
