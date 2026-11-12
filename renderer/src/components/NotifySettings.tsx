import React, { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { NotifyPrefs } from '../lib/notify';
import { HERE, isMac, isWindows } from '../lib/platform';

const ROWS: [keyof NotifyPrefs, string, string][] = [
  ['finished', 'A chat finishes a reply', "When Switchboard is in the back, or that chat isn't the one you have open."],
  ['waiting', 'A chat is waiting on you', 'It asked you something, needs a permission, or failed.'],
  ['grok', 'A Grok bot posts something new', `New messages and outputs from your bots, through Grok Bot on ${HERE} or the relay.`],
  ['todo', 'Something new to do', "A reply you owe, a follow-up after a meeting, or a client's next step."],
  ['onlyAway', "Only when Switchboard isn't in front", "Stay quiet while you're using Switchboard."],
  ['badge', isMac ? 'Dock badge' : 'Badge on the app icon', isMac ? 'How many things need you, on the Switchboard icon.' : 'How many things need you, on the Switchboard icon (where your desktop shows badges).'],
];
// Windows has no count badge on taskbar icons, so the switch would do nothing there.
const SHOWN = ROWS.filter(([k]) => !(k === 'badge' && isWindows));

// Settings → Accounts → Notifications. Saved in the 'notifications' setting by electron/ext/notify.cjs.
export default function NotifySettings() {
  const { notify } = useStore();
  const [p, setP] = useState<NotifyPrefs | null>(null);
  useEffect(() => { api.call<NotifyPrefs>('notify:settings').then(setP).catch(() => {}); }, []);
  const set = async (k: keyof NotifyPrefs, v: boolean) => {
    setP((cur) => (cur ? { ...cur, [k]: v } : cur));
    try { setP(await api.call<NotifyPrefs>('notify:set', { [k]: v })); } catch (e: any) { notify(e.message); }
  };
  const sample = async () => {
    try { notify((await api.call<boolean>('notify:sample')) ? 'Sent a test notification' : "This computer can't show notifications"); } catch (e: any) { notify(e.message); }
  };
  return (
    <div className="panel" data-testid="notify-settings">
      <div className="panel-h">Notifications</div>
      {SHOWN.map(([k, label, hint]) => (
        <div className="set-row" key={k}>
          <div className="txt"><b>{label}</b><span className="hint">{hint}</span></div>
          <button role="switch" aria-checked={!!p?.[k]} aria-label={label} data-testid={`notify-${k}`} disabled={!p}
            className={`switch ${p?.[k] ? 'on' : ''}`} onClick={() => p && set(k, !p[k])} />
        </div>
      ))}
      <div className="set-row">
        <div className="txt"><b>Try it</b><span className="hint">{isMac ? 'On a Mac, the first one asks to allow notifications from Switchboard.' : 'Shown by your system\'s notifications. If none appears, check that notifications are on for Switchboard there.'}</span></div>
        <button className="btn" data-testid="notify-sample" onClick={sample}><Bell size={13} />Send a test notification</button>
      </div>
    </div>
  );
}
