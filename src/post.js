// Post-processing: scene render (MSAA, HDR, depth texture) -> SSAO (half res, depth based)
// -> viewmodel overlay -> bloom -> final pass (ACES tone mapping, sRGB, scope lens with
// distortion / chromatic aberration / mil-dot reticle, vignette, grain, damage tint).
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { CONFIG } from './config.js';
import { sunDirection } from './shaders.js';

const SUN_DIR = sunDirection();
const _fwd = new THREE.Vector3(), _sunP = new THREE.Vector3();

const SSAO_FRAG = /* glsl */`
uniform sampler2D tDepth;
uniform mat4 uProjInv;
uniform vec2 uTexel;       // full-res texel
uniform float uRadius;
uniform float uProjScale;  // proj[1][1]
uniform float uAspect;
uniform float uFade;       // distance fade (scaled by zoom)
varying vec2 vUv;
vec3 viewPos(vec2 uv) {
  float d = texture2D(tDepth, uv).r;
  vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = uProjInv * clip;
  return v.xyz / v.w;
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  float d0 = texture2D(tDepth, vUv).r;
  if (d0 >= 0.99999) { gl_FragColor = vec4(1.0); return; }
  vec3 P = viewPos(vUv);
  vec3 pr = viewPos(vUv + vec2(uTexel.x, 0.0)), pl = viewPos(vUv - vec2(uTexel.x, 0.0));
  vec3 pu = viewPos(vUv + vec2(0.0, uTexel.y)), pd = viewPos(vUv - vec2(0.0, uTexel.y));
  vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
  vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
  vec3 N = normalize(cross(dx, dy));
  float rad = uRadius * uProjScale * 0.5 / max(-P.z, 0.1);
  rad = min(rad, 0.08);
  float occ = 0.0;
  float rot = ign(gl_FragCoord.xy) * 6.2831853;
  const int S = 12;
  for (int i = 0; i < S; i++) {
    float fi = float(i);
    float a = fi * 2.39996 + rot;
    float r = rad * sqrt((fi + 0.5) / float(S));
    vec2 suv = vUv + vec2(cos(a) / uAspect, sin(a)) * r;
    vec3 Sp = viewPos(suv);
    vec3 v = Sp - P;
    float dist = length(v);
    float nd = dot(N, v / max(dist, 1e-4));
    float w = 1.0 - smoothstep(uRadius * 0.6, uRadius * 2.5, dist);
    occ += max(nd - 0.08, 0.0) * w;
  }
  float ao = 1.0 - occ / float(S) * 1.6;
  ao = mix(ao, 1.0, smoothstep(uFade * 0.5, uFade, -P.z));
  gl_FragColor = vec4(vec3(clamp(ao, 0.0, 1.0)), 1.0);
}`;

const BLUR_FRAG = /* glsl */`
uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform vec2 uDir;
uniform float uNear;
uniform float uFar;
varying vec2 vUv;
float lin(float d) { float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
void main() {
  float dc = lin(texture2D(tDepth, vUv).r);
  float sum = 0.0, wsum = 0.0;
  for (int i = -3; i <= 3; i++) {
    vec2 uv = vUv + uDir * uTexel * float(i) * 1.5;
    float d = lin(texture2D(tDepth, uv).r);
    float w = exp(-abs(d - dc) / (dc * 0.04 + 0.05)) * (1.0 - abs(float(i)) / 4.5);
    sum += texture2D(tAO, uv).r * w;
    wsum += w;
  }
  gl_FragColor = vec4(vec3(sum / max(wsum, 1e-4)), 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tAO;
uniform float uStrength;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  float ao = texture2D(tAO, vUv).r;
  gl_FragColor = vec4(c.rgb * mix(1.0, ao, uStrength), c.a);
}`;

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

class SSAOPass extends Pass {
  constructor(camera) {
    super();
    this.camera = camera;
    this.needsSwap = true;
    const mk = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, depthBuffer: false });
    this.aoRT = mk();
    this.blurRT = mk();
    this.aoMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: SSAO_FRAG,
      uniforms: {
        tDepth: { value: null }, uProjInv: { value: new THREE.Matrix4() }, uTexel: { value: new THREE.Vector2() },
        uRadius: { value: 1.1 }, uProjScale: { value: 1 }, uAspect: { value: 1 }, uFade: { value: 160 },
      },
      depthTest: false, depthWrite: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BLUR_FRAG,
      uniforms: { tAO: { value: null }, tDepth: { value: null }, uTexel: { value: new THREE.Vector2() }, uDir: { value: new THREE.Vector2() }, uNear: { value: 0.1 }, uFar: { value: 1000 } },
      depthTest: false, depthWrite: false,
    });
    this.compMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: COMPOSITE_FRAG,
      uniforms: { tDiffuse: { value: null }, tAO: { value: null }, uStrength: { value: 0.85 } },
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(null);
  }

  setSize(w, h) {
    this.aoRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.blurRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.aoMat.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.blurMat.uniforms.uTexel.value.set(2 / w, 2 / h);
  }

  render(renderer, writeBuffer, readBuffer) {
    const cam = this.camera;
    const depth = readBuffer.depthTexture;
    const u = this.aoMat.uniforms;
    u.tDepth.value = depth;
    u.uProjInv.value.copy(cam.projectionMatrixInverse);
    u.uProjScale.value = cam.projectionMatrix.elements[5];
    u.uAspect.value = cam.aspect;
    u.uFade.value = 170 * (CONFIG.player.fovHip / cam.fov);
    renderer.setRenderTarget(this.aoRT);
    this.quad.material = this.aoMat;
    this.quad.render(renderer);
    const b = this.blurMat.uniforms;
    b.tDepth.value = depth;
    b.uNear.value = cam.near; b.uFar.value = cam.far;
    b.tAO.value = this.aoRT.texture; b.uDir.value.set(1, 0);
    renderer.setRenderTarget(this.blurRT);
    this.quad.material = this.blurMat;
    this.quad.render(renderer);
    b.tAO.value = this.blurRT.texture; b.uDir.value.set(0, 1);
    renderer.setRenderTarget(this.aoRT);
    this.quad.render(renderer);
    const c = this.compMat.uniforms;
    c.tDiffuse.value = readBuffer.texture;
    c.tAO.value = this.aoRT.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.material = this.compMat;
    this.quad.render(renderer);
  }
}

// Screen-space light shafts (radial blur of the sky around the sun, after Mitchell,
// GPU Gems 3 ch. 13). The mask and blurs run at quarter resolution; the result is added to
// the HDR image before the viewmodel is drawn, so the rifle stays in front of the rays.
// The scene depth comes from the RenderPass target (set per frame by PostFX).
const SHAFT_MASK_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec2 uSun;
uniform float uAspect;
uniform vec2 uTexel;
varying vec2 vUv;
float skyAt(vec2 uv) { return step(0.99999, texture2D(tDepth, uv).r); }
void main() {
  float sky = skyAt(vUv);
  if (sky < 0.5) { gl_FragColor = vec4(0.0); return; }
  // Shafts come from light breaking through gaps: open sky far from any occluder only
  // adds a faint glow, sky next to branches and trunks adds the full amount.
  float occl = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398 + 0.39;
    vec2 o = vec2(cos(a), sin(a)) * uTexel;
    occl += 1.0 - skyAt(vUv + o * 10.0);
    occl += 1.0 - skyAt(vUv + o * 26.0);
  }
  float edge = smoothstep(0.0, 0.35, occl / 16.0);
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec2 dv = (vUv - uSun) * vec2(uAspect, 1.0);
  float fall = pow(max(0.0, 1.0 - length(dv) / 1.0), 2.0);
  gl_FragColor = vec4(vec3(fall * mix(0.12, 1.0, edge) * (0.35 + 0.65 * clamp(lum / 2.4, 0.0, 1.0))), 1.0);
}`;

const SHAFT_BLUR_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uSun;
uniform float uLength;
varying vec2 vUv;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  const int N = 36;
  vec2 delta = (vUv - uSun) * uLength / float(N);
  vec2 uv = vUv - delta * ign(gl_FragCoord.xy);
  float illum = 1.0, acc = 0.0, wsum = 0.0;
  for (int i = 0; i < N; i++) {
    acc += texture2D(tSrc, uv).r * illum;
    wsum += illum;
    illum *= 0.975;
    uv -= delta;
  }
  gl_FragColor = vec4(vec3(acc / wsum), 1.0);
}`;

const SHAFT_ADD_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tShafts;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  float s = texture2D(tShafts, vUv).r;
  gl_FragColor = vec4(c.rgb + uColor * (1.8 * s / (0.35 + s)), c.a);
}`;

class SunShaftsPass extends Pass {
  constructor() {
    super();
    this.needsSwap = true;
    this.depthTexture = null;
    const mk = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.rtA = mk();
    this.rtB = mk();
    this.sun = new THREE.Vector2(0.5, 0.5);
    this.color = new THREE.Color();
    this.maskMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: SHAFT_MASK_FRAG,
      uniforms: { tDiffuse: { value: null }, tDepth: { value: null }, uSun: { value: this.sun }, uAspect: { value: 1 }, uTexel: { value: new THREE.Vector2() } },
      depthTest: false, depthWrite: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: SHAFT_BLUR_FRAG,
      uniforms: { tSrc: { value: null }, uSun: { value: this.sun }, uLength: { value: 1 } },
      depthTest: false, depthWrite: false,
    });
    this.addMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: SHAFT_ADD_FRAG,
      uniforms: { tDiffuse: { value: null }, tShafts: { value: null }, uColor: { value: this.color } },
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(null);
  }

  setSize(w, h) {
    this.rtA.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.rtB.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.maskMat.uniforms.uAspect.value = w / Math.max(1, h);
    this.maskMat.uniforms.uTexel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
  }

  render(renderer, writeBuffer, readBuffer) {
    this.maskMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.maskMat.uniforms.tDepth.value = this.depthTexture;
    renderer.setRenderTarget(this.rtA);
    this.quad.material = this.maskMat;
    this.quad.render(renderer);
    const b = this.blurMat.uniforms;
    b.tSrc.value = this.rtA.texture; b.uLength.value = 0.85;
    renderer.setRenderTarget(this.rtB);
    this.quad.material = this.blurMat;
    this.quad.render(renderer);
    b.tSrc.value = this.rtB.texture; b.uLength.value = 0.3;
    renderer.setRenderTarget(this.rtA);
    this.quad.render(renderer);
    this.addMat.uniforms.tShafts.value = this.rtA.texture;
    this.addMat.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.material = this.addMat;
    this.quad.render(renderer);
  }
}

const FINAL_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform float uExposure;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
uniform float uScope;
uniform float uAspect;
uniform vec2 uRes;
uniform float uDamage;
uniform float uOutside;
uniform float uFade;
uniform vec2 uReticleOffset;
uniform vec3 uGrade; // saturation, contrast, warmth
varying vec2 vUv;

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 ACES(vec3 color) {
  const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color *= 1.0 / 0.6;
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime * 3.17) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  vec2 c = (uv - 0.5) * vec2(uAspect, 1.0);
  float r = length(c);
  const float lensR = 0.47;
  vec3 col;
  if (uScope > 0.001) {
    float rn = clamp(r / lensR, 0.0, 1.2);
    vec2 cd = c * (1.0 + 0.085 * rn * rn * uScope);
    vec2 duv = cd / vec2(uAspect, 1.0) + 0.5;
    vec2 dir = c / max(r, 1e-4);
    float ca = 0.004 * rn * rn * uScope;
    vec2 cao = dir * ca / vec2(uAspect, 1.0);
    col.r = texture2D(tDiffuse, duv + cao).r;
    col.g = texture2D(tDiffuse, duv).g;
    col.b = texture2D(tDiffuse, duv - cao).b;
  } else {
    col = texture2D(tDiffuse, uv).rgb;
  }
  col *= uExposure;
  // grading in linear HDR: log-space contrast around mid grey, saturation, split toning
  col = 0.18 * exp2(log2(max(col, vec3(1e-5)) / 0.18) * uGrade.y);
  float lumG = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(lumG), col, uGrade.x), 0.0);
  float tone = smoothstep(0.03, 0.7, lumG);
  col *= mix(vec3(1.0 - uGrade.z * 0.6, 1.0, 1.0 + uGrade.z), vec3(1.0 + uGrade.z, 1.0, 1.0 - uGrade.z * 0.8), tone);
  col = ACES(col);
  col = toSRGB(col);

  // general vignette
  float vig = smoothstep(0.85, 0.2, length((vUv - 0.5) * vec2(uAspect * 0.85, 1.0)));
  col *= mix(1.0 - uVignette, 1.0, vig);

  if (uScope > 0.001) {
    float px = 1.0 / uRes.y;
    // lens rim shading and mask
    float inner = smoothstep(lensR, lensR * 0.55, r);
    col *= mix(1.0, mix(0.35, 1.0, inner), uScope);
    float mask = smoothstep(lensR + px * 1.5, lensR - px * 1.5, r);
    float rim = smoothstep(lensR - px * 10.0, lensR, r) * mask;
    col = mix(col, col * 0.25 + vec3(0.02), rim * uScope);
    // reticle (slightly offset by sway lag)
    vec2 q = c - uReticleOffset;
    float lw = px * 0.9;
    float post = px * 3.2;
    float postStart = lensR * 0.42;
    float h = 1.0 - smoothstep(lw * 0.5, lw * 1.5, abs(q.y));
    float v = 1.0 - smoothstep(lw * 0.5, lw * 1.5, abs(q.x));
    float hp = (1.0 - smoothstep(post * 0.5, post * 0.5 + px, abs(q.y))) * step(postStart, abs(q.x));
    float vp = (1.0 - smoothstep(post * 0.5, post * 0.5 + px, abs(q.x))) * step(postStart, -q.y);
    float dots = 0.0;
    for (int i = 1; i <= 5; i++) {
      float s = float(i) * lensR * 0.075;
      dots += 1.0 - smoothstep(px * 1.6, px * 2.6, length(vec2(abs(q.x) - s, q.y)));
      dots += 1.0 - smoothstep(px * 1.6, px * 2.6, length(vec2(q.x, abs(q.y) - s)));
    }
    float ret = clamp(max(max(h, v), max(max(hp, vp), dots)), 0.0, 1.0) * step(r, lensR);
    col = mix(col, vec3(0.01), ret * 0.92 * uScope);
    col *= mix(1.0, mask, uScope);
  }

  // damage / outside zone tint
  float edge = smoothstep(0.25, 0.75, length((vUv - 0.5) * vec2(uAspect * 0.7, 1.0)));
  col = mix(col, vec3(0.5, 0.02, 0.0), uDamage * edge * 0.8);
  col = mix(col, col * vec3(1.15, 0.7, 0.65), uOutside * (0.35 + 0.25 * sin(uTime * 6.0)) * edge);

  // grain
  float g = hash(gl_FragCoord.xy) - 0.5;
  col += g * uGrain;
  col *= 1.0 - uFade;
  gl_FragColor = vec4(col, 1.0);
}`;

export class PostFX {
  constructor(renderer, scene, camera, vmScene, vmCamera) {
    this.renderer = renderer;
    this.camera = camera;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: CONFIG.render.msaa,
      depthTexture: new THREE.DepthTexture(size.x, size.y, THREE.UnsignedIntType),
    });
    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.ssao = new SSAOPass(camera);
    this.ssao.enabled = CONFIG.render.ao;
    this.composer.addPass(this.ssao);
    this.shafts = new SunShaftsPass();
    this.composer.addPass(this.shafts);
    if (vmScene) {
      this.vmPass = new RenderPass(vmScene, vmCamera);
      this.vmPass.clear = false;
      this.vmPass.clearDepth = true;
      this.composer.addPass(this.vmPass);
    }
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.65, 0.5, 4.5);
    this.bloom.enabled = CONFIG.render.bloom;
    this.composer.addPass(this.bloom);
    this.final = new ShaderPass(new THREE.ShaderMaterial({
      vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: FINAL_FRAG,
      uniforms: {
        tDiffuse: { value: null },
        uExposure: { value: CONFIG.render.exposure },
        uVignette: { value: CONFIG.render.vignette },
        uGrain: { value: CONFIG.render.grain },
        uTime: { value: 0 },
        uScope: { value: 0 },
        uAspect: { value: 1 },
        uRes: { value: new THREE.Vector2(1, 1) },
        uDamage: { value: 0 },
        uOutside: { value: 0 },
        uFade: { value: 0 },
        uReticleOffset: { value: new THREE.Vector2() },
        uGrade: { value: new THREE.Vector3(CONFIG.grade.saturation, CONFIG.grade.contrast, CONFIG.grade.warmth) },
      },
    }));
    this.composer.addPass(this.final);
    this.uniforms = this.final.material.uniforms;
  }

  setSize(w, h, pixelRatio) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
    this.uniforms.uAspect.value = w / h;
    this.uniforms.uRes.value.set(w * pixelRatio, h * pixelRatio);
  }

  render(dt, time) {
    this.uniforms.uTime.value = time % 1000;
    this.ssao.enabled = CONFIG.render.ao;
    this.bloom.enabled = CONFIG.render.bloom;
    this._updateShafts();
    this.composer.render(dt);
  }

  // Sun position on screen and fade (rays only when looking roughly toward the sun).
  _updateShafts() {
    const cam = this.camera;
    const sp = this.shafts;
    const fwd = cam.getWorldDirection(_fwd);
    const facing = fwd.dot(SUN_DIR);
    _sunP.copy(cam.position).addScaledVector(SUN_DIR, 1000).project(cam);
    const off = Math.max(Math.abs(_sunP.x), Math.abs(_sunP.y));
    const fade = THREE.MathUtils.smoothstep(facing, 0.05, 0.45) * (1 - THREE.MathUtils.smoothstep(off, 1.1, 2.0));
    sp.enabled = CONFIG.render.sunShafts && fade > 0.01 && !!this.composer.readBuffer.depthTexture;
    if (!sp.enabled) return;
    sp.sun.set(_sunP.x * 0.5 + 0.5, _sunP.y * 0.5 + 0.5);
    sp.color.set(CONFIG.sun.color).multiplyScalar(CONFIG.grade.shafts * fade);
    // the RenderPass draws into the composer's current read buffer; its depth is the scene depth
    sp.depthTexture = this.composer.readBuffer.depthTexture;
  }
}
