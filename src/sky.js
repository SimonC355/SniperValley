// Atmospheric sky (three's Preetham Sky with clouds) blended into the fog colour at the
// horizon, plus sun/ambient lights and a PMREM environment map generated from the sky.
// The clouds come from the drifting cloud field in weather.js (the same one that casts the
// cloud shadows), lit with three's cloud shading.
import * as THREE from 'three';
import { Sky as ThreeSky } from 'three/examples/jsm/objects/Sky.js';
import { CONFIG } from './config.js';
import { sunDirection, SHARED } from './shaders.js';
import { cloudUniforms } from './weather.js';

export class SkySystem {
  constructor(renderer, scene) {
    this.sunDir = sunDirection();
    SHARED.uSunDirWorld.value.copy(this.sunDir);
    const sunCol = new THREE.Color(CONFIG.sun.color);
    SHARED.uSunColor.value.copy(sunCol).multiplyScalar(CONFIG.sun.intensity);

    const sky = new ThreeSky();
    sky.scale.setScalar(4000);
    const u = sky.material.uniforms;
    u.turbidity.value = CONFIG.sky.turbidity;
    u.rayleigh.value = CONFIG.sky.rayleigh;
    u.mieCoefficient.value = CONFIG.sky.mieCoefficient;
    u.mieDirectionalG.value = CONFIG.sky.mieDirectionalG;
    u.sunPosition.value.copy(this.sunDir).multiplyScalar(1000);
    if (u.cloudCoverage) {
      u.cloudCoverage.value = CONFIG.sky.cloudCover;
      u.cloudDensity.value = 0.5;
      u.cloudElevation.value = 0.55;
    }
    // Horizon blend into fog colour + exposure scale.
    const fogCol = new THREE.Color(CONFIG.fog.color);
    sky.material.uniforms.uFogColor = { value: fogCol };
    sky.material.uniforms.uSkyGain = { value: 0.6 };
    Object.assign(sky.material.uniforms, cloudUniforms());
    let fs = sky.material.fragmentShader
      .replace('uniform float time;', 'uniform float time;\nuniform vec3 uFogColor;\nuniform float uSkyGain;\nuniform sampler2D uCloudTex;\nuniform vec4 uCloudA;\nuniform vec4 uCloudB;')
      .replace('vec3 texColor = ( Lin + L0 ) * 0.04 + sundiscColor + vec3( 0.0, 0.0003, 0.00075 );',
        'vec3 texColor = ( Lin + L0 ) * 0.04 + sundiscColor + vec3( 0.0, 0.0003, 0.00075 );\n\t\t\tfloat cloudAlpha = 0.0;')
      .replace('float alpha = ( 1.0 - exp( depth * cloudDensity * -12.0 ) ) * horizonFade;',
        'float alpha = smoothstep( threshold - 0.02, threshold + 0.16, cloudNoise ) * horizonFade;\n\t\t\t\tcloudAlpha = alpha;')
      .replace('gl_FragColor = vec4( texColor, 1.0 );', `
      {
        float hz = 1.0 - smoothstep(-0.04, 0.16, direction.y);
        float sunAmt = pow(max(dot(direction, vSunDirection), 0.0), 8.0);
        vec3 fc = mix(uFogColor, uFogColor * vec3(1.6, 1.4, 1.1), sunAmt * ${CONFIG.fog.sunScatter.toFixed(3)});
        // keep the sky below the bloom threshold; only the sun disc itself blooms (unless a
        // cloud covers it)
        vec3 base = max(texColor - sundiscColor * (1.0 - cloudAlpha), vec3(0.0)) * uSkyGain;
        float bl = dot(base, vec3(0.2126, 0.7152, 0.0722));
        base *= min(1.0, 2.4 / max(bl, 1e-4));
        base = mix(base, fc, hz * 0.85);
        texColor = base + sundisc * (1.0 - cloudAlpha) * vec3(40.0, 34.0, 26.0);
      }
      gl_FragColor = vec4( texColor, 1.0 );`);
    // cloud density from the weather cloud field, projected onto the same cloud layer the
    // ground shadows use (so a cloud over the sun shades the place you stand)
    const a = fs.indexOf('float elevation = mix( 1.0, 0.1, cloudElevation );');
    const bTag = 'float cloudMask = smoothstep( threshold, threshold + 0.3, cloudNoise );';
    const b = fs.indexOf(bTag);
    if (a < 0 || b < 0) throw new Error('Sky shader changed: cloud block not found');
    fs = fs.slice(0, a) + `vec2 cq = cameraPosition.xz + direction.xz / max( direction.y, 1e-3 ) * ( uCloudB.z - cameraPosition.y );
				vec2 cuv = cq * uCloudB.w + uCloudA.xy;
				float cloudNoise = texture( uCloudTex, cuv ).r * 0.72 + texture( uCloudTex, cuv * 3.3 + vec2( 0.37, 0.61 ) ).r * 0.28;
				float threshold = uCloudA.z;
				float cloudMask = smoothstep( threshold, threshold + 0.1, cloudNoise );` + fs.slice(b + bTag.length);
    sky.material.fragmentShader = fs;
    sky.material.needsUpdate = true;
    sky.frustumCulled = false;
    this.sky = sky;
    scene.add(sky);

    // Environment lighting from the sky (rendered once).
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const skyClone = new ThreeSky();
    skyClone.material = sky.material;
    skyClone.scale.setScalar(4000);
    envScene.add(skyClone);
    const groundGeo = new THREE.CircleGeometry(3000, 16);
    groundGeo.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(groundGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.06, 0.07, 0.04) }));
    ground.position.y = -20;
    envScene.add(ground);
    const envRT = pmrem.fromScene(envScene, 0, 0.1, 5000);
    scene.environment = envRT.texture;
    scene.environmentIntensity = CONFIG.sun.ambient;
    pmrem.dispose();

    scene.fog = new THREE.FogExp2(fogCol, CONFIG.fog.density);

    const sun = new THREE.DirectionalLight(sunCol, CONFIG.sun.intensity);
    sun.castShadow = CONFIG.render.shadowQuality !== 'off';
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    sun.shadow.radius = 2.5;
    this.sun = sun;
    scene.add(sun);
    scene.add(sun.target);
    this.applyShadowQuality(CONFIG.render.shadowQuality);

    const hemi = new THREE.HemisphereLight(0x9fb4c8, 0x2a2416, 0.25);
    scene.add(hemi);
    this.hemi = hemi;
  }

  applyShadowQuality(q) {
    const sun = this.sun;
    const sizes = { low: 1024, medium: 2048, high: 4096 };
    sun.castShadow = q !== 'off';
    const s = sizes[q] || 2048;
    if (sun.shadow.mapSize.x !== s) {
      sun.shadow.mapSize.set(s, s);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
  }

  // Centre the shadow frustum on a focus point; extent = half size in metres.
  updateShadow(focus, extent) {
    const sun = this.sun;
    const cam = sun.shadow.camera;
    // snap to texel grid to reduce shimmering
    const texel = (extent * 2) / sun.shadow.mapSize.x;
    const d = this.sunDir;
    const f = focus.clone();
    // project focus into light space, snap, project back
    const lightRot = new THREE.Matrix4().lookAt(new THREE.Vector3(), d.clone().negate(), new THREE.Vector3(0, 1, 0));
    const inv = lightRot.clone().invert();
    f.applyMatrix4(inv);
    f.x = Math.round(f.x / texel) * texel;
    f.y = Math.round(f.y / texel) * texel;
    f.applyMatrix4(lightRot);
    sun.target.position.copy(f);
    sun.position.copy(f).addScaledVector(d, 400);
    cam.left = -extent; cam.right = extent; cam.top = extent; cam.bottom = -extent;
    cam.near = 50; cam.far = 900;
    cam.updateProjectionMatrix();
    sun.target.updateMatrixWorld();
  }
}
