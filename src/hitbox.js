// Body-sized hitboxes (capsules) derived from stance + facing. The procedural ghillie
// poses are built to match these, so the shaggy suit volume never counts as a hit.
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

export class Hitbox {
  constructor() {
    // capsules: { a, b, r, part }
    this.caps = [];
    for (let i = 0; i < 5; i++) this.caps.push({ a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0.1, part: '' });
    this.count = 0;
    this.bounds = new THREE.Sphere();
  }

  _set(i, part, ax, ay, az, bx, by, bz, r) {
    const c = this.caps[i];
    c.part = part; c.r = r;
    c.a.set(ax, ay, az); c.b.set(bx, by, bz);
  }

  // Update from combatant stance, feet position, body yaw and eye height.
  update(cb) {
    const p = cb.pos;
    const yaw = cb.bodyYaw !== undefined ? cb.bodyYaw : cb.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);     // forward
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);      // right
    const e = cb.eye;
    if (cb.stance === 'prone') {
      // head at the front (eye), body stretched backwards along the ground
      const hx = p.x, hz = p.z, hy = p.y + e - 0.05;
      this._set(0, 'head', hx, hy, hz, hx, hy, hz, 0.13);
      this._set(1, 'torso', hx - fx * 0.25, p.y + 0.2, hz - fz * 0.25, hx - fx * 0.85, p.y + 0.18, hz - fz * 0.85, 0.19);
      this._set(2, 'legs', hx - fx * 0.95 + rx * 0.1, p.y + 0.12, hz - fz * 0.95 + rz * 0.1, hx - fx * 1.75 + rx * 0.18, p.y + 0.1, hz - fz * 1.75 + rz * 0.18, 0.1);
      this._set(3, 'legs', hx - fx * 0.95 - rx * 0.1, p.y + 0.12, hz - fz * 0.95 - rz * 0.1, hx - fx * 1.75 - rx * 0.18, p.y + 0.1, hz - fz * 1.75 - rz * 0.18, 0.1);
      this._set(4, 'arms', hx + fx * 0.15 + rx * 0.2, p.y + 0.18, hz + fz * 0.15 + rz * 0.2, hx - fx * 0.2 + rx * 0.25, p.y + 0.18, hz - fz * 0.2 + rz * 0.25, 0.07);
      this.count = 5;
    } else if (cb.stance === 'crouch') {
      const hy = p.y + e - 0.04;
      this._set(0, 'head', p.x + fx * 0.08, hy, p.z + fz * 0.08, p.x + fx * 0.08, hy, p.z + fz * 0.08, 0.13);
      this._set(1, 'torso', p.x - fx * 0.05, p.y + 0.55, p.z - fz * 0.05, p.x + fx * 0.04, p.y + e - 0.25, p.z + fz * 0.04, 0.2);
      this._set(2, 'legs', p.x + rx * 0.12, p.y + 0.1, p.z + rz * 0.12, p.x + rx * 0.12 + fx * 0.25, p.y + 0.5, p.z + rz * 0.12 + fz * 0.25, 0.11);
      this._set(3, 'legs', p.x - rx * 0.12 - fx * 0.2, p.y + 0.12, p.z - rz * 0.12 - fz * 0.2, p.x - rx * 0.12 + fx * 0.1, p.y + 0.45, p.z - rz * 0.12 + fz * 0.1, 0.11);
      this._set(4, 'arms', p.x + rx * 0.22 + fx * 0.15, p.y + e - 0.3, p.z + rz * 0.22 + fz * 0.15, p.x + rx * 0.1 + fx * 0.45, p.y + e - 0.22, p.z + rz * 0.1 + fz * 0.45, 0.07);
      this.count = 5;
    } else {
      const hy = p.y + e - 0.03;
      this._set(0, 'head', p.x, hy, p.z, p.x, hy, p.z, 0.13);
      this._set(1, 'torso', p.x, p.y + 0.95, p.z, p.x, p.y + e - 0.3, p.z, 0.21);
      this._set(2, 'legs', p.x + rx * 0.11, p.y + 0.1, p.z + rz * 0.11, p.x + rx * 0.1, p.y + 0.9, p.z + rz * 0.1, 0.1);
      this._set(3, 'legs', p.x - rx * 0.11, p.y + 0.1, p.z - rz * 0.11, p.x - rx * 0.1, p.y + 0.9, p.z - rz * 0.1, 0.1);
      this._set(4, 'arms', p.x + rx * 0.24, p.y + e - 0.25, p.z + rz * 0.24, p.x + rx * 0.12 + fx * 0.4, p.y + e - 0.2, p.z + rz * 0.12 + fz * 0.4, 0.07);
      this.count = 5;
    }
    this.bounds.center.set(p.x, p.y + 0.8, p.z);
    this.bounds.radius = 2.2;
  }

  // Ray (origin o, unit dir d) vs capsules. Returns { t, part } or null.
  raycast(o, d, maxDist) {
    // quick reject on bounding sphere
    const oc = _v.subVectors(o, this.bounds.center);
    const b = oc.dot(d);
    const c = oc.lengthSq() - this.bounds.radius * this.bounds.radius;
    if (c > 0 && b > 0) return null;
    if (b * b - c < 0) return null;
    let best = Infinity, part = null;
    for (let i = 0; i < this.count; i++) {
      const cap = this.caps[i];
      const t = rayCapsule(o, d, cap.a, cap.b, cap.r);
      if (t >= 0 && t < best && t <= maxDist) { best = t; part = cap.part; }
    }
    return part ? { t: best, part } : null;
  }

  // Closest distance from a ray segment to the capsules (for near-miss detection).
  centerDistanceToRay(o, d, maxDist) {
    const c = this.caps[0].a;
    const t = Math.max(0, Math.min(maxDist, _v.subVectors(c, o).dot(d)));
    return _v2.copy(o).addScaledVector(d, t).distanceTo(c);
  }
}

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _ba = new THREE.Vector3(), _oa = new THREE.Vector3();

// Ray-capsule intersection (after Inigo Quilez). Returns entry t or -1.
function rayCapsule(ro, rd, pa, pb, r) {
  _ba.subVectors(pb, pa);
  _oa.subVectors(ro, pa);
  const baba = _ba.dot(_ba);
  if (baba < 1e-8) return raySphere(ro, rd, pa, r);
  const bard = _ba.dot(rd);
  const baoa = _ba.dot(_oa);
  const rdoa = rd.dot(_oa);
  const oaoa = _oa.dot(_oa);
  const a = baba - bard * bard;
  const b = baba * rdoa - baoa * bard;
  const c = baba * oaoa - baoa * baoa - r * r * baba;
  const h = b * b - a * c;
  if (h < 0) return -1;
  if (a > 1e-9) {
    const t = (-b - Math.sqrt(h)) / a;
    const y = baoa + t * bard;
    if (y > 0 && y < baba) return t;
    return raySphere(ro, rd, y <= 0 ? pa : pb, r);
  }
  // ray parallel to the axis: hit the nearer cap
  const ta = raySphere(ro, rd, pa, r), tb = raySphere(ro, rd, pb, r);
  if (ta < 0) return tb;
  if (tb < 0) return ta;
  return Math.min(ta, tb);
}

function raySphere(ro, rd, c, r) {
  const ox = ro.x - c.x, oy = ro.y - c.y, oz = ro.z - c.z;
  const b = ox * rd.x + oy * rd.y + oz * rd.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const h = b * b - cc;
  if (h < 0) return -1;
  const t = -b - Math.sqrt(h);
  return t >= 0 ? t : (cc < 0 ? 0 : -1);
}

export { rayCapsule, UP };
