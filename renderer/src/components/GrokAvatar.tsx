import React from 'react';
import './grok-avatar.css';

export type BlobShape = 'cloud' | 'circle' | 'gumdrop' | 'egg' | 'squircle' | 'star' | 'hexagon' | 'bean';

export const GROK_COLORS: Record<string, string> = {
  grey: '#8A8A8A', gray: '#8A8A8A', purple: '#8B5CF6', orange: '#F07A2E', red: '#EF4444', brown: '#8B5E3C',
  pink: '#EC4899', blue: '#3B82F6', white: '#FFFFFF', green: '#4ADE80', teal: '#2DD4BF', amber: '#F59E0B',
};

const SHAPE_ALIASES: Record<string, BlobShape> = {
  puffy: 'cloud', blob: 'cloud', round: 'circle', dot: 'circle', triangle: 'gumdrop', pyramid: 'gumdrop',
  drop: 'egg', droplet: 'egg', oval: 'egg', square: 'squircle', box: 'squircle', hex: 'hexagon', pill: 'bean',
};
const SHAPES: BlobShape[] = ['cloud', 'circle', 'gumdrop', 'egg', 'squircle', 'star', 'hexagon', 'bean'];

export function resolveShape(shape?: string): BlobShape {
  const s = (shape || '').toLowerCase();
  if ((SHAPES as string[]).includes(s)) return s as BlobShape;
  return SHAPE_ALIASES[s] ?? 'cloud';
}

function resolveColor(color?: string): string {
  if (!color) return GROK_COLORS.grey;
  return GROK_COLORS[color.toLowerCase()] ?? color;
}

const SEED_COLORS = ['purple', 'orange', 'red', 'brown', 'pink', 'blue', 'green', 'teal', 'amber'];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// A bot whose cache has no avatar still gets its own stable colour and shape, derived from its id or name.
export function botLook(seed: string | undefined, color?: string | null, shape?: string | null): { color: string; shape: BlobShape } {
  const h = hash(seed || '');
  return {
    color: resolveColor(color || (seed ? SEED_COLORS[h % SEED_COLORS.length] : undefined)),
    shape: shape ? resolveShape(shape) : seed ? SHAPES[Math.floor(h / SEED_COLORS.length) % SHAPES.length] : 'cloud',
  };
}

function starPoints(cx: number, cy: number, outer: number, inner: number): string {
  return Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 ? inner : outer;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
  }).join(' ');
}

// viewBox 0 0 40 40. Rounded corners come from a same-color stroke with round joins.
function shapeEl(shape: BlobShape, p: React.SVGProps<SVGElement>): React.ReactNode {
  const props = p as any;
  switch (shape) {
    case 'circle': return <circle cx="20" cy="21" r="14" {...props} />;
    case 'gumdrop': return <path d="M20 7 C23 7 34 28 33 31 C32 34 8 34 7 31 C6 28 17 7 20 7Z" {...props} />;
    case 'egg': return <ellipse cx="20" cy="21" rx="12" ry="15" transform="rotate(-14 20 21)" {...props} />;
    case 'squircle': return <rect x="8" y="9" width="24" height="24" rx="8" transform="rotate(8 20 21)" {...props} />;
    case 'star': return <polygon points={starPoints(20, 21.5, 16, 8.5)} {...props} />;
    case 'hexagon': return <polygon points="20,7 32,14 32,28 20,35 8,28 8,14" {...props} />;
    case 'bean': return <rect x="4" y="12" width="32" height="19" rx="9.5" {...props} />;
    default: return <path d="M11 32 C5 32 4 24 9 22.5 C7 16 14 12 18 15.5 C20 9 30 9 30.5 16.5 C36 16 37.5 24 33 26 C35 31 30 33 27 32Z" {...props} />;
  }
}

type AvatarProps = { color?: string; shape?: string; size?: number; working?: boolean; attention?: boolean; title?: string; seed?: string };

export function GrokAvatar({ color, shape, size = 28, working, attention, title, seed }: AvatarProps) {
  const look = botLook(seed ?? title, color, shape);
  const fill = look.color;
  const s = look.shape;
  const isWhite = fill.toUpperCase() === '#FFFFFF';
  const eyeY = s === 'bean' ? 18 : s === 'gumdrop' ? 22 : 19;
  return (
    <span className={`ga ${working ? 'working' : 'idle'}`} style={{ width: size, height: size }} title={title}>
      <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden>
        <g className="ga-body">
          {isWhite && shapeEl(s, { fill: '#E4E4E7', stroke: '#D4D4D8', strokeWidth: 5.5, strokeLinejoin: 'round' })}
          {shapeEl(s, { fill, stroke: fill, strokeWidth: 3.5, strokeLinejoin: 'round' })}
          <g className="ga-eyes" stroke="#1a1a1a" strokeWidth="2.6" strokeLinecap="round">
            <line x1="15" y1={eyeY - 2.2} x2="16.4" y2={eyeY + 2.2} />
            <line x1="22.6" y1={eyeY - 2.2} x2="24" y2={eyeY + 2.2} />
          </g>
        </g>
      </svg>
      {attention && <i className="ga-badge" />}
    </span>
  );
}

type Member = { color?: string; shape?: string; seed?: string };

export function GroupAvatar({ members, size = 28, attention }: { members: Member[]; size?: number; attention?: boolean }) {
  const m = members.slice(0, 3);
  const mini = Math.round(size * (m.length > 2 ? 0.56 : 0.64));
  const spots = m.length > 2
    ? [[0, 0.04], [0.44, 0], [0.2, 0.42]]
    : [[0, 0.1], [0.36, 0.3]];
  return (
    <span className="ga-group" style={{ width: size, height: size }}>
      {m.map((mem, i) => (
        <span key={i} style={{ left: spots[i][0] * size, top: spots[i][1] * size, zIndex: 3 - i }}>
          <GrokAvatar color={mem.color} shape={mem.shape} seed={mem.seed} size={mini} />
        </span>
      ))}
      {attention && <i className="ga-badge" />}
    </span>
  );
}
