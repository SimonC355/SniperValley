// What the game page may ask the desktop program for (window.desktop). In a browser it is absent.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  lanPort: 47821,
  quit: () => ipcRenderer.invoke('app:quit'),
  // set fullscreen (true/false) or just read it (no argument); resolves to the current state
  fullscreen: (on) => ipcRenderer.invoke('app:fullscreen', on),
  onFullscreen: (cb) => ipcRenderer.on('fullscreen', (_e, on) => cb(on)),
  // start hosting a LAN game: { port, ips } or { error }
  hostLan: () => ipcRenderer.invoke('lan:host'),
});
