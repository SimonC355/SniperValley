// Online play over Steam (the program only). A Steam lobby lets friends find the game, and
// Steam's network carries it through Valve's relays: nobody opens ports or types IP addresses.
// The game itself runs exactly like a LAN game:
// - the host's relay (server/relay.mjs) gets each Steam friend as one more peer;
// - a friend's game connects to its own program (WebSocket /steamnet on the local game
//   server), and this file forwards that connection to the host over Steam.
//
// Until SniperValley has its own Steam App ID it uses Valve's test app Spacewar (480):
// everyone with Steam has it, and Steam shows "Playing Spacewar" while the game runs.
'use strict';
const fs = require('node:fs');
const { WebSocketServer } = require('ws');

const APP_ID = 480;
const LOBBY_MAX = 40;
const PING_EVERY = 1000;     // ms
const TIMEOUT = 15000;       // ms without a packet from the other side: it is gone
const CONNECT_TIMEOUT = 20000;
const HOST_GRACE = 60000;    // ms the lobby waits for the host's game to come back (map change reload)
const UNRELIABLE_MAX = 1150; // bytes; Steam sends at most 1200 per unreliable packet
const SEND_UNRELIABLE = 0, SEND_RELIABLE = 2;
const LOBBY_FRIENDS = 1, LOBBY_PUBLIC = 2;
// packet kinds (first byte)
const DATA = 0x44, OPEN = 0x4f, CLOSE = 0x43, PING = 0x50, PONG = 0x51;

const key = (id) => String(typeof id === 'bigint' ? id : BigInt(id));
const msg = (e) => String((e && e.message) || e || 'unknown error');

// Lobby codes: the lobby's Steam ID in Crockford base 32. Steam lobby IDs share their top 32
// bits (0x01860000), so a code is the low 32 bits: 7 characters. Anything else gets all 64 (13).
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LOBBY_HIGH = 0x01860000n;
function lobbyCode(id) {
  const v = BigInt(id);
  const short = v >> 32n === LOBBY_HIGH;
  let n = short ? v & 0xffffffffn : v;
  let s = '';
  for (let i = 0, len = short ? 7 : 13; i < len; i++) { s = B32[Number(n & 31n)] + s; n >>= 5n; }
  return s;
}
function parseCode(text) {
  const raw = String(text || '').trim();
  if (/^\d{15,20}$/.test(raw)) return BigInt(raw);   // a lobby ID pasted as a number
  const s = raw.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if ((s.length !== 7 && s.length !== 13) || [...s].some((ch) => !B32.includes(ch))) return null;
  let n = 0n;
  for (const ch of s) n = (n << 5n) | BigInt(B32.indexOf(ch));
  return s.length === 7 ? (LOBBY_HIGH << 32n) | n : n;
}

// The Steam module: steamworks.js, or a stand-in for tests (scripts/fake-steam).
function loadModule() {
  return process.env.SNIPERVALLEY_FAKE_STEAM ? require(process.env.SNIPERVALLEY_FAKE_STEAM) : require('steamworks.js');
}

class SteamNet {
  // version: the game's version (friends must have the same); emit(event): to the game page;
  // logFile: what happened, for bug reports (started fresh each run)
  constructor({ version, log = console.log, emit = () => {}, logFile = '' }) {
    this.version = version;
    this.emit = emit;
    const t0 = Date.now();
    if (logFile) {
      try {
        fs.mkdirSync(require('node:path').dirname(logFile), { recursive: true });
        fs.writeFileSync(logFile, `SniperValley ${version} · ${new Date().toISOString()}\n`);
      } catch { logFile = ''; }
    }
    this.log = (m) => {
      log(m);
      if (logFile) { try { fs.appendFileSync(logFile, `${((Date.now() - t0) / 1000).toFixed(2).padStart(9)} ${m}\n`); } catch { /* ignore */ } }
    };
    this.mod = null;
    this.client = null;
    this.error = '';
    this.lastTry = 0;
    this.me = '';
    this.name = '';
    this.mode = 'none';      // 'host' | 'client'
    this.lobby = null;
    this.lobbyId = '';
    this.code = '';
    // host
    this.relay = null;
    this.peers = new Map();   // steam id -> { handle, seen }: friends in the hosted game
    this.waiting = new Map(); // steam id -> time: a session request from someone not (yet) in the lobby
    this.graceTimer = null;
    // client
    this.hostId = '';
    this.hostName = '';
    this.hostSeen = 0;
    this.joinedAt = 0;
    this.ping = null;
    this.ws = null;
    // `+connect_lobby <id>`: Steam started the game to join a friend (with the game's own App ID)
    const i = process.argv.indexOf('+connect_lobby');
    this.pendingJoin = i >= 0 && process.argv[i + 1] && parseCode(process.argv[i + 1]) ? lobbyCode(parseCode(process.argv[i + 1])) : '';
  }

  // Start Steam support (again after a failure, at most every 3 s). True when it runs.
  init() {
    if (this.client) return true;
    const now = Date.now();
    if (now - this.lastTry < 3000) return false;
    this.lastTry = now;
    try {
      this.mod = this.mod || loadModule();
    } catch (e) {
      this.error = 'STEAM SUPPORT DID NOT LOAD';
      this.log(`[steam] module: ${msg(e)}`);
      return false;
    }
    try {
      this.client = this.mod.init(APP_ID);
    } catch (e) {
      this.client = null;
      this.error = 'STEAM IS NOT RUNNING OR NOT LOGGED IN · START STEAM, LOG IN AND TRY AGAIN';
      this.log(`[steam] init: ${msg(e)}`);
      return false;
    }
    this.error = '';
    this.me = key(this.client.localplayer.getSteamId().steamId64);
    this.name = String(this.client.localplayer.getName() || '');
    const C = this.mod.SteamCallback;
    const on = (kind, fn) => this.client.callback.register(kind, (v) => { try { fn(v); } catch (e) { this.log(`[steam] callback: ${msg(e)}`); } });
    on(C.LobbyChatUpdate, (v) => this.onLobbyChat(v));
    on(C.P2PSessionRequest, (v) => this.onSessionRequest(key(v.remote)));
    on(C.P2PSessionConnectFail, (v) => this.onSessionFail(key(v.remote)));
    on(C.GameLobbyJoinRequested, (v) => this.emit({ type: 'join', code: lobbyCode(v.lobby_steam_id) }));
    setInterval(() => this.poll(), 4);
    setInterval(() => this.keepAlive(), PING_EVERY);
    this.log(`[steam] logged in as ${this.name} (app ${APP_ID})`);
    return true;
  }

  status() {
    const ok = this.init();
    const pendingJoin = this.pendingJoin;
    this.pendingJoin = '';
    return { ok, name: this.name, error: ok ? '' : this.error, mode: this.mode, code: this.code, hostName: this.hostName, testApp: APP_ID === 480, pendingJoin };
  }

  // ------------------------------------------------------------------ host
  // Open the host's game (its relay) to Steam: friends-only lobby, or `open` to anyone with the code.
  async host({ relay, open = false }) {
    if (!this.init()) return { error: this.error };
    if (this.mode === 'host' && this.lobby) {
      this.relay = relay;
      return { code: this.code };
    }
    this.leave();
    let lobby;
    try {
      lobby = await this.client.matchmaking.createLobby(open ? LOBBY_PUBLIC : LOBBY_FRIENDS, LOBBY_MAX);
    } catch (e) {
      this.log(`[steam] create lobby: ${msg(e)}`);
      return { error: 'STEAM COULD NOT CREATE A LOBBY · TRY AGAIN' };
    }
    this.mode = 'host';
    this.relay = relay;
    this.lobby = lobby;
    this.lobbyId = key(lobby.id);
    this.code = lobbyCode(lobby.id);
    this.peers.clear();
    this.waiting.clear();
    try {
      lobby.setData('game', 'snipervalley');
      lobby.setData('v', this.version);
      lobby.setData('name', this.name);
    } catch (e) { this.log(`[steam] lobby data: ${msg(e)}`); }
    this.presence('Hosting a game');
    this.log(`[steam] hosting, code ${this.code}`);
    return { code: this.code };
  }

  // The relay's host changed: 0 while the host's game reloads (map change) or after it left.
  onRelayHost(id) {
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
    if (id || this.mode !== 'host') return;
    this.graceTimer = setTimeout(() => { if (this.mode === 'host' && !this.relay.hostId) this.leave(); }, HOST_GRACE);
  }

  isMember(id) {
    if (!this.lobby) return false;
    try { return this.lobby.getMembers().some((m) => key(m.steamId64) === id); } catch { return false; }
  }

  onSessionRequest(id) {
    if (this.mode === 'host' && !this.isMember(id)) {
      // Steam may tell us about the session before the lobby lists the new member
      this.log(`[steam] session request from ${id}, not in the lobby yet`);
      this.waiting.set(id, Date.now());
      return;
    }
    if (this.mode === 'host' || (this.mode === 'client' && id === this.hostId)) {
      this.log(`[steam] session with ${id} accepted`);
      this.client.networking.acceptP2PSession(BigInt(id));
    } else this.log(`[steam] session request from ${id} ignored`);
  }

  openPeer(id) {
    const old = this.peers.get(id);
    this.log(`[steam] ${id} connects${old ? ' again' : ''}`);
    if (old) old.handle.close();
    const handle = this.relay.connect((text, unreliable) => this.send(id, DATA, text, unreliable), { canHost: false });
    this.peers.set(id, { handle, seen: Date.now() });
  }

  closePeer(id, tell) {
    const p = this.peers.get(id);
    if (!p) return;
    this.log(`[steam] ${id} disconnects`);
    this.peers.delete(id);
    if (tell) this.send(id, CLOSE, '', false);
    p.handle.close();
  }

  // ------------------------------------------------------------------ client
  async join(code) {
    if (!this.init()) return { error: this.error };
    const id = parseCode(code);
    if (id === null) return { error: 'THAT IS NOT A STEAM CODE (7 LETTERS AND DIGITS) OR AN IP ADDRESS' };
    if (this.mode === 'client' && this.lobbyId === key(id)) return { ok: true, hostName: this.hostName, code: this.code };   // after a reload
    this.leave();
    let lobby;
    try {
      lobby = await this.client.matchmaking.joinLobby(id);
    } catch (e) {
      this.log(`[steam] join ${code}: ${msg(e)}`);
      return { error: 'COULD NOT JOIN · CHECK THE CODE · THE HOST MUST BE IN THE GAME, AND YOU MUST BE STEAM FRIENDS UNLESS THE HOST ALLOWS ANYONE WITH THE CODE' };
    }
    const leaveWith = (error) => { try { lobby.leave(); } catch { /* ignore */ } return { error }; };
    if (lobby.getData('game') !== 'snipervalley') return leaveWith('THAT CODE IS NOT A SNIPERVALLEY GAME');
    const v = lobby.getData('v') || '';
    if (v !== this.version) return leaveWith(`THE HOST HAS VERSION ${v || '?'} AND YOU HAVE ${this.version} · YOU BOTH NEED THE SAME VERSION`);
    const owner = key(lobby.getOwner().steamId64);
    if (owner === this.me) return leaveWith('THAT IS YOUR OWN GAME');
    this.mode = 'client';
    this.lobby = lobby;
    this.lobbyId = key(lobby.id);
    this.code = lobbyCode(lobby.id);
    this.hostId = owner;
    this.hostName = (lobby.getData('name') || '').toUpperCase() || 'THE HOST';
    this.hostSeen = 0;
    this.joinedAt = Date.now();
    this.ping = null;
    this.presence('In a game');
    this.log(`[steam] joined ${this.hostName}'s game, code ${this.code}`);
    return { ok: true, hostName: this.hostName, code: this.code };
  }

  // The joined game's connection (ws://127.0.0.1:<port>/steamnet), forwarded to the host.
  attachBridge(httpServer, origin) {
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => {
      if (!req.url || !req.url.startsWith('/steamnet')) return;
      // only the game's own page (not some web page in a browser on this PC)
      if (req.headers.origin && req.headers.origin !== origin()) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => this.onBridge(ws));
    });
  }

  onBridge(ws) {
    if (this.mode !== 'client') {
      ws.send(JSON.stringify({ t: 'error', msg: 'NOT IN A STEAM GAME' }));
      ws.close();
      return;
    }
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
    this.ws = ws;
    this.log('[steam] the game connects to the host');
    this.send(this.hostId, OPEN, '', false);
    ws.on('message', (raw) => {
      if (this.ws !== ws || this.mode !== 'client') return;
      const text = raw.toString();
      // the game marks positions (sent 20 times a second) as unreliable: {"u":1,...}
      this.send(this.hostId, DATA, text, text.startsWith('{"u":1'));
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.mode === 'client') this.send(this.hostId, CLOSE, '', false);
    });
  }

  hostGone(note) {
    if (this.mode !== 'client') return;
    this.log(`[steam] ${note}`);
    const ws = this.ws;
    this.ws = null;
    this.leave();
    if (ws) {
      try { ws.send(JSON.stringify({ t: 'error', msg: note })); } catch { /* ignore */ }
      ws.close();
    }
    this.emit({ type: 'gone', note });
  }

  // ------------------------------------------------------------------ both
  // Leave the lobby (host: friends are told the game is closed).
  leave() {
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
    if (this.mode === 'host') for (const id of [...this.peers.keys()]) this.closePeer(id, true);
    if (this.mode === 'client' && this.hostId) this.send(this.hostId, CLOSE, '', false);
    if (this.lobby) {
      try { this.lobby.leave(); } catch { /* ignore */ }
      this.log('[steam] left the lobby');
    }
    this.mode = 'none';
    this.lobby = null;
    this.lobbyId = '';
    this.code = '';
    this.hostId = '';
    this.hostName = '';
    this.waiting.clear();
    if (this.client) this.presence(null);
  }

  presence(text) {
    try { this.client.localplayer.setRichPresence('status', text); } catch { /* ignore */ }
  }

  send(to, kind, text, unreliable) {
    if (!this.client || !to) return false;
    const body = Buffer.from(text || '', 'utf8');
    const buf = Buffer.allocUnsafe(body.length + 1);
    buf[0] = kind;
    body.copy(buf, 1);
    const type = unreliable && buf.length <= UNRELIABLE_MAX ? SEND_UNRELIABLE : SEND_RELIABLE;
    try {
      return this.client.networking.sendP2PPacket(BigInt(to), type, buf);
    } catch (e) {
      this.log(`[steam] send: ${msg(e)}`);
      return false;
    }
  }

  poll() {
    const net = this.client.networking;
    for (let i = 0; i < 1000; i++) {
      let size, p;
      try {
        size = net.isP2PPacketAvailable();
        if (!size) return;
        p = net.readP2PPacket(size);
      } catch (e) {
        this.log(`[steam] read: ${msg(e)}`);
        return;
      }
      const data = p.size < p.data.length ? p.data.subarray(0, p.size) : p.data;
      if (data.length) this.onPacket(key(p.steamId.steamId64), data);
    }
  }

  onPacket(from, buf) {
    const kind = buf[0];
    const text = () => buf.subarray(1).toString('utf8');
    if (this.mode === 'host') {
      if (kind === OPEN) {
        if (this.isMember(from)) this.openPeer(from);
        else this.log(`[steam] ${from} is not in the lobby: not connected`);
        return;
      }
      const p = this.peers.get(from);
      // a friend's game reloading (map change) still pings: answer, so it doesn't give up
      if (kind === PING && (p || this.isMember(from))) this.send(from, PONG, text(), true);
      if (!p) return;
      p.seen = Date.now();
      if (kind === DATA) p.handle.receive(text());
      else if (kind === PONG) { const t = Number(text()); if (t) p.handle.ping = Math.round(performance.now() - t); }
      else if (kind === CLOSE) this.closePeer(from, false);
    } else if (this.mode === 'client' && from === this.hostId) {
      this.hostSeen = Date.now();
      if (kind === DATA) { if (this.ws && this.ws.readyState === 1) this.ws.send(text()); }
      else if (kind === PING) this.send(from, PONG, text(), true);
      else if (kind === PONG) { const t = Number(text()); if (t) this.ping = Math.round(performance.now() - t); }
      else if (kind === CLOSE) this.hostGone('THE HOST CLOSED THE GAME');
    }
  }

  keepAlive() {
    const now = Date.now();
    const stamp = String(performance.now());
    if (this.mode === 'host') {
      for (const [id, at] of this.waiting) {
        if (this.isMember(id)) { this.log(`[steam] session with ${id} accepted`); this.waiting.delete(id); this.client.networking.acceptP2PSession(BigInt(id)); }
        else if (now - at > 10000) { this.log(`[steam] session request from ${id} dropped`); this.waiting.delete(id); }
      }
      for (const [id, p] of this.peers) {
        if (now - p.seen > TIMEOUT) { this.log('[steam] a friend stopped answering'); this.closePeer(id, false); continue; }
        this.send(id, PING, stamp, true);
      }
    } else if (this.mode === 'client') {
      this.send(this.hostId, PING, stamp, true);
      if (this.hostSeen ? now - this.hostSeen > TIMEOUT : now - this.joinedAt > CONNECT_TIMEOUT) {
        this.hostGone(this.hostSeen ? 'LOST THE CONNECTION TO THE HOST' : 'COULD NOT REACH THE HOST OVER STEAM');
      }
    }
  }

  onLobbyChat(v) {
    if (!this.lobby || key(v.lobby) !== this.lobbyId) return;
    const user = key(v.user_changed);
    const entered = v.member_state_change === 'Entered' || v.member_state_change === 0;
    this.log(`[steam] lobby: ${user} ${v.member_state_change}`);
    if (this.mode === 'host') {
      if (entered && this.waiting.has(user)) {
        this.log(`[steam] session with ${user} accepted`);
        this.waiting.delete(user);
        this.client.networking.acceptP2PSession(BigInt(user));
      } else if (!entered) this.closePeer(user, false);
    } else if (this.mode === 'client' && !entered && user === this.hostId) {
      this.hostGone('THE HOST LEFT THE GAME');
    }
  }

  onSessionFail(id) {
    this.log(`[steam] connection to ${id} failed`);
    if (this.mode === 'host') this.closePeer(id, false);
    else if (this.mode === 'client' && id === this.hostId) this.hostGone('LOST THE CONNECTION TO THE HOST');
  }
}

// For the build check: can this program load Steam support? (Steam itself need not run.)
function selfTest() {
  const out = { appId: APP_ID, loaded: false, running: false, error: '' };
  let mod;
  try { mod = loadModule(); out.loaded = typeof mod.init === 'function'; } catch (e) { out.error = msg(e); return out; }
  try { mod.init(APP_ID); out.running = true; } catch (e) { out.error = msg(e); }
  return out;
}

module.exports = { SteamNet, lobbyCode, parseCode, selfTest, APP_ID };
