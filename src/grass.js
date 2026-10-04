// Instanced grass near the viewer. The field is split into tiles that wrap around the
// focus point (camera, or the scope aim point when zoomed) so blades stay world-anchored.
// Blade height comes from the baked heightmap, density from the terrain splat map.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { SHARED } from './shaders.js';

function buildClump(blades = 4, segs = 2) {
  const pos = [], uv = [], nrm = [], idx = [], bl = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let b = 0; b < blades; b++) {
    const ox = (rnd() - 0.5) * 0.26, oz = (rnd() - 0.5) * 0.26;
    const yaw = rnd() * Math.PI * 2;
    const dx = Math.cos(yaw), dz = Math.sin(yaw);
    const leanX = -dz, leanZ = dx;
    const base = pos.length / 3;
    const hMul = 0.7 + rnd() * 0.45;
    for (let r = 0; r <= segs; r++) {
      const t = r / segs;
      const w = 0.016 * (1 - t) + 0.002;
      const lean = t * t * 0.18;
      for (const s of [-1, 1]) {
        pos.push(ox + dx * w * s + leanX * lean, t * hMul, oz + dz * w * s + leanZ * lean);
        uv.push(s * 0.5 + 0.5, t);
        nrm.push(leanX * 0.4, 1, leanZ * 0.4);
        bl.push(rnd());
      }
    }
    for (let r = 0; r < segs; r++) {
      const a = base + r * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aBlade', new THREE.Float32BufferAttribute(bl, 1));
  g.setIndex(idx);
  return g;
}

export class Grass {
  constructor(scene, terrain, textures) {
    this.terrain = terrain;
    const R = CONFIG.grass.radius;
    const spacing = CONFIG.grass.spacing / Math.sqrt(Math.max(0.05, CONFIG.render.grassDensity));
    const T = 10;
    this.T = T;
    this.tilesPerSide = Math.ceil((2 * R) / T);
    this.R = (this.tilesPerSide * T) / 2;
    const perSide = Math.max(1, Math.round(T / spacing));
    const geo = buildClump();
    const offsets = new Float32Array(perSide * perSide * 2);
    let k = 0;
    for (let j = 0; j < perSide; j++) for (let i = 0; i < perSide; i++) {
      offsets[k++] = (i + 0.5) * (T / perSide);
      offsets[k++] = (j + 0.5) * (T / perSide);
    }
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 2));
    geo.instanceCount = perSide * perSide;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(T / 2, 0, T / 2), T * 0.75 + 4);
    this.cell = T / perSide;
    this.uniforms = {
      tHeight: { value: terrain.heightTexture },
      tSplat: { value: terrain.splatTexture },
      tGrassA: { value: textures.grass.map },
      tMacro: { value: textures.macro },
      uHB: { value: terrain.gridBounds },
      uFadeCenter: { value: new THREE.Vector2() },
      uFadeRadius: { value: this.R },
      uCell: { value: this.cell },
      uTileSize: { value: T },
      uDensity: { value: Math.min(1, CONFIG.render.grassDensity) },
    };
    const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.82 });
    mat.customProgramCacheKey = () => 'grass';
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.uniforms.uTime = SHARED.uTime;
      shader.uniforms.uWindDir = SHARED.uWindDir;
      shader.uniforms.uWindStrength = SHARED.uWindStrength;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
uniform sampler2D tHeight, tSplat;
uniform vec4 uHB;
uniform vec2 uFadeCenter;
uniform float uFadeRadius, uCell, uTileSize, uDensity, uTime, uWindStrength;
uniform vec2 uWindDir;
attribute vec2 aOffset;
attribute float aBlade;
varying vec2 vBaseXZ;
varying float vT;
varying float vShade;
uvec2 pcg2(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return v;
}`)
        .replace('#include <begin_vertex>', `
vec3 tileO = vec3(modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2]);
ivec2 tIdx = ivec2(floor(tileO.xz / uTileSize + 0.5));
uvec2 hh = pcg2(uvec2(uint(tIdx.x + 30000) * 977u + uint(gl_InstanceID), uint(tIdx.y + 30000) * 131u + uint(gl_InstanceID) * 7u));
vec4 rr = vec4(float(hh.x & 0xffffu), float(hh.x >> 16u), float(hh.y & 0xffffu), float(hh.y >> 16u)) / 65535.0;
vec2 wxz = tileO.xz + aOffset + (rr.xy - 0.5) * uCell * 0.9;
vec2 huv = (wxz - uHB.xy) / uHB.zw;
float gy = texture(tHeight, huv).r;
float dens = texture(tSplat, huv).g * uDensity;
float d = length(wxz - uFadeCenter);
float fade = 1.0 - smoothstep(uFadeRadius * 0.62, uFadeRadius * 0.97, d);
float show = step(rr.z, dens * 1.15) * fade;
float H = mix(0.18, 0.5, rr.w) * (0.55 + 0.6 * dens) * show;
float ang = rr.x * 6.2831;
float ca = cos(ang), sa = sin(ang);
vec3 p = position;
vec2 pr = vec2(p.x * ca - p.z * sa, p.x * sa + p.z * ca) * (0.6 + 0.6 * show);
float t = p.y;
vec2 wind = uWindDir * (sin(uTime * 1.9 + dot(wxz, vec2(0.21, 0.17))) * 0.6 + 0.5 + sin(uTime * 4.7 + wxz.x * 1.3) * 0.15) * uWindStrength * 0.22;
vec2 bend = (wind + (rr.yz - 0.5) * 0.25) * t * t * H;
vec3 transformed = vec3(wxz.x + pr.x + bend.x - tileO.x, gy + t * H - tileO.y - 0.02, wxz.y + pr.y + bend.y - tileO.z);
vBaseXZ = wxz;
vT = t;
vShade = aBlade;`)
        .replace('#include <beginnormal_vertex>', `vec3 objectNormal = normalize(vec3(normal.x * 0.4, 1.0, normal.z * 0.4));
#ifdef USE_TANGENT
vec3 objectTangent = vec3(tangent.xyz);
#endif`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D tGrassA, tMacro;
varying vec2 vBaseXZ;
varying float vT;
varying float vShade;`)
        .replace('#include <map_fragment>', `
vec3 gcol = texture(tGrassA, vBaseXZ / 3.3).rgb;
vec4 mac = texture(tMacro, vBaseXZ / 47.0);
gcol *= 0.82 + 0.36 * mac.r;
float lum = dot(gcol, vec3(0.3, 0.6, 0.1));
gcol = mix(vec3(lum), gcol, 1.25);
diffuseColor.rgb = gcol * mix(0.55, 1.2, vT) * (0.85 + 0.3 * vShade);`)
        .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
    };
    this.material = mat;
    this.tiles = [];
    const n = this.tilesPerSide;
    this.group = new THREE.Group();
    for (let i = 0; i < n * n; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.receiveShadow = true;
      m.castShadow = false;
      m.matrixAutoUpdate = true;
      this.group.add(m);
      this.tiles.push({ mesh: m, ix: i % n, iz: Math.floor(i / n) });
    }
    scene.add(this.group);
  }

  update(center) {
    const T = this.T, n = this.tilesPerSide, R = this.R, span = n * T;
    this.uniforms.uFadeCenter.value.set(center.x, center.z);
    for (const tile of this.tiles) {
      // place tile origin at the position congruent to its index (mod span) inside [c-R, c+R)
      const bx = tile.ix * T, bz = tile.iz * T;
      const ox = center.x - R + (((bx - (center.x - R)) % span) + span) % span;
      const oz = center.z - R + (((bz - (center.z - R)) % span) + span) % span;
      tile.mesh.position.set(ox, this.terrain.heightAt(ox + T / 2, oz + T / 2), oz);
    }
  }
}
