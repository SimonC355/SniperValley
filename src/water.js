// River water: planar reflection (three's Reflector with a custom shader), fresnel,
// depth-based colour/transparency from the terrain heightmap, flowing normals and sun glints.
import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { CONFIG } from './config.js';
import { SHARED } from './shaders.js';

const WaterShader = {
  name: 'RiverWater',
  uniforms: THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      color: { value: null },
      tDiffuse: { value: null },
      textureMatrix: { value: null },
      tNormal: { value: null },
      tHeight: { value: null },
      uHB: { value: new THREE.Vector4() },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3() },
      uSunColor: { value: new THREE.Color() },
      uDeep: { value: new THREE.Color(0.012, 0.03, 0.028) },
      uShallow: { value: new THREE.Color(0.06, 0.09, 0.07) },
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
    void main() {
      vec2 p = vWPos.xz;
      float bed = texture2D(tHeight, (p - uHB.xy) / uHB.zw).r;
      float depth = max(0.0, -bed);
      vec2 flow = vec2(0.45, 0.04);
      vec3 n1 = texture2D(tNormal, p / 9.0 + flow * uTime * 0.11).xyz * 2.0 - 1.0;
      vec3 n2 = texture2D(tNormal, p / 3.7 - vec2(0.03, 0.06) * uTime + flow * uTime * 0.17).xyz * 2.0 - 1.0;
      vec3 n3 = texture2D(tNormal, p / 23.0 + flow * uTime * 0.05).xyz * 2.0 - 1.0;
      vec3 tn = normalize(n1 * 0.5 + n2 * 0.35 + n3 * 0.4 + vec3(0.0, 0.0, 2.2));
      vec3 N = normalize(vec3(tn.x, tn.z, tn.y));
      vec3 V = normalize(cameraPosition - vWPos);
      float NdV = max(dot(N, V), 0.0);
      float fres = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
      vec2 dist = tn.xy * 0.035;
      vec4 uvr = vUvR;
      uvr.xy += dist * uvr.w;
      vec3 refl = texture2DProj(tDiffuse, uvr).rgb;
      refl = mix(uSkyColor, refl, uReflStrength);
      vec3 body = mix(uShallow, uDeep, 1.0 - exp(-depth * 0.9));
      float sunR = max(dot(reflect(-uSunDir, N), V), 0.0);
      vec3 spec = uSunColor * (pow(sunR, 380.0) * 6.0 + pow(sunR, 60.0) * 0.25);
      vec3 col = mix(body, refl, fres) + spec;
      // shoreline foam
      float foamN = texture2D(tNormal, p / 1.7 + uTime * 0.05).a;
      float foam = smoothstep(0.12, 0.0, depth) * smoothstep(0.45, 0.65, foamN);
      col = mix(col, vec3(0.55, 0.57, 0.55), foam * 0.35);
      float alpha = clamp(1.0 - exp(-depth * 2.2), 0.0, 1.0);
      alpha = max(alpha, fres * 0.9);
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
    u.tNormal.value = textures.water.normalMap;
    u.tHeight.value = terrain.heightTexture;
    u.uHB.value = terrain.gridBounds;
    u.uSunDir.value = SHARED.uSunDirWorld.value;
    u.uSunColor.value = SHARED.uSunColor.value;
    this.uniforms = u;
    this.enabled = CONFIG.render.reflections;
    // Skip the reflection render when disabled, and hide expensive/irrelevant objects during it.
    const origBefore = r.onBeforeRender.bind(r);
    this.hideDuringReflection = [];
    r.onBeforeRender = (rend, sc, cam) => {
      if (!this.enabled) return;
      this._frame = (this._frame || 0) + 1;
      const hidden = [];
      for (const o of this.hideDuringReflection) { if (o.visible) { o.visible = false; hidden.push(o); } }
      origBefore(rend, sc, cam);
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
