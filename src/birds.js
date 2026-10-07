// Crow flocks perched in tree clusters all over the valley (a grid of cells along the valley
// and up both slopes, each flock spread over a few neighbouring trees). A flock flushes when
// anyone comes within flushBase + speed * flushSpeedMul metres, when a shot is fired within
// shotFlushRadius, or when a bullet lands within impactFlushRadius. Flushed birds burst out of
// the crowns with wing beats and alarm caws, circle for ~8 s, drift, and resettle after ~25 s.
// Perched birds are alive too: they look around, flick their wings, hop to another branch and
// back, and now and then one calls (you can find a flock by ear). Motion is analytic per bird
// (no physics); wing flap is done in the vertex shader. Calls and hops come from the flock id
// and the game clock, so every player in a LAN game sees and hears the same ones. Each flush
// emits a 'birds' reveal event.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { RNG, clamp, lerp, hash2 } from './noise.js';
import { SHARED } from './shaders.js';

function buildCrowGeometry() {
  // body (elongated diamond), wings (two flat quads split at the elbow), tail
  const pos = [], wing = [], idx = [];
  const v = (x, y, z, w) => { pos.push(x, y, z); wing.push(w); return pos.length / 3 - 1; };
  // body along -Z (forward)
  const L = 0.5, W = 0.11, H = 0.11;
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
const CALL_SLOT = 12;    // s: a perched flock may call once per slot
const PERCH_PITCH = 0.85; // perched crows sit upright (nose up), not flat like in flight
const HOP_SLOT = 6;      // s: a perched flock may send one bird on a short hop per slot

// stateless hash -> [0,1) (deterministic from the flock, the time slot and a channel)
const h3 = (a, b, c) => hash2(Math.imul(a | 0, 1013) + (c | 0), b);
const ease = (k) => k * k * (3 - 2 * k);

export class Birds {
  constructor(scene, forest, terrain, audio, seed) {
    this.scene = scene;
    this.terrain = terrain;
    this.audio = audio;
    this.rng = new RNG(seed + 777);
    this.flocks = [];
    this.salt = 0;
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
    this.authority = true;   // false on joined LAN clients (the host decides flushes)
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1.25, 1.25, 1.25);
    this.checkT = 0;
    this.nearT = 0;
    this.reset(0);
  }

  // A perch on the outside of a crown, mostly near the top (crows like the tops of trees).
  _perch(tr) {
    const u = this.rng.chance(0.6) ? this.rng.float(0.93, 0.99) : this.rng.float(0.72, 0.93);
    const y = tr.y + tr.height * u;
    let r;
    if (tr.variant === 'snag') r = this.rng.float(0.2, 0.9);
    else {
      const tc = clamp((y - tr.crownBase) / (tr.crownTop - tr.crownBase), 0, 1);
      const R = tr.coreR / 0.42;
      r = R * (tr.variant === 'pine' ? Math.pow(Math.sin(Math.PI * (0.12 + 0.88 * tc)), 0.7) * (1 - 0.25 * tc) : 1 - tc) * 1.02 + 0.12;
    }
    const a = this.rng.float(0, Math.PI * 2);
    return new THREE.Vector3(tr.x + Math.cos(a) * r, y + 0.1, tr.z + Math.sin(a) * r);
  }

  _pickFlocks(forest) {
    const T = this.terrain;
    const B = CONFIG.birds, M = CONFIG.map;
    const cands = forest.trees.filter((t) => !t.outer && t.height > 9 && Math.abs(t.x) < T.halfX - 8 && Math.abs(t.z) < T.halfZ - 8);
    const near = M.riverShelfEnd + 8, far = M.ridgeDist - 13;
    const nFlocks = B.flocks;
    const perSide = Math.ceil(nFlocks / 2);
    // one flock per cell of a grid along the valley (cols) and up each slope (rows)
    const rows = perSide >= 9 ? 3 : 2;
    const cols = Math.ceil(perSide / rows);
    let k = 0;
    for (let side = 0; side < 2; side++) {
      let placed = 0;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          if (placed >= perSide || k >= nFlocks) continue;
          const x0 = -T.halfX + ((col + 0.08) / cols) * T.halfX * 2;
          const x1 = -T.halfX + ((col + 0.92) / cols) * T.halfX * 2;
          const z0 = near + ((row + 0.05) / rows) * (far - near);
          const z1 = near + ((row + 0.95) / rows) * (far - near);
          const inCell = cands.filter((t) => {
            const dz = (t.z - T.riverCenter(t.x)) * (side === 0 ? 1 : -1);
            return t.x > x0 && t.x < x1 && dz > z0 && dz < z1;
          });
          if (!inCell.length) continue;
          // crows like dead snags and tall trees
          inCell.sort((a, b) => (b.variant === 'snag' ? 6 : 0) + b.height - ((a.variant === 'snag' ? 6 : 0) + a.height) + (this.rng.next() - 0.5) * 8);
          const root = inCell[Math.floor(this.rng.next() * Math.min(8, inCell.length))];
          // spread over a few neighbouring trees
          const neighbours = cands.filter((t) => t !== root && (t.x - root.x) ** 2 + (t.z - root.z) ** 2 < 14 * 14)
            .sort((a, b) => ((a.x - root.x) ** 2 + (a.z - root.z) ** 2) - ((b.x - root.x) ** 2 + (b.z - root.z) ** 2));
          const cluster = [root, ...neighbours.slice(0, Math.max(0, B.treesPerFlock - 1))];
          const n = this.rng.int(B.minPerFlock, B.maxPerFlock);
          const birds = [];
          for (let i = 0; i < n; i++) {
            const perch = this._perch(cluster[i % cluster.length]);
            birds.push({
              perch,
              from: perch.clone(),
              yaw: this.rng.float(0, Math.PI * 2),
              orbitR: B.circleRadius * this.rng.float(0.65, 1.35),
              orbitW: this.rng.float(0.45, 0.8) * (this.rng.chance(0.15) ? -1 : 1),
              orbitPh: this.rng.float(0, Math.PI * 2),
              hOff: this.rng.float(-4, 6),
              flapPh: this.rng.float(0, 6.28),
              delay: this.rng.float(0, 0.6),
              turnLen: this.rng.float(2.5, 5.5),
              turnPh: this.rng.float(0, 5),
              bob: [],
              pos: new THREE.Vector3(), prev: new THREE.Vector3(),
            });
          }
          // spare branches for hops
          const spots = [];
          for (let s = 0; s < 3; s++) spots.push(this._perch(cluster[this.rng.int(0, cluster.length - 1)]));
          const center = cluster.reduce((v, t) => v.add(new THREE.Vector3(t.x, 0, t.z)), new THREE.Vector3()).divideScalar(cluster.length);
          center.y = T.heightAt(center.x, center.z);
          const top = Math.max(...birds.map((b) => b.perch.y));
          this.flocks.push({ id: k, center, top, birds, spots, state: STATE.PERCHED, t0: -1e9, resettleAt: 0, caws: [], calledSlot: -1, hopSnd: -1, landSounded: true });
          k++;
          placed++;
        }
      }
    }
  }

  // salt: the round number, so calls and hops differ between rounds (the same for everyone)
  reset(time, salt = 0) {
    this.salt = salt;
    for (const f of this.flocks) {
      f.state = STATE.PERCHED;
      f.t0 = -1e9;
      f.resettleAt = 0;
      f.caws.length = 0;
      f.calledSlot = -1;
      f.hopSnd = -1;
      f.landSounded = true;
      for (const b of f.birds) { b.pos.copy(b.perch); b.prev.copy(b.perch); b.from.copy(b.perch); b.bob.length = 0; }
    }
    this.time = time;
  }

  // ---------------------------------------------------------------- triggers
  // Network sync: the host's birds are authoritative; joined clients replay their state.
  getState() { return this.flocks.map((f) => [f.state, Math.round(f.t0 * 100) / 100, Math.round(f.resettleAt * 100) / 100]); }

  applyState(list, time) {
    list.forEach(([state, t0, resettleAt], i) => {
      const f = this.flocks[i];
      if (!f) return;
      if (state === STATE.FLYING && f.state !== STATE.FLYING) {
        this.flush(f, t0, -1, -1, 'remote', true);
      }
      if (resettleAt > f.resettleAt + 1) f.landSounded = false;   // the host postponed the landing
      f.state = state;
      f.t0 = t0;
      f.resettleAt = resettleAt;
    });
  }

  flush(f, time, sourceTeam, sourceId, cause, silentEvent = false) {
    if (f.state !== STATE.PERCHED) return;
    f.state = STATE.FLYING;
    f.t0 = time;
    f.resettleAt = time + CONFIG.birds.resettleTime;
    f.landSounded = false;
    // take off from wherever each bird is (it may be on a hop)
    for (const b of f.birds) b.from.copy(b.pos);
    // alarm caws over the circling period
    f.caws.length = 0;
    const n = Math.min(16, f.birds.length + 4);
    for (let i = 0; i < n; i++) f.caws.push({ at: time + (i < 4 ? this.rng.float(0, 1.2) : this.rng.float(1, CONFIG.birds.circleTime + 3)), bird: i % f.birds.length, pitch: this.rng.float(0.88, 1.12) });
    // the whole flock bursting out of the crowns
    if (this.audio) this.audio.wings(_v.set(f.center.x, f.top - 1, f.center.z), { birds: f.birds.length, beats: 7, rate: 3.6, branches: true });
    if (this.onFlush && !silentEvent) this.onFlush(f, time, sourceTeam, sourceId, cause);
  }

  onShot(pos, time, team, id) {
    if (!this.authority) return;
    for (const f of this.flocks) {
      _v.set(f.center.x, (f.center.y + f.top) / 2, f.center.z);
      if (_v.distanceTo(pos) < CONFIG.birds.shotFlushRadius) this.flush(f, time, team, id, 'shot');
    }
  }

  onImpact(pos, time, team, id) {
    if (!this.authority) return;
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
          else if (time > f.resettleAt - 4) { f.resettleAt = time + 10; f.landSounded = false; } // don't land next to someone
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------------- perched life
  // A perched flock calls now and then: one bird, one to three caws (quieter than the alarm).
  _perchedCall(f, time) {
    const s = Math.floor(time / CALL_SLOT);
    if (f.calledSlot === s) return;
    const id = f.id + this.salt * 131;
    if (h3(id, s, 1) > CONFIG.birds.callChance) { f.calledSlot = s; return; }
    const at = s * CALL_SLOT + h3(id, s, 2) * (CALL_SLOT - 2);
    if (time < at) return;
    f.calledSlot = s;
    if (time - at > 1) return;   // missed (paused or a long frame)
    const b = f.birds[Math.floor(h3(id, s, 3) * f.birds.length)];
    const reps = 1 + Math.floor(h3(id, s, 4) * 3);
    const gap = 0.34 + h3(id, s, 5) * 0.12;
    if (this.audio) this.audio.caw(b.pos, 0.94 + h3(id, s, 6) * 0.12, { gain: 0.6, reps, gap });
    for (let r = 0; r < reps; r++) b.bob.push(time + r * gap);
  }

  // The hop this flock makes in the current slot, if any: one bird flies to a spare branch,
  // sits there a moment and flies back.
  _hop(f, time) {
    const s = Math.floor(time / HOP_SLOT);
    const id = f.id + this.salt * 131;
    if (h3(id, s, 11) > CONFIG.birds.hopChance) return null;
    const fly = 0.8 + h3(id, s, 15) * 0.4;
    const start = s * HOP_SLOT + h3(id, s, 14) * 0.6;
    const stay = Math.min(1.6 + h3(id, s, 16) * 1.6, HOP_SLOT - 0.7 - 2 * fly);
    const t = time - start;
    if (t < 0 || t > 2 * fly + stay) return null;
    return { slot: s, bi: Math.floor(h3(id, s, 12) * f.birds.length), spot: f.spots[Math.floor(h3(id, s, 13) * f.spots.length)], t, fly, stay };
  }

  // Looking around: every few seconds a perched bird turns to a new heading.
  _turn(f, bi, b, time) {
    const id = (f.id + this.salt * 131) * 64 + bi;
    const u = (time + b.turnPh) / b.turnLen;
    const s = Math.floor(u);
    const k = Math.min(1, ((u - s) * b.turnLen) / 0.35);
    const a0 = (h3(id, s - 1, 21) - 0.5) * 2.4, a1 = (h3(id, s, 21) - 0.5) * 2.4;
    return a0 + (a1 - a0) * ease(k);
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
    const e = ease(clamp(tt / 2.2, 0, 1));
    const out0x = b.from.x + (b.from.x - c.x) * 0.8 * e;
    const out0z = b.from.z + (b.from.z - c.z) * 0.8 * e;
    const out0y = b.from.y + 9 * e;
    const kk = ease(clamp((tt - 1.0) / 2.5, 0, 1));
    out.set(lerp(out0x, ox, kk), lerp(out0y, oy, kk), lerp(out0z, oz, kk));
    // landing over the last 3.5 s
    const land = clamp((t - (total - 3.5)) / 3.5, 0, 1);
    if (land > 0) out.lerp(b.perch, ease(land));
    return land;
  }

  update(dt, time, combatants, camera) {
    this.checkT -= dt;
    if (this.checkT <= 0) { this.checkT = 0.1; if (this.authority) this.checkProximity(time, combatants); }
    // wing beats of birds flying close to the listener (checked twice a second)
    this.nearT -= dt;
    const nearCheck = this.nearT <= 0 && !!camera && !!this.audio;
    if (nearCheck) this.nearT = 0.5;
    const lp = camera ? camera.position : null;
    let i = 0;
    const F = this.flap.array;
    for (const f of this.flocks) {
      if (f.state === STATE.FLYING && time >= f.resettleAt) f.state = STATE.PERCHED;
      // settling back into the trees
      if (f.state === STATE.FLYING && !f.landSounded && time >= f.resettleAt - 1.4) {
        f.landSounded = true;
        if (this.audio) this.audio.wings(_v.set(f.center.x, f.top, f.center.z), { birds: Math.min(6, f.birds.length), beats: 2, rate: 4.5, gain: 0.5, branches: true });
      }
      // alarm caws while flushed
      for (let c = f.caws.length - 1; c >= 0; c--) {
        if (time >= f.caws[c].at) {
          const b = f.birds[f.caws[c].bird];
          if (this.audio) this.audio.caw(b.pos, f.caws[c].pitch);
          f.caws.splice(c, 1);
        }
      }
      const perched = f.state === STATE.PERCHED && time - f.resettleAt > 3;
      if (perched) this._perchedCall(f, time);
      const hop = perched ? this._hop(f, time) : null;
      if (hop && this.audio && lp) {
        // a few wing beats as the bird leaves and as it comes back (only heard close by)
        const leg = hop.t < hop.fly + hop.stay ? 0 : 1;
        const key = hop.slot * 2 + leg;
        if (f.hopSnd !== key) {
          f.hopSnd = key;
          const at = leg === 0 ? f.birds[hop.bi].perch : hop.spot;
          if (at.distanceTo(lp) < 45) this.audio.wings(at, { birds: 1, beats: 3, rate: 5, gain: 0.35 });
        }
      }
      let nearest = 1e9, nearestB = null;
      f.birds.forEach((b, bi) => {
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
          if (t < b.delay) { b.pos.copy(b.from); amp = 0; spread = 0; yaw = b.yaw; pitch = PERCH_PITCH; bank = 0; }
          b.yaw = yaw;
          if (nearCheck && amp > 0.5) {
            const d = b.pos.distanceTo(lp);
            if (d < nearest) { nearest = d; nearestB = b; }
          }
        } else if (hop && hop.bi === bi) {
          // hop: out to the spare branch, sit, and back
          const out = hop.t < hop.fly + hop.stay;
          const a = out ? b.perch : hop.spot, z = out ? hop.spot : b.perch;
          const k = clamp(out ? hop.t / hop.fly : (hop.t - hop.fly - hop.stay) / hop.fly, 0, 1);
          const flying = out ? hop.t < hop.fly : true;
          if (flying) {
            const e = ease(k);
            b.pos.lerpVectors(a, z, e);
            b.pos.y += Math.sin(Math.PI * k) * (0.5 + 0.25 * a.distanceTo(z));
            yaw = Math.atan2(-(z.x - a.x), -(z.z - a.z));
            amp = k < 0.85 ? 1 : 0.4;
            spread = k < 0.92 ? 1 : (1 - k) / 0.08;
            pitch = PERCH_PITCH * (1 - Math.sin(Math.PI * Math.min(1, k * 1.15)));
          } else {
            b.pos.copy(hop.spot);
            yaw = Math.atan2(-(hop.spot.x - b.perch.x), -(hop.spot.z - b.perch.z));
            pitch = PERCH_PITCH;
          }
        } else {
          b.pos.copy(b.perch);
          pitch = PERCH_PITCH;
          yaw = b.yaw + this._turn(f, bi, b, time);
          // occasional wing flick
          if (Math.sin(time * 0.7 + b.flapPh * 3) > 0.995) { amp = 0.6; spread = 0.7; }
          // bob with each caw
          for (let c = b.bob.length - 1; c >= 0; c--) {
            const tb = time - b.bob[c];
            if (tb > 0.3) b.bob.splice(c, 1);
            else if (tb >= 0) pitch -= Math.sin((Math.PI * tb) / 0.3) * 0.5;
          }
        }
        this._q.setFromEuler(_e.set(pitch, yaw, bank, 'YXZ'));
        // an upright bird's tail hangs below its centre: lift it onto the branch
        this._p.copy(b.pos);
        this._p.y += Math.max(0, pitch) * 0.2;
        this._m.compose(this._p, this._q, this._s);
        this.mesh.setMatrixAt(i, this._m);
        F[i * 3] = b.flapPh; F[i * 3 + 1] = amp; F[i * 3 + 2] = Math.max(0, spread);
        i++;
      });
      if (nearestB && nearest < 28 && Math.random() < 0.45) {
        this.audio.wings(nearestB.pos, { birds: 1, beats: 3, rate: 4, gain: 0.5 });
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.flap.needsUpdate = true;
  }

  flyingCount() { return this.flocks.filter((f) => f.state === STATE.FLYING).length; }
}

const _v = new THREE.Vector3();
const _e = new THREE.Euler();
