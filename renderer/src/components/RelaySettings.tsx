import React, { useEffect, useState } from 'react';
import { Copy, Check, RefreshCw, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import { HERE } from '../lib/platform';
import { useStore } from '../lib/store';
import { ago } from '../lib/format';

type RelayStatus = {
  url: string; mcpUrl: string; enabled: boolean; active: boolean; hasToken: boolean; hasBotToken: boolean;
  lastSync: { at: number; ok: boolean; error?: string; count?: number } | null; agents: { name: string; app: string; at: number }[];
};

// How to connect each kind of agent. {MCP} is the connector address and {TOKEN} the agent token: the
// main process fills them in when copying, so the token never reaches this window.
type Step = { text: string; value?: string };
const APPS: { id: string; label: string; steps: Step[] }[] = [
  { id: 'grok-bot', label: 'Grok Bot', steps: [
    { text: 'Plugins → Add custom MCP server. URL:', value: '{MCP}?app=grok-bot' },
    { text: 'Add a header named Authorization with the value:', value: 'Bearer {TOKEN}' },
  ] },
  { id: 'claude', label: 'Claude (app and claude.ai)', steps: [
    { text: "Settings → Connectors → Add custom connector. Use this URL (the token is in it, since Claude's connectors can't send headers):", value: '{MCP}?app=claude&key={TOKEN}' },
    { text: 'Turn it on for the chats that should report.' },
    { text: "So a Project's chats show under that Project, add this line to the Project's instructions (with its name):", value: 'When you report to Switchboard, use project "<Project name>".' },
  ] },
  { id: 'claude-code', label: 'Claude Code (cloud or other computers)', steps: [
    { text: `Run once. Claude Code on ${HERE} already shows up without it.`, value: 'claude mcp add --transport http --scope user switchboard-relay "{MCP}?app=claude-code" --header "Authorization: Bearer {TOKEN}"' },
  ] },
  { id: 'cursor', label: 'Cursor', steps: [
    { text: 'Add to ~/.cursor/mcp.json:', value: '{"mcpServers":{"switchboard-relay":{"url":"{MCP}?app=cursor","headers":{"Authorization":"Bearer {TOKEN}"}}}}' },
  ] },
  { id: 'codex', label: 'Codex', steps: [
    { text: 'Add to ~/.codex/config.toml:', value: '[mcp_servers.switchboard-relay]\nurl = "{MCP}?app=codex&key={TOKEN}"' },
  ] },
  { id: 'chatgpt', label: 'ChatGPT', steps: [
    { text: 'Create a custom connector (developer mode) with no authentication and this URL:', value: '{MCP}?app=chatgpt&key={TOKEN}' },
  ] },
  { id: 'other', label: 'Any other MCP client', steps: [
    { text: 'URL:', value: '{MCP}?app=other' },
    { text: 'With the header Authorization:', value: 'Bearer {TOKEN}' },
    { text: 'Or, for clients that cannot send headers, this URL alone:', value: '{MCP}?app=other&key={TOKEN}' },
  ] },
];
const APP_LABEL: Record<string, string> = { 'grok-bot': 'Grok', claude: 'Claude', 'claude-code': 'Claude Code', cursor: 'Cursor', codex: 'Codex', chatgpt: 'ChatGPT', other: 'Agent' };

// Switchboard Relay: an always-on MCP connector (relay/ in this repo, deployed on Vercel) that agents
// report to from anywhere. Lives in Settings → Accounts → Connections.
export default function RelaySettings() {
  const { notify } = useStore();
  const [st, setSt] = useState<RelayStatus | null>(null);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [botToken, setBotToken] = useState('');
  const [app, setApp] = useState('grok-bot');
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; text: string; warnings?: string[] } | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    api.call<RelayStatus>('relay:status').then((s) => { setSt(s); setUrl(s.url); }).catch(() => {});
    const off = api.onEvent((e) => { if (e.type === 'relay' && e.status) setSt(e.status); });
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => { off(); clearInterval(t); };
  }, []);

  const configure = async (extra: Record<string, unknown> = {}) => {
    const s = await api.call<RelayStatus>('relay:configure', { url, appToken: token || undefined, botToken: botToken || undefined, ...extra });
    setSt(s); setUrl(s.url); setToken(''); setBotToken('');
    return s;
  };
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e: any) { notify(e.message); } setBusy(false); };
  const save = () => run(async () => { await configure(); notify('Saved'); });
  const test = () => run(async () => {
    setCheck(null);
    await configure();
    try {
      const r = await api.call<{ storage: string; warnings: string[] }>('relay:test');
      setCheck({ ok: true, text: `Connected · ${r.storage === 'upstash' ? 'Redis storage' : 'memory storage'}`, warnings: r.warnings });
    } catch (e: any) { setCheck({ ok: false, text: e.message }); }
  });
  const toggle = (on: boolean) => run(async () => {
    if (on && !(url.trim() && (token.trim() || st?.hasToken))) throw new Error('Add the relay URL and app token first.');
    const s = await configure({ enabled: on });
    if (on && s.lastSync && !s.lastSync.ok) notify(s.lastSync.error || 'The relay did not answer');
  });
  const sync = () => run(async () => { setSt(await api.call<RelayStatus>('relay:sync')); });
  const copy = async (template: string) => {
    const r = await api.call<{ full: boolean }>('relay:copy', template);
    notify(r.full || !template.includes('{TOKEN}') ? 'Copied' : 'Copied. Replace <BOT_TOKEN> with your agent token.');
  };

  const on = !!st?.enabled;
  const last = st?.lastSync;
  const mcp = st?.mcpUrl || 'https://<your-relay>.vercel.app/mcp';
  const shown = (v: string) => v.replaceAll('{MCP}', mcp).replaceAll('{TOKEN}', st?.hasBotToken ? '••••••••' : '<BOT_TOKEN>');
  const reporting = (st?.agents || []).slice(0, 3).map((a) => `${a.name} (${APP_LABEL[a.app] || a.app}) ${ago(a.at)}`).join(', ');
  const picked = APPS.find((a) => a.id === app) || APPS[0];
  return (
    <div data-testid="relay">
      <div className="set-row">
        <div className="txt">
          <b>Switchboard Relay</b>
          <span className="hint">One always-on MCP connector for all your agents: Grok bots, Claude chats, Claude Code in the cloud, Cursor, Codex, ChatGPT. Their cards keep moving with {HERE} or their apps closed, and messages you send them wait there until they check in. Agents can read a short summary of your board. Gmail and Granola connect through their own sign-ins above.</span>
        </div>
        <button role="switch" aria-checked={on} aria-label="Switchboard Relay" data-testid="relay-toggle" className={`switch ${on ? 'on' : ''}`} disabled={busy} onClick={() => toggle(!on)} />
      </div>
      <div className="form" style={{ paddingBottom: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 8 }}>
          <div className="field"><label>Relay URL</label>
            <input className="mono" data-testid="relay-url" placeholder="https://switchboard-relay.vercel.app" value={url} onChange={(e) => setUrl(e.target.value)} /></div>
          <div className="field"><label>App token {st?.hasToken ? '(saved)' : ''}</label>
            <input type="password" data-testid="relay-token" placeholder={st?.hasToken ? '••••••••' : 'APP_TOKEN'} value={token} onChange={(e) => setToken(e.target.value)} /></div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn" data-testid="relay-save" disabled={busy} onClick={save}>Save</button>
          <button className="btn" data-testid="relay-test" disabled={busy || !url.trim()} onClick={test}>Test</button>
          {on && <button className="btn ghost" data-testid="relay-sync" disabled={busy} onClick={sync}><RefreshCw size={13} />Sync now</button>}
          {check && <span className={`chip ${check.ok ? 'green' : 'amber'}`} data-testid="relay-check" title={check.text}>{check.ok ? <Check size={11} /> : <TriangleAlert size={11} />}{check.ok ? check.text : 'Not connected'}</span>}
          <span className="hint" data-testid="relay-last">{!on ? 'Off' : !last ? 'Not synced yet' : last.ok ? `Synced ${ago(last.at)}${reporting ? ` · ${reporting}` : ''}` : `Last try ${ago(last.at)} failed`}</span>
        </div>
        {check && !check.ok && <div className="hint" style={{ color: 'var(--red)' }}>{check.text}</div>}
        {on && last && !last.ok && last.error && !(check && !check.ok) && <div className="hint" style={{ color: 'var(--red)' }}>{last.error}</div>}
        {check?.warnings?.map((w) => <div key={w} className="hint" style={{ color: 'var(--amber)' }}>{w}</div>)}
        <div className="well" data-testid="relay-steps" style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <b style={{ fontWeight: 600, flex: 1 }}>Connect an agent, once</b>
            <select data-testid="relay-app" value={app} onChange={(e) => setApp(e.target.value)}
              style={{ border: '1px solid var(--line-2)', borderRadius: 9, padding: '4px 8px', background: 'var(--card)' }}>
              {APPS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </div>
          {picked.steps.map((s, i) => (
            <div key={`${picked.id}-${i}`} style={{ display: 'grid', gap: 4 }}>
              <span>{picked.steps.length > 1 ? `${i + 1}. ` : ''}{s.text}</span>
              {s.value && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span className="mono" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={shown(s.value)}>{shown(s.value)}</span>
                  <button className="btn" style={{ background: 'var(--card)' }} data-testid={`relay-copy-${i + 1}`} onClick={() => copy(s.value!)}><Copy size={13} />Copy</button>
                </div>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="password" className="mono" data-testid="relay-bot-token" style={{ flex: 1, minWidth: 0, border: '1px solid var(--line-2)', borderRadius: 9, padding: '6px 10px', background: 'var(--card)' }}
              placeholder={st?.hasBotToken ? 'Agent token saved' : 'BOT_TOKEN (optional, so Copy fills it in)'} value={botToken} onChange={(e) => setBotToken(e.target.value)} />
            <button className="btn" style={{ background: 'var(--card)' }} data-testid="relay-bot-save" disabled={busy || !botToken.trim()} onClick={save}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
