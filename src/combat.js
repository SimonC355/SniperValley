// Shooting: bolt-action fire, hitscan (default) or simulated projectiles (optional travel
// time, drop and wind), hit resolution against body hitboxes, impacts, tracers, near-miss
// cracks and reveal events (shot sound + muzzle flash).
import * as THREE from 'three';
import { CONFIG } from './config.js';

const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3(), _v = new THREE.Vector3();

export class Combat {
  constructor({ world, terrain, effects, audio, bus }) {
    this.world = world;
    this.terrain = terrain;
    this.effects = effects;
    this.audio = audio;
    this.bus = bus;
    this.combatants = [];
    this.projectiles = [];
    this.onKill = null;       // (shooter, victim, distance, part)
    this.onShot = null;       // (shooter)
    this.listener = null;     // the player combatant (for near-miss cracks)
  }

  setCombatants(list) { this.combatants = list; }

  canFire(shooter, time) { return shooter.alive && time >= shooter.boltReadyTime; }

  // dir must be normalised. Returns true if a shot was fired.
  fire(shooter, dir, time) {
    if (!this.canFire(shooter, time)) return false;
    const W = CONFIG.weapon;
    shooter.boltReadyTime = time + W.boltTime;
    shooter.lastShotTime = time;
    shooter.shotsFired++;
    const origin = shooter.eyePos(new THREE.Vector3());
    const muzzle = shooter.muzzlePos(new THREE.Vector3());
    // reveal: muzzle flash (visual) + shot (sound)
    if (!shooter.isPlayer) this.effects.muzzleFlash(muzzle);
    else { this.effects.light.position.copy(muzzle); this.effects.light.intensity = 250; this.effects.lightT = 0.06; }
    this.audio.shot(muzzle, shooter.isPlayer);
    const base = { position: muzzle.clone(), time, sourceTeam: shooter.team, sourceId: shooter.id };
    this.bus.emit({ type: 'flash', ...base });
    this.bus.emit({ type: 'shot', ...base, loudness: 1 });
    if (this.onShot) this.onShot(shooter);
    if (W.ballistics.enabled) {
      this.projectiles.push({
        shooter, pos: origin.clone(), vel: dir.clone().multiplyScalar(W.ballistics.muzzleVelocity),
        start: muzzle.clone(), origin: origin.clone(), age: 0, travelled: 0, nearMissDone: false,
      });
    } else {
      this._trace(shooter, origin, dir, W.range, muzzle, time, 0, {});
    }
    return true;
  }

  // Cast a straight segment. Returns true if it hit something.
  _trace(shooter, origin, dir, maxDist, tracerFrom, time, travelledBefore, ctx) {
    const worldHit = this.world.raycast(origin, dir, maxDist);
    let tWorld = worldHit ? worldHit.t : maxDist;
    let kind = worldHit ? worldHit.kind : null;
    // water surface
    const wl = CONFIG.map.waterLevel;
    if (dir.y < -1e-4 && origin.y > wl) {
      const tw = (origin.y - wl) / -dir.y;
      if (tw < tWorld) {
        _p.copy(origin).addScaledVector(dir, tw);
        if (this.terrain.heightAt(_p.x, _p.z) < wl) { tWorld = tw; kind = 'water'; }
      }
    }
    let best = null;
    for (const c of this.combatants) {
      if (c === shooter || !c.alive || !c.hitbox) continue;
      const h = c.hitbox.raycast(origin, dir, tWorld);
      if (h && (!best || h.t < best.t)) best = { c, t: h.t, part: h.part };
    }
    const endT = best ? best.t : tWorld;
    const end = new THREE.Vector3().copy(origin).addScaledVector(dir, endT);
    // near-miss crack for the listening player
    const L = this.listener;
    if (L && L.alive && L !== shooter && (!best || best.c !== L) && !ctx.nearMissDone) {
      const head = L.eyePos(_o);
      const t = Math.max(0, Math.min(endT, _v.subVectors(head, origin).dot(dir)));
      const closest = _p.copy(origin).addScaledVector(dir, t);
      const miss = closest.distanceTo(head);
      if (miss < 5 && travelledBefore + t > 8) {
        ctx.nearMissDone = true;
        this.audio.crack(closest);
        if (this.onNearMiss) this.onNearMiss(shooter, miss);
      }
    }
    if (tracerFrom) this.effects.tracer(tracerFrom, end);
    if (best) {
      this._hit(shooter, best.c, best.part, end, travelledBefore + best.t, time);
      return true;
    }
    if (kind) {
      const k = kind === 'terrain' ? (this.terrain.canopyAt(end.x, end.z) > 0.5 ? 'forest' : 'ground') : kind;
      this.effects.impact(end, k === 'forest' ? 'ground' : k);
      this.audio.impact(end, k);
      this.bus.emit({ type: 'impact', position: end.clone(), time, sourceTeam: shooter.team, sourceId: shooter.id, kind: k });
      return true;
    }
    return false;
  }

  _hit(shooter, victim, part, point, dist, time) {
    victim.alive = false;
    victim.health = 0;
    victim.killedBy = shooter;
    victim.deathTime = time;
    shooter.hits++;
    shooter.kills++;
    shooter.longestHit = Math.max(shooter.longestHit, dist);
    if (!victim.isPlayer) this.effects.impact(point, 'body');
    this.audio.impact(point, 'ground');
    this.bus.emit({ type: 'impact', position: point.clone(), time, sourceTeam: shooter.team, sourceId: shooter.id, kind: 'body' });
    if (this.onKill) this.onKill(shooter, victim, dist, part);
  }

  update(dt, time) {
    if (!this.projectiles.length) return;
    const B = CONFIG.weapon.ballistics;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      let remaining = dt;
      let done = false;
      while (remaining > 1e-6 && !done) {
        const h = Math.min(remaining, 1 / 60);
        remaining -= h;
        const prev = pr.pos.clone();
        pr.vel.y -= B.gravity * h;
        pr.vel.x += B.wind.x * 0.9 * h;
        pr.vel.z += B.wind.z * 0.9 * h;
        pr.vel.multiplyScalar(1 - 0.12 * h);
        pr.pos.addScaledVector(pr.vel, h);
        const seg = _d.subVectors(pr.pos, prev);
        const len = seg.length();
        if (len < 1e-6) continue;
        const dir = seg.clone().divideScalar(len);
        if (this._trace(pr.shooter, prev, dir, len, null, time, pr.travelled, pr)) {
          // show the whole flight path as a tracer on impact
          this.effects.tracer(pr.start, prev.clone().addScaledVector(dir, len * 0.5));
          done = true;
        }
        pr.travelled += len;
      }
      pr.age += dt;
      if (done || pr.age > 3 || pr.pos.y < -50) this.projectiles.splice(i, 1);
    }
  }
}
