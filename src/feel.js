// v5.2: the small details of being a sniper, in one place.
//
// - Suppression: a bullet cracking past within feel.suppressRadius (or landing that close)
//   closes your hearing for a moment, rings your ears when it was very close, jolts the aim,
//   drains the colour and narrows and blurs the edges of the view. It wears off over
//   feel.suppressTime; while it lasts the hands shake more and the heart beats faster.
// - Breathing: through the scope you hear yourself breathe, in time with the rise and fall of
//   the reticle; after a sprint you pant, also unscoped. Holding the breath silences it, and
//   after a moment the heartbeat comes up, louder and faster as the breath runs out, and each
//   beat twitches the reticle a hair.
// - Rifle foley: cloth and cheek as the rifle comes up, the zoom ring's detents.
// - Scope: the eye box. The scope only shows a full picture with the eye exactly behind it; a
//   fast swing, walking, or the recoil puts a dark crescent at the edge, and the picture opens
//   up from a tunnel as the rifle settles on your cheek. Heat mirage: at long range on a sunny
//   day the far picture shimmers, drifting with the crosswind (read it like a wind flag).
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp, lerp } from './noise.js';

const TAU = Math.PI * 2;

export class Feel {
  constructor(game) {
    this.g = game;
    this.suppress = 0;       // 0..1, what the screen shows
    this.suppressHold = 0;   // seconds before it starts to wear off
    this.kick = 0;           // own shot: the picture jumps (vertical blur), 0..1
    this.eye = new THREE.Vector2();   // eye-box offset, lens units
    this.tunnel = 1;
    this.prevScopeT = 0;
    this.prevZoom = 0;
    this.prevPhase = 0;
    this.lastBreathSound = -10;
    this.beatT = 0;
    this.lastYaw = 0;
    this.lastPitch = 0;
    this.mirage = 0;
  }

  reset() {
    this.suppress = 0;
    this.suppressHold = 0;
    this.kick = 0;
    this.eye.set(0, 0);
    this.tunnel = 1;
    this.beatT = 0;
  }

  // ---------------------------------------------------------------- events
  // A bullet passed the player `miss` metres away (closest point `pos`, direction `dir`).
  nearMiss(miss, pos, dir) {
    const F = CONFIG.feel;
    const k = Math.pow(clamp(1 - miss / F.suppressRadius, 0, 1), 0.7);
    if (k <= 0) return;
    this._suppress(k);
    const ring = miss < F.tinnitusMiss ? clamp(1.2 - miss / F.tinnitusMiss, 0.35, 1) : 0;
    this.g.audio.suppress(k, ring);
    this.g.player.flinch(F.flinch * k);
  }

  // A bullet landed `d` metres from the player.
  nearImpact(d) {
    const F = CONFIG.feel;
    const k = clamp(1 - d / F.suppressRadius, 0, 1) * 0.85;
    if (k <= 0) return;
    this._suppress(k);
    this.g.audio.suppress(k * 0.7, 0);
    this.g.player.flinch(F.flinch * 0.6 * k);
    this.g.player.punch(0.03 * k);
  }

  _suppress(k) {
    this.suppress = Math.max(this.suppress, k);
    this.suppressHold = Math.max(this.suppressHold, 0.25 + 0.35 * k);
  }

  // The player fired.
  ownShot() {
    const p = this.g.player;
    this.kick = 1;
    p.punch(p.scoped ? 0.006 : 0.018);
    // the recoil pushes the eyepiece off the eye: the shadow flashes in and the picture settles
    if (p.scoped) this.eye.set((Math.random() - 0.5) * 0.06, -0.11);
  }

  // ---------------------------------------------------------------- per frame
  update(dt, realDt) {
    const g = this.g, p = g.player, F = CONFIG.feel, A = g.audio;
    const alive = p.alive && g.state === 'playing';
    // a new life (round start, respawn) starts calm
    const life = `${g.match ? g.match.round : 0}/${p.life || 0}`;
    if (life !== this.life) { this.life = life; this.reset(); }
    // suppression wears off
    if (this.suppressHold > 0) this.suppressHold -= realDt;
    else this.suppress = Math.max(0, this.suppress - realDt / F.suppressTime);
    if (!alive) this.suppress = Math.max(0, this.suppress - realDt * 2);
    p.stress = this.suppress;
    this.kick = Math.max(0, this.kick - realDt * 7);

    // breathing (in the round-start freeze too)
    if (alive && F.breathing && dt > 0) this._breathing(dt);
    // rifle foley: up to the eye, down again, the zoom ring
    if (alive && dt > 0) {
      const st = p.scopeT, ps = this.prevScopeT;
      if (st > ps && ps === 0) A.scopeFoley('in');
      else if (st < ps && ps >= 0.999) A.scopeFoley('out');
      if (p.scoped && p.zoomIndex !== this.prevZoom) {
        const n = Math.min(4, Math.abs(p.zoomIndex - this.prevZoom));
        for (let i = 0; i < n; i++) A.zoomClick(i * 0.045);
      }
    }
    this.prevScopeT = p.scopeT;
    this.prevZoom = p.zoomIndex;

    this._scope(realDt);
    this._uniforms();
  }

  _breathing(dt) {
    const g = this.g, p = g.player, A = g.audio, W = CONFIG.weapon, F = CONFIG.feel;
    const now = g.realTime;
    const winded = p.breathCooldown > 0;
    const panting = p.fatigue > 0.3 || winded;
    // breath sounds follow the phase that moves the reticle: in while it rises, out while it falls
    const ph = ((p.breathPhase % TAU) + TAU) % TAU, prev = this.prevPhase;
    this.prevPhase = ph;
    if (!p.holdingBreath && (p.scoped || panting) && now - this.lastBreathSound > 0.6) {
      const strength = clamp(p.fatigue * 0.85 + (winded ? 0.55 : 0) + p.stress * 0.35, 0, 1);
      const half = p.breathPeriod / 2;
      const crossed = (a) => (prev < a && ph >= a) || (prev > ph && (prev < a || ph >= a));
      if (crossed(1.5 * Math.PI)) { A.breathe('in', strength, half * 0.85); this.lastBreathSound = now; }
      else if (crossed(0.5 * Math.PI)) { A.breathe('out', strength, half * 0.95); this.lastBreathSound = now; }
    }
    // the heartbeat: comes up while holding the breath, and when winded or under fire
    let h = 0;
    if (p.holdingBreath) h = clamp((p.holdT - 0.6) / 0.8, 0, 1) * (0.35 + 0.65 * (1 - p.breath / W.holdBreathTime));
    if (winded) h = Math.max(h, 0.75);
    if (p.stress > 0.3) h = Math.max(h, p.stress * 0.9);
    if (p.fatigue > 0.6 && !p.sprinting) h = Math.max(h, (p.fatigue - 0.6) * 1.2);
    if (h > 0.04) {
      const bpm = 64 + 45 * p.fatigue + 35 * p.stress + (winded ? 28 : 0) + (p.holdingBreath ? 14 * (1 - p.breath / W.holdBreathTime) : 0);
      this.beatT -= dt;
      if (this.beatT <= 0) {
        this.beatT = 60 / bpm;
        A.heartbeat(h);
        if (p.scoped && p.holdingBreath) p.pulse(F.pulse * (0.5 + 0.5 * h));
      }
    } else this.beatT = Math.min(this.beatT, 0.25);
  }

  // The eye box and the mirage.
  _scope(dt) {
    const g = this.g, p = g.player, F = CONFIG.feel;
    const fovR = THREE.MathUtils.degToRad(Math.max(1, p.fov));
    const dyaw = p.yaw - this.lastYaw, dpitch = p.pitch - this.lastPitch;
    this.lastYaw = p.yaw;
    this.lastPitch = p.pitch;
    const scoped = p.alive && p.scopeT > 0.55;
    if (!scoped) {
      this.tunnel = 1;
      this.eye.set(0, 0);
      this.mirage = 0;
      return;
    }
    // the picture opens up as the rifle settles on the cheek
    this.tunnel = Math.max(0, this.tunnel - dt / 0.22);
    // swinging the rifle: the eye lags behind the eyepiece (screen fractions per second)
    const vx = dt > 0 ? clamp(-dyaw / fovR / dt, -6, 6) : 0;
    const vy = dt > 0 ? clamp(dpitch / fovR / dt, -6, 6) : 0;
    let tx = vx * 0.04, ty = vy * 0.04;
    // walking with the rifle up, and the recoil pushing it off the eye
    const walk = clamp(p.speed / 1.6, 0, 1);
    tx += Math.sin(g.realTime * 6.1) * 0.05 * walk;
    ty += Math.cos(g.realTime * 12.2) * 0.035 * walk;
    ty -= clamp(p.recoil / fovR, 0, 1.5) * 0.25;
    const len = Math.hypot(tx, ty), cap = 0.16;
    if (len > cap) { tx *= cap / len; ty *= cap / len; }
    const k = 1 - Math.exp(-dt * 14);
    this.eye.x = lerp(this.eye.x, tx, k);
    this.eye.y = lerp(this.eye.y, ty, k);
    // mirage: far, magnified and in the sun
    let m = 0;
    if (F.mirage && g.range) {
      const sun = g.post.sunVis ?? 1;
      m = THREE.MathUtils.smoothstep(g.range, 140, 650) * THREE.MathUtils.smoothstep(p.magnification, 3, 9) * (0.35 + 0.65 * sun);
    }
    this.mirage = lerp(this.mirage, m, 1 - Math.exp(-dt * 3));
  }

  _uniforms() {
    const g = this.g, U = g.post.uniforms, F = CONFIG.feel, p = g.player;
    U.uSuppress.value = this.suppress;
    U.uKick.value = p.scoped ? this.kick : this.kick * 0.4;
    const on = F.scopeShadow ? 1 : 0;
    U.uEye.value.set(this.eye.x * on, this.eye.y * on, this.tunnel * on);
    // crosswind seen through the scope: the wind's component across the line of sight
    const w = CONFIG.weapon.ballistics.wind;
    const cross = w.x * Math.cos(p.yaw) - w.z * Math.sin(p.yaw);
    U.uMirage.value.set(this.mirage, cross);
  }
}
