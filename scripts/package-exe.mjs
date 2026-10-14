// `npm run exe` (after `vite build`): packs the built game and the program files into
// release/SniperValley-win32-x64/SniperValley.exe. Zip that folder to share it.
// PLATFORM=linux packs a Linux build instead (used for testing on Linux).
import fs from 'node:fs';
import path from 'node:path';
import { packager } from '@electron/packager';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const platform = process.env.PLATFORM || 'win32';
if (!fs.existsSync('dist/index.html')) {
  console.error('dist/ is missing: run `npm run build` first (`npm run exe` does both).');
  process.exit(1);
}
// The .exe icon is set with rcedit, a Windows tool (other systems would need Wine).
const icon = platform === 'win32' && process.platform !== 'win32' ? undefined : 'electron/icon';
if (platform === 'win32' && !icon) console.warn('Not on Windows: the .exe keeps the default Electron icon.');

// Steam support (steamworks.js) ships its native files for every system: keep this one's
const steamDirs = { win32: 'win64', linux: 'linux64', darwin: 'osx' };
const otherSteam = Object.entries(steamDirs).filter(([p]) => p !== platform).map(([, d]) => d).join('|');

const [out] = await packager({
  dir: '.',
  out: 'release',
  overwrite: true,
  platform,
  arch: 'x64',
  name: 'SniperValley',
  executableName: 'SniperValley',
  appVersion: pkg.version,
  icon,
  // native modules (Steam support) can't load from inside the asar archive
  asar: { unpack: '**/*.{node,dll,so,dylib}' },
  prune: true,
  // only the built game, the program files and the relay go into the app
  ignore: [
    /^\/(src|scripts|public|release|\.github)(\/|$)/,
    /^\/(index\.html|vite\.config\.js|README\.md|NOTES\.md|CHANGELOG\.md|\.gitignore)$/,
    /^\/server\/lan\.mjs$/,
    /^\/electron\/icon\.ico$/,
    /^\/node_modules\/(\.vite-temp|\.package-lock\.json)/,
    /^\/node_modules\/@types(\/|$)/,
    new RegExp(`^/node_modules/steamworks\\.js/dist/(${otherSteam})(/|$)`),
    /^\/node_modules\/steamworks\.js\/dist\/.*\.lib$/,
  ],
  win32metadata: {
    CompanyName: 'SniperValley',
    FileDescription: 'SniperValley',
    ProductName: 'SniperValley',
    InternalName: 'SniperValley',
    OriginalFilename: 'SniperValley.exe',
  },
});

// Chromium's own texts (menus, dialogs) in 55 languages; the game is in English, so keep
// English and Danish (other languages fall back to English)
const keep = new Set(['en-US.pak', 'da.pak']);
for (const f of fs.readdirSync(path.join(out, 'locales'))) if (!keep.has(f)) fs.rmSync(path.join(out, 'locales', f));

// Steam's library also next to SniperValley.exe, where Windows looks for it first
if (platform === 'win32') fs.copyFileSync('node_modules/steamworks.js/dist/win64/steam_api64.dll', path.join(out, 'steam_api64.dll'));

// credits and the licences of what is bundled, next to the program
const lic = path.join(out, 'licenses');
fs.mkdirSync(lic, { recursive: true });
fs.copyFileSync('CREDITS.md', path.join(out, 'CREDITS.md'));
for (const [from, to] of [
  ['node_modules/three/LICENSE', 'three.js-MIT.txt'],
  ['node_modules/ws/LICENSE', 'ws-MIT.txt'],
  ['node_modules/steamworks.js/LICENSE', 'steamworks.js-MIT.txt'],
  ['node_modules/@fontsource/rajdhani/LICENSE', 'Rajdhani-OFL.txt'],
]) {
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(lic, to));
}
console.log(`\nSniperValley ${pkg.version} packed: ${out}`);
