import React, { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Search, Plus, StickyNote, UserPlus, FileText } from 'lucide-react';
import { useStore, wireEvents } from './lib/store';
import { api } from './lib/api';
import Sidebar from './components/Sidebar';
import Board from './components/Board';
import Inspector from './components/Inspector';
import Chief from './components/Chief';
import Palette from './components/Palette';
import Clients from './views/Clients';
import Brain from './views/Brain';
import Accounts from './views/Accounts';

function AddMenu({ onClose }: { onClose: () => void }) {
  const { refresh, notify, set } = useStore();
  const go = async (fn: () => Promise<void>) => { onClose(); await fn(); };
  return (
    <div className="menu" style={{ top: 44, left: 0 }} onClick={(e) => e.stopPropagation()}>
      <button onClick={() => go(async () => { await api.saveNote({ text: '' }); await refresh(true); notify('Note added to the board'); })}><StickyNote size={14} />Note</button>
      <button onClick={() => go(async () => { await api.saveOutput({ title: 'New output', content: '' }); await refresh(true); })}><FileText size={14} />Empty output</button>
      <button onClick={() => go(async () => { set({ view: 'clients' }); })}><UserPlus size={14} />Client</button>
      <div className="sep" />
      <button onClick={() => go(async () => { set({ view: 'accounts' }); })}><Plus size={14} />Account</button>
    </div>
  );
}

export default function App() {
  const { view, toast, set, refresh, refreshBoard, refreshDue, inspector } = useStore();
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    wireEvents();
    refresh().then(refreshBoard);
    refreshDue();
    const t = setInterval(refreshDue, 120000);
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); set({ paletteOpen: !useStore.getState().paletteOpen }); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') { e.preventDefault(); set({ chiefOpen: !useStore.getState().chiefOpen }); }
      if (e.key === 'Escape') set({ paletteOpen: false });
    };
    window.addEventListener('keydown', key);
    // Used by the end-to-end tests after changing the board behind the window's back.
    (window as any).__sbRefresh = async () => { await useStore.getState().refresh(true); await useStore.getState().refreshBoard(); };
    // Used by the screenshot mode in main.cjs to step through screens.
    (window as any).__sbScene = (i: number) => {
      const scenes: (() => void)[] = [
        () => set({ view: 'board', inspector: null, chiefOpen: false }),
        () => { const s = useStore.getState(); const first = s.entities.find((e) => e.kind === 'session'); set({ view: 'board', inspector: first?.id || null }); },
        () => set({ view: 'board', inspector: null, chiefOpen: true }),
        () => set({ view: 'clients', inspector: null, chiefOpen: false }),
        () => set({ view: 'accounts' }),
        () => set({ view: 'brain' }),
        () => set({ view: 'board', paletteOpen: true }),
      ];
      scenes[i]?.();
    };
    return () => { clearInterval(t); window.removeEventListener('keydown', key); };
  }, []);

  return (
    <div className="shell" onClick={() => setAdding(false)}>
      <Sidebar />
      <main className="main">
        {view === 'board' ? (
          <ReactFlowProvider>
            <Board />
            <div className="topbar" style={{ right: 'auto' }}>
              <button className="pill search" onClick={() => set({ paletteOpen: true })}><Search size={15} />Find a chat, project or client<span className="spacer" /><kbd>⌘K</kbd></button>
              <div style={{ position: 'relative' }}>
                <button className="pill" onClick={(e) => { e.stopPropagation(); setAdding(!adding); }}><Plus size={15} />Add</button>
                {adding && <AddMenu onClose={() => setAdding(false)} />}
              </div>
            </div>
            {inspector && <Inspector />}
            <Chief />
          </ReactFlowProvider>
        ) : (
          <div style={{ position: 'absolute', inset: 0, overflowY: 'auto' }}>
            {view === 'clients' && <Clients />}
            {view === 'brain' && <Brain />}
            {view === 'accounts' && <Accounts />}
          </div>
        )}
      </main>
      <Palette />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
