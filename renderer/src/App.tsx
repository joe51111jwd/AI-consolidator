import React, { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Search, Settings2 } from 'lucide-react';
import { useStore, wireEvents } from './lib/store';
import Board from './components/Board';
import Inspector from './components/Inspector';
import Chief from './components/Chief';
import Palette from './components/Palette';
import Onboarding from './components/Onboarding';
import ImportChats from './components/ImportChats';
import Outputs from './components/Outputs';
import Dock from './components/Dock';
import UsagePill from './components/UsagePill';
import Settings, { SettingsTab } from './components/Settings';
import BrandMark from './components/BrandMark';
import LiveView from './components/LiveView';
import './components/shell.css';

const TABS = ['accounts', 'clients', 'brain'];
type Mode = 'board' | 'live';
const MODE_KEY = 'sb.mode';
const savedMode = (): Mode => (localStorage.getItem(MODE_KEY) === 'live' ? 'live' : 'board');

export default function App() {
  const { view, toast, set, refresh, refreshBoard, refreshDue, inspector, settingsTab } = useStore();
  const [mode, setModeState] = useState<Mode>(savedMode);
  const setMode = (m: Mode) => { localStorage.setItem(MODE_KEY, m); setModeState(m); };

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
      if ((e.metaKey || e.ctrlKey) && (e.key === '1' || e.key === '2')) { e.preventDefault(); setMode(e.key === '1' ? 'board' : 'live'); }
      if (e.key === 'Escape') set({ paletteOpen: false });
    };
    window.addEventListener('keydown', key);
    // Used by the end-to-end tests after changing the board behind the window's back.
    (window as any).__sbRefresh = async () => { await useStore.getState().refresh(true); await useStore.getState().refreshBoard(); };
    // Used by the end-to-end tests: 'board' closes the settings panel, anything else opens that tab.
    (window as any).__sbView = (name: string) => set({ settingsTab: TABS.includes(name) ? (name as SettingsTab) : null });
    // Used by the end-to-end tests: 'live' shows the simple list, anything else the board.
    (window as any).__sbMode = (name: string) => setMode(name === 'live' ? 'live' : 'board');
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
        <main className={`main ${mode === 'live' ? 'is-hidden' : ''}`} aria-hidden={mode === 'live'}><Board /></main>
        {mode === 'live' && <LiveView />}
        <div className="drag-strip" />
        <div className="float tl">
          <div className="tl-pill">
            <BrandMark />
            <span className="div" />
            <button className="search-btn" data-testid="search" onClick={() => set({ paletteOpen: true })}><Search size={14} />Search<kbd>⌘K</kbd></button>
          </div>
          <div className="mode-seg" role="tablist" aria-label="View">
            <button role="tab" aria-selected={mode === 'board'} className={mode === 'board' ? 'on' : ''} data-testid="mode-board" title="Board (⌘1)" onClick={() => setMode('board')}>Board</button>
            <button role="tab" aria-selected={mode === 'live'} className={mode === 'live' ? 'on' : ''} data-testid="mode-live" title="Live (⌘2)" onClick={() => setMode('live')}>Live</button>
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
        <ImportChats />
        <Settings />
      </ReactFlowProvider>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
