import React from 'react';
import claudeSvg from '../assets/logos/claude.svg?raw';
import openaiSvg from '../assets/logos/openai.svg?raw';
import cursorSvg from '../assets/logos/cursor.svg?raw';
import gmailSvg from '../assets/logos/gmail.svg?raw';
import grokPng from '../assets/logos/grok.png';
import granolaPng from '../assets/logos/granola.png';
import './logos.css';

// Real brand marks, always in the brand's own colour (no rings or backgrounds). `working` adds that agent's own motion so you can tell at a glance who is busy.
type P = { size?: number; color?: string; working?: boolean };

const prep = (raw: string) => raw.replace(/<title>.*?<\/title>/, '').replace('<svg ', '<svg fill="currentColor" width="100%" height="100%" aria-hidden="true" ');
const SVGS = { claude: prep(claudeSvg), openai: prep(openaiSvg), cursor: prep(cursorSvg), gmail: prep(gmailSvg) };

function Svg({ name, label, size = 14, color, working }: P & { name: keyof typeof SVGS; label: string }) {
  return (
    <span className={`lg lg-${name} ${working ? 'on' : ''}`} role="img" aria-label={label}
      style={{ width: size, height: size, color }} dangerouslySetInnerHTML={{ __html: SVGS[name] }} />
  );
}
function Img({ name, label, src, size = 14, working }: P & { name: string; label: string; src: string }) {
  return (
    <span className={`lg lg-${name} ${working ? 'on' : ''}`} style={{ width: size, height: size }}>
      <img src={src} alt={label} draggable={false} />
    </span>
  );
}

export const ClaudeLogo = (p: P) => <Svg name="claude" label="Claude" {...p} color="#D97757" />;
export const CodexLogo = (p: P) => <Svg name="openai" label="Codex" {...p} color="#000000" />;
export const CursorLogo = (p: P) => <Svg name="cursor" label="Cursor" {...p} color="#000" />;
export const MailLogo = (p: P) => <Svg name="gmail" label="Gmail" {...p} color="#EA4335" />;
export const GrokLogo = (p: P) => <Img name="grok" label="Grok Bot" src={grokPng} {...p} />;
export const GranolaLogo = (p: P) => <Img name="granola" label="Granola" src={granolaPng} {...p} />;
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
