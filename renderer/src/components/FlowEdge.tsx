import React from 'react';
import { BaseEdge, EdgeLabelRenderer, EdgeProps, getBezierPath } from '@xyflow/react';
import { useStore } from '../lib/store';

// A connection between two cards. Lights up and carries a moving dot when a message travels along it.
export default function FlowEdge(p: EdgeProps) {
  const [path, lx, ly] = getBezierPath(p);
  const live = useStore((s) => s.activeEdges[p.id]);
  const d: any = p.data || {};
  const isLink = d.kind === 'link';
  const stroke = live ? 'var(--accent)' : p.selected ? 'var(--ink)' : isLink ? '#A9A398' : '#C9C3B8';
  return (
    <>
      <BaseEdge id={p.id} path={path} style={{ stroke, strokeWidth: live ? 2.2 : 1.6, strokeDasharray: isLink && !live ? '0' : d.auto ? '5 4' : undefined, transition: 'stroke .3s' }} />
      {live && (
        <circle r="5" fill="var(--accent)">
          <animateMotion dur="1.2s" repeatCount="4" path={path} />
        </circle>
      )}
      <EdgeLabelRenderer>
        <div className="edge-label nodrag nopan" style={{ left: lx, top: ly }}>
          {live ? <span className="edge-pill live">{live.preview || 'Sending…'}</span>
            : d.auto ? <span className="edge-pill">Auto-sends outputs</span>
            : d.count ? <span className="edge-count" title={d.last || ''}>{d.count}</span> : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
