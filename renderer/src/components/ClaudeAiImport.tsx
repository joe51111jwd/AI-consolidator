import React, { useEffect, useState } from 'react';
import { Check, Download, LayoutGrid, Sparkles, TriangleAlert, X } from 'lucide-react';
import { api, Entity } from '../lib/api';
import { useStore } from '../lib/store';
import { ago } from '../lib/format';

type Import = { at: number; added: number; updated: number; same: number; skipped: number; projects: number; accounts: string[]; missing: string[]; problems: string[] };
type Status = {
  chats: number; projects: number; inProjects: number; unchecked: number; accounts: string[];
  lastImport: Import | null; lastMatch: { at: number; asked: number; matched: number; error: string | null } | null;
  importing: boolean; progress: { chats: number } | null; matching: boolean;
};
type Project = { uuid: string; name: string; description: string; files: number; chats: number; latest: number; by: { ai: number; knowledge: number; you: number }; onBoard: boolean };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Settings → Accounts → Connections: chats and Projects from claude.ai and the Claude app, brought in
// from claude.ai's data export (they aren't stored on this Mac). See electron/ext/claudeai.cjs.
export default function ClaudeAiImport() {
  const { notify } = useStore();
  const [st, setSt] = useState<Status | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const load = async () => {
    try {
      const [s, p] = await Promise.all([api.call<Status>('claudeai:status'), api.call<Project[]>('claudeai:projects')]);
      setSt(s); setProjects(p);
    } catch { /* an older main process */ }
  };
  useEffect(() => {
    load();
    return api.onEvent((e) => { if (e.type === 'claudeai') { if (e.status) setSt(e.status); if (!e.status?.importing) api.call<Project[]>('claudeai:projects').then(setProjects).catch(() => {}); } });
  }, []);

  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e: any) { notify(e.message); } setBusy(false); load(); };
  const importNow = () => run(async () => {
    const r = await api.call<Import | null>('claudeai:import');
    if (!r) return;
    await useStore.getState().refresh(true);
    const parts = [r.added && `${r.added} new`, r.updated && `${r.updated} updated`, r.same && `${r.same} unchanged`].filter(Boolean);
    notify(r.added || r.updated ? `Imported claude.ai chats: ${parts.join(', ')}` : r.same ? 'Already up to date' : r.problems[0] || 'Nothing imported');
  });
  const match = () => run(async () => {
    const r = await api.call<{ matched: number; error: string | null }>('claudeai:match');
    notify(r.error ? `Couldn't sort chats into Projects: ${r.error}` : `Claude put ${plural(r.matched, 'chat')} in Projects`);
  });
  const toggleBoard = (p: Project) => run(async () => {
    const r = await api.call<{ ids: string[] }>('claudeai:showOnBoard', p.uuid, !p.onBoard);
    await useStore.getState().refresh(true);
    await useStore.getState().refreshBoard();
    if (!p.onBoard) { (window as any).__sbWeek?.(); notify(r.ids.length ? `Put ${plural(r.ids.length, 'chat')} from ${p.name} on the board` : `${p.name} has no chats yet`); }
    else notify(`Took ${p.name} off the board`);
  });
  const clear = () => run(async () => { await api.call('claudeai:clear'); setConfirm(false); await useStore.getState().refresh(true); notify('Removed the imported claude.ai history'); });

  const last = st?.lastImport;
  const lm = st?.lastMatch;
  return (
    <div data-testid="claudeai">
      <div className="set-row">
        <div className="txt">
          <b>Import claude.ai history</b>
          <span className="hint">Chats and Projects from claude.ai and the Claude app aren't kept on this Mac. On claude.ai open Settings → Privacy → Export data, then pick what the email links to: the zip file(s), or the folder you unzipped them into. Importing a newer export updates what changed.</span>
        </div>
        <button className="btn accent" data-testid="claudeai-import" disabled={busy || st?.importing} onClick={importNow}><Download size={13} />{st?.importing ? 'Importing…' : 'Import…'}</button>
      </div>
      <div className="form" style={{ paddingBottom: 10, gap: 6 }}>
        <span className="hint" data-testid="claudeai-summary">
          {st?.importing ? `Reading the export… ${st.progress?.chats || 0} chats so far`
            : st?.chats ? `${plural(st.chats, 'chat')} · ${plural(st.projects, 'Project')} · ${st.inProjects} in a Project${st.accounts.length ? ` · ${st.accounts.join(', ')}` : ''}`
              : 'Nothing imported yet.'}
          {last && !st?.importing ? ` · last import ${ago(last.at)}: ${last.added} new, ${last.updated} updated, ${last.same} unchanged` : ''}
        </span>
        {last?.missing?.length ? <div className="hint" data-testid="claudeai-missing" style={{ color: 'var(--amber)' }}><TriangleAlert size={11} /> The export email also links to {last.missing.join(', ')}. Download {last.missing.length === 1 ? 'it' : 'them'} and import again{last.missing.some((m) => /^projects/i.test(m)) ? ' to get your Projects' : ''}.</div> : null}
        {last?.problems?.map((p) => <div key={p} className="hint" style={{ color: 'var(--red)' }}>{p}</div>)}
        {(st?.matching || lm || (st && st.projects > 0 && st.unchecked > 0)) && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="hint" data-testid="claudeai-match" style={{ flex: 1, minWidth: 200 }}>
              {st?.matching ? 'Claude is reading chat titles and summaries to find their Projects…'
                : lm?.error ? `Couldn't sort chats into Projects: ${lm.error}`
                  : lm ? `The export doesn't say which Project a chat is in, so Claude suggested it for ${plural(lm.matched, 'chat')} (${ago(lm.at)}). Change any chat's Project on its card.`
                    : 'The export doesn\'t say which Project a chat is in. Claude can suggest it from each chat\'s title and summary.'}
            </span>
            {!st?.matching && st && st.unchecked > 0 && st.projects > 0 && (
              <button className="btn" data-testid="claudeai-match-run" disabled={busy} onClick={match}><Sparkles size={13} />Sort {plural(st.unchecked, 'chat')} into Projects</button>
            )}
          </div>
        )}
        {projects.length > 0 && (
          <div className="well" data-testid="claudeai-projects" style={{ display: 'grid', gap: 6 }}>
            {projects.map((p) => (
              <div key={p.uuid} data-testid="claudeai-project" data-id={p.uuid} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.description}>{p.name}</div>
                  <div className="hint">{plural(p.chats, 'chat')}{p.files ? ` · ${plural(p.files, 'file')}` : ''}{p.by.ai ? ` · ${p.by.ai} suggested by Claude` : ''}{p.latest ? ` · ${ago(p.latest)}` : ''}</div>
                </div>
                <button className={`btn ${p.onBoard ? '' : 'ghost'}`} style={{ background: 'var(--card)' }} data-testid="claudeai-board" disabled={busy || (!p.onBoard && !p.chats)} onClick={() => toggleBoard(p)}
                  title={p.onBoard ? 'Take its chats off the board' : 'Put its newest chats on the board, together under the Project'}>
                  {p.onBoard ? <><Check size={13} />On board</> : <><LayoutGrid size={13} />Show on board</>}
                </button>
              </div>
            ))}
          </div>
        )}
        {!!st?.chats && (confirm
          ? <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span className="hint">Remove every imported claude.ai chat and Project from Switchboard? claude.ai keeps them.</span><button className="btn danger" data-testid="claudeai-clear-yes" onClick={clear}>Remove</button><button className="btn ghost" onClick={() => setConfirm(false)}>Cancel</button></div>
          : <div><button className="btn ghost" data-testid="claudeai-clear" onClick={() => setConfirm(true)}><X size={13} />Remove imported history</button></div>)}
      </div>
    </div>
  );
}

let projectList: Promise<Project[]> | null = null;
const VIA: Record<string, string> = { ai: 'suggested by Claude', knowledge: 'it read this Project’s files', export: '', you: '' };

// On an imported claude.ai chat's card: which Project it is in. The export doesn't say, so this shows
// how it was found, and you can change it.
export function ClaudeAiProject({ e }: { e: Entity }) {
  const notify = useStore((s) => s.notify);
  const [list, setList] = useState<Project[]>([]);
  useEffect(() => {
    projectList = projectList || api.call<Project[]>('claudeai:projects').finally(() => setTimeout(() => { projectList = null; }, 30000));
    projectList.then(setList).catch(() => {});
  }, [e.id]);
  if (!list.length && !e.meta?.project) return null;
  const set = async (uuid: string) => {
    try {
      await api.call('claudeai:assign', e.id, uuid || null);
      await useStore.getState().refresh(true);
      notify(uuid ? `Moved to ${list.find((p) => p.uuid === uuid)?.name || 'the Project'}` : 'Not in a Project');
    } catch (err: any) { notify(err.message); }
  };
  const via = e.meta?.projectVia ? VIA[e.meta.projectVia] : '';
  return (
    <div className="pn-meta" data-testid="claudeai-project-pick" style={{ gap: 6 }}>
      <span>Claude Project</span>
      <select value={e.meta?.projectUuid || ''} onChange={(ev) => set(ev.target.value)} aria-label="Claude Project"
        style={{ border: '1px solid var(--line-2)', borderRadius: 8, padding: '2px 6px', background: 'var(--card)', maxWidth: 220 }}>
        <option value="">None</option>
        {list.map((p) => <option key={p.uuid} value={p.uuid}>{p.name}</option>)}
      </select>
      {via && <span className="hint">{via}</span>}
    </div>
  );
}
