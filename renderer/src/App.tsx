import React, { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Search, Settings2 } from 'lucide-react';
import { useStore, wireEvents } from './lib/store';
import Board from './components/Board';
import Inspector from './components/Inspector';
import Chief from './components/Chief';
import Palette from './components/Palette';
import Onboarding from './components/Onboarding';
import Outputs from './components/Outputs';
import Dock from './components/Dock';
import UsagePill from './components/UsagePill';
import Settings, { SettingsTab } from './components/Settings';
import BrandMark from './components/BrandMark';
import './components/shell.css';

const TABS = ['accounts', 'clients', 'brain'];

export default function App() {
  const { view, toast, set, refresh, refreshBoard, refreshDue, inspector, settingsTab } = useStore();

  // Older callers still switch "views"; every non-board view now lives in the settings panel.
  useEffect(() => { if (view !== 'board') set({ settingsTab: view as SettingsTab, view: 'board' }); }, [view]);

  useEffect(() => {
    wireEvents();
    refresh().then(refreshBoard);
    refreshDue();
    const t = setInterval(refreshDue, 120000);
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); set({ paletteOpen: !useStore.getState().paletteOpen }); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') { e.preventDefault(); set({ chiefOpen: !useStore.getState().chiefOpen }); }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); set({ settingsTab: useStore.getState().settingsTab ? null : 'accounts' }); }
      if (e.key === 'Escape') set({ paletteOpen: false });
    };
    window.addEventListener('keydown', key);
    // Used by the end-to-end tests after changing the board behind the window's back.
    (window as any).__sbRefresh = async () => { await useStore.getState().refresh(true); await useStore.getState().refreshBoard(); };
    // Used by the end-to-end tests: 'board' closes the settings panel, anything else opens that tab.
    (window as any).__sbView = (name: string) => set({ settingsTab: TABS.includes(name) ? (name as SettingsTab) : null });
    // Used by the screenshot mode in main.cjs to step through screens.
    (window as any).__sbScene = (i: number) => {
      const clean = { inspector: null, chiefOpen: false, settingsTab: null, paletteOpen: false, outputsOpen: false };
      const scenes: (() => void)[] = [
        () => set(clean),
        () => { const first = useStore.getState().entities.find((e) => e.kind === 'session'); set({ ...clean, inspector: first?.id || null }); },
        () => set({ ...clean, chiefOpen: true }),
        () => set({ ...clean, settingsTab: 'clients' }),
        () => set({ ...clean, settingsTab: 'accounts' }),
        () => set({ ...clean, settingsTab: 'brain' }),
        () => set({ ...clean, paletteOpen: true }),
        () => set({ ...clean, outputsOpen: true }),
      ];
      scenes[i]?.();
    };
    return () => { clearInterval(t); window.removeEventListener('keydown', key); };
  }, []);

  return (
    <div className={`shell ${window.sbBridge?.platform === 'darwin' ? 'mac' : ''}`}>
      <ReactFlowProvider>
        <main className="main"><Board /></main>
        <div className="drag-strip" />
        <div className="float tl">
          <div className="tl-pill">
            <BrandMark />
            <span className="div" />
            <button className="search-btn" data-testid="search" onClick={() => set({ paletteOpen: true })}><Search size={14} />Search<kbd>⌘K</kbd></button>
          </div>
        </div>
        <div className="float tr">
          <UsagePill />
          <button className={`round-btn ${settingsTab ? 'on' : ''}`} title="Settings (⌘,)" data-testid="settings-btn" onClick={() => set({ settingsTab: settingsTab ? null : 'accounts' })}><Settings2 size={16} /></button>
        </div>
        <Dock />
        <Outputs />
        <Chief />
        {inspector && <Inspector />}
        <Palette />
        <Onboarding />
        <Settings />
      </ReactFlowProvider>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
