// SniperValley as a desktop program (Electron). The game is the same web build as in the
// browser (dist/). This file gives it a window, serves it from this PC, hosts LAN games and
// takes games online over Steam (steam.cjs).
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { SteamNet, selfTest } = require('./steam.cjs');

const ROOT = path.join(__dirname, '..', 'dist');
// The game is served on this PC only. Browser storage (the game's settings) is kept per
// address, so the port stays the same from run to run. A second copy on the same PC gets the
// next free port (and its own settings).
const GAME_PORT = 47820;
// Hosting a LAN game: the relay (and the game files, so friends can also join from a browser).
const LAN_PORT = 47821;

// laptops with two graphics cards: use the fast one
app.commandLine.appendSwitch('force_high_performance_gpu');
// sound may start without a click (rejoining a LAN game after the host changes the map)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// for tests: a separate settings folder (two copies on one PC) and URL options for the game
if (process.env.SNIPERVALLEY_USER_DATA) app.setPath('userData', process.env.SNIPERVALLEY_USER_DATA);
const QUERY = process.env.SNIPERVALLEY_QUERY ? `?${process.env.SNIPERVALLEY_QUERY}` : '';

let win = null;
let gameUrl = '';
let gameOrigin = '';
let lan = null;
let lanRelay = null;
let serve = null;
const steam = new SteamNet({
  version: app.getVersion(),
  log: (m) => console.log(m),
  emit: (ev) => { if (win && !win.isDestroyed()) win.webContents.send('steam', ev); },
  logFile: path.join(app.getPath('userData'), 'steam-log.txt'),
});

const prefsFile = () => path.join(app.getPath('userData'), 'window.json');
function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(prefsFile(), 'utf8')); } catch { return {}; }
}
function savePrefs(p) {
  try { fs.writeFileSync(prefsFile(), JSON.stringify({ ...loadPrefs(), ...p })); } catch { /* ignore */ }
}

// Listen on `port`, or on the next ports (+2, +4 ...) up to `tries` times if it is taken.
// Resolves to the port in use.
function listen(server, port, host, tries = 0) {
  return new Promise((resolve, reject) => {
    const attempt = (p, left) => {
      const onListening = () => { server.off('error', onError); resolve(server.address().port); };
      const onError = (e) => {
        server.off('listening', onListening);
        if (e.code === 'EADDRINUSE' && left > 0) attempt(p + 2, left - 1);
        else reject(e);
      };
      server.once('listening', onListening);
      server.once('error', onError);
      server.listen(p, host);
    };
    attempt(port, tries);
  });
}

async function startGameServer() {
  serve = await import('../server/serve.mjs');
  const server = http.createServer(serve.serveStatic(ROOT));
  // a game joined over Steam talks to the host through this program (ws://.../steamnet)
  steam.attachBridge(server, () => gameOrigin);
  const port = await listen(server, GAME_PORT, '127.0.0.1', 8);
  gameOrigin = `http://127.0.0.1:${port}`;
  return `${gameOrigin}/${QUERY}`;
}

// Start hosting on the local network (once; it keeps running while the program is open).
async function hostLan() {
  if (!lan) {
    const { attachRelay } = await import('../server/relay.mjs');
    const server = http.createServer(serve.serveStatic(ROOT));
    lanRelay = attachRelay(server, { log: (m) => console.log(m), onHost: (id) => steam.onRelayHost(id) });
    try {
      await listen(server, LAN_PORT, '0.0.0.0');
    } catch (e) {
      throw new Error(e.code === 'EADDRINUSE' ? `PORT ${LAN_PORT} IS IN USE · IS ANOTHER COPY OF THE GAME HOSTING?` : String(e.message || e));
    }
    lan = server;
  }
  return { port: LAN_PORT, ips: serve.lanAddresses() };
}

function setFullscreen(on) {
  if (!win) return;
  win.setFullScreen(on);
  savePrefs({ fullscreen: on });
}

function createWindow() {
  const prefs = loadPrefs();
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 960,
    minHeight: 540,
    fullscreen: prefs.fullscreen !== false,
    show: false,
    title: 'SniperValley',
    backgroundColor: '#0b0d0c',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('enter-full-screen', () => win.webContents.send('fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('fullscreen', false));
  // links out of the game open in the normal browser
  const inGame = (url) => url.startsWith(`${gameOrigin}/`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && !inGame(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (inGame(url)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  // F11 or Alt+Enter: fullscreen; Ctrl+Shift+I: developer tools (for bug reports)
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11' || (input.alt && input.key === 'Enter')) {
      e.preventDefault();
      setFullscreen(!win.isFullScreen());
    } else if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      e.preventDefault();
      win.webContents.toggleDevTools();
    }
  });
  win.loadURL(gameUrl);
}

ipcMain.handle('app:quit', () => app.quit());
ipcMain.handle('app:fullscreen', (_e, on) => {
  if (typeof on === 'boolean') setFullscreen(on);
  return win ? win.isFullScreen() : false;
});
ipcMain.handle('lan:host', async () => {
  try { return await hostLan(); } catch (e) { return { error: String(e.message || e) }; }
});
// Steam: { ok, name, error, mode, code, ... }; host: { code } or { error }; join: { ok, hostName } or { error }
ipcMain.handle('steam:status', () => steam.status());
ipcMain.handle('steam:host', async (_e, opts) => {
  try { await hostLan(); } catch (e) { return { error: String(e.message || e) }; }
  return steam.host({ relay: lanRelay, open: !!(opts && opts.open) });
});
ipcMain.handle('steam:join', (_e, code) => steam.join(String(code || '')));
ipcMain.handle('steam:leave', () => { steam.leave(); return true; });

// `--steam-selftest=<file>` (the build check): can the program load Steam support? Writes JSON, quits.
const selftest = process.argv.find((a) => a.startsWith('--steam-selftest='));

app.whenReady().then(async () => {
  if (selftest) {
    fs.writeFileSync(selftest.slice('--steam-selftest='.length), JSON.stringify(selfTest()));
    app.exit(0);
    return;
  }
  Menu.setApplicationMenu(null);
  try {
    gameUrl = await startGameServer();
  } catch (e) {
    dialog.showErrorBox('SniperValley', `The game could not start: ${e.message || e}`);
    app.quit();
    return;
  }
  steam.init();   // early, so a friend's "Join game" in Steam reaches this game
  createWindow();
});

app.on('before-quit', () => steam.leave());
app.on('window-all-closed', () => app.quit());
