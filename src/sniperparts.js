// The stylized sniper on the three.js side: builds its pieces once per map load (in a worker,
// or here if workers can't), turns them into geometry, and has the material they share.
import * as THREE from 'three';
import { sniperReady, buildStylizedPieces, FACE_PAINT } from './stylizedsniper.js';

let PIECES = null;
let pending = null;

// { sniper: [near, far] skinned geometries, rifle, rifleFar, bolt, fpArms: { solid, leaves },
//   head } once prepared, else null
export const stylizedPieces = () => PIECES;

export function prepareStylizedPieces(BONES) {
  if (PIECES) return Promise.resolve(PIECES);
  if (pending) return pending;
  const t0 = performance.now();
  pending = (async () => {
    let data = null;
    try { data = await inWorker(BONES); } catch (e) { console.warn('stylized sniper: no worker, building here', e); }
    if (!data) {
      try { await sniperReady; data = buildStylizedPieces(BONES); } catch (e) { console.warn('stylized sniper: unavailable', e); return null; }
    }
    PIECES = {
      sniper: data.sniper.map(toGeometry), rifle: toGeometry(data.rifle), rifleFar: toGeometry(data.rifleFar), bolt: toGeometry(data.bolt),
      fpArms: { solid: toGeometry(data.fpArms.solid), leaves: toGeometry(data.fpArms.leaves) }, head: data.head,
      stats: { ...data.sniper[0].stats, total: Math.round(performance.now() - t0) },
    };
    return PIECES;
  })();
  return pending;
}

function inWorker(BONES) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(new URL('./sniperworker.js', import.meta.url), { type: 'module' }); } catch (e) { reject(e); return; }
    const done = () => { clearTimeout(timer); w.terminate(); };
    const timer = setTimeout(() => { done(); reject(new Error('timed out')); }, 90000);
    w.onmessage = (e) => { done(); if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.pieces); };
    w.onerror = (e) => { done(); reject(e.error || new Error(e.message || 'worker error')); };
    w.postMessage({ bones: BONES });
  });
}

export function toGeometry(p) {
  const g = new THREE.BufferGeometry();
  for (const [name, [arr, size]] of Object.entries(p.attributes)) g.setAttribute(name, new THREE.BufferAttribute(arr, size));
  g.setIndex(new THREE.BufferAttribute(p.index, 1));
  for (const [start, count, m] of p.groups || []) g.addGroup(start, count, m);
  g.computeBoundingSphere();
  return g;
}

const v3 = (c) => `vec3(${c.map((v) => v.toFixed(4)).join(', ')})`;

// Each sniper is a little different: the colour of the vest, pouches and belts (coyote, ranger
// green, khaki, brown), where the camo blobs fall, and the tone of the leaves.
const GEAR_COLOURS = [0x8c7754, 0x5f6440, 0x9b8d62, 0x6e5a3e];
const LEAF_TONES = [[1, 1, 1], [0.9, 1.02, 0.84], [1.1, 1.0, 0.82], [0.92, 0.94, 0.9]];
export function sniperVariant(i) {
  const k = ((i % 16) + 16) % 16;
  return {
    gear: new THREE.Color(GEAR_COLOURS[k % 4]),
    camoShift: new THREE.Vector3(k * 0.731 % 1, k * 0.377 % 1, k * 0.519 % 1).multiplyScalar(9),
    leaves: new THREE.Color(...LEAF_TONES[(k + (k >> 2)) % 4]),
  };
}

// One material for every sculpted piece: vertex colours (with the baked occlusion), per-vertex
// roughness, the woodland camo pattern where aCamo is 1 and the face paint where it is 2 (both
// drawn from the bind-pose position, so they stick to the cloth and the skin), the sniper's
// gear colour where aGear is set, and a soft rim of light that keeps the silhouette clear.
export function sniperBodyMaterial(variant = sniperVariant(0)) {
  const head = PIECES ? PIECES.head : [0, 1.62, 0];
  const uGear = { value: variant.gear }, uCamoShift = { value: variant.camoShift };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  mat.customProgramCacheKey = () => 'sculpted-sniper';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGear = uGear;
    shader.uniforms.uCamoShift = uCamoShift;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aCamo;
attribute float aRough;
attribute float aGear;
varying float vCamo;
varying float vRough;
varying float vGear;
varying vec3 vRest;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vCamo = aCamo; vRough = aRough; vGear = aGear; vRest = position;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uGear;
uniform vec3 uCamoShift;
varying float vCamo;
varying float vRough;
varying float vGear;
varying vec3 vRest;
float cHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float cNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(cHash(i), cHash(i + vec3(1, 0, 0)), f.x), mix(cHash(i + vec3(0, 1, 0)), cHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(cHash(i + vec3(0, 0, 1)), cHash(i + vec3(1, 0, 1)), f.x), mix(cHash(i + vec3(0, 1, 1)), cHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float cBlob(float n, float t) { float w = max(fwidth(n), 0.004) * 0.8; return smoothstep(t - w, t + w, n); }
// woodland camo: olive ground, green and brown blobs, dark branches
vec3 camoAt(vec3 p) {
  vec3 q = p * 8.5;
  q += (vec3(cNoise(q * 1.9 + 3.1), cNoise(q * 1.9 + 7.3), cNoise(q * 1.9 + 1.7)) - 0.5) * 1.1;
  vec3 col = vec3(0.152, 0.184, 0.066);
  col = mix(col, vec3(0.062, 0.098, 0.026), cBlob(cNoise(q), 0.53));
  col = mix(col, vec3(0.142, 0.088, 0.036), cBlob(cNoise(q * 1.25 + 11.0), 0.6));
  col = mix(col, vec3(0.03, 0.031, 0.02), cBlob(cNoise(q * 1.7 + 23.0), 0.7));
  return col;
}
// camo face paint over the skin (p: from the head): olive stripes, brown smudges and a dark
// band across the eyes, all with ragged edges
vec3 facePaint(vec3 p) {
  vec3 col = ${v3(FACE_PAINT.skin)};
  float n = cNoise(p * 38.0) + 0.5 * cNoise(p * 90.0 + 4.0) - 0.75;
  float st = sin((p.x * 0.8 + p.y) * 95.0 + n * 3.0);
  col = mix(col, ${v3(FACE_PAINT.green)}, cBlob(st, 0.35) * 0.9);
  col = mix(col, ${v3(FACE_PAINT.brown)}, cBlob(cNoise(p * 30.0 + vec3(9.0, -3.0, 0.0)), 0.64) * 0.8);
  float top = 0.036 + 0.004 * sin(p.x * 140.0 + 1.0) + 0.004 * n, bot = 0.004 + 0.004 * sin(p.x * 110.0 + 2.0) + 0.004 * n;
  col = mix(col, ${v3(FACE_PAINT.dark)}, cBlob(min(top - p.y, p.y - bot), 0.0) * 0.8);
  return col;
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
if (vCamo > 1.5) diffuseColor.rgb *= facePaint(vRest - ${v3(head)});
else if (vCamo > 0.001) diffuseColor.rgb *= mix(vec3(1.0), camoAt(vRest + uCamoShift), vCamo);
diffuseColor.rgb *= mix(vec3(1.0), uGear, vGear);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = vRough;`)
      .replace('#include <opaque_fragment>', `{
  float rim = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
  outgoingLight += rim * 0.22 * mix(diffuseColor.rgb, vec3(0.6, 0.66, 0.7), 0.6);
}
#include <opaque_fragment>`);
  };
  return mat;
}
