// Sky, sun, haze and the day/night cycle. The Preetham sky is re-baked into a PMREM
// environment map whenever the time of day moves, so glass towers and car paint
// reflect the actual sky.
import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import { U } from "./materials.js";

// Preetham sky, rescaled: its raw radiance averages about 4 by day (measured with a cube
// camera), ten times what it should be next to a sun of intensity 3.3, which washed the
// whole city out through image-based lighting. uScale brings it to about 0.4. A dark blue
// floor keeps the night sky from going pure black, and the horizon blends into the haze.
function hazeSky(mat) {
  mat.uniforms.uHaze = { value: new THREE.Color(0xd5dde2) };
  mat.uniforms.uScale = { value: 0.1 };
  mat.uniforms.uGround = { value: new THREE.Color(0xd5dde2) };
  mat.fragmentShader = mat.fragmentShader
    .replace("uniform float mieDirectionalG;", "uniform float mieDirectionalG;\nuniform vec3 uHaze;\nuniform vec3 uGround;\nuniform float uScale;")
    // clouds lit by white sunlight, not sunlight reddened along the whole view ray (pink smudges)
    .replace("vec3 sunColor = vSunE * Fex * 0.22 * 0.04;", "vec3 sunColor = vSunE * mix( vec3( 1.0 ), Fex, 0.3 ) * 0.22 * 0.04;")
    .replace("gl_FragColor = vec4( texColor, 1.0 );", `
      // the night floor: the city's orange sodium glow low over the horizon, dark blue above
      texColor = max( texColor * uScale, mix( vec3( 0.034, 0.025, 0.019 ), vec3( 0.005, 0.007, 0.014 ), smoothstep( 0.0, 0.45, direction.y ) ) );
      // a dusty desert sky: soften the sun's halo and lift the zenith towards the haze (the raw
      // sky is navy overhead and burnt white around the sun). Off while bakeEnv measures it.
      if ( uScale < 0.5 ) { texColor = texColor / ( 1.0 + 0.3 * texColor ); texColor = mix( uHaze * vec3( 0.72, 0.84, 1.0 ) * 0.75, texColor, 0.62 ); }
      float hz = smoothstep( -0.02, 0.32, direction.y );
      texColor = mix( direction.y < 0.0 ? uGround : uHaze, min( texColor, vec3( 6.0 ) ), hz );
      gl_FragColor = vec4( texColor, 1.0 );`);
  mat.needsUpdate = true;
}

export class Atmosphere {
  constructor(renderer, scene) {
    this.renderer = renderer; this.scene = scene;
    this.sky = new Sky(); this.sky.scale.setScalar(40000); this.sky.frustumCulled = false;
    // The sky pins itself to the far plane (z = w), which a reversed depth buffer reads as the
    // near plane: it must draw before everything else or it paints over the scene.
    this.sky.renderOrder = -1e6;
    this.sky.material.fog = false;
    hazeSky(this.sky.material);
    scene.add(this.sky);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 9; u.rayleigh.value = 1.6; u.mieCoefficient.value = 0.007; u.mieDirectionalG.value = 0.86;
    // a thin layer of high cloud: Gulf skies are mostly clear
    u.cloudCoverage.value = 0.1; u.cloudDensity.value = 0.35; u.cloudScale.value = 0.00016; u.cloudSpeed.value = 0.00001; u.cloudElevation.value = 0.6;
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const c = this.sun.shadow.camera; c.left = -140; c.right = 140; c.top = 140; c.bottom = -140; c.near = 10; c.far = 1400;
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun); scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xcfe3ff, 0xc9b08a, 1.0); scene.add(this.hemi);
    scene.fog = new THREE.FogExp2(0xd7dde0, 0.00016);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene(); this.envSky = new Sky(); this.envSky.scale.setScalar(1000); hazeSky(this.envSky.material); this.envScene.add(this.envSky);
    this.envRT = null; this.lastEnvHour = -99;
    this.hour = 16.5;
    this.sunDir = new THREE.Vector3();
    this.night = 0;
  }
  // Sun path for the UAE (about 25 N): hour 6 sunrise in the east, 12 high to the south, 18.3 sunset in the west.
  sunAt(hour) {
    const t = (hour - 6.1) / 12.2;                     // 0 sunrise .. 1 sunset
    const el = Math.sin(Math.PI * t) * 72 * Math.PI / 180 - (t < 0 || t > 1 ? 0.25 : 0);
    const az = (90 + 180 * t) * Math.PI / 180;          // east -> south -> west (compass degrees)
    // world: x east, -z north. Compass azimuth az: direction (sin az, -cos az)
    return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
  }
  setHour(h) { this.hour = ((h % 24) + 24) % 24; }
  update(focus, camera) {
    const h = this.hour;
    const s = this.sunAt(h);
    this.sunDir.copy(s);
    const elev = Math.asin(THREE.MathUtils.clamp(s.y, -1, 1)) * 180 / Math.PI;
    const day = THREE.MathUtils.smoothstep(elev, -6, 8);
    const golden = 1 - THREE.MathUtils.smoothstep(elev, 2, 26);
    this.night = 1 - THREE.MathUtils.smoothstep(elev, -8, 2);
    U.uNight.value = this.night;
    // sky shader
    const su = this.sky.material.uniforms;
    su.sunPosition.value.copy(s);
    su.turbidity.value = 10 + 2 * golden; su.rayleigh.value = 0.75 + 1.8 * golden * day;
    this.sky.position.copy(camera.position);
    // sun light: warm and weak near the horizon; a cool moon at night
    const lightDir = elev > -4 ? s.clone() : new THREE.Vector3(-0.4, 0.75, 0.3).normalize();
    this.sun.position.copy(focus).addScaledVector(lightDir, 600);
    this.sun.target.position.copy(focus);
    const sunCol = new THREE.Color().setRGB(1, 0.94 - 0.34 * golden, 0.86 - 0.6 * golden);
    this.sun.color.copy(elev > -4 ? sunCol : new THREE.Color(0.62, 0.66, 0.78));
    this.sun.intensity = elev > -4 ? 3.1 * THREE.MathUtils.smoothstep(elev, -4, 10) + 0.05 : 0.26;
    this.hemi.intensity = 0.06 + 0.1 * day;
    this.hemi.color.setRGB(0.75 + 0.1 * golden, 0.84 - 0.05 * golden, 1.0 - 0.25 * golden).lerp(new THREE.Color(0.26, 0.24, 0.24), this.night);
    this.hemi.groundColor.setRGB(0.78, 0.66, 0.5).lerp(new THREE.Color(0.12, 0.1, 0.1), this.night);
    // haze colour tracks the horizon: pale dusty blue by day, amber at golden hour, sodium-lit navy at night
    const fogDay = new THREE.Color(0xd5dde2), fogGold = new THREE.Color(0xe4bb92), fogNight = new THREE.Color(0x2e2926);
    const fc = fogDay.clone().lerp(fogGold, golden * day).lerp(fogNight, this.night);
    this.scene.fog.color.copy(fc);
    this.sky.material.uniforms.uHaze.value.copy(fc).multiplyScalar(1.0);
    this.sky.material.uniforms.uGround.value.copy(fc);
    // what the lighting sees below the horizon: sunlit sand and asphalt, warm and about as bright
    // as the sky above (it was the pale blue haze, twice the sky, which lit every wall from below)
    const irr = this.sun.intensity * Math.max(0, s.y) + day;
    this.groundCol = (this.groundCol || new THREE.Color()).setRGB(1.15, 0.98, 0.75).multiplyScalar(0.25 * irr / Math.PI).lerp(new THREE.Color(0.02, 0.017, 0.014), this.night);
    this.scene.fog.density = 0.00015 + 0.00006 * golden + 0.00008 * this.night;
    this.renderer.toneMappingExposure = 0.72 + 0.18 * this.night + 0.06 * golden;
    // re-bake the environment map when the sun has moved enough
    if (Math.abs(h - this.lastEnvHour) > 0.12) this.bakeEnv();
  }
  bakeEnv() {
    this.lastEnvHour = this.hour;
    const e = this.envSky.material.uniforms, s = this.sky.material.uniforms;
    for (const k of ["turbidity", "rayleigh", "mieCoefficient", "mieDirectionalG", "cloudCoverage", "cloudDensity", "cloudScale", "cloudElevation"]) e[k].value = s[k].value;
    e.uHaze.value.copy(s.uHaze.value);
    if (this.groundCol) e.uGround.value.copy(this.groundCol);
    e.sunPosition.value.copy(s.sunPosition.value);
    // Measure the raw sky (8 px cube, float) and scale it to an average radiance of about
    // 0.35: constant brightness through the day, a darker but not black twilight.
    if (!this.cube) { this.cubeRT = new THREE.WebGLCubeRenderTarget(8, { type: THREE.FloatType }); this.cube = new THREE.CubeCamera(0.1, 2000, this.cubeRT); this.px = new Float32Array(8 * 8 * 4); }
    e.uScale.value = 1;
    let L = 0, n = 0;
    try {
      this.cube.update(this.renderer, this.envScene);
      for (const f of [0, 1, 2, 4, 5]) { this.renderer.readRenderTargetPixels(this.cubeRT, 0, 0, 8, 8, this.px, f); for (let i = 0; i < 64; i++) { const v = 0.2126 * this.px[4 * i] + 0.7152 * this.px[4 * i + 1] + 0.0722 * this.px[4 * i + 2]; if (isFinite(v)) { L += v; n++; } } }
    } catch (err) { L = 0; }
    const avg = n ? L / n : 4;
    const scale = THREE.MathUtils.clamp(0.35 / Math.max(avg, 1e-4), 0.08, 0.25);
    e.uScale.value = scale; s.uScale.value = scale; e.uHaze.value.copy(s.uHaze.value);
    this.skyAvg = avg;
    const old = this.envRT;
    this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 2000);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 1.0;
    if (old) old.dispose();
  }
}
