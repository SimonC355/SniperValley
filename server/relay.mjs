// LAN relay for SniperValley. Browsers connect to ws://<host>/net. The server keeps a small
// lobby (names, teams, who hosts) and forwards game messages between the hosting browser
// and the joined browsers. All game logic runs in the hosting browser.
import { WebSocketServer } from 'ws';

export function attachRelay(httpServer, { log = console.log } = {}) {
  const wss = new WebSocketServer({ noServer: true });
  const peers = new Map();   // id -> { ws, name, team, map }
  let nextId = 1;
  let hostId = 0;
  let inGame = false;

  const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const lobby = () => {
    const players = [...peers.entries()].filter(([, p]) => p.name).map(([id, p]) => ({ id, name: p.name, team: p.team }));
    const host = peers.get(hostId);
    const msg = { t: 'lobby', hostId, inGame, players, map: host ? host.map : '' };
    for (const p of peers.values()) send(p.ws, msg);
  };

  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/net')) return;   // leave other upgrades (e.g. Vite HMR) alone
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const id = nextId++;
    peers.set(id, { ws, name: '', team: 'auto', map: '' });
    send(ws, { t: 'welcome', id });
    lobby();
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      const me = peers.get(id);
      if (!me) return;
      switch (m.t) {
        case 'hello':
          me.name = String(m.name || `PLAYER${id}`).toUpperCase().replace(/[^A-Z0-9 _-]/g, '').slice(0, 12) || `PLAYER${id}`;
          me.team = ['0', '1', 'auto'].includes(String(m.team)) ? String(m.team) : 'auto';
          me.map = String(m.map || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 24);
          if (m.host) {
            if (hostId && peers.has(hostId) && hostId !== id) send(ws, { t: 'error', msg: 'A game is already hosted on this server. Join it instead.' });
            else { hostId = id; inGame = false; log(`[lan] ${me.name} hosts`); }
          } else log(`[lan] ${me.name} joined`);
          lobby();
          break;
        case 'team':
          me.team = ['0', '1', 'auto'].includes(String(m.team)) ? String(m.team) : 'auto';
          lobby();
          break;
        case 'ingame':
          if (id === hostId) { inGame = !!m.v; lobby(); }
          break;
        case 'm': {
          // game message: clients talk to the host, the host talks to everyone (or one peer)
          const out = JSON.stringify({ t: 'm', from: id, d: m.d });
          if (m.to === 'host') { const h = peers.get(hostId); if (h && hostId !== id && h.ws.readyState === 1) h.ws.send(out); }
          else if (typeof m.to === 'number') { const p = peers.get(m.to); if (p && p.ws.readyState === 1) p.ws.send(out); }
          else for (const [pid, p] of peers) if (pid !== id && p.name && p.ws.readyState === 1) p.ws.send(out);
          break;
        }
        default:
      }
    });
    ws.on('close', () => {
      const me = peers.get(id);
      peers.delete(id);
      if (me && me.name) log(`[lan] ${me.name} left`);
      for (const p of peers.values()) send(p.ws, { t: 'left', id });
      if (id === hostId) {
        hostId = 0;
        inGame = false;
        for (const p of peers.values()) send(p.ws, { t: 'hostgone' });
      }
      lobby();
    });
  });
  return wss;
}
