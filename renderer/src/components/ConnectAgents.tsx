import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Check, Copy, X } from 'lucide-react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { AgentLogo } from './Logos';
import './connect.css';

export const useConnectAgents = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));

type RelayStatus = { url: string; mcpUrl: string; enabled: boolean; active: boolean; hasBotToken: boolean };

// {MCP} and {TOKEN} are filled in by the main process when copying (relay:copy), so the token never
// reaches this window. Same setup lines as Settings → Accounts → Switchboard Relay.
type Step = { text: string; value?: string };
const APPS: { id: string; source: string; label: string; steps: Step[] }[] = [
  { id: 'grok-bot', source: 'grok-bot', label: 'Grok Bot', steps: [
    { text: 'Plugins → Add custom MCP server. URL:', value: '{MCP}?app=grok-bot' },
    { text: 'Add a header named Authorization with the value:', value: 'Bearer {TOKEN}' },
  ] },
  { id: 'claude', source: 'claude-code', label: 'Claude app & claude.ai', steps: [
    { text: 'Settings → Connectors → Add custom connector, with this URL:', value: '{MCP}?app=claude&key={TOKEN}' },
    { text: 'Turn it on for the chats that should report.' },
  ] },
  { id: 'claude-code', source: 'claude-code', label: 'Claude Code elsewhere', steps: [
    { text: 'Run once on each other computer or cloud box (this Mac already shows up):', value: 'claude mcp add --transport http --scope user switchboard-relay "{MCP}?app=claude-code" --header "Authorization: Bearer {TOKEN}"' },
  ] },
  { id: 'cursor', source: 'cursor', label: 'Cursor', steps: [
    { text: 'Add to ~/.cursor/mcp.json:', value: '{"mcpServers":{"switchboard-relay":{"url":"{MCP}?app=cursor","headers":{"Authorization":"Bearer {TOKEN}"}}}}' },
  ] },
  { id: 'codex', source: 'codex', label: 'Codex', steps: [
    { text: 'Add to ~/.codex/config.toml:', value: '[mcp_servers.switchboard-relay]\nurl = "{MCP}?app=codex&key={TOKEN}"' },
  ] },
  { id: 'chatgpt', source: 'chatgpt', label: 'ChatGPT', steps: [
    { text: 'Create a custom connector (developer mode), no authentication, with this URL:', value: '{MCP}?app=chatgpt&key={TOKEN}' },
  ] },
];

const DONE_KEY = 'sb.connectDone';
const readDone = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem(DONE_KEY) || '{}') || {}; } catch { return {}; } };

// "Connect your agents": add the Switchboard Relay MCP to each app once, and they report here.
export default function ConnectAgents() {
  const { open, set } = useConnectAgents();
  const notify = useStore((s) => s.notify);
  const [st, setSt] = useState<RelayStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [done, setDone] = useState(readDone);

  useEffect(() => {
    if (!open) return;
    setLoaded(false);
    api.call<RelayStatus>('relay:status').then(setSt).catch(() => setSt(null)).finally(() => setLoaded(true));
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); set(false); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open]);
  if (!open) return null;

  const setUp = !!st?.url;
  const mcp = st?.mcpUrl || '';
  const shown = (v: string) => v.replaceAll('{MCP}', mcp).replaceAll('{TOKEN}', st?.hasBotToken ? '••••••••' : '<BOT_TOKEN>');
  const copy = async (template: string) => {
    try {
      const r = await api.call<{ full: boolean }>('relay:copy', template);
      notify(r.full || !template.includes('{TOKEN}') ? 'Copied' : 'Copied. Replace <BOT_TOKEN> with your agent token.');
    } catch (e: any) { notify(e.message || 'Could not copy'); }
  };
  const toggle = (id: string) => {
    const next = { ...done, [id]: !done[id] };
    setDone(next);
    localStorage.setItem(DONE_KEY, JSON.stringify(next));
  };
  const openSettings = () => { set(false); useStore.getState().set({ settingsTab: 'accounts' }); };
  const count = APPS.filter((a) => done[a.id]).length;

  return createPortal(
    <div className="ca-back" onMouseDown={() => set(false)}>
      <div className="ca" role="dialog" aria-label="Connect your agents" data-testid="connect-agents" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ca-head">
          <b>Connect your agents</b>
          {loaded && <span className={`ca-status ${st?.active ? 'on' : ''}`} data-testid="connect-status">{st?.active ? 'Relay connected' : setUp ? 'Relay off' : 'Relay not set up'}</span>}
          {setUp && <span className="ca-count">{count} / {APPS.length} done</span>}
          <button className="ca-x" onClick={() => set(false)} aria-label="Close"><X size={15} /></button>
        </div>
        <p className="ca-lede">Add Switchboard to each app once. After that they report here automatically.</p>
        {loaded && !setUp && (
          <div className="ca-wait" data-testid="connect-waiting">
            <span>Waiting for the relay to be set up.</span>
            <button className="ca-btn" onClick={openSettings}>Open settings</button>
          </div>
        )}
        {setUp && (
          <div className="ca-list">
            {!st?.active && (
              <div className="ca-wait"><span>The relay is saved but switched off, so nothing will show until it's on.</span>
                <button className="ca-btn" onClick={openSettings}>Open settings</button></div>
            )}
            {APPS.map((a) => (
              <div key={a.id} className={`ca-row ${done[a.id] ? 'done' : ''}`} data-testid={`connect-${a.id}`}>
                <div className="ca-row-head">
                  <AgentLogo source={a.source} size={15} />
                  <b>{a.label}</b>
                  <label className="ca-done">
                    <input type="checkbox" checked={!!done[a.id]} onChange={() => toggle(a.id)} />Done
                  </label>
                </div>
                {a.steps.map((s, i) => (
                  <div key={i} className="ca-step">
                    <span>{a.steps.length > 1 ? `${i + 1}. ` : ''}{s.text}</span>
                    {s.value && (
                      <div className="ca-val">
                        <span className="mono" title={shown(s.value)}>{shown(s.value)}</span>
                        <button className="ca-btn" onClick={() => copy(s.value!)}><Copy size={12} />Copy</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
            {!st?.hasBotToken && <p className="ca-hint">Copy leaves &lt;BOT_TOKEN&gt; in place. Save your agent token in Settings → Accounts → Switchboard Relay and Copy fills it in.</p>}
            {count === APPS.length && <p className="ca-hint"><Check size={12} /> All connected.</p>}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
