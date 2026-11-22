// The sculpted snipers on the three.js side: builds their pieces once per map load (in a worker,
// or here if workers can't), turns them into geometry, and has the materials: the one every
// sculpted piece shares (camo, face paint, gear colour) for both looks, and for the realistic
// ghillie the jute / leaf atlas and the strand material that lets the strands hang with
// gravity and move in the wind.
import * as THREE from 'three';
import { sniperReady, buildSniperPieces, FACE_PAINTS } from './sculptedsniper.js';
import { ATLAS } from './ghilliestrands.js';
import { CONFIG } from './config.js';
import { SHARED, GUST_GLSL } from './shaders.js';
import { RNG } from './noise.js';

let PIECES = null;
let pending = null;

// { look, sniper: [near, far] skinned geometries, rifle, rifleFar, rifleStrands, bolt,
//   fpArms: { solid, leaves | strands }, head } once prepared, else null
export const sniperPieces = () => PIECES;

export function prepareSniperPieces(BONES, look) {
  if (PIECES) return Promise.resolve(PIECES);
  if (pending) return pending;
  const t0 = performance.now();
  pending = (async () => {
    let data = null;
    try { data = await inWorker(BONES, look); } catch (e) { console.warn('sculpted sniper: no worker, building here', e); }
    if (!data) {
      try { await sniperReady; data = buildSniperPieces(BONES, look); } catch (e) { console.warn('sculpted sniper: unavailable', e); return null; }
    }
    const g = (p) => (p ? toGeometry(p) : null);
    PIECES = {
      look: data.look, sniper: data.sniper.map(toGeometry), rifle: g(data.rifle), rifleFar: g(data.rifleFar), rifleStrands: g(data.rifleStrands),
      bolt: g(data.bolt), fpArms: { solid: g(data.fpArms.solid), leaves: g(data.fpArms.leaves), strands: g(data.fpArms.strands) },
      head: data.head, stats: { ...data.sniper[0].stats, total: Math.round(performance.now() - t0) },
    };
    return PIECES;
  })();
  return pending;
}

function inWorker(BONES, look) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(new URL('./sniperworker.js', import.meta.url), { type: 'module' }); } catch (e) { reject(e); return; }
    const done = () => { clearTimeout(timer); w.terminate(); };
    const timer = setTimeout(() => { done(); reject(new Error('timed out')); }, 90000);
    w.onmessage = (e) => { done(); if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.pieces); };
    w.onerror = (e) => { done(); reject(e.error || new Error(e.message || 'worker error')); };
    w.postMessage({ bones: BONES, look });
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
// green, khaki, brown), where the camo blobs fall, and the tone of the leaves or jute.
const GEAR_COLOURS = [0x8c7754, 0x5f6440, 0x9b8d62, 0x6e5a3e];
const LEAF_TONES = [[1, 1, 1], [0.9, 1.02, 0.84], [1.1, 1.0, 0.82], [0.92, 0.94, 0.9]];
const JUTE_TONES = [[1, 1, 1], [0.93, 0.97, 0.86], [1.06, 0.98, 0.88], [0.86, 0.86, 0.8]];
export function sniperVariant(i) {
  const k = ((i % 16) + 16) % 16;
  const real = PIECES && PIECES.look === 'real';
  return {
    gear: new THREE.Color(GEAR_COLOURS[k % 4]),
    camoShift: new THREE.Vector3(k * 0.731 % 1, k * 0.377 % 1, k * 0.519 % 1).multiplyScalar(9),
    leaves: new THREE.Color(...(real ? JUTE_TONES : LEAF_TONES)[(k + (k >> 2)) % 4]),
  };
}

// Camo per look: the stylized woodland (olive, green, brown, dark branches; crisp edges) and a
// realistic woodland (muted, softer edges, a fine fabric grain).
const CAMO = {
  stylized: { base: [0.152, 0.184, 0.066], a: [0.062, 0.098, 0.026], b: [0.142, 0.088, 0.036], c: [0.03, 0.031, 0.02], soft: 0.8, grain: 0 },
  real: { base: [0.13, 0.127, 0.072], a: [0.045, 0.062, 0.03], b: [0.096, 0.062, 0.036], c: [0.022, 0.021, 0.017], soft: 2.4, grain: 1 },
};

// One material for every sculpted piece: vertex colours (with the baked occlusion), per-vertex
// roughness, the woodland camo pattern where aCamo is 1 and the face paint where it is 2 (both
// drawn from the bind-pose position, so they stick to the cloth and the skin), the sniper's
// gear colour where aGear is set, and (stylized) a soft rim of light that keeps the silhouette
// clear, or (realistic) a fine grain in the cloth.
export function sniperBodyMaterial(variant = sniperVariant(0)) {
  const look = PIECES ? PIECES.look : 'stylized';
  const head = PIECES ? PIECES.head : [0, 1.62, 0];
  const FP = FACE_PAINTS[look] || FACE_PAINTS.stylized, CM = CAMO[look] || CAMO.stylized;
  const real = look === 'real';
  const uGear = { value: variant.gear }, uCamoShift = { value: variant.camoShift };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  mat.customProgramCacheKey = () => 'sculpted-sniper-' + look;
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
float cBlob(float n, float t) { float w = max(fwidth(n), 0.004) * ${CM.soft.toFixed(2)}; return smoothstep(t - w, t + w, n); }
// woodland camo: a light ground, green and brown blobs, dark branches
vec3 camoAt(vec3 p) {
  vec3 q = p * 8.5;
  q += (vec3(cNoise(q * 1.9 + 3.1), cNoise(q * 1.9 + 7.3), cNoise(q * 1.9 + 1.7)) - 0.5) * 1.1;
  vec3 col = ${v3(CM.base)};
  col = mix(col, ${v3(CM.a)}, cBlob(cNoise(q), 0.53));
  col = mix(col, ${v3(CM.b)}, cBlob(cNoise(q * 1.25 + 11.0), 0.6));
  col = mix(col, ${v3(CM.c)}, cBlob(cNoise(q * 1.7 + 23.0), 0.7));
  return col;
}
// camo face paint over the skin (p: from the head): olive stripes, brown smudges and a dark
// band across the eyes, all with ragged edges
vec3 facePaint(vec3 p) {
  vec3 col = ${v3(FP.skin)};
  float n = cNoise(p * 38.0) + 0.5 * cNoise(p * 90.0 + 4.0) - 0.75;
  float st = sin((p.x * 0.8 + p.y) * 95.0 + n * 3.0);
  col = mix(col, ${v3(FP.green)}, cBlob(st, 0.35) * ${real ? '0.8' : '0.9'});
  col = mix(col, ${v3(FP.brown)}, cBlob(cNoise(p * 30.0 + vec3(9.0, -3.0, 0.0)), 0.64) * 0.8);
  float top = 0.036 + 0.004 * sin(p.x * 140.0 + 1.0) + 0.004 * n, bot = 0.004 + 0.004 * sin(p.x * 110.0 + 2.0) + 0.004 * n;
  col = mix(col, ${v3(FP.dark)}, cBlob(min(top - p.y, p.y - bot), 0.0) * 0.8);
  return col;
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
if (vCamo > 1.5) diffuseColor.rgb *= facePaint(vRest - ${v3(head)});
else if (vCamo > 0.001) diffuseColor.rgb *= mix(vec3(1.0), camoAt(vRest + uCamoShift), vCamo);
diffuseColor.rgb *= mix(vec3(1.0), uGear, vGear);
${CM.grain ? `{
  // the weave of the cloth: a fine grain that fades out before it can shimmer
  float g = cNoise(vRest * 700.0) - 0.5;
  float fade = 1.0 - smoothstep(0.15, 0.6, fwidth(vRest.x * 700.0) + fwidth(vRest.y * 700.0));
  diffuseColor.rgb *= 1.0 + g * 0.16 * fade * step(0.5, vCamo) * step(vCamo, 1.5);
}` : ''}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = vRough;`)
      .replace('#include <opaque_fragment>', `${real ? '' : `{
  float rim = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
  outgoingLight += rim * 0.22 * mix(diffuseColor.rgb, vec3(0.6, 0.66, 0.7), 0.6);
}`}
#include <opaque_fragment>`);
  };
  return mat;
}

// ---------------------------------------------------------------- the ghillie atlas
// Jute (the photo strips), a beech twig and a fern (the map's own cards), and drawn synthetic
// leaf strips, burlap and single leaves, in one 1024² texture. Its mipmaps keep the strands'
// coverage: plain averaging thins hair-like cards into nothing at a distance, so each smaller
// level's alpha is scaled until as much of each region passes the alpha test as at full size.
let ATLAS_TEX = null;
export const GHILLIE_ALPHA_TEST = 0.36;
export function ghillieAtlas(textures) {
  if (ATLAS_TEX) return ATLAS_TEX;
  const S = ATLAS.size;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const put = (tex, r) => {
    const src = drawable(tex);
    if (src) g.drawImage(src, r.x, r.y, r.w, r.h);
  };
  put(textures.ghillie, ATLAS.jute);
  put(textures.beechLeaves || textures.leaves, ATLAS.twig);
  put(textures.fern, ATLAS.fern);
  const rng = new RNG(2024);
  drawLeafStrips(g, ATLAS.leafStrip, rng);
  drawBurlap(g, ATLAS.burlap, rng);
  drawLeaves(g, ATLAS.leaves, rng);
  const base = g.getImageData(0, 0, S, S).data;
  const regions = [ATLAS.jute, ATLAS.twig, ATLAS.fern, ATLAS.leafStrip, ATLAS.burlap, ATLAS.leaves];
  bleed(base, S, regions);
  const levels = coverageMips(base, S, regions, GHILLIE_ALPHA_TEST);
  const flip = (d, n) => {
    const o = new Uint8Array(d.length);
    for (let y = 0; y < n; y++) o.set(d.subarray((n - 1 - y) * n * 4, (n - y) * n * 4), y * n * 4);
    return o;
  };
  const mips = levels.map((d, i) => ({ data: flip(d, S >> i), width: S >> i, height: S >> i }));
  const tex = new THREE.DataTexture(mips[0].data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = mips;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  ATLAS_TEX = tex;
  return tex;
}

// an image, canvas or bitmap to draw; a DataTexture (rows bottom-up) is turned back into one
function drawable(tex) {
  if (!tex || !tex.image) return null;
  const im = tex.image;
  if (typeof HTMLImageElement !== 'undefined' && im instanceof HTMLImageElement) return im;
  if (typeof ImageBitmap !== 'undefined' && im instanceof ImageBitmap) return im;
  if (typeof HTMLCanvasElement !== 'undefined' && im instanceof HTMLCanvasElement) return im;
  if (im.data && im.width) {
    const c = document.createElement('canvas');
    c.width = im.width; c.height = im.height;
    const id = c.getContext('2d').createImageData(im.width, im.height);
    const w = im.width * 4;
    for (let y = 0; y < im.height; y++) id.data.set(im.data.subarray((im.height - 1 - y) * w, (im.height - y) * w), y * w);
    c.getContext('2d').putImageData(id, 0, 0);
    return c;
  }
  return null;
}

// fill fully transparent texels with the region's average colour, so filtering never pulls
// in black
function bleed(d, S, regions) {
  for (const r of regions) {
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * S + x) * 4;
      if (d[i + 3] > 128) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++; }
    }
    if (!n) continue;
    sr /= n; sg /= n; sb /= n;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * S + x) * 4;
      if (d[i + 3] < 8) { d[i] = sr; d[i + 1] = sg; d[i + 2] = sb; d[i + 3] = 0; }
    }
  }
}

function coverageMips(d0, S, regions, thr) {
  const levels = [d0];
  const t = thr * 255;
  const coverage = (d, n, r, k, scale) => {
    let pass = 0, all = 0;
    const x0 = r.x >> k, y0 = r.y >> k, x1 = Math.max(x0 + 1, (r.x + r.w) >> k), y1 = Math.max(y0 + 1, (r.y + r.h) >> k);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { all++; if (d[(y * n + x) * 4 + 3] * scale > t) pass++; }
    return all ? pass / all : 0;
  };
  const want = regions.map((r) => coverage(d0, S, r, 0, 1));
  let prev = d0, n = S;
  for (let k = 1; n > 1; k++) {
    const m = n >> 1;
    const d = new Uint8ClampedArray(m * m * 4);
    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = ((y * 2 + dy) * n + x * 2 + dx) * 4, al = prev[i + 3] + 1;
        r += prev[i] * al; g += prev[i + 1] * al; b += prev[i + 2] * al; a += prev[i + 3];
      }
      const o = (y * m + x) * 4, wsum = a + 4;
      d[o] = r / wsum; d[o + 1] = g / wsum; d[o + 2] = b / wsum; d[o + 3] = a / 4;
    }
    // per region: the alpha scale that keeps its coverage (binary search)
    if (m >= 4) regions.forEach((r, ri) => {
      if (!want[ri]) return;
      let lo = 0.5, hi = 4;
      for (let it = 0; it < 14; it++) {
        const s = (lo + hi) / 2;
        if (coverage(d, m, r, k, s) < want[ri]) lo = s; else hi = s;
      }
      const s = (lo + hi) / 2;
      const x0 = r.x >> k, y0 = r.y >> k, x1 = (r.x + r.w) >> k, y1 = (r.y + r.h) >> k;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * m + x) * 4 + 3; d[i] = Math.min(255, d[i] * s); }
    });
    levels.push(d);
    prev = d; n = m;
  }
  return levels;
}

// synthetic leaves on strings (like laser-cut ghillie leaves): a dark cord down each strip with
// leaves to the left and right, olive, green, tan and brown
function drawLeafStrips(g, r, rng) {
  const sw = r.w / r.n;
  const cols = ['#4f5a2e', '#5f6b34', '#6b5a38', '#7a6a42', '#3f4a28', '#857a4c'];
  for (let k = 0; k < r.n; k++) {
    const cx = r.x + sw * (k + 0.5);
    g.strokeStyle = '#2e2a1e'; g.lineWidth = 2.2;
    g.beginPath(); g.moveTo(cx, r.y); g.bezierCurveTo(cx + 4, r.y + r.h * 0.3, cx - 5, r.y + r.h * 0.6, cx + 2, r.y + r.h - 8); g.stroke();
    for (let y = r.y + 10; y < r.y + r.h - 30; y += rng.float(22, 34)) {
      const side = rng.chance(0.5) ? 1 : -1;
      leafShape(g, cx + side * 3, y, side * rng.float(0.5, 1.1) + 0.0 * side, rng.float(26, 36), rng.float(14, 19), cols[rng.int(0, cols.length - 1)], rng.chance(0.5) ? 'oak' : 'beech', rng);
    }
  }
}

// frayed burlap: a woven strip, the threads coming loose at the sides and at the bottom
function drawBurlap(g, r, rng) {
  const sw = r.w / r.n;
  for (let k = 0; k < r.n; k++) {
    const x0 = r.x + sw * k + sw * 0.18, x1 = r.x + sw * (k + 1) - sw * 0.18, body = r.y + r.h * 0.62;
    const tone = rng.float(0.85, 1.1);
    g.fillStyle = `rgb(${172 * tone | 0},${150 * tone | 0},${108 * tone | 0})`;
    g.fillRect(x0, r.y, x1 - x0, body - r.y);
    // the weave
    g.globalAlpha = 0.35;
    g.strokeStyle = '#6e5c3c'; g.lineWidth = 1;
    for (let y = r.y; y < body; y += 3) { g.beginPath(); g.moveTo(x0, y + rng.float(-0.5, 0.5)); g.lineTo(x1, y + rng.float(-0.5, 0.5)); g.stroke(); }
    g.strokeStyle = '#d8c79a';
    for (let x = x0; x < x1; x += 3) { g.beginPath(); g.moveTo(x, r.y); g.lineTo(x + rng.float(-1, 1), body); g.stroke(); }
    g.globalAlpha = 1;
    // loose threads at the bottom and the sides
    for (let i = 0; i < 70; i++) {
      const x = rng.float(x0, x1), len = rng.float(r.h * 0.1, r.h * 0.37);
      g.strokeStyle = `rgba(${190 * tone | 0},${168 * tone | 0},${122 * tone | 0},${rng.float(0.6, 1)})`;
      g.lineWidth = rng.float(0.8, 1.8);
      g.beginPath(); g.moveTo(x, body - 6); g.quadraticCurveTo(x + rng.float(-8, 8), body + len * 0.5, x + rng.float(-14, 14), body + len); g.stroke();
    }
    for (let i = 0; i < 26; i++) {
      const y = rng.float(r.y, body), sideX = rng.chance(0.5) ? x0 : x1, dir = sideX === x0 ? -1 : 1;
      g.strokeStyle = `rgba(190,168,122,${rng.float(0.5, 0.9)})`; g.lineWidth = 1;
      g.beginPath(); g.moveTo(sideX, y); g.lineTo(sideX + dir * rng.float(4, 14), y + rng.float(2, 18)); g.stroke();
    }
  }
}

// single leaves, the stem at the bottom: beech (oval, wavy edge, straight veins) and oak
// (lobed), green ones and dry ones
function drawLeaves(g, r, rng) {
  const cw = r.w / r.cols, ch = r.h / r.rows;
  const cols = ['#5d7a2f', '#4f6a2a', '#7a8a3a', '#9a6a32', '#b07c3c', '#7a5a30', '#6a7a34', '#a88a4a'];
  for (let i = 0; i < r.cols * r.rows; i++) {
    const cx = r.x + cw * (i % r.cols + 0.5), cy = r.y + ch * (Math.floor(i / r.cols) + 1) - 8;
    leafShape(g, cx, cy, -Math.PI / 2, ch * 0.8, cw * 0.42, cols[i % cols.length], i % 3 === 2 ? 'oak' : 'beech', rng, true);
  }
}

// one leaf from (x, y) along angle a: length L, half width W
function leafShape(g, x, y, a, L, W, col, kind, rng, stem = false) {
  g.save();
  g.translate(x, y);
  g.rotate(a);
  if (stem) { g.strokeStyle = '#4a3a22'; g.lineWidth = 2; g.beginPath(); g.moveTo(-6, 0); g.lineTo(L * 0.08, 0); g.stroke(); }
  g.beginPath();
  const N = 28;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    let w = Math.sin(Math.PI * Math.pow(t, 0.85)) * W;
    if (kind === 'oak') w *= 0.72 + 0.28 * Math.abs(Math.sin(t * Math.PI * 4.5));
    else w *= 1 + 0.05 * Math.sin(t * Math.PI * 14);
    g.lineTo(t * L, -w);
  }
  for (let i = N; i >= 0; i--) {
    const t = i / N;
    let w = Math.sin(Math.PI * Math.pow(t, 0.85)) * W;
    if (kind === 'oak') w *= 0.72 + 0.28 * Math.abs(Math.sin(t * Math.PI * 4.5 + 0.6));
    else w *= 1 + 0.05 * Math.sin(t * Math.PI * 14 + 1);
    g.lineTo(t * L, w);
  }
  g.closePath();
  const grd = g.createLinearGradient(0, -W, 0, W);
  grd.addColorStop(0, shadeHex(col, 1.12)); grd.addColorStop(0.5, col); grd.addColorStop(1, shadeHex(col, 0.85));
  g.fillStyle = grd;
  g.fill();
  // the midrib and the side veins
  g.strokeStyle = shadeHex(col, 0.7); g.lineWidth = 1.2;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(L * 0.95, 0); g.stroke();
  g.lineWidth = 0.7;
  for (let t = 0.15; t < 0.85; t += 0.1) {
    for (const s of [-1, 1]) { g.beginPath(); g.moveTo(t * L, 0); g.lineTo(t * L + W * 0.5, s * Math.sin(Math.PI * t) * W * 0.85); g.stroke(); }
  }
  g.restore();
}

function shadeHex(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * k))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ---------------------------------------------------------------- strand material
// The realistic ghillie's strands on the skinned sniper: the atlas, alpha test (and alpha to
// coverage with MSAA), lit the same on both sides; in the vertex shader each strand swings from
// its posed direction back toward the direction it had in the bind pose (how it hangs when the
// sniper stands) the further along it is, except where that would push it into the body (lying
// on the back when prone), then wind, gusts and drag move it in world space. motion: the
// character's per-frame uniforms (uVel, uTurn, uCenter, uBob, uDroop).
export function ghillieStrandMaterial(textures, motion) {
  const map = ghillieAtlas(textures);
  const mat = new THREE.MeshStandardMaterial({
    map, alphaTest: GHILLIE_ALPHA_TEST, alphaToCoverage: CONFIG.render.msaa > 0, side: THREE.DoubleSide, vertexColors: true, roughness: 0.92,
  });
  mat.customProgramCacheKey = () => 'ghillie-real';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = SHARED.uTime;
    shader.uniforms.uWindDir = SHARED.uWindDir;
    Object.assign(shader.uniforms, motion);
    shader.vertexShader = strandVertex(shader.vertexShader, true);
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>',
      THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
  };
  // shadows: the same hanging strands, cut out by the same alpha
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: GHILLIE_ALPHA_TEST });
  depth.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = SHARED.uTime;
    shader.uniforms.uWindDir = SHARED.uWindDir;
    Object.assign(shader.uniforms, motion);
    shader.vertexShader = strandVertex(shader.vertexShader, false);
  };
  return { mat, depth };
}

// The atlas material for jute on rigid pieces (the rifle, the first-person sleeves); one, shared.
let CARD_MAT = null;
export function ghillieCardMaterial(textures) {
  if (CARD_MAT) return CARD_MAT;
  const mat = new THREE.MeshStandardMaterial({
    map: ghillieAtlas(textures), alphaTest: GHILLIE_ALPHA_TEST, alphaToCoverage: CONFIG.render.msaa > 0, side: THREE.DoubleSide, vertexColors: true, roughness: 0.92,
  });
  mat.customProgramCacheKey = () => 'ghillie-card';
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>',
      THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
  };
  CARD_MAT = mat;
  return mat;
}

function strandVertex(vs, wind) {
  vs = vs.replace('#include <common>', `#include <common>
attribute float aSway;
attribute vec3 aRoot;
attribute vec3 aRootN;
attribute vec2 aStrand;
uniform float uTime;
uniform vec2 uWindDir;
uniform vec3 uVel;
uniform float uTurn;
uniform vec3 uCenter;
uniform float uBob;
uniform float uDroop;
${GUST_GLSL}`)
    .replace('#include <skinning_vertex>', `#include <skinning_vertex>
#ifdef USE_SKINNING
{
  // the strand's root and the surface normal there, skinned like the strand
  mat4 skinM = boneMatX * skinWeight.x + boneMatY * skinWeight.y + boneMatZ * skinWeight.z + boneMatW * skinWeight.w;
  skinM = bindMatrixInverse * skinM * bindMatrix;
  vec3 root = (skinM * vec4(aRoot, 1.0)).xyz;
  vec3 rootN = normalize(mat3(skinM) * aRootN);
  vec3 V = transformed - root;
  float L = length(V);
  if (L > 1e-4) {
    vec3 dirP = V / L;
    vec3 dirB = normalize(position - aRoot + vec3(0.0, 1e-5, 0.0));
    // hang as in the bind pose, unless that points into the body here
    float gate = smoothstep(-0.25, 0.35, dot(dirB, rootN));
    float f = clamp(aStrand.x * aStrand.y * gate, 0.0, 1.0);
    transformed = root + normalize(mix(dirP, dirB, f) + vec3(0.0, 1e-5, 0.0)) * L;
  }
}
#endif`);
  if (!wind) return vs;
  return vs.replace('#include <project_vertex>', `
vec4 wp = modelMatrix * vec4(transformed, 1.0);
{
  float ph = dot(aRoot, vec3(7.1, 3.3, 5.7)) + aStrand.x * 2.0;
  float gust = gustAt(uCenter.xz) * ${CONFIG.weather.gusts.toFixed(3)};
  vec3 wind = vec3(uWindDir.x, 0.0, uWindDir.y);
  vec3 d = wind * (sin(uTime * 2.2 + ph) * (0.6 + 0.8 * gust) + 0.4 + 1.3 * gust) * 0.035
         + vec3(sin(uTime * 5.1 + ph * 2.0), 0.0, cos(uTime * 4.3 + ph)) * 0.012 * (1.0 + 2.2 * gust);
  vec3 rel = wp.xyz - uCenter;
  vec3 drag = -uVel * 0.05 - vec3(rel.z, 0.0, -rel.x) * uTurn * 0.07;
  float dl = length(drag);
  if (dl > 0.28) drag *= 0.28 / dl;
  d += drag + vec3(0.0, uBob * (0.5 + 0.5 * sin(ph)), 0.0);
  wp.xyz += d * aSway;
}
vec4 mvPosition = viewMatrix * wp;
gl_Position = projectionMatrix * mvPosition;`);
}
