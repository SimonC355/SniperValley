// Procedural conifers (spruce, fir, pine, dead snag) and undergrowth (ferns, shrubs).
// Each tree variant has: LOD0 cards, LOD1 reduced cards, a baked billboard impostor,
// and a shadow-only proxy. Instances are bucketed per frame by effective distance
// (distance scaled by FOV, so scoped views get full detail) with per-instance culling.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { RNG, Simplex, clamp, lerp, smoothstep } from './noise.js';
import { patchFoliage, SHARED } from './shaders.js';

const VARIANTS = {
  spruce: { H: 16, r0: 0.3, crownBase: 0.08, R: 2.8, whorls: 20, branches: [8, 5], droop: [-0.4, 0.2], profile: 'cone', tex: 'spray', bark: 'barkSpruce', tint: [0.82, 0.92, 0.88] },
  fir: { H: 14, r0: 0.28, crownBase: 0.12, R: 3.1, whorls: 17, branches: [8, 5], droop: [-0.25, 0.3], profile: 'fir', tex: 'spray', bark: 'barkSpruce', tint: [0.95, 1.0, 0.9] },
  pine: { H: 19, r0: 0.32, crownBase: 0.5, R: 3.5, whorls: 10, branches: [7, 4], droop: [0.05, 0.45], profile: 'round', tex: 'pine', bark: 'barkPine', tint: [1.0, 0.97, 0.88] },
  snag: { H: 13, r0: 0.25, crownBase: 0.4, R: 1.6, whorls: 6, branches: [4, 2], droop: [-0.1, 0.2], profile: 'cone', tex: null, bark: 'barkSpruce', tint: [1, 1, 1] },
};
const VARIANT_NAMES = ['spruce', 'fir', 'pine', 'snag'];

function crownRadius(profile, t) {
  if (profile === 'cone') return Math.pow(1 - t, 1.0) * (0.9 + 0.1 * Math.sin(t * 9));
  if (profile === 'fir') return Math.pow(1 - t, 0.82);
  // round pine crown
  return Math.pow(Math.sin(Math.PI * (0.12 + 0.88 * t)), 0.7) * (1 - 0.25 * t) + 0.05;
}

class GeoBuilder {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; this.col = []; this.idx = []; }
  vert(p, n, u, v, c) {
    this.pos.push(p.x, p.y, p.z); this.nrm.push(n.x, n.y, n.z); this.uv.push(u, v); this.col.push(c, c, c);
    return this.pos.length / 3 - 1;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _side = new THREE.Vector3(), _up = new THREE.Vector3();

// A curved card along a path. widthDir is perpendicular to the path.
function addCard(B, pts, widthDir, width, crownCenterY, ao0, ao1, faceN, flipV = false) {
  const segs = pts.length - 1;
  const base = [];
  for (let s = 0; s <= segs; s++) {
    const u = s / segs;
    const p = pts[s];
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? -0.5 : 0.5;
      _v.copy(p).addScaledVector(widthDir, side * width);
      // spherical normal blended with face normal
      _n.set(_v.x, (_v.y - crownCenterY) * 0.5, _v.z);
      if (_n.lengthSq() < 1e-4) _n.set(0, 1, 0);
      _n.normalize().add(_up.set(0, 0.45, 0)).normalize();
      _n.multiplyScalar(0.72).addScaledVector(faceN, 0.28).normalize();
      const ao = lerp(ao0, ao1, u);
      base.push(B.vert(_v, _n, u, flipV ? 1 - (k ? 1 : 0) : (k ? 1 : 0), ao));
    }
  }
  for (let s = 0; s < segs; s++) {
    const a = base[s * 2], b = base[s * 2 + 1], c = base[s * 2 + 2], d = base[s * 2 + 3];
    B.tri(a, c, b); B.tri(b, c, d);
  }
}

function buildTrunk(B, H, r0, radial, hSegs, rng, bendSeed) {
  const rings = [];
  const bx = Math.sin(bendSeed) * 0.25, bz = Math.cos(bendSeed * 1.7) * 0.25;
  for (let j = 0; j <= hSegs; j++) {
    const t = j / hSegs;
    const y = t * H * 0.97;
    let r = r0 * Math.pow(1 - t * 0.98, 0.9);
    r *= 1 + 0.7 * Math.exp(-y * 2.5);
    const ox = bx * Math.sin(t * 2.5), oz = bz * Math.sin(t * 2.0);
    const ring = [];
    for (let i = 0; i <= radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      const nx = Math.cos(a), nz = Math.sin(a);
      _v.set(ox + nx * r, y, oz + nz * r);
      _n.set(nx, 0.15, nz).normalize();
      ring.push(B.vert(_v, _n, (i / radial) * 3, y / 1.0, lerp(0.55, 1.0, Math.min(1, t * 3))));
    }
    rings.push(ring);
  }
  for (let j = 0; j < hSegs; j++) {
    for (let i = 0; i < radial; i++) {
      const a = rings[j][i], b = rings[j][i + 1], c = rings[j + 1][i], d = rings[j + 1][i + 1];
      B.tri(a, c, b); B.tri(b, c, d);
    }
  }
}

function buildConifer(variantName, lod, seed) {
  const V = VARIANTS[variantName];
  const rng = new RNG(seed);
  const trunkB = new GeoBuilder();
  const leafB = new GeoBuilder();
  const H = V.H;
  buildTrunk(trunkB, H, V.r0, lod === 0 ? 8 : lod === 1 ? 5 : 4, lod === 0 ? 7 : lod === 1 ? 3 : 2, rng, seed * 0.37);
  const yb = H * V.crownBase;
  const crownH = H - yb;
  const whorls = lod === 0 ? V.whorls : lod === 1 ? Math.ceil(V.whorls / 2) : Math.ceil(V.whorls / 3);
  const isSnag = variantName === 'snag';
  for (let w = 0; w < whorls; w++) {
    const t = (w + rng.float(0.1, 0.6)) / whorls;
    const y = yb + t * crownH * 0.94;
    const R = V.R * crownRadius(V.profile, t);
    let nb = Math.round(lerp(V.branches[0], V.branches[1], t));
    if (lod === 1) nb = Math.max(3, Math.round(nb * 0.65));
    if (lod === 2) nb = 3;
    const off = rng.float(0, Math.PI * 2);
    for (let b = 0; b < nb; b++) {
      const yaw = off + (b / nb) * Math.PI * 2 + rng.float(-0.25, 0.25);
      const L = Math.max(0.5, R * rng.float(0.85, 1.12)) * (isSnag ? 0.7 : 1);
      const pitch = lerp(V.droop[0], V.droop[1], t) + rng.float(-0.12, 0.12);
      const dir = new THREE.Vector3(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch));
      const segs = lod === 0 ? 3 : 1;
      const droopAmt = (variantName === 'pine' ? -0.08 : 0.22) * L;
      const pts = [];
      const p0 = new THREE.Vector3(Math.cos(yaw) * 0.12, y, Math.sin(yaw) * 0.12);
      for (let s = 0; s <= segs; s++) {
        const u = s / segs;
        pts.push(p0.clone().addScaledVector(dir, L * u).add(new THREE.Vector3(0, -droopAmt * u * u, 0)));
      }
      if (isSnag) {
        // dead branch stub: thin trunk-textured card pair
        _side.set(-Math.sin(yaw), 0, Math.cos(yaw));
        addCard(trunkB, pts, _side, 0.06, y, 0.6, 0.8, _up.set(0, 1, 0));
        continue;
      }
      const W = L * (lod === 0 ? 0.78 : lod === 1 ? 1.0 : 1.3) + 0.3;
      const roll = rng.float(-0.35, 0.35);
      _side.set(-Math.sin(yaw), 0, Math.cos(yaw));
      const sideDir = _side.clone().applyAxisAngle(dir, roll);
      const faceUp = new THREE.Vector3().crossVectors(sideDir, dir).normalize();
      if (faceUp.y < 0) faceUp.negate();
      const ao0 = lerp(0.35, 0.6, t);
      const ao1 = lerp(0.85, 1.0, t) * rng.float(0.92, 1.08);
      addCard(leafB, pts, sideDir, W, y, ao0, ao1, faceUp);
      // vertical cross card for volume
      const vDir = faceUp.clone();
      const sideN = sideDir.clone();
      addCard(leafB, pts, vDir, W * 0.62, y, ao0 * 0.9, ao1 * 0.95, sideN);
    }
  }
  if (!isSnag) {
    // inner filler cards: make the crown core dense (this is what blocks sight/bullets)
    const fillers = lod === 0 ? 6 : lod === 1 ? 3 : 2;
    for (let f = 0; f < fillers; f++) {
      const a = (f / fillers) * Math.PI;
      const d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const yTop = yb + crownH * 0.8;
      const y0 = yb + crownH * 0.04;
      const pts = [];
      const segs = 3;
      for (let s = 0; s <= segs; s++) pts.push(new THREE.Vector3(0, lerp(y0, yTop, s / segs), 0));
      const Rb = V.R * crownRadius(V.profile, 0.25) * 0.85;
      // cards are vertical, width = horizontal direction d; uv u runs up the card
      const n = new THREE.Vector3(-d.z, 0, d.x);
      addCard(leafB, pts, d, Rb * 1.6, (y0 + yTop) / 2, 0.3, 0.45, n);
    }
  }
  return { trunk: trunkB.build(), leaves: isSnag ? null : leafB.build(), height: H, radius: V.R };
}

// --------------------------------------------------------------------------- impostors

const BAKE_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vN;
varying vec3 vCol;
void main() {
  vUv = uv; vCol = color;
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const BAKE_FRAG = /* glsl */`
uniform sampler2D map;
uniform vec3 tint;
uniform float mode;
uniform float alphaTest;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vCol;
void main() {
  vec4 t = texture2D(map, vUv);
  if (t.a < alphaTest) discard;
  if (mode < 0.5) gl_FragColor = vec4(t.rgb * vCol * tint, 1.0);
  else { vec3 n = normalize(vN); n.z = max(n.z, 0.2); gl_FragColor = vec4(normalize(n) * 0.5 + 0.5, 1.0); }
}`;

function bakeImpostor(renderer, geos, mats, width, height) {
  const scene = new THREE.Scene();
  const meshes = [];
  for (let i = 0; i < geos.length; i++) {
    if (!geos[i]) continue;
    const m = new THREE.Mesh(geos[i], new THREE.ShaderMaterial({
      vertexShader: BAKE_VERT, fragmentShader: BAKE_FRAG, vertexColors: true, side: THREE.DoubleSide,
      uniforms: { map: { value: mats[i].map }, tint: { value: new THREE.Color(1, 1, 1) }, mode: { value: 0 }, alphaTest: { value: mats[i].alphaTest || 0.01 } },
    }));
    scene.add(m);
    meshes.push(m);
  }
  const cam = new THREE.OrthographicCamera(-width / 2, width / 2, height, 0, -50, 50);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  const W = 256, Hh = 512;
  const mk = (srgb) => {
    const rt = new THREE.WebGLRenderTarget(W, Hh, {
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    });
    return rt;
  };
  const albedo = mk(true), normal = mk(false);
  const prevRT = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(albedo);
  renderer.setClearColor(new THREE.Color(0.035, 0.06, 0.025), 0);
  renderer.clear();
  for (const m of meshes) m.material.uniforms.mode.value = 0;
  renderer.render(scene, cam);
  renderer.setRenderTarget(normal);
  renderer.setClearColor(new THREE.Color(0.5, 0.5, 1.0), 0);
  renderer.clear();
  for (const m of meshes) m.material.uniforms.mode.value = 1;
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevRT);
  renderer.setClearColor(prevClear, prevAlpha);
  for (const m of meshes) m.material.dispose();
  return { map: albedo.texture, normalMap: normal.texture };
}

// --------------------------------------------------------------------------- instancing helpers

function makeInstanced(geo, mat, capacity, { castShadow = false, receiveShadow = true } = {}) {
  const m = new THREE.InstancedMesh(geo, mat, Math.max(1, capacity));
  m.count = 0;
  m.frustumCulled = false;
  m.castShadow = castShadow;
  m.receiveShadow = receiveShadow;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity) * 3), 3);
  m.instanceColor.setUsage(THREE.DynamicDrawUsage);
  return m;
}

// Shadow-only material: vertices collapse in the main pass, but the shadow pass uses
// the auto-generated depth material (which honours map + alphaTest from this material).
function shadowOnlyMaterial(map) {
  const m = new THREE.MeshBasicMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide, colorWrite: false, depthWrite: false });
  m.customProgramCacheKey = () => 'shadowonly';
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace('#include <project_vertex>', 'vec4 mvPosition = vec4(0.0); gl_Position = vec4(0.0, 0.0, 2.0, 1.0);');
  };
  return m;
}

class Bucket {
  constructor(meshes) { this.meshes = meshes; this.count = 0; }
  reset() { this.count = 0; }
  // copies matrix #k from mats (Float32Array of 16-float matrices) and colour #k from cols
  push(mats, cols, k) {
    const i = this.count++;
    const ms = k * 16, cs = k * 3, md = i * 16, cd = i * 3;
    for (let mi = 0; mi < this.meshes.length; mi++) {
      const m = this.meshes[mi];
      const a = m.instanceMatrix.array, c = m.instanceColor.array;
      for (let e = 0; e < 16; e++) a[md + e] = mats[ms + e];
      c[cd] = cols[cs]; c[cd + 1] = cols[cs + 1]; c[cd + 2] = cols[cs + 2];
    }
  }
  commit() {
    for (const m of this.meshes) {
      m.count = this.count;
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, Math.max(1, this.count) * 16);
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor.clearUpdateRanges();
      m.instanceColor.addUpdateRange(0, Math.max(1, this.count) * 3);
      m.instanceColor.needsUpdate = true;
    }
  }
}

// --------------------------------------------------------------------------- Forest

export class Forest {
  constructor(renderer, scene, terrain, textures, seed) {
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.group.name = 'forest';
    scene.add(this.group);
    this.trees = [];       // collision data for play-area + outer trees
    this.rng = new RNG(seed + 7);
    this.noise = new Simplex(seed + 23);
    this._buildVariants(renderer, textures);
    this._place();
    this._buildInstances();
    this.frustum = new THREE.Frustum();
    this._pm = new THREE.Matrix4();
    this._sphere = new THREE.Sphere();
    this.lastUpdatePos = new THREE.Vector3(1e9, 0, 0);
  }

  _buildVariants(renderer, T) {
    this.variants = {};
    for (const name of VARIANT_NAMES) {
      const V = VARIANTS[name];
      const lod0 = buildConifer(name, 0, 11 + name.length * 7);
      const lod1 = buildConifer(name, 1, 11 + name.length * 7);
      const lod2 = buildConifer(name, 2, 11 + name.length * 7);
      const barkMat = new THREE.MeshStandardMaterial({
        map: T[V.bark].map, normalMap: T[V.bark].normalMap, roughness: 0.95, vertexColors: true,
      });
      patchFoliage(barkMat, { sway: 0.0025, flutter: 0, translucency: 0, noFlip: false, key: 'bark' });
      let leafMat = null;
      if (V.tex) {
        leafMat = new THREE.MeshStandardMaterial({
          map: T[V.tex], alphaTest: 0.42, side: THREE.DoubleSide, vertexColors: true, roughness: 0.82,
          alphaToCoverage: CONFIG.render.msaa > 0,
        });
        patchFoliage(leafMat, { sway: 0.004, flutter: 0.035, translucency: 0.35, key: 'needles' });
      }
      const width = V.R * 2.2, height = V.H * 1.02;
      const imp = bakeImpostor(renderer, [lod0.trunk, lod0.leaves], [barkMat, leafMat || barkMat], width, height);
      const impGeo = new THREE.PlaneGeometry(width, height);
      impGeo.translate(0, height / 2, 0);
      const impMat = new THREE.MeshStandardMaterial({
        map: imp.map, normalMap: imp.normalMap, alphaTest: 0.45, roughness: 0.9, side: THREE.FrontSide,
        alphaToCoverage: CONFIG.render.msaa > 0,
      });
      patchFoliage(impMat, { sway: 0.003, flutter: 0, translucency: 0.35, billboard: true, noFlip: false, key: 'impostor' });
      this.variants[name] = { V, lod0, lod1, lod2, barkMat, leafMat, impGeo, impMat, shadowLeaf: leafMat ? shadowOnlyMaterial(T[V.tex]) : null, shadowBark: shadowOnlyMaterial(null) };
    }
  }

  // Tree density function (0..1)
  density(x, z) {
    const t = this.terrain;
    const h = t.heightAt(x, z);
    if (h < 1.3) return 0;
    const n = this.noise.fbm2(x / 95, z / 95, 3);
    const n2 = this.noise.noise2(x / 31 + 7, z / 31);
    let d = smoothstep(-0.38, 0.05, n) * 0.85 + 0.15 * smoothstep(0.2, 0.6, n2);
    d *= smoothstep(1.3, 5, h);
    const nrm = t.normalAt(x, z);
    d *= 1 - smoothstep(0.2, 0.35, 1 - nrm.y);
    return clamp(d, 0, 1);
  }

  _chooseVariant(x, z, h) {
    const r = this.rng.next();
    if (r < 0.04) return 'snag';
    const hn = clamp(h / 60, 0, 1);
    const n = this.noise.noise2(x / 60 + 40, z / 60);
    const pPine = 0.06 + hn * 0.16 + (n > 0.35 ? 0.14 : 0);
    if (this.rng.next() < pPine) return 'pine';
    return this.rng.next() < 0.55 ? 'spruce' : 'fir';
  }

  _place() {
    const t = this.terrain;
    const M = CONFIG.map;
    const cell = CONFIG.trees.minSpacing;
    const hx = M.length / 2 + 10, hz = M.width / 2 + 10;
    // play area (+10 m margin)
    const accept = 0.62;
    const cellsX = Math.ceil((hx * 2) / cell), cellsZ = Math.ceil((hz * 2) / cell);
    const occ = new Int32Array(cellsX * cellsZ).fill(-1);
    for (let j = 0; j < cellsZ; j++) {
      for (let i = 0; i < cellsX; i++) {
        const x = -hx + (i + this.rng.float(0.1, 0.9)) * cell;
        const z = -hz + (j + this.rng.float(0.1, 0.9)) * cell;
        const d = this.density(x, z);
        if (this.rng.next() > d * accept) continue;
        // spacing check against neighbours
        let ok = true;
        for (let dj = -1; dj <= 1 && ok; dj++) for (let di = -1; di <= 1 && ok; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= cellsX || jj >= cellsZ) continue;
          const k = occ[jj * cellsX + ii];
          if (k >= 0) {
            const o = this.trees[k];
            if ((o.x - x) ** 2 + (o.z - z) ** 2 < (cell * 0.8) ** 2) ok = false;
          }
        }
        if (!ok) continue;
        occ[j * cellsX + i] = this.trees.length;
        this._addTree(x, z, false);
      }
    }
    this.playCount = this.trees.length;
    // outer scenery: coarser grid
    const E = CONFIG.map.terrainExtent / 2 - 40;
    const oc = 9;
    for (let z = -E; z < E; z += oc) {
      for (let x = -E; x < E; x += oc) {
        const px = x + this.rng.float(0, oc), pz = z + this.rng.float(0, oc);
        if (Math.abs(px) < hx && Math.abs(pz) < hz) continue;
        const h = t.heightAt(px, pz);
        if (h > 175) continue;
        const d = this.density(px, pz) * (1 - smoothstep(110, 175, h));
        if (this.rng.next() > d * 0.85) continue;
        this._addTree(px, pz, true);
      }
    }
  }

  _addTree(x, z, outer) {
    const h = this.terrain.heightAt(x, z);
    const variant = this._chooseVariant(x, z, h);
    const V = VARIANTS[variant];
    const age = 0.5 + 0.5 * this.noise.noise2(x / 45, z / 45 + 9);
    const s = lerp(0.62, 1.22, clamp(age * 0.7 + this.rng.float(0, 0.45), 0, 1));
    const rot = this.rng.float(0, Math.PI * 2);
    const tintJ = this.rng.float(0.88, 1.1);
    const height = V.H * s;
    const tree = {
      x, z, y: h - 0.15, s, rot, variant, outer,
      trunkR: V.r0 * s * 1.15,
      height,
      crownBase: h + height * V.crownBase,
      crownTop: h + height,
      coreR: variant === 'snag' ? 0 : V.R * s * 0.42,
      tint: [V.tint[0] * tintJ, V.tint[1] * tintJ, V.tint[2] * tintJ],
    };
    this.trees.push(tree);
  }

  _buildInstances() {
    const n = this.trees.length;
    this.matrices = new Float32Array(n * 16);
    this.impMatrices = new Float32Array(n * 16);
    this.colors = new Float32Array(n * 3);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const counts = {};
    for (const name of VARIANT_NAMES) counts[name] = 0;
    for (let i = 0; i < n; i++) {
      const t = this.trees[i];
      counts[t.variant]++;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.rot);
      p.set(t.x, t.y, t.z);
      sc.setScalar(t.s);
      m.compose(p, q, sc);
      m.toArray(this.matrices, i * 16);
      q.identity();
      m.compose(p, q, sc);
      m.toArray(this.impMatrices, i * 16);
      this.colors.set(t.tint, i * 3);
    }
    this.buckets = {};
    for (const name of VARIANT_NAMES) {
      const v = this.variants[name];
      const c = counts[name];
      const l0 = [makeInstanced(v.lod0.trunk, v.barkMat, c)];
      if (v.lod0.leaves) l0.push(makeInstanced(v.lod0.leaves, v.leafMat, c));
      const l1 = [makeInstanced(v.lod1.trunk, v.barkMat, c)];
      if (v.lod1.leaves) l1.push(makeInstanced(v.lod1.leaves, v.leafMat, c));
      const imp = [makeInstanced(v.impGeo, v.impMat, c)];
      const sh = [makeInstanced(v.lod2.trunk, v.shadowBark, c, { castShadow: true, receiveShadow: false })];
      if (v.lod2.leaves) sh.push(makeInstanced(v.lod2.leaves, v.shadowLeaf, c, { castShadow: true, receiveShadow: false }));
      for (const mm of [...l0, ...l1, ...imp, ...sh]) this.group.add(mm);
      this.buckets[name] = { l0: new Bucket(l0), l1: new Bucket(l1), imp: new Bucket(imp), sh: new Bucket(sh) };
    }
  }

  // Per-frame LOD + culling. shadowFocus: centre of the shadow map; shadowRange: radius.
  update(camera, shadowFocus, shadowRange) {
    this._pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._pm);
    const zoom = camera.fov / CONFIG.player.fovHip;
    const l0d = CONFIG.trees.lod0Distance / zoom, l1d = CONFIG.trees.lod1Distance / zoom;
    const l0d2 = l0d * l0d, l1d2 = l1d * l1d;
    const sr2 = shadowRange * shadowRange;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    for (const name of VARIANT_NAMES) {
      const b = this.buckets[name];
      b.l0.reset(); b.l1.reset(); b.imp.reset(); b.sh.reset();
    }
    const trees = this.trees, M = this.matrices, IM = this.impMatrices, C = this.colors;
    const sphere = this._sphere;
    const fr = this.frustum;
    for (let i = 0, n = trees.length; i < n; i++) {
      const t = trees[i];
      const b = this.buckets[t.variant];
      if (shadowFocus) {
        const sx = t.x - shadowFocus.x, sz = t.z - shadowFocus.z;
        if (sx * sx + sz * sz < sr2) b.sh.push(M, C, i);
      }
      sphere.center.set(t.x, t.y + t.height * 0.5, t.z);
      sphere.radius = t.height * 0.6 + 6;
      if (!fr.intersectsSphere(sphere)) continue;
      const dx = t.x - cx, dy = t.y + t.height * 0.5 - cy, dz = t.z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < l0d2) b.l0.push(M, C, i);
      else if (d2 < l1d2) b.l1.push(M, C, i);
      else b.imp.push(IM, C, i);
    }
    for (const name of VARIANT_NAMES) {
      const b = this.buckets[name];
      b.l0.commit(); b.l1.commit(); b.imp.commit(); b.sh.commit();
    }
  }

  // canopy coverage (0..1) rasterised for the terrain splat map
  buildCanopyGrid() {
    const t = this.terrain;
    const W = t.gW, H = t.gH;
    const g = new Float32Array(W * H);
    for (const tr of this.trees) {
      if (tr.variant === 'snag') continue;
      const r = VARIANTS[tr.variant].R * tr.s * 1.25;
      const i0 = Math.floor(tr.x - r - t.gMinX), i1 = Math.ceil(tr.x + r - t.gMinX);
      const j0 = Math.floor(tr.z - r - t.gMinZ), j1 = Math.ceil(tr.z + r - t.gMinZ);
      for (let j = Math.max(0, j0); j <= Math.min(H - 1, j1); j++) {
        for (let i = Math.max(0, i0); i <= Math.min(W - 1, i1); i++) {
          const x = t.gMinX + i, z = t.gMinZ + j;
          const d = Math.hypot(x - tr.x, z - tr.z) / r;
          if (d < 1) g[j * W + i] += (1 - d * d) * 0.75;
        }
      }
    }
    return (x, z) => {
      const i = Math.round(x - t.gMinX), j = Math.round(z - t.gMinZ);
      if (i < 0 || j < 0 || i >= W || j >= H) return 0;
      return Math.min(1, g[j * W + i]);
    };
  }
}

// --------------------------------------------------------------------------- undergrowth

function buildFern(lod, rng) {
  const B = new GeoBuilder();
  const fronds = lod === 0 ? 8 : 4;
  for (let f = 0; f < fronds; f++) {
    const yaw = (f / fronds) * Math.PI * 2 + rng.float(-0.3, 0.3);
    const L = rng.float(0.8, 1.15);
    const lift = rng.float(0.55, 0.85);
    const dir = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
    const pts = [];
    const segs = lod === 0 ? 4 : 2;
    for (let s = 0; s <= segs; s++) {
      const u = s / segs;
      pts.push(new THREE.Vector3(dir.x * L * u, Math.sin(u * Math.PI * 0.85) * lift * L * 0.7 + u * 0.05, dir.z * L * u));
    }
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    addCard(B, pts, side, 0.42, 0.2, 0.45, 1.0, new THREE.Vector3(0, 1, 0));
  }
  return B.build();
}

function buildShrub(lod, rng) {
  const B = new GeoBuilder();
  const cards = lod === 0 ? 7 : 3;
  for (let c = 0; c < cards; c++) {
    const a = (c / cards) * Math.PI + rng.float(-0.2, 0.2);
    const d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const h = rng.float(0.9, 1.4);
    const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, h * 0.5, 0), new THREE.Vector3(0, h, 0)];
    const n = new THREE.Vector3(-d.z, 0, d.x);
    addCard(B, pts, d, h * 1.1, h * 0.5, 0.4, 1.0, n);
  }
  // a horizontal top card
  const pts = [new THREE.Vector3(-0.6, 1.0, 0), new THREE.Vector3(0.6, 1.05, 0)];
  addCard(B, pts, new THREE.Vector3(0, 0, 1), 1.2, 0.5, 0.9, 1.0, new THREE.Vector3(0, 1, 0));
  // card uvs: fern texture expects u along frond; shrub uses square leaf texture so remap
  return B.build();
}

export class Undergrowth {
  constructor(scene, terrain, forest, textures, seed) {
    this.terrain = terrain;
    this.rng = new RNG(seed + 31);
    this.noise = new Simplex(seed + 37);
    this.group = new THREE.Group();
    scene.add(this.group);
    const fernTex = textures.fern.clone();
    fernTex.needsUpdate = true;
    // fern texture is drawn with the frond pointing up (v); our cards run along u, so rotate
    fernTex.center.set(0.5, 0.5);
    fernTex.rotation = -Math.PI / 2;
    const fernMat = new THREE.MeshStandardMaterial({ map: fernTex, alphaTest: 0.45, side: THREE.DoubleSide, vertexColors: true, roughness: 0.85, alphaToCoverage: CONFIG.render.msaa > 0 });
    patchFoliage(fernMat, { sway: 0.05, flutter: 0.03, translucency: 0.7, key: 'fern' });
    const shrubMat = new THREE.MeshStandardMaterial({ map: textures.leaves, alphaTest: 0.45, side: THREE.DoubleSide, vertexColors: true, roughness: 0.8, alphaToCoverage: CONFIG.render.msaa > 0 });
    patchFoliage(shrubMat, { sway: 0.04, flutter: 0.025, translucency: 0.6, key: 'shrub' });
    const types = [
      { name: 'fern', lod0: buildFern(0, this.rng), lod1: buildFern(1, this.rng), mat: fernMat, radius: 0.9 },
      { name: 'shrub', lod0: buildShrub(0, this.rng), lod1: buildShrub(1, this.rng), mat: shrubMat, radius: 0.8 },
    ];
    this.types = types;
    this.items = [];
    this._place(forest);
    const n = this.items.length;
    this.matrices = new Float32Array(n * 16);
    this.colors = new Float32Array(n * 3);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    const counts = [0, 0];
    this.items.forEach((it, i) => {
      counts[it.type]++;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.rot);
      p.set(it.x, it.y, it.z);
      s.set(it.s, it.s * it.sy, it.s);
      m.compose(p, q, s).toArray(this.matrices, i * 16);
      this.colors.set(it.tint, i * 3);
    });
    this.buckets = types.map((tp, k) => {
      const a = makeInstanced(tp.lod0, tp.mat, counts[k]);
      const b = makeInstanced(tp.lod1, tp.mat, counts[k]);
      this.group.add(a, b);
      return { l0: new Bucket([a]), l1: new Bucket([b]) };
    });
    this.frustum = new THREE.Frustum();
    this._pm = new THREE.Matrix4();
    this._sphere = new THREE.Sphere();
  }

  _place(forest) {
    const t = this.terrain;
    const M = CONFIG.map;
    const hx = M.length / 2 + 6, hz = M.width / 2 + 6;
    const target = CONFIG.bushes.count;
    let tries = 0;
    while (this.items.length < target && tries < target * 8) {
      tries++;
      const x = this.rng.float(-hx, hx), z = this.rng.float(-hz, hz);
      const h = t.heightAt(x, z);
      if (h < 0.9) continue;
      const canopy = t.canopyAt(x, z);
      const nrm = t.normalAt(x, z);
      if (nrm.y < 0.8) continue;
      // undergrowth likes forest edges and clearings, avoids deep canopy and steep ground
      const n = this.noise.fbm2(x / 40, z / 40, 2);
      const p = clamp(0.35 + n * 0.6 + (canopy > 0.2 && canopy < 0.75 ? 0.3 : 0) - (canopy > 0.9 ? 0.4 : 0), 0, 1);
      if (this.rng.next() > p) continue;
      const type = canopy > 0.45 ? (this.rng.chance(0.8) ? 0 : 1) : (this.rng.chance(0.45) ? 0 : 1);
      const s = this.rng.float(0.65, 1.35);
      const g = this.rng.float(0.8, 1.15);
      this.items.push({
        x, z, y: h - 0.05, type, s, sy: type === 1 ? this.rng.float(0.7, 1.2) : 1, rot: this.rng.float(0, Math.PI * 2),
        radius: this.types[type].radius * s,
        tint: type === 0 ? [0.85 * g, 0.95 * g, 0.7 * g] : [0.9 * g, 0.95 * g, 0.8 * g],
      });
    }
  }

  update(camera) {
    this._pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._pm);
    const zoom = camera.fov / CONFIG.player.fovHip;
    const l0 = CONFIG.bushes.lod0Distance / zoom, maxD = CONFIG.bushes.maxDistance / zoom;
    const l02 = l0 * l0, max2 = maxD * maxD;
    for (const b of this.buckets) { b.l0.reset(); b.l1.reset(); }
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const items = this.items, M = this.matrices, C = this.colors, sp = this._sphere;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const dx = it.x - cx, dy = it.y - cy, dz = it.z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > max2) continue;
      sp.center.set(it.x, it.y + 0.5, it.z); sp.radius = 1.6 * it.s;
      if (!this.frustum.intersectsSphere(sp)) continue;
      const b = this.buckets[it.type];
      if (d2 < l02) b.l0.push(M, C, i); else b.l1.push(M, C, i);
    }
    for (const b of this.buckets) { b.l0.commit(); b.l1.commit(); }
  }
}
