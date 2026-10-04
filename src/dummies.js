// Static target dummies for testing shooting and hit detection (milestone 2).
// Enabled with ?dummies=1 (they are always placed in the shooting-range test mode).
import * as THREE from 'three';
import { Combatant, eyeHeightFor } from './entity.js';
import { Hitbox } from './hitbox.js';

const mat = new THREE.MeshStandardMaterial({ color: 0xd8742a, roughness: 0.7 });
const matW = new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: 0.7 });

export class TargetDummy extends Combatant {
  constructor(scene, name, x, z, terrain, stance, yaw) {
    super({ name, team: 1 });
    this.isDummy = true;
    this.pos.set(x, terrain.heightAt(x, z), z);
    this.stance = stance;
    this.eye = eyeHeightFor(stance);
    this.yaw = yaw;
    this.bodyYaw = yaw;
    this.hitbox = new Hitbox();
    this.hitbox.update(this);
    this.group = new THREE.Group();
    // visualise the capsules directly so what you see is exactly what you hit
    for (let i = 0; i < this.hitbox.count; i++) {
      const c = this.hitbox.caps[i];
      const len = c.a.distanceTo(c.b);
      const g = len > 0.01 ? new THREE.CapsuleGeometry(c.r, len, 4, 10) : new THREE.SphereGeometry(c.r, 14, 10);
      const m = new THREE.Mesh(g, i === 0 ? matW : mat);
      m.position.copy(c.a).add(c.b).multiplyScalar(0.5).sub(this.pos);
      if (len > 0.01) m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3().subVectors(c.b, c.a).normalize());
      m.castShadow = true;
      this.group.add(m);
    }
    this.group.position.copy(this.pos);
    scene.add(this.group);
    this.fall = 0;
  }

  update(dt) {
    if (!this.alive && this.fall < 1) {
      this.fall = Math.min(1, this.fall + dt * 2.2);
      this.group.rotation.x = -this.fall * (this.stance === 'prone' ? 0.2 : 1.4);
      this.group.position.y = this.pos.y - this.fall * 0.1;
    }
  }

  dispose(scene) { scene.remove(this.group); }
}
