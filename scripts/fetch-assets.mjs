#!/usr/bin/env node
// Downloads CC0 photoscanned PBR textures from Poly Haven (https://polyhaven.com) into
// public/assets/ and writes public/assets/assets.json, which the game loads at startup in
// place of its procedural textures. Also refreshes the generated block in CREDITS.md.
//
//   npm run assets                      pick and download textures for every slot (2k)
//   npm run assets -- --res 1k          smaller download and less GPU memory
//   npm run assets -- --list            show the best candidates per slot, download nothing
//   npm run assets -- --slot forest=forest_leaves_02 --slot rock=rock_face
//   npm run assets -- --force           download again even if the files exist
//   npm run assets -- --clean           remove downloaded textures (back to procedural)
//
// Each slot lists preferred asset ids first. When none of them exists, the slot falls back
// to the best tag match in Poly Haven's catalogue, so renamed assets do not break the script.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'assets');
const CREDITS = path.join(ROOT, 'CREDITS.md');
const API = (process.env.POLYHAVEN_API || 'https://api.polyhaven.com').replace(/\/$/, '');
const HEADERS = { 'User-Agent': 'SniperYard-prototype-asset-fetcher/1.0' };

// Game texture slots. `size` caps the packed GPU texture (bark is small on screen).
const SLOTS = {
  grass: {
    what: 'meadow grass on open slopes',
    prefer: ['aerial_grass_rock', 'sparse_grass', 'leafy_grass', 'grass_medium_01', 'forest_grass'],
    tags: { grass: 4, meadow: 3, field: 2, lawn: 1, ground: 1, terrain: 1, moss: 1, aerial: 1 },
    avoid: ['path', 'paving', 'snow', 'sand', 'tiles', 'brick', 'artificial', 'road', 'dry'],
  },
  forest: {
    what: 'forest floor under the conifers (needles, twigs, cones)',
    prefer: ['forrest_ground_01', 'forest_ground_04', 'forest_floor', 'forest_leaves_02', 'brown_mud_leaves_01'],
    tags: { forest: 4, needles: 4, pine: 3, twigs: 2, leaves: 2, floor: 2, ground: 1, terrain: 1, cones: 2 },
    avoid: ['snow', 'paving', 'tiles', 'brick', 'artificial', 'road', 'autumn'],
  },
  rock: {
    what: 'rock faces on steep ground and boulders',
    prefer: ['rock_face', 'rock_boulder_cracked', 'mossy_rock', 'rock_surface', 'aerial_rocks_02', 'rocky_terrain_02'],
    tags: { rock: 4, cliff: 3, boulder: 3, granite: 2, moss: 1, stone: 1, natural: 1 },
    avoid: ['wall', 'brick', 'paving', 'tiles', 'cobble', 'sand', 'path', 'floor', 'artificial', 'concrete'],
  },
  mud: {
    what: 'wet river bank (mud, pebbles)',
    prefer: ['brown_mud_02', 'brown_mud_03', 'muddy_ground', 'river_small_rocks', 'coast_sand_rocks_02'],
    tags: { mud: 4, wet: 2, pebbles: 3, riverbed: 3, river: 2, gravel: 2, dirt: 1, soil: 1, ground: 1 },
    avoid: ['snow', 'paving', 'tiles', 'brick', 'artificial', 'road', 'cracked', 'dry'],
  },
  barkSpruce: {
    what: 'spruce/fir bark (grey-brown, fine scales)',
    prefer: ['bark_brown_02', 'bark_brown_01', 'tree_bark_03', 'bark_willow_02'],
    tags: { bark: 5, tree: 2, spruce: 3, wood: 1, brown: 1 },
    avoid: ['planks', 'floor', 'painted', 'wall', 'furniture', 'pine'],
    size: 1024,
  },
  barkPine: {
    what: 'pine bark (orange-brown plates)',
    prefer: ['pine_bark', 'bark_pine', 'rough_pine_bark', 'bark_brown_01', 'bark_platanus'],
    tags: { bark: 5, pine: 4, tree: 2, wood: 1, plates: 2 },
    avoid: ['planks', 'floor', 'painted', 'wall', 'furniture'],
    size: 1024,
  },
};

// Poly Haven map names differ a little between assets; first match wins.
const MAPS = {
  albedo: ['Diffuse', 'diffuse', 'diff', 'Color', 'albedo'],
  normal: ['nor_gl', 'Normal', 'normal_gl'],
  rough: ['Rough', 'rough', 'Roughness'],
  arm: ['arm', 'ARM'],
  height: ['Displacement', 'disp', 'Height', 'height'],
};
const RES_ORDER = ['1k', '2k', '4k', '8k'];

// ------------------------------------------------------------------ args
const args = process.argv.slice(2);
const opt = { res: '2k', list: false, force: false, clean: false, slots: {} };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--res') opt.res = args[++i];
  else if (a === '--list') opt.list = true;
  else if (a === '--force') opt.force = true;
  else if (a === '--clean') opt.clean = true;
  else if (a === '--slot') { const [k, v] = String(args[++i]).split('='); opt.slots[k] = v; }
  else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).join('\n')); process.exit(0); }
  else { console.error(`Unknown option ${a} (try --help)`); process.exit(1); }
}
if (!RES_ORDER.includes(opt.res)) { console.error(`--res must be one of ${RES_ORDER.join(', ')}`); process.exit(1); }
for (const k of Object.keys(opt.slots)) if (!SLOTS[k]) { console.error(`Unknown slot "${k}". Slots: ${Object.keys(SLOTS).join(', ')}`); process.exit(1); }

if (opt.clean) {
  fs.rmSync(path.join(OUT, 'textures'), { recursive: true, force: true });
  fs.rmSync(path.join(OUT, 'assets.json'), { force: true });
  writeCredits(null);
  console.log('Removed downloaded textures. The game uses its procedural textures again.');
  process.exit(0);
}

// ------------------------------------------------------------------ helpers
async function getJSON(url) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
    }
  }
  throw new Error(`${url}: ${last && last.message}`);
}

async function download(url, file, expectedSize) {
  if (!opt.force && fs.existsSync(file) && (!expectedSize || fs.statSync(file).size === expectedSize)) return 'cached';
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.part', buf);
      fs.renameSync(file + '.part', file);
      return `${(buf.length / 1048576).toFixed(1)} MB`;
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
    }
  }
  throw new Error(`${url}: ${last && last.message}`);
}

function words(asset, id) {
  const w = new Set();
  for (const s of [id, asset.name || '', ...(asset.tags || []), ...(asset.categories || [])]) {
    for (const t of String(s).toLowerCase().split(/[^a-z0-9]+/)) if (t) w.add(t);
  }
  return w;
}

function score(slot, asset, id) {
  const w = words(asset, id);
  let s = 0;
  for (const [tag, weight] of Object.entries(slot.tags)) if (w.has(tag)) s += weight;
  for (const bad of slot.avoid || []) if (w.has(bad)) s -= 6;
  s += Math.log10(1 + (asset.download_count || 0)) * 0.4;
  return s;
}

function pickFile(files, aliases, res) {
  for (const key of aliases) {
    const entry = files[key];
    if (!entry) continue;
    // requested resolution, else the next lower, else the next higher
    const want = RES_ORDER.indexOf(res);
    const order = [...RES_ORDER.slice(0, want + 1).reverse(), ...RES_ORDER.slice(want + 1)];
    for (const r of order) {
      const byFmt = entry[r];
      if (!byFmt) continue;
      for (const fmt of ['jpg', 'png']) if (byFmt[fmt] && byFmt[fmt].url) return { key, res: r, fmt, url: byFmt[fmt].url, size: byFmt[fmt].size };
    }
  }
  return null;
}

function authorsOf(asset) {
  return Object.keys(asset.authors || {});
}

function writeCredits(manifest) {
  if (!fs.existsSync(CREDITS)) return;
  const BEGIN = '<!-- photo-assets:begin -->', END = '<!-- photo-assets:end -->';
  let text = fs.readFileSync(CREDITS, 'utf8');
  let block = `${BEGIN}\n`;
  if (manifest && Object.keys(manifest.textures).length) {
    block += '### Downloaded photoscanned textures (CC0)\n\n';
    block += 'Fetched with `npm run assets` from [Poly Haven](https://polyhaven.com), licensed\n';
    block += '[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Stored in `public/assets/textures/`.\n\n';
    block += '| Slot | Asset | Author(s) |\n|---|---|---|\n';
    for (const [slot, t] of Object.entries(manifest.textures)) {
      block += `| ${slot} | [${t.name}](${t.url}) | ${t.authors.join(', ') || 'Poly Haven'} |\n`;
    }
  } else {
    block += '_No photoscanned textures downloaded. Run `npm run assets` to fetch CC0 textures from Poly Haven._\n';
  }
  block += END;
  if (text.includes(BEGIN) && text.includes(END)) {
    text = text.slice(0, text.indexOf(BEGIN)) + block + text.slice(text.indexOf(END) + END.length);
  } else {
    text = text.replace(/\n## Libraries/, `\n${block}\n\n## Libraries`);
  }
  fs.writeFileSync(CREDITS, text);
}

// ------------------------------------------------------------------ main
console.log(`Reading the Poly Haven texture catalogue (${API}) ...`);
let catalogue;
try {
  catalogue = await getJSON(`${API}/assets?t=textures`);
} catch (e) {
  console.error(`\nCould not reach Poly Haven: ${e.message}`);
  console.error('Check your internet connection (or proxy) and try again. The game keeps using its procedural textures.');
  process.exit(1);
}
if (!catalogue || typeof catalogue !== 'object') { console.error('Unexpected catalogue response.'); process.exit(1); }
console.log(`  ${Object.keys(catalogue).length} textures in the catalogue.\n`);

const chosen = {};
const used = new Set();
for (const [slotName, slot] of Object.entries(SLOTS)) {
  const ranked = Object.entries(catalogue)
    .map(([id, a]) => ({ id, a, s: score(slot, a, id) }))
    .sort((x, y) => y.s - x.s);
  if (opt.list) {
    console.log(`${slotName} (${slot.what}):`);
    for (const r of ranked.slice(0, 6)) console.log(`   ${r.id.padEnd(28)} ${r.a.name}  [score ${r.s.toFixed(1)}]`);
    const pref = slot.prefer.filter((id) => catalogue[id]);
    console.log(`   preferred ids present: ${pref.join(', ') || '(none)'}\n`);
    continue;
  }
  let id = opt.slots[slotName];
  if (id && !catalogue[id]) { console.error(`--slot ${slotName}=${id}: no such texture on Poly Haven.`); process.exit(1); }
  if (!id) id = slot.prefer.find((p) => catalogue[p] && !used.has(p));
  if (!id) id = (ranked.find((r) => !used.has(r.id) && r.s >= 4) || {}).id;
  if (!id) { console.warn(`  ${slotName}: no suitable texture found, keeping the procedural one.`); continue; }
  used.add(id);
  chosen[slotName] = id;
}
if (opt.list) process.exit(0);

const manifest = {
  source: 'Poly Haven (https://polyhaven.com)',
  license: 'CC0 1.0',
  generated: new Date().toISOString(),
  textures: {},
};
let failures = 0;
for (const [slotName, id] of Object.entries(chosen)) {
  const asset = catalogue[id];
  const slot = SLOTS[slotName];
  process.stdout.write(`${slotName.padEnd(11)} ${asset.name} (${id})\n`);
  try {
    const files = await getJSON(`${API}/files/${id}`);
    if (!files) throw new Error('no file list');
    const albedo = pickFile(files, MAPS.albedo, opt.res);
    const normal = pickFile(files, MAPS.normal, opt.res);
    let rough = pickFile(files, MAPS.rough, opt.res), roughChannel = 0;
    if (!rough) { rough = pickFile(files, MAPS.arm, opt.res); roughChannel = 1; }
    const height = pickFile(files, MAPS.height, opt.res);
    if (!albedo || !normal) throw new Error('missing diffuse or OpenGL normal map');
    const entry = {
      id, name: asset.name, url: `https://polyhaven.com/a/${id}`, authors: authorsOf(asset),
      sizeM: Array.isArray(asset.dimensions) && asset.dimensions[0] > 0 ? +(asset.dimensions[0] / 1000).toFixed(3) : null,
      maxSize: slot.size || null,
      files: {},
    };
    for (const [kind, f] of Object.entries({ albedo, normal, rough, height })) {
      if (!f) continue;
      const rel = `textures/${slotName}/${kind}.${f.fmt}`;
      const how = await download(f.url, path.join(OUT, rel), f.size);
      entry.files[kind] = rel;
      console.log(`   ${kind.padEnd(7)} ${f.res} ${f.fmt}  ${how}`);
    }
    if (rough) entry.roughChannel = roughChannel;
    manifest.textures[slotName] = entry;
  } catch (e) {
    failures++;
    console.warn(`   failed: ${e.message} (this slot stays procedural)`);
  }
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'assets.json'), JSON.stringify(manifest, null, 2) + '\n');
writeCredits(manifest);
const n = Object.keys(manifest.textures).length;
console.log(`\nDone: ${n} slot(s) use photoscanned textures${failures ? `, ${failures} failed` : ''}.`);
console.log('Wrote public/assets/assets.json and updated CREDITS.md. Restart or reload the game to see them.');
console.log('Use ?photo=0 in the URL to compare with the procedural textures.');
