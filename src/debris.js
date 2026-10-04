// Forest-floor debris: fallen logs (moss on top, one cut and one broken end), stumps and dead
// branches. Logs and stumps are cover: World turns them into colliders that stop bullets,
// block sight and block movement. Branches are visual only.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { RNG, Simplex, clamp, lerp, smoothstep } from './noise.js';

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _d = new THREE.Vector3();
const X = new THREE.Vector3(1, 0, 0);
const MOSS = [0.9, 1.4, 0.55];  // multiplies the bark texture where moss grows

// Cut-wood texture: growth rings, radial cracks, a dark bark rim at the edge.
function woodTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const rng = new RNG(4242);
  g.fillStyle = '#8a6a48';
  g.fillRect(0, 0, S, S);
  const cx = S / 2 + rng.float(-6, 6), cy = S / 2 + rng.float(-6, 6);
  for (let r = 4; r < S * 0.48; r += rng.float(2.5, 5.5)) {
    g.strokeStyle = `rgba(70, 48, 28, ${rng.float(0.25, 0.6)})`;
    g.lineWidth = rng.float(0.8, 2.2);
    g.beginPath();
    for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.08) {
      const rr = r * (1 + 0.04 * Math.sin(a * 3 + r * 0.1));
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (a === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  // weathering: grey, dark cracks
  g.fillStyle = 'rgba(120, 115, 105, 0.25)';
  g.fillRect(0, 0, S, S);
  for (let k = 0; k < 9; k++) {
    const a = rng.float(0, Math.PI * 2), l = rng.float(0.15, 0.45) * S;
    g.strokeStyle = 'rgba(30, 20, 12, 0.7)';
    g.lineWidth = rng.float(1, 2.5);
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * S * 0.47, cy + Math.sin(a) * S * 0.47);
    g.lineTo(cx + Math.cos(a + 0.05) * (S * 0.47 - l), cy + Math.sin(a + 0.05) * (S * 0.47 - l));
    g.stroke();
  }
  g.strokeStyle = '#2a1d14';
  g.lineWidth = S * 0.05;
  g.beginPath();
  g.arc(cx, cy, S * 0.475, 0, Math.PI * 2);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

class Geo {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; this.col = []; this.idx = [[], []]; }
  v(x, y, z, nx, ny, nz, u, w, c) {
    this.pos.push(x, y, z); this.nrm.push(nx, ny, nz); this.uv.push(u, w); this.col.push(c[0], c[1], c[2]);
    return this.pos.length / 3 - 1;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex([...this.idx[0], ...this.idx[1]]);
    g.addGroup(0, this.idx[0].length, 0);
    if (this.idx[1].length) g.addGroup(this.idx[0].length, this.idx[1].length, 1);
    g.computeBoundingSphere();
    return g;
  }
}

function barkColour(ny, moss, ao) {
  const m = moss * smoothstep(0.15, 0.7, ny);
  const dark = ny < -0.2 ? lerp(1, 0.55, smoothstep(-0.2, -0.8, ny)) : 1;
  return [lerp(1, MOSS[0], m) * dark * ao, lerp(1, MOSS[1], m) * dark * ao, lerp(1, MOSS[2], m) * dark * ao];
}

// A fallen log along +X from 0 to L. Group 0 = bark, group 1 = wood ends.
function buildLog(seed, L, r0) {
  const rng = new RNG(seed);
  const noise = new Simplex(seed + 9);
  const G = new Geo();
  const RAD = 8;
  const segs = Math.max(4, Math.round(L / 0.8));
  const moss = rng.float(0.35, 1);
  const bendY = rng.float(-0.06, 0.06) * L, bendZ = rng.float(-0.08, 0.08) * L;
  const ring = (t) => {
    const r = r0 * (1 - 0.28 * t);
    return { x: t * L, y: Math.sin(t * Math.PI) * bendY, z: Math.sin(t * Math.PI) * bendZ, r };
  };
  const rows = [];
  for (let j = 0; j <= segs; j++) {
    const t = j / segs;
    const c = ring(t);
    const row = [];
    for (let i = 0; i <= RAD; i++) {
      const a = (i / RAD) * Math.PI * 2;
      const ny = Math.cos(a), nz = Math.sin(a);
      const bump = 1 + 0.07 * noise.noise2(t * L * 1.3, i % RAD) + 0.03 * Math.sin(a * 5 + t * 9);
      const rr = c.r * bump;
      const mossN = moss * clamp(0.6 + 0.6 * noise.noise2(t * L * 0.5 + 20, a), 0, 1);
      row.push(G.v(c.x, c.y + ny * rr, c.z + nz * rr, 0, ny, nz, (i / RAD) * 2, t * L / 1.1, barkColour(ny, mossN, 1)));
    }
    rows.push(row);
  }
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < RAD; i++) {
      const a = rows[j][i], b = rows[j][i + 1], c = rows[j + 1][i], d = rows[j + 1][i + 1];
      G.idx[0].push(a, b, c, b, d, c);
    }
  }
  // cut end at t=0 (flat), broken end at t=1 (jagged splinters)
  for (const end of [0, 1]) {
    const c = ring(end);
    const nx = end === 0 ? -1 : 1;
    const centre = G.v(c.x + (end ? c.r * rng.float(0.3, 0.7) : 0), c.y, c.z, nx, 0, 0, 0.5, 0.5, [1, 1, 1]);
    const rim = [];
    for (let i = 0; i <= RAD; i++) {
      const a = (i / RAD) * Math.PI * 2;
      const ny = Math.cos(a), nz = Math.sin(a);
      const jag = end ? c.r * (i % 2 ? rng.float(0.15, 0.6) : rng.float(-0.05, 0.1)) : 0;
      rim.push(G.v(c.x + jag, c.y + ny * c.r * 0.98, c.z + nz * c.r * 0.98, nx, ny * 0.2, nz * 0.2, 0.5 + ny * 0.48, 0.5 + nz * 0.48, [1, 1, 1]));
    }
    for (let i = 0; i < RAD; i++) {
      if (end === 0) G.idx[1].push(centre, rim[i + 1], rim[i]);
      else G.idx[1].push(centre, rim[i], rim[i + 1]);
    }
  }
  const geo = G.build();
  geo.computeVertexNormals();
  return geo;
}

// A stump standing on y=0. Group 0 = bark (with flared roots), group 1 = the cut top.
function buildStump(seed, H, r0) {
  const rng = new RNG(seed);
  const noise = new Simplex(seed + 3);
  const G = new Geo();
  const RAD = 10, ROWS = 5;
  const lobes = rng.int(4, 6), lobePhase = rng.float(0, 6.28);
  const tilt = rng.float(0, 6.28), tiltAmt = rng.float(0.02, 0.12);
  const topY = (a) => H + Math.cos(a - tilt) * tiltAmt;
  const rows = [];
  for (let j = 0; j <= ROWS; j++) {
    const t = j / ROWS;
    const row = [];
    for (let i = 0; i <= RAD; i++) {
      const a = (i / RAD) * Math.PI * 2;
      const y = lerp(-0.25, topY(a), t);
      const root = Math.max(0, Math.cos(a * lobes + lobePhase)) * 0.55 * Math.exp(-Math.max(0, y) * 5);
      const r = r0 * (1 + 0.5 * Math.exp(-Math.max(0, y) * 4) + root) * (1 + 0.05 * noise.noise2(a * 2, y * 3));
      const ao = lerp(0.6, 1, smoothstep(-0.1, 0.4, y));
      row.push(G.v(Math.cos(a) * r, y, Math.sin(a) * r, Math.cos(a), 0.1, Math.sin(a), (i / RAD) * 2, y / 1.1, barkColour(0, 0, ao)));
    }
    rows.push(row);
  }
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < RAD; i++) {
      const a = rows[j][i], b = rows[j][i + 1], c = rows[j + 1][i], d = rows[j + 1][i + 1];
      G.idx[0].push(a, c, b, b, c, d);
    }
  }
  const centre = G.v(0, H, 0, 0, 1, 0, 0.5, 0.5, [1, 1, 1]);
  const rim = [];
  for (let i = 0; i <= RAD; i++) {
    const a = (i / RAD) * Math.PI * 2;
    const r = r0 * (1 + 0.5 * Math.exp(-H * 4)) * 0.98;
    rim.push(G.v(Math.cos(a) * r, topY(a), Math.sin(a) * r, 0, 1, 0, 0.5 + Math.cos(a) * 0.48, 0.5 + Math.sin(a) * 0.48, [1, 1, 1]));
  }
  for (let i = 0; i < RAD; i++) G.idx[1].push(centre, rim[i + 1], rim[i]);
  const geo = G.build();
  geo.computeVertexNormals();
  return geo;
}

// A dead branch lying along +X: a thin triangular stick with two side twigs.
function buildBranch(seed, L) {
  const rng = new RNG(seed);
  const G = new Geo();
  const stick = (p0, dir, len, r, side) => {
    const segs = 3, SIDES = 3;
    const up = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const b1 = new THREE.Vector3().crossVectors(dir, up).normalize();
    const b2 = new THREE.Vector3().crossVectors(b1, dir).normalize();
    const rows = [];
    for (let j = 0; j <= segs; j++) {
      const t = j / segs;
      const c = p0.clone().addScaledVector(dir, len * t).add(new THREE.Vector3(0, Math.sin(t * 3.1) * side * 0.04 * len, 0));
      const rr = r * (1 - 0.7 * t);
      const row = [];
      for (let i = 0; i <= SIDES; i++) {
        const a = (i / SIDES) * Math.PI * 2;
        const n = b1.clone().multiplyScalar(Math.cos(a)).addScaledVector(b2, Math.sin(a));
        const p = c.clone().addScaledVector(n, rr);
        row.push(G.v(p.x, p.y, p.z, n.x, n.y, n.z, i / SIDES, t * len, [0.8, 0.76, 0.72]));
      }
      rows.push(row);
    }
    for (let j = 0; j < segs; j++) for (let i = 0; i < SIDES; i++) {
      const a = rows[j][i], b = rows[j][i + 1], c = rows[j + 1][i], d = rows[j + 1][i + 1];
      G.idx[0].push(a, c, b, b, c, d);
    }
  };
  const r = rng.float(0.022, 0.045);
  stick(new THREE.Vector3(0, r, 0), new THREE.Vector3(1, 0, 0), L, r, 1);
  for (let k = 0; k < 1 + (L > 1.5 ? 1 : 0); k++) {
    const t = rng.float(0.25, 0.7);
    const a = (k ? 1 : -1) * rng.float(0.5, 1.0);
    stick(new THREE.Vector3(L * t, r, 0), new THREE.Vector3(Math.cos(a), rng.float(0.0, 0.25), Math.sin(a)).normalize(), L * rng.float(0.25, 0.45), r * 0.6, -1);
  }
  return G.build();
}

export class Debris {
  constructor(scene, terrain, forest, textures, seed) {
    const D = CONFIG.debris;
    this.terrain = terrain;
    this.forest = forest;
    this.rng = new RNG(seed + 301);
    this.logs = [];     // { a, b, r } for colliders
    this.stumps = [];   // { x, z, y, top, r }
    this.group = new THREE.Group();
    this.group.name = 'debris';
    scene.add(this.group);
    this._buildTreeGrid();

    const wood = woodTexture();
    const barkMat = new THREE.MeshStandardMaterial({ map: textures.barkSpruce.map, normalMap: textures.barkSpruce.normalMap, roughness: 0.95, vertexColors: true });
    const woodMat = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.9, vertexColors: true });
    const twigMat = new THREE.MeshStandardMaterial({ map: textures.barkSpruce.map, roughness: 0.95, vertexColors: true });
    // branches fade out (collapse) beyond ~70 m, where they would only shimmer
    twigMat.onBeforeCompile = (s) => {
      s.vertexShader = s.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
if (-mvPosition.z > 70.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);`);
    };
    twigMat.customProgramCacheKey = () => 'twig';

    // ---- logs
    const logVariants = [];
    for (let k = 0; k < 6; k++) {
      const L = lerp(3.2, 9.5, k / 5) * this.rng.float(0.9, 1.1);
      const r = lerp(0.17, 0.36, (k % 3) / 2) * this.rng.float(0.9, 1.1);
      logVariants.push({ L, r, geo: buildLog(seed + 400 + k, L, r), mats: [] });
    }
    for (let i = 0, tries = 0; i < D.logs && tries < D.logs * 40; tries++) {
      const v = logVariants[this.rng.int(0, logVariants.length - 1)];
      if (this._placeLog(v)) i++;
    }
    for (const v of logVariants) this._instanced(v.geo, [barkMat, woodMat], v.mats, true);

    // ---- stumps
    const stumpVariants = [];
    for (let k = 0; k < 3; k++) {
      const H = lerp(0.3, 0.8, k / 2), r = lerp(0.2, 0.32, this.rng.next());
      stumpVariants.push({ H, r, geo: buildStump(seed + 450 + k, H, r), mats: [] });
    }
    for (let i = 0, tries = 0; i < D.stumps && tries < D.stumps * 40; tries++) {
      const v = stumpVariants[this.rng.int(0, stumpVariants.length - 1)];
      if (this._placeStump(v)) i++;
    }
    for (const v of stumpVariants) this._instanced(v.geo, [barkMat, woodMat], v.mats, true);

    // ---- branches
    const branchVariants = [];
    for (let k = 0; k < 4; k++) branchVariants.push({ L: lerp(0.8, 2.4, k / 3), geo: buildBranch(seed + 480 + k, lerp(0.8, 2.4, k / 3)), mats: [] });
    for (let i = 0, tries = 0; i < D.branches && tries < D.branches * 20; tries++) {
      const v = branchVariants[this.rng.int(0, branchVariants.length - 1)];
      if (this._placeBranch(v)) i++;
    }
    for (const v of branchVariants) this._instanced(v.geo, twigMat, v.mats, false);
  }

  _instanced(geo, material, mats, shadows) {
    const n = mats.length / 16;
    if (!n) return;
    const m = new THREE.InstancedMesh(geo, material, n);
    m.instanceMatrix.array.set(mats);
    m.instanceMatrix.needsUpdate = true;
    m.castShadow = shadows;
    m.receiveShadow = true;
    m.computeBoundingSphere();
    this.group.add(m);
  }

  // coarse grid of tree trunks to keep debris out of them
  _buildTreeGrid() {
    this.cell = 8;
    this.grid = new Map();
    for (const t of this.forest.trees) {
      if (t.outer) continue;
      const k = `${Math.floor(t.x / this.cell)},${Math.floor(t.z / this.cell)}`;
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k).push(t);
    }
  }

  _treesNear(x, z, R) {
    const out = [];
    const i0 = Math.floor((x - R) / this.cell), i1 = Math.floor((x + R) / this.cell);
    const j0 = Math.floor((z - R) / this.cell), j1 = Math.floor((z + R) / this.cell);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const l = this.grid.get(`${i},${j}`);
      if (l) for (const t of l) if ((t.x - x) ** 2 + (t.z - z) ** 2 < R * R) out.push(t);
    }
    return out;
  }

  _spot(minDensity) {
    const M = CONFIG.map;
    const x = this.rng.float(-M.length / 2 - 8, M.length / 2 + 8);
    const z = this.rng.float(-M.width / 2 - 8, M.width / 2 + 8);
    const T = this.terrain;
    if (T.waterDepthAt(x, z) > 0 || T.heightAt(x, z) < 1.4) return null;
    const d = this.forest.density(x, z);
    if (d < minDensity || this.rng.next() > d) return null;
    if (T.normalAt(x, z).y < 0.84) return null;
    return { x, z };
  }

  _placeLog(v) {
    const p = this._spot(0.3);
    if (!p) return false;
    const T = this.terrain;
    const s = this.rng.float(0.85, 1.15);
    const L = v.L * s, r = v.r * s;
    const yaw = this.rng.float(0, Math.PI * 2);
    const dx = Math.cos(yaw), dz = Math.sin(yaw);
    const ax = p.x - dx * L / 2, az = p.z - dz * L / 2, bx = p.x + dx * L / 2, bz = p.z + dz * L / 2;
    if (!T.inPlayArea(ax, az, 1) || !T.inPlayArea(bx, bz, 1)) return false;
    // keep clear of trunks along the whole log
    for (const t of this._treesNear(p.x, p.z, L / 2 + 3)) {
      const u = clamp(((t.x - ax) * dx + (t.z - az) * dz) / L, 0, 1);
      const qx = ax + dx * L * u - t.x, qz = az + dz * L * u - t.z;
      if (qx * qx + qz * qz < (t.trunkR + r + 0.6) ** 2) return false;
    }
    for (const o of this.logs) {
      if ((o.mx - p.x) ** 2 + (o.mz - p.z) ** 2 < ((o.len + L) / 2 + 1) ** 2 * 0.5) return false;
    }
    const ya = T.heightAt(ax, az) + r * 0.55, yb = T.heightAt(bx, bz) + r * 0.55;
    // reject if the ground bulges through the middle or drops far below it
    for (const u of [0.25, 0.5, 0.75]) {
      const hm = T.heightAt(ax + dx * L * u, az + dz * L * u);
      const ym = lerp(ya, yb, u);
      if (hm > ym + r * 0.15 || hm < ym - r * 2.2) return false;
    }
    _d.set(bx - ax, yb - ya, bz - az).normalize();
    _q.setFromUnitVectors(X, _d);
    _q2.setFromAxisAngle(X, this.rng.float(0, Math.PI * 2));
    _q.multiply(_q2);
    _m.compose(_p.set(ax, ya, az), _q, _s.setScalar(s));
    v.mats.push(..._m.elements);
    this.logs.push({ a: new THREE.Vector3(ax, ya, az), b: new THREE.Vector3(bx, yb, bz), r: r * 0.95, mx: p.x, mz: p.z, len: L });
    return true;
  }

  _placeStump(v) {
    const p = this._spot(0.25);
    if (!p) return false;
    const s = this.rng.float(0.8, 1.25);
    for (const t of this._treesNear(p.x, p.z, 3)) if ((t.x - p.x) ** 2 + (t.z - p.z) ** 2 < (t.trunkR + 1.4) ** 2) return false;
    for (const o of this.logs) {
      const L = o.len, dx = (o.b.x - o.a.x) / L, dz = (o.b.z - o.a.z) / L;
      const u = clamp((p.x - o.a.x) * dx + (p.z - o.a.z) * dz, 0, L);
      if ((o.a.x + dx * u - p.x) ** 2 + (o.a.z + dz * u - p.z) ** 2 < (o.r + 1) ** 2) return false;
    }
    const y = this.terrain.heightAt(p.x, p.z);
    _q.setFromAxisAngle(_d.set(0, 1, 0), this.rng.float(0, Math.PI * 2));
    _m.compose(_p.set(p.x, y, p.z), _q, _s.setScalar(s));
    v.mats.push(..._m.elements);
    this.stumps.push({ x: p.x, z: p.z, y, top: y + v.H * s + 0.05, r: v.r * s * 1.15 });
    return true;
  }

  _placeBranch(v) {
    const p = this._spot(0.2);
    if (!p) return false;
    const T = this.terrain;
    const s = this.rng.float(0.8, 1.2);
    const L = v.L * s;
    const yaw = this.rng.float(0, Math.PI * 2);
    const ax = p.x, az = p.z, bx = p.x + Math.cos(yaw) * L, bz = p.z + Math.sin(yaw) * L;
    const ya = T.heightAt(ax, az) - 0.01, yb = T.heightAt(bx, bz) - 0.01;
    _d.set(bx - ax, yb - ya, bz - az).normalize();
    _q.setFromUnitVectors(X, _d);
    _q2.setFromAxisAngle(X, this.rng.float(-0.4, 0.4));
    _q.multiply(_q2);
    _m.compose(_p.set(ax, ya, az), _q, _s.setScalar(s));
    v.mats.push(..._m.elements);
    return true;
  }
}
