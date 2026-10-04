# SniperYard prototype: design notes, ambiguities and choices

This prototype lets you feel the core concept before committing to UE5. Gameplay numbers live
in `src/config.js`. This file explains how the spec was interpreted and where I made choices.

## Assets (important)

The build environment's network policy **blocked Poly Haven, Quaternius and jsDelivr**, so
no CC0 assets could be downloaded. As the brief allowed, everything is generated
procedurally at load time:

- Terrain, rock, bark, mud and water textures are baked on the GPU into tileable render targets
  (albedo + height, then normal + roughness). The code is in `src/textures.js`.
- Needle sprays, pine tufts, ferns, leaves and ghillie strips are drawn with Canvas2D.
- Trees (spruce, fir, pine, dead snag), undergrowth, rocks, ghillie characters, the rifle and
  crows are generated meshes.
- All audio is synthesised with WebAudio (no sample files).

`public/assets/` is empty. To try real CC0 assets later, replace the texture or mesh builders.
The rest of the game only depends on their outputs.

## Map

- The valley runs along **X**: the play area is 440 m along it and 380 m across (Z). The river
  meanders around z ≈ 0 at y = 0.
- **ALPHA (you)** holds the **north slope (+Z)**, **BRAVO** the south slope (−Z). The compass
  puts north toward +Z. You spawn looking south across the valley.
- Ridges are about 60 m above the water, roughly 175 m from the river. Slopes average about
  20°, with spurs and gullies running downhill and a terrace on each side.
- The terrain continues as scenery beyond the play area (distant hills, impostor forest).
  Invisible walls stop you at the play-area edge.
- **Water:** deep water (> 0.85 m) is **impassable**. The shallow shelf slows you to 55% and
  every step makes a splash. A splash is a reveal event, audible to about 90 m. Optional shallow
  fords can be added with `map.fords: [x, ...]`; there are none by default, per the design
  assumption.
- About 2,800 trees stand in the play area, with clearings from a noise mask. Measured at
  sniper positions, roughly 17% of cross-valley spot pairs have line of sight, at a median of
  about 210 m.

## Shrinking zone

- **One step every 60 s**, made of a **30 s hold**, a **10 s warning** and a **20 s smooth
  shrink**. The first shrink therefore finishes at 1:00. Steps come from
  `zone.steps = [1, 0.8, 0.62, 0.46, 0.32, 0.2]`.
- During the warning, the next boundary is drawn as a blinking dashed white line on the terrain
  plus a white curtain. The current boundary is an orange line, an orange curtain, and a red
  tint on the ground outside.
- **'ends'** (default): the zone is an X-range, `|x| <= 220 * factor`, closing from both valley
  ends. Both slopes and the cross-valley duel survive to the end; the final zone is 88 m long.
- **'radial'**: a circle centred on the river at x = 0. Its starting radius covers the whole
  rectangle (about 291 m); the final circle has a radius of about 58 m.
- **Damage outside** grows per completed step: `[2, 4, 7, 11, 16, 24, 30]` hp/s. The zone
  can kill AI too.
- **T (debug)** finishes the current step instantly and starts the next warning, so pressing T
  repeatedly walks through the steps.
- Mode and team size can be changed in the start/pause menu (they apply on restart), or in the
  URL: `?mode=radial&team=3`.

## Reveal mechanics

- **Scope glint**: a scoped character glints toward any viewer within a **10° cone** around its
  aim, at full strength under about 3°. It is a depth-tested HDR sprite (trees and terrain hide
  it) that keeps a minimum angular size so it reads at 300 m+.
  - The HUD shows your own glint whenever you are scoped. It deliberately does **not** tell
    you whether anyone can see it; that would leak enemy positions.
  - A glint toward an entity that lasts longer than `glintSustain` (0.4 s) emits a `glint`
    event with `targetId`, re-emitted about every 2 s.
- **Shot flash**: an HDR additive sprite that blooms, with a brief warm spill light. It lasts
  0.2 s and is visible to 400 m with line of sight.
  - AI notice a flash within 100° of where they are looking.
  - Shots are also heard: sound arrives after `distance / 340` s, through a valley-echo convolver.
  - Tracers are `faint` by default; set `weapon.tracers` to `'off'` or `'bright'`.
- **"You are being aimed at"**: shown when an enemy AI in aim or fire state is targeting you,
  its glint points at you (within 10°), and it has line of sight. It tells you *that* you are
  being aimed at, never *where* from. Toggle with `hud.aimedAtWarning`.
- **Event bus** (`src/events.js`): `{type, position, time, sourceTeam, sourceId, ...}` with
  these types:
  - `shot`, `flash`, `glint` (with `targetId`), `birds`, `splash`, `footstep`, `impact`.
  - AI ignore events from their own team (teams know their own noise).
  - F1 shows the live event log.

## Birds

- 12 flocks of 6–12 crows sit on the outside of tree crowns (preferring snags and tall trees),
  6 per slope, spread along the valley.
- **What flushes a flock**:
  - **Proximity** inside `8 m + speed × 2.5`: a sprint at 7 m/s disturbs them from about 25 m,
    scoped prone movement from about 10 m.
  - **Shots** within 40 m.
  - **Bullet impacts** within 12 m. A miss can therefore reveal the *target's* area.
- **Flight**: birds rise, circle for about 8 s, drift wider and higher, then land after about
  25 s. Landing is postponed while someone is still close.
- Each flush emits one `birds` event at the flock's ground centre. Opposing AI within 380 m
  investigate it; no line of sight is needed, because they hear the caws.

## Characters and camouflage

- Each ghillie is a skinned capsule body covered by about 550 alpha-cut strips (burlap, leaf and
  grass). A hood veil and a back cape break up the head and shoulder outline. The strips sway in
  the wind in the vertex shader.
- **Hit detection uses stance-based body capsules** (head sphere, torso, legs, arms), never the
  suit volume. The procedural poses (stand, kneel, prone, aim, walk, dead) are authored to
  match them. You can see the capsules directly on `?dummies=1` targets.
  - Prone capsules follow the slope.
  - Head and body hits both kill; "HEADSHOT" is only a label.
- **`camouflageStrength`** (0–1, default 0.85) controls two things:
  1. **AI visual spotting.** Conspicuity is `1 − camo × (1 − 0.35 × moveFactor)`, so a still
     target is 0.15 and a moving one only 0.45: moving makes you *slightly* easier to see.
  2. **The suit colour.** Each suit is tinted toward the local ground (forest floor or grass).
     At low values the suits turn a uniform light tan that stands out.
- Teammates (your team only) get a small HUD chevron with name and distance, plus a faint
  team-colour armband. Enemies have no markers.

## AI

- **States**: `idle → scan → investigate → aim → fire → cool`, plus **`move`** (relocating).
  Move is not in the brief's list, but relocation needs a state.
- **Sniper spots**: at load, about 90 candidate spots per slope are scored for view across the
  valley (line-of-sight samples), nearby cover and height (ridge preference). AI hold these
  spots, keep about 24 m from teammates, relocate every 35–65 s and after shooting, and only
  pick spots inside the current or upcoming zone.
- **No seeing through camouflage.** Targets are acquired through:
  - **Reveal events**, which trigger `investigate`. The AI turns, scopes in (and glints) toward
    the point, and spotting near it is 4× faster with 2.2× range.
  - **Visual spotting**, scaled by camouflage, movement, stance, distance and partial occlusion.
    Bushes soften visibility; trunks, crown cores, rocks and terrain block it.
  - **Glints**: seeing your glint raises awareness and, once sustained, triggers investigate.
  - **Hearing**: shot bearing error is ±14° (growing with distance) and range error ±25%, so a
    heard shot gives an *area*, not a point. Splashes and footsteps are heard at short range.
- **Scanning** favours likely hides: mostly good spots on the opposite slope that are visible
  from where the AI sits. That is terrain knowledge, not enemy knowledge. About 45% of scans
  are scoped, so AI glint while they scan.
- **Aiming** starts with a random 2.5–7.5° error that settles over the aim time
  (`1.1 s + 6 ms/m`, ×0.8–1.3). The AI's glint becomes visible to you while it lines up. Aim
  time is ×0.6 if you are scoped and looking straight at it (the duel).
- **Hit chance** is `0.9 − 0.0011/m`, ×0.45 against a target moving fast, ×0.75 against one
  moving slowly, and ×0.85 against prone. A miss lands 0.6–1.8 m off and still uses real
  raycasts, so trees can eat shots.
- AI never fire through teammates. You can (friendly fire is on).
- **Balance check**: six AI-only 3v3 rounds took 90–180 s and all ended in elimination.
  ALPHA won 5 of 6.

## Player

- Controls from the brief, plus two additions:
  - **C/Ctrl crouch** and **Z prone**. Camouflage and spotting depend on stance, so this felt
    essential.
  - **Shift while scoped holds your breath** for 3 s (sway ×0.12), followed by a short
    out-of-breath penalty.
- Hip-fire has 2.5° random spread (`weapon.hipSpread`), so you need to scope.
- Scope sway grows with movement and lingers after sprinting. Recoil kicks about 3° and
  recovers 55%.
- **Bolt cycle 1.5 s**, with a viewmodel bolt animation and synthesised clicks.
- **Optional ballistics** (`weapon.ballistics.enabled`, or the menu, or `?ballistics=1`):
  850 m/s, drop and wind. At 200 m the drop is about 0.27 m.
- **Freeze time**: 3 s at round start (`round.freezeTime`). You can look around but not move
  or fire.
- **After death** you spectate a living teammate (click to switch). A round ends when one team
  is eliminated: VICTORY or ELIMINATED with stats, and R restarts.

## What blocks what

| | Bullets | Line of sight (AI, glint, flash) |
|---|---|---|
| Terrain | yes | yes |
| Tree trunks | yes | yes |
| Tree crown *core* (inner ~40% radius, where foliage is drawn dense) | yes | yes |
| Outer needle cards | no | no (gaps you can see through are real) |
| Rocks | yes | yes |
| Bushes, ferns | no | soften AI visibility |
| Water surface | stops bullets (splash) | no |

## Rendering choices

- **Lighting and sky**: PBR materials, ACES tone mapping in a custom final pass, PCF soft
  shadows, a Preetham sky with clouds blended into the fog colour at the horizon, and
  exponential height fog with sun in-scattering. The fog is a global shader-chunk override, so
  every material gets it.
- **Shadows** follow the view: ahead of you when unscoped; when scoped, centred on the aim
  point with a tighter frustum, so distant scoped targets have crisp shadows.
- **Tree LOD**: LOD0 cards, LOD1 reduced cards, then baked billboard impostors with albedo and
  normal maps. The switch uses *effective* distance (distance × FOV/70), so everything in the
  scope gets full detail.
  - Separate ~80-triangle shadow proxies are drawn only in the shadow pass (their vertices
    collapse in the main pass).
- **Grass**: instanced and world-anchored in tiles around you. When scoped, the grass field
  re-centres on the aim point, so a prone target in grass stays hidden through the scope.
- **Water**: planar reflection at half resolution (it skips grass, undergrowth and LOD0 trees,
  and uses a coarse terrain), fresnel, transparency from the depth heightmap, flowing normals
  and sun glints.
- **Post-processing**:
  - Half-res depth-based SSAO. Three's GTAO pass re-renders the scene with an override material
    that ignores alpha-cut foliage.
  - Bloom, tuned so that only the glint, muzzle flash, sun disc and water sparkles bloom.
  - A lens pass with barrel distortion, chromatic aberration, a mil-dot duplex reticle,
    vignette and grain.
- **Budget**: about 1.3M triangles and about 165 draw calls per frame from a slope vista.
  **I could only render with a software rasteriser here, so real frame rates are unmeasured.**
  - Options: render scale, shadow quality (off/low/medium/high), SSAO, bloom, reflections,
    MSAA, grass density.
  - `?quality=low` applies a low preset in one go.

## Known limitations and ideas

- LOD transitions are hard switches; dithered cross-fades would hide popping.
- The AI uses straight-line movement with local trunk avoidance (no navmesh), which is enough
  for open slopes.
- AI don't use the sun direction (glare), and the glint ignores the sun angle. Both are cheap
  next steps if the designer wants sun-side tactics.
- Bird motion is analytic and the flocks don't avoid trees.
- No points or ranking (out of scope).
