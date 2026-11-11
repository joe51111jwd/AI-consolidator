// The apps an agent can report from. A connector URL names its app (/mcp?app=claude), so every call
// through it is filed under that app; an agent may also say it in the call.
export const APPS = ['grok-bot', 'claude', 'claude-code', 'cursor', 'codex', 'chatgpt', 'other'];
export const appOf = (v) => (APPS.includes(v) ? v : null);

// An agent's key: its display name, lowercased, with runs of anything but letters and digits as '-'.
// The Switchboard app uses the same key to match relay agents to its cards.
export const agentKey = (name) => String(name || '').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'agent';

export function clip(s, n) {
  if (s == null) return undefined;
  const t = String(s).trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export const httpUrl = (u) => (typeof u === 'string' && /^https?:\/\/\S+$/i.test(u.trim()) ? u.trim().slice(0, 2000) : undefined);

export function ago(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - (ts || now)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
