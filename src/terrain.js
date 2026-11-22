// Terrain: analytic V-valley heightfield, baked height grid for fast queries,
// warped-grid mesh and a splatting material (grass / forest floor / rock / mud),
// plus the shrinking-zone line overlay. Since v5.1 every map ends in a ring of steep mountains
// right at the edge of the play area (see _rim), so nothing but mountain and sky shows beyond.
import * as THREE from 'three';
import { sunDirection } from './shaders.js';
import { CONFIG } from './config.js';
import { Simplex, clamp, lerp, smoothstep } from './noise.js';

export const ZONE_UNIFORMS = {
  uZoneMode: { value: 0 },          // 0 = ends, 1 = radial
  uZoneCur: { value: 1 },
  uZoneNext: { value: 1 },
  uZoneWarn: { value: 0 },          // 0..1: next line visibility
  uZoneHalfLen: { value: CONFIG.map.length / 2 },
  uZoneRadius: { value: 300 },
  uZoneCenter: { value: new THREE.Vector2() },
};

function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

export class Terrain {
  constructor(seed) {
    this.noise = new Simplex(seed);
    this.noise2 = new Simplex(seed + 101);
    const M = CONFIG.map;
    this.halfX = M.length / 2;
    this.halfZ = M.width / 2;
    // the mountain ring: crest height above the ground at the edge, horizontal distance from
    // the edge to the crest, and the lowest base it rises from (so the valley ends, where the
    // river runs out, get as high a wall as the ridges)
    const H = M.rimHeight ?? clamp(0.21 * M.width, 30, 70);
    this.rim = { H, L: H * 0.6, floor: 0.8 * Math.max(M.ridgeHeightNorth, M.ridgeHeightSouth) };
    // baked grid covers the play area plus margin at 1 m resolution
    this.gMinX = -this.halfX - 80;
    this.gMinZ = -this.halfZ - 70;
    this.gW = Math.round(M.length + 160) + 1;
    this.gH = Math.round(M.width + 140) + 1;
    this.grid = new Float32Array(this.gW * this.gH);
    for (let j = 0; j < this.gH; j++) {
      const z = this.gMinZ + j;
      for (let i = 0; i < this.gW; i++) {
        this.grid[j * this.gW + i] = this.heightAnalytic(this.gMinX + i, z);
      }
    }
    this.splatData = new Uint8Array(this.gW * this.gH * 4);
    // areas kept clear of trees, rocks, bushes and debris (buildings; see reserve())
    this.reserved = [];
  }

  // Keep a circle clear of trees, rocks, bushes and debris (buildings call this).
  reserve(x, z, r) { this.reserved.push({ x, z, r }); }

  // Is (x, z) free of buildings (with margin) and inside the play area, away from its edge?
  isFree(x, z, margin = 0) {
    for (const c of this.reserved) {
      const rr = c.r + margin;
      if ((x - c.x) ** 2 + (z - c.z) ** 2 < rr * rr) return false;
    }
    // nothing on the mountains, and a clear strip at their foot so the edge reads from afar
    return this.edgeDist(x, z) < -(2.5 + margin);
  }

  // Signed distance (m) to the edge of the play area: negative inside, positive outside.
  edgeDist(x, z) {
    const ex = Math.abs(x) - this.halfX, ez = Math.abs(z) - this.halfZ;
    return Math.hypot(Math.max(ex, 0), Math.max(ez, 0)) + Math.min(Math.max(ex, ez), 0);
  }

  // The mountains around the play area: from the edge the ground rises as a steep rock wall
  // (steepest at the foot, rounding off at a jagged crest well above anything inside), then
  // keeps climbing slowly behind it. h: the valley's own height here.
  _rim(x, z, h) {
    let o = this.edgeDist(x, z);
    if (o <= 0) return h;
    const R = this.rim, n = this.noise2;
    let bay = 0;
    if (CONFIG.map.style !== 'stylized') {
      // bays: here and there the wall leans back above its foot, up to 1.7 times as long a climb
      // to the crest, so the crest line wanders (one straight wall across the whole valley read
      // as a curtain). The foot is as steep as before: the ground still rises right at the edge.
      const sA = Math.abs(x) - this.halfX > Math.abs(z) - this.halfZ ? z : x;
      const side = (x > 0 ? 31 : -31) + (z > 0 ? 7 : -7);
      bay = smoothstep(-0.1, 0.5, n.fbm2(sA * 0.009 + side, side * 0.37, 2));
      // the river's gorge: at both ends of the valley the river comes out of a winding canyon
      // that closes a hundred metres or so in
      let gorge = 0;
      if (Math.abs(x) > this.halfX - 5) {
        const W = (CONFIG.map.riverShelfEnd || 15) + 6, dz = z - this.riverCenter(x);
        gorge = Math.exp(-(dz * dz) / (W * W)) * (1 - smoothstep(R.L * 2.5, R.L * 5, o));
      }
      o *= 1 - gorge;
      if (o <= 0) return h;
    }
    const uS = Math.min(1, o / R.L), uB = Math.min(1, o / (R.L * 1.7)), w = bay * smoothstep(6, 30, o);
    const u = lerp(uS, uB, w);
    const f = lerp(1 - Math.pow(1 - uS, 2.5), 1 - Math.pow(1 - uB, 2.5), w);
    // peaks and saddles along the crest
    const peak = clamp(0.8 + 0.45 * n.fbm2(x * 0.011 + 3.1, z * 0.011 - 7.7, 3), 0.55, 1.3);
    const top = Math.max(h, R.floor) + R.H * peak;
    let hr = lerp(h, top, f);
    // rock buttresses and gullies on the face, a mountain mass behind the crest
    const face = Math.sin(Math.PI * Math.min(1, u * 1.2));
    hr += n.fbm2(x * 0.07, z * 0.07, 3) * 3.2 * face;
    if (CONFIG.map.style !== 'stylized') {
      // couloirs: narrow channels cut back into the wall every 20-30 m, ribs of rock between
      const sAlong = Math.abs(x) - this.halfX > Math.abs(z) - this.halfZ ? z : x;
      const g = n.fbm2(sAlong * 0.04 + 5.3, (x > 0 ? 1 : -1) * 17 + (z > 0 ? 3 : -3), 2);
      const couloir = Math.pow(Math.max(0, 1 - Math.abs(g) * 4), 2);
      hr -= couloir * (4 + 3 * u) * face;
      hr += Math.max(0, Math.abs(g) - 0.35) * 5 * face;
      // ledges: the rock in beds a few metres thick, each with a small step
      const bed = 6.5, tb = (hr + n.noise2(x * 0.02, z * 0.02) * 2) / bed;
      const stepped = (Math.floor(tb) + smoothstep(0.2, 0.8, tb - Math.floor(tb))) * bed;
      hr = lerp(hr, stepped, 0.45 * face);
      // finer crags
      hr += n.fbm2(x * 0.19, z * 0.19, 2) * 0.9 * face;
    }
    hr += Math.max(0, o - R.L) * 0.3 + n.fbm2(x * 0.018, z * 0.018, 3) * 10 * smoothstep(R.L * 0.6, R.L * 2, o);
    return Math.max(h, hr);
  }

  riverCenter(x) {
    return (CONFIG.map.meander ?? 1) * (14 * Math.sin(x * 0.0105 + 0.6) + 6 * Math.sin(x * 0.027 + 2.1));
  }

  heightAnalytic(x, z) {
    const M = CONFIG.map;
    const n = this.noise;
    const zc = this.riverCenter(x);
    const d = z - zc;
    const ad = Math.abs(d);
    const north = d > 0;
    const D = M.riverDepth;
    let h;
    if (ad < M.riverDeepHalfWidth) h = -D;
    else if (ad < M.riverShelfStart) h = lerp(-D, -0.75, smoothstep(M.riverDeepHalfWidth, M.riverShelfStart, ad));
    else if (ad < M.riverShelfEnd) h = lerp(-0.75, 0.05, (ad - M.riverShelfStart) / (M.riverShelfEnd - M.riverShelfStart));
    else h = lerp(0.05, M.bankTop, smoothstep(M.riverShelfEnd, M.riverShelfEnd + 7, ad));
    // lowland rivers cut a clear bank into the flat ground
    if (M.terrain === 'lowland' && ad >= M.riverShelfEnd) h += 1.6 * smoothstep(M.riverShelfEnd + 1, M.riverShelfEnd + 5, ad);

    // optional fords: shallow crossings
    for (const fx of M.fords) {
      const fw = 1 - smoothstep(6, 14, Math.abs(x - fx));
      if (fw > 0 && ad < M.riverShelfEnd) h = lerp(h, Math.max(h, -0.45), fw);
    }

    // slopes
    const s0 = M.riverShelfEnd + 5;
    const sd = Math.max(0, ad - s0);
    const span = M.ridgeDist - s0;
    const t = sd / span;
    const ridgeH = north ? M.ridgeHeightNorth : M.ridgeHeightSouth;
    let p = smin(t, 1 + 0.12 * (t - 1), 0.3);
    p = Math.max(p, 0);
    h += ridgeH * p * smoothstep(0, 0.04, t + 0.02);

    // terrain character
    const relief = M.relief ?? 1;
    const slopeMask = smoothstep(0.03, 0.3, t);
    h += n.fbm2(x * 0.0042 + 11, z * 0.0042, 3) * 9 * relief * slopeMask;
    // spurs and gullies running down the slopes (stretched across the valley axis)
    const spur = this.noise2.fbm2(x * 0.021, ad * 0.0055 + (north ? 0 : 37), 3);
    h += spur * 6.5 * relief * slopeMask * (1 - smoothstep(1.0, 1.5, t));
    // benches: terraces at mid slope
    const bench = north ? 0.45 : 0.62;
    h += 3.2 * relief * Math.exp(-Math.pow((t - bench) * 9, 2)) * (0.5 + 0.5 * n.noise2(x * 0.01, 3.3));
    h += n.fbm2(x * 0.045, z * 0.045, 3) * 1.4 * smoothstep(0.0, 0.12, t);
    h += n.noise2(x * 0.17, z * 0.17) * 0.22 * smoothstep(0.0, 0.05, t);
    // distant mountains, at the same distance from the river on every map (on the smaller
    // maps a forested plateau lies between the ridge and the mountains)
    // (lowland: low wooded hills instead of mountains; Tuscany: softer, rounder hills)
    const [farA, farB] = M.farHills || [90, 70];
    const far = smoothstep(232.6, 521.2, ad);
    if (far > 0) h += far * (farA + farB * this.noise2.fbm2(x * 0.0022, z * 0.0022, 4));
    const farX = smoothstep(CONFIG.map.length * 0.9, CONFIG.map.length * 1.7, Math.abs(x));
    if (farX > 0) h += farX * 45 * (farA / 90) * (0.6 + 0.4 * n.noise2(z * 0.004, x * 0.002)) * smoothstep(0.2, 0.5, t + 0.15);
    return this._rim(x, z, h);
  }

  inGrid(x, z) {
    const fx = x - this.gMinX, fz = z - this.gMinZ;
    return fx >= 0 && fz >= 0 && fx < this.gW - 1 && fz < this.gH - 1;
  }

  heightAt(x, z) {
    const fx = x - this.gMinX, fz = z - this.gMinZ;
    if (fx < 0 || fz < 0 || fx >= this.gW - 1 || fz >= this.gH - 1) return this.heightAnalytic(x, z);
    const i = fx | 0, j = fz | 0;
    const tx = fx - i, tz = fz - j;
    const g = this.grid, W = this.gW;
    const k = j * W + i;
    const a = g[k], b = g[k + 1], c = g[k + W], d = g[k + W + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const e = 0.8;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  waterDepthAt(x, z) {
    return Math.max(0, CONFIG.map.waterLevel - this.heightAt(x, z));
  }

  inPlayArea(x, z, margin = 0) {
    return Math.abs(x) <= this.halfX - margin && Math.abs(z) <= this.halfZ - margin;
  }

  // ------------------------------------------------------------- GPU data
  createHeightTexture() {
    const data = new Uint16Array(this.gW * this.gH);
    for (let i = 0; i < data.length; i++) data[i] = THREE.DataUtils.toHalfFloat(this.grid[i]);
    const tex = new THREE.DataTexture(data, this.gW, this.gH, THREE.RedFormat, THREE.HalfFloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.heightTexture = tex;
    // xy = min corner, zw = size (texel centres)
    this.gridBounds = new THREE.Vector4(this.gMinX - 0.5, this.gMinZ - 0.5, this.gW, this.gH);
    return tex;
  }

  // Splat control: R = forest floor (canopy), G = grass density, B = rock, A = unused.
  bakeSplat(canopyFn) {
    const W = this.gW, H = this.gH, d = this.splatData;
    const nrm = new THREE.Vector3();
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const x = this.gMinX + i, z = this.gMinZ + j;
        const k = (j * W + i) * 4;
        const canopy = canopyFn(x, z);
        const hgt = this.grid[j * W + i];
        this.normalAt(x, z, nrm);
        const slope = 1 - nrm.y;
        const rock = smoothstep(0.16, 0.3, slope);
        const dry = smoothstep(0.1, 1.2, hgt);
        // (the beech forest floor is leaves, with grass only in the clearings)
        const grass = clamp((1 - canopy * 1.25) * (1 - rock) * dry, 0, 1) * (CONFIG.map.biome === 'beech' ? 0.35 : 1);
        d[k] = clamp(canopy, 0, 1) * 255;
        d[k + 1] = grass * 255;
        d[k + 2] = rock * 255;
        d[k + 3] = 255;
      }
    }
    if (!this.splatTexture) {
      const tex = new THREE.DataTexture(d, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      this.splatTexture = tex;
    }
    this.splatTexture.needsUpdate = true;
  }

  grassDensityAt(x, z) {
    const fx = Math.round(x - this.gMinX), fz = Math.round(z - this.gMinZ);
    if (fx < 0 || fz < 0 || fx >= this.gW || fz >= this.gH) return 0;
    return this.splatData[(fz * this.gW + fx) * 4 + 1] / 255;
  }

  canopyAt(x, z) {
    const fx = Math.round(x - this.gMinX), fz = Math.round(z - this.gMinZ);
    if (fx < 0 || fz < 0 || fx >= this.gW || fz >= this.gH) return 0;
    return this.splatData[(fz * this.gW + fx) * 4] / 255;
  }

  // ------------------------------------------------------------- mesh
  buildMesh(textures, spacing = CONFIG.map.terrainSpacing, segOut = 104, material = null) {
    const M = CONFIG.map;
    const E = M.terrainExtent / 2;
    // fine spacing over the play area and the mountains around it (the faces and the crest)
    const innerX = this.halfX + Math.max(90, this.rim.L * 2 + 70), innerZ = this.halfZ + Math.max(80, this.rim.L * 2 + 60);
    const segInX = Math.round((innerX * 2) / spacing);
    const segInZ = Math.round((innerZ * 2) / spacing);
    const xs = this._axis(innerX, E, segInX, segOut);
    const zs = this._axis(innerZ, E, segInZ, segOut);
    const nx = xs.length, nz = zs.length;
    const pos = new Float32Array(nx * nz * 3);
    let p = 0;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = xs[i], z = zs[j];
        pos[p++] = x; pos[p++] = this.heightAt(x, z); pos[p++] = z;
      }
    }
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let q = 0;
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        idx[q++] = a; idx[q++] = c; idx[q++] = b;
        idx[q++] = b; idx[q++] = c; idx[q++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    // the land's own light: shadows the mountains cast and how much sky each spot sees
    const light = this._bakeLight(xs, zs, pos, nx, nz);
    geo.setAttribute('aTerrainLight', new THREE.BufferAttribute(light, 2));

    let mat = material;
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
      this._patchMaterial(mat, textures);
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = 'terrain';
    if (!material) this.mesh = mesh;
    return mesh;
  }

  // Coarse copy of the terrain used only when rendering the water reflection.
  buildReflectionMesh() {
    const m = this.buildMesh(null, 7, 24, this.mesh.material);
    m.name = 'terrain-reflection';
    m.receiveShadow = false;
    m.visible = false;
    return m;
  }

  // Per vertex: (sun visibility, sky visibility). The sun is fixed on each map, so the shadows the
  // mountains and ridges cast can be baked: march toward the sun over the terrain and compare
  // the steepest rise with the sun's elevation (a soft edge for the penumbra). Sky visibility:
  // the horizon in eight directions out to 100 m (horizon-based occlusion), darkening gullies,
  // couloirs and the foot of the walls. The terrain itself casts no shadow map, so without this
  // a ridge never shades the slope behind it. Heights come from the mesh itself, resampled on a
  // regular 4 m grid. (Stylized maps: all lit.)
  _bakeLight(xs, zs, pos, nx, nz) {
    const out = new Float32Array(nx * nz * 2).fill(1);
    if (CONFIG.map.style === 'stylized') return out;
    const S = 4, x0 = xs[0], z0 = zs[0], W = Math.floor((xs[nx - 1] - x0) / S) + 1, Hh = Math.floor((zs[nz - 1] - z0) / S) + 1;
    // regular grid from the mesh's (non-uniform) one
    const col = new Int32Array(W), row = new Int32Array(Hh);
    for (let i = 0, k = 0; i < W; i++) { const x = x0 + i * S; while (k < nx - 2 && xs[k + 1] <= x) k++; col[i] = k; }
    for (let j = 0, k = 0; j < Hh; j++) { const z = z0 + j * S; while (k < nz - 2 && zs[k + 1] <= z) k++; row[j] = k; }
    const G = new Float32Array(W * Hh);
    for (let j = 0; j < Hh; j++) {
      const z = z0 + j * S, r = row[j], tz = (z - zs[r]) / (zs[r + 1] - zs[r]);
      for (let i = 0; i < W; i++) {
        const x = x0 + i * S, c = col[i], tx = (x - xs[c]) / (xs[c + 1] - xs[c]);
        const a = pos[(r * nx + c) * 3 + 1], b = pos[(r * nx + c + 1) * 3 + 1], d = pos[((r + 1) * nx + c) * 3 + 1], e = pos[((r + 1) * nx + c + 1) * 3 + 1];
        G[j * W + i] = (a + (b - a) * tx) * (1 - tz) + (d + (e - d) * tx) * tz;
      }
    }
    const hAt = (x, z) => {
      let fx = (x - x0) / S, fz = (z - z0) / S;
      if (fx < 0) fx = 0; else if (fx > W - 1.001) fx = W - 1.001;
      if (fz < 0) fz = 0; else if (fz > Hh - 1.001) fz = Hh - 1.001;
      const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, o = j * W + i;
      return (G[o] + (G[o + 1] - G[o]) * tx) * (1 - tz) + (G[o + W] + (G[o + W + 1] - G[o + W]) * tx) * tz;
    };
    const sun = sunDirection();
    const sh = Math.hypot(sun.x, sun.z) || 1, sdx = sun.x / sh, sdz = sun.z / sh, tanSun = sun.y / sh;
    const dirs = [];
    for (let a = 0; a < 8; a++) dirs.push([Math.cos(a * Math.PI / 4 + 0.2), Math.sin(a * Math.PI / 4 + 0.2)]);
    const aoDist = [3, 7, 14, 26, 45, 75, 110];
    for (let v = 0, n = nx * nz; v < n; v++) {
      const x = pos[v * 3], h = pos[v * 3 + 1] + 0.3, z = pos[v * 3 + 2];
      // the sun: the steepest terrain rise toward it, out to ~900 m
      let maxT = -1;
      for (let d = 3; d < 900; d *= 1.24) {
        const t = (hAt(x + sdx * d, z + sdz * d) - h) / d;
        if (t > maxT) maxT = t;
      }
      out[v * 2] = Math.max(0, Math.min(1, (tanSun - maxT) / 0.07 + 0.5));
      // the sky: how high the horizon rises around
      let occ = 0;
      for (const [dx, dz] of dirs) {
        let m = 0;
        for (const d of aoDist) { const t = (hAt(x + dx * d, z + dz * d) - h) / d; if (t > m) m = t; }
        occ += m / Math.sqrt(1 + m * m);
      }
      out[v * 2 + 1] = Math.max(0.2, 1 - (occ / 8) * 1.15);
    }
    return out;
  }

  _axis(inner, extent, segIn, segOut) {
    const out = [];
    for (let k = segOut; k > 0; k--) {
      const t = k / segOut;
      out.push(-(inner + (extent - inner) * t * t));
    }
    for (let k = 0; k <= segIn; k++) out.push(-inner + (2 * inner * k) / segIn);
    for (let k = 1; k <= segOut; k++) {
      const t = k / segOut;
      out.push(inner + (extent - inner) * t * t);
    }
    return out;
  }

  _patchMaterial(mat, T) {
    const STYLIZED = CONFIG.map.style === 'stylized';
    // the land beyond the play area as it looks from afar (realistic maps): forest on the gentle
    // slopes below the tree line, alpine grass and scree above it, snow on the high ground of the
    // conifer mountains; colours linear
    const L = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255].map((v) => (((v / 255 + 0.055) / 1.055) ** 2.4).toFixed(4)).join(', ');
    const FAR = {
      conifer: { tree: 175, snow: 255, snowK: 1, dark: L(0x1b261b), light: L(0x2f3f27), meadow: L(0x56603a), scree: L(0x77736a) },
      beech: { tree: 230, snow: 900, snowK: 0, dark: L(0x253820), light: L(0x48622f), meadow: L(0x5f6a3e), scree: L(0x7a766c) },
      tuscany: { tree: 205, snow: 900, snowK: 0, dark: L(0x343c22), light: L(0x5d6236), meadow: L(0x8f7f50), scree: L(0x9a9282) },
    }[CONFIG.map.biome] || null;
    // plants clinging to the rock walls: the far forest's colours
    const VEG = FAR ? [FAR.dark, FAR.light] : [L(0x1c2a1a), L(0x34452a)];
    const uniforms = {
      tGrassA: { value: T.grass.map }, tGrassN: { value: T.grass.normalMap },
      tForestA: { value: T.forest.map }, tForestN: { value: T.forest.normalMap },
      tRockA: { value: T.rock.map }, tRockN: { value: T.rock.normalMap },
      tMudA: { value: T.mud.map }, tMudN: { value: T.mud.normalMap },
      tMacro: { value: T.macro },
      tSplat: { value: this.splatTexture },
      // metres per texture repeat: grass, forest floor, rock (terrain scale), mud
      uTile: { value: new THREE.Vector4(T.grass.tile || 3.3, T.forest.tile || 2.7, (T.rock.tile || 3.0) * 2.33, T.mud.tile || 2.9) },
      uGridBounds: { value: this.gridBounds },
      ...ZONE_UNIFORMS,
    };
    this.terrainUniforms = uniforms;
    mat.customProgramCacheKey = () => 'terrain';
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec2 aTerrainLight;
varying vec2 vTerrainLight;
varying vec3 vWPos;
varying vec3 vWNormal;`)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNormal = normalize(mat3(modelMatrix) * objectNormal);
vTerrainLight = aTerrainLight;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D tGrassA, tGrassN, tForestA, tForestN, tRockA, tRockN, tMudA, tMudN, tMacro, tSplat;
varying vec2 vTerrainLight;
uniform vec4 uGridBounds;
uniform vec4 uTile;
uniform float uZoneMode, uZoneCur, uZoneNext, uZoneWarn, uZoneHalfLen, uZoneRadius;
uniform vec2 uZoneCenter;
varying vec3 vWPos;
varying vec3 vWNormal;
float zoneDist(vec2 p, float f) {
  if (uZoneMode < 0.5) return abs(p.x) - uZoneHalfLen * f;
  return length(p - uZoneCenter) - uZoneRadius * f;
}
vec4 sampleAT(sampler2D t, vec2 uv, float macro) {
  vec4 a = texture(t, uv);
  vec4 b = texture(t, uv * 0.41 + vec2(0.37, 0.71));
  return mix(a, b, smoothstep(0.35, 0.65, macro) * 0.6);
}
vec4 sampleNT(sampler2D t, vec2 uv, float macro) {
  vec4 a = texture(t, uv);
  vec4 b = texture(t, uv * 0.41 + vec2(0.37, 0.71));
  return mix(a, b, smoothstep(0.35, 0.65, macro) * 0.6);
}`)
        .replace('#include <map_fragment>', `
vec3 tN = normalize(vWNormal);
vec2 wxz = vWPos.xz;
vec4 macro = texture(tMacro, wxz / 260.0);
vec4 macro2 = texture(tMacro, wxz / 47.0);
vec2 suv = (wxz - uGridBounds.xy) / uGridBounds.zw;
float inGrid = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0);
vec4 splat = texture(tSplat, clamp(suv, 0.0, 1.0));
float slope = 1.0 - tN.y;
float forestW = mix(smoothstep(0.42, 0.62, macro.r) * smoothstep(0.5, 2.0, vWPos.y), splat.r, inGrid);
float rockW = smoothstep(0.17, 0.3, slope + (macro2.b - 0.5) * 0.12);
rockW = max(rockW, smoothstep(0.8, 0.86, macro.g) * smoothstep(0.06, 0.14, slope));
float mudW = 1.0 - smoothstep(0.25, 1.3, vWPos.y + (macro2.b - 0.5) * 0.8);
float grassW = 1.0;
vec2 uvG = wxz / uTile.x, uvF = wxz / uTile.y, uvR = wxz / uTile.z, uvM = wxz / uTile.w;
vec4 aG = sampleAT(tGrassA, uvG, macro2.g);
vec4 aF = sampleAT(tForestA, uvF, macro2.g);
vec4 aR = sampleAT(tRockA, uvR + vec2(vWPos.y * 0.1), macro2.g);
// steep faces (the mountains around the map): rock projected on the face, not stretched down it
{
  vec2 fd = normalize(tN.xz + vec2(1e-4, 0.0));
  vec2 uvW = vec2(dot(wxz, vec2(-fd.y, fd.x)), vWPos.y * 1.15) / uTile.z;
  aR = mix(aR, sampleAT(tRockA, uvW, macro2.g), smoothstep(0.32, 0.55, slope));
}
vec4 aM = sampleAT(tMudA, uvM, macro2.g);
// height-aware weights
float sG = grassW * (1.0 - forestW) * (1.0 - rockW) * (1.0 - mudW);
float sF = forestW * (1.0 - rockW) * (1.0 - mudW);
float sR = rockW * (1.0 - mudW);
float sM = mudW;
vec4 sc = vec4(sG, sF, sR, sM) * 1.6 + vec4(aG.a, aF.a, aR.a, aM.a) * 0.45;
sc = mix(vec4(-9.0), sc, step(vec4(0.002), vec4(sG, sF, sR, sM)));
float mx = max(max(sc.x, sc.y), max(sc.z, sc.w)) - 0.18;
vec4 bw = max(sc - mx, 0.0);
bw /= max(bw.x + bw.y + bw.z + bw.w, 1e-4);
vec3 albedo = aG.rgb * bw.x + aF.rgb * bw.y + aR.rgb * bw.z + aM.rgb * bw.w;
// macro colour variation
albedo *= 0.82 + 0.36 * macro2.r;
// drier patches in the grass (Tuscany's grass is dry already: paler, bleached patches)
albedo = mix(albedo, albedo * ${CONFIG.map.biome === 'tuscany' && !STYLIZED ? 'vec3(1.1, 1.08, 1.02)' : 'vec3(1.18, 1.08, 0.75)'}, smoothstep(0.55, 0.8, macro.b) * bw.x * 0.7);
// the mountains around the play area: darker, warmer rock with lighter and darker bands
float vegW = 0.0;
{
  float e = max(abs(wxz.x) - ${(CONFIG.map.length / 2).toFixed(1)}, abs(wxz.y) - ${(CONFIG.map.width / 2).toFixed(1)});
  float mtn = smoothstep(0.0, 12.0, e);
  float strata = 0.9 + 0.08 * sin(vWPos.y * 0.45 + macro2.g * 9.0 + macro.r * 6.0) + (macro.g - 0.5) * 0.3;
  albedo = mix(albedo, albedo * ${STYLIZED ? 'vec3(0.74, 0.7, 0.64)' : 'vec3(0.62, 0.6, 0.56)'} * strata, mtn * bw.z);
  // stylized: grass on the mountains deeper and cooler, so the far slopes don't streak lime
  albedo = mix(albedo, albedo * vec3(0.62, 0.74, 0.7), mtn * bw.x * ${STYLIZED ? '1.0' : '0.0'});
${STYLIZED ? '' : `  // the rock walls: big-scale structure (the 7 m texture alone repeats on 60 m faces), beds of
  // lighter and darker stone that wander and pinch out, narrow streaks running down, darker
  // cracks and hollows (the rock texture's own height)
  vec4 big = texture(tMacro, vec2(dot(wxz, vec2(0.7071)), vWPos.y * 1.6) / 90.0);
  float streak = texture(tMacro, vec2(dot(wxz, vec2(0.7071, -0.7071)) / 11.0, vWPos.y / 90.0)).g;
  float bedPh = vWPos.y / 6.5 + (big.g - 0.5) * 1.2 + macro2.g * 0.3;
  float beds = 0.92 + 0.12 * smoothstep(0.3, 0.7, fract(bedPh)) * smoothstep(0.3, 0.6, big.b);
  float cavity = mix(0.72, 1.06, smoothstep(0.2, 0.7, aR.a));
  albedo = mix(albedo, albedo * beds * (0.72 + 0.5 * big.r) * (0.84 + 0.26 * streak) * cavity, mtn * bw.z);
  // plants on the walls: shrubs and grass in the cracks and on the ledges, more where the wall
  // is less steep (noise on the wall's own plane, blended by which way it faces)
  float fx = smoothstep(0.3, 0.7, abs(tN.x) / (abs(tN.x) + abs(tN.z) + 1e-4));
  vec2 wp = mix(vec2(wxz.x, vWPos.y), vec2(wxz.y, vWPos.y), fx);
  float vc = texture(tMacro, wp / 13.0).a, vb = texture(tMacro, wp / 37.0 + vec2(0.31, 0.17)).r;
  vegW = mtn * bw.z * (1.0 - smoothstep(0.5, 0.8, slope)) * smoothstep(0.55, 0.72, vb * 0.65 + vc * 0.35 + (1.0 - slope) * 0.3);
  albedo = mix(albedo, mix(vec3(${VEG[0]}), vec3(${VEG[1]}), smoothstep(0.3, 0.75, vc)) * (0.8 + 0.4 * macro2.b), vegW);`}
}
float farW = 0.0, woodW = 0.0, snowW = 0.0, alpW = 0.0;
${STYLIZED || !FAR ? '' : `{
  float e2 = max(abs(wxz.x) - ${(CONFIG.map.length / 2).toFixed(1)}, abs(wxz.y) - ${(CONFIG.map.width / 2).toFixed(1)});
  farW = smoothstep(8.0, 45.0, e2);
  float hgt = vWPos.y + (macro.r - 0.5) * 34.0 + (macro2.g - 0.5) * 10.0;
  float gentle = 1.0 - smoothstep(0.3, 0.5, slope);
  // forest: crowns (cells a few metres across), stands of darker and lighter trees, clearings
  float crowns = texture(tMacro, wxz / 120.0).a;
  float stands = texture(tMacro, wxz / 900.0).g;
  woodW = farW * gentle * (1.0 - smoothstep(${FAR.tree - 15}.0, ${FAR.tree + 12}.0, hgt)) * smoothstep(0.3, 0.42, macro.g + 0.25);
  vec3 canopy = mix(vec3(${FAR.dark}), vec3(${FAR.light}), smoothstep(0.15, 0.7, crowns) * (0.6 + 0.6 * stands));
  albedo = mix(albedo, canopy, woodW);
  // above the trees: grass and scree on the gentle ground
  alpW = farW * gentle * smoothstep(${FAR.tree - 8}.0, ${FAR.tree + 16}.0, hgt) * (1.0 - woodW);
  albedo = mix(albedo, mix(vec3(${FAR.meadow}), vec3(${FAR.scree}), smoothstep(0.4, 0.7, macro2.r + slope)) * (0.85 + 0.3 * macro2.b), alpW * 0.9);
  // snow: high and not too steep, longer in the gullies
  snowW = farW * ${FAR.snowK.toFixed(1)} * smoothstep(${FAR.snow - 14}.0, ${FAR.snow + 14}.0, hgt + (macro2.a - 0.5) * 20.0) * (1.0 - smoothstep(0.5, 0.82, slope));
  albedo = mix(albedo, vec3(0.78, 0.8, 0.84) * (0.92 + 0.08 * macro2.b), snowW);
}`}
// wetness near the waterline (stylized: a light sandy bank, barely darker and not glossy)
float wet = 1.0 - smoothstep(-0.05, 0.75, vWPos.y);
albedo *= mix(1.0, ${STYLIZED ? '0.8' : '0.55'}, wet);
// zone: tint outside
float dCur = zoneDist(wxz, uZoneCur);
float inPlay = step(abs(wxz.x), uZoneHalfLen + 0.5) * step(abs(wxz.y), ${(CONFIG.map.width / 2 + 0.5).toFixed(1)});
float outside = smoothstep(0.0, 3.0, dCur) * inPlay;
albedo = mix(albedo, albedo * vec3(1.25, 0.55, 0.5), outside * 0.55);
diffuseColor.rgb = albedo;
vec4 nmix = sampleNT(tGrassN, uvG, macro2.g) * bw.x + sampleNT(tForestN, uvF, macro2.g) * bw.y
          + sampleNT(tRockN, uvR + vec2(vWPos.y * 0.1), macro2.g) * bw.z + sampleNT(tMudN, uvM, macro2.g) * bw.w;
// the far forest is bumpy (crowns), snow is smooth, plants on the walls bumpy
nmix = mix(nmix, texture(tForestN, wxz / 9.0), woodW * 0.8);
nmix = mix(nmix, texture(tForestN, vec2(wxz.x + wxz.y, vWPos.y) / 3.0), vegW * 0.7);
nmix.xy = mix(nmix.xy, vec2(0.5), snowW * 0.7);
float tRough = mix(nmix.a, ${STYLIZED ? '0.85' : '0.28'}, wet);
tRough = mix(tRough, 0.62, snowW);
tRough = mix(tRough, 0.88, vegW);
`)
        .replace('#include <roughnessmap_fragment>', `float roughnessFactor = tRough;`)
        // the baked terrain light: its shadows only beyond the play area's edge (inside, trees and
        // rocks take their light from the shadow map), the sky's occlusion everywhere, gently
        .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace('directLight.color *= cloudSun;',
          `directLight.color *= cloudSun * mix(1.0, vTerrainLight.x, smoothstep(2.0, 25.0, max(abs(vWPos.x) - ${(CONFIG.map.length / 2).toFixed(1)}, abs(vWPos.z) - ${(CONFIG.map.width / 2).toFixed(1)})));`))
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>
{
  float terrAO = mix(1.0, vTerrainLight.y, mix(0.55, 1.0, smoothstep(0.0, 25.0, max(abs(vWPos.x) - ${(CONFIG.map.length / 2).toFixed(1)}, abs(vWPos.z) - ${(CONFIG.map.width / 2).toFixed(1)}))));
  reflectedLight.indirectDiffuse *= terrAO;
  reflectedLight.indirectSpecular *= terrAO;
}`)
        .replace('#include <normal_fragment_maps>', `
{
  vec3 tn = nmix.xyz * 2.0 - 1.0;
  tn.xy *= 1.0 - wet * 0.6;
  vec3 T = normalize(vec3(1.0, 0.0, 0.0) - tN * tN.x);
  vec3 B = normalize(vec3(0.0, 0.0, 1.0) - tN * tN.z);
  vec3 wn = normalize(T * tn.x + B * tn.y + tN * tn.z);
  normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float wpx = max(fwidth(dCur) * 1.5, 0.35);
  float band = 1.0 - smoothstep(0.0, wpx + 0.6, abs(dCur));
  totalEmissiveRadiance += vec3(2.2, 0.55, 0.12) * band * inPlay;
  if (uZoneWarn > 0.001) {
    float dN = zoneDist(wxz, uZoneNext);
    float wn = max(fwidth(dN) * 1.5, 0.35);
    float bn = 1.0 - smoothstep(0.0, wn + 0.5, abs(dN));
    float dash = step(0.5, fract((uZoneMode < 0.5 ? wxz.y : atan(wxz.y - uZoneCenter.y, wxz.x - uZoneCenter.x) * uZoneRadius * uZoneNext) / 6.0));
    totalEmissiveRadiance += vec3(2.4, 2.2, 1.8) * bn * dash * uZoneWarn * inPlay;
  }
}`);
    };
  }
}
