import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Check, Copy, Loader2, X } from 'lucide-react';
import { api } from '../lib/api';
import { HERE } from '../lib/platform';
import { useStore } from '../lib/store';
import { AgentLogo } from './Logos';
import './connect.css';

export const useConnectAgents = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));

export type RelayStatus = { url: string; mcpUrl: string; enabled: boolean; active: boolean; hasBotToken: boolean; apps?: Record<string, number> };

// {MCP} and {TOKEN} are filled in by the main process when copying (relay:copy), so the token never
// reaches this window. Same setup lines as Settings → Accounts → Switchboard Relay.
type Step = { text: string; value?: string };
export type ConnectApp = { id: string; source: string; label: string; steps: Step[] };
export const CONNECT_APPS: ConnectApp[] = [
  { id: 'grok-bot', source: 'grok-bot', label: 'Grok Bot', steps: [
    { text: 'Plugins → Add custom MCP server. URL:', value: '{MCP}?app=grok-bot' },
    { text: 'Add a header named Authorization with the value:', value: 'Bearer {TOKEN}' },
  ] },
  { id: 'claude', source: 'claude-code', label: 'Claude app & claude.ai', steps: [
    { text: 'Settings → Connectors → Add custom connector, with this URL:', value: '{MCP}?app=claude&key={TOKEN}' },
    { text: 'Turn it on for the chats that should report.' },
  ] },
  { id: 'claude-code', source: 'claude-code', label: 'Claude Code elsewhere', steps: [
    { text: `Run once on each other computer or cloud box (${HERE} already shows up):`, value: 'claude mcp add --transport http --scope user switchboard-relay "{MCP}?app=claude-code" --header "Authorization: Bearer {TOKEN}"' },
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

const APPS = CONNECT_APPS;

// The relay's status. While `watch` is on it pulls from the relay every few seconds, so an app
// that just added the connector shows as connected right away.
export function useRelay(watch: boolean) {
  const [st, setSt] = useState<RelayStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!watch) return;
    let live = true;
    setLoaded(false);
    api.call<RelayStatus>('relay:status').then((s) => { if (live) setSt(s); }).catch(() => { if (live) setSt(null); }).finally(() => { if (live) setLoaded(true); });
    const t = setInterval(() => { api.call<RelayStatus>('relay:sync').then((s) => { if (live && s) setSt(s); }).catch(() => {}); }, 3000);
    return () => { live = false; clearInterval(t); };
  }, [watch]);
  return { st, loaded };
}

export function useCopySetup() {
  const notify = useStore((s) => s.notify);
  return async (template: string) => {
    try {
      const r = await api.call<{ full: boolean }>('relay:copy', template);
      notify(r.full || !template.includes('{TOKEN}') ? 'Copied' : 'Copied. Replace <BOT_TOKEN> with your agent token.');
    } catch (e: any) { notify(e.message || 'Could not copy'); }
  };
}

// One app's connector setup lines, each with a Copy button.
export function ConnectSteps({ app, st }: { app: ConnectApp; st: RelayStatus | null }) {
  const copy = useCopySetup();
  const shown = (v: string) => v.replaceAll('{MCP}', st?.mcpUrl || '').replaceAll('{TOKEN}', st?.hasBotToken ? '••••••••' : '<BOT_TOKEN>');
  return (<>
    {app.steps.map((s, i) => (
      <div key={i} className="ca-step">
        <span>{app.steps.length > 1 ? `${i + 1}. ` : ''}{s.text}</span>
        {s.value && (
          <div className="ca-val">
            <span className="mono" title={shown(s.value)}>{shown(s.value)}</span>
            <button className="ca-btn" onClick={() => copy(s.value!)}><Copy size={12} />Copy</button>
          </div>
        )}
      </div>
    ))}
  </>);
}

export function ConnectState({ on, waiting = false }: { on: boolean; waiting?: boolean }) {
  if (on) return <span className="ca-state on" data-testid="connect-state"><Check size={11} />Connected</span>;
  return waiting
    ? <span className="ca-state" data-testid="connect-state"><Loader2 size={11} className="bt-spin" />Waiting for it to connect</span>
    : <span className="ca-state" data-testid="connect-state">Not connected</span>;
}

// "Connect your agents": add the Switchboard Relay MCP to each app once, and they report here.
export default function ConnectAgents() {
  const { open, set } = useConnectAgents();
  const { st, loaded } = useRelay(open);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); set(false); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open]);
  if (!open) return null;

  const setUp = !!st?.url;
  const isOn = (id: string) => !!st?.apps?.[id];
  const openSettings = () => { set(false); useStore.getState().set({ settingsTab: 'accounts' }); };
  const count = APPS.filter((a) => isOn(a.id)).length;

  return createPortal(
    <div className="ca-back" onMouseDown={() => set(false)}>
      <div className="ca" role="dialog" aria-label="Connect your agents" data-testid="connect-agents" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ca-head">
          <b>Connect your agents</b>
          {loaded && <span className={`ca-status ${st?.active ? 'on' : ''}`} data-testid="connect-status">{st?.active ? 'Relay connected' : setUp ? 'Relay off' : 'Relay not set up'}</span>}
          {setUp && <span className="ca-count">{count} / {APPS.length} connected</span>}
          <button className="ca-x" onClick={() => set(false)} aria-label="Close"><X size={15} /></button>
        </div>
        <p className="ca-lede">Add the Switchboard connector to each app once. An app shows as connected the moment it reaches Switchboard.</p>
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
              <div key={a.id} className={`ca-row ${isOn(a.id) ? 'done' : ''}`} data-testid={`connect-${a.id}`}>
                <div className="ca-row-head">
                  <AgentLogo source={a.source} size={15} />
                  <b>{a.label}</b>
                  <ConnectState on={isOn(a.id)} />
                </div>
                <ConnectSteps app={a} st={st} />
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
