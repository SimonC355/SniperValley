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
  // online over Steam (electron/steam.cjs)
  steam: {
    // { ok, name, error, mode, code, hostName, testApp, pendingJoin }
    status: () => ipcRenderer.invoke('steam:status'),
    // open the hosted game to Steam friends ({ open: true }: anyone with the code): { code } or { error }
    host: (opts) => ipcRenderer.invoke('steam:host', opts),
    // join a friend's game by its code: { ok, hostName, code } or { error }; then connect to /steamnet
    join: (code) => ipcRenderer.invoke('steam:join', code),
    leave: () => ipcRenderer.invoke('steam:leave'),
    // { type: 'join', code } (a friend's "Join game" in Steam) or { type: 'gone', note }
    onEvent: (cb) => ipcRenderer.on('steam', (_e, ev) => cb(ev)),
  },
});
