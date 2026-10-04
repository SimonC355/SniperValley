// Synthesised WebAudio: distance-delayed gunshots with valley echo (convolver), bolt cycling,
// supersonic near-miss cracks, impacts, footsteps, water splashes, crow caws, wind and river.
// No audio files are used.
import * as THREE from 'three';
import { CONFIG } from './config.js';

export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.listenerPos = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
  }

  // Must be called from a user gesture.
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = CONFIG.audio.master;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.25;
    this.master.connect(comp).connect(ctx.destination);
    // valley echo
    this.echo = ctx.createConvolver();
    this.echo.buffer = this._valleyIR();
    this.echoGain = ctx.createGain();
    this.echoGain.gain.value = CONFIG.audio.echo ? 0.55 : 0;
    this.echo.connect(this.echoGain).connect(this.master);
    this.noise = this._noiseBuffer(2);
    this.brown = this._brownBuffer(4);
    this._startAmbience();
    this.ready = true;
  }

  _noiseBuffer(sec) {
    const ctx = this.ctx;
    const b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  _brownBuffer(sec) {
    const ctx = this.ctx;
    const b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    return b;
  }

  // Impulse response: diffuse decay plus discrete slope reflections.
  _valleyIR() {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 3.2);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / ctx.sampleRate;
        d[i] = (Math.random() * 2 - 1) * Math.exp(-t * 1.6) * 0.18 * Math.min(1, t * 30);
      }
      // reflections from the slopes and valley ends
      for (const [t0, a] of [[0.28, 0.7], [0.52, 0.55], [0.95, 0.4], [1.45, 0.28], [2.1, 0.16]]) {
        const s0 = Math.floor((t0 + ch * 0.013) * ctx.sampleRate);
        for (let k = 0; k < 2400 && s0 + k < len; k++) d[s0 + k] += (Math.random() * 2 - 1) * a * Math.exp(-k / 500);
      }
    }
    return b;
  }

  updateListener(camera) {
    if (!this.ready) return;
    const L = this.ctx.listener;
    const p = camera.position;
    this.listenerPos.copy(p);
    const f = this._fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const u = this._up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const t = this.ctx.currentTime;
    if (L.positionX) {
      L.positionX.setTargetAtTime(p.x, t, 0.02); L.positionY.setTargetAtTime(p.y, t, 0.02); L.positionZ.setTargetAtTime(p.z, t, 0.02);
      L.forwardX.setTargetAtTime(f.x, t, 0.02); L.forwardY.setTargetAtTime(f.y, t, 0.02); L.forwardZ.setTargetAtTime(f.z, t, 0.02);
      L.upX.setTargetAtTime(u.x, t, 0.02); L.upY.setTargetAtTime(u.y, t, 0.02); L.upZ.setTargetAtTime(u.z, t, 0.02);
    } else {
      L.setPosition(p.x, p.y, p.z);
      L.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
    this._updateAmbience();
  }

  _panner(pos) {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 1e6; // distance attenuation is handled manually
    p.rolloffFactor = 0;
    if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } else p.setPosition(pos.x, pos.y, pos.z);
    return p;
  }

  _noiseSrc(t, dur) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.05);
    return s;
  }

  _env(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  // ------------------------------------------------------------------ gunshot
  shot(pos, own = false) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const d = own ? 0 : this.listenerPos.distanceTo(pos);
    const delay = d / CONFIG.reveal.soundSpeed;
    const t = ctx.currentTime + delay;
    const vol = own ? 1.0 : Math.min(1, 28 / (d + 10));
    const out = ctx.createGain();
    out.gain.value = vol;
    if (own) out.connect(this.master);
    else out.connect(this._panner(pos)).connect(this.master);
    // send to echo (relatively stronger for distant shots)
    const send = ctx.createGain();
    send.gain.value = own ? 0.5 : Math.min(1.2, 0.35 + d / 400);
    out.connect(send).connect(this.echo);
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = own ? 14000 : Math.max(900, 12000 / (1 + d / 120));
    air.connect(out);
    // crack
    const crack = this._noiseSrc(t, 0.06);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
    const cg = ctx.createGain();
    this._env(cg, t, own ? 1.2 : 0.7, 0.001, 0.05);
    crack.connect(hp).connect(cg).connect(air);
    // boom
    const boom = this._noiseSrc(t, 0.6);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(1600, t); lp.frequency.exponentialRampToValueAtTime(220, t + 0.4);
    const bg = ctx.createGain();
    this._env(bg, t, own ? 1.4 : 1.0, 0.004, 0.5);
    boom.connect(lp).connect(bg).connect(air);
    // thump
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(130, t); osc.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    const og = ctx.createGain();
    this._env(og, t, own ? 1.0 : 0.6, 0.002, 0.28);
    osc.connect(og).connect(air);
    osc.start(t); osc.stop(t + 0.35);
  }

  // Supersonic crack of a bullet passing close to the listener.
  crack(pos) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = this._noiseSrc(t, 0.03);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2500;
    const g = ctx.createGain();
    this._env(g, t, 1.3, 0.0005, 0.02);
    s.connect(hp).connect(g).connect(this._panner(pos)).connect(this.master);
    // whizz
    const w = this._noiseSrc(t, 0.25);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 6; bp.frequency.setValueAtTime(3500, t); bp.frequency.exponentialRampToValueAtTime(900, t + 0.2);
    const wg = ctx.createGain();
    this._env(wg, t, 0.25, 0.01, 0.2);
    w.connect(bp).connect(wg).connect(this.master);
  }

  bolt(startDelay = 0.25) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + startDelay;
    const clicks = [[0.0, 3200, 0.5], [0.22, 2200, 0.6], [0.55, 2600, 0.55], [0.74, 3600, 0.45]];
    for (const [dt, f, a] of clicks) {
      const t = t0 + dt;
      const s = this._noiseSrc(t, 0.05);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 7;
      const g = ctx.createGain();
      this._env(g, t, a, 0.001, 0.045);
      s.connect(bp).connect(g).connect(this.master);
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f * 1.3;
      const og = ctx.createGain();
      this._env(og, t, a * 0.15, 0.001, 0.05);
      o.connect(og).connect(this.master); o.start(t); o.stop(t + 0.08);
    }
  }

  impact(pos, kind) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const d = this.listenerPos.distanceTo(pos);
    if (d > 350) return;
    const t = ctx.currentTime + d / CONFIG.reveal.soundSpeed;
    const vol = Math.min(0.9, 9 / (d + 4));
    const s = this._noiseSrc(t, 0.3);
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    if (kind === 'water') {
      f.type = 'bandpass'; f.Q.value = 2; f.frequency.setValueAtTime(2200, t); f.frequency.exponentialRampToValueAtTime(500, t + 0.25);
      this._env(g, t, vol, 0.005, 0.25);
    } else if (kind === 'tree') {
      f.type = 'bandpass'; f.Q.value = 3; f.frequency.value = 520;
      this._env(g, t, vol * 1.2, 0.001, 0.09);
    } else if (kind === 'rock') {
      f.type = 'highpass'; f.frequency.value = 1500;
      this._env(g, t, vol, 0.001, 0.06);
    } else {
      f.type = 'lowpass'; f.frequency.value = 900;
      this._env(g, t, vol, 0.002, 0.08);
    }
    s.connect(f).connect(g).connect(this._panner(pos)).connect(this.master);
  }

  footstep(pos, loud, surface, own) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const d = own ? 0 : this.listenerPos.distanceTo(pos);
    if (d > CONFIG.reveal.footstepHearingRange) return;
    const t = ctx.currentTime;
    const vol = (own ? 0.12 : 0.35 / (1 + d / 4)) * loud;
    const s = this._noiseSrc(t, 0.12);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = surface === 'forest' ? 1400 : 700 + Math.random() * 300; f.Q.value = 0.8;
    const g = ctx.createGain();
    this._env(g, t, vol, 0.01, 0.09);
    s.connect(f).connect(g);
    if (own) g.connect(this.master); else g.connect(this._panner(pos)).connect(this.master);
  }

  splash(pos, loud, own) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const d = own ? 0 : this.listenerPos.distanceTo(pos);
    if (d > CONFIG.reveal.splashHearingRange) return;
    const t = ctx.currentTime + d / CONFIG.reveal.soundSpeed;
    const vol = (own ? 0.35 : 0.8 / (1 + d / 8)) * (0.5 + loud);
    for (let i = 0; i < 2; i++) {
      const tt = t + i * 0.07;
      const s = this._noiseSrc(tt, 0.3);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.Q.value = 1.5; f.frequency.setValueAtTime(1800 - i * 500, tt); f.frequency.exponentialRampToValueAtTime(400, tt + 0.25);
      const g = ctx.createGain();
      this._env(g, tt, vol * (1 - i * 0.4), 0.01, 0.25);
      s.connect(f).connect(g);
      if (own) g.connect(this.master); else g.connect(this._panner(pos)).connect(this.master);
    }
  }

  // A single crow caw, distance-delayed and spatialised.
  caw(pos, pitch = 1) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const d = this.listenerPos.distanceTo(pos);
    if (d > 450) return;
    const t = ctx.currentTime + d / CONFIG.reveal.soundSpeed;
    const vol = Math.min(0.5, 14 / (d + 12));
    const out = ctx.createGain(); out.gain.value = vol;
    const air = ctx.createBiquadFilter(); air.type = 'lowpass'; air.frequency.value = Math.max(1200, 9000 / (1 + d / 150));
    out.connect(air).connect(this._panner(pos)).connect(this.master);
    const reps = 1 + Math.floor(Math.random() * 3);
    for (let r = 0; r < reps; r++) {
      const tt = t + r * (0.32 + Math.random() * 0.1);
      const dur = 0.22 + Math.random() * 0.08;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const f0 = (420 + Math.random() * 80) * pitch;
      o.frequency.setValueAtTime(f0 * 1.15, tt);
      o.frequency.linearRampToValueAtTime(f0, tt + dur * 0.4);
      o.frequency.linearRampToValueAtTime(f0 * 0.82, tt + dur);
      const formant = ctx.createBiquadFilter(); formant.type = 'bandpass'; formant.frequency.value = 1300 * pitch; formant.Q.value = 3;
      const formant2 = ctx.createBiquadFilter(); formant2.type = 'bandpass'; formant2.frequency.value = 2400 * pitch; formant2.Q.value = 5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime(0.9, tt + 0.02);
      g.gain.setValueAtTime(0.9, tt + dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + dur);
      // rasp: noise amplitude modulation
      const n = this._noiseSrc(tt, dur);
      const ng = ctx.createGain(); ng.gain.value = 0.35;
      n.connect(ng).connect(formant);
      o.connect(formant); o.connect(formant2);
      formant.connect(g); formant2.connect(g);
      g.connect(out);
      o.start(tt); o.stop(tt + dur + 0.02);
    }
  }

  // wing flutter when a flock takes off
  flutter(pos) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const d = this.listenerPos.distanceTo(pos);
    if (d > 120) return;
    const t = ctx.currentTime + d / CONFIG.reveal.soundSpeed;
    const s = this._noiseSrc(t, 1.2);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 0.7;
    const g = ctx.createGain();
    const vol = Math.min(0.5, 6 / (d + 6));
    g.gain.setValueAtTime(0.0001, t);
    for (let i = 0; i < 12; i++) g.gain.setValueAtTime(i % 2 ? vol * 0.3 : vol, t + i * 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    s.connect(f).connect(g).connect(this._panner(pos)).connect(this.master);
  }

  beep(freq = 880, dur = 0.08, vol = 0.12) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
    const g = ctx.createGain();
    this._env(g, t, vol, 0.005, dur);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }

  // ------------------------------------------------------------------ ambience
  _startAmbience() {
    const ctx = this.ctx;
    // wind
    const w = ctx.createBufferSource(); w.buffer = this.brown; w.loop = true;
    const wf = ctx.createBiquadFilter(); wf.type = 'lowpass'; wf.frequency.value = 500;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0.08;
    w.connect(wf).connect(this.windGain).connect(this.master);
    w.start();
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lg = ctx.createGain(); lg.gain.value = 0.05;
    lfo.connect(lg).connect(this.windGain.gain); lfo.start();
    // river: positioned at the nearest point on the river
    const r = ctx.createBufferSource(); r.buffer = this.noise; r.loop = true;
    const rf = ctx.createBiquadFilter(); rf.type = 'bandpass'; rf.frequency.value = 900; rf.Q.value = 0.5;
    const rf2 = ctx.createBiquadFilter(); rf2.type = 'lowpass'; rf2.frequency.value = 2500;
    this.riverGain = ctx.createGain(); this.riverGain.gain.value = 0;
    this.riverPanner = this._panner(new THREE.Vector3());
    r.connect(rf).connect(rf2).connect(this.riverGain).connect(this.riverPanner).connect(this.master);
    r.start();
  }

  setRiverSource(pos, dist) {
    if (!this.ready) return;
    const p = this.riverPanner;
    const t = this.ctx.currentTime;
    if (p.positionX) { p.positionX.setTargetAtTime(pos.x, t, 0.1); p.positionY.setTargetAtTime(pos.y, t, 0.1); p.positionZ.setTargetAtTime(pos.z, t, 0.1); }
    this.riverGain.gain.setTargetAtTime(Math.min(0.12, 2.2 / (dist + 8)), t, 0.2);
  }

  _updateAmbience() {}
}
