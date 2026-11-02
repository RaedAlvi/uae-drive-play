// Traffic lights. The tile worker finds the signalised junctions (real OpenStreetMap signal
// nodes where the roads database has them), groups the junction points of one crossing into
// a controller, and splits its approaches into two phases: along the main road and across
// it. Every controller runs the same 64 s cycle from its own offset, so the heads you see,
// the AI traffic stopping at the line and the red-light check all agree without any shared
// state: the colour is a function of (controller seed, phase, time).
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { U } from "./materials.js";

export const CYCLE = 64;
// 0 green, 1 amber, 2 red
export function signalState(seed, group, t) {
  const ph = ((t + seed * CYCLE) % CYCLE + CYCLE) % CYCLE;
  if (group === 0) return ph < 27 ? 0 : ph < 30 ? 1 : 2;
  return ph < 32 ? 2 : ph < 59 ? 0 : ph < 62 ? 1 : 2;
}

function tint(g, hex) {
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[3 * i] = c.r; a[3 * i + 1] = c.g; a[3 * i + 2] = c.b; }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  for (const k of Object.keys(g.attributes)) if (!["position", "normal", "color"].includes(k)) g.deleteAttribute(k);
  return g.index ? g.toNonIndexed() : g;
}
// Pole with the signal head on top, facing local +Z (the approaching drivers).
function headGeometry() {
  const parts = [];
  let g = new THREE.CylinderGeometry(0.085, 0.11, 3.3, 8); g.translate(0, 1.65, 0); parts.push(tint(g, "#b8bcc0"));
  g = new THREE.CylinderGeometry(0.2, 0.24, 0.35, 8); g.translate(0, 0.17, 0); parts.push(tint(g, "#9a9ea2"));
  g = new THREE.BoxGeometry(0.44, 1.22, 0.3); g.translate(0, 3.05, 0.05); parts.push(tint(g, "#1b1d1f"));        // housing
  g = new THREE.BoxGeometry(0.72, 1.5, 0.04); g.translate(0, 3.05, -0.12); parts.push(tint(g, "#111213"));       // backboard
  for (const y of [3.45, 3.05, 2.65]) { g = new THREE.BoxGeometry(0.34, 0.05, 0.16); g.translate(0, y + 0.17, 0.26); parts.push(tint(g, "#1b1d1f")); }   // visors
  return mergeGeometries(parts);
}

export class Signals {
  constructor(scene) {
    this.tiles = new Map();          // tileKey -> { c: [x, z, seed, ref] x n, h: [x, z, y, rot, cluster, group] x n }
    this.cap = 420;
    this.pole = new THREE.InstancedMesh(headGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.3 }), this.cap);
    this.pole.castShadow = true; this.pole.frustumCulled = false; this.pole.count = 0;
    // the three lamps are one quad per head; a per-instance state lights one of them
    const lampGeo = new THREE.PlaneGeometry(0.3, 1.1); lampGeo.translate(0, 3.05, 0.205);
    this.state = new Float32Array(this.cap);
    lampGeo.setAttribute("aState", new THREE.InstancedBufferAttribute(this.state, 1));
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true });
    mat.onBeforeCompile = sh => {
      sh.uniforms.uNight = U.uNight;
      sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nattribute float aState; varying float vState; varying vec2 vUvL;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvState = aState; vUvL = uv;");
      sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform float uNight; varying float vState; varying vec2 vUvL;")
        .replace("vec4 diffuseColor = vec4( diffuse, opacity );", /* glsl */`
vec2 p = vec2((vUvL.x - 0.5) * 0.3, vUvL.y * 1.1);
vec3 col = vec3(0.03);
for (int i = 0; i < 3; i++) {
  float cy = 1.1 * (0.82 - 0.32 * float(i));           // red top, amber, green bottom
  float d = length(p - vec2(0.0, cy));
  float lamp = 1.0 - smoothstep(0.11, 0.125, d);
  vec3 lc = i == 0 ? vec3(1.0, 0.08, 0.04) : i == 1 ? vec3(1.0, 0.55, 0.02) : vec3(0.05, 1.0, 0.45);
  bool on = (i == 0 && vState > 1.5) || (i == 1 && vState > 0.5 && vState < 1.5) || (i == 2 && vState < 0.5);
  col = mix(col, on ? lc * (2.4 + 3.0 * uNight) * (1.0 - 0.35 * d / 0.12) : lc * 0.06, lamp);
}
vec4 diffuseColor = vec4(col, 1.0);`);
    };
    mat.customProgramCacheKey = () => "uae-signal-lamps-v1";
    this.lamps = new THREE.InstancedMesh(lampGeo, mat, this.cap);
    this.lamps.frustumCulled = false; this.lamps.count = 0;
    scene.add(this.pole, this.lamps);
    this.vis = [];                   // visible heads: [tileKey, headIndex]
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(1, 1, 1); this._e = new THREE.Euler();
    this.lastPick = -1e9; this.px = 1e9; this.pz = 1e9;
  }
  setTile(key, data) { if (data && data.c && data.c.length) this.tiles.set(key, data); this.lastPick = -1e9; }
  dropTile(key) { this.tiles.delete(key); this.lastPick = -1e9; }
  stateFor(key, cl, group, t) { const d = this.tiles.get(key); if (!d) return 0; return signalState(d.c[4 * cl + 2], group, t); }
  // controllers near a world point: [{ key, i, x, z, seed, ref }] (for the red-light check)
  near(x, z, offsets, r) {
    const out = [];
    for (const [key, d] of this.tiles) { const off = offsets.get(key); if (!off) continue; for (let i = 0; i < d.c.length; i += 4) { const cx = d.c[i] + off.x, cz = d.c[i + 1] + off.z; if ((cx - x) ** 2 + (cz - z) ** 2 < r * r) out.push({ key, i: i / 4, x: cx, z: cz, seed: d.c[i + 2], ref: d.c[i + 3] }); } }
    return out;
  }
  update(camX, camZ, offsets, t) {
    const now = performance.now();
    // re-pick the visible heads every half second or after 40 m of movement
    if (now - this.lastPick > 500 || Math.hypot(camX - this.px, camZ - this.pz) > 40) {
      this.lastPick = now; this.px = camX; this.pz = camZ;
      const cand = [];
      for (const [key, d] of this.tiles) {
        const off = offsets.get(key); if (!off) continue;
        for (let i = 0; i < d.h.length; i += 6) { const x = d.h[i] + off.x, z = d.h[i + 1] + off.z, dd = (x - camX) ** 2 + (z - camZ) ** 2; if (dd < 480 * 480) cand.push([dd, key, i]); }
      }
      cand.sort((a, b) => a[0] - b[0]);
      this.vis = cand.slice(0, this.cap);
      let j = 0;
      for (const [, key, i] of this.vis) {
        const d = this.tiles.get(key), off = offsets.get(key);
        this._p.set(d.h[i] + off.x, d.h[i + 2], d.h[i + 1] + off.z); this._q.setFromEuler(this._e.set(0, d.h[i + 3], 0));
        this._m.compose(this._p, this._q, this._s); this.pole.setMatrixAt(j, this._m); this.lamps.setMatrixAt(j, this._m); j++;
      }
      this.pole.count = this.lamps.count = j; this.pole.instanceMatrix.needsUpdate = true; this.lamps.instanceMatrix.needsUpdate = true;
    }
    // colours change every frame they need to (cheap: one float per head)
    let j = 0, changed = false;
    for (const [, key, i] of this.vis) {
      const d = this.tiles.get(key); if (!d) { j++; continue; }
      const s = signalState(d.c[4 * d.h[i + 4] + 2], d.h[i + 5], t);
      if (this.state[j] !== s) { this.state[j] = s; changed = true; }
      j++;
    }
    if (changed) this.lamps.geometry.attributes.aState.needsUpdate = true;
  }
}
