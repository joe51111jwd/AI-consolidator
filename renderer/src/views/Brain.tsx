import React, { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { md } from '../lib/format';

const PLACEHOLDER = ['# About me', '', '# Clients', '', '# How I like work done', ''].join('\n');

// The shared brain: one markdown file every agent can read and add to (through the `sb` command or MCP).
export default function Brain() {
  const [text, setText] = useState('');
  const [file, setFile] = useState('');
  const [preview, setPreview] = useState(false);
  const notify = useStore((s) => s.notify);
  useEffect(() => { api.brain().then(setText); api.brainPath().then(setFile); }, []);
  const save = async () => { await api.setBrain(text); notify('Saved'); };
  return (
    <div className="page">
      <div className="page-h">
        <div><h1>Shared brain</h1><p>Notes every agent can read. Claude Code, Codex and Grok Bot read and add to it through the Switchboard tools.</p></div>
        <div className="spacer" />
        <div className="seg"><button className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>Edit</button><button className={preview ? 'on' : ''} onClick={() => setPreview(true)}>Read</button></div>
        <button className="btn" onClick={() => api.openPath(file.slice(0, file.lastIndexOf('/')))}><FolderOpen size={13} />Show file</button>
        <button className="btn primary" onClick={save}>Save</button>
      </div>
      <div className="panel" style={{ padding: 22 }}>
        {preview ? <div className="md" dangerouslySetInnerHTML={{ __html: md(text || '_Empty. Add who you are, your clients, and how you like work done._') }} />
          : <textarea className="brain-ed" value={text} onChange={(e) => setText(e.target.value)} placeholder={PLACEHOLDER} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } }} />}
      </div>
      <p className="hint" style={{ marginTop: 10 }}>Stored at <span className="mono">{file}</span></p>
    </div>
  );
}
