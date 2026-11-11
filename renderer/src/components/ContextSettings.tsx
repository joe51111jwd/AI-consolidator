import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';

type ContextStatus = { enabled: boolean; summarized: number; pending: number; model: string; batch: number; everySeconds: number; error?: string | null };

// Settings row: AI summaries of every chat (electron/ext/context.cjs), which the home's topics,
// the cards and ⌘K read to know who each chat is for. On by default.
export default function ContextSettings() {
  const [st, setSt] = useState<ContextStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.call<ContextStatus>('context:status').then((s) => { if (alive) setSt(s); }).catch(() => {});
    load();
    const off = api.onEvent((e) => { if (e?.type === 'context-changed') load(); });
    return () => { alive = false; off?.(); };
  }, []);
  const on = st ? st.enabled : true;
  const set = async (v: boolean) => {
    setSt((s) => (s ? { ...s, enabled: v } : s));
    try { setSt(await api.call<ContextStatus>('context:setEnabled', v)); } catch (e: any) { useStore.getState().notify(e.message); }
  };
  const progress = st && on && (st.summarized || st.pending) ? ` ${st.summarized} summarized${st.pending ? `, ${st.pending} to go` : ''}.` : '';
  const model = (st?.model || 'haiku').replace(/^\w/, (c) => c.toUpperCase());
  return (
    <div className="set-row" data-testid="context-setting">
      <div className="txt">
        <b>Summarize chats with AI</b>
        <span className="hint">
          A line on what each chat is about and who it's for, used to group chats by client. Uses your Claude plan: one small {model} call
          for up to {st?.batch || 8} changed chats, at most every {st?.everySeconds || 20} seconds.{progress}
        </span>
      </div>
      <button role="switch" aria-checked={on} aria-label="Summarize chats with AI" data-testid="context-toggle" className={`switch ${on ? 'on' : ''}`} onClick={() => set(!on)} />
    </div>
  );
}
