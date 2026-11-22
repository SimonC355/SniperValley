// A small sculpting kit for the stylized characters: shapes are described as signed distance
// fields (capsules and round cones, ellipsoids, rounded boxes, tori, shells) blended with smooth
// unions and carved with smooth subtractions, like clay. A narrow-band surface-nets mesher turns
// each object into triangles (vertices projected onto the true surface, normals from the field's
// gradient), and the field also gives cheap ambient occlusion for baked shading.
//
// Everything is plain numbers (no THREE objects in the hot loops) so a whole character meshes in
// a fraction of a second.

// ---------------------------------------------------------------- blends
export function smin(a, b, k) {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
export function smax(a, b, k) { return -smin(-a, -b, k); }

// ---------------------------------------------------------------- frames
// A rotation as 9 numbers, row-major; its columns are the local x / y / z axes in model space.
export const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export function mul3(A, B) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  return r;
}
// rotation from Euler angles (XYZ order, like THREE.Euler's default)
export function eulerRot(x = 0, y = 0, z = 0) {
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  return [c * e, -c * f, d, af + be * d, ae - bf * d, -b * c, bf - ae * d, be + af * d, a * c];
}
// rotation about an axis (unit) by an angle
export function axisRot(ax, ay, az, t) {
  const c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  return [c + ax * ax * C, ax * ay * C - az * s, ax * az * C + ay * s,
    ay * ax * C + az * s, c + ay * ay * C, ay * az * C - ax * s,
    az * ax * C - ay * s, az * ay * C + ax * s, c + az * az * C];
}
// the AABB half-size of a box with half extents (ex, ey, ez) rotated by R
function rotExtent(R, ex, ey, ez) {
  return [
    Math.abs(R[0]) * ex + Math.abs(R[1]) * ey + Math.abs(R[2]) * ez,
    Math.abs(R[3]) * ex + Math.abs(R[4]) * ey + Math.abs(R[5]) * ez,
    Math.abs(R[6]) * ex + Math.abs(R[7]) * ey + Math.abs(R[8]) * ez,
  ];
}

// ---------------------------------------------------------------- primitives
// Each primitive: { d(x, y, z) -> signed distance, min: [3], max: [3] } in model space.
export function sphere(c, r) {
  const [cx, cy, cz] = c;
  return { d: (x, y, z) => Math.hypot(x - cx, y - cy, z - cz) - r, min: [cx - r, cy - r, cz - r], max: [cx + r, cy + r, cz + r] };
}

// A cone with spherical ends: radius r1 at a, r2 at b (Inigo Quilez's exact round cone).
export function roundCone(a, b, r1, r2 = r1) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2, a2 = l2 - rr * rr;
  if (l2 < 1e-10 || a2 <= 1e-9) return r1 >= r2 ? sphere(a, r1) : sphere(b, r2);
  const il2 = 1 / l2, ax = a[0], ay = a[1], az = a[2];
  const sr = Math.sign(rr) * rr * rr;
  const d = (x, y, z) => {
    const px = x - ax, py = y - ay, pz = z - az;
    const yy = px * bax + py * bay + pz * baz;
    const zz = yy - l2;
    const qx = px * l2 - bax * yy, qy = py * l2 - bay * yy, qz = pz * l2 - baz * yy;
    const x2 = qx * qx + qy * qy + qz * qz;
    const y2 = yy * yy * l2, z2 = zz * zz * l2;
    const k = sr * x2;
    if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
    if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
    return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
  };
  return {
    d,
    min: [Math.min(a[0] - r1, b[0] - r2), Math.min(a[1] - r1, b[1] - r2), Math.min(a[2] - r1, b[2] - r2)],
    max: [Math.max(a[0] + r1, b[0] + r2), Math.max(a[1] + r1, b[1] + r2), Math.max(a[2] + r1, b[2] + r2)],
  };
}

// Ellipsoid (radii in its own frame R). Not exact, but a good bound near the surface.
export function ellipsoid(c, R, rx, ry, rz) {
  const [cx, cy, cz] = c;
  const [r0, r1, r2, r3, r4, r5, r6, r7, r8] = R;
  const ix = 1 / rx, iy = 1 / ry, iz = 1 / rz;
  const d = (x, y, z) => {
    const px = x - cx, py = y - cy, pz = z - cz;
    const lx = px * r0 + py * r3 + pz * r6, ly = px * r1 + py * r4 + pz * r7, lz = px * r2 + py * r5 + pz * r8;
    const ax = lx * ix, ay = ly * iy, az = lz * iz;
    const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
    const bx = ax * ix, by = ay * iy, bz = az * iz;
    const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
    return k1 < 1e-9 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
  };
  const e = rotExtent(R, rx, ry, rz);
  return { d, min: [cx - e[0], cy - e[1], cz - e[2]], max: [cx + e[0], cy + e[1], cz + e[2]] };
}

// Box with half extents (bx, by, bz) and edges rounded by r, in its own frame R.
export function roundBox(c, R, bx, by, bz, r) {
  const [cx, cy, cz] = c;
  const [r0, r1, r2, r3, r4, r5, r6, r7, r8] = R;
  r = Math.min(r, bx, by, bz);
  const qx0 = bx - r, qy0 = by - r, qz0 = bz - r;
  const d = (x, y, z) => {
    const px = x - cx, py = y - cy, pz = z - cz;
    const qx = Math.abs(px * r0 + py * r3 + pz * r6) - qx0;
    const qy = Math.abs(px * r1 + py * r4 + pz * r7) - qy0;
    const qz = Math.abs(px * r2 + py * r5 + pz * r8) - qz0;
    const mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0, mz = qz > 0 ? qz : 0;
    return Math.sqrt(mx * mx + my * my + mz * mz) + Math.min(Math.max(qx, qy, qz), 0) - r;
  };
  const e = rotExtent(R, bx, by, bz);
  return { d, min: [cx - e[0], cy - e[1], cz - e[2]], max: [cx + e[0], cy + e[1], cz + e[2]] };
}

// Torus: a ring of radius ra in the frame's xz plane, tube radius rb.
export function torus(c, R, ra, rb) {
  const [cx, cy, cz] = c;
  const [r0, r1, r2, r3, r4, r5, r6, r7, r8] = R;
  const d = (x, y, z) => {
    const px = x - cx, py = y - cy, pz = z - cz;
    const lx = px * r0 + py * r3 + pz * r6, ly = px * r1 + py * r4 + pz * r7, lz = px * r2 + py * r5 + pz * r8;
    const q = Math.sqrt(lx * lx + lz * lz) - ra;
    return Math.sqrt(q * q + ly * ly) - rb;
  };
  const e = rotExtent(R, ra + rb, rb, ra + rb);
  return { d, min: [cx - e[0], cy - e[1], cz - e[2]], max: [cx + e[0], cy + e[1], cz + e[2]] };
}

// Any distance function with given bounds.
export function custom(d, min, max) { return { d, min, max }; }

// A layer that follows another surface: the band between offsets o0 and o1 outside `base`
// (a distance function), cut to the bounds and to `mask` (a distance function, < 0 inside),
// with edges rounded by k. Vests, belts, straps and pads.
export function shell(base, o0, o1, mask, min, max, k = 0.004) {
  const mid = (o0 + o1) / 2, half = (o1 - o0) / 2;
  return { d: (x, y, z) => smax(Math.abs(base(x, y, z) - mid) - half, mask(x, y, z), k), min, max };
}

// ---------------------------------------------------------------- objects
// One closed surface: an ordered list of smooth unions ("add") and carvings ("sub"), each add
// with its colour and material; meshed at its own resolution h (metres).
export class SdfObject {
  constructor(name, { h = 0.012, bone = null } = {}) {
    this.name = name;
    this.h = h;
    this.bone = bone;           // rigid: every vertex on this bone
    this.ops = [];
    this.paints = [];
    this.min = [Infinity, Infinity, Infinity];
    this.max = [-Infinity, -Infinity, -Infinity];
    this.pad = 0.25;
  }

  // mat: { color: [r, g, b] linear, camo: 0..2, rough: 0..1, gear: 0..1 }, bone: for the weights
  add(prim, mat, { k = 0, bone = null } = {}) {
    this.ops.push({ sub: false, prim, mat, k, bone, bmin: prim.min, bmax: prim.max });
    for (let i = 0; i < 3; i++) { this.min[i] = Math.min(this.min[i], prim.min[i] - k); this.max[i] = Math.max(this.max[i], prim.max[i] + k); }
    return this;
  }

  sub(prim, { k = 0 } = {}) {
    this.ops.push({ sub: true, prim, k, bmin: prim.min, bmax: prim.max });
    return this;
  }

  // fn(x, y, z, col) may change col (linear rgb, col[3] camo, col[4] roughness, col[5] gear) in place
  paint(fn) { this.paints.push(fn); return this; }

  dist(x, y, z) {
    const pad = this.pad;
    let d = 1e9;
    const ops = this.ops;
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i], mn = o.bmin, mx = o.bmax, p = pad + o.k;
      if (x < mn[0] - p || x > mx[0] + p || y < mn[1] - p || y > mx[1] + p || z < mn[2] - p || z > mx[2] + p) continue;
      const di = o.prim.d(x, y, z);
      d = o.sub ? smax(d, -di, o.k) : smin(d, di, o.k);
    }
    return d;
  }

  // the field from a list of operations already culled to a region
  distOps(x, y, z, ops) {
    let d = 1e9;
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      const di = o.prim.d(x, y, z);
      d = o.sub ? smax(d, -di, o.k) : smin(d, di, o.k);
    }
    return d;
  }

  // the operations whose shapes come within `pad` (plus their blend) of a box
  opsNear(x0, y0, z0, x1, y1, z1, pad) {
    const list = [];
    for (const o of this.ops) {
      const p = pad + o.k, mn = o.bmin, mx = o.bmax;
      if (mx[0] + p < x0 || mn[0] - p > x1 || mx[1] + p < y0 || mn[1] - p > y1 || mx[2] + p < z0 || mn[2] - p > z1) continue;
      list.push(o);
    }
    return list;
  }

  // colour and material at a surface point: the nearest added shape's, blended softly
  // across smooth unions, then the paints.
  material(x, y, z, out) {
    let wsum = 0, r = 0, g = 0, b = 0, camo = 0, rough = 0, gear = 0;
    let best = Infinity;
    const ds = this._ds || (this._ds = new Float64Array(this.ops.length));
    // (shapes more than a few centimetres away can't be the nearest at a surface point)
    const ops = this.ops;
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i], mn = o.bmin, mx = o.bmax, p = 0.03 + o.k;
      if (o.sub || x < mn[0] - p || x > mx[0] + p || y < mn[1] - p || y > mx[1] + p || z < mn[2] - p || z > mx[2] + p) { ds[i] = Infinity; continue; }
      const di = o.prim.d(x, y, z);
      ds[i] = di;
      if (di < best) best = di;
    }
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      const di = ds[i];
      if (di === Infinity) continue;
      const s = Math.max(0.0015, o.k * 0.35);
      const w = Math.exp(-(di - best) / s);
      if (w < 1e-4) continue;
      const m = o.mat;
      r += m.color[0] * w; g += m.color[1] * w; b += m.color[2] * w;
      camo += (m.camo || 0) * w; rough += (m.rough === undefined ? 0.85 : m.rough) * w; gear += (m.gear || 0) * w;
      wsum += w;
    }
    out[0] = r / wsum; out[1] = g / wsum; out[2] = b / wsum; out[3] = camo / wsum; out[4] = rough / wsum; out[5] = gear / wsum;
    for (const fn of this.paints) fn(x, y, z, out);
    return out;
  }
}

// ---------------------------------------------------------------- mesher
// Narrow-band surface nets: the field is sampled on a coarse grid first and only the coarse
// cells near the surface are refined, so the cost grows with the surface area, not the volume.
// Returns { pos: Float32Array, nrm: Float32Array, idx: Uint32Array }.
export function meshObject(obj) {
  const h = obj.h, C = 4;
  const f = (x, y, z) => obj.dist(x, y, z);
  const ox = obj.min[0] - 2 * h, oy = obj.min[1] - 2 * h, oz = obj.min[2] - 2 * h;
  const cells = (span) => Math.ceil(Math.ceil((span + 4 * h) / h) / C) * C;
  const nx = cells(obj.max[0] - obj.min[0]) + 1, ny = cells(obj.max[1] - obj.min[1]) + 1, nz = cells(obj.max[2] - obj.min[2]) + 1;
  const N = nx * ny * nz, sy = nx, sz = nx * ny;
  const val = new Float32Array(N);
  const exact = new Uint8Array(N);
  const cnx = (nx - 1) / C + 1, cny = (ny - 1) / C + 1, cnz = (nz - 1) / C + 1;
  const cval = new Float32Array(cnx * cny * cnz);
  obj.pad = 1.7 * C * h * 1.7321 + 0.02;
  for (let k = 0; k < cnz; k++) for (let j = 0; j < cny; j++) for (let i = 0; i < cnx; i++) {
    cval[i + cnx * (j + cny * k)] = f(ox + i * C * h, oy + j * C * h, oz + k * C * h);
  }
  const thr = 1.25 * C * h * 1.7321;
  const activeCells = [];
  obj.pad = 4 * h + 0.01;
  for (let ck = 0; ck < cnz - 1; ck++) for (let cj = 0; cj < cny - 1; cj++) for (let ci = 0; ci < cnx - 1; ci++) {
    const c = (a, b, e) => cval[(ci + a) + cnx * ((cj + b) + cny * (ck + e))];
    const v000 = c(0, 0, 0), v100 = c(1, 0, 0), v010 = c(0, 1, 0), v110 = c(1, 1, 0);
    const v001 = c(0, 0, 1), v101 = c(1, 0, 1), v011 = c(0, 1, 1), v111 = c(1, 1, 1);
    const mn = Math.min(Math.abs(v000), Math.abs(v100), Math.abs(v010), Math.abs(v110), Math.abs(v001), Math.abs(v101), Math.abs(v011), Math.abs(v111));
    const i0 = ci * C, j0 = cj * C, k0 = ck * C;
    if (mn < thr) {
      activeCells.push(ci, cj, ck);
      const x0 = ox + i0 * h, y0 = oy + j0 * h, z0 = oz + k0 * h, ext = C * h;
      const ops = obj.opsNear(x0, y0, z0, x0 + ext, y0 + ext, z0 + ext, 4 * h + 0.01);
      for (let k = k0; k <= k0 + C; k++) for (let j = j0; j <= j0 + C; j++) for (let i = i0; i <= i0 + C; i++) {
        const n = i + sy * j + sz * k;
        if (exact[n]) continue;
        exact[n] = 1;
        val[n] = obj.distOps(ox + i * h, oy + j * h, oz + k * h, ops);
      }
    } else {
      for (let k = k0; k <= k0 + C; k++) for (let j = j0; j <= j0 + C; j++) for (let i = i0; i <= i0 + C; i++) {
        const n = i + sy * j + sz * k;
        if (exact[n]) continue;
        const u = (i - i0) / C, v = (j - j0) / C, w = (k - k0) / C;
        val[n] = (v000 * (1 - u) + v100 * u) * (1 - v) * (1 - w) + (v010 * (1 - u) + v110 * u) * v * (1 - w)
          + (v001 * (1 - u) + v101 * u) * (1 - v) * w + (v011 * (1 - u) + v111 * u) * v * w;
      }
    }
  }
  // vertices: one per fine cell that the surface passes through
  const vid = new Int32Array(N).fill(-1);
  const P = [];
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float64Array(8);
  for (let a = 0; a < activeCells.length; a += 3) {
    const i0 = activeCells[a] * C, j0 = activeCells[a + 1] * C, k0 = activeCells[a + 2] * C;
    for (let k = k0; k < k0 + C; k++) for (let j = j0; j < j0 + C; j++) for (let i = i0; i < i0 + C; i++) {
      const n = i + sy * j + sz * k;
      let mask = 0;
      for (let q = 0; q < 8; q++) {
        const c = corner[q];
        cv[q] = val[n + c[0] + sy * c[1] + sz * c[2]];
        if (cv[q] < 0) mask |= 1 << q;
      }
      if (mask === 0 || mask === 255) continue;
      let sx = 0, syy = 0, szz = 0, cnt = 0;
      for (const [e0, e1] of edges) {
        const a0 = cv[e0], a1 = cv[e1];
        if ((a0 < 0) === (a1 < 0)) continue;
        const t = a0 / (a0 - a1);
        const c0 = corner[e0], c1 = corner[e1];
        sx += c0[0] + (c1[0] - c0[0]) * t; syy += c0[1] + (c1[1] - c0[1]) * t; szz += c0[2] + (c1[2] - c0[2]) * t;
        cnt++;
      }
      vid[n] = P.length / 3;
      P.push(ox + (i + sx / cnt) * h, oy + (j + syy / cnt) * h, oz + (k + szz / cnt) * h);
    }
  }
  // faces: a quad around every grid edge the surface crosses
  const I = [];
  const quad = (a, b, c, d) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    // split along the shorter diagonal
    const dac = dist2(P, a, c), dbd = dist2(P, b, d);
    if (dac <= dbd) I.push(a, b, c, a, c, d); else I.push(a, b, d, b, c, d);
  };
  for (let a = 0; a < activeCells.length; a += 3) {
    const i0 = activeCells[a] * C, j0 = activeCells[a + 1] * C, k0 = activeCells[a + 2] * C;
    for (let k = k0; k < k0 + C; k++) for (let j = j0; j < j0 + C; j++) for (let i = i0; i < i0 + C; i++) {
      const n = i + sy * j + sz * k;
      const inside = val[n] < 0;
      // x edge
      if (j > 0 && k > 0 && (val[n + 1] < 0) !== inside) {
        const q = [vid[n - sy - sz], vid[n - sz], vid[n], vid[n - sy]];
        if (inside) quad(q[0], q[1], q[2], q[3]); else quad(q[3], q[2], q[1], q[0]);
      }
      // y edge
      if (i > 0 && k > 0 && (val[n + sy] < 0) !== inside) {
        const q = [vid[n - 1 - sz], vid[n - 1], vid[n], vid[n - sz]];
        if (inside) quad(q[3], q[2], q[1], q[0]); else quad(q[0], q[1], q[2], q[3]);
      }
      // z edge
      if (i > 0 && j > 0 && (val[n + sz] < 0) !== inside) {
        const q = [vid[n - 1 - sy], vid[n - sy], vid[n], vid[n - 1]];
        if (inside) quad(q[0], q[1], q[2], q[3]); else quad(q[3], q[2], q[1], q[0]);
      }
    }
  }
  // project the vertices onto the surface (one Newton step: they start within half a cell of it)
  // and take the normals from the gradient
  obj.pad = 2 * h + 0.01;
  const nv = P.length / 3;
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3);
  const g = [0, 0, 0];
  const e = Math.min(0.0015, h * 0.25);
  for (let v = 0; v < nv; v++) {
    let x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    const d = f(x, y, z);
    grad(f, x, y, z, e, g);
    const gl = Math.hypot(g[0], g[1], g[2]) || 1;
    g[0] /= gl; g[1] /= gl; g[2] /= gl;
    // (the tetrahedron gradient is 4e times the true one)
    let s = d / (gl / (4 * e));
    if (s > h) s = h; else if (s < -h) s = -h;
    x -= g[0] * s; y -= g[1] * s; z -= g[2] * s;
    pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
    nrm[v * 3] = g[0]; nrm[v * 3 + 1] = g[1]; nrm[v * 3 + 2] = g[2];
  }
  // make every triangle face outward (along the field's gradient)
  const idx = new Uint32Array(I);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const nx2 = nrm[a * 3] + nrm[b * 3] + nrm[c * 3], ny2 = nrm[a * 3 + 1] + nrm[b * 3 + 1] + nrm[c * 3 + 1], nz2 = nrm[a * 3 + 2] + nrm[b * 3 + 2] + nrm[c * 3 + 2];
    if (cx * nx2 + cy * ny2 + cz * nz2 < 0) { idx[t + 1] = c; idx[t + 2] = b; }
  }
  obj.pad = 0.25;
  return { pos, nrm, idx };
}

// The surface normal at a point: the field's gradient, normalised.
export function normalAt(f, x, y, z, out, e = 0.0008) {
  grad(f, x, y, z, e, out);
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= l; out[1] /= l; out[2] /= l;
  return out;
}

function dist2(P, a, b) {
  const dx = P[a * 3] - P[b * 3], dy = P[a * 3 + 1] - P[b * 3 + 1], dz = P[a * 3 + 2] - P[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

// gradient by the tetrahedron technique (4 samples)
export function grad(f, x, y, z, e, out) {
  const a = f(x + e, y - e, z - e), b = f(x - e, y - e, z + e), c = f(x - e, y + e, z - e), d = f(x + e, y + e, z + e);
  out[0] = a - b - c + d; out[1] = -a - b + c + d; out[2] = -a + b - c + d;
  return out;
}

// Ambient occlusion from a distance field: how much of the space just outside the surface, at
// two scales (creases and broad cavities), is filled.
export function sdfAO(f, x, y, z, nx, ny, nz) {
  let occ = 0, w = 1;
  for (let i = 1; i <= 4; i++) {
    const t = 0.004 + 0.009 * i;
    occ += w * Math.max(0, t - f(x + nx * t, y + ny * t, z + nz * t));
    w *= 0.7;
  }
  let occ2 = 0;
  w = 1;
  for (let i = 1; i <= 3; i++) {
    const t = 0.03 + 0.035 * i;
    occ2 += w * Math.max(0, t - f(x + nx * t, y + ny * t, z + nz * t));
    w *= 0.6;
  }
  return Math.max(0, Math.min(1, 1 - 9 * occ - 2.2 * occ2));
}
