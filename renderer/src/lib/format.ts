import { marked } from 'marked';
import DOMPurify from 'dompurify';

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
  'claude-code': { label: 'Claude Code', color: '#C0603E' },
  codex: { label: 'Codex', color: '#3A3936' },
  granola: { label: 'Granola', color: '#5E7F3A' },
  gmail: { label: 'Gmail', color: '#9A4B5B' },
  cursor: { label: 'Cursor', color: '#4E6E7E' },
  'grok-bot': { label: 'Grok Bot', color: '#7A5A8C' },
  'anthropic-api': { label: 'Claude API', color: '#B08A2E' },
  'openai-compatible': { label: 'Model API', color: '#4E6E7E' },
  project: { label: 'Project', color: '#3F7A5E' },
  crm: { label: 'Client', color: '#2F6B55' },
  output: { label: 'Output', color: '#5F5C55' },
  note: { label: 'Note', color: '#B08A2E' },
};

export const PROMPTABLE = (id: string) => /^(cc|cx|cu|lc|pj|ac|cl):/.test(id);
