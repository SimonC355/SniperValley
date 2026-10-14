# Changelog

Each version's section becomes the notes of its release on GitHub (see
`scripts/release-notes.mjs`); the text after the version is the release's name.

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
