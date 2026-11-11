import React, { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useStore } from '../lib/store';
import { api, Account, Usage } from '../lib/api';
import { tokens } from '../lib/format';
import { AgentLogo } from './Logos';
import './shell.css';

type Row = { id: string; label: string; kind: string; color: string; usage: Usage | null };
const METERED = ['claude-code', 'codex'];

// Rough weekly token allowance per plan. Input + output tokens only, the same numbers Claude Code logs.
export function defaultBudget(plan?: string | null) {
  const p = (plan || '').toLowerCase();
  if (/20x/.test(p)) return 100e6;
  if (/5x/.test(p)) return 25e6;
  if (/max/.test(p)) return 100e6;
  return 10e6;
}

interface UsageState {
  rows: Row[];
  budgets: Record<string, number>;
  load: () => Promise<void>;
  setBudget: (id: string, n: number | null) => void;
}

// One poll shared by the pill and the dock (which starts new work on the least-used account).
export const useUsage = create<UsageState>((set) => ({
  rows: [], budgets: {},
  load: async () => {
    const all = await api.usage().catch(() => null);
    if (!all) return;
    const rows = all.filter((r) => METERED.includes(r.kind));
    const budgets: Record<string, number> = {};
    await Promise.all(rows.map(async (r) => {
      const v = await api.getSetting<number | null>(`weeklyBudget:${r.id}`, null).catch(() => null);
      if (v && v > 0) budgets[r.id] = v;
    }));
    set({ rows, budgets });
  },
  setBudget: (id, n) => {
    api.setSetting(`weeklyBudget:${id}`, n && n > 0 ? n : null);
    set((s) => { const b = { ...s.budgets }; if (n && n > 0) b[id] = n; else delete b[id]; return { budgets: b }; });
  },
}));

export function budgetFor(id: string, accounts: Account[], budgets: Record<string, number>) {
  return budgets[id] || defaultBudget(accounts.find((a) => a.id === id)?.config?.auth?.plan);
}
export function weeklyPct(r: Row, accounts: Account[], budgets: Record<string, number>) {
  return ((r.usage?.d7 || 0) / budgetFor(r.id, accounts, budgets)) * 100;
}
const tone = (p: number) => (p >= 90 ? 'var(--red)' : p >= 70 ? 'var(--amber)' : 'var(--ink)');

export function useUsagePolling() {
  const n = useStore((s) => s.entities.length);
  const load = useUsage((s) => s.load);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [n]);
}

function Ring({ pct, size = 16 }: { pct: number; size?: number }) {
  const r = (size - 3) / 2, c = 2 * Math.PI * r, v = Math.min(100, Math.max(0, pct));
  return (
    <svg className="usage-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle className="trk" cx={size / 2} cy={size / 2} r={r} />
      <circle className="val" cx={size / 2} cy={size / 2} r={r} stroke={tone(pct)} strokeDasharray={`${Math.max(v > 0 ? 1.5 : 0, (v / 100) * c)} ${c}`} />
    </svg>
  );
}

function UsageRow({ r, accounts }: { r: Row; accounts: Account[] }) {
  const { budgets, setBudget } = useUsage();
  const [open, setOpen] = useState(false);
  const pct = weeklyPct(r, accounts, budgets);
  const budget = budgetFor(r.id, accounts, budgets);
  const [draft, setDraft] = useState(String(Math.round(budget / 1e6)));
  useEffect(() => setDraft(String(Math.round(budget / 1e6))), [budget]);
  const commit = () => { const n = Number(draft); setBudget(r.id, n > 0 ? n * 1e6 : null); };
  return (
    <div className={`u-row ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} data-testid={`usage-${r.id}`}>
      <div className="u-top">
        <AgentLogo source={r.kind} size={13} color={r.color} />
        <span className="n">{r.label}</span>
        <span className="p" style={{ color: tone(pct) }}>{Math.round(pct)}%</span>
      </div>
      <div className="u-bar"><i style={{ width: `${Math.min(100, Math.max(pct > 0 ? 2 : 0, pct))}%`, background: tone(pct) === 'var(--ink)' ? r.color : tone(pct) }} /></div>
      <div className="u-more">
        <div><span>5 hr</span><b>{tokens(r.usage?.h5)}</b></div>
        <div><span>Today</span><b>{tokens(r.usage?.d1)}</b></div>
        <div><span>7 days</span><b>{tokens(r.usage?.d7)}</b></div>
      </div>
      {open && (
        <label className="u-budget" onClick={(e) => e.stopPropagation()}>
          Weekly budget
          <input type="number" min={1} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          M tokens
        </label>
      )}
    </div>
  );
}

// Top-right pill: the busiest account's share of its weekly budget. Click for every account.
export default function UsagePill() {
  useUsagePolling();
  const accounts = useStore((s) => s.accounts);
  const { rows, budgets } = useUsage();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); window.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc); };
  }, [open]);
  if (!rows.length) return null;
  const ranked = rows.map((r) => ({ r, p: weeklyPct(r, accounts, budgets) })).sort((a, b) => b.p - a.p);
  const top = ranked[0];
  return (
    <div className="usage" ref={ref}>
      <button className="usage-pill" data-testid="usage-pill" title={`${top.r.label}: ${Math.round(top.p)}% of this week`} onClick={() => setOpen(!open)}>
        <Ring pct={top.p} />{Math.round(top.p)}%<span className="lbl">week</span>
      </button>
      {open && (
        <div className="usage-pop">
          <div className="hd">This week<span className="hint">of weekly budget</span></div>
          {ranked.map(({ r }) => <UsageRow key={r.id} r={r} accounts={accounts} />)}
        </div>
      )}
    </div>
  );
}
