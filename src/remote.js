// A combatant driven by the network: other players, and (on joined clients) the host's AI.
// It is drawn a little in the past (INTERP), between the two received states around that
// moment, so late or lost packets (online play) don't make it stutter. It keeps its hitbox and
// ghillie pose in sync, shows its scope glint, and makes footstep sounds (on the host it also
// emits the footstep and splash reveal events the AI listens for).
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Combatant, eyeHeightFor } from './entity.js';
import { Hitbox } from './hitbox.js';
import { GhillieCharacter } from './characters.js';
import { GlintSprite } from './effects.js';
import { lerp } from './noise.js';

export const STANCES = ['stand', 'crouch', 'prone'];

const INTERP = 0.1;    // s: drawn this far behind the newest state (room for late packets)
const EXTRAP = 0.2;    // s: at most this far past the newest state when packets are missing
const KEEP = 1.5;      // s of states kept
const now = () => performance.now() / 1000;

function wrap(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export class RemoteCombatant extends Combatant {
  constructor(game, { id, name, team, human, index, armband }) {
    super({ name, team });
    this.id = id;
    this.game = game;
    this.isRemote = true;
    this.human = human;
    this.hitbox = new Hitbox();
    this.character = new GhillieCharacter(game.scene, game.textures, { index, armbandColor: armband ? CONFIG.teams.colors[team] : null });
    this.glint = new GlintSprite(game.scene);
    this.bodyYaw = 0;
    this.aiming = false;
    this.aimTargetId = 0;
    this.net = null;          // latest received state
    this.buf = [];            // received states { t: sender's clock, s }, oldest first
    this.lastT = undefined;   // sender's clock of the newest state
    this.off = undefined;     // arrival minus sender time, lowest seen (travel time without delays)
    this.stepDist = 0;
    this._prev = new THREE.Vector3();
    this._s = { p: [0, 0, 0], y: 0, pi: 0, b: 0, sc: 0, st: 0 };
  }

  spawn(x, z, yaw) {
    const T = this.game.terrain;
    this.pos.set(x, T.heightAt(x, z), z);
    this._prev.copy(this.pos);
    this.yaw = yaw; this.bodyYaw = yaw; this.pitch = 0;
    this.alive = true;
    this.health = CONFIG.player.health;
    this.stance = 'stand';
    this.eye = eyeHeightFor('stand');
    this.scoped = false;
    this.net = null;
    this.buf.length = 0;
    this.lastT = undefined;
  }

  // s: { p:[x,y,z], y: yaw, pi: pitch, b: bodyYaw, st: stance index, sc: scopeT, sp: speed, al, hp, at: aim target id }
  // t: the sender's real clock (s) when it was sent
  applyState(s, t) {
    // a state from before a deathmatch respawn (it crossed the respawn message) is stale
    if ((s.li || 0) < (this.life || 0)) return;
    if (t !== undefined) {
      // out of order: older than one we have (a big jump back is a reset of the sender's clock)
      if (this.lastT !== undefined && t <= this.lastT && t > this.lastT - 2) return;
      if (this.lastT !== undefined && t <= this.lastT) this.buf.length = 0;
      this.lastT = t;
      const d = now() - t;
      this.off = this.off === undefined || d < this.off ? d : this.off + (d - this.off) * 0.02;
      this.buf.push({ t, s });
      while (this.buf.length > 2 && this.buf[1].t < t - KEEP) this.buf.shift();
    }
    const first = !this.net;
    this.net = s;
    if (first) {
      this.pos.set(s.p[0], s.p[1], s.p[2]);
      this.yaw = s.y; this.pitch = s.pi; this.bodyYaw = s.b;
    }
  }

  // The state to draw now: between the two received states around (now - INTERP), or a little
  // past the newest one if packets are late.
  sample() {
    const b = this.buf;
    const n = b.length;
    if (n < 2) return n ? b[0].s : this.net;
    const T = now() - this.off - INTERP;
    let a, c, f;
    if (T >= b[n - 1].t) {
      a = b[n - 2]; c = b[n - 1];
      f = 1 + Math.min(T - c.t, EXTRAP) / Math.max(0.001, c.t - a.t);
    } else if (T <= b[0].t) {
      return b[0].s;
    } else {
      let i = n - 1;
      while (i > 1 && b[i - 1].t > T) i--;
      a = b[i - 1]; c = b[i];
      f = (T - a.t) / Math.max(0.001, c.t - a.t);
    }
    const A = a.s, C = c.s, o = this._s;
    for (let k = 0; k < 3; k++) o.p[k] = A.p[k] + (C.p[k] - A.p[k]) * f;
    o.y = A.y + wrap(C.y - A.y) * f;
    o.b = A.b + wrap(C.b - A.b) * f;
    o.pi = A.pi + (C.pi - A.pi) * Math.min(f, 1);
    o.sc = A.sc + (C.sc - A.sc) * Math.min(f, 1);
    o.st = f < 0.5 ? A.st : C.st;
    return o;
  }

  update(dt, time) {
    const s = this.net;
    if (s) {
      const v = this.sample();
      // the sampled path is smooth; this only softens a correction when late packets arrive
      const k = 1 - Math.exp(-dt * 30);
      if (this.pos.distanceToSquared(_v.set(v.p[0], v.p[1], v.p[2])) > 100) this.pos.copy(_v);
      else this.pos.lerp(_v, k);
      this.yaw = wrap(this.yaw + wrap(v.y - this.yaw) * k);
      this.pitch = lerp(this.pitch, v.pi, k);
      this.bodyYaw = wrap(this.bodyYaw + wrap(v.b - this.bodyYaw) * k);
      this.stance = STANCES[v.st] || 'stand';
      this.scopeT = v.sc;
      this.scoped = v.sc > 0.55;
      this.aiming = this.scoped;
      this.aimTargetId = s.at || 0;
      // the network can only make someone alive again on a new round (spawn), not mid-round
      if (!s.al) this.alive = false;
      if (s.hp !== undefined) this.health = s.hp;
    }
    const moved = Math.hypot(this.pos.x - this._prev.x, this.pos.z - this._prev.z);
    this.speed = dt > 0 ? lerp(this.speed, moved / dt, 1 - Math.exp(-dt * 8)) : this.speed;
    this._prev.copy(this.pos);
    this.eye = lerp(this.eye, eyeHeightFor(this.stance), 1 - Math.exp(-dt * 6));
    if (this.alive) this.hitbox.update(this, this.game.terrain);
    this.character.update(dt, this, time, this.game.terrain);
    if (this.alive && moved > 0 && moved < 3) this._footsteps(moved, time);
  }

  _footsteps(moved, time) {
    const g = this.game;
    this.stepDist += moved;
    const sprint = this.speed > 5;
    const stride = sprint ? 1.9 : this.stance === 'prone' ? 0.9 : 1.3;
    if (this.stepDist < stride) return;
    this.stepDist = 0;
    const loud = sprint ? 1.0 : this.stance === 'prone' ? 0.2 : this.stance === 'crouch' ? 0.35 : 0.55;
    const wet = g.terrain.waterDepthAt(this.pos.x, this.pos.z) > 0.05;
    if (wet) g.audio.splash(this.pos, loud, false); else g.audio.footstep(this.pos, loud, g.surfaceAt(this.pos.x, this.pos.z), false);
    // the AI (host only) hears remote players move
    if (g.net && g.net.isHost && this.human) {
      g.bus.emit({ type: wet ? 'splash' : 'footstep', position: this.pos.clone(), time, sourceTeam: this.team, sourceId: this.id, loudness: loud });
    }
  }

  dispose() {
    this.character.dispose();
    this.game.scene.remove(this.glint.s);
  }
}

const _v = new THREE.Vector3();
