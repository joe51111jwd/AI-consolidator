import React, { useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import { api } from '../lib/api';
import './preview.css';

// In a preview window, a thin banner across the top says the data is made up. Added once when this
// module loads, so it shows whether or not Settings is open.
api.call<boolean>('app:isPreview').then((on) => {
  if (!on || document.querySelector('.preview-banner')) return;
  const bar = document.createElement('div');
  bar.className = 'preview-banner';
  bar.dataset.testid = 'preview-banner';
  bar.textContent = 'Preview · sample data';
  document.body.appendChild(bar);
}).catch(() => {});

// Opens a second Switchboard window on sample data, leaving this one as it is.
export default function PreviewToggle() {
  const [preview, setPreview] = useState(false);
  const [opened, setOpened] = useState(false);
  useEffect(() => { api.call<boolean>('app:isPreview').then((v) => setPreview(!!v)).catch(() => {}); }, []);
  if (preview) return null;
  const open = () => api.call('preview:open').then(() => setOpened(true)).catch(() => {});
  return (
    <div className="preview-toggle" data-testid="preview-toggle">
      <div>
        <div className="preview-toggle-title">Preview with sample data</div>
        <div className="preview-toggle-sub">Opens a separate window with made-up clients, chats and bots. Your real data is not touched.</div>
      </div>
      <button className="btn" onClick={open} disabled={opened}><Eye size={13} />{opened ? 'Opening…' : 'Open preview'}</button>
    </div>
  );
}
