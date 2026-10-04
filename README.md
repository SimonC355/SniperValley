# SniperYard — browser prototype

A single-player Three.js + Vite prototype of **SniperYard**, a team sniper game in a forested
V-shaped valley. You play 2v2 (up to 5v5) against AI ghillie snipers. Everyone has one bolt-action
rifle, one hit kills, there are no respawns, and the map shrinks every minute. Detection comes from
scope glints, muzzle flashes, gunshots, flushed birds and water splashes.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static build in dist/
```

Requires a desktop browser with WebGL2 and a mouse. The first load takes a few seconds while
textures, the forest and sniper positions are generated.

## Controls

| Key | Action |
|---|---|
| WASD | move |
| Mouse | look (arrow keys if pointer lock is unavailable) |
| Shift | sprint · while scoped: hold breath |
| Space | jump / stand up |
| C or Ctrl | crouch |
| Z | prone |
| Right mouse (hold) | scope (FOV 70 → 7, slower sensitivity) |
| Left mouse | fire (1.5 s bolt cycle) |
| R | restart round |
| T | debug: skip to the next zone step |
| F1 | debug overlay (AI states, awareness, live reveal-event log) |
| F2 | debug: reveal all characters |
| Esc | pause / settings |

## URL options

`?mode=radial` · `?team=3` (1–5) · `?ballistics=1` · `?tracers=off|faint|bright` ·
`?camo=0.5` · `?quality=low` · `?dummies=1` (orange shooting-range targets that show the exact
hitboxes) · `?autostart` (skip the menu).

Every other tunable is in [`src/config.js`](src/config.js).

## Structure

```
src/
  main.js        game loop, state machine, round flow, spawning, glints/HUD wiring
  config.js      all tunables
  terrain.js     analytic valley heightfield, 1 m height grid, splat material, zone line
  water.js       river: planar reflection, fresnel, depth transparency
  trees.js       procedural conifers (LOD0/LOD1/impostor/shadow proxy) + undergrowth
  rocks.js       procedural boulders
  grass.js       instanced grass tiles around the viewer
  sky.js         sky, sun, environment light, shadow frustum
  textures.js    GPU-baked terrain/bark/water textures, Canvas2D foliage + ghillie strips
  shaders.js     shared uniforms, exponential height fog, foliage material patch
  world.js       analytic raycasts / line of sight / collisions (no physics engine)
  player.js      first-person controller, scope, sway, recoil
  entity.js      shared combatant state
  hitbox.js      body capsules + ray tests
  combat.js      firing, hitscan / ballistics, hits, impacts, reveal events
  characters.js  procedural ghillie suits, skeleton, poses
  ai.js          sniper spots, AI state machine and perception
  events.js      reveal event bus
  birds.js       crow flocks
  zone.js        shrinking zone
  effects.js     muzzle flash, glint, impacts, tracers
  viewmodel.js   first-person rifle
  audio.js       synthesised WebAudio
  post.js        SSAO, bloom, tone mapping, scope lens, vignette, grain
  hud.js         HUD and menus
```

Design interpretations, numbers and open questions are in [NOTES.md](NOTES.md). Asset credits
are in [CREDITS.md](CREDITS.md).

## What to test, milestone by milestone

**1. Terrain, water, sky, trees, movement**
- Look around from spawn. You should see two forested slopes in a V, the river at the bottom,
  low sun, height fog and clouds.
- Walk down to the river. Deep water stops you at about 0.85 m depth. On the shallow shelf you
  slow down, splash, and the HUD shows *IN WATER (LOUD)*. Check the reflections and the
  transparent shallows.
- Sprint (Shift), jump (Space), crouch (C) and go prone (Z). Trees and rocks block you.
- Esc → change render scale and shadows to check performance.

**2. Scope, shooting, flash, hit detection** (`?dummies=1`)
- Hold right mouse: zoom, lens vignette, slight edge distortion, mil-dot reticle and slower
  sensitivity. Walking makes the scope sway; Shift steadies it.
- Shoot the orange targets on the opposite slope (100–250 m). Expect the recoil kick, the bolt
  animation and clicks, the hit marker and kill feed with distance, and trees eating shots.
- Hip-fire misses more often. Try `?ballistics=1` for travel time and drop.

**3. Ghillie characters, AI, glint, enemy shooting**
- Stand still and scan the opposite slope through the scope. Look for enemy glints: a white
  star in the trees.
- When an enemy lines up on you, the glint grows and **YOU ARE BEING AIMED AT** appears. Duck
  or move to break line of sight.
- Get shot and watch the death cam. If your teammate is alive you spectate them.
- F2 reveals everyone if you need to find them. Look at a teammate up close: a shaggy suit with
  no human outline and a faint armband.

**4. Event bus, investigate, AI teammate**
- Press F1. Fire one shot and watch BRAVO switch to `investigate` (flash if they had line of
  sight; otherwise sound, arriving later and less accurately), then `aim`.
- Your teammate (blue marker) picks a ridge spot, scans, and engages enemies on its own.

**5. Birds**
- Sprint toward a flock of crows on a treetop. They flush at about 25 m (about 10 m when
  crawling), circle with caws, and resettle after about 25 s.
- Fire near a flock (within 40 m) to flush it. Watch F1: the enemy investigates the flock.
- Watch the opposite slope for birds that BRAVO flushes.

**6. Shrinking zone, HUD, win/lose, restart**
- The zone timer counts down. At 0:30 a warning appears with a dashed white line and curtain;
  at 0:40 the orange boundary moves.
- Stand outside the zone to see the damage tint and HP drain. Press T to skip steps.
- Restart with `?mode=radial` to compare modes; the menu also has zone mode and team size.
- Win or lose for VICTORY/ELIMINATED with stats. R restarts.

**7. Visual polish**
- Compare AO on and off and bloom on and off in the Esc menu. Bloom should only affect the sun,
  glints and flashes.
- Watch tree LODs from far away, then scope in: full detail appears in the scope.
- Listen for valley echo on distant shots, river ambience near the water, and wind.
