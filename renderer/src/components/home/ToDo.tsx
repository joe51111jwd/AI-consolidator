import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { useStore } from '../../lib/store';
import { api } from '../../lib/api';
import { dueLabel } from '../../lib/format';
import { Item, useItems } from './items';
import { approvalTarget, hasApproval } from '../../lib/approvals';
import '../live.css';
import '../approval.css';

interface Todo { id: string; text: string; done: boolean; ts: number; ref?: string }

// One list of everything to keep track of: your own to-dos, chats that need you, chats still
// working, and what you owe people (replies, follow-ups, client next steps).
export default function ToDo({ items, className = '' }: { items: Item[]; className?: string }) {
  const due = useStore((s) => s.due);
  const open = useStore((s) => s.open);
  const asks = useStore((s) => s.approvals);
  const byId = useStore((s) => s.byId);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [text, setText] = useState('');
  const [all, setAll] = useState(false);
  useEffect(() => { api.getSetting<Todo[]>('todos', []).then((t) => setTodos(Array.isArray(t) ? t : [])); }, []);
  const save = (next: Todo[]) => { setTodos(next); api.setSetting('todos', next); };
  const add = () => { const t = text.trim(); if (!t) return; save([{ id: `td${Date.now().toString(36)}`, text: t, done: false, ts: Date.now() }, ...todos]); setText(''); };
  const toggle = (t: Todo) => save(todos.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)));
  const remove = (t: Todo) => save(todos.filter((x) => x.id !== t.id));
  // A chat asking for your OK is listed once, as "Approve: …", not again as "Reply to …".
  const needs = items.filter((i) => i.attn && !hasApproval(asks, i.e.id));
  const working = items.filter((i) => i.running && !i.attn);
  const mine = todos.filter((t) => !t.done || all);
  const total = todos.filter((t) => !t.done).length + asks.length + needs.length + working.length + due.length;
  return (
    <section className={`lv-section flat lv-todo ${className}`} data-testid="home-todo">
      <h3 className="lv-h">To do<span>{total}</span></h3>
      <div className="lv-todo-add">
        <input value={text} placeholder="Add a to-do…" data-testid="todo-input" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') add(); }} />
      </div>
      {asks.map((a) => {
        const to = approvalTarget(a, byId);
        return (
          <button key={a.id} className="lv-todo-row ask" onClick={() => to && open(to)} data-testid="todo-approval" title={a.summary.title}>
            <i className="lv-todo-dot attn" /><span className="lv-todo-t">Approve: {a.summary.line}</span><span className="lv-todo-m">{(to && byId[to]?.title) || 'Claude'}</span>
          </button>
        );
      })}
      {mine.map((t) => (
        <div key={t.id} className={`lv-todo-row mine ${t.done ? 'done' : ''}`} data-testid="todo-mine">
          <button className={`lv-todo-check ${t.done ? 'on' : ''}`} onClick={() => toggle(t)} title={t.done ? 'Mark not done' : 'Mark done'}>{t.done ? <Check size={10} strokeWidth={3} /> : null}</button>
          <span className="lv-todo-t" onClick={() => t.ref && open(t.ref)}>{t.text}</span>
          <button className="lv-todo-x" onClick={() => remove(t)} title="Remove"><X size={12} /></button>
        </div>
      ))}
      {needs.map((i) => (
        <button key={`n:${i.e.id}`} className="lv-todo-row" onClick={() => open(i.e.id)} data-testid="todo-row">
          <i className="lv-todo-dot attn" /><span className="lv-todo-t">Reply to {i.e.title}</span><span className="lv-todo-m">needs you</span>
        </button>
      ))}
      {working.map((i) => (
        <button key={`w:${i.e.id}`} className="lv-todo-row" onClick={() => open(i.e.id)} data-testid="todo-row">
          <i className="lv-todo-dot run" /><span className="lv-todo-t">{i.e.title}</span><span className="lv-todo-m">working</span>
        </button>
      ))}
      {(all ? due : due.slice(0, 5)).map((d) => (
        <button key={d.id} className="lv-todo-row" onClick={() => open(d.ref)} data-testid="todo-row">
          <i className={`lv-todo-dot ${d.overdue ? 'late' : ''}`} />
          <span className="lv-todo-t">{d.title}</span>
          <span className="lv-todo-m">{[d.client, d.due ? dueLabel(d.due) : ''].filter(Boolean).join(' · ')}</span>
        </button>
      ))}
      {(due.length > 5 || todos.some((t) => t.done)) && <button className="lv-more" onClick={() => setAll(!all)}>{all ? 'Show less' : 'Show all, including done'}</button>}
    </section>
  );
}

const COLLAPSED_KEY = 'sb.boardTodo';

// The same list, floating on the board home: collapsible, remembered, never taller than ~40% of the window.
export function BoardToDo() {
  const items = useItems();
  const due = useStore((s) => s.due);
  const asks = useStore((s) => s.approvals);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1');
  const flip = () => { const v = !collapsed; setCollapsed(v); localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0'); };
  const needs = asks.length + items.filter((i) => i.attn && !hasApproval(asks, i.e.id)).length;
  const working = items.filter((i) => i.running && !i.attn).length;
  return (
    <aside className={`board-todo ${collapsed ? 'collapsed' : ''}`} data-testid="board-todo" data-tour="board-todo" onKeyDown={(e) => e.stopPropagation()}>
      <button className="bdt-head" onClick={flip} data-testid="board-todo-toggle" aria-expanded={!collapsed} title={collapsed ? 'Show to-dos' : 'Hide to-dos'}>
        <span className="bdt-title">To do</span>
        {needs > 0 && <span className="bdt-n attn">{needs}</span>}
        {working > 0 && <span className="bdt-n run">{working}</span>}
        {!needs && !working && due.length > 0 && <span className="bdt-n">{due.length}</span>}
        <ChevronDown size={13} className="bdt-chev" />
      </button>
      {!collapsed && <div className="bdt-body"><ToDo items={items} className="bdt-list" /></div>}
    </aside>
  );
}
