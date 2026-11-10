'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sbBridge', {
  call: async (channel, ...args) => {
    const r = await ipcRenderer.invoke('sb:' + channel, ...args);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  },
  onEvent: (fn) => {
    const h = (_e, ev) => fn(ev);
    ipcRenderer.on('sb:event', h);
    return () => ipcRenderer.removeListener('sb:event', h);
  },
  platform: process.platform,
});
