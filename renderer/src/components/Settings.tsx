import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useStore } from '../lib/store';
import Accounts from '../views/Accounts';
import Clients from '../views/Clients';
import Brain from '../views/Brain';
import PreviewToggle from './PreviewToggle';
import './shell.css';

export type SettingsTab = 'accounts' | 'clients' | 'brain';
const TABS: [SettingsTab, string][] = [['accounts', 'Accounts'], ['clients', 'Clients'], ['brain', 'Shared brain']];

// Right slide-over holding everything that isn't the board. Esc or a click outside closes it.
export default function Settings() {
  const tab = useStore((s) => s.settingsTab);
  const set = useStore((s) => s.set);
  const [shown, setShown] = useState<SettingsTab | null>(tab);
  const [out, setOut] = useState(false);
  const close = () => set({ settingsTab: null });

  useEffect(() => {
    if (tab) { setShown(tab); setOut(false); return; }
    if (!shown) return;
    setOut(true);
    const t = setTimeout(() => { setShown(null); setOut(false); }, 220);
    return () => clearTimeout(t);
  }, [tab]);

  useEffect(() => {
    if (!tab) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || useStore.getState().paletteOpen) return;
      const modal = document.querySelector<HTMLElement>('.settings .overlay');
      if (modal) modal.click(); else close();
    };
    // Capture phase, so this sees the palette still open before App's handler closes it.
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [tab]);

  if (!shown) return null;
  const view = tab || shown;
  return (
    <>
      <div className={`settings-scrim ${out ? 'out' : ''}`} onMouseDown={close} />
      <aside className={`settings ${out ? 'out' : ''}`} role="dialog" aria-label="Settings" data-testid="settings">
        <div className="settings-head">
          <div className="settings-tabs" role="tablist">
            {TABS.map(([k, label]) => (
              <button key={k} role="tab" aria-selected={view === k} data-view={k} className={view === k ? 'on' : ''} onClick={() => set({ settingsTab: k })}>{label}</button>
            ))}
          </div>
          <span className="spacer" />
          <button className="icon-btn" title="Close" onClick={close}><X size={16} /></button>
        </div>
        <div className="settings-body" key={view}>
          {view === 'accounts' ? <Accounts /> : view === 'clients' ? <Clients /> : <Brain />}
          {view === 'accounts' && <PreviewToggle />}
        </div>
      </aside>
    </>
  );
}
