// Support for a rigged 3D ghillie character (v5), public/models/ghillie.glb. A first model made
// with Higgsfield from a reference photo was tried and not kept (a single-image model is a smooth
// shape with painted leaves), so no model ships for now and the procedural suit is used. Any
// humanoid glTF with a Mixamo-style rig (e.g. a bought, professional asset) can be dropped in.
//
// The game keeps its own procedural skeleton and poses (stand, kneel, prone, aim, walk, dead,
// breathing; characters.js). This file retargets them onto the model's auto-rig every frame:
// each model bone is turned so that it points the way the matching game bone points, measured
// from the rest poses (the model's A-pose to the game's arms-down rest). The hips follow the game
// hips. If the file is missing, the procedural suit is drawn as before.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

let TEMPLATE = null;      // { scene, height } once loaded
let LOADING = null;

function url(file) {
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${base}models/${file}`;
}

// Load the model once (all characters clone it). Resolves to true when it is there.
export function loadGhillieModel() {
  if (LOADING) return LOADING;
  LOADING = (async () => {
    try {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.loadAsync(url('ghillie.glb'));
      let skinned = 0;
      gltf.scene.traverse((o) => {
        if (o.isSkinnedMesh) {
          skinned++;
          const m = o.material;
          if (m.metalness !== undefined) { m.metalness = 0; m.metalnessMap = null; }
          m.envMapIntensity = 0.7;
          m.needsUpdate = true;
        }
      });
      if (!skinned) return false;
      gltf.scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(gltf.scene);
      TEMPLATE = { scene: gltf.scene, height: box.max.y - box.min.y, minY: box.min.y };
      return true;
    } catch (e) {
      return false;
    }
  })();
  return LOADING;
}

export const hasGhillieModel = () => !!TEMPLATE;

// game bone -> candidate model bone names (Meshy / Mixamo-style rigs), first match wins
const MAP = {
  hips: ['Hips', 'mixamorig:Hips', 'hips', 'pelvis', 'Pelvis'],
  spine: ['Spine', 'mixamorig:Spine', 'spine', 'Spine01'],
  chest: ['Spine02', 'Spine2', 'mixamorig:Spine2', 'chest', 'Chest', 'Spine1', 'Spine01'],
  neck: ['neck', 'Neck', 'mixamorig:Neck'],
  head: ['Head', 'head', 'mixamorig:Head'],
  upperArmR: ['RightArm', 'mixamorig:RightArm', 'R_Upperarm', 'upperarm_r', 'Right_Arm'],
  foreArmR: ['RightForeArm', 'mixamorig:RightForeArm', 'R_Forearm', 'lowerarm_r', 'Right_ForeArm'],
  handR: ['RightHand', 'mixamorig:RightHand', 'R_Hand', 'hand_r', 'Right_Hand'],
  upperArmL: ['LeftArm', 'mixamorig:LeftArm', 'L_Upperarm', 'upperarm_l', 'Left_Arm'],
  foreArmL: ['LeftForeArm', 'mixamorig:LeftForeArm', 'L_Forearm', 'lowerarm_l', 'Left_ForeArm'],
  handL: ['LeftHand', 'mixamorig:LeftHand', 'L_Hand', 'hand_l', 'Left_Hand'],
  thighR: ['RightUpLeg', 'mixamorig:RightUpLeg', 'R_Thigh', 'thigh_r', 'Right_UpLeg'],
  shinR: ['RightLeg', 'mixamorig:RightLeg', 'R_Calf', 'calf_r', 'Right_Leg'],
  footR: ['RightFoot', 'mixamorig:RightFoot', 'R_Foot', 'foot_r', 'Right_Foot'],
  thighL: ['LeftUpLeg', 'mixamorig:LeftUpLeg', 'L_Thigh', 'thigh_l', 'Left_UpLeg'],
  shinL: ['LeftLeg', 'mixamorig:LeftLeg', 'L_Calf', 'calf_l', 'Left_Leg'],
  footL: ['LeftFoot', 'mixamorig:LeftFoot', 'L_Foot', 'foot_l', 'Left_Foot'],
};
// which game bone each one points to (its rest direction in the game skeleton)
const AIM = {
  hips: 'spine', spine: 'chest', chest: 'neck', neck: 'head', head: null,
  upperArmR: 'foreArmR', foreArmR: 'handR', handR: null, upperArmL: 'foreArmL', foreArmL: 'handL', handL: null,
  thighR: 'shinR', shinR: 'footR', footR: null, thighL: 'shinL', shinL: 'footL', footL: null,
};
// the game's rest direction of a bone that has no child to point to
const REST_DIR = { head: [0, 1, 0], handR: [0, -1, 0], handL: [0, -1, 0], footR: [0, 0, -1], footL: [0, 0, -1] };

const _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _gq = new THREE.Quaternion(), _tq = new THREE.Quaternion(), _pq = new THREE.Quaternion();

// A retargeted copy of the model for one character. gameBones: the character's game skeleton
// ({ name: THREE.Bone }), restPos: the game bones' rest positions (character space).
export class GhillieModel {
  constructor(gameBones, restPos) {
    this.game = gameBones;
    this.root = new THREE.Group();          // lives in the character group (character space)
    const inner = SkeletonUtils.clone(TEMPLATE.scene);
    // 1.8 m tall, feet on y = 0, facing -Z (glTF characters face +Z)
    const s = 1.8 / TEMPLATE.height;
    inner.scale.setScalar(s);
    inner.rotation.y = Math.PI;
    inner.position.y = -TEMPLATE.minY * s;
    this.root.add(inner);
    this.root.updateMatrixWorld(true);
    this.meshes = [];
    const byName = {};
    inner.traverse((o) => {
      if (o.isBone) byName[o.name] = o;
      if (o.isSkinnedMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false;
        o.material = o.material.clone();
        this.meshes.push(o);
      }
    });
    // find the model bone for each game bone
    this.map = [];
    const used = new Set();
    for (const g of Object.keys(MAP)) {
      const name = MAP[g].find((n) => byName[n] && !used.has(n));
      if (!name) continue;
      used.add(name);
      this.map.push({ g, bone: byName[name] });
    }
    // spine and chest by the hierarchy, not the names (rigs number the spine either way): the
    // spine is the hips' child on the way to the neck, the chest the neck's parent
    const find = (g) => this.map.find((m) => m.g === g);
    const hipsM = find('hips'), neckM = find('neck');
    if (hipsM && neckM) {
      const chestB = neckM.bone.parent;
      let spineB = neckM.bone;
      while (spineB.parent && spineB.parent !== hipsM.bone) spineB = spineB.parent;
      this.map = this.map.filter((m) => m.g !== 'spine' && m.g !== 'chest');
      if (spineB.parent === hipsM.bone && spineB !== chestB) this.map.push({ g: 'spine', bone: spineB });
      this.map.push({ g: 'chest', bone: chestB });
    }
    this.ok = !!hipsM && this.map.length >= 12;
    if (!this.ok) return;
    const rootInv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const worldQ = (o) => { o.updateWorldMatrix(true, false); _m.multiplyMatrices(rootInv, o.matrixWorld); return new THREE.Quaternion().setFromRotationMatrix(_m.extractRotation(_m)); };
    const worldP = (o) => { o.updateWorldMatrix(true, false); return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).applyMatrix4(rootInv); };
    const mapped = Object.fromEntries(this.map.map((m) => [m.g, m.bone]));
    for (const m of this.map) {
      m.restWorldQ = worldQ(m.bone);
      // model rest direction of the bone (to the mapped child, or along its own y axis)
      const child = AIM[m.g] && mapped[AIM[m.g]];
      let dM;
      if (child) dM = worldP(child).sub(worldP(m.bone)).normalize();
      else dM = new THREE.Vector3(0, 1, 0).applyQuaternion(m.restWorldQ).normalize();
      // game rest direction
      let dG;
      if (AIM[m.g]) dG = restPos[AIM[m.g]].clone().sub(restPos[m.g]).normalize();
      else dG = new THREE.Vector3(...(REST_DIR[m.g] || [0, 1, 0]));
      if (!child && REST_DIR[m.g]) dM = dG.clone();   // hands, feet, head: keep their own twist
      m.corr = new THREE.Quaternion().setFromUnitVectors(dM, dG);
    }
    this.hipsBone = mapped.hips;
    this.hipsRestP = worldP(this.hipsBone);
    this.k = this.hipsRestP.y / restPos.hips.y;        // model hips height / game hips height
    // all model bones in hierarchy order, with their rest local rotations
    this.order = [];
    inner.traverse((o) => { if (o.isBone) this.order.push(o); });
    this.restLocal = new Map(this.order.map((b) => [b, b.quaternion.clone()]));
    this.byBone = new Map(this.map.map((m) => [m.bone, m]));
    this.inner = inner;
  }

  // Pose the model like the game skeleton. Call after the game bones are posed and the
  // character group's world matrices are up to date.
  update() {
    if (!this.ok) return;
    const rootW = this.root.matrixWorld;
    // hips position first (children follow it): the game hips, scaled to the model's size
    const hp = _v.setFromMatrixPosition(this.game.hips.matrixWorld).applyMatrix4(_m.copy(rootW).invert()).multiplyScalar(this.k);
    hp.applyMatrix4(rootW);
    const par = this.hipsBone.parent;
    par.updateWorldMatrix(true, false);
    this.hipsBone.position.copy(hp.applyMatrix4(_m.copy(par.matrixWorld).invert()));
    // rotations, parents before children. In world space: game bone world rotation × the
    // rest correction × the model bone's rest rotation (both character space, so the
    // character's own turn comes in once, through the game bone)
    for (const b of this.order) {
      const m = this.byBone.get(b);
      if (m) {
        this.game[m.g].matrixWorld.decompose(_p, _gq, _s);
        _tq.copy(_gq).multiply(m.corr).multiply(m.restWorldQ);
        b.parent.matrixWorld.decompose(_p, _pq, _s);
        b.quaternion.copy(_pq.invert().multiply(_tq));
      }
      b.updateMatrix();
      b.matrixWorld.multiplyMatrices(b.parent.matrixWorld, b.matrix);
    }
  }

  setTint(c) { for (const m of this.meshes) m.material.color.copy(c); }

  dispose() { for (const m of this.meshes) m.material.dispose(); }
}
