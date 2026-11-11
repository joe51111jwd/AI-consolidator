import React from 'react';
import { BaseEdge, EdgeLabelRenderer, EdgeProps, getBezierPath } from '@xyflow/react';
import { Zap } from 'lucide-react';
import { useStore } from '../lib/store';
import { colorOf } from '../lib/format';

// A line between two cards. Auto-forwarding lines carry a slow drifting dash; when a message
// travels, the line takes the sender's colour and a dot runs along it.
// Related lines (a meeting or thread to the latest chat in its frame) are drawn faint and do nothing.
export default function FlowEdge(p: EdgeProps) {
  if ((p.data as any)?.related) return <RelatedEdge {...p} />;
  return <LinkEdge {...p} />;
}

function RelatedEdge(p: EdgeProps) {
  const [path] = getBezierPath(p);
  return <BaseEdge id={p.id} path={path} className="edge-related" interactionWidth={0} />;
}

function LinkEdge(p: EdgeProps) {
  const [path, lx, ly] = getBezierPath(p);
  const live = useStore((s) => s.activeEdges[p.id]);
  const color = useStore((s) => colorOf(s.byId[p.source], s.accounts));
  const d: any = p.data || {};
  const auto = !!d.auto;
  const stroke = live ? color : p.selected ? '#18181B' : auto ? '#71717A' : d.kind === 'link' ? '#A1A1AA' : '#D4D4D8';
  const cls = live ? 'edge-live' : auto ? 'edge-auto' : undefined;
  return (
    <>
      <BaseEdge id={p.id} path={path} className={cls} interactionWidth={18}
        style={{ stroke, strokeWidth: live ? 2.6 : auto || p.selected ? 1.7 : 1.4, ['--edge-c' as any]: color }} />
      {live && (
        <circle r="4.5" fill={color} className="edge-dot">
          <animateMotion dur="1.1s" repeatCount="indefinite" path={path} />
        </circle>
      )}
      <EdgeLabelRenderer>
        <div className="edge-label nodrag nopan" style={{ left: lx, top: ly }}>
          {live ? <span className="edge-pill live" style={{ background: color }}>{live.preview || 'Sending…'}</span>
            : auto ? <span className="edge-bolt" title="Sends outputs automatically"><Zap size={10} /></span>
            : d.label ? <span className="edge-text">{d.label}</span> : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
