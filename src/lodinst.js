// Instances with a near and a far model (v5.2, for the Megascans pieces): every frame each
// instance that is in view goes to the near or the far InstancedMesh by its distance from the
// camera, scaled by the zoom (through a 12x scope a log 300 m away is as big as one 25 m away);
// it is left out beyond `maxDist` or outside the view. Culling each instance matters through
// the scope: a 3° view sees a sliver of the valley, but every rock would be drawn near.
import * as THREE from 'three';

const _m = new THREE.Matrix4(), _s = new THREE.Sphere();

export class LodInstances {
  // near/far: { geo, mat }; mats: flat array of 4x4 matrices (16 numbers each)
  constructor(parent, near, far, mats, { nearDist = 70, maxDist = Infinity, shadows = true, farShadows = true } = {}) {
    this.n = mats.length / 16;
    this.mats = Float32Array.from(mats);
    this.nearDist = nearDist;
    this.maxDist = maxDist;
    // bounding radius of each instance (the model's, times its scale); a margin keeps shadows
    // of pieces just outside the view
    near.geo.computeBoundingSphere();
    const r0 = near.geo.boundingSphere.radius, c0 = near.geo.boundingSphere.center;
    this.rad = new Float32Array(this.n);
    this.cen = new Float32Array(this.n * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < this.n; i++) {
      _m.fromArray(this.mats, i * 16);
      const sc = Math.hypot(this.mats[i * 16], this.mats[i * 16 + 1], this.mats[i * 16 + 2]);
      this.rad[i] = r0 * sc + 6;   // + a margin: low-sun shadows of pieces just outside the view
      v.copy(c0).applyMatrix4(_m);
      this.cen[i * 3] = v.x; this.cen[i * 3 + 1] = v.y; this.cen[i * 3 + 2] = v.z;
    }
    const make = (part, cast) => {
      const m = new THREE.InstancedMesh(part.geo, part.mat, Math.max(1, this.n));
      m.count = 0;
      m.castShadow = cast;
      m.receiveShadow = true;
      m.frustumCulled = false;   // culled per instance here
      parent.add(m);
      return m;
    };
    this.near = make(near, shadows);
    this.far = far ? make(far, shadows && farShadows) : null;
  }

  // k: distance scale for the zoom (fov / normal fov); frustum: the camera's (or null: no culling)
  update(camera, k = 1, frustum = null) {
    const p = camera.position;
    const M = this.mats, C = this.cen, nd2 = (this.nearDist / k) ** 2, md2 = (this.maxDist / k) ** 2;
    let a = 0, b = 0;
    for (let i = 0; i < this.n; i++) {
      const dx = C[i * 3] - p.x, dy = C[i * 3 + 1] - p.y, dz = C[i * 3 + 2] - p.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > md2) continue;
      if (frustum) {
        _s.center.set(C[i * 3], C[i * 3 + 1], C[i * 3 + 2]);
        _s.radius = this.rad[i];
        if (!frustum.intersectsSphere(_s)) continue;
      }
      _m.fromArray(M, i * 16);
      if (d2 < nd2 || !this.far) this.near.setMatrixAt(a++, _m);
      else this.far.setMatrixAt(b++, _m);
    }
    this.near.count = a;
    this.near.instanceMatrix.needsUpdate = true;
    if (this.far) { this.far.count = b; this.far.instanceMatrix.needsUpdate = true; }
  }
}
