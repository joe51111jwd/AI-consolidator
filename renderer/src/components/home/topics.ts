import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { DAY, Item } from './items';

export type Topic = { id: string; label: string; summary: string; ids: string[] };
export type TopicGroup = { id: string; label: string; summary: string; items: Item[]; working: number; attn: number; latest: number };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';

// Topics from the main process (rules at once, Claude's version when it lands), refetched when the
// chats change. Without a main process that knows topics, the home falls back to its own grouping.
export function useTopics() {
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await api.call<{ topics: Topic[] }>('topics:get');
      if (alive.current && Array.isArray(r?.topics)) setTopics(r.topics);
    } catch { /* older main process: keep the local grouping */ }
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api.call<{ topics: Topic[] }>('topics:refresh');
      if (alive.current && Array.isArray(r?.topics)) setTopics(r.topics);
    } catch { /* keep what is shown */ } finally { if (alive.current) setBusy(false); }
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = api.onEvent((e) => {
      if (e?.type === 'topics-changed') load();
      if (e?.type === 'entities-changed') { clearTimeout(t); t = setTimeout(load, 1500); }
    });
    return () => { alive.current = false; clearTimeout(t); off?.(); };
  }, [load]);

  return { topics, refresh, busy };
}

const isCurrent = (it: Item, since: number) => it.running || it.attn || (it.e.updatedAt || 0) >= since;

// Puts each current chat under its topic. Chats the topics don't know yet join the topic named
// like their folder or client chip, else one of their own, else "Other".
export function placeInTopics(items: Item[], topics: Topic[] | null): { groups: TopicGroup[]; older: Item[] } {
  const since = Date.now() - 3 * DAY;
  const byId = new Map<string, Topic>();
  for (const t of topics || []) for (const id of t.ids) if (!byId.has(id)) byId.set(id, t);
  const groups = new Map<string, TopicGroup>();
  const byLabel = new Map<string, TopicGroup>();
  const ensure = (id: string, label: string, summary: string) => {
    let g = groups.get(id) || byLabel.get(label.toLowerCase());
    if (!g) {
      g = { id, label, summary, items: [], working: 0, attn: 0, latest: 0 };
      groups.set(id, g); byLabel.set(label.toLowerCase(), g);
    }
    return g;
  };
  for (const t of topics || []) ensure(t.id, t.label, t.summary);
  const older: Item[] = [];
  for (const it of items) {
    const t = byId.get(it.e.id);
    if (!t && !isCurrent(it, since)) { older.push(it); continue; }
    const label = t?.label || it.chip || (it.family === 'grok' ? it.e.title || 'Grok' : 'Other');
    const g = t ? ensure(t.id, t.label, t.summary) : ensure(`t:${slug(label)}`, label, '');
    g.items.push(it);
    if (it.running) g.working++;
    if (it.attn) g.attn++;
    g.latest = Math.max(g.latest, it.e.updatedAt || 0);
  }
  const list = [...groups.values()].filter((g) => g.items.length);
  for (const g of list) g.items.sort((a, b) => Number(b.running) - Number(a.running) || (b.e.updatedAt || 0) - (a.e.updatedAt || 0));
  list.sort((a, b) => Number(b.working > 0) - Number(a.working > 0) || b.attn - a.attn || b.working - a.working || b.latest - a.latest);
  // "Other" is a catch-all; it never leads.
  const other = list.findIndex((g) => g.label === 'Other');
  if (other >= 0 && list.length > 1) list.push(...list.splice(other, 1));
  return { groups: list, older };
}
