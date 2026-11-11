import { useStore } from './store';
import type { Account } from './api';

// The Claude models a chat can pick per message; '' is the account's default. The main process
// accepts the same ids (MODELS in electron/sources/claudeCode.cjs) and refuses anything else.
// Used by the composer's picker and the New chat sheet, so both send the same thing.
export const MODELS = [
  { id: '', label: 'Default' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
] as const;

const KEY = (cardId: string) => `sb.model.${cardId}`;
const CHANGED = 'sb:model';
const valid = (m: unknown): m is string => typeof m === 'string' && MODELS.some((x) => x.id === m);

// The model last picked for a card (remembered on this Mac), or '' for the default.
export function savedModel(cardId: string): string {
  try { const m = localStorage.getItem(KEY(cardId)) || ''; return valid(m) ? m : ''; } catch { return ''; }
}

export function saveModel(cardId: string, model: string) {
  try {
    if (model && valid(model)) localStorage.setItem(KEY(cardId), model);
    else localStorage.removeItem(KEY(cardId));
  } catch {}
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: { id: cardId, model: valid(model) ? model : '' } }));
}

// Calls fn when a card's remembered model changes (from another composer, or a chat it started).
export function onModelChange(fn: (cardId: string, model: string) => void): () => void {
  const h = (e: Event) => { const d = (e as CustomEvent).detail || {}; fn(d.id, d.model); };
  window.addEventListener(CHANGED, h);
  return () => window.removeEventListener(CHANGED, h);
}

// Cards whose messages go to Claude Code: its chats, and the project, client and Claude account
// cards that start one.
export function takesModel(cardId: string, accounts: Account[]): boolean {
  const [kind, acc] = cardId.split(':');
  if (kind === 'cc' || kind === 'pj' || kind === 'cl') return true;
  return kind === 'ac' && accounts.some((a) => a.id === acc && a.kind === 'claude-code');
}

// A message from a project, client or account card (or the New chat sheet) starts a new chat. That
// chat keeps the model it was started with; resuming it later would otherwise use the default.
useStore.subscribe((s, prev) => {
  if (s.runs === prev.runs) return;
  for (const r of Object.values(s.runs)) {
    if (prev.runs[r.id] === r || !r.model) continue;
    const to = r.result?.entityId as string | undefined;
    if (to && to !== r.entityId && prev.runs[r.id]?.result?.entityId !== to && !savedModel(to)) saveModel(to, r.model);
  }
});
