// DOM HUD: crosshair, team status, zone timer, compass, health, bolt + glint status,
// "being aimed at" warning, kill feed, teammate markers, overlays (start/pause/settings/end).
import * as THREE from 'three';
import { CONFIG, saveRenderSettings } from './config.js';

const $ = (id) => document.getElementById(id);

export class HUD {
  constructor() {
    const hud = $('hud');
    hud.innerHTML = `
      <div id="markers" class="hud-el"></div>
      <div id="crosshair" class="hud-el"></div>
      <div id="hitmarker" class="hud-el"></div>
      <div id="topbar" class="hud-el">
        <div class="team friend" id="team-f"></div>
        <div id="zonebox"><span class="label">ZONE</span><span id="zonetext">--</span></div>
        <div class="team enemy" id="team-e"></div>
      </div>
      <div id="compass" class="hud-el"><div class="strip" id="compass-strip"></div></div>
      <div id="compass-mark" class="hud-el"></div>
      <div id="aimed" class="hud-el">⚠ YOU ARE BEING AIMED AT</div>
      <div id="outside" class="hud-el">OUTSIDE ZONE</div>
      <div id="center-msg" class="hud-el"></div>
      <div id="killfeed" class="hud-el"></div>
      <div id="status" class="hud-el">
        <div style="font-size:13px;letter-spacing:.14em;color:var(--dim)">HEALTH <span id="hpnum">100</span></div>
        <div id="health"><div></div></div>
        <div id="stance">STANDING</div>
      </div>
      <div id="weapon" class="hud-el">
        <div id="bolt">BOLT READY</div>
        <div id="boltbar"><div></div></div>
        <div id="glint"><span id="glinttext">GLINT OFF</span><span class="dot"></span></div>
        <div id="breath"></div>
      </div>
      <div id="fps" class="hud-el"></div>
      <div id="debug" class="hud-el"></div>
    `;
    this.el = {
      crosshair: $('crosshair'), hit: $('hitmarker'), teamF: $('team-f'), teamE: $('team-e'),
      zonebox: $('zonebox'), zonetext: $('zonetext'), compass: $('compass-strip'), aimed: $('aimed'),
      outside: $('outside'), center: $('center-msg'), killfeed: $('killfeed'), health: $('health'),
      hpnum: $('hpnum'), stance: $('stance'), bolt: $('bolt'), boltbar: $('boltbar').firstElementChild,
      glint: $('glint'), glinttext: $('glinttext'), breath: $('breath'), fps: $('fps'), debug: $('debug'),
      markers: $('markers'),
    };
    this._buildCompass();
    this._buildOverlays();
    this.markerEls = new Map();
    this.debugEls = [];
    this.fpsAcc = 0; this.fpsFrames = 0; this.fpsShown = 0;
    this._v = new THREE.Vector3();
    this.centerTimer = 0;
  }

  _buildCompass() {
    const strip = this.el.compass;
    // 0 deg = north, clockwise. 3 copies for wrap.
    const labels = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    let html = '';
    for (let c = -1; c <= 1; c++) {
      for (let d = 0; d < 360; d += 15) {
        const x = (c * 360 + d) * 3;
        const lab = labels[d];
        html += `<span class="tick ${lab ? 'major' : ''}" style="left:${x}px">${lab || '|'}</span>`;
      }
    }
    strip.innerHTML = html;
  }

  _buildOverlays() {
    const make = (id, inner) => {
      const d = document.createElement('div');
      d.id = id; d.className = 'overlay';
      d.innerHTML = inner;
      document.body.appendChild(d);
      return d;
    };
    const controls = `
      <div class="controls">
        <b>WASD</b><span>move</span>
        <b>Mouse</b><span>look (arrow keys if pointer lock is unavailable)</span>
        <b>Shift</b><span>sprint · hold while scoped to steady your breath</span>
        <b>Space</b><span>jump / stand up</span>
        <b>C / Ctrl</b><span>crouch</span>
        <b>Z</b><span>prone</span>
        <b>Right mouse</b><span>hold to scope</span>
        <b>Left mouse</b><span>fire (bolt cycles 1.5 s)</span>
        <b>R</b><span>restart round</span>
        <b>T</b><span>debug: skip to next zone step</span>
        <b>F1</b><span>debug info &nbsp; <b>F2</b> debug: reveal all characters</span>
        <b>Esc</b><span>pause / settings</span>
      </div>`;
    const settings = `
      <h2>MATCH</h2>
      <div class="settings">
        <label>Team size</label><select id="set-team">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n}v${n}</option>`).join('')}</select>
        <label>Zone mode</label><select id="set-zone"><option value="ends">ends (closes from valley ends)</option><option value="radial">radial (toward the water)</option></select>
        <label>Camouflage</label><input id="set-camo" type="range" min="0" max="1" step="0.05">
        <label>Tracers</label><select id="set-tracers"><option value="off">off</option><option value="faint">faint</option><option value="bright">bright</option></select>
        <label>Ballistics</label><select id="set-ball"><option value="0">hitscan</option><option value="1">travel time + drop + wind</option></select>
      </div>
      <h2>GRAPHICS</h2>
      <div class="settings">
        <label>Render scale</label><input id="set-scale" type="range" min="0.5" max="1" step="0.05">
        <label>Shadows</label><select id="set-shadow"><option>off</option><option>low</option><option>medium</option><option>high</option></select>
        <label>Ambient occlusion</label><select id="set-ao"><option value="1">on</option><option value="0">off</option></select>
        <label>Bloom</label><select id="set-bloom"><option value="1">on</option><option value="0">off</option></select>
        <label>Water reflections</label><select id="set-refl"><option value="1">on</option><option value="0">off</option></select>
        <label>MSAA (reload)</label><select id="set-msaa"><option value="4">4x</option><option value="0">off</option></select>
        <label>Grass density (reload)</label><input id="set-grass" type="range" min="0" max="1.5" step="0.1">
      </div>
      <div class="note">Match settings apply when the round restarts. Graphics settings are saved in this browser.</div>`;
    this.startScreen = make('startscreen', `<div class="panel">
      <h1>SNIPER<span>YARD</span></h1>
      <div class="sub">PROTOTYPE · TEAM SNIPER ELIMINATION · ONE SHOT, ONE KILL</div>
      ${controls}
      ${settings.replace(/id="set-/g, 'id="s0-')}
      <div class="btnrow"><button class="primary" id="btn-play">CLICK TO DEPLOY</button></div>
    </div>`);
    this.pauseScreen = make('pausescreen', `<div class="panel">
      <h1>PAUSED</h1>
      <div class="sub">CLICK RESUME TO RE-LOCK THE MOUSE</div>
      ${controls}
      ${settings.replace(/id="set-/g, 'id="s1-')}
      <div class="btnrow"><button class="primary" id="btn-resume">RESUME</button><button id="btn-restart">RESTART ROUND</button></div>
    </div>`);
    this.endScreen = make('endscreen', `<div class="panel">
      <h1 id="end-title">VICTORY</h1>
      <div class="sub" id="end-sub"></div>
      <div class="stats" id="end-stats"></div>
      <div class="btnrow" style="justify-content:center"><button class="primary" id="btn-again">PRESS R TO RESTART</button></div>
    </div>`);
    this.loading = document.createElement('div');
    this.loading.id = 'loading';
    this.loading.innerHTML = `<div class="t">SNIPERYARD</div><div class="s" id="loading-s">LOADING</div>`;
    document.body.appendChild(this.loading);
  }

  setLoading(text) {
    if (text === null) { this.loading.style.display = 'none'; return; }
    $('loading-s').textContent = text;
  }

  // Wire settings controls (prefix s0 = start, s1 = pause). onChange(kind) is called.
  bindSettings(onChange) {
    for (const p of ['s0', 's1']) {
      const g = (k) => $(`${p}-${k}`);
      const sync = () => {
        g('team').value = String(CONFIG.teams.size);
        g('zone').value = CONFIG.zone.mode;
        g('camo').value = String(CONFIG.camouflageStrength);
        g('tracers').value = CONFIG.weapon.tracers;
        g('ball').value = CONFIG.weapon.ballistics.enabled ? '1' : '0';
        g('scale').value = String(CONFIG.render.renderScale);
        g('shadow').value = CONFIG.render.shadowQuality;
        g('ao').value = CONFIG.render.ao ? '1' : '0';
        g('bloom').value = CONFIG.render.bloom ? '1' : '0';
        g('refl').value = CONFIG.render.reflections ? '1' : '0';
        g('msaa').value = String(CONFIG.render.msaa);
        g('grass').value = String(CONFIG.render.grassDensity);
      };
      sync();
      this[`sync_${p}`] = sync;
      const on = (k, fn) => g(k).addEventListener('change', () => { fn(g(k).value); saveRenderSettings(); this.sync_s0(); this.sync_s1(); onChange(k); });
      on('team', (v) => { CONFIG.teams.size = parseInt(v, 10); });
      on('zone', (v) => { CONFIG.zone.mode = v; });
      on('camo', (v) => { CONFIG.camouflageStrength = parseFloat(v); });
      on('tracers', (v) => { CONFIG.weapon.tracers = v; });
      on('ball', (v) => { CONFIG.weapon.ballistics.enabled = v === '1'; });
      on('scale', (v) => { CONFIG.render.renderScale = parseFloat(v); });
      on('shadow', (v) => { CONFIG.render.shadowQuality = v; });
      on('ao', (v) => { CONFIG.render.ao = v === '1'; });
      on('bloom', (v) => { CONFIG.render.bloom = v === '1'; });
      on('refl', (v) => { CONFIG.render.reflections = v === '1'; });
      on('msaa', (v) => { CONFIG.render.msaa = parseInt(v, 10); });
      on('grass', (v) => { CONFIG.render.grassDensity = parseFloat(v); });
    }
  }

  showStart(on) { this.startScreen.classList.toggle('on', on); }
  showPause(on) { this.pauseScreen.classList.toggle('on', on); }
  showEnd(on, victory, sub, stats) {
    this.endScreen.classList.toggle('on', on);
    if (!on) return;
    const t = $('end-title');
    t.textContent = victory ? 'VICTORY' : 'ELIMINATED';
    t.className = victory ? 'victory' : 'defeat';
    $('end-sub').textContent = sub;
    $('end-stats').innerHTML = stats.map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join('');
  }

  centerMessage(text, sub = '', duration = 2) {
    this.el.center.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`;
    this.el.center.classList.add('on');
    this.centerTimer = duration;
  }

  hitMarker(kill) {
    const h = this.el.hit;
    h.classList.toggle('kill', !!kill);
    h.classList.add('on');
    clearTimeout(this._hitT);
    this._hitT = setTimeout(() => h.classList.remove('on'), 60);
  }

  killFeed(text, cls) {
    if (!CONFIG.hud.killFeed) return;
    const d = document.createElement('div');
    d.innerHTML = text;
    if (cls) d.className = cls;
    this.el.killfeed.prepend(d);
    setTimeout(() => d.remove(), 7000);
    while (this.el.killfeed.children.length > 5) this.el.killfeed.lastChild.remove();
  }

  clearKillFeed() { this.el.killfeed.innerHTML = ''; }

  setTeams(friends, enemies) {
    const pips = (list) => list.map((c) => `<div class="pip ${c.alive ? '' : 'dead'}" title="${c.name}"></div>`).join('');
    const f = pips(friends), e = pips(enemies);
    if (f !== this._lastF) { this.el.teamF.innerHTML = f; this._lastF = f; }
    if (e !== this._lastE) { this.el.teamE.innerHTML = e; this._lastE = e; }
  }

  setZone(state) {
    // state: { phase: 'hold'|'warn'|'shrink'|'final', timeLeft, step, steps }
    const box = this.el.zonebox;
    box.classList.toggle('warn', state.phase === 'warn');
    box.classList.toggle('shrink', state.phase === 'shrink');
    const t = Math.max(0, Math.ceil(state.timeLeft));
    const mm = Math.floor(t / 60), ss = String(t % 60).padStart(2, '0');
    let txt;
    if (state.phase === 'hold') txt = `NEXT SHRINK ${mm}:${ss}`;
    else if (state.phase === 'warn') txt = `SHRINKING IN ${t}`;
    else if (state.phase === 'shrink') txt = `ZONE CLOSING ${mm}:${ss}`;
    else txt = 'FINAL ZONE';
    txt += `  ·  ${state.step + 1}/${state.steps}`;
    this.el.zonetext.textContent = txt;
  }

  update(dt, s) {
    // s: { player, scoped, fov, boltT, glint, aimedAt, outside, outsideDps, stance, breath, holdingBreath, yaw }
    this.el.crosshair.classList.toggle('hidden', s.scoped || !s.alive);
    const hp = Math.max(0, Math.round(s.health));
    this.el.hpnum.textContent = hp;
    this.el.health.firstElementChild.style.width = `${hp}%`;
    this.el.health.classList.toggle('low', hp < 35);
    this.el.stance.textContent = `${s.stance === 'prone' ? 'PRONE' : s.stance === 'crouch' ? 'CROUCHED' : 'STANDING'}${s.inWater ? ' · IN WATER (LOUD)' : ''}`;
    const ready = s.boltT >= 1;
    this.el.bolt.textContent = ready ? 'BOLT READY' : 'CYCLING BOLT';
    this.el.bolt.classList.toggle('cycling', !ready);
    this.el.boltbar.style.width = `${Math.min(1, s.boltT) * 100}%`;
    this.el.glint.classList.toggle('on', s.glint);
    this.el.glinttext.textContent = s.glint ? 'YOUR SCOPE GLINTS' : 'GLINT OFF';
    this.el.breath.textContent = s.scoped ? (s.holdingBreath ? 'HOLDING BREATH' : s.breathCooldown ? 'OUT OF BREATH' : 'SHIFT: HOLD BREATH') : '';
    this.el.aimed.classList.toggle('on', !!s.aimedAt && CONFIG.hud.aimedAtWarning);
    this.el.outside.style.display = s.outside ? 'block' : 'none';
    if (s.outside) this.el.outside.textContent = `OUTSIDE ZONE  −${s.outsideDps} HP/s`;
    // compass: north = +Z (toward the ALPHA ridge), east = -X. yaw 0 looks -Z = south.
    let heading = 180 - (s.yaw * 180) / Math.PI;
    heading = ((heading % 360) + 360) % 360;
    this.el.compass.style.left = `${180 - heading * 3}px`;

    if (this.centerTimer > 0) {
      this.centerTimer -= dt;
      if (this.centerTimer <= 0) this.el.center.classList.remove('on');
    }
    // fps
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.fpsShown = Math.round(this.fpsFrames / this.fpsAcc);
      this.fpsAcc = 0; this.fpsFrames = 0;
      if (CONFIG.debug.showFps) this.el.fps.textContent = `${this.fpsShown} FPS`;
    }
  }

  // Teammate markers: small chevrons above friendly heads (player's team only).
  updateMarkers(camera, mates, width, height) {
    const seen = new Set();
    if (CONFIG.hud.teammateMarkers) {
      for (const m of mates) {
        if (!m.alive) continue;
        seen.add(m.id);
        let el = this.markerEls.get(m.id);
        if (!el) {
          el = document.createElement('div');
          el.className = 'mate';
          el.innerHTML = `<div class="name">${m.name}</div><div class="chev"></div>`;
          this.el.markers.appendChild(el);
          this.markerEls.set(m.id, el);
        }
        const p = this._v.set(m.pos.x, m.pos.y + m.eye + 0.6, m.pos.z).project(camera);
        if (p.z > 1 || p.z < -1) { el.style.display = 'none'; continue; }
        el.style.display = 'block';
        const x = Math.min(Math.max((p.x * 0.5 + 0.5) * width, 20), width - 20);
        const y = Math.min(Math.max((-p.y * 0.5 + 0.5) * height, 20), height - 20);
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        const dist = camera.position.distanceTo(m.pos);
        el.firstElementChild.textContent = `${m.name} ${Math.round(dist)}m`;
      }
    }
    for (const [id, el] of this.markerEls) {
      if (!seen.has(id)) { el.remove(); this.markerEls.delete(id); }
    }
  }

  // Debug reveal (F2): circles on every character.
  updateDebugMarks(camera, list, width, height, on) {
    while (this.debugEls.length < list.length) {
      const d = document.createElement('div');
      d.className = 'debugmark';
      d.innerHTML = '<span></span>';
      this.el.markers.appendChild(d);
      this.debugEls.push(d);
    }
    this.debugEls.forEach((el, i) => {
      const c = list[i];
      if (!on || !c || !c.alive) { el.style.display = 'none'; return; }
      const p = this._v.set(c.pos.x, c.pos.y + c.eye * 0.6, c.pos.z).project(camera);
      if (p.z > 1) { el.style.display = 'none'; return; }
      el.style.display = 'block';
      el.style.left = `${(p.x * 0.5 + 0.5) * width}px`;
      el.style.top = `${(-p.y * 0.5 + 0.5) * height}px`;
      el.style.borderColor = c.team === 0 ? '#5fb3ff' : '#ff3';
      el.firstElementChild.textContent = `${c.name} ${c.ai ? c.ai.state : ''}`;
    });
  }

  setDebug(text, on) {
    this.el.debug.style.display = on ? 'block' : 'none';
    if (on) this.el.debug.textContent = text;
  }
}
