// Photoreal textures generated with Higgsfield (v5), in public/hf/. They replace the procedural
// (canvas and shader-baked) textures of the ground, the barks, the foliage cards and the ghillie
// strips:
//   - surfaces (ground, bark): <name>_ah.webp = albedo + height in alpha, <name>_nr.webp = normal +
//     roughness in alpha, the same packing as the procedural bakes, so the terrain, tree and rock
//     shaders use them unchanged. Made seamless and given height/normal from the photo.
//   - cards (foliage, ghillie): <name>.webp with the background keyed out to alpha, laid out like
//     the canvas textures they replace (stem at the left, fern stem at the bottom, 8 ghillie strips).
// The CC0 photoscans (assets.js) still take over the conifer ground and barks when they are there.
// A missing file keeps the procedural texture.
import * as THREE from 'three';

const SURFACES = {
  conifer: { grass: 'meadow', forest: 'forest', rock: 'rock', mud: 'mud', barkSpruce: 'bark-spruce', barkPine: 'bark-pine' },
  beech: { grass: 'beechgrass', forest: 'leaflitter', rock: 'rock', mud: 'mud', barkSpruce: 'bark-spruce', barkBeech: 'bark-beech' },
  tuscany: { grass: 'drygrass', forest: 'drysoil', rock: 'rock', mud: 'mud', barkPine: 'bark-pine', barkOlive: 'bark-olive' },
};
// photo stone walls for the edge wall and the Tuscan ruins (every map)
const WALLS = { wallDry: 'wall-dry', wallRubble: 'wall-rubble' };
// metres per repeat on the terrain (barks use the trunk's own uv)
const TILE = { grass: 2.6, forest: 2.4, rock: 3.2, mud: 2.2, wallDry: 2.4, wallRubble: 2.0 };
const CARDS = {
  conifer: { spray: 'spruce', pine: 'pine', fern: 'fern', leaves: 'shrub', ghillie: 'ghillie' },
  beech: { spray: 'spruce', fern: 'fern', beechLeaves: 'beech-leaves', leaves: 'beech-leaves', ghillie: 'ghillie' },
  tuscany: { pine: 'pine', cypress: 'cypress', oliveLeaves: 'olive-leaves', leaves: 'olive-leaves', fern: 'fern', ghillie: 'ghillie' },
};

function url(file) {
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${base}hf/${file}`;
}

function load(loader, file, { srgb, repeat, aniso }) {
  return loader.loadAsync(url(file)).then((t) => {
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    t.anisotropy = aniso;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }, () => null);
}

// Replaces entries of `textures` (from createTextures) in place. Returns the names replaced.
export async function loadHFTextures(renderer, textures, biome = 'conifer') {
  // ?hf=0 keeps the procedural textures (to compare)
  try { if (new URLSearchParams(location.search).get('hf') === '0') return []; } catch { /* ignore */ }
  const loader = new THREE.TextureLoader();
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const done = [];
  const surf = { ...(SURFACES[biome] || SURFACES.conifer), ...WALLS };
  const cards = CARDS[biome] || CARDS.conifer;
  await Promise.all([
    ...Object.entries(surf).map(async ([slot, name]) => {
      if (!textures[slot] && !WALLS[slot]) return;
      const [map, normalMap] = await Promise.all([load(loader, `${name}_ah.webp`, { srgb: true, repeat: true, aniso }), load(loader, `${name}_nr.webp`, { srgb: false, repeat: true, aniso })]);
      if (!map || !normalMap) return;
      const old = textures[slot] || {};
      textures[slot] = { map, normalMap, tile: TILE[slot] || old.tile, hf: name };
      done.push(slot);
    }),
    ...Object.entries(cards).map(async ([slot, name]) => {
      const t = await load(loader, `${name}.webp`, { srgb: true, repeat: false, aniso });
      if (!t) return;
      textures[slot] = t;
      done.push(slot);
    }),
  ]);
  if (done.length) console.info(`[hf] generated textures: ${done.sort().join(', ')}`);
  return done;
}
