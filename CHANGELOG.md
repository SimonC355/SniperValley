# Changelog

Each version's section becomes the notes of its release on GitHub (see
`scripts/release-notes.mjs`); the text after the version is the release's name.

## Unreleased

- **Back to the lobby.** A LOBBY button in the pause menu (Esc) and on the end screen takes you
  back to the start screen to pick another map or mode. In a LAN game the host takes everyone
  along: they wait in the lobby until the host starts the next match. Joined players get LEAVE
  TO LOBBY. The pause menu's buttons are now at the top (they were below all the settings).
- **The gunshot is a shrill whip crack: "gu-DISHHH".** A bright, loud crack with a short hiss
  after it and a small low thump under it, then the valley's echoes, instead of a long, rolling
  boom (and not the dull "parlour rifle" of the first try). Your ears no longer go muffled after
  your own shot, which cut the hiss. The echo is cleaner too: distinct echoes off the slopes
  instead of white noise.
- **No more glittering specks.** The needles drifting down and the dust motes that lit up toward
  the sun are off. GRAPHICS → Drifting needles & dust turns them back on.
- **The small details of being a sniper.** Still a sniper-only game; these are the touches
  that make it feel like one:
  - **Bullets passing close.** A bullet that cracks past within a few metres (or slams into the
    ground next to you) suppresses you: your hearing closes for a moment, the colour drains and
    the edges of the view darken and blur, the aim jolts, and your hands shake more while it
    wears off. One that passes right by your head leaves your ears ringing. Very close you also
    hear the air tear as the bullet rushes past, and dirt or splinters rain down around you.
  - **Breathing and heartbeat.** Through the scope you hear yourself breathe, in time with the
    reticle's rise and fall; after a sprint you pant. Hold your breath and the heartbeat comes
    up, louder and faster as the breath runs out, and each beat twitches the reticle a hair.
  - **The rifle.** Cloth and cheek as the rifle comes up to your eye, a click for each step of
    the zoom ring, the bolt sliding back and forward, and the empty case flying out to the
    right and landing next to you (it rings on rock and ticks on the forest floor). Your own
    shot compresses your ears for a moment and the forest goes quiet under it.
  - **The scope.** The picture opens up from a tunnel as the rifle settles on your cheek, a
    dark crescent closes in when you swing fast, walk or take the recoil, and the picture jumps
    when you fire. On sunny days far targets shimmer in the heat mirage, which drifts with the
    crosswind.
  - **Hits.** A tick when your bullet hits, then the dull thump of the hit coming back over
    the distance a moment later.
  - **Prone dust.** A shot fired prone kicks up dust in front of the muzzle, which others can
    see, and so can you through the scope for a moment.
  - **Settings.** GRAPHICS → Quality preset (low, medium, high, ultra) sets every graphics
    option at once; also Scope eye box and Heat mirage on/off. AUDIO → Breath & heartbeat
    volume and Hit sound on/off.
- **Every map ends in mountains.** The stone wall around the edge is gone: right at the edge
  of every map the ground now rises into steep rock mountains, higher on the big maps, so you
  always see where the map ends, and beyond it there is only mountain and sky (no more valley
  or forest out there). The river runs into the mountains at both ends of the valley.
- **Bullet trails.** Every shot leaves a thin, whitish vapour trail along its path, like in
  modern shooters: a bright streak runs out at the bullet's speed and the trail hangs in the
  air for a moment before it drifts and fades. Through the scope you see where your shot went
  and can correct the next one. Your own trail is clear; other players' trails are faint,
  a light hint at where a shot came from. MATCH → Bullet trails: off, light (default) or
  bright. With ballistics on, the trail follows the bullet's real arc.
- **Megascans export tool** (`scripts/megascans`): gets Unreal-only Fab packs such as the
  European Beech trees out of Unreal Engine, for a private asset repository.

## 5.0.0 – Player-requested updates

Everything in this version was asked for by players and testers.

- **Two new maps, same concept** (two banks facing each other across a river you can't cross):
  - **Tuscan Hills** (300 × 240 m, 2v2–10v10): old stone hamlets on the slopes, built of rough
    limestone or ochre plaster with terracotta roofs and green shutters, a few towers, and
    roofless ruins whose low walls you can climb and hide behind. Cypresses around the
    hamlets, olive groves on the benches, umbrella pines, dry golden grass and warm, hazy light.
  - **Beech River** (320 × 260 m, 2v2–10v10): a Nordic beech forest on low, rolling ground,
    tall grey beeches over a thick carpet of last year's leaves, a few dark patches of planted
    spruce, and a broad river in the middle that splits the two sides.
  - The three valley maps are still there.
- **More rocks, and you can climb them.** About twice as many rocks, many in outcrops. Walk
  straight up onto low rocks; hold forward against a higher one (up to about 2.4 m, or press
  jump) to climb onto it. The same goes for low walls in the Tuscan ruins. Bullets and sight
  lines now hit the rock as it is drawn.
- **Slide.** Press crouch while sprinting: you slide about 9 m on your hip and end up
  crouched. Downhill you slide further; jump ends the slide with a hop. It makes a scraping
  sound the enemy can hear.
- **You can see where the map ends.** A tall dry-stone wall runs along the whole edge of every
  map (higher on the big maps), with a clear strip in front of it, so you see it long before
  you get there. Across the river it becomes a low weir.
- **The circle is now the default zone**: it closes toward the water. Settings saved before
  5.0 switch to it once; you can still choose *ends* in MATCH.
- **The river is deadly.** The deep channel has a strong current: it sweeps you downstream and
  drowns you in a few seconds (in deathmatch you respawn). White water streaks show the
  current, and even the shallows pull at you.
- **Gunshots sound like a real sniper rifle**: a sharp supersonic whip-crack and a heavy boom
  that rolls down the valley for almost three seconds, about four times louder (RMS) than the
  old "puff". Passing bullets crack within 50 m (was 30 m).
- **Kill markers.** A small skull marks where the person you shot went down, with the distance,
  for eight seconds; off screen it sits at the edge in that direction.
- **Graphics.** A new, detailed first-person rifle (chassis with M-LOK slots, fluted barrel,
  muzzle brake, rail, knurled scope turrets, folded bipod), sharper image, more contrast and
  clearer air, fuller grass. The Windows build now includes the CC0 photoscanned ground, rock
  and bark textures (downloaded when the program is built).
- **New look for menus and HUD**: rounded, glassy panels in dark olive and khaki, a segmented
  tab bar, pill-shaped HUD elements and a cleaner scoreboard, kill feed and killcam.
- **Photoreal textures and models (made with Higgsfield)**: the forest floor, meadow, beech
  leaves, dry grass, mud, rock, the barks and the stone walls are photo textures; the spruce,
  pine, cypress, beech and olive foliage, ferns, shrubs and the ghillie strips are photo cut-outs;
  the Tuscan houses are textured 3D models and the boulders are 3D rock models (you can still
  climb them). The river now mirrors the forest instead of looking milky.
- **New start screen**: key art of a sniper over a misty valley behind the menu, and the map is
  chosen with picture cards of the five maps. The loading screen shows the map being loaded.
  The pictures were made with Higgsfield.

## 0.4.0 – Online with friends over Steam

- **Play online with friends.** Host a game and friends join from anywhere: they right-click
  you in Steam's friends list and choose **Join Game**, or type your 7-character **Steam
  code**. Steam carries the game over Valve's network, so nobody opens ports or types IP
  addresses. Everyone needs Steam running and logged in.
- **A test setup for now.** Until SniperValley has its own Steam App ID it runs online games as
  Valve's free test app Spacewar, so Steam shows you as *Playing Spacewar*. Add it once with
  Win+R → `steam://install/480`. The README has the steps.
- **Who can join** is a setting in the multiplayer box: Steam friends, anyone with the code,
  or nobody (LAN only). LAN games work as before, with or without Steam.
- **Ping** to the host in the lobby and on the scoreboard (Tab).
- **Smoother movement of other players**, online and on LAN. They are drawn a tenth of a
  second in the past, between the positions received, so a late or lost packet no longer makes
  them stop and jump.
- **Same version only.** A friend with another version of the game is told so instead of
  joining a game that goes wrong.
- **steam-log.txt** in the settings folder (`%APPDATA%\SniperValley`) records what Steam did,
  for bug reports.

## 0.3.1 – First game experience fixes

From the first hour-long play test.

- **Sprint gets you up.** Sprinting from crouch or prone stands you up and runs. Crouch or
  prone while running keeps you down until you press sprint again.
- **Zoom on the mouse wheel.** The scope opens at 2×; roll forward to zoom in (up to 12×),
  back to zoom out. CONTROLS can make it open at the last zoom instead.
- **Breathing and holding your breath.** Through the scope the aim drifts and rises and falls
  with each breath, most when standing, least when prone. Hold Shift to steady it for 4 s
  (breath bar under the bolt bar); run out and it shakes harder for a few seconds.
- **Long shots.** Tree trunks now stop bullets only where they are drawn: before, a straight,
  too thick trunk shape could stop a shot that cleared the trunk on screen.
- **Rangefinder and drop marks.** The scope shows the zoom and the range to what you aim at.
  With ballistics on (MATCH tab) it also shows drop marks for 200–800 m and how far to hold
  high and into the wind; the AI now holds over too.
- **Team deathmatch.** A new mode: respawns on your team's slope, first team to 30 kills (or
  ahead after 15 minutes) wins. Works on LAN.
- **10v10 and 20v20.** Team sizes up to 20 per side, with spawns spread over the slope, a
  compact HUD and scoreboard, and characters off screen skipped when drawing.
- **Friendly fire** is a MATCH setting (on by default). A team kill doesn't count as a kill
  and costs the team a point in deathmatch. Off: bullets pass through teammates.
- **Smaller maps.** All three are about a quarter smaller: Valley 340 × 290 m, Narrow valley
  260 × 210 m, Ravine 200 × 150 m.
- **Crows sound like crows**: a rough "kraa" instead of a burst of static.
- **Ghillie snipers no longer walk on the spot** after stopping to look at something.
- **Fewer false glints.** Falling needles and dust in the sun no longer flash like a scope.
- **Quieter round starts.** Spawning next to a flock no longer flushes it, and AI snipers
  settle into their hide for a few seconds before they scan through the scope.

## 0.2.0 – Windows program

- The game as a Windows program (SniperValley.exe), with fullscreen, QUIT and LAN games by IP.
