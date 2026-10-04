// Shared combatant state used by the player and AI characters.
import * as THREE from 'three';
import { CONFIG } from './config.js';

let nextId = 1;

export function eyeHeightFor(stance) {
  const P = CONFIG.player;
  return stance === 'prone' ? P.eyeProne : stance === 'crouch' ? P.eyeCrouch : P.eyeStand;
}

export class Combatant {
  constructor({ name, team, isPlayer = false }) {
    this.id = nextId++;
    this.name = name;
    this.team = team;
    this.isPlayer = isPlayer;
    this.alive = true;
    this.health = CONFIG.player.health;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.stance = 'stand';
    this.eye = eyeHeightFor('stand');   // smoothed eye height
    this.scoped = false;
    this.scopeT = 0;
    this.lastShotTime = -100;
    this.boltReadyTime = 0;
    this.speed = 0;
    this.character = null;              // ghillie visual (AI + player body)
    this.shotsFired = 0;
    this.hits = 0;
    this.longestHit = 0;
    this.kills = 0;
  }

  eyePos(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.pos.y + this.eye, this.pos.z);
  }

  // Forward direction from yaw/pitch (yaw 0 looks toward -Z).
  aimDir(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  // Scope lens position (source of glint)
  scopePos(out = new THREE.Vector3()) {
    const d = this.aimDir(_tmp);
    return this.eyePos(out).addScaledVector(d, 0.35);
  }

  muzzlePos(out = new THREE.Vector3()) {
    const d = this.aimDir(_tmp);
    return this.eyePos(out).addScaledVector(d, 1.05).add(_tmp2.set(0, -0.06, 0));
  }

  centerPos(out = new THREE.Vector3()) {
    const h = this.stance === 'prone' ? 0.25 : this.stance === 'crouch' ? 0.65 : 1.05;
    return out.set(this.pos.x, this.pos.y + h, this.pos.z);
  }

  boltReady(time) { return time >= this.boltReadyTime; }
}

const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();

export function yawPitchTo(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const h = Math.hypot(dx, dz);
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, h) };
}

export function angleBetween(a, b) {
  return Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
}
