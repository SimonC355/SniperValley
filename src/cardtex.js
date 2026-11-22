// Card textures assembled on a canvas at load time: the ghillie atlas (sniperparts.js) and the
// leafy sprays of the broadleaf crowns (leafSpray below). Shared helpers: a drawable from any
// texture, colour bled into transparent texels, and mipmaps that keep the alpha coverage.
import * as THREE from 'three';
import { RNG } from './noise.js';

// an image, canvas or bitmap to draw; a DataTexture (rows bottom-up) is turned back into one
export function drawable(tex) {
  if (!tex || !tex.image) return null;
  const im = tex.image;
  if (typeof HTMLImageElement !== 'undefined' && im instanceof HTMLImageElement) return im;
  if (typeof ImageBitmap !== 'undefined' && im instanceof ImageBitmap) return im;
  if (typeof HTMLCanvasElement !== 'undefined' && im instanceof HTMLCanvasElement) return im;
  if (im.data && im.width) {
    const c = document.createElement('canvas');
    c.width = im.width; c.height = im.height;
    const id = c.getContext('2d').createImageData(im.width, im.height);
    const w = im.width * 4;
    for (let y = 0; y < im.height; y++) id.data.set(im.data.subarray((im.height - 1 - y) * w, (im.height - y) * w), y * w);
    c.getContext('2d').putImageData(id, 0, 0);
    return c;
  }
  return null;
}

// fill fully transparent texels with the region's average colour, so filtering never pulls
// in black (W: the row length of the data)
export function bleed(d, W, regions) {
  for (const r of regions) {
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * W + x) * 4;
      if (d[i + 3] > 128) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++; }
    }
    if (!n) continue;
    sr /= n; sg /= n; sb /= n;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * W + x) * 4;
      if (d[i + 3] < 8) { d[i] = sr; d[i + 1] = sg; d[i + 2] = sb; d[i + 3] = 0; }
    }
  }
}

// The mip chain of a W×H texture whose smaller levels keep the alpha coverage: plain averaging
// thins hair-like strands and small leaves into nothing at a distance, so in each smaller level
// the alpha of every region is scaled until as much of it passes the alpha test (thr) as at
// full size. Colour is averaged weighted by alpha.
export function coverageMips(d0, W, H, regions, thr) {
  const levels = [d0];
  const t = thr * 255;
  const coverage = (d, w, h, r, k, scale) => {
    let pass = 0, all = 0;
    const x0 = Math.min(w - 1, r.x >> k), y0 = Math.min(h - 1, r.y >> k);
    const x1 = Math.max(x0 + 1, Math.min(w, (r.x + r.w) >> k)), y1 = Math.max(y0 + 1, Math.min(h, (r.y + r.h) >> k));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { all++; if (d[(y * w + x) * 4 + 3] * scale > t) pass++; }
    return all ? pass / all : 0;
  };
  const want = regions.map((r) => coverage(d0, W, H, r, 0, 1));
  let prev = d0, w = W, h = H;
  for (let k = 1; w > 1 || h > 1; k++) {
    const mw = Math.max(1, w >> 1), mh = Math.max(1, h >> 1);
    const d = new Uint8ClampedArray(mw * mh * 4);
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let q = 0; q < 4; q++) {
        const sx = Math.min(w - 1, x * 2 + (q & 1)), sy = Math.min(h - 1, y * 2 + (q >> 1));
        const i = (sy * w + sx) * 4, al = prev[i + 3] + 1;
        r += prev[i] * al; g += prev[i + 1] * al; b += prev[i + 2] * al; a += prev[i + 3];
      }
      const o = (y * mw + x) * 4, wsum = a + 4;
      d[o] = r / wsum; d[o + 1] = g / wsum; d[o + 2] = b / wsum; d[o + 3] = a / 4;
    }
    // per region: the alpha scale that keeps its coverage (binary search)
    if (Math.min(mw, mh) >= 4) regions.forEach((r, ri) => {
      if (!want[ri]) return;
      let lo = 0.5, hi = 4;
      for (let it = 0; it < 14; it++) {
        const s = (lo + hi) / 2;
        if (coverage(d, mw, mh, r, k, s) < want[ri]) lo = s; else hi = s;
      }
      const s = (lo + hi) / 2;
      const x0 = r.x >> k, y0 = r.y >> k, x1 = Math.min(mw, (r.x + r.w) >> k), y1 = Math.min(mh, (r.y + r.h) >> k);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * mw + x) * 4 + 3; d[i] = Math.min(255, d[i] * s); }
    });
    levels.push(d);
    prev = d; w = mw; h = mh;
  }
  return levels;
}

// A DataTexture from canvas-ordered levels (rows top-down; flipped so the canvas top is v = 1)
export function mipTexture(levels, W, H) {
  const mips = levels.map((d, i) => {
    const w = Math.max(1, W >> i), h = Math.max(1, H >> i);
    const o = new Uint8Array(d.length);
    for (let y = 0; y < h; y++) o.set(d.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return { data: o, width: w, height: h };
  });
  const tex = new THREE.DataTexture(mips[0].data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = mips;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------- broadleaf sprays
// A broadleaf crown card is metres long, and one photo twig stretched over it made every leaf
// half a metre across: the crowns read as clumps of giant leaves. A spray is a branch drawn on
// the card instead: a stem from the card's base (its left edge, where the card sits on the
// crown) with side shoots, and the twig drawn many times, small, along them, so a card carries
// a branch's worth of leaves at their real size. Inner twigs are drawn first and darker.
const SPRAYS = new Map();
export function leafSpray(tex, { seed = 11, W = 1024, H = 512, scale = 0.36, shoots = 7, stem = '#4a3d2f', alphaTest = 0.42 } = {}) {
  if (SPRAYS.has(tex)) return SPRAYS.get(tex);
  const src = drawable(tex);
  if (!src || typeof document === 'undefined') return tex;
  const sw = src.width, sh = src.height;
  // the twig's own stem: the middle of its leftmost opaque column
  const probe = document.createElement('canvas');
  probe.width = sw; probe.height = sh;
  probe.getContext('2d').drawImage(src, 0, 0);
  const pd = probe.getContext('2d').getImageData(0, 0, sw, sh).data;
  let ay = sh / 2;
  for (let x = 0; x < sw * 0.25; x++) {
    let s = 0, n = 0;
    for (let y = 0; y < sh; y++) if (pd[(y * sw + x) * 4 + 3] > 128) { s += y; n++; }
    if (n) { ay = s / n; break; }
  }
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const rng = new RNG(seed);
  // the main stem: across the card, a gentle wave
  const ph = rng.float(0, 6.28);
  const stemAt = (u) => [u * W * 0.95, H * (0.5 + 0.05 * Math.sin(u * 2.4 + ph) - 0.05 * Math.sin(ph))];
  const line = (pts, w0, w1) => {
    g.strokeStyle = stem;
    g.lineCap = 'round';
    for (let i = 1; i < pts.length; i++) {
      g.lineWidth = w0 + (w1 - w0) * (i / (pts.length - 1));
      g.beginPath(); g.moveTo(...pts[i - 1]); g.lineTo(...pts[i]); g.stroke();
    }
  };
  // twigs to draw: [x, y, angle, scale, depth]
  const twigs = [];
  const mainPts = [];
  for (let i = 0; i <= 16; i++) mainPts.push(stemAt(i / 16));
  const shootLines = [];
  for (let i = 0; i < shoots * 2; i++) {
    const u = 0.1 + (i / (shoots * 2)) * 0.74 + rng.float(-0.02, 0.02);
    const side = i % 2 ? 1 : -1;
    const [x0, y0] = stemAt(u);
    const a = side * rng.float(0.45, 0.85);
    // shorter toward the tip, a little shorter at the very base
    const len = W * (0.3 - 0.2 * u) * rng.float(0.85, 1.15) * (u < 0.2 ? 0.85 : 1);
    const bend = side * rng.float(-0.25, 0.1);
    const pts = [];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6, aa = a + bend * t;
      pts.push([x0 + Math.cos(aa) * len * t, y0 + Math.sin(aa) * len * t]);
    }
    shootLines.push(pts);
    const end = pts[6], mid = pts[3];
    twigs.push([end[0], end[1], a + bend + rng.float(-0.2, 0.2), scale * rng.float(0.85, 1.12), rng.next()]);
    twigs.push([mid[0], mid[1], a + side * rng.float(0.2, 0.6), scale * rng.float(0.7, 0.95), rng.next() * 0.6]);
    if (rng.chance(0.6)) twigs.push([pts[1][0], pts[1][1], a - side * rng.float(0.3, 0.8), scale * rng.float(0.6, 0.85), rng.next() * 0.4]);
  }
  // the leader at the tip, and a few twigs straight on the main stem
  const tip = stemAt(0.86);
  twigs.push([tip[0], tip[1], rng.float(-0.12, 0.12), scale * 1.15, 1]);
  for (let i = 0; i < 4; i++) {
    const [x, y] = stemAt(rng.float(0.3, 0.8));
    twigs.push([x, y, (i % 2 ? 1 : -1) * rng.float(0.1, 0.35), scale * rng.float(0.7, 0.9), rng.next() * 0.5]);
  }
  line(mainPts, 7, 2);
  for (const pts of shootLines) line(pts, 3.2, 1.2);
  twigs.sort((p, q) => p[4] - q[4]);
  for (let [x, y, a, s, depth] of twigs) {
    const flip = rng.chance(0.5) ? -1 : 1;   // mirrored across its own stem
    // keep the whole twig on the card: shrink it, then turn it toward the stem
    const fits = () => {
      const c = Math.cos(a), si = Math.sin(a);
      for (const [px, py0] of [[0, -ay], [sw, -ay], [sw, sh - ay], [0, sh - ay]]) {
        const py = py0 * flip;
        const X = x + (px * c - py * si) * s, Y = y + (px * si + py * c) * s;
        if (X < 2 || X > W - 2 || Y < 2 || Y > H - 2) return false;
      }
      return true;
    };
    let ok = fits();
    for (let k = 0; k < 6 && !ok; k++) { if (k % 2) a *= 0.7; else s *= 0.88; ok = fits(); }
    if (!ok) continue;
    g.save();
    g.filter = `brightness(${(0.66 + 0.34 * depth).toFixed(3)}) saturate(${(0.92 + 0.16 * rng.next()).toFixed(3)}) hue-rotate(${rng.float(-6, 6).toFixed(1)}deg)`;
    g.translate(x, y);
    g.rotate(a);
    g.scale(s, s * flip);
    g.drawImage(src, 0, -ay);
    g.restore();
  }
  const d = g.getImageData(0, 0, W, H).data;
  const all = [{ x: 0, y: 0, w: W, h: H }];
  bleed(d, W, all);
  const out = mipTexture(coverageMips(d, W, H, all, alphaTest), W, H);
  out.wrapS = out.wrapT = THREE.ClampToEdgeWrapping;
  SPRAYS.set(tex, out);
  return out;
}
