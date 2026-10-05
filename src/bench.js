// Benchmark (?bench): flies the camera through fixed, typical views for a few seconds each
// and reports average FPS, 1% lows and frame times per scene, plus the GPU and settings.
// Simulation is paused and auto resolution is off, so runs on different PCs compare.
import * as THREE from 'three';
import { CONFIG } from './config.js';

const SCENE_TIME = 6;   // seconds per scene (the first second is warm-up, not measured)

export class Benchmark {
  constructor(game) {
    this.game = game;
    this.autoRes = CONFIG.render.autoResolution;
    CONFIG.render.autoResolution = false;
    game.dynScale = 1;
    game.resize();
    const g = game;
    const T = g.terrain;
    // a forest spot with open sky toward the sun (light shafts through crowns)
    let sun = { x: 0, z: 90 };
    let best = -1;
    for (let x = -140; x <= 140; x += 6) {
      for (let z = 40; z <= 140; z += 6) {
        if (T.waterDepthAt(x, z) > 0 || g.world.query(x, z, 6, ['tree']).length) continue;
        const n = g.world.query(x, z, 30, ['tree']).length;
        if (n > best) { best = n; sun = { x, z }; }
      }
    }
    const rock = g.rocks.items.find((r) => r.s > 1.6 && Math.abs(r.x) < 150 && Math.abs(r.z) < 150) || { x: 0, z: 10 };
    this.scenes = [
      { name: 'Valley vista', x: -59.6, z: 119.5, yaw: 0, pitch: -0.08, pan: 0.5 },
      { name: 'Scoped across the valley', x: -59.6, z: 119.5, yaw: 0.05, pitch: -0.11, pan: 0.06, scope: 1, stance: 'prone' },
      { name: 'Forest toward the sun', x: sun.x, z: sun.z, yaw: 0.977, pitch: 0.1, pan: 0.4 },
      { name: 'Walking through the forest', x: sun.x - 20, z: sun.z, yaw: -Math.PI / 2, pitch: -0.12, walk: 3 },
      { name: 'River bank', x: rock.x + Math.cos(0.7) * 4.5, z: rock.z + Math.sin(0.7) * 4.5, yaw: Math.atan2(Math.cos(0.7), Math.sin(0.7)), pitch: -0.2, pan: 0.6 },
    ];
    this.i = -1;
    this.results = [];
    this.renderer = this._gpuName();
    g.ais.forEach((a) => { a.frozen = true; });
    g.hud.centerMessage('BENCHMARK', 'MEASURING FRAME RATES · DON\'T TOUCH THE MOUSE', 2.5);
    this._next();
  }

  _gpuName() {
    try {
      const gl = this.game.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch { return 'unknown'; }
  }

  _next() {
    this.i++;
    this.t = 0;
    this.frames = [];
    if (this.i >= this.scenes.length) { this._finish(); return; }
    const s = this.scenes[this.i];
    this.game.setView(s.x, s.z, s.yaw, s.pitch, { stance: s.stance || 'stand', scope: s.scope ?? 0 });
  }

  // Called every frame with the real frame time (seconds). Returns true while running.
  update(dt) {
    if (this.done) return false;
    const s = this.scenes[this.i];
    const g = this.game;
    this.t += dt;
    if (this.t > 1) this.frames.push(dt * 1000);
    const p = g.player;
    if (s.pan) p.lookYaw = s.yaw + Math.sin(this.t * 0.6) * s.pan;
    if (s.walk) {
      const d = s.walk * this.t;
      const q = { x: s.x + Math.cos(s.yaw + Math.PI / 2) * d, z: s.z - Math.sin(s.yaw + Math.PI / 2) * d };
      p.pos.set(q.x, g.terrain.heightAt(q.x, q.z), q.z);
    }
    if (this.t >= SCENE_TIME) {
      const f = this.frames.slice().sort((a, b) => a - b);
      const avg = f.reduce((a, b) => a + b, 0) / Math.max(1, f.length);
      const p99 = f[Math.min(f.length - 1, Math.floor(f.length * 0.99))] || avg;
      this.results.push({ scene: s.name, fps: 1000 / avg, low1: 1000 / p99, ms: avg });
      this._next();
    }
    return true;
  }

  _finish() {
    this.done = true;
    CONFIG.render.autoResolution = this.autoRes;
    const g = this.game;
    const R = CONFIG.render;
    const size = g.renderer.getDrawingBufferSize(new THREE.Vector2());
    const all = this.results.reduce((a, r) => a + r.ms, 0) / this.results.length;
    const summary = {
      gpu: this.renderer,
      resolution: `${size.x}x${size.y}`,
      settings: `scale ${R.renderScale}, shadows ${R.shadowQuality}, AO ${R.ao ? 'on' : 'off'}, bloom ${R.bloom ? 'on' : 'off'}, shafts ${R.sunShafts ? 'on' : 'off'}, reflections ${R.reflections ? 'on' : 'off'}, MSAA ${R.msaa}x, grass ${R.grassDensity}`,
      averageFps: +(1000 / all).toFixed(1),
      scenes: this.results.map((r) => ({ scene: r.scene, fps: +r.fps.toFixed(1), low1: +r.low1.toFixed(1), ms: +r.ms.toFixed(2) })),
    };
    console.log('[bench]', JSON.stringify(summary));
    window.__benchResult = summary;
    const text = [
      `SniperYard benchmark`,
      `GPU: ${summary.gpu}`,
      `Resolution: ${summary.resolution}`,
      `Settings: ${summary.settings}`,
      `Average: ${summary.averageFps} FPS`,
      ...summary.scenes.map((r) => `  ${r.scene}: ${r.fps} FPS avg, ${r.low1} FPS 1% low (${r.ms} ms)`),
    ].join('\n');
    const el = document.createElement('div');
    el.className = 'overlay on';
    el.id = 'benchresult';
    el.innerHTML = `<div class="panel"><h1>BENCH<span>MARK</span></h1>
      <div class="sub">${summary.averageFps} FPS AVERAGE · ${summary.resolution}</div>
      <div class="stats" style="max-width:600px">${summary.scenes.map((r) => `<span>${r.scene}</span><span>${r.fps} FPS · 1% low ${r.low1}</span>`).join('')}</div>
      <div class="note">GPU: ${summary.gpu}<br>${summary.settings}</div>
      <div class="btnrow"><button class="primary" id="bench-copy">COPY RESULTS</button><button id="bench-close">CLOSE</button></div></div>`;
    document.body.appendChild(el);
    el.querySelector('#bench-copy').addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(() => { el.querySelector('#bench-copy').textContent = 'COPIED'; }, () => {});
    });
    el.querySelector('#bench-close').addEventListener('click', () => { location.href = location.pathname; });
  }
}
