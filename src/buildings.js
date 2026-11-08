// Stone walls and buildings (v5).
//
// - EdgeWall: a tall dry-stone wall along the whole edge of the play area, on every map, so you
//   see where the map ends before you get there. Its height follows the map size.
// - Buildings: the old stone hamlets of the TUSCAN HILLS map: houses of rough stone or ochre
//   plaster with terracotta roofs, green shutters, a few towers, and roofless ruins whose low
//   walls you can climb over and hide behind.
//
// Both are drawn with one procedural masonry/roof-tile shader (no textures to download), and
// both are convex "solids" in the World: they stop bullets and sight, the AI walks around
// them, and the player stands on (and climbs) the low ones (World.groundAt).
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { RNG, Simplex, clamp, lerp, smoothstep } from './noise.js';
import { fitParts } from './models.js';

// ------------------------------------------------------------------------------- solids

// A convex solid in its own frame: x along `angle`, y up, z across. planes: [nx, ny, nz, w]
// with inside = n·p <= w (y is world height). topAt(x, z): the height to stand on, or -Infinity.
function solidFrame(cx, cz, angle, hx, hz) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return {
    kind: 'solid', x: cx, z: cz, cos, sin, hx, hz, R: Math.hypot(hx, hz) + 0.5,
    local(x, z) {
      const ox = x - cx, oz = z - cz;
      return [ox * cos + oz * sin, -ox * sin + oz * cos];
    },
  };
}

export function boxSolid(cx, cz, angle, hx, hz, y0, y1, label = 'wall') {
  const s = solidFrame(cx, cz, angle, hx, hz);
  s.label = label;
  s.y0 = y0; s.y1 = y1;
  s.planes = [[1, 0, 0, hx], [-1, 0, 0, hx], [0, 0, 1, hz], [0, 0, -1, hz], [0, 1, 0, y1], [0, -1, 0, -y0]];
  s.topAt = (x, z) => {
    const [lx, lz] = s.local(x, z);
    return Math.abs(lx) <= hx && Math.abs(lz) <= hz ? y1 : -Infinity;
  };
  return s;
}

// A house: walls up to the eaves, a gable roof with its ridge along the local x axis.
export function houseSolid(cx, cz, angle, hx, hz, y0, eave, ridge) {
  const s = solidFrame(cx, cz, angle, hx + 0.3, hz + 0.3);
  s.label = 'house';
  s.y0 = y0; s.y1 = ridge;
  const k = (ridge - eave) / hz;
  s.planes = [[1, 0, 0, hx], [-1, 0, 0, hx], [0, 0, 1, hz], [0, 0, -1, hz], [0, -1, 0, -y0], [0, 1, k, ridge], [0, 1, -k, ridge]];
  s.hx = hx; s.hz = hz;
  s.topAt = (x, z) => {
    const [lx, lz] = s.local(x, z);
    if (Math.abs(lx) > hx || Math.abs(lz) > hz) return -Infinity;
    return ridge - k * Math.abs(lz);
  };
  return s;
}

// ------------------------------------------------------------------------------- material

const MASONRY_GLSL = /* glsl */`
vec2 bHash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
float bHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }
float bNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(bHash(i), bHash(i + vec2(1, 0)), u.x), mix(bHash(i + vec2(0, 1)), bHash(i + vec2(1, 1)), u.x), u.y);
}
float bFbm(vec2 p) { return bNoise(p) * 0.5 + bNoise(p * 2.03) * 0.25 + bNoise(p * 4.1) * 0.125 + bNoise(p * 8.3) * 0.0625; }
// irregular stones: F1, F2 of a stretched Voronoi, and the stone's id
vec3 stones(vec2 p) {
  vec2 ip = floor(p), fp = fract(p);
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = vec2(float(i), float(j));
    vec2 r = bHash2(ip + c);
    vec2 d = c + 0.15 + 0.7 * r - fp;
    float dd = dot(d, d);
    if (dd < f1) { f2 = f1; f1 = dd; id = bHash(ip + c + 3.7); } else if (dd < f2) f2 = dd;
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}
`;

// kind: 0 dry-stone edge wall, 1 Tuscan rubble stone, 2 ochre plaster, 3 roof tiles,
//       4 dark foundation stone, 5 window/door opening
function masonryMaterial(textures) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, vertexColors: true });
  mat.customProgramCacheKey = () => 'masonry';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.tRockA = { value: textures.rock.map };
    shader.uniforms.tMossA = { value: textures.forest.map };
    // photo stone walls (Higgsfield textures) where they are loaded; else the procedural stones
    shader.uniforms.tDryA = { value: textures.wallDry ? textures.wallDry.map : textures.rock.map };
    shader.uniforms.tRubA = { value: textures.wallRubble ? textures.wallRubble.map : textures.rock.map };
    shader.uniforms.tDryN = { value: textures.wallDry ? textures.wallDry.normalMap : textures.rock.normalMap };
    shader.uniforms.tRubN = { value: textures.wallRubble ? textures.wallRubble.normalMap : textures.rock.normalMap };
    shader.uniforms.uPhoto = { value: new THREE.Vector2(textures.wallDry ? 1 : 0, textures.wallRubble ? 1 : 0) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec2 aWall;
attribute float aKind;
varying vec2 vWall;
varying float vKind;
varying vec3 vWN;
varying vec3 vWP;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vWall = aWall;
vKind = aKind;
vWN = normalize(mat3(modelMatrix) * objectNormal);
vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D tRockA, tMossA, tDryA, tRubA, tDryN, tRubN;
uniform vec2 uPhoto;
varying vec2 vWall;
varying float vKind;
varying vec3 vWN;
varying vec3 vWP;
${MASONRY_GLSL}`)
      .replace('#include <map_fragment>', `
float kind = floor(vKind + 0.5);
vec2 w = vWall;
vec3 alb;
float hgt = 0.5, rough = 0.9;
vec3 rockTex = texture2D(tRockA, w / 2.3).rgb;
// (sampled here, outside the per-face branches: inside them the mip level is undefined)
vec4 phDry = texture2D(tDryA, w / 2.4);
vec4 phRub = texture2D(tRubA, w / 2.0);
vec3 phDryN = texture2D(tDryN, w / 2.4).xyz * 2.0 - 1.0;
vec3 phRubN = texture2D(tRubN, w / 2.0).xyz * 2.0 - 1.0;
float bPhoto = 0.0;      // 1: this face uses a photo wall and its normal map
vec3 bPhotoN = vec3(0.0, 0.0, 1.0);
vec3 mossTex = texture2D(tMossA, w / 1.3).rgb;
float grime = bFbm(w * vec2(0.35, 0.9));
// how many stones fall in a pixel: fade the pattern out where it would only shimmer
float detail = 1.0 - smoothstep(0.06, 0.22, length(fwidth(w)) * 3.0);
if (kind < 0.5) {
  // dry stone: big grey stones, deep dark gaps, moss on top and in the shade
  vec3 st = stones(w * vec2(1.7, 2.9));
  float gap = smoothstep(0.02, 0.16, st.y - st.x);
  float bulge = gap * (0.75 + 0.25 * (1.0 - st.x));
  vec3 tint = mix(vec3(0.45, 0.44, 0.41), vec3(0.6, 0.58, 0.53), st.z) * mix(1.0, 0.86, step(0.82, st.z));
  alb = rockTex * 1.6 * tint;
  alb = mix(vec3(0.05, 0.05, 0.04), alb, mix(1.0, gap, 0.35 + 0.65 * detail));
  if (uPhoto.x > 0.5) {
    alb = phDry.rgb;
    bPhoto = 1.0;
    bPhotoN = phDryN;
  }
  float moss = smoothstep(0.55, 0.85, vWN.y + bFbm(w * 1.7) * 0.6) + smoothstep(0.6, 0.9, bFbm(w * 0.8 + 7.0)) * 0.5 * (1.0 - smoothstep(0.0, 1.2, w.y));
  alb = mix(alb, mossTex * vec3(0.75, 1.15, 0.5), clamp(moss, 0.0, 1.0) * 0.8);
  hgt = bulge;
  rough = 0.92;
} else if (kind < 2.5 || kind > 3.5 && kind < 4.5) {
  // Tuscan rubble: warm limestone and sandstone in rough courses with pale mortar
  // (kind 4: the darker, weathered foundation)
  vec3 st = stones(w * vec2(2.2, 3.7));
  float gap = smoothstep(0.02, 0.16, st.y - st.x);
  vec3 tint = mix(vec3(0.66, 0.57, 0.43), vec3(0.76, 0.68, 0.54), st.z);
  tint = mix(tint, vec3(0.62, 0.48, 0.34), step(0.86, st.z) * 0.6);
  vec3 stoneCol = rockTex * 1.85 * tint;
  vec3 mortar = vec3(0.5, 0.46, 0.39);
  alb = mix(mortar, stoneCol, mix(0.85, gap, detail));
  hgt = gap * (0.7 + 0.3 * (1.0 - st.x));
  if (uPhoto.y > 0.5) {
    alb = phRub.rgb;
    bPhoto = 1.0;
    bPhotoN = phRubN;
  }
  if (kind > 3.5) alb *= 0.72;
  if (kind > 1.5 && kind < 2.5) {
    // ochre plaster, fallen off in patches so the stone shows through
    float flake = smoothstep(0.56, 0.6, bFbm(w * 0.55 + 3.1) + (1.0 - smoothstep(0.0, 0.9, w.y)) * 0.25);
    vec3 pl = mix(vec3(0.74, 0.52, 0.3), vec3(0.83, 0.66, 0.42), bFbm(w * 0.3)) * (0.85 + 0.25 * bFbm(w * 3.0));
    alb = mix(pl, alb, flake);
    hgt = mix(0.85, hgt, flake);
  }
  // rain streaks and grime near the ground
  alb *= mix(0.72, 1.0, smoothstep(0.0, 1.4, w.y)) * (0.85 + 0.25 * grime);
  rough = 0.88;
} else if (kind < 3.5) {
  // terracotta roof tiles: channels down the slope, overlapping rows
  float cu = w.x / 0.23;
  float row = floor(w.y / 0.36);
  float ch = abs(fract(cu + 0.5 * mod(row, 2.0) * 0.0) - 0.5) * 2.0;
  float lap = fract(w.y / 0.36);
  float prof = sqrt(max(0.0, 1.0 - ch * ch));
  float id = bHash(vec2(floor(cu), row));
  vec3 terra = mix(vec3(0.5, 0.22, 0.12), vec3(0.66, 0.36, 0.2), id) * mix(0.75, 1.0, prof);
  terra *= mix(0.62, 1.0, smoothstep(0.0, 0.18, lap));
  float lichen = smoothstep(0.62, 0.8, bFbm(w * 1.3 + id));
  terra = mix(terra, vec3(0.34, 0.33, 0.24), lichen * 0.6);
  alb = terra * (0.85 + 0.3 * grime);
  hgt = prof * 0.8 + smoothstep(0.0, 0.2, lap) * 0.2;
  rough = 0.75;
} else {
  alb = vec3(0.025, 0.022, 0.02);
  hgt = 0.0;
  rough = 0.95;
}
diffuseColor.rgb = alb * vColor.rgb;
float bRough = rough;
float bH = hgt;`)
      .replace('#include <color_fragment>', '')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = bRough;')
      .replace('#include <normal_fragment_maps>', `
{
  // photo walls: their normal map in a tangent frame built from the wall coordinates
  vec3 pos = -vViewPosition;
  vec3 dpdx = dFdx(pos), dpdy = dFdy(pos);
  vec2 duvx = dFdx(vWall), duvy = dFdy(vWall);
  vec3 Nf = normal;
  vec3 dp2perp = cross(dpdy, Nf), dp1perp = cross(Nf, dpdx);
  vec3 Tf = dp2perp * duvx.x + dp1perp * duvy.x;
  vec3 Bf = dp2perp * duvx.y + dp1perp * duvy.y;
  float invmax = inversesqrt(max(max(dot(Tf, Tf), dot(Bf, Bf)), 1e-12));
  vec3 photoNormal = normalize(mat3(Tf * invmax, Bf * invmax, Nf) * vec3(bPhotoN.xy * 0.8, bPhotoN.z));
  float dHx = dFdx(bH) * 0.06 * detail, dHy = dFdy(bH) * 0.06 * detail;
  vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dHx * r1 + dHy * r2);
  vec3 bumped = normalize(abs(det) * normal - grad * 7.0);
  normal = mix(bumped, photoNormal, bPhoto);
}`);
  };
  return mat;
}

// Geometry with the masonry attributes: aWall (metres along the surface), aKind, colour.
class MasonryBuilder {
  constructor() { this.pos = []; this.nrm = []; this.wall = []; this.kind = []; this.col = []; this.idx = []; }
  // quad a-b-c-d (counter-clockwise seen from outside), uv in metres for each corner
  quad(a, b, c, d, ua, ub, uc, ud, kind, col = [1, 1, 1]) {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a)).normalize();
    const base = this.pos.length / 3;
    for (const [p, u] of [[a, ua], [b, ub], [c, uc], [d, ud]]) {
      this.pos.push(p.x, p.y, p.z); this.nrm.push(n.x, n.y, n.z); this.wall.push(u[0], u[1]); this.kind.push(kind); this.col.push(col[0], col[1], col[2]);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  tri(a, b, c, ua, ub, uc, kind, col = [1, 1, 1]) {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    const base = this.pos.length / 3;
    for (const [p, u] of [[a, ua], [b, ub], [c, uc]]) {
      this.pos.push(p.x, p.y, p.z); this.nrm.push(n.x, n.y, n.z); this.wall.push(u[0], u[1]); this.kind.push(kind); this.col.push(col[0], col[1], col[2]);
    }
    this.idx.push(base, base + 1, base + 2);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aWall', new THREE.Float32BufferAttribute(this.wall, 2));
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(this.kind, 1));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// An axis box in a local frame (x along, z across) placed at (cx, cz) rotated by angle; walls
// from y0 to y1 (top may vary per corner via topFn(lx, lz)). Faces: 4 sides + top.
function addBox(B, cx, cz, angle, hx, hz, y0, topFn, kind, col, { top = true, uOff = 0, topKind = kind } = {}) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const W = (lx, y, lz) => new THREE.Vector3(cx + lx * c - lz * s, y, cz + lx * s + lz * c);
  const corners = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
  let u = uOff;
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
    const len = Math.hypot(bx - ax, bz - az);
    const ta = topFn(ax, az), tb = topFn(bx, bz);
    // outward-facing quad (counter-clockwise seen from outside)
    B.quad(W(bx, y0, bz), W(ax, y0, az), W(ax, ta, az), W(bx, tb, bz), [u + len, y0], [u, y0], [u, ta], [u + len, tb], kind, col);
    u += len;
  }
  if (top) {
    const p = corners.map(([x, z]) => W(x, topFn(x, z), z));
    B.quad(p[3], p[2], p[1], p[0], [-hx, hz], [hx, hz], [hx, -hz], [-hx, -hz], topKind, col);
  }
}

// ------------------------------------------------------------------------------- edge wall

export class EdgeWall {
  constructor(scene, terrain, textures, seed) {
    const M = CONFIG.map;
    const H = M.wallHeight || 2.6;
    const noise = new Simplex(seed + 707);
    const B = new MasonryBuilder();
    this.solids = [];
    const hx = terrain.halfX, hz = terrain.halfZ;
    const T = 1.25;          // thickness at the foot; it narrows toward the top
    const seg = 1.0;          // metres per column of the mesh
    // the four sides, each as a line from a to b with the play area on its left
    const sides = [
      { a: [-hx, -hz], b: [hx, -hz], out: [0, -1] },
      { a: [hx, -hz], b: [hx, hz], out: [1, 0] },
      { a: [hx, hz], b: [-hx, hz], out: [0, 1] },
      { a: [-hx, hz], b: [-hx, -hz], out: [-1, 0] },
    ];
    let uRun = 0;
    for (const sd of sides) {
      const [ax, az] = sd.a, [bx, bz] = sd.b, [ox, oz] = sd.out;
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.ceil(L / seg);
      const dx = (bx - ax) / L, dz = (bz - az) / L;
      const cols = [];
      for (let i = 0; i <= n; i++) {
        // run past the corners a little so the walls meet
        const t = -T + (L + 2 * T) * (i / n);
        const px = ax + dx * t, pz = az + dz * t;
        const gi = terrain.heightAt(px, pz), go = terrain.heightAt(px + ox * T, pz + oz * T);
        const ground = Math.min(gi, go);
        const over = ground < 0.4;    // across the river: a lower weir of the same stone
        const top = Math.max(gi, go) + (over ? 1.1 : H) * (1 + 0.07 * noise.noise2(px * 0.08, pz * 0.08)) + 0.12 * noise.noise2(px * 0.9, pz * 0.9);
        cols.push({ px, pz, bot: Math.min(ground, M.waterLevel - (over ? M.riverDepth : 0)) - 0.7, top: over ? Math.max(top, M.waterLevel + 0.9) : top, u: uRun + t });
      }
      uRun += L + 4;
      const inner = (c, f) => new THREE.Vector3(c.px + ox * f, 0, c.pz + oz * f);
      for (let i = 0; i < n; i++) {
        const c0 = cols[i], c1 = cols[i + 1];
        const P = (c, off, y) => { const v = inner(c, off); v.y = y; return v; };
        const tIn = 0.18, tOut = T - 0.18;   // the faces lean in toward the top
        // inner face (facing the play area), outer face, and a rounded cap up to a crest
        B.quad(P(c0, 0, c0.bot), P(c1, 0, c1.bot), P(c1, tIn, c1.top), P(c0, tIn, c0.top), [c0.u, c0.bot], [c1.u, c1.bot], [c1.u, c1.top], [c0.u, c0.top], 0);
        B.quad(P(c1, T, c1.bot), P(c0, T, c0.bot), P(c0, tOut, c0.top), P(c1, tOut, c1.top), [c1.u, c1.bot], [c0.u, c0.bot], [c0.u, c0.top], [c1.u, c1.top], 0);
        const cr0 = c0.top + 0.16, cr1 = c1.top + 0.16, mid = T * 0.5;
        B.quad(P(c0, tIn, c0.top), P(c1, tIn, c1.top), P(c1, mid, cr1), P(c0, mid, cr0), [c0.u, 0], [c1.u, 0], [c1.u, 0.5], [c0.u, 0.5], 0);
        B.quad(P(c1, tOut, c1.top), P(c0, tOut, c0.top), P(c0, mid, cr0), P(c1, mid, cr1), [c1.u, 1], [c0.u, 1], [c0.u, 0.5], [c1.u, 0.5], 0);
      }
      // solids in short pieces (bullets and sight stop at the wall; only nearby cells list them)
      const piece = 8;
      for (let t = 0; t < L; t += piece) {
        const l = Math.min(piece, L - t);
        const cx = ax + dx * (t + l / 2) + ox * T / 2, cz = az + dz * (t + l / 2) + oz * T / 2;
        let top = -Infinity, bot = Infinity;
        for (const c of cols) if (Math.abs((c.px - ax) * dx + (c.pz - az) * dz - (t + l / 2)) <= l / 2 + 1) { top = Math.max(top, c.top); bot = Math.min(bot, c.bot); }
        this.solids.push(boxSolid(cx, cz, Math.atan2(dz, dx), l / 2 + 0.05, T / 2, bot, top, 'edge'));
      }
    }
    const mesh = new THREE.Mesh(B.build(), masonryMaterial(textures));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'edge-wall';
    scene.add(mesh);
    this.mesh = mesh;
  }
}

// ------------------------------------------------------------------------------- Tuscan hamlets

export class Buildings {
  // models: the Higgsfield house models (models.js loadHouseModels), or null for procedural houses
  constructor(scene, terrain, textures, seed, models = null) {
    this.solids = [];
    this.items = [];
    this.houses3d = [];
    this.group = new THREE.Group();
    this.group.name = 'buildings';
    scene.add(this.group);
    if (CONFIG.map.biome !== 'tuscany') return;
    this.terrain = terrain;
    this.rng = new RNG(seed + 909);
    this.models = null;
    if (models) {
      // fit each model once to a 10 m long side (each house scales it to its own length)
      this.models = {};
      for (const [name, M] of Object.entries(models)) this.models[name] = { ...M, ...fitParts(M.hi, 'l', 10, 0, M.lo) };
    }
    const B = new MasonryBuilder();
    const D = new DetailBuilder();
    this._placeHamlets(B, D);
    const mesh = new THREE.Mesh(B.build(), masonryMaterial(textures));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    const det = new THREE.Mesh(D.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }));
    det.castShadow = true;
    det.receiveShadow = true;
    this.group.add(det);
  }

  // A few hamlets on each slope (on the flatter benches), plus lone farmhouses and ruins.
  _placeHamlets(B, D) {
    const T = this.terrain, M = CONFIG.map, rng = this.rng;
    const perSide = Math.max(2, Math.round(M.length / 110));
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      const sites = [];
      for (let k = 0; k < 400 && sites.length < perSide; k++) {
        const x = rng.float(-T.halfX + 22, T.halfX - 22);
        const dz = rng.float(0.32, 0.78) * M.ridgeDist;
        const z = T.riverCenter(x) + sgn * dz;
        if (Math.abs(z) > T.halfZ - 18) continue;
        if (T.normalAt(x, z).y < 0.93) continue;
        if (sites.some((s) => Math.abs(s.x - x) < 55)) continue;
        sites.push({ x, z });
      }
      for (const s of sites) this._hamlet(B, D, s.x, s.z, sgn, rng.int(3, 6));
      // lone ruins and farmhouses between the hamlets
      for (let k = 0, made = 0; k < 200 && made < perSide + 1; k++) {
        const x = rng.float(-T.halfX + 15, T.halfX - 15);
        const z = T.riverCenter(x) + sgn * rng.float(0.25, 0.85) * M.ridgeDist;
        if (Math.abs(z) > T.halfZ - 14 || T.normalAt(x, z).y < 0.9) continue;
        if (!T.isFree(x, z, 9)) continue;
        if (rng.chance(0.6)) this._ruin(B, x, z, rng.float(-0.4, 0.4) + (rng.chance(0.5) ? 0 : Math.PI / 2));
        else if (this.models) this._modelHouse(B, x, z, rng.float(-0.25, 0.25), this._pickModel(rng.chance(0.5) ? 'cottage' : 'farm'));
        else this._house(B, D, x, z, rng.float(-0.25, 0.25), rng.float(4, 6), rng.float(3, 4), 1);
        made++;
      }
    }
  }

  // Houses along the contour (the long side faces across the valley), leaning on each other.
  _hamlet(B, D, x0, z0, sgn, n) {
    const T = this.terrain, rng = this.rng;
    let x = x0 - (n * 7) / 2;
    for (let i = 0; i < n; i++) {
      let hx = rng.float(3.5, 6.5), hz = rng.float(2.8, 4.2);
      // with the 3D house models, the house's size comes from the model it gets
      const pick = this.models ? this._pickModel(rng.chance(0.2) ? 'tower' : null) : null;
      if (pick) { hx = pick.hx; hz = pick.hz; }
      x += hx;
      const z = T.riverCenter(x) + (z0 - T.riverCenter(x0)) + rng.float(-3, 3);
      const ang = rng.float(-0.18, 0.18);
      if (Math.abs(z) < T.halfZ - 12 && T.isFree(x, z, 1)) {
        if (rng.chance(0.18)) this._ruin(B, x, z, ang);
        else if (pick) this._modelHouse(B, x, z, ang, pick);
        else {
          this._house(B, D, x, z, ang, hx, hz, rng.chance(0.45) ? 2 : 1);
          if (rng.chance(0.25)) {
            // a stone tower at the end of the row
            const tx = x + Math.cos(ang) * (hx + 2.2), tz = z + Math.sin(ang) * (hx + 2.2);
            if (T.isFree(tx, tz, 0)) this._house(B, D, tx, tz, ang, 1.9, 1.9, 3.4, true);
          }
        }
      }
      x += hx + rng.float(0.5, 4.5);
    }
  }

  // A house model and its size for one house (a little bigger or smaller than the reference).
  _pickModel(want = null) {
    const rng = this.rng, names = Object.keys(this.models);
    const r = rng.next();
    let name = want || (r < 0.4 ? 'farm' : r < 0.65 ? 'ochre' : r < 0.9 ? 'cottage' : 'tower');
    if (!this.models[name]) name = names[Math.floor(rng.next() * names.length)];
    const len = { farm: 11, cottage: 8.5, ochre: 9.5, tower: 12.5 }[name] || 10;
    const k = (len / 10) * rng.float(0.92, 1.08);
    const M = this.models[name];
    return { name, M, k, hx: M.hx * k, hz: M.hz * k, h: M.h * k };
  }

  // A 3D house (Higgsfield model) on a stone plinth that levels the slope.
  _modelHouse(B, cx, cz, ang, pick) {
    const { M, k, hx, hz, h } = pick;
    const { lo, hi } = this._footprint(cx, cz, ang, hx, hz);
    const base = hi + 0.05;
    // plinth from below the lowest corner up to the house's floor
    addBox(B, cx, cz, ang, hx + 0.12, hz + 0.12, lo - 0.8, () => base + 0.02, 4, [1, 1, 1], { top: false });
    const place = (parts) => {
      const g = new THREE.Group();
      for (const p of parts) {
        const m = new THREE.Mesh(p.geo, p.mat);
        m.castShadow = true;
        m.receiveShadow = true;
        g.add(m);
      }
      // the model's long side runs along local x; the house frame's x is (cos ang, sin ang)
      g.position.set(cx, base, cz);
      g.rotation.y = -ang;
      g.scale.setScalar(k);
      g.updateMatrixWorld(true);
      g.matrixAutoUpdate = false;
      this.group.add(g);
      return g;
    };
    const item = { x: cx, z: cz, ang, hx, hz, kind: pick.name === 'tower' ? 'tower' : 'house', hi: place(M.hi), lo: M.lo ? place(M.lo) : null, center: new THREE.Vector3(cx, base + h / 2, cz) };
    if (item.lo) item.lo.visible = false;
    this.houses3d.push(item);
    this.items.push(item);
    this.solids.push(houseSolid(cx, cz, ang, hx, hz, lo - 0.8, base + h * 0.66, base + h));
    this.terrain.reserve(cx, cz, Math.hypot(hx, hz) + 1.2);
  }

  // 3D houses switch to their light copy by effective distance (distance × zoom).
  update(camera) {
    if (!this.houses3d.length) return;
    const zoom = camera.fov / CONFIG.player.fovHip;
    const l2 = (90 / zoom) ** 2;
    for (const it of this.houses3d) {
      if (!it.lo) continue;
      const near = camera.position.distanceToSquared(it.center) < l2;
      it.hi.visible = near;
      it.lo.visible = !near;
    }
  }

  _footprint(cx, cz, ang, hx, hz) {
    const T = this.terrain;
    const c = Math.cos(ang), s = Math.sin(ang);
    let lo = Infinity, hi = -Infinity;
    for (const [lx, lz] of [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz], [0, 0]]) {
      const h = T.heightAt(cx + lx * c - lz * s, cz + lx * s + lz * c);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    return { lo, hi };
  }

  // storeys: 1, 2 (or a tall tower)
  _house(B, D, cx, cz, ang, hx, hz, storeys, tower = false) {
    const rng = this.rng;
    const { lo, hi } = this._footprint(cx, cz, ang, hx, hz);
    const base = lo - 0.8;
    const eave = hi + 0.25 + storeys * 3.0;
    const pitch = tower ? 0.32 : 0.36;
    const ridge = eave + hz * pitch;
    const plaster = !tower && rng.chance(0.4);
    const kind = plaster ? 2 : 1;
    const col = [rng.float(0.9, 1.08), rng.float(0.9, 1.04), rng.float(0.88, 1.0)];
    // foundation band on the downhill side, then the walls
    addBox(B, cx, cz, ang, hx + 0.08, hz + 0.08, base, () => hi + 0.25, 4, col, { top: false });
    addBox(B, cx, cz, ang, hx, hz, hi + 0.25, () => eave, kind, col, { top: false });
    // gable ends up to the ridge (triangles), and the roof with an overhang
    const c = Math.cos(ang), s = Math.sin(ang);
    const W = (lx, y, lz) => new THREE.Vector3(cx + lx * c - lz * s, y, cz + lx * s + lz * c);
    for (const sx of [-1, 1]) {
      const a = W(sx * hx, eave, -sx * hz), b = W(sx * hx, eave, sx * hz), r = W(sx * hx, ridge, 0);
      B.tri(b, a, r, [2 * hz, eave], [0, eave], [hz, ridge], kind, col);
    }
    const o = 0.38, oy = o * pitch;
    const rc = [1, 1, 1];
    for (const sz of [-1, 1]) {
      const e0 = W(-hx - o, eave - oy, sz * (hz + o)), e1 = W(hx + o, eave - oy, sz * (hz + o));
      const r0 = W(-hx - o, ridge, 0), r1 = W(hx + o, ridge, 0);
      const slope = Math.hypot(hz + o, ridge - eave + oy);
      if (sz > 0) B.quad(e1, r1, r0, e0, [2 * hx + 2 * o, 0], [2 * hx + 2 * o, slope], [0, slope], [0, 0], 3, rc);
      else B.quad(e0, r0, r1, e1, [0, 0], [0, slope], [2 * hx + 2 * o, slope], [2 * hx + 2 * o, 0], 3, rc);
      // underside of the overhang (dark)
      const u0 = W(-hx - o, eave - oy - 0.06, sz * (hz + o)), u1 = W(hx + o, eave - oy - 0.06, sz * (hz + o));
      const w0 = W(-hx, eave, sz * hz), w1 = W(hx, eave, sz * hz);
      if (sz > 0) B.quad(w0, w1, u1, u0, [0, 0], [1, 0], [1, 1], [0, 1], 5, rc); else B.quad(u0, u1, w1, w0, [0, 0], [1, 0], [1, 1], [0, 1], 5, rc);
    }
    // windows, shutters and a door
    D.openings(W, hx, hz, hi + 0.25, storeys, rng, tower);
    // a chimney on most houses
    if (!tower && rng.chance(0.7)) {
      const lx = rng.float(-hx * 0.6, hx * 0.6), lz = rng.float(-hz * 0.4, hz * 0.4);
      const chx = cx + lx * c - lz * s, chz = cz + lx * s + lz * c;
      addBox(B, chx, chz, ang, 0.35, 0.35, ridge - 1.4, () => ridge + 0.9, 1, col);
    }
    const sol = houseSolid(cx, cz, ang, hx, hz, base, eave, ridge);
    this.solids.push(sol);
    this.items.push({ x: cx, z: cz, ang, hx, hz, kind: tower ? 'tower' : 'house' });
    this.terrain.reserve(cx, cz, Math.hypot(hx, hz) + 1.2);
  }

  // A roofless ruin: broken walls of different heights with gaps (doorways and collapses).
  // Low walls can be climbed; the ruin is cover with a view.
  _ruin(B, cx, cz, ang) {
    const rng = this.rng, T = this.terrain;
    const hx = rng.float(3.5, 5.5), hz = rng.float(2.8, 4);
    const t = 0.32;
    const c = Math.cos(ang), s = Math.sin(ang);
    const walls = [
      { lx: 0, lz: -hz, len: 2 * hx, a: 0 },
      { lx: hx, lz: 0, len: 2 * hz, a: Math.PI / 2 },
      { lx: 0, lz: hz, len: 2 * hx, a: 0 },
      { lx: -hx, lz: 0, len: 2 * hz, a: Math.PI / 2 },
    ];
    const missing = rng.int(0, 3);
    walls.forEach((wl, wi) => {
      // each wall in 1-3 pieces with gaps; one wall mostly gone
      const pieces = [];
      let u = -wl.len / 2;
      while (u < wl.len / 2 - 0.4) {
        const len = Math.min(wl.len / 2 - u, rng.float(1.2, 3.6));
        pieces.push([u, u + len]);
        u += len + (rng.chance(0.45) ? rng.float(0.9, 1.6) : 0);
      }
      for (const [u0, u1] of pieces) {
        const hl = (u1 - u0) / 2, um = (u0 + u1) / 2;
        const wa = ang + wl.a;
        const px = cx + (wl.lx + Math.cos(wl.a) * um) * c - (wl.lz + Math.sin(wl.a) * um) * s;
        const pz = cz + (wl.lx + Math.cos(wl.a) * um) * s + (wl.lz + Math.sin(wl.a) * um) * c;
        const { lo, hi } = this._footprint(px, pz, wa, hl, t);
        const hgt = wi === missing ? rng.float(0.5, 1.3) : rng.float(1.1, 3.6);
        const h0 = hi + hgt, h1 = hi + hgt * rng.float(0.55, 1.15);
        const topFn = (lx) => lerp(h0, h1, (lx + hl) / (2 * hl));
        addBox(B, px, pz, wa, hl, t, lo - 0.5, topFn, 1, [1, 0.97, 0.92], { topKind: 1 });
        // the solid uses the lower top so you can stand on the wall where it is drawn
        const sol = boxSolid(px, pz, wa, hl, t, lo - 0.5, Math.min(h0, h1) + 0.02, 'ruin');
        const yTop = (x, z) => {
          const [lx, lz] = sol.local(x, z);
          return Math.abs(lx) <= hl && Math.abs(lz) <= t ? topFn(lx) : -Infinity;
        };
        sol.topAt = yTop;
        sol.planes[4] = [0, 1, 0, Math.max(h0, h1)];
        this.solids.push(sol);
      }
    });
    // rubble heaps inside
    this.items.push({ x: cx, z: cz, ang, hx, hz, kind: 'ruin' });
    T.reserve(cx, cz, Math.hypot(hx, hz) + 0.8);
  }
}

// Windows (dark openings with stone sills), wooden shutters and doors.
class DetailBuilder {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.idx = []; }
  box(W, lx, ly, lz, sx, sy, sz, col) {
    // axis box in the house frame centred at (lx, ly, lz)
    const v = [];
    for (const [a, b, c] of [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]) v.push(W(lx + a * sx, ly + b * sy, lz + c * sz));
    const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]];
    for (const f of faces) {
      const n = new THREE.Vector3().subVectors(v[f[1]], v[f[0]]).cross(new THREE.Vector3().subVectors(v[f[3]], v[f[0]])).normalize();
      const base = this.pos.length / 3;
      for (const k of f) { this.pos.push(v[k].x, v[k].y, v[k].z); this.nrm.push(n.x, n.y, n.z); this.col.push(col[0], col[1], col[2]); }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  openings(W, hx, hz, floor, storeys, rng, tower) {
    const green = rng.chance(0.6);
    const shutter = green ? [0.16, 0.24, 0.14] : [0.3, 0.18, 0.1];
    const dark = [0.02, 0.018, 0.016];
    const sill = [0.62, 0.56, 0.46];
    const levels = tower ? [floor + 4.2, floor + 7.6] : Array.from({ length: Math.round(storeys) }, (_, i) => floor + 1.0 + i * 3.0);
    for (const sz of [-1, 1]) {
      const n = Math.max(1, Math.floor((2 * hx) / 2.6));
      for (let i = 0; i < n; i++) {
        const lx = -hx + (2 * hx * (i + 0.5)) / n;
        levels.forEach((y, li) => {
          if (rng.chance(0.15)) return;
          const door = li === 0 && i === Math.floor(n / 2) && sz > 0 && !tower;
          const w = door ? 0.55 : 0.42, h = door ? 1.05 : 0.65;
          const cy = door ? floor + h : y + 0.6;
          const z = sz * (hz + 0.005);
          this.box(W, lx, cy, z, w, h, 0.02, dark);
          if (!door) this.box(W, lx, cy - h - 0.05, sz * (hz + 0.06), w + 0.1, 0.05, 0.07, sill);
          // shutters: open (beside the window) or closed (over it)
          if (!door && rng.chance(0.75)) {
            if (rng.chance(0.35)) this.box(W, lx, cy, sz * (hz + 0.04), w + 0.02, h + 0.02, 0.03, shutter);
            else for (const sx of [-1, 1]) this.box(W, lx + sx * (w * 1.5 + 0.04), cy, sz * (hz + 0.04), w * 0.5, h + 0.02, 0.025, shutter);
          }
          if (door) this.box(W, lx, cy, sz * (hz + 0.03), w - 0.06, h - 0.04, 0.03, [0.24, 0.15, 0.08]);
        });
      }
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

export { clamp, smoothstep };
