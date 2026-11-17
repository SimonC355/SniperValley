// Visual effects: muzzle flashes (HDR additive sprites + pooled point light), impact puffs,
// water splashes, bullet trails, and the scope glint sprites. Sprites keep a minimum angular size
// so a flash or glint stays readable at long range; they are depth-tested so trees and
// terrain hide them.
import * as THREE from 'three';
import { CONFIG } from './config.js';

function canvasTex(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export const FX_TEX = {};
function buildTextures() {
  if (FX_TEX.flash) return;
  FX_TEX.flash = canvasTex(128, (g, s) => {
    const r = s / 2;
    const grd = g.createRadialGradient(r, r, 0, r, r, r);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.28, 'rgba(255,236,190,0.95)');
    grd.addColorStop(0.55, 'rgba(255,170,70,0.4)');
    grd.addColorStop(1, 'rgba(255,120,30,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    // a few streaks
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 6; i++) {
      g.save(); g.translate(r, r); g.rotate((i / 6) * Math.PI * 2 + 0.3);
      const lg = g.createLinearGradient(0, 0, r, 0);
      lg.addColorStop(0, 'rgba(255,220,150,0.6)'); lg.addColorStop(1, 'rgba(255,200,120,0)');
      g.fillStyle = lg; g.beginPath(); g.moveTo(0, -3); g.lineTo(r * (0.6 + (i % 2) * 0.35), 0); g.lineTo(0, 3); g.fill();
      g.restore();
    }
  });
  FX_TEX.glint = canvasTex(128, (g, s) => {
    const r = s / 2;
    const grd = g.createRadialGradient(r, r, 0, r, r, r * 0.5);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,250,235,0.8)');
    grd.addColorStop(1, 'rgba(255,240,210,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    g.globalCompositeOperation = 'lighter';
    for (const [ang, len] of [[0, 1], [Math.PI / 2, 1], [Math.PI / 4, 0.45], [-Math.PI / 4, 0.45]]) {
      g.save(); g.translate(r, r); g.rotate(ang);
      const lg = g.createLinearGradient(-r * len, 0, r * len, 0);
      lg.addColorStop(0, 'rgba(255,250,230,0)'); lg.addColorStop(0.5, 'rgba(255,250,230,0.9)'); lg.addColorStop(1, 'rgba(255,250,230,0)');
      g.fillStyle = lg; g.fillRect(-r * len, -1.5, 2 * r * len, 3);
      g.restore();
    }
  });
  FX_TEX.puff = canvasTex(64, (g, s) => {
    const r = s / 2;
    const grd = g.createRadialGradient(r, r, 0, r, r, r);
    grd.addColorStop(0, 'rgba(255,255,255,0.8)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
  });
}

class SpritePool {
  constructor(scene, material, n) {
    this.items = [];
    for (let i = 0; i < n; i++) {
      const s = new THREE.Sprite(material.clone());
      s.visible = false;
      s.frustumCulled = false;
      s.renderOrder = 5;
      scene.add(s);
      this.items.push({ s, active: false });
    }
    this.next = 0;
  }
  get() {
    const it = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    it.active = true;
    it.s.visible = true;
    return it;
  }
}

// ---------------------------------------------------------------- bullet trails (v5.1)
// A thin vapour streak along the bullet's path, like the bullet trails of modern shooters. A
// bright head runs at the bullet's speed; behind it the trail lingers as a soft whitish line
// that widens, breaks up and drifts with the wind before it fades. The path is a polyline with
// the time the bullet passed each point (straight for a hitscan shot, the real arc with
// ballistics), so the shader draws the head, the fade and the "not there yet" cut from one
// clock uniform. The ribbon faces the camera and its width is kept between a minimum and a
// maximum number of pixels: a line through the scope, from the side and from behind.
const TRAIL_CAP = 256;            // points per trail (ballistics: 3 s at 60 steps per second)
const TRAIL_POOL = 16;
let TRAIL_INDEX = null;

const TRAIL_VS = /* glsl */`
attribute vec3 aDir;      // path direction at this point
attribute float aT;       // seconds after the shot when the bullet passed here
attribute float aSide;    // -1 / +1: ribbon edge
attribute float aDist;    // metres from the muzzle
uniform float uNow;
uniform float uWidth;
uniform float uSpread;
uniform float uPx;        // metres per pixel at 1 m depth
uniform vec3 uDrift;
varying float vAge;
varying float vSide;
varying float vDist;
varying float vThin;
#include <fog_pars_vertex>
void main() {
  float age = uNow - aT;
  vec3 wp = position + uDrift * max(age, 0.0);
  vec4 mvPosition = modelViewMatrix * vec4(wp, 1.0);
  vec3 t = normalize((modelViewMatrix * vec4(aDir, 0.0)).xyz);
  vec3 side = cross(t, normalize(mvPosition.xyz));
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
  float px = uPx * max(-mvPosition.z, 0.05);
  float w = uWidth + uSpread * max(age, 0.0);
  float wc = clamp(w, 1.6 * px, 7.0 * px);
  vThin = clamp(sqrt(w / wc), 0.6, 1.0);    // thinner than that: a little fainter instead
  mvPosition.xyz += side * (0.5 * wc * aSide);
  vAge = age;
  vSide = aSide;
  vDist = aDist;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const TRAIL_FS = /* glsl */`
uniform float uNow;
uniform float uLife;
uniform float uOpacity;
uniform float uHead;
uniform float uSkip;
uniform vec3 uColor;
uniform vec3 uHeadColor;
varying float vAge;
varying float vSide;
varying float vDist;
varying float vThin;
#include <fog_pars_fragment>
float th(float n) { return fract(sin(n) * 43758.5453); }
float tn(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(th(i), th(i + 1.0), f); }
void main() {
  if (vAge < 0.0 || vAge > uLife) discard;
  float k = vAge / uLife;
  float s2 = vSide * vSide;
  float across = 1.0 - s2 * s2;             // flat core, soft edges (a thin line keeps its core)
  // no smear right in front of the gun
  float muzzle = smoothstep(uSkip * 0.35, uSkip, vDist);
  // vapour: thins out with age and breaks up into wisps along the path
  float n = tn(vDist * 0.45 + vAge * 0.8) * 0.65 + tn(vDist * 1.7 - vAge * 1.3 + 7.0) * 0.35;
  float vapour = pow(1.0 - k, 1.25) * mix(1.0, smoothstep(0.2, 0.8, n), smoothstep(0.05, 0.6, k));
  float head = exp(-vAge / uHead);
  float a = (vapour * uOpacity + head * 0.85) * across * muzzle * vThin;
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(uColor, uHeadColor, head), min(a, 1.0));
  #include <fog_fragment>
}`;

class Trail {
  constructor(scene) {
    if (!TRAIL_INDEX) {
      TRAIL_INDEX = new Uint16Array((TRAIL_CAP - 1) * 6);
      for (let i = 0; i < TRAIL_CAP - 1; i++) {
        const a = i * 2;
        TRAIL_INDEX.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
      }
    }
    const V = TRAIL_CAP * 2;
    const g = new THREE.BufferGeometry();
    this.posA = new THREE.BufferAttribute(new Float32Array(V * 3), 3);
    this.dirA = new THREE.BufferAttribute(new Float32Array(V * 3), 3);
    this.tA = new THREE.BufferAttribute(new Float32Array(V), 1);
    this.distA = new THREE.BufferAttribute(new Float32Array(V), 1);
    const side = new Float32Array(V);
    for (let i = 0; i < V; i++) side[i] = i % 2 ? 1 : -1;
    for (const a of [this.posA, this.dirA, this.tA, this.distA]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posA);
    g.setAttribute('aDir', this.dirA);
    g.setAttribute('aT', this.tA);
    g.setAttribute('aDist', this.distA);
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setIndex(new THREE.BufferAttribute(TRAIL_INDEX, 1));
    g.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uNow: { value: 0 }, uLife: { value: 1.6 }, uOpacity: { value: 0.4 }, uHead: { value: 0.025 }, uSkip: { value: 1.2 },
        uWidth: { value: 0.02 }, uSpread: { value: 0.1 }, uPx: { value: 0.001 }, uDrift: { value: new THREE.Vector3() },
        uColor: { value: new THREE.Color(0.86, 0.87, 0.88) }, uHeadColor: { value: new THREE.Color(3.2, 2.9, 2.4) },
      }]),
      vertexShader: TRAIL_VS, fragmentShader: TRAIL_FS,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 4;
    scene.add(this.mesh);
    this.geo = g;
    this.n = 0;
    this.open = false;
    this.last = new THREE.Vector3();
    this.lastT = 0;
    this.dist = 0;
  }

  get active() { return this.mesh.visible; }

  start(from, t0, opacity) {
    const T = CONFIG.weapon.trail;
    this.gen = (this.gen || 0) + 1;   // a bullet still in flight checks this before adding points
    this.n = 0;
    this.dist = 0;
    this.t0 = t0;
    this.open = true;
    const u = this.mat.uniforms;
    u.uNow.value = 0;
    u.uLife.value = T.life;
    u.uOpacity.value = opacity;
    u.uHead.value = T.headTime;
    u.uWidth.value = T.width;
    u.uSpread.value = T.spread;
    const W = CONFIG.weapon.ballistics.wind;
    u.uDrift.value.set(W.x * T.drift, 0.06, W.z * T.drift);
    this.geo.setDrawRange(0, 0);
    this.mesh.visible = true;
    this.add(from, 0);
  }

  // The bullet passed p, t seconds after the shot.
  add(p, t) {
    if (!this.open || this.n >= TRAIL_CAP) return;
    const i = this.n;
    if (i > 0) {
      const d = p.distanceTo(this.last);
      if (d < 1e-4) return;
      this.dist += d;
      const dx = (p.x - this.last.x) / d, dy = (p.y - this.last.y) / d, dz = (p.z - this.last.z) / d;
      for (let k = 0; k < 2; k++) this.dirA.setXYZ(i * 2 + k, dx, dy, dz);
      if (i === 1) for (let k = 0; k < 2; k++) this.dirA.setXYZ(k, dx, dy, dz);
    }
    for (let k = 0; k < 2; k++) {
      this.posA.setXYZ(i * 2 + k, p.x, p.y, p.z);
      this.tA.setX(i * 2 + k, t);
      this.distA.setX(i * 2 + k, this.dist);
    }
    this.last.copy(p);
    this.lastT = t;
    this.n++;
    for (const a of [this.posA, this.dirA, this.tA, this.distA]) a.needsUpdate = true;
    this.geo.setDrawRange(0, Math.max(0, this.n - 1) * 6);
  }

  close() { this.open = false; }

  update(clock, camera, viewH) {
    const now = clock - this.t0;
    const u = this.mat.uniforms;
    u.uNow.value = now;
    u.uPx.value = 2 / (camera.projectionMatrix.elements[5] * Math.max(1, viewH));
    if (!this.open && now > this.lastT + u.uLife.value) { this.mesh.visible = false; this.n = 0; }
    else if (this.open && now > 6) this.open = false;   // a ballistic trail nobody closed
  }
}

export class Effects {
  constructor(scene, vmScene) {
    buildTextures();
    this.scene = scene;
    const flashMat = new THREE.SpriteMaterial({ map: FX_TEX.flash, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false, transparent: true });
    this.flashes = new SpritePool(scene, flashMat, 12);
    const puffMat = new THREE.SpriteMaterial({ map: FX_TEX.puff, depthWrite: false, transparent: true, fog: true });
    this.puffs = new SpritePool(scene, puffMat, 40);
    this.light = new THREE.PointLight(0xffc27a, 0, 30, 2);
    scene.add(this.light);
    this.lightT = 0;
    // bullet trails
    this.trails = [];
    for (let i = 0; i < TRAIL_POOL; i++) this.trails.push(new Trail(scene));
    this.trNext = 0;
    this.clock = 0;
    this.pending = [];   // delayed impacts
    this.active = [];
    this._v = new THREE.Vector3();
  }

  // World-space muzzle flash (seen by others / third person).
  muzzleFlash(pos) {
    const it = this.flashes.get();
    it.pos = pos.clone();
    it.t = 0;
    it.life = CONFIG.reveal.flashDuration;
    it.kind = 'flash';
    it.s.position.copy(pos);
    it.s.material.rotation = Math.random() * Math.PI;
    this.active.push(it);
    this.light.position.copy(pos);
    this.light.intensity = 160;
    this.lightT = 0.07;
  }

  // delay: seconds until the puff (a hitscan bullet's trail is still on its way)
  impact(pos, kind, normal, delay = 0) {
    if (delay > 0.005) { this.pending.push({ at: this.clock + delay, pos: pos.clone(), kind, normal }); return; }
    const n = kind === 'water' ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const it = this.puffs.get();
      it.pos = pos.clone();
      it.t = 0;
      it.kind = 'puff';
      it.life = kind === 'water' ? 0.9 : 1.1;
      it.vel = new THREE.Vector3((Math.random() - 0.5) * 0.6, kind === 'water' ? 2.5 + i * 1.5 : 0.6 + Math.random() * 0.5, (Math.random() - 0.5) * 0.6);
      it.size0 = kind === 'water' ? 0.35 : 0.3;
      it.size1 = kind === 'water' ? 1.0 : 1.6;
      const col = kind === 'water' ? [0.75, 0.8, 0.82] : kind === 'tree' ? [0.36, 0.26, 0.17] : kind === 'rock' ? [0.45, 0.43, 0.4] : kind === 'body' ? [0.28, 0.05, 0.04] : [0.32, 0.26, 0.19];
      it.s.material.color.setRGB(col[0], col[1], col[2]);
      it.s.material.opacity = 0.85;
      it.s.position.copy(pos);
      this.active.push(it);
    }
  }

  // A trail for a new bullet from `from`. own: the shooter is this player (a clear trail);
  // others' trails are fainter unless the setting is 'bright'. Returns the trail (add points
  // with trail.add(p, secondsAfterShot), then trail.close()), or null with trails off.
  startTrail(from, own) {
    const mode = CONFIG.weapon.tracers;
    if (mode === 'off') return null;
    const T = CONFIG.weapon.trail;
    // your own trail starts where your rifle's muzzle is drawn (main.js), not 6 cm under your eye
    if (own && this.ownTrailStart) from = this.ownTrailStart(from) || from;
    // the next free trail; with all of them still fading, the oldest
    const N = this.trails.length;
    let idx = this.trNext;
    for (let i = 0; i < N; i++) {
      const j = (this.trNext + i) % N;
      if (!this.trails[j].active) { idx = j; break; }
    }
    const tr = this.trails[idx];
    this.trNext = (idx + 1) % N;
    tr.start(from, this.clock, mode === 'bright' ? T.brightOpacity : own ? T.opacity : T.othersOpacity);
    return tr;
  }

  // A straight (hitscan) shot: the head runs to `to` at bullet speed, in at most 0.25 s (the hit
  // itself is instant; combat.js delays the impact puff to the head's arrival).
  bulletTrail(from, to, own) {
    const tr = this.startTrail(from, own);
    if (!tr) return null;
    from = tr.last.clone();
    const len = from.distanceTo(to);
    const speed = Math.max(CONFIG.weapon.ballistics.muzzleVelocity, len / 0.25);
    // points every ~20 m keep the camera-facing width even along a long path
    const n = Math.min(TRAIL_CAP - 1, Math.max(1, Math.ceil(len / 20)));
    const p = new THREE.Vector3();
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      tr.add(p.copy(from).lerp(to, k), (len * k) / speed);
    }
    tr.close();
    return tr;
  }

  // older name, kept for callers that only know the end points
  tracer(from, to, own = false) { return this.bulletTrail(from, to, own); }

  update(dt, camera) {
    dt *= this.timeScale ?? 1; // test hook: 0 freezes effects
    const cam = camera.position;
    const fovScale = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.tan(THREE.MathUtils.degToRad(35));
    for (let i = this.active.length - 1; i >= 0; i--) {
      const it = this.active[i];
      it.t += dt;
      const k = it.t / it.life;
      if (k >= 1) {
        it.active = false;
        it.s.visible = false;
        this.active.splice(i, 1);
        continue;
      }
      const d = cam.distanceTo(it.s.position);
      if (it.kind === 'flash') {
        // bright core that decays fast, minimum angular size so it reads at 400 m
        const env = Math.pow(1 - k, 2.2);
        const atten = Math.exp(-d * 0.0012) * (d > CONFIG.reveal.flashRange ? 0 : 1);
        const size = Math.max(0.9, d * CONFIG.reveal.flashSize * fovScale) * (0.8 + 0.4 * env);
        it.s.scale.setScalar(size);
        const I = CONFIG.reveal.flashIntensity * env * atten;
        it.s.material.color.setRGB(I, I * 0.85, I * 0.6);
      } else {
        it.vel.y -= (it.kind === 'puff' && it.vel.y > 1.5 ? 6 : 0.3) * dt;
        it.s.position.addScaledVector(it.vel, dt);
        const size = THREE.MathUtils.lerp(it.size0, it.size1, Math.sqrt(k));
        it.s.scale.setScalar(Math.max(size, d * 0.004 * fovScale));
        it.s.material.opacity = 0.75 * (1 - k);
      }
    }
    if (this.lightT > 0) {
      this.lightT -= dt;
      if (this.lightT <= 0) this.light.intensity = 0;
    }
    this.clock += dt;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const q = this.pending[i];
      if (this.clock >= q.at) { this.pending.splice(i, 1); this.impact(q.pos, q.kind, q.normal); }
    }
    const viewH = (typeof window !== 'undefined' && window.innerHeight) || 720;
    for (const tr of this.trails) if (tr.active) tr.update(this.clock, camera, viewH);
  }
}

// Persistent glint sprite for one character's scope.
export class GlintSprite {
  constructor(scene) {
    buildTextures();
    this.s = new THREE.Sprite(new THREE.SpriteMaterial({ map: FX_TEX.glint, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false, transparent: true }));
    this.s.visible = false;
    this.s.frustumCulled = false;
    this.s.renderOrder = 6;
    scene.add(this.s);
  }

  // intensity 0..1 toward this viewer
  set(pos, intensity, camera, time) {
    if (intensity <= 0.001) { this.s.visible = false; return; }
    const d = camera.position.distanceTo(pos);
    const fovScale = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.tan(THREE.MathUtils.degToRad(35));
    // offset toward the viewer so the character's own suit doesn't occlude it
    this.s.position.copy(pos).addScaledVector(_dir.subVectors(camera.position, pos).normalize(), 0.3);
    const flicker = 0.85 + 0.15 * Math.sin(time * 23.0 + pos.x) * Math.sin(time * 7.3);
    const size = Math.max(0.25, d * CONFIG.reveal.glintSize * Math.max(fovScale, 0.35)) * (0.6 + 0.6 * intensity);
    this.s.scale.setScalar(size);
    const I = CONFIG.reveal.glintIntensity * intensity * flicker * Math.exp(-d * 0.0008);
    this.s.material.color.setRGB(I, I * 0.97, I * 0.88);
    this.s.material.rotation = 0.2;
    this.s.visible = true;
  }

  hide() { this.s.visible = false; }
}
const _dir = new THREE.Vector3();
