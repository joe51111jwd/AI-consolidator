import React, { useEffect, useState } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Check, FileOutput, Globe, MessageSquare, Plug, Bot, Bell, Zap, X } from 'lucide-react';
import { AgentLogo, ClaudeLogo, GranolaLogo, MailLogo } from '../Logos';
import { GrokAvatar } from '../GrokAvatar';
import { useDemo, CardSim, DemoAction, DemoSpec, DemoStatus } from '../../lib/demo';
import './demo.css';

const Handles = ({ left, right }: { left?: boolean; right?: boolean }) => (
  <>
    <Handle type="target" position={Position.Left} />
    <Handle type="source" position={Position.Right} />
    {left && <Handle type="source" id="l" position={Position.Left} className="dm-h-alt" />}
    {right && <Handle type="target" id="r" position={Position.Right} className="dm-h-alt" />}
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

const WORD: Record<DemoStatus, string> = { running: 'Working', waiting: 'Needs you', done: 'Done', idle: 'Idle' };

function Status({ c }: { c: CardSim }) {
  return <span className={`dm-status ${c.status}`}><i />{c.label || WORD[c.status]}</span>;
}

const KIND_ICON: Record<DemoAction['kind'], React.ComponentType<any>> = {
  message: MessageSquare, event: Zap, tool: Globe, connector: Plug, agent: Bot, notice: Bell,
};

function FeedList({ feed, max }: { feed: DemoAction[]; max: number }) {
  return (
    <div className="dm-feedlist">
      {feed.slice(0, max).map((a) => {
        const Ico = KIND_ICON[a.kind];
        return <div key={a.ts + a.text} className={`dm-act k-${a.kind}`}><Ico size={11} /><span>{a.text}</span>{a.tool && <em>{a.tool}</em>}</div>;
      })}
    </div>
  );
}

function Avatar({ spec, c }: { spec: DemoSpec; c: CardSim }) {
  const on = c.status === 'running';
  switch (spec.kind) {
    case 'session': return <AgentLogo source={spec.agent} size={16} working={on} />;
    case 'meeting': return <GranolaLogo size={16} />;
    case 'mail': return <MailLogo size={15} />;
    case 'client': return <span className="dm-initials">{spec.name.split(' ').map((w) => w[0]).join('').slice(0, 2)}</span>;
    case 'output': return <span className="dm-ico"><FileOutput size={13} /></span>;
    case 'grok': return <GrokAvatar color={spec.avatar.color} shape={spec.avatar.shape} size={22} working={on} />;
  }
}

function title(spec: DemoSpec) {
  switch (spec.kind) {
    case 'mail': return spec.subject;
    case 'client': return spec.name;
    case 'grok': return spec.name;
    default: return spec.title;
  }
}

function Meta({ spec, c }: { spec: DemoSpec; c: CardSim }) {
  switch (spec.kind) {
    case 'session': {
      const busy = c.subs.filter((s) => s.status === 'running').length;
      return <><span className="dm-acc"><i style={{ background: spec.account.color }} />{spec.account.label}</span>{c.subs.length > 0 && <span>· {busy ? `${busy} of ${c.subs.length} subagents running` : `${c.subs.length} subagents`}</span>}</>;
    }
    case 'meeting': return <><span className="dm-people">{spec.attendees.map((a) => <b key={a}>{a}</b>)}</span><span>· Granola</span></>;
    case 'mail': return <span>{spec.from} · {spec.age}</span>;
    case 'client': return <span>Due {spec.due}</span>;
    case 'output': return <><span className="dm-bar"><i style={{ width: `${(c.n / spec.lines.length) * 100}%` }} /></span><span className="dm-num">{c.n}/{spec.lines.length}</span></>;
    case 'grok': return <span>Grok Bot · {c.feed.length} actions</span>;
  }
}

function SessionMore({ spec, c }: { spec: Extract<DemoSpec, { kind: 'session' }>; c: CardSim }) {
  const typing = c.chars < spec.reply.length && c.status !== 'waiting';
  return (
    <>
      <div className="dm-bubble user">{spec.prompt}</div>
      <div className="dm-bubble">{spec.reply.slice(0, c.chars)}{typing && <span className="dm-caret" />}</div>
      {c.subs.length > 0 && (
        <div className="dm-subs">
          {c.subs.map((s) => (
            <div key={s.title} className={`dm-sub ${s.status}`}>
              <span className="dm-sub-ico">{s.status === 'done' ? <Check size={10} strokeWidth={3} /> : <i />}</span>
              <span className="dm-sub-t">{s.title}</span>
              <span className={`dm-sub-l ${s.status === 'running' ? 'shimmer' : ''}`}>{s.line}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function More({ spec, c }: { spec: DemoSpec; c: CardSim }) {
  switch (spec.kind) {
    case 'session': return <SessionMore spec={spec} c={c} />;
    case 'meeting': return (
      <div className="dm-items"><span className="dm-cap">Action items</span>
        {spec.items.map((it, i) => <div key={it} className={`dm-item ${!spec.live && i < c.n ? 'done' : ''} ${spec.live && i >= c.n ? 'pending' : ''}`}><i />{it}</div>)}
      </div>
    );
    case 'mail': return <div className="dm-quote">{spec.snippets[0]}</div>;
    case 'client': return (
      <div className="dm-items"><span className="dm-cap">Next steps</span>
        {spec.next.map((it, i) => <div key={it} className={`dm-item ${i < c.i % spec.next.length ? 'done' : ''}`}><i />{it}</div>)}
      </div>
    );
    case 'output': return (
      <div className="dm-out">
        {spec.lines.map((l, i) => i < c.n
          ? <div key={l} className="dm-line in"><Check size={11} strokeWidth={2.6} /><span>{l}</span></div>
          : <div key={l} className="dm-line skel"><s style={{ width: `${55 + ((i * 17) % 35)}%` }} /></div>)}
      </div>
    );
    case 'grok': return <FeedList feed={c.feed} max={5} />;
  }
}

// Compact card: avatar + title + status, a now-line, a meta line. Opens up on hover.
function DemoCard({ id, data }: NodeProps) {
  const spec = (data as { spec: DemoSpec }).spec;
  const c = useDemo((s) => s.sim[id]);
  if (!c) return null;
  return (
    <div className={`card dm-card dm-c s-${c.status}`} data-kind={spec.kind}>
      <Handles right={spec.kind === 'session'} />
      {c.attention && <i className="dm-att" title="Needs you" />}
      <div className="dm-r1"><Avatar spec={spec} c={c} /><span className="dm-t">{title(spec)}</span><Status c={c} /></div>
      <div className={`dm-now ${c.status === 'running' ? 'shimmer' : ''}`}>{c.now}</div>
      <div className="dm-meta"><Meta spec={spec} c={c} /></div>
      <div className="dm-more"><div className="dm-more-in"><More spec={spec} c={c} /></div></div>
    </div>
  );
}

function CliRun({ lines, n }: { lines: string[]; n: number }) {
  const shown = Math.floor(n / 2) % (lines.length + 3);
  const visible = lines.slice(0, Math.min(shown, lines.length)).slice(-4);
  const running = shown < lines.length;
  return (
    <div className="dm-cli">
      <div className="dm-cli-top"><ClaudeLogo size={12} working={running} /><span>Claude</span><em>on Grok's computer</em><span className={`dm-status ${running ? 'running' : 'done'}`}><i />{running ? 'Running' : 'Done'}</span></div>
      <div className="dm-cli-body">
        {visible.map((l, i) => <div key={`${shown}-${i}`} className={l.startsWith('$') ? 'cmd' : l.startsWith('✓') ? 'ok' : ''}>{l}</div>)}
        {running && <span className="dm-caret" />}
      </div>
    </div>
  );
}

// The Marketing hub: always open, with its screen, a Claude CLI run and its action feed.
function DemoHub({ id, data }: NodeProps) {
  const spec = (data as { spec: Extract<DemoSpec, { kind: 'grok' }> }).spec;
  const c = useDemo((s) => s.sim[id]);
  if (!c) return null;
  const last = c.feed[0];
  return (
    <div className={`card dm-card dm-hub s-${c.status}`}>
      <Handles left />
      <div className="dm-r1"><GrokAvatar color={spec.avatar.color} shape={spec.avatar.shape} size={26} working /><span className="dm-t">{spec.name}</span><Status c={c} /></div>
      <div className="dm-now shimmer">{c.now}{last?.tool && <em className="dm-tool">{last.tool}</em>}</div>
      <ComputerPreview name={spec.name} color={spec.avatar.color} live />
      {spec.cli && <CliRun lines={spec.cli} n={c.n} />}
      <FeedList feed={c.feed} max={4} />
    </div>
  );
}

function DemoFrame({ data }: NodeProps) {
  const d = data as { name: string; tone: string; prefix: string; agents: number };
  const needs = useDemo((s) => Object.keys(s.sim).filter((k) => k.startsWith(d.prefix) && s.sim[k].attention).length);
  return (
    <div className="dm-frame">
      <div className="dm-frame-head">
        <span className="dm-frame-dot" style={{ background: d.tone }} />
        <span className="dm-frame-name">{d.name}</span>
        <span className="dm-frame-n">{d.agents} {d.agents === 1 ? 'agent' : 'agents'}</span>
        {needs > 0 && <span className="dm-frame-att"><i />{needs}</span>}
      </div>
    </div>
  );
}

function DemoHeader() {
  const stop = useDemo((s) => s.stop);
  const needs = useDemo((s) => Object.values(s.sim).filter((c) => c.attention).length);
  const working = useDemo((s) => Object.values(s.sim).filter((c) => c.status === 'running').length);
  return (
    <div className="dm-header">
      <span className="dm-live"><i />Showcase</span>
      <span className="dm-hint">Mock data · 3 clients</span>
      <span className="dm-stat"><b>{working}</b> working</span>
      {needs > 0 && <span className="dm-stat hot"><b>{needs}</b> need you</span>}
      <button className="dm-x nodrag" title="Stop showcase" onClick={stop}><X size={13} /></button>
    </div>
  );
}

const DemoAnchor = () => <div className="dm-anchor" />;

export const demoNodeTypes: Record<string, React.ComponentType<any>> = {
  demoHeader: DemoHeader, demoCard: DemoCard, demoHub: DemoHub, demoFrame: DemoFrame, demoAnchor: DemoAnchor,
};
