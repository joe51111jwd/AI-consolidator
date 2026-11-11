import React, { useEffect, useState } from 'react';
import { Plus, LogIn, LogOut, Trash2, Copy, X, KeyRound, Check, RefreshCw, Terminal, ExternalLink, TriangleAlert, ChevronRight } from 'lucide-react';
import { useStore } from '../lib/store';
import { api, Account, ClaudeAuth } from '../lib/api';
import { SOURCE, tokens } from '../lib/format';
import { AgentLogo } from '../components/Logos';
import RelaySettings from '../components/RelaySettings';

type Kind = { kind: string; label: string; blurb: string };
const KINDS: Kind[] = [
  { kind: 'claude-code', label: 'Claude account', blurb: 'Your Claude login, through Claude Code.' },
  { kind: 'gmail', label: 'Gmail', blurb: 'Read-only, with Google sign-in.' },
  { kind: 'granola', label: 'Granola', blurb: 'Meeting notes on this Mac.' },
  { kind: 'grok-bot', label: 'Grok Bot', blurb: 'Your Grok bots and their chats, from the app.' },
];
// Key-based and rarely used sources stay out of the way.
const ADVANCED: Kind[] = [
  { kind: 'codex', label: 'Codex', blurb: 'Codex CLI sessions.' },
  { kind: 'cursor', label: 'Cursor cloud agents', blurb: 'Uses a Cursor API key.' },
  { kind: 'anthropic-api', label: 'Claude API key', blurb: 'Chats billed to an Anthropic key.' },
  { kind: 'openai-compatible', label: 'Grok API or other model API', blurb: 'Any OpenAI-compatible key. Defaults to xAI.' },
];
const PERMISSIONS: [string, string][] = [['default', 'Ask first'], ['acceptEdits', 'Edit files'], ['bypassPermissions', 'Full access']];

function grokText(sb: string) {
  return [
    'You can reach my other AI agents on my Mac through Switchboard.',
    `Run "${sb} cards" to list them, and "${sb} send --from grok-bot --wait <card name> <message>" to hand one a task and get its reply.`,
    `Add notes everyone should know with "${sb} brain append <note>".`,
  ].join('\n');
}

function freeClaudeDir(accounts: Account[]) {
  const used = new Set(accounts.filter((a) => a.kind === 'claude-code').map((a) => (a.config.configDir || '~/.claude').replace(/\/$/, '')));
  if (!used.has('~/.claude')) return '~/.claude';
  for (let i = 2; ; i++) if (!used.has(`~/.claude-${i}`)) return `~/.claude-${i}`;
}

function planLabel(p?: string | null) {
  if (!p) return null;
  const m: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
  return m[p.toLowerCase()] || p.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// Sign-in state for one Claude account card. Each card has its own Claude Code folder, so two
// plans on the same email (for example a Team org and a personal Max plan) stay separate.
function ClaudeSignIn({ a, all }: { a: Account; all: Account[] }) {
  const { notify } = useStore();
  const live = useStore((s) => s.auth[a.id]);
  const st: ClaudeAuth | undefined = a.config.auth;
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!st || Date.now() - st.checkedAt > 10 * 60000) api.claudeStatus(a.id).catch(() => {}); }, [a.id]);
  const waiting = live?.phase === 'waiting';
  const twin = st?.loggedIn && all.find((b) => b.id !== a.id && b.kind === 'claude-code' && b.config.auth?.loggedIn
    && b.config.auth.email === st.email && (st.orgId && b.config.auth.orgId ? b.config.auth.orgId === st.orgId : (b.config.auth.org || '') === (st.org || '') && (b.config.auth.plan || '') === (st.plan || '')));
  const signIn = async () => {
    try { const r = await api.claudeLogin(a.id); notify(r.loggedIn ? `${a.label} is signed in` : 'Sign-in did not finish'); }
    catch (e: any) { if (!/cancel/i.test(e.message)) notify(e.message); }
  };
  const check = async () => { setBusy(true); await api.claudeStatus(a.id).catch(() => {}); setBusy(false); };
  return (
    <div className="signin" data-testid={`claude-auth-${a.id}`}>
      {waiting ? (
        <div className="signin-row"><span className="status running"><i /></span><span>Finish in the browser and pick the organization for this card.</span></div>
      ) : st?.loggedIn ? (
        <div className="signin-row">
          <span className="chip green"><Check size={11} />Signed in</span>
          <span className="who">{st.email || 'claude.ai account'}{st.org ? ` · ${st.org}` : ''}{st.plan ? ` · ${planLabel(st.plan)}` : ''}</span>
        </div>
      ) : st && !st.cli ? (
        <div className="signin-row"><span className="chip amber"><TriangleAlert size={11} />Claude Code not found</span><span className="who">Install it, then Check.</span></div>
      ) : st ? (
        <div className="signin-row"><span className="chip amber"><KeyRound size={11} />Not signed in</span></div>
      ) : <div className="signin-row hint">Checking…</div>}
      {twin && <div className="hint" style={{ color: 'var(--amber)' }}>Same login as {twin.label}. Sign out here and sign in again with the other organization.</div>}
      {live?.phase === 'error' && live.error && !/cancel/i.test(live.error) && <div className="hint" style={{ color: 'var(--red)' }}>{live.error}</div>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {waiting ? (<>
          {live?.url && <button className="btn" onClick={() => api.openExternal(live.url!)}><ExternalLink size={13} />Open sign-in page</button>}
          <button className="btn" onClick={() => api.claudeLoginCancel(a.id)}>Cancel</button>
        </>) : st?.loggedIn ? (<>
          <button className="btn" disabled={busy} onClick={check}><RefreshCw size={13} />Check</button>
          <button className="btn" onClick={async () => { await api.claudeLogout(a.id).catch((e) => notify(e.message)); }}><LogOut size={13} />Sign out</button>
        </>) : (<>
          <button className="btn accent" onClick={signIn}><LogIn size={13} />Sign in</button>
          <button className="btn" disabled={busy} onClick={check}><RefreshCw size={13} />Check</button>
          <button className="btn ghost" title="Open Terminal in this account's folder and type /login" onClick={async () => { const cmd = await api.loginAccount(a.id); notify(window.sbBridge.platform === 'darwin' ? 'Opened Terminal. Type /login there.' : `Run: ${cmd}`); }}><Terminal size={13} />Terminal</button>
        </>)}
      </div>
    </div>
  );
}

// Folders this Claude account is dedicated to: new work started in them always uses it.
function Dedicated({ a, map, onChange }: { a: Account; map: Record<string, string>; onChange: (m: Record<string, string>) => void }) {
  const [dir, setDir] = useState('');
  const mine = Object.entries(map).filter(([, id]) => id === a.id).map(([p]) => p);
  const add = () => {
    const p = dir.trim().replace(/\/+$/, '');
    if (!p) return;
    onChange({ ...map, [p]: a.id }); setDir('');
  };
  const remove = (p: string) => { const m = { ...map }; delete m[p]; onChange(m); };
  return (
    <div className="dedicated" data-testid={`dedicated-${a.id}`}>
      <div className="hint">Dedicated to {mine.length ? '' : 'no folders yet. New work in a folder added here always uses this account.'}</div>
      {mine.length > 0 && <div className="chips">{mine.map((p) => (
        <span key={p} className="chip mono" title={p}>{p}<button className="icon-btn" aria-label={`Remove ${p}`} onClick={() => remove(p)}><X size={11} /></button></span>
      ))}</div>}
      <div style={{ display: 'flex', gap: 6 }}>
        <input className="mono" style={{ flex: 1, minWidth: 0 }} placeholder="~/Projects/client-site" value={dir} onChange={(e) => setDir(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button className="btn" disabled={!dir.trim()} onClick={add}><Plus size={13} />Add folder</button>
      </div>
    </div>
  );
}

type GrokStatus = { enabled: boolean; installed: boolean; running: boolean; signedIn: boolean; bots: number; cache: boolean };

function KindButton({ k, onPick }: { k: Kind; onPick: (k: Kind) => void }) {
  return (
    <button className="due-item" onClick={() => onPick(k)}>
      <span style={{ display: 'grid', placeItems: 'center' }}><AgentLogo source={k.kind} size={16} /></span>
      <div><div className="t">{k.label}</div><div className="s">{k.blurb}</div></div>
    </button>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;
}

export default function Accounts() {
  const { accounts, entities, notify } = useStore();
  const [edit, setEdit] = useState<any | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [split, setSplit] = useState(true);
  const [tools, setTools] = useState<{ on: boolean; results: string[] } | null>(null);
  const [toolsBusy, setToolsBusy] = useState(false);
  const [grok, setGrok] = useState<GrokStatus | null>(null);
  const [grokAuto, setGrokAuto] = useState(true);
  const [axOk, setAxOk] = useState<boolean | null>(null);
  const [dedicated, setDedicated] = useState<Record<string, string>>({});
  const [detected, setDetected] = useState<string[]>([]);
  const [gmailBusy, setGmailBusy] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [bus, setBus] = useState<{ tokenFile: string; port: string | null } | null>(null);
  const sbPath = '~/.switchboard/bin/sb';
  useEffect(() => { useStore.getState().refresh(true); api.getSetting('splitUsage', true).then(setSplit); api.detect().then((d) => setDetected(d.claude)); api.busInfo().then(setBus);
    api.call('agentTools:get').then(setTools).catch(() => {});
    api.call('grokbot:status').then(setGrok).catch(() => {});
    api.getSetting('grokAutoSend', true).then(setGrokAuto);
    const checkAx = () => api.call('perm:status').then((p: { accessibility: boolean }) => setAxOk(p.accessibility)).catch(() => {});
    checkAx(); window.addEventListener('focus', checkAx);
    api.getSetting<Record<string, string>>('accountForPath', {}).then((m) => setDedicated(m || {}));
    return () => window.removeEventListener('focus', checkAx);
  }, []);
  const saveDedicated = (m: Record<string, string>) => { setDedicated(m); api.setSetting('accountForPath', m); };
  const setAgentTools = async (on: boolean) => {
    setToolsBusy(true); setTools((t) => ({ results: [], ...t, on }));
    try { setTools(await api.call('agentTools:set', on)); } catch (e: any) { notify(e.message); }
    setToolsBusy(false);
  };
  const setGrokOn = async (on: boolean) => { try { setGrok(await api.call('grokbot:setEnabled', on)); refresh(); } catch (e: any) { notify(e.message); } };
  const refresh = () => useStore.getState().refresh(true);

  const save = async () => {
    const { secretsIn, ...a } = edit;
    try { await api.saveAccount({ ...a, secrets: secretsIn }); } catch (e: any) { notify(e.message); return; }
    setEdit(null); await refresh(); notify('Saved');
  };
  const pick = (k: Kind) => setEdit({
    ...edit, kind: k.kind,
    label: k.kind === 'openai-compatible' ? 'Grok API' : k.kind === 'claude-code' ? 'Claude' : k.label,
    config: k.kind === 'openai-compatible' ? { baseUrl: 'https://api.x.ai/v1', model: 'grok-4' } : k.kind === 'claude-code' ? { configDir: freeClaudeDir(accounts) } : {},
  });
  const usageOf = (id: string) => entities.find((e) => e.id === `ac:${id}`)?.meta?.usage;
  const field = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setEdit({ ...edit, config: { ...edit.config, [k]: e.target.value } });
  const secret = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setEdit({ ...edit, secretsIn: { ...edit.secretsIn, [k]: e.target.value } });

  return (
    <div className="page">
      <div className="page-h">
        <span className="hint">Keys stay encrypted in your Keychain.</span>
        <span className="spacer" />
        <button className="btn primary" onClick={() => { setAdvanced(false); setEdit({ kind: '', config: {}, secretsIn: {} }); }}><Plus size={14} />Add account</button>
      </div>

      <div className="accounts-grid">
        {accounts.map((a) => {
          const u = usageOf(a.id); const src = SOURCE[a.kind] || { label: a.kind, color: '#888' };
          const sub = [src.label !== a.label && src.label, a.config.configDir, a.config.email].filter(Boolean).join(' · ');
          return (
            <div key={a.id} className="card acc-card" style={{ cursor: 'default', '--ring': a.color } as React.CSSProperties}>
              <div className="acc-head">
                <div className="avatar"><AgentLogo source={a.kind} size={17} /></div>
                <div className="grow"><div className="t">{a.label}</div><div className="s" title={sub}>{sub}</div></div>
                <div className="acc-actions">
                  <button className="btn ghost" onClick={() => setEdit({ ...a, secretsIn: {} })}>Edit</button>
                  {confirmDel === a.id
                    ? <button className="btn danger" onClick={async () => { await api.deleteAccount(a.id); setConfirmDel(null); refresh(); useStore.getState().refreshBoard(); }}>Remove</button>
                    : <button className="icon-btn" title="Remove account" onClick={() => setConfirmDel(a.id)}><Trash2 size={14} /></button>}
                </div>
              </div>
              {u && <div className="stats"><span><b>{tokens(u.h5)}</b> 5 hr</span><span><b>{tokens(u.d1)}</b> today</span><span><b>{tokens(u.d7)}</b> 7 days</span></div>}
              {a.kind === 'claude-code' && <ClaudeSignIn a={a} all={accounts} />}
              {a.kind === 'claude-code' && <Dedicated a={a} map={dedicated} onChange={saveDedicated} />}
              {a.kind === 'grok-bot' && grok && (
                <div className="hint">{!grok.installed ? 'Grok Bot app not found on this Mac.' : !grok.enabled ? 'Connection off.' : `${grok.bots} bot${grok.bots === 1 ? '' : 's'} · ${grok.running ? (grok.signedIn ? 'app running' : 'app running, not signed in') : 'app closed (showing last sync)'}`}</div>
              )}
              {a.secrets && Object.keys(a.secrets).length > 0 && (
                <div className="chips">{Object.entries(a.secrets).map(([k, v]) => <span key={k} className={`chip ${v ? 'green' : 'amber'}`}>{v ? <Check size={11} /> : <KeyRound size={11} />}{k === 'refresh' ? (v ? 'Signed in' : 'Not signed in') : k.replace('_', ' ')}</span>)}</div>
              )}
              {a.kind === 'gmail' && (
                <div><button className="btn accent" disabled={gmailBusy === a.id} onClick={async () => { setGmailBusy(a.id); try { const email = await api.gmailConnect(a.id); notify(`Connected ${email}`); refresh(); } catch (e: any) { notify(e.message); } setGmailBusy(null); }}><LogIn size={13} />{gmailBusy === a.id ? 'Waiting for Google…' : a.secrets?.refresh ? 'Reconnect' : 'Sign in with Google'}</button></div>
              )}
            </div>
          );
        })}
        {!accounts.length && <div className="empty">No accounts yet.</div>}
      </div>

      <div className="panel">
        <div className="panel-h">Connections</div>
        <div className="set-row">
          <div className="txt"><b>Let agents use Switchboard</b><span className="hint">Your Claude and Codex agents can see your cards, send each other work and add to the shared brain. Set up automatically.</span></div>
          <Toggle label="Let agents use Switchboard" on={tools ? tools.on : true} onChange={(v) => { if (!toolsBusy) setAgentTools(v); }} />
        </div>
        {tools && tools.results.length > 0 && <div className="well" data-testid="agent-tools-results">{tools.results.map((r) => <div key={r}>{r}</div>)}</div>}
        <RelaySettings />
        <div className="set-row">
          <div className="txt"><b>Grok Bot</b><span className="hint">{grok && grok.enabled ? `${grok.bots} bot${grok.bots === 1 ? '' : 's'}${grok.running ? '' : ' · app closed'}` : 'Off'}</span></div>
          <Toggle label="Connect Grok Bot" on={grok ? grok.enabled : true} onChange={setGrokOn} />
        </div>
        {(!grok || grok.enabled) && (<>
          <div className="set-row">
            <div className="txt"><b>Send in background</b><span className="hint">Sends without leaving Switchboard.</span></div>
            <Toggle label="Send in background" on={grokAuto} onChange={(v) => { setGrokAuto(v); api.setSetting('grokAutoSend', v); }} />
          </div>
          {grokAuto && (
            <div className="set-row" data-testid="grok-accessibility">
              <div className="txt"><b>Accessibility</b><span className="hint">Needed to send for you.</span></div>
              {axOk
                ? <span className="chip green"><Check size={11} />Allowed</span>
                : <button className="btn" onClick={async () => { try { const p = await api.call('perm:openAccessibility'); setAxOk(p.accessibility); } catch (e: any) { notify(e.message); } }}><ExternalLink size={13} />Open Settings</button>}
            </div>
          )}
        </>)}
        <div className="set-row">
          <div className="txt"><b>Balance usage</b><span className="hint">On: new work goes to the Claude account used least in the last 5 hours. Off: the first account. Dedicated folders always win.</span></div>
          <Toggle label="Balance usage" on={split} onChange={(v) => { setSplit(v); api.setSetting('splitUsage', v); }} />
        </div>
        <details className="more">
          <summary>Let a Grok bot message your other agents (optional)</summary>
          <p className="hint">Needs "Execution on this computer" on in Grok Bot. Paste this into the bot once.</p>
          <button className="btn" onClick={() => { api.copy(grokText(sbPath)); notify('Copied'); }}><Copy size={13} />Copy note for Grok Bot</button>
        </details>
        <details className="more">
          <summary>The sb command</summary>
          <div className="well mono" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{`${sbPath} cards\n${sbPath} send "client-site" "Fix the footer" --wait\n${sbPath} board "Plan" --json '{"nodes":[...],"edges":[...]}'\n${sbPath} brain append "Client wants Friday delivery"`}</div>
          {bus && <p className="hint">Listening on 127.0.0.1:{bus.port}. Only programs that can read <span className="mono">{bus.tokenFile}</span> can use it.</p>}
        </details>
      </div>

      {edit && (
        <div className="overlay" onClick={() => setEdit(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex' }}><h3>{edit.id ? edit.label : edit.kind ? (SOURCE[edit.kind]?.label || 'Add account') : 'Add account'}</h3><button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => setEdit(null)}><X size={16} /></button></div>
            {!edit.kind ? (
              <div className="kind-list">
                {KINDS.map((k) => <KindButton key={k.kind} k={k} onPick={pick} />)}
                <button className={`disclose ${advanced ? 'open' : ''}`} onClick={() => setAdvanced(!advanced)}><ChevronRight size={13} />Advanced</button>
                {advanced && ADVANCED.map((k) => <KindButton key={k.kind} k={k} onPick={pick} />)}
              </div>
            ) : (
              <div className="form">
                <div className="field"><label>Name</label><input value={edit.label || ''} onChange={(e) => setEdit({ ...edit, label: e.target.value })} /></div>
                {edit.kind === 'claude-code' && (<>
                  <div className="field"><label>Folder</label><input className="mono" value={edit.config.configDir || ''} onChange={field('configDir')} />
                    <span className="hint">One folder per Claude login, like ~/.claude-2. After saving, press Sign in and pick the organization.{detected.length ? ` Found: ${detected.join(', ')}` : ''}</span></div>
                  <div className="field"><label>Permissions</label>
                    <select value={edit.config.permissionMode || 'default'} onChange={field('permissionMode')}>
                      {PERMISSIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select></div>
                </>)}
                {edit.kind === 'codex' && <div className="field"><label>Codex folder</label><input className="mono" placeholder="~/.codex" value={edit.config.home || ''} onChange={field('home')} /></div>}
                {edit.kind === 'granola' && <div className="field"><label>Cache file (optional)</label><input className="mono" value={edit.config.path || ''} onChange={field('path')} /></div>}
                {(edit.kind === 'anthropic-api' || edit.kind === 'openai-compatible') && (<>
                  {edit.kind === 'openai-compatible' && <div className="field"><label>API base URL</label><input className="mono" value={edit.config.baseUrl || ''} onChange={field('baseUrl')} /></div>}
                  <div className="field"><label>Model</label><input className="mono" placeholder={edit.kind === 'anthropic-api' ? 'claude-sonnet-5-5' : 'grok-4'} value={edit.config.model || ''} onChange={field('model')} /></div>
                  <div className="field"><label>API key {edit.secrets?.key ? '(saved)' : ''}</label><input type="password" value={edit.secretsIn.key || ''} onChange={secret('key')} /></div>
                </>)}
                {edit.kind === 'cursor' && <div className="field"><label>Cursor API key {edit.secrets?.key ? '(saved)' : ''}</label><input type="password" value={edit.secretsIn.key || ''} onChange={secret('key')} /><span className="hint">Cursor dashboard → API Keys.</span></div>}
                {edit.kind === 'gmail' && (<>
                  <div className="field"><label>Google OAuth client ID {edit.secrets?.client_id ? '(saved)' : ''}</label><input value={edit.secretsIn.client_id || ''} onChange={secret('client_id')} /></div>
                  <div className="field"><label>Client secret</label><input type="password" value={edit.secretsIn.client_secret || ''} onChange={secret('client_secret')} /><span className="hint">A Desktop-app client with the Gmail API on (steps in the README). Then Sign in with Google.</span></div>
                </>)}
                {edit.kind === 'grok-bot' && <p className="hint">Reads your bots from the Grok Bot app on this Mac. Messages go straight into the bot you send to.</p>}
                <div style={{ display: 'flex', gap: 8 }}><button className="btn primary" onClick={save}>Save</button>{!edit.id && <button className="btn" onClick={() => setEdit({ ...edit, kind: '' })}>Back</button>}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
