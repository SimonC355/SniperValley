// Procedural ghillie-suited sniper: a skinned capsule body covered with layered, alpha-cut
// burlap / leaf / grass strips, thin jute threads and upright grass tufts (hood veil + back
// cape break up the human outline), procedural poses (stand / kneel / prone / aim / walk /
// dead) with breathing, a rifle on the chest bone, and an optional team armband (only shown
// to the player's team). The strands move in world space: wind, passing gusts, trailing
// behind when the wearer moves and swinging out when they turn.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { RNG, lerp } from './noise.js';
import { SHARED, GUST_GLSL } from './shaders.js';

const BONES = [
  // name, parent, x, y, z
  ['root', null, 0, 0, 0],
  ['hips', 'root', 0, 0.95, 0],
  ['spine', 'hips', 0, 0.12, 0],
  ['chest', 'spine', 0, 0.25, 0],
  ['neck', 'chest', 0, 0.22, 0],
  ['head', 'neck', 0, 0.08, 0],
  ['upperArmR', 'chest', 0.2, 0.17, 0],
  ['foreArmR', 'upperArmR', 0, -0.29, 0],
  ['handR', 'foreArmR', 0, -0.26, 0],
  ['upperArmL', 'chest', -0.2, 0.17, 0],
  ['foreArmL', 'upperArmL', 0, -0.29, 0],
  ['handL', 'foreArmL', 0, -0.26, 0],
  ['thighR', 'hips', 0.1, -0.03, 0],
  ['shinR', 'thighR', 0, -0.45, 0],
  ['footR', 'shinR', 0, -0.43, 0],
  ['thighL', 'hips', -0.1, -0.03, 0],
  ['shinL', 'thighL', 0, -0.45, 0],
  ['footL', 'shinL', 0, -0.43, 0],
];

// Body parts: bone, capsule from a to b (bone-local), radius, scale, strip count, strip length
const PARTS = [
  { bone: 'hips', a: [0, -0.06, 0], b: [0, 0.1, 0], r: 0.15, sx: 1.3, sz: 0.9, strips: 50, len: [0.22, 0.4] },
  { bone: 'spine', a: [0, 0, 0], b: [0, 0.24, 0], r: 0.15, sx: 1.2, sz: 0.85, strips: 50, len: [0.22, 0.4] },
  { bone: 'chest', a: [0, 0, 0], b: [0, 0.2, 0], r: 0.17, sx: 1.3, sz: 0.85, strips: 70, len: [0.25, 0.45] },
  { bone: 'head', a: [0, 0.1, 0.01], b: [0, 0.1, 0.01], r: 0.12, sx: 1, sz: 1.05, strips: 60, len: [0.22, 0.42], hood: true },
  { bone: 'upperArmR', a: [0, 0, 0], b: [0, -0.28, 0], r: 0.06, strips: 26, len: [0.15, 0.3] },
  { bone: 'foreArmR', a: [0, 0, 0], b: [0, -0.24, 0], r: 0.05, strips: 20, len: [0.12, 0.25] },
  { bone: 'handR', a: [0, -0.04, 0], b: [0, -0.04, 0], r: 0.045, strips: 0 },
  { bone: 'upperArmL', a: [0, 0, 0], b: [0, -0.28, 0], r: 0.06, strips: 26, len: [0.15, 0.3] },
  { bone: 'foreArmL', a: [0, 0, 0], b: [0, -0.24, 0], r: 0.05, strips: 20, len: [0.12, 0.25] },
  { bone: 'handL', a: [0, -0.04, 0], b: [0, -0.04, 0], r: 0.045, strips: 0 },
  { bone: 'thighR', a: [0, 0, 0], b: [0, -0.43, 0], r: 0.085, strips: 36, len: [0.18, 0.35] },
  { bone: 'shinR', a: [0, 0, 0], b: [0, -0.41, 0], r: 0.065, strips: 28, len: [0.15, 0.28] },
  { bone: 'footR', a: [0, -0.03, 0.02], b: [0, -0.03, -0.12], r: 0.05, strips: 6, len: [0.1, 0.18] },
  { bone: 'thighL', a: [0, 0, 0], b: [0, -0.43, 0], r: 0.085, strips: 36, len: [0.18, 0.35] },
  { bone: 'shinL', a: [0, 0, 0], b: [0, -0.41, 0], r: 0.065, strips: 28, len: [0.15, 0.28] },
  { bone: 'footL', a: [0, -0.03, 0.02], b: [0, -0.03, -0.12], r: 0.05, strips: 6, len: [0.1, 0.18] },
];

// Strip colours (linear), matched to the foliage palette.
const PALETTE = [
  [0.09, 0.12, 0.05], [0.13, 0.15, 0.07], [0.16, 0.14, 0.08], [0.11, 0.09, 0.05],
  [0.2, 0.18, 0.1], [0.07, 0.09, 0.04], [0.14, 0.17, 0.08], [0.23, 0.2, 0.12],
];
// grass and dry-grass tones for the tufts stuck into the suit
const TUFT = [[0.12, 0.16, 0.06], [0.17, 0.19, 0.08], [0.24, 0.21, 0.11], [0.1, 0.13, 0.05]];
// where tufts sit: part bone -> count (shoulders, upper back, hood)
const TUFTS = { chest: 22, spine: 8, head: 18, upperArmR: 6, upperArmL: 6 };

function buildGeometry(seed) {
  const rng = new RNG(seed);
  const boneIndex = Object.fromEntries(BONES.map((b, i) => [b[0], i]));
  const pos = [], nrm = [], uv = [], col = [], skinI = [], skinW = [], sway = [];
  const idxBody = [], idxStrip = [];
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  const push = (p, nn, u, vv, c, bi, sw) => {
    pos.push(p.x, p.y, p.z); nrm.push(nn.x, nn.y, nn.z); uv.push(u, vv); col.push(c[0], c[1], c[2]);
    skinI.push(bi, 0, 0, 0); skinW.push(1, 0, 0, 0); sway.push(sw);
    return pos.length / 3 - 1;
  };
  // bone rest positions (model space), needed because geometry is in model space at bind
  const rest = {};
  for (const [name, parent, x, y, z] of BONES) {
    const pp = parent ? rest[parent] : new THREE.Vector3();
    rest[name] = new THREE.Vector3(x, y, z).add(pp);
  }
  const bodyCol = [0.05, 0.05, 0.035];
  // one strand: 3 rows of 2 vertices from root along dir, curling toward `out`.
  // aSway grows from 0 at the root to swayMul at the tip.
  const strand = (root, dir, out, L, W, curl, c, colIdx, bi, swayMul) => {
    const side = new THREE.Vector3().crossVectors(dir, out).normalize();
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    const u0 = colIdx / 8 + 0.004, u1 = (colIdx + 1) / 8 - 0.004;
    const nn = out.clone().addScaledVector(dir, -0.2).normalize();
    const rows = [];
    for (let r = 0; r <= 2; r++) {
      const k = r / 2;
      const p = root.clone().addScaledVector(dir, L * k).addScaledVector(out, curl * L * k * k);
      const w = W * (1 - k * 0.45);
      rows.push([
        push(p.clone().addScaledVector(side, -w / 2), nn, u0, 1 - k * 0.98, c, bi, k * swayMul),
        push(p.clone().addScaledVector(side, w / 2), nn, u1, 1 - k * 0.98, c, bi, k * swayMul),
      ]);
    }
    for (let r = 0; r < 2; r++) {
      const [a0, a1] = rows[r], [b0, b1] = rows[r + 1];
      idxStrip.push(a0, b0, a1, a1, b0, b1);
    }
  };
  // a point on a part's surface and its outward direction
  const surface = (part, o, a, b, axis, t, ang) => {
    const sx = part.sx || 1, sz = part.sz || 1;
    const axisPt = a.clone().lerp(b, t);
    let radial = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang));
    if (axis.lengthSq() > 1e-6) {
      const ax = axis.clone().normalize();
      radial = radial.sub(ax.clone().multiplyScalar(radial.dot(ax))).normalize();
      if (radial.lengthSq() < 1e-4) radial.set(1, 0, 0);
    } else {
      radial.set(Math.cos(ang) * Math.sin(t * Math.PI * 0.9 + 0.1), Math.cos(t * Math.PI * 0.9 + 0.1), Math.sin(ang) * Math.sin(t * Math.PI * 0.9 + 0.1));
    }
    const root = axisPt.clone().add(new THREE.Vector3(radial.x * part.r * sx, radial.y * part.r, radial.z * part.r * sz)).add(o);
    return { root, radial };
  };
  for (const part of PARTS) {
    const bi = boneIndex[part.bone];
    const o = rest[part.bone];
    const a = new THREE.Vector3(...part.a), b = new THREE.Vector3(...part.b);
    const sx = part.sx || 1, sz = part.sz || 1;
    // ---- body capsule (low poly)
    const cap = new THREE.CapsuleGeometry(part.r, Math.max(0.001, a.distanceTo(b)), 3, 8);
    const axis = new THREE.Vector3().subVectors(b, a);
    const q = new THREE.Quaternion();
    if (axis.lengthSq() > 1e-6) q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().normalize());
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const cp = cap.attributes.position, cn = cap.attributes.normal;
    const base = pos.length / 3;
    for (let i = 0; i < cp.count; i++) {
      v.fromBufferAttribute(cp, i); n.fromBufferAttribute(cn, i);
      v.x *= sx; v.z *= sz;
      v.applyQuaternion(q).add(mid).add(o);
      n.applyQuaternion(q);
      push(v, n, 0.5, 0.5, bodyCol, bi, 0);
    }
    const ci = cap.index.array;
    for (let i = 0; i < ci.length; i++) idxBody.push(base + ci[i]);
    // ---- strips
    for (let s = 0; s < part.strips; s++) {
      const { root, radial } = surface(part, o, a, b, axis, rng.next(), rng.float(0, Math.PI * 2));
      let L = rng.float(part.len[0], part.len[1]);
      const W = rng.float(0.05, 0.12);
      if (part.hood) L *= 1.25;
      // hanging down, a little outward
      const dir = new THREE.Vector3(0, -0.8, 0).addScaledVector(radial, rng.float(0.25, 0.6)).normalize();
      const c = PALETTE[rng.int(0, PALETTE.length - 1)];
      const cj = rng.float(0.85, 1.15);
      strand(root, dir, radial, L, W, rng.float(0.05, 0.25), [c[0] * cj, c[1] * cj, c[2] * cj], rng.int(0, 7), bi, 1);
    }
    // ---- jute threads: thin, long, loose (they move the most)
    const threads = Math.round(part.strips * 0.45);
    for (let s = 0; s < threads; s++) {
      const { root, radial } = surface(part, o, a, b, axis, rng.next(), rng.float(0, Math.PI * 2));
      const L = rng.float(part.len[0], part.len[1]) * rng.float(1.1, 1.6) * (part.hood ? 1.2 : 1);
      const dir = new THREE.Vector3(0, -0.85, 0).addScaledVector(radial, rng.float(0.15, 0.45)).normalize();
      const c = PALETTE[rng.int(0, PALETTE.length - 1)];
      const cj = rng.float(0.9, 1.3);
      strand(root, dir, radial, L, rng.float(0.014, 0.028), rng.float(0.1, 0.45), [c[0] * cj, c[1] * cj, c[2] * cj], rng.int(0, 7), bi, 1.5);
    }
    // ---- grass tufts sticking up and out on the shoulders, back and hood
    const tufts = TUFTS[part.bone] || 0;
    for (let s = 0; s < tufts; s++) {
      // upper part of the limb / torso, mostly at the back and the sides
      const t = part.hood ? rng.float(0.0, 0.45) : rng.float(0.55, 1.0);
      let ang = rng.float(0, Math.PI * 2);
      if (!part.hood && Math.sin(ang) < -0.3) ang = -ang;   // keep the chest front clear
      const { root, radial } = surface(part, o, a, b, axis, t, ang);
      const dir = new THREE.Vector3(0, 0.85, 0).addScaledVector(radial, rng.float(0.35, 0.8)).normalize();
      const c = TUFT[rng.int(0, TUFT.length - 1)];
      const cj = rng.float(0.85, 1.2);
      strand(root, dir, radial, rng.float(0.16, 0.32), rng.float(0.05, 0.09), rng.float(0.25, 0.6), [c[0] * cj, c[1] * cj, c[2] * cj], rng.int(0, 7), bi, 1.2);
    }
  }
  // back cape: long strips from the shoulders down the back (in chest space)
  const chestI = boneIndex.chest, chestO = rest.chest;
  for (let s = 0; s < 70; s++) {
    const x = rng.float(-0.22, 0.22);
    const root = new THREE.Vector3(x, rng.float(0.05, 0.22), 0.13 + rng.float(0, 0.05)).add(chestO);
    const L = rng.float(0.45, 0.75), W = rng.float(0.06, 0.13);
    const dir = new THREE.Vector3(x * 0.4, -1, rng.float(0.15, 0.35)).normalize();
    const side = new THREE.Vector3(1, 0, 0);
    const c = PALETTE[rng.int(0, PALETTE.length - 1)];
    const colIdx = rng.int(0, 7);
    const u0 = colIdx / 8 + 0.004, u1 = (colIdx + 1) / 8 - 0.004;
    const rows = [];
    for (let r = 0; r <= 2; r++) {
      const k = r / 2;
      const p = root.clone().addScaledVector(dir, L * k).add(new THREE.Vector3(0, 0, 0.08 * k * k));
      const w = W * (1 - k * 0.4);
      const nn = new THREE.Vector3(0, 0.2, 1).normalize();
      rows.push([
        push(p.clone().addScaledVector(side, -w / 2), nn, u0, 1 - k * 0.98, c, chestI, k),
        push(p.clone().addScaledVector(side, w / 2), nn, u1, 1 - k * 0.98, c, chestI, k),
      ]);
    }
    for (let r = 0; r < 2; r++) {
      const [a0, a1] = rows[r], [b0, b1] = rows[r + 1];
      idxStrip.push(a0, b0, a1, a1, b0, b1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinI, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinW, 4));
  g.setAttribute('aSway', new THREE.Float32BufferAttribute(sway, 1));
  g.setIndex([...idxBody, ...idxStrip]);
  g.addGroup(0, idxBody.length, 0);
  g.addGroup(idxBody.length, idxStrip.length, 1);
  g.computeBoundingSphere();
  return g;
}

const GEO_CACHE = [];
function getGeometry(i) {
  const k = i % 3;
  if (!GEO_CACHE[k]) GEO_CACHE[k] = buildGeometry(101 + k * 17);
  return GEO_CACHE[k];
}

function buildRifle() {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x151614, metalness: 0.6, roughness: 0.5 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x35331f, roughness: 0.9 });
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.013, 0.65, 6), metal);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.z = -0.5;
  g.add(barrel);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.75), wood);
  stock.position.set(0, -0.03, 0.05);
  g.add(stock);
  const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.34, 8), metal);
  scope.rotation.x = Math.PI / 2;
  scope.position.set(0, 0.07, -0.1);
  g.add(scope);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
  return g;
}

// ---------------------------------------------------------------- poses
// Euler XYZ per bone. Unlisted bones are 0. hips: [y, z offset] stored separately.
const P = {
  stand: {
    hipsY: 0.95, hipsZ: 0, hipsX: 0,
    spine: [-0.05, 0, 0], neck: [0.05, 0, 0],
    upperArmR: [0.35, 0, 0.15], foreArmR: [1.2, 0, 0], upperArmL: [0.6, 0, -0.25], foreArmL: [1.3, 0, 0],
    thighR: [0.02, 0, 0.03], thighL: [0.02, 0, -0.03],
    rifle: { pos: [0.05, 0.02, -0.22], rot: [-0.9, 0, 0.45] },
  },
  standAim: {
    hipsY: 0.95, hipsZ: 0, hipsX: 0,
    spine: [-0.05, 0, 0], neck: [-0.15, 0, 0.12], head: [0, 0, 0.1],
    upperArmR: [1.25, 0, 0.55], foreArmR: [0.9, 0, 0], upperArmL: [1.35, 0, -0.35], foreArmL: [0.5, 0, 0],
    thighR: [0.05, 0, 0.08], thighL: [-0.05, 0, -0.08],
    rifle: { pos: [0.1, 0.17, -0.28], rot: [0, 0, 0] }, aimChest: true,
  },
  crouch: {
    hipsY: 0.55, hipsZ: 0.05, hipsX: 0,
    spine: [-0.3, 0, 0], chest: [0.15, 0, 0], neck: [0.15, 0, 0],
    upperArmR: [0.5, 0, 0.15], foreArmR: [1.2, 0, 0], upperArmL: [0.75, 0, -0.25], foreArmL: [1.2, 0, 0],
    thighR: [0.25, 0, 0.06], shinR: [-1.75, 0, 0], thighL: [1.35, 0, -0.12], shinL: [-1.35, 0, 0],
    rifle: { pos: [0.05, 0.02, -0.22], rot: [-0.7, 0, 0.45] },
  },
  crouchAim: {
    hipsY: 0.55, hipsZ: 0.05, hipsX: 0,
    spine: [-0.2, 0, 0], chest: [0.2, 0, 0], neck: [-0.1, 0, 0.12], head: [0, 0, 0.1],
    upperArmR: [1.25, 0, 0.55], foreArmR: [0.9, 0, 0], upperArmL: [1.35, 0, -0.35], foreArmL: [0.5, 0, 0],
    thighR: [0.25, 0, 0.06], shinR: [-1.75, 0, 0], thighL: [1.35, 0, -0.12], shinL: [-1.35, 0, 0],
    rifle: { pos: [0.1, 0.17, -0.28], rot: [0, 0, 0] }, aimChest: true,
  },
  prone: {
    hipsY: 0.17, hipsZ: 0.78, hipsX: -1.57,
    spine: [0.05, 0, 0], chest: [0.08, 0, 0], neck: [1.25, 0, 0],
    upperArmR: [2.2, 0, 0.45], foreArmR: [0.9, 0.3, 0], upperArmL: [2.2, 0, -0.45], foreArmL: [0.9, -0.3, 0],
    thighR: [0, 0, 0.12], thighL: [0, 0, -0.12], footR: [0.9, 0, 0], footL: [0.9, 0, 0],
    rifle: { pos: [0.1, 0.42, 0.06], rot: [1.25, 0, 0.3] },
  },
  proneAim: {
    hipsY: 0.17, hipsZ: 0.78, hipsX: -1.57,
    spine: [0.05, 0, 0], chest: [0.12, 0, 0], neck: [1.15, 0, 0.1],
    upperArmR: [2.15, 0, 0.5], foreArmR: [0.7, 0.4, 0], upperArmL: [2.35, 0, -0.35], foreArmL: [0.4, -0.4, 0],
    thighR: [0, 0, 0.15], thighL: [0, 0, -0.15], footR: [0.9, 0, 0], footL: [0.9, 0, 0],
    rifle: { pos: [0.08, 0.5, 0.08], rot: [1.5708, 0, 0] }, aimChest: true,
  },
  dead: {
    hipsY: 0.15, hipsZ: 0.5, hipsX: -1.5,
    spine: [-0.1, 0.1, 0], chest: [0, 0, 0.1], neck: [0.3, 0.6, 0],
    upperArmR: [2.6, 0, 0.6], foreArmR: [0.3, 0, 0], upperArmL: [1.2, 0, -1.0], foreArmL: [0.5, 0, 0],
    thighR: [0.1, 0, 0.2], thighL: [-0.2, 0, -0.1], shinL: [-0.6, 0, 0],
    rifle: { pos: [0.3, 0.3, 0.1], rot: [1.2, 0.8, 1.2] },
  },
};

const _e = new THREE.Euler(), _q = new THREE.Quaternion();

export class GhillieCharacter {
  constructor(scene, textures, { index = 0, armbandColor = null } = {}) {
    this.scene = scene;
    const geo = getGeometry(index);
    this.bodyMat = new THREE.MeshStandardMaterial({ color: 0x0d0d09, roughness: 0.95 });
    this.stripMat = new THREE.MeshStandardMaterial({ map: textures.ghillie, alphaTest: 0.42, side: THREE.DoubleSide, vertexColors: true, roughness: 0.95 });
    // per-character motion for the strands (world space): smoothed velocity, turn rate, bob
    this.motion = { uVel: { value: new THREE.Vector3() }, uTurn: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uBob: { value: 0 } };
    this.stripMat.customProgramCacheKey = () => 'ghillie';
    this.stripMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = SHARED.uTime;
      shader.uniforms.uWindDir = SHARED.uWindDir;
      Object.assign(shader.uniforms, this.motion);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute float aSway;
uniform float uTime;
uniform vec2 uWindDir;
uniform vec3 uVel;
uniform float uTurn;
uniform vec3 uCenter;
uniform float uBob;
${GUST_GLSL}`)
        // after skinning: move the strands in world space so wind and drag act in the
        // right direction whatever the pose (standing, kneeling or prone)
        .replace('#include <project_vertex>', `
vec4 wp = modelMatrix * vec4(transformed, 1.0);
{
  float ph = dot(position, vec3(7.1, 3.3, 5.7));
  float gust = gustAt(uCenter.xz) * ${CONFIG.weather.gusts.toFixed(3)};
  vec3 wind = vec3(uWindDir.x, 0.0, uWindDir.y);
  vec3 d = wind * (sin(uTime * 2.2 + ph) * (0.6 + 0.8 * gust) + 0.4 + 1.3 * gust) * 0.035
         + vec3(sin(uTime * 5.1 + ph * 2.0), 0.0, cos(uTime * 4.3 + ph)) * 0.012 * (1.0 + 2.2 * gust);
  // drag: trail behind when moving, swing out when turning, bounce with the steps
  vec3 rel = wp.xyz - uCenter;
  vec3 drag = -uVel * 0.05 - vec3(rel.z, 0.0, -rel.x) * uTurn * 0.07;
  float dl = length(drag);
  if (dl > 0.28) drag *= 0.28 / dl;
  d += drag + vec3(0.0, uBob * (0.5 + 0.5 * sin(ph)), 0.0);
  wp.xyz += d * aSway;
}
vec4 mvPosition = viewMatrix * wp;
gl_Position = projectionMatrix * mvPosition;`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>',
        THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
    };
    // skeleton
    this.bones = {};
    const list = [];
    for (const [name, parent, x, y, z] of BONES) {
      const b = new THREE.Bone();
      b.name = name;
      b.position.set(x, y, z);
      if (parent) this.bones[parent].add(b);
      this.bones[name] = b;
      list.push(b);
    }
    const mesh = new THREE.SkinnedMesh(geo, [this.bodyMat, this.stripMat]);
    mesh.add(this.bones.root);
    mesh.bind(new THREE.Skeleton(list));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.mesh = mesh;
    this.group = new THREE.Group();
    this.group.add(mesh);
    // rifle on the chest bone
    this.rifle = buildRifle();
    this.bones.chest.add(this.rifle);
    // armband (team members only)
    if (armbandColor !== null) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.05, 10, 1, true),
        new THREE.MeshStandardMaterial({ color: armbandColor, emissive: armbandColor, emissiveIntensity: 0.35, roughness: 0.6, side: THREE.DoubleSide }));
      band.position.set(0, -0.12, 0);
      this.bones.upperArmL.add(band);
      this.armband = band;
    }
    scene.add(this.group);
    // pose state: current quaternions per bone
    this.cur = {};
    for (const [name] of BONES) this.cur[name] = new THREE.Quaternion();
    this.hips = { y: 0.95, z: 0, x: 0 };
    this.rifleState = { pos: new THREE.Vector3(0.05, 0.02, -0.22), q: new THREE.Quaternion() };
    this.walkPhase = 0;
    this.breathPh = Math.random() * 6.28;
    this.prevPos = null;
    this.prevYaw = 0;
    this.tint = new THREE.Color(1, 1, 1);
    this.tintTarget = new THREE.Color(1, 1, 1);
    this._first = true;
  }

  // Blend camouflage colour toward the local environment (camouflageStrength).
  setEnvironmentTint(env) {
    const k = CONFIG.camouflageStrength;
    // at low camouflage the suit is a uniform darker brown that stands out
    const base = new THREE.Color(0.75, 0.6, 0.45);
    this.tintTarget.copy(base).lerp(env, k);
  }

  update(dt, cb, time, terrain) {
    const g = this.group;
    g.position.copy(cb.pos);
    const yaw = cb.bodyYaw !== undefined ? cb.bodyYaw : cb.yaw;
    g.rotation.set(0, yaw, 0);
    // choose pose
    let key;
    if (!cb.alive) key = 'dead';
    else if (cb.stance === 'prone') key = cb.aiming ? 'proneAim' : 'prone';
    else if (cb.stance === 'crouch') key = cb.aiming ? 'crouchAim' : 'crouch';
    else key = cb.aiming ? 'standAim' : 'stand';
    const pose = P[key];
    const rate = this._first ? 1 : 1 - Math.exp(-dt * (cb.alive ? 7 : 4));
    this._first = false;
    // walk cycle overlay
    const moving = cb.alive && cb.speed > 0.3 && cb.stance !== 'prone';
    this.walkPhase += dt * cb.speed * 2.6;
    const sw = moving ? Math.min(1, cb.speed / 3) : 0;
    const crawl = cb.alive && cb.speed > 0.2 && cb.stance === 'prone' ? 1 : 0;
    for (const [name] of BONES) {
      if (name === 'root') continue;
      const e = pose[name] || [0, 0, 0];
      let x = e[0], y = e[1], z = e[2];
      if (sw > 0) {
        const s = Math.sin(this.walkPhase);
        if (name === 'thighR') x = lerp(x, s * 0.55 + 0.1, sw);
        if (name === 'thighL') x = lerp(x, -s * 0.55 + 0.1, sw);
        if (name === 'shinR') x = lerp(x, -Math.max(0, -Math.cos(this.walkPhase)) * 0.9 - 0.1, sw);
        if (name === 'shinL') x = lerp(x, -Math.max(0, Math.cos(this.walkPhase)) * 0.9 - 0.1, sw);
        if (name === 'spine') x += -0.12 * sw;
      }
      if (crawl) {
        const s = Math.sin(this.walkPhase * 1.4);
        if (name === 'thighR') x += s * 0.25;
        if (name === 'thighL') x -= s * 0.25;
        if (name === 'upperArmR') x += s * 0.2;
        if (name === 'upperArmL') x -= s * 0.2;
      }
      if (pose.aimChest && name === 'chest') x += cb.pitch;
      if (!pose.aimChest && name === 'neck' && cb.alive) x += cb.pitch * 0.6;
      // breathing (slower and calmer while aiming) and a slight idle sway
      if (cb.alive && (name === 'chest' || name === 'spine')) {
        const br = Math.sin(time * (pose.aimChest ? 1.2 : 1.7) + this.breathPh);
        x += br * (name === 'chest' ? 0.022 : 0.012) * (pose.aimChest ? 0.5 : 1);
        if (name === 'spine' && !moving) z += Math.sin(time * 0.43 + this.breathPh) * 0.012;
      }
      _q.setFromEuler(_e.set(x, y, z));
      this.cur[name].slerp(_q, rate);
      this.bones[name].quaternion.copy(this.cur[name]);
    }
    // hips placement (prone: align with terrain slope)
    let hx = pose.hipsX;
    if (pose.hipsX < -1 && terrain) {
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const hHead = terrain.heightAt(cb.pos.x + fx * 0.2, cb.pos.z + fz * 0.2);
      const hFeet = terrain.heightAt(cb.pos.x - fx * 1.6, cb.pos.z - fz * 1.6);
      hx += Math.atan2(hHead - hFeet, 1.8);
    }
    this.hips.y = lerp(this.hips.y, pose.hipsY, rate);
    this.hips.z = lerp(this.hips.z, pose.hipsZ, rate);
    this.hips.x = lerp(this.hips.x, hx, rate);
    const hips = this.bones.hips;
    hips.position.set(0, this.hips.y + (moving ? Math.abs(Math.sin(this.walkPhase)) * 0.03 : 0), this.hips.z);
    hips.quaternion.multiplyQuaternions(_q.setFromEuler(_e.set(this.hips.x, 0, 0)), this.cur.hips);
    // rifle
    const rp = pose.rifle;
    this.rifleState.pos.lerp(_v.set(rp.pos[0], rp.pos[1], rp.pos[2]), rate);
    this.rifleState.q.slerp(_q.setFromEuler(_e.set(rp.rot[0], rp.rot[1], rp.rot[2])), rate);
    this.rifle.position.copy(this.rifleState.pos);
    this.rifle.quaternion.copy(this.rifleState.q);
    // strand motion: velocity and turn rate lag a little (the strands' inertia)
    const m = this.motion;
    if (this.prevPos && dt > 0) {
      const k = 1 - Math.exp(-dt * 5);
      _v.subVectors(cb.pos, this.prevPos).divideScalar(dt);
      if (_v.lengthSq() > 400) _v.set(0, 0, 0);   // teleport (spawn)
      m.uVel.value.lerp(_v, k);
      let dy = yaw - this.prevYaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      m.uTurn.value += (THREE.MathUtils.clamp(dy / dt, -4, 4) - m.uTurn.value) * k;
    }
    this.prevPos = (this.prevPos || new THREE.Vector3()).copy(cb.pos);
    this.prevYaw = yaw;
    m.uCenter.value.copy(cb.pos);
    m.uBob.value = moving ? Math.sin(this.walkPhase * 2) * 0.02 * sw : 0;
    // camo tint
    this.tint.lerp(this.tintTarget, 1 - Math.exp(-dt * 0.8));
    this.stripMat.color.copy(this.tint);
  }

  setVisible(v) { this.group.visible = v; }

  dispose() {
    this.scene.remove(this.group);
    this.bodyMat.dispose();
    this.stripMat.dispose();
    // per-character rifle and armband (the skinned suit geometry is shared and cached)
    for (const o of [this.rifle, this.armband]) {
      if (!o) continue;
      o.traverse((m) => { if (m.isMesh) { m.geometry.dispose(); m.material.dispose(); } });
    }
  }
}
const _v = new THREE.Vector3();
