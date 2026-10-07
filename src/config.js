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
    fovScope: 7,
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
    swayIdle: 0.05,            // degrees of scope sway when still
    swayMove: 0.9,             // extra degrees at full movement speed
    swaySprintCarry: 0.6,      // extra sway after sprinting, decays over ~3 s
    holdBreathTime: 3.0,       // Shift while scoped steadies the aim for this long
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
    flocks: 12,
    minPerFlock: 6,
    maxPerFlock: 12,
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
    size: 2,                   // 2 = 2v2, up to 5
    names: ['ALPHA', 'BRAVO'],
    colors: [0x5fb3ff, 0xff7a4d],
  },
  // LAN multiplayer (npm run host).
  lan: {
    fillWithAI: true,      // fill empty team slots (up to teams.size) with AI snipers
  },

  // A match is a series of rounds; teams swap slopes (and sun side) between rounds.
  match: {
    roundsToWin: 2,        // 1 = single round, 2 = best of 3, 3 = best of 5
    swapSides: true,
    nextRoundDelay: 6,     // seconds between rounds
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
    for (const k of ['sensitivity', 'scopeSensitivity', 'invertY']) if (k in saved) CONFIG.controls[k] = saved[k];
    if (saved.binds) for (const a in DEFAULT_BINDS) if (Array.isArray(saved.binds[a]) && saved.binds[a].length) CONFIG.controls.binds[a] = saved.binds[a];
    if (saved.fov) CONFIG.player.fovHip = saved.fov;
    for (const k of ['master', 'effects', 'ambience']) if (saved.volume && k in saved.volume) CONFIG.audio[k] = saved.volume[k];
  }
} catch (e) { /* storage unavailable */ }

// Persisted match settings (team size, rounds, zone and so on).
try {
  const s = JSON.parse(localStorage.getItem('sniperyard.match') || 'null');
  if (s && typeof s === 'object') {
    if (s.size) CONFIG.teams.size = Math.max(1, Math.min(5, s.size | 0));
    if (s.rounds) CONFIG.match.roundsToWin = Math.max(1, Math.min(4, s.rounds | 0));
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
    }));
  } catch (e) { /* ignore */ }
  try {
    const C = CONFIG.controls;
    localStorage.setItem('sniperyard.controls', JSON.stringify({
      sensitivity: C.sensitivity, scopeSensitivity: C.scopeSensitivity, invertY: C.invertY, binds: C.binds,
      fov: CONFIG.player.fovHip, volume: { master: CONFIG.audio.master, effects: CONFIG.audio.effects, ambience: CONFIG.audio.ambience },
    }));
  } catch (e) { /* ignore */ }
}

// URL overrides for quick testing, e.g. ?mode=radial&team=3&ballistics=1
try {
  const q = new URLSearchParams(location.search);
  if (q.get('mode')) CONFIG.zone.mode = q.get('mode');
  if (q.get('team')) CONFIG.teams.size = Math.max(1, Math.min(5, parseInt(q.get('team'), 10) || 2));
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
export const MAPS = {
  valley: {
    name: 'VALLEY', size: '440 × 380 m', players: '3v3 – 5v5', zoneInterval: 60,
    map: { length: 440, width: 380, ridgeDist: 178, ridgeHeightNorth: 64, ridgeHeightSouth: 58, riverDeepHalfWidth: 9, riverShelfStart: 12.5, riverShelfEnd: 17, riverDepth: 2.8, meander: 1, relief: 1 },
  },
  narrow: {
    name: 'NARROW VALLEY', size: '340 × 270 m', players: '2v2 – 3v3', zoneInterval: 50,
    map: { length: 340, width: 270, ridgeDist: 126, ridgeHeightNorth: 48, ridgeHeightSouth: 44, riverDeepHalfWidth: 7, riverShelfStart: 10, riverShelfEnd: 14, riverDepth: 2.5, meander: 0.75, relief: 0.85 },
  },
  ravine: {
    name: 'RAVINE', size: '260 × 200 m', players: '1v1 – 2v2', zoneInterval: 42,
    map: { length: 260, width: 200, ridgeDist: 94, ridgeHeightNorth: 38, ridgeHeightSouth: 35, riverDeepHalfWidth: 5.5, riverShelfStart: 8, riverShelfEnd: 11.5, riverDepth: 2.2, meander: 0.55, relief: 0.7 },
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
  CONFIG.birds.flocks = Math.max(6, Math.round(12 * k));
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
