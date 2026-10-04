// First-person rifle (procedural bolt-action with scope), ghillie sleeves, bolt cycle
// animation, recoil, look sway and the player's own muzzle flash. Rendered in a separate
// scene on top of the world (depth cleared) so it never clips into trees.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { FX_TEX } from './effects.js';
import { RNG } from './noise.js';

function cyl(r0, r1, len, seg = 16) {
  const g = new THREE.CylinderGeometry(r0, r1, len, seg, 1);
  g.rotateX(Math.PI / 2); // along Z; r0 at the +Z (rear) end, r1 at the -Z (front) end
  return g;
}

export class Viewmodel {
  constructor(vmScene, vmCamera, textures, environment) {
    this.scene = vmScene;
    this.camera = vmCamera;
    vmScene.add(vmCamera);
    vmScene.environment = environment;
    vmScene.environmentIntensity = 0.7;
    this.sun = new THREE.DirectionalLight(0xffd7a8, 2.6);
    vmScene.add(this.sun);
    this.hemi = new THREE.HemisphereLight(0x9fb4c8, 0x2a2416, 0.5);
    vmScene.add(this.hemi);

    const metal = new THREE.MeshStandardMaterial({ color: 0x1c1d1b, metalness: 0.75, roughness: 0.42 });
    const metalDark = new THREE.MeshStandardMaterial({ color: 0x111211, metalness: 0.6, roughness: 0.5 });
    const stockMat = new THREE.MeshStandardMaterial({ color: 0x3d3c2a, roughness: 0.85, metalness: 0 });
    const lensMat = new THREE.MeshStandardMaterial({ color: 0x0b1420, metalness: 0.9, roughness: 0.08, emissive: 0x020406 });
    const gloveMat = new THREE.MeshStandardMaterial({ color: 0x2d2a1f, roughness: 0.9 });
    const stripMat = new THREE.MeshStandardMaterial({ map: textures.ghillie, alphaTest: 0.4, side: THREE.DoubleSide, vertexColors: true, roughness: 0.95 });

    const rifle = new THREE.Group();
    this.rifle = rifle;
    // stock: side profile extruded along X
    const sh = new THREE.Shape();
    sh.moveTo(0.30, -0.105);
    sh.lineTo(0.30, 0.03);
    sh.lineTo(0.12, 0.035);
    sh.lineTo(0.05, 0.012);
    sh.lineTo(0.0, 0.012);
    sh.lineTo(-0.44, 0.008);
    sh.lineTo(-0.44, -0.035);
    sh.lineTo(-0.05, -0.04);
    sh.lineTo(-0.02, -0.1);
    sh.lineTo(0.035, -0.1);
    sh.lineTo(0.06, -0.045);
    sh.lineTo(0.16, -0.05);
    sh.lineTo(0.30, -0.105);
    const stockGeo = new THREE.ExtrudeGeometry(sh, { depth: 0.042, bevelEnabled: true, bevelThickness: 0.007, bevelSize: 0.006, bevelSegments: 2 });
    stockGeo.translate(0, 0, -0.021);
    // shape is in XY; map shape-x -> rifle z, shape-y -> rifle y
    stockGeo.rotateY(-Math.PI / 2);
    const stock = new THREE.Mesh(stockGeo, stockMat);
    rifle.add(stock);
    const receiver = new THREE.Mesh(cyl(0.017, 0.017, 0.24), metal);
    receiver.position.set(0, 0.022, -0.08);
    rifle.add(receiver);
    const barrel = new THREE.Mesh(cyl(0.012, 0.0095, 0.6), metal);
    barrel.position.set(0, 0.022, -0.5);
    rifle.add(barrel);
    const muzzle = new THREE.Mesh(cyl(0.013, 0.013, 0.05), metalDark);
    muzzle.position.set(0, 0.022, -0.815);
    rifle.add(muzzle);
    this.muzzlePoint = new THREE.Vector3(0, 0.022, -0.86);
    // scope
    const scope = new THREE.Group();
    scope.position.set(0, 0.088, 0);
    const tube = new THREE.Mesh(cyl(0.0135, 0.0135, 0.25), metalDark);
    tube.position.z = -0.12;
    scope.add(tube);
    const obj = new THREE.Mesh(cyl(0.0135, 0.026, 0.06), metalDark);
    obj.position.z = -0.27;
    scope.add(obj);
    const objEnd = new THREE.Mesh(cyl(0.026, 0.026, 0.05), metalDark);
    objEnd.position.z = -0.325;
    scope.add(objEnd);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.023, 24), lensMat);
    lens.position.z = -0.351;
    lens.rotation.y = Math.PI;
    scope.add(lens);
    const ocu = new THREE.Mesh(cyl(0.021, 0.0135, 0.07), metalDark);
    ocu.position.z = 0.03;
    scope.add(ocu);
    const ocuLens = new THREE.Mesh(new THREE.CircleGeometry(0.018, 24), lensMat);
    ocuLens.position.z = 0.066;
    scope.add(ocuLens);
    const turretT = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.03, 12), metalDark);
    turretT.position.set(0, 0.02, -0.12);
    scope.add(turretT);
    const turretS = turretT.clone();
    turretS.rotation.z = Math.PI / 2;
    turretS.position.set(0.02, 0, -0.12);
    scope.add(turretS);
    for (const z of [-0.04, -0.17]) {
      const ring = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.06, 0.018), metal);
      ring.position.set(0, -0.035, z);
      scope.add(ring);
    }
    rifle.add(scope);
    // bolt (handle rotates about the bore axis, then slides back)
    const bolt = new THREE.Group();
    bolt.position.set(0, 0.022, 0.015);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 0.06, 8), metal);
    handle.rotation.z = Math.PI / 2;
    handle.position.set(0.035, -0.006, 0);
    bolt.add(handle);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.011, 12, 8), metal);
    knob.position.set(0.068, -0.012, 0);
    bolt.add(knob);
    const boltBody = new THREE.Mesh(cyl(0.012, 0.012, 0.06), metal);
    boltBody.position.z = 0.02;
    bolt.add(boltBody);
    this.bolt = bolt;
    rifle.add(bolt);
    // trigger guard
    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.003, 6, 12, Math.PI), metal);
    guard.rotation.y = Math.PI / 2;
    guard.rotation.x = Math.PI;
    guard.position.set(0, -0.035, -0.05);
    rifle.add(guard);

    // burlap strips wrapped on stock and forend
    const rng = new RNG(5);
    const strips = this._strips(rng, [
      { z0: 0.08, z1: 0.28, y: -0.03, n: 10 },
      { z0: -0.4, z1: -0.12, y: -0.02, n: 12 },
      { z0: -0.25, z1: -0.05, y: 0.11, n: 6 },
    ], 0.05, 0.11);
    rifle.add(new THREE.Mesh(strips, stripMat));

    // arms with ghillie sleeves
    const arms = new THREE.Group();
    const mkArm = (hand, elbow) => {
      const g = new THREE.Group();
      const dir = new THREE.Vector3().subVectors(elbow, hand);
      const len = dir.length();
      const fore = new THREE.Mesh(cyl(0.05, 0.034, len, 10), gloveMat);
      fore.position.copy(hand).addScaledVector(dir, 0.5);
      fore.lookAt(elbow);
      g.add(fore);
      const glove = new THREE.Mesh(new THREE.SphereGeometry(0.036, 12, 8), gloveMat);
      glove.scale.set(1, 0.85, 1.35);
      glove.position.copy(hand);
      g.add(glove);
      const sleeve = this._sleeve(rng, hand, elbow);
      g.add(new THREE.Mesh(sleeve, stripMat));
      return g;
    };
    arms.add(mkArm(new THREE.Vector3(0.0, -0.06, -0.02), new THREE.Vector3(0.17, -0.28, 0.28)));
    arms.add(mkArm(new THREE.Vector3(0.0, -0.045, -0.33), new THREE.Vector3(-0.17, -0.3, -0.02)));
    rifle.add(arms);

    // own muzzle flash
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: FX_TEX.flash, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
    this.flash.position.copy(this.muzzlePoint);
    this.flash.visible = false;
    rifle.add(this.flash);

    rifle.traverse((o) => { o.frustumCulled = false; });
    vmCamera.add(rifle);

    this.hip = new THREE.Vector3(0.17, -0.185, -0.43);
    this.ads = new THREE.Vector3(0, -0.088, -0.13);
    this.kick = 0;
    this.flashT = 0;
    this.shotTime = -10;
    this.swayX = 0; this.swayY = 0;
    this.lastYaw = 0; this.lastPitch = 0;
    this.shade = 1;
  }

  _strips(rng, zones, wMin, lMax) {
    const pos = [], uv = [], col = [], idx = [];
    const palette = [[0.32, 0.3, 0.2], [0.24, 0.27, 0.15], [0.38, 0.33, 0.22], [0.2, 0.22, 0.13]];
    for (const zn of zones) {
      for (let i = 0; i < zn.n; i++) {
        const z = rng.float(zn.z1, zn.z0);
        const side = rng.chance(0.5) ? 1 : -1;
        const x = side * rng.float(0.01, 0.03);
        const L = rng.float(0.05, lMax);
        const w = rng.float(0.02, wMin);
        const col0 = rng.int(0, 7);
        const c = palette[rng.int(0, palette.length - 1)];
        const b = pos.length / 3;
        const sway = rng.float(-0.03, 0.03);
        pos.push(x - w / 2 * side, zn.y, z, x + w / 2 * side, zn.y, z, x + side * 0.01 + sway - w / 2, zn.y - L, z + sway, x + side * 0.01 + sway + w / 2, zn.y - L, z + sway);
        const u0 = col0 / 8, u1 = (col0 + 1) / 8;
        uv.push(u0, 1, u1, 1, u0, 0, u1, 0);
        for (let k = 0; k < 4; k++) col.push(c[0], c[1], c[2]);
        idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  _sleeve(rng, a, b) {
    const pos = [], uv = [], col = [], idx = [];
    const palette = [[0.3, 0.3, 0.19], [0.22, 0.25, 0.14], [0.36, 0.32, 0.21], [0.18, 0.2, 0.12]];
    for (let i = 0; i < 26; i++) {
      const t = rng.float(0.1, 1.0);
      const p = new THREE.Vector3().lerpVectors(a, b, t);
      const ang = rng.float(0, Math.PI * 2);
      const r = 0.045;
      const off = new THREE.Vector3(Math.cos(ang) * r, Math.sin(ang) * r, 0);
      p.add(off);
      const L = rng.float(0.06, 0.13), w = rng.float(0.025, 0.05);
      const c = palette[rng.int(0, palette.length - 1)];
      const col0 = rng.int(0, 7);
      const base = pos.length / 3;
      const dx = rng.float(-0.02, 0.02);
      pos.push(p.x - w / 2, p.y, p.z, p.x + w / 2, p.y, p.z, p.x - w / 2 + dx, p.y - L, p.z + rng.float(-0.02, 0.02), p.x + w / 2 + dx, p.y - L, p.z);
      uv.push(col0 / 8, 1, (col0 + 1) / 8, 1, col0 / 8, 0, (col0 + 1) / 8, 0);
      for (let k = 0; k < 4; k++) col.push(c[0], c[1], c[2]);
      idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  onFire(time) {
    this.kick = 1;
    this.flashT = 0.055;
    this.shotTime = time;
    this.flash.material.rotation = Math.random() * Math.PI;
  }

  update(dt, time, player, sunDirView, inShade) {
    const scopeT = player.scopeT;
    // hide once the scope overlay takes over
    this.rifle.visible = scopeT < 0.62 && player.alive;
    const ads = THREE.MathUtils.smoothstep(scopeT, 0, 0.6);
    // look sway (rifle lags behind the view)
    const dyaw = player.yaw - this.lastYaw, dpitch = player.pitch - this.lastPitch;
    this.lastYaw = player.yaw; this.lastPitch = player.pitch;
    this.swayX = THREE.MathUtils.lerp(this.swayX, THREE.MathUtils.clamp(dyaw * 2.5, -0.05, 0.05), 1 - Math.exp(-dt * 10));
    this.swayY = THREE.MathUtils.lerp(this.swayY, THREE.MathUtils.clamp(-dpitch * 2.5, -0.05, 0.05), 1 - Math.exp(-dt * 10));
    this.kick = Math.max(0, this.kick - dt * 5);
    const k = this.kick * this.kick;
    const bob = Math.sin(player.bobPhase * 2) * 0.006 * (1 - ads) * Math.min(1, player.speed / 4);
    const bobX = Math.cos(player.bobPhase) * 0.008 * (1 - ads) * Math.min(1, player.speed / 4);
    const pos = new THREE.Vector3().lerpVectors(this.hip, this.ads, ads);
    pos.x += this.swayX * (1 - ads * 0.7) + bobX;
    pos.y += this.swayY * (1 - ads * 0.7) + bob - (player.stance === 'prone' ? 0.01 : 0);
    pos.z += k * 0.07;
    // sprint pose: rifle angled down
    const sprint = player.speed > CONFIG.player.walkSpeed + 0.5 && scopeT < 0.1 ? 1 : 0;
    this.sprintBlend = THREE.MathUtils.lerp(this.sprintBlend || 0, sprint, 1 - Math.exp(-dt * 8));
    this.rifle.position.copy(pos);
    // bolt cycle
    const ts = time - this.shotTime;
    const ph = (a, b) => THREE.MathUtils.clamp((ts - a) / (b - a), 0, 1);
    const up = ph(0.25, 0.4) - ph(0.85, 1.0);
    const back = ph(0.4, 0.62) - ph(0.62, 0.85);
    this.bolt.rotation.z = up * 1.3;
    this.bolt.position.z = 0.015 + back * 0.085;
    const cycling = ts < 1.05 ? Math.sin(Math.min(1, ts / 1.05) * Math.PI) : 0;
    this.rifle.rotation.set(k * 0.12 - this.sprintBlend * 0.5 + cycling * 0.05, -0.03 * (1 - ads) + this.sprintBlend * 0.5, 0.02 * (1 - ads) - cycling * 0.18);
    // own muzzle flash
    if (this.flashT > 0) {
      this.flashT -= dt;
      this.flash.visible = true;
      const s = 0.18 + Math.random() * 0.08;
      this.flash.scale.setScalar(s);
      const I = 40 * Math.max(0, this.flashT / 0.055);
      this.flash.material.color.setRGB(I, I * 0.85, I * 0.6);
    } else this.flash.visible = false;
    // lighting follows the world sun (dimmed in shade)
    this.shade = THREE.MathUtils.lerp(this.shade, inShade ? 0.15 : 1, 1 - Math.exp(-dt * 4));
    this.sun.position.copy(sunDirView);
    this.sun.intensity = 2.6 * this.shade;
  }
}
