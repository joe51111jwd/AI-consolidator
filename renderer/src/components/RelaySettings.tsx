import React, { useEffect, useState } from 'react';
import { Copy, Check, RefreshCw, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { ago } from '../lib/format';

type RelayStatus = {
  url: string; mcpUrl: string; enabled: boolean; active: boolean; hasToken: boolean; hasBotToken: boolean;
  lastSync: { at: number; ok: boolean; error?: string; count?: number } | null; bots: { name: string; at: number }[];
};

// Switchboard Relay: an always-on connector Grok bots report to from the cloud (relay/ in this repo,
// deployed on Vercel). Lives in the Grok Bot part of Settings → Accounts.
export default function RelaySettings() {
  const { notify } = useStore();
  const [st, setSt] = useState<RelayStatus | null>(null);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [botToken, setBotToken] = useState('');
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
  const copy = (text: string) => { api.copy(text); notify('Copied'); };
  const copyHeader = async () => { const r = await api.call<{ full: boolean }>('relay:copyHeader'); notify(r.full ? 'Copied the header value' : 'Copied. Replace <BOT_TOKEN> with your bot token.'); };

  const on = !!st?.enabled;
  const last = st?.lastSync;
  const mcpUrl = st?.mcpUrl || (url.trim() ? `${url.trim().replace(/\/+$/, '')}/mcp` : 'https://<your-relay>.vercel.app/mcp');
  const reporting = (st?.bots || []).slice(0, 3).map((b) => `${b.name} ${ago(b.at)}`).join(', ');
  return (
    <div data-testid="relay">
      <div className="set-row">
        <div className="txt">
          <b>Switchboard Relay</b>
          <span className="hint">Grok bots report to it from the cloud, so their cards keep moving with this Mac or Grok Bot closed. Messages you send a bot wait there until it checks in. Bots can read a short summary of your board.</span>
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
          <b style={{ fontWeight: 600 }}>In Grok Bot, once</b>
          <Step n={1} text="Plugins → Add custom MCP server. URL:" value={mcpUrl} onCopy={() => copy(mcpUrl)} testId="relay-copy-url" />
          <Step n={2} text="Add a header named Authorization with the value:" value={`Bearer ${st?.hasBotToken ? '••••••••' : '<BOT_TOKEN>'}`} onCopy={copyHeader} testId="relay-copy-header" />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="password" className="mono" style={{ flex: 1, minWidth: 0, border: '1px solid var(--line-2)', borderRadius: 9, padding: '6px 10px', background: 'var(--card)' }}
              placeholder={st?.hasBotToken ? 'Bot token saved' : 'BOT_TOKEN (optional, so Copy fills it in)'} value={botToken} onChange={(e) => setBotToken(e.target.value)} />
            <button className="btn" style={{ background: 'var(--card)' }} disabled={busy || !botToken.trim()} onClick={save}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Step({ n, text, value, onCopy, testId }: { n: number; text: string; value: string; onCopy: () => void; testId: string }) {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <span>{n}. {text}</span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span className="mono" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={value}>{value}</span>
        <button className="btn" style={{ background: 'var(--card)' }} data-testid={testId} onClick={onCopy}><Copy size={13} />Copy</button>
      </div>
    </div>
  );
}
