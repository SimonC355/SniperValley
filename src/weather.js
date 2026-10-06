// Living weather.
// - Clouds: one drifting cloud field drawn in the sky AND used for cloud shadows on
//   everything lit by the sun (terrain, trees, grass, characters). Both look the field up the
//   same way, so when a cloud covers the sun in the sky you are standing in its shadow.
//   The shadow is added to three's lighting chunk once, for every lit material.
// Gusts (bands of stronger wind travelling down the valley) are in shaders.js.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { SHARED, sunDirection } from './shaders.js';
import { RNG } from './noise.js';

const N = 256;           // cloud texture size (tileable)
const TILE = 1100;       // metres of cloud layer per texture repeat
const HEIGHT = 900;      // cloud layer height, metres
const EDGE = 0.1;        // soft edge of a cloud shadow (in noise units)

// ------------------------------------------------------------------------- cloud field
// Tileable fbm of value noise in 0..1.
function cloudField(seed) {
  const rng = new RNG(seed);
  const out = new Float32Array(N * N);
  let amp = 1, total = 0;
  for (let o = 0, period = 4; o < 5; o++, period *= 2) {
    const g = new Float32Array(period * period);
    for (let i = 0; i < g.length; i++) g[i] = rng.next();
    const s = period / N;
    for (let y = 0; y < N; y++) {
      const fy = y * s, y0 = Math.floor(fy), ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % period) * period, r1 = ((y0 + 1) % period) * period;
      for (let x = 0; x < N; x++) {
        const fx = x * s, x0 = Math.floor(fx), tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const c0 = x0 % period, c1 = (x0 + 1) % period;
        const a = g[r0 + c0] + (g[r0 + c1] - g[r0 + c0]) * sx;
        const b = g[r1 + c0] + (g[r1 + c1] - g[r1 + c0]) * sx;
        out[y * N + x] += (a + (b - a) * sy) * amp;
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

export const WEATHER = {
  // uniforms shared by reference (typed arrays are not cloned by three's uniform cloning)
  cloudA: new Float32Array(4),   // drift u, drift v, coverage threshold, shadow strength
  cloudB: new Float32Array(4),   // sun x/y, sun z/y, cloud height, 1 / tile size
  tex: null,
  data: null,
  sunVis: 1,                     // sun visibility at the camera (0 = behind a cloud)
};

const CLOUD_GLSL = /* glsl */`
uniform sampler2D uCloudTex;
uniform vec4 uCloudA;
uniform vec4 uCloudB;
// 0 = clear sky above this point toward the sun, 1 = inside a cloud's shadow
float cloudCoverAt(vec3 wp) {
  vec2 q = wp.xz + uCloudB.xy * (uCloudB.z - wp.y);
  vec2 uv = q * uCloudB.w + uCloudA.xy;
  float n = texture(uCloudTex, uv).r * 0.72 + texture(uCloudTex, uv * 3.3 + vec2(0.37, 0.61)).r * 0.28;
  return smoothstep(uCloudA.z, uCloudA.z + ${EDGE.toFixed(2)}, n);
}`;

// Must run before any material compiles (adds the cloud shadow to every lit material).
export function installWeather() {
  const data = cloudField(CONFIG.seed + 909);
  WEATHER.data = data;
  const bytes = new Uint8Array(N * N);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(data[i] * 255);
  const tex = new THREE.DataTexture(bytes, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  tex.clone = function () { return this; };   // one texture for every material
  WEATHER.tex = tex;
  // coverage: the share of the sky covered by cloud (by the combined lookup's distribution;
  // seeded, so every player in a LAN game gets the same clouds)
  const rng = new RNG(CONFIG.seed + 913);
  const sample = [];
  for (let i = 0; i < 4000; i++) {
    const u = rng.next(), v = rng.next();
    sample.push(sampleData(u, v) * 0.72 + sampleData(u * 3.3 + 0.37, v * 3.3 + 0.61) * 0.28);
  }
  sample.sort((a, b) => a - b);
  const cover = CONFIG.weather.cloudCover;
  WEATHER.cloudA[2] = sample[Math.floor((1 - cover) * (sample.length - 1))] - EDGE * 0.5;
  WEATHER.cloudA[3] = CONFIG.weather.cloudShadow;
  const sun = sunDirection();
  WEATHER.cloudB.set([sun.x / sun.y, sun.z / sun.y, HEIGHT, 1 / TILE]);

  const C = THREE.ShaderChunk;
  C.lights_pars_begin = C.lights_pars_begin + CLOUD_GLSL;
  C.lights_fragment_begin = /* glsl */`
float cloudSun = 1.0;
#ifndef NO_CLOUD_SHADOW
  cloudSun = 1.0 - cloudCoverAt(cameraPosition + transpose(mat3(viewMatrix)) * (-vViewPosition)) * uCloudA.w;
#endif
` + C.lights_fragment_begin.replace('getDirectionalLightInfo( directionalLight, directLight );',
    'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= cloudSun;');
  for (const id of ['standard', 'physical', 'lambert', 'phong', 'toon']) {
    Object.assign(THREE.ShaderLib[id].uniforms, cloudUniforms());
  }
}

export function cloudUniforms() {
  return { uCloudTex: { value: WEATHER.tex }, uCloudA: { value: WEATHER.cloudA }, uCloudB: { value: WEATHER.cloudB } };
}

export const CLOUD_FUNCTIONS = CLOUD_GLSL;

// bilinear lookup of the base texture (u, v in texture repeats)
function sampleData(u, v) {
  const d = WEATHER.data;
  const fx = (u - Math.floor(u)) * N - 0.5, fy = (v - Math.floor(v)) * N - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const i0 = ((x0 % N) + N) % N, i1 = (i0 + 1) % N, j0 = ((y0 % N) + N) % N, j1 = (j0 + 1) % N;
  const a = d[j0 * N + i0] + (d[j0 * N + i1] - d[j0 * N + i0]) * tx;
  const b = d[j1 * N + i0] + (d[j1 * N + i1] - d[j1 * N + i0]) * tx;
  return a + (b - a) * ty;
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Same as the GLSL cloudCoverAt (0 clear .. 1 cloud shadow).
export function cloudCoverAt(x, y, z) {
  const A = WEATHER.cloudA, B = WEATHER.cloudB;
  const qx = x + B[0] * (B[2] - y), qz = z + B[1] * (B[2] - y);
  const u = qx * B[3] + A[0], v = qz * B[3] + A[1];
  const n = sampleData(u, v) * 0.72 + sampleData(u * 3.3 + 0.37, v * 3.3 + 0.61) * 0.28;
  return smooth(A[2], A[2] + EDGE, n);
}

// Direct sunlight reaching a point (1 in the open sun, 1 - shadow strength under a cloud).
export function sunlightAt(pos) {
  return 1 - cloudCoverAt(pos.x, pos.y, pos.z) * WEATHER.cloudA[3];
}

// Per frame: drift the clouds with the wind, and measure the sun at the camera.
export function updateWeather(time, camera) {
  const w = SHARED.uWindDir.value;
  const speed = CONFIG.weather.cloudSpeed / TILE;
  WEATHER.cloudA[0] = -w.x * speed * time;
  WEATHER.cloudA[1] = -w.y * speed * time;
  const p = camera.position;
  WEATHER.sunVis = 1 - cloudCoverAt(p.x, p.y, p.z);
}
