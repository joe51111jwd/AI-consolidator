import React, { useEffect, useState } from 'react';
import { LayoutDashboard, Users, BookOpen, KeyRound } from 'lucide-react';
import { useStore, View } from '../lib/store';
import { api, Usage } from '../lib/api';
import { dueLabel, tokens } from '../lib/format';

const NAV: { view: View; label: string; icon: any }[] = [
  { view: 'board', label: 'Board', icon: LayoutDashboard },
  { view: 'clients', label: 'Clients', icon: Users },
  { view: 'brain', label: 'Shared brain', icon: BookOpen },
  { view: 'accounts', label: 'Accounts', icon: KeyRound },
];

type Row = { id: string; label: string; kind: string; color: string; usage: Usage | null };

export default function Sidebar() {
  const { view, set, due, open, entities } = useStore();
  const [usage, setUsage] = useState<Row[]>([]);
  useEffect(() => {
    const load = () => api.usage().then(setUsage).catch(() => {});
    load(); const t = setInterval(load, 60000); return () => clearInterval(t);
  }, [entities.length]);
  const late = due.filter((d) => d.overdue).length;
  const metered = usage.filter((u) => u.usage);
  const top = Math.max(1, ...metered.map((u) => u.usage!.h5));

  return (
    <aside className="side">
      <div className="brand"><div className="brand-mark"><span /></div>Switchboard</div>
      <nav className="nav">
        {NAV.map(({ view: v, label, icon: Icon }) => (
          <button key={v} className={view === v ? 'on' : ''} onClick={() => set({ view: v })}>
            <Icon size={16} strokeWidth={1.8} />{label}
            {v === 'clients' && due.length > 0 && <span className={`count ${late ? 'hot' : ''}`}>{due.length}</span>}
          </button>
        ))}
      </nav>

      {due.length > 0 && (
        <div>
          <div className="side-h"><span>Due</span><span>{due.length}</span></div>
          <div className="due-mini">
            {due.slice(0, 5).map((d) => (
              <button key={d.id} onClick={() => { set({ view: 'board' }); open(d.ref); }}>
                <span className="t">{d.title}</span>
                <span className={`s ${d.overdue ? 'late' : ''}`}>{d.client}{d.due ? ` · ${dueLabel(d.due)}` : ''}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 'auto' }}>
        <div className="side-h"><span>Usage, last 5 hr</span></div>
        {usage.map((u) => (
          <div key={u.id} className="acc-row" title={u.usage ? `${tokens(u.usage.d1)} today · ${tokens(u.usage.d7)} this week` : 'No usage data'}>
            <span className="dot" style={{ background: u.color }} />
            <span className="n">{u.label}</span>
            <span className="u">{u.usage ? tokens(u.usage.h5) : ''}</span>
            {u.usage && <span className="acc-bar"><i style={{ width: `${Math.max(2, (u.usage.h5 / top) * 100)}%`, background: u.color }} /></span>}
          </div>
        ))}
        {!usage.length && <div className="hint" style={{ padding: '0 10px' }}>No accounts yet.</div>}
      </div>
    </aside>
  );
}
