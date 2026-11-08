// Analytic spatial queries: raycasts against terrain (ray-marched heightfield), tree trunks,
// tree crown cores, rocks (their drawn top surface), buildings and walls (convex solids),
// fallen logs, stumps and (optionally) bushes. Used for bullets, line of sight, glint/flash
// visibility and movement collision. No physics engine.
//
// groundAt() is the height you stand on: the terrain, or the top of a rock, a wall or a
// building. The player walks up small steps and climbs higher ones (player.js).
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { rayCapsule } from './hitbox.js';
import { trunkProfile, ROUND_CROWN } from './trees.js';
import { rockTopAt } from './rocks.js';

const CELL = 8;

export class World {
  constructor(terrain, forest, rocks, undergrowth, debris, solids = []) {
    this.terrain = terrain;
    const M = CONFIG.map;
    this.minX = -M.length / 2 - 60;
    this.minZ = -M.width / 2 - 60;
    this.nx = Math.ceil((M.length + 120) / CELL);
    this.nz = Math.ceil((M.width + 120) / CELL);
    this.cells = new Array(this.nx * this.nz);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = [];
    this.colliders = [];
    for (const t of forest.trees) {
      if (t.x < this.minX || t.z < this.minZ || t.x > -this.minX || t.z > -this.minZ) continue;
      // trunk: the drawn shape (bent, tapered) for bullets and sight; r: for walking into it
      const trunk = trunkProfile(t);
      let br = 0;
      for (const q of trunk) br = Math.max(br, Math.hypot(q.x - t.x, q.z - t.z) + q.r);
      this._add({
        kind: 'tree', x: t.x, z: t.z, y0: t.y, top: t.y + t.height, r: t.trunkR, trunk, br,
        cb: t.crownBase, ct: t.crownTop, cr: t.coreR, round: ROUND_CROWN(t.variant), tree: t,
      }, Math.max(br, t.coreR));
    }
    for (const r of rocks.items) {
      // R: footprint radius of the drawn rock (its height map); r: the circle the AI walks around
      this._add({ kind: 'rock', x: r.x, z: r.z, y: r.y + r.s * 0.12, r: r.s * 0.78, R: r.R, y0: r.y - r.s, top: r.maxY, item: r }, r.R);
    }
    // buildings, ruined walls: convex solids (see buildings.js)
    for (const so of solids) this._add(so, so.R);
    if (debris) {
      for (const l of debris.logs) {
        const mx = (l.a.x + l.b.x) / 2, mz = (l.a.z + l.b.z) / 2;
        this._add({ kind: 'log', x: mx, z: mz, a: l.a, b: l.b, r: l.r, top: Math.max(l.a.y, l.b.y) + l.r }, l.len / 2 + l.r);
      }
      for (const st of debris.stumps) {
        this._add({ kind: 'stump', x: st.x, z: st.z, y0: st.y, top: st.top, r: st.r }, st.r);
      }
    }
    for (const b of undergrowth.items) {
      this._add({ kind: 'bush', x: b.x, z: b.z, y: b.y + 0.45 * b.s * (b.sy || 1), r: b.radius * 0.8 }, b.radius);
    }
    this.stamp = new Uint32Array(this.colliders.length);
    this.stampId = 1;
    this._p = new THREE.Vector3();
  }

  _add(c, radius) {
    const id = this.colliders.length;
    c.id = id;
    this.colliders.push(c);
    const i0 = Math.floor((c.x - radius - this.minX) / CELL), i1 = Math.floor((c.x + radius - this.minX) / CELL);
    const j0 = Math.floor((c.z - radius - this.minZ) / CELL), j1 = Math.floor((c.z + radius - this.minZ) / CELL);
    for (let j = Math.max(0, j0); j <= Math.min(this.nz - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(this.nx - 1, i1); i++) this.cells[j * this.nx + i].push(id);
    }
  }

  // ------------------------------------------------------------------ terrain
  terrainRaycast(o, d, maxDist) {
    const T = this.terrain;
    let tPrev = 0;
    let prevAbove = o.y - T.heightAt(o.x, o.z);
    if (prevAbove < 0) return 0;
    let t = 0;
    while (t < maxDist) {
      const step = Math.min(2.0, Math.max(0.35, t * 0.012));
      t = Math.min(maxDist, t + step);
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      const above = y - T.heightAt(x, z);
      if (above < 0) {
        let a = tPrev, b = t;
        for (let k = 0; k < 7; k++) {
          const m = (a + b) * 0.5;
          const ab = o.y + d.y * m - T.heightAt(o.x + d.x * m, o.z + d.z * m);
          if (ab < 0) b = m; else a = m;
        }
        return (a + b) * 0.5;
      }
      tPrev = t;
      prevAbove = above;
      if (t >= maxDist) break;
    }
    return Infinity;
  }

  // ------------------------------------------------------------------ primitives
  // ray vs vertical cylinder (finite); returns [tEnter, tExit] or null
  static _cyl(o, d, cx, cz, r, y0, y1) {
    const ox = o.x - cx, oz = o.z - cz;
    const a = d.x * d.x + d.z * d.z;
    if (a < 1e-9) {
      if (ox * ox + oz * oz > r * r) return null;
      const ta = (y0 - o.y) / d.y, tb = (y1 - o.y) / d.y;
      return [Math.min(ta, tb), Math.max(ta, tb)];
    }
    const b = 2 * (ox * d.x + oz * d.z);
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    let t0 = (-b - s) / (2 * a), t1 = (-b + s) / (2 * a);
    // clip by y range
    if (Math.abs(d.y) > 1e-9) {
      let ya = (y0 - o.y) / d.y, yb = (y1 - o.y) / d.y;
      if (ya > yb) { const tmp = ya; ya = yb; yb = tmp; }
      t0 = Math.max(t0, ya); t1 = Math.min(t1, yb);
    } else if (o.y < y0 || o.y > y1) return null;
    if (t1 < t0) return null;
    return [t0, t1];
  }

  static _sphere(o, d, cx, cy, cz, r) {
    const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz;
    const b = ox * d.x + oy * d.y + oz * d.z;
    const c = ox * ox + oy * oy + oz * oz - r * r;
    const disc = b * b - c;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    return [-b - s, -b + s];
  }

  // Ray against a convex solid (a building, a wall): planes in its local frame (rotated by
  // c.cos/c.sin about Y around (c.x, c.z)), each [nx, ny, nz, w] with inside = n·p <= w.
  static _convex(o, d, c) {
    const ox = o.x - c.x, oz = o.z - c.z;
    const lx = ox * c.cos + oz * c.sin, lz = -ox * c.sin + oz * c.cos;
    const dx = d.x * c.cos + d.z * c.sin, dz = -d.x * c.sin + d.z * c.cos;
    let t0 = 0, t1 = Infinity;
    for (const [nx, ny, nz, w] of c.planes) {
      const den = nx * dx + ny * d.y + nz * dz;
      const dist = w - (nx * lx + ny * o.y + nz * lz);
      if (Math.abs(den) < 1e-9) { if (dist < 0) return Infinity; continue; }
      const t = dist / den;
      if (den < 0) { if (t > t0) t0 = t; } else if (t < t1) t1 = t;
      if (t0 > t1) return Infinity;
    }
    return t0;
  }

  _testCollider(c, o, d, maxDist, opts) {
    if (c.kind === 'tree') {
      let best = Infinity;
      // trunk: a quick test against a cylinder around it, then its capsules
      const hit = World._cyl(o, d, c.x, c.z, c.br, c.y0 - 0.5, c.top);
      if (hit && hit[1] > 0 && hit[0] < maxDist) {
        const tr = c.trunk;
        for (let j = 0; j < tr.length - 1; j++) {
          const t = rayCapsule(o, d, tr[j], tr[j + 1], (tr[j].r + tr[j + 1].r) * 0.5);
          if (t >= 0 && t < best && t < maxDist) best = t;
        }
      }
      if (c.cr > 0 && opts.crowns !== false) {
        const ch = World._cyl(o, d, c.x, c.z, c.cr, c.cb, c.ct);
        if (ch && ch[1] > 0 && ch[0] < Math.min(best, maxDist)) {
          // sample along the chord: inside the crown profile?
          const ta = Math.max(0, ch[0]), tb = Math.min(ch[1], maxDist);
          const n = 7;
          for (let k = 0; k <= n; k++) {
            const t = ta + ((tb - ta) * k) / n;
            const y = o.y + d.y * t;
            const u = (y - c.cb) / (c.ct - c.cb);
            if (u < 0 || u > 1) continue;
            const prof = c.round ? Math.pow(Math.sin(Math.PI * (0.12 + 0.88 * u)), 0.7) * (1 - 0.25 * u) : (1 - u);
            const rr = c.cr * prof;
            const px = o.x + d.x * t - c.x, pz = o.z + d.z * t - c.z;
            if (px * px + pz * pz < rr * rr) { if (t < best) best = t; break; }
          }
        }
      }
      return best;
    }
    if (c.kind === 'rock') {
      // the drawn top surface: march the chord through the rock's footprint
      const h = World._cyl(o, d, c.x, c.z, c.R, c.y0, c.top);
      if (!h || h[1] < 0 || h[0] > maxDist) return Infinity;
      const ta = Math.max(0, h[0]), tb = Math.min(h[1], maxDist);
      const step = 0.1;
      for (let t = ta; t <= tb + 1e-6; t += step) {
        const y = o.y + d.y * t;
        if (y < rockTopAt(c.item, o.x + d.x * t, o.z + d.z * t)) {
          // refine between the last free sample and this one
          let a = Math.max(ta, t - step), b = t;
          for (let k = 0; k < 5; k++) {
            const m = (a + b) * 0.5;
            if (o.y + d.y * m < rockTopAt(c.item, o.x + d.x * m, o.z + d.z * m)) b = m; else a = m;
          }
          return b;
        }
      }
      return Infinity;
    }
    if (c.kind === 'solid') {
      const t = World._convex(o, d, c);
      return t < maxDist ? t : Infinity;
    }
    if (c.kind === 'log') {
      const t = rayCapsule(o, d, c.a, c.b, c.r);
      return t >= 0 && t < maxDist ? t : Infinity;
    }
    if (c.kind === 'stump') {
      const hit = World._cyl(o, d, c.x, c.z, c.r, c.y0 - 0.5, c.top);
      if (hit && hit[1] > 0 && hit[0] < maxDist) return Math.max(0, hit[0]);
      return Infinity;
    }
    if (c.kind === 'bush' && opts.bushes) {
      const h = World._sphere(o, d, c.x, c.y, c.z, c.r);
      if (h && h[1] > 0 && h[0] < maxDist) return Math.max(0, h[0]);
    }
    return Infinity;
  }

  // Raycast against everything. Returns { t, kind, collider, point } or null.
  // opts: { bushes: bool, crowns: bool, terrain: bool, ignoreNear: metres }
  raycast(o, d, maxDist, opts = {}) {
    let bestT = Infinity, bestC = null;
    const stampId = ++this.stampId;
    if (stampId > 4e9) { this.stamp.fill(0); this.stampId = 1; }
    // 2D DDA across grid cells
    const len2 = Math.hypot(d.x, d.z);
    const fx = (o.x - this.minX) / CELL, fz = (o.z - this.minZ) / CELL;
    let i = Math.floor(fx), j = Math.floor(fz);
    const stepI = d.x > 0 ? 1 : -1, stepJ = d.z > 0 ? 1 : -1;
    const dx = len2 > 1e-9 ? d.x : 0, dz = len2 > 1e-9 ? d.z : 0;
    const tDeltaI = Math.abs(dx) > 1e-9 ? CELL / Math.abs(dx) : Infinity;
    const tDeltaJ = Math.abs(dz) > 1e-9 ? CELL / Math.abs(dz) : Infinity;
    let tMaxI = Math.abs(dx) > 1e-9 ? ((d.x > 0 ? i + 1 - fx : fx - i) * CELL) / Math.abs(dx) : Infinity;
    let tMaxJ = Math.abs(dz) > 1e-9 ? ((d.z > 0 ? j + 1 - fz : fz - j) * CELL) / Math.abs(dz) : Infinity;
    let tCell = 0;
    const ignoreNear = opts.ignoreNear || 0;
    let guard = 0;
    while (tCell < Math.min(maxDist, bestT) && guard++ < 4000) {
      if (i >= 0 && j >= 0 && i < this.nx && j < this.nz) {
        const list = this.cells[j * this.nx + i];
        for (let k = 0; k < list.length; k++) {
          const id = list[k];
          if (this.stamp[id] === stampId) continue;
          this.stamp[id] = stampId;
          const c = this.colliders[id];
          const t = this._testCollider(c, o, d, Math.min(maxDist, bestT), opts);
          if (t < bestT && t >= ignoreNear) { bestT = t; bestC = c; }
        }
      } else if ((i < 0 && stepI < 0) || (j < 0 && stepJ < 0) || (i >= this.nx && stepI > 0) || (j >= this.nz && stepJ > 0)) {
        break;
      }
      if (tMaxI < tMaxJ) { tCell = tMaxI; tMaxI += tDeltaI; i += stepI; }
      else { tCell = tMaxJ; tMaxJ += tDeltaJ; j += stepJ; }
    }
    let kind = bestC ? bestC.kind : null;
    if (opts.terrain !== false) {
      const tt = this.terrainRaycast(o, d, Math.min(maxDist, bestT));
      if (tt < bestT) { bestT = tt; bestC = null; kind = 'terrain'; }
    }
    if (bestT === Infinity || bestT > maxDist) return null;
    return {
      t: bestT, kind, collider: bestC,
      point: new THREE.Vector3(o.x + d.x * bestT, o.y + d.y * bestT, o.z + d.z * bestT),
    };
  }

  // Line of sight between two points. Returns true if clear.
  lineOfSight(a, b, opts = {}) {
    const d = this._p.subVectors(b, a);
    const len = d.length();
    if (len < 1e-3) return true;
    const dir = d.clone().divideScalar(len);
    const hit = this.raycast(a, dir, len - (opts.endMargin ?? 0.4), opts);
    return hit === null;
  }

  // Visibility factor 0..1 (bushes near the target soften it instead of blocking).
  visibility(a, b) {
    if (!this.lineOfSight(a, b)) return 0;
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    d.divideScalar(len);
    const hit = this.raycast(a, d, len - 0.3, { bushes: true, terrain: false });
    if (hit && hit.kind === 'bush') return hit.t > len - 6 ? 0.25 : 0.55;
    return 1;
  }

  // Push a circle (x,z) out of trunks, stumps, logs, rocks and buildings. Returns adjusted {x,z}.
  // climber: the player, who walks onto and climbs rocks, walls and buildings (groundAt) instead.
  collideCircle(pos, radius, footY, climber = false) {
    const i0 = Math.floor((pos.x - radius - this.minX) / CELL), i1 = Math.floor((pos.x + radius - this.minX) / CELL);
    const j0 = Math.floor((pos.z - radius - this.minZ) / CELL), j1 = Math.floor((pos.z + radius - this.minZ) / CELL);
    for (let j = Math.max(0, j0); j <= Math.min(this.nz - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(this.nx - 1, i1); i++) {
        const list = this.cells[j * this.nx + i];
        for (let k = 0; k < list.length; k++) {
          const c = this.colliders[list[k]];
          let r;
          if (c.kind === 'log') {
            if (footY === undefined || footY < c.top - 0.15) this._pushFromSegment(pos, c, c.r * 0.9 + radius);
            continue;
          }
          if (c.kind === 'tree' || c.kind === 'stump') r = c.r + radius;
          else if (c.kind === 'rock') {
            if (climber || (footY !== undefined && footY > c.y + c.r * 0.6)) continue;
            r = c.r * 0.9 + radius;
          } else if (c.kind === 'solid') {
            if (!climber) this._pushFromBox(pos, c, radius);
            continue;
          } else continue;
          const dx = pos.x - c.x, dz = pos.z - c.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < r * r && d2 > 1e-8) {
            const d = Math.sqrt(d2);
            pos.x = c.x + (dx / d) * r;
            pos.z = c.z + (dz / d) * r;
          }
        }
      }
    }
    return pos;
  }

  // push a circle out of a solid's footprint (a rotated rectangle)
  _pushFromBox(pos, c, r) {
    const ox = pos.x - c.x, oz = pos.z - c.z;
    const lx = ox * c.cos + oz * c.sin, lz = -ox * c.sin + oz * c.cos;
    const cx = Math.max(-c.hx, Math.min(c.hx, lx)), cz = Math.max(-c.hz, Math.min(c.hz, lz));
    let dx = lx - cx, dz = lz - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) return;
    let nx, nz;
    if (d2 > 1e-8) { const d = Math.sqrt(d2); nx = lx + (dx / d) * (r - d); nz = lz + (dz / d) * (r - d); } else {
      // centre inside: out through the nearest side
      const px = c.hx - Math.abs(lx), pz = c.hz - Math.abs(lz);
      if (px < pz) { nx = Math.sign(lx || 1) * (c.hx + r); nz = lz; } else { nx = lx; nz = Math.sign(lz || 1) * (c.hz + r); }
    }
    pos.x = c.x + nx * c.cos - nz * c.sin;
    pos.z = c.z + nx * c.sin + nz * c.cos;
  }

  // Highest rock, wall or building top at (x, z) (not the terrain), or -Infinity.
  obstacleAt(x, z) {
    let g = -Infinity;
    const i = Math.floor((x - this.minX) / CELL), j = Math.floor((z - this.minZ) / CELL);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return g;
    const list = this.cells[j * this.nx + i];
    for (let k = 0; k < list.length; k++) {
      const c = this.colliders[list[k]];
      if (c.kind === 'rock') {
        if (c.top <= g) continue;
        const h = rockTopAt(c.item, x, z);
        if (h > g) g = h;
      } else if (c.kind === 'solid') {
        const h = c.topAt(x, z);
        if (h > g) g = h;
      }
    }
    return g;
  }

  // Height you stand on at (x, z): the terrain, or the top of a rock, wall or building.
  groundAt(x, z) {
    let g = this.terrain.heightAt(x, z);
    const i = Math.floor((x - this.minX) / CELL), j = Math.floor((z - this.minZ) / CELL);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return g;
    const list = this.cells[j * this.nx + i];
    for (let k = 0; k < list.length; k++) {
      const c = this.colliders[list[k]];
      if (c.kind === 'rock') {
        if (c.top <= g) continue;
        const h = rockTopAt(c.item, x, z);
        if (h > g) g = h;
      } else if (c.kind === 'solid') {
        const h = c.topAt(x, z);
        if (h > g) g = h;
      }
    }
    return g;
  }

  // closest point on a log's axis in 2D; returns squared distance and sets _cq
  _logClosest(x, z, c) {
    const ax = c.a.x, az = c.a.z, dx = c.b.x - ax, dz = c.b.z - az;
    const L2 = dx * dx + dz * dz;
    const u = L2 > 1e-8 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)) : 0;
    this._cqx = ax + dx * u;
    this._cqz = az + dz * u;
    return (x - this._cqx) ** 2 + (z - this._cqz) ** 2;
  }

  // push a circle out of a log's footprint (2D distance to its axis)
  _pushFromSegment(pos, c, r) {
    const d2 = this._logClosest(pos.x, pos.z, c);
    if (d2 < r * r && d2 > 1e-8) {
      const d = Math.sqrt(d2);
      pos.x = this._cqx + ((pos.x - this._cqx) / d) * r;
      pos.z = this._cqz + ((pos.z - this._cqz) / d) * r;
    }
  }

  // nearby colliders (for cover evaluation)
  query(x, z, radius, kinds) {
    const out = [];
    const i0 = Math.floor((x - radius - this.minX) / CELL), i1 = Math.floor((x + radius - this.minX) / CELL);
    const j0 = Math.floor((z - radius - this.minZ) / CELL), j1 = Math.floor((z + radius - this.minZ) / CELL);
    const seen = new Set();
    for (let j = Math.max(0, j0); j <= Math.min(this.nz - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(this.nx - 1, i1); i++) {
        for (const id of this.cells[j * this.nx + i]) {
          if (seen.has(id)) continue;
          seen.add(id);
          const c = this.colliders[id];
          if (kinds && !kinds.includes(c.kind)) continue;
          if (c.kind === 'log') {
            if (this._logClosest(x, z, c) < (radius + c.r) ** 2) out.push(c);
          } else if (c.kind === 'solid') {
            const ox = x - c.x, oz = z - c.z;
            const lx = Math.abs(ox * c.cos + oz * c.sin) - c.hx, lz = Math.abs(-ox * c.sin + oz * c.cos) - c.hz;
            if (Math.max(lx, 0) ** 2 + Math.max(lz, 0) ** 2 < radius * radius) out.push(c);
          } else if (c.kind === 'rock') {
            if ((c.x - x) ** 2 + (c.z - z) ** 2 < (radius + c.R * 0.6) ** 2) out.push(c);
          } else if ((c.x - x) ** 2 + (c.z - z) ** 2 < radius * radius) out.push(c);
        }
      }
    }
    return out;
  }
}
