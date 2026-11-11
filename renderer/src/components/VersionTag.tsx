import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';

// Always shows which build is running, so it's never unclear whether an update landed.
export default function VersionTag() {
  const [v, setV] = useState('');
  useEffect(() => { api.call<string>('app:version').then((x) => setV(String(x || '').split('.').slice(0, 2).join('.'))).catch(() => {}); }, []);
  if (!v) return null;
  return <div className="version-tag" data-testid="version-tag" title="Switchboard version">v{v}</div>;
}
