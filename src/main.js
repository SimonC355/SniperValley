// SniperYard prototype: main loop and game state machine.
import * as THREE from 'three';
import { CONFIG, MAPS, MAP_ID, saveMapChoice, urlWithoutMap } from './config.js';
import { installHeightFog, SHARED, gustAt } from './shaders.js';
import { ForestParticles } from './particles.js';
import { ForestAmbience } from './forestsound.js';
import { installWeather, updateWeather, sunlightAt, WEATHER } from './weather.js';
import { createTextures } from './textures.js';
import { loadPhotoTextures } from './assets.js';
import { Debris } from './debris.js';
import { Terrain } from './terrain.js';
import { SkySystem } from './sky.js';
import { Forest, Undergrowth } from './trees.js';
import { Rocks } from './rocks.js';
import { Grass } from './grass.js';
import { Water } from './water.js';
import { World } from './world.js';
import { Input } from './input.js';
import { Player } from './player.js';
import { PostFX } from './post.js';
import { HUD } from './hud.js';
import { EventBus } from './events.js';
import { Effects } from './effects.js';
import { AudioSystem } from './audio.js';
import { Combat } from './combat.js';
import { Viewmodel } from './viewmodel.js';
import { Hitbox } from './hitbox.js';
import { TargetDummy } from './dummies.js';
import { AICombatant, SpotMap, glintToward, glintAim, glintSun } from './ai.js';
import { yawPitchTo } from './entity.js';
import { Benchmark } from './bench.js';
import { RemoteCombatant } from './remote.js';
import { NetSession, LanGame } from './net.js';

// Killcam wording for how an AI found its victim (cue from AIBrain.reasons).
const REVEAL_TEXT = {
  flash: ['YOUR MUZZLE FLASH', 'A MUZZLE FLASH NEAR YOU'],
  shot: ['THE SOUND OF YOUR SHOT', 'A SHOT FIRED NEAR YOU'],
  birds: ['BIRDS YOU FLUSHED', 'BIRDS FLUSHED NEAR YOU'],
  splash: ['YOUR SPLASHING', 'SPLASHING NEAR YOU'],
  footstep: ['YOUR FOOTSTEPS', 'FOOTSTEPS NEAR YOU'],
  glint: ['YOUR SCOPE GLINT', 'A SCOPE GLINT NEAR YOU'],
  movement: ['YOU MOVED IN THEIR VIEW', 'YOU MOVED IN THEIR VIEW'],
  visual: ['THEY SPOTTED YOU WHILE SCANNING', 'THEY SPOTTED YOU WHILE SCANNING'],
};
import { Birds } from './birds.js';
import { Zone } from './zone.js';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const _eye = new THREE.Vector3();

class Game {
  constructor() {
    this.state = 'loading';   // loading | menu | playing | ended
    this.paused = false;
    this.time = 0;            // game clock (pauses)
    this.realTime = 0;
    this.debug = false;
    this.reveal = false;
  }

  async init() {
    this.hud = new HUD();
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setPixelRatio(this.pixelRatio());
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    document.getElementById('app').appendChild(renderer.domElement);
    this.renderer = renderer;
    renderer.info.autoReset = false;
    installHeightFog();
    installWeather();

    const scene = new THREE.Scene();
    this.scene = scene;
    const camera = new THREE.PerspectiveCamera(CONFIG.player.fovHip, window.innerWidth / window.innerHeight, 0.12, CONFIG.render.farClip);
    camera.rotation.order = 'YXZ';
    this.camera = camera;
    scene.add(camera);

    this.hud.setLoading('BAKING TEXTURES');
    await nextFrame();
    this.textures = createTextures(renderer, CONFIG.seed);
    this.hud.setLoading('LOADING PHOTOSCANNED TEXTURES');
    this.photoSlots = await loadPhotoTextures(renderer, this.textures);

    this.hud.setLoading('SHAPING THE VALLEY');
    await nextFrame();
    const terrain = new Terrain(CONFIG.seed);
    terrain.createHeightTexture();
    terrain.bakeSplat(() => 0);
    this.terrain = terrain;
    this.sky = new SkySystem(renderer, scene);

    this.hud.setLoading('GROWING THE FOREST');
    await nextFrame();
    this.forest = new Forest(renderer, scene, terrain, this.textures, CONFIG.seed);
    terrain.bakeSplat(this.forest.buildCanopyGrid());
    scene.add(terrain.buildMesh(this.textures));
    this.undergrowth = new Undergrowth(scene, terrain, this.forest, this.textures, CONFIG.seed);
    this.rocks = new Rocks(scene, terrain, this.forest, this.textures, CONFIG.seed);
    this.debris = new Debris(scene, terrain, this.forest, this.textures, CONFIG.seed);
    this.grass = new Grass(scene, terrain, this.textures);
    this.particles = new ForestParticles(scene, terrain);

    this.hud.setLoading('FILLING THE RIVER');
    await nextFrame();
    this.water = new Water(scene, terrain, this.textures, renderer);
    // Reflections skip grass, undergrowth and full-detail trees (the far bank dominates the mirror image).
    this.water.hideDuringReflection.push(this.grass.group, this.undergrowth.group, this.debris.group, terrain.mesh, this.particles.points);
    const reflTerrain = terrain.buildReflectionMesh();
    scene.add(reflTerrain);
    this.water.showDuringReflection.push(reflTerrain);
    for (const name in this.forest.buckets) this.water.hideDuringReflection.push(...this.forest.buckets[name].l0.meshes);
    this.world = new World(terrain, this.forest, this.rocks, this.undergrowth, this.debris);
    this.hud.setLoading('SCOUTING SNIPER POSITIONS');
    await nextFrame();
    this.spots = new SpotMap(this.world, terrain, CONFIG.seed);

    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(55, camera.aspect, 0.01, 10);
    this.post = new PostFX(renderer, scene, camera, this.vmScene, this.vmCamera);

    this.input = new Input(renderer.domElement);
    this.player = new Player(camera);
    this.player.hitbox = new Hitbox();

    this.bus = new EventBus();
    this.effects = new Effects(scene, this.vmScene);
    this.audio = new AudioSystem();
    this.forestSound = new ForestAmbience(this.audio, terrain);
    this.audio.onShotHeard = (d) => this.forestSound.onShot(d);
    this.combat = new Combat({ world: this.world, terrain, effects: this.effects, audio: this.audio, bus: this.bus });
    this.combat.listener = this.player;
    this.combat.onKill = (shooter, victim, dist, part, point) => {
      this.onKill(shooter, victim, dist, part, point);
      if (this.net && this.net.isHost) this.net.broadcastKill(shooter, victim, dist, part, point);
    };
    // LAN: shots simulated here are replayed by the others; joined clients claim their hits
    this.combat.onFired = (shooter, origin, dir, time) => {
      if (this.net && (shooter === this.player || this.net.isHost)) this.net.sendFire(shooter, origin, dir, time);
    };
    this.combat.onClaim = (shooter, victim, part, point, dist) => { if (this.net) this.net.sendClaim(shooter, victim, part, point, dist); };
    this.viewmodel = new Viewmodel(this.vmScene, this.vmCamera, this.textures, scene.environment);
    // the rifle is lit by its own light (dimmed in shade); world cloud shadows don't apply to it
    this.vmScene.traverse((o) => {
      for (const m of [].concat(o.material || [])) { m.defines = { ...(m.defines || {}), NO_CLOUD_SHADOW: '' }; m.needsUpdate = true; }
    });
    this.player.onFootstep = (pos, loud) => {
      this.audio.footstep(pos, loud, this.surfaceAt(pos.x, pos.z), true);
      this.bus.emit({ type: 'footstep', position: pos.clone(), time: this.time, sourceTeam: this.player.team, sourceId: this.player.id, loudness: loud });
    };
    this.player.onSplash = (pos, loud) => {
      this.audio.splash(pos, loud, true);
      this.effects.impact(pos.clone().add(new THREE.Vector3(0, 0.05, 0)), 'water');
      this.bus.emit({ type: 'splash', position: pos.clone(), time: this.time, sourceTeam: this.player.team, sourceId: this.player.id, loudness: loud });
    };
    this.dummies = [];
    this.ais = [];
    this.remotes = [];
    this.net = null;
    this.combatants = [this.player];
    this.bus.on((ev) => { for (const a of this.ais) a.ai.onEvent(ev); });
    // birds: flushed by shots, nearby impacts, and proximity (see Birds.checkProximity)
    this.birds = new Birds(scene, this.forest, terrain, this.audio, CONFIG.seed);
    this.zone = new Zone(scene, terrain);
    this.zone.onPhase = (phase) => {
      if (this.state !== 'playing') return;
      if (phase === 'warn') {
        this.hud.centerMessage('ZONE SHRINKING', `MOVE INSIDE THE MARKED LINE · ${CONFIG.zone.warning} s`, 2.5);
        for (let i = 0; i < 3; i++) setTimeout(() => this.audio.beep(880, 0.08, 0.1), i * 180);
      } else if (phase === 'shrink') this.audio.beep(660, 0.25, 0.12);
    };
    this.birds.onFlush = (f, time, team, id, cause) => {
      this.bus.emit({ type: 'birds', position: f.center.clone().add(new THREE.Vector3(0, 1, 0)), time, sourceTeam: team, sourceId: id, cause, flockId: f.id });
    };
    this.bus.on((ev) => {
      if (ev.type === 'shot') this.birds.onShot(ev.position, ev.time, ev.sourceTeam, ev.sourceId);
      else if (ev.type === 'impact') this.birds.onImpact(ev.position, ev.time, ev.sourceTeam, ev.sourceId);
    });
    this.params = new URLSearchParams(location.search);
    this.noRender = this.params.has('norender');   // test hook: run the game loop without drawing

    this.hud.bindSettings((kind) => this.onSettingsChanged(kind), this.input);
    this.bindUI();
    this.setupLan();
    window.addEventListener('resize', () => this.resize());
    this.resize();

    this.newMatch();
    this.state = 'menu';
    this.hud.setLoading('WARMING UP SHADERS');
    await nextFrame();
    renderer.compile(scene, camera);
    this.hud.setLoading(null);
    if (this.params.has('bench')) {
      this.state = 'playing';
      this.hud.showStart(false);
      this.bench = new Benchmark(this);
    } else if (this.params.has('autostart')) {
      this.state = 'playing';
      this.input.fallback = true;
    } else {
      this.hud.showStart(true);
    }
    this.lastNow = performance.now();
    this.frameCount = 0;
    renderer.setAnimationLoop(() => this.frame());
    window.__game = this;
    window.__weather = WEATHER;
    window.THREE = THREE;
    this.config = CONFIG;
    console.log(`[SniperYard] trees: ${this.forest.trees.length} (play area ${this.forest.playCount}), bushes: ${this.undergrowth.items.length}, rocks: ${this.rocks.items.length}, logs: ${this.debris.logs.length}, stumps: ${this.debris.stumps.length}`);
  }

  // Ground type under a point, for footstep sounds.
  surfaceAt(x, z) {
    const T = this.terrain;
    if (T.heightAt(x, z) < 1.2) return 'mud';
    if (1 - T.normalAt(x, z).y > 0.26) return 'rock';
    return T.canopyAt(x, z) > 0.5 ? 'forest' : 'grass';
  }

  pixelRatio() {
    return Math.min(window.devicePixelRatio || 1, CONFIG.render.maxPixelRatio) * CONFIG.render.renderScale * (this.dynScale || 1);
  }

  // Auto resolution: drop the render scale when frames are slow, probe upward when they are
  // fast again (with vsync the frame time can't show headroom, so it tries a step up now and then).
  updateAutoResolution(rawDt) {
    if (!CONFIG.render.autoResolution || this.state !== 'playing' || this.paused || this.bench) { this.arT = 0; return; }
    this.arEma = this.arEma ? this.arEma * 0.94 + rawDt * 0.06 : rawDt;
    this.arT = (this.arT || 0) + rawDt;
    if (this.arT < 1.5) return;
    const ms = this.arEma * 1000;
    let sc = this.dynScale || 1;
    if (ms > 19.5) { sc = Math.max(0.6, sc - 0.1); this.arProbe = 12; }
    else if (ms < 17.8 && sc < 1) {
      this.arProbe = (this.arProbe ?? 8) - this.arT;
      if (this.arProbe <= 0) { sc = Math.min(1, sc + 0.05); this.arProbe = 8; }
    }
    this.arT = 0;
    if (Math.abs(sc - (this.dynScale || 1)) > 1e-3) {
      this.dynScale = sc;
      this.resize();
    }
    this.hud.fpsExtra = sc < 1 ? ` · ${Math.round(sc * 100)}% RES` : '';
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const pr = this.pixelRatio();
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vmCamera.aspect = w / h;
    this.vmCamera.updateProjectionMatrix();
    this.post.setSize(w, h, pr);
    this.water.setQuality(CONFIG.render.reflections, w * pr);
  }

  onSettingsChanged(kind, value) {
    if (kind === 'map') { this.changeMap(value); return; }
    if (['scale', 'refl'].includes(kind)) this.resize();
    if (kind === 'shadow') this.sky.applyShadowQuality(CONFIG.render.shadowQuality);
    if (['msaa', 'grass'].includes(kind)) this.hud.centerMessage('RELOAD TO APPLY', '', 2);
    if (['vmaster', 'vfx', 'vamb', 'echo'].includes(kind)) this.audio.setVolumes();
    if (kind === 'autores' && !CONFIG.render.autoResolution) { this.dynScale = 1; this.resize(); }
  }

  // The world is built once per page load, so a new map saves the choice and reloads.
  // A LAN host takes its players along (they reload and rejoin by themselves).
  changeMap(id) {
    if (id === MAP_ID || !MAPS[id]) return;
    const net = this.net;
    if (net && !net.isHost) {
      this.hud.centerMessage('THE HOST CHOOSES THE MAP', '', 2);
      this.hud.syncAll();
      return;
    }
    saveMapChoice(id);
    if (net) {
      net.s.toAll({ k: 'mapchange', map: id });
      this.setAutoNet('host');
    }
    this.reloadPage(`LOADING ${MAPS[id].name}`);
  }

  // A joined LAN client follows the host to another map.
  followHostMap(id) {
    if (!MAPS[id] || this.reloading) return;
    saveMapChoice(id);
    this.setAutoNet('join');
    this.reloadPage(`LOADING ${MAPS[id].name}`);
  }

  // Remember to host or join again after the reload (sessionStorage lives per browser tab).
  setAutoNet(role) {
    const $ = (id) => document.getElementById(id);
    const tries = (this.autoNetTries || 0) + 1;
    try { sessionStorage.setItem('sniperyard.autonet', JSON.stringify({ role, name: $('lan-name').value, team: $('lan-team').value, ai: $('lan-ai').value, tries })); } catch { /* ignore */ }
  }

  reloadPage(text) {
    this.reloading = true;
    if (document.pointerLockElement) document.exitPointerLock();
    this.hud.setLoading(text);
    // a moment for queued LAN messages to leave before the socket closes
    setTimeout(() => { location.href = urlWithoutMap(); }, 250);
  }

  bindUI() {
    const start = (fresh) => {
      this.audio.init();
      if (fresh) { this.newMatch(); this.state = 'playing'; }
      this.hud.showStart(false);
      this.hud.showPause(false);
      this.hud.showEnd(false);
      this.paused = false;
      this.input.requestLock();
    };
    document.getElementById('btn-play').addEventListener('click', () => start(true));
    document.getElementById('btn-resume').addEventListener('click', () => start(false));
    document.getElementById('btn-restart').addEventListener('click', () => start(true));
    document.getElementById('btn-again').addEventListener('click', () => start(true));
    this.input.onLockChange = (locked, failed) => {
      if (failed) {
        // pointer lock unavailable: play with arrow keys
        this.paused = false;
        this.hud.showPause(false);
        this.hud.centerMessage('POINTER LOCK UNAVAILABLE', 'USE ARROW KEYS TO LOOK', 3);
        return;
      }
      if (!locked && this.state === 'playing' && !this.input.fallback) {
        this.paused = true;
        this.hud.showPause(true);
      }
    };
    this.renderer.domElement.addEventListener('click', () => {
      if (this.state === 'playing' && !this.input.locked && !this.input.fallback) this.input.requestLock();
    });
    // sound that started without a click (rejoining a LAN game after a map change) needs one
    window.addEventListener('pointerdown', () => { if (this.audio.ctx) this.audio.init(); });
  }

  // ---------------------------------------------------------------- match flow
  // Sides: 0 = north slope (+Z), 1 = south slope (-Z). Teams swap every other round.
  sideOf(team) { return (team + (CONFIG.match.swapSides && this.match && this.match.round % 2 === 1 ? 1 : 0)) % 2; }
  sideSign(team) { return this.sideOf(team) === 0 ? 1 : -1; }

  newMatch() {
    this.match = { round: 0, score: [0, 0], over: false, stats: { shots: 0, hits: 0, kills: 0, longest: 0, survived: 0 } };
    this.newRound();
  }

  // Start a round. Single player and the LAN host build the roster here; joined LAN
  // clients get the host's roster through applyRound().
  newRound() {
    if (this.net && !this.net.isHost) return;
    if (this.net) {
      this.applyRound(this.net.hostRound(), 0);
      return;
    }
    const n = CONFIG.teams.size;
    const me = this.player.team;
    const roster = [];
    let id = 1;
    for (const t of [me, 1 - me]) {
      const spawns = this.teamSpawns(t, n);
      const yaw = this.sideOf(t) === 0 ? 0 : Math.PI;
      for (let i = 0; i < n; i++) {
        const local = t === me && i === 0;
        roster.push({ id: id++, kind: local ? 'h' : 'a', peer: local ? 'local' : undefined, name: local ? 'YOU' : `${CONFIG.teams.names[t]}-${i + 1}`, team: t, x: spawns[i].x, z: spawns[i].z, yaw });
      }
    }
    this.applyRound({ round: this.match.round, score: this.match.score.slice(), roster }, 0);
  }

  // Create everyone for a round from a roster: our player, AI (single player / host) and
  // remote combatants (other LAN players, and the host's AI on joined clients).
  applyRound(msg, roundId) {
    const net = this.net;
    const authority = !net || net.isHost;
    if (msg.settings && !authority) {
      const st = msg.settings;
      if (st.map && st.map !== MAP_ID) { this.followHostMap(st.map); return; }
      CONFIG.zone.mode = st.zone; CONFIG.camouflageStrength = st.camo; CONFIG.weapon.ballistics.enabled = st.ball;
      CONFIG.weapon.tracers = st.tracers; CONFIG.match.roundsToWin = st.rounds; CONFIG.match.swapSides = st.swap; CONFIG.teams.size = st.size;
    }
    this.roundId = roundId;
    this.diedReported = false;
    if (msg.round === 0) this.match = { round: 0, score: [0, 0], over: false, stats: { shots: 0, hits: 0, kills: 0, longest: 0, survived: 0 } };
    this.match.round = msg.round;
    this.match.score = msg.score.slice();
    this.time = 0;
    this.bus.clear();
    this.combat.projectiles.length = 0;
    this.hud.clearKillFeed();
    this.hud.showEnd(false);
    this.roundOver = false;
    this.roundFinished = false;
    this.nextRoundAt = null;
    this.deathT = 0;
    this.killcam = null;
    this.aimHistory = [];
    this.birds.reset(0);
    this.zone.reset();
    this.spectating = null;
    this.damageFlash = 0;
    for (const a of this.ais) a.dispose();
    for (const r of this.remotes || []) r.dispose();
    this.ais = [];
    this.remotes = [];
    const myPeer = net ? net.myPeer : 'local';
    const mine = msg.roster.find((e) => e.kind === 'h' && e.peer === myPeer) || msg.roster[0];
    const p = this.player;
    p.id = mine.id; p.team = mine.team; p.name = mine.name; p.peer = myPeer;
    p.spawn(mine.x, mine.z, mine.yaw);
    p.pos.y = this.terrain.heightAt(mine.x, mine.z);
    let idx = 0;
    for (const e of msg.roster) {
      if (e === mine) continue;
      let c;
      if (e.kind === 'a' && authority) {
        c = new AICombatant(this, { name: e.name, team: e.team, index: idx++, armband: e.team === p.team });
        this.ais.push(c);
      } else {
        c = new RemoteCombatant(this, { id: e.id, name: e.name, team: e.team, human: e.kind === 'h', index: idx++, armband: e.team === p.team });
        this.remotes.push(c);
      }
      c.id = e.id;
      c.peer = e.peer;
      c.spawn(e.x, e.z, e.yaw);
    }
    this.spawnDummies();
    this.humans = [p, ...this.remotes.filter((r) => r.human)];
    this.combatants = [p, ...this.ais, ...this.remotes, ...this.dummies];
    this.combat.setCombatants(this.combatants);
    this.envTintT = 0;
    if (net && !net.isHost && this.state !== 'playing') this.enterNetGame();
    this.announceRound();
  }

  announceRound() {
    const M = this.match, me = this.player.team;
    const names = CONFIG.teams.names;
    const slope = this.sideOf(me) === 0 ? 'NORTH' : 'SOUTH';
    const score = CONFIG.match.roundsToWin > 1 ? ` · ${names[me]} ${M.score[me]} – ${M.score[1 - me]} ${names[1 - me]}` : '';
    const n = CONFIG.teams.size;
    this.hud.centerMessage(CONFIG.match.roundsToWin > 1 ? `ROUND ${M.round + 1}` : 'ROUND START',
      `${n}v${n} · ${MAPS[MAP_ID].name} · YOU HOLD THE ${slope} SLOPE${score}`, Math.max(2.5, CONFIG.round.freezeTime));
  }

  // Called once when a round's result is final (a short delay after the last elimination).
  finishRound() {
    if (this.roundFinished) return;
    this.roundFinished = true;
    const M = this.match, me = this.player.team, names = CONFIG.teams.names;
    const a = this.aliveCount(0), b = this.aliveCount(1);
    const winner = a > 0 && b === 0 ? 0 : b > 0 && a === 0 ? 1 : -1;
    if (winner >= 0) M.score[winner]++;
    const p = this.player;
    M.stats.shots += p.shotsFired; M.stats.hits += p.hits; M.stats.kills += p.kills;
    M.stats.longest = Math.max(M.stats.longest, p.longestHit);
    if (p.alive) M.stats.survived++;
    this.lastWinner = winner;
    if (winner >= 0 && M.score[winner] >= CONFIG.match.roundsToWin) {
      M.over = true;
      if (this.net && this.net.isHost) this.net.broadcastRoundEnd(winner);
      this.showMatchEnd(winner);
      return;
    }
    this.nextRoundAt = this.time + CONFIG.match.nextRoundDelay;
    this.intermissionTitle = winner < 0 ? 'ROUND DRAW' : winner === me ? 'ROUND WON' : 'ROUND LOST';
    if (this.net && this.net.isHost) this.net.broadcastRoundEnd(winner);
  }

  // Joined client: the host ended the round (or the match).
  applyRoundEnd(m) {
    const M = this.match, me = this.player.team, p = this.player;
    if (this.roundFinished) return;
    this.roundFinished = true;
    this.roundOver = true;
    M.score = m.score.slice();
    M.stats.shots += p.shotsFired; M.stats.hits += p.hits; M.stats.kills += p.kills;
    M.stats.longest = Math.max(M.stats.longest, p.longestHit);
    if (p.alive) M.stats.survived++;
    if (m.over) {
      M.over = true;
      this.showMatchEnd(m.winner);
      return;
    }
    this.nextRoundAt = m.next;
    this.intermissionTitle = m.winner < 0 ? 'ROUND DRAW' : m.winner === me ? 'ROUND WON' : 'ROUND LOST';
  }

  updateIntermission() {
    if (this.nextRoundAt === null || this.nextRoundAt === undefined) return;
    const M = this.match, me = this.player.team, names = CONFIG.teams.names;
    const left = Math.max(0, Math.ceil(this.nextRoundAt - this.time));
    const swap = CONFIG.match.swapSides ? ' · SIDES SWAP' : '';
    this.hud.centerMessage(this.intermissionTitle, `${names[me]} ${M.score[me]} – ${M.score[1 - me]} ${names[1 - me]} · NEXT ROUND IN ${left}${swap}`, 0.3);
    if (this.time >= this.nextRoundAt && (!this.net || this.net.isHost)) {
      M.round++;
      this.newRound();
    }
  }

  // ---------------------------------------------------------------- LAN
  setupLan() {
    const $ = (id) => document.getElementById(id);
    const S = new NetSession();
    this.lanSession = S;
    try { $('lan-name').value = localStorage.getItem('sniperyard.name') || ''; } catch { /* ignore */ }
    try {
      const note = sessionStorage.getItem('sniperyard.note');
      if (note) { this.lanNote = note; sessionStorage.removeItem('sniperyard.note'); }
      // host or join again after a map change reloaded the page
      const auto = JSON.parse(sessionStorage.getItem('sniperyard.autonet') || 'null');
      sessionStorage.removeItem('sniperyard.autonet');
      if (auto && (auto.role === 'host' || auto.role === 'join')) {
        this.autoNet = auto.role;
        this.autoNetTries = auto.tries || 1;
        if (auto.name) $('lan-name').value = auto.name;
        if (auto.team) $('lan-team').value = auto.team;
        if (auto.ai) { $('lan-ai').value = auto.ai; CONFIG.lan.fillWithAI = auto.ai === '1'; }
        this.lanNote = auto.role === 'host' ? `HOSTING AGAIN ON ${MAPS[MAP_ID].name}` : `${MAPS[MAP_ID].name} LOADED · JOINING THE HOST`;
      }
    } catch { /* ignore */ }
    S.onAvailable = (ok) => { $('lanbox').style.display = ok ? 'block' : 'none'; this.renderLobby(); };
    S.onLobby = () => { this.renderLobby(); this.tryAutoNet(); };
    S.onError = (msg) => { this.lanNote = msg; this.renderLobby(); };
    S.onHostGone = () => { if (this.net && !this.reloading) this.leaveNet('THE HOST LEFT THE GAME'); };
    S.connect();
    $('btn-host').addEventListener('click', () => this.lanJoin(true));
    $('btn-join').addEventListener('click', () => this.lanJoin(false));
    $('lan-team').addEventListener('change', () => { if (S.joined) S.setTeam($('lan-team').value); });
    $('lan-ai').addEventListener('change', () => { CONFIG.lan.fillWithAI = $('lan-ai').value === '1'; });
    $('btn-mpstart').addEventListener('click', () => {
      if (!this.net || !this.net.isHost) return;
      this.audio.init();
      this.net.teamOf.clear();
      this.newMatch();
      this.enterNetGame();
    });
    $('btn-leave').addEventListener('click', () => this.leaveNet());
    $('btn-leavegame').addEventListener('click', () => this.leaveNet());
  }

  lanJoin(host) {
    const $ = (id) => document.getElementById(id);
    const S = this.lanSession;
    if (S.joined || this.reloading) return;
    // the host plays another map: load it first, then join by itself
    if (!host && MAPS[S.hostMap] && S.hostMap !== MAP_ID) {
      if ((this.autoNetTries || 0) >= 3) { this.lanNote = 'COULD NOT LOAD THE HOST\'S MAP · RELOAD THE PAGE'; this.renderLobby(); return; }
      this.followHostMap(S.hostMap);
      return;
    }
    this.audio.init();
    const name = ($('lan-name').value || '').trim().toUpperCase() || 'PLAYER';
    try { localStorage.setItem('sniperyard.name', name); } catch { /* ignore */ }
    this.lanNote = '';
    this.autoNetTries = 0;
    S.hello(name, $('lan-team').value, host);
    this.net = new LanGame(this, S);
    this.renderLobby();
  }

  // After a map change: host again, or join once the host is back.
  tryAutoNet() {
    const S = this.lanSession;
    if (!this.autoNet || !S.available || S.joined) return;
    if (this.autoNet === 'host') {
      this.autoNet = null;
      if (!S.hostId) this.lanJoin(true);
    } else if (S.hostId && S.hostMap) {
      this.autoNet = null;
      this.lanJoin(false);
    }
  }

  renderLobby() {
    const $ = (id) => document.getElementById(id);
    const S = this.lanSession;
    const joined = S.joined;
    const names = CONFIG.teams.names;
    $('lan-list').innerHTML = S.players.map((p) => {
      const team = p.team === '0' ? `<span class="t0">${names[0]}</span>` : p.team === '1' ? `<span class="t1">${names[1]}</span>` : '<span class="dim">AUTO</span>';
      return `<span>${p.name}${p.id === S.myId ? ' (you)' : ''}</span>${team}<span class="dim">${p.id === S.hostId ? 'HOST' : ''}</span>`;
    }).join('');
    $('btn-host').style.display = joined ? 'none' : '';
    $('btn-join').style.display = joined ? 'none' : '';
    $('btn-leave').style.display = joined ? '' : 'none';
    $('btn-mpstart').style.display = joined && S.isHost ? '' : 'none';
    $('btn-join').disabled = !S.hostId;
    $('btn-host').disabled = !!S.hostId;
    $('btn-play').disabled = joined;
    // joined players play the host's map
    for (const id of ['map-quick', 's0-map', 's1-map']) $(id).disabled = joined && !S.isHost;
    const hostMap = MAPS[S.hostMap] ? MAPS[S.hostMap].name : '';
    $('lan-note').textContent = this.lanNote || (!S.available ? '' : !joined ? (S.hostId ? `A GAME IS HOSTED ON THIS NETWORK${hostMap ? ` (${hostMap})` : ''} · CHOOSE A NAME AND JOIN` : 'NOBODY IS HOSTING YET · HOST A GAME, FRIENDS JOIN FROM THEIR BROWSERS')
      : S.isHost ? `YOU HOST ${MAPS[MAP_ID].name} · ${S.players.length} PLAYER${S.players.length === 1 ? '' : 'S'} · THE MATCH TAB SETS MAP, TEAM SIZE, ROUNDS AND ZONE`
        : S.inGame ? 'MATCH IN PROGRESS · YOU JOIN AT THE NEXT ROUND' : 'WAITING FOR THE HOST TO START THE MATCH');
    this.updateMenuButtons();
  }

  updateMenuButtons() {
    const authority = !this.net || this.net.isHost;
    document.getElementById('btn-restart').style.display = authority ? '' : 'none';
    document.getElementById('btn-leavegame').style.display = this.net ? '' : 'none';
  }

  enterNetGame() {
    const host = this.net.isHost;
    this.combat.claimHits = !host;
    this.birds.authority = host;
    this.state = 'playing';
    this.paused = false;
    this.hud.showStart(false);
    this.hud.showPause(false);
    this.hud.showEnd(false);
    this.updateMenuButtons();
    // the host clicked START (a user gesture); joined players click once to capture the mouse
    if (host) this.input.requestLock();
  }

  leaveNet(note) {
    if (this.reloading) return;
    try { if (note) sessionStorage.setItem('sniperyard.note', note); } catch { /* ignore */ }
    location.href = location.pathname + location.search;
  }

  // Spread a team along its slope (upper half, near the ridge).
  teamSpawns(team, n) {
    const T = this.terrain;
    const side = this.sideSign(team);
    const out = [];
    // map scale along the valley and across it (1 on the valley map)
    const kx = CONFIG.map.length / 440, ks = CONFIG.map.ridgeDist / 178;
    const span = Math.min(170, 60 * n) * kx;
    const off = (Math.random() - 0.5) * 120 * kx;
    const used = [];
    for (let i = 0; i < n; i++) {
      const bx = off + (n === 1 ? 0 : -span / 2 + (span * i) / (n - 1));
      // prefer a scored sniper spot (open view across the valley) near this slot
      let best = null, bestS = -1;
      for (const sp of this.spots.spots[this.sideOf(team)]) {
        if (Math.abs(sp.x - bx) > 35 || used.includes(sp)) continue;
        const sc = sp.view + sp.height * 0.3 + Math.random() * 0.7;   // varied, so spawns aren't predictable
        if (sc > bestS) { bestS = sc; best = sp; }
      }
      if (best) { used.push(best); out.push({ x: best.x, z: best.z }); continue; }
      for (let k = 0; k < 60 && !best; k++) {
        const x = bx + (Math.random() - 0.5) * 20;
        const z = T.riverCenter(x) + side * (105 + Math.random() * 45) * ks;
        if (Math.abs(z) > T.halfZ - 6 || T.waterDepthAt(x, z) > 0) continue;
        if (this.world.query(x, z, 1.5, ['tree', 'rock', 'log', 'stump']).length) continue;
        best = { x, z };
      }
      out.push(best || { x: bx, z: T.riverCenter(bx) + side * 120 * ks });
    }
    return out;
  }

  // Shooting-range targets on the opposite slope (milestone 2 test aid).
  spawnDummies() {
    for (const d of this.dummies) d.dispose(this.scene);
    this.dummies = [];
    if (!this.params.has('dummies')) return;
    const px = this.player.pos.x;
    const T = this.terrain;
    const spots = [[-25, 45, 'stand'], [15, 90, 'crouch'], [55, 140, 'prone'], [-60, 70, 'stand'], [35, 30, 'crouch']];
    spots.forEach(([dx, dz, stance], i) => {
      const ks = CONFIG.map.ridgeDist / 178;
      let x = px + dx, z = T.riverCenter(px + dx) - (20 + dz) * ks;
      const q = { x, z };
      for (let k = 0; k < 3; k++) this.world.collideCircle(q, 1.2);
      this.dummies.push(new TargetDummy(this.scene, `TARGET ${i + 1}`, q.x, q.z, T, stance, Math.PI));
    });
  }

  onKill(shooter, victim, dist, part, point) {
    const d = Math.round(dist);
    if (shooter.isPlayer) {
      this.hud.hitMarker(true);
      const ff = victim.team === shooter.team;
      this.hud.centerMessage(ff ? 'FRIENDLY FIRE' : `${part === 'head' ? 'HEADSHOT' : 'ELIMINATED'} · ${d} m`, victim.name, 1.8);
    }
    if (victim.isPlayer) {
      this.player.killedBy = shooter;
      this.startKillcam(shooter, dist, part, point);
    }
    const cls = (c) => (c.team === this.player.team ? 'f' : 'e');
    this.hud.killFeed(`<span class="${cls(shooter)}">${shooter.name}</span> ✕ <span class="${cls(victim)}">${victim.name}</span> · ${d} m${part === 'head' ? ' · HEAD' : ''}`);
  }

  // ---------------------------------------------------------------- killcam
  startKillcam(shooter, dist, part, point) {
    const p = this.player;
    const target = shooter.scopePos(new THREE.Vector3());
    let eye = p.eyePos(new THREE.Vector3());
    // look from where the bullet hit if the eye has no line of sight to the shooter
    if (point && !this.world.lineOfSight(eye, target, { endMargin: 1 })) {
      const alt = point.clone().addScaledVector(new THREE.Vector3().subVectors(target, point).normalize(), 0.4);
      if (this.world.lineOfSight(alt, target, { endMargin: 1 })) eye = alt;
    }
    const lines = [];
    const reason = (shooter.ai && shooter.ai.reasons.get(p.id)) || this.killReason;
    if (reason && REVEAL_TEXT[reason.cue]) lines.push(['SPOTTED YOU BY', REVEAL_TEXT[reason.cue][reason.own ? 0 : 1]]);
    const give = this.recentGiveaways(p, shooter);
    if (give.length) lines.push(['YOUR GIVEAWAYS', give.join(' · ')]);
    if (!lines.length) lines.push(['YOUR GIVEAWAYS', 'NONE IN THE LAST 40 S']);
    this.hud.clearCenter();
    this.killcam = {
      shooter, eye, yaw0: p.yaw, pitch0: p.pitch, start: this.realTime, end: this.realTime + CONFIG.round.killcamTime,
      title: `KILLED BY ${shooter.name} · ${Math.round(dist)} m${part === 'head' ? ' · HEADSHOT' : ''}`, lines,
    };
  }

  // What the player did recently that could have given them away (newest first).
  recentGiveaways(p, shooter) {
    const now = this.time, out = [];
    const ago = (t) => `${Math.max(1, Math.round(now - t))} S AGO`;
    const seen = new Set();
    const label = { shot: 'YOUR SHOT', birds: 'BIRDS YOU FLUSHED', splash: 'SPLASHING' };
    const evs = this.bus.recent(now, 40);
    for (let i = evs.length - 1; i >= 0; i--) {
      const ev = evs[i];
      if (ev.sourceId !== p.id) continue;
      let k = ev.type;
      if (k === 'footstep' && (ev.loudness || 0) >= 1) k = 'sprint';
      const text = k === 'sprint' ? 'SPRINTING' : label[k];
      if (!text || seen.has(k)) continue;
      seen.add(k);
      out.push(`${text} ${ago(ev.time)}`);
    }
    // was our scope pointed at them (glint toward the killer)?
    const se = shooter.eyePos(new THREE.Vector3());
    const to = new THREE.Vector3();
    for (let i = this.aimHistory.length - 1; i >= 0; i--) {
      const h = this.aimHistory[i];
      if (now - h.t > 15) break;
      if (!h.scoped) continue;
      to.subVectors(se, h.eye).normalize();
      if (THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(to.dot(h.dir), -1, 1))) < CONFIG.reveal.glintAngle) {
        out.unshift(`SCOPE GLINT TOWARD THEM ${ago(h.t)}`);
        break;
      }
    }
    return out.slice(0, 3);
  }

  // Sample the player's aim a few times per second (for the killcam's glint check).
  recordAim(dt) {
    this.aimSampleT = (this.aimSampleT || 0) - dt;
    if (this.aimSampleT > 0) return;
    this.aimSampleT = 0.25;
    const p = this.player;
    if (!p.alive) return;
    this.aimHistory.push({ t: this.time, scoped: p.scoped, eye: p.eyePos(new THREE.Vector3()), dir: p.aimDir(new THREE.Vector3()) });
    if (this.aimHistory.length > 80) this.aimHistory.shift();
  }

  playerFire() {
    const p = this.player;
    if (!this.combat.canFire(p, this.time)) return;
    const dir = p.aimDir(new THREE.Vector3());
    // unscoped shots are inaccurate
    const spread = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(CONFIG.weapon.hipSpread, 0, THREE.MathUtils.smoothstep(p.scopeT, 0.5, 0.95)));
    if (spread > 0) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread;
      const right = new THREE.Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
      const up = new THREE.Vector3().crossVectors(right, dir).normalize();
      dir.applyAxisAngle(up, Math.cos(a) * r).applyAxisAngle(right, Math.sin(a) * r).normalize();
    }
    if (this.combat.fire(p, dir, this.time)) {
      p.applyRecoil();
      this.viewmodel.onFire(this.time);
      this.audio.bolt(0.25);
    }
  }

  frame() {
    const now = performance.now();
    const rawDt = Math.max(0, (now - this.lastNow) / 1000);
    const dtReal = Math.min(0.05, rawDt);
    this.lastNow = now;
    this.frameCount++;
    this.realTime += dtReal;
    const input = this.input;
    if (input.wasPressed('F1')) this.debug = !this.debug;
    if (input.wasPressed('F2') && CONFIG.debug.allowReveal) this.reveal = !this.reveal;
    if (input.wasPressed('Escape') && this.state === 'playing' && input.fallback) {
      this.paused = !this.paused;
      this.hud.showPause(this.paused);
    }
    const authority = !this.net || this.net.isHost;
    if (input.wasPressed('KeyT') && this.state === 'playing' && authority) {
      this.zone.skip(this.time);
      this.hud.centerMessage('ZONE STEP SKIPPED', this.zone.debugText(), 1.5);
    }
    if (input.actPressed('restart') && (this.state === 'playing' || this.state === 'ended') && authority && !this.paused) {
      this.hud.showEnd(false);
      this.newMatch();
      this.state = 'playing';
      // pointer lock needs a click (a user gesture); the canvas click handler re-captures the mouse
      if (!input.locked && !input.fallback) this.hud.centerMessage('CLICK TO CAPTURE THE MOUSE', '', 3);
    }
    if (this.bench && this.bench.update(rawDt)) {
      this.simulate(0, this.idleInput());
      this.effects.update(dtReal, this.camera);
      this.render(dtReal);
      input.endFrame();
      return;
    }
    this.updateAutoResolution(rawDt);
    // LAN games keep running while the menu is open (others are still playing)
    const running = this.state === 'playing' && (!this.paused || this.net);
    this.simulate(running ? dtReal : 0, running && !this.paused ? input : this.idleInput());
    if (this.net) this.net.tick(dtReal);
    this.effects.update(dtReal, this.camera);
    if (!this.noRender) this.render(dtReal);
    input.endFrame();
  }

  // Advance gameplay by dt seconds (dt = 0 keeps the camera alive while paused).
  simulate(dt, input) {
    if (dt > 0) this.time += dt;
    SHARED.uTime.value = this.realTime;
    const p = this.player;
    // freeze time at round start: look around, no moving or firing
    const freeze = this.time < CONFIG.round.freezeTime;
    p.frozen = freeze;
    p.update(dt, input, this.world, this.terrain, this.time);
    p.bodyYaw = p.yaw;
    p.hitbox.update(p);
    if (dt > 0 && p.alive && !freeze && input.actPressed && input.actPressed('fire')) this.playerFire();
    if (dt > 0) {
      const authority = !this.net || this.net.isHost;
      for (const a of this.ais) { a.frozenByRound = freeze; a.update(dt, this.time); }
      for (const r of this.remotes) r.update(dt, this.time);
      this.combat.update(dt, this.time);
      this.birds.update(dt, this.time, this.combatants, this.camera);
      this.zone.update(dt, this.time);
      this.applyZoneDamage(dt);
      this.updateCharacterTints(dt);
      this.recordAim(dt);
      if (authority) {
        this.checkRoundEnd();
        if (this.roundOver && !this.roundFinished && this.time >= this.endAt && this.state === 'playing') this.finishRound();
      }
      if (this.state === 'playing') this.updateIntermission();
    }
    for (const d of this.dummies) d.update(dt);
    if (!p.alive) this.deathT += dt;
  }

  applyZoneDamage(dt) {
    const dps = this.zone.damagePerSecond();
    for (const c of this.combatants) {
      if (!c.alive || c.isDummy || c.isRemote) continue;
      if (this.zone.contains(c.pos.x, c.pos.z, 0, false)) continue;
      c.health -= dps * dt;
      if (c.isPlayer) this.damageFlash = Math.min(1, this.damageFlash + dt * 2);
      if (c.health <= 0) {
        if (this.net && !this.net.isHost) {
          // joined client: report our own zone death, the host confirms it to everyone
          c.health = 0;
          if (!this.diedReported) { this.diedReported = true; this.net.sendDied(c); }
          continue;
        }
        this.applyZoneDeath(c);
      }
    }
  }

  applyZoneDeath(c) {
    c.health = 0;
    c.alive = false;
    c.deathTime = this.time;
    c.killedBy = null;
    this.hud.killFeed(`ZONE ✕ <span class="${c.team === this.player.team ? 'f' : 'e'}">${c.name}</span>`);
    if (c.isPlayer) this.hud.centerMessage('ELIMINATED BY THE ZONE', '', 3);
    if (this.net && this.net.isHost) this.net.broadcastKill(null, c, 0, null, null, 'zone');
  }

  // Joined client: the host confirmed a death.
  applyKillMessage(m) {
    const victim = this.combatants.find((c) => c.id === m.v);
    if (!victim || !victim.alive) return;
    const shooter = m.s ? this.combatants.find((c) => c.id === m.s) : null;
    const point = m.p ? new THREE.Vector3(m.p[0], m.p[1], m.p[2]) : null;
    if (!shooter) {
      if (m.cause === 'left') {
        victim.alive = false; victim.health = 0;
        this.hud.killFeed(`<span class="${victim.team === this.player.team ? 'f' : 'e'}">${victim.name}</span> LEFT THE GAME`);
      } else this.applyZoneDeath(victim);
      return;
    }
    victim.alive = false;
    victim.health = 0;
    victim.killedBy = shooter;
    victim.deathTime = this.time;
    shooter.kills = (shooter.kills || 0) + 1;
    if (shooter === this.player) {
      shooter.hits++;
      shooter.longestHit = Math.max(shooter.longestHit, m.d);
    }
    if (victim !== this.player && point) this.effects.impact(point, 'body');
    this.killReason = m.r || null;
    this.onKill(shooter, victim, m.d, m.part, point);
    this.killReason = null;
  }

  showMatchEnd(winner) {
    this.state = 'ended';
    const M = this.match, st = M.stats, me = this.player.team, names = CONFIG.teams.names;
    const won = winner === me;
    const acc = st.shots ? Math.round((st.hits / st.shots) * 100) : 0;
    const multi = CONFIG.match.roundsToWin > 1;
    const sub = multi ? `${names[me]} ${M.score[me]} – ${M.score[1 - me]} ${names[1 - me]} · ${won ? 'MATCH WON' : 'MATCH LOST'}`
      : won ? (this.player.alive ? 'YOUR TEAM WINS' : 'YOUR TEAM WINS · YOU DID NOT SURVIVE') : 'YOUR TEAM WAS ELIMINATED';
    const t = Math.floor(this.time);
    const rows = [
      [multi ? 'Rounds played' : 'Round time', multi ? M.round + 1 : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`],
      ['Rounds survived', `${st.survived} / ${M.round + 1}`],
      ['Shots fired', st.shots],
      ['Hits', `${st.hits} (${acc}%)`],
      ['Eliminations', st.kills],
      ['Longest hit', st.longest ? `${Math.round(st.longest)} m` : '-'],
    ];
    if (!multi) rows.splice(1, 1);
    this.hud.showEnd(true, won, sub, rows);
    const again = document.getElementById('btn-again');
    again.disabled = !!(this.net && !this.net.isHost);
    again.textContent = this.net && !this.net.isHost ? 'WAITING FOR THE HOST' : 'NEW MATCH (R)';
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // Camouflage: suits blend toward the local ground colour (scaled by camouflageStrength).
  updateCharacterTints(dt) {
    this.envTintT -= dt;
    if (this.envTintT > 0) return;
    this.envTintT = 1;
    const c = new THREE.Color();
    for (const a of [...this.ais, ...this.remotes]) {
      const canopy = this.terrain.canopyAt(a.pos.x, a.pos.z);
      const grass = this.terrain.grassDensityAt(a.pos.x, a.pos.z);
      c.setRGB(0.92, 0.88, 0.78).lerp(new THREE.Color(0.85, 1.05, 0.75), grass).lerp(new THREE.Color(0.8, 0.78, 0.68), canopy * 0.7);
      a.character.setEnvironmentTint(c);
    }
  }

  aliveCount(team) { return this.combatants.filter((c) => c.team === team && c.alive && !c.isDummy).length; }

  checkRoundEnd() {
    if (this.roundOver) return;
    const a = this.aliveCount(0), b = this.aliveCount(1);
    if (a > 0 && b > 0) return;
    this.roundOver = true;
    this.endAt = this.time + Math.max(2.5, this.killcam ? this.killcam.end - this.realTime + 0.5 : 0);
  }

  // Is any enemy currently lining up a shot on the player (glint toward us + line of sight)?
  playerAimedAt() {
    const p = this.player;
    if (!p.alive) return false;
    const eye = p.eyePos(new THREE.Vector3());
    for (const a of this.combatants) {
      if (a === p || a.isDummy || a.team === p.team || !a.alive) continue;
      // AI lining up on us (local brain, or the host's AI via aimTargetId); a remote player
      // with their glint on us (within ~2.5° of their aim)
      const aiming = a.ai ? (a.ai.state === 'aim' || a.ai.state === 'fire') && a.ai.target === p
        : a.isRemote && (a.aimTargetId === p.id || (a.human && a.scoped && glintAim(a, eye) > 0.6));
      if (aiming && glintToward(a, eye) > 0.1 && this.world.lineOfSight(a.scopePos(new THREE.Vector3()), eye)) return true;
    }
    return false;
  }

  // Test hook: run the simulation without rendering (fixed steps).
  simulateFor(seconds, step = 1 / 30) {
    const n = Math.round(seconds / step);
    for (let i = 0; i < n; i++) {
      this.simulate(step, this.input);
      this.input.pressed.clear();
      this.input.clicked.clear();
    }
    return this.time;
  }

  render(dtReal) {
    this.renderer.info.reset();
    this.updateRenderSystems(dtReal);
    this.post.uniforms.uScope.value = THREE.MathUtils.smoothstep(this.player.scopeT, 0.55, 1.0);
    this.post.render(dtReal, this.realTime);
    const p = this.player;
    const boltT = THREE.MathUtils.clamp(1 - (p.boltReadyTime - this.time) / CONFIG.weapon.boltTime, 0, 1);
    // scope glints of AI snipers, as seen from the player's camera (depth-tested sprites)
    for (const a of this.combatants) {
      if (!a.glint) continue;
      const gi = glintToward(a, this.camera.position);
      if (gi > 0.001) a.glint.set(a.scopePos(new THREE.Vector3()), gi, this.camera, this.realTime); else a.glint.hide();
    }
    this.aimedAtT = (this.aimedAtT || 0) - dtReal;
    if (this.aimedAtT <= 0) { this.aimedAtT = 0.15; this.aimedAt = this.playerAimedAt(); }
    const w = window.innerWidth, h = window.innerHeight;
    this.hud.localTeam = p.team;
    const others = this.combatants.filter((c) => c !== p && !c.isDummy);
    this.hud.updateMarkers(this.camera, others.filter((c) => c.team === p.team), w, h);
    this.hud.updateDebugMarks(this.camera, others, w, h, this.reveal);
    const me = p.team;
    this.hud.setTeams(this.combatants.filter((c) => c.team === me && !c.isDummy), this.combatants.filter((c) => c.team !== me && !c.isDummy));
    this.hud.setScore(this.match.score[me], this.match.score[1 - me], this.match.round, CONFIG.match.roundsToWin);
    const board = this.state === 'playing' && !this.paused && this.input.act('scores');
    this.hud.setScoreboard(board, board ? this.combatants.filter((c) => !c.isDummy).map((c) => ({
      name: c.name, team: c.team, alive: c.alive, kills: c.kills || 0, human: c === p || !!c.human, me: c === p,
    })) : null, me, this.match.score);
    this.hud.update(dtReal, {
      alive: this.player.alive, scoped: this.player.scoped, health: this.player.health, stance: this.player.stance,
      inWater: this.player.inWater > 0.05, boltT, glint: this.player.scoped && this.player.alive, aimedAt: this.aimedAt,
      glintDim: glintSun(this.player.scopePos(_eye)) < 0.6,
      outside: p.alive && !this.zone.contains(p.pos.x, p.pos.z), outsideDps: this.zone.damagePerSecond(),
      holdingBreath: this.player.holdingBreath, breathCooldown: this.player.breathCooldown > 0, yaw: this.camera.rotation.y,
    });
    this.hud.setZone(this.zone.hudState());
    this.damageFlash = Math.max(0, this.damageFlash - dtReal * 1.5);
    this.post.uniforms.uDamage.value = this.damageFlash * 0.6;
    this.post.uniforms.uOutside.value = p.alive && !this.zone.contains(p.pos.x, p.pos.z) ? 1 : 0;
    if (this.debug) this.hud.setDebug(this.debugText(), true); else this.hud.setDebug('', false);
  }

  idleInput() {
    if (!this._idle) this._idle = { mouseDX: 0, mouseDY: 0, wheel: 0, down: () => false, wasPressed: () => false, mouse: () => false, act: () => false, actPressed: () => false };
    return this._idle;
  }

  updateRenderSystems(dt) {
    const cam = this.camera;
    const p = this.player;
    const mates = this.combatants.filter((a) => a !== p && !a.isDummy && a.team === p.team && a.alive);
    const kc = this.killcam && this.realTime < this.killcam.end ? this.killcam : null;
    this.hud.setKillcam(null);
    if (!p.alive && kc) {
      // killcam: turn from our last view toward the shooter and zoom in on them
      const t = this.realTime - kc.start;
      const target = kc.shooter.scopePos(new THREE.Vector3());
      const look = yawPitchTo(kc.eye, target);
      const k = THREE.MathUtils.smoothstep(t, 0.5, 1.6);
      let dy = look.yaw - kc.yaw0;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      cam.position.copy(kc.eye);
      cam.rotation.set(THREE.MathUtils.lerp(kc.pitch0, look.pitch, k), kc.yaw0 + dy * k, 0, 'YXZ');
      const dist = kc.eye.distanceTo(target);
      const fovT = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(4 / dist)), 2.5, 40);
      const z = THREE.MathUtils.smoothstep(t, 1.2, 2.4);
      const fov = CONFIG.player.fovHip * Math.pow(fovT / CONFIG.player.fovHip, z);
      if (Math.abs(cam.fov - fov) > 1e-3) { cam.fov = fov; cam.updateProjectionMatrix(); }
      p.scopeT = 0;
      this.post.uniforms.uFade.value = Math.max(0, 0.35 - t * 0.3);
      cam.updateMatrixWorld();
      const sp = target.clone().project(cam);
      this.hud.setKillcam(t > 1.4 ? kc : null, sp.z < 1 ? { x: (sp.x * 0.5 + 0.5) * window.innerWidth, y: (-sp.y * 0.5 + 0.5) * window.innerHeight, name: kc.shooter.name } : null);
    } else if (!p.alive && mates.length && this.state === 'playing' && (this.killcam || this.deathT > 2.5)) {
      // spectate a living teammate (third person, behind the shoulder); click to switch
      if (!this.spectating || !this.spectating.alive) this.spectating = mates[0];
      if (this.input.actPressed('fire')) {
        const i = mates.indexOf(this.spectating);
        this.spectating = mates[(i + 1) % mates.length];
      }
      const m = this.spectating;
      const d = m.aimDir(new THREE.Vector3());
      const back = new THREE.Vector3(d.x, 0, d.z).normalize();
      const e = m.eyePos(new THREE.Vector3());
      const right = new THREE.Vector3(-back.z, 0, back.x);
      cam.position.copy(e).addScaledVector(back, -2.6).addScaledVector(right, 0.6).add(new THREE.Vector3(0, 0.7, 0));
      const gy = this.terrain.heightAt(cam.position.x, cam.position.z) + 0.4;
      if (cam.position.y < gy) cam.position.y = gy;
      cam.rotation.set(m.pitch * 0.8 - 0.08, m.yaw, 0, 'YXZ');
      if (cam.fov !== CONFIG.player.fovHip) { cam.fov = CONFIG.player.fovHip; cam.updateProjectionMatrix(); }
      this.post.uniforms.uFade.value = 0;
      this.hud.el.center.innerHTML = `SPECTATING ${m.name}<small>CLICK TO SWITCH</small>`;
      this.hud.el.center.classList.add('on');
      this.hud.centerTimer = 0.1;
    } else if (!p.alive) {
      // death cam: sink to the ground and tilt
      const k = Math.min(1, this.deathT / 1.4);
      const e = k * k * (3 - 2 * k);
      cam.position.set(p.pos.x, p.pos.y + THREE.MathUtils.lerp(p.eye, 0.25, e), p.pos.z);
      cam.rotation.set(THREE.MathUtils.lerp(p.pitch, -0.25, e), p.yaw, e * 0.6, 'YXZ');
      if (cam.fov !== CONFIG.player.fovHip) { cam.fov = CONFIG.player.fovHip; cam.updateProjectionMatrix(); }
      p.scopeT = 0;
      this.post.uniforms.uFade.value = Math.min(0.55, this.deathT * 0.4);
    } else this.post.uniforms.uFade.value = 0;
    cam.updateMatrixWorld();
    // shadow / grass focus: aim point when scoped, slightly ahead of the player otherwise
    let focus, extent;
    if (!p.alive && kc) {
      focus = kc.shooter.pos.clone();
      extent = 45;
    } else if (p.scopeT > 0.5) {
      const dir = p.aimDir(new THREE.Vector3());
      const hit = this.world.raycast(cam.position, dir, 600, { crowns: false });
      const dist = hit ? hit.t : 300;
      focus = cam.position.clone().addScaledVector(dir, dist);
      extent = THREE.MathUtils.clamp(dist * 0.18 + 25, 35, 90);
    } else {
      focus = p.pos.clone().addScaledVector(p.aimDir(new THREE.Vector3()).setY(0).normalize(), 45);
      extent = 120;
    }
    this.shadowFocus = focus;
    this.sky.updateShadow(focus, extent);
    this.forest.update(cam, focus, CONFIG.trees.shadowDistance * (extent / 120) + 20);
    this.undergrowth.update(cam);
    this.grass.update(p.scopeT > 0.5 || (!p.alive && kc) ? focus : cam.position);
    this.water.update(this.realTime);
    // clouds drift with game time (the same for everyone in a LAN game; new clouds each round)
    updateWeather(this.time + (this.match ? this.match.round * 977 : 0), cam);
    this.post.sunVis = WEATHER.sunVis;
    this.particles.update(cam, this.renderer, gustAt(cam.position.x, cam.position.z, this.realTime), WEATHER.sunVis, p.alive ? p.scopeT : 0);
    this.forestSound.update(dt, cam, this.realTime);
    SHARED.uSunDirView.value.copy(this.sky.sunDir).transformDirection(cam.matrixWorldInverse);
    // sunlight on the player: 0 in the shade of trees or terrain, less under a cloud (dims the
    // first-person rifle)
    this.shadeTimer = (this.shadeTimer || 0) - dt;
    if (this.shadeTimer <= 0) {
      this.shadeTimer = 0.25;
      this.inShade = !!this.world.raycast(p.eyePos(new THREE.Vector3()), this.sky.sunDir, 200, { terrain: true });
    }
    const eye = p.eyePos(_eye);
    this.viewmodel.update(dt, this.time, p, SHARED.uSunDirView.value, this.inShade ? 0 : sunlightAt(eye));
    this.audio.updateListener(cam);
    // river ambience from the nearest point on the river centre line
    const rz = this.terrain.riverCenter(cam.position.x);
    const rp = new THREE.Vector3(cam.position.x, 0, rz);
    this.audio.setRiverSource(rp, Math.abs(cam.position.z - rz) + Math.max(0, cam.position.y) * 0.5);
  }

  // Debug/test hook: place the player and camera.
  setView(x, z, yaw = 0, pitch = 0, opts = {}) {
    const p = this.player;
    const q = { x, z };
    for (let k = 0; k < 4; k++) this.world.collideCircle(q, 1.5);
    p.pos.set(q.x, this.terrain.heightAt(q.x, q.z), q.z);
    p.lookYaw = yaw; p.lookPitch = pitch;
    if (opts.stance) p.stance = opts.stance;
    if (opts.scope !== undefined) p.scopeT = opts.scope;
    p.frozenScope = opts.scope !== undefined;
    if (opts.eye !== undefined) p.eye = opts.eye;
  }

  // Test helper: near (x,z), find a spot whose view along yaw/pitch is clear for the longest distance.
  findOpenView(x, z, yaw, pitch = 0, radius = 25) {
    let best = null, bestD = -1;
    const dir = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    for (let k = 0; k < 120; k++) {
      const px = x + (Math.random() - 0.5) * radius * 2, pz = z + (Math.random() - 0.5) * radius * 2;
      if (this.terrain.waterDepthAt(px, pz) > 0 || !this.terrain.inPlayArea(px, pz, 2)) continue;
      const e = new THREE.Vector3(px, this.terrain.heightAt(px, pz) + 1.62, pz);
      const hit = this.world.raycast(e, dir, 400, { bushes: true });
      const d = hit ? hit.t : 400;
      if (d > bestD) { bestD = d; best = { x: px, z: pz }; }
    }
    if (best) this.setView(best.x, best.z, yaw, pitch);
    return bestD;
  }

  debugText() {
    const r = this.renderer.info.render;
    const p = this.player;
    const lines = [
      `pos ${p.pos.x.toFixed(1)} ${p.pos.y.toFixed(1)} ${p.pos.z.toFixed(1)}  fov ${p.fov.toFixed(1)}  stance ${p.stance}`,
      `draw calls ${r.calls}  tris ${(r.triangles / 1000).toFixed(0)}k  time ${this.time.toFixed(1)}`,
      `zone ${this.zone ? this.zone.debugText() : '-'}`,
      '',
      'AI:',
    ];
    for (const a of this.ais) {
      const aw = [...a.ai.awareness.entries()].filter(([, v]) => v > 0.05).map(([id, v]) => `${this.nameOf(id)}=${v.toFixed(2)}`).join(' ');
      lines.push(` ${a.name.padEnd(8)} ${a.alive ? a.ai.state.padEnd(11) : 'DEAD       '} ${a.stance.padEnd(6)} ${a.scoped ? 'SCOPED' : '      '} ${a.ai.target ? '-> ' + a.ai.target.name : ''} ${aw}`);
    }
    lines.push('', 'Reveal events (last 12 s):');
    const now = this.time;
    for (const ev of this.bus.recent(now, 12).slice(-12).reverse()) {
      if (ev.type === 'footstep') continue;
      lines.push(` ${(now - ev.time).toFixed(1).padStart(5)}s ago  ${ev.type.padEnd(8)} by ${this.nameOf(ev.sourceId)}${ev.targetId ? ' at ' + this.nameOf(ev.targetId) : ''}  (${ev.position.x.toFixed(0)}, ${ev.position.z.toFixed(0)})`);
    }
    return lines.join('\n');
  }

  nameOf(id) {
    const c = this.combatants.find((x) => x.id === id);
    return c ? c.name : (id === -1 ? 'birds' : String(id));
  }
}

const game = new Game();
game.init().catch((e) => {
  console.error(e);
  const l = document.getElementById('loading-s');
  if (l) l.textContent = 'ERROR: ' + e.message;
});
