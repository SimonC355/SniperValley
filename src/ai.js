// AI snipers (enemies and teammates share this code and the player's reveal rules).
// State machine: idle -> scan -> investigate -> aim -> fire -> cool, plus move (relocating).
// Perception never sees through camouflage: targets are acquired via reveal events (glint,
// muzzle flash, shot sounds, birds, splashes, footsteps) that trigger "investigate", or via
// close-range visual spotting scaled by camouflageStrength, target movement and stance.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Combatant, eyeHeightFor, angleBetween } from './entity.js';
import { Hitbox } from './hitbox.js';
import { GhillieCharacter } from './characters.js';
import { GlintSprite } from './effects.js';
import { Combat } from './combat.js';
import { cloudCoverAt } from './weather.js';
import { RNG, clamp, lerp } from './noise.js';

const DEG = Math.PI / 180;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// How directly `shooter`'s scope points at point `p` (0..1, geometry only).
export function glintAim(shooter, p) {
  if (!shooter.alive || !shooter.scoped) return 0;
  const s = shooter.scopePos(_a);
  const dir = _b.subVectors(p, s).normalize();
  const aim = shooter.aimDir(_c);
  const ang = angleBetween(aim, dir) / DEG;
  const G = CONFIG.reveal.glintAngle;
  if (ang >= G) return 0;
  const t = 1 - ang / G;
  return t * t * (3 - 2 * t);
}

// Glint intensity (0..1) that `shooter` shows toward point `p`: the aim, dimmed under a cloud.
export function glintToward(shooter, p) {
  const g = glintAim(shooter, p);
  return g > 0 ? g * glintSun(shooter.scopePos(_a)) : 0;
}

// A glint is sunlight off the lens: under a cloud it is weaker (about a third).
export function glintSun(p) {
  return 0.35 + 0.65 * (1 - cloudCoverAt(p.x, p.y, p.z));
}

// ---------------------------------------------------------------------------- spots

export class SpotMap {
  constructor(world, terrain, seed) {
    this.world = world;
    this.terrain = terrain;
    const rng = new RNG(seed + 401);
    this.spots = [[], []];   // per side: 0 = north slope (+Z), 1 = south slope (-Z)
    const T = terrain;
    const M = CONFIG.map;
    // map scale across (ridge distance) and along the valley (length), 1 on the valley map
    const ks = M.ridgeDist / 178, kx = M.length / 440;
    const dzMin = M.riverShelfEnd + 13, dzMax = M.ridgeDist - 6;
    for (let team = 0; team < 2; team++) {
      const side = team === 0 ? 1 : -1;
      const cands = [];
      for (let k = 0; k < 240; k++) {
        const x = rng.float(-T.halfX + 10, T.halfX - 10);
        const dz = rng.float(dzMin, dzMax);
        const z = T.riverCenter(x) + side * dz;
        if (Math.abs(z) > T.halfZ - 5) continue;
        if (T.waterDepthAt(x, z) > 0) continue;
        const n = T.normalAt(x, z);
        if (n.y < 0.84) continue;
        if (world.query(x, z, 1.1, ['tree', 'rock', 'log', 'stump']).length) continue;
        const h = T.heightAt(x, z);
        const eye = new THREE.Vector3(x, h + 0.55, z);
        let vis = 0;
        for (let s = 0; s < 6; s++) {
          const tx = x + (s - 2.5) * 50 * kx;
          const tz = T.riverCenter(tx) - side * (35 + (s % 3) * 45) * ks;
          const tp = new THREE.Vector3(tx, T.heightAt(tx, tz) + 1.0, tz);
          if (world.lineOfSight(eye, tp)) vis++;
        }
        if (vis === 0) continue;
        const cover = Math.min(1, world.query(x, z, 3, ['tree', 'rock', 'bush', 'log', 'stump']).length * 0.3);
        const height = dz / dzMax;
        const canopy = T.canopyAt(x, z);
        cands.push({
          x, z, team, view: vis / 6, cover, height,
          score: (vis / 6) * 0.55 + cover * 0.25 + height * 0.2,
          stance: canopy < 0.45 && n.y > 0.93 ? 'prone' : 'crouch',
        });
      }
      cands.sort((a, b) => b.score - a.score);
      const kept = [];
      for (const c of cands) {
        if (kept.every((k) => (k.x - c.x) ** 2 + (k.z - c.z) ** 2 > 100)) kept.push(c);
        if (kept.length >= 90) break;
      }
      this.spots[team] = kept;
    }
  }

  // The spot at (x, z) on a side, if there is one within maxD metres.
  nearest(side, x, z, maxD = 3) {
    let best = null, bd = maxD * maxD;
    for (const s of this.spots[side]) {
      const d = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  // Pick a spot on a side (0 north, 1 south) near `from`. zoneFn(x,z) -> true if acceptable.
  choose(team, from, { minDist = 0, maxDist = 80, avoid = [], spacing = CONFIG.ai.spotSpacing, zoneFn = null, rng = Math.random } = {}) {
    let best = null, bestS = -1e9;
    for (const s of this.spots[team]) {
      const d = Math.hypot(s.x - from.x, s.z - from.z);
      if (d < minDist) continue;
      if (zoneFn && !zoneFn(s.x, s.z)) continue;
      let pen = 0;
      for (const a of avoid) {
        const da = Math.hypot(s.x - a.x, s.z - a.z);
        if (da < spacing) pen += (spacing - da) / spacing;
      }
      const far = d > maxDist ? (d - maxDist) / 40 : 0;
      const sc = s.score - pen * 0.8 - far - d * 0.002 + rng() * 0.12;
      if (sc > bestS) { bestS = sc; best = s; }
    }
    return best;
  }
}

// ---------------------------------------------------------------------------- AI combatant

export class AICombatant extends Combatant {
  constructor(game, { name, team, index, armband }) {
    super({ name, team });
    this.game = game;
    this.hitbox = new Hitbox();
    this.character = new GhillieCharacter(game.scene, game.textures, { index, armbandColor: armband ? CONFIG.teams.colors[team] : null });
    this.glint = new GlintSprite(game.scene);
    this.aiming = false;
    this.bodyYaw = 0;
    this.ai = new AIBrain(this, game, index);
  }

  spawn(x, z, yaw) {
    const T = this.game.terrain;
    this.pos.set(x, T.heightAt(x, z), z);
    this.yaw = yaw;
    this.bodyYaw = yaw;
    this.pitch = 0;
    this.alive = true;
    this.health = CONFIG.player.health;
    this.stance = 'stand';
    this.eye = eyeHeightFor('stand');
    this.scoped = false;
    this.boltReadyTime = 0;
    this.ai.reset();
    // spawned on a sniper spot: settle into it (kneeling or prone) instead of walking off in
    // the open, so a round doesn't start with everyone visible on the move
    const g = this.game;
    const sp = g.spots && g.spots.nearest(g.sideOf(this.team), x, z, 3);
    if (sp) {
      this.ai.spot = sp;
      this.stance = sp.stance;
      this.eye = eyeHeightFor(sp.stance);
    }
  }

  update(dt, time) {
    const g = this.game;
    // frozen: test hook; frozenByRound: freeze time at round start
    if (this.alive && !this.frozen && !this.frozenByRound) this.ai.update(dt, time);
    this.eye = lerp(this.eye, eyeHeightFor(this.stance), 1 - Math.exp(-dt * 6));
    if (this.alive) this.hitbox.update(this, g.terrain);
    this.character.update(dt, this, time, g.terrain);
  }

  dispose() {
    this.character.dispose();
    this.game.scene.remove(this.glint.s);
  }
}

// ---------------------------------------------------------------------------- brain

class AIBrain {
  constructor(cb, game, index) {
    this.cb = cb;
    this.game = game;
    this.rng = new RNG(9000 + index * 31 + cb.team * 7);
    this.reset();
  }

  reset() {
    this.state = 'idle';
    this.stateT = 0;
    this.thinkT = this.rng.float(0, CONFIG.ai.thinkInterval);
    this.awareness = new Map();
    this.reasons = new Map();
    this.invCue = null;
    this.glintTime = new Map();
    this.glintEmitT = new Map();
    this.queue = [];
    this.target = null;
    this.lastSeenPos = null;
    this.lastSeenTime = -99;
    this.lostT = 0;
    this.invPos = null;
    this.invUntil = 0;
    this.invStrength = 0;
    this.spot = null;
    this.moveTarget = null;
    this.moveSpeed = CONFIG.ai.moveSpeed;
    this.desiredYaw = this.cb.yaw;
    this.desiredPitch = 0;
    this.scanUntil = 0;
    this.scanScoped = false;
    this.scanTarget = null;
    this.aimProgress = 0;
    this.aimDuration = 1;
    this.aimErr0 = new THREE.Vector2();
    this.duel = false;
    this.followUp = false;
    this.relocateAt = 30 + this.rng.float(0, 25);
    this.pendingInvestigate = null;
    this.stuckT = 0;
    this.lastPos = new THREE.Vector3();
    this.detour = null;
    this.underFireUntil = 0;
    this.stepDist = 0;
    this.lastShotTarget = null;
    // after spawning, a sniper first settles into the hide: no scanning through the scope (no
    // glint) for a few seconds, staggered, so big teams don't all light up at once
    this.settleUntil = (this.game.time || 0) + this.rng.float(5, 13);
  }

  setState(s, time) {
    if (s !== this.state) {
      this.state = s;
      this.stateT = 0;
      if (s === 'aim') { this.aimProgress = 0; }
    }
  }

  get zone() { return this.game.zone || null; }

  inZone(x, z, next = true) {
    const zn = this.zone;
    if (!zn) return true;
    return zn.contains(x, z, 6, next);
  }

  // ------------------------------------------------------------------ perception (events)
  onEvent(ev) {
    const cb = this.cb;
    if (!cb.alive || ev.sourceTeam === cb.team) return;
    const eye = cb.eyePos(_a);
    const d = eye.distanceTo(ev.position);
    const R = CONFIG.reveal;
    const delay = d / R.soundSpeed;
    const react = this.rng.float(CONFIG.ai.reactionTime[0], CONFIG.ai.reactionTime[1]);
    switch (ev.type) {
      case 'flash': {
        if (d > R.flashRange) return;
        const fwd = cb.aimDir(_b);
        const dir = _c.subVectors(ev.position, eye).normalize();
        if (angleBetween(fwd, dir) > 100 * DEG) return;
        if (!this.game.world.lineOfSight(eye, ev.position)) return;
        this.queue.push({ at: ev.time + react, kind: 'flash', pos: ev.position.clone(), strength: 1, cue: 'flash', sourceId: ev.sourceId });
        break;
      }
      case 'shot': {
        if (d > R.shotHearingRange) return;
        // bearing + distance error
        const be = this.rng.float(-1, 1) * CONFIG.ai.hearingBearingError * DEG * (0.5 + d / 400);
        const de = 1 + this.rng.float(-1, 1) * CONFIG.ai.hearingDistanceError;
        const dx = ev.position.x - eye.x, dz = ev.position.z - eye.z;
        const ang = Math.atan2(dz, dx) + be;
        const hd = Math.hypot(dx, dz) * de;
        const est = new THREE.Vector3(eye.x + Math.cos(ang) * hd, 0, eye.z + Math.sin(ang) * hd);
        est.y = this.game.terrain.heightAt(est.x, est.z) + 1;
        this.queue.push({ at: ev.time + delay + react, kind: 'sound', pos: est, strength: 0.55, cue: 'shot', sourceId: ev.sourceId });
        break;
      }
      case 'birds': {
        if (d > 380) return;
        this.queue.push({ at: ev.time + Math.min(delay, 0.4) + react, kind: 'birds', pos: ev.position.clone(), strength: 0.4, cue: 'birds', sourceId: ev.sourceId });
        break;
      }
      case 'splash': {
        if (d > R.splashHearingRange) return;
        const est = ev.position.clone().add(new THREE.Vector3(this.rng.float(-6, 6), 0, this.rng.float(-6, 6)));
        this.queue.push({ at: ev.time + delay + react, kind: 'sound', pos: est, strength: 0.5, cue: 'splash', sourceId: ev.sourceId });
        break;
      }
      case 'footstep': {
        if (d > R.footstepHearingRange * (ev.loudness || 0.5)) return;
        const est = ev.position.clone().add(new THREE.Vector3(this.rng.float(-3, 3), 0, this.rng.float(-3, 3)));
        this.queue.push({ at: ev.time + delay + react, kind: 'sound', pos: est, strength: 0.6, cue: 'footstep', sourceId: ev.sourceId });
        break;
      }
      case 'impact': {
        if (d < 7 && ev.kind !== 'body') this.underFireUntil = ev.time + 4;
        break;
      }
      default:
    }
  }

  // info: { cue, sourceId } — what drew attention here (kept for the victim's killcam)
  investigate(pos, strength, time, info = null) {
    // keep engaging a visible target rather than chasing weaker cues
    if ((this.state === 'aim' || this.state === 'fire' || this.state === 'cool') && this.target && this.target.alive && time - this.lastSeenTime < 1.0 && strength < 0.9) return;
    if (this.state === 'move' && strength < 0.5 && this.moveUrgent) return;
    if (this.invPos && time < this.invUntil && strength < this.invStrength - 0.2) return;
    const [a, b] = CONFIG.ai.investigateTime;
    this.invPos = pos.clone();
    this.invCue = info;
    this.invStrength = strength;
    this.invUntil = time + this.rng.float(a, b) * (0.7 + strength * 0.6);
    if (this.state === 'move') { this.moveTarget = null; this.cb.stance = 'crouch'; }
    if (this.state !== 'aim' || !this.target || !this.target.alive) this.setState('investigate', time);
  }

  // ------------------------------------------------------------------ main update
  update(dt, time) {
    const cb = this.cb;
    this.stateT += dt;
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      const ti = CONFIG.ai.thinkInterval;
      this.think(time, ti - this.thinkT);
      this.thinkT += ti;
    }
    // speed is set while walking; any other state stands still (the walk cycle, footstep
    // reveals and spotting all read it)
    if (this.state !== 'move') cb.speed = 0;
    switch (this.state) {
      case 'idle': this.doIdle(dt, time); break;
      case 'scan': this.doScan(dt, time); break;
      case 'investigate': this.doInvestigate(dt, time); break;
      case 'aim': this.doAim(dt, time); break;
      case 'fire': this.doFire(dt, time); break;
      case 'cool': this.doCool(dt, time); break;
      case 'move': this.doMove(dt, time); break;
      default:
    }
    // turning
    const scoped = cb.scoped;
    const rate = (scoped ? CONFIG.ai.scopedTurnSpeed : CONFIG.ai.turnSpeed) * dt;
    const dy = wrapAngle(this.desiredYaw - cb.yaw);
    cb.yaw = wrapAngle(cb.yaw + clamp(dy, -rate, rate));
    const dp = this.desiredPitch - cb.pitch;
    cb.pitch += clamp(dp, -rate, rate);
    // body follows aim (prone turns slower)
    const bodyRate = (cb.stance === 'prone' ? 1.2 : 4) * dt;
    const db = wrapAngle(cb.yaw - cb.bodyYaw);
    if (cb.stance !== 'prone' || Math.abs(db) > 0.5 || cb.speed > 0.1) cb.bodyYaw = wrapAngle(cb.bodyYaw + clamp(db, -bodyRate, bodyRate));
    cb.aiming = cb.scoped;
    cb.scopeT = cb.scoped ? 1 : 0;
    // keep feet on the ground
    cb.pos.y = this.game.terrain.heightAt(cb.pos.x, cb.pos.z);
    // emit sustained glint events toward enemies
    if (cb.scoped) this._glintEvents(dt, time);
  }

  // ------------------------------------------------------------------ think (perception)
  think(time, dtThink) {
    const cb = this.cb;
    const g = this.game;
    const AI = CONFIG.ai;
    // deliver delayed perceptions
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      if (q.at > time) continue;
      this.queue.splice(i, 1);
      const info = { cue: q.cue || q.kind, sourceId: q.sourceId };
      if (q.kind === 'flash') {
        this.investigate(q.pos, 1.0, time, info);
        const src = g.combatants.find((c) => c.id === q.sourceId);
        if (src && src.alive) this.awareness.set(src.id, Math.max(this.awareness.get(src.id) || 0, 0.6));
      } else {
        this.investigate(q.pos, q.strength, time, info);
      }
    }
    // visual spotting and glints
    const eye = cb.eyePos(new THREE.Vector3());
    const fwd = cb.aimDir(new THREE.Vector3());
    const camo = CONFIG.camouflageStrength;
    let bestT = null, bestAw = 0;
    for (const e of g.combatants) {
      if (e.team === cb.team || !e.alive) continue;
      const tp = e.stance === 'prone' ? e.eyePos(_d) : e.centerPos(_d);
      const toT = _c.subVectors(tp, eye);
      const d = toT.length();
      const dir = toT.divideScalar(d);
      let aw = this.awareness.get(e.id) || 0;
      let seen = false;
      const nearInv = this.invPos && time < this.invUntil && tp.distanceTo(this.invPos) < AI.investigateRadius;
      const stanceMul = e.stance === 'prone' ? 0.5 : e.stance === 'crouch' ? 0.75 : 1;
      const moving = e.speed > 0.4;
      const range = (cb.scoped ? AI.visualRangeScoped : AI.visualRangeHip) * (nearInv ? 2.2 : 1) * stanceMul * (moving ? 1.3 : 1);
      const fovHalf = (cb.scoped ? AI.fovScoped : AI.fovHip) * 0.5 * DEG;
      const ang = angleBetween(fwd, dir);
      if (d < range && ang < fovHalf) {
        let vis = g.world.visibility(eye, tp);
        if (vis === 0 && e.stance !== 'prone') vis = g.world.visibility(eye, e.eyePos(_b)) * 0.6;
        if (vis > 0) {
          const moveF = clamp(e.speed / 4, 0, 1);
          const conspic = 1 - camo * (1 - 0.35 * moveF);
          const f = Math.pow(1 - d / range, 0.7);
          const rate = 1.8 * conspic * f * vis * (nearInv ? AI.investigateBonus : 1) * (cb.scoped ? 1.3 : 1);
          aw += rate * dtThink;
          seen = true;
          if (aw > 0.5) { this.lastSeenPos = tp.clone(); this.lastSeenTime = time; }
        }
      }
      // a scope glinting at me gives the shooter away
      const gi = glintToward(e, eye);
      if (gi > 0.05 && g.world.lineOfSight(eye, e.scopePos(_b))) {
        const gt = (this.glintTime.get(e.id) || 0) + dtThink;
        this.glintTime.set(e.id, gt);
        aw += gi * 0.9 * dtThink;
        seen = true;
        if (gt > CONFIG.reveal.glintSustain && (!this.invPos || this.invPos.distanceTo(e.pos) > 4 || time > this.invUntil)) {
          this.investigate(e.scopePos(new THREE.Vector3()), 0.95, time, { cue: 'glint', sourceId: e.id });
        }
      } else this.glintTime.set(e.id, 0);
      if (!seen) aw -= AI.awarenessDecay * dtThink;
      aw = clamp(aw, 0, 1.25);
      this.awareness.set(e.id, aw);
      if (seen && aw >= 1 && aw > bestAw) { bestAw = aw; bestT = e; }
    }
    if (bestT && (this.state !== 'aim' && this.state !== 'fire' && this.state !== 'cool' || !this.target || !this.target.alive)) {
      this.acquire(bestT, time);
    }
    // zone: leave if the spot is (or will be) outside
    if (this.state !== 'aim' && this.state !== 'fire' && this.state !== 'move' && !this.inZone(cb.pos.x, cb.pos.z, true)) {
      this.relocate(time, true);
    }
  }

  acquire(target, time) {
    const cb = this.cb;
    // remember how this target was found (shown in the victim's killcam)
    const nearCue = this.invPos && this.invCue && time < this.invUntil + 2 && target.pos.distanceTo(this.invPos) < CONFIG.ai.investigateRadius * 1.5;
    if ((this.glintTime.get(target.id) || 0) > 0) this.reasons.set(target.id, { cue: 'glint', own: true });
    else if (nearCue) this.reasons.set(target.id, { cue: this.invCue.cue, own: this.invCue.sourceId === target.id });
    else this.reasons.set(target.id, { cue: target.speed > 0.4 ? 'movement' : 'visual', own: true });
    this.target = target;
    this.lastSeenPos = target.centerPos(new THREE.Vector3());
    this.lastSeenTime = time;
    this.lostT = 0;
    this.followUp = false;
    this.duel = false;
    if (cb.stance === 'stand') cb.stance = 'crouch';
    if (this.state === 'move') this.moveTarget = null;
    const d = cb.eyePos(_a).distanceTo(this.lastSeenPos);
    const AI = CONFIG.ai;
    this.aimDuration = (AI.aimTimeBase + d * AI.aimTimePerMetre) * this.rng.float(0.8, 1.3);
    const e0 = this.rng.float(2.5, 7.5) * DEG * (1 + d / 400);
    const a = this.rng.float(0, Math.PI * 2);
    this.aimErr0.set(Math.cos(a) * e0, Math.sin(a) * e0 * 0.6);
    this.setState('aim', time);
  }

  // ------------------------------------------------------------------ behaviours
  doIdle(dt, time) {
    const cb = this.cb;
    cb.scoped = false;
    if (this.spot) cb.stance = this.spot.stance;
    if (!this.spot && this.stateT > 0.3) { this.relocate(time, false); return; }
    if (this.stateT > 1.2) this.setState('scan', time);
  }

  doScan(dt, time) {
    const cb = this.cb;
    const g = this.game;
    if (this.spot) cb.stance = this.underFireUntil > time ? 'prone' : this.spot.stance;
    if (time > this.scanUntil || !this.scanTarget) {
      this.scanTarget = this.pickScanTarget();
      this.scanUntil = time + this.rng.float(2.5, 6);
      // in big teams each sniper uses the scope a little less (the team covers the valley)
      this.scanScoped = time > this.settleUntil && this.rng.chance(0.45 * Math.min(1, Math.sqrt(5 / CONFIG.teams.size)));
    }
    this.lookAt(this.scanTarget);
    cb.scoped = this.scanScoped && this.turnedWithin(12 * DEG);
    if (time > this.relocateAt) this.relocate(time, false);
  }

  // Snipers watch likely hides: mostly good positions on the opposite slope that are
  // visible from here (terrain knowledge, not enemy knowledge), otherwise a random point.
  pickScanTarget() {
    const g = this.game;
    const T = g.terrain;
    const cb = this.cb;
    const eye = cb.eyePos(new THREE.Vector3());
    const enemySpots = g.spots.spots[1 - g.sideOf(cb.team)];
    if (this.rng.chance(0.6) && enemySpots.length) {
      for (let k = 0; k < 6; k++) {
        const s = enemySpots[this.rng.int(0, enemySpots.length - 1)];
        if (!this.inZone(s.x, s.z, false)) continue;
        const p = new THREE.Vector3(s.x, T.heightAt(s.x, s.z) + 0.6, s.z);
        const d = p.distanceTo(eye);
        if (d > 330 || d < 25) continue;
        if (g.world.lineOfSight(eye, p)) return p;
      }
    }
    const side = g.sideOf(cb.team) === 0 ? -1 : 1;
    const ks = CONFIG.map.ridgeDist / 178;
    let x = cb.pos.x + this.rng.float(-120, 120) * (CONFIG.map.length / 440);
    const zn = this.zone;
    if (zn && zn.mode === 'ends') x = clamp(x, -zn.halfLen * zn.current + 5, zn.halfLen * zn.current - 5);
    x = clamp(x, -T.halfX, T.halfX);
    const z = T.riverCenter(x) + side * this.rng.float(20, 150) * ks;
    return new THREE.Vector3(x, T.heightAt(x, z) + 1, z);
  }

  doInvestigate(dt, time) {
    const cb = this.cb;
    if (!this.invPos || time > this.invUntil) {
      this.invPos = null;
      this.setState('scan', time);
      this.scanUntil = 0;
      return;
    }
    if (this.spot && cb.speed < 0.1) cb.stance = this.underFireUntil > time ? 'prone' : this.spot.stance;
    _a.copy(this.invPos);
    // slow search sweep around the point
    const wob = Math.sin(this.stateT * 0.9) * 3.5 * DEG;
    this.lookAt(_a, wob, Math.sin(this.stateT * 0.6) * 0.8 * DEG);
    // still settling in: weak cues (birds, sounds) are checked without the scope
    cb.scoped = this.turnedWithin(15 * DEG) && (time > this.settleUntil || this.invStrength >= 0.9);
  }

  doAim(dt, time) {
    const cb = this.cb;
    const g = this.game;
    const t = this.target;
    if (!t || !t.alive) { this.target = null; this.setState('scan', time); this.scanUntil = 0; return; }
    cb.scoped = true;
    if (cb.stance === 'stand') cb.stance = 'crouch';
    const aimPt = t.stance === 'prone' ? t.eyePos(_d).add(_b.set(0, -0.08, 0)) : t.centerPos(_d).add(_b.set(0, 0.15, 0));
    const eye = cb.eyePos(_a);
    // track visibility
    const visible = g.world.lineOfSight(eye, aimPt, { endMargin: 0.3 });
    if (visible) { this.lastSeenPos = aimPt.clone(); this.lastSeenTime = time; this.lostT = 0; }
    else {
      this.lostT += dt;
      if (this.lostT > 1.6) {
        this.target = null;
        this.investigate(this.lastSeenPos || aimPt, 0.8, time);
        return;
      }
    }
    // duel: the player is scoped and looking straight at me -> hurry
    if (!this.duel && !t.ai && t.scoped) {
      const look = t.aimDir(_c);
      const toMe = _b.subVectors(eye, t.eyePos(new THREE.Vector3())).normalize();
      if (angleBetween(look, toMe) < 5 * DEG) {
        this.duel = true;
        this.aimDuration = this.aimProgress + (this.aimDuration - this.aimProgress) * CONFIG.ai.aimTimeDuelMul;
      }
    }
    this.aimProgress += dt;
    const k = clamp(this.aimProgress / this.aimDuration, 0, 1);
    const err = 1 - k * k * (3 - 2 * k);
    const target = this.lastSeenPos || aimPt;
    this.lookAt(target, this.aimErr0.x * err, this.aimErr0.y * err);
    if (k >= 1 && this.turnedWithin(0.6 * DEG) && g.combat.canFire(cb, time) && visible) {
      this.setState('fire', time);
    }
  }

  doFire(dt, time) {
    const cb = this.cb;
    const g = this.game;
    const t = this.target;
    if (!t || !t.alive) { this.setState('scan', time); return; }
    const eye = cb.eyePos(new THREE.Vector3());
    const aimPt = t.stance === 'prone' ? t.eyePos(new THREE.Vector3()).add(_b.set(0, -0.08, 0)) : t.centerPos(new THREE.Vector3()).add(_b.set(0, 0.15, 0));
    const d = eye.distanceTo(aimPt);
    const AI = CONFIG.ai;
    let p = AI.hitChanceBase - d * AI.hitChanceDistanceFalloff;
    if (t.speed > 1.5) p *= AI.hitChanceMovingMul;
    else if (t.speed > 0.4) p *= 0.75;
    if (t.stance === 'prone') p *= AI.hitChanceProneMul;
    if (this.followUp) p *= 1.05;
    p = clamp(p, 0.12, 0.96);
    const dir = new THREE.Vector3().subVectors(aimPt, eye).normalize();
    const hit = this.rng.next() < p;
    // perturb: tiny error on a hit, 0.6-1.8 m offset on a miss
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    const off = hit ? this.rng.float(0, 0.06) : this.rng.float(0.6, 1.8);
    const a = this.rng.float(0, Math.PI * 2);
    const target = aimPt.clone().addScaledVector(right, Math.cos(a) * off).addScaledVector(up, Math.sin(a) * off * 0.7);
    dir.subVectors(target, eye).normalize();
    // with ballistics on, hold over for drop and into the wind like a trained sniper
    if (CONFIG.weapon.ballistics.enabled) Combat.ballisticAim(eye, target, dir);
    // don't shoot through teammates
    for (const m of g.combatants) {
      if (m === cb || m.team !== cb.team || !m.alive || !m.hitbox) continue;
      if (m.hitbox.raycast(eye, dir, d)) { this.aimProgress = this.aimDuration * 0.6; this.setState('aim', time); return; }
    }
    // the aim is the visible direction (glint + pose)
    if (g.combat.fire(cb, dir, time)) {
      this.lastShotTarget = t;
      this.setState('cool', time);
    } else this.setState('aim', time);
  }

  doCool(dt, time) {
    const cb = this.cb;
    const g = this.game;
    cb.scoped = true;
    if (!g.combat.canFire(cb, time) && this.stateT < CONFIG.weapon.boltTime + 0.1) return;
    const t = this.target;
    if (!t || !t.alive) {
      this.target = null;
      // target down: relocate (our flash gave us away)
      if (this.rng.chance(0.7)) this.relocate(time, false, true); else { this.setState('scan', time); this.scanUntil = 0; }
      return;
    }
    if (this.rng.chance(CONFIG.ai.relocateAfterShotChance * 0.5)) { this.relocate(time, false, true); return; }
    // follow-up shot, faster
    this.followUp = true;
    this.aimDuration = (CONFIG.ai.aimTimeBase * 0.5 + cb.eyePos(_a).distanceTo(t.pos) * CONFIG.ai.aimTimePerMetre * 0.5) * this.rng.float(0.8, 1.2);
    const e0 = this.rng.float(1, 3) * DEG;
    const a = this.rng.float(0, Math.PI * 2);
    this.aimErr0.set(Math.cos(a) * e0, Math.sin(a) * e0 * 0.6);
    this.setState('aim', time);
  }

  relocate(time, urgent, afterShot = false) {
    const g = this.game;
    const cb = this.cb;
    if (!g.spots) return;
    const mates = g.combatants.filter((c) => c !== cb && c.team === cb.team && c.alive && c.ai).map((c) => c.ai.spot || c.pos);
    for (const h of g.humans || []) if (h.team === cb.team && h.alive) mates.push(h.pos);
    const spot = g.spots.choose(g.sideOf(cb.team), cb.pos, {
      minDist: afterShot ? 14 : urgent ? 0 : 10,
      maxDist: urgent ? 400 : 70,
      avoid: mates,
      zoneFn: (x, z) => this.inZone(x, z, true),
      rng: () => this.rng.next(),
    });
    this.relocateAt = time + this.rng.float(35, 65);
    if (!spot) { this.setState('scan', time); return; }
    this.spot = spot;
    this.moveTarget = new THREE.Vector3(spot.x, 0, spot.z);
    this.moveUrgent = urgent;
    this.moveSpeed = urgent ? CONFIG.ai.moveSpeed * 1.5 : afterShot ? CONFIG.ai.moveSpeed * 0.75 : CONFIG.ai.moveSpeed;
    this.setState('move', time);
  }

  doMove(dt, time) {
    const cb = this.cb;
    const g = this.game;
    cb.scoped = false;
    if (!this.moveTarget) { cb.speed = 0; this.setState('idle', time); return; }
    cb.stance = this.moveSpeed < CONFIG.ai.moveSpeed ? 'crouch' : 'stand';
    const dx = this.moveTarget.x - cb.pos.x, dz = this.moveTarget.z - cb.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.8) {
      this.moveTarget = null;
      cb.speed = 0;
      cb.stance = this.spot ? this.spot.stance : 'crouch';
      this.setState('idle', time);
      return;
    }
    let mx = dx / dist, mz = dz / dist;
    if (this.detour && time < this.detour.until) { mx = this.detour.x; mz = this.detour.z; }
    // avoid trunks/rocks ahead
    const ahead = g.world.query(cb.pos.x + mx * 1.6, cb.pos.z + mz * 1.6, 1.6, ['tree', 'rock', 'stump', 'log']);
    for (const o of ahead) {
      if (o.kind === 'log') {
        // walk around a fallen log: follow it toward the end nearer the target
        const lx = o.b.x - o.a.x, lz = o.b.z - o.a.z, ll = Math.hypot(lx, lz) || 1;
        const s = (lx * dx + lz * dz) >= 0 ? 1 : -1;
        mx = (lx / ll) * s; mz = (lz / ll) * s;
        break;
      }
      const ox = o.x - cb.pos.x, oz = o.z - cb.pos.z;
      const along = ox * mx + oz * mz;
      if (along < 0) continue;
      const lat = ox * -mz + oz * mx;
      const r = (o.kind === 'rock' ? o.r * 0.9 : o.r) + 0.6;
      if (Math.abs(lat) < r) {
        const s = lat > 0 ? -1 : 1;
        const nx = mx * Math.cos(0.9 * s) - mz * Math.sin(0.9 * s);
        const nz = mx * Math.sin(0.9 * s) + mz * Math.cos(0.9 * s);
        mx = nx; mz = nz;
        break;
      }
    }
    const sp = this.moveSpeed * (g.terrain.waterDepthAt(cb.pos.x, cb.pos.z) > 0.05 ? CONFIG.map.shallowSpeedMul : 1);
    const next = { x: cb.pos.x + mx * sp * dt, z: cb.pos.z + mz * sp * dt };
    g.world.collideCircle(next, 0.35, cb.pos.y);
    if (g.terrain.waterDepthAt(next.x, next.z) > CONFIG.map.deepWaterDepth) { next.x = cb.pos.x; next.z = cb.pos.z; }
    next.x = clamp(next.x, -g.terrain.halfX + 1, g.terrain.halfX - 1);
    next.z = clamp(next.z, -g.terrain.halfZ + 1, g.terrain.halfZ - 1);
    const moved = Math.hypot(next.x - cb.pos.x, next.z - cb.pos.z);
    cb.pos.x = next.x; cb.pos.z = next.z;
    cb.speed = dt > 0 ? moved / dt : 0;
    // face movement direction
    this.desiredYaw = Math.atan2(-mx, -mz);
    this.desiredPitch = 0;
    // footsteps (heard by others)
    this.stepDist += moved;
    if (this.stepDist > 1.4) {
      this.stepDist = 0;
      const wet = g.terrain.waterDepthAt(cb.pos.x, cb.pos.z) > 0.05;
      g.bus.emit({ type: wet ? 'splash' : 'footstep', position: cb.pos.clone(), time, sourceTeam: cb.team, sourceId: cb.id, loudness: this.moveSpeed > 3.5 ? 1 : 0.55 });
      if (wet) g.audio.splash(cb.pos, 0.6, false); else g.audio.footstep(cb.pos, 0.6, g.surfaceAt(cb.pos.x, cb.pos.z), false);
    }
    // stuck detection
    this.stuckT += dt;
    if (this.stuckT > 1.5) {
      if (cb.pos.distanceTo(this.lastPos) < 0.6) {
        const a = this.rng.float(0, Math.PI * 2);
        this.detour = { x: Math.cos(a), z: Math.sin(a), until: time + 1.2 };
      }
      this.lastPos.copy(cb.pos);
      this.stuckT = 0;
    }
  }

  // ------------------------------------------------------------------ helpers
  lookAt(p, yawOff = 0, pitchOff = 0) {
    const e = this.cb.eyePos(_b);
    const dx = p.x - e.x, dy = p.y - e.y, dz = p.z - e.z;
    this.desiredYaw = Math.atan2(-dx, -dz) + yawOff;
    this.desiredPitch = Math.atan2(dy, Math.hypot(dx, dz)) + pitchOff;
  }

  turnedWithin(rad) {
    return Math.abs(wrapAngle(this.desiredYaw - this.cb.yaw)) < rad && Math.abs(this.desiredPitch - this.cb.pitch) < rad;
  }

  _glintEvents(dt, time) {
    const cb = this.cb;
    const g = this.game;
    for (const e of g.combatants) {
      if (e.team === cb.team || !e.alive) continue;
      const gi = glintToward(cb, e.eyePos(_d));
      let t = this.glintEmitT.get(e.id) || 0;
      if (gi > 0.1) t += dt; else t = 0;
      if (t > CONFIG.reveal.glintSustain) {
        if (g.world.lineOfSight(cb.scopePos(_a), e.eyePos(_d))) {
          g.bus.emit({ type: 'glint', position: cb.scopePos(new THREE.Vector3()), time, sourceTeam: cb.team, sourceId: cb.id, targetId: e.id });
        }
        t = -2; // re-emit every ~2 s while sustained
      }
      this.glintEmitT.set(e.id, t);
    }
  }
}
