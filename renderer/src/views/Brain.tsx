import React, { useEffect, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { md } from '../lib/format';

const PLACEHOLDER = ['# About me', '', '# Clients', '', '# How I like work done', ''].join('\n');

// The shared brain: one markdown file every agent can read and add to (through the `sb` command or MCP).
// Edits save on their own shortly after you stop typing.
export default function Brain() {
  const [text, setText] = useState('');
  const [file, setFile] = useState('');
  const [preview, setPreview] = useState(false);
  const [dirty, setDirty] = useState(false);
  const notify = useStore((s) => s.notify);
  // `base` is the file as last loaded or saved. When an agent adds a note while you're editing,
  // the new part is added to what you're typing instead of replacing it.
  const base = useRef('');
  const textRef = useRef('');
  const timer = useRef<any>(null);
  textRef.current = text;

  const save = async (quiet = false) => {
    clearTimeout(timer.current);
    let t = textRef.current;
    const f = await api.brain();
    if (f !== base.current && f.startsWith(base.current) && !t.endsWith(f.slice(base.current.length))) { t += f.slice(base.current.length); setText(t); }
    if (t !== f) await api.setBrain(t);
    base.current = t; setDirty(false);
    if (!quiet) notify('Saved');
  };

  useEffect(() => {
    api.brain().then((t) => { base.current = t; setText(t); }); api.brainPath().then(setFile);
    const off = window.sbBridge.onEvent(async (e) => {
      if (e.type !== 'brain-changed') return;
      const f = await api.brain();
      if (f === base.current) return;
      const cur = textRef.current;
      if (f === cur) { base.current = f; return; }
      if (cur === base.current) setText(f);
      else if (f.startsWith(base.current)) setText(cur + f.slice(base.current.length));
      base.current = f;
    });
    return () => { off(); if (textRef.current !== base.current) save(true); };
  }, []);

  const edit = (t: string) => {
    setText(t); setDirty(true);
    clearTimeout(timer.current); timer.current = setTimeout(() => save(true), 1200);
  };

  return (
    <div className="page">
      <div className="page-h">
        <div className="seg"><button className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>Edit</button><button className={preview ? 'on' : ''} onClick={() => setPreview(true)}>Read</button></div>
        <span className="spacer" />
        <span className="hint">{dirty ? 'Editing…' : 'Agents read and add to this'}</span>
        <button className="icon-btn" title="Show file" onClick={() => api.openPath(file.slice(0, file.lastIndexOf('/')))}><FolderOpen size={14} /></button>
        <button className="btn primary" onClick={() => save()}>Save</button>
      </div>
      <div className="panel brain-panel" style={{ marginTop: 0 }}>
        {preview ? <div className="md" dangerouslySetInnerHTML={{ __html: md(text || '_Empty. Add who you are, your clients, and how you like work done._') }} />
          : <textarea className="brain-ed" value={text} onChange={(e) => edit(e.target.value)} placeholder={PLACEHOLDER} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } }} />}
      </div>
      {file && <p className="hint" style={{ marginTop: 10 }}>Stored at <span className="mono">{file}</span></p>}
    </div>
  );
}
