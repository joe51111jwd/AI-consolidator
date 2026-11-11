import React, { memo, useMemo, useRef, useState } from 'react';
import { Bot, Search, X } from 'lucide-react';
import { useStore } from '../lib/store';
import { Account, Entity, Run } from '../lib/api';
import { needsAttention, useSeen } from '../lib/attention';
import { ago, baseName, isNoise, PROMPTABLE } from '../lib/format';
import { AgentLogo, ClaudeLogo } from './Logos';
import { GrokAvatar } from './GrokAvatar';
import Composer from './Composer';
import './live.css';

type Filter = 'all' | 'claude' | 'grok' | 'desktop' | 'attn';
type Family = 'claude' | 'grok' | 'desktop' | 'cursor' | 'codex' | 'other';
type Item = {
  e: Entity; family: Family; group: string; groupLabel: string; running: boolean; attn: boolean;
  activity: string; chip: string; subs: number; subsLive: number;
};
type Group = { key: string; label: string; family: Family; items: Item[] };

const DAY = 86400000;
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'claude', label: 'Claude' }, { id: 'grok', label: 'Grok' },
  { id: 'desktop', label: 'Desktop' }, { id: 'attn', label: 'Needs you' },
];
const FAMILY_ORDER: Family[] = ['claude', 'grok', 'desktop', 'cursor', 'codex', 'other'];
const FAMILY_LABEL: Record<Family, string> = { claude: 'Claude', grok: 'Grok', desktop: 'Claude desktop', cursor: 'Cursor', codex: 'Codex', other: 'Other' };

function familyOf(e: Entity): Family {
  if (e.source === 'claude-app' || e.meta?.category === 'desktop') return 'desktop';
  if (e.source === 'grok-bot') return 'grok';
  if (e.source === 'cursor') return 'cursor';
  if (e.source === 'codex') return 'codex';
  if (e.source === 'claude-code' || e.source === 'anthropic-api') return 'claude';
  return 'other';
}

const clean = (s: string) => s.replace(/[#*`_>|[\]]/g, '').replace(/\s+/g, ' ').trim();

function activityOf(e: Entity, live: Run | undefined, running: boolean): string {
  const a = e.meta?.activity;
  if (running && live?.status === 'running' && live.text) return clean(live.text).slice(-140);
  if (typeof a === 'string') return clean(a).slice(0, 140);
  const now = a?.tool || (a?.text || '').split('\n').filter(Boolean).pop();
  if (now && (running || a?.running)) return clean(now).slice(0, 140);
  return clean(e.preview || now || '').slice(0, 140);
}

function clientChip(e: Entity, clientPaths: [string, string][]): string {
  if (e.meta?.client?.name) return e.meta.client.name;
  const cwd: string = e.meta?.cwd || '';
  if (cwd) for (const [p, name] of clientPaths) if (cwd === p || cwd.startsWith(`${p}/`)) return name;
  if (typeof e.meta?.project === 'string' && !e.meta.project.startsWith('pj:')) return e.meta.project;
  return baseName(cwd);
}

function attentionSet(): Set<string> {
  const flag = (window as any).__sbAttention;
  return new Set(Array.isArray(flag) ? flag : []);
}

function useItems(): Item[] {
  const entities = useStore((s) => s.entities);
  const live = useStore((s) => s.liveByEntity);
  const accounts = useStore((s) => s.accounts);
  const seen = useSeen((s) => s.seen);
  const base = useSeen((s) => s.base);
  return useMemo(() => {
    const accById: Record<string, Account> = {};
    for (const a of accounts) accById[a.id] = a;
    const clientPaths: [string, string][] = [];
    for (const e of entities) {
      const c = e.kind === 'client' ? e.meta?.client : null;
      for (const p of c?.project_paths || []) clientPaths.push([String(p).replace(/\/+$/, ''), c.name]);
    }
    clientPaths.sort((x, y) => y[0].length - x[0].length);
    const flagged = attentionSet();
    const out: Item[] = [];
    for (const e of entities) {
      if (e.kind !== 'session' || e.meta?.archived || isNoise(e)) continue;
      const family = familyOf(e);
      const run = live[e.id];
      const running = e.status === 'running' || run?.status === 'running' || !!(e.meta?.activity?.running);
      const acc = e.accountId ? accById[e.accountId] : undefined;
      const subs = Array.isArray(e.meta?.subagents) ? e.meta.subagents : [];
      out.push({
        e, family, running,
        group: `${family}:${family === 'desktop' ? '' : e.accountId || ''}`,
        groupLabel: family === 'desktop' || family === 'cursor' ? FAMILY_LABEL[family] : acc?.label || FAMILY_LABEL[family],
        attn: flagged.has(e.id) || needsAttention(e, run, seen[e.id] ?? base),
        activity: activityOf(e, run, running),
        chip: clientChip(e, clientPaths),
        subs: subs.length,
        subsLive: subs.filter((s: any) => s?.status === 'running').length,
      });
    }
    return out.sort((x, y) => (y.e.updatedAt || 0) - (x.e.updatedAt || 0));
  }, [entities, live, accounts, seen, base]);
}

function groupItems(items: Item[]): Group[] {
  const m = new Map<string, Group>();
  for (const it of items) {
    let g = m.get(it.group);
    if (!g) { g = { key: it.group, label: it.groupLabel, family: it.family, items: [] }; m.set(it.group, g); }
    g.items.push(it);
  }
  return [...m.values()].sort((a, b) => FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family) || a.label.localeCompare(b.label));
}

function RowLogo({ it }: { it: Item }) {
  const { e } = it;
  if (it.family === 'grok') return <GrokAvatar color={e.meta?.avatarColor} shape={e.meta?.avatarShape || 'circle'} size={22} working={it.running} />;
  if (it.family === 'desktop') return <ClaudeLogo size={16} working={it.running} />;
  return <AgentLogo source={e.source} size={16} working={it.running} />;
}

function GroupLogo({ g }: { g: Group }) {
  if (g.family === 'grok') return <AgentLogo source="grok-bot" size={12} />;
  if (g.family === 'desktop') return <ClaudeLogo size={12} />;
  return <AgentLogo source={g.items[0]?.e.source || ''} size={12} />;
}

const Row = memo(function Row({ it }: { it: Item }) {
  const [hot, setHot] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { e } = it;
  const canReply = PROMPTABLE(e.id) && !e.meta?.readOnly;
  const cool = () => { if (!ref.current?.contains(document.activeElement)) setHot(false); };
  return (
    <div ref={ref} className={`lv-row ${it.running ? 'running' : ''} ${it.attn ? 'attn' : ''} ${hot ? 'hot' : ''}`}
      data-testid="live-row" data-id={e.id} role="button" tabIndex={0}
      onClick={() => useStore.getState().open(e.id)}
      onKeyDown={(ev) => { if (ev.key === 'Enter' && ev.target === ev.currentTarget) useStore.getState().open(e.id); }}
      onMouseEnter={() => setHot(true)} onMouseLeave={cool}
      onBlur={(ev) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node) && !ev.currentTarget.matches(':hover')) setHot(false); }}>
      <span className="lv-logo">{<RowLogo it={it} />}</span>
      <div className="lv-body">
        <div className="lv-top">
          <span className="lv-title">{e.title || 'Untitled'}</span>
          {it.chip && <span className="lv-chip">{it.chip}</span>}
          {it.subs > 0 && (
            <span className={`lv-subs ${it.subsLive ? 'on' : ''}`} title={`${it.subs} subagent${it.subs === 1 ? '' : 's'}${it.subsLive ? `, ${it.subsLive} running` : ''}`}>
              <Bot size={11} />{it.subs}{it.subsLive > 0 && <em>{it.subsLive} live</em>}
            </span>
          )}
        </div>
        {it.activity && <div className="lv-act"><span className={it.running ? 'lv-shimmer' : ''}>{it.activity}</span></div>}
        {hot && canReply && (
          <div className="lv-reply" onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => ev.stopPropagation()}>
            <Composer id={e.id} placeholder={`Reply to ${e.title || 'this chat'}`} />
          </div>
        )}
      </div>
      <span className="lv-meta">
        {it.running ? <span className="lv-working"><i />Working</span> : <span className="lv-age">{ago(e.updatedAt)}</span>}
        {it.attn && <i className="lv-dot" data-testid="live-attn" title="Needs you" />}
      </span>
    </div>
  );
});

function Section({ title, items, testId }: { title: string; items: Item[]; testId: string }) {
  const groups = useMemo(() => groupItems(items), [items]);
  if (!items.length) return null;
  return (
    <section className="lv-section" data-testid={testId}>
      <h3 className="lv-h">{title}<span>{items.length}</span></h3>
      {groups.map((g) => (
        <div key={g.key} className="lv-group">
          <div className="lv-gh"><GroupLogo g={g} />{g.label}</div>
          {g.items.map((it) => <Row key={it.e.id} it={it} />)}
        </div>
      ))}
    </section>
  );
}

// Simple mode: every chat and bot as a calm list, what needs you first, then what is working, then today.
export default function LiveView() {
  const all = useItems();
  const [filter, setFilter] = useState<Filter>(() => (localStorage.getItem('sb.liveFilter') as Filter) || 'all');
  const [q, setQ] = useState('');
  const [earlier, setEarlier] = useState(false);
  const pick = (f: Filter) => { setFilter(f); localStorage.setItem('sb.liveFilter', f); };

  const summary = useMemo(() => {
    const midnight = new Date().setHours(0, 0, 0, 0);
    return {
      working: all.filter((i) => i.running).length,
      attn: all.filter((i) => i.attn).length,
      today: all.filter((i) => (i.e.updatedAt || 0) >= midnight).length,
    };
  }, [all]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((i) => {
      if (filter === 'attn' && !i.attn) return false;
      if (filter === 'claude' && i.family !== 'claude') return false;
      if (filter === 'grok' && i.family !== 'grok') return false;
      if (filter === 'desktop' && i.family !== 'desktop') return false;
      return !needle || (i.e.title || '').toLowerCase().includes(needle) || i.chip.toLowerCase().includes(needle);
    });
  }, [all, filter, q]);

  const sections = useMemo(() => {
    const since = Date.now() - DAY;
    const needs: Item[] = [], working: Item[] = [], recent: Item[] = [], older: Item[] = [];
    for (const i of shown) {
      if (i.attn) needs.push(i);
      else if (i.running) working.push(i);
      else if ((i.e.updatedAt || 0) >= since) recent.push(i);
      else older.push(i);
    }
    return { needs, working, recent, older: older.slice(0, 200) };
  }, [shown]);

  const empty = !all.length;
  const none = !empty && !sections.needs.length && !sections.working.length && !sections.recent.length && !(earlier && sections.older.length);

  return (
    <div className="lv" data-testid="live-view">
      <div className="lv-col">
        <div className="lv-summary" data-testid="live-summary">
          <span><b>{summary.working}</b> working</span><i />
          <span className={summary.attn ? 'warn' : ''}><b>{summary.attn}</b> need you</span><i />
          <span><b>{summary.today}</b> today</span>
        </div>
        <div className="lv-bar">
          <div className="lv-filters" role="tablist">
            {FILTERS.map((f) => (
              <button key={f.id} role="tab" aria-selected={filter === f.id} className={`lv-filter ${filter === f.id ? 'on' : ''}`}
                data-testid={`live-filter-${f.id}`} onClick={() => pick(f.id)}>
                {f.label}{f.id === 'attn' && summary.attn > 0 && <span className="n">{summary.attn}</span>}
              </button>
            ))}
          </div>
          <label className="lv-search">
            <Search size={13} />
            <input value={q} placeholder="Filter by title" data-testid="live-search" onChange={(ev) => setQ(ev.target.value)}
              onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Escape') setQ(''); }} />
            {q && <button onClick={() => setQ('')} title="Clear"><X size={12} /></button>}
          </label>
        </div>

        {empty && <div className="lv-empty" data-testid="live-empty">No chats yet. Start one from the dock below and it shows up here live.</div>}
        {none && <div className="lv-empty" data-testid="live-empty">{q || filter !== 'all' ? 'Nothing matches.' : 'All quiet. Nothing ran in the last day.'}</div>}

        <Section title="Needs you" items={sections.needs} testId="live-needs" />
        <Section title="Working now" items={sections.working} testId="live-working" />
        <Section title="Recent" items={sections.recent} testId="live-recent" />
        {earlier && <Section title="Earlier" items={sections.older} testId="live-earlier" />}
        {sections.older.length > 0 && (
          <button className="lv-more" onClick={() => setEarlier(!earlier)}>{earlier ? 'Hide earlier' : `Show ${sections.older.length} earlier`}</button>
        )}
      </div>
    </div>
  );
}
