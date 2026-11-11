import React, { useEffect, useRef, useState } from 'react';
import { Plus, X, Sparkles, Loader2 } from 'lucide-react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import './group-rules.css';

type Rule = { label: string; hint: string };

// Your own top-level groups for the home: the AI sorts everything into exactly these (plus Other).
export default function GroupRules({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Rule[]>([]);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const notify = useStore((s) => s.notify);

  useEffect(() => {
    api.call<{ groups: Rule[] }>('groupRules:get').then((r) => setRows(r?.groups?.length ? r.groups : [{ label: '', hint: '' }])).catch(() => {});
  }, []);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.bt-groups')) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [onClose]);

  const edit = (i: number, patch: Partial<Rule>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const suggest = async () => {
    setBusy(true);
    try {
      const r = await api.call<{ clients?: { label: string }[] }>('topics:get');
      const labels = (r?.clients || []).map((c) => c.label).filter((l) => l && l !== 'Other');
      if (labels.length) setRows(labels.map((label) => ({ label, hint: rows.find((x) => x.label === label)?.hint || '' })));
    } finally { setBusy(false); }
  };
  const save = async () => {
    const groups = rows.map((r) => ({ label: r.label.trim(), hint: r.hint.trim() })).filter((r) => r.label);
    await api.call('groupRules:set', { groups });
    notify(groups.length ? `Grouping by your ${groups.length} groups` : 'Back to automatic groups');
    onClose();
  };

  return (
    <div className="bt-panel gr-panel" ref={ref} data-testid="group-rules-panel" onKeyDown={(e) => e.stopPropagation()}>
      <div className="bt-h">Your groups</div>
      <div className="gr-rows">
        {rows.map((r, i) => (
          <div key={i} className="gr-row">
            <input className="gr-label" value={r.label} placeholder="Group, e.g. Michael" autoFocus={i === 0 && !r.label} onChange={(e) => edit(i, { label: e.target.value })} />
            <input className="gr-hint" value={r.hint} placeholder="What goes here (optional)" onChange={(e) => edit(i, { hint: e.target.value })} />
            <button className="gr-del" title="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}><X size={12} /></button>
          </div>
        ))}
      </div>
      <div className="gr-actions">
        <button className="gr-link" onClick={() => setRows([...rows, { label: '', hint: '' }])}><Plus size={12} />Add group</button>
        <button className="gr-link" onClick={suggest} disabled={busy}>{busy ? <Loader2 size={12} className="bt-spin" /> : <Sparkles size={12} />}Suggest from my chats</button>
      </div>
      <div className="gr-foot">
        <span className="gr-note">Everything else goes in Other.</span>
        <button className="gr-save" onClick={save}>Save</button>
      </div>
    </div>
  );
}
