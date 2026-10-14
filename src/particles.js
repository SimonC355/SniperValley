// Small life in the air around the camera: needles and bits of bark drifting down under the
// canopy (more of them in a gust), and dust motes that light up when you look toward the
// sun. One point cloud; every particle is animated in the vertex shader and wraps around a
// box that follows the camera, so it costs almost nothing.
import * as THREE from 'three';
import { SHARED } from './shaders.js';

const COUNT = 2400;
const NEEDLE_SHARE = 0.62;

const vertexShader = /* glsl */`
uniform float uTime;
uniform vec2 uWindDir;
uniform vec3 uCam;
uniform vec3 uBox;
uniform float uGust;
uniform float uPx;
uniform float uFade;
uniform vec3 uSunDir;
uniform float uSunVis;
uniform sampler2D tSplat;
uniform sampler2D tHeight;
uniform vec4 uHB;
attribute vec4 aSeed;
varying float vNeedle;
varying float vAlpha;
varying float vAngle;
varying float vTumble;
varying vec3 vColor;

void main() {
  float needle = step(aSeed.w, ${NEEDLE_SHARE.toFixed(2)});
  vec3 base = aSeed.xyz * uBox;
  float t = uTime + aSeed.w * 97.0;
  vec3 drift;
  if (needle > 0.5) {
    float fall = 0.45 + aSeed.y * 0.55;
    drift = vec3(uWindDir.x, 0.0, uWindDir.y) * t * (0.35 + 0.5 * aSeed.x) * (0.5 + 2.5 * uGust)
          + vec3(sin(t * (1.1 + aSeed.z) + aSeed.x * 40.0) * 0.4, -fall * t, cos(t * (0.9 + aSeed.x) + aSeed.z * 40.0) * 0.4);
  } else {
    drift = vec3(sin(t * 0.13 + aSeed.x * 30.0) * 1.5 + uWindDir.x * 0.2 * t,
                 sin(t * 0.09 + aSeed.y * 20.0) * 0.9,
                 cos(t * 0.11 + aSeed.z * 25.0) * 1.5 + uWindDir.y * 0.2 * t);
  }
  // wrap into a box that follows the camera
  vec3 rel = mod(base + drift - uCam + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 p = uCam + rel;
  vec2 huv = (p.xz - uHB.xy) / uHB.zw;
  float ground = texture(tHeight, huv).r;
  float canopy = texture(tSplat, huv).r;
  // fade at the box edges (where particles wrap) and below the ground
  vec3 e = abs(rel) / uBox;
  float edge = 1.0 - smoothstep(0.32, 0.5, max(max(e.x, e.z), e.y));
  float above = smoothstep(0.0, 0.15, p.y - ground);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float dist = -mv.z;
  vec3 dir = normalize(p - cameraPosition);
  float toSun = max(dot(dir, uSunDir), 0.0);
  float size, alpha;
  if (needle > 0.5) {
    // only under trees (a few blow out of the forest in a gust)
    float where = smoothstep(0.25, 0.7, canopy) + 0.12 * uGust;
    size = (0.045 + aSeed.z * 0.04) * uPx / max(dist, 0.2);
    alpha = where * 0.95;
    vAngle = aSeed.x * 6.283 + t * (0.6 + aSeed.y * 1.6);
    vTumble = aSeed.z * 6.283 + t * (1.5 + aSeed.x * 3.0);
    // tumbling flakes catch the sun now and then; only close ones, and softly: a far, tiny
    // bright fleck reads as a scope glint (and it is gone when you scope in to look)
    float catchLight = pow(abs(sin(vTumble * 0.5 + aSeed.y * 3.0)), 12.0) * uSunVis * (0.5 + 1.2 * toSun) * (1.0 - smoothstep(3.0, 7.0, dist));
    vColor = vec3(0.16, 0.12, 0.075) * (0.55 + 0.45 * uSunVis) + vec3(1.0, 0.8, 0.5) * catchLight * 0.2;
  } else {
    // dust shows up against the light, mostly where the sun gets through the crowns (close
    // to you only, and not bright enough to pass for a glint)
    size = (0.006 + aSeed.z * 0.006) * uPx / max(dist, 0.2);
    float shine = pow(toSun, 5.0) * 1.6 + 0.03;
    alpha = shine * uSunVis * (1.0 - 0.5 * smoothstep(0.6, 1.0, canopy)) * (1.0 - smoothstep(3.0, 7.0, dist)) * smoothstep(1.2, 2.6, size);
    vAngle = 0.0;
    vTumble = 0.0;
    vColor = vec3(1.0, 0.86, 0.62);
  }
  // sub-pixel particles fade instead of flickering
  alpha *= edge * above * uFade * smoothstep(0.7, 2.0, size);
  vNeedle = needle;
  vAlpha = alpha;
  gl_PointSize = clamp(size, 1.0, 48.0);
  gl_Position = projectionMatrix * mv;
  if (alpha < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const fragmentShader = /* glsl */`
varying float vNeedle;
varying float vAlpha;
varying float vAngle;
varying float vTumble;
varying vec3 vColor;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float a;
  if (vNeedle > 0.5) {
    float c = cos(vAngle), s = sin(vAngle);
    q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
    // a thin flake, foreshortened as it tumbles
    q.x /= max(0.25, abs(cos(vTumble)));
    float d = length(vec2(q.x * 1.0, q.y * 5.0));
    a = 1.0 - smoothstep(0.32, 0.48, d);
  } else {
    a = 1.0 - smoothstep(0.1, 0.5, length(q));
  }
  a *= vAlpha;
  if (a < 0.004) discard;
  // premultiplied: flakes blend over the scene, dust adds light
  gl_FragColor = vec4(vColor * a, a * vNeedle);
}`;

export class ForestParticles {
  constructor(scene, terrain) {
    const seeds = new Float32Array(COUNT * 4);
    let s = 12345;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < seeds.length; i++) seeds[i] = rnd();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.uniforms = {
      uTime: SHARED.uTime,
      uWindDir: SHARED.uWindDir,
      uCam: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(28, 14, 28) },
      uGust: { value: 0 },
      uPx: { value: 800 },
      uFade: { value: 1 },
      uSunDir: SHARED.uSunDirWorld,
      uSunVis: { value: 1 },
      tSplat: { value: terrain.splatTexture },
      tHeight: { value: terrain.heightTexture },
      uHB: { value: terrain.gridBounds },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader, fragmentShader,
      transparent: true, depthWrite: false, fog: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
    this._size = new THREE.Vector2();
  }

  // gust: gust strength at the camera (0..1); sunVis: sun not behind a cloud (0..1)
  update(camera, renderer, gust, sunVis, scopeT) {
    const u = this.uniforms;
    u.uCam.value.copy(camera.position);
    u.uGust.value = gust;
    u.uSunVis.value = sunVis;
    u.uFade.value = 1 - THREE.MathUtils.smoothstep(scopeT, 0.1, 0.5);
    renderer.getDrawingBufferSize(this._size);
    u.uPx.value = this._size.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    this.points.visible = u.uFade.value > 0.01;
  }
}
