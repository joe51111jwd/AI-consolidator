import { api } from './api';
import { useStore } from './store';
import { useSeen } from './attention';

// Keeps the main process's notifications (electron/ext/notify.cjs) in step with the window: which
// card is open (no notification for the chat you're looking at) and how many cards need you (the
// blue dots, window.__sbAttention, shown as the Dock badge). Clicking a notification opens its card.
export interface NotifyPrefs { finished: boolean; waiting: boolean; grok: boolean; todo: boolean; onlyAway: boolean; badge: boolean }

// A notification can be about a card the window hasn't loaded yet (a chat or client that just
// appeared), so load the cards first in that case.
async function reveal(id: string) {
  const s = useStore.getState();
  s.set({ settingsTab: null, paletteOpen: false });
  if (!s.byId[id]) await s.refresh(true).catch(() => {});
  useStore.getState().open(id);
}

let wired = false;
export function wireNotify() {
  if (wired) return; wired = true;
  api.onEvent((e) => { if (e.type === 'notify-open' && typeof e.id === 'string') reveal(e.id); });
  api.call<string | null>('notify:pending').then((id) => { if (id) reveal(id); }).catch(() => {});

  let last = '';
  const push = () => {
    const flag = (window as any).__sbAttention;
    const attention = Array.isArray(flag) ? flag.length : 0;
    const open = useStore.getState().inspector;
    const key = `${open}|${attention}`;
    if (key === last) return;
    last = key;
    api.call('notify:state', { open, attention }).catch(() => { last = ''; });
  };
  // The board recomputes __sbAttention after it renders, so look shortly after anything changes.
  let t: ReturnType<typeof setTimeout> | undefined;
  const soon = () => { clearTimeout(t); t = setTimeout(push, 200); };
  useStore.subscribe(soon);
  useSeen.subscribe(soon);
  setInterval(push, 2000);
  soon();
}
