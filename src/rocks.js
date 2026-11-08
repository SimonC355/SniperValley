// Procedural boulders: displaced icospheres, instanced, triplanar rock material with moss on top.
// v5: about twice as many, in clusters and outcrops, and each rock has a small height map of
// its real (drawn) top surface. You walk up onto low rocks and climb onto high ones
// (player.js), and bullets and sight lines hit the drawn shape instead of a big sphere.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { RNG, Simplex, smoothstep } from './noise.js';
import { fitParts } from './models.js';

function buildRockGeometry(seed, shape = 0) {
  const g = new THREE.IcosahedronGeometry(1, 3);
  const n = new Simplex(seed);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  // shape 0: boulder, 1: low slab (good to climb and lie on), 2: tall block
  let sx = 0.8 + (seed % 5) * 0.12, sy = 0.5 + (seed % 3) * 0.12, sz = 0.75 + (seed % 4) * 0.1;
  if (shape === 1) { sx *= 1.35; sz *= 1.25; sy *= 0.62; }
  if (shape === 2) { sx *= 0.85; sz *= 0.9; sy *= 1.55; }
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const d = 1 + n.noise3(v.x * 1.1, v.y * 1.1, v.z * 1.1) * 0.34 + n.noise3(v.x * 2.7, v.y * 2.7, v.z * 2.7) * 0.1;
    // quantise radius for a fractured, faceted look
    const f = Math.round(d * 5) / 5;
    const dd = d * 0.45 + f * 0.55;
    v.multiplyScalar(dd);
    // flattened top (weathered slab) and buried bottom
    if (v.y > 0.45) v.y = 0.45 + (v.y - 0.45) * 0.35;
    if (v.y < -0.3) v.y = -0.3 + (v.y + 0.3) * 0.5;
    v.set(v.x * sx, v.y * sy, v.z * sz);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.deleteAttribute('uv');
  const merged = mergeVerticesSimple(g);
  merged.computeVertexNormals();
  return merged;
}

// IcosahedronGeometry is non-indexed; merge to get smooth normals.
function mergeVerticesSimple(g) {
  const pos = g.attributes.position;
  const map = new Map();
  const verts = [];
  const idx = [];
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    let k = map.get(key);
    if (k === undefined) { k = verts.length / 3; map.set(key, k); verts.push(pos.getX(i), pos.getY(i), pos.getZ(i)); }
    idx.push(k);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  out.setIndex(idx);
  return out;
}

// Height map of a rock geometry's top surface in its own space (unit scale): rays straight
// down onto the mesh on a grid over its footprint. NaN where the rock isn't.
const HM = 36;
function localHeightMap(geo) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const ext = Math.max(Math.abs(bb.min.x), bb.max.x, Math.abs(bb.min.z), bb.max.z) * 1.02;
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const rc = new THREE.Raycaster();
  const o = new THREE.Vector3(), down = new THREE.Vector3(0, -1, 0);
  const h = new Float32Array(HM * HM);
  for (let j = 0; j < HM; j++) {
    for (let i = 0; i < HM; i++) {
      o.set(-ext + (2 * ext * i) / (HM - 1), bb.max.y + 1, -ext + (2 * ext * j) / (HM - 1));
      rc.set(o, down);
      const hit = rc.intersectObject(mesh, false)[0];
      h[j * HM + i] = hit ? hit.point.y : NaN;
    }
  }
  return { h, ext, top: bb.max.y, bottom: bb.min.y };
}

function sampleLocal(L, x, z) {
  const fx = ((x + L.ext) / (2 * L.ext)) * (HM - 1), fz = ((z + L.ext) / (2 * L.ext)) * (HM - 1);
  if (fx < 0 || fz < 0 || fx > HM - 1 || fz > HM - 1) return NaN;
  const i = Math.min(HM - 2, fx | 0), j = Math.min(HM - 2, fz | 0);
  const tx = fx - i, tz = fz - j;
  const a = L.h[j * HM + i], b = L.h[j * HM + i + 1], c = L.h[(j + 1) * HM + i], d = L.h[(j + 1) * HM + i + 1];
  if (a === a && b === b && c === c && d === d) return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  // at the rim: the nearest corner that is rock
  const k = (tz < 0.5 ? j : j + 1) * HM + (tx < 0.5 ? i : i + 1);
  return L.h[k];
}

// World-space top-surface grid of one placed rock (G × G cells over its footprint).
const G = 18;
function bakeWorldTop(it, L, matrix) {
  const inv = new THREE.Matrix4().copy(matrix).invert();
  const R = it.R;
  const top = new Float32Array(G * G);
  const p = new THREE.Vector3();
  let maxY = -Infinity;
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      const wx = it.x - R + (2 * R * i) / (G - 1), wz = it.z - R + (2 * R * j) / (G - 1);
      // a vertical line through (wx, wz) in rock space; two passes correct for the tilt
      let y = it.y + it.s * L.top;
      let hy = NaN;
      for (let k = 0; k < 2; k++) {
        p.set(wx, y, wz).applyMatrix4(inv);
        const lh = sampleLocal(L, p.x, p.z);
        if (lh !== lh) { hy = NaN; break; }
        p.y = lh;
        p.applyMatrix4(matrix);
        y = p.y;
        hy = p.y;
      }
      top[j * G + i] = hy === hy ? hy : -1e4;
      if (hy === hy) maxY = Math.max(maxY, hy);
    }
  }
  it.top = top;
  it.maxY = maxY;
}

// Height of a rock's top surface at (x, z), or -Infinity outside it.
export function rockTopAt(it, x, z) {
  const R = it.R;
  const fx = ((x - it.x + R) / (2 * R)) * (G - 1), fz = ((z - it.z + R) / (2 * R)) * (G - 1);
  if (fx < 0 || fz < 0 || fx > G - 1 || fz > G - 1) return -Infinity;
  const i = Math.min(G - 2, fx | 0), j = Math.min(G - 2, fz | 0);
  const tx = fx - i, tz = fz - j;
  const T = it.top;
  const a = T[j * G + i], b = T[j * G + i + 1], c = T[(j + 1) * G + i], d = T[(j + 1) * G + i + 1];
  if (a > -1e3 && b > -1e3 && c > -1e3 && d > -1e3) return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  // the rim: inside only near a cell corner that is rock
  const k = (tz < 0.5 ? j : j + 1) * G + (tx < 0.5 ? i : i + 1);
  return T[k] > -1e3 ? T[k] : -Infinity;
}

export class Rocks {
  // models: Higgsfield boulder models (models.js loadRockModels) or null for procedural rocks
  constructor(scene, terrain, forest, textures, seed, models = null) {
    this.terrain = terrain;
    this.rng = new RNG(seed + 51);
    const noise = new Simplex(seed + 53);
    const shapes = [0, 0, 1, 2, 0, 1];
    const variants = shapes.map((sh, i) => buildRockGeometry(seed + i * 13 + 3, sh));
    // v5: photoreal scanned-style boulders where the models are there (round boulder, flat slab,
    // tall block), each fitted to the unit size of the procedural rock it replaces
    const modelMats = [];
    if (models) {
      const byShape = ['boulder', 'slab', 'block'];
      const fitted = {};
      for (const [name, parts] of Object.entries(models)) {
        const p = parts[0];
        fitParts([p], 'r', name === 'slab' ? 1.25 : 1.0, -0.3);
        fitted[name] = p;
      }
      shapes.forEach((sh, i) => {
        const p = fitted[byShape[sh]] || fitted.boulder;
        if (p) { variants[i] = p.geo; modelMats[i] = p.mat; }
      });
    }
    this.local = variants.map((g) => localHeightMap(g));
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
    mat.customProgramCacheKey = () => 'rock';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.tRockA = { value: textures.rock.map };
      shader.uniforms.tRockN = { value: textures.rock.normalMap };
      shader.uniforms.tGrassA = { value: textures.forest.map };
      shader.uniforms.uRockTile = { value: textures.rock.tile || 3.0 };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP;\nvarying vec3 vWN;')
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
{
  vec4 wp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    wp = instanceMatrix * wp;
  #endif
  vWP = (modelMatrix * wp).xyz;
  vec3 on = objectNormal;
  #ifdef USE_INSTANCING
    on = mat3(instanceMatrix) * on;
  #endif
  vWN = normalize(mat3(modelMatrix) * on);
}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D tRockA, tRockN, tGrassA;
uniform float uRockTile;
varying vec3 vWP;
varying vec3 vWN;`)
        .replace('#include <map_fragment>', `
vec3 wn = normalize(vWN);
vec3 bw = pow(abs(wn), vec3(4.0)); bw /= dot(bw, vec3(1.0));
vec2 ux = vWP.zy / uRockTile, uy = vWP.xz / uRockTile, uz = vWP.xy / uRockTile;
vec3 alb = texture(tRockA, ux).rgb * bw.x + texture(tRockA, uy).rgb * bw.y + texture(tRockA, uz).rgb * bw.z;
vec4 nx = texture(tRockN, ux), ny = texture(tRockN, uy), nz = texture(tRockN, uz);
float moss = smoothstep(0.74, 0.97, wn.y + (texture(tRockA, uy * 0.5).a - 0.5) * 0.45) * (0.55 + 0.45 * texture(tRockA, uy * 0.13).a);
vec3 mossCol = texture(tGrassA, vWP.xz / 1.5).rgb * vec3(0.7, 1.0, 0.55);
alb = mix(alb * 1.15, mossCol, moss * 0.7);
diffuseColor.rgb = alb;
float rRough = mix(nx.a * bw.x + ny.a * bw.y + nz.a * bw.z, 0.95, moss);
`)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = rRough;')
        .replace('#include <normal_fragment_maps>', `
{
  vec3 tx = nx.xyz * 2.0 - 1.0, ty = ny.xyz * 2.0 - 1.0, tz = nz.xyz * 2.0 - 1.0;
  // whiteout blend of triplanar normal maps
  vec3 n1 = vec3(tx.xy + wn.zy, abs(tx.z) * wn.x);
  vec3 n2 = vec3(ty.xy + wn.xz, abs(ty.z) * wn.y);
  vec3 n3 = vec3(tz.xy + wn.xy, abs(tz.z) * wn.z);
  vec3 wnn = normalize(n1.zyx * bw.x + n2.xzy * bw.y + n3.xyz * bw.z);
  wnn = normalize(mix(wnn, wn, moss * 0.6));
  normal = normalize((viewMatrix * vec4(wnn, 0.0)).xyz);
}`);
    };
    this.items = [];
    const M = CONFIG.map;
    const hx = M.length / 2 + 8, hz = M.width / 2 + 8;
    const free = (x, z, r) => {
      if (!terrain.isFree(x, z, r)) return false;
      for (const o of this.items) if ((o.x - x) ** 2 + (o.z - z) ** 2 < (o.R * 0.55 + r) ** 2) return false;
      if (forest) for (const t of forest.treesNear(x, z, r + 0.6)) if ((t.x - x) ** 2 + (t.z - z) ** 2 < (r + t.trunkR + 0.3) ** 2) return false;
      return true;
    };
    const up = new THREE.Vector3(0, 1, 0), qi = new THREE.Quaternion();
    const place = (x, z, s, v) => {
      const h = terrain.heightAt(x, z);
      if (h < -0.6 || !free(x, z, s * 0.8)) return false;
      const L = this.local[v];
      const R = s * L.ext * 1.12;
      // lean with the slope (mostly), turned and tilted a little at random
      const nrm = terrain.normalAt(x, z);
      const q = new THREE.Quaternion().setFromUnitVectors(up, nrm);
      q.slerp(qi, 0.35);
      q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(this.rng.float(-0.12, 0.12), this.rng.float(0, Math.PI * 2), this.rng.float(-0.12, 0.12))));
      // sunk so no side floats above a slope: the bottom goes below the lowest ground under it
      let hmin = h;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        hmin = Math.min(hmin, terrain.heightAt(x + Math.cos(a) * R * 0.7, z + Math.sin(a) * R * 0.7));
      }
      const y = Math.min(h - s * (0.28 + 0.1 * (L.top - 0.5)), hmin - 0.12 - s * L.bottom * 0.85);
      const it = { x, z, y, s, v, quat: q, radius: s * 0.85, R };
      this.items.push(it);
      return true;
    };
    const size = () => {
      const r = this.rng.next();
      return r < 0.22 ? this.rng.float(1.6, 3.4) : r < 0.7 ? this.rng.float(0.8, 1.6) : this.rng.float(0.4, 0.8);
    };
    // outcrops: a big rock with smaller ones leaning on it (good cover, and steps to climb)
    const clusters = Math.round(CONFIG.rocks.count * 0.12);
    let tries = 0;
    for (let c = 0; c < clusters && tries < 4000; tries++) {
      const x = this.rng.float(-hx, hx), z = this.rng.float(-hz, hz);
      const h = terrain.heightAt(x, z);
      if (h < 0.8) continue;
      const steep = 1 - terrain.normalAt(x, z).y;
      if (this.rng.next() > 0.35 + steep * 2) continue;
      const big = this.rng.float(2.0, 3.6);
      if (!place(x, z, big, this.rng.chance(0.5) ? 2 : this.rng.int(0, 5))) continue;
      c++;
      const n = this.rng.int(2, 5);
      for (let k = 0; k < n; k++) {
        const a = this.rng.float(0, Math.PI * 2), d = big * this.rng.float(0.9, 1.6);
        const s = this.rng.float(0.6, big * 0.65);
        place(x + Math.cos(a) * d, z + Math.sin(a) * d, s, this.rng.int(0, 5));
      }
    }
    tries = 0;
    while (this.items.length < CONFIG.rocks.count && tries < 30000) {
      tries++;
      const x = this.rng.float(-hx, hx), z = this.rng.float(-hz, hz);
      const h = terrain.heightAt(x, z);
      if (h < -0.6) continue;
      const nrm = terrain.normalAt(x, z);
      const n = noise.fbm2(x / 50, z / 50, 2);
      const steep = 1 - nrm.y;
      // clusters on steeper ground, gullies, and along the river bank
      let p = 0.16 + smoothstep(0.05, 0.25, steep) * 0.6 + (n > 0.25 ? 0.35 : 0) + (h < 2.0 ? 0.25 : 0);
      if (this.rng.next() > p * 0.5) continue;
      place(x, z, size(), this.rng.int(0, 5));
    }
    this.meshes = variants.map((g, vi) => {
      const list = this.items.filter((it) => it.v === vi);
      const m = new THREE.InstancedMesh(g, modelMats[vi] || mat, Math.max(1, list.length));
      const mm = new THREE.Matrix4();
      list.forEach((it, i) => {
        mm.compose(new THREE.Vector3(it.x, it.y, it.z), it.quat, new THREE.Vector3(it.s, it.s, it.s));
        m.setMatrixAt(i, mm);
        bakeWorldTop(it, this.local[vi], mm);
      });
      m.count = list.length;
      m.castShadow = true;
      m.receiveShadow = true;
      m.computeBoundingSphere();
      scene.add(m);
      return m;
    });
  }
}
