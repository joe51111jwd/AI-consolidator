// What to call keys and the computer on this platform: ⌘ and ⌥ on a Mac, Ctrl and Alt on Linux and
// Windows (where the shortcuts are Ctrl+K and so on; see the (e.metaKey || e.ctrlKey) handlers).
export const isMac = (typeof window !== 'undefined' && window.sbBridge?.platform) === 'darwin';
export const isWindows = (typeof window !== 'undefined' && window.sbBridge?.platform) === 'win32';

// key('K') is "⌘K" on a Mac and "Ctrl+K" elsewhere; alt('Space') is "⌥Space" or "Alt+Space".
export const key = (k: string) => (isMac ? `⌘${k}` : `Ctrl+${k}`);
export const alt = (k: string) => (isMac ? `⌥${k}` : `Alt+${k}`);
export const ENTER = isMac ? '↵' : 'Enter';

export const HERE = isMac ? 'this Mac' : 'this computer';
