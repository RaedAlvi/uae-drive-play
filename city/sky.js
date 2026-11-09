// Sky, sun, haze and the day/night cycle. The Preetham sky is re-baked into a PMREM
// environment map whenever the time of day moves, so glass towers and car paint
// reflect the actual sky.
import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import { U, TERR_GEO } from "./materials.js";
import { CITY, toLatLon } from "./world.js";

// Pakistan only. Sky, horizon and haze per the art brief (section 9): Islamabad "typical dry" and Lahore
// "typical", as displayed sRGB colours; the fog end is where the air has fully closed in. Every other city
// takes none of these paths.
const PK = CITY.region === "pakistan";
const PK_SKY = {
  isb: { zen: 0x6aa0cf, hor: 0xd9ddd6, fogEnd: 22000, zenG: 0x7ca6cc, horG: 0xeec48f },
  lhr: { zen: 0x90afc6, hor: 0xded6c2, fogEnd: 10000, zenG: 0x9fb2be, horG: 0xeabf8b },
};
// the M-2: Islamabad's air down to Bhera, Lahore's from Sheikhupura on (brief, section 9)
const PK_RAMP = [31.747, 32.468];
// ACES as three's OutputPass applies it (exposure included), solved backwards: the linear colour that
// comes out on screen as the given hex, so the presets are what the player sees.
function acesFwd(v, ex, out) {
  const r = v[0] * ex / 0.6, g = v[1] * ex / 0.6, b = v[2] * ex / 0.6;
  const a0 = 0.59719 * r + 0.35458 * g + 0.04823 * b, a1 = 0.076 * r + 0.90834 * g + 0.01566 * b, a2 = 0.0284 * r + 0.13383 * g + 0.83777 * b;
  const f = x => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081);
  const c0 = f(a0), c1 = f(a1), c2 = f(a2);
  out[0] = 1.60475 * c0 - 0.53108 * c1 - 0.07367 * c2; out[1] = -0.10208 * c0 + 1.10813 * c1 - 0.00605 * c2; out[2] = -0.00327 * c0 - 0.07276 * c1 + 1.07602 * c2;
}
function screenColor(hex, ex = 0.74) {
  const c = new THREE.Color(hex), t = [c.r, c.g, c.b], x = t.slice(), o = [0, 0, 0];
  for (let k = 0; k < 60; k++) { acesFwd(x, ex, o); for (let i = 0; i < 3; i++) x[i] = Math.min(8, Math.max(1e-4, x[i] * t[i] / Math.max(o[i], 1e-4))); }
  return new THREE.Color().setRGB(x[0], x[1], x[2]);
}
// What the sky paints below the horizon where no terrain has been built yet: distant hazy land (0x73875f is an estimate, sampled from the far ridges). The haze colour here read as a white lake.
const PK_LAND = PK ? screenColor(0x73875f) : null;
const PK_LIN = PK ? Object.fromEntries(Object.entries(PK_SKY).map(([k, p]) => [k, { zen: screenColor(p.zen), hor: screenColor(p.hor), zenG: screenColor(p.zenG), horG: screenColor(p.horG), fogEnd: p.fogEnd }])) : null;

// Preetham sky, rescaled: its raw radiance averages about 4 by day (measured with a cube
// camera), ten times what it should be next to a sun of intensity 3.3, which washed the
// whole city out through image-based lighting. uScale brings it to about 0.4. A dark blue
// floor keeps the night sky from going pure black, and the horizon blends into the haze.
function hazeSky(mat) {
  mat.uniforms.uHaze = { value: new THREE.Color(0xd5dde2) };
  mat.uniforms.uScale = { value: 0.1 };
  mat.uniforms.uGround = { value: new THREE.Color(0xd5dde2) };
  if (PK) { mat.uniforms.uZen = { value: new THREE.Color() }; mat.uniforms.uHor = { value: new THREE.Color() }; mat.uniforms.uWarm = { value: 0 }; mat.uniforms.uLand = { value: new THREE.Color() }; mat.uniforms.uLandK = { value: 0 }; }
  mat.fragmentShader = mat.fragmentShader
    .replace("uniform float mieDirectionalG;", "uniform float mieDirectionalG;\nuniform vec3 uHaze;\nuniform vec3 uGround;\nuniform float uScale;" + (PK ? "\nuniform vec3 uZen;\nuniform vec3 uHor;\nuniform float uWarm;\nuniform vec3 uLand;\nuniform float uLandK;" : ""))
    // clouds lit by white sunlight, not sunlight reddened along the whole view ray (pink smudges)
    .replace("vec3 sunColor = vSunE * Fex * 0.22 * 0.04;", "vec3 sunColor = vSunE * mix( vec3( 1.0 ), Fex, 0.3 ) * 0.22 * 0.04;")
    .replace("gl_FragColor = vec4( texColor, 1.0 );", `
      // the night floor: the city's orange sodium glow low over the horizon, dark blue above
      texColor = max( texColor * uScale, mix( vec3( 0.034, 0.025, 0.019 ), vec3( 0.005, 0.007, 0.014 ), smoothstep( 0.0, 0.45, direction.y ) ) );
      // a dusty desert sky: soften the sun's halo and lift the zenith towards the haze (the raw
      // sky is navy overhead and burnt white around the sun). Off while bakeEnv measures it.
      if ( uScale < 0.5 ) { texColor = texColor / ( 1.0 + 0.3 * texColor ); texColor = mix( uHaze * vec3( 0.72, 0.84, 1.0 ) * 0.75, texColor, 0.62 ); }${PK ? `
      // Pakistan: the brief's gradient, with a little of the physical sky kept for the sun's glow and the cloud; a dusty amber bloom around a low sun
      if ( uScale < 0.5 ) { float pkC = max( dot( direction, vSunDirection ), 0.0 ); texColor = mix( mix( uHor, uZen, pow( smoothstep( 0.0, 0.62, direction.y ), 0.6 ) ), texColor, 0.1 ) + uWarm * vec3( 0.75, 0.36, 0.08 ) * pow( pkC, 5.0 ) * ( 1.0 - smoothstep( 0.0, 0.7, direction.y ) ); }` : ""}
      float hz = smoothstep( -0.02, 0.32, direction.y );
      texColor = mix( direction.y < 0.0 ? uGround : uHaze, min( texColor, vec3( 6.0 ) ), hz );${PK ? `
      // below the far edge of the map stays haze; a steeper look down can only be a gap in the terrain rings
      texColor = mix( texColor, uLand, uLandK * ( 1.0 - smoothstep( -0.1, -0.034, direction.y ) ) );` : ""}
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
    if (PK) {       // the sky goes on the far plane and draws after the city, so its costly shader only runs where no building stands in front of it
      this.sky.material.vertexShader = this.sky.material.vertexShader.replace("gl_Position.z = gl_Position.w;", "gl_Position.z = 0.0;");
      this.sky.renderOrder = 1e6;
      this.sky.material.uniforms.uLandK.value = 1;
    }
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
    // Pakistan's late afternoon is golden from about 4 pm, not only in the last minutes before sunset
    const golden = 1 - THREE.MathUtils.smoothstep(elev, PK ? 3 : 2, PK ? 40 : 26);
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
    this.sun.intensity = elev > -4 ? (PK ? 2.95 : 3.1) * THREE.MathUtils.smoothstep(elev, -4, 10) + 0.05 : 0.26;
    this.hemi.intensity = PK ? 0.08 + 0.3 * day : 0.06 + 0.1 * day;     // Pakistan: shade filled by dust and bright ground, never near black
    this.hemi.color.setRGB(0.75 + 0.1 * golden, 0.84 - 0.05 * golden, 1.0 - 0.25 * golden).lerp(new THREE.Color(0.26, 0.24, 0.24), this.night);
    this.hemi.groundColor.setRGB(0.78, 0.66, 0.5).lerp(new THREE.Color(0.12, 0.1, 0.1), this.night);
    if (PK) this.hemi.color.lerp(new THREE.Color(0.96, 0.9, 0.8), 0.65 * (1 - this.night));
    // haze colour tracks the horizon: pale dusty blue by day, amber at golden hour, sodium-lit navy at night
    const fogDay = new THREE.Color(0xd5dde2), fogGold = new THREE.Color(0xe4bb92), fogNight = new THREE.Color(0x2e2926);
    const fc = fogDay.clone().lerp(fogGold, golden * day).lerp(fogNight, this.night);
    // Pakistan: the preset for where the player is, ramped along the M-2
    let pkT = 1;
    if (PK) {
      const [la] = toLatLon(focus.x, focus.z);
      pkT = THREE.MathUtils.smoothstep(la, PK_RAMP[0], PK_RAMP[1]); this.pkT = pkT;
      const A = PK_LIN.lhr, B = PK_LIN.isb, g = golden * day;
      const hor = A.hor.clone().lerp(B.hor, pkT).lerp(A.horG.clone().lerp(B.horG, pkT), g);
      const zen = A.zen.clone().lerp(B.zen, pkT).lerp(A.zenG.clone().lerp(B.zenG, pkT), g);
      fc.copy(hor).lerp(fogNight, this.night);
      su.uHor.value.copy(fc); su.uZen.value.copy(zen).lerp(new THREE.Color(0.004, 0.006, 0.012), this.night); su.uWarm.value = golden * day;
      su.uLand.value.copy(PK_LAND).lerp(fc, 0.3 * golden * day).lerp(new THREE.Color(0.01, 0.01, 0.012), this.night);
      const [a0, b0] = toLatLon(0, 0); TERR_GEO.value.set(a0, b0);    // where the terrain shader's world origin is on the map
    }
    this.scene.fog.color.copy(fc);
    this.sky.material.uniforms.uHaze.value.copy(fc).multiplyScalar(1.0);
    this.sky.material.uniforms.uGround.value.copy(fc);
    // what the lighting sees below the horizon: sunlit sand and asphalt, warm and about as bright
    // as the sky above (it was the pale blue haze, twice the sky, which lit every wall from below)
    const irr = this.sun.intensity * Math.max(0, s.y) + day;
    this.groundCol = (this.groundCol || new THREE.Color()).setRGB(1.15, 0.98, 0.75).multiplyScalar(0.25 * irr / Math.PI).lerp(new THREE.Color(0.02, 0.017, 0.014), this.night);
    // Exp2 reaches 95 percent at sqrt(3) / density. main.js scales the Pakistan fog by 0.62 at low altitude, so divide that back out.
    this.scene.fog.density = PK ? (Math.sqrt(3) / (PK_LIN.lhr.fogEnd + (PK_LIN.isb.fogEnd - PK_LIN.lhr.fogEnd) * pkT)) / 0.62 + 0.00002 * golden + 0.00008 * this.night : 0.00015 + 0.00006 * golden + 0.00008 * this.night;
    this.renderer.toneMappingExposure = 0.72 + 0.18 * this.night + 0.06 * golden;
    // re-bake the environment map when the sun has moved enough
    if (Math.abs(h - this.lastEnvHour) > 0.12 || (PK && Math.abs(pkT - (this.lastEnvT ?? -1)) > 0.05)) this.bakeEnv();
  }
  bakeEnv() {
    this.lastEnvHour = this.hour;
    const e = this.envSky.material.uniforms, s = this.sky.material.uniforms;
    for (const k of ["turbidity", "rayleigh", "mieCoefficient", "mieDirectionalG", "cloudCoverage", "cloudDensity", "cloudScale", "cloudElevation"]) e[k].value = s[k].value;
    e.uHaze.value.copy(s.uHaze.value);
    if (PK) { e.uZen.value.copy(s.uZen.value); e.uHor.value.copy(s.uHor.value); e.uWarm.value = s.uWarm.value; this.lastEnvT = this.pkT; const L = e.uZen.value.r * 0.2126 + e.uZen.value.g * 0.7152 + e.uZen.value.b * 0.0722; e.uZen.value.lerp(new THREE.Color(L * 1.05, L, L * 0.86), 0.68); }    // the lighting sees a less blue sky than the eye: shade is dusty, not navy
    if (this.groundCol) e.uGround.value.copy(this.groundCol);
    e.sunPosition.value.copy(s.sunPosition.value);
    // Measure the raw sky (8 px cube, float) and scale it to an average radiance of about
    // 0.35: constant brightness through the day, a darker but not black twilight.
    if (!this.cube) { this.cubeRT = new THREE.WebGLCubeRenderTarget(8, { type: THREE.FloatType }); this.cube = new THREE.CubeCamera(0.1, 2000, this.cubeRT); this.px = new Float32Array(8 * 8 * 4); }
    e.uScale.value = 1;
    let L = 0, n = 0;
    // Pakistan: driving the M-2 only drifts the haze, and reading the pixels back stalls the frame until the GPU catches up: keep the last measured scale unless the hour moved
    const again = !(PK && this.envRT && this.scaleHour !== undefined && Math.abs(this.hour - this.scaleHour) < 0.12);
    if (again) try {
      this.cube.update(this.renderer, this.envScene);
      for (const f of [0, 1, 2, 4, 5]) { this.renderer.readRenderTargetPixels(this.cubeRT, 0, 0, 8, 8, this.px, f); for (let i = 0; i < 64; i++) { const v = 0.2126 * this.px[4 * i] + 0.7152 * this.px[4 * i + 1] + 0.0722 * this.px[4 * i + 2]; if (isFinite(v)) { L += v; n++; } } }
    } catch (err) { L = 0; }
    const avg = n ? L / n : 4;
    const scale = again ? THREE.MathUtils.clamp(0.35 / Math.max(avg, 1e-4), 0.08, 0.25) : this.lastScale;
    if (again) { this.lastScale = scale; this.scaleHour = this.hour; }
    e.uScale.value = scale; s.uScale.value = scale; e.uHaze.value.copy(s.uHaze.value);
    if (again) this.skyAvg = avg;
    const old = this.envRT;
    this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 2000);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = PK ? 0.82 : 1.0;
    if (old) old.dispose();
  }
}
