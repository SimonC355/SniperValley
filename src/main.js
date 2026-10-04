// SniperYard prototype: main loop and game state machine.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { installHeightFog, SHARED } from './shaders.js';
import { createTextures } from './textures.js';
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
import { AICombatant, SpotMap, glintToward } from './ai.js';
import { Birds } from './birds.js';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

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

    const scene = new THREE.Scene();
    this.scene = scene;
    const camera = new THREE.PerspectiveCamera(CONFIG.player.fovHip, window.innerWidth / window.innerHeight, 0.12, CONFIG.render.farClip);
    camera.rotation.order = 'YXZ';
    this.camera = camera;
    scene.add(camera);

    this.hud.setLoading('BAKING TEXTURES');
    await nextFrame();
    this.textures = createTextures(renderer, CONFIG.seed);

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
    this.grass = new Grass(scene, terrain, this.textures);

    this.hud.setLoading('FILLING THE RIVER');
    await nextFrame();
    this.water = new Water(scene, terrain, this.textures, renderer);
    // Reflections skip grass, undergrowth and full-detail trees (the far bank dominates the mirror image).
    this.water.hideDuringReflection.push(this.grass.group, this.undergrowth.group);
    for (const name in this.forest.buckets) this.water.hideDuringReflection.push(...this.forest.buckets[name].l0.meshes);
    this.world = new World(terrain, this.forest, this.rocks, this.undergrowth);
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
    this.combat = new Combat({ world: this.world, terrain, effects: this.effects, audio: this.audio, bus: this.bus });
    this.combat.listener = this.player;
    this.combat.onKill = (shooter, victim, dist, part) => this.onKill(shooter, victim, dist, part);
    this.viewmodel = new Viewmodel(this.vmScene, this.vmCamera, this.textures, scene.environment);
    this.player.onFootstep = (pos, loud) => {
      this.audio.footstep(pos, loud, this.terrain.canopyAt(pos.x, pos.z) > 0.5 ? 'forest' : 'grass', true);
      this.bus.emit({ type: 'footstep', position: pos.clone(), time: this.time, sourceTeam: 0, sourceId: this.player.id, loudness: loud });
    };
    this.player.onSplash = (pos, loud) => {
      this.audio.splash(pos, loud, true);
      this.effects.impact(pos.clone().add(new THREE.Vector3(0, 0.05, 0)), 'water');
      this.bus.emit({ type: 'splash', position: pos.clone(), time: this.time, sourceTeam: 0, sourceId: this.player.id, loudness: loud });
    };
    this.dummies = [];
    this.ais = [];
    this.combatants = [this.player];
    this.bus.on((ev) => { for (const a of this.ais) a.ai.onEvent(ev); });
    // birds: flushed by shots, nearby impacts, and proximity (see Birds.checkProximity)
    this.birds = new Birds(scene, this.forest, terrain, this.audio, CONFIG.seed);
    this.birds.onFlush = (f, time, team, id, cause) => {
      this.bus.emit({ type: 'birds', position: f.center.clone().add(new THREE.Vector3(0, 1, 0)), time, sourceTeam: team, sourceId: id, cause, flockId: f.id });
    };
    this.bus.on((ev) => {
      if (ev.type === 'shot') this.birds.onShot(ev.position, ev.time, ev.sourceTeam, ev.sourceId);
      else if (ev.type === 'impact') this.birds.onImpact(ev.position, ev.time, ev.sourceTeam, ev.sourceId);
    });
    this.params = new URLSearchParams(location.search);

    this.hud.bindSettings((kind) => this.onSettingsChanged(kind));
    this.bindUI();
    window.addEventListener('resize', () => this.resize());
    this.resize();

    this.newRound();
    this.state = 'menu';
    this.hud.setLoading('WARMING UP SHADERS');
    await nextFrame();
    renderer.compile(scene, camera);
    this.hud.setLoading(null);
    if (new URLSearchParams(location.search).has('autostart')) {
      this.state = 'playing';
      this.input.fallback = true;
    } else {
      this.hud.showStart(true);
    }
    this.lastNow = performance.now();
    this.frameCount = 0;
    renderer.setAnimationLoop(() => this.frame());
    window.__game = this;
    window.THREE = THREE;
    this.config = CONFIG;
    console.log(`[SniperYard] trees: ${this.forest.trees.length} (play area ${this.forest.playCount}), bushes: ${this.undergrowth.items.length}, rocks: ${this.rocks.items.length}`);
  }

  pixelRatio() {
    return Math.min(window.devicePixelRatio || 1, CONFIG.render.maxPixelRatio) * CONFIG.render.renderScale;
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

  onSettingsChanged(kind) {
    if (['scale', 'refl'].includes(kind)) this.resize();
    if (kind === 'shadow') this.sky.applyShadowQuality(CONFIG.render.shadowQuality);
    if (['msaa', 'grass'].includes(kind)) this.hud.centerMessage('RELOAD TO APPLY', '', 2);
  }

  bindUI() {
    const start = () => {
      this.audio.init();
      this.hud.showStart(false);
      this.hud.showPause(false);
      this.state = this.state === 'menu' ? 'playing' : this.state;
      this.paused = false;
      this.input.requestLock();
    };
    document.getElementById('btn-play').addEventListener('click', () => { this.newRound(); start(); });
    document.getElementById('btn-resume').addEventListener('click', start);
    document.getElementById('btn-restart').addEventListener('click', () => { this.newRound(); start(); });
    document.getElementById('btn-again').addEventListener('click', () => { this.newRound(); start(); });
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
  }

  findSpawn(team, index) {
    const T = this.terrain;
    const side = team === 0 ? 1 : -1;
    const baseX = -60 + index * 32 + (team === 0 ? 0 : 20);
    for (let k = 0; k < 200; k++) {
      const x = baseX + (Math.random() - 0.5) * 30;
      const z = T.riverCenter(x) + side * (95 + Math.random() * 50);
      if (T.waterDepthAt(x, z) > 0) continue;
      const near = this.world.query(x, z, 2.5, ['tree', 'rock']);
      if (near.length) continue;
      return { x, z };
    }
    return { x: baseX, z: side * 120 };
  }

  newRound() {
    this.time = 0;
    this.bus.clear();
    this.combat.projectiles.length = 0;
    this.hud.clearKillFeed();
    this.hud.showEnd(false);
    this.roundOver = false;
    this.deathT = 0;
    this.birds.reset(0);
    // teams: ALPHA = player + AI mates on the north (+Z) slope, BRAVO = AI on the south slope
    for (const a of this.ais) a.dispose();
    this.ais = [];
    const n = CONFIG.teams.size;
    const spawnsA = this.teamSpawns(0, n), spawnsB = this.teamSpawns(1, n);
    this.player.spawn(spawnsA[0].x, spawnsA[0].z, 0);
    this.player.pos.y = this.terrain.heightAt(spawnsA[0].x, spawnsA[0].z);
    let idx = 0;
    for (let i = 1; i < n; i++) {
      const a = new AICombatant(this, { name: `${CONFIG.teams.names[0]}-${i + 1}`, team: 0, index: idx++, armband: true });
      a.spawn(spawnsA[i].x, spawnsA[i].z, 0);
      this.ais.push(a);
    }
    for (let i = 0; i < n; i++) {
      const a = new AICombatant(this, { name: `${CONFIG.teams.names[1]}-${i + 1}`, team: 1, index: idx++, armband: false });
      a.spawn(spawnsB[i].x, spawnsB[i].z, Math.PI);
      this.ais.push(a);
    }
    this.spawnDummies();
    this.combatants = [this.player, ...this.ais, ...this.dummies];
    this.combat.setCombatants(this.combatants);
    this.envTintT = 0;
  }

  // Spread a team along its slope (upper half, near the ridge).
  teamSpawns(team, n) {
    const T = this.terrain;
    const side = team === 0 ? 1 : -1;
    const out = [];
    const span = Math.min(170, 60 * n);
    const off = (Math.random() - 0.5) * 60;
    for (let i = 0; i < n; i++) {
      const bx = off + (n === 1 ? 0 : -span / 2 + (span * i) / (n - 1));
      let best = null;
      for (let k = 0; k < 60 && !best; k++) {
        const x = bx + (Math.random() - 0.5) * 20;
        const z = T.riverCenter(x) + side * (105 + Math.random() * 45);
        if (Math.abs(z) > T.halfZ - 6 || T.waterDepthAt(x, z) > 0) continue;
        if (this.world.query(x, z, 1.5, ['tree', 'rock']).length) continue;
        best = { x, z };
      }
      out.push(best || { x: bx, z: T.riverCenter(bx) + side * 120 });
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
      let x = px + dx, z = T.riverCenter(px + dx) - 20 - dz;
      const q = { x, z };
      for (let k = 0; k < 3; k++) this.world.collideCircle(q, 1.2);
      this.dummies.push(new TargetDummy(this.scene, `TARGET ${i + 1}`, q.x, q.z, T, stance, Math.PI));
    });
  }

  onKill(shooter, victim, dist, part) {
    const d = Math.round(dist);
    if (shooter.isPlayer) {
      this.hud.hitMarker(true);
      const ff = victim.team === shooter.team;
      this.hud.centerMessage(ff ? 'FRIENDLY FIRE' : `${part === 'head' ? 'HEADSHOT' : 'ELIMINATED'} · ${d} m`, victim.name, 1.8);
    }
    if (victim.isPlayer) {
      this.hud.centerMessage('YOU WERE HIT', `${shooter.name} · ${d} m`, 3);
      this.player.killedBy = shooter;
    }
    this.hud.killFeed(`<span class="${shooter.team === 0 ? 'f' : 'e'}">${shooter.name}</span> ✕ <span class="${victim.team === 0 ? 'f' : 'e'}">${victim.name}</span> · ${d} m${part === 'head' ? ' · HEAD' : ''}`);
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
    const dtReal = Math.min(0.05, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    this.frameCount++;
    this.realTime += dtReal;
    const input = this.input;
    if (input.wasPressed('F1')) this.debug = !this.debug;
    if (input.wasPressed('F2') && CONFIG.debug.allowReveal) this.reveal = !this.reveal;
    if (input.wasPressed('KeyR') && (this.state === 'playing' || this.state === 'ended')) {
      this.hud.showEnd(false);
      this.newRound();
      this.state = 'playing';
      if (!input.locked && !input.fallback) input.requestLock();
    }
    const running = this.state === 'playing' && !this.paused;
    this.simulate(running ? dtReal : 0, running ? input : this.idleInput());
    if (this.state === 'playing' && this.roundOver && this.time >= this.endAt) this.showRoundEnd();
    this.effects.update(dtReal, this.camera);
    this.render(dtReal);
    input.endFrame();
  }

  // Advance gameplay by dt seconds (dt = 0 keeps the camera alive while paused).
  simulate(dt, input) {
    if (dt > 0) this.time += dt;
    SHARED.uTime.value = this.realTime;
    const p = this.player;
    p.update(dt, input, this.world, this.terrain, this.time);
    p.bodyYaw = p.yaw;
    p.hitbox.update(p);
    if (dt > 0 && p.alive && input.wasClicked && input.wasClicked(0)) this.playerFire();
    if (dt > 0) {
      for (const a of this.ais) a.update(dt, this.time);
      this.combat.update(dt, this.time);
      this.birds.update(dt, this.time, this.combatants, this.camera);
      this.updateCharacterTints(dt);
      this.checkRoundEnd();
    }
    for (const d of this.dummies) d.update(dt);
    if (!p.alive) this.deathT += dt;
  }

  showRoundEnd() {
    this.state = 'ended';
    const p = this.player;
    const acc = p.shotsFired ? Math.round((p.hits / p.shotsFired) * 100) : 0;
    const t = Math.floor(this.time);
    const sub = this.victory ? (p.alive ? 'YOUR TEAM WINS' : 'YOUR TEAM WINS · YOU DID NOT SURVIVE') : 'YOUR TEAM WAS ELIMINATED';
    this.hud.showEnd(true, this.victory, sub, [
      ['Round time', `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`],
      ['Shots fired', p.shotsFired],
      ['Hits', `${p.hits} (${acc}%)`],
      ['Eliminations', p.kills],
      ['Longest hit', p.longestHit ? `${Math.round(p.longestHit)} m` : '-'],
      ['Killed by', p.alive ? '-' : (p.killedBy ? p.killedBy.name : 'the zone')],
    ]);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // Camouflage: suits blend toward the local ground colour (scaled by camouflageStrength).
  updateCharacterTints(dt) {
    this.envTintT -= dt;
    if (this.envTintT > 0) return;
    this.envTintT = 1;
    const c = new THREE.Color();
    for (const a of this.ais) {
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
    this.endAt = this.time + 2.5;
    this.victory = b === 0 && a > 0;
  }

  // Is any enemy currently lining up a shot on the player (glint toward us + line of sight)?
  playerAimedAt() {
    const p = this.player;
    if (!p.alive) return false;
    const eye = p.eyePos(new THREE.Vector3());
    for (const a of this.ais) {
      if (a.team === p.team || !a.alive || !a.ai) continue;
      if ((a.ai.state === 'aim' || a.ai.state === 'fire') && a.ai.target === p && glintToward(a, eye) > 0.1) {
        if (this.world.lineOfSight(a.scopePos(new THREE.Vector3()), eye)) return true;
      }
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
    for (const a of this.ais) {
      const gi = glintToward(a, this.camera.position);
      if (gi > 0.001) a.glint.set(a.scopePos(new THREE.Vector3()), gi, this.camera, this.realTime); else a.glint.hide();
    }
    this.aimedAtT = (this.aimedAtT || 0) - dtReal;
    if (this.aimedAtT <= 0) { this.aimedAtT = 0.15; this.aimedAt = this.playerAimedAt(); }
    const w = window.innerWidth, h = window.innerHeight;
    this.hud.updateMarkers(this.camera, this.ais.filter((a) => a.team === p.team), w, h);
    this.hud.updateDebugMarks(this.camera, this.ais, w, h, this.reveal);
    this.hud.setTeams(this.combatants.filter((c) => c.team === 0 && !c.isDummy), this.combatants.filter((c) => c.team === 1 && !c.isDummy));
    this.hud.update(dtReal, {
      alive: this.player.alive, scoped: this.player.scoped, health: this.player.health, stance: this.player.stance,
      inWater: this.player.inWater > 0.05, boltT, glint: this.player.scoped && this.player.alive, aimedAt: this.aimedAt,
      outside: false, holdingBreath: this.player.holdingBreath, breathCooldown: this.player.breathCooldown > 0, yaw: this.player.yaw,
    });
    if (this.debug) this.hud.setDebug(this.debugText(), true); else this.hud.setDebug('', false);
  }

  idleInput() {
    if (!this._idle) this._idle = { mouseDX: 0, mouseDY: 0, down: () => false, wasPressed: () => false, mouse: () => false };
    return this._idle;
  }

  updateRenderSystems(dt) {
    const cam = this.camera;
    const p = this.player;
    if (!p.alive) {
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
    if (p.scopeT > 0.5) {
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
    this.grass.update(p.scopeT > 0.5 ? focus : cam.position);
    this.water.update(this.realTime);
    SHARED.uSunDirView.value.copy(this.sky.sunDir).transformDirection(cam.matrixWorldInverse);
    // is the player standing in shade? (dims the first-person rifle)
    this.shadeTimer = (this.shadeTimer || 0) - dt;
    if (this.shadeTimer <= 0) {
      this.shadeTimer = 0.25;
      this.inShade = !!this.world.raycast(p.eyePos(new THREE.Vector3()), this.sky.sunDir, 200, { terrain: true });
    }
    this.viewmodel.update(dt, this.time, p, SHARED.uSunDirView.value, this.inShade);
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
