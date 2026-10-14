// Stand-in for steamworks.js (the parts electron/steam.cjs uses), talking to
// scripts/fake-steam/backend.mjs. Load it with SNIPERVALLEY_FAKE_STEAM=<path to this file>;
// FAKE_STEAM_ID, FAKE_STEAM_NAME and FAKE_STEAM_PORT pick the user and the backend;
// FAKE_STEAM_OFF=1 acts as if Steam is not running.
'use strict';
const net = require('node:net');

const SteamCallback = {
  PersonaStateChange: 0, SteamServersConnected: 1, SteamServersDisconnected: 2, SteamServerConnectFailure: 3,
  LobbyDataUpdate: 4, LobbyChatUpdate: 5, P2PSessionRequest: 6, P2PSessionConnectFail: 7, GameLobbyJoinRequested: 8,
  MicroTxnAuthorizationResponse: 9,
};
const BIG = ['lobby', 'user_changed', 'making_change', 'remote', 'lobby_steam_id', 'friend_steam_id'];

function init() {
  if (process.env.FAKE_STEAM_OFF === '1') throw new Error('Steam is not running (fake)');
  const me = String(process.env.FAKE_STEAM_ID || '76561198000000001');
  const name = process.env.FAKE_STEAM_NAME || `USER${me.slice(-2)}`;
  const sock = net.connect(Number(process.env.FAKE_STEAM_PORT || 47900), '127.0.0.1');
  sock.setNoDelay(true);
  const out = [];
  let ready = false;
  const write = (obj) => { const line = `${JSON.stringify(obj)}\n`; if (ready) sock.write(line); else out.push(line); };
  sock.on('connect', () => { ready = true; sock.write(`${JSON.stringify({ op: 'hello', id: me, name })}\n`); for (const l of out.splice(0)) sock.write(l); });
  sock.on('error', (e) => console.log(`[fake-steam] ${e.message}`));

  const handlers = new Map();   // kind -> Set(fn)
  const pending = new Map();    // req -> resolve
  const lobbies = new Map();    // id -> view { id, owner, members, data }
  const packets = [];
  let req = 1;
  const call = (obj) => new Promise((resolve) => { const r = req++; pending.set(r, resolve); write({ ...obj, req: r }); });

  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.op === 'res') { const r = pending.get(m.req); pending.delete(m.req); if (r) r(m); }
      else if (m.op === 'lobby') lobbies.set(m.lobby.id, m.lobby);
      else if (m.op === 'pkt') packets.push({ from: m.from, data: Buffer.from(m.data, 'base64') });
      else if (m.op === 'cb') {
        const v = { ...m.v };
        for (const k of BIG) if (v[k] !== undefined) v[k] = BigInt(v[k]);
        // callbacks run on Steam's callback tick, not inside the socket read
        setTimeout(() => { for (const fn of handlers.get(SteamCallback[m.kind]) || []) fn(v); }, 0);
      }
    }
  });

  const sid = (id) => ({ steamId64: BigInt(id), steamId32: `[U:1:${BigInt(id) & 0xffffffffn}]`, accountId: Number(BigInt(id) & 0xffffffffn) });
  class Lobby {
    constructor(view) { this.id = BigInt(view.id); this._id = view.id; lobbies.set(view.id, view); }
    get view() { return lobbies.get(this._id) || { members: [], data: {}, owner: '0' }; }
    leave() { write({ op: 'leave', lobby: this._id }); lobbies.delete(this._id); }
    getMembers() { return this.view.members.map(sid); }
    getOwner() { return sid(this.view.owner); }
    getMemberCount() { return BigInt(this.view.members.length); }
    getData(k) { const v = this.view.data[k]; return v === undefined ? null : v; }
    setData(k, v) { this.view.data[k] = String(v); write({ op: 'setdata', lobby: this._id, k, v: String(v) }); return true; }
    openInviteDialog() {}
  }

  return {
    localplayer: {
      getSteamId: () => sid(me),
      getName: () => name,
      setRichPresence: () => {},
    },
    matchmaking: {
      async createLobby(type, max) {
        const r = await call({ op: 'create', type, max });
        return new Lobby(r.lobby);
      },
      async joinLobby(id) {
        const r = await call({ op: 'join', lobby: String(id) });
        if (!r.ok) throw new Error('Failed to join lobby');
        return new Lobby(r.lobby);
      },
    },
    networking: {
      sendP2PPacket(to, type, data) { write({ op: 'send', to: String(to), type, data: Buffer.from(data).toString('base64') }); return true; },
      isP2PPacketAvailable: () => (packets.length ? packets[0].data.length : 0),
      readP2PPacket(size) {
        const p = packets.shift();
        if (!p) throw new Error('No packet available');
        return { data: p.data, size: Math.min(size, p.data.length), steamId: sid(p.from) };
      },
      acceptP2PSession(id) { write({ op: 'accept', id: String(id) }); },
    },
    callback: {
      register(kind, fn) {
        if (!handlers.has(kind)) handlers.set(kind, new Set());
        handlers.get(kind).add(fn);
        return { disconnect: () => handlers.get(kind).delete(fn) };
      },
    },
  };
}

module.exports = { init, SteamCallback, restartAppIfNecessary: () => false, electronEnableSteamOverlay: () => {} };
