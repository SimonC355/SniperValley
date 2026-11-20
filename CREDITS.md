# Credits

## Assets

By default, all textures, meshes and sounds in this game are **generated procedurally at
runtime** by the code in `src/`:

- GPU-baked noise textures, Canvas2D foliage and ghillie strips.
- Generated trees, rocks, logs, stumps, characters, rifle and birds.
- WebAudio synthesis.

No third-party art or audio files are included in the repository. The program icon
(`electron/icon.png`, `electron/icon.ico`) is drawn by `scripts/make-icon.mjs`.

`npm run assets` optionally downloads CC0 photoscanned textures from
[Poly Haven](https://polyhaven.com) into `public/assets/`, which is git-ignored. The script
rewrites the block below with the downloaded assets and their authors. Poly Haven assets are
CC0 1.0, so credit is appreciated but not required.

<!-- photo-assets:begin -->
_No photoscanned textures downloaded. Run `npm run assets` to fetch CC0 textures from Poly Haven._
<!-- photo-assets:end -->

## Libraries

- [three.js](https://threejs.org) (MIT), including its `examples/jsm` addons (EffectComposer,
  RenderPass, ShaderPass, UnrealBloomPass, Reflector, Sky).
- [Vite](https://vitejs.dev) (MIT): dev server and build.
- [ws](https://github.com/websockets/ws) (MIT): WebSocket server for the LAN relay.
- [Electron](https://www.electronjs.org) (MIT, with Chromium's licences in
  `LICENSES.chromium.html` next to the program): the Windows program.
- [@electron/packager](https://github.com/electron/packager) (BSD-2-Clause): builds the
  program (not shipped with it).
- [steamworks.js](https://github.com/ceifa/steamworks.js) (MIT): Steam support for online
  play. It includes Valve's Steamworks API library (`steam_api64.dll`), which Valve lets games
  ship with them; Steam and Steamworks are Valve's. The program ships the steamworks.js licence
  in `licenses/steamworks.js-MIT.txt`.

## Fonts

- [Rajdhani](https://fonts.google.com/specimen/Rajdhani) by Indian Type Foundry, SIL Open Font
  License 1.1, bundled with the game through [Fontsource](https://fontsource.org)
  (`@fontsource/rajdhani`), so it also works offline. The program ships the licence text in
  `licenses/Rajdhani-OFL.txt`, next to those of three.js and ws.
