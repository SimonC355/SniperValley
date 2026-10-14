// Shrinking playable area. Every `interval` seconds the zone steps down through
// CONFIG.zone.steps: hold -> warning (HUD countdown + marked next line) -> smooth shrink.
// Modes: 'ends' closes from the valley ends (both slopes and the cross-valley duel survive),
// 'radial' closes a circle toward the water. Damage outside grows per step.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { ZONE_UNIFORMS } from './terrain.js';

function curtainTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 128, 0, 0);
  grd.addColorStop(0, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.15, 'rgba(255,255,255,0.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 4, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Zone {
  constructor(scene, terrain) {
    this.terrain = terrain;
    this.halfLen = CONFIG.map.length / 2;
    this.halfWid = CONFIG.map.width / 2;
    this.center = new THREE.Vector2(0, terrain.riverCenter(0));
    this.radius0 = Math.hypot(this.halfLen, this.halfWid + Math.abs(this.center.y)) + 2;
    ZONE_UNIFORMS.uZoneCenter.value.copy(this.center);
    ZONE_UNIFORMS.uZoneRadius.value = this.radius0;
    ZONE_UNIFORMS.uZoneHalfLen.value = this.halfLen;
    const tex = curtainTexture();
    const mk = (color) => {
      const m = new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true, opacity: 0.5 });
      return m;
    };
    this.curMat = mk(new THREE.Color(1.0, 0.42, 0.12));
    this.nextMat = mk(new THREE.Color(1.0, 1.0, 0.92));
    // curtains follow the terrain profile along the boundary (rebuilt every frame)
    this.curStrip = this._makeStrip(this.curMat, 320);
    this.nextStrip = this._makeStrip(this.nextMat, 320);
    scene.add(this.curStrip.mesh, this.nextStrip.mesh);
    this._lastNext = -1;
    this.reset();
  }

  get mode() { return CONFIG.zone.mode; }

  _makeStrip(mat, cols) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(cols * 2 * 3);
    const uv = new Float32Array(cols * 2 * 2);
    for (let i = 0; i < cols; i++) { uv[i * 4] = i; uv[i * 4 + 1] = 0; uv[i * 4 + 2] = i; uv[i * 4 + 3] = 1; }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex([]);
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    return { mesh, g, cols };
  }

  // Fill a strip with boundary points [[x,z],...] split into runs (breaks between runs).
  _fillStrip(strip, runs) {
    const T = this.terrain;
    const pos = strip.g.attributes.position.array;
    const idx = [];
    let c = 0;
    for (const run of runs) {
      const start = c;
      for (const [x, z] of run) {
        if (c >= strip.cols) break;
        const h = T.heightAt(x, z);
        pos[c * 6] = x; pos[c * 6 + 1] = h - 2; pos[c * 6 + 2] = z;
        pos[c * 6 + 3] = x; pos[c * 6 + 4] = h + 24; pos[c * 6 + 5] = z;
        if (c > start) { const a = (c - 1) * 2, b = c * 2; idx.push(a, b, a + 1, a + 1, b, b + 1); }
        c++;
      }
    }
    strip.g.setIndex(idx);
    strip.g.attributes.position.needsUpdate = true;
  }

  _boundaryRuns(f) {
    const runs = [];
    if (this.mode === 'radial') {
      const R = this.radius0 * f;
      let run = [];
      const n = 300;
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        const x = this.center.x + Math.cos(a) * R, z = this.center.y + Math.sin(a) * R;
        if (Math.abs(x) <= this.halfLen && Math.abs(z) <= this.halfWid) run.push([x, z]);
        else if (run.length) { runs.push(run); run = []; }
      }
      if (run.length) runs.push(run);
    } else {
      for (const s of [-1, 1]) {
        const run = [];
        const x = s * this.halfLen * f;
        for (let k = 0; k <= 150; k++) run.push([x, -this.halfWid + (k / 150) * this.halfWid * 2]);
        runs.push(run);
      }
    }
    return runs;
  }

  // shrink = false (team deathmatch): the zone stays open all match
  reset(shrink = true) {
    const Z = CONFIG.zone;
    this.steps = shrink ? Z.steps : [1];
    this.stepIndex = 0;            // index of the current (completed) step
    this.current = this.steps[0];
    this.target = this.steps[Math.min(1, this.steps.length - 1)];
    this.phase = this.steps.length > 1 ? 'hold' : 'final';
    this.phaseStart = 0;
    this.phaseLen = Math.max(0, Z.interval - Z.warning - Z.shrink);
    this.shrinkFrom = this.current;
    this.time = 0;
    ZONE_UNIFORMS.uZoneMode.value = this.mode === 'radial' ? 1 : 0;
    this._apply();
  }

  _enter(phase, time) {
    const Z = CONFIG.zone;
    this.phase = phase;
    this.phaseStart = time;
    this.phaseLen = phase === 'hold' ? Math.max(0, Z.interval - Z.warning - Z.shrink) : phase === 'warn' ? Z.warning : phase === 'shrink' ? Z.shrink : Infinity;
    if (phase === 'shrink') this.shrinkFrom = this.current;
    if (this.onPhase) this.onPhase(phase);
  }

  _completeStep(time) {
    this.stepIndex++;
    this.current = this.steps[this.stepIndex];
    if (this.stepIndex + 1 < this.steps.length) {
      this.target = this.steps[this.stepIndex + 1];
      this._enter('hold', time);
    } else {
      this.target = this.current;
      this._enter('final', time);
    }
  }

  // Debug (T): finish the current step now and start the next warning.
  // Network sync (the host's zone is authoritative).
  getState() {
    return [this.stepIndex, this.phase, Math.round(this.phaseStart * 1000) / 1000, this.phaseLen === Infinity ? -1 : this.phaseLen,
      this.current, this.target, this.shrinkFrom];
  }

  setState(s) {
    const phaseChanged = s[1] !== this.phase;
    [this.stepIndex, this.phase, this.phaseStart] = s;
    this.phaseLen = s[3] < 0 ? Infinity : s[3];
    this.current = s[4]; this.target = s[5]; this.shrinkFrom = s[6];
    if (phaseChanged && this.onPhase) this.onPhase(this.phase);
  }

  skip(time) {
    if (this.phase === 'final') return;
    this.current = this.target;
    this.stepIndex++;
    if (this.stepIndex + 1 < this.steps.length) {
      this.target = this.steps[this.stepIndex + 1];
      this._enter('warn', time);
    } else {
      this.target = this.current;
      this._enter('final', time);
    }
    this._apply();
  }

  update(dt, time) {
    this.time = time;
    const t = time - this.phaseStart;
    if (this.phase === 'hold' && t >= this.phaseLen) this._enter('warn', time);
    else if (this.phase === 'warn' && t >= this.phaseLen) this._enter('shrink', time);
    else if (this.phase === 'shrink') {
      const k = Math.min(1, t / this.phaseLen);
      const e = k * k * (3 - 2 * k);
      this.current = this.shrinkFrom + (this.target - this.shrinkFrom) * e;
      if (k >= 1) this._completeStep(time);
    }
    this._apply();
  }

  timeLeft() {
    if (this.phase === 'final') return 0;
    const t = this.time - this.phaseStart;
    if (this.phase === 'hold') return this.phaseLen - t + CONFIG.zone.warning;
    return this.phaseLen - t;
  }

  hudState() {
    return { phase: this.phase, timeLeft: this.timeLeft(), step: this.stepIndex, steps: this.steps.length };
  }

  // signed distance to the boundary of zone factor f (negative inside)
  signedDist(x, z, f = this.current) {
    if (this.mode === 'radial') return Math.hypot(x - this.center.x, z - this.center.y) - this.radius0 * f;
    return Math.abs(x) - this.halfLen * f;
  }

  // inside the current zone (or, with next = true during warn/shrink, the upcoming zone)
  contains(x, z, margin = 0, next = false) {
    const f = next && (this.phase === 'warn' || this.phase === 'shrink') ? this.target : this.current;
    return this.signedDist(x, z, f) <= -margin;
  }

  damagePerSecond() {
    const d = CONFIG.zone.damage;
    return d[Math.min(this.stepIndex, d.length - 1)];
  }

  _apply() {
    const U = ZONE_UNIFORMS;
    U.uZoneMode.value = this.mode === 'radial' ? 1 : 0;
    U.uZoneCur.value = this.current;
    U.uZoneNext.value = this.target;
    const warnVis = this.phase === 'warn' || this.phase === 'shrink' ? 1 : 0;
    const blink = this.phase === 'warn' ? 0.55 + 0.45 * Math.sin(this.time * 8) : 1;
    U.uZoneWarn.value = warnVis * blink;
    const atStart = this.current >= 0.999;
    this.curStrip.mesh.visible = !atStart;
    if (!atStart && (this._lastCur !== this.current || this._lastCurMode !== this.mode)) {
      this._fillStrip(this.curStrip, this._boundaryRuns(this.current));
      this._lastCur = this.current;
      this._lastCurMode = this.mode;
    }
    const showNext = warnVis > 0 && this.target < this.current - 1e-3;
    this.nextStrip.mesh.visible = showNext;
    if (showNext && (this._lastNext !== this.target || this._lastMode !== this.mode)) {
      this._fillStrip(this.nextStrip, this._boundaryRuns(this.target));
      this._lastNext = this.target;
      this._lastMode = this.mode;
    }
    this.curMat.opacity = 0.42;
    this.nextMat.opacity = 0.35 * blink;
  }

  debugText() {
    return `${this.mode} step ${this.stepIndex + 1}/${this.steps.length} ${this.phase} f=${this.current.toFixed(2)} -> ${this.target.toFixed(2)} (${this.timeLeft().toFixed(0)}s)`;
  }
}
