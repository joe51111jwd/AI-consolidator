import React, { useEffect, useMemo, useState } from 'react';
import { Inbox, ChevronRight, Check, ChevronDown, FileText } from 'lucide-react';
import { useStore } from '../lib/store';
import { api, Run } from '../lib/api';
import { ago, SOURCE } from '../lib/format';
import { dragOutput } from '../nodes/nodes';
import { AgentLogo } from './Logos';
import './panels.css';

interface Item { id: string; ref: string; title: string; sub?: string; source: string; color?: string; ts: number; text: string; sourceId: string; working?: boolean }

const firstLine = (t: string) => (t.split('\n').map((l) => l.replace(/^[#>*\-\s`]+/, '').trim()).find(Boolean) || '').slice(0, 90);
const RUN_WINDOW = 12 * 3600000;

// Right-edge drawer: everything agents have produced, as a calm list you can tick off or drag onto a card.
export default function Outputs() {
  const { outputsOpen, set, entities, byId, accounts, runs, inspector, open } = useStore();
  const [done, setDone] = useState<string[]>([]);
  const [past, setPast] = useState<Run[]>([]);
  const [full, setFull] = useState<Record<string, string>>({});
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    api.getSetting<string[]>('outputsDone', []).then((d) => setDone(Array.isArray(d) ? d : [])).catch(() => {});
    api.runs().then(setPast).catch(() => {});
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Escape' && useStore.getState().outputsOpen && !useStore.getState().inspector && t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA') set({ outputsOpen: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const colorOf = (id?: string) => {
    const e = id ? byId[id] : undefined;
    const acc = e?.accountId ? accounts.find((a) => a.id === e.accountId) : undefined;
    return acc?.color || (e && SOURCE[e.source]?.color);
  };

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const e of entities) {
      if (e.kind !== 'output' || !(e.preview || '').trim()) continue;
      const from = e.meta?.from ? byId[e.meta.from] : undefined;
      out.push({ id: e.id, ref: e.id, title: e.title, sub: from?.title, source: from?.source || 'output', color: colorOf(from?.id), ts: e.updatedAt, text: full[e.id] || e.preview || '', sourceId: e.id });
    }
    const merged: Record<string, Run> = {};
    for (const r of past) merged[r.id] = r;
    Object.assign(merged, runs);
    for (const r of Object.values(merged)) {
      if (r.entityId === 'chief' || Date.now() - r.startedAt > RUN_WINDOW) continue;
      if (r.status === 'error' || (r.status === 'done' && (!r.text?.trim() || /^Copied to your clipboard/.test(r.text)))) continue;
      const ref = r.result?.entityId && byId[r.result.entityId] ? r.result.entityId : r.entityId;
      const card = byId[ref] || byId[r.entityId];
      const working = r.status === 'running';
      out.push({
        id: r.id, ref, title: working ? card?.title || 'Working…' : firstLine(r.text) || 'Reply', sub: working ? 'Working…' : card?.title,
        source: card?.source || 'output', color: colorOf(card?.id), ts: r.startedAt, text: r.text || '', sourceId: ref, working,
      });
    }
    return out.sort((a, b) => Number(!!b.working) - Number(!!a.working) || b.ts - a.ts);
  }, [entities, byId, accounts, runs, past, full]);

  const doneSet = new Set(done);
  const todo = items.filter((x) => !doneSet.has(x.id));
  const finished = items.filter((x) => doneSet.has(x.id));
  const count = todo.filter((x) => !x.working).length;
  const busy = todo.some((x) => x.working);

  // Load full output text so a drag carries everything, not just the preview.
  useEffect(() => {
    if (!outputsOpen) return;
    const need = todo.filter((x) => x.id.startsWith('out:') && full[x.id] === undefined).slice(0, 40);
    need.forEach((x) => api.transcript(x.id).then((t) => setFull((f) => ({ ...f, [x.id]: t[0]?.text || '' }))).catch(() => {}));
  }, [outputsOpen, todo.length]);

  const toggle = (id: string) => {
    const next = doneSet.has(id) ? done.filter((d) => d !== id) : [...done, id].slice(-500);
    setDone(next); api.setSetting('outputsDone', next);
  };
  const openItem = (x: Item) => { open(x.ref); (window as any).__sbCenter?.(x.ref); };

  const row = (x: Item) => (
    <div key={x.id} className={`pn-out ${doneSet.has(x.id) ? 'done' : ''}`} draggable={!!x.text} title={x.text ? 'Drag onto a card' : undefined}
      onDragStart={(ev) => dragOutput(ev, { text: x.text, title: x.title, sourceId: x.sourceId })} onClick={() => openItem(x)}>
      {x.working
        ? <span className="pn-check busy"><AgentLogo source={x.source} size={12} color={x.color} working /></span>
        : <button className="pn-check" onClick={(ev) => { ev.stopPropagation(); toggle(x.id); }} title={doneSet.has(x.id) ? 'Mark as not done' : 'Mark done'}><Check size={11} /></button>}
      <span className="pn-out-main">
        <span className="t">{x.title}</span>
        {x.sub && <span className="s">{!x.working && (x.source === 'output' ? <FileText size={10} /> : <AgentLogo source={x.source} size={10} color={x.color} />)}<span className="ell">{x.sub}</span></span>}
      </span>
      <span className="pn-out-age">{ago(x.ts)}</span>
    </div>
  );

  return (
    <div className={`pn-outputs ${outputsOpen ? 'open' : ''} ${inspector && !outputsOpen ? 'covered' : ''}`}>
      <button className="pn-out-face" onClick={() => set({ outputsOpen: true })} title="Outputs" tabIndex={outputsOpen ? -1 : 0}>
        <Inbox size={15} />
        {count > 0 && <span className="n">{count}</span>}
        {busy && <i className="pn-busy" />}
      </button>
      <div className="pn-out-panel" aria-hidden={!outputsOpen}>
        <div className="pn-out-head">
          <span>Outputs</span>
          {count > 0 && <span className="n">{count}</span>}
          <button className="icon-btn" onClick={() => set({ outputsOpen: false })} title="Close"><ChevronRight size={15} /></button>
        </div>
        <div className="pn-out-list">
          {todo.length === 0 && <div className="pn-none">All clear</div>}
          {todo.map(row)}
          {finished.length > 0 && (
            <>
              <button className="pn-out-done" onClick={() => setShowDone(!showDone)}>
                <ChevronDown size={12} style={{ transform: showDone ? 'none' : 'rotate(-90deg)' }} />Done<span>{finished.length}</span>
              </button>
              {showDone && finished.map(row)}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
