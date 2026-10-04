// Procedural textures. Terrain/rock/bark/water textures are baked on the GPU into
// tileable render targets at load time; foliage cards are drawn with Canvas2D.
// (Used because CC0 asset hosts were not reachable from the build environment.)
import * as THREE from 'three';
import { RNG } from './noise.js';

const COMMON_GLSL = /* glsl */`
precision highp float;
precision highp int;
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
in vec2 vUv;
uniform float uSeed;

uvec4 pcg4d(uvec4 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  v ^= v >> 16u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  return v;
}
vec4 rand4(vec2 cell, float k) {
  uvec4 u = pcg4d(uvec4(uint(int(cell.x) + 4096), uint(int(cell.y) + 4096), uint(int(k * 7.0) + 17), uint(int(uSeed))));
  return vec4(u) / 4294967295.0;
}
vec2 gradv(vec2 c, float s) { float a = rand4(c, s).x * 6.2831853; return vec2(cos(a), sin(a)); }
float pnoise(vec2 p, vec2 per, float s) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 i00 = mod(i, per), i10 = mod(i + vec2(1.0, 0.0), per), i01 = mod(i + vec2(0.0, 1.0), per), i11 = mod(i + 1.0, per);
  float a = dot(gradv(i00, s), f);
  float b = dot(gradv(i10, s), f - vec2(1.0, 0.0));
  float c = dot(gradv(i01, s), f - vec2(0.0, 1.0));
  float d = dot(gradv(i11, s), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.45;
}
float pfbm(vec2 p, vec2 per, int oct, float s) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    sum += amp * pnoise(p, per, s + float(i) * 3.0);
    norm += amp; p *= 2.0; per *= 2.0; amp *= 0.5;
  }
  return sum / norm;
}
// returns F1, F2, cell id
vec3 pworley(vec2 p, vec2 per, float s) {
  vec2 ip = floor(p), fp = fract(p);
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = ip + vec2(float(i), float(j));
    vec4 r = rand4(mod(c, per), s);
    vec2 d = vec2(float(i), float(j)) + r.xy - fp;
    float dd = dot(d, d);
    if (dd < f1) { f2 = f1; f1 = dd; id = r.z; } else if (dd < f2) { f2 = dd; }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}
// Scattered tapered strokes (blades, needles, twigs). Returns height, id, along-param.
vec3 strokes(vec2 uv, float cells, float len, float wid, float s, float dirBias, float dirSpread) {
  vec2 p = uv * cells;
  vec2 ip = floor(p);
  float best = 0.0, bid = 0.0, bt = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = ip + vec2(float(i), float(j));
    vec2 cw = mod(c, vec2(cells));
    for (int k = 0; k < 3; k++) {
      vec4 r = rand4(cw, s + float(k) * 11.0);
      vec2 center = c + r.xy;
      float ang = dirBias + (r.z - 0.5) * dirSpread;
      vec2 d = vec2(cos(ang), sin(ang));
      float L = len * (0.55 + 0.9 * r.w);
      vec2 q = p - center;
      float t = clamp(dot(q, d) / L, -0.5, 0.5);
      float dist = length(q - d * t * L);
      float w = wid * (1.0 - abs(t) * 1.5);
      float cov = smoothstep(w, w * 0.25, dist);
      float hh = cov * (0.55 + 0.45 * fract(r.w * 7.31)) * (1.0 - 0.6 * abs(t));
      if (hh > best) { best = hh; bid = fract(r.x * 13.1 + r.y * 7.3); bt = t; }
    }
  }
  return vec3(best, bid, bt);
}
`;

const BAKE_VERT = /* glsl */`
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// ----------------------------------------------------------------- material bakes
// Each returns vec4(linear albedo, height)
const GRASS_FRAG = /* glsl */`
vec4 bake(vec2 uv) {
  float n1 = pfbm(uv * 3.0, vec2(3.0), 4, 1.0);
  float n2 = pfbm(uv * 11.0, vec2(11.0), 3, 9.0);
  vec3 soil = vec3(0.075, 0.058, 0.035);
  vec3 cA = vec3(0.085, 0.13, 0.035);
  vec3 cB = vec3(0.17, 0.2, 0.06);
  vec3 cDry = vec3(0.28, 0.23, 0.11);
  vec3 base = mix(cA, cB, smoothstep(-0.35, 0.45, n1));
  base = mix(base, cDry, smoothstep(0.15, 0.65, n2) * 0.55);
  vec3 s1 = strokes(uv, 38.0, 0.9, 0.09, 3.0, 1.2, 2.2);
  vec3 s2 = strokes(uv, 64.0, 0.8, 0.11, 21.0, 1.6, 2.6);
  vec3 s3 = strokes(uv, 20.0, 0.7, 0.07, 41.0, 0.6, 6.28);
  float h = max(max(s1.x, s2.x * 0.85), s3.x * 0.7);
  float id = s1.x >= s2.x ? s1.y : s2.y;
  vec3 blade = base * (0.75 + 0.6 * id);
  blade = mix(blade, cDry * 1.1, step(0.86, id) * 0.8);
  float tipLight = 1.0 + 0.25 * (s1.z + 0.5);
  vec3 col = mix(soil, blade * tipLight, smoothstep(0.02, 0.25, h));
  float clover = smoothstep(0.12, 0.05, pworley(uv * 26.0, vec2(26.0), 61.0).x) * step(0.55, pnoise(uv * 7.0, vec2(7.0), 71.0) + 0.5);
  col = mix(col, vec3(0.06, 0.12, 0.03), clover * 0.8);
  h = max(h, clover * 0.6);
  return vec4(col, h);
}
`;

const FOREST_FRAG = /* glsl */`
vec4 bake(vec2 uv) {
  float n1 = pfbm(uv * 4.0, vec2(4.0), 4, 2.0);
  vec3 soil = mix(vec3(0.05, 0.035, 0.022), vec3(0.09, 0.06, 0.035), n1 * 0.5 + 0.5);
  vec3 a = strokes(uv, 44.0, 1.2, 0.05, 5.0, 0.0, 6.28);
  vec3 b = strokes(uv, 30.0, 1.25, 0.055, 15.0, 0.0, 6.28);
  vec3 c = strokes(uv, 70.0, 1.1, 0.06, 25.0, 0.0, 6.28);
  vec3 twig = strokes(uv, 7.0, 1.3, 0.035, 35.0, 0.0, 6.28);
  float h = max(max(a.x, b.x * 0.9), c.x * 0.75);
  float id = a.x > b.x ? a.y : b.y;
  vec3 needleOld = vec3(0.24, 0.12, 0.05);
  vec3 needleDry = vec3(0.33, 0.21, 0.1);
  vec3 needleDark = vec3(0.12, 0.07, 0.035);
  vec3 nc = mix(needleDark, needleOld, smoothstep(0.1, 0.6, id));
  nc = mix(nc, needleDry, smoothstep(0.75, 0.95, id));
  vec3 col = mix(soil, nc, smoothstep(0.03, 0.3, h));
  float tw = twig.x * step(0.6, twig.y);
  col = mix(col, vec3(0.1, 0.07, 0.045), smoothstep(0.2, 0.5, tw));
  h = max(h, tw * 1.1);
  // moss patches
  float m = smoothstep(0.15, 0.45, pfbm(uv * 5.0, vec2(5.0), 4, 51.0));
  float mossDetail = pfbm(uv * 60.0, vec2(60.0), 2, 57.0);
  vec3 moss = mix(vec3(0.07, 0.11, 0.025), vec3(0.15, 0.19, 0.05), mossDetail * 0.5 + 0.5);
  col = mix(col, moss, m * (1.0 - smoothstep(0.5, 0.9, h)) * 0.85);
  h = max(h, m * (0.35 + 0.15 * mossDetail));
  // cones
  vec3 w = pworley(uv * 9.0, vec2(9.0), 77.0);
  float cone = smoothstep(0.16, 0.1, w.x) * step(0.82, w.z);
  col = mix(col, vec3(0.16, 0.09, 0.045) * (0.7 + 0.6 * fract(w.x * 40.0)), cone);
  h = max(h, cone * (1.0 - w.x * 4.0));
  return vec4(col, h);
}
`;

const ROCK_FRAG = /* glsl */`
vec4 bake(vec2 uv) {
  float n1 = pfbm(uv * 3.0, vec2(3.0), 6, 4.0);
  float n2 = pfbm(uv * 9.0, vec2(9.0), 4, 14.0);
  // domain-warped cracks so they don't read as regular cells
  vec2 warp = vec2(pfbm(uv * 4.0, vec2(4.0), 3, 70.0), pfbm(uv * 4.0 + 0.37, vec2(4.0), 3, 80.0));
  vec3 w = pworley(uv * 4.0 + warp * 0.9, vec2(4.0), 24.0);
  vec3 w2 = pworley(uv * 11.0 + warp * 1.6, vec2(11.0), 34.0);
  float gate = smoothstep(-0.05, 0.25, pnoise(uv * 6.0, vec2(6.0), 90.0));
  float crack = (1.0 - smoothstep(0.0, 0.03, w.y - w.x)) * gate;
  float crack2 = (1.0 - smoothstep(0.0, 0.02, w2.y - w2.x)) * (1.0 - gate) * 0.7;
  // faint strata
  float strata = sin((uv.y * 7.0 + n1 * 1.2) * 6.2831853) * 0.5 + 0.5;
  vec3 g1 = vec3(0.24, 0.22, 0.19);
  vec3 g2 = vec3(0.36, 0.33, 0.29);
  vec3 g3 = vec3(0.19, 0.18, 0.16);
  vec3 col = mix(g1, g2, smoothstep(-0.4, 0.5, n1));
  col = mix(col, g3, smoothstep(0.1, 0.6, n2) * 0.45);
  col *= 0.9 + 0.12 * strata;
  float grain = pnoise(uv * 180.0, vec2(180.0), 44.0);
  float speck = step(0.82, pnoise(uv * 90.0, vec2(90.0), 45.0) * 0.5 + 0.5);
  col *= 0.9 + 0.12 * grain;
  col = mix(col, vec3(0.42, 0.4, 0.37), speck * 0.25);
  float h = 0.55 + 0.32 * n1 + 0.12 * n2 + strata * 0.04 - crack * 0.4 - crack2 * 0.18 + grain * 0.025;
  col *= 1.0 - crack * 0.5 - crack2 * 0.25;
  // lichen
  vec3 lw = pworley(uv * 22.0, vec2(22.0), 54.0);
  float lichen = smoothstep(0.42, 0.3, lw.x) * step(0.7, lw.z) * smoothstep(0.0, 0.3, pnoise(uv * 4.0, vec2(4.0), 64.0) + 0.2);
  col = mix(col, mix(vec3(0.4, 0.4, 0.24), vec3(0.46, 0.46, 0.42), fract(lw.z * 9.0)), lichen * 0.75);
  h += lichen * 0.04;
  return vec4(col, clamp(h, 0.0, 1.0));
}
`;

const MUD_FRAG = /* glsl */`
vec4 bake(vec2 uv) {
  float n1 = pfbm(uv * 4.0, vec2(4.0), 5, 6.0);
  vec3 silt = mix(vec3(0.06, 0.05, 0.035), vec3(0.11, 0.09, 0.06), n1 * 0.5 + 0.5);
  vec3 w = pworley(uv * 22.0, vec2(22.0), 16.0);
  float peb = smoothstep(0.5, 0.22, w.x) * step(0.45, w.z);
  vec3 pc = mix(vec3(0.11, 0.1, 0.085), vec3(0.21, 0.19, 0.16), fract(w.z * 17.0));
  vec3 w2 = pworley(uv * 40.0, vec2(40.0), 26.0);
  float peb2 = smoothstep(0.5, 0.2, w2.x) * step(0.6, w2.z);
  vec3 col = mix(silt, pc, peb);
  col = mix(col, pc * 0.8, peb2 * (1.0 - peb));
  float h = max(peb * (1.0 - w.x * w.x * 2.5), peb2 * 0.5 * (1.0 - w2.x)) + n1 * 0.08;
  return vec4(col, clamp(h, 0.0, 1.0));
}
`;

const BARK_FRAG = /* glsl */`
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uPlates;
vec4 bake(vec2 uv) {
  // spruce: fine vertical fissures + small scales; pine: elongated plates with deep cracks
  float warp = pfbm(uv * vec2(3.0, 5.0), vec2(3.0, 5.0), 3, 3.0);
  float r = pfbm(vec2(uv.x * 12.0 + warp * 0.9, uv.y * 2.0), vec2(12.0, 2.0), 4, 13.0);
  float fiss = 1.0 - smoothstep(0.03, 0.16, abs(r));
  vec3 sc = pworley(uv * vec2(14.0, 9.0), vec2(14.0, 9.0), 23.0);
  float scale = smoothstep(0.0, 0.18, sc.y - sc.x);
  float hS = 0.65 - fiss * 0.55 + scale * 0.25 + sc.z * 0.1;
  vec3 pl = pworley(vec2(uv.x * 7.0 + warp * 0.4, uv.y * 4.0), vec2(7.0, 4.0), 33.0);
  float edge = smoothstep(0.0, 0.1, pl.y - pl.x);
  float hP = edge * (0.7 + 0.3 * pl.z) - (1.0 - edge) * 0.2;
  float h = mix(hS, hP, uPlates);
  float n = pfbm(uv * vec2(16.0, 32.0), vec2(16.0, 32.0), 3, 43.0);
  vec3 col = mix(uColA, uColB, clamp(h * 0.85 + n * 0.25 + (uPlates > 0.5 ? pl.z * 0.25 : sc.z * 0.15), 0.0, 1.0));
  col *= 0.7 + 0.4 * clamp(h, 0.0, 1.0);
  // lichen / moss streaks on spruce
  float moss = smoothstep(0.3, 0.6, pfbm(uv * vec2(2.0, 3.0), vec2(2.0, 3.0), 3, 53.0)) * (1.0 - uPlates);
  col = mix(col, vec3(0.16, 0.18, 0.1), moss * 0.45 * (1.0 - fiss));
  return vec4(col, clamp(h + n * 0.06, 0.0, 1.0));
}
`;

const WATER_FRAG = /* glsl */`
vec4 bake(vec2 uv) {
  float h = pfbm(uv * 6.0, vec2(6.0), 5, 8.0) * 0.6 + pfbm(uv * vec2(16.0, 10.0), vec2(16.0, 10.0), 3, 18.0) * 0.4;
  return vec4(vec3(0.5), h * 0.5 + 0.5);
}
`;

const MACRO_FRAG = /* glsl */`
vec4 bake(vec2 uv) {
  float a = pfbm(uv * 3.0, vec2(3.0), 5, 2.0) * 0.5 + 0.5;
  float b = pfbm(uv * 11.0, vec2(11.0), 4, 12.0) * 0.5 + 0.5;
  float c = pfbm(uv * 37.0, vec2(37.0), 3, 22.0) * 0.5 + 0.5;
  float d = pworley(uv * 20.0, vec2(20.0), 32.0).x;
  return vec4(a, b, c, d);
}
`;

const NORMAL_FRAG = /* glsl */`
precision highp float;
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
in vec2 vUv;
uniform sampler2D tSrc;
uniform float uStrength;
uniform float uTexel;
uniform float uRoughBase;
uniform float uRoughVar;
float H(vec2 o) { return textureLod(tSrc, vUv + o * uTexel, 0.0).a; }
void main() {
  float tl = H(vec2(-1, 1)), t = H(vec2(0, 1)), tr = H(vec2(1, 1));
  float l = H(vec2(-1, 0)), r = H(vec2(1, 0));
  float bl = H(vec2(-1, -1)), b = H(vec2(0, -1)), br = H(vec2(1, -1));
  float dx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float dy = (tl + 2.0 * t + tr) - (bl + 2.0 * b + br);
  vec3 n = normalize(vec3(-dx * uStrength, -dy * uStrength, 1.0));
  float h = H(vec2(0.0));
  gl_FragColor = vec4(n * 0.5 + 0.5, clamp(uRoughBase + (0.5 - h) * uRoughVar, 0.0, 1.0));
}
`;

export class TextureBaker {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.targets = [];
  }

  _target(size, srgb, mipmaps = true) {
    const rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      generateMipmaps: mipmaps,
      minFilter: mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
    });
    rt.texture.anisotropy = this.maxAniso;
    this.targets.push(rt);
    return rt;
  }

  _render(material, rt) {
    this.quad.material = material;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
    material.dispose();
  }

  // Bakes albedo(+height in alpha) and normal(+roughness in alpha).
  bakeMaterial(bakeGLSL, { size = 1024, seed = 1, normalStrength = 3, roughBase = 0.85, roughVar = 0.2, uniforms = {}, srgb = true } = {}) {
    const albedo = this._target(size, srgb);
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: BAKE_VERT,
      fragmentShader: COMMON_GLSL + bakeGLSL + `\nvoid main(){ gl_FragColor = bake(vUv); }`,
      uniforms: { uSeed: { value: seed }, ...uniforms },
      depthTest: false, depthWrite: false,
    });
    this._render(mat, albedo);
    const normal = this._target(size, false);
    const nmat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: BAKE_VERT,
      fragmentShader: NORMAL_FRAG,
      uniforms: {
        tSrc: { value: albedo.texture },
        uStrength: { value: normalStrength },
        uTexel: { value: 1 / size },
        uRoughBase: { value: roughBase },
        uRoughVar: { value: roughVar },
      },
      depthTest: false, depthWrite: false,
    });
    this._render(nmat, normal);
    return { map: albedo.texture, normalMap: normal.texture, dispose() { albedo.dispose(); normal.dispose(); } };
  }

  bakeData(bakeGLSL, size, seed = 1) {
    const rt = this._target(size, false);
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: BAKE_VERT,
      fragmentShader: COMMON_GLSL + bakeGLSL + `\nvoid main(){ gl_FragColor = bake(vUv); }`,
      uniforms: { uSeed: { value: seed } },
      depthTest: false, depthWrite: false,
    });
    this._render(mat, rt);
    return rt.texture;
  }
}

// ----------------------------------------------------------------- canvas foliage

function dataTextureFromCanvas(canvas, fillRGB, { srgb = true } = {}) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  // Bleed colour into transparent texels so mipmaps don't produce dark fringes.
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) { d[i] = fillRGB[0]; d[i + 1] = fillRGB[1]; d[i + 2] = fillRGB[2]; d[i + 3] = 0; }
  }
  // Flip vertically so canvas top = v 1.
  const w = canvas.width, h = canvas.height;
  const out = new Uint8Array(d.length);
  for (let y = 0; y < h; y++) {
    out.set(d.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// Foliage cards are drawn in a w x h coordinate space at 2x resolution.
const CANVAS_SCALE = 2;
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w * CANVAS_SCALE; c.height = h * CANVAS_SCALE;
  c.getContext('2d').scale(CANVAS_SCALE, CANVAS_SCALE);
  return c;
}

function rgb(r, g, b, a = 1) { return `rgba(${r | 0},${g | 0},${b | 0},${a})`; }

// Spruce / fir branch spray. Card u: trunk(0) -> tip(1), v across.
// Drawn in three passes: a solid "mass" along every twig (gives coverage at distance),
// then individual needles for a ragged edge, then lighter young growth at the tips.
function drawSpray(rng, w, h, palette) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const midY = h / 2;
  const N = 40;
  const main = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    main.push([6 + t * (w - 16), midY + Math.sin(t * 2.4) * h * 0.035]);
  }
  const twigs = [{ pts: main, main: true, t0: 0 }];
  for (let i = 3; i < N - 2; i += 3) {
    const [x, y] = main[i];
    const t = i / N;
    for (const side of [-1, 1]) {
      if (rng.chance(0.08)) continue;
      const ang = side * (0.62 + rng.float(-0.12, 0.2));
      const L = (1 - t * 0.72) * h * rng.float(0.34, 0.44);
      const sp = [];
      for (let k = 0; k <= 8; k++) {
        const u = k / 8;
        sp.push([x + Math.cos(ang) * L * u + u * u * 5, y + Math.sin(ang) * L * u * (1 - u * 0.15)]);
      }
      twigs.push({ pts: sp, main: false, t0: t });
      // sub twigs
      for (let k = 3; k < 8; k += 2) {
        const [sx, sy] = sp[k];
        const a2 = ang + side * rng.float(0.5, 0.8) * (rng.chance(0.5) ? 1 : -1) * 0.8;
        const L2 = L * 0.32 * (1 - k / 10);
        twigs.push({ pts: [[sx, sy], [sx + Math.cos(a2) * L2 * 0.5 + 2, sy + Math.sin(a2) * L2 * 0.5], [sx + Math.cos(a2) * L2 + 3, sy + Math.sin(a2) * L2]], main: false, t0: t, sub: true });
      }
    }
  }
  const path = (P) => { ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]); for (const p of P) ctx.lineTo(p[0], p[1]); };
  // pass 1: mass
  for (const tw of twigs) {
    const m = palette.mass;
    ctx.strokeStyle = rgb(m[0], m[1], m[2]);
    ctx.lineWidth = tw.main ? 24 : tw.sub ? 9 : 15 * (1 - tw.t0 * 0.45);
    path(tw.pts); ctx.stroke();
  }
  // twig wood
  for (const tw of twigs) {
    ctx.strokeStyle = rgb(62, 44, 28);
    ctx.lineWidth = tw.main ? 3 : 1.4;
    path(tw.pts); ctx.stroke();
  }
  // pass 2: needles
  for (const tw of twigs) {
    const P = tw.pts;
    for (let i = 1; i < P.length; i++) {
      const [x0, y0] = P[i - 1];
      const [x1, y1] = P[i];
      const dirA = Math.atan2(y1 - y0, x1 - x0);
      const segLen = Math.hypot(x1 - x0, y1 - y0);
      const steps = Math.max(1, Math.round(segLen / 2.0));
      const tip = i / P.length;
      for (let s2 = 0; s2 < steps; s2++) {
        const f = s2 / steps;
        const x = x0 + (x1 - x0) * f, y = y0 + (y1 - y0) * f;
        for (const side of [-1, 1]) {
          const a = dirA + side * rng.float(0.55, 1.2);
          const L = (tw.main ? rng.float(12, 19) : tw.sub ? rng.float(6, 10) : rng.float(9, 14)) * (1 - tip * 0.2);
          const young = tip > 0.7 && !tw.main && rng.chance(0.55);
          const col = young ? palette.young : palette.needles[rng.int(0, palette.needles.length - 1)];
          const k = rng.float(0.82, 1.15);
          ctx.strokeStyle = rgb(col[0] * k, col[1] * k, col[2] * k);
          ctx.lineWidth = rng.float(1.6, 2.6);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L);
          ctx.stroke();
        }
      }
    }
  }
  return c;
}

// Pine: long needle tufts at twig ends.
function drawPineTufts(rng, w, h) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.lineCap = 'round';
  const midY = h / 2;
  const tufts = [];
  ctx.strokeStyle = rgb(80, 52, 32);
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(6, midY);
  ctx.quadraticCurveTo(w * 0.5, midY + 8, w - 40, midY - 10);
  ctx.stroke();
  for (let i = 0; i < 9; i++) {
    const t = 0.25 + i * 0.085;
    const x = 6 + t * (w - 46);
    const y = midY + Math.sin(t * 3) * 6;
    const side = i % 2 ? -1 : 1;
    const ex = x + rng.float(20, 50);
    const ey = y + side * rng.float(25, h * 0.32);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
    tufts.push([ex, ey]);
  }
  tufts.push([w - 40, midY - 10]);
  for (const [tx, ty] of tufts) {
    ctx.fillStyle = rgb(40, 58, 26);
    ctx.beginPath(); ctx.arc(tx, ty, 22, 0, Math.PI * 2); ctx.fill();
  }
  for (const [tx, ty] of tufts) {
    const n = 110;
    for (let k = 0; k < n; k++) {
      const a = rng.float(0, Math.PI * 2);
      const L = rng.float(18, 42);
      const g = rng.float(0.8, 1.2);
      ctx.strokeStyle = rgb(62 * g, 88 * g, 38 * g);
      ctx.lineWidth = rng.float(1.1, 1.8);
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.quadraticCurveTo(tx + Math.cos(a) * L * 0.5, ty + Math.sin(a) * L * 0.5 - 3, tx + Math.cos(a) * L, ty + Math.sin(a) * L);
      ctx.stroke();
    }
  }
  return c;
}

function drawFern(rng, w, h) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.lineCap = 'round';
  const cx = w / 2;
  ctx.strokeStyle = rgb(70, 90, 35);
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(cx, h); ctx.quadraticCurveTo(cx + 6, h * 0.5, cx, 6); ctx.stroke();
  const pinnae = 22;
  for (let i = 0; i < pinnae; i++) {
    const t = i / pinnae;
    const y = h - 20 - t * (h - 30);
    const L = Math.sin(Math.min(1, (1 - t) * 1.3) * Math.PI * 0.9) * w * 0.46 + 6;
    for (const side of [-1, 1]) {
      const g = rng.float(0.85, 1.15);
      const ex = cx + side * L;
      const ey = y - L * 0.25;
      // leaflet as a series of small lobes
      const lobes = Math.max(3, Math.round(L / 7));
      for (let k = 0; k < lobes; k++) {
        const u = k / lobes;
        const lx = cx + (ex - cx) * u, ly = y + (ey - y) * u;
        const r = (1 - u) * 6 + 2.5;
        ctx.fillStyle = rgb(60 * g, 100 * g, 34 * g);
        ctx.beginPath();
        ctx.ellipse(lx, ly, r, r * 1.6, side * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  return c;
}

function drawLeaves(rng, w, h) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  for (let i = 0; i < 70; i++) {
    const x = rng.float(40, w - 40), y = rng.float(40, h - 40);
    const dx = x - w / 2, dy = y - h / 2;
    if (dx * dx + dy * dy > (w * 0.45) ** 2) continue;
    const a = rng.float(0, Math.PI * 2);
    const L = rng.float(22, 36);
    const g = rng.float(0.75, 1.2);
    const yellow = rng.chance(0.12);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.fillStyle = yellow ? rgb(120 * g, 110 * g, 40 * g) : rgb(55 * g, 85 * g, 30 * g);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(L * 0.5, -L * 0.32, L, 0);
    ctx.quadraticCurveTo(L * 0.5, L * 0.32, 0, 0);
    ctx.fill();
    ctx.strokeStyle = rgb(40 * g, 60 * g, 22 * g);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(L * 0.9, 0); ctx.stroke();
    ctx.restore();
  }
  return c;
}

// Ghillie strips atlas: 8 columns. Grey-scale albedo, tinted per strip.
function drawGhillie(rng, w, h) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.lineCap = 'round';
  const cols = 8, cw = w / cols;
  for (let col = 0; col < cols; col++) {
    const x0 = col * cw;
    const type = col < 4 ? 'burlap' : col < 6 ? 'leaf' : 'grass';
    if (type === 'burlap') {
      const strands = 16;
      for (let s = 0; s < strands; s++) {
        const sx = x0 + 6 + rng.float(0, cw - 12);
        const len = rng.float(0.55, 1.0) * h;
        const v = rng.float(150, 235);
        ctx.strokeStyle = rgb(v, v * 0.97, v * 0.9);
        ctx.lineWidth = rng.float(2, 5);
        ctx.beginPath();
        ctx.moveTo(sx, 0);
        let x = sx;
        for (let y = 0; y < len; y += 16) {
          x += rng.float(-3, 3);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    } else if (type === 'leaf') {
      ctx.fillStyle = rgb(200, 200, 190);
      ctx.beginPath();
      ctx.moveTo(x0 + cw * 0.5, 0);
      const pts = 14;
      for (let i = 0; i <= pts; i++) {
        const t = i / pts;
        const wid = Math.sin(t * Math.PI) * cw * 0.45 * (i % 2 ? 0.7 : 1);
        ctx.lineTo(x0 + cw * 0.5 + wid, t * h);
      }
      for (let i = pts; i >= 0; i--) {
        const t = i / pts;
        const wid = Math.sin(t * Math.PI) * cw * 0.45 * (i % 2 ? 1 : 0.7);
        ctx.lineTo(x0 + cw * 0.5 - wid, t * h);
      }
      ctx.fill();
      ctx.strokeStyle = rgb(150, 150, 140);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x0 + cw * 0.5, 0); ctx.lineTo(x0 + cw * 0.5, h); ctx.stroke();
    } else {
      for (let s = 0; s < 22; s++) {
        const sx = x0 + cw * 0.5 + rng.float(-cw * 0.2, cw * 0.2);
        const ex = x0 + rng.float(4, cw - 4);
        const len = rng.float(0.5, 1.0) * h;
        const v = rng.float(160, 230);
        ctx.strokeStyle = rgb(v, v, v * 0.85);
        ctx.lineWidth = rng.float(1.5, 3);
        ctx.beginPath(); ctx.moveTo(sx, 0); ctx.quadraticCurveTo(sx, len * 0.5, ex, len); ctx.stroke();
      }
    }
  }
  return c;
}

export function createTextures(renderer, seed = 1) {
  const baker = new TextureBaker(renderer);
  const t = {};
  t.grass = baker.bakeMaterial(GRASS_FRAG, { seed: seed + 1, normalStrength: 2.5, roughBase: 0.9, roughVar: 0.1 });
  t.forest = baker.bakeMaterial(FOREST_FRAG, { seed: seed + 2, normalStrength: 3.5, roughBase: 0.92, roughVar: 0.1 });
  t.rock = baker.bakeMaterial(ROCK_FRAG, { seed: seed + 3, normalStrength: 3.2, roughBase: 0.82, roughVar: 0.2 });
  t.mud = baker.bakeMaterial(MUD_FRAG, { seed: seed + 4, normalStrength: 2.2, roughBase: 0.74, roughVar: 0.2 });
  t.barkSpruce = baker.bakeMaterial(BARK_FRAG, {
    size: 512, seed: seed + 5, normalStrength: 6, roughBase: 0.9, roughVar: 0.1,
    uniforms: { uColA: { value: new THREE.Color(0.035, 0.03, 0.026) }, uColB: { value: new THREE.Color(0.17, 0.14, 0.11) }, uPlates: { value: 0 } },
  });
  t.barkPine = baker.bakeMaterial(BARK_FRAG, {
    size: 512, seed: seed + 6, normalStrength: 6, roughBase: 0.9, roughVar: 0.1,
    uniforms: { uColA: { value: new THREE.Color(0.05, 0.035, 0.025) }, uColB: { value: new THREE.Color(0.3, 0.15, 0.075) }, uPlates: { value: 1 } },
  });
  t.water = baker.bakeMaterial(WATER_FRAG, { size: 512, seed: seed + 7, normalStrength: 6, srgb: false });
  t.macro = baker.bakeData(MACRO_FRAG, 512, seed + 8);
  t.macro.wrapS = t.macro.wrapT = THREE.RepeatWrapping;

  const rng = new RNG(seed + 99);
  t.spray = dataTextureFromCanvas(drawSpray(rng, 512, 256, {
    mass: [22, 36, 20],
    needles: [[30, 50, 28], [38, 60, 32], [26, 44, 26], [44, 68, 38]],
    young: [78, 104, 48],
  }), [26, 42, 24]);
  t.pine = dataTextureFromCanvas(drawPineTufts(rng, 512, 256), [60, 84, 38]);
  t.fern = dataTextureFromCanvas(drawFern(rng, 256, 512), [60, 98, 34]);
  t.leaves = dataTextureFromCanvas(drawLeaves(rng, 512, 512), [55, 85, 30]);
  t.ghillie = dataTextureFromCanvas(drawGhillie(rng, 512, 512), [190, 190, 180]);
  return t;
}
