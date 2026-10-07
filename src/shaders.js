// Shared shader uniforms, exponential height fog, and foliage material patching.
import * as THREE from 'three';
import { CONFIG } from './config.js';

// Uniform objects shared by reference across all custom materials.
export const SHARED = {
  uTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(0.86, 0.5).normalize() },
  uWindStrength: { value: CONFIG.trees.windStrength },
  uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
  uSunDirWorld: { value: new THREE.Vector3(0, 1, 0) },
  uSunColor: { value: new THREE.Color(1, 1, 1) },
};

// Gusts: bands of stronger wind that travel down the valley. Trees, grass and ghillie
// strands sway harder as a band passes (GLSL), and the wind sound follows it (JS).
// Bands of stronger wind travelling downwind (~7 m/s); 0 = lull, 1 = the peak of a gust.
// GUST_GLSL needs uTime and uWindDir (SHARED) in the shader.
export const GUST_GLSL = /* glsl */`
float gustAt(vec2 p) {
  float a = dot(p, uWindDir);
  float c = dot(p, vec2(-uWindDir.y, uWindDir.x));
  float ph = (a - uTime * 7.0) * 0.042 + sin(c * 0.018 + uTime * 0.05) * 1.6 + sin(c * 0.043 - uTime * 0.07) * 0.7;
  float g = sin(ph) * 0.5 + 0.5;
  return g * g * g * (0.5 + 0.5 * sin(uTime * 0.021 + 1.3));
}`;

export function gustAt(x, z, t) {
  const w = SHARED.uWindDir.value;
  const a = x * w.x + z * w.y;
  const c = -x * w.y + z * w.x;
  const ph = (a - t * 7.0) * 0.042 + Math.sin(c * 0.018 + t * 0.05) * 1.6 + Math.sin(c * 0.043 - t * 0.07) * 0.7;
  const g = Math.sin(ph) * 0.5 + 0.5;
  return g * g * g * (0.5 + 0.5 * Math.sin(t * 0.021 + 1.3));
}

export function sunDirection() {
  const el = THREE.MathUtils.degToRad(CONFIG.sun.elevation);
  const az = THREE.MathUtils.degToRad(CONFIG.sun.azimuth);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
}

const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const v3 = (v) => `vec3(${f(v.x)}, ${f(v.y)}, ${f(v.z)})`;

// Replace three's fog chunks with exponential height fog plus sun in-scattering.
// Works for every material that has fog enabled (including instanced/skinned/sprites)
// because the world position is reconstructed from the final view-space position.
export function installHeightFog() {
  const sun = sunDirection();
  const sc = new THREE.Color(CONFIG.sun.color);
  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
  varying vec3 vFogWorldPos;
#endif`;
  C.fog_vertex = /* glsl */`
#ifdef USE_FOG
  vFogWorldPos = cameraPosition + transpose(mat3(viewMatrix)) * mvPosition.xyz;
#endif`;
  C.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying vec3 vFogWorldPos;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  vec3 heightFog(vec3 col, vec3 wpos) {
    #ifdef FOG_EXP2
      float dens = fogDensity;
    #else
      float dens = 0.002;
    #endif
    vec3 ray = wpos - cameraPosition;
    float dist = length(ray);
    vec3 dir = ray / max(dist, 1e-4);
    float b = ${f(CONFIG.fog.heightFalloff)};
    float ry = dir.y * b * dist;
    float k = abs(ry) > 1e-4 ? (1.0 - exp(-ry)) / ry : 1.0;
    float integ = dens * exp(-b * max(cameraPosition.y, -20.0)) * dist * k;
    float fogF = 1.0 - exp(-max(integ, 0.0));
    float sunAmt = pow(max(dot(dir, ${v3(sun)}), 0.0), 8.0);
    vec3 fc = mix(fogColor, ${v3({ x: sc.r * 1.6, y: sc.g * 1.45, z: sc.b * 1.2 })}, sunAmt * ${f(CONFIG.fog.sunScatter)});
    return mix(col, fc, fogF);
  }
#endif`;
  C.fog_fragment = /* glsl */`
#ifdef USE_FOG
  gl_FragColor.rgb = heightFog(gl_FragColor.rgb, vFogWorldPos);
#endif`;
}

// Patch a MeshStandardMaterial used for alpha-cut foliage cards:
//  - wind sway (world space, after instancing) scaled by height above the base
//  - leaf flutter at card tips (uv.x)
//  - normals are NOT flipped for back faces (we author volumetric "spherical" normals)
//  - alpha is boosted per mip level so cards don't thin out with distance
//  - simple sun translucency when back-lit
//  - optional cylindrical billboarding (impostors)
export function patchFoliage(material, { sway = 0.004, flutter = 0.03, translucency = 0.6, billboard = false, noFlip = true, key = 'foliage' } = {}) {
  material.defines = material.defines || {};
  material.defines.FOLIAGE_SWAY = f(sway);
  material.defines.FOLIAGE_FLUTTER = f(flutter);
  material.defines.FOLIAGE_TRANSLUCENCY = f(translucency);
  if (billboard) material.defines.BILLBOARD = '';
  if (noFlip) material.defines.NO_FLIP = '';
  material.customProgramCacheKey = () => key;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = SHARED.uTime;
    shader.uniforms.uWindDir = SHARED.uWindDir;
    shader.uniforms.uWindStrength = SHARED.uWindStrength;
    shader.uniforms.uSunDirView = SHARED.uSunDirView;
    shader.uniforms.uSunColor = SHARED.uSunColor;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
varying float vFoliageAO;
${GUST_GLSL}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
#ifdef BILLBOARD
  {
    vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
    vec3 toCam = cameraPosition - ip; toCam.y = 0.0; toCam = normalize(toCam);
    objectNormal = normalize(toCam + vec3(0.0, 0.35, 0.0));
  }
#endif`)
      .replace('#include <project_vertex>', `
vec4 mvPosition = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  vec3 instPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  float instScale = length(vec3(instanceMatrix[0][0], instanceMatrix[0][1], instanceMatrix[0][2]));
  #ifdef BILLBOARD
    vec3 toC = cameraPosition - instPos; toC.y = 0.0; toC = normalize(toC);
    vec3 right = vec3(toC.z, 0.0, -toC.x);
    mvPosition = vec4(instPos + (right * transformed.x + vec3(0.0, transformed.y, 0.0) + toC * transformed.z) * instScale, 1.0);
  #else
    mvPosition = instanceMatrix * mvPosition;
  #endif
#else
  vec3 instPos = vec3(0.0);
  float instScale = 1.0;
#endif
{
  float ph = dot(instPos.xz, vec2(0.13, 0.17));
  float hgt = max(transformed.y, 0.0) * instScale;
  // calmer between gusts; a passing gust leans the tree downwind and shakes it harder
  float gust = gustAt(instPos.xz) * ${f(CONFIG.weather.gusts)};
  float s = ((sin(uTime * 1.05 + ph) * 0.6 + sin(uTime * 2.3 + ph * 1.7) * 0.25) * (0.7 + 0.8 * gust) + 0.25 + 0.6 * gust) * uWindStrength;
  mvPosition.xz += uWindDir * s * hgt * hgt * FOLIAGE_SWAY;
  #ifndef BILLBOARD
    mvPosition.xyz += normalize(vec3(sin(dot(transformed, vec3(3.1, 2.3, 1.7))), 0.6, cos(dot(transformed, vec3(1.3, 2.9, 3.7))))) * sin(uTime * 6.5 + dot(transformed, vec3(2.0, 3.0, 1.0)) + ph) * FOLIAGE_FLUTTER * uv.x * uWindStrength * (0.6 + 1.6 * gust);
  #endif
}
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
#ifdef USE_COLOR
  vFoliageAO = vColor.r;
#else
  vFoliageAO = 1.0;
#endif
`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uSunDirView;
uniform vec3 uSunColor;
varying float vFoliageAO;`)
      .replace('#include <alphatest_fragment>', `
#ifdef USE_MAP
  {
    vec2 tsz = vec2(textureSize(map, 0));
    vec2 ddx = dFdx(vMapUv * tsz), ddy = dFdy(vMapUv * tsz);
    float mip = max(0.0, 0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy))));
    diffuseColor.a *= 1.0 + mip * 0.3;
  }
#endif
#include <alphatest_fragment>`)
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', '#ifndef NO_FLIP\nnormal *= faceDirection;\n#endif'))
      .replace('#include <opaque_fragment>', `
{
  vec3 vdir = normalize(-vViewPosition);
  float tr = pow(max(dot(-vdir, uSunDirView), 0.0), 3.0);
  outgoingLight += diffuseColor.rgb * uSunColor * tr * FOLIAGE_TRANSLUCENCY * (0.35 + 0.65 * vFoliageAO);
}
#include <opaque_fragment>`);
  };
  return material;
}
