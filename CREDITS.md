# Credits

## Assets

By default, all textures, meshes and sounds in this prototype are **generated procedurally at
runtime** by the code in `src/`:

- GPU-baked noise textures, Canvas2D foliage and ghillie strips.
- Generated trees, rocks, logs, stumps, characters, rifle and birds.
- WebAudio synthesis.

No third-party art or audio files are included in the repository.

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

## Fonts

- [Rajdhani](https://fonts.google.com/specimen/Rajdhani) by Indian Type Foundry, SIL Open Font
  License, loaded from Google Fonts (falls back to the system font when offline).
