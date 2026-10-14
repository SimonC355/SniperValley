// A combatant driven by the network: other players, and (on joined clients) the host's AI.
// It smooths toward the latest received state, keeps its hitbox and ghillie pose in sync,
// shows its scope glint, and makes footstep sounds (on the host it also emits the footstep
// and splash reveal events the AI listens for).
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Combatant, eyeHeightFor } from './entity.js';
import { Hitbox } from './hitbox.js';
import { GhillieCharacter } from './characters.js';
import { GlintSprite } from './effects.js';
import { lerp } from './noise.js';

export const STANCES = ['stand', 'crouch', 'prone'];

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
    this.stepDist = 0;
    this._prev = new THREE.Vector3();
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
  }

  // s: { p:[x,y,z], y: yaw, pi: pitch, b: bodyYaw, st: stance index, sc: scopeT, sp: speed, al, hp, at: aim target id }
  applyState(s) {
    // a state from before a deathmatch respawn (it crossed the respawn message) is stale
    if ((s.li || 0) < (this.life || 0)) return;
    const first = !this.net;
    this.net = s;
    if (first) {
      this.pos.set(s.p[0], s.p[1], s.p[2]);
      this.yaw = s.y; this.pitch = s.pi; this.bodyYaw = s.b;
    }
  }

  update(dt, time) {
    const s = this.net;
    if (s) {
      const k = 1 - Math.exp(-dt * 14);
      if (this.pos.distanceToSquared(_v.set(s.p[0], s.p[1], s.p[2])) > 100) this.pos.copy(_v);
      else this.pos.lerp(_v, k);
      this.yaw = wrap(this.yaw + wrap(s.y - this.yaw) * k);
      this.pitch = lerp(this.pitch, s.pi, k);
      this.bodyYaw = wrap(this.bodyYaw + wrap(s.b - this.bodyYaw) * k);
      this.stance = STANCES[s.st] || 'stand';
      this.scopeT = s.sc;
      this.scoped = s.sc > 0.55;
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
