// Crow flocks perched in tree clusters. A flock flushes when anyone comes within
// flushBase + speed * flushSpeedMul metres, when a shot is fired within shotFlushRadius,
// or when a bullet lands within impactFlushRadius. Flushed birds rise, circle for ~8 s,
// drift, and resettle after ~25 s. Motion is analytic per bird (no physics); wing flap is
// done in the vertex shader. Each flush emits a 'birds' reveal event and spatialised caws.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { RNG, clamp, lerp } from './noise.js';
import { SHARED } from './shaders.js';

function buildCrowGeometry() {
  // body (elongated diamond), wings (two flat quads split at the elbow), tail
  const pos = [], wing = [], idx = [];
  const v = (x, y, z, w) => { pos.push(x, y, z); wing.push(w); return pos.length / 3 - 1; };
  // body along -Z (forward)
  const L = 0.5, W = 0.09, H = 0.08;
  const nose = v(0, 0, -L * 0.55, 0), tailB = v(0, 0.01, L * 0.45, 0);
  const l = v(-W, 0, 0, 0), r = v(W, 0, 0, 0), t = v(0, H, -0.02, 0), b = v(0, -H * 0.8, 0, 0);
  for (const [a, c] of [[l, t], [t, r], [r, b], [b, l]]) { idx.push(nose, a, c); idx.push(tailB, c, a); }
  // head bump
  const hd = v(0, H * 0.9, -L * 0.42, 0);
  idx.push(nose, l, hd, nose, hd, r);
  // wings: inner + outer segments each side; wing weight = distance factor (for flap bend)
  for (const s of [-1, 1]) {
    const i0 = v(s * 0.06, 0.02, -0.1, 0), i1 = v(s * 0.06, 0.02, 0.12, 0);
    const m0 = v(s * 0.34, 0.03, -0.09, s * 0.55), m1 = v(s * 0.34, 0.03, 0.14, s * 0.55);
    const o0 = v(s * 0.66, 0.0, 0.02, s * 1.0), o1 = v(s * 0.6, 0.0, 0.17, s * 1.0);
    if (s < 0) { idx.push(i0, m0, i1, i1, m0, m1, m0, o0, m1, m1, o0, o1); }
    else { idx.push(i0, i1, m0, i1, m1, m0, m0, m1, o0, m1, o1, o0); }
  }
  // tail fan
  const ta = v(-0.08, 0.01, L * 0.62, 0), tb = v(0.08, 0.01, L * 0.62, 0);
  idx.push(tailB, ta, tb);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const STATE = { PERCHED: 0, FLYING: 1 };

export class Birds {
  constructor(scene, forest, terrain, audio, seed) {
    this.scene = scene;
    this.terrain = terrain;
    this.audio = audio;
    this.rng = new RNG(seed + 777);
    this.flocks = [];
    this._pickFlocks(forest);
    const total = this.flocks.reduce((n, f) => n + f.birds.length, 0);
    const geo = buildCrowGeometry();
    this.flap = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3);
    this.flap.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iFlap', this.flap);
    const mat = new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide });
    mat.customProgramCacheKey = () => 'crow';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = SHARED.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aWing;\nattribute vec3 iFlap;\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  float w = aWing;
  float aw = abs(w);
  float spread = iFlap.z;
  // fold wings along the body when perched
  transformed.x = mix(transformed.x * 0.22, transformed.x, spread);
  transformed.z += (1.0 - spread) * aw * 0.12;
  float ang = sin(uTime * 13.0 + iFlap.x) * 0.95 * iFlap.y + 0.12 * spread;
  transformed.y += aw * sin(ang) * 0.62 * (0.6 + 0.4 * aw);
  transformed.x *= mix(1.0, cos(ang), aw);
}`);
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, total);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    scene.add(this.mesh);
    this.onFlush = null;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1.25, 1.25, 1.25);
    this.checkT = 0;
    this.reset(0);
  }

  _pickFlocks(forest) {
    const T = this.terrain;
    const cands = forest.trees.filter((t) => !t.outer && t.height > 9 && Math.abs(t.x) < T.halfX - 8 && Math.abs(t.z) < T.halfZ - 8);
    const nFlocks = CONFIG.birds.flocks;
    const perSide = Math.ceil(nFlocks / 2);
    let k = 0;
    for (let side = 0; side < 2 && k < nFlocks; side++) {
      for (let band = 0; band < perSide && k < nFlocks; band++) {
        const x0 = -T.halfX + ((band + 0.15) / perSide) * T.halfX * 2;
        const x1 = -T.halfX + ((band + 0.85) / perSide) * T.halfX * 2;
        const inBand = cands.filter((t) => {
          const dz = t.z - T.riverCenter(t.x);
          return t.x > x0 && t.x < x1 && (side === 0 ? dz > 25 : dz < -25) && Math.abs(dz) < 165;
        });
        if (!inBand.length) continue;
        // crows like dead snags and tall trees
        inBand.sort((a, b) => (b.variant === 'snag' ? 6 : 0) + b.height - ((a.variant === 'snag' ? 6 : 0) + a.height) + (this.rng.next() - 0.5) * 8);
        const root = inBand[Math.floor(this.rng.next() * Math.min(8, inBand.length))];
        const cluster = [root, ...inBand.filter((t) => t !== root && (t.x - root.x) ** 2 + (t.z - root.z) ** 2 < 70).slice(0, 2)];
        const n = this.rng.int(CONFIG.birds.minPerFlock, CONFIG.birds.maxPerFlock);
        const birds = [];
        for (let i = 0; i < n; i++) {
          const tr = cluster[i % cluster.length];
          // crows sit on the outside of the crown, mostly near the top
          const u = this.rng.chance(0.35) ? this.rng.float(0.93, 0.99) : this.rng.float(0.72, 0.93);
          const y = tr.y + tr.height * u;
          let r;
          if (tr.variant === 'snag') r = this.rng.float(0.2, 0.9);
          else {
            const tc = clamp((y - tr.crownBase) / (tr.crownTop - tr.crownBase), 0, 1);
            const R = tr.coreR / 0.42;
            r = R * (tr.variant === 'pine' ? Math.pow(Math.sin(Math.PI * (0.12 + 0.88 * tc)), 0.7) * (1 - 0.25 * tc) : 1 - tc) * 1.02 + 0.12;
          }
          const a = this.rng.float(0, Math.PI * 2);
          birds.push({
            perch: new THREE.Vector3(tr.x + Math.cos(a) * r, y + 0.1, tr.z + Math.sin(a) * r),
            yaw: this.rng.float(0, Math.PI * 2),
            orbitR: CONFIG.birds.circleRadius * this.rng.float(0.65, 1.35),
            orbitW: this.rng.float(0.45, 0.8) * (this.rng.chance(0.15) ? -1 : 1),
            orbitPh: this.rng.float(0, Math.PI * 2),
            hOff: this.rng.float(-4, 6),
            flapPh: this.rng.float(0, 6.28),
            delay: this.rng.float(0, 0.6),
            pos: new THREE.Vector3(), prev: new THREE.Vector3(),
          });
        }
        const center = cluster.reduce((v, t) => v.add(new THREE.Vector3(t.x, 0, t.z)), new THREE.Vector3()).divideScalar(cluster.length);
        center.y = T.heightAt(center.x, center.z);
        const top = Math.max(...birds.map((b) => b.perch.y));
        this.flocks.push({ id: k, center, top, birds, state: STATE.PERCHED, t0: -1e9, resettleAt: 0, caws: [] });
        k++;
      }
    }
  }

  reset(time) {
    for (const f of this.flocks) {
      f.state = STATE.PERCHED;
      f.t0 = -1e9;
      f.caws.length = 0;
      for (const b of f.birds) { b.pos.copy(b.perch); b.prev.copy(b.perch); }
    }
    this.time = time;
  }

  // ---------------------------------------------------------------- triggers
  flush(f, time, sourceTeam, sourceId, cause) {
    if (f.state !== STATE.PERCHED) return;
    f.state = STATE.FLYING;
    f.t0 = time;
    f.resettleAt = time + CONFIG.birds.resettleTime;
    // schedule caws over the circling period
    f.caws.length = 0;
    const n = Math.min(16, f.birds.length + 4);
    for (let i = 0; i < n; i++) f.caws.push({ at: time + (i < 4 ? this.rng.float(0, 1.2) : this.rng.float(1, CONFIG.birds.circleTime + 3)), bird: i % f.birds.length, pitch: this.rng.float(0.88, 1.12) });
    if (this.audio) this.audio.flutter(f.birds[0].perch);
    if (this.onFlush) this.onFlush(f, time, sourceTeam, sourceId, cause);
  }

  onShot(pos, time, team, id) {
    for (const f of this.flocks) {
      _v.set(f.center.x, (f.center.y + f.top) / 2, f.center.z);
      if (_v.distanceTo(pos) < CONFIG.birds.shotFlushRadius) this.flush(f, time, team, id, 'shot');
    }
  }

  onImpact(pos, time, team, id) {
    for (const f of this.flocks) {
      for (const b of f.birds) {
        if (b.perch.distanceTo(pos) < CONFIG.birds.impactFlushRadius || Math.hypot(f.center.x - pos.x, f.center.z - pos.z) < CONFIG.birds.impactFlushRadius) {
          this.flush(f, time, team, id, 'impact');
          break;
        }
      }
    }
  }

  // proximity: flushBase + speed * flushSpeedMul
  checkProximity(time, combatants) {
    const B = CONFIG.birds;
    for (const f of this.flocks) {
      for (const c of combatants) {
        if (!c.alive || c.isDummy) continue;
        const r = B.flushBase + c.speed * B.flushSpeedMul;
        const dx = c.pos.x - f.center.x, dz = c.pos.z - f.center.z;
        if (dx * dx + dz * dz < r * r) {
          if (f.state === STATE.PERCHED) this.flush(f, time, c.team, c.id, 'proximity');
          else if (time > f.resettleAt - 4) f.resettleAt = time + 10; // don't land next to someone
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------------- motion
  _flightPos(f, b, t, out) {
    const B = CONFIG.birds;
    const c = f.center;
    const H = f.top - c.y + B.circleHeight + b.hOff;
    const total = f.resettleAt - f.t0;
    const tt = Math.max(0, t - b.delay);
    // orbit (radius grows and gets higher after circleTime)
    const wander = clamp((tt - B.circleTime) / 8, 0, 1);
    const R = b.orbitR * (1 + wander * 0.7);
    const th = b.orbitPh + tt * b.orbitW;
    const ox = c.x + Math.cos(th) * R + Math.sin(tt * 0.07 + b.orbitPh) * wander * 25;
    const oz = c.z + Math.sin(th) * R + Math.cos(tt * 0.05 + b.orbitPh) * wander * 25;
    const oy = c.y + H + Math.sin(tt * 1.3 + b.flapPh) * 1.5 + wander * 8;
    // take-off: rise out of the tree, then blend into the orbit
    const rise = clamp(tt / 2.2, 0, 1);
    const e = rise * rise * (3 - 2 * rise);
    const out0x = b.perch.x + (b.perch.x - c.x) * 0.8 * e;
    const out0z = b.perch.z + (b.perch.z - c.z) * 0.8 * e;
    const out0y = b.perch.y + 9 * e;
    const k = clamp((tt - 1.0) / 2.5, 0, 1);
    const kk = k * k * (3 - 2 * k);
    out.set(lerp(out0x, ox, kk), lerp(out0y, oy, kk), lerp(out0z, oz, kk));
    // landing over the last 3.5 s
    const land = clamp((t - (total - 3.5)) / 3.5, 0, 1);
    if (land > 0) {
      const l = land * land * (3 - 2 * land);
      out.lerp(b.perch, l);
    }
    return land;
  }

  update(dt, time, combatants, camera) {
    this.checkT -= dt;
    if (this.checkT <= 0) { this.checkT = 0.1; this.checkProximity(time, combatants); }
    let i = 0;
    const F = this.flap.array;
    for (const f of this.flocks) {
      if (f.state === STATE.FLYING && time >= f.resettleAt) {
        f.state = STATE.PERCHED;
      }
      // caws
      for (let c = f.caws.length - 1; c >= 0; c--) {
        if (time >= f.caws[c].at) {
          const b = f.birds[f.caws[c].bird];
          if (this.audio) this.audio.caw(b.pos, f.caws[c].pitch);
          f.caws.splice(c, 1);
        }
      }
      for (const b of f.birds) {
        b.prev.copy(b.pos);
        let amp = 0, spread = 0, yaw = b.yaw, pitch = 0, bank = 0;
        if (f.state === STATE.FLYING) {
          const t = time - f.t0;
          const land = this._flightPos(f, b, t, b.pos);
          const vx = b.pos.x - b.prev.x, vy = b.pos.y - b.prev.y, vz = b.pos.z - b.prev.z;
          const sp = Math.hypot(vx, vz);
          if (sp > 1e-4) yaw = Math.atan2(-vx, -vz);
          pitch = Math.atan2(vy, Math.max(sp, 1e-3)) * 0.6;
          bank = -b.orbitW * 0.5;
          const climbing = vy > 0.02 || t < 3;
          amp = land > 0.85 ? 0.3 : climbing ? 1 : (Math.sin(t * 0.8 + b.flapPh) > 0.2 ? 0.9 : 0.15);
          spread = land > 0.95 ? 1 - (land - 0.95) * 20 : 1;
          if (t < b.delay) { b.pos.copy(b.perch); amp = 0; spread = 0; yaw = b.yaw; }
          b.yaw = yaw;
        } else {
          b.pos.copy(b.perch);
          // occasional fidget
          if (Math.sin(time * 0.7 + b.flapPh * 3) > 0.995) { amp = 0.6; spread = 0.7; }
        }
        this._q.setFromEuler(_e.set(pitch, yaw, bank, 'YXZ'));
        this._m.compose(b.pos, this._q, this._s);
        this.mesh.setMatrixAt(i, this._m);
        F[i * 3] = b.flapPh; F[i * 3 + 1] = amp; F[i * 3 + 2] = Math.max(0, spread);
        i++;
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.flap.needsUpdate = true;
  }

  flyingCount() { return this.flocks.filter((f) => f.state === STATE.FLYING).length; }
}

const _v = new THREE.Vector3();
const _e = new THREE.Euler();
