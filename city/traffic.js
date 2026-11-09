// AI traffic on the real road graph. The idea comes from God's Eye View's traffic layer
// (simulated vehicles flowing along OSM roads at class speeds); here they are 3D cars in
// lanes, keep right, follow the car ahead, overtake slower cars by changing lane, stop at
// red lights, brake for the player, and turn at junctions.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { CITY, K, origin } from "./world.js";

const SPEED = [27, 22, 16.5, 14, 12, 9.5, 6.5];           // m/s by road class code 0 motorway .. 6 service
const LANE_W = 3.4;

// Pakistan drives on the left, and the mix of vehicles depends on the road (art_direction.md section 4).
const PK = CITY.region === "pakistan";
const RE = 6378137;
// Metrobus Red Line station coordinates (build/pk/research/rawalpindi.json), Saddar to Pak Secretariat.
const METRO = [[33.59378, 73.05615], [33.59952, 73.06266], [33.60607, 73.06582], [33.61378, 73.06508], [33.62073, 73.06614], [33.62982, 73.07185], [33.63645, 73.07503], [33.64357, 73.07787], [33.65068, 73.08044], [33.66126, 73.08303], [33.6565, 73.07204], [33.66078, 73.0656], [33.66902, 73.05939], [33.67554, 73.05448], [33.68462, 73.04756], [33.68981, 73.04304], [33.69577, 73.03857], [33.70234, 73.04151], [33.70588, 73.04829], [33.71166, 73.0593], [33.71804, 73.07149], [33.721496, 73.078114], [33.72475, 73.084338], [33.734674, 73.092559]];
function metroDist(lat, lon) {
  const k = Math.cos(lat * Math.PI / 180); let best = 1e12;
  for (let i = 0; i < METRO.length - 1; i++) {
    if (i === 9) continue;                                    // the list goes Faizabad then IJP: the line turns there, do not draw a chord between them
    const a = METRO[i], b = METRO[i + 1], dx = (b[1] - a[1]) * k, dy = b[0] - a[0], px = (lon - a[1]) * k, py = lat - a[0];
    const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(px - t * dx, py - t * dy) * 111320);
  }
  return best;
}

// Pakistan: how much traffic each kind of place carries, as a multiple of the quality setting's base target (60 at normal
// quality, so 120 in the Pindi bazaars), and how many of those belong on the road you are driving. All estimates, tuned by measured counts.
const PK_MAX_TARGET = 170;
const PKZ = {
  shop: { f: 2, band: 26, ring: 190, despawn: 230, behind: 100, dmax: 150, share: 0.6 },
  city: { f: 1.4, band: 18, ring: 220, despawn: 260, behind: 110, dmax: 150, share: 0.6 },
  lahore: { f: 1.5, band: 20, ring: 220, despawn: 260, behind: 110, dmax: 150, share: 0.6 },
  isb: { f: 1, band: 12, ring: 260, despawn: 300, behind: 130, dmax: 150, share: 0.6 },
  soc: { f: 0.8, band: 8, ring: 260, despawn: 300, behind: 130, dmax: 150, share: 0.6 },
  hill: { f: 0.9, band: 10, ring: 240, despawn: 280, behind: 120, dmax: 150, share: 0.6 },
  rural: { f: 0.6, band: 6, ring: 300, despawn: 340, behind: 160, dmax: 180, share: 0.6 },
  motor: { f: 0.75, band: 34, ring: 400, despawn: 560, behind: 260, dmax: 420, share: 0.8 },
};
// Raed played it and asked for half the traffic: this scales the moving vehicles and the kerbside ones together.
const PK_TRAFFIC = 0.5;
for (const z of Object.values(PKZ)) { z.f *= PK_TRAFFIC; z.band = Math.max(2, Math.round(z.band * PK_TRAFFIC)); }

// The bazaar boxes used for frontage in tileworker.js (PK_SHOP): Raja Bazaar, Saddar, and the Committee Chowk stretch
const PK_SHOP_BOX = [[73.045, 33.605, 73.066, 33.622], [73.043, 33.589, 73.063, 33.603], [73.066, 33.6335, 73.076, 33.6415]];
const pkShop = (lat, lon) => PK_SHOP_BOX.some(b => lon > b[0] && lon < b[2] && lat > b[1] && lat < b[3]);
// Fawara Chowk to Raja Bazaar to Moti Bazaar: the standardised stretch (tileworker.js pkNoWires), cleared of carts and vans
function pkCleared(lat, lon) {
  const P = [[73.05528, 33.61306], [73.056339, 33.612309], [73.058367, 33.613926]], k = Math.cos(33.6 * Math.PI / 180);
  for (let i = 0; i < 2; i++) { const dx = (P[i + 1][0] - P[i][0]) * k, dy = P[i + 1][1] - P[i][1], px = (lon - P[i][0]) * k, py = lat - P[i][1], t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy))); if (Math.hypot(px - dx * t, py - dy * t) * 111000 < 60) return true; }
  return false;
}
function pkZoneKey(lat, lon) {
  if (pkShop(lat, lon)) return "shop";
  if (lat > 33.76 && lon >= 73.2) return "hill";
  if (lat > 33.54 && lat < 33.665 && lon > 72.98 && lon < 73.13) return "city";
  if (lat >= 33.655 && lat < 33.78 && lon > 72.95 && lon < 73.2) return "isb";
  if (lat > 33.47 && lat <= 33.57 && lon > 73.05 && lon < 73.22) return "soc";
  if (lat < 31.75) return "lahore";
  return "rural";
}
// A small random stream per road, so a street keeps the same parked vehicles when you come back to it
function pkRng(a, b) { let h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)) >>> 0; return () => { h = (h + 0x6D2B79F5) >>> 0; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// Produce and general goods, the same estimated colours as the bazaar dressing in tileworker.js
const CART_GOODS = [0xd67a1f, 0xd6b21f, 0xa82a2a, 0x8a9a3a, 0xc6462a, 0xb3261e, 0x1f5aa6, 0x2e7d4f];
const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);
function vcol(g, hex) { const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[3 * i] = c.r; a[3 * i + 1] = c.g; a[3 * i + 2] = c.b; } g.setAttribute("color", new THREE.BufferAttribute(a, 3)); for (const k of Object.keys(g.attributes)) if (!["position", "normal", "color"].includes(k)) g.deleteAttribute(k); return g.index ? g.toNonIndexed() : g; }
// A two-wheeled barrow, 2 m long, propped on a front leg: wooden bed, bicycle wheels, two push handles (faces -z)
function cartFrame() {
  const wood = 0x7a5a38, iron = 0x26282b, P = [];
  const box = (w, h, d, x, y, z, hex) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); P.push(vcol(g, hex)); };
  box(0.96, 0.05, 1.9, 0, 0.8, 0, wood);
  for (const s of [-1, 1]) { box(0.05, 0.14, 1.9, s * 0.48, 0.88, 0, wood); box(0.04, 0.04, 0.8, s * 0.34, 0.86, 1.3, iron); const w = new THREE.CylinderGeometry(0.34, 0.34, 0.04, 12); w.rotateZ(Math.PI / 2); w.translate(s * 0.55, 0.34, 0.15); P.push(vcol(w, iron)); }
  for (const z of [-0.95, 0.95]) box(0.96, 0.14, 0.05, 0, 0.88, z, wood);
  box(0.04, 0.76, 0.04, 0, 0.38, -0.75, iron);
  box(0.06, 0.06, 0.9, 0, 0.46, 0.15, iron);
  return mergeGeometries(P);
}
// The heap on the bed: a low dark mound with loose fruit or parcels over it, tinted per cart
function cartGoods() {
  const P = [], m = new THREE.SphereGeometry(0.5, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2); m.scale(0.86, 0.24, 1.75); m.translate(0, 0.89, 0); P.push(vcol(m, 0x6a6a6a));
  const R = pkRng(5, 11);
  for (let i = 0; i < 26; i++) { const q = 0.08 + R() * 0.03, g = new THREE.IcosahedronGeometry(q, 0), a = R() * 6.28, r = Math.sqrt(R()), x = Math.cos(a) * r * 0.36, z = Math.sin(a) * r * 0.78; g.translate(x, 0.92 + 0.13 * (1 - r * r), z); P.push(vcol(g, i % 3 === 2 ? 0xc4c4c4 : 0xffffff)); }
  return mergeGeometries(P);
}
// The motorbike type carries its rider: the shirt is the paint part, and head, hair and trousers sit in the detail part. Parked bikes need the bike alone.
function riderlessDetail(g) {
  const pos = g.attributes.position, col = g.attributes.color, idx = g.index, n = idx ? idx.count : pos.count, keep = [];
  const pants = new THREE.Color(0xcfc9ba), srgb = [0xcf / 255, 0xc9 / 255, 0xba / 255];
  const isPants = v => { if (!col) return false; const r = col.getX(v), gg = col.getY(v), b = col.getZ(v); return (Math.abs(r - pants.r) + Math.abs(gg - pants.g) + Math.abs(b - pants.b) < 0.02) || (Math.abs(r - srgb[0]) + Math.abs(gg - srgb[1]) + Math.abs(b - srgb[2]) < 0.02); };
  for (let i = 0; i < n; i += 3) {
    const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, c = idx ? idx.getX(i + 2) : i + 2;
    if ((pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3 > 1.2 || isPants(a)) continue;
    keep.push(a, b, c);
  }
  const out = g.clone(); out.setIndex(keep); return out;
}

// Where a type's lamps really are, read from its light quads (a truck's prow or a bus's destination board must not count)
function lampsOf(t) {
  const out = { fx: 0.6, fy: 0.7, fz: t.zFront || -2, rx: 0.6, ry: 0.85, rz: t.zRear || 2 }, g = t.lights;
  if (!g || !g.attributes.position.count) return out;
  const p = g.attributes.position; let z0 = 1e9, z1 = -1e9;
  for (let i = 0; i < p.count; i++) if (p.getY(i) < 1.7) { z0 = Math.min(z0, p.getZ(i)); z1 = Math.max(z1, p.getZ(i)); }
  let nf = 0, nr = 0, fx = 0, fy = 0, rx = 0, ry = 0;
  for (let i = 0; i < p.count; i++) { const y = p.getY(i), z = p.getZ(i), x = Math.abs(p.getX(i)); if (y >= 1.7) continue; if (z < z0 + 0.3) { nf++; fx += x; fy += y; } else if (z > z1 - 0.3) { nr++; rx += x; ry += y; } }
  if (nf) { out.fx = fx / nf; out.fy = fy / nf; out.fz = z0; } if (nr) { out.rx = rx / nr; out.ry = ry / nr; out.rz = z1; }
  return out;
}
// Soft light textures: a round glow for the lamps, and a beam that is brightest at its near end and fades along its length
function glowTexture(beam) {
  const S = 64, cv = document.createElement("canvas"); cv.width = cv.height = S; const g = cv.getContext("2d"), d = g.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S * 2 - 1, v = (y + 0.5) / S; let a;
    if (beam) { const t = v, w = 0.3 + 0.7 * t, e = Math.max(0, 1 - Math.abs(u) / w); a = e * e * (3 - 2 * e) * Math.pow(1 - t, 1.5) * Math.min(1, t * 9); }
    else { const r = Math.hypot(u, v * 2 - 1), e = Math.max(0, 1 - r); a = e * e * e; }
    const i = 4 * (x + y * S), b = Math.round(255 * a); d.data[i] = b; d.data[i + 1] = b; d.data[i + 2] = b; d.data[i + 3] = 255;
  }
  g.putImageData(d, 0, 0); const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// One instance per vehicle, origin at the lamp line, -z forward: a pool on the road and a thin blade of light from each lamp. x is scaled to the lamp spacing, y to twice the lamp height, z to the throw.
function beamGeometry() {
  const P = [], U = [], C = [], I = [], W = 2.9, quad = (k, a, b, c, d) => { const n = P.length / 3; for (const v of [a, b, c, d]) { P.push(v[0], v[1], v[2]); U.push(v[3], v[4]); C.push(k, k, k); } I.push(n, n + 1, n + 2, n, n + 2, n + 3); };
  quad(1, [-W, 0, 0, 0, 1], [W, 0, 0, 1, 1], [W, 0, -1, 1, 0], [-W, 0, -1, 0, 0]);
  for (const s of [-1, 1]) quad(0.3, [s, 0, 0, 0.18, 1], [s, 1, 0, 0.82, 1], [s, 1, -1, 0.82, 0], [s, 0, -1, 0.18, 0]);   // the blades stay faint: inside a line of traffic they stack up into a white fog
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2)); g.setAttribute("color", new THREE.Float32BufferAttribute(C, 3)); g.setIndex(I); return g;
}
const PK_FX_RANGE = 150, PK_FX_FADE = 40, PK_BEAMS = 100, PK_HALOS = 420;

export class Traffic {
  constructor(scene, types, mats) {
    this.scene = scene; this.types = types; this.mats = mats;
    this.lines = new Map();       // id -> { pts: Float32Array (global coords), c, ow, w, l, tileKey, len, cum }
    this.nodes = new Map();       // nodeKey -> [{ id, end }]
    this.nextId = 1;
    this.cars = [];
    this.target = 60;
    this.meshes = types.map(t => {
      const cap = PK ? Math.max(40, Math.ceil(220 * t.weight * 2.2)) : Math.max(8, Math.ceil(120 * t.weight * 2.2));   // Pakistan: room for the higher targets and the parked vehicles
      const mk = (geo, mat, colors) => { if (!geo) return null; const im = new THREE.InstancedMesh(geo, mat, cap); im.count = 0; im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); if (colors) im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3); scene.add(im); return im; };
      const r = { cap, paint: mk(t.paint, mats.paint, true), detail: mk(t.detail, mats.detail, false), lights: mk(t.lights, mats.lights, false), art: t.art && mats.art ? mk(t.art, mats.art, false) : null, used: 0 };
      if (r.art) r.art.castShadow = false;
      // only the body casts a shadow (the detail and light meshes add draw calls, not visible shadow)
      if (r.detail) r.detail.castShadow = false; if (r.lights) r.lights.castShadow = false;
      return r;
    });
    this.wsum = types.reduce((s, t) => s + t.weight, 0);
    this.G0 = { mx: origin.mx, my: origin.my };   // same fixed frame as the engine's global traffic coordinates
    this._warm = 8;                               // draw the truck art once off-screen so its shader compiles at load
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(1, 1, 1); this._e = new THREE.Euler(); this._c = new THREE.Color();
    this.gx = 0; this.gz = 0;          // global-to-world shift (set by the engine each frame)
    this.signals = null; this.t = 0;   // traffic-light controllers (signals.js) and the clock, set by the engine
    if (PK) {
      this.parked = []; this.carts = []; this.liveTarget = this.target; this._Z = PKZ.city; this._zT = 0; this._corT = 0; this._cor = []; this._road = null; this._lx = 0; this._lz = 0; this._pv = 0; this._cells = new Map(); this._segs = [];
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });   // the same programme as the pedestrians, so it needs no new shader compile
      const mk = geo => { const im = new THREE.InstancedMesh(geo, mat, 48); im.count = 0; im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false; im.visible = false; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(48 * 3).fill(1), 3); scene.add(im); return im; };
      this.cartF = mk(cartFrame()); this.cartG = mk(cartGoods()); this.cartG.castShadow = false;
      const bt = types.find(t => t.name === "cd70");
      if (bt && mats.detail) { const im = new THREE.InstancedMesh(riderlessDetail(bt.detail), mats.detail, 280); im.count = 0; im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false; im.visible = false; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(im); this.parkBike = im; }
      if (bt && bt.tank) { const cap = this.meshes[types.indexOf(bt)].cap + 280, im = new THREE.InstancedMesh(bt.tank, mats.paint, cap); im.count = 0; im.castShadow = false; im.receiveShadow = true; im.frustumCulled = false; im.visible = false; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3); scene.add(im); this.bikeTank = im; this._tankCap = cap; }
      // Lamps after dark: oncoming vehicles were dark shapes with pin-prick lights. Two draw calls, and none by day.
      this._lamps = types.map(lampsOf); this._v = new THREE.Vector3(); this._sv = new THREE.Vector3(); this._qf = new THREE.Quaternion();
      const fxMat = (tex, vc) => new THREE.MeshBasicMaterial({ map: tex, vertexColors: vc, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -16 });
      const mkFx = (geo, tex, cap, vc) => { const im = new THREE.InstancedMesh(geo, fxMat(tex, vc), cap); im.count = 0; im.castShadow = false; im.receiveShadow = false; im.frustumCulled = false; im.visible = false; im.renderOrder = 5; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3); scene.add(im); return im; };
      this.fxBeam = mkFx(beamGeometry(), glowTexture(true), PK_BEAMS, true); this.fxHalo = mkFx(new THREE.PlaneGeometry(1, 1), glowTexture(false), PK_HALOS, false);
    }
  }
  // lines from one tile, in tile-local metres; gx0/gz0 = tile's global offset
  addTile(key, lines, gx0, gz0) {
    const ids = [];
    for (const L of lines) {
      const n = L.p.length / 2; if (n < 2) continue;
      const pts = new Float64Array(n * 2); for (let i = 0; i < n; i++) { pts[2 * i] = L.p[2 * i] + gx0; pts[2 * i + 1] = L.p[2 * i + 1] + gz0; }
      const cum = new Float64Array(n); for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
      if (cum[n - 1] < 4) continue;
      const id = this.nextId++;
      const rec = { id, pts, cum, len: cum[n - 1], c: L.c, ow: L.ow, w: L.w, l: L.l, key, n, e: L.e || null, h: L.h || null, st: L.st || null, np: L.np || 0 };
      this.lines.set(id, rec); ids.push(id);
      for (const end of [0, 1]) { const i = end ? n - 1 : 0; const k = nodeKey(pts[2 * i], pts[2 * i + 1]); let a = this.nodes.get(k); if (!a) { a = []; this.nodes.set(k, a); } a.push({ id, end }); }
    }
    return ids;
  }
  dropTile(ids) {
    for (const id of ids || []) {
      const L = this.lines.get(id); if (!L) continue;
      for (const end of [0, 1]) { const i = end ? L.n - 1 : 0; const k = nodeKey(L.pts[2 * i], L.pts[2 * i + 1]); const a = this.nodes.get(k); if (a) { const f = a.filter(e => e.id !== id); if (f.length) this.nodes.set(k, f); else this.nodes.delete(k); } }
      this.lines.delete(id);
    }
    this.cars = this.cars.filter(c => this.lines.has(c.line));
  }
  // Pakistan: which column of the mix a line belongs to, and whether a Metrobus can run on it.
  zoneOf(L) {
    if (L.zone) return L.zone;
    const mid = (L.n >> 1) * 2, lon = (L.pts[mid] / K + this.G0.mx) / RE * 180 / Math.PI, lat = (2 * Math.atan(Math.exp((-L.pts[mid + 1] / K + this.G0.my) / RE)) - Math.PI / 2) * 180 / Math.PI;
    const inRwp = lat > 33.54 && lat < 33.665 && lon > 72.98 && lon < 73.13, inIsb = lat >= 33.655 && lat < 33.78 && lon > 72.95 && lon < 73.2, inBah = lat > 33.47 && lat <= 33.57 && lon > 73.05 && lon < 73.22, hills = lat > 33.76 && lon >= 73.2;
    let z;
    if (L.c === 0) z = "m2";
    else if (hills) z = "mur";
    else if (inBah) z = "bah";
    else if (L.c === 1 && !inIsb) z = "gt";
    else if (inRwp) z = "rwp";
    else if (inIsb) z = "isb";
    else if (lat < 31.75) z = "rwp";                              // Lahore has no column of its own: the dense-city mix
    else z = L.c <= 2 ? "gt" : "rwp";                             // towns along the highways
    L.zone = z; L.lat = lat; L.lon = lon; L.shop = pkShop(lat, lon) && L.c >= 2;
    // Red Line: elevated south of Faizabad, so in Rawalpindi only on a raised deck; at grade in Islamabad
    let raised = false; if (L.e) for (let i = 0; i < L.n; i++) if (L.e[i] > 3) { raised = true; break; }
    L.metro = metroDist(lat, lon) < 45 && L.c >= 1 && L.c <= 5 && (lat > 33.655 ? L.c <= 3 || L.w <= 7 : raised);
    return z;
  }
  pickPk(L) {
    const z = this.zoneOf(L); let sum = 0;
    const W = this._pw || (this._pw = new Float64Array(this.types.length));
    for (let i = 0; i < this.types.length; i++) {
      const T = this.types[i]; let w = T.mix[z] || 0;
      if (T.corridor) { let live = 0; for (const c of this.cars) if (c.ti === i) live++; w = L.metro && live < 3 ? 5 : 0; }
      else if (L.metro && (T.bike || T.slow) && !T.isbHighwayOnly) w = 0;   // the busway carries only buses
      if (T.sideOnly && L.c < 4) w = 0;
      if (T.isbHighwayOnly && z === "isb" && L.c > 1) w = 0;
      if (L.metro && !T.corridor && L.w <= 7) w = 0;
      W[i] = w; sum += w;
    }
    if (sum <= 0) return -1;
    let r = Math.random() * sum;
    for (let i = 0; i < W.length; i++) { r -= W[i]; if (r <= 0 && W[i] > 0) return i; }
    return -1;
  }
  // kerbside lane for slow vehicles: lane 0 on a one-way line, the outermost on a two-way one
  kerbLane(L) { return L.ow ? 0 : this.lanesPerDir(L) - 1; }
  pickType() { let r = Math.random() * this.wsum; for (let i = 0; i < this.types.length; i++) { r -= this.types[i].weight; if (r <= 0) return i; } return 0; }
  lanesPerDir(L) { return L.ow ? Math.max(1, L.l) : Math.max(1, Math.floor(L.l / 2)); }
  // Lines within 600 m of the player, refreshed every second: spawning (cars and pedestrians)
  // scans this short list instead of every line loaded, which ran to 30,000 on long drives.
  nearLines(px, pz) {
    const now = performance.now();
    if (!this._near || now - this._nearT > 1000 || Math.hypot(px - this._nearX, pz - this._nearZ) > 150) {
      const out = [];
      for (const L of this.lines.values()) {
        if (!L.bb) { let a = 1e12, b = 1e12, c = -1e12, d = -1e12; for (let i = 0; i < L.n; i++) { const x = L.pts[2 * i], z = L.pts[2 * i + 1]; if (x < a) a = x; if (x > c) c = x; if (z < b) b = z; if (z > d) d = z; } L.bb = [a, b, c, d]; }
        const bb = L.bb; const dx = Math.max(bb[0] - px, 0, px - bb[2]), dz = Math.max(bb[1] - pz, 0, pz - bb[3]);
        if (dx * dx + dz * dz < 600 * 600) out.push(L);
      }
      this._near = out; this._nearT = now; this._nearX = px; this._nearZ = pz;
      if (PK) { this.pkRoadCells(px, pz); this.pkActivateParked(px, pz); }
    }
    return this._near;
  }
  // ------------------------------------------------------------------ Pakistan: where the traffic goes
  // A point on a line at arc length s, moved o metres to the left of the line's own direction.
  posAt(L, s, o) {
    s = Math.max(0, Math.min(L.len - 1e-3, s));
    let i = 0, lo = 0, hi = L.n - 2; while (lo <= hi) { const m = (lo + hi) >> 1; if (L.cum[m] <= s) { i = m; lo = m + 1; } else hi = m - 1; }
    const t = (s - L.cum[i]) / Math.max(1e-6, L.cum[i + 1] - L.cum[i]), ax = L.pts[2 * i], az = L.pts[2 * i + 1], bx = L.pts[2 * i + 2], bz = L.pts[2 * i + 3];
    let dx = bx - ax, dz = bz - az; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    let y = 0, slope = 0; if (L.h) { y = L.h[i] + (L.h[i + 1] - L.h[i]) * t; slope = (L.h[i + 1] - L.h[i]) / l; }
    return { x: ax + (bx - ax) * t + dz * o, z: az + (bz - az) * t - dx * o, y, ux: dx, uz: dz, i, slope };
  }
  // The road the player is driving: the nearest line under the car that runs the way the car points.
  pkPlayerRoad(px, pz, hx, hz) {
    let best = null, bs = 12;
    for (const L of this._near || []) {
      if (L.c > 5 || !L.bb || px < L.bb[0] - 26 || px > L.bb[2] + 26 || pz < L.bb[1] - 26 || pz > L.bb[3] + 26) continue;
      for (let i = 0; i < L.n - 1; i++) {
        const ax = L.pts[2 * i], az = L.pts[2 * i + 1]; let dx = L.pts[2 * i + 2] - ax, dz = L.pts[2 * i + 3] - az; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        const t = Math.max(0, Math.min(l, (px - ax) * dx + (pz - az) * dz)), d = Math.hypot(ax + dx * t - px, az + dz * t - pz), dot = dx * hx + dz * hz;
        const score = Math.max(0, d - L.w / 2) + (1 - Math.abs(dot)) * 7 + (L.ow && dot < 0 ? 9 : 0);
        if (score < bs) { bs = score; best = { L, s: L.cum[i] + t, dir: L.ow || dot >= 0 ? 1 : -1 }; }
      }
    }
    return best;
  }
  // The stretch of that road ahead of the car, followed straight on through junctions and tile edges.
  pkCorridor(road, maxD) {
    const spans = []; if (!road) return spans;
    let { L, s, dir } = road, d = 0; const seen = new Set();
    while (d < maxD && spans.length < 16 && !seen.has(L.id)) {
      seen.add(L.id);
      const room = dir > 0 ? L.len - s : s;
      this.zoneOf(L);
      if (!L.metro) spans.push({ L, dir, s0: s, d0: d, d1: d + room });
      d += room;
      const e = dir > 0 ? L.n - 1 : 0, e0 = dir > 0 ? L.n - 2 : 1;
      let fx = (L.pts[2 * e] - L.pts[2 * e0]) * 1, fz = (L.pts[2 * e + 1] - L.pts[2 * e0 + 1]) * 1; const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
      let nx = null, top = 0.55;
      for (const q of this.nodes.get(nodeKey(L.pts[2 * e], L.pts[2 * e + 1])) || []) {
        if (q.id === L.id) continue;
        const M = this.lines.get(q.id); if (!M || M.c > 5) continue;
        const md = q.end === 0 ? 1 : -1; if (M.ow && md < 0) continue;
        const i0 = q.end === 0 ? 0 : M.n - 1, i1 = q.end === 0 ? 1 : M.n - 2; let ax = M.pts[2 * i1] - M.pts[2 * i0], az = M.pts[2 * i1 + 1] - M.pts[2 * i0 + 1]; const al = Math.hypot(ax, az) || 1;
        const dot = (ax * fx + az * fz) / al + (M.c === L.c ? 0.1 : 0);
        if (dot > top) { top = dot; nx = { M, md }; }
      }
      if (!nx) break;
      L = nx.M; dir = nx.md; s = dir > 0 ? 0 : L.len;
    }
    return spans;
  }
  // The other carriageway of a divided road, level with arc length s on L.
  pkSibling(L, s) {
    const q = this.posAt(L, s, 0); let best = null, bd = 46;
    for (const M of this._near || []) {
      if (M === L || !M.ow || !M.bb || Math.abs(M.c - L.c) > 1 || q.x < M.bb[0] - 46 || q.x > M.bb[2] + 46 || q.z < M.bb[1] - 46 || q.z > M.bb[3] + 46) continue;
      for (let i = 0; i < M.n - 1; i++) {
        const ax = M.pts[2 * i], az = M.pts[2 * i + 1]; let dx = M.pts[2 * i + 2] - ax, dz = M.pts[2 * i + 3] - az; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        if (dx * q.ux + dz * q.uz > -0.8) continue;
        const t = Math.max(0, Math.min(l, (q.x - ax) * dx + (q.z - az) * dz)), d = Math.hypot(ax + dx * t - q.x, az + dz * t - q.z);
        if (d > 2 && d < bd) { bd = d; best = { L: M, s: M.cum[i] + t }; }
      }
    }
    return best;
  }
  pkSpawnAt(L, s, dir) {
    const ti = this.pickPk(L); if (ti < 0) return false; const T = this.types[ti];
    const gap = T.bike ? 5 : 11;
    for (const c of this.cars) if (c.line === L.id && c.dir === dir && Math.abs(c.s - s) < gap && c.bike === !!T.bike) return false;
    let lane = Math.floor(Math.random() * this.lanesPerDir(L));
    if (T.bike || T.slow) lane = this.kerbLane(L);
    const col = T.paints[Math.floor(Math.random() * T.paints.length)], cap = L.shop ? 8 : 1e3;
    const car = { line: L.id, s, dir, lane, laneF: lane, v: Math.min(T.vmax || 1e3, cap, SPEED[L.c] * (0.75 + Math.random() * 0.3)), ti, color: col, x: 0, z: 0, hx: 0, hz: 1, stopT: 0, len: T.length || 4.6, hw: (T.width || 1.8) / 2, lcT: 2 + Math.random() * 4, keen: 0.85 + Math.random() * 0.3, bike: !!T.bike, slow: !!T.slow, latH: T.latH || 0, nudge: 0 };
    const q = this.posAt(L, s, 0); car.hx = q.ux * dir; car.hz = q.uz * dir;
    this.place(car, L);
    this.cars.push(car);
    return true;
  }
  // A vehicle on the player's own road, 30 to 150 m ahead (farther on a motorway): either running the same way or coming towards them.
  pkSpawnBand(dmin, dmax) {
    const spans = this._cor; if (!spans.length) return false;
    const end = Math.min(dmax, spans[spans.length - 1].d1); if (end <= dmin) return false;
    const d = dmin + Math.random() * (end - dmin), sp = spans.find(q => d >= q.d0 && d < q.d1); if (!sp) return false;
    let L = sp.L, dir = sp.dir, s = sp.s0 + dir * (d - sp.d0);
    if (Math.random() < (L.c <= 1 ? 0.3 : 0.48)) {
      if (!L.ow) dir = -dir;
      else { const o = this.pkSibling(L, s); if (o) { L = o.L; s = o.s; dir = 1; } }
    }
    return this.pkSpawnAt(L, s, dir);
  }
  // Everywhere else in reach, sampled by distance along each line: motorway vertices can be a kilometre apart, so picking a vertex almost never found one in range.
  pkSpawnRing(px, pz, hx, hz, Z) {
    const near = this.nearLines(px, pz); if (!near.length) return false;
    const cand = [], n0 = Math.floor(Math.random() * near.length), rc = this._road ? this._road.L.c : 3;
    for (let q = 0; q < near.length && q < 240 && cand.length < 40; q++) {
      const L = near[(q + n0) % near.length];
      if (L.c > 5) continue;
      if (rc === 0 && L.c > 1 && Math.random() > 0.05) continue;     // on the motorway the side roads get only a twentieth of the draw
      if (rc === 1 && L.c > 3 && Math.random() > 0.5) continue;
      const s = Math.random() * L.len, p = this.posAt(L, s, 0), dx = p.x - px, dz = p.z - pz, d = Math.hypot(dx, dz);
      if (d < 55 || d > Z.ring) continue;
      cand.push([L, s, (dx * hx + dz * hz) / (d || 1) + (L.c <= 2 ? 0.6 : 0) + (1 - d / Z.ring) * 0.7 + Math.random() * 0.8]);
    }
    if (!cand.length) return false;
    cand.sort((a, b) => b[2] - a[2]);
    const [L, s] = cand[Math.floor(Math.random() * Math.min(6, cand.length))];
    return this.pkSpawnAt(L, s, L.ow ? 1 : (Math.random() < 0.5 ? 1 : -1));
  }
  // Called each frame: refresh the zone and the road ahead, then top up the road first and the surrounding streets second.
  pkFill(px, pz, hx, hz, dt) {
    const now = performance.now();
    this.nearLines(px, pz);
    this._pv += (Math.min(60, Math.hypot(px - this._lx, pz - this._lz) / Math.max(dt, 1e-3)) - this._pv) * 0.1; this._lx = px; this._lz = pz;
    if (now - this._corT > 300) {
      this._corT = now; this._road = this.pkPlayerRoad(px, pz, hx, hz);
      const G = this.G0, lat = (2 * Math.atan(Math.exp((-pz / K + G.my) / RE)) - Math.PI / 2) * 180 / Math.PI, lon = (px / K + G.mx) / RE * 180 / Math.PI;
      this._Z = PKZ[this._road && this._road.L.c === 0 ? "motor" : pkZoneKey(lat, lon)];
      this.liveTarget = this.target <= 0 ? 0 : Math.min(PK_MAX_TARGET, Math.round(this.target * this._Z.f));
      this._cor = this.pkCorridor(this._road, this._Z.dmax + 10);
    }
    const Z = this._Z, want = this.liveTarget;
    if (want <= 0) return;
    const lateral = this._road ? (this._road.L.ow ? 34 : this._road.L.w / 2 + 6) : 20;
    let band = 0, far = null, fd = Z.dmax * 0.85;
    for (const c of this.cars) {
      const dx = c.x - px, dz = c.z - pz, al = dx * hx + dz * hz, la = Math.abs(dx * hz - dz * hx);
      if (al > -5 && al < Z.dmax && la < lateral) band++;
      else { const d = Math.hypot(dx, dz); if (d > fd) { fd = d; far = c; } }
    }
    const bandWant = Math.min(Z.band, Math.ceil(want * Z.share));
    // a full budget spent on far-off streets gives way to the road in front of the car
    if (band < bandWant && this.cars.length >= want && far) far.dead = true;
    const dmin = band < bandWant * 0.5 ? 30 : Math.min(Z.dmax - 40, Math.max(90, 70 + this._pv * 3));
    let tries = 8, live = this.cars.length; if (far && far.dead) live--;
    while (live < want && tries-- > 0) {
      if (band < bandWant && this.pkSpawnBand(dmin, Z.dmax)) { band++; live++; continue; }
      if (this.pkSpawnRing(px, pz, hx, hz, Z)) live++;
    }
    if (far && far.dead) this.cars = this.cars.filter(c => !c.dead);
  }
  // ------------------------------------------------------------------ Pakistan: what stands at the kerb
  // Per line, once, from a seed of the line's own position: groups of motorbikes, stopped autos and carry vans, parked cars, barrows on the pavement edge.
  pkParkLine(L) {
    if (L.parkDone) return; L.parkDone = true;
    this.zoneOf(L);
    if (L.c < 2 || L.c > 5 || L.e || L.np || L.metro || L.len < 26 || L.w < 5.5) return;
    const z = L.zone, shop = L.shop, cleared = shop && pkCleared(L.lat, L.lon);
    const step = shop ? [10, 13] : z === "rwp" ? [34, 40] : z === "isb" ? (L.c < 3 ? [0, 0] : [60, 70]) : z === "mur" ? [42, 50] : z === "bah" ? [90, 70] : z === "gt" ? [52, 60] : [0, 0];
    if (!step[0]) return;
    step[0] /= PK_TRAFFIC; step[1] /= PK_TRAFFIC;      // kerbside vehicles thin out with the moving traffic
    const R = pkRng(Math.round(L.pts[0]) + L.n, Math.round(L.pts[1]));
    const byName = {}; this.types.forEach((t, i) => { byName[t.name] = i; });
    const mixOK = i => i != null && (this.types[i].mix[z] || 0) > 0;
    const out = [];
    for (let s = 11 + R() * step[0], guard = 0; s < L.len - 11 && guard < 80; s += step[0] + R() * step[1], guard++) {
      const side = L.ow ? 1 : (R() < 0.5 ? 1 : -1), r = R(), wide = L.w >= 7;
      let kind;
      if (cleared) kind = r < 0.7 ? "bike" : null;
      else if (shop) kind = r < 0.5 ? "bike" : r < 0.66 ? (wide ? "rickshaw" : "bike") : r < 0.82 ? (wide ? "carry" : "bike") : "cart";
      else kind = r < 0.42 ? "bike" : r < 0.58 ? (wide ? "rickshaw" : "bike") : r < 0.72 ? (wide ? "carry" : "bike") : wide ? "car" : "bike";
      if (kind === "rickshaw" && !mixOK(byName.rickshaw)) kind = "car";
      if (kind === "carry" && !mixOK(byName.carry)) kind = "car";
      if (kind === "bike" && !mixOK(byName.cd70)) kind = "car";
      if (kind === "car" && !wide) kind = null;
      if (!kind) continue;
      if (kind === "cart") {
        const q = this.posAt(L, s, side * (L.w / 2 + 0.6));
        out.push({ cart: true, s, side, half: 0, inner: 1e9, x: q.x, z: q.z, y: q.y + 0.13, hx: q.ux * side, hz: q.uz * side, color: CART_GOODS[Math.floor(R() * CART_GOODS.length)], len: 2.6, hw: 0.5, line: L.id });
        continue;
      }
      if (kind === "bike") {
        // Side by side, front wheels to the kerb or the road, about 1.15 m apart: bikes standing at an angle overlapped into one long tread (REVIEW3 item 4)
        const pick = R(), n = pick < 0.22 ? 1 : pick < 0.42 ? 2 : 3 + Math.floor(R() * 5), ti = byName.cd70, T = this.types[ti], items = [], off = L.w / 2 - 0.98, lean0 = (R() < 0.5 ? 1 : -1) * R() * 0.14, nose = R() < 0.7 ? 1 : -1;
        let sb = s;
        for (let b = 0; b < n; b++) {
          const q = this.posAt(L, sb, side * (off + (R() - 0.5) * 0.3)), ang = lean0 + (R() - 0.5) * 0.3, f = R() < 0.12 ? -nose : nose, nx = q.uz * side * f, nz = -q.ux * side * f, ca = Math.cos(ang), sa = Math.sin(ang);
          items.push({ bike: true, ti, x: q.x, z: q.z, y: q.y, hx: nx * ca + q.ux * sa, hz: nz * ca + q.uz * sa, pitch: 0, roll: R() < 0.45 ? (R() < 0.5 ? 1 : -1) * (0.07 + R() * 0.07) : 0, color: T.paints[Math.floor(R() * T.paints.length)], tank: T.tanks[Math.floor(R() * T.tanks.length)], len: 1.9, hw: 0.36, range: 115 });
          sb += 1.15 + (R() - 0.5) * 0.16 + (R() < 0.1 ? 0.9 : 0);
        }
        const span = sb - s - 1.15;
        out.push({ bikes: true, s: s + span / 2, side, half: span / 2 + 0.7, inner: L.w / 2 - 2.05, items });
        s += span;
        continue;
      }
      const names = kind === "car" ? ["mehran", "alto", "cultus", "corolla"] : [kind], name = names[Math.floor(R() * names.length)], ti = byName[name]; if (ti == null) continue;
      const T = this.types[ti], hw = (T.width || 1.6) / 2, off = L.w / 2 - hw - 0.22, q = this.posAt(L, s, side * off), j = (R() - 0.5) * 0.05, cj = Math.cos(j), sj = Math.sin(j), fx = q.ux * side, fz = q.uz * side;
      out.push({ s, side, half: (T.length || 4) / 2 + 0.3, inner: L.w / 2 - 2 * hw - 0.22, items: [{ ti, x: q.x, z: q.z, y: q.y, hx: fx * cj - fz * sj, hz: fx * sj + fz * cj, pitch: Math.atan2(q.slope * side, 1), color: T.paints[Math.floor(R() * T.paints.length)], len: T.length || 4, hw, range: 170 }] });
    }
    if (out.length) L.parkS = out;
  }
  // The kerb within reach of the car, rebuilt with the near-line list.
  pkActivateParked(px, pz) {
    const P = [], C = [], gm = window.GAME, idx = gm && gm.IDX && gm.IDX.ready ? gm.IDX : null, G = this.G0;
    for (const L of this._near) {
      if (L.c < 2 || L.c > 5 || !L.bb) continue;
      if (Math.max(L.bb[0] - px, 0, px - L.bb[2]) > 185 || Math.max(L.bb[1] - pz, 0, pz - L.bb[3]) > 185) continue;
      this.pkParkLine(L);
      if (!L.parkS) continue;
      for (const q of L.parkS) {
        if (q.cart) {
          if (Math.hypot(q.x - px, q.z - pz) > 170) continue;
          if (q.blocked === undefined && idx) q.blocked = !!idx.building((2 * Math.atan(Math.exp((-q.z / K + G.my) / RE)) - Math.PI / 2) * 180 / Math.PI, (q.x / K + G.mx) / RE * 180 / Math.PI);   // no barrows inside a shop
          if (!q.blocked) C.push(q);
          continue;
        }
        if (q.bikes && !this.pkFrontage(L, q, idx, gm)) continue;
        for (const it of q.items) if (Math.hypot(it.x - px, it.z - pz) < it.range + 15) P.push(it);
      }
    }
    this.parked = P; this.carts = C;
  }
  // Bikes stand where there is something to park for. A shop-zone street always counts; elsewhere there must be a building close behind the kerb, so green verges and villa setbacks stay clear.
  pkFrontage(L, q, idx, gm) {
    if (q.front !== undefined) return q.front;
    if (L.shop) return (q.front = true);
    if (!idx) return false;
    const G = this.G0, reach = L.zone === "bah" ? 6 : L.c <= 2 ? 9 : 14; let hit = false;
    outer: for (const ds of [-3, 3, 0]) for (let d = 2; d <= reach; d += 3) {
      const p = this.posAt(L, Math.max(0, Math.min(L.len, q.s + ds)), q.side * (L.w / 2 + d));
      if (idx.building((2 * Math.atan(Math.exp((-p.z / K + G.my) / RE)) - Math.PI / 2) * 180 / Math.PI, (p.x / K + G.mx) / RE * 180 / Math.PI)) { hit = true; break outer; }
    }
    if (hit || (gm.snapState && gm.snapState.idxJobs === 0)) q.front = hit;   // a miss is only final once the footprints have all arrived
    q.hidden = !hit;
    return hit;
  }
  // Road surface near the player, on a coarse grid, so pedestrians can be kept off it. Positive result: metres clear of the nearest carriageway edge.
  pkRoadCells(px, pz) {
    if (this._cx !== undefined && Math.hypot(px - this._cx, pz - this._cz) < 30 && this._cn === this._near.length) return;
    this._cx = px; this._cz = pz; this._cn = this._near.length;
    const cells = new Map(), segs = [], C = 16, R = 300;
    for (const L of this._near) {
      if (L.c > 6) continue;
      if (L.e) { let up = false; for (let i = 0; i < L.n; i++) if (Math.abs(L.e[i]) > 1) { up = true; break; } if (up) continue; }  // people walk under flyovers
      const hw = L.w / 2;
      for (let i = 0; i < L.n - 1; i++) {
        const ax = L.pts[2 * i], az = L.pts[2 * i + 1], bx = L.pts[2 * i + 2], bz = L.pts[2 * i + 3];
        if (Math.max(Math.min(ax, bx) - px, 0, px - Math.max(ax, bx)) > R || Math.max(Math.min(az, bz) - pz, 0, pz - Math.max(az, bz)) > R) continue;
        const id = segs.length; segs.push([ax, az, bx, bz, hw]);
        const m = hw + 3, l = Math.hypot(bx - ax, bz - az), n = Math.ceil(l / C);
        // walk the segment, marking the cells within reach of the road's edge
        for (let k = 0; k <= n; k++) {
          const t = k / Math.max(1, n), x = ax + (bx - ax) * t, z = az + (bz - az) * t, i0 = Math.floor((x - m) / C), i1 = Math.floor((x + m) / C), j0 = Math.floor((z - m) / C), j1 = Math.floor((z + m) / C);
          for (let a = i0; a <= i1; a++) for (let b = j0; b <= j1; b++) { const key = a * 100003 + b; let c = cells.get(key); if (!c) { c = []; cells.set(key, c); } if (c[c.length - 1] !== id) c.push(id); }
        }
      }
    }
    this._cells = cells; this._segs = segs;
  }
  roadClear(x, z) {
    const c = this._cells.get(Math.floor(x / 16) * 100003 + Math.floor(z / 16)); if (!c) return 99;
    let best = 99;
    for (const id of c) {
      const [ax, az, bx, bz, hw] = this._segs[id], dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1))), d = Math.hypot(ax + dx * t - x, az + dz * t - z) - hw;
      if (d < best) best = d;
    }
    return best;
  }
  spawn(px, pz, hx, hz) {
    if (PK) return this.pkSpawnRing(px, pz, hx, hz, this._Z);
    // choose a random line near the player (global coords), preferring ahead of them
    const cand = [];
    const near = this.nearLines(px, pz);
    for (let q = 0; q < near.length && cand.length < 60; q++) {
      const L = near[(q * 7919 + Math.floor(Math.random() * near.length)) % near.length];
      if (L.c > 5) continue;
      const i = Math.floor(Math.random() * (L.n - 1));
      const x = L.pts[2 * i], z = L.pts[2 * i + 1];
      const dx = x - px, dz = z - pz, d = Math.hypot(dx, dz);
      if (d < 60 || d > 380) continue;
      const ahead = (dx * hx + dz * hz) / (d || 1);
      cand.push([L, i, ahead + (L.c <= 2 ? 0.6 : 0) + Math.random() * 0.8]);
    }
    if (!cand.length) return false;
    cand.sort((a, b) => b[2] - a[2]);
    const [L, i] = cand[Math.floor(Math.random() * Math.min(6, cand.length))];
    const dir = L.ow ? 1 : (Math.random() < 0.5 ? 1 : -1);
    const s = L.cum[i] + Math.random() * (L.cum[i + 1] - L.cum[i]);
    let lane = Math.floor(Math.random() * this.lanesPerDir(L));
    for (const c of this.cars) if (c.line === L.id && c.dir === dir && Math.abs(c.s - s) < 18) return false;
    const ti = PK ? this.pickPk(L) : this.pickType(); if (ti < 0) return false; const T = this.types[ti];
    if (T.bike || T.slow) lane = this.kerbLane(L);
    const col = T.paints[Math.floor(Math.random() * T.paints.length)];
    const car = { line: L.id, s, dir, lane, laneF: lane, v: Math.min(T.vmax || 1e3, SPEED[L.c] * (0.75 + Math.random() * 0.3)), ti, color: col, x: 0, z: 0, hx: 0, hz: 1, stopT: 0, len: T.length || 4.6, lcT: 2 + Math.random() * 4, keen: 0.85 + Math.random() * 0.3, bike: !!T.bike, slow: !!T.slow, latH: T.latH || 0 };
    this.place(car, L);
    this.cars.push(car);
    return true;
  }
  // position on the line at arc length s with lane offset
  place(car, L) {
    let s = Math.max(0, Math.min(L.len - 1e-3, car.s));
    let i = car.seg != null && L.cum[car.seg] <= s && L.cum[car.seg + 1] >= s ? car.seg : 0;
    while (i < L.n - 2 && L.cum[i + 1] < s) i++;
    while (i > 0 && L.cum[i] > s) i--;
    car.seg = i;
    const t = (s - L.cum[i]) / Math.max(1e-6, L.cum[i + 1] - L.cum[i]);
    const ax = L.pts[2 * i], az = L.pts[2 * i + 1], bx = L.pts[2 * i + 2], bz = L.pts[2 * i + 3];
    let dx = (bx - ax), dz = (bz - az); const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const fx = dx * car.dir, fz = dz * car.dir;
    // right-hand traffic: offset to the right of the travel direction
    const rx = -fz, rz = fx;
    const lw = L.w / Math.max(1, L.l);
    let off;
    const lf = car.laneF != null ? car.laneF : car.lane;
    if (L.ow) off = -L.w / 2 + (lf + 0.5) * lw;
    else off = PK ? -(lf + 0.5) * lw : (lf + 0.5) * lw;      // Pakistan keeps left: the mirror of the offset right of travel
    if (car.bike) off = L.ow ? -L.w / 2 + 0.6 : -(L.w / 2 - 0.6);   // motorbikes hug the kerb, beside the cars in that lane
    if (car.nudge) off += car.nudge;                                // Pakistan: out and around whatever is stopped at the kerb
    car.x = ax + (bx - ax) * t + rx * off; car.z = az + (bz - az) * t + rz * off;
    car.y = L.e ? L.e[i] + (L.e[i + 1] - L.e[i]) * t : 0;
    if (L.h) {                                                   // Pakistan: the land under the road, and the car tilts with the grade
      car.y += L.h[i] + (L.h[i + 1] - L.h[i]) * t;
      const rise = (L.h[i + 1] - L.h[i]) + (L.e ? L.e[i + 1] - L.e[i] : 0);
      car.pitch = Math.atan2(rise * car.dir, l);
    }
    // smooth heading
    const k = 0.35; car.hx += (fx - car.hx) * k; car.hz += (fz - car.hz) * k; const hl = Math.hypot(car.hx, car.hz) || 1; car.hx /= hl; car.hz /= hl;
  }
  // turn onto the next line at the node we reached
  // The line a car takes at the end of this one, chosen early so it can slow for the turn.
  pickNext(car, L) {
    const endIdx = car.dir > 0 ? L.n - 1 : 0;
    const k = nodeKey(L.pts[2 * endIdx], L.pts[2 * endIdx + 1]);
    const opts = [];
    const inx = car.hx, inz = car.hz;
    for (const e of this.nodes.get(k) || []) {
      if (e.id === L.id) continue;
      const M = this.lines.get(e.id); if (!M || M.c > 5) continue;
      const dir = e.end === 0 ? 1 : -1;
      if (M.ow && dir < 0) continue;
      if (this.types[car.ti].corridor) { this.zoneOf(M); if (!M.metro) continue; }   // a Metrobus never leaves its corridor
      const i0 = e.end === 0 ? 0 : M.n - 1, i1 = e.end === 0 ? 1 : M.n - 2;
      let dx = M.pts[2 * i1] - M.pts[2 * i0], dz = M.pts[2 * i1 + 1] - M.pts[2 * i0 + 1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const dot = dx * inx + dz * inz;
      if (dot < -0.3) continue;                                      // no U-turns
      opts.push({ M, dir, dot, score: dot + Math.random() * 0.9 + (M.c <= L.c ? 0.2 : 0) });
    }
    if (!opts.length) return null;
    opts.sort((a, b) => b.score - a.score);
    return opts[0];
  }
  advanceLine(car, L) {
    const nx = car.next && this.lines.has(car.next.M.id) ? car.next : this.pickNext(car, L);
    car.next = null;
    if (!nx) return false;
    const { M, dir } = nx;
    car.line = M.id; car.dir = dir; car.s = dir > 0 ? 0.01 : M.len - 0.01; car.seg = null;
    car.lane = car.bike || car.slow ? this.kerbLane(M) : Math.min(car.lane, this.lanesPerDir(M) - 1); car.laneF = car.bike || car.slow ? car.lane : Math.min(car.laneF, car.lane + 0.5);
    return true;
  }
  update(dt, player, gx, gz, night) {
    this.gx = gx; this.gz = gz;
    // player in global coords
    const px = player.x + gx, pz = player.z + gz;
    // despawn far cars
    if (PK) {
      const Z = this._Z;
      this.cars = this.cars.filter(c => { const dx = c.x - px, dz = c.z - pz, d = Math.hypot(dx, dz); return d < Z.despawn && this.lines.has(c.line) && !(d > Z.behind && dx * player.hx + dz * player.hz < -Z.behind); });
      this.pkFill(px, pz, player.hx, player.hz, dt);
    } else {
      this.cars = this.cars.filter(c => { const d = Math.hypot(c.x - px, c.z - pz); return d < 520 && this.lines.has(c.line); });
      let tries = 6;
      while (this.cars.length < this.target && tries-- > 0) this.spawn(px, pz, player.hx, player.hz);
    }
    // bucket by line for following
    const byLine = new Map();
    for (const c of this.cars) { const k = c.line * 2 + (c.dir > 0 ? 1 : 0); let a = byLine.get(k); if (!a) { a = []; byLine.set(k, a); } a.push(c); }
    for (const a of byLine.values()) a.sort((p, q) => (p.s - q.s) * p.dir);
    let hitCar = null;
    for (const c of this.cars) {
      const L = this.lines.get(c.line); if (!L) continue;
      let want = SPEED[L.c] * (0.85 + ((c.ti * 7919) % 13) / 60) * c.keen;
      const vm = this.types[c.ti].vmax; if (vm) want = Math.min(want, vm * c.keen);
      if (PK) {
        this.zoneOf(L);
        if (L.shop) want = Math.min(want, (L.c <= 3 ? 8.5 : 6.5) * c.keen);   // nobody gets up to speed in a bazaar
        // ease out around anything stopped at this kerb
        let need = 0;
        if (L.parkS) {
          const lw = L.w / Math.max(1, L.l), m = c.bike ? L.w / 2 - 0.6 : L.ow ? L.w / 2 - (c.laneF + 0.5) * lw : (c.laneF + 0.5) * lw, hw = c.hw || 0.9, kerb = c.dir > 0 ? 1 : -1;
          for (const q of L.parkS) { if (q.cart || q.side !== kerb || q.hidden || (q.bikes && q.front === undefined)) continue; const rel = (q.s - c.s) * c.dir; if (rel > -(c.len / 2 + q.half + 1) && rel < 13 + q.half) need = Math.max(need, m + hw + 0.25 - q.inner); }
        }
        c.nudge = (c.nudge || 0) + Math.max(-2.2 * dt, Math.min(2.2 * dt, Math.min(2.6, need) - (c.nudge || 0)));
      }
      const free = want;
      // car ahead on the same line and direction, in (or moving into) the same lane
      const a = byLine.get(c.line * 2 + (c.dir > 0 ? 1 : 0));
      const idx = a.indexOf(c);
      let ahead = null, gapAhead = 1e9;
      for (let j = idx + 1; j < a.length; j++) { const o = a[j]; if (Math.abs(o.laneF - c.laneF) > 0.7 || o.bike !== c.bike) continue; const gap = (o.s - c.s) * c.dir - (c.len + o.len) / 2; ahead = o; gapAhead = gap; if (gap < 30) { want = Math.min(want, Math.max(0, (gap - 4) * 0.9), o.v + gap * 0.2); } break; }
      // traffic lights: stop at the line on amber (if there is room) and red
      if (L.st && this.signals) {
        let best = 1e9, bi = -1;
        for (let k = 0; k < L.st.length; k += 4) { if (L.st[k + 1] !== c.dir) continue; const d = (L.st[k] - c.s) * c.dir - c.len / 2; if (d > -1 && d < best) { best = d; bi = k; } }
        if (bi >= 0 && best < 75) {
          const st = this.signals.stateFor(L.key, L.st[bi + 2], L.st[bi + 3], this.t);
          if (st === 2 || (st === 1 && best > c.v * 1.1)) want = Math.min(want, Math.max(0, (best - 1.2) * 0.55));
        }
      }
      // slow down for a turn at the end of this line (straight on keeps its speed)
      const toEnd = c.dir > 0 ? L.len - c.s : c.s;
      if (toEnd < 40) {
        if (c.next === undefined || c.next === null || c.nextFor !== c.line) { c.next = this.pickNext(c, L); c.nextFor = c.line; }
        if (c.next && c.next.dot < 0.8) { const vt = c.next.dot < 0.2 ? 5.5 : 8.5; want = Math.min(want, vt + toEnd * 0.35); }
      }
      // overtake: a slower car close ahead and a free gap in the next lane over
      c.lcT -= dt;
      const nl = this.lanesPerDir(L);
      if (nl > 1 && !c.bike && !c.slow && ahead && gapAhead < 22 && ahead.v < free - 2.5 && c.lcT <= 0 && Math.abs(c.laneF - c.lane) < 0.05) {
        c.lcT = 3 + Math.random() * 3;
        for (const nlane of [c.lane - 1, c.lane + 1]) {
          if (nlane < 0 || nlane >= nl) continue;
          let clear = true;
          for (const o of a) { if (o === c || Math.abs(o.laneF - nlane) > 0.7) continue; const rel = (o.s - c.s) * c.dir; if (rel > -12 && rel < 20) { clear = false; break; } }
          if (clear) { c.lane = nlane; break; }
        }
      }
      if (c.laneF !== c.lane) { const dl = c.lane - c.laneF; c.laneF = Math.abs(dl) < 0.02 ? c.lane : c.laneF + Math.sign(dl) * Math.min(Math.abs(dl), dt * 0.55); }
      // the player
      const dx = px - c.x, dz = pz - c.z; const along = dx * c.hx + dz * c.hz; const lat = Math.abs(-dx * c.hz + dz * c.hx);
      if (along > 0 && along < 26 && lat < (c.latH || 1.7)) want = Math.min(want, Math.max(0, (along - 7) * 0.8));
      if (Math.abs(along) < (c.len / 2 + 2.2) && lat < (c.latH || 1.75)) hitCar = c;
      if (c.stopT > 0) { c.stopT -= dt; want = 0; }
      c.v += Math.max(-9 * dt, Math.min(3.2 * dt, want - c.v));
      c.s += c.v * dt * c.dir;
      if (c.s > L.len || c.s < 0) { if (!this.advanceLine(c, L)) { c.dead = true; continue; } }
      const L2 = this.lines.get(c.line); if (L2) this.place(c, L2);
    }
    this.cars = this.cars.filter(c => !c.dead);
    if (PK) for (const list of [this.parked, this.carts]) for (const p of list) {   // what stands at the kerb is solid too
      const dx = px - p.x, dz = pz - p.z; if (Math.abs(dx) > 6 || Math.abs(dz) > 6) continue;
      if (Math.abs(dx * p.hx + dz * p.hz) < p.len / 2 + 2.2 && Math.abs(-dx * p.hz + dz * p.hx) < p.hw + 0.95) hitCar = p;
    }
    this.render(gx, gz, night);
    return hitCar;
  }
  render(gx, gz, night) {
    for (const m of this.meshes) m.used = 0;
    let nt = 0; const tank = this.bikeTank, tc = this._tankCap || 0;
    for (const c of this.cars) {
      const m = this.meshes[c.ti]; if (m.used >= m.cap) continue;
      const j = m.used++;
      this._p.set(c.x - gx, 0.07 + (c.y || 0), c.z - gz);
      this._q.setFromEuler(this._e.set(c.pitch || 0, Math.atan2(-c.hx, -c.hz), 0, "YXZ"));
      this._m.compose(this._p, this._q, this._s);
      for (const part of [m.paint, m.detail, m.lights, m.art]) if (part) part.setMatrixAt(j, this._m);
      if (m.paint) m.paint.setColorAt(j, this._c.set(c.color));
      if (tank && c.bike && nt < tc) { const T = this.types[c.ti]; if (c.tank === undefined) c.tank = T.tanks[Math.floor(Math.random() * T.tanks.length)]; tank.setMatrixAt(nt, this._m); tank.setColorAt(nt++, this._c.set(c.tank)); }
    }
    if (PK) {
      const qx = this._lx - gx, qz = this._lz - gz; let nb = 0;
      for (const c of this.parked) {
        const wx = c.x - gx, wz = c.z - gz; if (Math.hypot(wx - qx, wz - qz) > c.range) continue;
        this._p.set(wx, 0.07 + c.y, wz); this._q.setFromEuler(this._e.set(c.pitch, Math.atan2(-c.hx, -c.hz), c.roll || 0, "YXZ")); this._m.compose(this._p, this._q, this._s);
        if (c.bike && this.parkBike) { if (nb < 280) { this.parkBike.setMatrixAt(nb++, this._m); if (tank && nt < tc) { tank.setMatrixAt(nt, this._m); tank.setColorAt(nt++, this._c.set(c.tank)); } } continue; }
        const m = this.meshes[c.ti]; if (m.used >= m.cap) continue;
        const j = m.used++;
        for (const part of [m.paint, m.detail, m.art]) if (part) part.setMatrixAt(j, this._m);
        if (m.lights) m.lights.setMatrixAt(j, ZERO_M);                // nothing parked has its lamps on
        if (m.paint) m.paint.setColorAt(j, this._c.set(c.color));
      }
      let nc = 0;
      for (const c of this.carts) {
        if (nc >= 48) break;
        this._p.set(c.x - gx, 0.07 + c.y, c.z - gz); this._q.setFromEuler(this._e.set(0, Math.atan2(-c.hx, -c.hz), 0, "YXZ")); this._m.compose(this._p, this._q, this._s);
        this.cartF.setMatrixAt(nc, this._m); this.cartG.setMatrixAt(nc, this._m); this.cartG.setColorAt(nc, this._c.set(c.color)); nc++;
      }
      if (this.parkBike) { this.parkBike.count = nb; this.parkBike.visible = nb > 0; this.parkBike.instanceMatrix.needsUpdate = true; }
      if (tank) { tank.count = nt; tank.visible = nt > 0; tank.instanceMatrix.needsUpdate = true; if (tank.instanceColor) tank.instanceColor.needsUpdate = true; }
      this.pkNightFx(gx, gz, night, qx, qz);
      for (const im of [this.cartF, this.cartG]) { im.count = nc; im.visible = nc > 0; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }
    }
    if (this._warm > 0) { this._warm--; this._m.makeTranslation(0, -5000, 0); for (const m of this.meshes) if (m.art && m.used === 0) { m.art.setMatrixAt(0, this._m); m.art.count = 1; m.art.visible = true; m.art.instanceMatrix.needsUpdate = true; m._warmed = true; } }
    for (const m of this.meshes) for (const part of [m.paint, m.detail, m.lights, m.art]) if (part) { if (part === m.art && m._warmed) { m._warmed = false; continue; } part.count = m.used; part.visible = m.used > 0; part.instanceMatrix.needsUpdate = true; if (part.instanceColor) part.instanceColor.needsUpdate = true; }
    if (this.mats.lights) this.mats.lights.emissiveIntensity = 0.35 + (PK ? 2.5 : 1.5) * night;
  }
  // Beams, road pools and lamp glows for the moving vehicles near the player
  pkNightFx(gx, gz, night, qx, qz) {
    const B = this.fxBeam, H = this.fxHalo, on = Math.min(1, Math.max(0, (night - 0.2) / 0.4));
    if (this._warm > 0) {                                 // compile the two programmes while loading, off in the ground
      this._m.makeTranslation(0, -5000, 0);
      for (const im of [B, H]) { im.setMatrixAt(0, this._m); im.count = 1; im.visible = true; im.instanceMatrix.needsUpdate = true; }
      return;
    }
    if (on <= 0) { B.visible = H.visible = false; B.count = H.count = 0; return; }
    let nb = 0, nh = 0; const p = this._p, q = this._q, v = this._v, sv = this._sv, col = this._c, m = this._m;
    const halo = (lx, ly, lz, size, r, g, b) => {
      if (nh >= PK_HALOS) return;
      v.set(lx, ly, lz).applyQuaternion(q).add(p); sv.set(size, size, 1); m.compose(v, q, sv); H.setMatrixAt(nh, m); H.setColorAt(nh, col.setRGB(r, g, b)); nh++;
    };
    for (const c of this.cars) {
      const wx = c.x - gx, wz = c.z - gz, d = Math.hypot(wx - qx, wz - qz); if (d > PK_FX_RANGE) continue;
      const fade = on * Math.min(1, (PK_FX_RANGE - d) / PK_FX_FADE), L = this._lamps[c.ti], T = this.types[c.ti], lit = T.bike ? 0.55 : 1;
      p.set(wx, 0.07 + (c.y || 0), wz); q.setFromEuler(this._e.set(c.pitch || 0, Math.atan2(-c.hx, -c.hz), 0, "YXZ"));
      if (nb < PK_BEAMS) {
        const throwM = T.bike ? 11 : T.length > 6 ? 20 : 17;
        v.set(0, 0.04, L.fz).applyQuaternion(q).add(p); sv.set(Math.max(0.32, L.fx), L.fy * 2, throwM); m.compose(v, q, sv);
        B.setMatrixAt(nb, m); B.setColorAt(nb, col.setRGB(0.36 * fade * lit, 0.32 * fade * lit, 0.24 * fade * lit)); nb++;
      }
      const hs = (T.bike ? 0.9 : 1.25) * (1 + d / 90), a = 1.15 * fade;
      if (T.bike) halo(0, L.fy, L.fz - 0.03, hs, a, a * 0.92, a * 0.75);
      else for (const s of [-1, 1]) halo(s * L.fx, L.fy, L.fz - 0.03, hs, a, a * 0.92, a * 0.75);
      const ts = (T.bike ? 0.5 : 0.8) * (1 + d / 90), tb = 0.8 * fade;
      if (T.bike) halo(0, L.ry, L.rz + 0.03, ts, tb, tb * 0.06, tb * 0.05);
      else for (const s of [-1, 1]) halo(s * L.rx, L.ry, L.rz + 0.03, ts, tb, tb * 0.06, tb * 0.05);
    }
    for (const [im, n] of [[B, nb], [H, nh]]) { im.count = n; im.visible = n > 0; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }
  }
}
function nodeKey(x, z) { return Math.round(x * 2) + "," + Math.round(z * 2); }

// Fallback traffic when vehicles.js is not available: simple two-box cars.
export function fallbackTypes() {
  const body = new THREE.BoxGeometry(1.85, 0.8, 4.5); body.translate(0, 0.65, 0);
  const cab = new THREE.BoxGeometry(1.6, 0.6, 2.2); cab.translate(0, 1.35, 0.2);
  const lights = new THREE.BoxGeometry(1.7, 0.15, 0.05); lights.translate(0, 0.8, -2.26);
  const setC = (g, hex) => { const c = new THREE.Color(hex); const a = new Float32Array(g.attributes.position.count * 3); for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; } g.setAttribute("color", new THREE.BufferAttribute(a, 3)); return g; };
  setC(cab, "#1b2530"); setC(lights, "#fff2c0");
  return [{ name: "box", weight: 1, length: 4.5, width: 1.85, height: 1.6, paint: body, detail: cab, lights, paints: [0xffffff, 0xc0c4c8, 0x2a2d31, 0x8a8f96] }];
}
export function fallbackMaterials() {
  return { paint: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.5 }), detail: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.2 }), lights: new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0.5 }) };
}
