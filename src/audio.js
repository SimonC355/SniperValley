// WebAudio: distance-delayed gunshots with valley echo (convolver), bolt cycling, supersonic
// near-miss cracks, impacts, surface-dependent footsteps, water splashes, crow caws and wing
// beats, wind and river. Everything is synthesised; optional recorded samples listed in
// public/assets/sounds/sounds.json replace individual sounds (see README).
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { muzzleBlast, supersonicCrack, crowCaw } from './sfx.js';

const lerpN = (a, b, t) => a + (b - a) * t;

export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.listenerPos = new THREE.Vector3();
    this.onShotHeard = null;   // fn(distance) for every gunshot played (the forest falls silent)
    this.log = [];             // recent sounds { name, d, t } for the F1 debug panel
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
  }

  // Must be called from a user gesture. `ctx` lets tests render into an OfflineAudioContext.
  init(ctx = null, { ambience = true, samples = true } = {}) {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
    }
    this.ctx = ctx;
    this.bus = ctx.createGain();     // everything -> soft clipper -> master volume
    // A soft clipper instead of a compressor: a compressor's look-ahead flattens the first
    // millisecond of a shot, which is exactly what makes it crack. tanh only rounds off peaks.
    const clip = ctx.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      // ceiling 0.82: the 4× oversampling filter overshoots a hard transient by up to ~20 %,
      // which pushed a full-volume gunshot to +1.5 dBFS (clipped in the sound card)
      curve[i] = (0.82 * Math.tanh(1.2 * x * 1.5)) / Math.tanh(1.8);
    }
    clip.curve = curve;
    clip.oversample = '4x';
    this.out = ctx.createGain();
    // v5.2: your hearing. A low-pass on everything from outside your head: it closes for a
    // moment when a bullet cracks past (suppression) and, a little, right after your own shot.
    this.openHz = Math.min(20000, ctx.sampleRate * 0.45);
    this.hearing = ctx.createBiquadFilter();
    this.hearing.type = 'lowpass';
    this.hearing.Q.value = 0.707;
    this.hearing.frequency.value = this.openHz;
    this.bus.connect(this.hearing).connect(clip).connect(this.out).connect(ctx.destination);
    // sounds inside your head (breath, heartbeat, ringing ears, the hit tick) skip the hearing filter
    this.body = ctx.createGain();
    this.body.connect(clip);
    // effect and ambience sub-buses; one-shots connect to `master` (= the effects bus)
    this.master = ctx.createGain();
    this.master.connect(this.bus);
    this.amb = ctx.createGain();
    this.ambDuck = ctx.createGain();   // the ambience dips after a gunshot close by
    this.amb.connect(this.ambDuck).connect(this.bus);
    // valley echo
    this.echo = ctx.createConvolver();
    this.echo.buffer = this._valleyIR();
    this.echoGain = ctx.createGain();
    this.echo.connect(this.echoGain).connect(this.master);
    this.noise = this._noiseBuffer(2);
    this.brown = this._brownBuffer(4);
    // synthesised gunshot buffers (a few variations each, see sfx.js)
    const toBuffer = (data) => {
      const b = ctx.createBuffer(1, data.length, ctx.sampleRate);
      b.getChannelData(0).set(data);
      return b;
    };
    this.blasts = [11, 23, 37].map((sd) => toBuffer(muzzleBlast(ctx.sampleRate, sd)));   // v5.2: a short, hard smack
    this.cracks = [[1.5, 5], [6, 17], [16, 29]].map(([miss, sd]) => ({ miss, bufs: [sd, sd + 1].map((k) => toBuffer(supersonicCrack(ctx.sampleRate, k, miss))) }));
    this.cawBufs = [41, 42, 43, 44, 45, 46].map((sd) => toBuffer(crowCaw(ctx.sampleRate, sd)));
    this.samples = {};
    if (samples) this._loadSamples();
    if (ambience) this._startAmbience();
    this.setVolumes();
    this.ready = true;
  }

  setVolumes() {
    if (!this.ctx) return;
    const A = CONFIG.audio, t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(A.master, t, 0.03);
    this.master.gain.setTargetAtTime(A.effects, t, 0.03);
    this.amb.gain.setTargetAtTime(A.ambience, t, 0.03);
    this.body.gain.setTargetAtTime(A.effects * (A.body ?? 1), t, 0.03);
    this.echoGain.gain.setTargetAtTime(A.echo ? 0.55 : 0, t, 0.03);
  }

  // Close the hearing filter to `hz` at time `at` for `hold` seconds, then let it open again
  // (time constant `tau`). A weaker muffle never lifts a stronger one that is still on.
  _muffle(hz, at, hold, tau) {
    const f = this.hearing.frequency;
    const now = this.ctx.currentTime;
    const cur = Math.min(this.openHz, f.value);
    if (cur < hz && at <= now + 0.02) return;
    f.cancelScheduledValues(now);
    f.setValueAtTime(cur, now);
    f.setValueAtTime(cur, Math.max(now, at));
    f.exponentialRampToValueAtTime(Math.min(cur, hz), Math.max(now, at) + 0.012);
    f.setTargetAtTime(this.openHz, Math.max(now, at) + 0.012 + hold, tau);
  }

  // Dip the ambience (wind, river, forest) to `k` and let it come back.
  _duckAmbience(k, at, tau) {
    const g = this.ambDuck.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(Math.min(g.value, k), at + 0.03);
    g.setTargetAtTime(1, at + 0.08, tau);
  }

  // Optional recorded samples: public/assets/sounds/sounds.json maps a sound name to one file
  // or a list of variations, e.g. { "shot": ["shot1.ogg", "shot2.ogg"], "footstep_forest": [...] }.
  async _loadSamples() {
    const base = `${(import.meta.env && import.meta.env.BASE_URL) || '/'}assets/sounds/`;
    let list;
    try {
      const r = await fetch(`${base}sounds.json`, { cache: 'no-cache' });
      if (!r.ok) return;
      list = await r.json();
    } catch { return; }
    const names = [];
    for (const [name, files] of Object.entries(list || {})) {
      const arr = Array.isArray(files) ? files : [files];
      const bufs = [];
      for (const f of arr) {
        try {
          const data = await (await fetch(base + f)).arrayBuffer();
          bufs.push(await this.ctx.decodeAudioData(data));
        } catch (e) { console.warn(`[audio] could not load ${f}`); }
      }
      if (bufs.length) { this.samples[name] = bufs; names.push(name); }
    }
    if (names.length) console.info(`[audio] samples: ${names.join(', ')}`);
  }

  // Play a sample variation into `dest` at time t. Returns false if there is no such sample.
  _sample(name, dest, t, gain = 1, rate = 1) {
    const list = this.samples && this.samples[name];
    if (!list) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = list[Math.floor(Math.random() * list.length)];
    src.playbackRate.value = rate * (0.96 + Math.random() * 0.08);
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(dest);
    src.start(t);
    return true;
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
  // The valley answering a shot (v5.2): distinct, dulled echoes off the slopes and the valley
  // ends, and a low diffuse roll between them that starts once the shot itself is over. (It was
  // white noise from t = 0, which laid a hiss over every shot.)
  _valleyIR() {
    const ctx = this.ctx, sr = ctx.sampleRate;
    const len = Math.floor(sr * 3.2);
    const b = ctx.createBuffer(2, len, sr);
    const lp = (d, hz) => { const a = Math.exp(-2 * Math.PI * hz / sr); let y = 0; for (let i = 0; i < d.length; i++) { y = (1 - a) * d[i] + a * y; d[i] = y; } };
    const peakTo = (d, p) => { let m = 0; for (const v of d) m = Math.max(m, Math.abs(v)); if (m > 0) for (let i = 0; i < d.length; i++) d[i] *= p / m; };
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const rise = Math.min(1, Math.max(0, (t - 0.06) / 0.2));
        d[i] = (Math.random() * 2 - 1) * Math.exp(-t / 0.55) * rise;
      }
      lp(d, 1800); lp(d, 2400);
      peakTo(d, 0.06);
      // the echoes: compact bursts (a few ms), duller the further they travelled
      for (const [t0, a, hz] of [[0.3, 0.75, 4200], [0.55, 0.55, 3500], [0.98, 0.4, 2800], [1.5, 0.26, 2200], [2.15, 0.15, 1800]]) {
        const s0 = Math.floor((t0 + ch * 0.013 + (Math.random() - 0.5) * 0.01) * sr);
        const burst = new Float32Array(Math.floor(sr * 0.06));
        for (let k = 0; k < burst.length; k++) burst[k] = (Math.random() * 2 - 1) * Math.exp(-k / (sr * 0.006));
        lp(burst, hz); lp(burst, hz * 1.3);
        peakTo(burst, a);
        for (let k = 0; k < burst.length && s0 + k < len; k++) d[s0 + k] += burst[k];
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

  // remember a sound for the F1 debug panel (what was that noise?)
  _log(name, d) {
    this.log.push({ name, d: Math.round(d), t: this.ctx.currentTime });
    if (this.log.length > 14) this.log.shift();
  }

  _env(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  // ------------------------------------------------------------------ gunshot
  // Muzzle report. Close up it is a hard "SMELD" (blast wave + tree reflections); far away the
  // same blast arrives later, duller (air absorption), a little stretched and with more valley
  // echo. The bullet's own crack is crack() below.
  shot(pos, own = false) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const d = own ? 0 : this.listenerPos.distanceTo(pos);
    if (this.onShotHeard) this.onShotHeard(d);
    this._log(own ? 'shot (yours)' : 'shot', d);
    const t = ctx.currentTime + d / CONFIG.reveal.soundSpeed;
    // v5.2: the forest goes quiet under a shot close by. (Your ears are no longer muffled after
    // it: that cut the hiss right after the crack, and the shot sounded dull.)
    if (d < 40) this._duckAmbience(1 - 0.6 * (own ? 1 : 1 - d / 40), t, 0.9);
    // v5.2, "your own shot is perfect, the others' are a bit worse": others' shots kept the
    // whip-crack's character only up close. Now they are not played slower with distance (that
    // pitched them down, a dull thud at 300 m), the air takes the highs off more gently, the echo
    // no longer swamps them, and a treble shelf makes up for the HRTF panner (the 3D direction
    // filter, kept: it tells front from behind), which took about half the crack's highs.
    const out = ctx.createGain();
    out.gain.value = own ? 0.9 : Math.min(1, 65 / (d + 35));
    if (own) out.connect(this.master);
    else out.connect(this._panner(pos)).connect(this.master);
    // send to the valley echo (relatively stronger for distant shots)
    const send = ctx.createGain();
    send.gain.value = own ? 0.4 : Math.min(0.9, 0.35 + d / 600);
    out.connect(send).connect(this.echo);
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.Q.value = 0.5;
    air.frequency.value = own ? 20000 : Math.max(4500, 20000 / (1 + d / 400));
    let into = air;
    if (!own) {
      const shelf = ctx.createBiquadFilter();
      shelf.type = 'highshelf';
      shelf.frequency.value = 2200;
      shelf.gain.value = 6;
      shelf.connect(air);
      into = shelf;
    }
    air.connect(out);
    if (this._sample(own || d < 60 ? 'shot' : 'shot_far', into, t, 1) || this._sample('shot', into, t, 1)) return;
    const src = ctx.createBufferSource();
    src.buffer = this.blasts[Math.floor(Math.random() * this.blasts.length)];
    src.connect(into);
    src.start(t);
  }

  // Supersonic crack of a bullet passing within ~30 m: an N-wave "PISK" from the closest point
  // of the bullet's path. It arrives before the muzzle report (the bullet outruns the sound).
  //
  // v5.2: `dir` is the bullet's direction. The shock wave leaves the bullet's path at the Mach
  // angle, so the crack seems to come from a point a little back toward the shooter
  // (0.44 × the miss distance at 850 m/s), not from the closest point. A bullet within ~4 m
  // also tears the air: a short hiss that sweeps across your head with the bullet.
  crack(pos, miss = 2, dir = null) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    this._log(`bullet crack (${Math.round(miss)} m miss)`, this.listenerPos.distanceTo(pos));
    const from = dir ? pos.clone().addScaledVector(dir, -0.44 * miss) : pos;
    if (dir && miss < 4) this._airTear(pos, dir, miss);
    const p = this._panner(from);
    const g = ctx.createGain();
    g.gain.value = Math.min(1.4, Math.max(0.25, Math.pow(6 / (miss + 3), 0.8)));
    g.connect(p).connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.35;
    g.connect(send).connect(this.echo);
    if (this._sample('crack', g, t, 1)) return;
    let set = this.cracks[0];
    for (const c of this.cracks) if (Math.abs(c.miss - miss) < Math.abs(set.miss - miss)) set = c;
    const src = ctx.createBufferSource();
    src.buffer = set.bufs[Math.floor(Math.random() * set.bufs.length)];
    src.connect(g);
    src.start(t);
  }

  // The air torn by a bullet passing within a few metres: broadband hiss (no tone, no pitch
  // sweep: those read as an insect) whose source runs along the bullet's path past your head.
  _airTear(pos, dir, miss) {
    const ctx = this.ctx, t = ctx.currentTime;
    const k = Math.min(1, Math.pow(1.6 / (miss + 0.6), 0.9));
    const p = this._panner(pos.clone().addScaledVector(dir, -14));
    if (p.positionX) {
      const a = pos.clone().addScaledVector(dir, -14), b = pos.clone().addScaledVector(dir, 14);
      p.positionX.setValueAtTime(a.x, t); p.positionY.setValueAtTime(a.y, t); p.positionZ.setValueAtTime(a.z, t);
      p.positionX.linearRampToValueAtTime(b.x, t + 0.05); p.positionY.linearRampToValueAtTime(b.y, t + 0.05); p.positionZ.linearRampToValueAtTime(b.z, t + 0.05);
    }
    const s = this._noiseSrc(t, 0.2);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1600; hp.Q.value = 0.5;
    const bp = ctx.createBiquadFilter(); bp.type = 'peaking'; bp.frequency.value = 4800; bp.Q.value = 0.8; bp.gain.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.55 * k, t + 0.022);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    s.connect(hp).connect(bp).connect(g).connect(p).connect(this.master);
  }

  // v5.2: suppression. A bullet that just missed you: your hearing closes for a moment (more
  // the closer it was) and a very close one leaves your ears ringing for a few seconds.
  suppress(k, ring = 0) {
    if (!this.ready || k <= 0) return;
    const t = this.ctx.currentTime;
    this._muffle(lerpN(this.openHz, 650, Math.min(1, k)), t + 0.02, 0.12 + 0.35 * k, 0.45 + 0.5 * k);
    this._duckAmbience(1 - 0.7 * Math.min(1, k), t, 1.2);
    if (ring > 0) this.tinnitus(ring);
  }

  // Ringing ears: one thin high sine (a second one close to it would beat: a buzz).
  tinnitus(strength = 1) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    this._log('ringing ears', 0);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 3500 + Math.random() * 600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.022 * strength, t + 0.12);
    g.gain.setTargetAtTime(0.0001, t + 0.5, 0.9);
    o.connect(g).connect(this.body);
    o.start(t);
    o.stop(t + 5);
  }

  // Your own breathing (v5.2): kind 'in' | 'out', strength 0 (calm, through the scope) .. 1
  // (out of breath), dur seconds. Breath is noise through a moving formant, not a tone.
  breathe(kind, strength = 0, dur = 1.2) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    if (this._sample(`breathe_${kind}`, this.body, t, 0.35 + 0.65 * strength)) return;
    const s = this._noiseSrc(t, dur);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = kind === 'in' ? 1.1 : 0.8;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = kind === 'in' ? 4200 : 2600;
    const [f0, f1] = kind === 'in' ? [1400 + 500 * strength, 1900 + 500 * strength] : [1150 + 300 * strength, 650];
    bp.frequency.setValueAtTime(f0, t);
    bp.frequency.linearRampToValueAtTime(f1, t + dur);
    const peak = (kind === 'in' ? 0.024 : 0.03) + 0.06 * strength * strength + 0.02 * strength;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + dur * (kind === 'in' ? 0.45 : 0.25));
    g.gain.linearRampToValueAtTime(peak * 0.6, t + dur * 0.7);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    s.connect(bp).connect(lp).connect(g).connect(this.body);
  }

  // A heartbeat (v5.2): "lub-dub", two low thumps felt more than heard. Low-passed noise for
  // the body of each beat and a little 110-170 Hz thud so laptop speakers carry it too.
  heartbeat(strength = 1) {
    if (!this.ready || strength <= 0.01) return;
    const ctx = this.ctx, t = ctx.currentTime;
    if (this._sample('heartbeat', this.body, t, 0.4 + 0.6 * strength)) return;
    for (const [dt, a] of [[0, 1], [0.17, 0.62]]) {
      const tt = t + dt;
      const s = this._noiseSrc(tt, 0.16);
      const lp1 = ctx.createBiquadFilter(); lp1.type = 'lowpass'; lp1.frequency.value = 150; lp1.Q.value = 0.9;
      const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 150; lp2.Q.value = 0.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime(1.4 * a * strength, tt + 0.014);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.13);
      s.connect(lp1).connect(lp2).connect(g).connect(this.body);
    }
  }

  // Cloth and cheek on the stock as the rifle comes up to the eye (in) or down (out).
  scopeFoley(kind) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    if (this._sample(`scope_${kind}`, this.master, t, 0.5)) return;
    const dur = kind === 'in' ? 0.2 : 0.14;
    const s = this._noiseSrc(t, dur);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.9; bp.frequency.value = kind === 'in' ? 2300 : 1900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(kind === 'in' ? 0.05 : 0.035, t + dur * 0.4);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    s.connect(bp).connect(g).connect(this.master);
    if (kind === 'in') this._click(t + 0.13, 1500, 0.035, 0.02, 3);   // cheek meets the riser
  }

  // One detent of the scope's zoom ring.
  zoomClick(at = 0) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + at;
    if (this._sample('zoom', this.master, t, 0.4)) return;
    this._click(t, 5200, 0.12, 0.01, 5);
    this._click(t + 0.004, 1700, 0.05, 0.018, 3);
  }

  // A short filtered noise click into `dest` (default: the effects bus).
  _click(t, f, a, decay, q = 6, dest = this.master) {
    const ctx = this.ctx;
    const s = this._noiseSrc(t, decay + 0.02);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
    const g = ctx.createGain();
    this._env(g, t, a, 0.001, decay);
    s.connect(bp).connect(g).connect(dest);
  }

  // Metal sliding on metal (the bolt going back or forward): a soft scrape with a few ticks.
  _scrape(t, dur, f, a) {
    const ctx = this.ctx;
    const s = this._noiseSrc(t, dur);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 2.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(a, t + dur * 0.3);
    g.gain.linearRampToValueAtTime(a * 0.7, t + dur * 0.8);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    s.connect(bp).connect(g).connect(this.master);
    for (let i = 0; i < 3; i++) this._click(t + Math.random() * dur, f * (1.3 + Math.random()), a * 0.6, 0.008, 8);
  }

  // The empty case landing next to you, by surface: it rings on rock, ticks on the forest
  // floor, thumps on grass and disappears in mud or water.
  _brass(t, surface) {
    const ctx = this.ctx;
    if (surface === 'mud' || surface === 'water') { this._click(t, 900, 0.025, 0.03, 2); return; }
    if (surface !== 'rock') {
      this._click(t, surface === 'grass' ? 1300 : 2400, 0.05, 0.025, 2.5);
      if (surface !== 'grass') this._click(t + 0.09, 3200, 0.022, 0.015, 4);
      return;
    }
    // brass on stone: a few bounces, each a cluster of high, inharmonic partials
    let tt = t, a = 0.035;
    for (let b = 0; b < 3; b++) {
      for (const f of [5100, 7700, 11300]) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * (0.97 + Math.random() * 0.06);
        const g = ctx.createGain();
        this._env(g, tt, a * (f === 5100 ? 1 : 0.55), 0.001, 0.06 + 0.04 * (2 - b));
        o.connect(g).connect(this.master); o.start(tt); o.stop(tt + 0.2);
      }
      tt += 0.13 - b * 0.04;
      a *= 0.5;
    }
  }

  // Bolt cycle (v5.2 adds the slides, the case flying out and landing, `surface` under you).
  // Times follow the first-person animation: handle up 0.25-0.4 s after the shot, back to
  // 0.62, forward to 0.85, down to 1.0.
  bolt(startDelay = 0.25, surface = 'forest') {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + startDelay;
    if (this._sample('bolt', this.master, t0, 0.8)) return;
    this._scrape(t0 + 0.16, 0.2, 2500, 0.07);    // back
    this._click(t0 + 0.37, 6200, 0.05, 0.02, 5);  // the case leaves the ejector
    this._scrape(t0 + 0.38, 0.2, 2100, 0.06);    // forward
    this._brass(t0 + 0.72 + Math.random() * 0.12, surface);
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
    this._log(`impact ${kind}`, d);
    if (d < 9 && kind !== 'water') this._debris(pos, kind, d, t);
    if (this._sample(`impact_${kind === 'forest' ? 'ground' : kind}`, this._panner(pos).connect(this.master), t, vol)) return;
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

  // v5.2: a bullet landing within a few metres of you: a heavy thud in the ground and the
  // dirt, needles or splinters it threw up raining down around you.
  _debris(pos, kind, d, t) {
    const ctx = this.ctx;
    const k = 1 - d / 9;
    const pn = this._panner(pos);
    pn.connect(this.master);
    const s = this._noiseSrc(t, 0.25);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = kind === 'rock' ? 900 : 260;
    const g = ctx.createGain();
    this._env(g, t, 0.9 * k, 0.003, 0.18);
    s.connect(lp).connect(g).connect(pn);
    const n = 6 + Math.round(8 * k);
    for (let i = 0; i < n; i++) {
      const tt = t + 0.12 + Math.pow(Math.random(), 1.6) * 0.7;
      const f = kind === 'rock' ? 3200 + Math.random() * 3000 : kind === 'tree' ? 1800 + Math.random() * 1500 : 1400 + Math.random() * 2400;
      this._click(tt, f, (0.06 + Math.random() * 0.1) * k, 0.012 + Math.random() * 0.02, 3, pn);
    }
  }

  // v5.2: your bullet hit someone. A tick right away (inside your head, like a hit marker) and,
  // after the sound has come back over the distance, the dull thump of the hit itself.
  hitConfirm(pos, part, dist) {
    if (!this.ready) return;
    const ctx = this.ctx, now = ctx.currentTime;
    this._click(now + 0.015, part === 'head' ? 4200 : 3000, part === 'head' ? 0.26 : 0.2, 0.025, 4, this.body);
    if (part === 'head') this._click(now + 0.05, 5600, 0.14, 0.02, 5, this.body);
    const t = now + dist / CONFIG.reveal.soundSpeed;
    this._log(`hit ${part}`, dist);
    const out = ctx.createGain();
    out.gain.value = Math.max(0.2, Math.min(0.8, 40 / (dist + 30)));
    out.connect(this._panner(pos)).connect(this.master);
    if (this._sample('hit', out, t, 1)) return;
    const s = this._noiseSrc(t, 0.2);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.max(500, 1600 / (1 + dist / 300));
    const g = ctx.createGain();
    this._env(g, t, 0.9, 0.002, 0.13);
    s.connect(lp).connect(g).connect(out);
  }

  // surface: 'grass' | 'forest' (needles, twigs) | 'rock' | 'mud'
  footstep(pos, loud, surface, own) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const d = own ? 0 : this.listenerPos.distanceTo(pos);
    if (d > CONFIG.reveal.footstepHearingRange * 1.5) return;
    const t = ctx.currentTime + d / CONFIG.reveal.soundSpeed;
    const vol = (own ? 0.14 : 0.4 / (1 + d / 4)) * loud;
    const out = ctx.createGain();
    out.gain.value = vol;
    if (own) out.connect(this.master); else out.connect(this._panner(pos)).connect(this.master);
    if (this._sample(`footstep_${surface}`, out, t, 1)) return;
    // heel: a soft low thud
    const th = this._noiseSrc(t, 0.1);
    const tl = ctx.createBiquadFilter(); tl.type = 'lowpass'; tl.frequency.value = surface === 'rock' ? 600 : 320;
    const tg = ctx.createGain();
    this._env(tg, t, 0.9, 0.006, 0.07);
    th.connect(tl).connect(tg).connect(out);
    if (surface === 'grass') {
      // swish of blades
      const sw = this._noiseSrc(t, 0.22);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.9;
      bp.frequency.setValueAtTime(2600, t); bp.frequency.exponentialRampToValueAtTime(1400, t + 0.18);
      const g = ctx.createGain();
      this._env(g, t + 0.01, 0.35, 0.04, 0.15);
      sw.connect(bp).connect(g).connect(out);
    } else {
      // crunch: a burst of tiny clicks (needles and twigs, gravel, wet sucking for mud)
      const n = surface === 'mud' ? 2 : 4 + Math.floor(Math.random() * 4);
      const f0 = surface === 'rock' ? 3800 : surface === 'mud' ? 700 : 2400;
      for (let i = 0; i < n; i++) {
        const tt = t + 0.01 + Math.random() * (surface === 'mud' ? 0.12 : 0.08);
        const c = this._noiseSrc(tt, 0.03);
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 2.5; bp.frequency.value = f0 * (0.7 + Math.random() * 0.7);
        const g = ctx.createGain();
        this._env(g, tt, (surface === 'mud' ? 0.5 : 0.28) * (0.5 + Math.random()), 0.001, surface === 'mud' ? 0.08 : 0.018);
        c.connect(bp).connect(g).connect(out);
      }
      // now and then a twig snaps in the forest
      if (surface === 'forest' && Math.random() < 0.12 * (0.5 + loud)) {
        const tt = t + 0.03;
        const c = this._noiseSrc(tt, 0.02);
        const hp = ctx.createBiquadFilter(); hp.type = 'bandpass'; hp.Q.value = 4; hp.frequency.value = 3200 + Math.random() * 1200;
        const g = ctx.createGain();
        this._env(g, tt, 1.4, 0.0005, 0.025);
        c.connect(hp).connect(g).connect(out);
      }
    }
  }

  splash(pos, loud, own) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const d = own ? 0 : this.listenerPos.distanceTo(pos);
    if (d > CONFIG.reveal.splashHearingRange) return;
    const t = ctx.currentTime + d / CONFIG.reveal.soundSpeed;
    const vol = (own ? 0.35 : 0.8 / (1 + d / 8)) * (0.5 + loud);
    this._log(own ? 'splash (yours)' : 'splash', d);
    if (this._sample('splash', own ? this.master : this._panner(pos).connect(this.master), t, vol)) return;
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

  // Crow caws, distance-delayed and spatialised. A flushed flock gives full alarm caws; a
  // perched one calls more quietly (gain). reps/gap fix the series (so the caller can bob its
  // head in time); otherwise one to three caws at a natural spacing.
  caw(pos, pitch = 1, { gain = 1, reps = 0, gap = 0 } = {}) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const d = this.listenerPos.distanceTo(pos);
    if (d > 450) return;
    const t = ctx.currentTime + d / CONFIG.reveal.soundSpeed;
    const vol = Math.min(0.5, 14 / (d + 12)) * gain;
    const out = ctx.createGain(); out.gain.value = vol;
    const air = ctx.createBiquadFilter(); air.type = 'lowpass'; air.frequency.value = Math.max(1200, 9000 / (1 + d / 150));
    out.connect(air).connect(this._panner(pos)).connect(this.master);
    const send = ctx.createGain(); send.gain.value = Math.min(0.5, 0.1 + d / 400);
    air.connect(send).connect(this.echo);
    this._log('caw', d);
    if (this._sample('caw', out, t, 1, pitch)) return;
    const n = reps || 1 + Math.floor(Math.random() * 3);
    for (let r = 0; r < n; r++) {
      const src = ctx.createBufferSource();
      src.buffer = this.cawBufs[Math.floor(Math.random() * this.cawBufs.length)];
      src.playbackRate.value = pitch * (0.96 + Math.random() * 0.08);
      src.connect(out);
      src.start(t + r * (gap || 0.32 + Math.random() * 0.1));
    }
  }

  // Wing beats: `birds` birds flapping `beats` times at `rate` per second. Each beat is a soft,
  // low "whup" of air with a little feather swish on top; a flock bursting out of a crown also
  // thrashes the twigs (branches).
  wings(pos, { birds = 1, beats = 4, rate = 3.6, gain = 1, branches = false } = {}) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const d = this.listenerPos.distanceTo(pos);
    if (d > 220) return;
    const t0 = ctx.currentTime + d / CONFIG.reveal.soundSpeed;
    const out = ctx.createGain(); out.gain.value = gain * Math.min(1.2, 9 / (d + 4));
    const air = ctx.createBiquadFilter(); air.type = 'lowpass'; air.frequency.value = Math.max(1500, 12000 / (1 + d / 60));
    out.connect(air).connect(this._panner(pos)).connect(this.master);
    this._log('wings', d);
    if (this._sample('wings', out, t0, 1, 1)) return;
    const n = Math.min(birds, 10);
    const norm = 1.5 / Math.sqrt(n);
    for (let i = 0; i < n; i++) {
      const start = t0 + (i === 0 ? 0 : Math.random() * 0.5);
      const per = 1 / (rate * (0.85 + Math.random() * 0.3));
      const nb = beats + Math.floor(Math.random() * 2);
      const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
      const low = ctx.createBiquadFilter(); low.type = 'bandpass'; low.frequency.value = 380 + Math.random() * 300; low.Q.value = 1.1;
      const high = ctx.createBiquadFilter(); high.type = 'bandpass'; high.frequency.value = 2600 + Math.random() * 1400; high.Q.value = 0.9;
      const hg = ctx.createGain(); hg.gain.value = 0.22;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, start);
      for (let k = 0; k < nb; k++) {
        // the first strokes are the strongest (pushing off), then they fade as the bird climbs away
        const tb = start + k * per;
        const a = (k < 2 ? 1 : Math.pow(0.78, k - 1)) * (0.7 + Math.random() * 0.3) * norm;
        g.gain.setValueAtTime(0, tb);
        g.gain.linearRampToValueAtTime(a, tb + 0.014);
        g.gain.linearRampToValueAtTime(a * 0.3, tb + 0.05);
        g.gain.linearRampToValueAtTime(0, tb + Math.min(per * 0.9, 0.13));
      }
      src.connect(low).connect(g);
      src.connect(high).connect(hg).connect(g);
      g.connect(out);
      src.start(start, Math.random() * 1.5);
      src.stop(start + nb * per + 0.2);
    }
    if (branches) {
      const s = this._noiseSrc(t0, 0.9);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 4200; bp.Q.value = 0.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.45, t0 + 0.03);
      g.gain.linearRampToValueAtTime(0.14, t0 + 0.3);
      g.gain.linearRampToValueAtTime(0, t0 + 0.85);
      s.connect(bp).connect(g).connect(out);
    }
  }

  // Sliding over the ground on your knee and hip: a scrape that dies away (v5).
  slide(surface = 'forest') {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    this._log('slide (yours)', 0);
    if (this._sample('slide', this.master, t, 0.7)) return;
    const s = this._noiseSrc(t, 0.9);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 0.9;
    const f0 = surface === 'rock' ? 2600 : surface === 'mud' ? 700 : surface === 'grass' ? 1500 : 1900;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f0 * 0.45, t + 0.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
    s.connect(f).connect(g).connect(this.master);
    // twigs and leaves pushed along
    for (let i = 0; i < 6; i++) {
      const tt = t + 0.05 + Math.random() * 0.55;
      const c = this._noiseSrc(tt, 0.03);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2500 + Math.random() * 2500; bp.Q.value = 6;
      const cg = ctx.createGain();
      this._env(cg, tt, 0.18 * Math.random() + 0.05, 0.002, 0.03);
      c.connect(bp).connect(cg).connect(this.master);
    }
  }

  // Hands and boots on rock: climbing onto a rock or a wall (v5).
  climb() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    this._log('climb (yours)', 0);
    if (this._sample('climb', this.master, t, 0.6)) return;
    for (const [dt, f, a] of [[0, 1700, 0.35], [0.16, 2300, 0.25], [0.34, 1200, 0.4]]) {
      const tt = t + dt;
      const n = this._noiseSrc(tt, 0.14);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 1.2;
      const g = ctx.createGain();
      this._env(g, tt, a, 0.006, 0.12);
      n.connect(bp).connect(g).connect(this.master);
    }
  }

  // Falling into the deep, fast river: a big plunge and the roar of the current.
  plunge() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    this._log('plunge (yours)', 0);
    const s = this._noiseSrc(t, 2.6);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(3500, t);
    f.frequency.exponentialRampToValueAtTime(700, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.5);
    s.connect(f).connect(g).connect(this.master);
  }

  // The player's own breath while scoped: a short inhale when holding it, a slow exhale when
  // letting go, and a gasp (exhale + quick inhale) when it ran out.
  breath(kind) {
    if (!this.ready) return;
    const ctx = this.ctx, t0 = ctx.currentTime;
    const puff = (t, dur, f0, f1, peak) => {
      const s = this._noiseSrc(t, dur);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
      bp.frequency.setValueAtTime(f0, t);
      bp.frequency.linearRampToValueAtTime(f1, t + dur);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + dur * 0.35);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      s.connect(bp).connect(lp).connect(g).connect(this.body);
    };
    this._log(`breath ${kind}`, 0);
    if (this._sample(`breath_${kind}`, this.body, t0, 0.8)) return;
    if (kind === 'hold') puff(t0, 0.32, 900, 1500, 0.05);
    else if (kind === 'release') puff(t0, 0.7, 1100, 600, 0.045);
    else if (kind === 'gasp') { puff(t0, 0.45, 1300, 700, 0.09); puff(t0 + 0.5, 0.3, 900, 1600, 0.08); puff(t0 + 0.9, 0.5, 1200, 700, 0.06); }
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
    w.connect(wf).connect(this.windGain).connect(this.amb);
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
    r.connect(rf).connect(rf2).connect(this.riverGain).connect(this.riverPanner).connect(this.amb);
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
