import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Row } from './items';
import { TopicGroup } from './topics';

// One topic: what it is, what is happening in it, and its chats (those needing you sit in the strip above).
export default function TopicSection({ g, first, rowTour, onBoard }: { g: TopicGroup; first: boolean; rowTour: boolean; onBoard: (ids: string[]) => void }) {
  const rows = g.items.filter((it) => !it.attn);
  if (!rows.length) return null;
  return (
    <section className="hm-topic" data-testid="home-topic" data-topic-id={g.id}>
      <header className="hm-th" data-tour={first ? 'home-topic' : undefined}>
        <div className="hm-tt">
          <h3>{g.label}</h3>
          <span className="hm-counts">
            {g.working > 0 && <span className="w"><i />{g.working} working</span>}
            {g.attn > 0 && <span className="a"><i />{g.attn} needs you</span>}
            {!g.working && !g.attn && <span>{g.items.length}</span>}
          </span>
          <button className="hm-board" data-testid="topic-board" onClick={() => onBoard(g.items.map((it) => it.e.id))} title="Show these chats on the board">
            Open on board<ArrowUpRight size={12} />
          </button>
        </div>
        {g.summary && <p className="hm-sum">{g.summary}</p>}
      </header>
      {rows.map((it, i) => <Row key={it.e.id} it={it} tour={rowTour && i === 0 ? 'home-row' : undefined} />)}
    </section>
  );
}
