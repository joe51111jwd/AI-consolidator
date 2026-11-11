import React from 'react';

const RAYS = Array.from({ length: 12 }, (_, i) => i * 30);

export default function ClaudeMark({ size = 12, color = '#D97757' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="-12 -12 24 24" aria-label="Claude" style={{ flex: 'none' }}>
      {RAYS.map((deg, i) => (
        <rect key={deg} x={-1.1} y={-11} width={2.2} height={i % 2 ? 7.5 : 9.5} rx={1.1} fill={color} transform={`rotate(${deg})`} />
      ))}
    </svg>
  );
}

export const isClaude = (source: string) => source === 'claude-code' || source === 'anthropic-api';
