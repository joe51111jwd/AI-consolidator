import React, { useState } from 'react';
import { ShieldQuestion, X } from 'lucide-react';
import { useStore } from '../lib/store';
import { api, Approval, ApprovalChoice } from '../lib/api';
import { toolNoun, useApprovals } from '../lib/approvals';
import './approval.css';

const VERB: Record<string, string> = { command: 'run a command', edit: 'edit a file', write: 'write a file', web: 'go on the web', tool: 'use a tool' };
// The folder (home as ~) shrinks with an ellipsis; the file name always shows in full.
function FilePath({ file }: { file: string }) {
  const p = file.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
  const cut = p.lastIndexOf('/') + 1;
  return <span className="ap-path" data-testid="approval-file"><span className="ap-dir">{p.slice(0, cut)}</span><b>{p.slice(cut)}</b></span>;
}

// One thing a Claude chat wants to do, with what it is (the command, or the file and what changes)
// and the three answers the Claude app gives you. `compact` is the version on a board card.
export function ApprovalCard({ a, compact }: { a: Approval; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const notify = useStore((s) => s.notify);
  const s = a.summary;
  const answer = async (choice: ApprovalChoice) => {
    setBusy(true);
    try { await api.answerApproval(a.id, choice); } catch (err: any) { notify(err.message); setBusy(false); }
  };
  const stop = (ev: React.SyntheticEvent) => ev.stopPropagation();
  const diff = s.diff && s.diff.lines.length > 0 ? s.diff : null;
  const shown = diff ? diff.lines.slice(0, compact ? 6 : 60) : [];
  const hidden = diff ? diff.lines.length - shown.length + diff.more : 0;
  return (
    <div className={`approval nodrag nowheel ${compact ? 'compact' : ''}`} data-testid="approval" data-tool={a.tool} onClick={stop} onDoubleClick={stop} onPointerDown={stop} onKeyDown={stop}>
      <div className="ap-h"><ShieldQuestion size={14} /><span>Claude wants to {VERB[s.kind] || 'use a tool'}</span></div>
      {s.kind === 'command' ? (<>
        {s.title && s.title !== 'Run a command' && <div className="ap-what">{s.title}</div>}
        <pre className="ap-code" data-testid="approval-command">{s.command}</pre>
      </>) : s.file ? (
        <div className="ap-file" title={s.file}>
          <FilePath file={s.file} />
          {diff && <span className="ap-n add">+{diff.added}</span>}
          {diff && <span className="ap-n del">−{diff.removed}</span>}
        </div>
      ) : (<>
        <div className="ap-what">{s.title}</div>
        {s.detail && <pre className="ap-code">{s.detail}</pre>}
      </>)}
      {diff && (
        <pre className="ap-diff" data-testid="approval-diff">
          {shown.map(([t, l], i) => <div key={i} className={t === '+' ? 'add' : t === '-' ? 'del' : 'ctx'}><i>{t === '…' ? '⋯' : t}</i>{l}</div>)}
          {hidden > 0 && <div className="ctx more">{hidden} more line{hidden === 1 ? '' : 's'}</div>}
        </pre>
      )}
      <div className="ap-acts">
        <button className="ap-btn primary" disabled={busy} data-testid="approval-allow" onClick={() => answer('once')}>Allow once</button>
        <button className="ap-btn always" disabled={busy} data-testid="approval-always" onClick={() => answer('always')} title={`Allow ${toolNoun(a.tool)} in this chat without asking again`}>
          {compact ? `Always allow ${toolNoun(a.tool)} here` : `Always allow ${toolNoun(a.tool)} in this chat`}
        </button>
        <button className="ap-btn deny" disabled={busy} data-testid="approval-deny" onClick={() => answer('deny')}>Deny</button>
      </div>
    </div>
  );
}

// Every request waiting on this card, plus the tools you said to always allow in this chat (with ×
// to take that back). Sits above the message box of the open chat.
export function ChatApprovals({ id }: { id: string }) {
  const asks = useApprovals(id);
  const always = useStore((s) => s.approvalRules[id]) || [];
  if (!asks.length && !always.length) return null;
  return (
    <div className="ap-list" data-testid="chat-approvals">
      {asks.map((a) => <ApprovalCard key={a.id} a={a} />)}
      {always.length > 0 && (
        <div className="ap-rules" data-testid="approval-rules">
          <span>Always allowed in this chat:</span>
          {always.map((t) => (
            <span key={t} className="ap-rule">{toolNoun(t)}<button title={`Ask again before ${toolNoun(t)}`} onClick={() => api.forgetApproval(id, t)}><X size={10} /></button></span>
          ))}
        </div>
      )}
    </div>
  );
}
