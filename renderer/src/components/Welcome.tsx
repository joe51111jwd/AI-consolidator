import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Check, Loader2, Monitor, NotebookPen, Radio } from 'lucide-react';
import { api, Account } from '../lib/api';
import { useStore } from '../lib/store';
import { AgentLogo } from './Logos';
import './connect.css';

export type FoundItem = { id: string; kind: string; label: string; detail: string; account?: { kind: string; label: string; config: any }; setting?: string };

// checked: the first-launch check has answered, so the tour knows whether to wait for Done.
export const useWelcome = create<{ open: boolean; checked: boolean; set: (s: { open?: boolean; checked?: boolean }) => void }>((set) => ({
  open: false, checked: false, set: (s) => set(s),
}));

const icon = (kind: string) => {
  if (kind === 'granola') return <NotebookPen size={16} />;
  if (kind === 'claude-app') return <Monitor size={16} />;
  return <AgentLogo source={kind} size={16} />;
};

const isConnected = (item: FoundItem, accounts: Account[], settings: Record<string, boolean>) => {
  if (item.setting) return !!settings[item.setting];
  const a = item.account;
  if (!a) return false;
  return accounts.some((b) => b.kind === a.kind && (a.kind !== 'claude-code' || (b.config?.configDir || '~/.claude') === a.config?.configDir));
};

// First launch (and, while onboarding.cjs has EVERY_BUILD on, each new build): nothing is connected
// until it's clicked here. Finishing hands over to the guided tour.
export default function Welcome({ onDone }: { onDone: () => void }) {
  const open = useWelcome((s) => s.open);
  const accounts = useStore((s) => s.accounts);
  const { set, refresh, notify } = useStore.getState();
  const [found, setFound] = useState<FoundItem[]>([]);
  const [settings, setSettings] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);

  // Opens only while onboarding is pending (a brand-new install that hasn't pressed Done).
  const check = async () => {
    try {
      const s = await api.call<{ pending: boolean; found: FoundItem[] }>('onboard:status');
      if (s.pending) {
        const keys = [...new Set(s.found.map((i) => i.setting).filter(Boolean))] as string[];
        const vals = await Promise.all(keys.map((k) => api.getSetting<boolean>(k, false).catch(() => false)));
        setSettings(Object.fromEntries(keys.map((k, i) => [k, vals[i] === true])));
        setFound(s.found);
      }
      useWelcome.getState().set({ open: s.pending, checked: true });
      return s.pending;
    } catch { useWelcome.getState().set({ checked: true }); return false; }
  };

  useEffect(() => {
    // Tests drive the app with navigator.webdriver set, so it stays out of their way unless asked:
    // window.__sbWelcome() runs the first-launch check (resolves true if it opened), (false) closes it.
    (window as any).__sbWelcome = (on: boolean = true) => (on ? check() : (useWelcome.getState().set({ open: false }), Promise.resolve(false)));
    if ((window as any).__sbNoTour || navigator.webdriver) return;
    check();
  }, []);

  const connect = async (item: FoundItem) => {
    setBusy(item.id);
    try {
      if (item.setting) { await api.setSetting(item.setting, true); setSettings((s) => ({ ...s, [item.setting!]: true })); }
      else if (item.account) await api.saveAccount(item.account);
      await refresh(true);
    } catch (e: any) { notify(e.message); }
    setBusy(null);
  };

  const finish = async (then?: () => void) => {
    await api.call('onboard:finish').catch(() => {});
    useWelcome.getState().set({ open: false });
    if (then) then(); else onDone();
  };

  if (!open) return null;
  return createPortal(
    <div className="ca-back">
      <div className="ca" role="dialog" aria-label="Welcome to Switchboard" data-testid="welcome">
        <div className="ca-head"><b>Welcome to Switchboard</b></div>
        <p className="ca-lede">{accounts.length
          ? 'Here’s what Switchboard found on this computer. Connect anything else it should show; you can change any of it later in Settings → Accounts.'
          : 'Nothing is connected yet. Pick what Switchboard should show; you can change any of it later in Settings → Accounts.'}</p>
        <div className="ca-list">
          {found.length === 0 && <div className="ca-row"><span className="ca-step">No Claude Code, Codex, Granola or Grok Bot data found on this computer. Add accounts in Settings.</span></div>}
          {found.map((item) => {
            const on = isConnected(item, accounts, settings);
            return (
              <div key={item.id} className={`ca-row ${on ? 'done' : ''}`} data-testid={`welcome-${item.id}`}>
                <div className="ca-row-head">
                  {icon(item.kind)}
                  <b>{item.label}</b>
                  <span className="ca-count">{item.detail}</span>
                  {on
                    ? <span className="ca-state on"><Check size={11} />Connected</span>
                    : <button className="ca-btn" disabled={busy === item.id} onClick={() => connect(item)}>{busy === item.id ? <Loader2 size={11} className="bt-spin" /> : null}Connect</button>}
                </div>
              </div>
            );
          })}
          <div className="ca-row" data-testid="welcome-relay">
            <div className="ca-row-head">
              <Radio size={16} />
              <b>Switchboard Relay</b>
              <span className="ca-count">Cloud sessions and other apps</span>
              <button className="ca-btn" onClick={() => finish(() => set({ settingsTab: 'accounts' }))}>Set up</button>
            </div>
          </div>
        </div>
        <div className="ca-foot">
          <button className="ca-btn" data-testid="welcome-done" onClick={() => finish()}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
