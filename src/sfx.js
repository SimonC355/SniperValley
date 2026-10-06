// Gunshot sound synthesis into sample buffers (pure functions, no WebAudio).
//
// - Muzzle blast: a Friedlander blast wave (instant rise, ~1.5 ms positive phase, negative
//   phase), hot-gas turbulence noise, a low body, a ground reflection and a cluster of early
//   reflections from trees. No pitch sweeps: falling tones read as "something flying past".
// - Supersonic crack: the bullet's shock wave is an N-wave (instant rise to +p, linear fall to
//   -p, instant return to 0). It is what makes a whip crack: a sharp "PISK" heard before the
//   muzzle report when the bullet passes close. Its length grows slowly with miss distance.

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// one-pole low-pass in place (cutoff Hz)
function lowpass(buf, sr, hz) {
  const a = Math.exp(-2 * Math.PI * hz / sr);
  let y = 0;
  for (let i = 0; i < buf.length; i++) { y = (1 - a) * buf[i] + a * y; buf[i] = y; }
  return buf;
}

// one-pole high-pass in place
function highpass(buf, sr, hz) {
  const a = Math.exp(-2 * Math.PI * hz / sr);
  let y = 0, xPrev = 0;
  for (let i = 0; i < buf.length; i++) { const x = buf[i]; y = a * (y + x - xPrev); xPrev = x; buf[i] = y; }
  return buf;
}

// add src * gain into dst starting at sample `at`
function mixInto(dst, src, at, gain) {
  for (let i = 0; i < src.length && at + i < dst.length; i++) if (at + i >= 0) dst[at + i] += src[i] * gain;
}

function normalize(buf, peak = 0.95) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]));
  if (m > 0) for (let i = 0; i < buf.length; i++) buf[i] *= peak / m;
  return buf;
}

// Friedlander waveform p(t) = (1 - t/Td) e^(-b t/Td), sampled.
function friedlander(sr, Td, b, len) {
  const n = Math.floor(sr * len);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] = (1 - t / Td) * Math.exp(-b * t / Td);
  }
  return out;
}

// N-wave of duration T seconds (peak +1 .. -1).
function nWave(sr, T) {
  const n = Math.max(3, Math.round(sr * T));
  const out = new Float32Array(n + 1);
  for (let i = 0; i < n; i++) out[i] = 1 - (2 * i) / (n - 1);
  out[n] = 0;
  return out;
}

// Muzzle blast as heard close to the rifle (the shooter, or anyone within a few metres).
// Distance is applied at playback (filter, level, playback rate, reverb send).
export function muzzleBlast(sr, seed = 1) {
  const r = rng(seed);
  const len = 1.6;
  const out = new Float32Array(Math.floor(sr * len));
  // primary blast wave
  const Td = 0.0013 + r() * 0.0005;
  const blast = friedlander(sr, Td, 0.9, 0.03);
  mixInto(out, blast, 0, 1.0);
  // ground reflection (softer: the ground absorbs the top end)
  const refl = lowpass(Float32Array.from(blast), sr, 5000);
  mixInto(out, refl, Math.round(sr * (0.0042 + r() * 0.0015)), 0.6);
  // hot-gas turbulence: a bright burst that decays in ~8 ms
  const nz = new Float32Array(Math.floor(sr * 0.06));
  for (let i = 0; i < nz.length; i++) nz[i] = (r() * 2 - 1) * Math.exp(-(i / sr) / 0.008);
  highpass(nz, sr, 700);
  mixInto(out, nz, 0, 0.55);
  // body: a damped low thump (no pitch glide)
  const body = new Float32Array(Math.floor(sr * 0.35));
  const f1 = 62 + r() * 10, f2 = 140 + r() * 30;
  for (let i = 0; i < body.length; i++) {
    const t = i / sr;
    body[i] = Math.sin(2 * Math.PI * f1 * t) * Math.exp(-t / 0.07) * 0.6 + Math.sin(2 * Math.PI * f2 * t) * Math.exp(-t / 0.03) * 0.3;
  }
  // soften the attack of the sine so it doesn't click on its own
  for (let i = 0; i < Math.min(body.length, sr * 0.002); i++) body[i] *= i / (sr * 0.002);
  mixInto(out, body, 0, 0.5);
  // early reflections from trunks and the ground nearby: the "crackle" after a shot in a forest
  const tapSrc = lowpass(Float32Array.from(blast), sr, 3500);
  const taps = 26;
  for (let k = 0; k < taps; k++) {
    const t = 0.012 + Math.pow(r(), 1.6) * 0.32;
    const a = (0.12 + r() * 0.22) * Math.exp(-t / 0.11);
    mixInto(out, tapSrc, Math.round(sr * t), a);
  }
  // rolling rumble: low noise that swells and dies over ~1.2 s
  const rum = new Float32Array(Math.floor(sr * 1.5));
  let b = 0;
  for (let i = 0; i < rum.length; i++) {
    b = 0.985 * b + 0.015 * (r() * 2 - 1);
    const t = i / sr;
    rum[i] = b * Math.min(1, t / 0.03) * Math.exp(-t / 0.45);
  }
  lowpass(rum, sr, 320);
  normalize(rum, 1);
  mixInto(out, rum, Math.round(sr * 0.004), 0.16);
  return normalize(out, 0.95);
}

// Supersonic crack of a passing bullet. `miss` (metres from the bullet path) lengthens the
// N-wave a little; reflections give the whip-like "PISK-k-k".
export function supersonicCrack(sr, seed = 1, miss = 3) {
  const r = rng(seed);
  const out = new Float32Array(Math.floor(sr * 0.4));
  // the N-wave itself, about three times longer than physical so it carries through speakers
  const T = 0.0008 * Math.pow(Math.max(1, miss), 0.25) * (0.9 + r() * 0.2);
  const nw = nWave(sr, T);
  mixInto(out, nw, 0, 1.0);
  // ground reflection
  mixInto(out, lowpass(Float32Array.from(nw), sr, 7000), Math.round(sr * (0.0016 + r() * 0.002)), 0.7);
  // tearing sizzle right behind the shock (the "whip" texture)
  const nz = new Float32Array(Math.floor(sr * 0.04));
  for (let i = 0; i < nz.length; i++) nz[i] = (r() * 2 - 1) * Math.exp(-(i / sr) / 0.005);
  highpass(nz, sr, 2200);
  mixInto(out, nz, 0, 0.6);
  // a short mid-range "thwack" so it has weight, not just a tick
  const th = new Float32Array(Math.floor(sr * 0.03));
  const f = 900 + r() * 300;
  for (let i = 0; i < th.length; i++) { const t = i / sr; th[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.004); }
  mixInto(out, th, 0, 0.35);
  // slap echoes off trunks and the ground: k-k-k
  const tap = lowpass(Float32Array.from(nw), sr, 4500);
  for (let k = 0; k < 12; k++) {
    const t = 0.006 + Math.pow(r(), 1.3) * 0.14;
    mixInto(out, tap, Math.round(sr * t), (0.25 + r() * 0.25) * Math.exp(-t / 0.05));
  }
  return normalize(out, 0.95);
}
