// The sculpted sniper: a figure built once from signed-distance shapes (sculpt.js) in an A-pose
// and skinned to the game's own skeleton, so it takes the same poses as every other character.
// Two looks:
//   - 'stylized' (Ravine), in the spirit of Fortnite / Apex / Overwatch: a uniform in woodland
//     camo, a face with camo paint and eyes, a neck gaiter, a ghillie hood with shooting goggles
//     pushed up onto it, fingerless gloves, chunky boots, knee pads, a plate carrier with
//     pouches, a belt and a drop-leg pouch, and a mantle and cape of layered, folded leaves and
//     jute strands (sniperFoliage)
//   - 'real' (Beech River): the same figure under a full, realistic ghillie suit of jute,
//     burlap and leaves (ghilliestrands.js); no goggles or gear, a muted palette
// Each piece is meshed finely, then simplified (meshoptimizer) to two levels of detail; the
// ambient occlusion is baked into the vertex colours. Everything here is plain arrays (no
// three.js), so it can run in a worker (sniperworker.js); sniperparts.js turns the result into
// geometry and has the materials.
import { MeshoptSimplifier } from 'meshopt-simplifier';
import {
  SdfObject, meshObject, sdfAO, normalAt, roundCone, ellipsoid, roundBox, torus, custom, shell,
  smax, eulerRot, mul3, IDENT,
} from './sculpt.js';
import { RNG } from './noise.js';
import { realGhillieStrands, hangingJute, ATLAS } from './ghilliestrands.js';

// the body's uv where the ghillie has an atlas: an opaque texel, so the strands' shadow
// material (which cuts by the atlas' alpha) keeps the body whole
const SOLID_UV = [ATLAS.solid[0] / ATLAS.size, 1 - ATLAS.solid[1] / ATLAS.size];

// The simplifier is WebAssembly: wait for this before building.
export const sniperReady = MeshoptSimplifier.ready;

// The bind pose: arms out and down at ~45°, feet a little apart, so no two limbs touch while
// the shapes are blended. The game's poses replace these rotations every frame.
export const BIND_POSE = {
  upperArmR: [0, 0, 0.8], upperArmL: [0, 0, -0.8],
  thighR: [0, 0, 0.1], thighL: [0, 0, -0.1],
};

const lin = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => ((v / 255 + 0.055) / 1.055) ** 2.4);

// palettes (sRGB in the source, linear here): the stylized look (Ravine) and the realistic one
// (Beech River: muted skin and paint, suede boots, olive-tan gloves, dark netting)
const STYLIZED = {
  skin: lin(0xc68a64), paintG: lin(0x55642f), paintD: lin(0x2c2d22), paintB: lin(0x6e5434),
  sclera: lin(0xe6dfd2), iris: lin(0x5a4129), pupil: lin(0x140f0b),
  gear: lin(0x8c7754), gearDk: lin(0x6e5c40), web: lin(0x5c4d36),
  boot: lin(0x4b3624), bootDk: lin(0x3a2a1c), sole: lin(0x262320), lace: lin(0x2c271f),
  glove: lin(0x40422f), gloveDk: lin(0x2b2c23),
  hood: lin(0x4b5631), gaiter: lin(0x7c7552),
  frame: lin(0x2c2e2b), strap: lin(0x434634), lensTop: lin(0x5a2a10), lensBot: lin(0xf0a43c),
  metal: lin(0x4a4a44), pad: lin(0x3b3c33), radio: lin(0x3a3d32),
  white: [1, 1, 1],
};
const REAL = {
  ...STYLIZED,
  skin: lin(0xb07a5a), paintG: lin(0x474f2e), paintD: lin(0x22231b), paintB: lin(0x5b4830),
  sclera: lin(0xd6cec1), iris: lin(0x4a3622), pupil: lin(0x0f0c09),
  boot: lin(0x5c4a36), bootDk: lin(0x463626), sole: lin(0x2a2724), lace: lin(0x3a3226),
  glove: lin(0x6b6247), gloveDk: lin(0x4a4434),
  hood: lin(0x3b3826), gaiter: lin(0x5c5a40), metal: lin(0x3a3a36),
};
const PALETTES = { stylized: STYLIZED, real: REAL };
// the palette of the look being built (set by buildSniperPieces; the builds run one at a time)
let C = STYLIZED;
const M = (color, rough = 0.88, camo = 0, gear = 0) => ({ color, rough, camo, gear });
// the vest, pouches and belts: a shade here, the colour per sniper (sniperparts.js, uGear)
const GEARC = (shade, rough = 0.9) => M([shade, shade, shade], rough, 0, 1);
const UNI = M(C.white, 0.92, 1);
const TORSO = new Set(['hips', 'spine', 'chest']);

// ---------------------------------------------------------------- frames
function bindFrames(BONES) {
  const F = {};
  for (const [name, parent, x, y, z] of BONES) {
    const e = BIND_POSE[name] || [0, 0, 0];
    const Rl = eulerRot(e[0], e[1], e[2]);
    if (!parent) { F[name] = { R: Rl, t: [x, y, z] }; continue; }
    const P = F[parent];
    F[name] = {
      R: mul3(P.R, Rl),
      t: [P.t[0] + P.R[0] * x + P.R[1] * y + P.R[2] * z, P.t[1] + P.R[3] * x + P.R[4] * y + P.R[5] * z, P.t[2] + P.R[6] * x + P.R[7] * y + P.R[8] * z],
    };
  }
  return F;
}

// sphere tracing along a ray: the distance t to the surface of f, or tMax
function trace(f, ox, oy, oz, dx, dy, dz, tMax = 0.5) {
  let t = 0;
  for (let i = 0; i < 96 && t < tMax; i++) {
    const d = f(ox + dx * t, oy + dy * t, oz + dz * t);
    if (Math.abs(d) < 1e-4) return t;
    t += Math.max(d * 0.8, 5e-4);
  }
  return t;
}

function smooth(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// distance to a box with rounded edges, in its own (axis-aligned) frame
function boxDist(qx, qy, qz, bx, by, bz, r) {
  const ax = Math.abs(qx) - bx + r, ay = Math.abs(qy) - by + r, az = Math.abs(qz) - bz + r;
  const mx = ax > 0 ? ax : 0, my = ay > 0 ? ay : 0, mz = az > 0 ? az : 0;
  return Math.sqrt(mx * mx + my * my + mz * mz) + Math.min(Math.max(ax, ay, az), 0) - r;
}

// ---------------------------------------------------------------- the figure
function defineSniper(F, look = 'stylized') {
  const real = look === 'real';
  const P = (b, x, y, z) => {
    const f = F[b], R = f.R;
    return [R[0] * x + R[1] * y + R[2] * z + f.t[0], R[3] * x + R[4] * y + R[5] * z + f.t[1], R[6] * x + R[7] * y + R[8] * z + f.t[2]];
  };
  const Rb = (b, R = IDENT) => mul3(F[b].R, R);
  const objects = [];
  const SIDES = [[1, 'R'], [-1, 'L']];

  // ---- body: the uniform (torso, arms, legs, neck); every shape carries its bone
  const body = new SdfObject('body', { h: 0.015 });
  body.errK = 2.2;
  body.add(ellipsoid(P('hips', 0, 0.02, 0.01), IDENT, 0.158, 0.12, 0.118), UNI, { bone: 'hips' });
  for (const [s] of SIDES) body.add(ellipsoid(P('hips', s * 0.07, -0.045, 0.04), IDENT, 0.082, 0.09, 0.08), UNI, { k: 0.05, bone: 'hips' });
  body.add(ellipsoid(P('spine', 0, 0.11, 0), IDENT, 0.146, 0.13, 0.108), UNI, { k: 0.06, bone: 'spine' });
  body.add(ellipsoid(P('chest', 0, 0.1, -0.005), IDENT, 0.184, 0.16, 0.124), UNI, { k: 0.06, bone: 'chest' });
  body.add(ellipsoid(P('chest', 0, 0.18, 0.025), IDENT, 0.155, 0.07, 0.098), UNI, { k: 0.05, bone: 'chest' });
  body.add(roundCone(P('neck', 0, -0.03, 0.012), P('neck', 0, 0.07, 0.002), 0.058, 0.052), UNI, { k: 0.04, bone: 'neck' });
  for (const [s, S] of SIDES) {
    const ua = 'upperArm' + S, fa = 'foreArm' + S, th = 'thigh' + S, sh = 'shin' + S;
    body.add(ellipsoid(P(ua, 0, -0.04, 0), Rb(ua), 0.071, 0.092, 0.071), UNI, { k: 0.05, bone: ua });
    body.add(roundCone(P(ua, 0, -0.05, 0), P(ua, 0, -0.275, 0), 0.06, 0.05), UNI, { k: 0.03, bone: ua });
    body.add(roundCone(P(fa, 0, -0.005, 0), P(fa, 0, -0.235, 0), 0.05, 0.041), UNI, { k: 0.025, bone: fa });
    body.add(roundCone(P(th, 0, -0.01, 0), P(th, 0, -0.41, 0), 0.083, 0.061), UNI, { k: 0.03, bone: th });
    body.add(ellipsoid(P(th, s * 0.006, -0.17, -0.012), Rb(th), 0.078, 0.17, 0.076), UNI, { k: 0.04, bone: th });
    body.add(roundCone(P(sh, 0, 0, 0), P(sh, 0, -0.37, 0), 0.059, 0.05), UNI, { k: 0.03, bone: sh });
    body.add(ellipsoid(P(sh, 0, -0.12, 0.018), Rb(sh), 0.054, 0.1, 0.057), UNI, { k: 0.04, bone: sh });
    // the trousers bloused over the boot tops
    body.add(torus(P(sh, 0, -0.245, 0.003), Rb(sh), 0.054, 0.014), UNI, { k: 0.02, bone: sh });
  }
  // a cargo pocket with a flap on the left thigh
  body.add(roundBox(P('thighL', -0.08, -0.21, 0.004), Rb('thighL'), 0.016, 0.068, 0.054, 0.014), UNI, { k: 0.008, bone: 'thighL' });
  body.add(roundBox(P('thighL', -0.088, -0.142, 0.004), Rb('thighL'), 0.01, 0.013, 0.058, 0.008), UNI, { k: 0.004, bone: 'thighL' });
  objects.push(body);

  // the bones' shapes, for the skin weights of the other pieces (the head from the skull below)
  const proxies = body.ops.filter((o) => !o.sub).map((o) => ({ bone: o.bone, prim: o.prim }));

  // ---- the face: skull front, brow, cheekbones, jaw, nose, eye sockets and lids (the back
  // and the top of the head are inside the hood and left out)
  const face = new SdfObject('face', { h: 0.0048, bone: 'head' });
  face.errK = 0.5;
  face.aoK = real ? 0.85 : 0.5;   // (the realistic face sits in the hood's shadow)
  // (aCamo 2: the shader paints skin and camo paint, crisp at any mesh density)
  const SKIN = M(C.white, 0.62, 2);
  const H = (x, y, z) => P('head', x, y, z);
  const hd = F.head.t;
  const skull = ellipsoid(H(0, 0.035, 0.012), IDENT, 0.078, 0.094, 0.092);
  proxies.push({ bone: 'head', prim: skull });
  face.add(skull, SKIN);
  face.add(ellipsoid(H(0, 0.04, -0.066), IDENT, 0.066, 0.017, 0.022), SKIN, { k: 0.025 });
  for (const [s] of SIDES) face.add(ellipsoid(H(s * 0.042, 0.0, -0.054), IDENT, 0.026, 0.02, 0.025), SKIN, { k: 0.02 });
  face.add(ellipsoid(H(0, -0.035, -0.035), IDENT, 0.056, 0.05, 0.058), SKIN, { k: 0.03 });
  face.add(ellipsoid(H(0, -0.068, -0.058), IDENT, 0.03, 0.022, 0.022), SKIN, { k: 0.02 });
  face.add(roundCone(H(0, 0.03, -0.079), H(0, -0.001, -0.097), 0.0085, 0.0125), SKIN, { k: 0.008 });
  face.add(ellipsoid(H(0, -0.006, -0.096), IDENT, 0.014, 0.011, 0.012), SKIN, { k: 0.006 });
  for (const [s] of SIDES) face.add(ellipsoid(H(s * 0.012, -0.011, -0.088), IDENT, 0.01, 0.008, 0.008), SKIN, { k: 0.006 });
  for (const [s] of SIDES) face.sub(ellipsoid(H(s * 0.032, 0.018, -0.082), IDENT, 0.021, 0.0125, 0.016), { k: 0.01 });
  for (const [s] of SIDES) face.add(ellipsoid(H(s * 0.032, 0.0265, -0.068), IDENT, 0.019, 0.0068, 0.013), SKIN, { k: 0.004 });
  for (const [s] of SIDES) face.add(ellipsoid(H(s * 0.032, 0.0068, -0.068), IDENT, 0.017, 0.0045, 0.011), SKIN, { k: 0.004 });
  face.sub(custom((x, y, z) => hd[2] + 0.03 - z, [-1, 0, hd[2] + 0.03], [1, 3, 1]));
  face.sub(custom((x, y, z) => hd[1] + 0.1 - y, [-1, hd[1] + 0.1, -1], [1, 3, 1]));
  objects.push(face);

  // ---- the hood: round the head with a soft peak, draping down the neck, open at the face
  const hood = new SdfObject('hood', { h: 0.009 });
  hood.errK = 1.5;
  const HOOD = M(C.hood, 0.95);
  hood.add(ellipsoid(H(0, 0.04, 0.02), IDENT, 0.106, 0.118, 0.116), HOOD);
  hood.add(ellipsoid(H(0, 0.13, 0.045), IDENT, 0.05, 0.045, 0.065), HOOD, { k: 0.05 });
  hood.add(roundCone(H(0, -0.01, 0.05), P('neck', 0, -0.06, 0.05), 0.095, 0.12), HOOD, { k: 0.05 });
  hood.sub(ellipsoid(H(0, 0.012, -0.112), IDENT, 0.074, 0.09, 0.08), { k: 0.012 });
  objects.push(hood);

  // ---- neck gaiter: over the mouth and jaw (up to just under the nose) and round the neck
  const gaiter = new SdfObject('gaiter', { h: 0.0055 });
  const GAIT = M(C.gaiter, 0.95);
  const lower = new SdfObject('lowerFace');
  for (const o of face.ops) if (!o.sub && o.prim.max[1] < hd[1] + 0.03) lower.add(o.prim, o.mat, { k: o.k });
  lower.add(skull, SKIN);
  gaiter.add(custom((x, y, z) => {
    const lx = x - hd[0], ly = y - hd[1];
    const cut = -0.024 + 0.019 * smooth(0.012, 0.05, Math.abs(lx));
    return smax(lower.dist(x, y, z) - 0.0052, ly - cut, 0.004);
  }, [hd[0] - 0.1, hd[1] - 0.12, hd[2] - 0.12], [hd[0] + 0.1, hd[1] + 0.01, hd[2] + 0.05]), GAIT);
  gaiter.add(roundCone(P('neck', 0, -0.05, 0.01), H(0, -0.06, -0.004), 0.064, 0.061), GAIT, { k: 0.03 });
  gaiter.paint((x, y, z, c) => {
    const k = 0.93 + 0.07 * Math.sin((y - hd[1]) * 260 + Math.atan2(x - hd[0], z - hd[2]) * 2);
    c[0] *= k; c[1] *= k; c[2] *= k;
  });
  objects.push(gaiter);

  if (!real) {
    // ---- goggles pushed up onto the hood, their strap round it
    const gog = new SdfObject('goggles', { h: 0.0042, bone: 'head' });
    gog.errK = 0.9;
    const tilt = eulerRot(-0.42, 0, 0);
    const gy = 0.104, gz = -0.094;
    gog.add(roundBox(H(0, gy, gz), tilt, 0.071, 0.024, 0.014, 0.013), M(C.frame, 0.5));
    gog.sub(ellipsoid(H(0, gy - 0.026, gz - 0.004), tilt, 0.016, 0.016, 0.03), { k: 0.006 });
    for (const [s] of SIDES) gog.add(ellipsoid(H(s * 0.034, gy + 0.0015, gz - 0.0095), tilt, 0.031, 0.02, 0.009), M(C.lensBot, 0.12), { k: 0.002 });
    {
      const c = H(0, 0.1, 0.02), n = [0, Math.cos(-0.42), Math.sin(-0.42)];
      const band = (x, y, z) => Math.abs((x - c[0]) * n[0] + (y - c[1]) * n[1] + (z - c[2]) * n[2]) - 0.0075;
      gog.add(shell((x, y, z) => hood.dist(x, y, z), -0.003, 0.0035, band, [c[0] - 0.13, c[1] - 0.08, c[2] - 0.14], [c[0] + 0.13, c[1] + 0.09, c[2] + 0.14], 0.003), M(C.strap, 0.9), { k: 0.003 });
    }
    gog.paint((x, y, z, c) => {
      // lenses: dark amber at the top to bright orange at the bottom, with a light streak
      if (c[4] > 0.3) return;
      const ly = y - hd[1] - gy;
      const t = smooth(0.016, -0.014, ly);
      for (let i = 0; i < 3; i++) c[i] = C.lensTop[i] + (C.lensBot[i] - C.lensTop[i]) * t;
      const streak = smooth(0.004, 0.0, Math.abs(ly - 0.006 + (x - hd[0]) * 0.25)) * 0.6;
      for (let i = 0; i < 3; i++) c[i] += (1 - c[i]) * streak;
    });
    objects.push(gog);
  }

  // the torso alone (no arms or legs): the vest, belt and mantle follow its surface
  const torso = new SdfObject('torso');
  for (const o of body.ops) if (!o.sub && TORSO.has(o.bone)) torso.add(o.prim, o.mat, { k: o.k });
  torso.pad = 2;
  let tx = NaN, ty = NaN, tz = NaN, tv = 0;
  const tD = (x, y, z) => {
    if (x !== tx || y !== ty || z !== tz) { tx = x; ty = y; tz = z; tv = torso.dist(x, y, z); }
    return tv;
  };
  const frontZ = (x, y, off) => -0.4 + trace((a, b, c) => tD(a, b, c) - off, x, y, -0.4, 0, 0, 1, 0.6);

  if (!real) {
    // ---- plate carrier: front and back panels, cummerbund, shoulder straps, pouches
    const vest = new SdfObject('vest', { h: 0.0085 });
    vest.errK = 1.5;
    const GEAR = GEARC(1), GEARDK = GEARC(0.8), WEB = GEARC(0.66, 0.92);
    const box = (cx, cy, cz, bx, by, bz) => (x, y, z) => Math.max(Math.abs(x - cx) - bx, Math.abs(y - cy) - by, Math.abs(z - cz) - bz);
    vest.add(shell(tD, 0.003, 0.025, box(0, 1.275, -0.3, 0.142, 0.16, 0.27), [-0.22, 1.08, -0.3], [0.22, 1.47, 0], 0.008), GEAR);
    vest.add(shell(tD, 0.003, 0.022, box(0, 1.29, 0.3, 0.145, 0.15, 0.26), [-0.22, 1.1, 0], [0.22, 1.47, 0.3], 0.008), GEAR);
    vest.add(shell(tD, 0.002, 0.018, (x, y, z) => Math.abs(y - 1.14) - 0.05, [-0.24, 1.07, -0.24], [0.24, 1.21, 0.24], 0.006), GEARDK, { k: 0.004 });
    for (const [s] of SIDES) {
      vest.add(shell(tD, 0.002, 0.016, (x, y, z) => Math.max(Math.abs(x - s * 0.1) - 0.027, 1.37 - y), [s * 0.1 - 0.05, 1.35, -0.2], [s * 0.1 + 0.05, 1.6, 0.2], 0.005), WEB, { k: 0.004 });
    }
    // three magazine pouches with flaps, an admin pouch above them
    for (const x of [-0.07, 0, 0.07]) {
      const z0 = frontZ(x, 1.19, 0.025);
      vest.add(roundBox([x, 1.19, z0 - 0.018], IDENT, 0.032, 0.052, 0.023, 0.009), GEAR, { k: 0.004 });
      vest.add(roundBox([x, 1.238, z0 - 0.021], eulerRot(0.12, 0, 0), 0.034, 0.012, 0.026, 0.006), GEARDK, { k: 0.002 });
      vest.add(roundBox([x, 1.219, z0 - 0.048], IDENT, 0.007, 0.009, 0.003, 0.002), WEB, { k: 0.002 });
    }
    {
      const z0 = frontZ(0, 1.35, 0.025);
      vest.add(roundBox([0, 1.35, z0 - 0.013], IDENT, 0.056, 0.033, 0.016, 0.009), GEARDK, { k: 0.004 });
    }
    // a radio on the left side at the back (its antenna is a strand, with the leaves)
    vest.add(roundBox([-0.165, 1.31, 0.075], eulerRot(0, -0.5, 0), 0.03, 0.058, 0.028, 0.01), M(C.radio, 0.7), { k: 0.004 });
    // MOLLE webbing: darker bands across the panels
    vest.paint((x, y, z, c) => {
      if (Math.abs(tD(x, y, z) - 0.025) > 0.0025 || Math.abs(z) < 0.05) return;
      const f = ((y - 1.09) / 0.026) % 1;
      const k = f < 0.3 ? 0.8 : 1;
      c[0] *= k; c[1] *= k; c[2] *= k;
    });
    objects.push(vest);

    // ---- belt with a buckle and hip pouches; a drop-leg pouch on the right thigh
    const belt = new SdfObject('belt', { h: 0.0075 });
    belt.errK = 1.3;
    belt.add(shell(tD, 0.001, 0.013, (x, y, z) => Math.abs(y - 1.0) - 0.023, [-0.24, 0.96, -0.2], [0.24, 1.04, 0.2], 0.004), WEB);
    {
      const z0 = frontZ(0, 1.0, 0.013);
      belt.add(roundBox([0, 1.0, z0 - 0.004], IDENT, 0.026, 0.019, 0.006, 0.004), M(C.metal, 0.45), { k: 0.002 });
    }
    for (const [s] of SIDES) belt.add(roundBox([s * 0.168, 0.975, -0.02], eulerRot(0, s * 0.35, 0), 0.022, 0.047, 0.042, 0.011), GEAR, { k: 0.004 });
    {
      const th = 'thighR';
      belt.add(roundBox(P(th, 0.098, -0.17, -0.004), Rb(th), 0.017, 0.066, 0.05, 0.012), GEAR);
      belt.add(roundBox(P(th, 0.104, -0.1, -0.004), Rb(th, eulerRot(0, 0, 0.15)), 0.012, 0.012, 0.053, 0.007), GEARC(0.8), { k: 0.003 });
      for (const y of [-0.13, -0.235]) belt.add(torus(P(th, 0, y, -0.002), Rb(th), 0.079 + (y + 0.13) * 0.048, 0.0055), WEB, { k: 0.004 });
    }
    objects.push(belt);

    // ---- knee pads (on the shins, so they stay on the knee when it bends)
    const pads = new SdfObject('pads', { h: 0.0065 });
    pads.errK = 1.6;
    for (const [, S] of SIDES) {
      const sh = 'shin' + S;
      pads.add(ellipsoid(P(sh, 0, -0.03, -0.05), Rb(sh), 0.05, 0.062, 0.03), M(C.pad, 0.6), { bone: sh });
      pads.add(torus(P(sh, 0, -0.035, 0.0), Rb(sh), 0.061, 0.006), M(C.gearDk, 0.9), { k: 0.004, bone: sh });
    }
    pads.ownWeights = true;
    objects.push(pads);
  }

  // ---- boots: shaft round the lower shin, the foot with toe cap and heel, a thick sole, laces
  const boots = new SdfObject('boots', { h: 0.0065 });
  boots.errK = 1.3;
  const BOOT = M(C.boot, 0.65), SOLE = M(C.sole, 0.85);
  for (const [, S] of SIDES) {
    const sh = 'shin' + S, ft = 'foot' + S;
    boots.add(roundCone(P(sh, 0, -0.27, 0.002), P(sh, 0, -0.405, 0.006), 0.057, 0.06), BOOT, { bone: sh });
    boots.add(torus(P(sh, 0, -0.272, 0.002), Rb(sh), 0.055, 0.01), M(C.bootDk, 0.7), { k: 0.004, bone: sh });
    boots.add(roundBox(P(ft, 0, -0.012, -0.045), Rb(ft), 0.047, 0.03, 0.104, 0.034), BOOT, { k: 0.02, bone: ft });
    boots.add(ellipsoid(P(ft, 0, 0.008, -0.03), Rb(ft), 0.046, 0.042, 0.065), BOOT, { k: 0.025, bone: ft });
    boots.add(ellipsoid(P(ft, 0, -0.018, -0.135), Rb(ft), 0.049, 0.032, 0.055), M(C.bootDk, 0.6), { k: 0.01, bone: ft });
    boots.add(ellipsoid(P(ft, 0, -0.01, 0.04), Rb(ft), 0.044, 0.042, 0.04), BOOT, { k: 0.02, bone: ft });
    boots.add(roundBox(P(ft, 0, -0.034, -0.055), Rb(ft), 0.054, 0.0095, 0.135, 0.008), SOLE, { k: 0.003, bone: ft });
    for (const [lz, ly, la] of [[-0.02, 0.05, 0.1], [-0.045, 0.049, -0.1], [-0.07, 0.041, -0.45]]) {
      boots.add(roundBox(P(ft, 0, ly, lz), Rb(ft, eulerRot(la, 0, 0)), 0.022, 0.0035, 0.0045, 0.0025), M(C.lace, 0.9), { k: 0.002, bone: ft });
    }
  }
  boots.ownWeights = true;
  objects.push(boots);

  // ---- fingerless gloves gripping (fingers curled round a grip), a cuff over the sleeve
  for (const [s, S] of SIDES) objects.push(glove(P, Rb, 'hand' + S, s, 0.004, real ? 1.0 : 1.1));

  // ---- the ghillie mantle: a shawl over the shoulders and a cape down the back
  const mantle = new SdfObject('mantle', { h: 0.015 });
  mantle.errK = 3;
  const NET = M(C.hood, 0.95);
  mantle.add(ellipsoid(P('chest', 0, 0.18, 0.05), IDENT, 0.225, 0.095, 0.15), NET);
  mantle.add(custom((x, y, z) => {
    const t = Math.max(0, Math.min(1, (1.5 - y) / 0.82));
    const hw = 0.17 + 0.075 * t, zc = 0.148 + 0.9 * x * x, th = real ? 0.016 - 0.004 * t : 0.03 - 0.008 * t;
    return boxDist(x, y - 1.1, z - zc, hw, 0.41, th, 0.022);
  }, [-0.27, 0.68, 0.09], [0.27, 1.52, 0.27]), NET, { k: 0.05 });
  mantle.sub(ellipsoid(P('chest', 0, 0.07, -0.19), IDENT, 0.17, 0.16, 0.13), { k: 0.03 });
  mantle.proxyFilter = (b) => TORSO.has(b) || b === 'neck' || b === 'head' || b.startsWith('upperArm');
  objects.push(mantle);

  return { objects, proxies, P, Rb, F, frontZ, tD, hood, mantle, body, face };
}

// A right hand (s = 1) in its bone's frame: fingers along -y, the palm facing -x, the thumb
// toward -z; the left hand (s = -1) is its mirror image. k scales the hand.
function glove(P, Rb, bone, s, h, k = 1, curl = [0.95, 1.45, 0.75]) {
  const g = new SdfObject('glove' + bone, { h, bone });
  g.errK = 0.9;
  const GLOVE = M(C.glove, 0.85), DK = M(C.gloveDk, 0.8), SKIN = M(C.skin, 0.62);
  const L = (x, y, z) => P(bone, s * x * k, y * k, z * k);
  g.add(roundBox(L(-0.004, -0.05, 0), Rb(bone), 0.017 * k, 0.043 * k, 0.038 * k, 0.015 * k), GLOVE);
  // cuff with a strap, over the sleeve's end
  g.add(roundCone(L(0, 0.022, 0), L(0, -0.03, 0), 0.042, 0.04), GLOVE, { k: 0.02 });
  g.add(torus(L(0, -0.006, 0), Rb(bone), 0.043, 0.0065), DK, { k: 0.003 });
  // knuckle guard on the back of the hand
  g.add(roundBox(L(0.016, -0.08, 0), Rb(bone), 0.006 * k, 0.01 * k, 0.033 * k, 0.005 * k), DK, { k: 0.004 });
  // fingers: three bones each, curled toward the palm (the last one bare)
  const fingers = [
    { z: -0.026, len: [0.04, 0.025, 0.021], r: 0.0098 },
    { z: -0.0085, len: [0.044, 0.028, 0.022], r: 0.01 },
    { z: 0.0085, len: [0.041, 0.026, 0.021], r: 0.0096 },
    { z: 0.025, len: [0.032, 0.02, 0.018], r: 0.0086 },
  ];
  for (const fi of fingers) {
    let x = 0.002, y = -0.088, a = 0;
    for (let j = 0; j < 3; j++) {
      a += curl[j];
      const x1 = x - Math.sin(a) * fi.len[j], y1 = y - Math.cos(a) * fi.len[j];
      const r0 = fi.r * (1 - j * 0.07) * k, r1 = fi.r * (1 - (j + 1) * 0.07) * k;
      g.add(roundCone(L(x, y, fi.z), L(x1, y1, fi.z), r0, r1), j === 2 ? SKIN : GLOVE, { k: 0.004 });
      x = x1; y = y1;
    }
  }
  // the thumb: from the heel of the palm, across the front of the curled fingers
  const tp = [[-0.008, -0.03, -0.03], [-0.03, -0.055, -0.048], [-0.05, -0.08, -0.04], [-0.058, -0.096, -0.022]];
  const tr = [0.0125, 0.0112, 0.0102, 0.0094];
  for (let j = 0; j < 3; j++) g.add(roundCone(L(...tp[j]), L(...tp[j + 1]), tr[j] * k, tr[j + 1] * k), j === 2 ? SKIN : GLOVE, { k: j === 0 ? 0.012 : 0.004 });
  return g;
}

// ---------------------------------------------------------------- eyes
// UV spheres with the pole forward: pupil, iris and white by the angle from the front.
function eyeMesh(center, r) {
  const W = 16, Hs = 10;
  const pos = [], nrm = [], col = [], idx = [];
  for (let i = 0; i <= Hs; i++) {
    const th = (i / Hs) * Math.PI;   // 0 at the front
    for (let j = 0; j <= W; j++) {
      const ph = (j / W) * Math.PI * 2;
      const nx = Math.sin(th) * Math.cos(ph), ny = Math.sin(th) * Math.sin(ph), nzz = -Math.cos(th);
      pos.push(center[0] + nx * r, center[1] + ny * r, center[2] + nzz * r);
      nrm.push(nx, ny, nzz);
      const c = th < 0.25 ? C.pupil : th < 0.6 ? C.iris.map((v) => v * (0.75 + (th - 0.25) * 1.2)) : C.sclera;
      col.push(...c);
    }
  }
  for (let i = 0; i < Hs; i++) for (let j = 0; j < W; j++) {
    const a = i * (W + 1) + j, b = a + W + 1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);   // (counter-clockwise seen from outside)
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), col: new Float32Array(col), idx: new Uint32Array(idx) };
}

// ---------------------------------------------------------------- skin weights
// Each bone's distance from the point (its own shapes); weights fall off with the distance
// beyond the nearest bone. Leg bones only weigh on their own side, so the inner thighs never
// follow the other leg.
const _dmin = new Float32Array(64);
function weightsFor(x, y, z, proxies, boneIndex, nb, out) {
  const dmin = _dmin.fill(1e9, 0, nb);
  for (const p of proxies) {
    if (p.side > 0 && x < -0.015) continue;
    if (p.side < 0 && x > 0.015) continue;
    const d = p.prim.d(x, y, z);
    if (d < dmin[p.bi]) dmin[p.bi] = d;
  }
  let best = 1e9;
  for (let b = 0; b < nb; b++) if (dmin[b] < best) best = dmin[b];
  for (let b = 0; b < nb; b++) out[b] = dmin[b] > 1e8 ? 0 : Math.exp(-(dmin[b] - best) / 0.02);
}

// the 4 strongest weights at a point: [indices, weights] (rigid on the head without proxies)
function topWeights(p, px, boneIndex, nb, wv) {
  if (!px) return [[boneIndex.head, 0, 0, 0], [1, 0, 0, 0]];
  weightsFor(p[0], p[1], p[2], px, boneIndex, nb, wv);
  const order = [...wv.keys()].sort((a, b) => wv[b] - wv[a]).slice(0, 4);
  let sum = 0;
  for (const b of order) if (wv[b] > 0.02) sum += wv[b];
  return [order, order.map((b) => (wv[b] > 0.02 ? wv[b] / sum : 0))];
}

function smoothAndPack(W, nv, nb, idx, iters) {
  if (iters > 0) {
    const nbr = Array.from({ length: nv }, () => []);
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      nbr[a].push(b, c); nbr[b].push(a, c); nbr[c].push(a, b);
    }
    const tmp = new Float32Array(W.length);
    for (let it = 0; it < iters; it++) {
      for (let v = 0; v < nv; v++) {
        const ns = nbr[v];
        for (let b = 0; b < nb; b++) {
          let s = 0;
          for (const u of ns) s += W[u * nb + b];
          tmp[v * nb + b] = ns.length ? W[v * nb + b] * 0.5 + (s / ns.length) * 0.5 : W[v * nb + b];
        }
      }
      W.set(tmp);
    }
  }
  const si = new Uint16Array(nv * 4), sw = new Float32Array(nv * 4);
  const order = new Array(nb);
  for (let v = 0; v < nv; v++) {
    for (let b = 0; b < nb; b++) order[b] = b;
    order.sort((a, b) => W[v * nb + b] - W[v * nb + a]);
    let sum = 0;
    for (let k = 0; k < 4; k++) { const w = W[v * nb + order[k]]; if (w > 0.02) sum += w; }
    for (let k = 0; k < 4; k++) {
      const w = W[v * nb + order[k]];
      si[v * 4 + k] = order[k];
      sw[v * 4 + k] = w > 0.02 && sum > 0 ? w / sum : 0;
    }
  }
  return { si, sw };
}

// ---------------------------------------------------------------- building
// LOD error budgets (metres of surface deviation the simplifier may introduce)
const LODS = [{ err: 0.001, ratio: 0.02 }, { err: 0.005, ratio: 0.005 }];

export function buildSculptedSniper(BONES, { look = 'stylized', lods = [0, 1] } = {}) {
  const foliage = look === 'real' ? realGhillieStrands : sniperFoliage;
  const t0 = performance.now();
  const timing = {};
  const tick = (k, t) => { timing[k] = (timing[k] || 0) + Math.round(performance.now() - t); };
  const F = bindFrames(BONES);
  const boneIndex = Object.fromEntries(BONES.map((b, i) => [b[0], i]));
  const nb = BONES.length;
  const def = defineSniper(F, look);
  const { objects, proxies } = def;
  const side = (b) => (/^(thigh|shin|foot)R$/.test(b) ? 1 : /^(thigh|shin|foot)L$/.test(b) ? -1 : 0);
  const prox = (list) => list.map((p) => ({ ...p, bi: boneIndex[p.bone], side: side(p.bone) }));
  // the whole figure as one field, for ambient occlusion
  const scene = (x, y, z) => {
    let d = 1e9;
    for (const o of objects) {
      if (x < o.min[0] - 0.2 || x > o.max[0] + 0.2 || y < o.min[1] - 0.2 || y > o.max[1] + 0.2 || z < o.min[2] - 0.2 || z > o.max[2] + 0.2) continue;
      const di = o.dist(x, y, z);
      if (di < d) d = di;
    }
    return d;
  };
  const out = lods.map(() => []);
  const surfaces = {};
  const tmp = [0, 0, 0, 0, 0, 0], g = [0, 0, 0];
  const wv = new Float32Array(nb);
  for (const obj of objects) {
    let t = performance.now();
    const m = meshObject(obj);
    tick('mesh', t);
    tick('mesh:' + obj.name, t);
    t = performance.now();
    // the dense mesh's colours and materials guide the simplifier (in roughly perceptual units)
    const nv = m.pos.length / 3;
    const mat = new Float32Array(nv * 6), attr = new Float32Array(nv * 6);
    for (let v = 0; v < nv; v++) {
      obj.material(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2], tmp);
      for (let i = 0; i < 6; i++) mat[v * 6 + i] = tmp[i];
      for (let i = 0; i < 3; i++) attr[v * 6 + i] = Math.sqrt(Math.max(0, tmp[i]));
      attr[v * 6 + 3] = tmp[3]; attr[v * 6 + 4] = tmp[4]; attr[v * 6 + 5] = tmp[5];
    }
    tick('material', t);
    const px = obj.bone ? null : prox(obj.ownWeights ? obj.ops.filter((o) => !o.sub).map((o) => ({ bone: o.bone, prim: o.prim }))
      : proxies.filter((p) => (obj === objects[0] ? p.bone !== 'head' : obj.proxyFilter ? obj.proxyFilter(p.bone) : true)));
    lods.forEach((lod, li) => {
      t = performance.now();
      const L = LODS[lod];
      const target = Math.max(6, Math.floor((m.idx.length * L.ratio) / 3) * 3);
      const err = L.err * (obj.errK || 1);
      const [sIdx] = MeshoptSimplifier.simplifyWithAttributes(m.idx, m.pos, 3, attr, 6, [0.03, 0.03, 0.03, 0.02, 0.004, 0.03], null, target, err, ['ErrorAbsolute']);
      // compact: keep the used vertices
      const remap = new Int32Array(nv).fill(-1);
      let n = 0;
      for (let i = 0; i < sIdx.length; i++) if (remap[sIdx[i]] < 0) remap[sIdx[i]] = n++;
      const idx = new Uint32Array(sIdx.length);
      for (let i = 0; i < sIdx.length; i++) idx[i] = remap[sIdx[i]];
      const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
      const camo = new Float32Array(n), rough = new Float32Array(n), gear = new Float32Array(n), W = new Float32Array(n * nb);
      tick('simplify', t);
      t = performance.now();
      for (let v = 0; v < nv; v++) {
        const r = remap[v];
        if (r < 0) continue;
        const x = m.pos[v * 3], y = m.pos[v * 3 + 1], z = m.pos[v * 3 + 2];
        pos[r * 3] = x; pos[r * 3 + 1] = y; pos[r * 3 + 2] = z;
        normalAt((a, b, c) => obj.dist(a, b, c), x, y, z, g);
        nrm[r * 3] = g[0]; nrm[r * 3 + 1] = g[1]; nrm[r * 3 + 2] = g[2];
        const ao = 1 - (1 - sdfAO(scene, x, y, z, g[0], g[1], g[2])) * (obj.aoK ?? 1);
        const cm = Math.min(1, Math.max(0, mat[v * 6 + 3]));
        for (let i = 0; i < 3; i++) col[r * 3 + i] = (mat[v * 6 + i] + (1 - mat[v * 6 + i]) * cm) * ao;
        camo[r] = mat[v * 6 + 3]; rough[r] = mat[v * 6 + 4]; gear[r] = mat[v * 6 + 5];
        if (obj.bone) W[r * nb + boneIndex[obj.bone]] = 1;
        else { weightsFor(x, y, z, px, boneIndex, nb, wv); W.set(wv, r * nb); }
      }
      tick('attributes', t);
      const { si, sw } = smoothAndPack(W, n, nb, idx, obj.bone ? 0 : 2);
      out[li].push({ name: obj.name, pos, nrm, idx, col, camo, rough, gear, si, sw });
      if (li === 0) surfaces[obj.name] = { pos, idx, obj, px };
    });
  }
  // eyes
  for (const s of [1, -1]) {
    // (realistic: a little smaller and deeper, so less of the white shows)
    const e = look === 'real' ? eyeMesh(def.P('head', s * 0.032, 0.0152, -0.0565), 0.0128) : eyeMesh(def.P('head', s * 0.032, 0.0155, -0.0575), 0.0135);
    const nv = e.pos.length / 3;
    const si = new Uint16Array(nv * 4), sw = new Float32Array(nv * 4);
    for (let v = 0; v < nv; v++) { si[v * 4] = boneIndex.head; sw[v * 4] = 1; }
    for (const parts of out) parts.push({ name: 'eye', pos: e.pos, nrm: e.nrm, idx: e.idx, col: e.col, camo: new Float32Array(nv), rough: new Float32Array(nv).fill(0.25), si, sw });
  }
  let t = performance.now();
  const geos = out.map((parts, li) => {
    const leaves = foliage(def, {
      scene, surfaces, boneIndex, nb, lod: lods[li],
      normalAt: (obj, p) => normalAt((a, b, c) => obj.dist(a, b, c), p[0], p[1], p[2], [0, 0, 0]),
      ao: (p, n) => sdfAO(scene, p[0], p[1], p[2], n[0], n[1], n[2]),
      weights: (p, px) => topWeights(p, px, boneIndex, nb, wv),
    });
    return assemble(parts, leaves);
  });
  tick('foliage', t);
  const ms = Math.round(performance.now() - t0);
  geos.forEach((geo) => { geo.stats = { ms, timing, tris: geo.index.length / 3, parts: geo.parts }; });
  return geos;
}

// ---------------------------------------------------------------- the ghillie
// Leaves: pointed, folded along the midrib (each half shaded on its own, so they read as two
// tones like the stylized trees), curling out a little, dark at the root and light at the tip.
// They grow from the mantle (densely), the hood (flowing back from the face), and the outer
// and back sides of the arms and legs, pointing down the surface (down the limb), lifted off it.
// Each leaf takes the skin weights of its root. Then jute strands hanging from the cape and the
// shoulders, a few grass tufts sticking up, and the radio's antenna.
const LEAF_GREEN = [0x5b7a2c, 0x6c8e33, 0x4c6a28, 0x809c3e, 0x74853a, 0x5f7f35].map(lin);
const LEAF_DRY = [0x8c7546, 0x6f5b36, 0x9b8a52].map(lin);
const JUTE = [0x9c8a5c, 0x8a7a50, 0xa99a6e, 0x7d6f47].map(lin);
const GRASS = [0x8aa245, 0x9fae58, 0x76913a].map(lin);

function sniperFoliage(def, ctx) {
  const { surfaces, scene, boneIndex, nb, lod } = ctx;
  const rng = new RNG(1234);
  const F = def.F, hd = F.head.t;
  const pos = [], nrm = [], col = [], sway = [], si = [], sw = [], idx = [];
  const wv = new Float32Array(nb);
  let curW = null;   // [indices, weights] of the current leaf's root
  const vtx = (p, n, c, s) => {
    pos.push(p[0], p[1], p[2]); nrm.push(n[0], n[1], n[2]); col.push(c[0], c[1], c[2]); sway.push(s);
    si.push(...curW[0]); sw.push(...curW[1]);
    return pos.length / 3 - 1;
  };
  const tri = (a, b, c) => idx.push(a, b, c);
  const add = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const shade = (c, k, warm = 0) => [Math.min(1, c[0] * k * (1 + warm)), Math.min(1, c[1] * k * (1 + warm * 0.5)), Math.min(1, c[2] * k)];
  const setWeights = (p, px) => {
    if (!px) { curW = [[boneIndex.head, 0, 0, 0], [1, 0, 0, 0]]; return; }
    weightsFor(p[0], p[1], p[2], px, boneIndex, nb, wv);
    const order = [...wv.keys()].sort((a, b) => wv[b] - wv[a]).slice(0, 4);
    let sum = 0;
    for (const b of order) if (wv[b] > 0.02) sum += wv[b];
    curW = [order, order.map((b) => (wv[b] > 0.02 ? wv[b] / sum : 0))];
  };
  // one leaf: root, direction (unit, along the leaf), the surface normal, length, width
  const leaf = (root, dir, n0, L, W, c, swayK, ao) => {
    const side = norm(cross(n0, dir));
    const n = norm(cross(dir, side));
    const curl = rng.float(0.05, 0.22), fold = W * rng.float(0.16, 0.24);
    const at = (t, u) => {
      const w = t <= 0 || t >= 1 ? 0 : W * 0.5 * (t < 0.5 ? 0.55 + 0.9 * t : 1.1 - 0.9 * (t - 0.5) * 1.6);
      let p = add(root, dir, L * t);
      p = add(p, n, curl * L * t * t + (1 - Math.abs(u)) * fold * (t > 0 && t < 1 ? 1 : 0));
      return add(p, side, u * w);
    };
    const T = [0, 0.33, 0.68, 1];
    const cs = T.map((t) => shade(c, (0.5 + 0.65 * t) * (ao + (1 - ao) * t), t * 0.12));
    const sws = T.map((t) => swayK * t * (0.3 + 0.7 * t));
    if (lod > 0) {
      // far away: a flat diamond
      const r = vtx(at(0, 0), n, cs[0], 0), a = vtx(at(0.45, -1), n, cs[1], sws[1]), b = vtx(at(1, 0), n, cs[3], sws[3]), d = vtx(at(0.45, 1), n, cs[1], sws[1]);
      tri(r, a, b); tri(r, b, d);
      return;
    }
    for (const u of [-1, 1]) {
      const nh = norm(add(n, side, u * 0.45));
      const r = vtx(at(0, 0), nh, cs[0], 0);
      const e1 = vtx(at(0.33, u), nh, cs[1], sws[1]), m1 = vtx(at(0.33, 0), nh, cs[1], sws[1]);
      const e2 = vtx(at(0.68, u), nh, cs[2], sws[2]), m2 = vtx(at(0.68, 0), nh, cs[2], sws[2]);
      const tp = vtx(at(1, 0), nh, cs[3], sws[3]);
      tri(r, e1, m1); tri(e1, e2, m2); tri(e1, m2, m1); tri(e2, tp, m2);
    }
  };
  // a ribbon (jute strand, grass blade, antenna): points along a path, a width per point
  const ribbon = (pts, widths, n0, c0, c1, swayK) => {
    const vs = [];
    for (let i = 0; i < pts.length; i++) {
      const t = i / (pts.length - 1);
      const d = norm(i < pts.length - 1 ? add(pts[i + 1], pts[i], -1) : add(pts[i], pts[i - 1], -1));
      const side = norm(cross(n0, d));
      const c = [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
      vs.push(vtx(add(pts[i], side, -widths[i] / 2), n0, c, swayK * t), vtx(add(pts[i], side, widths[i] / 2), n0, c, swayK * t));
    }
    for (let i = 0; i < pts.length - 1; i++) { const a = vs[i * 2], b = vs[i * 2 + 1], c = vs[i * 2 + 2], d = vs[i * 2 + 3]; tri(a, c, b); tri(b, c, d); }
  };
  // area-weighted random points on a surface
  const sampler = (S) => {
    const cum = [];
    let A = 0;
    for (let t = 0; t < S.idx.length; t += 3) {
      const a = S.idx[t] * 3, b = S.idx[t + 1] * 3, c = S.idx[t + 2] * 3;
      const u = [S.pos[b] - S.pos[a], S.pos[b + 1] - S.pos[a + 1], S.pos[b + 2] - S.pos[a + 2]];
      const v = [S.pos[c] - S.pos[a], S.pos[c + 1] - S.pos[a + 1], S.pos[c + 2] - S.pos[a + 2]];
      const cr = cross(u, v);
      A += Math.hypot(cr[0], cr[1], cr[2]) / 2;
      cum.push(A);
    }
    return {
      area: A,
      next() {
        const r = rng.next() * A;
        let lo = 0, hi = cum.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
        let a = rng.next(), b = rng.next();
        if (a + b > 1) { a = 1 - a; b = 1 - b; }
        const i0 = S.idx[lo * 3] * 3, i1 = S.idx[lo * 3 + 1] * 3, i2 = S.idx[lo * 3 + 2] * 3;
        return [0, 1, 2].map((k) => S.pos[i0 + k] + (S.pos[i1 + k] - S.pos[i0 + k]) * a + (S.pos[i2 + k] - S.pos[i0 + k]) * b);
      },
    };
  };
  // no two leaf roots closer than minD (per zone), via a hash grid
  const grid = new Map();
  const cellOf = (p) => `${Math.floor(p[0] / 0.03)},${Math.floor(p[1] / 0.03)},${Math.floor(p[2] / 0.03)}`;
  const tooClose = (p, minD) => {
    const cx = Math.floor(p[0] / 0.03), cy = Math.floor(p[1] / 0.03), cz = Math.floor(p[2] / 0.03);
    const r = Math.ceil(minD / 0.03);
    for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) for (let z = cz - r; z <= cz + r; z++) {
      const list = grid.get(`${x},${y},${z}`);
      if (!list) continue;
      for (const q of list) if ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2 < minD * minD) return true;
    }
    return false;
  };
  const mark = (p) => { const k = cellOf(p); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); };
  const nAt = (obj, p) => normalAt((a, b, c) => obj.dist(a, b, c), p[0], p[1], p[2], [0, 0, 0]);
  const tangentDown = (n, want) => {
    const d = add(want, n, -dot(want, n));
    const l = Math.hypot(d[0], d[1], d[2]);
    return l < 1e-3 ? null : [d[0] / l, d[1] / l, d[2] / l];
  };
  const rotAbout = (v, axis, a) => {
    const c = Math.cos(a), s = Math.sin(a), d = dot(axis, v), cr = cross(axis, v);
    return [v[0] * c + cr[0] * s + axis[0] * d * (1 - c), v[1] * c + cr[1] * s + axis[1] * d * (1 - c), v[2] * c + cr[2] * s + axis[2] * d * (1 - c)];
  };
  const pickColor = (dryP) => (rng.chance(dryP) ? LEAF_DRY[rng.int(0, LEAF_DRY.length - 1)] : LEAF_GREEN[rng.int(0, LEAF_GREEN.length - 1)]);
  const far = lod > 0;
  // grow leaves on one surface: density(p, n) in 0..1, params(p, n) -> { want, L, W, lift, swayK, minD }
  const grow = (name, count, density, params) => {
    const S = surfaces[name];
    if (!S) return;
    const smp = sampler(S);
    let placed = 0;
    const target = Math.round(count * (far ? 0.4 : 1));
    for (let tries = 0; tries < target * 30 && placed < target; tries++) {
      const p = smp.next();
      const n = nAt(S.obj, p);
      if (rng.next() > density(p, n)) continue;
      const P = params(p, n);
      const minD = P.minD * (far ? 1.5 : 1);
      if (tooClose(p, minD)) continue;
      const down = tangentDown(n, P.want);
      if (!down) continue;
      let dir = rotAbout(down, n, rng.float(-0.45, 0.45));
      const lift = rng.float(P.lift[0], P.lift[1]);
      dir = norm(add(add([0, 0, 0], dir, Math.cos(lift)), n, Math.sin(lift)));
      const root = add(p, n, -0.004);
      setWeights(root, S.px);
      const ao = sdfAO(scene, ...add(p, n, 0.01), ...n);
      const k = far ? 1.4 : 1;
      leaf(root, dir, n, rng.float(P.L[0], P.L[1]) * k, rng.float(P.W[0], P.W[1]) * k, pickColor(P.dry ?? 0.14), P.swayK, Math.max(0.45, ao));
      mark(p);
      placed++;
    }
  };
  // the mantle: everything facing away from the body
  grow('mantle', 360, (p, n) => {
    const ox = p[0], oz = p[2] - 0.02, ol = Math.hypot(ox, oz) || 1;
    const out = (n[0] * ox + n[2] * oz) / ol + Math.max(0, n[1]) * 0.9;
    return out < 0.15 ? 0 : 1;
  }, (p) => {
    const low = smooth(0.95, 0.72, p[1]), top = smooth(1.38, 1.5, p[1]);
    return {
      want: [0, -1, 0.05], L: [0.11 + 0.03 * low - 0.03 * top, 0.16 + 0.05 * low - 0.05 * top], W: [0.044 - 0.006 * top, 0.064 - 0.012 * top],
      lift: [0.25 - 0.12 * top, 0.6 - 0.28 * top], swayK: 0.9 + 0.5 * low, minD: 0.034 - 0.004 * top,
    };
  });
  // the hood: flowing back from the face, the face and goggles kept clear
  grow('hood', 70, (p, n) => {
    const lx = p[0] - hd[0], ly = p[1] - hd[1], lz = p[2] - hd[2];
    if (lz < -0.025 && ly < 0.14 && Math.abs(lx) < 0.095) return 0;
    if (lz < -0.06 && ly < 0.16) return 0;
    return n[1] < -0.6 ? 0 : 1;
  }, () => ({ want: [0, -0.7, 1], L: [0.075, 0.11], W: [0.036, 0.05], lift: [0.3, 0.65], swayK: 0.5, minD: 0.026, dry: 0.1 }));
  // arms and legs: the outer and back sides, pointing down the limb
  const bodyS = surfaces.body;
  if (bodyS) {
    const limbOf = (p) => {
      let best = 1e9, bone = null;
      for (const o of bodyS.obj.ops) { if (o.sub) continue; const d = o.prim.d(p[0], p[1], p[2]); if (d < best) { best = d; bone = o.bone; } }
      return bone;
    };
    const localN = (bone, n) => { const R = F[bone].R; return [R[0] * n[0] + R[3] * n[1] + R[6] * n[2], R[1] * n[0] + R[4] * n[1] + R[7] * n[2], R[2] * n[0] + R[5] * n[1] + R[8] * n[2]]; };
    const localP = (bone, p) => { const f = F[bone], R = f.R, q = [p[0] - f.t[0], p[1] - f.t[1], p[2] - f.t[2]]; return [R[0] * q[0] + R[3] * q[1] + R[6] * q[2], R[1] * q[0] + R[4] * q[1] + R[7] * q[2], R[2] * q[0] + R[5] * q[1] + R[8] * q[2]]; };
    const down = (bone) => { const R = F[bone].R; return [-R[1], -R[4], -R[7]]; };
    const cache = new Map();
    const info = (p) => { const k = p.join(); if (!cache.has(k)) cache.set(k, limbOf(p)); return cache.get(k); };
    grow('body', 150, (p, n) => {
      const bone = info(p);
      if (!bone || TORSO.has(bone) || bone === 'neck') return 0;
      const s = bone.endsWith('R') ? 1 : -1;
      const ln = localN(bone, n), lp = localP(bone, p);
      if (bone.startsWith('upperArm')) return 0.75 * smooth(-0.2, 0.4, ln[0] * s + 0.7 * ln[2]);
      if (bone.startsWith('foreArm')) return lp[1] < -0.17 ? 0 : 0.45 * smooth(-0.1, 0.5, ln[0] * s + 0.7 * ln[2]);
      if (bone.startsWith('thigh')) {
        if (s > 0 && ln[0] > 0.3 && lp[1] > -0.27 && lp[1] < -0.05) return 0;   // the drop-leg pouch
        return 0.7 * smooth(-0.1, 0.5, ln[2] + 0.6 * ln[0] * s);
      }
      if (bone.startsWith('shin')) return lp[1] < -0.22 ? 0 : 0.45 * smooth(0.1, 0.6, ln[2]);
      return 0;
    }, (p) => {
      const bone = info(p);
      const arm = bone.includes('Arm');
      return { want: down(bone), L: arm ? [0.07, 0.1] : [0.08, 0.12], W: arm ? [0.032, 0.044] : [0.036, 0.05], lift: [0.2, 0.5], swayK: 0.6, minD: arm ? 0.03 : 0.033 };
    });
  }
  // jute strands: hanging from the bottom of the cape and from the shoulders
  const M_ = surfaces.mantle;
  if (M_) {
    const smp = sampler(M_);
    let made = 0;
    for (let tries = 0; tries < 3000 && made < (far ? 14 : 44); tries++) {
      const p = smp.next();
      const n = nAt(M_.obj, p);
      const onEdge = p[1] < 0.8 || (p[1] > 1.4 && Math.abs(p[0]) > 0.15);
      if (!onEdge || n[2] < -0.3) continue;
      setWeights(p, M_.px);
      const L = rng.float(0.16, 0.3), w = rng.float(0.011, 0.017);
      const pts = [];
      const drift = [rng.float(-0.04, 0.04), 0, rng.float(0.0, 0.05)];
      for (let i = 0; i <= 3; i++) {
        const t = i / 3;
        pts.push([p[0] + drift[0] * t * t, p[1] - L * t, p[2] + 0.01 + drift[2] * t * t]);
      }
      const c = JUTE[rng.int(0, JUTE.length - 1)];
      ribbon(pts, [w, w * 0.9, w * 0.75, w * 0.4], norm([n[0], 0, Math.max(0.3, n[2])]), shade(c, 0.6), shade(c, 1.1), 1.5);
      made++;
    }
  }
  // grass tufts on the shoulders and the crown
  if (!far) {
    const tufts = [[0.16, 1.55, 0.07, 1], [-0.17, 1.54, 0.05, -1], [0.05, 1.78, 0.07, 0.2], [-0.06, 1.77, 0.09, -0.3], [0.1, 1.52, 0.16, 0.6], [-0.09, 1.5, 0.18, -0.5]];
    for (const [x, y, z, lean] of tufts) {
      const root = [x, y, z];
      setWeights(root, surfaces.mantle ? surfaces.mantle.px : null);
      for (let b = 0; b < 4; b++) {
        const L = rng.float(0.12, 0.22), a = rng.float(-0.5, 0.5);
        const dir = norm([lean * 0.5 + Math.sin(a) * 0.4, 1, 0.35 + Math.cos(a) * 0.3]);
        const bend = [lean * 0.04, -0.02, 0.06];
        const pts = [0, 0.5, 1].map((t) => [root[0] + dir[0] * L * t + bend[0] * t * t, root[1] + dir[1] * L * t + bend[1] * t * t, root[2] + dir[2] * L * t + bend[2] * t * t]);
        const c = GRASS[rng.int(0, GRASS.length - 1)];
        ribbon(pts, [0.014, 0.009, 0.0], norm([-dir[2], 0, dir[0] || 0.01]), shade(c, 0.55), shade(c, 1.15, 0.1), 0.9);
      }
    }
  }
  // the radio's antenna, from the top of the radio up past the head
  {
    const base = [-0.165, 1.37, 0.09];
    setWeights(base, surfaces.mantle ? surfaces.mantle.px : null);
    const pts = [0, 0.25, 0.5, 0.75, 1].map((t) => [base[0] - 0.02 * t, base[1] + 0.5 * t, base[2] + 0.06 * t * t]);
    const dk = lin(0x22231d);
    ribbon(pts, [0.008, 0.007, 0.006, 0.005, 0.004], [1, 0, 0], dk, dk, 0.7);
    ribbon(pts, [0.008, 0.007, 0.006, 0.005, 0.004], [0, 0, 1], dk, dk, 0.7);
  }
  const nv = pos.length / 3;
  return {
    name: 'foliage', pos: new Float32Array(pos), nrm: new Float32Array(nrm), idx: new Uint32Array(idx),
    col: new Float32Array(col), camo: new Float32Array(nv), rough: new Float32Array(nv).fill(0.85), sway: new Float32Array(sway),
    si: new Uint16Array(si), sw: new Float32Array(sw),
  };
}

// The parts as one geometry. Every part has positions, normals, colours, indices and skin; the
// other attributes are zero where a part has none, and left out when no part has them.
const EXTRA = [['camo', 'aCamo', 1], ['rough', 'aRough', 1], ['sway', 'aSway', 1], ['gear', 'aGear', 1], ['uv', 'uv', 2],
  ['root', 'aRoot', 3], ['rootN', 'aRootN', 3], ['strand', 'aStrand', 2]];
function assemble(parts, foliage) {
  const all = foliage ? [...parts, foliage] : parts;
  let nv = 0, ni = 0;
  for (const p of all) { nv += p.pos.length / 3; ni += p.idx.length; }
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
  const si = new Uint16Array(nv * 4), sw = new Float32Array(nv * 4);
  const idx = new Uint32Array(ni);
  const extra = EXTRA.filter(([k]) => all.some((p) => p[k])).map(([k, name, size]) => [k, name, size, new Float32Array(nv * size)]);
  let ov = 0, oi = 0, bodyCount = 0;
  for (const p of all) {
    const n = p.pos.length / 3;
    pos.set(p.pos, ov * 3); nrm.set(p.nrm, ov * 3); col.set(p.col, ov * 3);
    for (const [k, , size, arr] of extra) {
      if (p[k]) arr.set(p[k], ov * size);
      else if (k === 'uv') for (let i = 0; i < n; i++) { arr[(ov + i) * 2] = SOLID_UV[0]; arr[(ov + i) * 2 + 1] = SOLID_UV[1]; }
    }
    si.set(p.si, ov * 4); sw.set(p.sw, ov * 4);
    for (let i = 0; i < p.idx.length; i++) idx[oi + i] = p.idx[i] + ov;
    ov += n; oi += p.idx.length;
    if (p !== foliage) bodyCount = oi;
  }
  const attributes = { position: [pos, 3], normal: [nrm, 3], color: [col, 3], skinIndex: [si, 4], skinWeight: [sw, 4] };
  for (const [, name, size, arr] of extra) attributes[name] = [arr, size];
  return {
    attributes,
    index: idx,
    groups: [[0, bodyCount, 0], [bodyCount, ni - bodyCount, 1]],
    parts: all.map((p) => `${p.name}:${p.idx.length / 3}`).join(' '),
  };
}

// colours the shader needs (face paint) for each look, linear
export const FACE_PAINTS = Object.fromEntries(Object.entries(PALETTES).map(([k, P]) => [k, { skin: P.skin, green: P.paintG, brown: P.paintB, dark: P.paintD }]));

// ---------------------------------------------------------------- rigid pieces
// Mesh, simplify and shade sculpted objects that move as one piece (the rifle, the bolt, the
// first-person arms): positions, gradient normals, colours with occlusion (from all of them
// together), camo and roughness. extra: more triangles to append ({ pos, nrm, col, idx }).
function rigidGeometry(objs, errs = 0.0008, extra = null) {
  const list = Array.isArray(errs) ? errs : [errs];
  const scene = (x, y, z) => { let d = 1e9; for (const o of objs) d = Math.min(d, o.dist(x, y, z)); return d; };
  const outs = list.map(() => ({ pos: [], nrm: [], col: [], camo: [], rough: [], idx: [] }));
  const tmp = [0, 0, 0, 0, 0, 0], g = [0, 0, 0];
  for (const o of objs) {
    const m = meshObject(o);
    const nv = m.pos.length / 3;
    const attr = new Float32Array(nv * 5), mat = new Float32Array(nv * 5);
    for (let v = 0; v < nv; v++) {
      o.material(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2], tmp);
      for (let i = 0; i < 5; i++) mat[v * 5 + i] = tmp[i];
      for (let i = 0; i < 3; i++) attr[v * 5 + i] = Math.sqrt(Math.max(0, tmp[i]));
      attr[v * 5 + 3] = tmp[3]; attr[v * 5 + 4] = tmp[4];
    }
    // normals and occlusion once per dense vertex, shared by the versions
    const shade = new Float32Array(nv * 4).fill(NaN);
    const field = (a, b, c) => o.dist(a, b, c);
    list.forEach((err, li) => {
      const out = outs[li];
      const [sIdx] = MeshoptSimplifier.simplifyWithAttributes(m.idx, m.pos, 3, attr, 5, [0.03, 0.03, 0.03, 0.02, 0.004], null,
        Math.floor((m.idx.length * 0.02) / 3) * 3, err * (o.errK || 1), ['ErrorAbsolute']);
      const remap = new Int32Array(nv).fill(-1);
      const base = out.pos.length / 3;
      let n = 0;
      for (let i = 0; i < sIdx.length; i++) if (remap[sIdx[i]] < 0) remap[sIdx[i]] = n++;
      const order = new Int32Array(n);
      for (let v = 0; v < nv; v++) if (remap[v] >= 0) order[remap[v]] = v;
      for (let q = 0; q < n; q++) {
        const v = order[q];
        const x = m.pos[v * 3], y = m.pos[v * 3 + 1], z = m.pos[v * 3 + 2];
        if (Number.isNaN(shade[v * 4])) {
          normalAt(field, x, y, z, g);
          shade[v * 4] = g[0]; shade[v * 4 + 1] = g[1]; shade[v * 4 + 2] = g[2];
          shade[v * 4 + 3] = 1 - (1 - sdfAO(scene, x, y, z, g[0], g[1], g[2])) * (o.aoK ?? 1);
        }
        const ao = shade[v * 4 + 3];
        const cm = Math.min(1, Math.max(0, mat[v * 5 + 3]));
        out.pos.push(x, y, z); out.nrm.push(shade[v * 4], shade[v * 4 + 1], shade[v * 4 + 2]);
        for (let i = 0; i < 3; i++) out.col.push((mat[v * 5 + i] + (1 - mat[v * 5 + i]) * cm) * ao);
        out.camo.push(mat[v * 5 + 3]); out.rough.push(mat[v * 5 + 4]);
      }
      for (let i = 0; i < sIdx.length; i++) out.idx.push(base + remap[sIdx[i]]);
    });
  }
  if (extra) {
    const out = outs[0];
    const base = out.pos.length / 3;
    out.pos.push(...extra.pos); out.nrm.push(...extra.nrm); out.col.push(...extra.col);
    for (let i = 0; i < extra.pos.length / 3; i++) { out.camo.push(0); out.rough.push(0.85); }
    for (const i of extra.idx) out.idx.push(base + i);
  }
  const plain = outs.map((out) => ({
    attributes: {
      position: [new Float32Array(out.pos), 3], normal: [new Float32Array(out.nrm), 3], color: [new Float32Array(out.col), 3],
      aCamo: [new Float32Array(out.camo), 1], aRough: [new Float32Array(out.rough), 1],
    },
    index: new Uint32Array(out.idx),
  }));
  return Array.isArray(errs) ? plain : plain[0];
}

// a folded leaf (two halves, each shaded flat) appended to { pos, nrm, col, idx }
function pushFoldedLeaf(out, root, dir, n0, L, W, c, curl = 0.15, foldK = 0.2) {
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const side = norm(cross(n0, dir));
  const n = cross(dir, side);
  const fold = W * foldK;
  const at = (t, u) => {
    const w = t <= 0 || t >= 1 ? 0 : W * 0.5 * (t < 0.5 ? 0.55 + 0.9 * t : 1.1 - 1.44 * (t - 0.5));
    return [0, 1, 2].map((i) => root[i] + dir[i] * L * t + n[i] * ((1 - Math.abs(u)) * fold * (t > 0 && t < 1 ? 1 : 0) + curl * L * t * t) + side[i] * u * w);
  };
  for (const u of [-1, 1]) {
    const nh = norm([n[0] + side[0] * u * 0.45, n[1] + side[1] * u * 0.45, n[2] + side[2] * u * 0.45]);
    const b = out.pos.length / 3;
    for (const [t, uu] of [[0, 0], [0.33, u], [0.33, 0], [0.68, u], [0.68, 0], [1, 0]]) {
      out.pos.push(...at(t, uu)); out.nrm.push(...nh);
      const k = 0.55 + 0.65 * t;
      out.col.push(Math.min(1, c[0] * k * (1 + 0.12 * t)), Math.min(1, c[1] * k * (1 + 0.06 * t)), c[2] * k);
    }
    out.idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 4, b + 1, b + 4, b + 2, b + 3, b + 5, b + 4);
  }
}

// ---------------------------------------------------------------- the rifle
// A chunky stylized bolt-action rifle, sculpted the same way: an olive stock with cheek rest
// and pistol grip, a dark receiver, barrel and suppressor, a scope with a big objective bell,
// a folded bipod, and burlap wraps with a few leaves. In the rifle's own space the muzzle
// points to -z; the third-person hands' IK targets are the grip (0, -0.07, 0.1) and under the
// fore-end (0, -0.05, -0.32). The bolt handle is its own piece (buildSculptedBolt), so first
// person can work it. Near and far versions.
export const RIFLE_SCOPE_Y = 0.08, RIFLE_BORE_Y = 0.02;
export function buildSculptedRifle(look = 'stylized') {
  const real = look === 'real';
  const r = new SdfObject('rifle', { h: 0.004 });
  r.errK = 1.2;
  // stylized: an olive stock, warm dark metal, a teal lens; realistic: a dark olive-drab stock,
  // near-black metal and a dark lens
  const STOCK = M(lin(real ? 0x4a4a38 : 0x5d653a), real ? 0.72 : 0.8), METAL = M(lin(real ? 0x2b2b29 : 0x3a3934), real ? 0.5 : 0.62);
  const DARK = M(lin(real ? 0x1c1c1b : 0x272723), real ? 0.6 : 0.7);
  const BURLAP = M(lin(real ? 0x857552 : 0x9a8858), 0.95), LENS = M(lin(0x2a8f8a), 0.1);
  const RX = (a) => eulerRot(a, 0, 0);
  // stock: butt, cheek rest, butt pad, wrist, pistol grip, fore-end, trigger guard
  r.add(roundBox([0, -0.032, 0.31], IDENT, 0.022, 0.058, 0.11, 0.018), STOCK);
  r.add(roundBox([0, 0.024, 0.27], IDENT, 0.018, 0.017, 0.085, 0.013), STOCK, { k: 0.03 });
  r.add(roundBox([0, -0.032, 0.418], IDENT, 0.024, 0.062, 0.008, 0.006), DARK, { k: 0.004 });
  r.add(roundCone([0, -0.022, 0.2], [0, -0.005, 0.06], 0.022, 0.02), STOCK, { k: 0.03 });
  r.add(roundCone([0, -0.02, 0.085], [0, -0.115, 0.13], 0.018, 0.016), STOCK, { k: 0.02 });
  r.add(roundBox([0, -0.015, -0.24], IDENT, 0.022, 0.024, 0.2, 0.016), STOCK, { k: 0.02 });
  r.add(torus([0, -0.042, 0.045], eulerRot(0, 0, Math.PI / 2), 0.02, 0.004), METAL, { k: 0.003 });
  // receiver, bolt handle, magazine
  r.add(roundBox([0, 0.018, -0.02], IDENT, 0.02, 0.022, 0.12, 0.012), METAL, { k: 0.006 });
  r.add(roundBox([0, -0.048, -0.04], RX(0.1), 0.015, 0.03, 0.034, 0.006), DARK, { k: 0.004 });
  // barrel and suppressor
  r.add(roundCone([0, RIFLE_BORE_Y, -0.14], [0, RIFLE_BORE_Y, -0.71], 0.012, 0.0105), METAL, { k: 0.004 });
  r.add(roundCone([0, RIFLE_BORE_Y, -0.69], [0, RIFLE_BORE_Y, -0.865], 0.021, 0.021), DARK, { k: 0.006 });
  // scope: eyepiece, tube, objective bell, turrets, rings, lens
  const sy = RIFLE_SCOPE_Y;
  r.add(roundCone([0, sy, 0.115], [0, sy, 0.06], 0.021, 0.016), DARK, { k: 0.01 });
  r.add(roundCone([0, sy, 0.06], [0, sy, -0.2], 0.0155, 0.0155), DARK, { k: 0.008 });
  r.add(roundCone([0, sy, -0.2], [0, sy, -0.295], 0.016, 0.028), DARK, { k: 0.012 });
  r.add(roundCone([0, sy + 0.012, -0.07], [0, sy + 0.03, -0.07], 0.011, 0.011), METAL, { k: 0.004 });
  r.add(roundCone([0.012, sy, -0.07], [0.03, sy, -0.07], 0.0095, 0.0095), METAL, { k: 0.004 });
  for (const z of [0.0, -0.13]) r.add(roundBox([0, 0.05, z], IDENT, 0.011, 0.02, 0.011, 0.004), METAL, { k: 0.004 });
  r.add(ellipsoid([0, sy, -0.297], IDENT, 0.024, 0.024, 0.004), LENS, { k: 0.002 });
  // folded bipod under the fore-end
  r.add(roundBox([0, -0.043, -0.415], IDENT, 0.018, 0.01, 0.013, 0.004), METAL, { k: 0.004 });
  for (const s of [1, -1]) r.add(roundCone([s * 0.012, -0.048, -0.41], [s * 0.012, -0.05, -0.2], 0.0055, 0.0045), METAL, { k: 0.003 });
  // burlap wraps on the barrel, the suppressor and the stock's wrist
  const wraps = [[-0.5, 0.014], [-0.56, 0.0135], [-0.62, 0.013], [-0.75, 0.024], [-0.8, 0.024]];
  for (const [z, ra] of wraps) r.add(torus([0, RIFLE_BORE_Y, z], RX(Math.PI / 2), ra, 0.0065), BURLAP, { k: 0.006 });
  r.add(torus([0, -0.016, 0.155], RX(Math.PI / 2 - 0.1), 0.024, 0.008), BURLAP, { k: 0.008 });
  r.add(torus([0, -0.016, 0.19], RX(Math.PI / 2 - 0.12), 0.025, 0.008), BURLAP, { k: 0.008 });
  // the lens: teal in the middle, a bright rim of light (realistic: dark, a faint green coating)
  r.paint((x, y, z, c) => {
    if (c[4] > 0.2) return;
    const t = smooth(0.2, 1.0, Math.hypot(x, y - sy) / 0.024);
    if (real) { c[0] = 0.01 + 0.08 * t; c[1] = 0.02 + 0.12 * t; c[2] = 0.02 + 0.1 * t; return; }
    c[0] = 0.02 + 0.5 * t; c[1] = 0.12 + 0.45 * t; c[2] = 0.12 + 0.3 * t;
  });
  // a few leaves tucked into the wraps
  const rng = new RNG(99);
  const leaves = { pos: [], nrm: [], col: [], idx: [] };
  const spots = [...wraps.map(([z, ra]) => [z, RIFLE_BORE_Y, ra]), [0.155, -0.016, 0.03], [0.19, -0.016, 0.03]];
  for (let i = 0; i < 9; i++) {
    const [z, cy, ra] = spots[i % spots.length];
    const a = rng.float(-0.6, Math.PI + 0.6);
    const o = [Math.cos(a), Math.sin(a), 0];
    const root = [o[0] * ra, cy + o[1] * ra, z + rng.float(-0.008, 0.008)];
    const dir = [o[0] * 0.5, o[1] * 0.5, 0.86];   // out of the wrap and back toward the stock
    const dl = Math.hypot(...dir);
    pushFoldedLeaf(leaves, root, dir.map((v) => v / dl), o, rng.float(0.06, 0.09), rng.float(0.028, 0.036), LEAF_GREEN[rng.int(0, LEAF_GREEN.length - 1)], 0.2);
  }
  if (real) {
    // jute hanging from the wraps (the atlas material, as its own mesh)
    const anchors = [];
    const jr = new RNG(77);
    // from the wraps (their underside and sides), along the barrel and round the stock's wrist
    for (const [z, ra] of wraps) for (let i = 0; i < 3; i++) {
      const a = jr.float(-0.6, Math.PI + 0.6) + Math.PI;
      anchors.push({ p: [Math.cos(a) * ra, RIFLE_BORE_Y + Math.sin(a) * ra, z + jr.float(-0.01, 0.01)], n: [Math.cos(a), Math.sin(a), 0] });
    }
    for (let i = 0; i < 12; i++) {
      const z = jr.float(-0.86, -0.42), a = jr.float(-0.7, Math.PI + 0.7) + Math.PI, ra = z < -0.69 ? 0.022 : 0.013;
      anchors.push({ p: [Math.cos(a) * ra, RIFLE_BORE_Y + Math.sin(a) * ra, z], n: [Math.cos(a), Math.sin(a), 0] });
    }
    for (let i = 0; i < 7; i++) {
      const z = jr.float(0.13, 0.22), a = jr.float(-0.5, Math.PI + 0.5) + Math.PI;
      anchors.push({ p: [Math.cos(a) * 0.026, -0.016 + Math.sin(a) * 0.026, z], n: [Math.cos(a), Math.sin(a), 0] });
    }
    const strands = hangingJute(anchors, { seed: 5, L: [0.05, 0.15], w: [0.014, 0.026], tone: 0.62 });
    const [near, far] = rigidGeometry([r], [0.0008, 0.0045]);
    return { near, far, strands: plainStrands(strands) };
  }
  const [near, far] = rigidGeometry([r], [0.0008, 0.0045], leaves);
  return { near, far };
}

// { pos, nrm, uv, col, idx } as plain geometry
function plainStrands(o) {
  return {
    attributes: { position: [new Float32Array(o.pos), 3], normal: [new Float32Array(o.nrm), 3], uv: [new Float32Array(o.uv), 2], color: [new Float32Array(o.col), 3] },
    index: new Uint32Array(o.idx),
  };
}

// The bolt handle with its knob, in the bolt's own space (in first person it turns about the
// bore and slides back): the handle sticks out to the right. BOLT_AT: where it sits on the rifle.
export const BOLT_AT = [0.014, RIFLE_BORE_Y + 0.002, 0.069];
export function buildSculptedBolt() {
  const b = new SdfObject('bolt', { h: 0.0025 });
  b.add(roundCone([0.006, 0, 0.005], [0.04, -0.016, 0.012], 0.0055, 0.005), M(lin(0x3a3934), 0.55));
  b.add(ellipsoid([0.043, -0.018, 0.013], IDENT, 0.011, 0.011, 0.011), M(lin(0x272723), 0.62), { k: 0.003 });
  return rigidGeometry([b], 0.0004);
}

// ---------------------------------------------------------------- first person
// The player's own forearms for the viewmodel, in the rifle's space: camo sleeves from past the
// elbow, the same fingerless gloves (the right fist round the pistol grip, the left hand cupped
// under the fore-end) and folded leaves on the top and outer side of the sleeves.
// arms: [{ s, elbow, grip, axis, curl }]: grip is where the fist's hole goes, axis what it
// wraps round.
export function buildFirstPersonArms(arms, look = 'stylized') {
  const real = look === 'real';
  const objs = [];
  const leaves = { pos: [], nrm: [], col: [], idx: [] };
  const jute = [];
  const rng = new RNG(31);
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  for (const a of arms) {
    const k = real ? 1.0 : 1.1;
    const hole = [-a.s * 0.03 * k, -0.09 * k, 0];
    let W = a.grip.slice(), R = IDENT;
    for (let it = 0; it < 3; it++) {
      const y = norm([a.elbow[0] - W[0], a.elbow[1] - W[1], a.elbow[2] - W[2]]);
      const d = a.axis[0] * y[0] + a.axis[1] * y[1] + a.axis[2] * y[2];
      const z = norm([a.axis[0] - y[0] * d, a.axis[1] - y[1] * d, a.axis[2] - y[2] * d]);
      const x = cross(y, z);
      R = [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
      W = [0, 1, 2].map((i) => a.grip[i] - (R[i * 3] * hole[0] + R[i * 3 + 1] * hole[1] + R[i * 3 + 2] * hole[2]));
    }
    const P = (b, x, y, z) => [R[0] * x + R[1] * y + R[2] * z + W[0], R[3] * x + R[4] * y + R[5] * z + W[1], R[6] * x + R[7] * y + R[8] * z + W[2]];
    const Rb = (b, Rl = IDENT) => mul3(R, Rl);
    const gl = glove(P, Rb, 'hand', a.s, 0.0034, k, a.curl);
    gl.errK = 1.1;
    // the sleeve, a soft cuff under the glove's
    const sl = new SdfObject('sleeve', { h: 0.006 });
    const f = norm([W[0] - a.elbow[0], W[1] - a.elbow[1], W[2] - a.elbow[2]]);
    const back = [a.elbow[0] - f[0] * 0.12, a.elbow[1] - f[1] * 0.12, a.elbow[2] - f[2] * 0.12];
    sl.add(roundCone(back, a.elbow, 0.064, 0.06), UNI);
    sl.add(roundCone(a.elbow, [W[0] - f[0] * 0.01, W[1] - f[1] * 0.01, W[2] - f[2] * 0.01], 0.058, 0.044), UNI, { k: 0.03 });
    sl.errK = 1.5;
    objs.push(gl, sl);
    // leaves on the top and the outer side, pointing back along the arm and drooping
    // (realistic: jute hanging from the top, the outer side and underneath)
    const out = norm(cross(f, [0, 1, 0]).map((v) => v * a.s));
    if (real) {
      for (let i = 0; i < 80; i++) {
        const t = rng.float(0.0, 0.86);
        const c = [0, 1, 2].map((q) => a.elbow[q] + (W[q] - a.elbow[q]) * t);
        const ang = rng.float(-0.9, 2.6);
        const n = norm([0, 1, 2].map((q) => out[q] * Math.cos(ang) + [0, 1, 0][q] * Math.sin(ang)));
        const rr = 0.058 - 0.014 * t;
        jute.push({ p: [0, 1, 2].map((q) => c[q] + n[q] * (rr - 0.004)), n });
      }
      continue;
    }
    for (let i = 0; i < 26; i++) {
      const t = rng.float(0.05, 0.85);
      const c = [0, 1, 2].map((q) => a.elbow[q] + (W[q] - a.elbow[q]) * t);
      const ang = rng.float(0.35, 1.9);
      const n = norm([0, 1, 2].map((q) => out[q] * Math.cos(ang) + [0, 1, 0][q] * Math.sin(ang)));
      const rr = 0.058 - 0.014 * t;
      const root = [0, 1, 2].map((q) => c[q] + n[q] * (rr - 0.004));
      let dir = norm([-f[0] + rng.float(-0.3, 0.3), -f[1] - 0.5, -f[2] + rng.float(-0.3, 0.3)]);
      const dn = dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2];
      dir = norm([0, 1, 2].map((q) => dir[q] - n[q] * dn + n[q] * 0.3));
      const lc = rng.chance(0.15) ? LEAF_DRY[rng.int(0, LEAF_DRY.length - 1)] : LEAF_GREEN[rng.int(0, LEAF_GREEN.length - 1)];
      pushFoldedLeaf(leaves, root, dir, n, rng.float(0.06, 0.095), rng.float(0.028, 0.04), lc, 0.15);
    }
  }
  if (real) {
    // (toward the elbow: the forearms point away from the camera)
    return { solid: rigidGeometry(objs, 0.0006), strands: plainStrands(hangingJute(jute, { seed: 9, L: [0.08, 0.17], w: [0.022, 0.038], tone: 0.85, back: [0, 0, 1] })) };
  }
  const lv = {
    attributes: { position: [new Float32Array(leaves.pos), 3], normal: [new Float32Array(leaves.nrm), 3], color: [new Float32Array(leaves.col), 3] },
    index: new Uint32Array(leaves.idx),
  };
  return { solid: rigidGeometry(objs, 0.0006), leaves: lv };
}

// ---------------------------------------------------------------- everything at once
// The first-person arms, in the viewmodel rifle's space: the right fist round the sculpted
// rifle's pistol grip, the left hand cupped under its fore-end.
const FP_ARMS = {
  stylized: [
    { s: 1, elbow: [0.17, -0.28, 0.28], grip: [0, -0.052, 0.058], axis: [0, 0.904, -0.428], curl: [0.95, 1.45, 0.75] },
    { s: -1, elbow: [-0.17, -0.3, -0.02], grip: [0, -0.01, -0.31], axis: [0, 0, 1], curl: [0.6, 0.95, 0.55] },
  ],
  // the realistic look keeps its detailed first-person rifle (viewmodel.js): its pistol grip and
  // the underside of its handguard
  real: [
    { s: 1, elbow: [0.17, -0.28, 0.28], grip: [0, -0.056, 0.064], axis: [0, 0.949, -0.315], curl: [0.95, 1.45, 0.75] },
    { s: -1, elbow: [-0.17, -0.3, -0.02], grip: [0, 0.0, -0.31], axis: [0, 0, 1], curl: [0.55, 0.85, 0.5] },
  ],
};

// All the pieces of one look, 'stylized' (Ravine) or 'real' (call once the simplifier is
// ready): the sniper and the rifle in two levels of detail (the realistic rifle with its jute),
// the bolt handle, the first-person arms, and where the head is in the bind pose (face paint).
export function buildSniperPieces(BONES, look = 'stylized') {
  C = PALETTES[look] || STYLIZED;
  const t = [performance.now()];
  const sniper = buildSculptedSniper(BONES, { look });
  t.push(performance.now());
  const { near: rifle, far: rifleFar, strands: rifleStrands } = buildSculptedRifle(look);
  t.push(performance.now());
  const bolt = buildSculptedBolt(), fpArms = buildFirstPersonArms(FP_ARMS[look] || FP_ARMS.stylized, look);
  t.push(performance.now());
  sniper[0].stats.pieces = { sniper: Math.round(t[1] - t[0]), rifles: Math.round(t[2] - t[1]), fp: Math.round(t[3] - t[2]) };
  return { look, sniper, rifle, rifleFar, rifleStrands: rifleStrands || null, bolt, fpArms, head: bindFrames(BONES).head.t.slice() };
}

// every typed array's buffer, to hand them over from the worker without copying
export function transferables(pieces) {
  const out = new Set();
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (ArrayBuffer.isView(o)) { out.add(o.buffer); return; }
    for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v);
  };
  walk(pieces);
  return [...out];
}
