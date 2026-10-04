// Procedural boulders: displaced icospheres, instanced, triplanar rock material with moss on top.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { RNG, Simplex, smoothstep } from './noise.js';

function buildRockGeometry(seed) {
  const g = new THREE.IcosahedronGeometry(1, 2);
  const n = new Simplex(seed);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  const sx = 0.8 + (seed % 5) * 0.12, sy = 0.5 + (seed % 3) * 0.12, sz = 0.75 + (seed % 4) * 0.1;
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

export class Rocks {
  constructor(scene, terrain, forest, textures, seed) {
    this.terrain = terrain;
    this.rng = new RNG(seed + 51);
    const noise = new Simplex(seed + 53);
    const variants = [0, 1, 2, 3].map((i) => buildRockGeometry(seed + i * 13 + 3));
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
    mat.customProgramCacheKey = () => 'rock';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.tRockA = { value: textures.rock.map };
      shader.uniforms.tRockN = { value: textures.rock.normalMap };
      shader.uniforms.tGrassA = { value: textures.forest.map };
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
varying vec3 vWP;
varying vec3 vWN;`)
        .replace('#include <map_fragment>', `
vec3 wn = normalize(vWN);
vec3 bw = pow(abs(wn), vec3(4.0)); bw /= dot(bw, vec3(1.0));
vec2 ux = vWP.zy / 3.0, uy = vWP.xz / 3.0, uz = vWP.xy / 3.0;
vec3 alb = texture(tRockA, ux).rgb * bw.x + texture(tRockA, uy).rgb * bw.y + texture(tRockA, uz).rgb * bw.z;
vec4 nx = texture(tRockN, ux), ny = texture(tRockN, uy), nz = texture(tRockN, uz);
float moss = smoothstep(0.55, 0.85, wn.y + (texture(tRockA, uy * 0.5).a - 0.5) * 0.5);
vec3 mossCol = texture(tGrassA, vWP.xz / 1.5).rgb * vec3(0.7, 1.0, 0.55);
alb = mix(alb, mossCol, moss * 0.85);
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
    let tries = 0;
    while (this.items.length < CONFIG.rocks.count && tries < 20000) {
      tries++;
      const x = this.rng.float(-hx, hx), z = this.rng.float(-hz, hz);
      const h = terrain.heightAt(x, z);
      if (h < -0.6) continue;
      const nrm = terrain.normalAt(x, z);
      const n = noise.fbm2(x / 50, z / 50, 2);
      const steep = 1 - nrm.y;
      // clusters on steeper ground, gullies, and along the river bank
      let p = 0.12 + smoothstep(0.05, 0.25, steep) * 0.6 + (n > 0.25 ? 0.35 : 0) + (h < 2.0 ? 0.25 : 0);
      if (this.rng.next() > p * 0.5) continue;
      const big = this.rng.chance(0.25);
      const s = big ? this.rng.float(1.4, 2.6) : this.rng.float(0.5, 1.3);
      this.items.push({ x, z, y: h - s * 0.28, s, v: this.rng.int(0, 3), rot: this.rng.float(0, Math.PI * 2), tilt: this.rng.float(-0.25, 0.25), radius: s * 0.85 });
    }
    this.meshes = variants.map((g, vi) => {
      const list = this.items.filter((it) => it.v === vi);
      const m = new THREE.InstancedMesh(g, mat, Math.max(1, list.length));
      const mm = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      list.forEach((it, i) => {
        e.set(it.tilt, it.rot, it.tilt * 0.5);
        q.setFromEuler(e);
        mm.compose(new THREE.Vector3(it.x, it.y, it.z), q, new THREE.Vector3(it.s, it.s, it.s));
        m.setMatrixAt(i, mm);
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
