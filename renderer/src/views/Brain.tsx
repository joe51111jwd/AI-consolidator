import React, { useEffect, useRef, useState } from 'react';
import { FolderOpen, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { md, ago } from '../lib/format';

const ENTRY = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?: · (.+))?\n([\s\S]*?)(?=\n## \d{4}-\d{2}-\d{2} \d{2}:\d{2}|$)/gm;

// Notes agents appended (each starts with a "## <time> · <who>" heading), newest first.
function additions(text: string) {
  const out: { ts: number; who: string; body: string }[] = [];
  for (const m of text.matchAll(ENTRY)) {
    const ts = Date.parse(`${m[1].replace(' ', 'T')}:00Z`);
    out.push({ ts: Number.isNaN(ts) ? 0 : ts, who: m[2] || 'Agent', body: m[3].trim() });
  }
  return out.reverse().slice(0, 4);
}

const PLACEHOLDER = ['# About me', '', '# Clients', '', '# How I like work done', ''].join('\n');

// The shared brain: one markdown file every agent can read and add to (through the `sb` command or MCP).
// Edits save on their own shortly after you stop typing.
export default function Brain() {
  const [text, setText] = useState('');
  const [file, setFile] = useState('');
  const [preview, setPreview] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [fresh, setFresh] = useState(0);
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
      setFresh(Date.now());
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

  const recent = additions(text);
  return (
    <div className="page">
      <div className="page-h">
        <div className="seg"><button className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>Edit</button><button className={preview ? 'on' : ''} onClick={() => setPreview(true)}>Read</button></div>
        <span className="spacer" />
        <span className="hint">{dirty ? 'Editing…' : 'Agents read and add to this'}</span>
        <button className="icon-btn" title="Show file" onClick={() => api.openPath(file.slice(0, file.lastIndexOf('/')))}><FolderOpen size={14} /></button>
        <button className="btn primary" onClick={() => save()}>Save</button>
      </div>
      <div className="brain-auto">
        <div className="brain-auto-h"><Sparkles size={12} />Agents add notes here automatically</div>
        {recent.length === 0 ? <div className="brain-auto-none">Nothing added yet. Agents append what they learn about you and your work.</div> : (
          <div className="brain-adds">
            {recent.map((r, i) => (
              <div key={`${r.ts}:${i}`} className={`brain-add ${(i === 0 && fresh && Date.now() - fresh < 60000) || Date.now() - r.ts < 86400000 ? 'new' : ''}`}>
                <div className="brain-add-h"><b>{r.who}</b><span>{ago(r.ts)}</span></div>
                <div className="brain-add-b">{r.body.slice(0, 220)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="panel brain-panel" style={{ marginTop: 0 }}>
        {preview ? <div className="md" dangerouslySetInnerHTML={{ __html: md(text || '_Empty. Add who you are, your clients, and how you like work done._') }} />
          : <textarea className="brain-ed" value={text} onChange={(e) => edit(e.target.value)} placeholder={PLACEHOLDER} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } }} />}
      </div>
      {file && <p className="hint" style={{ marginTop: 10 }}>Stored at <span className="mono">{file}</span></p>}
    </div>
  );
}
