// Post-processing: bloom (neon, street lamps, low sun), then an optional "visual preset",
// then tone mapping. The presets are a nod to God's Eye View (github.com/bilawalsidhu/
// gods-eye-view, MIT): the ironbow thermal ramp below uses its colour stops.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { FXAAPass } from "three/addons/postprocessing/FXAAPass.js";

export const PRESETS = ["normal", "cinematic", "thermal", "nightvision", "crt", "noir"];

const PresetShader = {
  uniforms: { tDiffuse: { value: null }, uMode: { value: 0 }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) } },
  vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse; uniform int uMode; uniform float uTime; uniform vec2 uRes; varying vec2 vUv;
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 ironbow(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.0), c1 = vec3(0.13, 0.0, 0.30), c2 = vec3(0.49, 0.0, 0.45), c3 = vec3(0.86, 0.10, 0.18), c4 = vec3(1.0, 0.55, 0.0), c5 = vec3(1.0, 0.91, 0.32), c6 = vec3(1.0);
  float s = t * 6.0;
  if (s < 1.0) return mix(c0, c1, s); if (s < 2.0) return mix(c1, c2, s - 1.0); if (s < 3.0) return mix(c2, c3, s - 2.0);
  if (s < 4.0) return mix(c3, c4, s - 3.0); if (s < 5.0) return mix(c4, c5, s - 4.0); return mix(c5, c6, s - 5.0);
}
void main() {
  vec2 uv = vUv;
  vec4 c = texture2D(tDiffuse, uv);
  vec3 col = c.rgb;
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec2 q = uv - 0.5; float vig = 1.0 - dot(q, q) * 1.1;
  if (uMode == 1) {            // cinematic: teal-orange grade, soft vignette, letterbox
    vec3 sh = vec3(0.0, 0.035, 0.05), hi = vec3(0.06, 0.02, -0.03);
    col = col + mix(sh, hi, smoothstep(0.1, 0.8, lum));
    col = mix(vec3(lum), col, 1.12);
    col *= mix(0.78, 1.0, vig);
    if (abs(uv.y - 0.5) > 0.44) col = vec3(0.0);
  } else if (uMode == 2) {     // thermal (FLIR ironbow): brightness stands in for heat
    float heat = pow(clamp(lum * 1.25, 0.0, 1.0), 0.8);
    heat += (hash(floor(uv * uRes / 2.0) + floor(uTime * 24.0)) - 0.5) * 0.04;
    col = ironbow(heat);
    col *= mix(0.7, 1.0, vig);
  } else if (uMode == 3) {     // night vision: green phosphor, grain, circular tube
    float g = pow(clamp(lum * 3.2, 0.0, 1.0), 0.7);
    g += (hash(uv * uRes + uTime * 61.0) - 0.5) * 0.18;
    col = vec3(0.12, 1.0, 0.25) * g;
    float r = length((uv - 0.5) * vec2(uRes.x / uRes.y, 1.0));
    col *= smoothstep(0.62, 0.52, r);
  } else if (uMode == 4) {     // CRT: scanlines, RGB split, curvature
    vec2 cc = uv - 0.5; cc *= 1.0 + dot(cc, cc) * 0.08; vec2 cuv = cc + 0.5;
    float ca = 0.0016;
    col = vec3(texture2D(tDiffuse, cuv + vec2(ca, 0.0)).r, texture2D(tDiffuse, cuv).g, texture2D(tDiffuse, cuv - vec2(ca, 0.0)).b);
    float scan = 0.82 + 0.18 * sin(cuv.y * uRes.y * 3.14159);
    col *= scan * mix(0.7, 1.05, vig);
    col = mix(col, col * vec3(0.9, 1.05, 0.95), 0.5);
    if (cuv.x < 0.0 || cuv.x > 1.0 || cuv.y < 0.0 || cuv.y > 1.0) col = vec3(0.0);
  } else if (uMode == 5) {     // noir: high-contrast monochrome, grain
    float m = smoothstep(0.05, 0.85, lum);
    m += (hash(uv * uRes + uTime * 13.0) - 0.5) * 0.06;
    col = vec3(m) * mix(0.55, 1.0, vig);
  }
  gl_FragColor = vec4(col, c.a);
}`,
};

export class FX {
  constructor(renderer, scene, camera, samples) {
    this.renderer = renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: samples || 0 });
    rt.depthTexture = new THREE.DepthTexture(size.x, size.y, THREE.FloatType);
    this.composer = new EffectComposer(renderer, rt);
    this.render = new RenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.25, 0.6, 0.9);
    // run the bloom chain at a quarter of the screen: a soft glow does not need full resolution
    const bloomSize = this.bloom.setSize.bind(this.bloom);
    this.bloom.setSize = (w, h) => bloomSize(Math.max(64, Math.round(w / 2)), Math.max(64, Math.round(h / 2)));
    this.preset = new ShaderPass(PresetShader);
    this.output = new OutputPass();
    this.composer.addPass(this.render);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.output);        // tone mapping + sRGB before the stylised looks
    this.composer.addPass(this.preset);
    this.fxaa = new FXAAPass();                 // cheap edge smoothing after the looks, on display values
    this.composer.addPass(this.fxaa);
    this.bloomWanted = true;
    this.mode = 0;
    this.preset.enabled = false;
  }
  setMode(name) { this.mode = Math.max(0, PRESETS.indexOf(name)); this.preset.uniforms.uMode.value = this.mode; this.preset.enabled = this.mode !== 0; }
  setSize(w, h) { this.composer.setSize(w, h); const pr = this.renderer.getPixelRatio(); this.preset.uniforms.uRes.value.set(w * pr, h * pr); }
  frame(dt, night) {
    this.preset.uniforms.uTime.value += dt;
    // By day only the sun and hot glints bloom; at night lit windows, lamps and headlights do.
    this.bloom.strength = 0.06 + 0.42 * night;
    this.bloom.threshold = 2.2 - 1.3 * night;
    this.bloom.radius = 0.55;
    // Bloom costs about 15 fps on an integrated GPU and does almost nothing in daylight, so it
    // only runs from dusk onwards.
    this.bloom.enabled = this.bloomWanted && night > 0.12;
    this.composer.render(dt);
  }
}
