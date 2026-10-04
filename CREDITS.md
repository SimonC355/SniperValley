# Credits

## Assets

All textures, meshes and sounds in this prototype are **generated procedurally at runtime** by
the code in `src/` (GPU-baked noise textures, Canvas2D foliage and ghillie strips, generated
trees, rocks, characters, rifle, birds, and WebAudio synthesis). No third-party art or audio
files are included.

The intended CC0 sources (Poly Haven, Quaternius) could not be downloaded from the build
environment because its network policy blocked them. `public/assets/` is reserved for CC0
replacements. If you add any, list them here with author, source URL and licence (CC0).

## Libraries

- [three.js](https://threejs.org) (MIT), including its `examples/jsm` addons (EffectComposer,
  RenderPass, ShaderPass, UnrealBloomPass, Reflector, Sky).
- [Vite](https://vitejs.dev) (MIT): dev server and build.

## Fonts

- [Rajdhani](https://fonts.google.com/specimen/Rajdhani) by Indian Type Foundry, SIL Open Font
  License, loaded from Google Fonts (falls back to the system font when offline).
