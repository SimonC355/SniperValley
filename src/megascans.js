// Megascans models (v5.2), optional. Quixel Megascans from Fab are under the Fab Standard
// License: the files may not be shared, so they never go into this (public) repository. Each
// player makes the game's light copies from their own downloads with `npm run megascans`
// (scripts/megascans/optimize.mjs), into the git-ignored public/assets/megascans/. Without them
// the game uses its own rocks, logs and stumps, as before.
//
// megascans.json lists the models with a role (see optimize.mjs): rock-boulder, rock-slab, log,
// snag, uprooted, patch, mushroom. Each model has a near copy and a far copy (about a fifth of
// the triangles).
import { CONFIG } from './config.js';
import { loadModel } from './models.js';

const DIR = 'assets/megascans';

// Brightness (linear albedo) each kind of piece is lifted to, to sit with the game's own
// textures (rock 0.23, bark 0.13, forest floor 0.09). Megascans are calibrated much darker
// (mossy rock 0.02-0.06) and stood out as black lumps. Never darkened; at most 4x.
const TARGET = { 'rock-boulder': 0.15, 'rock-slab': 0.14, log: 0.12, snag: 0.12, uprooted: 0.11, patch: 0.085, mushroom: 0.17 };

// { role: [{ name, near: parts, far: parts|null, size: [x, y, z] }] } or null.
export async function loadMegascans(mapId) {
  const C = CONFIG.megascans;
  if (!C.enabled || !C.maps.includes(mapId)) return null;
  let list;
  try {
    const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
    const r = await fetch(`${base}${DIR}/megascans.json`, { cache: 'no-cache' });
    if (!r.ok) return null;
    list = (await r.json()).models || [];
  } catch { return null; }
  const out = {};
  await Promise.all(list.map(async (m) => {
    const [near, far] = await Promise.all([loadModel(m.file, DIR), m.far ? loadModel(m.far, DIR) : null]);
    if (!near) return;
    const t = TARGET[m.role];
    if (t && m.albedo > 0) {
      const k = Math.min(4, Math.max(1, t / m.albedo));
      for (const p of [...near, ...(far || [])]) p.mat.color.multiplyScalar(k);
    }
    (out[m.role] = out[m.role] || []).push({ name: m.name, near, far, size: m.size });
  }));
  for (const k in out) out[k].sort((a, b) => (a.name < b.name ? -1 : 1));   // same order every load
  return Object.keys(out).length ? out : null;
}
