import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Check, Loader2, Monitor, NotebookPen, Radio } from 'lucide-react';
import { api, Account } from '../lib/api';
import { useStore } from '../lib/store';
import { AgentLogo } from './Logos';
import './connect.css';

export type FoundItem = { id: string; kind: string; label: string; detail: string; account?: { kind: string; label: string; config: any }; setting?: string };

export const useWelcome = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));

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

// First launch: nothing is connected until it's clicked here. Finishing hands over to the guided tour.
export default function Welcome({ onDone }: { onDone: () => void }) {
  const { open, set: setOpen } = useWelcome();
  const accounts = useStore((s) => s.accounts);
  const { set, refresh, notify } = useStore.getState();
  const [found, setFound] = useState<FoundItem[]>([]);
  const [settings, setSettings] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if ((window as any).__sbNoTour || navigator.webdriver) return;
    api.call<{ pending: boolean; found: FoundItem[] }>('onboard:status').then((s) => {
      setFound(s.found);
      if (s.pending) setOpen(true);
    }).catch(() => {});
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
    setOpen(false);
    if (then) then(); else onDone();
  };

  if (!open) return null;
  return createPortal(
    <div className="ca-back">
      <div className="ca" role="dialog" aria-label="Welcome to Switchboard" data-testid="welcome">
        <div className="ca-head"><b>Welcome to Switchboard</b></div>
        <p className="ca-lede">Nothing is connected yet. Pick what Switchboard should show; you can change any of it later in Settings → Accounts.</p>
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
        <div className="ca-head" style={{ paddingBottom: 14 }}>
          <button className="ca-btn" style={{ marginLeft: 'auto' }} data-testid="welcome-done" onClick={() => finish()}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
