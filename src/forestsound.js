// Forest ambience: songbirds in the trees around you (gunfire silences them, then they come
// back one by one), a woodpecker now and then, needles rustling in the gusts (left and right
// follow the gust as it sweeps past), and a low roar in strong gusts. Everything is
// synthesised and goes to the ambience bus. Nothing here may buzz: a steady pulse or tone in
// the 100-700 Hz range reads as an insect (two play tests heard "a bee flying around").
import * as THREE from 'three';
import { gustAt } from './shaders.js';

const SPECIES = ['chaffinch', 'tit', 'robin', 'thrush'];
const SINGERS = 5;

const rand = (a, b) => a + Math.random() * (b - a);

export class ForestAmbience {
  constructor(audio, terrain) {
    this.a = audio;
    this.terrain = terrain;
    this.singers = [];
    this.quietUntil = 0;       // audio-clock time until which the birds keep quiet
    this.woodpeckerAt = 0;
    this.started = false;
    this._right = new THREE.Vector3();
  }

  _start() {
    const a = this.a, ctx = a.ctx;
    // needle rustle, one source per ear so a gust can be heard arriving from one side
    this.rustle = [-0.75, 0.75].map((pan) => {
      const n = ctx.createBufferSource(); n.buffer = a.noise; n.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3400; bp.Q.value = 0.5;
      const g = ctx.createGain(); g.gain.value = 0;
      const p = ctx.createStereoPanner(); p.pan.value = pan;
      n.connect(bp).connect(g).connect(p).connect(a.amb);
      n.start(0, Math.random() * 1.5);
      return g;
    });
    // low roar of a strong gust
    const w = ctx.createBufferSource(); w.buffer = a.brown; w.loop = true;
    this.roarLP = ctx.createBiquadFilter(); this.roarLP.type = 'lowpass'; this.roarLP.frequency.value = 300;
    this.roar = ctx.createGain(); this.roar.gain.value = 0;
    w.connect(this.roarLP).connect(this.roar).connect(a.amb);
    w.start(0, 1.3);
    const now = ctx.currentTime;
    this.woodpeckerAt = now + rand(25, 60);
    this.started = true;
  }

  // Gunfire: the birds stop singing for a while.
  onShot(dist) {
    if (!this.started || dist > 700) return;
    const now = this.a.ctx.currentTime;
    this.quietUntil = Math.max(this.quietUntil, now + rand(22, 40));
    for (const s of this.singers) s.next = this.quietUntil + rand(0, 25);
    this.woodpeckerAt = Math.max(this.woodpeckerAt, this.quietUntil + rand(20, 60));
  }

  // Per frame (time = game clock for the gust field, camera = listener).
  update(dt, camera, time) {
    const a = this.a;
    if (!a.ready || !a.amb) return;
    if (!this.started) this._start();
    const ctx = a.ctx, now = ctx.currentTime;
    const p = camera.position;
    const T = this.terrain;
    const canopy = T.canopyAt(p.x, p.z);
    // gust on each side of the listener
    const r = this._right.set(1, 0, 0).applyQuaternion(camera.quaternion).setY(0).normalize();
    const gl = gustAt(p.x - r.x * 25, p.z - r.z * 25, time), gr = gustAt(p.x + r.x * 25, p.z + r.z * 25, time);
    const g = gustAt(p.x, p.z, time);
    const forest = 0.35 + 0.65 * canopy;
    this.rustle[0].gain.setTargetAtTime((0.0025 + 0.05 * gl ** 1.5) * forest, now, 0.25);
    this.rustle[1].gain.setTargetAtTime((0.0025 + 0.05 * gr ** 1.5) * forest, now, 0.25);
    this.roar.gain.setTargetAtTime(0.1 * g ** 2, now, 0.4);
    this.roarLP.frequency.setTargetAtTime(260 + 520 * g, now, 0.4);

    // songbirds
    while (this.singers.length < SINGERS) this.singers.push(this._newSinger(p, now));
    for (let i = 0; i < this.singers.length; i++) {
      let s = this.singers[i];
      if (s.pos.distanceTo(p) > 120) { s = this.singers[i] = this._newSinger(p, now); }
      if (now >= s.next) {
        if (now >= this.quietUntil) this._sing(s, now + 0.05);
        s.next = Math.max(now, this.quietUntil) + s.interval * rand(0.7, 1.4);
      }
    }
    // woodpecker
    if (now >= this.woodpeckerAt) {
      if (now >= this.quietUntil) this._woodpecker(p, now + 0.05);
      this.woodpeckerAt = now + rand(45, 120);
    }
  }

  _spot(p, minD, maxD, up) {
    const T = this.terrain;
    for (let k = 0; k < 8; k++) {
      const ang = Math.random() * Math.PI * 2, d = rand(minD, maxD);
      const x = p.x + Math.cos(ang) * d, z = p.z + Math.sin(ang) * d;
      if (T.waterDepthAt(x, z) > 0) continue;
      return new THREE.Vector3(x, T.heightAt(x, z) + up, z);
    }
    return new THREE.Vector3(p.x + minD, p.y + up, p.z);
  }

  _newSinger(p, now) {
    const species = SPECIES[Math.floor(Math.random() * SPECIES.length)];
    return {
      species,
      pos: this._spot(p, 18, 95, rand(7, 18)),
      interval: rand(4, 11),
      pitch: rand(0.92, 1.08),
      next: Math.max(now, this.quietUntil) + rand(0.5, 9),
    };
  }

  // output chain for a sound at pos: distance level and air absorption, HRTF, a little echo
  _out(pos, level) {
    const a = this.a, ctx = a.ctx;
    const d = a.listenerPos.distanceTo(pos);
    const g = ctx.createGain(); g.gain.value = level * Math.min(1, 18 / (d + 6));
    const air = ctx.createBiquadFilter(); air.type = 'lowpass'; air.frequency.value = Math.max(2500, 16000 / (1 + d / 90));
    g.connect(air).connect(a._panner(pos)).connect(a.amb);
    const send = ctx.createGain(); send.gain.value = 0.08;
    air.connect(send).connect(a.echo);
    return g;
  }

  // one tonal note with a pitch glide f0 -> f1 (birdsong is close to a pure whistle)
  _note(out, t, dur, f0, f1, vol) {
    const ctx = this.a.ctx;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const h = ctx.createOscillator(); h.type = 'sine';
    h.frequency.setValueAtTime(f0 * 2, t);
    h.frequency.exponentialRampToValueAtTime(f1 * 2, t + dur);
    const hg = ctx.createGain(); hg.gain.value = 0.12;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + Math.min(0.012, dur * 0.3));
    g.gain.setValueAtTime(vol, t + dur * 0.7);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g); h.connect(hg).connect(g);
    g.connect(out);
    o.start(t); h.start(t); o.stop(t + dur + 0.02); h.stop(t + dur + 0.02);
  }

  _sing(s, t0) {
    this.a._log(`songbird (${s.species})`, this.a.listenerPos.distanceTo(s.pos));
    const out = this._out(s.pos, 0.16);
    const k = s.pitch;
    let t = t0;
    switch (s.species) {
      case 'chaffinch': {   // a falling, quickening trill and a flourish at the end
        const n = Math.floor(rand(8, 12));
        for (let i = 0; i < n; i++) {
          const f = (4300 - i * 110) * k;
          const dur = 0.05 - i * 0.002;
          this._note(out, t, dur, f * 1.1, f * 0.88, 0.8);
          t += dur + 0.035 - i * 0.0015;
        }
        this._note(out, t + 0.02, 0.11, 2900 * k, 3800 * k, 0.9);
        this._note(out, t + 0.15, 0.16, 5200 * k, 2500 * k, 1.0);
        break;
      }
      case 'tit': {         // "tea-cher tea-cher tea-cher"
        const n = Math.floor(rand(3, 6));
        for (let i = 0; i < n; i++) {
          this._note(out, t, 0.09, 5700 * k, 5500 * k, 0.8);
          this._note(out, t + 0.12, 0.1, 3800 * k, 3650 * k, 0.9);
          t += 0.3;
        }
        break;
      }
      case 'robin': {       // a liquid warble of varied notes
        const n = Math.floor(rand(6, 11));
        for (let i = 0; i < n; i++) {
          const f = rand(2600, 7200) * k, dur = rand(0.04, 0.14);
          this._note(out, t, dur, f, f * rand(0.75, 1.3), rand(0.5, 1));
          t += dur + rand(0.02, 0.08);
        }
        break;
      }
      case 'thrush': {      // a short motif, repeated
        const m = Array.from({ length: Math.floor(rand(2, 4)) }, () => ({ f: rand(2200, 5200) * k, d: rand(0.06, 0.15), g: rand(0.85, 1.2) }));
        const reps = Math.floor(rand(2, 4));
        for (let r = 0; r < reps; r++) {
          for (const n of m) { this._note(out, t, n.d, n.f, n.f * n.g, 0.9); t += n.d + 0.03; }
          t += 0.12;
        }
        break;
      }
    }
  }

  _woodpecker(p, t0) {
    const a = this.a, ctx = a.ctx;
    const pos = this._spot(p, 50, 150, rand(4, 12));
    this.a._log('woodpecker', a.listenerPos.distanceTo(pos));
    const out = this._out(pos, 0.8);
    // dry, broadband knocks at a rate you can count (a ringing resonance under a fast roll
    // turns it into a buzz)
    const n = Math.floor(rand(10, 15));
    const rate = rand(11, 14);
    let t = t0;
    for (let i = 0; i < n; i++) {
      const src = a._noiseSrc(t, 0.03);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = rand(1000, 1400); bp.Q.value = 0.8;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.9 * (1 - i / (n * 1.6)), t + 0.0015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
      src.connect(bp).connect(g).connect(out);
      t += (1 / rate) * (1 + i * 0.012) * (0.92 + Math.random() * 0.16);
    }
  }
}
