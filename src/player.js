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
    // again; otherwise sprinting stands up (below).
    const sprintKey = input.act('sprint');
    if (!sprintKey) this.sprintBlocked = false;
    if (input.actPressed('crouch')) { this.stance = this.stance === 'crouch' ? 'stand' : 'crouch'; this.sprintBlocked = sprintKey; }
    if (input.actPressed('prone')) { this.stance = this.stance === 'prone' ? 'crouch' : 'prone'; this.sprintBlocked = sprintKey; }
    if (this.inWater > 0.25 && this.stance === 'prone') this.stance = 'crouch';

    // ---------------------------------------------------------------- scope
    const wantScope = input.act('scope');
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
    const wantSprint = sprintKey && !this.sprintBlocked && moving && fwd > 0 && !this.scoped && this.onGround;
    if (wantSprint && this.stance !== 'stand') this.stance = 'stand';
    const sprinting = wantSprint && this.stance === 'stand';
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
    const accel = this.onGround ? P.accel : P.accel * 0.15;
    const k = 1 - Math.exp(-accel * dt / Math.max(1, speed));
    this.vel.x = lerp(this.vel.x, moving ? wx : 0, k * (moving ? 1 : 1.6));
    this.vel.z = lerp(this.vel.z, moving ? wz : 0, k * (moving ? 1 : 1.6));

    const jump = input.actPressed('jump');
    if (this.onGround && jump && this.stance === 'stand' && !this.frozen && this.inWater < 0.4) {
      this.vel.y = P.jumpVelocity;
      this.onGround = false;
    } else if (this.onGround && jump && this.stance !== 'stand') {
      this.stance = 'stand';
    }
    this.vel.y -= P.gravity * dt;

    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;
    const next = { x: nx, z: nz };
    world.collideCircle(next, P.radius, this.pos.y);
    // deep water is impassable
    const deep = CONFIG.map.deepWaterDepth;
    if (terrain.waterDepthAt(next.x, next.z) > deep) {
      if (terrain.waterDepthAt(next.x, this.pos.z) <= deep) next.z = this.pos.z;
      else if (terrain.waterDepthAt(this.pos.x, next.z) <= deep) next.x = this.pos.x;
      else { next.x = this.pos.x; next.z = this.pos.z; }
    }
    const hx = terrain.halfX - 1, hz = terrain.halfZ - 1;
    next.x = clamp(next.x, -hx, hx);
    next.z = clamp(next.z, -hz, hz);
    const moved = Math.hypot(next.x - this.pos.x, next.z - this.pos.z);
    this.pos.x = next.x;
    this.pos.z = next.z;
    this.pos.y += this.vel.y * dt;
    const ground = terrain.heightAt(this.pos.x, this.pos.z);
    if (this.pos.y <= ground) {
      if (!this.onGround && this.vel.y < -6 && this.onFootstep) this.onFootstep(this.pos, 1.4);
      this.pos.y = ground;
      this.vel.y = 0;
      this.onGround = true;
    } else if (this.onGround && this.pos.y - ground < 0.35 && this.vel.y <= 0) {
      this.pos.y = ground; // stick to slopes
      this.vel.y = 0;
    } else {
      this.onGround = false;
    }
    this.inWater = Math.max(0, CONFIG.map.waterLevel - ground);
    this.speed = dt > 0 ? moved / dt : 0;

    // footsteps / splashes
    if (this.onGround && moved > 0) {
      this.stepDist += moved;
      const stride = sprinting ? 1.9 : this.stance === 'prone' ? 0.9 : 1.3;
      if (this.stepDist > stride) {
        this.stepDist = 0;
        const loud = sprinting ? 1.0 : this.stance === 'prone' ? 0.2 : this.stance === 'crouch' ? 0.35 : 0.55;
        if (this.inWater > 0.05 && this.onSplash) this.onSplash(this.pos, loud);
        else if (this.onFootstep) this.onFootstep(this.pos, loud);
      }
    }

    // eye height smoothing
    const targetEye = eyeHeightFor(this.stance);
    this.eye = lerp(this.eye, targetEye, 1 - Math.exp(-dt * 9));

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
    const bobAmt = this.scoped ? 0 : clamp(this.speed / P.sprintSpeed, 0, 1) * 0.045;

    // final aim = look + sway + recoil
    this.yaw = this.lookYaw + this.swayYaw;
    this.pitch = this.lookPitch + this.swayPitch + this.recoil;

    // ---------------------------------------------------------------- camera
    const cam = this.camera;
    cam.position.set(this.pos.x, this.pos.y + this.eye + Math.sin(this.bobPhase * 2) * bobAmt, this.pos.z);
    cam.rotation.set(this.pitch, this.yaw, Math.sin(this.bobPhase) * bobAmt * 0.15, 'YXZ');
    if (Math.abs(cam.fov - this.fov) > 1e-3) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  applyRecoil() {
    const W = CONFIG.weapon;
    const kick = W.recoilPitch * DEG;
    this.recoil += kick * W.recoilRecover;
    this.lookPitch += kick * (1 - W.recoilRecover);
    this.lookYaw += (Math.random() - 0.5) * kick * 0.25;
  }
}
