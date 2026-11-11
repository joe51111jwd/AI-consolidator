import React, { useEffect, useRef } from 'react';
import { ArrowLeft } from 'lucide-react';
import { AgentLogo } from './Logos';
import './fullchat.css';

type Sub = { id: string; title: string; status?: string; lastText?: string };
type PlanItem = { content: string; status: string };

// The open chat at full size, laid out like claude.ai: one centred conversation, plan and subagents on the side.
export default function FullChat({ title, source, color, agentName, working, rows, streaming, plan, subs, composer, onClose }: {
  title: string; source: string; color?: string; agentName: string; working: boolean;
  rows: React.ReactNode[]; streaming: string; plan: PlanItem[] | null; subs: Sub[]; composer: React.ReactNode; onClose: () => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [rows.length, streaming]);
  const done = plan ? plan.filter((t) => t.status === 'completed').length : 0;
  const side = (plan && plan.length > 0) || subs.length > 0;

  return (
    <div className="fc pn" data-testid="full-chat" onKeyDown={(ev) => { if (ev.key === 'Delete' || ev.key === 'Backspace') ev.stopPropagation(); }}>
      <header className="fc-head">
        <button className="fc-back" onClick={onClose} title="Back to board (Esc)"><ArrowLeft size={15} />Board</button>
        <span className="fc-src"><AgentLogo source={source} color={color} working={working} size={14} />{agentName}</span>
        <span className="fc-title pn-ell">{title}</span>
        {working && <span className="pn-state on">Working</span>}
      </header>
      <div className={`fc-body ${side ? 'side' : ''}`}>
        <div className="fc-scroll">
          <div className="fc-col msgs">
            {rows.length ? rows : <div className="empty">Nothing here yet.</div>}
            {working && <div className="fc-typing" aria-label="Typing"><i /><i /><i /></div>}
            <div ref={end} />
          </div>
        </div>
        {side && (
          <aside className="fc-side">
            {plan && plan.length > 0 && (
              <section>
                <h4>Plan <span>{done}/{plan.length}</span></h4>
                {plan.map((t, i) => (
                  <div key={i} className={`pn-plan-row ${t.status}`}><i>{t.status === 'completed' ? '✓' : ''}</i><span>{t.content}</span></div>
                ))}
              </section>
            )}
            {subs.length > 0 && (
              <section>
                <h4>Subagents <span>{subs.filter((s) => s.status === 'running').length || subs.length}</span></h4>
                {subs.map((s) => (
                  <div key={s.id} className={`fc-sub ${s.status === 'running' ? 'on' : ''}`} title={s.lastText || ''}>
                    <i /><span className="pn-ell">{s.title}</span>
                  </div>
                ))}
              </section>
            )}
          </aside>
        )}
      </div>
      <div className="fc-foot"><div className="fc-col">{composer}</div></div>
    </div>
  );
}
