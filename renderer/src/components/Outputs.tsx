import React, { useEffect, useMemo, useState } from 'react';
import { Inbox, ChevronRight, Check, ChevronDown, FileText, Copy, Maximize2, Minimize2, ArrowUpRight } from 'lucide-react';
import { useStore } from '../lib/store';
import { api, Run } from '../lib/api';
import { ago, md, SOURCE } from '../lib/format';
import { dragOutput } from '../nodes/nodes';
import { AgentLogo } from './Logos';
import { clean } from './LiveView';
import './panels.css';

interface Item { id: string; ref: string; title: string; sub?: string; source: string; color?: string; ts: number; text: string; sourceId: string; working?: boolean; saved?: boolean }

// Title from the first real line, as plain text; a lead-in ending in ":" gives way to the line after it.
const firstLine = (t: string) => {
  const lines = t.split('\n').map((l) => clean(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))).filter(Boolean);
  return ((lines[0]?.endsWith(':') && lines[1]) || lines[0] || '').slice(0, 90);
};
const RUN_WINDOW = 12 * 3600000;
interface Recent { id: string; title: string; source: string; text: string; ts: number; sent?: boolean }

const URL_RE = /https?:\/\/[^\s)<>\]"'`]+/g;
const linksIn = (t: string) => [...new Set((t.match(URL_RE) || []).map((u) => u.replace(/[.,;:!?]+$/, '')))].slice(0, 4);
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
// A session's last reply only counts as an output when it reads like a deliverable: the session is done,
// the reply is substantial, and it carries a link, a file path, a heading, a list or code. Progress chatter
// ("I'll wait in the foreground…"), small talk and Switchboard's own internal runs stay out.
const INTERNAL = /^(You are the overall agent inside Switchboard|Group these cards from my work whiteboard)/i;
const DELIVERABLE = /https?:\/\/|(^|\s)(~|\.{0,2})\/[\w.-]+\/[\w./-]+|\b[\w-]+\.(md|pdf|docx?|csv|xlsx|png|html|tsx?|py)\b|^#{1,4}\s|^\s*([-*]|\d+\.)\s|```/m;
export function isDeliverable(text: string, status?: string, title?: string) {
  const t = (text || '').trim();
  if (status === 'running' || status === 'waiting') return false;
  if (title && INTERNAL.test(title)) return false;
  if (INTERNAL.test(t)) return false;
  return t.length > 200 && DELIVERABLE.test(t);
}

const dataOf = (d: any) => { if (typeof d !== 'string') return d || {}; try { return JSON.parse(d); } catch { return {}; } };

function Links({ text }: { text: string }) {
  const urls = linksIn(text);
  if (!urls.length) return null;
  return (
    <span className="pn-links">
      {urls.map((u) => (
        <button key={u} className="pn-link" title={u} onClick={(ev) => { ev.stopPropagation(); api.openExternal(u); }}>
          <img src={`https://www.google.com/s2/favicons?sz=32&domain=${host(u)}`} alt="" width={12} height={12} />
          <span>{host(u)}</span>
        </button>
      ))}
    </span>
  );
}

// Right-edge drawer: everything agents have produced, as a calm list you can tick off or drag onto a card.
export default function Outputs() {
  const { outputsOpen, set, entities, byId, accounts, runs, inspector, open, notify, board } = useStore();
  const [tab, setTab] = useState<'recent' | 'saved'>('recent');
  const [wide, setWide] = useState(() => localStorage.getItem('sb.outputsWide') === '1');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [done, setDone] = useState<string[]>([]);
  const [past, setPast] = useState<Run[]>([]);
  const [full, setFull] = useState<Record<string, string>>({});
  const [showDone, setShowDone] = useState(false);
  const [recent, setRecent] = useState<Recent[]>([]);

  useEffect(() => {
    api.getSetting<string[]>('outputsDone', []).then((d) => setDone(Array.isArray(d) ? d : [])).catch(() => {});
    api.runs().then(setPast).catch(() => {});
  }, []);
  useEffect(() => {
    if (!outputsOpen) return;
    const t = setTimeout(() => api.call<Recent[]>('outputs:recent', 40).then((r) => setRecent(Array.isArray(r) ? r : [])).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [outputsOpen, entities]);
  useEffect(() => {
    localStorage.setItem('sb.outputsWide', wide ? '1' : '0');
    document.documentElement.style.setProperty('--out-w', wide ? '70vw' : '420px');
  }, [wide]);
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
      out.push({ id: e.id, ref: e.id, title: e.title, sub: from?.title, source: from?.source || 'output', color: colorOf(from?.id), ts: e.updatedAt, text: full[e.id] || e.preview || '', sourceId: e.id, saved: true });
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
    const seen = new Set(out.map((x) => `${x.ref}:${x.text.trim().slice(0, 80)}`));
    for (const r of recent) {
      if (seen.has(`${r.id}:${r.text.trim().slice(0, 80)}`)) continue;
      const card = byId[r.id];
      // Replies to work you sent from Switchboard always count; anything else must read like a deliverable.
      if (!r.sent && (card?.meta?.noise || card?.meta?.internal || !isDeliverable(r.text, card?.status, card?.title || r.title))) continue;
      out.push({ id: `rc:${r.id}:${r.ts}`, ref: r.id, title: firstLine(r.text) || 'Reply', sub: r.title, source: r.source, color: colorOf(r.id), ts: r.ts, text: r.text, sourceId: r.id });
    }
    return out.sort((a, b) => Number(!!b.working) - Number(!!a.working) || b.ts - a.ts);
  }, [entities, byId, accounts, runs, past, full, recent]);

  const groupOf = useMemo(() => {
    const rows: Record<string, any> = {};
    for (const r of board) rows[r.id] = r;
    return (ref: string) => {
      const e = byId[ref];
      const client = e?.meta?.client || e?.meta?.clientName;
      if (typeof client === 'string' && client) return client;
      const p = rows[ref]?.parent_id;
      const label = p ? dataOf(rows[p]?.data).label : '';
      return label ? String(label).replace(/^Example\s*·\s*/i, '') : 'Other';
    };
  }, [board, byId]);

  const doneSet = new Set(done);
  const saved = items.filter((x) => x.saved);
  const todo = items.filter((x) => !x.saved && !doneSet.has(x.id));
  const finished = items.filter((x) => !x.saved && doneSet.has(x.id));
  const count = todo.filter((x) => !x.working).length;
  const busy = todo.some((x) => x.working);

  // Load full output text so a drag carries everything, not just the preview.
  useEffect(() => {
    if (!outputsOpen) return;
    const need = todo.filter((x) => x.id.startsWith('out:') && full[x.id] === undefined).slice(0, 40);
    need.forEach((x) => api.transcript(x.id).then((t) => setFull((f) => ({ ...f, [x.id]: t[0]?.text || '' }))).catch(() => {}));
  }, [outputsOpen, todo.length]);

  const groups = (xs: Item[]) => {
    const m = new Map<string, Item[]>();
    for (const x of xs) { const g = groupOf(x.ref); if (!m.has(g)) m.set(g, []); m.get(g)!.push(x); }
    return [...m.entries()].sort((a, b) => Number(a[0] === 'Other') - Number(b[0] === 'Other'));
  };
  const toggle = (id: string) => {
    const next = doneSet.has(id) ? done.filter((d) => d !== id) : [...done, id].slice(-500);
    setDone(next); api.setSetting('outputsDone', next);
  };
  const openItem = (x: Item) => { open(x.ref); (window as any).__sbCenter?.(x.ref); };

  const copy = (x: Item) => { api.copy(x.text); notify('Copied'); };
  const flip = (id: string) => setExpanded((m) => ({ ...m, [id]: !m[id] }));

  const row = (x: Item) => (
    <div key={x.id} className={`pn-out ${doneSet.has(x.id) ? 'done' : ''} ${expanded[x.id] ? 'open' : ''}`} draggable={!!x.text} title={x.text ? 'Drag onto a card' : undefined}
      onDragStart={(ev) => dragOutput(ev, { text: x.text, title: x.title, sourceId: x.sourceId })}>
      {x.working
        ? <span className="pn-check busy"><AgentLogo source={x.source} size={12} color={x.color} working /></span>
        : <button className="pn-check" onClick={(ev) => { ev.stopPropagation(); toggle(x.id); }} title={doneSet.has(x.id) ? 'Mark as not done' : 'Mark done'}><Check size={11} /></button>}
      <span className="pn-out-main">
        <span className="pn-out-top">
          <span className="t" onClick={() => openItem(x)}>{x.title}</span>
          <span className="pn-out-age">{ago(x.ts)}</span>
        </span>
        {x.sub && <span className="s">{!x.working && (x.source === 'output' ? <FileText size={10} /> : <AgentLogo source={x.source} size={10} color={x.color} />)}<span className="ell">{x.sub}</span></span>}
        {x.text.trim() && !x.working && (
          <div className={`pn-out-prev md ${expanded[x.id] ? '' : 'clamp'}`} onClick={() => flip(x.id)} title={expanded[x.id] ? 'Collapse' : 'Expand'}
            dangerouslySetInnerHTML={{ __html: md(x.text) }} />
        )}
        {!x.working && <Links text={x.text} />}
        {!x.working && x.text.trim() && (
          <span className="pn-out-acts">
            <button onClick={() => flip(x.id)}>{expanded[x.id] ? 'Less' : 'More'}</button>
            <button onClick={() => copy(x)} title="Copy"><Copy size={12} /></button>
            <button onClick={() => openItem(x)} title="Open"><ArrowUpRight size={12} /></button>
          </span>
        )}
      </span>
    </div>
  );

  return (
    <div className={`pn-outputs ${outputsOpen ? 'open' : ''} ${wide ? 'wide' : ''} ${inspector && !outputsOpen ? 'covered' : ''}`}>
      <button className="pn-out-face" onClick={() => set({ outputsOpen: true })} title="Outputs" tabIndex={outputsOpen ? -1 : 0}>
        <Inbox size={15} />
        {count > 0 && <span className="n">{count}</span>}
        {busy && <i className="pn-busy" />}
      </button>
      <div className="pn-out-panel" aria-hidden={!outputsOpen}>
        <div className="pn-out-head">
          <span className="pn-tabs">
            <button className={tab === 'recent' ? 'on' : ''} onClick={() => setTab('recent')}>Recent{count > 0 && <em>{count}</em>}</button>
            <button className={tab === 'saved' ? 'on' : ''} onClick={() => setTab('saved')}>Saved{saved.length > 0 && <em>{saved.length}</em>}</button>
          </span>
          <button className="icon-btn" onClick={() => setWide(!wide)} title={wide ? 'Narrow' : 'Expand'}>{wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
          <button className="icon-btn" onClick={() => set({ outputsOpen: false })} title="Close"><ChevronRight size={15} /></button>
        </div>
        <div className="pn-out-list">
          {tab === 'saved' && (saved.length ? saved.map(row) : <div className="pn-none">Save a reply to keep it here</div>)}
          {tab === 'recent' && todo.length === 0 && <div className="pn-none">Nothing new</div>}
          {tab === 'recent' && groups(todo).map(([g, xs]) => (
            <div key={g} className="pn-group">
              {g !== 'Other' || todo.length !== xs.length ? <div className="pn-group-h">{g}</div> : null}
              {xs.map(row)}
            </div>
          ))}
          {tab === 'recent' && finished.length > 0 && (
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
