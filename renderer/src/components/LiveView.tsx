import React, { useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Download, RotateCw, Search, X } from 'lucide-react';
import { useStore } from '../lib/store';
import { useImport } from './ImportChats';
import { dueLabel } from '../lib/format';
import { DAY, groupItems, Item, Section, useItems } from './home/items';
import { placeInTopics, useTopics } from './home/topics';
import TopicSection from './home/TopicSection';
import './live.css';

export { clean, toolVerb } from './home/items';

type Filter = 'all' | 'claude' | 'grok' | 'desktop' | 'attn';
type GroupBy = 'topic' | 'status' | 'account';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'claude', label: 'Claude' }, { id: 'grok', label: 'Grok' },
  { id: 'desktop', label: 'Desktop' }, { id: 'attn', label: 'Needs you' },
];
const GROUP_BY: { id: GroupBy; label: string }[] = [{ id: 'topic', label: 'Topic' }, { id: 'status', label: 'Status' }, { id: 'account', label: 'Account' }];
const savedGroupBy = (): GroupBy => {
  const v = localStorage.getItem('sb.homeGroup');
  return v === 'status' || v === 'account' ? v : 'topic';
};

// Brings a topic's chats into view on the board: fit them all, or center the first if fitting fails.
function useOpenOnBoard(onMode?: (m: 'board' | 'live') => void) {
  const rf = useReactFlow();
  return (ids: string[]) => {
    onMode?.('board');
    setTimeout(() => {
      const on = ids.filter((id) => rf.getInternalNode(id));
      if (!on.length) { useStore.getState().notify('Not on the board yet — use Import chats to add them'); return; }
      rf.fitView({ nodes: on.map((id) => ({ id })), padding: 0.25, maxZoom: 1, duration: 450 })
        .catch(() => (window as any).__sbCenter?.(on[0]));
    }, 80);
  };
}

// What you owe people: replies, follow-ups and client next steps (the same list as "what's due").
function ToDo() {
  const due = useStore((s) => s.due);
  const open = useStore((s) => s.open);
  const [all, setAll] = useState(false);
  if (!due.length) return null;
  const list = all ? due : due.slice(0, 5);
  return (
    <section className="lv-section flat lv-todo" data-testid="home-todo">
      <h3 className="lv-h">To do<span>{due.length}</span></h3>
      {list.map((d) => (
        <button key={d.id} className="lv-todo-row" onClick={() => open(d.ref)} data-testid="todo-row">
          <i className={`lv-todo-dot ${d.overdue ? 'late' : ''}`} />
          <span className="lv-todo-t">{d.title}</span>
          <span className="lv-todo-m">{[d.client, d.due ? dueLabel(d.due) : ''].filter(Boolean).join(' · ')}</span>
        </button>
      ))}
      {due.length > 5 && <button className="lv-more" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${due.length}`}</button>}
    </section>
  );
}

// The home: every current chat, sorted by what it is about, what needs you first.
export default function LiveView({ onMode }: { onMode?: (m: 'board' | 'live') => void }) {
  const all = useItems();
  const { topics, refresh, busy } = useTopics();
  const openOnBoard = useOpenOnBoard(onMode);
  const [filter, setFilter] = useState<Filter>(() => (localStorage.getItem('sb.liveFilter') as Filter) || 'all');
  const [groupBy, setGroupByState] = useState<GroupBy>(savedGroupBy);
  const [q, setQ] = useState('');
  const [earlier, setEarlier] = useState(false);
  const pick = (f: Filter) => { setFilter(f); localStorage.setItem('sb.liveFilter', f); };
  const setGroupBy = (g: GroupBy) => { setGroupByState(g); localStorage.setItem('sb.homeGroup', g); };

  const summary = useMemo(() => ({
    working: all.filter((i) => i.running).length,
    attn: all.filter((i) => i.attn).length,
    chats: all.filter((i) => i.running || i.attn || (i.e.updatedAt || 0) >= Date.now() - 7 * DAY).length,
  }), [all]);

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
    const since = Date.now() - 7 * DAY;
    const needs: Item[] = [], working: Item[] = [], recent: Item[] = [], older: Item[] = [];
    for (const i of shown) {
      if (i.attn) needs.push(i);
      else if (i.running) working.push(i);
      else if ((i.e.updatedAt || 0) >= since) recent.push(i);
      else older.push(i);
    }
    return { needs, working, recent, older: older.slice(0, 200) };
  }, [shown]);

  const placed = useMemo(() => placeInTopics(shown, topics), [shown, topics]);
  const topicGroups = useMemo(() => placed.groups.filter((g) => g.items.some((it) => !it.attn)), [placed]);
  const accountGroups = useMemo(() => groupItems([...sections.working, ...sections.recent]), [sections]);

  const olderList = groupBy === 'topic' ? placed.older.slice(0, 200) : sections.older;
  const current = groupBy === 'topic' ? topicGroups.length : sections.working.length + sections.recent.length;
  const empty = !all.length;
  const none = !empty && !sections.needs.length && !current && !(earlier && olderList.length);

  return (
    <div className="lv" data-testid="live-view" data-tour="home">
      <div className="lv-col">
        <div className="hm-head">
          <div className="lv-summary" data-testid="live-summary">
            <span><b>{summary.working}</b> working</span><i />
            <span className={summary.attn ? 'warn' : ''}><b>{summary.attn}</b> needs you</span><i />
            <span><b>{summary.chats}</b> chats</span>
          </div>
          <div className="hm-groupby" role="tablist" aria-label="Group by">
            <span>Group by</span>
            {GROUP_BY.map((g) => (
              <button key={g.id} role="tab" aria-selected={groupBy === g.id} className={groupBy === g.id ? 'on' : ''}
                data-testid={`home-group-${g.id}`} onClick={() => setGroupBy(g.id)}>{g.label}</button>
            ))}
            {groupBy === 'topic' && (
              <button className={`hm-refresh ${busy ? 'spin' : ''}`} data-testid="topics-refresh" title="Re-sort into topics" disabled={busy} onClick={refresh}>
                <RotateCw size={12} />
              </button>
            )}
          </div>
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
          <button className="lv-import" data-testid="live-import" data-tour="import" onClick={() => useImport.getState().set(true)} title="Bring past chats onto the board"><Download size={13} />Import chats</button>
        </div>

        {empty && <div className="lv-empty" data-testid="live-empty">No chats yet. Start one from the dock below, or import the ones you have.</div>}
        {none && <div className="lv-empty" data-testid="live-empty">{q || filter !== 'all' ? 'Nothing matches.' : 'All quiet. Nothing in the past week.'}</div>}

        <Section title="Needs you" items={sections.needs} testId="live-needs" flat tour="home-row" />
        {!q && filter === 'all' && <ToDo />}

        {groupBy === 'topic' && topicGroups.map((g, i) => (
          <TopicSection key={g.id} g={g} first={i === 0} rowTour={i === 0 && !sections.needs.length} onBoard={openOnBoard} />
        ))}
        {groupBy === 'status' && (
          <>
            <Section title="Working now" items={sections.working} testId="live-working" tour={sections.needs.length ? undefined : 'home-row'} />
            <Section title="This week" items={sections.recent} testId="live-recent" />
          </>
        )}
        {groupBy === 'account' && accountGroups.map((g, i) => (
          <Section key={g.key} title={g.label} items={g.items} testId="live-account" flat tour={i === 0 && !sections.needs.length ? 'home-row' : undefined} />
        ))}

        {earlier && <Section title="Earlier" items={olderList} testId="live-earlier" />}
        {olderList.length > 0 && (
          <button className="lv-more" onClick={() => setEarlier(!earlier)}>{earlier ? 'Hide earlier' : `Show ${olderList.length} earlier`}</button>
        )}
      </div>
    </div>
  );
}
