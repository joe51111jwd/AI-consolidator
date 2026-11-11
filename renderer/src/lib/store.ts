import { create } from 'zustand';
import { api, Entity, BoardRow, EdgeRow, Run, Account, Attach, DueItem } from './api';

export type View = 'board' | 'clients' | 'brain' | 'accounts';

interface State {
  view: View;
  entities: Entity[];
  byId: Record<string, Entity>;
  board: BoardRow[];
  edges: EdgeRow[];
  runs: Record<string, Run>;          // run id -> run
  liveByEntity: Record<string, Run>;  // entity id -> latest run
  accounts: Account[];
  due: DueItem[];
  inspector: string | null;
  selected: string[];
  attach: Record<string, Attach[]>;   // target entity id -> pending attachments
  activeEdges: Record<string, { until: number; preview: string }>;
  toast: string | null;
  auth: Record<string, { phase: string; url?: string; error?: string }>;
  paletteOpen: boolean;
  chiefOpen: boolean;
  settingsTab: 'accounts' | 'clients' | 'brain' | null; // slide-over settings panel
  outputsOpen: boolean;
  chiefMin: boolean;
  pins: string[];                     // entity ids tagged as context for the next prompt
  set: (p: Partial<State>) => void;
  refresh: (force?: boolean) => Promise<void>;
  boardLoaded: boolean;
  refreshBoard: () => Promise<void>;
  refreshDue: () => Promise<void>;
  open: (id: string | null) => void;
  addAttach: (target: string, a: Attach) => void;
  clearAttach: (target: string) => void;
  notify: (t: string) => void;
}

export const useStore = create<State>((set, get) => ({
  view: 'board', entities: [], byId: {}, board: [], edges: [], runs: {}, liveByEntity: {}, accounts: [], due: [],
  boardLoaded: false, inspector: null, selected: [], attach: {}, activeEdges: {}, toast: null, auth: {}, paletteOpen: false, chiefOpen: false, settingsTab: null, outputsOpen: false, chiefMin: false, pins: [],
  set: (p) => set(p as any),
  refresh: async (force = false) => {
    const [entities, accounts] = await Promise.all([api.entities(force), api.accounts()]);
    const byId: Record<string, Entity> = {};
    for (const e of entities) byId[e.id] = e;
    set({ entities, byId, accounts });
  },
  refreshBoard: async () => {
    const [board, edges] = await Promise.all([api.board(), api.edges()]);
    set({ board, edges, boardLoaded: true });
  },
  refreshDue: async () => { try { set({ due: await api.due() }); } catch {} },
  open: (id) => set({ inspector: id }),
  addAttach: (target, a) => set((s) => ({ attach: { ...s.attach, [target]: [...(s.attach[target] || []), a] } })),
  clearAttach: (target) => set((s) => { const n = { ...s.attach }; delete n[target]; return { attach: n }; }),
  notify: (t) => { set({ toast: t }); setTimeout(() => { if (get().toast === t) set({ toast: null }); }, 3200); },
}));

// Wire main-process events into the store once.
let wired = false;
export function wireEvents() {
  if (wired) return; wired = true;
  let t: any;
  api.onEvent((e) => {
    const s = useStore.getState();
    if (e.type === 'entities-changed') { clearTimeout(t); t = setTimeout(() => { s.refresh(); }, 250); }
    if (e.type === 'auth') {
      useStore.setState((st) => ({ auth: { ...st.auth, [e.accountId]: { phase: e.phase, url: e.url ?? (e.phase === 'waiting' && st.auth[e.accountId]?.phase === 'waiting' ? st.auth[e.accountId]?.url : undefined), error: e.error } } }));
      if (e.phase === 'done' || e.phase === 'status') s.refresh();
    }
    if (e.type === 'run') {
      const r: Run = e.run;
      useStore.setState((st) => ({ runs: { ...st.runs, [r.id]: r }, liveByEntity: { ...st.liveByEntity, [r.entityId]: r } }));
    }
    if (e.type === 'flow' && e.edgeId) {
      const until = Date.now() + 6000;
      useStore.setState((st) => ({ activeEdges: { ...st.activeEdges, [e.edgeId]: { until, preview: e.flow.preview } } }));
      s.refreshBoard();
      setTimeout(() => useStore.setState((st) => { const n = { ...st.activeEdges }; if (n[e.edgeId] && n[e.edgeId].until <= Date.now()) delete n[e.edgeId]; return { activeEdges: n }; }), 6200);
    }
  });
}
