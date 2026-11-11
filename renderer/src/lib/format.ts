import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Entity } from './api';

export function ago(ts?: number | null) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function tokens(n?: number | null) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}

export function md(text: string) {
  return DOMPurify.sanitize(marked.parse(text || '', { async: false, breaks: true }) as string);
}

export function dueLabel(ts?: number) {
  if (!ts) return '';
  const d = new Date(ts); const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - today.getTime()) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff < 0) return `${-diff}d late`;
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const SOURCE: Record<string, { label: string; color: string }> = {
  'claude-code': { label: 'Claude', color: '#D97757' },
  'claude-ai': { label: 'claude.ai', color: '#D97757' },
  codex: { label: 'Codex', color: '#10A37F' },
  granola: { label: 'Granola', color: '#5E7F3A' },
  gmail: { label: 'Gmail', color: '#D93025' },
  cursor: { label: 'Cursor', color: '#3F5E8C' },
  'grok-bot': { label: 'Grok Bot', color: '#6D5BD0' },
  'anthropic-api': { label: 'Claude API', color: '#B08A2E' },
  'openai-compatible': { label: 'Model API', color: '#4E6E7E' },
  chatgpt: { label: 'ChatGPT', color: '#10A37F' },
  relay: { label: 'Agent', color: '#52525B' },
  project: { label: 'Project', color: '#3F7A5E' },
  crm: { label: 'Client', color: '#2F6B55' },
  output: { label: 'Output', color: '#52525B' },
  note: { label: 'Note', color: '#CA8A04' },
};

export const PROMPTABLE = (id: string) => /^(cc|cx|cu|lc|pj|ac|cl):/.test(id);

export const baseName = (p?: string) => (p || '').replace(/\/+$/, '').split('/').pop() || '';

// Throwaway sessions (scratch workspaces, temp folders). The backend flags them (it knows the home
// folder, which is never noise); the path check only covers sources that don't set the flag.
const NOISE_RE = /\/scratch-workspaces\/|^(\/private)?\/tmp(\/|$)|^(\/private)?\/var\/folders\//;
export const isNoise = (e: Entity) => (typeof e.meta?.noise === 'boolean' ? e.meta.noise : e.kind === 'session' && NOISE_RE.test(e.meta?.cwd || ''));

// "coding" when a session ran in a repo or project folder, "chat" otherwise.
export function categoryOf(e: Entity): 'coding' | 'chat' | null {
  if (e.kind !== 'session') return null;
  if (e.meta?.category === 'coding' || e.meta?.category === 'chat') return e.meta.category;
  return e.source === 'cursor' || (e.meta?.cwd && e.meta?.gitBranch && e.meta.gitBranch !== 'HEAD') ? 'coding' : 'chat';
}

export function colorOf(e: Entity | undefined, accounts: { id: string; color: string }[] = []) {
  if (!e) return '#A1A1AA';
  return accounts.find((a) => a.id === e.accountId)?.color || e.meta?.color || SOURCE[e.source]?.color || '#71717A';
}
