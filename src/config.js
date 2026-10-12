// All gameplay and rendering tunables live here.
// Distances are metres, times are seconds, angles are degrees unless noted.

export const CONFIG = {
  seed: 1337,

  // ---------------------------------------------------------------- map
  // The size and shape numbers below are the VALLEY map; the chosen map (MAPS, at the end of
  // this file) overwrites them before anything is built.
  map: {
    // Playable rectangle. X runs along the valley, Z across it (the two slopes).
    length: 440,           // x extent
    width: 380,            // z extent
    waterLevel: 0,
    riverDeepHalfWidth: 9, // |dz| below this is the deep channel
    riverShelfStart: 12.5, // deep -> shallow drop-off ends here
    riverShelfEnd: 17,     // shallow shelf reaches the waterline here
    riverDepth: 2.8,
    bankTop: 1.1,
    ridgeDist: 178,        // distance from the river centre to the ridge line
    ridgeHeightNorth: 64,
    ridgeHeightSouth: 58,
    meander: 1,            // scale of the river's side-to-side bends
    relief: 1,             // scale of the bumps, spurs and terraces on the slopes
    deepWaterDepth: 0.85,  // water deeper than this is impassable
    shallowSpeedMul: 0.55, // movement multiplier in shallow water
    fords: [],             // optional x positions of shallow crossings, e.g. [-120, 140]
    terrainExtent: 1500,   // full rendered terrain size (outer area is scenery)
    terrainSpacing: 2.0,   // mesh vertex spacing inside the play area (heights come from a 1 m grid)
  },

  // ---------------------------------------------------------------- rendering
  render: {
    renderScale: 1.0,      // 0.5 .. 1.0, multiplied with devicePixelRatio
    maxPixelRatio: 1.5,
    shadowQuality: 'medium', // 'off' | 'low' (1024) | 'medium' (2048) | 'high' (4096)
    ao: true,
    bloom: true,
    msaa: 4,               // 0 or 4
    reflections: true,
    sunShafts: true,       // screen-space light shafts when looking toward the sun
    autoResolution: true,  // lower the resolution (down to 60%) when frames take longer than ~17 ms
    grassDensity: 1.0,     // 0 .. 1.5
    exposure: 1.0,
    grain: 0.035,
    vignette: 0.32,
    farClip: 2600,
  },

  // Colour grading in the final pass (applied to linear HDR colour before tone mapping).
  grade: {
    saturation: 1.12,
    contrast: 1.1,         // around mid grey, in log space
    warmth: 0.05,          // warm highlights / cool shadows split toning
    shafts: 0.45,          // light-shaft strength
  },

  // Photoscanned textures downloaded with `npm run assets` (CC0, Poly Haven) into
  // public/assets/. When the folder is empty the procedural textures are used.
  assets: {
    photo: true,           // ?photo=0 forces the procedural textures for comparison
    maxSize: 2048,         // packed texture size cap (1024 saves ~75% GPU memory)
    tileScale: { grass: 1, forest: 1, rock: 1, mud: 1 },
    adjust: {              // per-slot colour tweaks: gain, saturation, normal, height
      grass: { gain: 1.0, saturation: 1.0 },
      forest: { gain: 1.0, saturation: 1.0 },
      rock: { gain: 1.0, saturation: 1.0 },
      mud: { gain: 1.0, saturation: 1.0 },
      barkSpruce: { gain: 1.0, saturation: 1.0 },
      barkPine: { gain: 1.0, saturation: 1.0 },
    },
  },

  sun: {
    elevation: 13,         // low sun
    azimuth: 236,          // degrees, 0 = +Z, 90 = +X (sun sits toward -X, along the valley)
    intensity: 3.4,
    color: 0xffd7a8,
    ambient: 0.55,         // environment (sky) light intensity
  },

  fog: {
    density: 0.002,        // exponential density at height 0
    heightFalloff: 0.028,  // per metre
    color: 0xb9c3c9,
    sunScatter: 0.6,
  },

  // Drifting clouds (sky + their shadows on the ground) and gusts sweeping the valley.
  weather: {
    cloudCover: 0.3,       // share of the sky (and the ground) under cloud
    cloudShadow: 0.8,      // how much direct sunlight a cloud blocks
    cloudSpeed: 7,         // m/s, with the wind
    gusts: 1.0,            // strength of the gusts in trees, grass and ghillie suits
  },

  sky: {
    turbidity: 4.5,
    rayleigh: 1.4,
    mieCoefficient: 0.0035,
    mieDirectionalG: 0.84,
    cloudCover: 0.42,
  },

  // Forest-floor debris. Logs and stumps are cover (they stop bullets and sight).
  debris: {
    logs: 240,             // fallen trunks in the play area
    stumps: 320,
    branches: 2000,        // dead branches (visual only, drawn within ~70 m)
  },

  // ---------------------------------------------------------------- vegetation
  trees: {
    playAreaCount: 2600,   // approx number of trees inside the playable area
    outerCount: 5200,      // scenery trees outside the playable area (impostors mostly)
    minSpacing: 4.2,
    lod0Distance: 55,      // effective distance (distance * fov / 70)
    lod1Distance: 150,
    shadowDistance: 140,   // trees within this range of the shadow focus cast shadows
    windStrength: 1.0,
  },
  bushes: { count: 5200, lod0Distance: 45, maxDistance: 240 },
  rocks: { count: 340 },
  grass: { radius: 30, spacing: 0.42 },

  // ---------------------------------------------------------------- player
  player: {
    eyeStand: 1.62,
    eyeCrouch: 1.05,
    eyeProne: 0.36,
    radius: 0.35,
    walkSpeed: 4.2,
    sprintSpeed: 7.0,
    crouchSpeed: 2.2,
    proneSpeed: 0.9,
    scopedSpeed: 1.6,
    accel: 22,
    jumpVelocity: 4.6,
    gravity: 15,
    mouseSensitivity: 0.0021,  // radians per pixel at hip FOV
    arrowLookSpeed: 1.6,       // radians per second for the arrow-key fallback
    fovHip: 70,
    zoomLevels: [2, 3, 4, 6, 8, 10, 12],  // scope magnifications on the mouse wheel (12× ≈ the old fixed scope)
    zoomTime: 0.16,
    health: 100,
  },

  // ---------------------------------------------------------------- weapon
  weapon: {
    boltTime: 1.5,             // bolt cycle = fire cooldown
    hipSpread: 2.5,            // degrees of random spread when firing unscoped
    range: 1500,
    recoilPitch: 3.2,          // degrees of kick
    recoilRecover: 0.55,       // fraction of the kick that recovers automatically
    swayIdle: 0.32,            // degrees of scope sway standing still (breathing + drift)
    swayCrouch: 0.6,           // sway multiplier crouched
    swayProne: 0.32,           // sway multiplier prone
    swayMove: 0.9,             // extra degrees at full movement speed
    swaySprintCarry: 0.6,      // extra sway after sprinting, decays over ~3 s
    holdBreathTime: 4.0,       // Shift while scoped steadies the aim for this long
    holdBreathSteady: 0.1,     // sway multiplier while holding the breath
    breathRecovery: 0.5,       // seconds of breath regained per second
    outOfBreathTime: 3.0,      // after running out: no breath hold and more sway for this long
    tracers: 'faint',          // 'off' | 'faint' | 'bright'
    tracerOpacity: 0.12,
    ballistics: {
      enabled: false,          // bullet travel time, drop and wind
      muzzleVelocity: 850,
      gravity: 9.81,
      wind: { x: 2.0, z: 0.6 },  // m/s
    },
  },

  // ---------------------------------------------------------------- reveal mechanics
  reveal: {
    glintAngle: 10,            // aim error under which a scope glints toward someone
    glintIntensity: 32,        // HDR intensity of the glint core
    glintSize: 0.011,          // angular size factor (world size = distance * factor)
    glintSustain: 0.4,         // glint must persist this long before it is emitted as an event
    flashRange: 400,
    flashDuration: 0.2,
    flashIntensity: 60,
    flashSize: 0.02,
    soundSpeed: 340,
    shotHearingRange: 900,
    footstepHearingRange: 28,
    splashHearingRange: 90,
  },

  // ---------------------------------------------------------------- birds
  birds: {
    flocks: 30,                // on the Valley map; fewer on the smaller maps (by area)
    minPerFlock: 3,
    maxPerFlock: 10,
    treesPerFlock: 4,          // a flock spreads over up to this many neighbouring trees
    callChance: 0.25,          // chance per 12 s that a perched flock calls (about every 48 s)
    hopChance: 0.35,           // chance per 6 s that a perched bird hops to another branch
    flushBase: 8,              // flush radius = flushBase + speed * flushSpeedMul
    flushSpeedMul: 2.5,
    shotFlushRadius: 40,
    impactFlushRadius: 12,
    circleTime: 8,
    resettleTime: 25,
    circleRadius: 22,
    circleHeight: 26,
  },

  // ---------------------------------------------------------------- zone
  zone: {
    steps: [1.0, 0.8, 0.62, 0.46, 0.32, 0.2],
    interval: 60,              // a new step starts every interval seconds
    warning: 10,
    shrink: 20,
    mode: 'ends',              // 'ends' (closes from the valley ends) | 'radial' (circle toward the water)
    damage: [2, 4, 7, 11, 16, 24, 30],  // hp per second outside, indexed by current step
  },

  // ---------------------------------------------------------------- teams / round
  teams: {
    size: 2,                   // 2 = 2v2, up to 20 (20v20)
    sizes: [1, 2, 3, 4, 5, 8, 10, 15, 20],   // choices in the MATCH settings
    names: ['ALPHA', 'BRAVO'],
    colors: [0x5fb3ff, 0xff7a4d],
  },
  // LAN multiplayer (npm run host).
  lan: {
    fillWithAI: true,      // fill empty team slots (up to teams.size) with AI snipers
  },

  // Elimination: a match is a series of rounds; teams swap slopes (and sun side) between
  // rounds. Team deathmatch: one long round with respawns; the first team to tdmKills kills
  // wins (or the team ahead after tdmTime).
  match: {
    mode: 'elim',          // 'elim' (elimination rounds) | 'tdm' (team deathmatch)
    roundsToWin: 2,        // 1 = single round, 2 = best of 3, 3 = best of 5
    swapSides: true,
    nextRoundDelay: 6,     // seconds between rounds
    tdmKills: 30,
    tdmTime: 900,
    respawnDelay: 7,       // team deathmatch: seconds from death to respawn (the killcam runs first)
    friendlyFire: true,    // bullets hit teammates (a team kill costs the team a point in deathmatch)
  },

  round: {
    freezeTime: 3,
    killcamTime: 5,        // seconds the killcam shows your killer before spectating
  },

  // ---------------------------------------------------------------- characters
  camouflageStrength: 0.85,    // 0 = obvious, 1 = invisible when still

  // ---------------------------------------------------------------- AI
  ai: {
    thinkInterval: 0.2,
    visualRangeHip: 70,        // max close-range spotting distance unscoped (before camo)
    visualRangeScoped: 260,
    fovHip: 110,
    fovScoped: 9,
    awarenessDecay: 0.35,
    investigateTime: [3.5, 6.0],
    investigateBonus: 4.0,     // spotting rate multiplier near an investigated position
    investigateRadius: 18,
    aimTimeBase: 1.1,
    aimTimePerMetre: 0.006,
    aimTimeDuelMul: 0.6,       // multiplier when the player is scoped and looking straight at the AI
    hitChanceBase: 0.9,
    hitChanceDistanceFalloff: 0.0011,  // per metre
    hitChanceMovingMul: 0.45,
    hitChanceProneMul: 0.85,
    turnSpeed: 2.4,            // rad/s
    scopedTurnSpeed: 0.9,
    moveSpeed: 3.0,
    relocateAfterShotChance: 0.6,
    hearingBearingError: 14,   // degrees
    hearingDistanceError: 0.25,
    spotSpacing: 24,           // teammates keep this distance between hold positions
    reactionTime: [0.25, 0.6],
  },

  hud: {
    aimedAtWarning: true,
    teammateMarkers: true,
    killFeed: true,
  },

  audio: {
    master: 0.8,
    effects: 1.0,          // gunshots, impacts, footsteps, birds
    ambience: 1.0,         // wind and river
    echo: true,
    crackRadius: 30,       // a passing bullet's supersonic crack is heard this far from its path
  },

  // Player controls (saved per browser from the settings menu).
  controls: {
    sensitivity: 1.0,      // multiplier on player.mouseSensitivity
    scopeSensitivity: 1.0, // extra multiplier while scoped (on top of the FOV scaling)
    invertY: false,
    scopeZoom: 'reset',    // 'reset': the scope opens at the lowest zoom; 'keep': at the last one
    binds: null,           // filled from DEFAULT_BINDS below
  },

  debug: {
    showFps: true,
    allowReveal: true,         // F2 reveals all characters (debug only)
  },
};

// Rebindable actions -> key codes (KeyboardEvent.code, or Mouse0/Mouse1/Mouse2).
export const DEFAULT_BINDS = {
  forward: ['KeyW'], back: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
  sprint: ['ShiftLeft', 'ShiftRight'], jump: ['Space'], crouch: ['KeyC', 'ControlLeft'], prone: ['KeyZ'],
  scope: ['Mouse2'], fire: ['Mouse0'], scores: ['Tab'], restart: ['KeyR'],
};
CONFIG.controls.binds = JSON.parse(JSON.stringify(DEFAULT_BINDS));

// Persisted per-browser render settings override the defaults (see settings menu).
try {
  const saved = JSON.parse(localStorage.getItem('sniperyard.render') || 'null');
  if (saved && typeof saved === 'object') Object.assign(CONFIG.render, saved);
} catch (e) { /* storage unavailable */ }

// Persisted controls, field of view and volumes.
try {
  const saved = JSON.parse(localStorage.getItem('sniperyard.controls') || 'null');
  if (saved && typeof saved === 'object') {
    for (const k of ['sensitivity', 'scopeSensitivity', 'invertY', 'scopeZoom']) if (k in saved) CONFIG.controls[k] = saved[k];
    if (saved.binds) for (const a in DEFAULT_BINDS) if (Array.isArray(saved.binds[a]) && saved.binds[a].length) CONFIG.controls.binds[a] = saved.binds[a];
    if (saved.fov) CONFIG.player.fovHip = saved.fov;
    for (const k of ['master', 'effects', 'ambience']) if (saved.volume && k in saved.volume) CONFIG.audio[k] = saved.volume[k];
  }
} catch (e) { /* storage unavailable */ }

// Persisted match settings (team size, rounds, zone and so on).
try {
  const s = JSON.parse(localStorage.getItem('sniperyard.match') || 'null');
  if (s && typeof s === 'object') {
    if (s.size) CONFIG.teams.size = Math.max(1, Math.min(20, s.size | 0));
    if (s.rounds) CONFIG.match.roundsToWin = Math.max(1, Math.min(4, s.rounds | 0));
    if (s.mode === 'elim' || s.mode === 'tdm') CONFIG.match.mode = s.mode;
    if (s.tdmKills) CONFIG.match.tdmKills = Math.max(5, Math.min(200, s.tdmKills | 0));
    if ('ff' in s) CONFIG.match.friendlyFire = !!s.ff;
    if ('swap' in s) CONFIG.match.swapSides = !!s.swap;
    if (s.zone === 'ends' || s.zone === 'radial') CONFIG.zone.mode = s.zone;
    if (typeof s.camo === 'number') CONFIG.camouflageStrength = s.camo;
    if (['off', 'faint', 'bright'].includes(s.tracers)) CONFIG.weapon.tracers = s.tracers;
    if ('ball' in s) CONFIG.weapon.ballistics.enabled = !!s.ball;
  }
} catch (e) { /* storage unavailable */ }

export function saveRenderSettings() {
  try { localStorage.setItem('sniperyard.render', JSON.stringify(CONFIG.render)); } catch (e) { /* ignore */ }
  try {
    localStorage.setItem('sniperyard.match', JSON.stringify({
      size: CONFIG.teams.size, rounds: CONFIG.match.roundsToWin, swap: CONFIG.match.swapSides, zone: CONFIG.zone.mode,
      camo: CONFIG.camouflageStrength, tracers: CONFIG.weapon.tracers, ball: CONFIG.weapon.ballistics.enabled,
      mode: CONFIG.match.mode, tdmKills: CONFIG.match.tdmKills, ff: CONFIG.match.friendlyFire,
    }));
  } catch (e) { /* ignore */ }
  try {
    const C = CONFIG.controls;
    localStorage.setItem('sniperyard.controls', JSON.stringify({
      sensitivity: C.sensitivity, scopeSensitivity: C.scopeSensitivity, invertY: C.invertY, scopeZoom: C.scopeZoom, binds: C.binds,
      fov: CONFIG.player.fovHip, volume: { master: CONFIG.audio.master, effects: CONFIG.audio.effects, ambience: CONFIG.audio.ambience },
    }));
  } catch (e) { /* ignore */ }
}

// URL overrides for quick testing, e.g. ?mode=radial&team=3&ballistics=1&game=tdm&ff=0
try {
  const q = new URLSearchParams(location.search);
  if (q.get('mode')) CONFIG.zone.mode = q.get('mode');
  if (q.get('team')) CONFIG.teams.size = Math.max(1, Math.min(20, parseInt(q.get('team'), 10) || 2));
  if (q.get('game') === 'tdm' || q.get('game') === 'elim') CONFIG.match.mode = q.get('game');
  if (q.get('kills')) CONFIG.match.tdmKills = Math.max(1, parseInt(q.get('kills'), 10) || 30);
  if (q.get('ff')) CONFIG.match.friendlyFire = q.get('ff') !== '0';
  if (q.get('ballistics')) CONFIG.weapon.ballistics.enabled = q.get('ballistics') === '1';
  if (q.get('tracers')) CONFIG.weapon.tracers = q.get('tracers');
  if (q.get('camo')) CONFIG.camouflageStrength = parseFloat(q.get('camo'));
  if (q.get('photo')) CONFIG.assets.photo = q.get('photo') !== '0';
  if (q.get('shafts')) CONFIG.render.sunShafts = q.get('shafts') !== '0';
  if (q.get('autores')) CONFIG.render.autoResolution = q.get('autores') !== '0';
  if (q.get('rounds')) CONFIG.match.roundsToWin = Math.max(1, parseInt(q.get('rounds'), 10) || 2);
  if (q.get('quality') === 'low') Object.assign(CONFIG.render, { renderScale: 0.7, shadowQuality: 'low', ao: false, msaa: 0, reflections: false, grassDensity: 0.5 });
} catch (e) { /* ignore */ }

// ---------------------------------------------------------------- maps
// Three sizes of the same forested river valley. The chosen map's numbers replace CONFIG.map,
// and the numbers of rocks, bushes, fallen trees and bird flocks follow the play area so the
// forest is as dense on every map. Trees follow the area by themselves.
// (v0.3.1: all three about a quarter smaller than before, for more contact.)
export const MAPS = {
  valley: {
    name: 'VALLEY', size: '340 × 290 m', players: '5v5 – 20v20', zoneInterval: 50,
    map: { length: 340, width: 290, ridgeDist: 136, ridgeHeightNorth: 52, ridgeHeightSouth: 47, riverDeepHalfWidth: 8, riverShelfStart: 11, riverShelfEnd: 15, riverDepth: 2.6, meander: 0.85, relief: 0.9 },
  },
  narrow: {
    name: 'NARROW VALLEY', size: '260 × 210 m', players: '2v2 – 10v10', zoneInterval: 42,
    map: { length: 260, width: 210, ridgeDist: 98, ridgeHeightNorth: 40, ridgeHeightSouth: 36, riverDeepHalfWidth: 6.5, riverShelfStart: 9, riverShelfEnd: 12.5, riverDepth: 2.4, meander: 0.65, relief: 0.78 },
  },
  ravine: {
    name: 'RAVINE', size: '200 × 150 m', players: '1v1 – 5v5', zoneInterval: 36,
    map: { length: 200, width: 150, ridgeDist: 70, ridgeHeightNorth: 31, ridgeHeightSouth: 28, riverDeepHalfWidth: 5, riverShelfStart: 7, riverShelfEnd: 10, riverDepth: 2.0, meander: 0.5, relief: 0.62 },
  },
};

// Which map this page builds: ?map=<id>, else the one chosen in the menu, else the valley.
// The benchmark always uses the valley so results compare between PCs.
export const MAP_ID = (() => {
  let id = null;
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('bench')) return 'valley';
    id = q.get('map') || localStorage.getItem('sniperyard.map');
  } catch (e) { /* ignore */ }
  return MAPS[id] ? id : 'valley';
})();

{
  const P = MAPS[MAP_ID];
  Object.assign(CONFIG.map, P.map);
  const k = (P.map.length * P.map.width) / (440 * 380);
  CONFIG.rocks.count = Math.round(340 * k);
  CONFIG.bushes.count = Math.round(5200 * k);
  CONFIG.debris.logs = Math.round(240 * k);
  CONFIG.debris.stumps = Math.round(320 * k);
  CONFIG.debris.branches = Math.round(2000 * k);
  CONFIG.birds.flocks = Math.max(10, Math.round(CONFIG.birds.flocks * k));
  CONFIG.zone.interval = P.zoneInterval;
}

// Choose the map for the next page load (the world is built once per load).
export function saveMapChoice(id) {
  try { localStorage.setItem('sniperyard.map', id); } catch (e) { /* ignore */ }
}

// The current address without ?map= (so the saved choice applies after a reload). Other
// options are kept exactly as written (e.g. ?autostart stays a bare flag).
export function urlWithoutMap() {
  const s = location.search.replace(/([?&])map=[^&]*(&|$)/, '$1').replace(/[?&]$/, '');
  return location.pathname + s;
}
