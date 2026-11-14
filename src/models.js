// Textured 3D models made with Higgsfield (v5), in public/models/: Tuscan houses and boulders.
// Each was a generated picture turned into a PBR mesh, then optimised (1k WebP textures, meshopt
// geometry); houses have a light copy for distance (*-lod.glb). A missing file returns null and
// the game uses its procedural houses and rocks instead.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

let loader = null;

function url(file) {
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${base}models/${file}`;
}

// Quantised (meshopt / KHR_mesh_quantization) attributes become plain floats, so the geometry
// can be scaled and moved in place without being clamped to the integer range.
function dequantize(g) {
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name];
    if (a.array instanceof Float32Array && !a.isInterleavedBufferAttribute) continue;
    const n = a.count, k = a.itemSize, out = new Float32Array(n * k);
    for (let i = 0; i < n; i++) {
      out[i * k] = a.getX(i);
      if (k > 1) out[i * k + 1] = a.getY(i);
      if (k > 2) out[i * k + 2] = a.getZ(i);
      if (k > 3) out[i * k + 3] = a.getW(i);
    }
    g.setAttribute(name, new THREE.BufferAttribute(out, k));
  }
  return g;
}

// A model as a list of { geo, mat } in its own space (node transforms applied), or null.
export async function loadModel(file) {
  if (!loader) {
    loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
  }
  try {
    const gltf = await loader.loadAsync(url(file));
    gltf.scene.updateMatrixWorld(true);
    const parts = [];
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const geo = dequantize(o.geometry.clone());
      geo.applyMatrix4(o.matrixWorld);
      geo.normalizeNormals();
      const mat = o.material;
      // stone, plaster, tiles and wood are not metal: the generated metalness maps make them dark
      // and mirror the sky, so they are dropped (roughness and normals stay)
      if (mat.metalness !== undefined) { mat.metalness = 0; mat.metalnessMap = null; }
      mat.envMapIntensity = 0.85;
      mat.needsUpdate = true;
      parts.push({ geo, mat });
    });
    return parts.length ? parts : null;
  } catch (e) {
    return null;
  }
}

export function partsBox(parts) {
  const box = new THREE.Box3();
  for (const p of parts) { p.geo.computeBoundingBox(); box.union(p.geo.boundingBox); }
  return box;
}

// Apply a matrix to all parts (and their bounds).
export function transformParts(parts, m) {
  for (const p of parts) { p.geo.applyMatrix4(m); p.geo.computeBoundingBox(); p.geo.computeBoundingSphere(); }
  return parts;
}

// Centre in x/z, base on y = baseY, long side along x, scaled so `axis` ('h' height, 'l' long
// side, 'r' half of the long side) equals `len`. Returns { hx, hz, h } after scaling.
export function fitParts(parts, axis, len, baseY = 0, lodParts = null) {
  let box = partsBox(parts);
  let size = box.getSize(new THREE.Vector3());
  const all = lodParts ? [...parts, ...lodParts] : parts;
  if (size.z > size.x) {
    transformParts(all, new THREE.Matrix4().makeRotationY(Math.PI / 2));
    box = partsBox(parts);
    size = box.getSize(new THREE.Vector3());
  }
  const long = Math.max(size.x, size.z);
  const s = axis === 'h' ? len / size.y : axis === 'r' ? len / (long / 2) : len / long;
  const m = new THREE.Matrix4().makeTranslation(0, baseY, 0)
    .multiply(new THREE.Matrix4().makeScale(s, s, s))
    .multiply(new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2));
  transformParts(all, m);
  return { hx: size.x * s / 2, hz: size.z * s / 2, h: size.y * s };
}

// The Tuscan house models: farmhouse (2 storeys), cottage (1), ochre village house, tower house.
export async function loadHouseModels() {
  const names = ['farm', 'cottage', 'ochre', 'tower'];
  const out = {};
  await Promise.all(names.map(async (n) => {
    const [hi, lo] = await Promise.all([loadModel(`house-${n}.glb`), loadModel(`house-${n}-lod.glb`)]);
    if (hi) out[n] = { hi, lo: lo || null };
  }));
  return Object.keys(out).length ? out : null;
}

// Boulder models: round boulder, flat slab, tall block.
export async function loadRockModels() {
  const names = ['boulder', 'slab', 'block'];
  const out = {};
  await Promise.all(names.map(async (n) => {
    const m = await loadModel(`rock-${n}.glb`);
    if (m) out[n] = m;
  }));
  return Object.keys(out).length ? out : null;
}
