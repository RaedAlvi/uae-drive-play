// Instanced street furniture and vegetation: date palms, broadleaf trees, street lamps.
// One InstancedMesh per kind for the whole world; the engine refills them with the
// nearest instances every few frames, so far tiles cost nothing.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { U } from "./materials.js";

function colorize(g, hex) {
  const c = new THREE.Color(hex); const n = g.attributes.position.count; const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[3 * i] = c.r; a[3 * i + 1] = c.g; a[3 * i + 2] = c.b; }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  if (g.index) { const ng = g.toNonIndexed(); ng.computeVertexNormals(); return ng.index ? ng : ng; }
  return g;
}
function clean(g) { for (const k of Object.keys(g.attributes)) if (!["position", "normal", "color"].includes(k)) g.deleteAttribute(k); return g; }

// Date palm: slightly curved ringed trunk, 14 drooping fronds, date clusters.
function palmGeometry(lod = 0) {
  const parts = [];
  const H = 8.5;
  // trunk as stacked tapered segments with a gentle lean
  // one smooth tapered trunk with a gentle curve; ring texture from vertex colours
  {
    const rings = lod ? 4 : 14, radial = lod ? 5 : 8, pos = [], col = [], idx = [];
    const cA = new THREE.Color("#7b6146"), cB = new THREE.Color("#5f4a35");
    for (let j = 0; j <= rings; j++) {
      const t = j / rings, y = H * t, r = 0.34 - 0.13 * t + 0.06 * Math.max(0, 1 - t * 6), bend = 0.55 * t * t;
      const c = (j % 2 ? cA : cB);
      for (let i = 0; i <= radial; i++) { const a = i / radial * Math.PI * 2; pos.push(bend + Math.cos(a) * r, y, Math.sin(a) * r); col.push(c.r, c.g, c.b); }
    }
    for (let j = 0; j < rings; j++) for (let i = 0; i < radial; i++) { const a = j * (radial + 1) + i, b = a + radial + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeVertexNormals();
    parts.push(g.toNonIndexed());
  }
  const top = new THREE.Vector3(0.55, H, 0);
  // crown ball + dates
  const crown = new THREE.SphereGeometry(0.45, 7, 5); crown.translate(top.x, top.y, top.z); parts.push(clean(colorize(crown, "#5d6b33")));
  for (let k = 0; k < (lod ? 0 : 4); k++) { const a = k / 4 * Math.PI * 2 + 0.4; const d = new THREE.SphereGeometry(0.28, 5, 4); d.scale(1, 1.4, 1); d.translate(top.x + Math.cos(a) * 0.45, top.y - 0.55, top.z + Math.sin(a) * 0.45); parts.push(clean(colorize(d, "#b86b1d"))); }
  // fronds: V-section strips that arch up then droop
  const N = lod ? 9 : 14;
  for (let k = 0; k < N; k++) {
    const az = k / N * Math.PI * 2 + (k % 2) * 0.2;
    const tilt = k % 2 ? 0.55 : 0.25;          // alternate upper and lower ring
    const L = 3.9 + (k % 3) * 0.35, steps = lod ? 3 : 7, wMax = lod ? 0.9 : 0.75;
    const pos = [], col = [], idx = [];
    const cG = new THREE.Color(k % 3 === 0 ? "#4f6b2a" : "#5c7a31"), cT = new THREE.Color("#8a9a4a");
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const r = L * t;
      const y = Math.sin(tilt) * r * 0.9 - 1.9 * t * t;      // arch then droop
      const w = wMax * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (1 - 0.3 * t);
      const cx = Math.cos(az), cz = Math.sin(az);
      const px = top.x + cx * r, pz = top.z + cz * r, py = top.y + y;
      const sx = -cz * w, sz = cx * w;
      // three points across: left edge, centre rib (raised), right edge -> V section
      pos.push(px + sx, py - 0.18 * w, pz + sz, px, py + 0.06, pz, px - sx, py - 0.18 * w, pz - sz);
      const c = cG.clone().lerp(cT, t * 0.6);
      col.push(c.r, c.g, c.b, c.r * 0.8, c.g * 0.8, c.b * 0.8, c.r, c.g, c.b);
      if (s < steps) { const b = s * 3; idx.push(b, b + 3, b + 1, b + 1, b + 3, b + 4, b + 1, b + 4, b + 2, b + 2, b + 4, b + 5); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    const ng = g.toNonIndexed(); ng.computeVertexNormals();
    // double-sided look without a double-sided material: add the flipped copy
    const flip = ng.clone(); const p = flip.attributes.position.array, n = flip.attributes.normal.array;
    for (let i = 0; i < p.length; i += 9) { for (let j = 0; j < 3; j++) { const t0 = p[i + 3 + j]; p[i + 3 + j] = p[i + 6 + j]; p[i + 6 + j] = t0; const t1 = n[i + 3 + j]; n[i + 3 + j] = n[i + 6 + j]; n[i + 6 + j] = t1; } }
    for (let i = 0; i < n.length; i++) n[i] = -n[i];
    const fc = flip.attributes.color.array; for (let i = 0; i < p.length; i += 9) for (let j = 0; j < 3; j++) { const t2 = fc[i + 3 + j]; fc[i + 3 + j] = fc[i + 6 + j]; fc[i + 6 + j] = t2; }
    parts.push(ng); if (!lod) parts.push(flip);
  }
  return mergeGeometries(parts.map(p => p.index ? p.toNonIndexed() : p));
}

// Broadleaf shade tree (neem / ghaf). Near version: a forked trunk and a rounded canopy of
// lumpy clusters, darker underneath and sunlit on top; far version: a few simple blobs.
function treeGeometry(lod = 0) {
  const parts = [];
  const bark = "#6b5541";
  const t = new THREE.CylinderGeometry(0.16, 0.3, 2.7, lod ? 5 : 7, 1, true); t.translate(0, 1.35, 0); parts.push(clean(colorize(t, bark)));
  if (!lod) for (const [ax, az, len] of [[0.5, 0.2, 1.6], [-0.45, -0.3, 1.4], [0.1, -0.55, 1.3]]) {
    const br = new THREE.CylinderGeometry(0.07, 0.13, len, 5, 1, true); br.translate(0, len / 2, 0);
    br.rotateZ(-ax); br.rotateX(az); br.translate(0, 2.4, 0); parts.push(clean(colorize(br, bark)));
  }
  const blobs = lod ? [[0, 3.7, 0, 2.0], [1.1, 3.3, 0.4, 1.35], [-0.9, 3.4, -0.5, 1.45], [0.2, 4.4, -0.5, 1.25]]
    : [[0, 3.8, 0, 1.9], [1.2, 3.4, 0.5, 1.35], [-1.1, 3.5, -0.4, 1.4], [0.4, 4.6, -0.6, 1.25], [-0.5, 4.4, 0.8, 1.2], [0.9, 3.9, -1.0, 1.15], [-1.0, 3.1, 0.9, 1.05], [0.1, 3.2, 1.3, 1.0]];
  const cLow = new THREE.Color("#3f5a26"), cHigh = new THREE.Color("#7a9a45");
  blobs.forEach(([x, y, z, r], i) => {
    let g = new THREE.IcosahedronGeometry(r, lod ? 0 : 1);
    g = g.index ? g.toNonIndexed() : g;
    const p = g.attributes.position;
    // lumpy: push each vertex in or out by a hash of its direction (same for shared corners)
    for (let k = 0; k < p.count; k++) {
      const vx = p.getX(k), vy = p.getY(k), vz = p.getZ(k), l = Math.hypot(vx, vy, vz) || 1;
      const h = Math.sin(vx * 12.9898 / l + vy * 78.233 / l + vz * 37.719 / l + i * 3.1) * 43758.5453; const n = h - Math.floor(h);
      const f = 1 + (n - 0.5) * (lod ? 0.2 : 0.34);
      p.setXYZ(k, vx * f, vy * f * 0.82, vz * f);
    }
    g.translate(x, y, z);
    const col = new Float32Array(p.count * 3), c = new THREE.Color();
    for (let k = 0; k < p.count; k++) { const u = Math.max(0, Math.min(1, (p.getY(k) - 2.2) / 3.4)); c.copy(cLow).lerp(cHigh, u * 0.85 + (i % 3) * 0.05); col.set([c.r, c.g, c.b], 3 * k); }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.deleteAttribute("uv"); g.computeVertexNormals();
    parts.push(g);
  });
  return mergeGeometries(parts.map(p => p.index ? p.toNonIndexed() : p));
}

// Desert scrub (young ghaf, arfaj): a low grey-green mound of a few flattened lumps.
function shrubGeometry() {
  const parts = [];
  [[0, 0.55, 0, 0.8], [0.6, 0.4, 0.3, 0.55], [-0.5, 0.45, -0.3, 0.6]].forEach(([x, y, z, r], i) => {
    let g = new THREE.IcosahedronGeometry(r, 0); g = g.toNonIndexed(); g.scale(1.25, 0.8, 1.2); g.translate(x, y, z);
    parts.push(clean(colorize(g, i === 0 ? "#7d8457" : i === 1 ? "#8e9163" : "#6f7a4c")));
  });
  return mergeGeometries(parts.map(p => p.index ? p.toNonIndexed() : p));
}

// Street lamp: tall pole with a single arm reaching over the road (local -Z), and the head.
function lampGeometry() {
  const body = [];
  const pole = new THREE.CylinderGeometry(0.09, 0.16, 11, 6, 1, true); pole.translate(0, 5.5, 0); body.push(clean(colorize(pole, "#9aa1a8")));
  const base = new THREE.CylinderGeometry(0.28, 0.32, 0.6, 6); base.translate(0, 0.3, 0); body.push(clean(colorize(base, "#8b9197")));
  const arm = new THREE.BoxGeometry(0.1, 0.1, 2.6); arm.translate(0, 10.9, -1.25); body.push(clean(colorize(arm, "#9aa1a8")));
  const housing = new THREE.BoxGeometry(0.45, 0.14, 0.9); housing.translate(0, 10.85, -2.55); body.push(clean(colorize(housing, "#6f757b")));
  const head = new THREE.BoxGeometry(0.36, 0.05, 0.75); head.translate(0, 10.76, -2.55);
  return { body: mergeGeometries(body.map(p => p.index ? p.toNonIndexed() : p)), head: clean(head.index ? head.toNonIndexed() : head) };
}

// Dubai's air-conditioned bus shelter: a glass box with a white frame, a roof slab and the
// AC unit on top. Front (the door side) faces local +Z, toward the road.
function shelterGeometry() {
  const frame = [], glass = [];
  const L = 5.4, D = 2.1, H = 2.5;
  const add = (arr, g, hex) => arr.push(clean(colorize(g, hex)));
  let g = new THREE.BoxGeometry(L + 0.5, 0.18, D + 0.6); g.translate(0, H + 0.09, 0.1); add(frame, g, "#eceef0");          // roof
  g = new THREE.BoxGeometry(L - 1.6, 0.55, 1.1); g.translate(0.4, H + 0.46, -0.3); add(frame, g, "#d9dcdf");             // AC unit
  g = new THREE.BoxGeometry(L, 0.12, D); g.translate(0, 0.06, 0); add(frame, g, "#b9bcbf");                                // floor
  for (const x of [-L / 2, L / 2]) for (const z of [-D / 2, D / 2]) { g = new THREE.BoxGeometry(0.1, H, 0.1); g.translate(x, H / 2, z); add(frame, g, "#f4f5f6"); }
  g = new THREE.BoxGeometry(1.1, 0.5, 0.06); g.translate(-L / 2 + 0.8, H - 0.35, D / 2 + 0.02); add(frame, g, "#c8102e");   // the red RTA bus sign band
  g = new THREE.BoxGeometry(L, H - 0.1, 0.03); g.translate(0, H / 2, -D / 2); add(glass, g, "#7fa7b3");                     // back
  for (const x of [-L / 2, L / 2]) { g = new THREE.BoxGeometry(0.03, H - 0.1, D); g.translate(x, H / 2, 0); add(glass, g, "#7fa7b3"); }
  g = new THREE.BoxGeometry(L - 1.3, H - 0.1, 0.03); g.translate(-0.6, H / 2, D / 2); add(glass, g, "#7fa7b3");            // front, with the door gap at +X
  const m = parts => mergeGeometries(parts.map(q => q.index ? q.toNonIndexed() : q));
  return { frame: m(frame), glass: m(glass) };
}
function unitBox() { const g = new THREE.BoxGeometry(1, 1, 1); g.translate(0, 0.5, 0); return g; }
function unitCyl() { const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 10); g.translate(0, 0.5, 0); return g; }

export class Props {
  constructor(scene) {
    this.scene = scene;
    const veg = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
    const metal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.6 });
    this.headMat = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.4, emissive: 0xffd9a0, emissiveIntensity: 0 });
    const lamp = lampGeometry();
    this.kinds = {
      palm: this.make(palmGeometry(0), veg, 450, true),
      palmFar: this.make(palmGeometry(1), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide }), 1800, false),
      tree: this.make(treeGeometry(0), veg, 260, true),
      treeFar: this.make(treeGeometry(1), veg, 900, false),
      shrub: this.make(shrubGeometry(), veg, 1600, false),
      lamp: this.make(lamp.body, metal, 1600, true),
      head: this.make(lamp.head, this.headMat, 1600, false),
    };
    // rooftop plant (boxes: condensers, stair houses, panel tanks; cylinders: round tanks, antennas)
    const plant = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.15 });
    this.roofBox = this.make(unitBox(), plant, 3000, false); this.roofBox.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3000 * 3), 3);
    this.roofCyl = this.make(unitCyl(), plant, 1200, false); this.roofCyl.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(1200 * 3), 3);
    const sh = shelterGeometry();
    this.shelter = this.make(sh.frame, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.2 }), 80, true);
    this.shelterGlass = this.make(sh.glass, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.08, metalness: 0.3, transparent: true, opacity: 0.42, depthWrite: false }), 80, false);
    this._c = new THREE.Color();
    this.src = new Map();   // tileKey -> { palm: Float32Array world [x,z,rot,s], tree, lamp }
    this.frame = 0;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(); this._e = new THREE.Euler();
  }
  make(geo, mat, cap, shadow) {
    const im = new THREE.InstancedMesh(geo, mat, cap); im.count = 0; im.castShadow = shadow; im.receiveShadow = false; im.frustumCulled = false;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.scene.add(im); return im;
  }
  setTile(key, data) { this.src.set(key, data); this.dirty = true; }
  dropTile(key) { this.src.delete(key); this.dirty = true; }
  // data arrays are in tile-local metres; `off` gives the tile's world offset at call time
  update(camX, camZ, offsets, night) {
    this.headMat.emissiveIntensity = 3.2 * night;
    if (++this.frame % 20 !== 0 && !this.dirty) return;
    this.dirty = false;
    const R = { palm: 420, tree: 380, lamp: 700, shrub: 420 };
    for (const kind of ["palm", "tree", "lamp", "shrub"]) {
      const cand = [];
      for (const [key, d] of this.src) {
        const off = offsets.get(key); if (!off) continue;
        const a = d[kind]; if (!a) continue;
        for (let i = 0; i < a.length; i += 4) {
          const x = a[i] + off.x, z = a[i + 1] + off.z; const dx = x - camX, dz = z - camZ; const dd = dx * dx + dz * dz;
          if (dd < R[kind] * R[kind]) cand.push(dd, x, z, a[i + 2], a[i + 3]);
        }
      }
      const n = cand.length / 5; const order = new Array(n); for (let i = 0; i < n; i++) order[i] = i;
      order.sort((p, q) => cand[p * 5] - cand[q * 5]);
      const im = this.kinds[kind], cap = im.instanceMatrix.count;
      const head = kind === "lamp" ? this.kinds.head : null;
      let m = Math.min(n, cap);
      // palms and trees: the nearest ones in full detail, the rest as a light far version
      if (kind === "palm" || kind === "tree") {
        const nearR = kind === "palm" ? 130 : 110;
        let nearN = 0; while (nearN < m && cand[order[nearN] * 5] < nearR * nearR) nearN++;
        const far = kind === "palm" ? this.kinds.palmFar : this.kinds.treeFar, fcap = far.instanceMatrix.count; let fj = 0;
        for (let j = nearN; j < n && fj < fcap; j++) {
          const o = order[j] * 5; const sc = cand[o + 4] % 10;
          this._p.set(cand[o + 1], 0, cand[o + 2]); this._q.setFromEuler(this._e.set(0, cand[o + 3], 0)); this._s.set(sc, sc, sc);
          this._m.compose(this._p, this._q, this._s); far.setMatrixAt(fj++, this._m);
        }
        far.count = fj; far.visible = fj > 0; far.instanceMatrix.needsUpdate = true;
        m = nearN;
      }
      for (let j = 0; j < m; j++) {
        const o = order[j] * 5; const x = cand[o + 1], z = cand[o + 2], rot = cand[o + 3], s = cand[o + 4] % 10;
        // lamps carry their base height in the 4th slot (they stand on ramps and bridges)
        this._p.set(x, kind === "lamp" ? Math.max(0, cand[o + 4] - 0.07) : 0, z); this._q.setFromEuler(this._e.set(0, rot, 0));
        const sc = kind === "lamp" ? 1 : s; this._s.set(sc, sc, sc);
        this._m.compose(this._p, this._q, this._s);
        im.setMatrixAt(j, this._m); if (head) head.setMatrixAt(j, this._m);
      }
      im.count = m; im.visible = m > 0; im.instanceMatrix.needsUpdate = true;
      if (head) { head.count = m; head.visible = m > 0; head.instanceMatrix.needsUpdate = true; }
    }
    this.updatePlant(camX, camZ, offsets);
  }
  // rooftop plant within 450 m and bus shelters within 600 m, nearest first
  updatePlant(camX, camZ, offsets) {
    const cand = [];
    const R2 = 450 * 450;
    for (const [key, d] of this.src) {
      const off = offsets.get(key); if (!off || !d.roof) continue;
      const a = d.roof;
      for (let i = 0; i < a.length; i += 9) { const x = a[i] + off.x, z = a[i + 2] + off.z, dx = x - camX, dz = z - camZ, dd = dx * dx + dz * dz; if (dd < R2) cand.push(dd, i, key); }
    }
    const n = cand.length / 3, order = new Array(n); for (let i = 0; i < n; i++) order[i] = i;
    order.sort((p, q) => cand[p * 3] - cand[q * 3]);
    let nb = 0, nc = 0; const cb = this.roofBox.instanceMatrix.count, cc = this.roofCyl.instanceMatrix.count;
    for (let j = 0; j < n; j++) {
      const o = order[j] * 3, key = cand[o + 2], i = cand[o + 1], a = this.src.get(key).roof, off = offsets.get(key);
      const kind = a[i + 7], cyl = kind === 2 || kind === 3;
      if (cyl ? nc >= cc : nb >= cb) continue;
      this._p.set(a[i] + off.x, a[i + 1], a[i + 2] + off.z); this._q.setFromEuler(this._e.set(0, a[i + 3], 0)); this._s.set(a[i + 4], a[i + 5], a[i + 6]);
      this._m.compose(this._p, this._q, this._s); this._c.setHex(a[i + 8]);
      if (cyl) { this.roofCyl.setMatrixAt(nc, this._m); this.roofCyl.setColorAt(nc++, this._c); } else { this.roofBox.setMatrixAt(nb, this._m); this.roofBox.setColorAt(nb++, this._c); }
    }
    for (const [im, k] of [[this.roofBox, nb], [this.roofCyl, nc]]) { im.count = k; im.visible = k > 0; im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; }
    let ns = 0; const cs = this.shelter.instanceMatrix.count;
    for (const [key, d] of this.src) {
      const off = offsets.get(key); if (!off || !d.shelter) continue;
      const a = d.shelter;
      for (let i = 0; i < a.length && ns < cs; i += 4) {
        const x = a[i] + off.x, z = a[i + 1] + off.z; if ((x - camX) ** 2 + (z - camZ) ** 2 > 600 * 600) continue;
        this._p.set(x, a[i + 3], z); this._q.setFromEuler(this._e.set(0, a[i + 2], 0)); this._s.set(1, 1, 1); this._m.compose(this._p, this._q, this._s);
        this.shelter.setMatrixAt(ns, this._m); this.shelterGlass.setMatrixAt(ns++, this._m);
      }
    }
    for (const im of [this.shelter, this.shelterGlass]) { im.count = ns; im.visible = ns > 0; im.instanceMatrix.needsUpdate = true; }
  }
}
