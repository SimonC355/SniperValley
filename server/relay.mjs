// Multiplayer relay for SniperValley. Players reach it over WebSocket (ws://<host>/net: LAN
// browsers and the program itself) or, in the program, over Steam (electron/steam.cjs adds
// them as peers with their own send function). The relay keeps a small lobby (names, teams,
// who hosts) and forwards game messages between the host's game and the joined games. All
// game logic runs in the host's game.
import { WebSocketServer } from 'ws';

const NAME = /[^A-Z0-9ÆØÅÄÖÜ _-]/g;
const PING_EVERY = 2000;   // ms; everyone's ping to the relay goes out this often

// The relay without a transport. connect(send) adds a peer: send(text, unreliable) delivers a
// message to it (unreliable: positions, which over Steam may be lost or arrive out of order).
// The returned peer takes its messages (receive), its ping in ms and its departure (close).
// onHost(id) is told when someone starts hosting (0: the host left).
export function createRelay({ log = console.log, onHost = null } = {}) {
  const peers = new Map();   // id -> { send, name, team, map, v, canHost, ping }
  let nextId = 1;
  let hostId = 0;
  let inGame = false;

  const send = (p, obj) => p.send(JSON.stringify(obj), false);
  const lobby = () => {
    const players = [...peers.entries()].filter(([, p]) => p.name).map(([id, p]) => ({ id, name: p.name, team: p.team }));
    const host = peers.get(hostId);
    const msg = JSON.stringify({ t: 'lobby', hostId, inGame, players, map: host ? host.map : '', v: host ? host.v : '' });
    for (const p of peers.values()) p.send(msg, false);
  };
  const setHost = (id) => {
    hostId = id;
    if (onHost) onHost(id);
  };

  // canHost: false for players from outside this PC's program (Steam friends)
  function connect(sendFn, { canHost = true } = {}) {
    const id = nextId++;
    const me = { send: sendFn, name: '', team: 'auto', map: '', v: '', canHost, ping: null };
    peers.set(id, me);
    send(me, { t: 'welcome', id });
    lobby();
    let open = true;
    return {
      id,
      set ping(ms) { me.ping = ms; },
      receive(raw) {
        if (!open) return;
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (!m || typeof m !== 'object') return;
        switch (m.t) {
          case 'hello': {
            const v = String(m.v || '').replace(/[^0-9a-z.+-]/gi, '').slice(0, 24);
            // a game of another version would go wrong in odd ways: it doesn't join
            const host = peers.get(hostId);
            if (!m.host && host && host !== me && host.v !== v) {
              send(me, { t: 'error', msg: `THE HOST HAS VERSION ${host.v || '?'} AND YOU HAVE ${v || 'AN OLDER ONE'} · YOU BOTH NEED THE SAME VERSION` });
              break;
            }
            me.name = String(m.name || `PLAYER${id}`).toUpperCase().replace(NAME, '').slice(0, 12) || `PLAYER${id}`;
            me.team = ['0', '1', 'auto'].includes(String(m.team)) ? String(m.team) : 'auto';
            me.map = String(m.map || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 24);
            me.v = v;
            if (m.host) {
              if (!me.canHost) send(me, { t: 'error', msg: 'ONLY THE HOST\'S OWN GAME CAN HOST HERE' });
              else if (hostId && peers.has(hostId) && hostId !== id) send(me, { t: 'error', msg: 'A game is already hosted on this server. Join it instead.' });
              else { inGame = false; setHost(id); log(`[relay] ${me.name} hosts`); }
            } else log(`[relay] ${me.name} joined`);
            lobby();
            break;
          }
          case 'team':
            me.team = ['0', '1', 'auto'].includes(String(m.team)) ? String(m.team) : 'auto';
            lobby();
            break;
          case 'ingame':
            if (id === hostId) { inGame = !!m.v; lobby(); }
            break;
          case 'm': {
            // game message: clients talk to the host, the host talks to everyone (or one peer)
            const u = !!m.u;
            const out = JSON.stringify({ t: 'm', from: id, d: m.d });
            if (m.to === 'host') { const h = peers.get(hostId); if (h && hostId !== id) h.send(out, u); }
            else if (typeof m.to === 'number') { const p = peers.get(m.to); if (p) p.send(out, u); }
            else for (const [pid, p] of peers) if (pid !== id && p.name) p.send(out, u);
            break;
          }
          default:
        }
      },
      close() {
        if (!open) return;
        open = false;
        peers.delete(id);
        if (me.name) log(`[relay] ${me.name} left`);
        for (const p of peers.values()) send(p, { t: 'left', id });
        if (id === hostId) {
          inGame = false;
          setHost(0);
          for (const p of peers.values()) send(p, { t: 'hostgone' });
        }
        lobby();
      },
    };
  }

  // everyone's ping to the relay, for the lobby list and the scoreboard
  const timer = setInterval(() => {
    if (!peers.size) return;
    const p = {};
    for (const [id, x] of peers) if (x.ping !== null) p[id] = x.ping;
    const msg = JSON.stringify({ t: 'pings', p });
    for (const x of peers.values()) x.send(msg, true);
  }, PING_EVERY);
  if (timer.unref) timer.unref();

  return {
    connect,
    get hostId() { return hostId; },
    get size() { return peers.size; },
  };
}

// The relay on an HTTP server, with WebSocket peers at /net. Returns the relay, so the program
// can add Steam peers to the same game.
export function attachRelay(httpServer, opts = {}) {
  const relay = createRelay(opts);
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/net')) return;   // leave other upgrades (Vite HMR, the Steam bridge) alone
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    const peer = relay.connect((text) => { if (ws.readyState === 1) ws.send(text); });
    let sentAt = 0;
    const timer = setInterval(() => {
      if (ws.readyState !== 1) return;
      sentAt = performance.now();
      ws.ping();
    }, PING_EVERY);
    ws.on('pong', () => { if (sentAt) peer.ping = Math.round(performance.now() - sentAt); });
    ws.on('message', (raw) => peer.receive(raw));
    ws.on('close', () => { clearInterval(timer); peer.close(); });
  });
  return relay;
}
