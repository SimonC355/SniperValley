# Changelog

Each version's section becomes the notes of its release on GitHub (see
`scripts/release-notes.mjs`); the text after the version is the release's name.

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
