// First-person rifle (procedural bolt-action with scope), ghillie sleeves, bolt cycle
// animation, recoil, look sway and the player's own muzzle flash. Rendered in a separate
// scene on top of the world (depth cleared) so it never clips into trees.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from './config.js';
import { FX_TEX } from './effects.js';
import { RNG } from './noise.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

function meshAt(geo, mat, x, y, z) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}

// Fine stipple/noise for roughness and bump (cerakote, rubber, gloves).
function stippleTexture() {
  const n = 128;
  const d = new Uint8Array(n * n * 4);
  let s = 12345;
  for (let i = 0; i < n * n; i++) {
    s = (s * 16807) % 2147483647;
    const v = 150 + ((s / 2147483647) * 105) | 0;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(d, n, n, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// A picatinny rail along -z: base and cross slots.
function railGeometry(len, w) {
  const parts = [new THREE.BoxGeometry(w * 0.7, 0.005, len)];
  const n = Math.floor(len / 0.01);
  for (let i = 0; i < n; i++) {
    const g = new THREE.BoxGeometry(w, 0.004, 0.0052);
    g.translate(0, 0.0045, -len / 2 + (i + 0.5) * (len / n));
    parts.push(g);
  }
  return mergeGeometries(parts);
}

// Heavy barrel with flutes: a star cross-section extruded along the bore.
function flutedBarrel(r0, r1, len, flutes) {
  const sh = new THREE.Shape();
  const N = flutes * 4;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const k = i % 4;
    const r = k === 1 || k === 2 ? r0 * 0.86 : r0;
    if (i === 0) sh.moveTo(Math.cos(a) * r, Math.sin(a) * r); else sh.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const g = new THREE.ExtrudeGeometry(sh, { depth: len * 0.6, bevelEnabled: false, steps: 1 });
  g.translate(0, 0, -len * 0.3);
  // plain taper toward the muzzle and a short chamber section
  const tip = new THREE.CylinderGeometry(r1, r0 * 0.93, len * 0.3, 20);
  tip.rotateX(Math.PI / 2);
  tip.translate(0, 0, -len * 0.45);
  const ch = new THREE.CylinderGeometry(r0, r0 * 1.12, len * 0.12, 20);
  ch.rotateX(-Math.PI / 2);
  ch.translate(0, 0, len * 0.36);
  const parts = [g.toNonIndexed(), tip.toNonIndexed(), ch.toNonIndexed()];
  for (const p of parts) { p.deleteAttribute('uv'); }
  const m = mergeGeometries(parts);
  m.computeVertexNormals();
  return m;
}

// A turret knob with knurled ridges.
function knurledKnob(r, h) {
  const parts = [new THREE.CylinderGeometry(r, r, h, 24)];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const g = new THREE.BoxGeometry(0.0016, h * 0.8, 0.0016);
    g.translate(Math.cos(a) * r, 0, Math.sin(a) * r);
    parts.push(g);
  }
  const cap = new THREE.CylinderGeometry(r * 0.55, r * 0.9, h * 0.25, 20);
  cap.translate(0, h * 0.6, 0);
  parts.push(cap);
  return mergeGeometries(parts.map((p) => { const q = p.toNonIndexed(); q.deleteAttribute('uv'); return q; }));
}

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

    // v5: a modern precision rifle in a chassis (it used to be a handful of plain cylinders).
    // Materials: cerakote (stippled), black anodised aluminium, blued steel, rubber and
    // coated glass; a small noise texture breaks up the roughness so it doesn't look plastic.
    const stipple = stippleTexture();
    const cerakote = new THREE.MeshStandardMaterial({ color: 0x6b6446, roughness: 0.62, metalness: 0.15, roughnessMap: stipple, bumpMap: stipple, bumpScale: 0.6 });
    const anod = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.38, metalness: 0.7, roughnessMap: stipple });
    const metal = new THREE.MeshStandardMaterial({ color: 0x232527, roughness: 0.32, metalness: 0.85, roughnessMap: stipple });
    const metalDark = new THREE.MeshStandardMaterial({ color: 0x101112, roughness: 0.45, metalness: 0.65, roughnessMap: stipple });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x141513, roughness: 0.92, metalness: 0, bumpMap: stipple, bumpScale: 1.2 });
    const lensMat = new THREE.MeshPhysicalMaterial({ color: 0x06101a, metalness: 0.2, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02, emissive: 0x03100c, emissiveIntensity: 0.6, sheen: 1, sheenColor: 0x2a6a50 });
    const gloveMat = new THREE.MeshStandardMaterial({ color: 0x2f2c21, roughness: 0.88, bumpMap: stipple, bumpScale: 1.5 });
    const stripMat = new THREE.MeshStandardMaterial({ map: textures.ghillie, alphaTest: 0.4, side: THREE.DoubleSide, vertexColors: true, roughness: 0.95 });

    const rifle = new THREE.Group();
    this.rifle = rifle;
    const add = (geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      rifle.add(m);
      return m;
    };
    const rbox = (w, h, d, r = 0.004, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2, h / 2, d / 2) * 0.999);
    const BORE = 0.022;
    // receiver and the long rail on top
    add(rbox(0.036, 0.042, 0.23, 0.008), anod, 0, BORE, -0.07);
    add(railGeometry(0.3, 0.021), anod, 0, BORE + 0.024, -0.1);
    // fluted heavy barrel
    const barrel = flutedBarrel(0.0118, 0.0098, 0.58, 8);
    add(barrel, metal, 0, BORE, -0.48);
    // muzzle brake with ports
    add(rbox(0.032, 0.03, 0.066, 0.006), metalDark, 0, BORE, -0.805);
    for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) add(new THREE.BoxGeometry(0.003, 0.016, 0.011), new THREE.MeshBasicMaterial({ color: 0x050505 }), sx * 0.0162, BORE, -0.785 - i * 0.018);
    this.muzzlePoint = new THREE.Vector3(0, BORE, -0.845);
    // chassis: handguard with M-LOK slots, magazine well, grip, skeleton stock
    add(rbox(0.054, 0.05, 0.42, 0.012, 3), cerakote, 0, BORE - 0.004, -0.28);
    for (const sx of [-1, 1]) for (let i = 0; i < 5; i++) add(rbox(0.004, 0.009, 0.034, 0.002), metalDark, sx * 0.0265, BORE - 0.006, -0.15 - i * 0.055);
    for (let i = 0; i < 4; i++) add(rbox(0.012, 0.004, 0.034, 0.002), metalDark, 0, BORE - 0.03, -0.18 - i * 0.06);
    add(rbox(0.048, 0.03, 0.2, 0.008), cerakote, 0, BORE - 0.03, -0.05);
    add(rbox(0.026, 0.07, 0.07, 0.006), anod, 0, BORE - 0.075, -0.06, 0.12);            // magazine
    add(rbox(0.028, 0.012, 0.075, 0.004), metalDark, 0, BORE - 0.11, -0.064, 0.12);     // its base plate
    const guard = add(new THREE.TorusGeometry(0.022, 0.0035, 8, 16, Math.PI), anod, 0, BORE - 0.05, 0.022);
    guard.rotation.set(Math.PI, Math.PI / 2, 0);
    add(rbox(0.006, 0.022, 0.006, 0.002), metal, 0, BORE - 0.05, 0.02, 0.35);           // trigger
    add(rbox(0.03, 0.095, 0.04, 0.012, 3), rubber, 0, BORE - 0.085, 0.068, -0.32);      // grip
    add(rbox(0.032, 0.03, 0.26, 0.01), cerakote, 0, BORE + 0.002, 0.17);                // stock top tube
    add(rbox(0.036, 0.03, 0.15, 0.012, 3), rubber, 0, BORE + 0.03, 0.19);               // cheek riser
    add(rbox(0.026, 0.024, 0.22, 0.008), cerakote, 0, BORE - 0.07, 0.19, -0.24);        // lower spine
    add(rbox(0.04, 0.15, 0.03, 0.012, 3), rubber, 0, BORE - 0.035, 0.305);              // butt pad
    add(rbox(0.02, 0.04, 0.03, 0.006), anod, 0, BORE - 0.105, 0.24);                    // monopod
    // folded bipod under the handguard
    add(rbox(0.04, 0.02, 0.03, 0.005), anod, 0, BORE - 0.04, -0.44);
    for (const sx of [-1, 1]) add(new THREE.CylinderGeometry(0.0045, 0.004, 0.2, 8), anod, sx * 0.012, BORE - 0.042, -0.34, Math.PI / 2);
    // scope: lathe profile (eyepiece, 30 mm tube, turret saddle, objective bell)
    const scope = new THREE.Group();
    scope.position.set(0, 0.088, 0);
    const prof = [
      [0.0, 0.07], [0.0205, 0.07], [0.022, 0.064], [0.0215, 0.035], [0.017, 0.022], [0.015, 0.012], [0.015, -0.12], [0.0152, -0.2], [0.02, -0.235],
      [0.0285, -0.27], [0.029, -0.33], [0.0275, -0.337], [0.0, -0.337],
    ];
    // (lathe points run front to rear so the faces point outward; the lathe's y becomes z)
    const scopeGeo = new THREE.LatheGeometry(prof.slice().reverse().map(([r, z]) => new THREE.Vector2(r, z)), 40);
    scopeGeo.rotateX(Math.PI / 2);
    scope.add(new THREE.Mesh(scopeGeo, anod));
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.0262, 40), lensMat);
    lens.position.z = -0.3375; lens.rotation.y = Math.PI;
    scope.add(lens);
    const ocuLens = new THREE.Mesh(new THREE.CircleGeometry(0.019, 32), lensMat);
    ocuLens.position.z = 0.0705;
    scope.add(ocuLens);
    scope.add(meshAt(rbox(0.04, 0.034, 0.05, 0.008), anod, 0, 0, -0.075));                // turret saddle
    scope.add(meshAt(knurledKnob(0.0125, 0.02), metalDark, 0, 0.026, -0.075));             // elevation
    const wind = meshAt(knurledKnob(0.011, 0.016), metalDark, 0.026, 0, -0.075);
    wind.rotation.z = -Math.PI / 2;
    scope.add(wind);
    const para = meshAt(knurledKnob(0.009, 0.012), metalDark, -0.024, 0, -0.075);
    para.rotation.z = Math.PI / 2;
    scope.add(para);
    scope.add(meshAt(new THREE.TorusGeometry(0.0205, 0.0025, 6, 32), metalDark, 0, 0, 0.03));   // power ring
    for (const z of [-0.025, -0.15]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0165, 0.004, 8, 24), anod);
      ring.position.set(0, 0, z);
      scope.add(ring);
      scope.add(meshAt(rbox(0.026, 0.03, 0.016, 0.004), anod, 0, -0.03, z));
    }
    rifle.add(scope);
    // bolt (handle rotates about the bore axis, then slides back)
    const bolt = new THREE.Group();
    bolt.position.set(0, BORE, 0.015);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.0055, 0.058, 10), metal);
    handle.rotation.z = Math.PI / 2;
    handle.position.set(0.034, -0.006, 0);
    bolt.add(handle);
    const knob = new THREE.Mesh(rbox(0.024, 0.02, 0.02, 0.009, 3), anod);   // tactical knob
    knob.position.set(0.068, -0.012, 0);
    bolt.add(knob);
    const boltBody = new THREE.Mesh(new THREE.CylinderGeometry(0.0115, 0.0115, 0.062, 16), metal);
    boltBody.rotation.x = Math.PI / 2;
    boltBody.position.z = 0.02;
    bolt.add(boltBody);
    this.bolt = bolt;
    rifle.add(bolt);

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
    // inShade: sunlight reaching the player, 0 (shade) .. 1 (open sun)
    const sun = typeof inShade === 'number' ? inShade : inShade ? 0 : 1;
    this.shade = THREE.MathUtils.lerp(this.shade, 0.15 + 0.85 * sun, 1 - Math.exp(-dt * 4));
    this.sun.position.copy(sunDirView);
    this.sun.intensity = 2.6 * this.shade;
  }
}
