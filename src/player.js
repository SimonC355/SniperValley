// First-person player controller: movement, stances, collisions, water, mouse look,
// variable scope zoom (mouse wheel) with FOV-scaled sensitivity, scope sway, breath hold and
// recoil.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Combatant, eyeHeightFor } from './entity.js';
import { Simplex, clamp, lerp } from './noise.js';

const DEG = Math.PI / 180;

// Field of view of a scope magnification (relative to a 70° view, so 2× is the same on every
// field of view setting).
export function zoomFov(mag) { return 2 * Math.atan(Math.tan(35 * DEG) / mag) / DEG; }

export class Player extends Combatant {
  constructor(camera) {
    super({ name: 'YOU', team: 0, isPlayer: true });
    this.camera = camera;
    this.onGround = true;
    this.fov = CONFIG.player.fovHip;
    this.swayNoise = new Simplex(77);
    this.swayYaw = 0;
    this.swayPitch = 0;
    this.recoil = 0;          // transient view kick (radians)
    this.fatigue = 0;         // sprint carry-over 0..1
    this.breath = CONFIG.weapon.holdBreathTime;
    this.holdingBreath = false;
    this.breathCooldown = 0;
    this.breathPhase = 0;
    this.steady = 1;          // sway multiplier, eases toward the breath-hold value
    this.onBreath = null;     // (kind) 'hold' | 'release' | 'gasp' for sounds
    this.zoomIndex = 0;       // into CONFIG.player.zoomLevels
    this.zoomFov = zoomFov(CONFIG.player.zoomLevels[0]);
    this.sprintBlocked = false;
    this.bobPhase = 0;
    this.stepDist = 0;
    this.inWater = 0;         // water depth at feet
    this.onFootstep = null;
    this.onSplash = null;
    this.lookYaw = 0;         // base look (without sway/recoil)
    this.lookPitch = 0;
    this.frozen = false;      // round-start freeze (no moving/jumping)
    this.frozenScope = false; // test hook: hold scopeT at a fixed value
    this.slide = null;        // { dx, dz, v, t } while sliding (sprint + crouch)
    this.climb = null;        // { from, to, t, dur } while climbing onto a rock or wall
    this.swept = false;       // in the deep river: the current has you
    this.sweptT = 0;          // seconds in the current
    this.pushT = 0;           // seconds pushing forward against something climbable
    this.stepEase = 0;        // camera offset that eases out a step up or down
    this.roll = 0;
    this.onSlide = null;      // (kind) 'start' | 'end' for sounds
    this.onClimb = null;      // () a climb starts
    this.onSwept = null;      // () the current takes the player
  }

  // keepStats: a deathmatch respawn (shots, hits, kills and deaths carry on)
  spawn(x, z, yaw, keepStats = false) {
    this.pos.set(x, 0, z);
    this.vel.set(0, 0, 0);
    this.lookYaw = yaw;
    this.lookPitch = -0.05;
    this.alive = true;
    this.health = CONFIG.player.health;
    this.stance = 'stand';
    this.eye = eyeHeightFor('stand');
    this.scopeT = 0;
    this.recoil = 0;
    this.fatigue = 0;
    this.breath = CONFIG.weapon.holdBreathTime;
    this.breathCooldown = 0;
    this.holdingBreath = false;
    this.steady = 1;
    this.zoomIndex = 0;
    this.zoomFov = zoomFov(CONFIG.player.zoomLevels[0]);
    this.sprintBlocked = false;
    this.boltReadyTime = 0;
    this.lastShotTime = -100;
    this.killedBy = null;
    this.respawnAt = null;
    this.life = keepStats ? (this.life || 0) + 1 : 0;
    if (!keepStats) {
      this.shotsFired = 0;
      this.hits = 0;
      this.kills = 0;
      this.deaths = 0;
      this.teamKills = 0;
      this.longestHit = 0;
    }
    this.speed = 0;
    this.slide = null;
    this.climb = null;
    this.swept = false;
    this.sweptT = 0;
    this.pushT = 0;
    this.stepEase = 0;
    this.onGround = true;
  }

  get sensitivityScale() { return this.fov / CONFIG.player.fovHip; }
  get magnification() { return CONFIG.player.zoomLevels[this.zoomIndex]; }

  update(dt, input, world, terrain, time) {
    const P = CONFIG.player;
    if (!this.alive) return;

    // ---------------------------------------------------------------- look
    const C = CONFIG.controls;
    const sens = P.mouseSensitivity * C.sensitivity * this.sensitivityScale * lerp(1, C.scopeSensitivity, this.scopeT);
    this.lookYaw -= input.mouseDX * sens;
    this.lookPitch -= input.mouseDY * sens * (C.invertY ? -1 : 1);
    const arrow = P.arrowLookSpeed * this.sensitivityScale * dt;
    if (input.down('ArrowLeft')) this.lookYaw += arrow;
    if (input.down('ArrowRight')) this.lookYaw -= arrow;
    if (input.down('ArrowUp')) this.lookPitch += arrow;
    if (input.down('ArrowDown')) this.lookPitch -= arrow;
    this.lookPitch = clamp(this.lookPitch, -1.45, 1.45);

    // ---------------------------------------------------------------- stance
    // Crouch or prone pressed while sprint is held keeps that stance until sprint is pressed
    // again; otherwise sprinting stands up (below). Crouch pressed while running fast is a
    // slide.
    const sprintKey = input.act('sprint');
    if (!sprintKey) this.sprintBlocked = false;
    const busy = !!this.climb || this.swept;
    if (input.actPressed('crouch') && !busy) {
      if (!this.slide && this.stance === 'stand' && this.onGround && this.speed > P.walkSpeed + 0.8 && !this.scoped && this.inWater < 0.05 && !this.frozen) {
        this._startSlide(world);
      } else if (this.slide) this._endSlide();
      else { this.stance = this.stance === 'crouch' ? 'stand' : 'crouch'; this.sprintBlocked = sprintKey; }
    }
    if (input.actPressed('prone') && !busy) { if (this.slide) this._endSlide(); this.stance = this.stance === 'prone' ? 'crouch' : 'prone'; this.sprintBlocked = sprintKey; }
    if (this.inWater > 0.25 && this.stance === 'prone') this.stance = 'crouch';

    // ---------------------------------------------------------------- scope
    const wantScope = input.act('scope') && !busy && !this.slide;
    // the scope opens at the lowest zoom (or the last one, see settings); the wheel zooms
    // (forward = in, back = out)
    const levels = P.zoomLevels;
    if (wantScope && this.scopeT === 0 && CONFIG.controls.scopeZoom !== 'keep') this.zoomIndex = 0;
    if (wantScope && input.wheel) this.zoomIndex = clamp(this.zoomIndex - input.wheel, 0, levels.length - 1);
    const zf = zoomFov(levels[this.zoomIndex]);
    this.zoomFov = this.scopeT === 0 ? zf : Math.exp(lerp(Math.log(this.zoomFov), Math.log(zf), 1 - Math.exp(-dt * 16)));
    if (!this.frozenScope) this.scopeT = clamp(this.scopeT + (wantScope ? 1 : -1) * dt / P.zoomTime, 0, 1);
    this.scoped = this.scopeT > 0.55;
    const z = this.scopeT * this.scopeT * (3 - 2 * this.scopeT);
    this.fov = P.fovHip * Math.pow(this.zoomFov / P.fovHip, z);

    // ---------------------------------------------------------------- movement
    let fwd = 0, side = 0;
    if (!this.frozen) {
      if (input.act('forward')) fwd += 1;
      if (input.act('back')) fwd -= 1;
      if (input.act('right')) side += 1;
      if (input.act('left')) side -= 1;
    }
    const moving = fwd !== 0 || side !== 0;
    // sprinting gets up from crouch or prone
    const wantSprint = sprintKey && !this.sprintBlocked && moving && fwd > 0 && !this.scoped && this.onGround && !this.slide && !busy;
    if (wantSprint && this.stance !== 'stand') this.stance = 'stand';
    const sprinting = wantSprint && this.stance === 'stand';
    this.sprinting = sprinting;
    let speed = P.walkSpeed;
    if (this.stance === 'crouch') speed = P.crouchSpeed;
    if (this.stance === 'prone') speed = P.proneSpeed;
    if (sprinting) speed = P.sprintSpeed;
    if (this.scoped) speed = Math.min(speed, this.stance === 'prone' ? P.proneSpeed * 0.7 : P.scopedSpeed);
    if (this.inWater > 0.05) speed *= CONFIG.map.shallowSpeedMul;

    const len = Math.hypot(fwd, side) || 1;
    const sy = Math.sin(this.lookYaw), cy = Math.cos(this.lookYaw);
    const wx = ((-sy * fwd) + (cy * side)) / len * speed;
    const wz = ((-cy * fwd) + (-sy * side)) / len * speed;
    const jump = input.actPressed('jump');
    let moved = 0;
    if (this.climb) {
      moved = this._updateClimb(dt);
    } else {
      if (this.slide) this._updateSlide(dt, world, terrain, jump);
      else if (this.swept) this._updateSwept(dt, terrain, wx, wz);
      else {
        const accel = this.onGround ? P.accel : P.accel * 0.15;
        const k = 1 - Math.exp(-accel * dt / Math.max(1, speed));
        this.vel.x = lerp(this.vel.x, moving ? wx : 0, k * (moving ? 1 : 1.6));
        this.vel.z = lerp(this.vel.z, moving ? wz : 0, k * (moving ? 1 : 1.6));
        // the river pulls a little on the shallow shelf
        if (this.inWater > 0.05 && this.onGround) {
          const pull = CONFIG.map.shallowDrift * clamp(this.inWater / CONFIG.map.deepWaterDepth, 0, 1);
          this.vel.x -= pull * dt * 6;
        }
        if (this.onGround && jump && this.stance === 'stand' && !this.frozen && this.inWater < 0.4) {
          this.vel.y = P.jumpVelocity;
          this.onGround = false;
        } else if (this.onGround && jump && this.stance !== 'stand') {
          this.stance = 'stand';
        }
      }
      if (!this.swept) this.vel.y -= P.gravity * dt;
      moved = this._move(dt, world, terrain, fwd > 0 && !this.slide && !this.swept, jump);
    }
    this.speed = dt > 0 ? moved / dt : 0;

    // footsteps / splashes
    if (this.onGround && moved > 0 && !this.slide && !this.climb) {
      this.stepDist += moved;
      const stride = sprinting ? 1.9 : this.stance === 'prone' ? 0.9 : 1.3;
      if (this.stepDist > stride) {
        this.stepDist = 0;
        const loud = sprinting ? 1.0 : this.stance === 'prone' ? 0.2 : this.stance === 'crouch' ? 0.35 : 0.55;
        if (this.inWater > 0.05 && this.onSplash) this.onSplash(this.pos, loud);
        else if (this.onFootstep) this.onFootstep(this.pos, loud);
      }
    }
    if (this.swept) {
      this.stepDist += dt;
      if (this.stepDist > 0.45 && this.onSplash) { this.stepDist = 0; this.onSplash(this.pos, 1.2); }
    }

    // eye height smoothing (a step up onto a rock is eased instead of popping)
    const targetEye = this.slide ? P.slideEye : this.climb ? 1.2 : this.swept ? 0.42 : eyeHeightFor(this.stance);
    this.eye = lerp(this.eye, targetEye, 1 - Math.exp(-dt * (this.slide ? 14 : 9)));
    this.stepEase = lerp(this.stepEase, 0, 1 - Math.exp(-dt * 12));

    // ---------------------------------------------------------------- sway
    // Scoped, the aim drifts and rises and falls with each breath (more standing, after a
    // sprint or while moving). Holding the breath (sprint key while scoped) steadies it for a
    // few seconds; running out of breath makes it worse for a while.
    this.fatigue = clamp(this.fatigue + (sprinting ? dt * 0.35 : -dt * 0.3), 0, 1);
    const W = CONFIG.weapon;
    const breathKey = sprintKey && this.scoped && this.alive;
    const wasHolding = this.holdingBreath;
    if (breathKey && this.breath > 0 && this.breathCooldown <= 0) {
      this.holdingBreath = true;
      this.breath -= dt;
      if (this.breath <= 0) { this.holdingBreath = false; this.breathCooldown = W.outOfBreathTime; }
    } else {
      this.holdingBreath = false;
      if (this.breathCooldown > 0) this.breathCooldown -= dt;
      this.breath = Math.min(W.holdBreathTime, this.breath + dt * W.breathRecovery);
    }
    if (this.onBreath && this.holdingBreath !== wasHolding) this.onBreath(this.holdingBreath ? 'hold' : this.breathCooldown > 0 ? 'gasp' : 'release');
    const moveFactor = clamp(this.speed / P.walkSpeed, 0, 1.5);
    const stanceK = this.stance === 'prone' ? W.swayProne : this.stance === 'crouch' ? W.swayCrouch : 1;
    // the breathing part is mostly felt through the scope
    let amp = (W.swayIdle * lerp(0.2, 1, this.scopeT) + W.swayMove * moveFactor + W.swaySprintCarry * this.fatigue) * stanceK;
    this.steady = lerp(this.steady, this.holdingBreath ? W.holdBreathSteady : this.breathCooldown > 0 ? 1.8 : 1, 1 - Math.exp(-dt * 5));
    amp *= this.steady * DEG;
    // breathing: ~4 s a breath (faster when out of breath); it stops while the breath is held
    if (!this.holdingBreath) this.breathPhase += dt * Math.PI * 2 / (this.breathCooldown > 0 ? 2.2 : 4 - 1.5 * this.fatigue);
    const t = time;
    const n = this.swayNoise;
    const targetSY = (n.noise2(t * 0.3, 1.3) * 0.75 + Math.sin(this.breathPhase * 0.5 + 0.7) * 0.25) * amp;
    const targetSP = (Math.sin(this.breathPhase) * 0.6 + n.noise2(t * 0.3, 7.9) * 0.45) * amp * 0.85;
    this.swayYaw = lerp(this.swayYaw, targetSY, 1 - Math.exp(-dt * 6));
    this.swayPitch = lerp(this.swayPitch, targetSP, 1 - Math.exp(-dt * 6));

    // recoil recovery
    this.recoil = lerp(this.recoil, 0, 1 - Math.exp(-dt * 7));

    // head bob (not while scoped)
    if (this.onGround && moved > 0.001 && !this.scoped) this.bobPhase += moved * (sprinting ? 1.6 : 2.2);
    const bobAmt = this.scoped || this.slide || this.climb || this.swept ? 0 : clamp(this.speed / P.sprintSpeed, 0, 1) * 0.045;

    // final aim = look + sway + recoil
    this.yaw = this.lookYaw + this.swayYaw;
    this.pitch = this.lookPitch + this.swayPitch + this.recoil;

    // ---------------------------------------------------------------- camera
    const cam = this.camera;
    const swim = this.swept ? Math.sin(time * 5.3) * 0.08 + Math.sin(time * 2.1) * 0.05 : 0;
    cam.position.set(this.pos.x, this.pos.y + this.eye + this.stepEase + Math.sin(this.bobPhase * 2) * bobAmt + swim, this.pos.z);
    this.roll = lerp(this.roll, (this.slide ? 0.07 : 0) + (this.swept ? Math.sin(time * 1.7) * 0.12 : 0), 1 - Math.exp(-dt * 8));
    cam.rotation.set(this.pitch, this.yaw, Math.sin(this.bobPhase) * bobAmt * 0.15 + this.roll, 'YXZ');
    if (Math.abs(cam.fov - this.fov) > 1e-3) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  // ---------------------------------------------------------------- moving on rocks and walls
  // Highest rock, wall or building top under the player's circle (centre and rim), or -Infinity.
  _obstacleMax(world, x, z) {
    const r = CONFIG.player.radius * 0.9;
    let m = world.obstacleAt(x, z);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const h = world.obstacleAt(x + Math.cos(a) * r, z + Math.sin(a) * r);
      if (h > m) m = h;
    }
    return m;
  }

  // Move by the velocity: trunks and logs push the circle aside; a rock, wall or building
  // higher than a step blocks it (sliding along it if possible). Pushing forward against one
  // that is low enough (or pressing jump) climbs onto it. Then the feet settle on the ground.
  _move(dt, world, terrain, forward, jump) {
    const P = CONFIG.player;
    const foot = this.pos.y;
    const hx = terrain.halfX - P.radius - 0.15, hz = terrain.halfZ - P.radius - 0.15;
    // what we already overlap never blocks (e.g. after a spawn next to a rock)
    const here = this._obstacleMax(world, this.pos.x, this.pos.z);
    const allow = Math.max(foot + (this.onGround || this.swept ? P.stepHeight : 0.08), here + 0.02);
    const tryAt = (x, z) => {
      const q = { x: clamp(x, -hx, hx), z: clamp(z, -hz, hz) };
      world.collideCircle(q, P.radius, foot, true);
      q.o = this._obstacleMax(world, q.x, q.z);
      return q;
    };
    let q = tryAt(this.pos.x + this.vel.x * dt, this.pos.z + this.vel.z * dt);
    let blockedTop = null;
    if (q.o > allow) {
      blockedTop = q.o;
      const qa = tryAt(this.pos.x + this.vel.x * dt, this.pos.z);
      const qb = tryAt(this.pos.x, this.pos.z + this.vel.z * dt);
      const ma = qa.o <= allow ? Math.abs(qa.x - this.pos.x) : -1, mb = qb.o <= allow ? Math.abs(qb.z - this.pos.z) : -1;
      if (ma > 1e-4 && ma >= mb) { q = qa; this.vel.z *= 0.5; } else if (mb > 1e-4) { q = qb; this.vel.x *= 0.5; } else { q = { x: this.pos.x, z: this.pos.z }; this.vel.x = 0; this.vel.z = 0; }
      if (this.slide) this._endSlide();
    }
    // climbing: pushing forward against something we can get onto
    if (blockedTop !== null && forward && this.onGround && !this.scoped && this.stance !== 'prone' && !this.frozen && blockedTop - foot <= P.climbHeight) {
      this.pushT += dt;
      if (this.pushT > 0.22 || jump) {
        const to = this._climbTarget(world, foot);
        if (to) {
          this.climb = { from: this.pos.clone(), to, t: 0, dur: P.climbTime * (0.65 + 0.45 * (to.y - foot) / P.climbHeight) };
          this.pushT = 0;
          this.vel.set(0, 0, 0);
          if (this.onClimb) this.onClimb(to.y - foot);
          return 0;
        }
      }
    } else this.pushT = 0;
    const moved = Math.hypot(q.x - this.pos.x, q.z - this.pos.z);
    this.pos.x = q.x;
    this.pos.z = q.z;
    this._settle(dt, world, terrain);
    return moved;
  }

  // Feet on the ground (terrain, rock, wall or building top), or floating in the current.
  _settle(dt, world, terrain) {
    const ground = world.groundAt(this.pos.x, this.pos.z);
    const bed = terrain.heightAt(this.pos.x, this.pos.z);
    const depth = CONFIG.map.waterLevel - bed;
    // the deep channel: the current takes you (and lets go if you reach the shallows)
    if (!this.swept && depth > CONFIG.map.deepWaterDepth && ground <= bed + 0.05) {
      this.swept = true;
      this.sweptT = 0;
      if (this.slide) this._endSlide();
      this.climb = null;
      if (this.onSwept) this.onSwept();
    } else if (this.swept && depth < CONFIG.map.deepWaterDepth * 0.7) this.swept = false;
    if (this.swept) {
      const float = CONFIG.map.waterLevel - 1.25;
      this.pos.y = lerp(this.pos.y, Math.max(ground, float), 1 - Math.exp(-dt * 5));
      this.vel.y = 0;
      this.onGround = false;
      this.inWater = depth;
      return;
    }
    this.pos.y += this.vel.y * dt;
    if (this.pos.y <= ground) {
      if (!this.onGround && this.vel.y < -6 && this.onFootstep) this.onFootstep(this.pos, 1.4);
      const up = ground - this.pos.y;
      if (this.onGround && up > 0.06) this.stepEase -= up;   // ease the camera up a step
      this.pos.y = ground;
      this.vel.y = 0;
      this.onGround = true;
    } else if (this.onGround && this.pos.y - ground < 0.35 && this.vel.y <= 0) {
      this.stepEase += this.pos.y - ground;   // stick to slopes and small steps down
      this.pos.y = ground;
      this.vel.y = 0;
    } else {
      this.onGround = false;
    }
    this.inWater = Math.max(0, CONFIG.map.waterLevel - ground);
  }

  // Where a climb ends: the first spot ahead (in the look direction) on top of the obstacle
  // that is flat enough to stand on and not higher than we can climb.
  _climbTarget(world, foot) {
    const P = CONFIG.player;
    const dx = -Math.sin(this.lookYaw), dz = -Math.cos(this.lookYaw);
    for (let d = P.radius + 0.1; d < 2.8; d += 0.1) {
      const x = this.pos.x + dx * d, z = this.pos.z + dz * d;
      const g = world.groundAt(x, z);
      if (g <= foot + P.stepHeight * 0.5) continue;
      if (g > foot + P.climbHeight + 0.05) return null;
      // somewhere to stand: not much higher right next to it (a rounded top is fine)
      if (this._obstacleMax(world, x, z) > g + P.stepHeight * 1.4) continue;
      // a little further in, if that is still on top, so we don't stand on the very edge
      const x2 = x + dx * 0.25, z2 = z + dz * 0.25, g2 = world.groundAt(x2, z2);
      if (Math.abs(g2 - g) < P.stepHeight * 0.6 && this._obstacleMax(world, x2, z2) <= g2 + P.stepHeight) return new THREE.Vector3(x2, g2, z2);
      return new THREE.Vector3(x, g, z);
    }
    return null;
  }

  // Up first (hands on top), then over the edge.
  _updateClimb(dt) {
    const c = this.climb;
    c.t = Math.min(1, c.t + dt / c.dur);
    const u = c.t;
    const px = this.pos.x, pz = this.pos.z;
    if (u < 0.6) {
      const k = u / 0.6, e = k * k * (3 - 2 * k);
      this.pos.y = lerp(c.from.y, c.to.y + 0.12, e);
      this.pos.x = lerp(c.from.x, c.to.x, e * 0.25);
      this.pos.z = lerp(c.from.z, c.to.z, e * 0.25);
    } else {
      const k = (u - 0.6) / 0.4, e = k * k * (3 - 2 * k);
      this.pos.y = c.to.y + 0.12 * (1 - e);
      this.pos.x = lerp(c.from.x, c.to.x, 0.25 + 0.75 * e);
      this.pos.z = lerp(c.from.z, c.to.z, 0.25 + 0.75 * e);
    }
    if (u >= 1) {
      this.pos.copy(c.to);
      this.climb = null;
      this.onGround = true;
      this.vel.set(0, 0, 0);
      if (this.stance === 'prone') this.stance = 'crouch';
    }
    return Math.hypot(this.pos.x - px, this.pos.z - pz);
  }

  // ---------------------------------------------------------------- slide
  _startSlide() {
    const P = CONFIG.player;
    let dx = this.vel.x, dz = this.vel.z;
    const l = Math.hypot(dx, dz);
    if (l < 0.1) { dx = -Math.sin(this.lookYaw); dz = -Math.cos(this.lookYaw); } else { dx /= l; dz /= l; }
    this.slide = { dx, dz, v: Math.max(P.slideSpeed, this.speed + 1.2), t: 0 };
    this.stance = 'crouch';
    this.sprintBlocked = true;
    if (this.onSlide) this.onSlide('start');
  }

  _endSlide() {
    if (!this.slide) return;
    this.slide = null;
    if (this.onSlide) this.onSlide('end');
  }

  // Momentum carries the slide; level ground and uphill slow it, downhill keeps it going. The
  // mouse steers it a little; jump ends it with a hop.
  _updateSlide(dt, world, terrain, jump) {
    const P = CONFIG.player, S = this.slide;
    const h0 = terrain.heightAt(this.pos.x - S.dx * 0.6, this.pos.z - S.dz * 0.6);
    const h1 = terrain.heightAt(this.pos.x + S.dx * 0.6, this.pos.z + S.dz * 0.6);
    const grade = (h0 - h1) / 1.2;   // > 0 downhill
    S.v = Math.min(12, S.v + (9.81 * 0.8 * grade - P.slideFriction) * dt);
    // steer toward the look direction, slowly
    const lx = -Math.sin(this.lookYaw), lz = -Math.cos(this.lookYaw);
    const cross = S.dx * lz - S.dz * lx, dot = S.dx * lx + S.dz * lz;
    const turn = clamp(Math.atan2(cross, dot), -1.4 * dt, 1.4 * dt);
    const c = Math.cos(turn), s = Math.sin(turn);
    const ndx = S.dx * c - S.dz * s, ndz = S.dx * s + S.dz * c;
    S.dx = ndx; S.dz = ndz;
    this.vel.x = S.dx * S.v;
    this.vel.z = S.dz * S.v;
    S.t += dt;
    if (jump && this.onGround) {
      this._endSlide();
      this.stance = 'stand';
      this.vel.y = CONFIG.player.jumpVelocity * 0.85;
      this.onGround = false;
      return;
    }
    if (S.v < P.slideMinSpeed || S.t > 2.4 || this.inWater > 0.2) this._endSlide();
  }

  // ---------------------------------------------------------------- the river's current
  // The current carries you downstream (toward -X, the way the water flows) and into the
  // middle of the channel; you can barely steer.
  _updateSwept(dt, terrain, wx, wz) {
    const C = CONFIG.map.current;
    this.sweptT += dt;
    const zc = terrain.riverCenter(this.pos.x);
    const tx = -C + wx * 0.12, tz = clamp((zc - this.pos.z) * 0.9, -2.5, 2.5) + wz * 0.12;
    const k = 1 - Math.exp(-dt * 2.5);
    this.vel.x = lerp(this.vel.x, tx, k);
    this.vel.z = lerp(this.vel.z, tz, k);
    this.vel.y = 0;
    this.stance = 'stand';
    this.scopeT = 0;
  }

  applyRecoil() {
    const W = CONFIG.weapon;
    const kick = W.recoilPitch * DEG;
    this.recoil += kick * W.recoilRecover;
    this.lookPitch += kick * (1 - W.recoilRecover);
    this.lookYaw += (Math.random() - 0.5) * kick * 0.25;
  }
}
