// DOM HUD: crosshair, team status, zone timer, compass, health, bolt + glint status,
// "being aimed at" warning, kill feed, teammate markers, overlays (start/pause/settings/end).
import * as THREE from 'three';
import { CONFIG, DEFAULT_BINDS, saveRenderSettings } from './config.js';
import { keyLabel } from './input.js';

const ACTION_LABELS = {
  forward: 'Move forward', back: 'Move back', left: 'Strafe left', right: 'Strafe right',
  sprint: 'Sprint · hold breath while scoped', jump: 'Jump / stand up', crouch: 'Crouch', prone: 'Prone',
  scope: 'Scope (hold)', fire: 'Fire (bolt cycles 1.5 s)', scores: 'Scoreboard (hold)', restart: 'Restart (single player)',
};

const $ = (id) => document.getElementById(id);

export class HUD {
  constructor() {
    const hud = $('hud');
    hud.innerHTML = `
      <div id="markers" class="hud-el"></div>
      <div id="crosshair" class="hud-el"></div>
      <div id="hitmarker" class="hud-el"></div>
      <div id="topbar" class="hud-el">
        <div class="score friend" id="score-f"></div>
        <div class="team friend" id="team-f"></div>
        <div id="zonebox"><span class="label" id="roundtext">ZONE</span><span id="zonetext">--</span></div>
        <div class="team enemy" id="team-e"></div>
        <div class="score enemy" id="score-e"></div>
      </div>
      <div id="compass" class="hud-el"><div class="strip" id="compass-strip"></div></div>
      <div id="compass-mark" class="hud-el"></div>
      <div id="aimed" class="hud-el">⚠ YOU ARE BEING AIMED AT</div>
      <div id="outside" class="hud-el">OUTSIDE ZONE</div>
      <div id="center-msg" class="hud-el"></div>
      <div id="kcmark" class="hud-el"><div class="br"></div><span></span></div>
      <div id="killcam" class="hud-el"></div>
      <div id="scoreboard" class="hud-el"></div>
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
    const opt = (vals) => vals.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
    const onoff = opt([['1', 'on'], ['0', 'off']]);
    const settings = `
      <div class="tabs">
        <button class="tab on" data-tab="controls">CONTROLS</button><button class="tab" data-tab="match">MATCH</button><button class="tab" data-tab="graphics">GRAPHICS</button><button class="tab" data-tab="audio">AUDIO</button>
      </div>
      <div class="tabpage on" data-page="controls">
        <div class="settings">
          <label>Mouse sensitivity</label><div class="rng"><input id="set-sens" type="range" min="0.2" max="3" step="0.05"><span id="set-sens-v"></span></div>
          <label>Scope sensitivity</label><div class="rng"><input id="set-ssens" type="range" min="0.3" max="2" step="0.05"><span id="set-ssens-v"></span></div>
          <label>Field of view</label><div class="rng"><input id="set-fov" type="range" min="60" max="100" step="1"><span id="set-fov-v"></span></div>
          <label>Invert mouse Y</label><select id="set-invy">${opt([['0', 'off'], ['1', 'on']])}</select>
        </div>
        <div class="settings binds" id="set-binds"></div>
        <div class="controls fixed">
          <b>Mouse</b><span>look (arrow keys if pointer lock is unavailable)</span>
          <b>Esc</b><span>pause / settings</span>
          <b>T · F1 · F2</b><span>debug: skip zone step · debug info · reveal all characters</span>
        </div>
        <div class="btnrow small"><button id="set-bindreset">RESET KEYS</button></div>
      </div>
      <div class="tabpage" data-page="match">
        <div class="settings">
          <label>Team size</label><select id="set-team">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n}v${n}</option>`).join('')}</select>
          <label>Rounds to win</label><select id="set-rounds">${opt([['1', '1 (single round)'], ['2', '2 (best of 3)'], ['3', '3 (best of 5)'], ['4', '4 (best of 7)']])}</select>
          <label>Swap sides each round</label><select id="set-swap">${onoff}</select>
          <label>Zone mode</label><select id="set-zone">${opt([['ends', 'ends (closes from valley ends)'], ['radial', 'radial (toward the water)']])}</select>
          <label>Camouflage</label><input id="set-camo" type="range" min="0" max="1" step="0.05">
          <label>Tracers</label><select id="set-tracers">${opt([['off', 'off'], ['faint', 'faint'], ['bright', 'bright']])}</select>
          <label>Ballistics</label><select id="set-ball">${opt([['0', 'hitscan'], ['1', 'travel time + drop + wind']])}</select>
        </div>
        <div class="note">Match settings apply when a new match starts.</div>
      </div>
      <div class="tabpage" data-page="graphics">
        <div class="settings">
          <label>Render scale</label><div class="rng"><input id="set-scale" type="range" min="0.5" max="1" step="0.05"><span id="set-scale-v"></span></div>
          <label>Auto resolution</label><select id="set-autores">${opt([['1', 'on (keeps ~60 fps)'], ['0', 'off']])}</select>
          <label>Shadows</label><select id="set-shadow"><option>off</option><option>low</option><option>medium</option><option>high</option></select>
          <label>Ambient occlusion</label><select id="set-ao">${onoff}</select>
          <label>Bloom</label><select id="set-bloom">${onoff}</select>
          <label>Sun shafts</label><select id="set-shafts">${onoff}</select>
          <label>Water reflections</label><select id="set-refl">${onoff}</select>
          <label>MSAA (reload)</label><select id="set-msaa">${opt([['4', '4x'], ['0', 'off']])}</select>
          <label>Grass density (reload)</label><input id="set-grass" type="range" min="0" max="1.5" step="0.1">
        </div>
        <div class="note">Graphics settings are saved in this browser. <a href="?bench" class="link">Run the benchmark</a> to measure frame rates on this PC.</div>
      </div>
      <div class="tabpage" data-page="audio">
        <div class="settings">
          <label>Master volume</label><div class="rng"><input id="set-vmaster" type="range" min="0" max="1" step="0.05"><span id="set-vmaster-v"></span></div>
          <label>Effects</label><div class="rng"><input id="set-vfx" type="range" min="0" max="1.5" step="0.05"><span id="set-vfx-v"></span></div>
          <label>Ambience</label><div class="rng"><input id="set-vamb" type="range" min="0" max="1.5" step="0.05"><span id="set-vamb-v"></span></div>
          <label>Valley echo</label><select id="set-echo">${onoff}</select>
        </div>
      </div>`;
    this.startScreen = make('startscreen', `<div class="panel">
      <h1>SNIPER<span>YARD</span></h1>
      <div class="sub">PROTOTYPE · TEAM SNIPER ELIMINATION · ONE SHOT, ONE KILL</div>
      <div id="lanbox" class="lan" style="display:none">
        <h2>LAN MULTIPLAYER</h2>
        <div class="settings">
          <label>Your name</label><input id="lan-name" maxlength="12" placeholder="NAME">
          <label>Team</label><select id="lan-team"><option value="auto">auto-balance</option><option value="0">ALPHA</option><option value="1">BRAVO</option></select>
          <label>Fill empty slots with AI</label><select id="lan-ai"><option value="1">on (up to the team size in MATCH)</option><option value="0">off (players only)</option></select>
        </div>
        <div id="lan-list" class="lanlist"></div>
        <div class="btnrow">
          <button id="btn-host">HOST GAME</button><button id="btn-join">JOIN GAME</button>
          <button class="primary" id="btn-mpstart" style="display:none">START MATCH</button><button id="btn-leave" style="display:none">LEAVE</button>
        </div>
        <div class="note" id="lan-note"></div>
      </div>
      ${settings.replace(/id="set-/g, 'id="s0-')}
      <div class="btnrow"><button class="primary" id="btn-play">SINGLE PLAYER</button></div>
    </div>`);
    this.pauseScreen = make('pausescreen', `<div class="panel">
      <h1>PAUSED</h1>
      <div class="sub">CLICK RESUME TO RE-LOCK THE MOUSE</div>
      ${settings.replace(/id="set-/g, 'id="s1-')}
      <div class="btnrow"><button class="primary" id="btn-resume">RESUME</button><button id="btn-restart">RESTART MATCH</button><button id="btn-leavegame" style="display:none">LEAVE GAME</button></div>
    </div>`);
    this.endScreen = make('endscreen', `<div class="panel">
      <h1 id="end-title">VICTORY</h1>
      <div class="sub" id="end-sub"></div>
      <div class="stats" id="end-stats"></div>
      <div class="btnrow" style="justify-content:center"><button class="primary" id="btn-again">NEW MATCH (R)</button></div>
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
  bindSettings(onChange, input) {
    const C = CONFIG;
    const fmt = { sens: (v) => `${(+v).toFixed(2)}×`, ssens: (v) => `${(+v).toFixed(2)}×`, fov: (v) => `${v}°`, scale: (v) => `${Math.round(v * 100)}%`,
      vmaster: (v) => `${Math.round(v * 100)}%`, vfx: (v) => `${Math.round(v * 100)}%`, vamb: (v) => `${Math.round(v * 100)}%` };
    const syncAll = () => { this.sync_s0(); this.sync_s1(); };
    for (const p of ['s0', 's1']) {
      const g = (k) => $(`${p}-${k}`);
      const panel = g('team').closest('.panel');
      // tabs
      panel.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
        panel.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
        panel.querySelectorAll('.tabpage').forEach((x) => x.classList.toggle('on', x.dataset.page === t.dataset.tab));
      }));
      const renderBinds = () => {
        const B = C.controls.binds;
        g('binds').innerHTML = Object.keys(B).map((a) =>
          `<label>${ACTION_LABELS[a] || a}</label><div><button class="bind" data-act="${a}">${B[a].length ? B[a].map(keyLabel).join(' / ') : '-'}</button></div>`).join('');
        g('binds').querySelectorAll('.bind').forEach((btn) => btn.addEventListener('click', () => {
          btn.textContent = 'PRESS A KEY…';
          btn.classList.add('wait');
          input.capture = (code) => {
            if (code) {
              // a key drives one action only (an action left without a key shows "-")
              for (const k in B) B[k] = B[k].filter((c) => c !== code);
              B[btn.dataset.act] = [code];
              saveRenderSettings();
            }
            syncAll();
          };
        }));
      };
      const sync = () => {
        g('team').value = String(C.teams.size);
        g('rounds').value = String(C.match.roundsToWin);
        g('swap').value = C.match.swapSides ? '1' : '0';
        g('zone').value = C.zone.mode;
        g('camo').value = String(C.camouflageStrength);
        g('tracers').value = C.weapon.tracers;
        g('ball').value = C.weapon.ballistics.enabled ? '1' : '0';
        g('sens').value = String(C.controls.sensitivity);
        g('ssens').value = String(C.controls.scopeSensitivity);
        g('fov').value = String(C.player.fovHip);
        g('invy').value = C.controls.invertY ? '1' : '0';
        g('scale').value = String(C.render.renderScale);
        g('autores').value = C.render.autoResolution ? '1' : '0';
        g('shadow').value = C.render.shadowQuality;
        g('ao').value = C.render.ao ? '1' : '0';
        g('bloom').value = C.render.bloom ? '1' : '0';
        g('shafts').value = C.render.sunShafts ? '1' : '0';
        g('refl').value = C.render.reflections ? '1' : '0';
        g('msaa').value = String(C.render.msaa);
        g('grass').value = String(C.render.grassDensity);
        g('vmaster').value = String(C.audio.master);
        g('vfx').value = String(C.audio.effects);
        g('vamb').value = String(C.audio.ambience);
        g('echo').value = C.audio.echo ? '1' : '0';
        for (const k in fmt) { const el = g(`${k}-v`); if (el) el.textContent = fmt[k](g(k).value); }
        renderBinds();
      };
      this[`sync_${p}`] = sync;
      const on = (k, fn, ev = 'change') => g(k).addEventListener(ev, () => { fn(g(k).value); saveRenderSettings(); syncAll(); onChange(k); });
      on('team', (v) => { C.teams.size = parseInt(v, 10); });
      on('rounds', (v) => { C.match.roundsToWin = parseInt(v, 10); });
      on('swap', (v) => { C.match.swapSides = v === '1'; });
      on('zone', (v) => { C.zone.mode = v; });
      on('camo', (v) => { C.camouflageStrength = parseFloat(v); });
      on('tracers', (v) => { C.weapon.tracers = v; });
      on('ball', (v) => { C.weapon.ballistics.enabled = v === '1'; });
      on('sens', (v) => { C.controls.sensitivity = parseFloat(v); }, 'input');
      on('ssens', (v) => { C.controls.scopeSensitivity = parseFloat(v); }, 'input');
      on('fov', (v) => { C.player.fovHip = parseInt(v, 10); }, 'input');
      on('invy', (v) => { C.controls.invertY = v === '1'; });
      on('scale', (v) => { C.render.renderScale = parseFloat(v); });
      on('autores', (v) => { C.render.autoResolution = v === '1'; });
      on('shadow', (v) => { C.render.shadowQuality = v; });
      on('ao', (v) => { C.render.ao = v === '1'; });
      on('bloom', (v) => { C.render.bloom = v === '1'; });
      on('shafts', (v) => { C.render.sunShafts = v === '1'; });
      on('refl', (v) => { C.render.reflections = v === '1'; });
      on('msaa', (v) => { C.render.msaa = parseInt(v, 10); });
      on('grass', (v) => { C.render.grassDensity = parseFloat(v); });
      on('vmaster', (v) => { C.audio.master = parseFloat(v); }, 'input');
      on('vfx', (v) => { C.audio.effects = parseFloat(v); }, 'input');
      on('vamb', (v) => { C.audio.ambience = parseFloat(v); }, 'input');
      on('echo', (v) => { C.audio.echo = v === '1'; });
      g('bindreset').addEventListener('click', () => {
        C.controls.binds = JSON.parse(JSON.stringify(DEFAULT_BINDS));
        saveRenderSettings();
        syncAll();
      });
    }
    syncAll();
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

  clearCenter() { this.el.center.classList.remove('on'); this.centerTimer = 0; }

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

  // Killcam panel (title + reveal lines) and a bracket around the shooter on screen.
  setKillcam(kc, mark) {
    const panel = $('killcam'), m = $('kcmark');
    if (!kc) { panel.classList.remove('on'); } else {
      if (this._kc !== kc) {
        this._kc = kc;
        panel.innerHTML = `<div class="t">${kc.title}</div>${kc.lines.map(([k, v]) => `<div class="l"><span>${k}</span>${v}</div>`).join('')}`;
      }
      panel.classList.add('on');
    }
    if (kc && mark) {
      m.style.display = 'block';
      m.style.left = `${mark.x}px`;
      m.style.top = `${mark.y}px`;
      m.lastElementChild.textContent = mark.name;
    } else m.style.display = 'none';
  }

  // Hold-to-show scoreboard: rows = [{ name, team, alive, kills, human, me }]
  setScoreboard(on, rows, myTeam, score) {
    const el = $('scoreboard');
    el.classList.toggle('on', on);
    if (!on) return;
    const names = CONFIG.teams.names;
    const col = (t) => {
      const list = rows.filter((r) => r.team === t);
      return `<div class="col ${t === myTeam ? 'f' : 'e'}"><div class="h">${names[t]} · ${score[t]}</div>${list.map((r) =>
        `<div class="r ${r.alive ? '' : 'dead'} ${r.me ? 'me' : ''}"><span>${r.name}${r.human ? '' : ' <i>AI</i>'}</span><span>${r.kills}</span></div>`).join('')}</div>`;
    };
    el.innerHTML = `<div class="sh"><span>PLAYER</span><span>ROUND KILLS</span></div><div class="cols">${col(myTeam)}${col(1 - myTeam)}</div>`;
  }

  setScore(mine, theirs, round, toWin) {
    const key = `${mine}|${theirs}|${round}|${toWin}`;
    if (key === this._lastScore) return;
    this._lastScore = key;
    const multi = toWin > 1;
    $('score-f').textContent = multi ? mine : '';
    $('score-e').textContent = multi ? theirs : '';
    $('roundtext').textContent = multi ? `ROUND ${round + 1} · FIRST TO ${toWin}` : 'ZONE';
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
      if (CONFIG.debug.showFps) this.el.fps.textContent = `${this.fpsShown} FPS${this.fpsExtra || ''}`;
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
      el.style.borderColor = c.team === this.localTeam ? '#5fb3ff' : '#ff3';
      el.firstElementChild.textContent = `${c.name} ${c.ai ? c.ai.state : ''}`;
    });
  }

  setDebug(text, on) {
    this.el.debug.style.display = on ? 'block' : 'none';
    if (on) this.el.debug.textContent = text;
  }
}
