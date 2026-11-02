// Pedestrians on the sidewalks of urban roads: low-poly people (kandura, abaya, casual),
// instanced, walking along the same road graph the traffic uses, offset onto the pavement.
// They step out of the way of the player's car.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

function tint(g, hex) { const c = new THREE.Color(hex); const n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[3 * i] = c.r; a[3 * i + 1] = c.g; a[3 * i + 2] = c.b; } g.setAttribute("color", new THREE.BufferAttribute(a, 3)); for (const k of Object.keys(g.attributes)) if (!["position", "normal", "color"].includes(k)) g.deleteAttribute(k); return g.index ? g.toNonIndexed() : g; }

// Three outfits share one skeleton layout: torso/robe (instance colour), head (skin), legs (swing).
function bodyGeometry(long) {
  // long = robe to the ankle (kandura, abaya); short = shirt with trousers below
  const parts = [];
  if (long) { const r = new THREE.CylinderGeometry(0.2, 0.3, 1.38, 8); r.translate(0, 0.72, 0); parts.push(tint(r, "#ffffff")); }
  else { const t = new THREE.CylinderGeometry(0.2, 0.19, 0.62, 8); t.translate(0, 1.12, 0); parts.push(tint(t, "#ffffff")); }
  const sh = new THREE.SphereGeometry(0.21, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2); sh.scale(1.15, 0.5, 0.8); sh.translate(0, 1.42, 0); parts.push(tint(sh, "#ffffff"));
  for (const s of [-1, 1]) { const a = new THREE.CylinderGeometry(0.06, 0.055, 0.6, 5); a.translate(s * 0.26, 1.14, 0); a.rotateZ(s * 0.06); parts.push(tint(a, "#ffffff")); }
  return mergeGeometries(parts);
}
function headGeometry() {
  const h = new THREE.SphereGeometry(0.12, 8, 6); h.scale(0.9, 1.1, 1); h.translate(0, 1.6, 0);
  return tint(h, "#ffffff");
}
function legGeometry() {
  // hip pivot at y = 0.82: a leg hangs down from the origin, rotated around x to swing
  const l = new THREE.CylinderGeometry(0.075, 0.06, 0.82, 5); l.translate(0, -0.41, 0);
  const f = new THREE.BoxGeometry(0.1, 0.06, 0.22); f.translate(0, -0.79, -0.05);
  return mergeGeometries([tint(l, "#ffffff"), tint(f, "#ffffff")]);
}

const OUTFITS = [
  { w: 0.2, long: true, robe: 0xf4f2ec, legs: 0xd9d4c8, head: 0xfbfbf8 },        // kandura + ghutra
  { w: 0.18, long: true, robe: 0x151515, legs: 0x111111, head: 0x1a1a1a },       // abaya + shayla
  { w: 0.62, long: false, robe: null, legs: null, head: null },                  // casual
];
const SHIRTS = [0x2f5d8a, 0xd4d4d4, 0x8a2c2c, 0x3c6e47, 0xe0c28a, 0x222222, 0x6b5b95, 0xf0f0f0, 0x1f3a5f];
const TROUSERS = [0x2b2f3a, 0x3d3a33, 0x1e2a3a, 0x6b6456, 0x222222];
const SKIN = [0x8d5a3b, 0xb07a52, 0xc99474, 0x6e4630, 0xe0b08e];

export class Peds {
  constructor(scene, traffic) {
    this.traffic = traffic; this.list = []; this.target = 50; this.cap = 140;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
    const mk = geo => { const im = new THREE.InstancedMesh(geo, mat, this.cap); im.count = 0; im.castShadow = true; im.frustumCulled = false; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 3).fill(1), 3); scene.add(im); return im; };
    this.robe = mk(bodyGeometry(true)); this.shirt = mk(bodyGeometry(false)); this.head = mk(headGeometry());
    this.legL = mk(legGeometry()); this.legR = mk(legGeometry());
    this._m = new THREE.Matrix4(); this._m2 = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(1, 1, 1); this._e = new THREE.Euler(); this._c = new THREE.Color();
  }
  spawn(px, pz) {
    const T = this.traffic; const cand = [];
    for (const L of T.nearLines(px, pz)) {
      if (L.c < 2 || L.c > 5 || L.e) continue;                // pavements on primary..minor streets, not on flyovers
      const i = Math.floor(Math.random() * (L.n - 1));
      const d = Math.hypot(L.pts[2 * i] - px, L.pts[2 * i + 1] - pz);
      if (d > 40 && d < 170) { cand.push([L, i]); if (cand.length > 12) break; }
    }
    if (!cand.length) return;
    const [L, i] = cand[Math.floor(Math.random() * cand.length)];
    let r = Math.random(), o = OUTFITS[2]; for (const x of OUTFITS) { r -= x.w; if (r <= 0) { o = x; break; } }
    const pick = a => a[Math.floor(Math.random() * a.length)];
    this.list.push({
      // one-way carriageways (half of a dual road) only have a pavement on the outer, right-hand side
      line: L.id, s: L.cum[i] + Math.random() * (L.cum[i + 1] - L.cum[i]), dir: Math.random() < 0.5 ? 1 : -1, side: L.ow ? -1 : (Math.random() < 0.5 ? 1 : -1),
      v: 1.1 + Math.random() * 0.5, phase: Math.random() * 6.28, long: o.long,
      robe: o.robe ?? pick(SHIRTS), legs: o.legs ?? pick(TROUSERS), head: o.head ?? pick(SKIN), dodge: 0, x: 0, z: 0, hx: 0, hz: 1,
    });
  }
  update(dt, player, gx, gz, night) {
    const T = this.traffic; const px = player.x + gx, pz = player.z + gz;
    const want = Math.round(this.target * (1 - 0.6 * night));
    this.list = this.list.filter(p => T.lines.has(p.line) && Math.hypot(p.x - px, p.z - pz) < 230);
    if (this.list.length < want) this.spawn(px, pz);
    let nr = 0, ns = 0;
    for (const p of this.list) {
      const L = T.lines.get(p.line);
      p.s += p.v * dt * p.dir;
      if (p.s < 0 || p.s > L.len) { p.dir = -p.dir; p.s = Math.max(0, Math.min(L.len, p.s)); }
      let i = 0; while (i < L.n - 2 && L.cum[i + 1] < p.s) i++;
      const t = (p.s - L.cum[i]) / Math.max(1e-6, L.cum[i + 1] - L.cum[i]);
      let dx = L.pts[2 * i + 2] - L.pts[2 * i], dz = L.pts[2 * i + 3] - L.pts[2 * i + 1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const off = (L.w / 2 + 1.4) * p.side;                       // on the pavement beside the carriageway
      let x = L.pts[2 * i] + dx * l * t + dz * off, z = L.pts[2 * i + 1] + dz * l * t - dx * off;
      // step aside when the player's car comes close
      const cx = x - px, cz = z - pz, cd = Math.hypot(cx, cz);
      if (cd < 5) p.dodge = Math.min(3, p.dodge + dt * 6); else p.dodge = Math.max(0, p.dodge - dt);
      if (p.dodge > 0 && cd > 0.01) { x += cx / cd * p.dodge; z += cz / cd * p.dodge; }
      p.x = x; p.z = z; p.hx = dx * p.dir; p.hz = dz * p.dir;
      p.phase += dt * p.v * 5.2;
      const yaw = Math.atan2(-p.hx, -p.hz);
      this._p.set(x - gx, 0.17, z - gz); this._q.setFromEuler(this._e.set(0, yaw, 0)); this._m.compose(this._p, this._q, this._s);
      const body = p.long ? this.robe : this.shirt; const j = p.long ? nr++ : ns++;
      body.setMatrixAt(j, this._m); body.setColorAt(j, this._c.set(p.robe));
      const k = nr + ns - 1;
      this.head.setMatrixAt(k, this._m); this.head.setColorAt(k, this._c.set(p.head));
      const swing = Math.sin(p.phase) * (p.long ? 0.25 : 0.5);
      for (const [im, sgn, sx] of [[this.legL, 1, -0.1], [this.legR, -1, 0.1]]) {
        this._m2.makeRotationX(swing * sgn); this._m2.setPosition(sx, 0.82, 0);
        im.setMatrixAt(k, this._m2.premultiply(this._m)); im.setColorAt(k, this._c.set(p.legs));
      }
    }
    for (const [im, n] of [[this.robe, nr], [this.shirt, ns], [this.head, nr + ns], [this.legL, nr + ns], [this.legR, nr + ns]]) { im.count = n; im.visible = n > 0; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }
  }
}
