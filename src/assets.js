// Optional photoscanned textures. `npm run assets` downloads CC0 textures from Poly Haven into
// public/assets/ and writes assets.json. At startup they are packed on the GPU into the same
// layout as the procedural bakes (albedo + height in alpha, normal + roughness in alpha), so
// terrain, rocks and bark use them without other changes. Missing files, a missing manifest
// or ?photo=0 keep the procedural textures.
import * as THREE from 'three';
import { CONFIG } from './config.js';

const VERT = /* glsl */`
precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const HEAD = /* glsl */`
precision highp float;
layout(location = 0) out highp vec4 pc_fragColor;
in vec2 vUv;
`;

const PACK_ALBEDO = HEAD + /* glsl */`
uniform sampler2D tAlb, tHeight;
uniform float uHasHeight, uSat, uHeightGain;
uniform vec3 uGain;
void main() {
  vec3 c = texture(tAlb, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3(l), c, uSat), 0.0) * uGain;
  // height for height-blended terrain layers; albedo brightness is a fair stand-in
  float h = uHasHeight > 0.5 ? texture(tHeight, vUv).r : smoothstep(0.0, 0.35, l);
  h = clamp(0.5 + (h - 0.5) * uHeightGain, 0.0, 1.0);
  pc_fragColor = vec4(c, h);
}`;

const PACK_NORMAL = HEAD + /* glsl */`
uniform sampler2D tNor, tRough;
uniform float uHasRough, uRoughChannel, uNormalGain;
void main() {
  vec3 n = texture(tNor, vUv).xyz * 2.0 - 1.0;
  n.xy *= uNormalGain;
  n = normalize(n);
  float r = 0.85;
  if (uHasRough > 0.5) { vec4 t = texture(tRough, vUv); r = uRoughChannel > 0.5 ? t.g : t.r; }
  pc_fragColor = vec4(n * 0.5 + 0.5, r);
}`;

// Procedural tile sizes (metres per repeat) used when the manifest has no real-world size.
const DEFAULT_TILE = { grass: 2.5, forest: 2.5, rock: 3.0, mud: 2.5, barkSpruce: 1, barkPine: 1 };

function assetURL(rel) {
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${base}assets/${rel}`;
}

function loadTexture(loader, rel, srgb) {
  return loader.loadAsync(assetURL(rel)).then((tex) => {
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    return tex;
  });
}

function packTarget(size, srgb, aniso) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
  });
  rt.texture.anisotropy = aniso;
  return rt;
}

// Replaces entries of `textures` (from createTextures) in place. Returns the slots replaced.
export async function loadPhotoTextures(renderer, textures) {
  const A = CONFIG.assets;
  if (!A.photo) return [];
  let manifest;
  try {
    const r = await fetch(assetURL('assets.json'), { cache: 'no-cache' });
    if (!r.ok) return [];
    manifest = await r.json();
  } catch {
    return [];
  }
  if (!manifest || !manifest.textures) return [];

  const loader = new THREE.TextureLoader();
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  scene.add(quad);
  const aniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  const render = (mat, rt) => {
    quad.material = mat;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prev);
    mat.dispose();
  };

  const replaced = [];
  for (const [slot, entry] of Object.entries(manifest.textures)) {
    if (!textures[slot] || !entry.files || !entry.files.albedo || !entry.files.normal) continue;
    const f = entry.files;
    try {
      const [alb, nor, rough, height] = await Promise.all([
        loadTexture(loader, f.albedo, true),
        loadTexture(loader, f.normal, false),
        f.rough ? loadTexture(loader, f.rough, false) : null,
        f.height ? loadTexture(loader, f.height, false) : null,
      ]);
      const adj = { gain: 1, saturation: 1, normal: 1, height: 1, ...(A.adjust[slot] || {}) };
      const cap = Math.min(A.maxSize, entry.maxSize || A.maxSize);
      const size = THREE.MathUtils.floorPowerOfTwo(Math.min(cap, alb.image.width || cap));
      const albedoRT = packTarget(size, true, aniso);
      render(new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: PACK_ALBEDO,
        uniforms: {
          tAlb: { value: alb }, tHeight: { value: height || alb }, uHasHeight: { value: height ? 1 : 0 },
          uSat: { value: adj.saturation }, uGain: { value: new THREE.Vector3().setScalar(adj.gain) }, uHeightGain: { value: adj.height },
        },
        depthTest: false, depthWrite: false,
      }), albedoRT);
      const normalRT = packTarget(size, false, aniso);
      render(new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: PACK_NORMAL,
        uniforms: {
          tNor: { value: nor }, tRough: { value: rough || nor }, uHasRough: { value: rough ? 1 : 0 },
          uRoughChannel: { value: entry.roughChannel || 0 }, uNormalGain: { value: adj.normal },
        },
        depthTest: false, depthWrite: false,
      }), normalRT);
      for (const t of [alb, nor, rough, height]) if (t) t.dispose();
      const old = textures[slot];
      if (old.dispose) old.dispose();
      textures[slot] = {
        map: albedoRT.texture, normalMap: normalRT.texture,
        tile: (entry.sizeM || DEFAULT_TILE[slot] || 2.5) * (A.tileScale[slot] || 1),
        photo: { id: entry.id, name: entry.name },
        dispose() { albedoRT.dispose(); normalRT.dispose(); },
      };
      replaced.push(slot);
    } catch (e) {
      console.warn(`[assets] ${slot}: could not load ${entry.id} (${e && e.message ? e.message : e}); keeping the procedural texture`);
    }
  }
  quad.geometry.dispose();
  if (replaced.length) console.info(`[assets] photoscanned textures: ${replaced.map((s) => `${s}=${textures[s].photo.id}`).join(', ')}`);
  return replaced;
}
