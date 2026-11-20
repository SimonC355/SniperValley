# SniperValley: design notes, ambiguities and choices

This prototype lets you feel the core concept before committing to UE5. Gameplay numbers live
in `src/config.js`. This file explains how the spec was interpreted and where I made choices.

## Assets (important)

The build environment's network policy **blocked Poly Haven, Quaternius, ambientCG and
jsDelivr**, so no CC0 assets could be downloaded here. As the brief allowed, everything is
generated procedurally at load time by default:

- Terrain, rock, bark, mud and water textures are baked on the GPU into tileable render targets
  (albedo + height, then normal + roughness). The code is in `src/textures.js`.
- Needle sprays, pine tufts, ferns, leaves and ghillie strips are drawn with Canvas2D.
- Trees (spruce, fir, pine, dead snag), undergrowth, rocks, logs, stumps, ghillie characters,
  the rifle and crows are generated meshes.
- All audio is synthesised with WebAudio (no sample files).

### Photoscanned textures: `npm run assets`

Because the downloads work on a normal machine, `scripts/fetch-assets.mjs` fetches CC0
photoscans from Poly Haven into `public/assets/` there.

- **Slots**: grass, forest floor, rock, mud, spruce bark and pine bark. Each slot has a list of
  preferred Poly Haven ids. If none of them exists, it falls back to the best tag match in the
  catalogue (with words such as *wall*, *paving* or *planks* penalised), so a renamed asset
  does not break the script.
- **Files**: diffuse, OpenGL normal, roughness (or the G channel of `arm`) and displacement, at
  2k by default. The script writes `public/assets/assets.json` (ids, authors, real-world size)
  and the CC0 table in CREDITS.md.
- **Loading** (`src/assets.js`): at startup each slot is packed on the GPU into exactly the
  layout of the procedural bakes (albedo + height in alpha, normal + roughness in alpha), so
  terrain, boulders, bark, grass colour and debris use them unchanged.
  - The terrain and boulder tile size comes from Poly Haven's real-world dimensions.
  - `assets.adjust` (gain, saturation, normal and height strength) and `assets.tileScale` in
    the config tune each slot.
  - Missing files, a bad manifest or `?photo=0` fall back to the procedural texture for that
    slot.
- **Not in git**: the downloads are git-ignored because they total about 70 MB at 2k. Every
  machine runs `npm run assets` once.
- **Testing**: I could only run the script against a local mock of the Poly Haven API that
  serves the same JSON shapes (catalogue, `/files/{id}`, download URLs). The mock covered the
  `arm` roughness fallback, a missing displacement map and tag-based picking. The game then
  loaded the mock textures correctly on terrain, rocks and bark. **The real API and real
  photoscans are untested here.** Expect to tune colour and tile size once real textures are
  in.
- **Scope**: textures only. Trees stay procedural: realistic CC0 conifer models are rare, and
  the tree system depends on its own LOD, impostor and wind setup.

### Megascans (asked about, not added)

Quixel Megascans now live on Epic's Fab marketplace under the Fab Standard License. That
license allows use in any engine, web included, but Megascans are **not CC0**: most cost money
since 2025 (assets claimed during the free period in 2024 stay yours), and the license is for
use inside a project, not for sharing the files themselves. The brief asked for CC0 only, so
none are in the repository.

If you want them anyway, the plan is the same as for the photoscans: you download the assets
you own into a git-ignored folder (`public/assets/megascans/`), and a loader uses them when
they are there and falls back to the procedural forest when they are not. Megascans 3D plants
are made for desktop engines, so the browser build would use their lowest LODs, bake
impostors from them, and keep our wind and collision setup.

## Map

- The valley runs along **X**: on the Valley map the play area is 440 m along it and 380 m
  across (Z). The river meanders around z ≈ 0 at y = 0.
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

### Three map sizes

The feedback was that the valley is huge for 2v2, so there are two smaller cuts of the same
valley (`MAPS` in `src/config.js`). After the first longer play test ("even smaller"), v0.3.1
made all three about a quarter smaller again:

| Map | Play area | Ridge distance / height | River (deep / waterline half-width) | Zone step |
|---|---|---|---|---|
| Valley | 340 × 290 m (was 440 × 380) | 136 m / 52 m | 8 / 15 m | 50 s |
| Narrow valley | 260 × 210 m (was 340 × 270) | 98 m / 40 m | 6.5 / 12.5 m | 42 s |
| Ravine | 200 × 150 m (was 260 × 200) | 70 m / 31 m | 5 / 10 m | 36 s |

- **Same style:** the same terrain recipe, scaled. The smaller maps also have a gentler river
  meander and less relief on the slopes, so the slopes stay walkable and the AI still finds
  flat sniper spots. The slopes are a little steeper on the smaller maps (a ravine should feel
  like one).
- **The mountains stay where they are.** The distant mountains are placed at the same distance
  from the river on every map, so on the smaller maps a forested plateau lies between the ridge
  and the mountains. Scaling them with the map put a 30° mountain wall right behind the ridge,
  which hid the low sun.
- **Scaled with the map:** AI sniper spots and the slope they look across, AI scan targets,
  spawn spread along the valley, bird flock placement, and the `?dummies=1` targets. Rocks,
  bushes, logs, stumps, branches and bird flocks scale with the play area so the forest is as
  dense as before. Trees already follow the area.
- **One map per page load.** The world (terrain, forest, colliders, sniper spots) is built at
  load, so changing the map saves the choice and reloads. Match settings (team size, rounds,
  zone and so on) are now saved in the browser too, so they survive the reload.
- **LAN:** the host sends its map with its lobby hello; the relay shows it to everyone. A
  friend whose map differs reloads with the host's map when they click JOIN and joins by
  itself. When the host changes map, it tells the joined players first; everyone reloads, the
  host hosts again and the others rejoin. Round messages also carry the map as a safety net.
- The benchmark always runs on the Valley map so results stay comparable.

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

- **30 flocks of 3–10 crows** on the Valley map (16 on Narrow valley, 10 in the Ravine), one
  per cell of a grid that runs along the valley and up both slopes (low, middle and high),
  so there are birds everywhere. Each flock spreads over up to four neighbouring trees and
  prefers snags and tall trees. The play tests found the old 12 flocks too few to notice.
- **Perched crows sit upright**, mostly on the treetops, so they stand out against the sky.
  The old perch kept the flight pose (body flat), which from the front or behind was a sliver
  of two to four pixels at 25 m.
- **Perched life.** Birds look around every few seconds, flick their wings, and now and then
  one hops to another branch and back. A perched flock calls about every 48 s: one bird, one
  to three caws, quieter than the alarm, and it leans forward with each caw. You can find
  flocks by ear before you see them.
- **LAN:** calls and hops are computed from the flock, the round and the game clock (no
  random state), so everyone sees and hears the same ones at the same time.
- **Sounds:** a flush is a burst of wing beats from every bird (a low "whup" of air per stroke
  plus a feather swish, strongest at take-off), twigs thrashing as they leave the crown, and
  alarm caws while they circle. You also hear wing beats when a bird flies close past you,
  when one hops nearby, and when the flock settles back into the trees. Caws got a rougher
  voice and a little valley echo. Recorded `wings` and `caw` samples can replace them (see
  the README).
- **What flushes a flock**:
  - **Proximity** inside `8 m + speed × 2.5`: a sprint at 7 m/s disturbs them from about 25 m,
    scoped prone movement from about 10 m.
  - **Shots** within 40 m.
  - **Bullet impacts** within 12 m. A miss can therefore reveal the *target's* area.
- **Flight**: birds rise, circle for about 8 s, drift wider and higher, then land after about
  25 s. Landing is postponed while someone is still close.
- Each flush emits one `birds` event at the flock's ground centre. Opposing AI within 380 m
  investigate it; no line of sight is needed, because they hear the caws.
- With 30 flocks, a minute of AI play flushed 0 flocks on the Valley map and 2 in the Ravine
  (the AI mostly holds still), so birds give players away more often without becoming noise.
  Perched calls and hops never trigger a reveal.

## Characters and camouflage

- Each ghillie is a skinned capsule body covered by about 550 alpha-cut strips (burlap, leaf and
  grass), about 210 thin jute threads and 60 grass tufts sticking up and out of the shoulders,
  upper back and hood. A hood veil and a back cape break up the head and shoulder outline.
- **The suit moves.** After skinning, every strand is displaced in world space, so the
  direction is right in any pose (standing, kneeling, prone):
  - wind sway and flutter, both stronger while a gust passes over the wearer;
  - drag: strands trail behind when the wearer moves and swing out when they turn (velocity and
    turn rate are smoothed, which gives the strands a little inertia), plus a bounce with the
    steps;
  - threads move the most and tufts a bit less (a per-vertex weight).
  - The body breathes (chest and spine, slower while aiming) and sways slightly while standing.
  - Shadows use the unmoved suit; the difference is a few centimetres.
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
- **Logs and stumps** count as cover when sniper spots are scored. Moving AI follow a log to
  its nearer end instead of walking into it.
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
- **Balance check** (before the forest-floor debris): six AI-only 3v3 rounds took 90–180 s and
  all ended in elimination. ALPHA won 5 of 6.
- **After the logs and stumps**, which add cover: four of six AI-only 3v3 rounds ended by
  elimination within 4 minutes (BRAVO won 3, ALPHA 1). Two were still 1v1 at the 4-minute
  mark. No AI stayed stuck on a log.

## Player

- Controls from the brief, plus two additions:
  - **C/Ctrl crouch** and **Z prone**. Camouflage and spotting depend on stance, so this felt
    essential.
  - **Shift while scoped holds your breath** for 4 s (sway ×0.1), followed by a 3 s
    out-of-breath penalty (see v0.3.1 below).
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
| Tree trunks (the drawn shape: tapered, bent, flared at the base) | yes | yes |
| Tree crown *core* (inner ~40% radius, where foliage is drawn dense) | yes | yes |
| Outer needle cards | no | no (gaps you can see through are real) |
| Rocks | yes | yes |
| Fallen logs, stumps | yes | yes (cover for prone players; logs block walking, but you can jump over them) |
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
- **Light shafts**: a screen-space radial blur of the sky around the sun (after GPU Gems 3,
  ch. 13), at quarter resolution, added in HDR before the viewmodel.
  - Sky pixels next to branches and trunks feed the shafts; open sky only adds a faint glow,
    so open views do not wash out.
  - They fade out when the sun is behind you or far off-screen. Esc → Sun shafts, or
    `?shafts=0`.
- **Colour grading** (`grade` in the config): log-space contrast around mid grey, saturation,
  and split toning (warm highlights, cool shadows), applied before ACES.
- **Fog** density went from 0.0024 to 0.002 so mid-range scope views are less grey.
- **Tree colour**: each tree gets a slight hue shift (yellower vs bluer stands plus per-tree
  jitter), so slopes no longer look like one repeated tree.
- **Forest floor** (`src/debris.js`):
  - About 240 fallen logs: mossy tops, one cut end, one splintered end, resting on both ends.
  - About 320 stumps with root flare and a cut top.
  - About 2,000 dead branches, drawn within about 70 m.
  - Everything sits under the canopy and keeps clear of trunks. None of it is drawn in the
    water reflection.
- **Post-processing**:
  - Half-res depth-based SSAO. Three's GTAO pass re-renders the scene with an override material
    that ignores alpha-cut foliage.
  - Bloom, tuned so that only the glint, muzzle flash, sun disc and water sparkles bloom.
  - A lens pass with barrel distortion, chromatic aberration, a mil-dot duplex reticle,
    vignette and grain.
- **Budget**: about 1.44M triangles and about 220 draw calls per frame from a slope vista,
  up from about 1.22M and 176 at the same view before the forest floor and light shafts.
  **I could only render with a software rasteriser here, so real frame rates are unmeasured.**
  - Options: render scale, shadow quality (off/low/medium/high), SSAO, bloom, reflections,
    MSAA, grass density.
  - `?quality=low` applies a low preset in one go.

## Match format, killcam and settings

- **Match**: best of 3 by default (`match.roundsToWin`, set in the MATCH tab or with
  `?rounds=`).
  - Teams swap slopes every round (`match.swapSides`) because the low sun makes the sides
    unequal: one slope looks into the sun and light shafts.
  - There are 6 s between rounds. A round where both teams die at once is a draw and gives no
    point.
  - The end screen shows match totals (rounds survived, shots, hits, eliminations, longest hit).
- **Killcam** (5 s, `round.killcamTime`): it looks from your eye toward the shooter. If the eye
  has no line of sight, it looks from where the bullet hit. It zooms until the shooter fills
  about 8 m of view.
  - For AI shooters it states the cue that led them to you. The AI records this when it
    acquires a target:
    - the investigated event (flash, shot, birds, splash, footsteps, glint), and whether you
      caused it or someone near you did;
    - or "spotted while scanning" / "you moved in their view".
  - It also lists your own recent giveaways from the event log: your shot, birds you flushed,
    splashing, sprinting, and a scope glint aimed at the shooter. The glint comes from aim
    samples taken 4 times per second over the last 15 s.
  - After the killcam you spectate a teammate (human or AI).
- **Settings** are saved per browser:
  - controls: sensitivity, scope sensitivity, FOV, invert Y, key bindings;
  - audio: master, effects and ambience volume, and the echo.
  - Every action can be rebound. A key bound to a new action is removed from its old one, which
    shows "-" until you bind it again.
- **Spawns**: the spawn bias toward high-scoring sniper spots now has more randomness. Before,
  rounds kept reusing the same spots.

## Sound

- Footsteps depend on the surface (`surfaceAt`):
  - grass is a low thud plus a swish;
  - forest floor is a thud plus a burst of needle and twig clicks, with an occasional twig
    snap;
  - rock and gravel is a higher, grainier crunch;
  - mud by the river is a wet squelch.
- **Gunshots were redesigned** after the feedback that they sounded like a bee flying past.
  The buzz came from pitch sweeps (a falling thump tone, a sweeping filter and a whizz band).
  Now there are no pitch sweeps at all (`src/sfx.js`, rendered into buffers at start):
  - The **muzzle blast** is a Friedlander blast wave (instant rise, about 1.5 ms positive phase,
    then the negative phase), hot-gas turbulence, a short low body, a ground reflection and a
    cluster of early reflections from the trees. Distance is applied when playing: level, air
    absorption (low-pass), a slight slow-down and more echo.
  - A bullet passing within 30 m plays the **supersonic crack**: an N-wave (the "pisk") with a
    ground reflection and slap echoes. Its length grows slowly with the miss distance. It
    arrives before the muzzle report, which is delayed by distance at 340 m/s.
  - A **soft clipper** (tanh) replaced the compressor on the master bus. The compressor's
    look-ahead flattened the first millisecond of a shot, which is exactly what makes it crack.
  - I checked the result by rendering the real sound chain offline in headless Chromium:
    own shot peaks at −0.2 dBFS, a crack at 3 m at −0.9 dBFS, a distant report at 300 m at
    −15 dBFS, and the spectrograms show no pitch sweeps.
- **Forest ambience** (`src/forestsound.js`): five songbirds sing from the trees around you
  (chaffinch, great tit, robin and thrush patterns), a woodpecker drums now and then,
  and needles rustle, louder in gusts. (Trunks creaked in strong gusts too; see below why
  that is gone.)
- **The second "bee".** After the gunshot fix, a play test still heard a bee flying around,
  and after the first fix "much better, but not completely gone". I built a buzz meter: it
  renders each sound offline and counts the 40 ms windows that have a real pitch (a
  repeating autocorrelation peak) in the insect band, 100–700 Hz. Results:

  | Sound | Windows with a pitch | Periodicity |
  |---|---|---|
  | Trunk creak, first version (gliding sawtooth) | 14 % | 0.99 |
  | Trunk creak, second version (wood slips ringing a 200 Hz resonance) | 19–20 % | 0.99–1.00 |
  | Crow caw, old (clean sawtooth, falling glide) | 18 % | 0.94 |
  | Everything now: gunshots, cracks, caws, wing beats, woodpecker, songbirds, gusts, river, wind | 0–3 % | ≤ 0.70 |

  So the bee was the creak both times (a creak is a tone in that range, however it is
  built), and the old caw was close. The creak is gone. The caw was then rendered as
  pulses at a very irregular rate through throat resonances; in v0.3.1 it became a
  "kraa" again (see below). The
  woodpecker knocks are now dry and countable (11–14 per second, no ringing resonance), the
  wren's fast trill is out, and a flushed flock caws at most nine times.
- **What was that noise?** The F1 debug panel lists the sounds of the last 10 s with their
  distance, so an odd sound can be named in a play test. The rustle has one source
  per ear, each following the gust 25 m to that side, so a gust is heard arriving from one
  side. Any gunshot within 700 m silences the birds for 22–40 s; they come back one by one.
- Volumes are separate buses: effects, ambience (wind, river, forest) and the echo send, all
  into the soft clipper and the master volume.
- Recorded samples can replace any sound through `public/assets/sounds/sounds.json` (see the
  README). Nothing is bundled: the CC0 sound sources were not reachable from this environment,
  and I can't listen here, so **the new synthesis is untested by ear**.

## Weather and the living forest

- **One cloud field for the sky and the ground** (`src/weather.js`). A tileable 256² noise
  texture covers 1.1 km of a cloud layer 900 m up and drifts with the wind at 7 m/s. The sky
  draws its clouds from it (with three's cloud lighting), and every lit material looks it up
  along the sun direction for its cloud shadow, so a cloud you see over the sun is the one
  shading you. About 30% of the sky is cloud; a cloud blocks 80% of the direct sunlight.
- **How the shadow reaches every material.** The lookup is added once to three's lighting
  chunk and its uniforms to the built-in material uniforms. The uniform values are typed
  arrays, which three shares by reference instead of cloning, so one update per frame drives
  every material. The first-person rifle opts out (it has its own light).
- **Clouds use the game clock** plus an offset per round, so in a LAN game everyone sees the
  same clouds, and each round has different ones.
- **Gameplay effect:** a scope glint is sunlight on the lens, so under a cloud it is about a
  third as strong, for the AI's eyes and for yours (`glintSun` in `src/ai.js`). The HUD shows
  *GLINT DIMMED · CLOUD*. Light shafts fade while the sun is covered. This is a real balance
  change: waiting for a cloud before scoping in is now a tactic.
- **Gusts** are bands of stronger wind travelling downwind at 7 m/s, curved across the valley,
  about one every 20 s with calmer minutes in between. The same function exists in GLSL and
  JS (`gustAt` in `src/shaders.js`): trees, impostors, ferns, grass and ghillie strands sway
  harder and lean downwind as a band passes, and the sound and particles read it on the CPU.
- **Particles** (`src/particles.js`): 2,400 points in one draw call, animated entirely in the
  vertex shader inside a 28 m box that follows the camera. Needles and bits of bark drift down
  only under canopy (more in gusts) and catch the sun as they tumble; dust motes show up only
  against the light. They fade out when you scope in.
- **Cost:** two texture fetches per lit pixel for the cloud shadow, one draw call for the
  particles. I could only measure in software rendering here, so please run `?bench` again.

## Performance tools

- `?bench` runs five fixed scenes (vista, scoped, toward the sun, walking in the forest, river)
  for 6 s each with the simulation paused. It reports average FPS, 1% lows, frame time, the GPU
  name (`WEBGL_debug_renderer_info`), resolution and settings.
- **Auto resolution**:
  - It drops the render scale by 10% (down to 60%) when the smoothed frame time goes above
    19.5 ms.
  - With vsync, the frame time can't show spare headroom, so after 8–12 s it tries a 5% step
    back up and drops again if that was too much.
- Real-GPU numbers are still unmeasured. Running the benchmark on the target PC is the next
  step.

## LAN multiplayer

- **Topology**: `npm run host` serves the built game and a WebSocket relay
  (`server/relay.mjs`) on one port. The relay only keeps the lobby (names, chosen teams, who
  hosts) and forwards messages. All game logic runs in the **hosting browser**.
- **The host decides**:
  - the round roster (players plus AI fill, spawn points);
  - the AI, the zone timeline, the birds;
  - kills, round and match results.
  - It sends a 20 Hz snapshot of every combatant (position, yaw/pitch, stance, scope, speed,
    alive, health, the AI's aim target). Zone state is sent every second, bird state whenever
    it changes.
- **Each player decides**:
  - their own movement (sent at 20 Hz);
  - their own hits: the shooter's browser traces the shot against what it sees and *claims*
    the hit, and the host confirms it to everyone. This is "favour the shooter", fine on a
    LAN.
  - their own zone damage (reported when it kills them).
  - **There is no cheat protection: this is for friends.**
- **Shots** are replayed visually everywhere (muzzle flash, distance-delayed sound, tracer,
  impacts, near-miss crack). On the host, a replayed shot also emits the shot and flash reveal
  events, so the AI reacts to human players exactly as it does in single player.
  - The host turns remote players' movement into footstep and splash events for the AI.
  - Glints are drawn from each player's synced aim and scope.
- **Time**: clients follow the host's game clock (snapped when it is more than 0.5 s off,
  otherwise eased), so the freeze time, zone timer and bird flights line up.
- **Teams**: chosen in the lobby, or auto-balanced, and fixed for the match. With AI fill on,
  each team has `max(team size, humans on the bigger team)` slots.
- **Not handled**:
  - no host migration (if the host leaves, everyone returns to the menu);
  - no reconnect;
  - no lag compensation (others are drawn 0.1 s in the past, and hits are the shooter's call);
  - no voice chat.
  - Pausing doesn't stop a LAN match.
- **Tested** with the real `npm run host` server and two headless browsers:
  - lobby, start and identical rosters, movement sync;
  - a player killing the host, with the killcam and kill feed on both;
  - the host's AI killing the remote player, with the AI reason in the killcam;
  - zone death of a remote player;
  - round end, side swap and next round;
  - match restart, and glints and the aimed-at warning between players.
  - **Not tested** with real people on separate PCs.

## Windows program (Electron)

- **Name.** The public version is called SniperValley (SniperYard was taken). Browser storage
  keys keep their `sniperyard.` prefix: they are invisible, and renaming them would reset
  everyone's settings.
- **Why Electron.**
  - It ships Chromium, so the program runs the same WebGL2 code as Chrome and Edge, with no
    changes to the game.
  - It is also the usual base for web games on Steam (with steamworks.js), if that comes
    later.
  - Tauri would make a much smaller download, but it uses the system's web view, and Steam
    support is harder there.
- **The game is served from `http://127.0.0.1:47820`**, not loaded from files.
  - It behaves exactly like `npm run host`: absolute asset paths, `fetch`, and WebSocket to
    the relay all just work.
  - Browser storage (the settings) is kept per address, so the port is fixed and the
    settings survive restarts.
  - A second copy on the same PC moves to the next free port and gets its own settings. That
    is handy for testing LAN on one PC.
- **LAN in the program.**
  - HOST GAME asks the program to start the relay plus the game files on port 47821 on all
    network interfaces. The page then joins it like a browser would.
  - The server lives in the program, not the page, so it survives the reload when the host
    changes map. It stops when the program closes.
  - JOIN GAME connects to `<ip>:47821`, and the game joins as soon as that PC hosts. A fixed
    port means friends only type the IP address.
  - Browsers can join a program's game at `http://<ip>:47821`, the same as with
    `npm run host`.
  - Windows asks the host once whether SniperValley may use the network.
- **Program-only features** are behind `window.desktop`, which `electron/preload.cjs` exposes:
  quit, fullscreen, and host LAN. The browser build doesn't have it and is unchanged. The
  fullscreen choice is saved in `%APPDATA%\SniperValley\window.json`.
- **Switches.** The program asks for the high-performance GPU
  (`force_high_performance_gpu`), and lets sound start without a click, for rejoining after a
  map change.
- **Packaging** uses `@electron/packager` rather than electron-builder. electron-builder
  downloads a signing toolkit that needs symlink rights on Windows (Developer Mode or admin).
  The packager sets the icon with rcedit and has no such step. CI zips the folder with
  PowerShell.
- **Not code-signed**, so Windows SmartScreen warns the first time. A certificate costs money
  every year and is only worth it for a public release; Steam doesn't need it.
- **Tested** in this environment (Linux, software GL, two program windows):
  - start-up, menu, fullscreen toggle and QUIT;
  - one copy hosting, another joining by IP, and a browser joining the same game;
  - the match starting for all three;
  - the packed build (app archive), hosting and joining.
  - **Not tested:** the Windows .exe itself (CI builds it), the firewall question, and the
    GPU switch on a real two-GPU laptop.

## v0.3.1: first game experience fixes

From an hour of play testing. Each point, what I found and what changed.

- **Sprint cancels crouch and prone.** Sprinting needed the standing stance, so Shift did
  nothing when crouched or prone. Now sprint (moving forward, not scoped) stands you up. A
  crouch or prone pressed *while* sprint is held keeps that stance until sprint is pressed
  again, so you can still drop to the ground from a run.
- **Crow sounds.** The caw from the "bee" round was noise through throat resonances: a
  spectrogram showed no pitch at all, a hiss, not a bird. The new caw (`crowCaw` in
  `src/sfx.js`) is a source–filter "kraa": a short "k", then glottal pulses at ~600–700 Hz
  with 5 % jitter, shimmer, a 45 Hz flutter and a croaky stretch (every other pulse weak),
  through an open "aa" (1.2 / 1.8 / 2.8 kHz). The pitch rises a little and falls at the end.
  Measured: median pitch 640 Hz, spectral centroid 1.6 kHz, 3 % of the energy below 900 Hz,
  and 0 % on the buzz meter (an insect drone is a steady pitch below ~700 Hz with its energy
  there). Untested by ear here.
- **Smaller maps.** All three about 25 % smaller (table above), zone steps shorter. The forest
  density, rocks, bushes, logs and flocks follow the area as before.
- **Long shots that don't hit.** Two causes:
  - *Trunks.* Bullets and sight lines tested each trunk as a straight cylinder of 1.15× its
    base radius all the way to the top, while the drawn trunk tapers to a point, is bent up
    to 25 cm and has a wide flared foot. A test rendered 300 random sight lines of 120–480 m
    (is the aim point visible on screen, through the alpha-tested needles?) and fired along
    the same lines. Before, 3 of 13 clearly visible aim points were "hit" by a trunk that
    wasn't there. After, no trunk blocked any of 22 (one crown core did). Trunks are now a
    chain of capsules along the drawn centre line
    (`trunkProfile` in `src/trees.js`), with the flare near the ground. AI sight lines use
    the same shapes.
  - *Ballistics (if switched on).* With drop and wind the bullet falls 0.3 m at 200 m, 0.7 m
    at 300 m and 1.2 m at 400 m, and there was nothing to aim with. The scope now has a
    rangefinder (ranges terrain, trees, rocks and bushes, never people, so it can't find a
    hidden sniper), drop marks under the centre for 200–800 m (labelled 2–8, they move with
    the zoom) and a "HOLD ▲ 0.6 m ◄ 0.1 m" line for the measured range. With the hold-off,
    25 of 25 test shots at 200–330 m hit (21 of 25 without). The AI holds over too
    (`Combat.ballisticAim`): it used to aim straight at you with drop on, so it missed long
    shots.
- **Ghillie man walking while standing still.** The AI only set its speed while walking.
  When it stopped walking because it heard or saw something (investigate, aim), the speed
  stayed, so it kept its walk cycle (and counted as "moving" for spotting). In a 5-minute
  4v4 simulation 25 % of the time an AI was standing but walking. Now any state other than
  walking has speed 0: 0 %.
- **Glints that aren't scopes.** With every scope glint switched off, renders across the
  valley showed nothing glint-like. What remained were the falling needles that "catch the
  sun" and the dust motes toward the sun: a bright fleck now and then, and they fade out when
  you scope in, so there is nothing there to find. They are softer now and only close to you
  (about 1.4 glint-like specks per frame in sun-facing test views before, 0 after). Other
  things that flash: a muzzle flash (a short orange burst, then the bang) and a teammate's
  scope if you stand in front of it. F1 lists recent glints and flashes with who made them.
- **10v10 and 20v20.** Team sizes 1–5, 8, 10, 15 and 20. Spawns fill the slope in rows
  (at least 7–10 m apart), off-screen ghillie characters are culled (skinned meshes can't
  use three.js culling), and the HUD pips and scoreboard compact for big teams. A 20v20 step
  costs ~0.4–1 ms of simulation here. The first tests were a massacre: 18 of 40 dead 10 s
  after the start. The cause was birds: everyone spawned next to some flock, the flocks all
  flushed at the start, every AI turned its scope toward the birds, and the glints did the
  rest. Now a spawn never flushes birds (only walking away and back does), AI snipers settle
  into their spawn spot for 5–13 s before scanning through the scope, and in big teams each
  uses the scope a bit less. 20v20 now: first kill after ~11 s (8 s of play).
- **Team deathmatch** (MATCH tab → Mode). One long round with respawns 7 s after a death
  (the killcam runs first) on your team's slope, at a spot away from enemies. The first team
  to 30 kills wins (10–100), or the team ahead after 15 minutes. The zone stays open. The
  scoreboard shows kills / deaths, the end screen kills, deaths, hits and longest hit. On LAN
  the host decides kills and respawns; each player's state carries which "life" it belongs
  to, so a state from before a respawn can't kill someone again.
- **Friendly fire.** It was already on (you could shoot teammates) but not visible as a
  choice. It is now a MATCH setting, on by default: a team kill doesn't count as a kill and
  costs the team a point in deathmatch. Off, bullets pass through teammates.
- **Sway and holding the breath.** The scope sway was 0.05° standing still, too small to
  notice, so holding the breath didn't matter. Now the aim drifts and rises and falls with
  each breath (about 4 s a breath): ~0.3° standing, ×0.6 crouched, ×0.32 prone, more while
  moving or after a sprint. Shift steadies it to 10 % for 4 s, with an inhale; letting go
  exhales; running out gasps and makes the sway 1.8× for 3 s. A breath bar sits under the
  bolt bar while scoped.
- **Zoom on the mouse wheel.** The scope opens at 2× and the wheel zooms 2–3–4–6–8–10–12×
  (forward in, back out). 12× is about the old fixed scope. The magnification is measured
  against a 70° view, so it is the same on every field-of-view setting. CONTROLS → *Scope
  opens at* can keep the last zoom instead.
- The benchmark's scoped scene zooms to 12× (the old scope). The Valley is smaller now, so
  benchmark results from 0.2.0 and 0.3.1 don't compare.
- Version 0.3.1 and the branch `v0.3.1`, as asked. The release workflow now takes the
  release title and notes for a version from `CHANGELOG.md`.

## v0.4.0: online over Steam

Asked for: "byg steam login så jeg kan spille online med mine venner". There is no separate
login: the game uses whoever is logged in to Steam on that PC.

- **What Steam does here.**
  - **Lobbies:** the host's game opens a Steam lobby, and friends find it through Steam's
    friends list (*Join Game*) or a code.
  - **Transport:** Steam's P2P networking carries the game's messages through Valve's relays.
    Nobody opens ports, and nobody sees anyone's IP address.
  - **No game servers:** the game still runs on the host's PC, exactly like a LAN game, and
    costs nothing to run.
- **App ID 480 (Spacewar).** Valve's public test app, available to every Steam account, so this
  works before the game has its own App ID ($100 through Steam Direct).
  - Steam shows *Playing Spacewar* while the program runs, because Steam starts as soon as the
    program starts, so a friend's *Join Game* reaches it.
  - *Join Game* only works while SniperValley is already running: Steam would start the real
    Spacewar otherwise.
  - Switching to an own App ID is one constant (`APP_ID` in `electron/steam.cjs`). Then Steam
    starts SniperValley for *Join Game* (`+connect_lobby` is handled already) and lobbies are
    SniperValley's alone.
- **Library: steamworks.js 0.4.0.**
  - It ships Valve's Steam API file for Windows, Linux and macOS, so neither the build (CI)
    nor anyone else needs a Steamworks account.
  - The other option, steamworks-ffi-node, is newer and covers Valve's newer networking API,
    but it needs Valve's SDK downloaded separately with a Steamworks developer login.
  - steamworks.js uses Valve's older P2P API (`ISteamNetworking`). Valve calls it deprecated,
    but it still works, goes through the relays, and has unreliable packets (up to 1200
    bytes) and reliable ones.
  - The library loads in the program's main process. The game page reaches it only through
    `window.desktop.steam`.
- **How it fits the LAN code**, which is unchanged:
  - **Host:** the relay (`server/relay.mjs`) runs in the host's program as for LAN, and each
    Steam friend becomes one more relay peer, sending through Steam instead of a WebSocket. A
    host's game can also have LAN players and Steam friends in the same match.
  - **Friend:** the game connects to its own program (`ws://127.0.0.1:<port>/steamnet`), and
    `electron/steam.cjs` forwards each message to the host over Steam. The game speaks the same
    relay protocol either way.
  - **Packets** are one byte of kind plus text:
    - `D` data (a relay message);
    - `O` open and `C` close (a relay peer comes and goes);
    - `P`/`Q` ping and pong.
  - **Keep-alive and timeouts:** pings go both ways every second. 15 s without a packet means
    the other side is gone, and so does Steam reporting that someone left the lobby or that a
    connection failed.
  - **The lobby stays open while the host's game reloads** (a map change) for up to 60 s.
    Friends' games reload too and rejoin by themselves, over Steam. It closes when the host
    leaves or quits.
  - **Steam friends can't host** on someone else's relay. The bridge only accepts the game's own
    page (Origin check), so a web page open on the same PC can't use it.
- **Codes.** A lobby's Steam ID in Crockford base 32. Lobby IDs share their top 32 bits, so a
  code is 7 characters (for example `2DKXX36`). Lower case, O for 0 and I/L for 1 are accepted,
  and so is a pasted lobby ID. A text with a dot or colon is an IP address (LAN) instead.
- **Netcode for the internet** (also used on LAN):
  - **Unreliable positions.** The host's 20 Hz snapshot goes as several messages of about
    0.9 KB, each fitting one Steam packet, sent unreliably. A lost one is simply replaced 50 ms
    later.
  - **Reliable events.** Zone and bird state moved to a reliable `world` message (zone every
    second, birds on change), next to kills, shots, rounds and respawns.
  - **Stale messages are dropped.** Snapshots carry the host's round count (a late one from
    the previous round is dropped), and every position carries the sender's real clock (an older
    one than already received is dropped).
  - **Drawing others.** Other players and the host's AI were drawn by easing toward the
    newest position. Now each is drawn 0.1 s in the past, between the two received states around
    that moment, or extrapolated up to 0.2 s if packets are late. The sender's clock to local
    time is the lowest transit time seen, which follows changes slowly.
  - Measured with the fake Steam at 50 ± 30 ms one way and 3 % loss: a player walking 3 m/s in
    a circle, seen by the friend, frame by frame (5th–95th percentile of speed):
    - before: 1.64–4.44 m/s (stop and jump);
    - after: 2.86–3.18 m/s.
  - **Traffic, 20v20 with one friend:** 76 packets/s and 0.37 Mbit/s both ways. The largest
    snapshot piece is 974 bytes; the largest reliable message (the round roster) is 3.6 KB. Ten
    friends need about 3–4 Mbit/s of the host's upload.
  - **Hits** are still the shooter's call, and the host confirms them. Over the internet that
    can mean being hit just after reaching cover, and that is accepted for games between
    friends.
- **Same version only.** The lobby (Steam and relay) carries the host's version. A friend with
  another version gets a message instead of joining. The relay also refuses older games that
  don't say their version.
- **Menu (program only).**
  - Status line: `STEAM ● LOGGED IN AS …`, or why not. It checks again every 5 s on the menu,
    so starting Steam later works.
  - *Online (Steam)*: friends (FriendsOnly lobby), anyone with the code (Public lobby), or off.
  - The host sees the code with COPY. Friends type it where the IP address went.
  - The player name defaults to the Steam name.
  - Pings: in the lobby list, the friend's note and the Tab scoreboard.
  - A *Join Game* while playing single player reloads into the menu and joins.
- **`steam-log.txt`** in the settings folder logs what Steam did in the last run (lobbies,
  sessions, connects, timeouts), for bug reports from real Steam.
- **The build check:** CI runs the packed `SniperValley.exe --steam-selftest=<file>`, which
  only loads Steam support and writes the result, so a missing native file fails the build. The
  native files are unpacked from the app archive, and `steam_api64.dll` also sits next to the
  .exe.

### Testing online play (without Steam)

`scripts/fake-steam/` stands in for Steam: `backend.mjs` is the "Steam servers" (lobbies, P2P
packets with a simulated internet), and `index.cjs` replaces steamworks.js in each copy of the
program.

```
npm run build
node scripts/fake-steam/backend.mjs --latency 50 --jitter 30 --loss 0.03
# two copies of the program, each its own Steam user and settings folder:
SNIPERVALLEY_FAKE_STEAM=$PWD/scripts/fake-steam/index.cjs FAKE_STEAM_ID=1001 FAKE_STEAM_NAME=Host npx electron .
SNIPERVALLEY_FAKE_STEAM=$PWD/scripts/fake-steam/index.cjs FAKE_STEAM_ID=1002 FAKE_STEAM_NAME=Friend SNIPERVALLEY_USER_DATA=/tmp/sv-friend npx electron .
```

`FAKE_STEAM_OFF=1` acts as if Steam isn't running; `SNIPERVALLEY_QUERY=norender` adds URL
options. The backend also takes test commands (a friend's *Join Game*, statistics).

- **Tested** that way (two copies of the program, driven by Playwright, at 40–50 ms ± 20–30 ms
  and 2–3 % loss):
  - hosting, the code, joining by code and by *Join Game*;
  - pings, settings and roster, positions agreeing;
  - smooth movement, kills both ways, a respawn and scores;
  - a friend quitting, the host leaving, a map change with automatic rejoin;
  - another version, a wrong code, *Join Game* during single player, no Steam (LAN only);
  - 20v20 traffic;
  - the LAN tests from 0.3.1 (deathmatch and elimination in browsers, the browser test on
    `npm run host`) still pass;
  - the packed Linux program loads Steam support from the unpacked files.
- **Not tested:**
  - **real Steam:** the steamworks.js calls are checked against its source and types, and on
    Linux it loads and reports that Steam isn't running, but no lobby or packet has gone through
    Valve;
  - real internet conditions;
  - the Windows .exe with Steam (CI loads the module only);
  - the Steam overlay (Shift+Tab). It is left off, because steamworks.js turns it on with
    Chromium switches (in-process GPU) that could cost frame rate.

## Known limitations and ideas

- LOD transitions are hard switches; dithered cross-fades would hide popping.
- The AI uses straight-line movement with local trunk avoidance (no navmesh), which is enough
  for open slopes.
- AI don't use the sun direction (glare). The glint dims under clouds but ignores the sun
  angle. Both are cheap next steps if the designer wants sun-side tactics.
- Songbirds don't react to where players are, only to gunfire. Birds going quiet near a
  hidden sniper would be a nice, subtle cue.
- Bird motion is analytic and the flocks don't avoid trees.
- Grass blades can poke through fallen logs.
- Light shafts are screen-space, so they need the sun on screen or near it.
- The light shafts don't affect the AI. Looking into the sun is harder only for the player.
- No points or ranking (out of scope).
- Online play is between friends: the host's game decides everything and trusts each player's
  hits (no cheat protection), there is no host migration, and a friend who joins during a
  deathmatch waits for the next match. Joining a running deathmatch would be a good next step.
- The Steam overlay (Shift+Tab, invites from inside the game) is off; see v0.4.0.
