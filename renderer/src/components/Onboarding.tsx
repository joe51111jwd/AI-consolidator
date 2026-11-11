import React, { useEffect, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';

// New builds lose macOS Accessibility permission, which Grok Bot sending needs. Nudge once per version.
export default function Onboarding() {
  const hasGrok = useStore((s) => s.accounts.some((a) => a.kind === 'grok-bot'));
  const settingsOpen = useStore((s) => !!s.settingsTab);
  const [need, setNeed] = useState(false);
  const [version, setVersion] = useState('');
  useEffect(() => {
    if (!hasGrok) return;
    let t: any;
    const check = async () => {
      try {
        const v = await api.call<string>('app:version').catch(() => '');
        setVersion(v);
        if (localStorage.getItem(`sb.permLater.${v}`)) { setNeed(false); return; }
        const s = await api.call<{ accessibility: boolean }>('perm:status');
        setNeed(!s.accessibility);
        if (!s.accessibility) t = setTimeout(check, 5000);
      } catch { setNeed(false); }
    };
    check();
    return () => clearTimeout(t);
  }, [hasGrok]);
  if (!need || settingsOpen) return null; // it would sit over the Settings tabs
  return (
    <div className="sb-onboard" role="dialog">
      <ShieldCheck size={16} />
      <span>Allow Switchboard to send to Grok Bot</span>
      <button className="sb-onboard-go" onClick={() => api.call('perm:openAccessibility')}>Open Settings</button>
      <button className="sb-onboard-x" aria-label="Later" onClick={() => { localStorage.setItem(`sb.permLater.${version}`, '1'); setNeed(false); }}><X size={14} /></button>
    </div>
  );
}
