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

    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(55, camera.aspect, 0.01, 10);
    this.post = new PostFX(renderer, scene, camera, this.vmScene, this.vmCamera);

    this.input = new Input(renderer.domElement);
    this.player = new Player(camera);

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
    const sp = this.findSpawn(0, 0);
    const yaw = Math.atan2(0, 1); // face south (+Z is south of the north slope? we look toward -side)
    this.player.spawn(sp.x, sp.z, 0);
    // face across the valley (toward -Z from the north slope)
    this.player.lookYaw = 0;
    this.player.pos.y = this.terrain.heightAt(sp.x, sp.z);
    this.time = 0;
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
    this.render(dtReal);
    input.endFrame();
  }

  // Advance gameplay by dt seconds (dt = 0 keeps the camera alive while paused).
  simulate(dt, input) {
    if (dt > 0) this.time += dt;
    SHARED.uTime.value = this.realTime;
    this.player.update(dt, input, this.world, this.terrain, this.time);
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
    this.hud.update(dtReal, {
      alive: this.player.alive, scoped: this.player.scoped, health: this.player.health, stance: this.player.stance,
      inWater: this.player.inWater > 0.05, boltT: 1, glint: this.player.scoped, aimedAt: false,
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
    cam.updateMatrixWorld();
    const p = this.player;
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
    return [
      `pos ${p.pos.x.toFixed(1)} ${p.pos.y.toFixed(1)} ${p.pos.z.toFixed(1)}  fov ${p.fov.toFixed(1)}`,
      `draw calls ${r.calls}  tris ${(r.triangles / 1000).toFixed(0)}k`,
      `time ${this.time.toFixed(1)}`,
    ].join('\n');
  }
}

const game = new Game();
game.init().catch((e) => {
  console.error(e);
  const l = document.getElementById('loading-s');
  if (l) l.textContent = 'ERROR: ' + e.message;
});
