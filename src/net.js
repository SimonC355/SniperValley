// LAN multiplayer. One browser hosts: it runs the round flow, the AI, the zone timeline,
// the birds and kill decisions, and streams snapshots (20 Hz) to the others. Every browser
// moves its own player and detects its own hits ("favour the shooter", fine on a LAN), then
// tells the host, which confirms the kill to everyone. Messages go through the small relay
// in server/relay.mjs (ws://<server>/net).
import * as THREE from 'three';
import { CONFIG, MAP_ID } from './config.js';
import { STANCES } from './remote.js';

const SEND_INTERVAL = 0.05;   // 20 Hz
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

// ------------------------------------------------------------------ transport + lobby
export class NetSession {
  constructor() {
    this.ws = null;
    this.myId = 0;
    this.hostId = 0;
    this.hostMap = '';        // the map the host's game is built with
    this.players = [];
    this.inGame = false;
    this.available = false;
    this.joined = false;
    this.onLobby = null;
    this.onMessage = null;
    this.onHostGone = null;
    this.onLeft = null;
    this.onError = null;
    this.onAvailable = null;
  }

  get isHost() { return this.joined && this.myId === this.hostId; }

  connect() {
    let ws;
    try {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/net`);
    } catch { return; }
    this.ws = ws;
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'welcome') { this.myId = m.id; this.available = true; if (this.onAvailable) this.onAvailable(true); }
      else if (m.t === 'lobby') { this.hostId = m.hostId; this.hostMap = m.map || ''; this.players = m.players; this.inGame = m.inGame; if (this.onLobby) this.onLobby(); }
      else if (m.t === 'm') { if (this.onMessage) this.onMessage(m.from, m.d); }
      else if (m.t === 'left') { if (this.onLeft) this.onLeft(m.id); }
      else if (m.t === 'hostgone') { if (this.onHostGone) this.onHostGone(); }
      else if (m.t === 'error') { if (this.onError) this.onError(m.msg); }
    };
    ws.onclose = () => {
      const was = this.available;
      this.available = false;
      if (was && this.onAvailable) this.onAvailable(false);
      if (this.joined && this.onHostGone) this.onHostGone();
      this.joined = false;
    };
  }

  _raw(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  hello(name, team, host) { this.joined = true; this._raw({ t: 'hello', name, team, host, map: MAP_ID }); }
  setTeam(team) { this._raw({ t: 'team', team }); }
  setInGame(v) { this._raw({ t: 'ingame', v }); }
  toHost(d) { this._raw({ t: 'm', to: 'host', d }); }
  toAll(d) { this._raw({ t: 'm', to: 'all', d }); }
  toPeer(id, d) { this._raw({ t: 'm', to: id, d }); }
}

// ------------------------------------------------------------------ game sync
export class LanGame {
  constructor(game, session) {
    this.game = game;
    this.s = session;
    this.sendT = 0;
    this.slowT = 0;
    this.lastBirds = '';
    this.teamOf = new Map();     // peer id -> team (kept for the whole match)
    session.onMessage = (from, d) => this.onMessage(from, d);
    session.onLeft = (id) => this.onLeft(id);
  }

  get isHost() { return this.s.isHost; }
  get myPeer() { return this.s.myId; }

  // ---------------------------------------------------------------- host: rounds
  // Team assignment: chosen team, otherwise the smaller team. Kept for the match.
  assignTeams() {
    const counts = [0, 0];
    const players = this.s.players;
    for (const p of players) if (this.teamOf.has(p.id)) counts[this.teamOf.get(p.id)]++;
    for (const p of players) {
      if (this.teamOf.has(p.id)) continue;
      let t = p.team === '0' ? 0 : p.team === '1' ? 1 : -1;
      if (t < 0) t = counts[0] <= counts[1] ? 0 : 1;
      this.teamOf.set(p.id, t);
      counts[t]++;
    }
    for (const id of [...this.teamOf.keys()]) if (!players.find((p) => p.id === id)) this.teamOf.delete(id);
  }

  // Build the roster for a new round (humans + AI fill) with spawn points.
  buildRoster() {
    const g = this.game;
    this.assignTeams();
    const humans = [[], []];
    for (const p of this.s.players) humans[this.teamOf.get(p.id)].push(p);
    const fill = CONFIG.lan.fillWithAI;
    const n = Math.max(fill ? CONFIG.teams.size : 0, humans[0].length, humans[1].length);
    const roster = [];
    let id = 1;
    for (let t = 0; t < 2; t++) {
      const count = fill ? n : humans[t].length;
      const spawns = g.teamSpawns(t, Math.max(1, count));
      const yaw = g.sideOf(t) === 0 ? 0 : Math.PI;
      for (let i = 0; i < count; i++) {
        const h = humans[t][i];
        const sp = spawns[i];
        roster.push(h
          ? { id: id++, kind: 'h', peer: h.id, name: h.name, team: t, x: r2(sp.x), z: r2(sp.z), yaw }
          : { id: id++, kind: 'a', name: `${CONFIG.teams.names[t]}-${i + 1}`, team: t, x: r2(sp.x), z: r2(sp.z), yaw });
      }
    }
    return roster;
  }

  settings() {
    return {
      zone: CONFIG.zone.mode, camo: CONFIG.camouflageStrength, ball: CONFIG.weapon.ballistics.enabled,
      tracers: CONFIG.weapon.tracers, rounds: CONFIG.match.roundsToWin, swap: CONFIG.match.swapSides, size: CONFIG.teams.size, map: MAP_ID,
    };
  }

  hostRound() {
    const g = this.game;
    const msg = { k: 'round', round: g.match.round, score: g.match.score.slice(), settings: this.settings(), roster: this.buildRoster() };
    this.s.toAll(msg);
    this.s.setInGame(true);
    return msg;
  }

  // ---------------------------------------------------------------- per frame
  tick(dt) {
    const g = this.game;
    if (g.state !== 'playing' && g.state !== 'ended') return;
    this.sendT -= dt;
    this.slowT -= dt;
    if (this.sendT > 0) return;
    this.sendT = SEND_INTERVAL;
    if (this.isHost) {
      const e = [];
      for (const c of g.combatants) {
        if (c.isDummy) continue;
        e.push(this.encode(c));
      }
      const snap = { k: 'snap', time: r3(g.time), e };
      if (this.slowT <= 0) {
        this.slowT = 1;
        snap.zone = g.zone.getState();
      }
      const birds = JSON.stringify(g.birds.getState());
      if (birds !== this.lastBirds || snap.zone) { snap.birds = JSON.parse(birds); this.lastBirds = birds; }
      this.s.toAll(snap);
    } else if (g.player && g.roundId === this.roundId) {
      this.s.toHost({ k: 'st', s: this.encode(g.player) });
    }
  }

  encode(c) {
    const ai = c.ai;
    const at = ai && (ai.state === 'aim' || ai.state === 'fire') && ai.target ? ai.target.id : 0;
    return [c.id, r2(c.pos.x), r2(c.pos.y), r2(c.pos.z), r3(c.yaw), r3(c.pitch), r3(c.bodyYaw ?? c.yaw),
      Math.max(0, STANCES.indexOf(c.stance)), r2(c.scopeT || 0), r2(c.speed || 0), c.alive ? 1 : 0, Math.round(c.health), at];
  }

  decode(a) {
    return { id: a[0], p: [a[1], a[2], a[3]], y: a[4], pi: a[5], b: a[6], st: a[7], sc: a[8], sp: a[9], al: a[10], hp: a[11], at: a[12] };
  }

  // ---------------------------------------------------------------- outgoing events
  // A shot we simulated (our player, or on the host any AI): others replay it visually.
  sendFire(shooter, origin, dir, time) {
    const m = { k: 'fire', s: shooter.id, o: [r3(origin.x), r3(origin.y), r3(origin.z)], d: [r3(dir.x), r3(dir.y), r3(dir.z)], t: r3(time) };
    if (this.isHost) this.s.toAll(m); else this.s.toHost(m);
  }

  // Client: our bullet hit someone; the host decides.
  sendClaim(shooter, victim, part, point, dist) {
    this.s.toHost({ k: 'claim', s: shooter.id, v: victim.id, part, d: r2(dist), p: [r2(point.x), r2(point.y), r2(point.z)] });
  }

  // Host: a kill happened (bullet, zone or a player leaving).
  broadcastKill(shooter, victim, dist, part, point, cause) {
    // how an AI shooter found the victim (for the victim's killcam)
    const reason = shooter && shooter.ai ? shooter.ai.reasons.get(victim.id) || null : null;
    this.s.toAll({ k: 'kill', s: shooter ? shooter.id : 0, v: victim.id, d: r2(dist || 0), part, p: point ? [r2(point.x), r2(point.y), r2(point.z)] : null, cause, r: reason });
  }

  sendDied(victim) { this.s.toHost({ k: 'died', v: victim.id }); }

  broadcastRoundEnd(winner) {
    const g = this.game;
    this.s.toAll({ k: 'roundEnd', winner, score: g.match.score.slice(), next: r3(g.nextRoundAt ?? 0), over: g.match.over });
  }

  // ---------------------------------------------------------------- incoming
  byId(id) { return this.game.combatants.find((c) => c.id === id) || null; }

  onMessage(from, d) {
    const g = this.game;
    // the host switched maps: load it too and rejoin
    if (d.k === 'mapchange') {
      if (!this.isHost && from === this.s.hostId) g.followHostMap(d.map);
      return;
    }
    // a joined client ignores game traffic until the host has put it into a round
    if (!this.isHost && d.k !== 'round' && (!this.roundId || g.roundId !== this.roundId)) return;
    switch (d.k) {
      case 'round':
        if (this.isHost) return;
        this.roundId = (this.roundId || 0) + 1;
        g.applyRound(d, this.roundId);
        break;
      case 'snap': {
        if (this.isHost) return;
        // time sync (host clock)
        const err = d.time - g.time;
        if (Math.abs(err) > 0.5) g.time = d.time; else g.time += err * 0.1;
        for (const a of d.e) {
          if (a[0] === g.player.id) continue;
          const c = this.byId(a[0]);
          if (c && c.applyState) c.applyState(this.decode(a));
        }
        if (d.zone) g.zone.setState(d.zone);
        if (d.birds) g.birds.applyState(d.birds, g.time);
        break;
      }
      case 'st': {
        if (!this.isHost) return;
        const st = this.decode(d.s);
        const c = this.byId(st.id);
        if (c && c.applyState && c.peer === from) c.applyState(st);
        break;
      }
      case 'fire': {
        const shooter = this.byId(d.s);
        if (!shooter || shooter === g.player) return;
        if (this.isHost && shooter.peer !== from) return;
        const origin = new THREE.Vector3(d.o[0], d.o[1], d.o[2]);
        const dir = new THREE.Vector3(d.d[0], d.d[1], d.d[2]).normalize();
        g.combat.fire(shooter, dir, g.time, { visual: true, origin });
        if (this.isHost) this.s.toAll(d);   // replay for the other clients (the shooter ignores its own)
        break;
      }
      case 'claim': {
        if (!this.isHost) return;
        const shooter = this.byId(d.s), victim = this.byId(d.v);
        if (!shooter || !victim || !victim.alive || shooter.peer !== from) return;
        g.combat._hit(shooter, victim, d.part, new THREE.Vector3(d.p[0], d.p[1], d.p[2]), d.d, g.time);
        break;
      }
      case 'died': {
        if (!this.isHost) return;
        const victim = this.byId(d.v);
        if (!victim || !victim.alive || victim.peer !== from) return;
        g.applyZoneDeath(victim);
        break;
      }
      case 'kill':
        if (this.isHost) return;
        g.applyKillMessage(d);
        break;
      case 'roundEnd':
        if (this.isHost) return;
        g.applyRoundEnd(d);
        break;
      default:
    }
  }

  onLeft(peerId) {
    const g = this.game;
    if (!this.isHost) return;
    const c = g.combatants.find((x) => x.peer === peerId);
    if (c && c.alive) {
      c.alive = false;
      c.health = 0;
      g.hud.killFeed(`<span class="${c.team === g.player.team ? 'f' : 'e'}">${c.name}</span> LEFT THE GAME`);
      this.broadcastKill(null, c, 0, null, null, 'left');
    }
  }
}
