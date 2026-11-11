import { create } from 'zustand';
import { api, Entity, Run } from './api';
import { useStore } from './store';
import { hasApproval } from './approvals';

// A card needs you when it's your turn, it failed, a run finished since you last opened it,
// or a Grok bot is waiting on a reply. Opening the card clears it.
type Seen = { seen: Record<string, number>; base: number };

const baseKey = 'sb.attnBase';
const base = Number(localStorage.getItem(baseKey)) || (() => { const t = Date.now(); localStorage.setItem(baseKey, String(t)); return t; })();

export const useSeen = create<Seen>(() => ({ seen: {}, base }));

api.call<Record<string, number>>('attention:seen').then((m) => m && useSeen.setState({ seen: m })).catch(() => {});

export function markSeen(id: string) {
  const ts = Date.now();
  useSeen.setState((s) => ({ seen: { ...s.seen, [id]: ts } }));
  api.call('attention:mark', id, ts).catch(() => {});
}

let last: string | null = null;
useStore.subscribe((s) => {
  if (s.inspector === last) return;
  if (last) markSeen(last);
  if (s.inspector) markSeen(s.inspector);
  last = s.inspector;
});

export function needsAttention(e: Entity | undefined, live: Run | undefined, seenAt: number): boolean {
  if (!e || e.kind === 'note' || e.kind === 'output') return false;
  const m = e.meta || {};
  if (e.source === 'grok-bot' && (m.unreadCount > 0 || m.awaitingUserResponse) && (e.updatedAt || 0) > seenAt) return true;
  if (e.status === 'waiting' && (e.updatedAt || Date.now()) > seenAt) return true;
  if (e.status === 'error' && (e.updatedAt || Date.now()) > seenAt) return true;
  if (live && live.status !== 'running' && live.startedAt > seenAt) return true;
  return false;
}

// A chat waiting for your OK to run a tool needs you until you answer, opened or not.
export function useAttention(id: string): boolean {
  const e = useStore((s) => s.byId[id]);
  const live = useStore((s) => s.liveByEntity[id]);
  const asks = useStore((s) => hasApproval(s.approvals, id));
  const seenAt = useSeen((s) => s.seen[id] ?? s.base);
  return asks || needsAttention(e, live, seenAt);
}

export function attentionIds(ids: string[]): string[] {
  const { byId, liveByEntity, approvals } = useStore.getState();
  const { seen, base: b } = useSeen.getState();
  return ids.filter((id) => hasApproval(approvals, id) || needsAttention(byId[id], liveByEntity[id], seen[id] ?? b));
}
