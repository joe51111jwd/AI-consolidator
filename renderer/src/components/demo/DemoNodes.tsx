import React, { useEffect, useState } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Check, FileOutput, Globe, MessageSquare, Plug, Bot, Bell, Zap, X } from 'lucide-react';
import { ClaudeLogo, GrokLogo } from '../Logos';
import { useDemo, CLAUDE_TEXT, OUTPUT_LINES, DemoAction } from '../../lib/demo';
import './demo.css';

const Handles = () => (
  <>
    <Handle type="target" position={Position.Left} />
    <Handle type="source" position={Position.Right} />
  </>
);

const TYPED = ['Launch day is here.', 'Switchboard puts every agent on one board.', 'Try it free →'];

// A tiny fake screen: browser chrome, a compose box being typed into and a cursor clicking around.
export default function ComputerPreview({ name, color = '#18181B', live = true }: { name: string; color?: string; live?: boolean }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setN((v) => (v + 1) % 140), 90);
    return () => clearInterval(t);
  }, [live]);
  const full = TYPED.join('\n');
  const shown = live ? full.slice(0, Math.min(n, full.length)) : full;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return (
    <div className={`dm-screen ${live ? 'live' : ''}`} style={{ ['--dm-c' as any]: color }} aria-label={`${name} computer`}>
      <div className="dm-chrome">
        <i /><i /><i />
        <span className="dm-url"><Globe size={9} />x.com/{slug}/compose</span>
      </div>
      <div className="dm-app">
        <div className="dm-side"><b /><b /><b /><b /></div>
        <div className="dm-main">
          <div className="dm-compose">
            <span className="dm-av" style={{ background: color }} />
            <div className="dm-typed">
              {shown.split('\n').map((l, i) => <div key={i}>{l}</div>)}
              {live && <span className="dm-caret" />}
            </div>
          </div>
          <div className="dm-row"><s /><s /><span className="dm-post">Post</span></div>
          <div className="dm-feed"><p /><p /><p className="short" /></div>
        </div>
      </div>
      {live && <span className="dm-cursor"><svg width="11" height="14" viewBox="0 0 11 14"><path d="M0 0v12l3.2-3 2.2 5 1.8-.8-2.2-4.9H9.5z" fill="#18181B" stroke="#fff" strokeWidth=".8" /></svg><em /></span>}
    </div>
  );
}

function Top({ logo, name, status }: { logo: React.ReactNode; name: string; status: 'running' | 'done' }) {
  return (
    <div className="dm-top">
      <span className="dm-src">{logo}<span>{name}</span></span>
      <span className={`dm-status ${status}`}><i />{status === 'running' ? 'Working' : 'Done'}</span>
    </div>
  );
}

function DemoHeader() {
  const stop = useDemo((s) => s.stop);
  return (
    <div className="dm-header">
      <span className="dm-live"><i />Live demo</span>
      <span className="dm-hint">Mock data</span>
      <button className="dm-x nodrag" title="Stop demo" onClick={stop}><X size={13} /></button>
    </div>
  );
}

function DemoClaude() {
  const sim = useDemo((s) => s.sim);
  const text = CLAUDE_TEXT.slice(0, sim.claudeChars);
  const streaming = sim.claudeChars < CLAUDE_TEXT.length;
  return (
    <div className="card dm-card">
      <Handles />
      <Top logo={<ClaudeLogo size={14} working={streaming} />} name="Claude" status={streaming ? 'running' : 'done'} />
      <div className="dm-title">Ship the launch</div>
      <div className="dm-bubble user">Get launch day ready. Posts, leads, tests.</div>
      <div className="dm-bubble">{text}{streaming && <span className="dm-caret" />}</div>
      <div className="dm-subs">
        {sim.subs.map((s) => (
          <div key={s.id} className={`dm-sub ${s.status}`}>
            <span className="dm-sub-ico">{s.status === 'done' ? <Check size={10} strokeWidth={3} /> : <i />}</span>
            <span className="dm-sub-t">{s.title}</span>
            <span className={`dm-sub-l ${s.status === 'running' ? 'shimmer' : ''}`}>{s.line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const KIND_ICON: Record<DemoAction['kind'], React.ComponentType<any>> = {
  message: MessageSquare, event: Zap, tool: Globe, connector: Plug, agent: Bot, notice: Bell,
};

function DemoGrok({ data }: NodeProps) {
  const d = data as { bot: 'marketing' | 'outreach'; name: string; color: string };
  const bot = useDemo((s) => s.sim[d.bot]);
  const working = !!bot.actions.length || d.bot === 'marketing';
  return (
    <div className="card dm-card">
      <Handles />
      <Top logo={<GrokLogo size={14} working={working} />} name="Grok Bot" status={working ? 'running' : 'done'} />
      <div className="dm-title"><span className="dm-dot" style={{ background: d.color }} />{d.name}</div>
      <div className="dm-activity shimmer">{bot.activity}{bot.tool && <em>{bot.tool}</em>}</div>
      {d.bot === 'marketing' && <ComputerPreview name={d.name} color={d.color} live />}
      <div className="dm-feedlist">
        {bot.actions.slice(0, 5).map((a) => {
          const Ico = KIND_ICON[a.kind];
          return <div key={a.ts + a.text} className={`dm-act k-${a.kind}`}><Ico size={11} /><span>{a.text}</span></div>;
        })}
        {!bot.actions.length && <div className="dm-act empty">Waiting…</div>}
      </div>
    </div>
  );
}

function DemoOutput() {
  const lines = useDemo((s) => s.sim.outputLines);
  return (
    <div className="card dm-card">
      <Handles />
      <div className="dm-top"><span className="dm-src"><FileOutput size={13} /><span>Output</span></span><span className="dm-count">{lines}/{OUTPUT_LINES.length}</span></div>
      <div className="dm-title">Launch summary</div>
      <div className="dm-out">
        {OUTPUT_LINES.map((l, i) => i < lines
          ? <div key={i} className="dm-line in"><Check size={11} strokeWidth={2.6} /><span>{l}</span></div>
          : <div key={i} className="dm-line skel"><s style={{ width: `${55 + ((i * 17) % 35)}%` }} /></div>)}
      </div>
    </div>
  );
}

export const demoNodeTypes: Record<string, React.ComponentType<any>> = {
  demoHeader: DemoHeader, demoClaude: DemoClaude, demoGrok: DemoGrok, demoOutput: DemoOutput,
};
