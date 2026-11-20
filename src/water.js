// River water: planar reflection (three's Reflector with a custom shader), fresnel,
// depth-based colour/transparency from the terrain heightmap, flowing normals and sun glints.
import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { CONFIG } from './config.js';
import { SHARED } from './shaders.js';
import { cloudUniforms, CLOUD_FUNCTIONS } from './weather.js';

const WaterShader = {
  name: 'RiverWater',
  uniforms: THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      color: { value: null },
      tDiffuse: { value: null },
      textureMatrix: { value: null },
      tNormal: { value: null },
      tNoise: { value: null },
      tHeight: { value: null },
      uHB: { value: new THREE.Vector4() },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3() },
      uSunColor: { value: new THREE.Color() },
      uDeep: { value: new THREE.Color(0.008, 0.022, 0.02) },
      uShallow: { value: new THREE.Color(0.05, 0.075, 0.055) },
      uSkyColor: { value: new THREE.Color(0.35, 0.45, 0.55) },
      uReflStrength: { value: 1 },
    },
  ]),
  vertexShader: /* glsl */`
    uniform mat4 textureMatrix;
    varying vec4 vUvR;
    varying vec3 vWPos;
    #include <fog_pars_vertex>
    void main() {
      vUvR = textureMatrix * vec4(position, 1.0);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWPos = wp.xyz;
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tNormal;
    uniform sampler2D tNoise;     // the water bake's height (fbm noise) in alpha: foam and streaks
    uniform sampler2D tHeight;
    uniform vec4 uHB;
    uniform float uTime;
    uniform vec3 uSunDir;
    uniform vec3 uSunColor;
    uniform vec3 uDeep;
    uniform vec3 uShallow;
    uniform vec3 uSkyColor;
    uniform float uReflStrength;
    varying vec4 vUvR;
    varying vec3 vWPos;
    #include <fog_pars_fragment>
    ${CLOUD_FUNCTIONS}
    void main() {
      vec2 p = vWPos.xz;
      float bed = texture2D(tHeight, (p - uHB.xy) / uHB.zw).r;
      float depth = max(0.0, -bed);
      float dCam = length(cameraPosition - vWPos);
      // v5: a strong current flowing toward -X. Ripples on four scales (fine ones fade out with
      // distance so the far water calms to a mirror instead of shimmering)
      vec2 flow = vec2(0.45, 0.04);
      float fast = smoothstep(0.5, 2.0, depth);
      vec3 n1 = texture2D(tNormal, p / 9.0 + flow * uTime * (0.25 + 0.3 * fast)).xyz * 2.0 - 1.0;
      vec3 n2 = texture2D(tNormal, p / 3.7 - vec2(0.03, 0.06) * uTime + flow * uTime * (0.3 + 0.35 * fast)).xyz * 2.0 - 1.0;
      vec3 n3 = texture2D(tNormal, p / 23.0 + flow * uTime * 0.16).xyz * 2.0 - 1.0;
      vec3 n4 = texture2D(tNormal, p / 1.3 + vec2(0.07, -0.05) * uTime + flow * uTime * 0.8).xyz * 2.0 - 1.0;
      float nearK = 1.0 - smoothstep(15.0, 90.0, dCam);
      vec3 tn = normalize(n1 * 0.5 + n2 * 0.35 * (0.4 + 0.6 * nearK) + n3 * 0.4 + n4 * 0.22 * nearK + vec3(0.0, 0.0, 1.9));
      vec3 N = normalize(vec3(tn.x, tn.z, tn.y));
      vec3 V = normalize(cameraPosition - vWPos);
      float NdV = max(dot(N, V), 0.0);
      float fres = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
      // reflection, distorted by the ripples
      vec2 dist = tn.xy * (0.03 + 0.02 * nearK);
      vec4 uvr = vUvR;
      uvr.xy += dist * uvr.w;
      vec3 refl = texture2DProj(tDiffuse, uvr).rgb;
      refl = mix(uSkyColor, refl, uReflStrength);
      // a forest river is dark where it mirrors its banks at low angles
      vec3 R = reflect(-V, N);
      float bank = smoothstep(0.22, 0.03, R.y);
      refl = mix(refl, refl * vec3(0.45, 0.52, 0.45) + vec3(0.01, 0.015, 0.01), bank * 0.4);
      // water body: dark tea-green, deeper = darker; light scattered inside the wave crests
      vec3 body = mix(uShallow, uDeep, 1.0 - exp(-depth * 0.9));
      float crest = clamp(dot(N, normalize(uSunDir + vec3(0.0, 0.3, 0.0))) - 0.82, 0.0, 1.0) * 5.0;
      body += vec3(0.03, 0.06, 0.045) * crest * (1.0 - cloudCoverAt(vWPos) * 0.7);
      float sunR = max(dot(reflect(-uSunDir, N), V), 0.0);
      float sunVis = 1.0 - cloudCoverAt(vWPos) * 0.9;
      vec3 spec = uSunColor * (pow(sunR, 600.0) * 9.0 + pow(sunR, 90.0) * 0.4 + pow(sunR, 12.0) * 0.03) * sunVis;
      vec3 col = mix(body, refl, fres * 0.9) + spec;
      // shoreline foam and the riverbed showing through the shallows
      float foamN = texture2D(tNoise, p / 1.7 + flow * uTime * 0.3).a;
      float foam = smoothstep(0.14, 0.0, depth) * smoothstep(0.45, 0.65, foamN);
      col = mix(col, vec3(0.62, 0.64, 0.6), foam * 0.4);
      // streaks of white water racing down the deep channel: the current is dangerous
      float streak = smoothstep(0.66, 0.8, texture2D(tNoise, vec2(p.x / 7.0 + uTime * 0.32, p.y / 1.1 + n3.x * 0.15)).a)
                   * smoothstep(0.8, 2.0, depth);
      float streak2 = smoothstep(0.7, 0.82, texture2D(tNoise, vec2(p.x / 3.1 + uTime * 0.55, p.y / 0.7 + n1.y * 0.2)).a) * smoothstep(1.0, 2.2, depth) * nearK;
      col = mix(col, vec3(0.62, 0.66, 0.64), clamp(streak * 0.22 + streak2 * 0.16, 0.0, 0.3));
      float alpha = clamp(1.0 - exp(-depth * 2.6), 0.0, 1.0);
      alpha = max(alpha, fres * 0.95);
      alpha = clamp(alpha + foam * 0.3, 0.0, 1.0);
      alpha *= smoothstep(0.0, 0.03, depth);
      gl_FragColor = vec4(col, alpha);
      #include <fog_fragment>
    }`,
};

export class Water {
  constructor(scene, terrain, textures, renderer) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    // Reflector uses local +Z as the mirror normal, so rotate the mesh (not the geometry).
    const geo = new THREE.PlaneGeometry(CONFIG.map.terrainExtent * 1.1, 220, 1, 1);
    this.reflector = new Reflector(geo, {
      textureWidth: 512,
      textureHeight: 512,
      clipBias: 0.02,
      shader: WaterShader,
      multisample: 0,
    });
    const r = this.reflector;
    r.rotation.x = -Math.PI / 2;
    r.position.y = CONFIG.map.waterLevel;
    r.material.transparent = true;
    r.material.fog = true;
    r.material.depthWrite = false;
    r.renderOrder = 1;
    const u = r.material.uniforms;
    Object.assign(u, cloudUniforms());
    u.tNormal.value = textures.water.normalMap;
    u.tNoise.value = textures.water.map;
    u.tHeight.value = terrain.heightTexture;
    u.uHB.value = terrain.gridBounds;
    u.uSunDir.value = SHARED.uSunDirWorld.value;
    u.uSunColor.value = SHARED.uSunColor.value;
    this.uniforms = u;
    this.enabled = CONFIG.render.reflections;
    // Skip the reflection render when disabled, and hide expensive/irrelevant objects during it.
    const origBefore = r.onBeforeRender.bind(r);
    this.hideDuringReflection = [];
    this.showDuringReflection = [];
    r.onBeforeRender = (rend, sc, cam) => {
      if (!this.enabled) return;
      this._frame = (this._frame || 0) + 1;
      const hidden = [];
      for (const o of this.hideDuringReflection) { if (o.visible) { o.visible = false; hidden.push(o); } }
      for (const o of this.showDuringReflection) o.visible = true;
      origBefore(rend, sc, cam);
      for (const o of this.showDuringReflection) o.visible = false;
      for (const o of hidden) o.visible = true;
    };
    scene.add(r);
  }

  setQuality(enabled, pixelWidth) {
    this.enabled = enabled;
    this.uniforms.uReflStrength.value = enabled ? 1 : 0;
    const rt = this.reflector.getRenderTarget();
    const w = Math.max(256, Math.round(pixelWidth * 0.5));
    rt.setSize(w, Math.round(w * 0.6));
  }

  update(time) {
    this.uniforms.uTime.value = time;
  }
}
