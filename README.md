# SniperValley

[![Latest version](https://img.shields.io/github/v/release/SimonC355/SniperValley?label=version)](https://github.com/SimonC355/SniperValley/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/SimonC355/SniperValley/total)](https://github.com/SimonC355/SniperValley/releases)

**[Download for Windows](https://github.com/SimonC355/SniperValley/releases/latest/download/SniperValley-windows-x64.zip)**
(zip, about 150 MB). How to start it is under [Play on Windows](#play-on-windows).

A team sniper game in a forested V-shaped valley, built with Three.js. Play anything from 1v1
to 20v20 against AI ghillie snipers, or with friends: online over Steam, or on your local
network.

- Everyone has one bolt-action rifle with a 2–12× scope, and one hit kills. Hold your breath
  to steady the aim.
- Two modes:
  - **Elimination**: nobody respawns, the play area shrinks every 40–50 s, a match is best of
    three rounds, and teams swap slopes (and sun side) between rounds.
  - **Team deathmatch**: you respawn on your team's slope; the first team to 30 kills wins.
- Three maps of the same valley: **Valley** (5v5–20v20), **Narrow valley** (2v2–10v10) and
  **Ravine** (small, 1v1–5v5).
- Detection comes from scope glints, muzzle flashes, gunshots, flushed birds and water splashes.
- The forest is alive: clouds drift over and their shadows sweep the slopes (a scope glints
  less under a cloud), gusts roll through the trees, grass and ghillie suits, needles drift
  down, and songbirds fall silent after gunfire.

This is an early test version. Feedback is welcome in the
[issues](https://github.com/SimonC355/SniperValley/issues).

## Play on Windows

1. Download **SniperValley-windows-x64.zip**
   ([direct link](https://github.com/SimonC355/SniperValley/releases/latest/download/SniperValley-windows-x64.zip),
   or under *Assets* in the [latest release](https://github.com/SimonC355/SniperValley/releases/latest)).
   The green **Code** button gives you the source code, not the program.
2. Optional: right-click the zip → **Properties**, tick **Unblock** at the bottom and click
   **OK**. Then Windows won't warn you when you start the game.
3. Right-click the zip → **Extract All…**, open the folder and double-click
   **SniperValley.exe**.
4. If you skipped step 2, Windows shows *Windows protected your PC* the first time, because
   the program is not code-signed. Click **More info**, then **Run anyway**.

- **F11** or **Alt+Enter** switches between fullscreen and a window (also under Esc → GRAPHICS).
  **QUIT** is in the menus.
- Settings are saved on the PC (`%APPDATA%\SniperValley`).
- On laptops with two graphics cards the program asks for the fast one. If it still runs
  slowly, set `SniperValley.exe` to *High performance* in Windows Settings → System →
  Display → Graphics.

**LAN games with the program:**

1. One player clicks **HOST GAME**. The lobby shows that PC's IP address, for example
   *FRIENDS TYPE 192.168.1.23*. The first time, Windows asks whether SniperValley may use the
   network: allow it on **private networks**.
2. The others type that address in the box next to **JOIN GAME** and click it. They join as
   soon as the host is ready.
3. Friends without the program can join from a browser at `http://<host's IP>:47821`.
4. The host picks teams, map, mode, team size and rounds in the lobby and the MATCH tab, then
   clicks **START MATCH**.

**Online with friends over Steam (test version):**

Steam finds the game and carries it over Valve's network, so nobody opens ports or types IP
addresses. The game doesn't have to be on the Steam store for this.

What you need:
- Steam installed and logged in on every PC, with one Steam account per PC.
- You and your friends are friends on Steam. A brand-new account can't send friend requests
  until $5 has been spent on it, but it can accept them, so send the request from the other
  account.
- Once on every PC: press **Win+R**, type `steam://install/480` and press Enter. That adds
  Valve's free test game Spacewar, which SniperValley uses until it has its own Steam App ID.
  While you play, Steam shows you as *Playing Spacewar*. That's expected.
- Everyone has the same version of SniperValley.

To play:
1. Start Steam first, then SniperValley. The multiplayer box says
   **STEAM ● LOGGED IN AS** *your name*.
2. The host clicks **HOST GAME**. The lobby shows a 7-character **STEAM CODE** (with a
   **COPY** button). If Windows asks whether SniperValley may use the network, allow it.
3. Friends start SniperValley too, then either right-click the host in Steam's friends list
   and choose **Join Game**, or type the code in the box next to **JOIN GAME** and click it.
4. The lobby lists everyone with their ping. The host clicks **START MATCH**.

The **Online (Steam)** setting in the multiplayer box decides who can join: Steam friends
(default), anyone with the code, or nobody (LAN only). Hold **Tab** in a match to see
everyone's ping. If the host leaves, the game ends for everyone; players who join during a
match come in at the next round (in deathmatch: the next match).

## Develop

```bash
npm install
npm run dev        # the game in the browser: http://localhost:5173 (reloads on every change)
npm run app        # the Windows program, run from the source (builds first)
npm run exe        # builds release/SniperValley-win32-x64/SniperValley.exe
npm run host       # LAN game in browsers: builds, then serves the game + relay on port 8080
npm run assets     # optional: download CC0 photoscanned textures from Poly Haven (~70 MB)
npm run build      # static build in dist/
```

You need [Node.js](https://nodejs.org) 22.12 or newer. The game runs in any desktop browser
with WebGL2; the program is the same game in its own window ([Electron](https://www.electronjs.org)).
The first load takes a few seconds while textures, the forest and sniper positions are
generated.

- Day-to-day work happens in the browser (`npm run dev`). Use `npm run app` now and then for
  what only the program has: QUIT, fullscreen, and hosting or joining LAN games by IP.
- `npm run exe` makes the folder `release/SniperValley-win32-x64/`. Zip it to share it by
  hand. Build on Windows to get the program icon on the .exe.
- On Windows PowerShell, if `npm` is blocked ("running scripts is disabled"), use `npm.cmd`.

### Releases

GitHub Actions ([`.github/workflows/build.yml`](.github/workflows/build.yml)) builds the
Windows zip on every pull request and every push to `main`. Each run keeps it under
*Artifacts* for testing.

When a push to `main` carries a `version` in `package.json` that has no release yet, the
workflow publishes **SniperValley vX.Y.Z** with the zip under Releases. The download badge at
the top counts every download of the release zips, across all versions. It counts downloads,
not people. To give testers a new
version: raise `version` in `package.json` (for example 0.2.0 → 0.3.0) and merge. The
version is shown on the start screen. If [`CHANGELOG.md`](CHANGELOG.md) has a section for the
version (`## 0.3.1 – First game experience fixes`), the release takes its title from that line
and lists the section in its notes.

### Maps

Pick the map with **MAP** next to *SINGLE PLAYER* on the start screen, or in the **MATCH** tab
of the menu. Changing the map reloads the game (the world is built once per load); your
settings stay.

| Map | Size | Players | Typical shots |
|---|---|---|---|
| Valley | 340 × 290 m | 5v5 – 20v20 | 110 – 270 m |
| Narrow valley | 260 × 210 m | 2v2 – 10v10 | 80 – 190 m |
| Ravine | 200 × 150 m | 1v1 – 5v5 | 45 – 140 m |

All three are the same forested river valley at different sizes: narrower slopes, a smaller
river and lower ridges, with the same mountains behind. The zone also closes faster on the
smaller maps. In a LAN game the host's map is used: friends who join load it automatically,
and when the host switches map everyone follows and rejoins.

### Photoscanned textures (optional)

`npm run assets` downloads CC0 photoscanned ground, forest-floor, rock, mud and bark
textures from [Poly Haven](https://polyhaven.com) into `public/assets/`. It writes
`public/assets/assets.json` and lists the assets in CREDITS.md. The game uses them
automatically on the next load and falls back to its procedural textures when they are
missing.

- `npm run assets -- --list` shows the candidates per slot.
- `--slot forest=<id>` picks a specific Poly Haven texture.
- `--res 1k` downloads less and uses less GPU memory.
- `--clean` removes the downloads.

Open the game with `?photo=0` to compare with the procedural textures. The downloads are
git-ignored because they are large, so every machine runs the command once.

### LAN multiplayer in browsers (you host, friends join)

With the Windows program you don't need any of this: see *Play on Windows* above.

1. **On the hosting PC**, run `npm install` once, then `npm run host`. The console prints two
   addresses: `http://localhost:8080` for you and `http://<your-ip>:8080` for your friends.
2. **Host:** open `http://localhost:8080`, type a name and click **HOST GAME**.
3. **Friends** on the same network: open the address with your IP, type a name and click
   **JOIN GAME**. They don't need to install anything; the browser is enough.
4. **Pick teams** in the lobby, or leave them on auto-balance. In the **MATCH** tab, the host
   sets the map, mode, team size, friendly fire, rounds and zone mode. With *Fill empty slots
   with AI* on, AI snipers fill the teams up to the team size.
5. **Host:** click **START MATCH**. Friends click once in the game window to capture the
   mouse.

Notes:

- Players who join mid-match come in at the next round. If the host leaves, the game ends for
  everyone.
- If friends can't connect, allow Node.js through the Windows firewall for **private
  networks**, and check that everyone is on the same Wi-Fi or LAN.
- Use another port with `PORT=9000 npm run host`. On Windows PowerShell, run
  `$env:PORT=9000; npm run host`.
- `npm run dev -- --host` also works for LAN testing. The relay runs inside the dev server.

## Controls

All keys can be rebound under Esc → **CONTROLS**. That tab also has mouse and scope
sensitivity, field of view, invert Y, and whether the scope opens at 2× or at the last zoom.

| Key | Action |
|---|---|
| WASD | move |
| Mouse | look (arrow keys if pointer lock is unavailable) |
| Shift | sprint (also gets you up from crouch or prone) · while scoped: hold your breath (4 s) |
| Space | jump / stand up |
| C or Ctrl | crouch |
| Z | prone |
| Right mouse (hold) | scope: opens at 2×, slower sensitivity |
| Mouse wheel | while scoped: zoom 2–12× (forward in, back out) |
| Left mouse | fire (1.5 s bolt cycle) · while dead: switch spectated teammate |
| Tab (hold) | scoreboard |
| R | new match (single player / LAN host) |
| T | debug: skip to the next zone step (single player / LAN host) |
| F1 | debug overlay (AI states, awareness, live reveal-event log) |
| F2 | debug: reveal all characters |
| Esc | pause / settings (in LAN games the match keeps running) |

When you are shot, the **killcam** turns toward the shooter and zooms in on them. It shows:

- the shooter's name and distance;
- for AI shooters, what gave you away (muzzle flash, shot sound, birds, splashing, footsteps,
  scope glint or movement);
- your own recent giveaways, such as your last shot, flushed birds, sprinting, or a scope glint
  aimed at the shooter.

### Benchmark

Open `?bench` (or use the link in Esc → GRAPHICS). The game flies through five fixed views for
6 s each, then shows average FPS, 1% lows and your GPU, with a **COPY RESULTS** button. Auto
resolution is off during the run, so results from different PCs compare.

In normal play, *Auto resolution* (on by default) lowers the render scale to as low as 60% when
frames take longer than about 17 ms, and steps back up when there is headroom. The FPS counter
shows the current scale.

### Recorded sounds (optional)

Everything is synthesised by default. To use recordings, put audio files in
`public/assets/sounds/` and list them in `public/assets/sounds/sounds.json`. Each entry is one
file or a list of variations:

```json
{ "shot": ["shot1.ogg", "shot2.ogg"], "shot_far": "shot_far.ogg", "crack": "crack.ogg",
  "bolt": "bolt.ogg", "footstep_grass": ["g1.ogg", "g2.ogg"], "footstep_forest": "f1.ogg",
  "footstep_rock": "r1.ogg", "footstep_mud": "m1.ogg", "splash": "splash.ogg",
  "impact_tree": "wood.ogg", "impact_rock": "rock.ogg", "impact_ground": "dirt.ogg",
  "impact_water": "water.ogg", "caw": ["caw1.ogg", "caw2.ogg"], "wings": "wings.ogg" }
```

Any sound you leave out stays synthesised. Use CC0 recordings, for example
[freesound.org](https://freesound.org) filtered to *Creative Commons 0*, and list them in
CREDITS.md.

## URL options

`?map=valley|narrow|ravine` · `?mode=radial` · `?team=3` (1–20) · `?game=tdm` (team deathmatch) ·
`?kills=30` (kills to win) · `?ff=0` (friendly fire off) · `?ballistics=1` · `?tracers=off|faint|bright` ·
`?camo=0.5` · `?quality=low` · `?dummies=1` (orange shooting-range targets that show the exact
hitboxes) · `?autostart` (skip the menu) · `?photo=0` (procedural textures even if photoscans
are downloaded) · `?shafts=0` (no light shafts) · `?rounds=3` (rounds to win) · `?bench`
(benchmark) · `?autores=0` (no auto resolution).

Every other tunable is in [`src/config.js`](src/config.js).

## Structure

```
src/
  main.js        game loop, match/round flow, rosters, killcam, LAN wiring, glints/HUD wiring
  config.js      all tunables
  terrain.js     analytic valley heightfield, 1 m height grid, splat material, zone line
  water.js       river: planar reflection, fresnel, depth transparency
  trees.js       procedural conifers (LOD0/LOD1/impostor/shadow proxy) + undergrowth
  rocks.js       procedural boulders
  debris.js      fallen logs, stumps and dead branches (logs and stumps are cover)
  grass.js       instanced grass tiles around the viewer
  sky.js         sky (clouds from weather.js), sun, environment light, shadow frustum
  weather.js     drifting cloud field: sky clouds + cloud shadows on every lit material
  particles.js   needles drifting down under the canopy, dust motes in the sun
  textures.js    GPU-baked terrain/bark/water textures, Canvas2D foliage + ghillie strips
  assets.js      loads optional photoscanned textures (public/assets) in place of the bakes
  shaders.js     shared uniforms, gusts, exponential height fog, foliage material patch
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
  audio.js       synthesised WebAudio (gunshots, impacts, footsteps, birds, wind, river)
  sfx.js         gunshot synthesis: muzzle blast wave and the supersonic crack
  forestsound.js songbirds, woodpecker, needle rustle and gust roar
  post.js        SSAO, light shafts, bloom, grading, tone mapping, scope lens, vignette, grain
  hud.js         HUD, menus (tabs, key rebinding), lobby, killcam panel, scoreboard
  input.js       keyboard/mouse, pointer lock, rebindable actions
  net.js         multiplayer: lobby session, host snapshots, shot/kill sync, map sync
  remote.js      network-driven combatants (other players, the host's AI on clients), drawn
                 between received states
  bench.js       ?bench benchmark (always on the Valley map)
  desktop.js     extras in the Windows program: QUIT, fullscreen setting
electron/
  main.cjs       the program: window, serves the game on this PC, hosts LAN games
  steam.cjs      online over Steam: lobbies, codes, the game's messages over Steam P2P
  preload.cjs    what the game may ask the program for (window.desktop)
  icon.png/.ico  program icon (drawn by scripts/make-icon.mjs)
scripts/
  fetch-assets.mjs   `npm run assets`: CC0 texture downloader (Poly Haven API)
  package-exe.mjs    `npm run exe`: packs the program with @electron/packager
  make-icon.mjs      draws the program icon
  fake-steam/        a stand-in for Steam (lobbies, P2P, simulated internet) for testing
server/
  lan.mjs        `npm run host`: serves dist/ and the relay, prints LAN addresses
  serve.mjs      serves the built game (used by lan.mjs and the program)
  relay.mjs      WebSocket lobby + message relay (also used by the dev server and the program)
.github/workflows/
  build.yml      builds the Windows zip; publishes a release for each new version
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
- Press F1. The panel also lists the sounds of the last 10 seconds with their distance, so you
  can name any odd noise.
- Fire one shot and watch BRAVO switch to `investigate` (flash if they had line of
  sight; otherwise sound, arriving later and less accurately), then `aim`.
- Your teammate (blue marker) picks a ridge spot, scans, and engages enemies on its own.

**5. Birds**
- Crows sit on treetops all over both slopes. Listen for their calls, then look for black
  upright birds against the sky; they look around and hop between branches.
- Sprint toward a flock. They burst out of the trees with loud wing beats at about 25 m
  (about 10 m when crawling), circle with alarm caws, and resettle after about 25 s.
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

**Graphics upgrade (photoscans, light shafts, forest floor)**
- Run `npm run assets`, then `npm run dev`. The console should log
  `[assets] photoscanned textures: grass=…, forest=…`. Compare ground, rocks and bark with
  `?photo=0`. If the colours or texture scale look off, tune `assets.adjust` and
  `assets.tileScale` in `src/config.js`, or pick other textures with `--slot`.
- Look toward the low sun (southwest) through the trees to see the light shafts. Switch them off
  under Esc → Sun shafts to compare.
- Walk through the forest. Look for fallen logs with moss on top, stumps and dead branches.
  Lie prone behind a log: it stops bullets and blocks the AI's line of sight. You cannot walk
  through logs, but you can jump over them.

**Beta step 1 (settings, match format, killcam, sound, performance, LAN)**
- **Settings.** Esc → CONTROLS: rebind a key (click it, press the new one), change sensitivity
  and FOV. AUDIO has master, effects and ambience volume. Reload: the settings stay.
- **Match format.** Win round 1. The message says the sides swap, and in round 2 you start on
  the other slope. The match ends at 2 round wins.
- **Killcam.** Get shot (stand in the open and fire a few shots). The camera turns to the
  shooter and the panel explains what gave you away.
- **Sound.** Walk on grass, under the trees, on rock and on the mud bank. The footsteps should
  sound different, and twigs sometimes snap in the forest.
- **Benchmark.** Run `?bench` and send me the copied results.
- **LAN.** Follow "LAN multiplayer" above with a friend:
  - Shoot each other. The victim gets the killcam, and the kill feed matches on both screens.
  - Birds, glints, muzzle flashes and the zone look the same for both players.
  - Hold Tab for the scoreboard.

**Maps, living forest, ghillie suits and gunshots**
- **Gunshots.** Your own shot is a hard crack with a short rumble. When an enemy shot passes
  close, you first hear a sharp *pisk* (the bullet's supersonic crack), then the report from
  the rifle a moment later; the further away the shooter, the longer the gap.
- **Maps.** Pick *Ravine* next to SINGLE PLAYER and play 2v2. The opposite slope is much
  closer and rounds are faster. Try *Narrow valley* as well. In a LAN game, the host switches
  map in the MATCH tab: friends reload and rejoin by themselves.
- **Clouds.** Look up: clouds drift with the wind. Watch the opposite slope for cloud shadows
  sweeping across it. When a cloud covers the sun, the light shafts fade, and your scope
  glint is weaker (the HUD says *GLINT DIMMED · CLOUD*).
- **Gusts.** Stand still on a ridge and watch the trees and grass: every 20 seconds or so a
  gust rolls down the valley, the trees lean and shake harder, and you hear it in the
  needles, first on one side, then the other.
- **Forest life.** Under the trees, needles drift down; look toward the sun to see dust
  motes. Listen for songbirds and a woodpecker now and then. Fire a shot: the birds fall
  silent for half a minute, then start again one by one.
- **Ghillie suits.** Look at your teammate up close (F2 helps to find them): thin jute
  threads and grass tufts on the shoulders and hood, strands that blow in the gusts, trail
  behind when they move and swing out when they turn, and slow breathing when they hold
  still.

**The Windows program**
- Download the zip from the pull request's build (*Checks* → *Build Windows* → *Artifacts*),
  unzip it and start `SniperValley.exe`. Click past the SmartScreen warning.
- The start screen says SNIPERVALLEY and TEST VERSION 0.3.1, the game fills the screen, and
  QUIT closes it. F11 switches to a window and back; restart the program: it remembers.
- Single player: play a round. Check that sound, mouse and settings work as in the browser.
- LAN with two PCs: HOST GAME on one (allow the firewall question), type its IP on the other
  and JOIN GAME. Also try joining from a browser at `http://<host's IP>:47821`.
- On a laptop, check the GPU line in `?bench` (Esc → GRAPHICS → Run the benchmark): it should
  name the NVIDIA/AMD card.

**v0.3.1: first game experience fixes**
- **Sprint.** Crouch (C) or go prone (Z), then hold Shift and W: you get up and run. Press C
  while running: you stay crouched until you press Shift again.
- **Zoom and breath.** Scope in: it opens at 2×. Roll the wheel forward to zoom in to 12×,
  back to zoom out. Standing still, the aim drifts and rises and falls with your breathing;
  hold Shift to steady it for 4 s (the bar under BOLT READY empties). Hold it to the end and
  you gasp, and the aim shakes harder for a few seconds. Prone sways least.
- **Range and drop.** The scope shows the zoom and the range to what the crosshair is on. In
  MATCH → Ballistics, pick *travel time + drop + wind*: drop marks (2–8 = 200–800 m) appear
  under the centre and a HOLD line tells you how far to aim high and into the wind. Hit
  something at 300 m with it.
- **Long shots.** Shoot past tree trunks at range: a shot that clears the trunk on screen
  should clear it in the game.
- **AI.** Watch an enemy that stops walking to look at something (F2 + F1): its legs stop.
- **Glints.** Under the trees with the sun ahead, the falling needles shouldn't flash like
  scopes any more. A real glint is a white star that stays while they aim at or near you, and
  it is still there when you scope in. F1 lists recent glints and muzzle flashes with who made
  them.
- **Crows.** Flush a flock: the alarm should sound like crows ("kraa"), not static.
- **Maps.** All three are about a quarter smaller. Rounds should reach contact sooner.
- **Big teams.** MATCH → Team size 10v10 or 20v20. The round shouldn't open with a burst of
  kills; after a few seconds it gets busy. Hold Tab for the scoreboard.
- **Team deathmatch.** MATCH → Mode → *team deathmatch*. Die and you see the killcam, then
  "RESPAWN IN …", and you come back on your slope. The top bar shows team kills and the time
  left; the first team to 30 kills wins. Try it on LAN too.
- **Friendly fire.** MATCH → Friendly fire. On: shooting a teammate kills them (TEAM KILL in
  the feed, −1 in deathmatch). Off: the bullet passes through them.

**v0.4.0: online with friends over Steam**
- **Before you start:** Steam running and logged in on both PCs (two accounts, Steam
  friends), and once on each PC Win+R → `steam://install/480` (Spacewar). Start Steam before
  SniperValley.
- **Status.** The multiplayer box says *STEAM ● LOGGED IN AS* your Steam name, and your name
  is filled in. Close Steam and start the game: it says Steam isn't running, and LAN still
  works.
- **Host.** Click HOST GAME: a 7-character STEAM CODE appears, with COPY. Your friend's Steam
  shows you *Playing Spacewar*.
- **Join by code.** Your friend types the code next to JOIN GAME. They appear in your lobby
  list with a ping, and see *PING … MS* themselves.
- **Join from Steam.** With SniperValley running on both PCs, your friend right-clicks you in
  Steam's friends list → Join Game.
- **Play.** START MATCH. Watch each other move: no stutter or jumps, also when you run.
  Shoot each other and the AI; kills, the score and respawns agree on both PCs. Hold Tab to
  see pings.
- **Map change.** Change the map in MATCH while your friend is in the lobby: both games reload,
  and your friend joins again by themselves.
- **Leaving.** You leave: your friend is told and goes back to the menu. Your friend quits:
  you see *LEFT THE GAME*.
- **If something fails,** send `steam-log.txt` from `%APPDATA%\SniperValley` (from both PCs).
