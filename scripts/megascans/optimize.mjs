// `npm run megascans`: turns Megascans models downloaded from Fab (glTF, e.g. "..._mid.glb") into
// light copies the game loads: geometry simplified to a budget per kind of object, textures
// scaled to 1024 px WebP, meshopt-compressed, plus a far copy (*-far.glb, about a fifth of the
// triangles). Writes public/assets/megascans/<name>.glb, <name>-far.glb and megascans.json.
//
// The Fab Standard License does not allow sharing the files themselves, so everything stays in
// public/assets/megascans/ (git-ignored) and never goes into this repository, which is public.
//
//   node scripts/megascans/optimize.mjs [folder with the downloaded .glb files ...]
// Default sources: megascans-src/ in the project folder (git-ignored, and outside public/, so the
// originals are not copied into every build), then public/assets/megascans/source/ and loose .glb
// files in public/assets/ (where they were first put).
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, weld, simplify, textureCompress, meshopt, flatten, join, getBounds } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const OUT = path.join(ROOT, 'public/assets/megascans');
const sources = process.argv.slice(2).length ? process.argv.slice(2) : [path.join(ROOT, 'megascans-src'), path.join(OUT, 'source'), path.join(ROOT, 'public/assets')];

// What the object is (from the Megascans name) and its triangle budget near / far.
const KINDS = [
  ['mushroom', /mushroom/i, 900, 200],
  ['uprooted', /uprooted/i, 2600, 500],
  ['stump', /stump|snag/i, 1300, 260],
  ['root', /root/i, 1600, 320],
  ['log', /log|fallen|mossy_tree|trunk/i, 2400, 420],
  ['rock', /rock|boulder|cliff|stone/i, 2400, 420],
  ['prop', /./, 1600, 320],
];

function kindOf(name) {
  for (const [kind, re, near, far] of KINDS) if (re.test(name)) return { kind, near, far };
  return { kind: 'prop', near: 1600, far: 320 };
}

// How the game uses it (megascans.json "role"; edit the file to change one):
//   rock-boulder / rock-slab   rocks (collision follows the drawn top; you can climb them)
//   log                        fallen trunks (cover)
//   snag                       stumps and broken standing trunks (cover)
//   uprooted                   a fallen tree with its root plate (big cover)
//   patch                      flat ground pieces (twigs, roots, dirt, needles): decoration
//   mushroom                   tiny, near logs and stumps: decoration
// Flat pieces (height under ~a quarter of the length) are patches whatever their name says:
// Megascans' "fallen pine tree" and "ground rock" scatters are mostly a piece of forest floor.
function roleOf(kind, size) {
  const flat = size[1] / Math.max(size[0], size[2]);
  if (kind === 'mushroom') return 'mushroom';
  if (kind === 'uprooted') return 'uprooted';
  if (kind === 'stump') return 'snag';
  if (kind === 'root') return 'patch';
  if (kind === 'rock') return flat < 0.12 ? 'patch' : flat < 0.3 ? 'rock-slab' : 'rock-boulder';
  if (kind === 'log') return flat < 0.3 && size[1] < 1.2 ? 'patch' : 'log';
  return flat < 0.2 ? 'patch' : 'prop';
}

// Mean brightness (linear luminance) of a model's base colour texture. Megascans are calibrated
// dark (mossy rock about 0.02-0.06) next to the game's own textures (rock 0.23, bark 0.13), so
// the game lifts them to match the scene (megascans.js).
async function albedoOf(doc) {
  const mat = doc.getRoot().listMaterials()[0];
  const tex = mat && mat.getBaseColorTexture();
  if (!tex) return null;
  const { data, info } = await sharp(Buffer.from(tex.getImage())).resize(64, 64).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  let sum = 0;
  for (let i = 0; i < data.length; i += info.channels) sum += 0.2126 * lin(data[i]) + 0.7152 * lin(data[i + 1]) + 0.0722 * lin(data[i + 2]);
  return +(sum / (data.length / info.channels)).toFixed(4);
}

function triangles(doc) {
  let t = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    const idx = p.getIndices();
    t += idx ? idx.getCount() / 3 : p.getAttribute('POSITION').getCount() / 3;
  }
  return t;
}

async function build(io, file, budget, texSize, error = 0.02) {
  const doc = await io.read(file);
  await doc.transform(dedup(), flatten(), join(), weld());
  const before = triangles(doc);
  const ratio = Math.min(1, budget / Math.max(1, before));
  if (ratio < 1) await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio, error, lockBorder: false }));
  await doc.transform(
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [texSize, texSize], quality: 82 }),
  );
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  return { doc, before, after: triangles(doc) };
}

async function main() {
  await Promise.all([MeshoptSimplifier.ready, MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  const files = [];
  for (const s of sources) {
    if (!fs.existsSync(s)) continue;
    for (const f of fs.readdirSync(s)) {
      // Windows copies ("... - Kopi.glb", "... - Copy.glb") are the same model twice
      if (f.toLowerCase().endsWith('.glb') && !/ - (kopi|copy)/i.test(f)) files.push(path.join(s, f));
    }
  }
  if (!files.length) {
    console.log(`No .glb files found in ${sources.join(' or ')}. Put the Megascans downloads (glTF .glb) in megascans-src/.`);
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const manifest = [];
  const seen = new Set();
  for (const file of files) {
    const base = path.basename(file, '.glb').replace(/_(mid|high|low|raw)$/i, '');
    if (seen.has(base)) continue;
    seen.add(base);
    const { kind, near, far } = kindOf(base);
    const tex = kind === 'mushroom' ? 512 : 1024;
    const a = await build(io, file, near, tex);
    const b = await build(io, file, far, Math.min(tex, 512), 0.12);   // the far copy may lose more shape
    const box = getBounds(a.doc.getRoot().listScenes()[0]);
    const size = box.max.map((v, i) => +(v - box.min[i]).toFixed(3));
    await io.write(path.join(OUT, `${base}.glb`), a.doc);
    await io.write(path.join(OUT, `${base}-far.glb`), b.doc);
    const kb = (f) => Math.round(fs.statSync(path.join(OUT, f)).size / 1024);
    const role = roleOf(kind, size);
    const albedo = await albedoOf(a.doc);
    manifest.push({ name: base, kind, role, file: `${base}.glb`, far: `${base}-far.glb`, tris: a.after, farTris: b.after, size, albedo });
    console.log(`${role.padEnd(12)} ${base.padEnd(58)} ${a.before} → ${a.after} / ${b.after} triangles · ${kb(`${base}.glb`)} + ${kb(`${base}-far.glb`)} KB · ${size.join(' × ')} m · albedo ${albedo}`);
  }
  fs.writeFileSync(path.join(OUT, 'megascans.json'), JSON.stringify({ models: manifest }, null, 1));
  console.log(`\n${manifest.length} models → ${OUT} (git-ignored; never commit Fab files)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
