// Visual effects: muzzle flashes (HDR additive sprites + pooled point light), impact puffs,
// water splashes, tracers, and the scope glint sprites. Sprites keep a minimum angular size
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
    // tracers: thin additive quads
    this.tracers = [];
    const trGeo = new THREE.PlaneGeometry(1, 1);
    trGeo.translate(0, 0.5, 0);
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(trGeo, new THREE.MeshBasicMaterial({ color: 0xffe2b0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0, side: THREE.DoubleSide, fog: false }));
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.tracers.push({ m, t: 0, life: 0 });
    }
    this.trNext = 0;
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

  impact(pos, kind, normal) {
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

  tracer(from, to) {
    const mode = CONFIG.weapon.tracers;
    if (mode === 'off') return;
    const tr = this.tracers[this.trNext];
    this.trNext = (this.trNext + 1) % this.tracers.length;
    tr.from = from.clone();
    tr.to = to.clone();
    tr.t = 0;
    tr.life = mode === 'bright' ? 0.35 : 0.18;
    tr.opacity = mode === 'bright' ? 0.9 : CONFIG.weapon.tracerOpacity;
    tr.m.visible = true;
  }

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
    for (const tr of this.tracers) {
      if (!tr.m.visible) continue;
      tr.t += dt;
      const k = tr.t / tr.life;
      if (k >= 1) { tr.m.visible = false; continue; }
      // a streak that travels along the path
      const len = tr.from.distanceTo(tr.to);
      const head = Math.min(1, k * 2.2);
      const tail = Math.max(0, head - Math.min(0.35, 40 / Math.max(len, 1)));
      const a = this._v.copy(tr.from).lerp(tr.to, tail);
      const b = new THREE.Vector3().copy(tr.from).lerp(tr.to, head);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const dir = b.clone().sub(a);
      const L = dir.length();
      tr.m.position.copy(a);
      // orient quad: Y along the path, face the camera
      const yAxis = dir.normalize();
      const toCam = cam.clone().sub(mid).normalize();
      const xAxis = new THREE.Vector3().crossVectors(yAxis, toCam).normalize();
      const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis);
      const width = Math.max(0.012, cam.distanceTo(mid) * 0.0012 * fovScale);
      tr.m.matrix.makeBasis(xAxis.multiplyScalar(width), yAxis.multiplyScalar(L), zAxis);
      tr.m.matrix.setPosition(a);
      tr.m.matrixAutoUpdate = false;
      tr.m.matrixWorldNeedsUpdate = true;
      tr.m.material.opacity = tr.opacity * (1 - k);
    }
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
