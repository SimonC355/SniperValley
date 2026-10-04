// All gameplay and rendering tunables live here.
// Distances are metres, times are seconds, angles are degrees unless noted.

export const CONFIG = {
  seed: 1337,

  // ---------------------------------------------------------------- map
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
    grassDensity: 1.0,     // 0 .. 1.5
    exposure: 1.0,
    grain: 0.035,
    vignette: 0.32,
    farClip: 2600,
  },

  sun: {
    elevation: 13,         // low sun
    azimuth: 236,          // degrees, 0 = +Z, 90 = +X (sun sits toward -X, along the valley)
    intensity: 3.4,
    color: 0xffd7a8,
    ambient: 0.55,         // environment (sky) light intensity
  },

  fog: {
    density: 0.0024,       // exponential density at height 0
    heightFalloff: 0.028,  // per metre
    color: 0xb9c3c9,
    sunScatter: 0.6,
  },

  sky: {
    turbidity: 4.5,
    rayleigh: 1.4,
    mieCoefficient: 0.0035,
    mieDirectionalG: 0.84,
    cloudCover: 0.42,
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
  round: {
    freezeTime: 3,
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
    echo: true,
  },

  debug: {
    showFps: true,
    allowReveal: true,         // F2 reveals all characters (debug only)
  },
};

// Persisted per-browser render settings override the defaults (see settings menu).
try {
  const saved = JSON.parse(localStorage.getItem('sniperyard.render') || 'null');
  if (saved && typeof saved === 'object') Object.assign(CONFIG.render, saved);
} catch (e) { /* storage unavailable */ }

export function saveRenderSettings() {
  try { localStorage.setItem('sniperyard.render', JSON.stringify(CONFIG.render)); } catch (e) { /* ignore */ }
}

// URL overrides for quick testing, e.g. ?mode=radial&team=3&ballistics=1
try {
  const q = new URLSearchParams(location.search);
  if (q.get('mode')) CONFIG.zone.mode = q.get('mode');
  if (q.get('team')) CONFIG.teams.size = Math.max(1, Math.min(5, parseInt(q.get('team'), 10) || 2));
  if (q.get('ballistics')) CONFIG.weapon.ballistics.enabled = q.get('ballistics') === '1';
  if (q.get('tracers')) CONFIG.weapon.tracers = q.get('tracers');
  if (q.get('camo')) CONFIG.camouflageStrength = parseFloat(q.get('camo'));
  if (q.get('quality') === 'low') Object.assign(CONFIG.render, { renderScale: 0.7, shadowQuality: 'low', ao: false, msaa: 0, reflections: false, grassDensity: 0.5 });
} catch (e) { /* ignore */ }
