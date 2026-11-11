import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap, Node, Edge, useNodesState, useEdgesState,
  useReactFlow, Connection, NodeChange, OnSelectionChangeParams, Viewport, SelectionMode,
} from '@xyflow/react';
import { useStore } from '../lib/store';
import { api, BoardRow, Entity } from '../lib/api';
import { nodeTypes, focusNote } from '../nodes/nodes';
import { useDemo } from '../lib/demo';
import { demoNodeTypes } from './demo/DemoNodes';
import FlowEdge from './FlowEdge';
import BoardTools from './BoardTools';
import { attentionIds, useSeen } from '../lib/attention';
import {
  defaultVisible, suppressed, passesFilter, heuristicGroups, cleanGroups, frameLayout, placeNew, fitFrame, estH, unoverlap, GroupSpec, GAP, PAD, HEAD,
} from '../lib/layout';
import { PROMPTABLE, colorOf } from '../lib/format';
import { EyeOff, Maximize2, Sparkles, Trash2, Zap, Unlink, Group, Ungroup, StickyNote } from 'lucide-react';
import './board.css';

const edgeTypes = { flow: FlowEdge };
// Opens at a readable zoom in the top-left corner; zoom out to see everything.
const START_VIEW = { x: 48, y: 104, zoom: 0.78 };
const isGroup = (id: string) => id.startsWith('grp:');
// Demo cards live only in memory: draggable, never saved, deleted or opened.
const isDemo = (id: string) => id.startsWith('demo:');
const allNodeTypes = { ...nodeTypes, ...demoNodeTypes };
// Cards deleted this session: never re-placed, even if a stale entity list still has them.
const deleted = new Set<string>();
const hiddenIds = new Map<string, number>();
// Background saves (unoverlap, drags, placement) can race a hide or delete; they must never undo it.
const guard = (rows: BoardRow[]) => rows.filter((r) => !deleted.has(r.id)).map((r) => (Date.now() - (hiddenIds.get(r.id) || 0) < 8000 ? { ...r, hidden: 1 } : r));
const defaultW = (kind: string) => (kind === 'note' ? 260 : 300);

function toNodes(rows: BoardRow[], byId: Record<string, Entity>, show: (e: Entity) => boolean): Node[] {
  const groups = rows.filter((r) => isGroup(r.id) && !r.hidden);
  const gset = new Set(groups.map((g) => g.id));
  const kids = new Map<string, number>(), shown = new Map<string, number>();
  const cards: Node[] = [];
  for (const r of rows) {
    if (isGroup(r.id)) continue;
    const parent = r.parent_id && gset.has(r.parent_id) ? r.parent_id : undefined;
    if (parent) kids.set(parent, (kids.get(parent) || 0) + 1);
    const e = byId[r.id];
    if (r.hidden || !e || suppressed(e) || !show(e)) continue;
    if (parent) shown.set(parent, (shown.get(parent) || 0) + 1);
    cards.push({ id: r.id, type: e.kind, position: { x: r.x, y: r.y }, data: {}, style: { width: r.w || defaultW(e.kind), ...(r.h ? { height: r.h } : {}) }, ...(parent ? { parentId: parent } : {}) });
  }
  // A frame whose cards are all hidden (old project frames, filtered out) disappears with them.
  const frames: Node[] = groups.filter((g) => !kids.get(g.id) || shown.get(g.id)).map((g) => ({
    id: g.id, type: 'group', position: { x: g.x, y: g.y }, data: { ...g.data },
    style: { width: g.w || 400, height: g.h || 300 }, zIndex: -1, dragHandle: '.frame-tab',
  }));
  // React Flow wants parents before children.
  return [...frames, ...cards];
}

const same = (a: Node, b: Node) => a.type === b.type && a.parentId === b.parentId && a.position.x === b.position.x && a.position.y === b.position.y
  && (a.style?.width ?? null) === (b.style?.width ?? null) && (a.style?.height ?? null) === (b.style?.height ?? null)
  && (a.width == null || a.width === b.style?.width) && JSON.stringify(a.data) === JSON.stringify(b.data);

export default function Board() {
  const { entities, byId, board, boardLoaded, edges: edgeRows, refreshBoard, open, set, addAttach, notify } = useStore();
  const [nodes, setNodes, onNodesChangeRaw] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const demoNodes = useDemo((d) => d.nodes);
  const demoEdges = useDemo((d) => d.edges);
  const allNodes = useMemo(() => (demoNodes.length ? [...nodes, ...demoNodes] : nodes), [nodes, demoNodes]);
  const allEdges = useMemo(() => (demoEdges.length ? [...edges, ...demoEdges] : edges), [edges, demoEdges]);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'node' | 'edge' | 'pane'; id?: string; ids?: string[]; at?: { x: number; y: number } } | null>(null);
  const [off, setOffState] = useState<string[]>([]);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const setBusy = (v: boolean) => { busyRef.current = v; setBusyState(v); };
  const rf = useReactFlow();
  const placing = useRef(false);
  const touched = useRef(false);     // the user rearranged something, so background regrouping must not move cards
  const marquee = useRef(false);
  const down = useRef<{ x: number; y: number } | null>(null);
  const [overview, setOverview] = useState(false);
  const beforeOverview = useRef<Viewport | null>(null);
  useSeen((s) => s.seen); // opening a card re-renders so __sbAttention stays current

  useEffect(() => { api.getSetting<{ off?: string[] }>('boardFilter', { off: [] }).then((v) => setOffState(Array.isArray(v?.off) ? v.off : [])).catch(() => {}); }, []);
  const setOff = (o: string[]) => { setOffState(o); api.setSetting('boardFilter', { off: o }); };
  const offSet = useMemo(() => new Set(off), [off]);

  const reload = async () => { await refreshBoard(); await useStore.getState().refresh(true); };

  // ---------- smart grouping ----------
  const cardIds = () => {
    const { board, byId } = useStore.getState();
    const ai = new Set(board.filter((r) => r.id.startsWith('grp:ai:')).map((r) => r.id));
    return board.filter((r) => !isGroup(r.id) && !r.hidden && !(r.parent_id && ai.has(r.parent_id)) && byId[r.id] && !suppressed(byId[r.id])).map((r) => r.id);
  };

  const applyGroups = async (groups: GroupSpec[]) => {
    const { board, byId } = useStore.getState();
    const ids = cardIds();
    const clean = cleanGroups(groups, ids);
    const goals = new Map(board.filter((r) => isGroup(r.id) && r.data?.goal).map((r) => [String(r.data.label).toLowerCase(), r.data.goal]));
    const { rows, bottom } = frameLayout(clean, (id) => rf.getNode(id)?.measured?.height || estH(byId[id]));
    for (const r of rows) { const g = isGroup(r.id) && goals.get(String(r.data.label).toLowerCase()); if (g) r.data.goal = g; }
    // Diagrams agents drew keep their frames; they move below the new layout.
    let x = 0;
    for (const f of board.filter((r) => r.id.startsWith('grp:ai:') && !r.hidden)) { rows.push({ ...f, x, y: bottom + GAP }); x += (f.w || 600) + GAP; }
    await api.deleteBoard(board.filter((r) => isGroup(r.id) && !r.id.startsWith('grp:ai:')).map((r) => r.id));
    await api.saveBoard(rows);
    await refreshBoard();
    setTimeout(() => rf.setViewport(START_VIEW, { duration: 400 }), 60);
  };

  const smartGroup = async (auto = false) => {
    const notify = useStore.getState().notify;
    if (busy) { if (!auto) notify('Already grouping…'); return; }
    const ids = cardIds();
    if (!ids.length) { if (!auto) notify('Nothing on the board to group'); return; }
    if (!auto) touched.current = true;
    setBusy(true);
    try {
      let groups: GroupSpec[] | null = null;
      if (ids.length >= 2) {
        try {
          const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out')), 45000));
          const r = await Promise.race([api.call<{ groups: GroupSpec[] }>('smartgroup:run', ids), timeout]);
          if (r?.groups?.length) groups = r.groups;
          else if (!auto) notify('AI grouping returned nothing — used a quick layout');
        } catch (err: any) {
          if (!auto) notify(`AI grouping failed (${err?.message || 'unknown error'}) — used a quick layout`);
        }
      }
      if (auto && (touched.current || !groups)) return;
      if (!groups) { const { byId } = useStore.getState(); groups = heuristicGroups(ids.map((id) => byId[id]).filter(Boolean), byId); }
      await applyGroups(groups);
    } catch (err: any) {
      notify(`Couldn't group the board: ${err?.message || err}`);
    } finally { setBusy(false); }
  };

  // Make sure every visible entity has a place on the board.
  useEffect(() => {
    // Wait for the saved board, or a fresh layout would overwrite where you put things.
    if (!boardLoaded || !entities.length || placing.current) return;
    const rowIds = new Set(board.map((r) => r.id));
    const fresh = entities.filter((e) => !rowIds.has(e.id) && !deleted.has(e.id) && defaultVisible(e));
    if (!fresh.length) return;
    placing.current = true;
    const first = board.length === 0;
    (async () => {
      const rows = first ? frameLayout(heuristicGroups(fresh, byId), (id) => estH(byId[id])).rows : placeNew(fresh.map((e) => e.id), board, byId);
      await api.saveBoard(guard(rows));
      await refreshBoard();
      placing.current = false;
      if (first) { setTimeout(() => rf.setViewport(START_VIEW, { duration: 300 }), 80); smartGroup(true); }
    })();
  }, [entities, board, boardLoaded]);

  // Rebuild nodes from the saved board, keeping selection, measurements and any drag in progress
  // (agents refresh the entities often, and a refresh mustn't yank a card out from under the cursor).
  useEffect(() => { setNodes((prev) => {
    const old = new Map(prev.map((n) => [n.id, n]));
    const next = toNodes(board, byId, (e) => passesFilter(e, offSet)).map((n) => {
      const o = old.get(n.id);
      if (!o) return n;
      if (o.dragging || o.resizing) return o;
      // Unchanged cards keep their node object so they don't re-render (and flash) on every refresh.
      if (same(o, n)) return o;
      return { ...n, selected: o.selected, measured: o.measured };
    });
    return next.length === prev.length && next.every((n, i) => n === prev[i]) ? prev : next;
  }); }, [board, byId, offSet]);

  const nodeKey = nodes.map((n) => n.id).join('|');
  useEffect(() => {
    const ids = new Set(nodes.map((n) => n.id));
    setEdges(edgeRows.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({
      id: e.id, source: e.source, target: e.target, type: 'flow', data: { ...e.data, kind: e.kind, auto: !!e.data?.autoForward },
    })));
  }, [edgeRows, nodeKey]);

  // Cards grow after they're laid out; keep them from covering each other.
  const heights = nodes.map((n) => `${n.id}:${Math.round(n.measured?.height || 0)}`).join('|');
  useEffect(() => {
    if (!boardLoaded) return;
    const t = setTimeout(() => {
      const ns = rf.getNodes();
      if (placing.current || busyRef.current || ns.some((n) => n.dragging)) return;
      const rows = guard(unoverlap(ns.filter((n) => !isDemo(n.id)), useStore.getState().board));
      if (rows.length) api.saveBoard(rows).then(refreshBoard);
    }, 500);
    return () => clearTimeout(t);
  }, [heights, boardLoaded]);

  // Marquee selection catches cards it only partly covers, but never the frames it starts inside.
  const onNodesChange = useCallback((changes: NodeChange<Node>[]) => {
    const list = marquee.current ? changes.filter((c) => !(c.type === 'select' && c.selected && isGroup(c.id))) : changes;
    const isDemoChange = (c: NodeChange<Node>) => 'id' in c && isDemo(c.id);
    const mine = list.filter(isDemoChange);
    if (mine.length) useDemo.getState().onNodesChange(mine);
    onNodesChangeRaw(mine.length ? list.filter((c) => !isDemoChange(c)) : list);
  }, [onNodesChangeRaw]);

  const absPos = useCallback((n: Node) => {
    const internal = rf.getInternalNode(n.id);
    return internal ? internal.internals.positionAbsolute : n.position;
  }, [rf]);
  const sizeOf = (n: Node) => ({ w: n.measured?.width || (n.style?.width as number) || 300, h: n.measured?.height || (n.style?.height as number) || 200 });

  const frameAt = (x: number, y: number, except?: string) => rf.getNodes().filter((g) => g.type === 'group' && g.id !== except).find((g) => {
    const p = absPos(g); const s = sizeOf(g);
    return x > p.x && x < p.x + s.w && y > p.y && y < p.y + s.h;
  });

  // Save positions after drags, reparent into frames (growing them to fit), and send outputs dropped onto cards.
  const onNodeDragStop = useCallback(async (_: any, node: Node, dragged: Node[]) => {
    touched.current = true;
    const moved = (dragged.length ? dragged : [node]).filter((n) => !isDemo(n.id));
    if (!moved.length) return;
    const rows: BoardRow[] = [];
    if (moved.length === 1 && !isDemo(node.id) && (node.type === 'output' || node.type === 'note')) {
      const hit = rf.getIntersectingNodes(node).find((n) => n.type !== 'group' && PROMPTABLE(n.id));
      if (hit) {
        const text = (await api.transcript(node.id))[0]?.text || '';
        addAttach(hit.id, { title: byId[node.id]?.title, text, sourceId: node.id });
        notify(`Attached to ${byId[hit.id]?.title}. Add a note and press Enter.`);
        await refreshBoard();
        return;
      }
    }
    const grow = new Map<string, { x: number; y: number; w: number; h: number }[]>();
    for (const n of moved) {
      if (n.type === 'group') { const r = board.find((b) => b.id === n.id); rows.push({ id: n.id, x: n.position.x, y: n.position.y, w: r?.w, h: r?.h, parent_id: null, data: r?.data || {} }); continue; }
      const abs = absPos(n); const s = sizeOf(n);
      const g = frameAt(abs.x + s.w / 2, abs.y + s.h / 2, n.id);
      if (g) {
        const gp = absPos(g); const k = { x: abs.x - gp.x, y: abs.y - gp.y };
        rows.push({ id: n.id, ...k, parent_id: g.id, data: {} });
        grow.set(g.id, [...(grow.get(g.id) || []), { ...k, w: s.w, h: s.h }]);
      } else rows.push({ id: n.id, x: abs.x, y: abs.y, parent_id: null, data: {} });
    }
    for (const [gid, ks] of grow) {
      const g = board.find((b) => b.id === gid); if (!g) continue;
      const fit = fitFrame(g, ks); if (fit) rows.push(fit);
    }
    await api.saveBoard(guard(rows));
    await refreshBoard();
  }, [board, byId, rf]);

  const onConnect = useCallback(async (c: Connection) => {
    if (!c.source || !c.target || c.source === c.target || isDemo(c.source) || isDemo(c.target)) return;
    if (c.source.startsWith('nt:') && PROMPTABLE(c.target)) {
      await api.saveEdge({ source: c.source, target: c.target, kind: 'link', data: { mode: 'linked', instruction: false } });
      await refreshBoard();
      notify('Linked. On the note, pick Instruction to add it to every prompt, or Send once.');
      return;
    }
    await api.saveEdge({ source: c.source, target: c.target, kind: 'link', data: { autoForward: true } });
    await refreshBoard();
    notify('Connected. Outputs will flow along this line.');
  }, []);

  const onSelectionChange = useCallback(({ nodes }: OnSelectionChangeParams) => {
    set({ selected: nodes.filter((n) => n.type !== 'group' && !isDemo(n.id)).map((n) => n.id) });
  }, []);

  // One click opens a card; a drag only moves it.
  const onNodeClick = (ev: React.MouseEvent, n: Node) => {
    if (isDemo(n.id)) return;
    if (n.type === 'note' && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey) {
      const ta = document.querySelector<HTMLTextAreaElement>(`.react-flow__node[data-id="${n.id}"] textarea`);
      if (ta && document.activeElement !== ta && !(ev.target as HTMLElement).closest('button')) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      return;
    }
    if (n.type === 'group' || ev.shiftKey || ev.metaKey || ev.ctrlKey) return;
    if ((ev.target as HTMLElement).closest('input, textarea, button, a, select, [contenteditable], .composer, .grip, .nodrag, .react-flow__handle')) return;
    const d = down.current;
    if (d && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 4) return;
    open(n.id);
  };

  // Drops from card grips and the inspector (HTML drag and drop).
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/x-sb')) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    document.querySelectorAll('.drop-hot').forEach((el) => el.classList.remove('drop-hot'));
    const el = document.elementsFromPoint(e.clientX, e.clientY).map((x) => x.closest('.react-flow__node:not(.react-flow__node-group)')).find(Boolean);
    if (el) el.classList.add('drop-hot');
  };
  const onDrop = async (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData('application/x-sb'); if (!raw) return;
    e.preventDefault();
    document.querySelectorAll('.drop-hot').forEach((el) => el.classList.remove('drop-hot'));
    const payload = JSON.parse(raw);
    const el = document.elementsFromPoint(e.clientX, e.clientY).map((x) => x.closest('.react-flow__node:not(.react-flow__node-group)')).find(Boolean) as HTMLElement | undefined;
    const target = el?.dataset.id;
    if (target && target !== payload.sourceId && PROMPTABLE(target)) {
      addAttach(target, payload);
      notify(`Attached to ${byId[target]?.title}. Add a note and press Enter.`);
      return;
    }
    const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    // An existing output (from the drawer or its own grip) moves there instead of being copied.
    if (payload.sourceId?.startsWith('out:') && byId[payload.sourceId]) {
      hiddenIds.delete(payload.sourceId);
      await api.saveBoard([{ ...placeAt(payload.sourceId, pos.x - 150, pos.y - 40), hidden: 0 }]);
      await reload();
      return;
    }
    const id = await api.saveOutput({ title: payload.title, content: payload.text, source: payload.sourceId });
    await api.saveBoard([placeAt(id, pos.x - 150, pos.y - 40)]);
    if (payload.sourceId) await api.recordFlow(payload.sourceId, id, payload.text);
    await reload();
  };

  const placeAt = (id: string, x: number, y: number): BoardRow => {
    const g = frameAt(x + 20, y + 20);
    if (!g) return { id, x, y, parent_id: null, data: {} };
    const gp = absPos(g);
    return { id, x: x - gp.x, y: Math.max(HEAD - 8, y - gp.y), parent_id: g.id, data: {} };
  };

  const addNote = async (at: { x: number; y: number }) => {
    const id = await api.saveNote({ text: '' });
    focusNote(id);
    await api.saveBoard([placeAt(id, at.x - 130, at.y - 30)]);
    await reload();
  };

  const hide = async (all: string[]) => {
    const ids = all.filter((id) => !isDemo(id));
    if (!ids.length) return;
    touched.current = true;
    const rows: BoardRow[] = [];
    for (const id of ids) {
      if (isGroup(id)) { await ungroup(id); continue; }
      if (id.startsWith('nt:') || id.startsWith('out:')) { deleted.add(id); await api.deleteEntity(id); continue; }
      const r = useStore.getState().board.find((b) => b.id === id);
      hiddenIds.set(id, Date.now());
      rows.push({ ...(r || { x: 0, y: 0, data: {} }), id, parent_id: r?.parent_id || null, hidden: 1 });
    }
    setNodes((ns) => ns.filter((n) => !ids.includes(n.id)));
    if (rows.length) await api.saveBoard(rows);
    // Entities first, so the placement pass never sees a deleted card without its row.
    await useStore.getState().refresh(true);
    await refreshBoard();
  };

  const groupSelected = async (ids?: string[]) => {
    const sel = ids ? rf.getNodes().filter((n) => ids.includes(n.id) && n.type !== 'group' && !isDemo(n.id)) : rf.getNodes().filter((n) => n.selected && n.type !== 'group' && !isDemo(n.id));
    if (sel.length < 2) { notify('Select two or more cards to group them'); return; }
    touched.current = true;
    const pts = sel.map((n) => ({ n, p: absPos(n), ...sizeOf(n) }));
    const x0 = Math.min(...pts.map((q) => q.p.x)) - PAD, y0 = Math.min(...pts.map((q) => q.p.y)) - HEAD;
    const x1 = Math.max(...pts.map((q) => q.p.x + q.w)) + PAD, y1 = Math.max(...pts.map((q) => q.p.y + q.h)) + PAD;
    const gid = `grp:manual:${Date.now().toString(36)}`;
    const color = colorOf(byId[sel[0].id], useStore.getState().accounts);
    await api.saveBoard([{ id: gid, x: x0, y: y0, w: x1 - x0, h: y1 - y0, parent_id: null, data: { label: 'New group', color, smart: false } },
      ...pts.map((q) => ({ id: q.n.id, x: q.p.x - x0, y: q.p.y - y0, parent_id: gid, data: {} }))]);
    await refreshBoard();
  };

  const ungroup = async (gid: string) => {
    touched.current = true;
    const { board } = useStore.getState();
    const g = board.find((b) => b.id === gid); if (!g) return;
    const kids = board.filter((b) => b.parent_id === gid);
    await api.saveBoard(kids.map((k) => ({ ...k, x: g.x + k.x, y: g.y + k.y, parent_id: null })));
    await api.deleteBoard([gid]);
    await refreshBoard();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
      // ⌘G also works while the open card's composer has the cursor (one click opens a card).
      if (typing && !t.closest?.('.inspector')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        const g = rf.getNodes().find((n) => n.selected && n.type === 'group');
        if (e.shiftKey && g) ungroup(g.id); else groupSelected();
        return;
      }
      if (typing) return;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        const ids = rf.getNodes().filter((n) => n.selected).map((n) => n.id);
        if (ids.length) { e.preventDefault(); hide(ids); }
        const eds = rf.getEdges().filter((x) => x.selected && !isDemo(x.source) && !isDemo(x.target)).map((x) => x.id);
        eds.forEach((id) => api.deleteEdge(id)); if (eds.length) refreshBoard();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    (window as any).__sbRegroup = () => smartGroup();
    (window as any).__sbHide = (ids: string[]) => hide(ids);
    (window as any).__sbAttention = attentionIds(board.filter((r) => !r.hidden && !isGroup(r.id)).map((r) => r.id));
    // Used by the palette and the end-to-end tests to bring a card into view.
    (window as any).__sbCenter = (id: string, zoom = 0.9) => {
      const n = rf.getInternalNode(id); if (!n) return false;
      const p = n.internals.positionAbsolute; const w = n.measured?.width || 300, h = n.measured?.height || 200;
      rf.setCenter(p.x + w / 2, p.y + h / 2, { zoom, duration: 0 }); return true;
    };
  });

  // Overview: group by client/project, fit every frame, and let what's running stand out.
  const toggleOverview = async () => {
    if (overview) {
      setOverview(false);
      if (beforeOverview.current) rf.setViewport(beforeOverview.current, { duration: 400 });
      return;
    }
    beforeOverview.current = rf.getViewport();
    setOverview(true);
    await smartGroup();
    setTimeout(() => {
      const frames = rf.getNodes().filter((n) => n.type === 'group');
      rf.fitView({ nodes: frames.length ? frames : undefined, padding: 0.08, duration: 500 });
    }, 500);
  };

  const viewport = useMemo<Viewport | undefined>(() => { try { return JSON.parse(localStorage.getItem('sb.viewport') || ''); } catch { return undefined; } }, []);
  const edgeRow = menu?.kind === 'edge' ? edgeRows.find((e) => e.id === menu.id) : null;
  const close = () => setMenu(null);
  const mini = (n: Node) => (n.type === 'group' ? 'rgba(24,24,27,.04)' : isDemo(n.id) ? '#18181B' : colorOf(byId[n.id], useStore.getState().accounts));

  return (
    <div className={`board ${overview ? 'overview' : ''}`} onDragOver={onDragOver} onDrop={onDrop} onClick={close}
      onPointerDownCapture={(e) => { down.current = { x: e.clientX, y: e.clientY }; }}
      onDoubleClick={(e) => { if ((e.target as HTMLElement).classList.contains('react-flow__pane')) addNote(rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })); }}>
      <ReactFlow
        nodes={allNodes} edges={allEdges} nodeTypes={allNodeTypes as any} edgeTypes={edgeTypes}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodeDragStop={onNodeDragStop}
        onConnect={onConnect} onSelectionChange={onSelectionChange}
        onSelectionStart={() => { marquee.current = true; }} onSelectionEnd={() => { marquee.current = false; }}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={(_, n) => n.type !== 'group' && n.type !== 'note' && !isDemo(n.id) && open(n.id)}
        onNodeContextMenu={(e, n) => {
          e.preventDefault();
          if (isDemo(n.id)) return;
          const sel = rf.getNodes().filter((x) => x.selected).map((x) => x.id);
          setMenu({ x: e.clientX, y: e.clientY, kind: 'node', id: n.id, ids: sel.includes(n.id) && sel.length > 1 ? sel : [n.id] });
        }}
        onPaneContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, kind: 'pane', at: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }) }); }}
        onEdgeClick={(e, ed) => { e.stopPropagation(); if (isDemo(ed.source) || isDemo(ed.target)) return; setMenu({ x: e.clientX, y: e.clientY, kind: 'edge', id: ed.id }); }}
        onMoveEnd={(_, vp) => localStorage.setItem('sb.viewport', JSON.stringify(vp))}
        defaultViewport={viewport || START_VIEW} minZoom={0.15} maxZoom={1.6}
        selectionOnDrag selectionMode={SelectionMode.Partial} panOnDrag={[1, 2]} panOnScroll zoomOnDoubleClick={false}
        selectionKeyCode={null} multiSelectionKeyCode="Shift" nodeClickDistance={4}
        deleteKeyCode={null} proOptions={{ hideAttribution: true }} elevateNodesOnSelect={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#D4D4D8" bgColor="#FFFFFF" />
        <Controls showInteractive={false} position="bottom-left" orientation="horizontal" className="board-controls" />
        <MiniMap pannable zoomable position="bottom-left" className="board-minimap" nodeColor={mini} nodeStrokeWidth={0} nodeBorderRadius={6}
          bgColor="#FFFFFF" maskColor="rgba(24,24,27,.07)" maskStrokeColor="rgba(24,24,27,.35)" maskStrokeWidth={1} style={{ width: 200, height: 130 }} />
      </ReactFlow>

      <BoardTools busy={busy} onSmart={() => smartGroup()} off={off} setOff={setOff} overview={overview} onOverview={toggleOverview} />

      {menu && (
        <div className="menu board-menu" style={{ left: menu.x, top: menu.y, position: 'fixed' }} onClick={(e) => e.stopPropagation()}>
          {menu.kind === 'node' && menu.id && (() => {
            const ids = menu.ids || [menu.id];
            const cards = ids.filter((i) => !isGroup(i));
            if (ids.length > 1) {
              const allDel = cards.every((i) => i.startsWith('out:') || i.startsWith('nt:'));
              return (<>
                <div className="board-menu-h">{ids.length} selected</div>
                {cards.length > 1 && <button onClick={() => { groupSelected(cards); close(); }}><Group size={14} />Group selected <span className="hint" style={{ marginLeft: 'auto' }}>⌘G</span></button>}
                {cards.length > 0 && <button onClick={() => { set({ chiefOpen: true, chiefMin: false, selected: cards }); close(); }}><Sparkles size={14} />Ask the overall agent about these</button>}
                <div className="sep" />
                <button onClick={() => { hide(ids); close(); }}>{allDel ? <><Trash2 size={14} />Delete {ids.length}</> : <><EyeOff size={14} />Remove {ids.length} from board</>}</button>
              </>);
            }
            return (<>
              {!isGroup(menu.id) && <button onClick={() => { open(menu.id!); close(); }}><Maximize2 size={14} />Open</button>}
              {!isGroup(menu.id) && <button onClick={() => { set({ chiefOpen: true, chiefMin: false, selected: [menu.id!] }); close(); }}><Sparkles size={14} />Ask the overall agent</button>}
              {isGroup(menu.id) && <button onClick={() => { ungroup(menu.id!); close(); }}><Ungroup size={14} />Ungroup</button>}
              <div className="sep" />
              <button onClick={() => { hide([menu.id!]); close(); }}>{menu.id.startsWith('out:') || menu.id.startsWith('nt:') ? <><Trash2 size={14} />Delete</> : <><EyeOff size={14} />{byId[menu.id]?.source === 'grok-bot' ? 'Hide bot' : 'Hide from board'}</>}</button>
            </>);
          })()}
          {menu.kind === 'pane' && menu.at && (<>
            <button onClick={() => { addNote(menu.at!); close(); }}><StickyNote size={14} />Note here</button>
            <button onClick={() => { smartGroup(); close(); }}><Sparkles size={14} />Smart group</button>
          </>)}
          {menu.kind === 'edge' && edgeRow && (<>
            {edgeRow.data?.last && <div className="board-edge-last">{edgeRow.data.last}</div>}
            <button className="board-switch-row" onClick={async () => { await api.saveEdge({ ...edgeRow, kind: 'link', data: { ...edgeRow.data, autoForward: !edgeRow.data?.autoForward } }); await refreshBoard(); }}>
              <Zap size={14} />Sends outputs automatically<span className={`board-switch ${edgeRow.data?.autoForward ? 'on' : ''}`}><i /></span>
            </button>
            <button onClick={async () => { await api.deleteEdge(edgeRow.id); await refreshBoard(); close(); }}><Unlink size={14} />Remove</button>
          </>)}
        </div>
      )}
    </div>
  );
}
