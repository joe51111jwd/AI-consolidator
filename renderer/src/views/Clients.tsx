import React, { useEffect, useState } from 'react';
import { Plus, Mail, CalendarDays, CircleCheck, UserPlus, X } from 'lucide-react';
import { useStore } from '../lib/store';
import { api, Client, DueItem } from '../lib/api';
import { dueLabel, ago } from '../lib/format';

const STATUSES = ['lead', 'active', 'waiting', 'done', 'lost'];

export default function Clients() {
  const { entities, due, refreshDue, open, set, notify } = useStore();
  const [clients, setClients] = useState<Client[]>([]);
  const [edit, setEdit] = useState<Partial<Client> | null>(null);
  const [sugg, setSugg] = useState<any[]>([]);
  const load = async () => { setClients(await api.clients()); refreshDue(); api.suggestions().then(setSugg).catch(() => {}); };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!edit?.name?.trim()) return;
    await api.saveClient(edit); setEdit(null); await load(); await useStore.getState().refresh(true);
  };
  const projects = entities.filter((e) => e.kind === 'project');
  const icon = (d: DueItem) => d.kind === 'reply' ? <Mail size={15} /> : d.kind === 'followup' ? <CalendarDays size={15} /> : <CircleCheck size={15} />;

  return (
    <div className="page">
      <div className="page-h">
        <div><h1>Clients</h1><p>Who you're working for, what's due, and the mail and meetings tied to each.</p></div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setEdit({ status: 'active', emails: [], domains: [], project_paths: [] })}><Plus size={14} />Add client</button>
      </div>
      <div className="grid2">
        <div className="panel">
          <div className="panel-h">All clients<span className="s">{clients.length}</span></div>
          {clients.length ? (
            <table className="t">
              <thead><tr><th>Client</th><th>Status</th><th>Next</th><th>Value</th><th>Updated</th></tr></thead>
              <tbody>{clients.map((c) => (
                <tr key={c.id} onClick={() => setEdit(c)}>
                  <td><div style={{ fontWeight: 600 }}>{c.name}</div><div className="hint">{c.company || c.domains[0] || c.emails[0] || ''}</div></td>
                  <td><span className={`chip ${c.status === 'active' ? 'green' : c.status === 'lead' || c.status === 'waiting' ? 'amber' : ''}`}>{c.status}</span></td>
                  <td style={{ maxWidth: 260 }}><div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.next_action || <span className="hint">None</span>}</div>{c.due && <div className="hint">{dueLabel(Date.parse(c.due))}</div>}</td>
                  <td>{c.value ? `$${Number(c.value).toLocaleString()}` : <span className="hint">None</span>}</td>
                  <td className="hint">{ago(c.updated_at)}</td>
                </tr>))}
              </tbody>
            </table>
          ) : <div className="empty">No clients yet. Add one, or pick from the people you've been emailing.</div>}
        </div>
        <div style={{ display: 'grid', gap: 18 }}>
          <div className="panel">
            <div className="panel-h">Due<span className="s">from your clients, Gmail and Granola</span></div>
            {due.length ? <div className="due-list">{due.map((d) => (
              <button key={d.id} className="due-item" onClick={() => { set({ view: 'board' }); open(d.ref); }}>
                <span style={{ color: d.overdue ? 'var(--red)' : 'var(--ink-3)', marginTop: 1 }}>{icon(d)}</span>
                <div><div className="t">{d.title}</div><div className="s">{d.client}</div></div>
                <span className={`chip ${d.overdue ? 'red' : 'amber'}`}>{dueLabel(d.due) || 'Open'}</span>
              </button>))}</div> : <div className="empty" style={{ padding: 20 }}>Nothing due. Connect Gmail and add clients so replies and follow-ups show up here.</div>}
          </div>
          {sugg.length > 0 && (
            <div className="panel">
              <div className="panel-h">People you've been emailing<span className="s">not clients yet</span></div>
              <div className="due-list">{sugg.slice(0, 8).map((s) => (
                <div key={s.key} className="due-item" style={{ gridTemplateColumns: '1fr auto' }}>
                  <div><div className="t">{s.name || s.email}</div><div className="s">{s.domain || s.email} · {s.subject}</div></div>
                  <button className="btn" onClick={() => setEdit({ name: s.name || s.email, emails: [s.email], domains: s.domain ? [s.domain] : [], status: 'lead', project_paths: [] })}><UserPlus size={13} />Add</button>
                </div>))}</div>
            </div>
          )}
        </div>
      </div>
      {edit && (
        <div className="overlay" onClick={() => setEdit(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex' }}><h3>{edit.id ? edit.name : 'New client'}</h3><button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => setEdit(null)}><X size={16} /></button></div>
            <div className="form">
              <div className="row2">
                <div className="field"><label>Name</label><input autoFocus value={edit.name || ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
                <div className="field"><label>Company</label><input value={edit.company || ''} onChange={(e) => setEdit({ ...edit, company: e.target.value })} /></div>
              </div>
              <div className="field"><label>Emails, comma separated. Their company domain links their mail and meetings.</label><input value={(edit.emails || []).join(', ')} onChange={(e) => setEdit({ ...edit, emails: e.target.value.split(',').map((x) => x.trim()) })} /></div>
              <div className="row2">
                <div className="field"><label>Status</label><select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></div>
                <div className="field"><label>Deal value ($)</label><input type="number" value={edit.value ?? ''} onChange={(e) => setEdit({ ...edit, value: e.target.value ? Number(e.target.value) : null })} /></div>
              </div>
              <div className="row2">
                <div className="field"><label>Next action</label><input value={edit.next_action || ''} onChange={(e) => setEdit({ ...edit, next_action: e.target.value })} /></div>
                <div className="field"><label>Due</label><input type="date" value={edit.due || ''} onChange={(e) => setEdit({ ...edit, due: e.target.value })} /></div>
              </div>
              <div className="field"><label>Code projects for this client</label>
                <select multiple value={edit.project_paths || []} style={{ minHeight: 80 }} onChange={(e) => setEdit({ ...edit, project_paths: [...e.target.selectedOptions].map((o) => o.value) })}>
                  {projects.map((p) => <option key={p.id} value={p.meta.cwd}>{p.title} ({p.preview})</option>)}
                </select></div>
              <div className="field"><label>Notes</label><textarea value={edit.notes || ''} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" onClick={save}>Save</button>
                {edit.id && <button className="btn danger" onClick={async () => { await api.deleteEntity('cl:' + edit.id); setEdit(null); load(); useStore.getState().refresh(true); notify('Client removed'); }}>Delete</button>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
