import React, { useEffect, useState } from 'react';
import { Plus, LogIn, Trash2, Plug, Copy, X, KeyRound, Check } from 'lucide-react';
import { useStore } from '../lib/store';
import { api, Account } from '../lib/api';
import { SOURCE, tokens } from '../lib/format';

const KINDS: { kind: string; label: string; blurb: string }[] = [
  { kind: 'claude-code', label: 'Claude account (Claude Code)', blurb: 'Each Claude login gets its own folder. Sessions, usage and prompting come from Claude Code on this Mac.' },
  { kind: 'codex', label: 'Codex', blurb: 'Reads Codex CLI sessions and prompts them.' },
  { kind: 'gmail', label: 'Gmail', blurb: 'Read-only. Uses a Google OAuth client you create once (see README).' },
  { kind: 'granola', label: 'Granola', blurb: 'Reads the meeting notes the Granola app keeps on this Mac.' },
  { kind: 'grok-bot', label: 'Grok Bot', blurb: 'No public API. Grok Bot talks to your other agents through the sb command.' },
  { kind: 'cursor', label: 'Cursor cloud agents', blurb: 'Lists and prompts Cursor cloud agents with a Cursor API key.' },
  { kind: 'anthropic-api', label: 'Claude API key', blurb: 'Chats billed to an Anthropic API key.' },
  { kind: 'openai-compatible', label: 'Grok API or other model API', blurb: 'Any OpenAI-compatible API. Defaults to xAI (Grok).' },
];

function grokText(sb: string) {
  return [
    'You can reach my other AI agents on my Mac through Switchboard.',
    `Run "${sb} cards" to list them, and "${sb} send --from grok-bot --wait <card name> <message>" to hand one a task and get its reply.`,
    `Add notes everyone should know with "${sb} brain append <note>".`,
  ].join('\n');
}

export default function Accounts() {
  const { accounts, entities, notify } = useStore();
  const [edit, setEdit] = useState<any | null>(null);
  const [split, setSplit] = useState(true);
  const [mcp, setMcp] = useState<{ sb: string; results: string[] } | null>(null);
  const [detected, setDetected] = useState<string[]>([]);
  const [bus, setBus] = useState<{ tokenFile: string; port: string | null } | null>(null);
  const sbPath = '~/.switchboard/bin/sb';
  useEffect(() => { api.getSetting('splitUsage', true).then(setSplit); api.detect().then((d) => setDetected(d.claude)); api.busInfo().then(setBus); }, []);
  const refresh = () => useStore.getState().refresh(true);

  const save = async () => {
    const { secretsIn, ...a } = edit;
    await api.saveAccount({ ...a, secrets: secretsIn });
    setEdit(null); await refresh(); notify('Saved');
  };
  const usageOf = (id: string) => entities.find((e) => e.id === `ac:${id}`)?.meta?.usage;

  return (
    <div className="page">
      <div className="page-h">
        <div><h1>Accounts</h1><p>Everything Switchboard reads from. Keys are encrypted with your Mac's Keychain and never leave this computer.</p></div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setEdit({ kind: '', config: {}, secretsIn: {} })}><Plus size={14} />Add account</button>
      </div>

      <div className="accounts-grid">
        {accounts.map((a) => {
          const u = usageOf(a.id); const src = SOURCE[a.kind] || { label: a.kind, color: '#888' };
          return (
            <div key={a.id} className="card" style={{ cursor: 'default' }}>
              <div className="acc-head">
                <div className="avatar" style={{ background: a.color }}>{a.label.slice(0, 1)}</div>
                <div style={{ minWidth: 0 }}><div className="t">{a.label}</div><div className="s">{src.label}{a.config.configDir ? ` · ${a.config.configDir}` : ''}{a.config.email ? ` · ${a.config.email}` : ''}</div></div>
              </div>
              {u && <div className="stats"><span><b>{tokens(u.h5)}</b> last 5 hr</span><span><b>{tokens(u.d1)}</b> today</span><span><b>{tokens(u.d7)}</b> 7 days</span></div>}
              {a.secrets && Object.keys(a.secrets).length > 0 && (
                <div className="chips">{Object.entries(a.secrets).map(([k, v]) => <span key={k} className={`chip ${v ? 'green' : 'amber'}`}>{v ? <Check size={11} /> : <KeyRound size={11} />}{k === 'refresh' ? (v ? 'Signed in' : 'Not signed in') : k.replace('_', ' ')}</span>)}</div>
              )}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button className="btn" onClick={() => setEdit({ ...a, secretsIn: {} })}>Edit</button>
                {a.kind === 'claude-code' && <button className="btn" onClick={async () => { const cmd = await api.loginAccount(a.id); notify(window.sbBridge.platform === 'darwin' ? 'Opened Terminal. Type /login there.' : `Run: ${cmd}`); }}><LogIn size={13} />Log in</button>}
                {a.kind === 'gmail' && <button className="btn accent" onClick={async () => { try { const email = await api.gmailConnect(a.id); notify(`Connected ${email}`); refresh(); } catch (e: any) { notify(e.message); } }}><LogIn size={13} />{a.secrets?.refresh ? 'Reconnect' : 'Sign in with Google'}</button>}
                <button className="btn ghost danger" style={{ marginLeft: 'auto' }} onClick={async () => { await api.deleteAccount(a.id); refresh(); }}><Trash2 size={13} /></button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid2" style={{ marginTop: 22 }}>
        <div className="panel">
          <div className="panel-h"><Plug size={15} />Let your agents use Switchboard</div>
          <p style={{ color: 'var(--ink-2)', lineHeight: 1.55, marginTop: 0 }}>
            This adds Switchboard's tools to every Claude Code and Codex account above, so any session can list your cards, send work to another agent, read the shared brain and post outputs. Each message shows up on the board as it travels.
          </p>
          <button className="btn primary" onClick={async () => { try { setMcp(await api.installMcp()); } catch (e: any) { notify(e.message); } }}>Add Switchboard tools to my agents</button>
          {mcp && <div className="well" style={{ marginTop: 10 }}>{mcp.results.map((r) => <div key={r}>{r}</div>)}{!mcp.results.length && 'No Claude Code or Codex accounts yet.'}</div>}
          <div className="panel-h" style={{ marginTop: 18 }}>Grok Bot</div>
          <p style={{ color: 'var(--ink-2)', lineHeight: 1.55, marginTop: 0 }}>
            Turn on <b>Settings → Computer → Execution on this computer</b> in Grok Bot, then give it this note once. Grok Bot will still ask you before each command.
          </p>
          <div className="well mono" style={{ whiteSpace: 'pre-wrap' }}>{grokText(sbPath)}</div>
          <button className="btn" style={{ marginTop: 8 }} onClick={() => { api.copy(grokText(sbPath)); notify('Copied'); }}><Copy size={13} />Copy note for Grok Bot</button>
        </div>
        <div className="panel">
          <div className="panel-h">Split usage</div>
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', lineHeight: 1.5, color: 'var(--ink-2)' }}>
            <input type="checkbox" checked={split} onChange={(e) => { setSplit(e.target.checked); api.setSetting('splitUsage', e.target.checked); }} style={{ marginTop: 4 }} />
            <span>Start new sessions, project tasks and overall-agent questions on whichever Claude account has used the least in the last 5 hours.</span>
          </label>
          <div className="panel-h" style={{ marginTop: 18 }}>The <span className="mono">sb</span> command</div>
          <div className="well mono" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{`${sbPath} cards\n${sbPath} send "client-site" "Fix the footer" --wait\n${sbPath} brain append "Client wants Friday delivery"\n${sbPath} due`}</div>
          {bus && <p className="hint">Listening on 127.0.0.1:{bus.port}. Only programs that can read <span className="mono">{bus.tokenFile}</span> can use it.</p>}
        </div>
      </div>

      {edit && (
        <div className="overlay" onClick={() => setEdit(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex' }}><h3>{edit.id ? `Edit ${edit.label}` : 'Add account'}</h3><button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => setEdit(null)}><X size={16} /></button></div>
            {!edit.kind ? (
              <div className="due-list">{KINDS.map((k) => (
                <button key={k.kind} className="due-item" style={{ gridTemplateColumns: '10px 1fr' }} onClick={() => setEdit({ ...edit, kind: k.kind, label: k.kind === 'openai-compatible' ? 'Grok API' : k.label.replace(/ \(.*\)/, ''), config: k.kind === 'openai-compatible' ? { baseUrl: 'https://api.x.ai/v1', model: 'grok-4' } : k.kind === 'claude-code' ? { configDir: '~/.claude-' + (accounts.filter((a) => a.kind === 'claude-code').length + 1) } : {} })}>
                  <i style={{ width: 8, height: 8, borderRadius: '50%', background: SOURCE[k.kind]?.color, marginTop: 5 }} />
                  <div><div className="t">{k.label}</div><div className="s">{k.blurb}</div></div>
                </button>))}</div>
            ) : (
              <div className="form">
                <div className="field"><label>Name on the board</label><input value={edit.label || ''} onChange={(e) => setEdit({ ...edit, label: e.target.value })} /></div>
                {edit.kind === 'claude-code' && (<>
                  <div className="field"><label>Claude Code folder for this login</label><input className="mono" value={edit.config.configDir || ''} onChange={(e) => setEdit({ ...edit, config: { ...edit.config, configDir: e.target.value } })} />
                    <span className="hint">Use ~/.claude for your main login and a new folder like ~/.claude-2 for each other account. Found on this Mac: {detected.join(', ') || 'none'}</span></div>
                  <div className="field"><label>When you prompt from Switchboard, Claude may</label>
                    <select value={edit.config.permissionMode || 'default'} onChange={(e) => setEdit({ ...edit, config: { ...edit.config, permissionMode: e.target.value } })}>
                      <option value="default">Read and plan only (safest)</option>
                      <option value="acceptEdits">Edit files in the project</option>
                      <option value="bypassPermissions">Do anything without asking</option>
                    </select></div>
                </>)}
                {edit.kind === 'codex' && <div className="field"><label>Codex folder</label><input className="mono" placeholder="~/.codex" value={edit.config.home || ''} onChange={(e) => setEdit({ ...edit, config: { ...edit.config, home: e.target.value } })} /></div>}
                {edit.kind === 'granola' && <div className="field"><label>Cache file (leave empty to find it)</label><input className="mono" value={edit.config.path || ''} onChange={(e) => setEdit({ ...edit, config: { ...edit.config, path: e.target.value } })} /></div>}
                {(edit.kind === 'anthropic-api' || edit.kind === 'openai-compatible') && (<>
                  {edit.kind === 'openai-compatible' && <div className="field"><label>API base URL</label><input className="mono" value={edit.config.baseUrl || ''} onChange={(e) => setEdit({ ...edit, config: { ...edit.config, baseUrl: e.target.value } })} /></div>}
                  <div className="field"><label>Model</label><input className="mono" placeholder={edit.kind === 'anthropic-api' ? 'claude-sonnet-5-5' : 'grok-4'} value={edit.config.model || ''} onChange={(e) => setEdit({ ...edit, config: { ...edit.config, model: e.target.value } })} /></div>
                  <div className="field"><label>API key {edit.secrets?.key ? '(saved; type to replace)' : ''}</label><input type="password" value={edit.secretsIn.key || ''} onChange={(e) => setEdit({ ...edit, secretsIn: { ...edit.secretsIn, key: e.target.value } })} /></div>
                </>)}
                {edit.kind === 'cursor' && <div className="field"><label>Cursor API key {edit.secrets?.key ? '(saved; type to replace)' : ''}</label><input type="password" value={edit.secretsIn.key || ''} onChange={(e) => setEdit({ ...edit, secretsIn: { ...edit.secretsIn, key: e.target.value } })} /><span className="hint">Cursor dashboard → API Keys. Grok Bot itself isn't reachable this way.</span></div>}
                {edit.kind === 'gmail' && (<>
                  <div className="field"><label>Google OAuth client ID {edit.secrets?.client_id ? '(saved)' : ''}</label><input value={edit.secretsIn.client_id || ''} onChange={(e) => setEdit({ ...edit, secretsIn: { ...edit.secretsIn, client_id: e.target.value } })} /></div>
                  <div className="field"><label>Client secret</label><input type="password" value={edit.secretsIn.client_secret || ''} onChange={(e) => setEdit({ ...edit, secretsIn: { ...edit.secretsIn, client_secret: e.target.value } })} /><span className="hint">Create a "Desktop app" OAuth client in Google Cloud with the Gmail API turned on. Steps are in the README. After saving, press Sign in with Google.</span></div>
                </>)}
                {edit.kind === 'grok-bot' && <p className="hint" style={{ lineHeight: 1.5 }}>Grok Bot has no public API. Prompts you send to this card are copied and Grok Bot opens so you can paste them. Its messages to your other agents arrive through the sb command and appear on the board.</p>}
                <div style={{ display: 'flex', gap: 8 }}><button className="btn primary" onClick={save}>Save</button>{!edit.id && <button className="btn" onClick={() => setEdit({ ...edit, kind: '' })}>Back</button>}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
