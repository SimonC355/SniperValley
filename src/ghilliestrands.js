// The realistic ghillie suit (Beech River): thousands of curved cards of jute fringe, burlap
// and leaf strips over the sculpted figure (sculptedsniper.js), a thick mop on the hood that
// frames the face, single leaves on top, and beech twigs and fern fronds tucked in like a
// sniper does with what grows around him.
//
// Every card carries its root (bind pose), the surface normal there and how far along the
// strand each vertex is, so the shader (characters.js) can let the strands hang with gravity
// whatever the pose, and move them in the wind. Plain arrays, so it runs in the worker.
import { RNG } from './noise.js';

// Where everything sits in the texture atlas (sniperparts.js draws it), in pixels of a 1024²
// canvas, top-left origin. Roots are at the top of a strip, the stems of twigs at the left,
// of ferns and single leaves at the bottom.
export const ATLAS = {
  size: 1024,
  jute: { x: 0, y: 0, w: 512, h: 512, n: 8 },            // public/hf/ghillie.webp: 8 strips of jute
  twig: { x: 512, y: 0, w: 512, h: 256 },                // public/hf/beech-leaves.webp: a beech twig
  fern: { x: 512, y: 256, w: 256, h: 512 },              // public/hf/fern.webp: a fern frond
  leafStrip: { x: 768, y: 256, w: 256, h: 512, n: 4 },   // drawn: synthetic leaves on strings
  burlap: { x: 0, y: 512, w: 512, h: 512, n: 4 },        // drawn: frayed burlap strips
  leaves: { x: 512, y: 768, w: 512, h: 256, cols: 4, rows: 2 },   // drawn: single leaves
  solid: [64, 600],      // an opaque texel (in the first burlap strip's weave), for the body's uv
};

const lin = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => ((v / 255 + 0.055) / 1.055) ** 2.4);
// tints for the light jute photo: tan, khaki, olive, brown, dark brown, moss (the texture
// itself is a pale straw, so these are multipliers more than colours)
const JUTE_TINT = [0xbfb187, 0xa99d72, 0x8e9060, 0x93744f, 0x66553c, 0x74824c, 0xb0a074, 0x7f8556, 0x5f6a3e].map(lin);
const LEAF_TINT = [0xffffff, 0xf2f0e8, 0xe0e6d0, 0xfff0dc].map(lin);

const add = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rotAbout = (v, axis, a) => {
  const c = Math.cos(a), s = Math.sin(a), d = dot(axis, v), cr = cross(axis, v);
  return [v[0] * c + cr[0] * s + axis[0] * d * (1 - c), v[1] * c + cr[1] * s + axis[1] * d * (1 - c), v[2] * c + cr[2] * s + axis[2] * d * (1 - c)];
};
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const DOWN = [0, -1, 0];

// ctx: { surfaces: { name: { pos, idx, obj, px } }, scene (field for occlusion), weights(p, px)
//        -> [indices, weights], normalAt(obj, p) -> n, ao(p, n) -> 0..1, lod }
export function realGhillieStrands(def, ctx) {
  const { surfaces, lod } = ctx;
  const far = lod > 0;
  const rng = new RNG(7331);
  const F = def.F, hd = F.head.t;
  const S = ATLAS.size;
  const out = { pos: [], nrm: [], uv: [], col: [], sway: [], root: [], rootN: [], strand: [], si: [], sw: [], idx: [] };
  let W = null, R0 = null, N0 = null;
  const vtx = (p, n, u, v, c, swy, t, droop) => {
    out.pos.push(p[0], p[1], p[2]); out.nrm.push(n[0], n[1], n[2]); out.uv.push(u / S, 1 - v / S); out.col.push(c[0], c[1], c[2]);
    out.sway.push(swy); out.root.push(R0[0], R0[1], R0[2]); out.rootN.push(N0[0], N0[1], N0[2]); out.strand.push(t, droop);
    out.si.push(...W[0]); out.sw.push(...W[1]);
    return out.pos.length / 3 - 1;
  };
  const tri = (a, b, c) => out.idx.push(a, b, c);
  const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

  // A hanging strand: from the root, first along dir0, bending toward straight down (sag per
  // segment), a ribbon of width w (tapering) facing out of the body. rect: the atlas strip
  // [x0, x1] across, [yTop, yBot] along (root at the top).
  const ribbon = (root, n0, dir0, L, w, segs, sag, twist, rect, tint, droop, swayK, ao) => {
    let dir = dir0;
    const pts = [root], dirs = [dir];
    for (let i = 1; i <= segs; i++) {
      dir = norm(mix(dir, DOWN, sag));
      pts.push(add(pts[i - 1], dir, L / segs));
      dirs.push(dir);
    }
    // the ribbon's width direction: across the surface, twisted a little along the way
    let side = norm(cross(n0, dirs[0]));
    if (Math.hypot(...side) < 0.5) side = norm(cross([0, 0, 1], dirs[0]));
    const vs = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const d = dirs[i];
      let sd = rotAbout(side, d, twist * t);
      sd = norm(add(sd, d, -dot(sd, d)));
      // light it like a soft volume: the normal leans out of the body
      const nn = norm(add(shade(norm(cross(sd, d)), dot(cross(sd, d), n0) < 0 ? -0.45 : 0.45), n0, 0.75));
      const wi = w * (1 - 0.3 * t);
      const k = (0.42 + 0.58 * ao) * (0.55 + 0.6 * t);
      const c = [tint[0] * k * (1 + 0.08 * t), tint[1] * k * (1 + 0.05 * t), tint[2] * k];
      const v = rect[2] + (rect[3] - rect[2]) * t;
      const sw = swayK * t * (0.35 + 0.65 * t);
      vs.push(vtx(add(pts[i], sd, -wi / 2), nn, rect[0], v, c, sw, t, droop), vtx(add(pts[i], sd, wi / 2), nn, rect[1], v, c, sw, t, droop));
    }
    for (let i = 0; i < segs; i++) {
      const a = vs[i * 2], b = vs[i * 2 + 1], c = vs[i * 2 + 2], d = vs[i * 2 + 3];
      tri(a, c, b); tri(b, c, d);
    }
  };
  // A stiff card (leaf, twig, fern): root at the stem, along dir, across `side`, a slight bend.
  const card = (root, n0, dir, side, L, w, rect, stemAt, tint, droop, swayK, ao, rows = 3) => {
    const nn = norm(add(cross(side, dir), n0, 0.8));
    const vs = [];
    for (let i = 0; i < rows; i++) {
      const t = i / (rows - 1);
      const p = add(add(root, dir, L * t), nn, 0.08 * L * t * t);
      const k = (0.55 + 0.45 * ao) * (0.8 + 0.3 * t);
      const c = shade(tint, k);
      const sw = swayK * t * t;
      let uv0, uv1;
      if (stemAt === 'left') {   // twig: the stem at the left edge, the leaves spread up and down
        const u = rect[0] + (rect[1] - rect[0]) * t;
        uv0 = [u, rect[3]]; uv1 = [u, rect[2]];
      } else {                   // fern / single leaf: stem at the bottom
        const v = rect[3] + (rect[2] - rect[3]) * t;
        uv0 = [rect[0], v]; uv1 = [rect[1], v];
      }
      vs.push(vtx(add(p, side, -w / 2), nn, uv0[0], uv0[1], c, sw, t, droop), vtx(add(p, side, w / 2), nn, uv1[0], uv1[1], c, sw, t, droop));
    }
    for (let i = 0; i < rows - 1; i++) {
      const a = vs[i * 2], b = vs[i * 2 + 1], c = vs[i * 2 + 2], d = vs[i * 2 + 3];
      tri(a, c, b); tri(b, c, d);
    }
  };
  const stripRect = (reg, k, inset = 0.06) => {
    const sw = reg.w / reg.n;
    return [reg.x + (k + inset) * sw, reg.x + (k + 1 - inset) * sw, reg.y + 2, reg.y + reg.h - 2];
  };

  // area-weighted random points on a surface
  const sampler = (Sf) => {
    const cum = [];
    let A = 0;
    for (let t = 0; t < Sf.idx.length; t += 3) {
      const a = Sf.idx[t] * 3, b = Sf.idx[t + 1] * 3, c = Sf.idx[t + 2] * 3;
      const u = [Sf.pos[b] - Sf.pos[a], Sf.pos[b + 1] - Sf.pos[a + 1], Sf.pos[b + 2] - Sf.pos[a + 2]];
      const v = [Sf.pos[c] - Sf.pos[a], Sf.pos[c + 1] - Sf.pos[a + 1], Sf.pos[c + 2] - Sf.pos[a + 2]];
      A += Math.hypot(...cross(u, v)) / 2;
      cum.push(A);
    }
    return () => {
      const r = rng.next() * A;
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
      let a = rng.next(), b = rng.next();
      if (a + b > 1) { a = 1 - a; b = 1 - b; }
      const i0 = Sf.idx[lo * 3] * 3, i1 = Sf.idx[lo * 3 + 1] * 3, i2 = Sf.idx[lo * 3 + 2] * 3;
      return [0, 1, 2].map((k) => Sf.pos[i0 + k] + (Sf.pos[i1 + k] - Sf.pos[i0 + k]) * a + (Sf.pos[i2 + k] - Sf.pos[i0 + k]) * b);
    };
  };
  // roots no closer than minD (per layer), via a hash grid
  const grids = {};
  const tooClose = (layer, p, minD) => {
    const g = grids[layer] || (grids[layer] = new Map());
    const cs = 0.02;
    const cx = Math.floor(p[0] / cs), cy = Math.floor(p[1] / cs), cz = Math.floor(p[2] / cs), r = Math.ceil(minD / cs);
    for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) for (let z = cz - r; z <= cz + r; z++) {
      const l = g.get(`${x},${y},${z}`);
      if (l) for (const q of l) if ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2 < minD * minD) return true;
    }
    const key = `${cx},${cy},${cz}`;
    if (!g.has(key)) g.set(key, []);
    g.get(key).push(p);
    return false;
  };
  const tangent = (n, want) => {
    const d = add(want, n, -dot(want, n));
    const l = Math.hypot(...d);
    return l < 1e-3 ? null : [d[0] / l, d[1] / l, d[2] / l];
  };

  // ---- which bone a body point belongs to, and its frame
  const bodyS = surfaces.body;
  const limbOf = (p) => {
    let best = 1e9, bone = null;
    for (const o of bodyS.obj.ops) { if (o.sub) continue; const d = o.prim.d(p[0], p[1], p[2]); if (d < best) { best = d; bone = o.bone; } }
    return bone;
  };
  const localN = (bone, n) => { const R = F[bone].R; return [R[0] * n[0] + R[3] * n[1] + R[6] * n[2], R[1] * n[0] + R[4] * n[1] + R[7] * n[2], R[2] * n[0] + R[5] * n[1] + R[8] * n[2]]; };
  const localP = (bone, p) => { const f = F[bone], R = f.R, q = [p[0] - f.t[0], p[1] - f.t[1], p[2] - f.t[2]]; return [R[0] * q[0] + R[3] * q[1] + R[6] * q[2], R[1] * q[0] + R[4] * q[1] + R[7] * q[2], R[2] * q[0] + R[5] * q[1] + R[8] * q[2]]; };
  const boneDown = (bone) => { const R = F[bone].R; return [-R[1], -R[4], -R[7]]; };
  const mantle = def.mantle;

  // ---- one layer of strands on a surface. place(p, n) -> null (none here) or
  //      { want, L: [a, b], w: [a, b], lift: [a, b], droop, sway, minD, kind? }
  const grow = (surfName, count, place) => {
    const Sf = surfaces[surfName];
    if (!Sf) return;
    const next = sampler(Sf);
    const target = Math.round(count * (far ? 0.36 : 1));
    let made = 0;
    for (let tries = 0; tries < target * 25 && made < target; tries++) {
      const p = next();
      const n = ctx.normalAt(Sf.obj, p);
      const P = place(p, n);
      if (!P) continue;
      if (tooClose(P.layer || surfName, p, P.minD * (far ? 1.6 : 1))) continue;
      const down = tangent(n, P.want);
      if (!down) continue;
      const lift = rng.float(P.lift[0], P.lift[1]);
      const dir0 = norm(add(shade(rotAbout(down, n, rng.float(-0.5, 0.5)), Math.cos(lift)), n, Math.sin(lift)));
      R0 = add(p, n, -0.006);
      N0 = n;
      W = ctx.weights(R0, Sf.px);
      const ao = ctx.ao(add(p, n, 0.008), n);
      const L = rng.float(P.L[0], P.L[1]) * (far ? 1.08 : 1);
      const w = rng.float(P.w[0], P.w[1]) * (far ? 1.55 : 1);
      const kind = P.kind ? P.kind() : 'jute';
      if (kind === 'jute') {
        const k = rng.int(0, ATLAS.jute.n - 1);
        const tint = JUTE_TINT[rng.int(0, JUTE_TINT.length - 1)].map((v) => v * rng.float(0.85, 1.12));
        ribbon(R0, n, dir0, L, w, far ? 2 : 4, rng.float(0.12, 0.3), rng.float(-0.9, 0.9), stripRect(ATLAS.jute, k), tint, P.droop * rng.float(0.85, 1.1), P.sway, ao);
      } else if (kind === 'leafStrip') {
        const k = rng.int(0, ATLAS.leafStrip.n - 1);
        ribbon(R0, n, dir0, L * 0.75, w * 1.1, far ? 2 : 3, 0.12, rng.float(-1.4, 1.4), stripRect(ATLAS.leafStrip, k, 0.02), LEAF_TINT[rng.int(0, 3)], P.droop * 0.7, P.sway * 0.8, ao);
      } else {
        const k = rng.int(0, ATLAS.burlap.n - 1);
        const tint = JUTE_TINT[rng.int(0, 5)].map((v) => v * 0.95);
        ribbon(R0, n, dir0, L * 0.6, w * 1.45, far ? 2 : 3, 0.18, rng.float(-0.6, 0.6), stripRect(ATLAS.burlap, k, 0.03), tint, P.droop * 0.8, P.sway * 0.8, ao);
      }
      made++;
    }
  };
  const mixKind = (leafP, burlapP) => () => { const r = rng.next(); return r < leafP ? 'leafStrip' : r < leafP + burlapP ? 'burlap' : 'jute'; };

  // ---- the hood: a thick mop, flowing back and down from the face; short fringes over the brow
  grow('hood', 420, (p, n) => {
    const lx = p[0] - hd[0], ly = p[1] - hd[1], lz = p[2] - hd[2];
    const front = lz < -0.03 && Math.abs(lx) < 0.085 && ly < 0.12;
    if (front && ly < 0.07) return null;              // the face opening
    if (n[1] < -0.7) return null;
    const brow = front ? 1 : 0;
    return {
      want: brow ? [0, -1, -0.25] : [lx * 0.6, -1, 0.55], L: brow ? [0.05, 0.11] : [0.15, 0.3], w: [0.035, 0.06],
      lift: brow ? [0.05, 0.25] : [0.25, 0.7], droop: 0.75, sway: brow ? 0.35 : 0.6, minD: 0.0145, kind: mixKind(0.12, 0.05),
    };
  });
  // ---- shoulders and back (the mantle): long, dense
  grow('mantle', 760, (p, n) => {
    const ox = p[0], oz = p[2] - 0.02, ol = Math.hypot(ox, oz) || 1;
    const out = (n[0] * ox + n[2] * oz) / ol + Math.max(0, n[1]) * 0.9;
    if (out < 0.1) return null;
    const low = smooth(1.0, 0.72, p[1]);
    return {
      want: [0, -1, 0.15], L: [0.2 + 0.08 * low, 0.36 + 0.12 * low], w: [0.04, 0.07], lift: [0.2, 0.55],
      droop: 0.8, sway: 0.8 + 0.5 * low, minD: 0.017, kind: mixKind(0.16, 0.08),
    };
  });
  // ---- the jacket's front and sides, the arms and the legs (on the body)
  if (bodyS) {
    const cache = new Map();
    const boneAt = (p) => { const k = p.join(); if (!cache.has(k)) cache.set(k, limbOf(p)); return cache.get(k); };
    grow('body', 1050, (p, n) => {
      const bone = boneAt(p);
      if (!bone || bone === 'neck') return null;
      if (mantle && mantle.dist(p[0], p[1], p[2]) < 0.012) return null;   // under the mantle
      const s = bone.endsWith('R') ? 1 : -1;
      const ln = localN(bone, n), lp = localP(bone, p);
      if (bone === 'chest' || bone === 'spine' || bone === 'hips') {
        if (p[1] < 0.86) return null;
        return { want: [0, -1, 0], L: [0.13, 0.26], w: [0.035, 0.06], lift: [0.12, 0.4], droop: 0.75, sway: 0.6, minD: 0.02, layer: 'torso', kind: mixKind(0.14, 0.08) };
      }
      if (bone.startsWith('upperArm') || bone.startsWith('foreArm')) {
        const fore = bone.startsWith('fore');
        if (fore && lp[1] < -0.2) return null;              // keep the wrist clear (the glove's cuff)
        const inner = -(ln[0] * s);                          // toward the body in the A-pose
        if (inner > 0.75) return null;
        return { want: boneDown(bone), L: fore ? [0.09, 0.17] : [0.12, 0.22], w: [0.032, 0.052], lift: [0.15, 0.45], droop: 0.7, sway: 0.55, minD: 0.02, layer: 'arms', kind: mixKind(0.12, 0.06) };
      }
      if (bone.startsWith('thigh') || bone.startsWith('shin')) {
        const shin = bone.startsWith('shin');
        if (shin && lp[1] < -0.22) return null;             // the boot tops stay clear
        const inner = -(ln[0] * s);
        if (inner > 0.6 && !shin && lp[1] > -0.2) return null;   // the crotch
        if (ln[2] < -0.6 && rng.next() < 0.5) return null;       // fewer on the shins' and knees' front
        return { want: boneDown(bone), L: shin ? [0.1, 0.2] : [0.14, 0.27], w: [0.035, 0.055], lift: [0.1, 0.4], droop: 0.7, sway: 0.55, minD: 0.021, layer: 'legs', kind: mixKind(0.1, 0.08) };
      }
      return null;
    });
  }

  // ---- single leaves on the outside (beech and oak shapes, green and dry)
  const leafCells = ATLAS.leaves.cols * ATLAS.leaves.rows;
  const leafRect = (k) => {
    const L = ATLAS.leaves, cw = L.w / L.cols, ch = L.h / L.rows, cx = k % L.cols, cy = Math.floor(k / L.cols);
    return [L.x + cx * cw + 2, L.x + (cx + 1) * cw - 2, L.y + cy * ch + 2, L.y + (cy + 1) * ch - 2];
  };
  const scatterLeaves = (surfName, count, ok, size) => {
    const Sf = surfaces[surfName];
    if (!Sf) return;
    const next = sampler(Sf);
    const target = Math.round(count * (far ? 0.3 : 1));
    let made = 0;
    for (let tries = 0; tries < target * 20 && made < target; tries++) {
      const p = next();
      const n = ctx.normalAt(Sf.obj, p);
      if (!ok(p, n) || tooClose('leaves', p, 0.035)) continue;
      // lift the leaf out to where the strands' surface is, leaning down and out
      const up = tangent(n, [0, 1, 0]) || [0, 1, 0];
      const dir = norm(add(rotAbout(shade(up, -1), n, rng.float(-1.2, 1.2)), n, rng.float(0.3, 0.9)));
      const side = norm(cross(n, dir));
      R0 = add(p, n, rng.float(0.01, 0.05));
      N0 = n;
      W = ctx.weights(R0, Sf.px);
      const ao = ctx.ao(add(p, n, 0.03), n);
      const L = rng.float(size[0], size[1]);
      card(R0, n, dir, side, L, L * 0.75, leafRect(rng.int(0, leafCells - 1)), 'bottom', LEAF_TINT[rng.int(0, 3)], 0.35, 0.5, ao, far ? 2 : 3);
      made++;
    }
  };
  const outward = (p, n) => {
    const ox = p[0], oz = p[2] - 0.02, ol = Math.hypot(ox, oz) || 1;
    return (n[0] * ox + n[2] * oz) / ol + Math.max(0, n[1]) * 0.8 > 0.1;
  };
  scatterLeaves('mantle', 120, outward, [0.06, 0.1]);
  scatterLeaves('hood', 40, (p) => !(p[2] - hd[2] < -0.03 && p[1] - hd[1] < 0.1), [0.05, 0.08]);
  if (bodyS) scatterLeaves('body', 70, (p) => p[1] > 0.5 && (!mantle || mantle.dist(p[0], p[1], p[2]) > 0.01), [0.05, 0.085]);

  // ---- beech twigs and fern fronds tucked in: up and out of the shoulders, the hood and the back
  const tuck = (pts, make) => {
    for (const q of pts) {
      R0 = q.p; N0 = norm(q.out);
      W = ctx.weights(R0, surfaces.mantle ? surfaces.mantle.px : null);
      make(q);
    }
  };
  const twig = ATLAS.twig, fern = ATLAS.fern;
  const TWIGS = [
    { p: [0.15, 1.53, 0.06], out: [0.8, 0.5, 0.4], L: 0.26 }, { p: [-0.16, 1.52, 0.05], out: [-0.8, 0.55, 0.3], L: 0.24 },
    { p: [0.05, 1.74, 0.09], out: [0.3, 0.8, 0.5], L: 0.22 }, { p: [-0.07, 1.73, 0.1], out: [-0.4, 0.75, 0.5], L: 0.2 },
    { p: [0.1, 1.42, 0.16], out: [0.4, 0.4, 0.8], L: 0.28 }, { p: [-0.11, 1.3, 0.17], out: [-0.5, 0.3, 0.8], L: 0.26 },
    { p: [0.02, 1.1, 0.19], out: [0.1, 0.1, 1], L: 0.24 }, { p: [0.19, 1.35, 0.02], out: [1, 0.25, 0.1], L: 0.22 },
  ].slice(0, far ? 4 : 8);
  tuck(TWIGS, (q) => {
    const out = norm(q.out);
    const dir = norm(add(out, [0, 0.4, 0], 1));
    const side = norm(cross(out, dir).map((v) => v + 1e-3));
    card(q.p, out, dir, side, q.L, q.L * 0.5, [twig.x + 4, twig.x + twig.w - 4, twig.y + 4, twig.y + twig.h - 4], 'left', LEAF_TINT[0], 0.15, 0.6, 0.85, far ? 2 : 4);
  });
  const FERNS = [
    { p: [0.08, 1.48, 0.15], out: [0.3, 1, 0.6], L: 0.36 }, { p: [-0.1, 1.46, 0.14], out: [-0.35, 1, 0.55], L: 0.34 },
    { p: [0.0, 1.2, 0.2], out: [0.05, 0.8, 0.8], L: 0.32 },
  ].slice(0, far ? 2 : 3);
  tuck(FERNS, (q) => {
    const dir = norm(q.out);
    const side = norm(cross([0, 0, 1], dir));
    card(q.p, norm([dir[0], 0.2, dir[2] + 0.5]), dir, side, q.L, q.L * 0.5, [fern.x + 4, fern.x + fern.w - 4, fern.y + 4, fern.y + fern.h - 4], 'bottom', LEAF_TINT[2], 0.2, 0.9, 0.85, far ? 2 : 4);
  });

  const nv = out.pos.length / 3;
  return {
    name: 'ghillie', pos: new Float32Array(out.pos), nrm: new Float32Array(out.nrm), idx: new Uint32Array(out.idx),
    col: new Float32Array(out.col), camo: new Float32Array(nv), rough: new Float32Array(nv).fill(0.9), sway: new Float32Array(out.sway),
    uv: new Float32Array(out.uv), root: new Float32Array(out.root), rootN: new Float32Array(out.rootN), strand: new Float32Array(out.strand),
    si: new Uint16Array(out.si), sw: new Float32Array(out.sw),
  };
}

// Jute hanging from things that move as one piece (the rifle's wraps, the first-person
// sleeves): anchors [{ p, n }] in that piece's space, hanging toward `down`. No skinning and no
// gravity in the shader; plain { pos, nrm, uv, col, idx } for the atlas material.
export function hangingJute(anchors, { seed = 1, down = DOWN, L = [0.08, 0.16], w = [0.025, 0.04], segs = 3, lift = [0.1, 0.5], tone = 1, back = null } = {}) {
  const rng = new RNG(seed);
  const S = ATLAS.size;
  const out = { pos: [], nrm: [], uv: [], col: [], idx: [] };
  for (const a of anchors) {
    const n = norm(a.n);
    let d = add(down, n, -dot(down, n));
    d = Math.hypot(...d) < 1e-3 ? down : norm(d);
    // (back: lean them that way too, e.g. along a sleeve toward the elbow)
    if (back) d = norm(add(d, back, rng.float(0.3, 0.9)));
    const li = rng.float(lift[0], lift[1]);
    let dir = norm(add(shade3(d, Math.cos(li)), n, Math.sin(li)));
    const len = rng.float(L[0], L[1]), wd = rng.float(w[0], w[1]);
    const k = rng.int(0, ATLAS.jute.n - 1);
    const sw = ATLAS.jute.w / ATLAS.jute.n;
    const u0 = (ATLAS.jute.x + (k + 0.06) * sw) / S, u1 = (ATLAS.jute.x + (k + 0.94) * sw) / S;
    const tint = JUTE_TINT[rng.int(0, JUTE_TINT.length - 1)].map((v) => v * rng.float(0.85, 1.1) * tone);
    let side = norm(cross(n, dir));
    if (Math.hypot(...side) < 0.5) side = norm(cross([0, 0, 1], dir));
    side = rotAbout(side, dir, rng.float(-0.8, 0.8));
    let p = a.p;
    const base = out.pos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      if (i > 0) { dir = norm(mix(dir, down, 0.3)); p = add(p, dir, len / segs); }
      const sd = norm(add(side, dir, -dot(side, dir)));
      const nn = norm(add(cross(sd, dir), n, 0.8));
      const wi = wd * (1 - 0.3 * t);
      const kk = 0.5 + 0.6 * t;
      const c = [tint[0] * kk, tint[1] * kk, tint[2] * kk];
      const v = 1 - (ATLAS.jute.y + 2 + (ATLAS.jute.h - 4) * t) / S;
      out.pos.push(...add(p, sd, -wi / 2), ...add(p, sd, wi / 2));
      out.nrm.push(...nn, ...nn);
      out.uv.push(u0, v, u1, v);
      out.col.push(...c, ...c);
    }
    for (let i = 0; i < segs; i++) {
      const q = base + i * 2;
      out.idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
    }
  }
  return out;
}
const shade3 = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
