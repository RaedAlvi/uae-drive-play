// Instanced street furniture and vegetation: date palms, broadleaf trees, street lamps.
// One InstancedMesh per kind for the whole world; the engine refills them with the
// nearest instances every few frames, so far tiles cost nothing.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { U } from "./materials.js";
import { PkTrees } from "./pktrees.js";

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
function unitCyl(n = 10) { const g = new THREE.CylinderGeometry(0.5, 0.5, 1, n); g.translate(0, 0.5, 0); return g; }

const PK_MAP = typeof window !== "undefined" && window.CITY && window.CITY.region === "pakistan";
// Green bilingual boards on the M-2 (art_direction.md section 2: green, white border and text, English with Urdu). The tile worker places them
// (msg.roofs entries of kind 9); only the nearest few are live panels, each with its own canvas. Every name and kilometre comes from city/m2data.js.
const BOARD_BG = "#0e6b3f", BOARD_FG = "#f4f4ee", BOARD_EN = '"Segoe UI", Tahoma, Arial, sans-serif', BOARD_UR = '"Urdu Typesetting", "Jameel Noori Nastaleeq", "Noto Nastaliq Urdu", "Segoe UI", Tahoma, sans-serif';
const BOARD_POOL = 10, BOARD_W = 768, BOARD_H = 320;
function boardName(n) { return n.replace(/,\s*near\s.*$/i, ""); }
function boardShort(n) { return boardName(n).replace(/\s+Interchange$/i, ""); }
function boardShortU(u) { return u.replace(/\s*انٹر\s?چینج\s*$/, ""); }
function boardLine(g, t, x, cy, fs, fam, maxW, align, rtl) {
  if (!t) return;
  g.font = `bold ${fs}px ${fam}`; g.textAlign = align; g.direction = rtl ? "rtl" : "ltr"; g.textBaseline = "alphabetic";
  const m = g.measureText(t), sx = m.width > maxW ? maxW / m.width : 1, by = rtl ? cy + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2 : cy + 0.355 * fs;
  g.save(); g.translate(x, by); g.scale(sx, 1); g.fillText(t, 0, 0); g.restore(); g.direction = "ltr";
}
function drawBoard(g, nodes, kind, a, b, val) {
  const W = BOARD_W, H = BOARD_H;
  g.fillStyle = BOARD_BG; g.fillRect(0, 0, W, H);
  g.strokeStyle = BOARD_FG; g.lineWidth = 7; g.beginPath(); g.roundRect(13, 13, W - 26, H - 26, 22); g.stroke();
  g.fillStyle = BOARD_FG;
  const A = nodes[a], B = nodes[b];
  if (kind === 2) {             // distance board: the next interchange and the end of the motorway
    const rows = a === b ? [[A, Math.floor(val / 1000)]] : [[A, Math.floor(val / 1000)], [B, val % 1000]], rh = (H - 64) / rows.length;
    rows.forEach(([n, km], i) => { const cy = 32 + rh * (i + 0.5); boardLine(g, boardShort(n[0]), 42, cy, 54, BOARD_EN, 300, "left", false); boardLine(g, km + " km", W - 262, cy, 52, BOARD_EN, 140, "right", false); boardLine(g, boardShortU(n[1]), W - 40, cy, 60, BOARD_UR, 202, "right", true); });
    return;
  }
  if (kind === 1) {             // at the exit: keep left, up the slip road
    g.lineWidth = 22; g.lineCap = "round"; g.lineJoin = "round"; g.strokeStyle = BOARD_FG;
    g.beginPath(); g.moveTo(112, 250); g.lineTo(112, 130); g.lineTo(82, 100); g.stroke();
    g.beginPath(); g.moveTo(62, 148); g.lineTo(62, 78); g.lineTo(132, 78); g.stroke();
    boardLine(g, boardName(A[0]), 190, A[1] ? 112 : 160, 60, BOARD_EN, W - 232, "left", false);
    boardLine(g, A[1], W - 42, 222, 74, BOARD_UR, W - 232, "right", true);
    return;
  }
  // advance board: English above Urdu, the distance on the right
  const dist = val >= 1000 ? (val / 1000) + " km" : val + " m", tw = W - 276;
  boardLine(g, boardName(A[0]), 44, A[1] ? 108 : 160, 58, BOARD_EN, tw, "left", false);
  boardLine(g, A[1], 44 + tw - 24, 218, 76, BOARD_UR, tw - 24, "right", true);
  g.fillStyle = BOARD_FG; g.beginPath(); g.roundRect(W - 204, 44, 150, 76, 12); g.fill();
  g.fillStyle = BOARD_BG; boardLine(g, "M-2", W - 129, 82, 54, BOARD_EN, 130, "center", false);
  g.fillStyle = BOARD_FG; boardLine(g, dist, W - 129, 212, 76, BOARD_EN, 196, "center", false);
}
class M2Boards {
  constructor(scene) {
    this.nodes = null; this.items = [];
    import("./m2data.js").then(m => { this.nodes = m.M2_NODES; }).catch(e => console.warn("m2 boards", e));
    const geo = new THREE.PlaneGeometry(1, 1);
    this.pool = [];
    for (let i = 0; i < BOARD_POOL; i++) {
      const c = document.createElement("canvas"); c.width = BOARD_W; c.height = BOARD_H;
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0 });
      const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.visible = false; scene.add(mesh);
      this.pool.push({ g: c.getContext("2d"), tex, mat, mesh, key: "" });
    }
    // one panel stays in the scene, out of sight, so the program is compiled at load and not on the first board you meet
    const w = this.pool[0].mesh; w.visible = true; w.position.set(0, -2000, 0); w.scale.set(0.001, 0.001, 0.001);
  }
  // items are [dd, x, y, z, rot, w, h, code, val] nearest first
  update(list, night) {
    if (!this.nodes) return;
    let drawn = 0;
    for (let i = 0; i < BOARD_POOL; i++) {
      const P = this.pool[i], it = list[i];
      if (!it) { P.mesh.visible = i === 0; if (i === 0) { P.mesh.position.set(0, -2000, 0); P.mesh.scale.set(0.001, 0.001, 0.001); } continue; }
      const key = it[7] + "|" + it[8];
      if (P.key !== key) {
        if (drawn >= 2) { P.mesh.visible = false; continue; }
        const code = it[7], kind = Math.floor(code / 1e6), a = Math.floor((code % 1e6) / 1e3), b = code % 1e3;
        if (!this.nodes[a] || !this.nodes[b]) { P.mesh.visible = false; continue; }
        drawBoard(P.g, this.nodes, kind, a, b, it[8]); P.tex.needsUpdate = true; P.key = key; drawn++;
      }
      P.mesh.position.set(it[1], it[2], it[3]); P.mesh.rotation.set(0, it[4], 0); P.mesh.scale.set(it[5], it[6], 1); P.mesh.visible = true; P.mat.emissiveIntensity = 0.32 * night;
    }
    this.dirty = drawn >= 2;
  }
}

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
      tree: PK_MAP ? null : this.make(treeGeometry(0), veg, 260, true),      // Pakistan has its own trees: pktrees.js
      treeFar: PK_MAP ? null : this.make(treeGeometry(1), veg, 900, false),
      shrub: this.make(shrubGeometry(), veg, 1600, false),
      lamp: this.make(lamp.body, metal, 1600, true),
      head: this.make(lamp.head, this.headMat, 1600, false),
    };
    // rooftop plant (boxes: condensers, stair houses, panel tanks; cylinders: round tanks, antennas)
    const plant = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.15 });
    this.roofBox = this.make(unitBox(), plant, 3000, false); this.roofBox.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3000 * 3), 3);
    const cylCap = PK_MAP ? 2200 : 1200;       // Pakistan: every roof has its water tank, so more of them and fewer sides
    this.roofCyl = this.make(unitCyl(PK_MAP ? 7 : 10), plant, cylCap, false); this.roofCyl.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cylCap * 3), 3);
    const sh = shelterGeometry();
    this.shelter = this.make(sh.frame, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.2 }), 80, true);
    this.shelterGlass = this.make(sh.glass, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.08, metalness: 0.3, transparent: true, opacity: 0.42, depthWrite: false }), 80, false);
    if (PK_MAP) this.pk = new PkTrees(scene, (geo, mat, cap, shadow) => this.make(geo, mat, cap, shadow));
    if (PK_MAP) this.boards = new M2Boards(scene);
    this._c = new THREE.Color();
    this.src = new Map();   // tileKey -> { palm: Float32Array world [x,z,rot,s], tree, lamp }
    this.frame = 0;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(); this._e = new THREE.Euler();
  }
  make(geo, mat, cap, shadow) {
    const im = new THREE.InstancedMesh(geo, mat, cap); im.count = 0; im.castShadow = shadow; im.receiveShadow = false; im.frustumCulled = false;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.scene.add(im); return im;
  }
  setTile(key, data) {
    if (PK_MAP && data.pk) { const a = data.pk; for (let i = 3; i < a.length; i += 4) { const sc = a[i] % 10; if (sc >= 5) a[i] = 40 + sc - 5; } }   // planted M-2 strips: eucalyptus (species 4 in pktrees.js), whatever the zone's mix
    this.src.set(key, data); this.dirty = true;
  }
  dropTile(key) { this.src.delete(key); this.dirty = true; }
  // data arrays are in tile-local metres; `off` gives the tile's world offset at call time
  update(camX, camZ, offsets, night) {
    this.headMat.emissiveIntensity = 3.2 * night;
    if (++this.frame % 20 !== 0 && !this.dirty) return;
    if (this.pk) this.pk.update(this.src, camX, camZ, offsets, this.groundAt, this.dirty);
    this.dirty = false;
    const R = { palm: 420, tree: 380, lamp: 700, shrub: 420 };
    for (const kind of PK_MAP ? ["palm", "lamp", "shrub"] : ["palm", "tree", "lamp", "shrub"]) {
      const cand = [];
      for (const [key, d] of this.src) {
        const off = offsets.get(key); if (!off) continue;
        const a = d[kind]; if (!a) continue;
        for (let i = 0; i < a.length; i += 4) {
          const x = a[i] + off.x, z = a[i + 1] + off.z; const dx = x - camX, dz = z - camZ; const dd = dx * dx + dz * dz;
          if (dd < R[kind] * R[kind]) cand.push(dd, x, z, a[i + 2], a[i + 3], this.groundAt && kind !== "lamp" ? this.groundAt(key, a[i], a[i + 1]) : 0);
        }
      }
      const n = cand.length / 6; const order = new Array(n); for (let i = 0; i < n; i++) order[i] = i;
      order.sort((p, q) => cand[p * 6] - cand[q * 6]);
      const im = this.kinds[kind], cap = im.instanceMatrix.count;
      const head = kind === "lamp" ? this.kinds.head : null;
      let m = Math.min(n, cap);
      // palms and trees: the nearest ones in full detail, the rest as a light far version
      if (kind === "palm" || kind === "tree") {
        const nearR = kind === "palm" ? 130 : 110;
        let nearN = 0; while (nearN < m && cand[order[nearN] * 6] < nearR * nearR) nearN++;
        const far = kind === "palm" ? this.kinds.palmFar : this.kinds.treeFar, fcap = far.instanceMatrix.count; let fj = 0;
        for (let j = nearN; j < n && fj < fcap; j++) {
          const o = order[j] * 6; const sc = cand[o + 4] % 10;
          this._p.set(cand[o + 1], cand[o + 5], cand[o + 2]); this._q.setFromEuler(this._e.set(0, cand[o + 3], 0)); this._s.set(sc, sc, sc);
          this._m.compose(this._p, this._q, this._s); far.setMatrixAt(fj++, this._m);
        }
        far.count = fj; far.visible = fj > 0; far.instanceMatrix.needsUpdate = true;
        m = nearN;
      }
      for (let j = 0; j < m; j++) {
        const o = order[j] * 6; const x = cand[o + 1], z = cand[o + 2], rot = cand[o + 3], s = cand[o + 4] % 10;
        // lamps carry their base height in the 4th slot (they stand on ramps and bridges)
        this._p.set(x, kind === "lamp" ? Math.max(0, cand[o + 4] - 0.07) : cand[o + 5], z); this._q.setFromEuler(this._e.set(0, rot, 0));
        const sc = kind === "lamp" ? 1 : s; this._s.set(sc, sc, sc);
        this._m.compose(this._p, this._q, this._s);
        im.setMatrixAt(j, this._m); if (head) head.setMatrixAt(j, this._m);
      }
      im.count = m; im.visible = m > 0; im.instanceMatrix.needsUpdate = true;
      if (head) { head.count = m; head.visible = m > 0; head.instanceMatrix.needsUpdate = true; }
    }
    this._night = night; this.updatePlant(camX, camZ, offsets);
  }
  // rooftop plant within 450 m and bus shelters within 600 m, nearest first
  updatePlant(camX, camZ, offsets) {
    const cand = [];
    const R2 = PK_MAP ? 300 * 300 : 450 * 450;     // Pakistan: every roof has a tank, and from the road they are specks past 300 m
    for (const [key, d] of this.src) {
      const off = offsets.get(key); if (!off || !d.roof) continue;
      const a = d.roof;
      for (let i = 0; i < a.length; i += 9) { const x = a[i] + off.x, z = a[i + 2] + off.z, dx = x - camX, dz = z - camZ, dd = dx * dx + dz * dz; if (dd < R2) cand.push(dd, i, key); }
    }
    const n = cand.length / 3, order = new Array(n); for (let i = 0; i < n; i++) order[i] = i;
    order.sort((p, q) => cand[p * 3] - cand[q * 3]);
    let nb = 0, nc = 0; const cb = this.roofBox.instanceMatrix.count, cc = this.roofCyl.instanceMatrix.count, board = this.boards ? [] : null;
    for (let j = 0; j < n; j++) {
      const o = order[j] * 3, key = cand[o + 2], i = cand[o + 1], a = this.src.get(key).roof, off = offsets.get(key);
      const kind = a[i + 7], cyl = kind === 2 || kind === 3;
      if (kind === 9) { if (board && board.length < BOARD_POOL) board.push([cand[o], a[i] + off.x, a[i + 1], a[i + 2] + off.z, a[i + 3], a[i + 4], a[i + 5], a[i + 6], a[i + 8]]); continue; }
      if (cyl ? nc >= cc : nb >= cb) continue;
      this._p.set(a[i] + off.x, a[i + 1], a[i + 2] + off.z); this._q.setFromEuler(this._e.set(0, a[i + 3], 0)); this._s.set(a[i + 4], a[i + 5], a[i + 6]);
      this._m.compose(this._p, this._q, this._s); this._c.setHex(a[i + 8]);
      if (cyl) { this.roofCyl.setMatrixAt(nc, this._m); this.roofCyl.setColorAt(nc++, this._c); } else { this.roofBox.setMatrixAt(nb, this._m); this.roofBox.setColorAt(nb++, this._c); }
    }
    if (board) { this.boards.update(board, this._night); if (this.boards.dirty) this.dirty = true; }
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
