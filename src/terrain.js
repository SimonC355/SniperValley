// Terrain: analytic V-valley heightfield, baked height grid for fast queries,
// warped-grid mesh and a splatting material (grass / forest floor / rock / mud),
// plus the shrinking-zone line overlay.
import * as THREE from 'three';
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
  }

  riverCenter(x) {
    return 14 * Math.sin(x * 0.0105 + 0.6) + 6 * Math.sin(x * 0.027 + 2.1);
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
    const slopeMask = smoothstep(0.03, 0.3, t);
    h += n.fbm2(x * 0.0042 + 11, z * 0.0042, 3) * 9 * slopeMask;
    // spurs and gullies running down the slopes (stretched across the valley axis)
    const spur = this.noise2.fbm2(x * 0.021, ad * 0.0055 + (north ? 0 : 37), 3);
    h += spur * 6.5 * slopeMask * (1 - smoothstep(1.0, 1.5, t));
    // benches: terraces at mid slope
    const bench = north ? 0.45 : 0.62;
    h += 3.2 * Math.exp(-Math.pow((t - bench) * 9, 2)) * (0.5 + 0.5 * n.noise2(x * 0.01, 3.3));
    h += n.fbm2(x * 0.045, z * 0.045, 3) * 1.4 * smoothstep(0.0, 0.12, t);
    h += n.noise2(x * 0.17, z * 0.17) * 0.22 * smoothstep(0.0, 0.05, t);
    // distant mountains
    const far = smoothstep(1.35, 3.2, t);
    if (far > 0) h += far * (90 + 70 * this.noise2.fbm2(x * 0.0022, z * 0.0022, 4));
    const farX = smoothstep(CONFIG.map.length * 0.9, CONFIG.map.length * 1.7, Math.abs(x));
    if (farX > 0) h += farX * 45 * (0.6 + 0.4 * n.noise2(z * 0.004, x * 0.002)) * smoothstep(0.2, 0.5, t + 0.15);
    return h;
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
        const grass = clamp((1 - canopy * 1.25) * (1 - rock) * dry, 0, 1);
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
  buildMesh(textures, spacing = CONFIG.map.terrainSpacing, segOut = 64, material = null) {
    const M = CONFIG.map;
    const E = M.terrainExtent / 2;
    const innerX = this.halfX + 90, innerZ = this.halfZ + 80;
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
    const uniforms = {
      tGrassA: { value: T.grass.map }, tGrassN: { value: T.grass.normalMap },
      tForestA: { value: T.forest.map }, tForestN: { value: T.forest.normalMap },
      tRockA: { value: T.rock.map }, tRockN: { value: T.rock.normalMap },
      tMudA: { value: T.mud.map }, tMudN: { value: T.mud.normalMap },
      tMacro: { value: T.macro },
      tSplat: { value: this.splatTexture },
      uGridBounds: { value: this.gridBounds },
      ...ZONE_UNIFORMS,
    };
    this.terrainUniforms = uniforms;
    mat.customProgramCacheKey = () => 'terrain';
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
varying vec3 vWPos;
varying vec3 vWNormal;`)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNormal = normalize(mat3(modelMatrix) * objectNormal);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D tGrassA, tGrassN, tForestA, tForestN, tRockA, tRockN, tMudA, tMudN, tMacro, tSplat;
uniform vec4 uGridBounds;
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
vec2 uvG = wxz / 3.3, uvF = wxz / 2.7, uvR = wxz / 7.0, uvM = wxz / 2.9;
vec4 aG = sampleAT(tGrassA, uvG, macro2.g);
vec4 aF = sampleAT(tForestA, uvF, macro2.g);
vec4 aR = sampleAT(tRockA, uvR + vec2(vWPos.y * 0.1), macro2.g);
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
albedo = mix(albedo, albedo * vec3(1.18, 1.08, 0.75), smoothstep(0.55, 0.8, macro.b) * bw.x * 0.7);
// wetness near the waterline
float wet = 1.0 - smoothstep(-0.05, 0.75, vWPos.y);
albedo *= mix(1.0, 0.55, wet);
// zone: tint outside
float dCur = zoneDist(wxz, uZoneCur);
float inPlay = step(abs(wxz.x), uZoneHalfLen + 0.5) * step(abs(wxz.y), ${(CONFIG.map.width / 2 + 0.5).toFixed(1)});
float outside = smoothstep(0.0, 3.0, dCur) * inPlay;
albedo = mix(albedo, albedo * vec3(1.25, 0.55, 0.5), outside * 0.55);
diffuseColor.rgb = albedo;
vec4 nmix = sampleNT(tGrassN, uvG, macro2.g) * bw.x + sampleNT(tForestN, uvF, macro2.g) * bw.y
          + sampleNT(tRockN, uvR + vec2(vWPos.y * 0.1), macro2.g) * bw.z + sampleNT(tMudN, uvM, macro2.g) * bw.w;
float tRough = mix(nmix.a, 0.28, wet);
`)
        .replace('#include <roughnessmap_fragment>', `float roughnessFactor = tRough;`)
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
