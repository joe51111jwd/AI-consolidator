import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap, Node, Edge, useNodesState, useEdgesState,
  useReactFlow, Connection, NodeChange, OnSelectionChangeParams, Viewport,
} from '@xyflow/react';
import { useStore } from '../lib/store';
import { api, BoardRow, Entity } from '../lib/api';
import { nodeTypes } from '../nodes/nodes';
import FlowEdge from './FlowEdge';
import { defaultVisible, smartLayout, placeNew, GroupMode } from '../lib/layout';
import { PROMPTABLE, SOURCE } from '../lib/format';
import { Eye, EyeOff, Maximize2, Sparkles, Trash2, Zap, Unlink, Group, Ungroup } from 'lucide-react';

const edgeTypes = { flow: FlowEdge };

function toNodes(rows: BoardRow[], byId: Record<string, Entity>): Node[] {
  const groups = rows.filter((r) => r.id.startsWith('grp:') && !r.hidden);
  const gset = new Set(groups.map((g) => g.id));
  const out: Node[] = groups.map((g) => ({
    id: g.id, type: 'group', position: { x: g.x, y: g.y }, data: { ...g.data, x: g.x, y: g.y, w: g.w, h: g.h },
    style: { width: g.w || 400, height: g.h || 300 }, zIndex: -1, dragHandle: '.group-label',
  } as Node));
  for (const r of rows) {
    if (r.id.startsWith('grp:') || r.hidden) continue;
    const e = byId[r.id]; if (!e) continue;
    const n: Node = { id: r.id, type: e.kind, position: { x: r.x, y: r.y }, data: {} };
    if (r.parent_id && gset.has(r.parent_id)) n.parentId = r.parent_id;
    out.push(n);
  }
  // React Flow wants parents before children.
  return out.sort((a, b) => (a.type === 'group' ? 0 : 1) - (b.type === 'group' ? 0 : 1));
}

// Opens at a readable zoom in the top-left corner; zoom out to see everything.
const START_VIEW = { x: 40, y: 76, zoom: 0.78 };

export default function Board() {
  const { entities, byId, board, boardLoaded, edges: edgeRows, accounts, refreshBoard, open, set, addAttach, notify } = useStore();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [mode, setMode] = useState<GroupMode>('project');
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'node' | 'edge' | 'pane'; id?: string } | null>(null);
  const rf = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);
  const placing = useRef(false);

  useEffect(() => { api.getSetting<GroupMode>('groupMode', 'project').then(setMode); }, []);

  // Make sure every visible entity has a place on the board.
  useEffect(() => {
    // Wait for the saved board, or a fresh layout would overwrite where you put things.
    if (!boardLoaded || !entities.length || placing.current) return;
    const rowIds = new Set(board.map((r) => r.id));
    const fresh = entities.filter((e) => !rowIds.has(e.id) && defaultVisible(e));
    if (!fresh.length) return;
    placing.current = true;
    (async () => {
      let rows: BoardRow[];
      if (board.length === 0) rows = smartLayout(mode, entities.filter((e) => defaultVisible(e)), accounts);
      else rows = placeNew(fresh.map((e) => e.id), board);
      await api.saveBoard(rows);
      await refreshBoard();
      placing.current = false;
      if (board.length === 0) setTimeout(() => rf.setViewport(START_VIEW, { duration: 300 }), 80);
    })();
  }, [entities, board, boardLoaded]);

  useEffect(() => { setNodes((prev) => {
    const sel = new Set(prev.filter((n) => n.selected).map((n) => n.id));
    return toNodes(board, byId).map((n) => ({ ...n, selected: sel.has(n.id) }));
  }); }, [board, byId]);

  useEffect(() => {
    const ids = new Set(nodes.map((n) => n.id));
    setEdges(edgeRows.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({
      id: e.id, source: e.source, target: e.target, type: 'flow', data: { ...e.data, kind: e.kind, auto: !!e.data?.autoForward },
    })));
  }, [edgeRows, nodes.length]);

  const absPos = useCallback((n: Node) => {
    const internal = rf.getInternalNode(n.id);
    return internal ? internal.internals.positionAbsolute : n.position;
  }, [rf]);

  // Save positions after drags, reparent into groups, and send outputs dropped onto cards.
  const onNodeDragStop = useCallback(async (_: any, node: Node, dragged: Node[]) => {
    const moved = dragged.length ? dragged : [node];
    const rows: BoardRow[] = [];
    if (moved.length === 1 && (node.type === 'output' || node.type === 'note')) {
      const hit = rf.getIntersectingNodes(node).find((n) => n.type !== 'group' && PROMPTABLE(n.id));
      if (hit) {
        const text = (await api.transcript(node.id))[0]?.text || '';
        addAttach(hit.id, { title: byId[node.id]?.title, text, sourceId: node.id });
        notify(`Attached to ${byId[hit.id]?.title}. Add a note on that card and press Enter.`);
        await refreshBoard();
        return;
      }
    }
    for (const n of moved) {
      if (n.type === 'group') { const r = board.find((b) => b.id === n.id); rows.push({ id: n.id, x: n.position.x, y: n.position.y, w: r?.w, h: r?.h, parent_id: null, data: r?.data || {} }); continue; }
      const abs = absPos(n);
      const w = n.measured?.width || 300, h = n.measured?.height || 200;
      const cx = abs.x + w / 2, cy = abs.y + h / 2;
      const group = rf.getNodes().filter((g) => g.type === 'group' && g.id !== n.id).find((g) => {
        const gp = absPos(g); const gw = (g.measured?.width || (g.style?.width as number)); const gh = (g.measured?.height || (g.style?.height as number));
        return cx > gp.x && cx < gp.x + gw && cy > gp.y && cy < gp.y + gh;
      });
      if (group) { const gp = absPos(group); rows.push({ id: n.id, x: abs.x - gp.x, y: abs.y - gp.y, parent_id: group.id, data: {} }); }
      else rows.push({ id: n.id, x: abs.x, y: abs.y, parent_id: null, data: {} });
    }
    await api.saveBoard(rows);
    await refreshBoard();
  }, [board, byId, rf]);

  const onConnect = useCallback(async (c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    await api.saveEdge({ source: c.source, target: c.target, kind: 'link', data: {} });
    await refreshBoard();
    notify('Connected. Drag outputs along it, or click the line to auto-send outputs.');
  }, []);

  const onSelectionChange = useCallback(({ nodes }: OnSelectionChangeParams) => {
    set({ selected: nodes.filter((n) => n.type !== 'group').map((n) => n.id) });
  }, []);

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
      notify(`Attached to ${byId[target]?.title}. Add a note and press Enter to send.`);
      return;
    }
    const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const id = await api.saveOutput({ title: payload.title, content: payload.text, source: payload.sourceId });
    await api.saveBoard([{ id, x: pos.x - 150, y: pos.y - 40, parent_id: null, data: {} }]);
    if (payload.sourceId) await api.recordFlow(payload.sourceId, id, payload.text);
    await useStore.getState().refresh(true); await refreshBoard();
  };

  const hide = async (ids: string[]) => {
    const rows: BoardRow[] = [];
    for (const id of ids) {
      if (id.startsWith('grp:')) { await ungroup(id); await api.deleteBoard([id]); continue; }
      if (id.startsWith('nt:') || id.startsWith('out:')) { await api.deleteEntity(id); continue; }
      const r = board.find((b) => b.id === id);
      rows.push({ id, x: r?.x || 0, y: r?.y || 0, parent_id: null, data: {}, hidden: 1 });
    }
    await api.saveBoard(rows);
    await useStore.getState().refresh(true); await refreshBoard();
  };

  const groupSelected = async () => {
    const sel = rf.getNodes().filter((n) => n.selected && n.type !== 'group');
    if (sel.length < 2) { notify('Select two or more cards to group them'); return; }
    const pts = sel.map((n) => ({ n, p: absPos(n), w: n.measured?.width || 300, h: n.measured?.height || 220 }));
    const x0 = Math.min(...pts.map((q) => q.p.x)) - 24, y0 = Math.min(...pts.map((q) => q.p.y)) - 56;
    const x1 = Math.max(...pts.map((q) => q.p.x + q.w)) + 24, y1 = Math.max(...pts.map((q) => q.p.y + q.h)) + 24;
    const gid = `grp:manual:${Date.now().toString(36)}`;
    await api.saveBoard([{ id: gid, x: x0, y: y0, w: x1 - x0, h: y1 - y0, parent_id: null, data: { label: 'New group', color: '#2F6B55', smart: false, count: sel.length } },
      ...pts.map((q) => ({ id: q.n.id, x: q.p.x - x0, y: q.p.y - y0, parent_id: gid, data: {} }))]);
    await refreshBoard();
  };

  const ungroup = async (gid: string) => {
    const g = board.find((b) => b.id === gid); if (!g) return;
    const kids = board.filter((b) => b.parent_id === gid);
    await api.saveBoard(kids.map((k) => ({ ...k, x: g.x + k.x, y: g.y + k.y, parent_id: null })));
    await api.deleteBoard([gid]);
    await refreshBoard();
  };

  const regroup = async (m: GroupMode) => {
    setMode(m); api.setSetting('groupMode', m);
    const manual = board.filter((r) => r.id.startsWith('grp:manual'));
    const visible = entities.filter((e) => { const r = board.find((b) => b.id === e.id); return r ? !r.hidden : defaultVisible(e); });
    const rows = smartLayout(m, visible, accounts);
    const smartIds = board.filter((r) => r.id.startsWith('grp:') && !r.id.startsWith('grp:manual')).map((r) => r.id);
    await api.deleteBoard([...smartIds, ...manual.map((r) => r.id)]);
    await api.saveBoard(rows);
    await refreshBoard();
    setTimeout(() => rf.setViewport(START_VIEW, { duration: 400 }), 60);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        const g = rf.getNodes().find((n) => n.selected && n.type === 'group');
        if (e.shiftKey && g) ungroup(g.id); else groupSelected();
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        const ids = rf.getNodes().filter((n) => n.selected).map((n) => n.id);
        if (ids.length) hide(ids);
        const eds = rf.getEdges().filter((x) => x.selected).map((x) => x.id);
        eds.forEach((id) => api.deleteEdge(id)); if (eds.length) refreshBoard();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    (window as any).__sbRegroup = regroup;
    // Used by the palette and the end-to-end tests to bring a card into view.
    (window as any).__sbCenter = (id: string, zoom = 0.9) => {
      const n = rf.getInternalNode(id); if (!n) return false;
      const p = n.internals.positionAbsolute; const w = n.measured?.width || 300, h = n.measured?.height || 200;
      rf.setCenter(p.x + w / 2, p.y + h / 2, { zoom, duration: 0 }); return true;
    };
  });

  const viewport = useMemo<Viewport | undefined>(() => { try { return JSON.parse(localStorage.getItem('sb.viewport') || ''); } catch { return undefined; } }, []);
  const edgeRow = menu?.kind === 'edge' ? edgeRows.find((e) => e.id === menu.id) : null;

  return (
    <div ref={wrap} style={{ position: 'absolute', inset: 0 }} onDragOver={onDragOver} onDrop={onDrop} onClick={() => setMenu(null)}>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes as any} edgeTypes={edgeTypes}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodeDragStop={onNodeDragStop}
        onConnect={onConnect} onSelectionChange={onSelectionChange}
        onNodeDoubleClick={(_, n) => n.type !== 'group' && open(n.id)}
        onNodeContextMenu={(e, n) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, kind: 'node', id: n.id }); }}
        onEdgeClick={(e, ed) => { e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, kind: 'edge', id: ed.id }); }}
        onMoveEnd={(_, vp) => localStorage.setItem('sb.viewport', JSON.stringify(vp))}
        defaultViewport={viewport || START_VIEW} minZoom={0.15} maxZoom={1.6}
        selectionOnDrag panOnDrag={[1, 2]} panOnScroll selectionKeyCode={null} multiSelectionKeyCode="Shift"
        deleteKeyCode={null} proOptions={{ hideAttribution: true }} elevateNodesOnSelect={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="#D3CEC4" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap pannable zoomable position="bottom-right" nodeColor={(n) => n.type === 'group' ? 'rgba(28,27,25,.05)' : (SOURCE[byId[n.id]?.source]?.color || '#ccc')} nodeBorderRadius={8} maskColor="rgba(243,241,236,.7)" style={{ width: 170, height: 110 }} />
      </ReactFlow>

      <div className="seg" style={{ position: 'absolute', top: 12, right: 16, zIndex: 5 }}>
        <span className="lbl">Group by</span>
        {(['project', 'source', 'client'] as GroupMode[]).map((m) => (
          <button key={m} className={mode === m ? 'on' : ''} onClick={() => regroup(m)}>{m === 'project' ? 'Project' : m === 'source' ? 'Account' : 'Client'}</button>
        ))}
      </div>

      {menu && (
        <div className="menu" style={{ left: menu.x, top: menu.y, position: 'fixed' }} onClick={(e) => e.stopPropagation()}>
          {menu.kind === 'node' && menu.id && (<>
            {!menu.id.startsWith('grp:') && <button onClick={() => { open(menu.id!); setMenu(null); }}><Maximize2 size={14} />Open</button>}
            {!menu.id.startsWith('grp:') && <button onClick={() => { set({ chiefOpen: true, selected: [menu.id!] }); setMenu(null); }}><Sparkles size={14} />Ask the overall agent</button>}
            <button onClick={() => { groupSelected(); setMenu(null); }}><Group size={14} />Group selected <span className="hint" style={{ marginLeft: 'auto' }}>⌘G</span></button>
            {menu.id.startsWith('grp:') && <button onClick={() => { ungroup(menu.id!); setMenu(null); }}><Ungroup size={14} />Ungroup</button>}
            <div className="sep" />
            <button onClick={() => { hide([menu.id!]); setMenu(null); }}>{menu.id.startsWith('out:') || menu.id.startsWith('nt:') ? <><Trash2 size={14} />Delete</> : <><EyeOff size={14} />Hide from board</>}</button>
          </>)}
          {menu.kind === 'edge' && edgeRow && (<>
            <div className="hint" style={{ padding: '6px 10px' }}>{byId[edgeRow.source]?.title || edgeRow.source} → {byId[edgeRow.target]?.title || edgeRow.target}{edgeRow.data?.count ? ` · ${edgeRow.data.count} messages` : ''}</div>
            {edgeRow.data?.last && <div className="well" style={{ margin: '0 6px 6px', maxWidth: 320 }}>{edgeRow.data.last}</div>}
            <button onClick={async () => { await api.saveEdge({ ...edgeRow, kind: 'link', data: { ...edgeRow.data, autoForward: !edgeRow.data?.autoForward } }); await refreshBoard(); setMenu(null); }}>
              <Zap size={14} />{edgeRow.data?.autoForward ? 'Stop auto-sending outputs' : 'Auto-send outputs along this line'}
            </button>
            <button onClick={async () => { await api.deleteEdge(edgeRow.id); await refreshBoard(); setMenu(null); }}><Unlink size={14} />Remove connection</button>
          </>)}
        </div>
      )}
    </div>
  );
}

export function useShowHidden() {
  return { Eye };
}
