import React from 'react';
import './logos.css';

// One mark per agent/source. `working` adds that agent's own motion so you can tell at a glance who is busy.
type P = { size?: number; color?: string; working?: boolean };

const RAYS = Array.from({ length: 12 }, (_, i) => i * 30);
export function ClaudeLogo({ size = 14, color = '#D97757', working }: P) {
  return (
    <svg className={`lg lg-claude ${working ? 'on' : ''}`} width={size} height={size} viewBox="-12 -12 24 24" aria-label="Claude">
      <g className="lg-spin">{RAYS.map((d, i) => <rect key={d} x={-1.1} y={-11} width={2.2} height={i % 2 ? 7.5 : 9.5} rx={1.1} fill={color} transform={`rotate(${d})`} />)}</g>
    </svg>
  );
}
export function GrokLogo({ size = 14, color = '#111', working }: P) {
  return (
    <svg className={`lg lg-grok ${working ? 'on' : ''}`} width={size} height={size} viewBox="0 0 24 24" aria-label="Grok Bot">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke={color} strokeWidth="2.2" />
      <path className="lg-slash" d="M5 19 L19 5" stroke={color} strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}
export function CodexLogo({ size = 14, color = '#111', working }: P) {
  return (
    <svg className={`lg lg-codex ${working ? 'on' : ''}`} width={size} height={size} viewBox="0 0 24 24" aria-label="Codex">
      <g className="lg-spin">{[0, 60, 120].map((d) => <ellipse key={d} cx="12" cy="12" rx="9.5" ry="4" fill="none" stroke={color} strokeWidth="1.8" transform={`rotate(${d} 12 12)`} />)}</g>
    </svg>
  );
}
export function CursorLogo({ size = 14, color = '#111', working }: P) {
  return (
    <svg className={`lg lg-cursor ${working ? 'on' : ''}`} width={size} height={size} viewBox="0 0 24 24" aria-label="Cursor">
      <path className="lg-pulse" d="M12 2 L21 7 V17 L12 22 L3 17 V7 Z" fill="none" stroke={color} strokeWidth="1.9" strokeLinejoin="round" />
      <path d="M12 2 V12 L21 7 M12 12 L3 17" stroke={color} strokeWidth="1.6" fill="none" />
    </svg>
  );
}
export function MailLogo({ size = 14, color = '#C5221F', working }: P) {
  return (
    <svg className={`lg lg-mail ${working ? 'on' : ''}`} width={size} height={size} viewBox="0 0 24 24" aria-label="Gmail">
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" fill="none" stroke={color} strokeWidth="2" />
      <path className="lg-pulse" d="M3.5 6.5 L12 13 L20.5 6.5" fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
export function GranolaLogo({ size = 14, color = '#4B7A2E', working }: P) {
  return (
    <svg className={`lg lg-granola ${working ? 'on' : ''}`} width={size} height={size} viewBox="0 0 24 24" aria-label="Granola">
      {[6, 12, 18].map((x, i) => <rect key={x} className="lg-bar" style={{ animationDelay: `${i * 0.15}s` }} x={x - 1.6} y="5" width="3.2" height="14" rx="1.6" fill={color} />)}
    </svg>
  );
}
export function DotLogo({ size = 14, color = '#888', working }: P) {
  return <span className={`lg lg-dot ${working ? 'on' : ''}`} style={{ width: size * 0.6, height: size * 0.6, background: color }} />;
}

export function AgentLogo({ source, ...p }: P & { source: string }) {
  switch (source) {
    case 'claude-code': case 'anthropic-api': return <ClaudeLogo {...p} />;
    case 'grok-bot': return <GrokLogo {...p} />;
    case 'codex': case 'openai-compatible': return <CodexLogo {...p} />;
    case 'cursor': return <CursorLogo {...p} />;
    case 'gmail': return <MailLogo {...p} />;
    case 'granola': return <GranolaLogo {...p} />;
    default: return <DotLogo {...p} />;
  }
}
