import React from 'react';

// Two jacks patched into one: agents routed onto a single board. Same motif as build/icon.svg.
export function BrandGlyph({ size = 26 }: { size?: number }) {
  return (
    <svg className="brand-glyph" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="#18181B" />
      <g fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round">
        <path d="M11.4 11 C16.2 11 15.6 16 20.4 16" />
        <path d="M11.4 21 C16.2 21 15.6 16 20.4 16" />
        <circle cx="9" cy="11" r="2.3" />
        <circle cx="9" cy="21" r="2.3" />
      </g>
      <circle cx="23" cy="16" r="2.9" fill="#fff" />
    </svg>
  );
}

export default function BrandMark() {
  return (
    <span className="brand-mark" title="Switchboard">
      <BrandGlyph />
      <span className="brand-word">Switchboard</span>
    </span>
  );
}
