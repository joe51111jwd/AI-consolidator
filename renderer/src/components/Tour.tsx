import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { X } from 'lucide-react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import './tour.css';

const DONE_KEY = 'sb.tourDone';

interface Step {
  target: string[];
  title: string;
  body: string;
  mode?: 'live' | 'board';
  chief?: boolean;
}

// Each target lists the preferred data-tour hook first, then older hooks that already exist.
const STEPS: Step[] = [
  { target: ['.react-flow__node-group', '[data-testid=week-board]'], mode: 'board',
    title: 'Your week', body: 'Everything from this week, grouped by what it\'s about. Running work shimmers; a blue dot means it needs you.' },
  { target: ['[data-tour=board-todo]', '[data-testid=board-todo]'], mode: 'board',
    title: 'To do', body: 'Your own to-dos, chats that need you, everything still working, and replies you owe.' },
  { target: ['.react-flow__node-session', '.react-flow__node'], mode: 'board',
    title: 'A chat', body: 'Click to open it: the plan, steps and recaps, live. Faint lines link meetings and email to the chat they belong with.' },
  { target: ['[data-testid=week-board]'], mode: 'board',
    title: 'This week', body: 'Lays the board out again from this week\'s work. Move things anywhere and it stays how you left it.' },
  { target: ['[data-tour=dock]', '[data-testid=dock]'],
    title: 'Start a chat', body: 'Pick an account to start something new. The % shows its usage, so you can spread work around.' },
  { target: ['[data-tour=agent-panel]', '.sb-chief.open .chief-panel'], chief: true,
    title: 'Main agent', body: 'Ask across everything: "what needs me?", a daily recap, or any question about your chats.' },
  { target: ['[data-tour=search]', '[data-testid=search]'],
    title: 'Search  ⌘K', body: 'Find any chat or meeting. ⌘T tags it as context for your next prompt.' },
  { target: ['[data-tour=mode]', '.mode-seg'], mode: 'live',
    title: 'List', body: 'The same chats as a list, sorted into topics. Switch back to Board any time.' },
  { target: ['[data-tour=import]', '[data-testid=live-import]'], mode: 'live',
    title: 'Import chats', body: 'Bring in any older chat from any Claude account.' },
  { target: ['[data-tour=usage]', '[data-testid=usage-pill]'], mode: 'board',
    title: 'Usage', body: 'Weekly usage for each account. Click for the details.' },
  { target: ['[data-tour=settings]', '[data-testid=settings-btn]'],
    title: 'Settings', body: 'Accounts, clients, the shared brain, and connecting Grok Bot.' },
];

interface TourState { open: boolean; start: () => void; stop: () => void }

export const useTour = create<TourState>((set) => ({
  open: false,
  start: () => {
    useStore.getState().set({ paletteOpen: false, settingsTab: null, chiefOpen: false, inspector: null });
    set({ open: true });
  },
  stop: () => set({ open: false }),
}));

type Box = { x: number; y: number; w: number; h: number } | null;

const find = (sels: string[]) => {
  for (const s of sels) {
    const el = document.querySelector(s) as HTMLElement | null;
    if (el && el.getClientRects().length) return el;
  }
  return null;
};

const PAD = 8, CARD_W = 300, GAP = 14;

function cardPos(box: Box, cardH: number) {
  const vw = window.innerWidth, vh = window.innerHeight;
  if (!box) return { left: (vw - CARD_W) / 2, top: (vh - cardH) / 2 };
  const clampX = (x: number) => Math.min(vw - CARD_W - 16, Math.max(16, x));
  const clampY = (y: number) => Math.min(vh - cardH - 16, Math.max(16, y));
  const cx = box.x + box.w / 2;
  if (box.y + box.h + GAP + cardH < vh - 16) return { left: clampX(cx - CARD_W / 2), top: box.y + box.h + GAP };
  if (box.y - GAP - cardH > 16) return { left: clampX(cx - CARD_W / 2), top: box.y - GAP - cardH };
  if (box.x + box.w + GAP + CARD_W < vw - 16) return { left: box.x + box.w + GAP, top: clampY(box.y) };
  if (box.x - GAP - CARD_W > 16) return { left: box.x - GAP - CARD_W, top: clampY(box.y) };
  return { left: (vw - CARD_W) / 2, top: (vh - cardH) / 2 };
}

// A spotlight walk-through of the real UI: the screen dims except the part being explained.
export default function Tour() {
  const open = useTour((s) => s.open);
  const [i, setI] = useState(0);
  const [box, setBox] = useState<Box>(null);
  const [cardH, setCardH] = useState(150);
  const startMode = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const step = STEPS[i];

  const finish = useCallback(async () => {
    useTour.getState().stop();
    setI(0); setBox(null);
    useStore.getState().set({ chiefOpen: false });
    const back = startMode.current;
    if (back) (window as any).__sbMode?.(back);
    const v = await api.call<string>('app:version').catch(() => '');
    localStorage.setItem(DONE_KEY, v || '1');
  }, []);

  useEffect(() => {
    (window as any).__sbTour = (on: boolean = true) => { if (on) useTour.getState().start(); else useTour.getState().stop(); };
    const auto = !localStorage.getItem(DONE_KEY) && !(window as any).__sbNoTour && !navigator.webdriver;
    if (!auto) return;
    const t = setTimeout(() => {
      if (!localStorage.getItem(DONE_KEY) && !(window as any).__sbNoTour) useTour.getState().start();
    }, 1400);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!open) return;
    setI(0); setBox(null);
    startMode.current = localStorage.getItem('sb.mode') === 'live' ? 'live' : 'board';
  }, [open]);

  // Put the app in the right state for the step, then keep the spotlight on the target as things move.
  useEffect(() => {
    if (!open || !step) return;
    if (step.mode) (window as any).__sbMode?.(step.mode);
    useStore.getState().set({ chiefOpen: !!step.chief });
    let alive = true;
    const measure = () => {
      if (!alive) return;
      const el = find(step.target);
      if (!el) { setBox(null); return; }
      const r = el.getBoundingClientRect();
      setBox((b) => {
        const n = { x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 };
        return b && Math.abs(b.x - n.x) < 0.5 && Math.abs(b.y - n.y) < 0.5 && Math.abs(b.w - n.w) < 0.5 && Math.abs(b.h - n.h) < 0.5 ? b : n;
      });
    };
    const first = setTimeout(() => {
      const el = find(step.target);
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      measure();
    }, 60);
    const poll = setInterval(measure, 250);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      alive = false; clearTimeout(first); clearInterval(poll);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, i]);

  useLayoutEffect(() => { if (open && card.current) setCardH(card.current.offsetHeight); }, [open, i, box]);

  const next = useCallback(() => { if (i >= STEPS.length - 1) finish(); else setI(i + 1); }, [i, finish]);
  const back = useCallback(() => setI(Math.max(0, i - 1)), [i]);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === 'Escape') finish();
      else if (k === 'ArrowRight' || k === 'Enter') next();
      else if (k === 'ArrowLeft') back();
      else return;
      e.preventDefault(); e.stopPropagation();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open, next, back, finish]);

  // Panels close themselves on any outside mousedown; the tour shouldn't count as outside.
  useEffect(() => {
    const el = root.current;
    if (!open || !el) return;
    const stop = (e: MouseEvent) => e.stopPropagation();
    el.addEventListener('mousedown', stop);
    return () => el.removeEventListener('mousedown', stop);
  }, [open]);

  if (!open || !step) return null;
  const pos = cardPos(box, cardH);
  const hole = box || { x: window.innerWidth / 2, y: window.innerHeight / 2, w: 0, h: 0 };
  return createPortal(
    <div className="sb-tour" ref={root} data-testid="tour" role="dialog" aria-modal="true" aria-label="Tour">
      <div className="tour-block" />
      <div className={`tour-hole ${box ? '' : 'none'}`} style={{ left: hole.x, top: hole.y, width: hole.w, height: hole.h }} />
      <div className="tour-card" ref={card} key={i} style={{ left: pos.left, top: pos.top, width: CARD_W }}>
        <button className="tour-x" aria-label="Close tour" onClick={finish}><X size={13} /></button>
        <div className="tour-title">{step.title}</div>
        <p className="tour-body">{step.body}</p>
        <div className="tour-foot">
          <div className="tour-dots" aria-hidden>
            {STEPS.map((_, n) => <i key={n} className={n === i ? 'on' : ''} onClick={() => setI(n)} />)}
          </div>
          <span className="tour-step" data-testid="tour-step">{i + 1} / {STEPS.length}</span>
          <span className="tour-sp" />
          {i === 0
            ? <button className="tour-btn ghost" data-testid="tour-skip" onClick={finish}>Skip</button>
            : <button className="tour-btn ghost" data-testid="tour-back" onClick={back}>Back</button>}
          <button className="tour-btn" data-testid="tour-next" onClick={next}>{i === STEPS.length - 1 ? 'Done' : 'Next'}</button>
        </div>
        {i > 0 && <button className="tour-skip-link" data-testid="tour-skip" onClick={finish}>Skip tour</button>}
      </div>
    </div>,
    document.body,
  );
}
