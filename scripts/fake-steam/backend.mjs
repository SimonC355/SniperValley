// A stand-in for Steam's servers, for testing online play without Steam: lobbies and P2P
// packets between copies of the program on one PC, with a simulated internet (delay, jitter,
// lost and reordered unreliable packets). Each program loads scripts/fake-steam/index.cjs
// (SNIPERVALLEY_FAKE_STEAM) and connects here. See NOTES.md → "Testing online play".
//
//   node scripts/fake-steam/backend.mjs [--port 47900] [--latency 50] [--jitter 20] [--loss 0.02]
//
// latency and jitter are one-way milliseconds; loss is the share of unreliable packets lost.
import net from 'node:net';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
};
const PORT = arg('port', 47900);
const sim = { latency: arg('latency', 0), jitter: arg('jitter', 0), loss: arg('loss', 0) };

const users = new Map();     // steam id -> { sock, name, accepted: Set<id>, queued: Map<id, packet[]> }
const lobbies = new Map();   // lobby id -> { id, type, max, owner, members: [], data: {} }
const reliableQueues = new Map();   // "from>to" -> { items: [{ at, data }], timer }: delivered in order
const stats = { packets: 0, unreliable: 0, reliable: 0, lost: 0, maxUnreliable: 0, maxReliable: 0, bytes: 0 };

const write = (sock, obj) => { if (sock && !sock.destroyed) sock.write(`${JSON.stringify(obj)}\n`); };
const toUser = (id, obj) => { const u = users.get(id); if (u) write(u.sock, obj); };
const lobbyView = (l) => ({ id: l.id, owner: l.owner, members: l.members.slice(), data: { ...l.data } });
const pushLobby = (l) => { for (const m of l.members) toUser(m, { op: 'lobby', lobby: lobbyView(l) }); };
const chat = (l, user, change) => {
  for (const m of l.members) toUser(m, { op: 'cb', kind: 'LobbyChatUpdate', v: { lobby: l.id, user_changed: user, making_change: user, member_state_change: change } });
};

function leaveLobby(id, lobbyId, change = 'Left') {
  const l = lobbies.get(lobbyId);
  if (!l || !l.members.includes(id)) return;
  chat(l, id, change);
  l.members = l.members.filter((m) => m !== id);
  if (!l.members.length) { lobbies.delete(lobbyId); return; }
  if (l.owner === id) l.owner = l.members[0];
  pushLobby(l);
}

function deliver(from, to, data, reliable) {
  const u = users.get(to);
  if (!u) return;
  // like Steam: the first packet from someone new asks to open a session; packets wait for it
  if (!u.accepted.has(from)) {
    if (!u.queued.has(from)) { u.queued.set(from, []); write(u.sock, { op: 'cb', kind: 'P2PSessionRequest', v: { remote: from } }); }
    const q = u.queued.get(from);
    if (reliable || q.length < 64) q.push(data);
    return;
  }
  write(u.sock, { op: 'pkt', from, data });
}

function send(from, to, data, type) {
  const reliable = type >= 2;
  const size = Buffer.byteLength(data, 'base64');
  stats.packets++; stats.bytes += size;
  if (reliable) { stats.reliable++; stats.maxReliable = Math.max(stats.maxReliable, size); }
  else { stats.unreliable++; stats.maxUnreliable = Math.max(stats.maxUnreliable, size); }
  if (!reliable && size > 1200) { stats.oversize = (stats.oversize || 0) + 1; return; }   // Steam refuses these
  if (!reliable && Math.random() < sim.loss) { stats.lost++; return; }
  // sending to someone opens our side of the session
  const me = users.get(from);
  if (me) me.accepted.add(to);
  const now = Date.now();
  const at = now + sim.latency + Math.random() * sim.jitter;
  if (!reliable) { setTimeout(() => deliver(from, to, data, false), Math.max(0, at - now)); return; }
  // reliable packets keep their order: one queue per pair, delivered head first
  const key = `${from}>${to}`;
  let q = reliableQueues.get(key);
  if (!q) { q = { items: [], timer: null }; reliableQueues.set(key, q); }
  const last = q.items.length ? q.items[q.items.length - 1].at : 0;
  q.items.push({ at: Math.max(at, last), data });
  const pump = () => {
    q.timer = null;
    while (q.items.length && q.items[0].at <= Date.now()) deliver(from, to, q.items.shift().data, true);
    if (q.items.length) q.timer = setTimeout(pump, Math.max(0, q.items[0].at - Date.now()));
  };
  if (!q.timer) q.timer = setTimeout(pump, Math.max(0, q.items[0].at - now));
}

let nextLobby = 1;
const server = net.createServer((sock) => {
  let me = '';
  let buf = '';
  sock.setNoDelay(true);
  sock.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const reply = (obj) => write(sock, { op: 'res', req: m.req, ...obj });
      switch (m.op) {
        case 'hello':
          me = String(m.id);
          users.set(me, { sock, name: m.name, accepted: new Set(), queued: new Map() });
          break;
        case 'create': {
          const id = String((0x01860000n << 32n) | BigInt((Date.now() * 7 + nextLobby++ * 104729) % 0xffffffff));
          const l = { id, type: m.type, max: m.max, owner: me, members: [me], data: {} };
          lobbies.set(id, l);
          reply({ ok: true, lobby: lobbyView(l) });
          break;
        }
        case 'join': {
          const l = lobbies.get(String(m.lobby));
          if (!l || l.members.length >= l.max) { reply({ ok: false }); break; }
          if (!l.members.includes(me)) l.members.push(me);
          reply({ ok: true, lobby: lobbyView(l) });
          chat(l, me, 'Entered');
          pushLobby(l);
          break;
        }
        case 'leave': leaveLobby(me, String(m.lobby)); break;
        case 'setdata': {
          const l = lobbies.get(String(m.lobby));
          if (l && l.owner === me) { l.data[m.k] = String(m.v); pushLobby(l); }
          break;
        }
        case 'send': send(me, String(m.to), m.data, m.type); break;
        case 'accept': {
          const u = users.get(me);
          const from = String(m.id);
          if (!u) break;
          u.accepted.add(from);
          for (const data of u.queued.get(from) || []) write(sock, { op: 'pkt', from, data });
          u.queued.delete(from);
          break;
        }
        // test controls
        case 'joinrequest': toUser(String(m.target), { op: 'cb', kind: 'GameLobbyJoinRequested', v: { lobby_steam_id: String(m.lobby), friend_steam_id: me } }); break;
        case 'lobbies': reply({ lobbies: [...lobbies.values()].map(lobbyView) }); break;
        case 'forcedata': {
          const l = lobbies.get(String(m.lobby));
          if (l) { l.data[m.k] = String(m.v); pushLobby(l); }
          reply({ ok: !!l });
          break;
        }
        case 'stats': reply({ stats, sim }); break;
        case 'sim': Object.assign(sim, m.sim); reply({ sim }); break;
        default:
      }
    }
  });
  const gone = () => {
    if (!me || users.get(me)?.sock !== sock) return;
    users.delete(me);
    for (const l of [...lobbies.values()]) leaveLobby(me, l.id, 'Disconnected');
    for (const [id, u] of users) if (u.accepted.has(me)) write(u.sock, { op: 'cb', kind: 'P2PSessionConnectFail', v: { remote: me, error: 3 } });
  };
  sock.on('close', gone);
  sock.on('error', gone);
});
server.listen(PORT, '127.0.0.1', () => console.log(`fake Steam on 127.0.0.1:${PORT} · latency ${sim.latency} ms ± ${sim.jitter} · loss ${sim.loss * 100} %`));
