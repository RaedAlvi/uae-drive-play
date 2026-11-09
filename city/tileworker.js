// Tile worker: fetches one OpenMapTiles vector tile, decodes it and builds render-ready
// geometry (buildings with facade attributes, roads with lane-marking attributes,
// sidewalks, ground areas, water, props) plus the collision and traffic data the game
// needs. Everything comes back as transferable typed arrays in tile-local metres:
// X east from the tile's west edge, Z south from its north edge, Y up.

import { decodeTile, polygons, ringArea } from "./mvt.js";
import earcut from "./earcut.js";

// Region rules: "shanghai" (shanghai.html) swaps the UAE guesses (villas, palms, desert scrub, Arabic names)
// for Shanghai ones (tower heights, plane trees, Chinese names). Set from each tile message.
let CN = false;
// Pakistan: real ground under everything (city/terrain.js). TH reads the elevation fields in this
// tile's metres, GG is this tile's ground grid; both stay null everywhere else.
let PK = false, TM = undefined, TD = null, TH = null, GG = null, M2 = null;   // M2: city/m2data.js, loaded for Pakistan only
async function terrainFor(z, x, y, TS) {
  if (TM === null) return null;
  try {
    if (!TM) { TM = await import("./terrain.js"); TD = new TM.Terrain(new URL("../data/dem_pk/", import.meta.url).href); await TD.init(); }
    const n = 2 ** z; await TD.ensureBox(x / n, y / n, (x + 1) / n, (y + 1) / n);
    return TD.view(z, x, y, TS);
  } catch (err) { console.warn("terrain worker", err && err.message); TM = null; return null; }
}
const LAYERS = new Set(["building", "transportation", "transportation_name", "water", "landuse", "landcover", "park", "poi", "place"]);

// ------------------------------------------------------------------ growable buffers
class FBuf {
  constructor(n = 4096) { this.a = new Float32Array(n); this.n = 0; }
  need(k) { if (this.n + k > this.a.length) { let m = this.a.length * 2; while (m < this.n + k) m *= 2; const b = new Float32Array(m); b.set(this.a.subarray(0, this.n)); this.a = b; } }
  p1(a) { this.need(1); this.a[this.n++] = a; }
  p2(a, b) { this.need(2); const A = this.a; A[this.n++] = a; A[this.n++] = b; }
  p3(a, b, c) { this.need(3); const A = this.a; A[this.n++] = a; A[this.n++] = b; A[this.n++] = c; }
  p4(a, b, c, d) { this.need(4); const A = this.a; A[this.n++] = a; A[this.n++] = b; A[this.n++] = c; A[this.n++] = d; }
  out() { return this.a.slice(0, this.n); }
}
class IBuf {
  constructor(n = 4096) { this.a = new Uint32Array(n); this.n = 0; }
  need(k) { if (this.n + k > this.a.length) { let m = this.a.length * 2; while (m < this.n + k) m *= 2; const b = new Uint32Array(m); b.set(this.a.subarray(0, this.n)); this.a = b; } }
  p3(a, b, c) { this.need(3); const A = this.a; A[this.n++] = a; A[this.n++] = b; A[this.n++] = c; }
  out() { return this.a.slice(0, this.n); }
}
// A mesh under construction: named float attributes with fixed item sizes, plus an index.
class Mesh {
  constructor(spec) { this.spec = spec; this.attr = {}; for (const k in spec) this.attr[k] = new FBuf(); this.idx = new IBuf(); this.vc = 0; }
  out() { const o = { index: this.idx.out(), count: this.vc }; for (const k in this.spec) o[k] = this.attr[k].out(); return o; }
  transfer(list) { }
}
function collect(meshOut, list) { for (const k in meshOut) if (meshOut[k] && meshOut[k].buffer) list.push(meshOut[k].buffer); }

// ------------------------------------------------------------------ small helpers
function hash2(x, y) { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; h = h ^ (h >>> 16); return (h >>> 0) / 4294967296; }
function hexRgb(s) { if (!s || s[0] !== "#" || (s.length !== 7 && s.length !== 4)) return null; if (s.length === 4) s = "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]; const n = parseInt(s.slice(1), 16); if (isNaN(n)) return null; return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
function srgbToLin(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lin(rgb) { return [srgbToLin(rgb[0]), srgbToLin(rgb[1]), srgbToLin(rgb[2])]; }

// Sutherland-Hodgman clip of a flat ring [x0,y0,x1,y1,...] (closed: last == first) to [0,E]^2.
function clipRing(r, E) {
  let pts = []; for (let i = 0; i < r.length - 2; i += 2) pts.push([r[i], r[i + 1]]);
  const edges = [[0, 0, 1], [0, E, -1], [1, 0, 1], [1, E, -1]]; // axis, value, keep-side sign
  for (const [ax, v, s] of edges) {
    if (!pts.length) break;
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ina = (a[ax] - v) * s >= 0, inb = (b[ax] - v) * s >= 0;
      if (ina) out.push(a);
      if (ina !== inb) { const t = (v - a[ax]) / (b[ax] - a[ax]); const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; p[ax] = v; out.push(p); }
    }
    pts = out;
  }
  // drop consecutive duplicates
  const res = [];
  for (const p of pts) { const q = res[res.length - 1]; if (!q || q[0] !== p[0] || q[1] !== p[1]) res.push(p); }
  if (res.length > 1 && res[0][0] === res[res.length - 1][0] && res[0][1] === res[res.length - 1][1]) res.pop();
  return res.length >= 3 ? res : null;
}
// Liang-Barsky clip of a polyline (flat, open) to [0,E]^2 -> array of polylines [[x,y],...]
function clipLine(r, E) {
  const lines = []; let cur = null;
  for (let i = 0; i < r.length - 2; i += 2) {
    let x0 = r[i], y0 = r[i + 1], x1 = r[i + 2], y1 = r[i + 3];
    let t0 = 0, t1 = 1; const dx = x1 - x0, dy = y1 - y0;
    const p = [-dx, dx, -dy, dy], q = [x0, E - x0, y0, E - y0];
    let ok = true;
    for (let k = 0; k < 4; k++) { if (p[k] === 0) { if (q[k] < 0) { ok = false; break; } } else { const t = q[k] / p[k]; if (p[k] < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; } else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; } } }
    if (!ok) { cur = null; continue; }
    const a = [x0 + dx * t0, y0 + dy * t0], b = [x0 + dx * t1, y0 + dy * t1];
    if (!cur || cur[cur.length - 1][0] !== a[0] || cur[cur.length - 1][1] !== a[1]) { cur = [a]; lines.push(cur); }
    cur.push(b);
    if (t1 < 1) cur = null;
  }
  return lines.filter(l => l.length >= 2);
}
// Liang-Barsky with a per-vertex elevation carried through: [{ pts: [[x,y]...], el: [...] }]
function clipLine3(pts, el, E) {
  const out = []; let cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const x0 = pts[i][0], y0 = pts[i][1], x1 = pts[i + 1][0], y1 = pts[i + 1][1];
    const e0 = el ? el[i] : 0, e1 = el ? el[i + 1] : 0;
    let t0 = 0, t1 = 1; const dx = x1 - x0, dy = y1 - y0;
    const p = [-dx, dx, -dy, dy], q = [x0, E - x0, y0, E - y0];
    let ok = true;
    for (let k = 0; k < 4; k++) { if (p[k] === 0) { if (q[k] < 0) { ok = false; break; } } else { const t = q[k] / p[k]; if (p[k] < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; } else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; } } }
    if (!ok) { cur = null; continue; }
    const a = [x0 + dx * t0, y0 + dy * t0], b = [x0 + dx * t1, y0 + dy * t1];
    const ea = e0 + (e1 - e0) * t0, eb = e0 + (e1 - e0) * t1;
    if (!cur || cur.pts[cur.pts.length - 1][0] !== a[0] || cur.pts[cur.pts.length - 1][1] !== a[1]) { cur = { pts: [a], el: [ea] }; out.push(cur); }
    cur.pts.push(b); cur.el.push(eb);
    if (t1 < 1) cur = null;
  }
  return out.filter(l => l.pts.length >= 2);
}
function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]; const d = Math.hypot(b[0] - a[0], b[1] - a[1]); const k = Math.ceil(d / step);
    for (let j = 1; j <= k; j++) out.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]);
  }
  return out;
}
// Deck heights. OSM gives a bridge's `layer` but no height, so: 6.5 m per layer (capped for
// short spans), ramping up from the ends over up to 110 m. An end that meets another bridge
// takes that bridge's height instead of the ground, repeated so stacked interchanges connect;
// an end cut off at the tile's buffer edge stays at full height (the bridge continues next
// door). Ordinary roads that meet an elevated end get a ramp down to the ground.
function smooth01(x) { return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x); }
function profileOf(F) {
  const R = Math.min(110, Math.max(12, 0.45 * F.len)), H = F.H, el = [];
  for (let i = 0; i < F.pts.length; i++) {
    const s = F.cum[i];
    const rise = F.e0 + (H - F.e0) * smooth01(s / R), fall = F.e1 + (H - F.e1) * smooth01((F.len - s) / R);
    el.push(Math.max(0, rise + fall - H));
  }
  return el;
}
function bridgeProfiles(feats, E, S) {
  const outside = q => q[0] < 0 || q[1] < 0 || q[0] > E || q[1] > E;
  const key = q => Math.round(q[0] * 4) + "," + Math.round(q[1] * 4);
  for (const F of feats) {
    const n = F.pts.length; F.cum = [0];
    for (let i = 1; i < n; i++) F.cum.push(F.cum[i - 1] + Math.hypot(F.pts[i][0] - F.pts[i - 1][0], F.pts[i][1] - F.pts[i - 1][1]) * S);
    F.len = F.cum[n - 1];
    if (!F.bridge) { F.el = new Array(n).fill(0); continue; }
    F.H = Math.min(6.5 * Math.max(1, Math.min(3, F.layer || 1)), 0.12 * F.len + 1);
    F.openS = outside(F.pts[0]); F.openE = outside(F.pts[n - 1]);
    F.e0 = F.openS ? F.H : 0; F.e1 = F.openE ? F.H : 0;
    F.el = profileOf(F);
  }
  const BR = feats.filter(F => F.bridge);
  if (!BR.length) return;
  for (let pass = 0; pass < 3; pass++) {
    const m = new Map();
    BR.forEach((F, fi) => F.pts.forEach((q, i) => { const k = key(q); let a = m.get(k); if (!a) m.set(k, a = []); a.push([fi, F.el[i]]); }));
    BR.forEach((F, fi) => {
      const endE = q => { let e = 0; for (const [g, v] of m.get(key(q)) || []) if (g !== fi && v > e) e = v; return e; };
      if (!F.openS) F.e0 = endE(F.pts[0]);
      if (!F.openE) F.e1 = endE(F.pts[F.pts.length - 1]);
      F.el = profileOf(F);
    });
  }
  // approach roads: ordinary lines whose end touches an elevated bridge vertex ramp down to the ground
  const m = new Map();
  for (const F of BR) F.pts.forEach((q, i) => { const k = key(q); m.set(k, Math.max(m.get(k) || 0, F.el[i])); });
  for (const F of feats) {
    if (F.bridge || F.spec.c >= 7) continue;
    const e0 = m.get(key(F.pts[0])) || 0, e1 = m.get(key(F.pts[F.pts.length - 1])) || 0;
    if (e0 < 0.5 && e1 < 0.5) continue;
    F.pts = densify(F.pts, 12 / S);
    const n = F.pts.length; F.cum = [0];
    for (let i = 1; i < n; i++) F.cum.push(F.cum[i - 1] + Math.hypot(F.pts[i][0] - F.pts[i - 1][0], F.pts[i][1] - F.pts[i - 1][1]) * S);
    F.len = F.cum[n - 1];
    F.H = 0; F.e0 = e0; F.e1 = e1;
    const R = Math.min(90, Math.max(12, 0.5 * F.len));
    F.el = F.cum.map(s => Math.max(0, e0 * (1 - smooth01(s / R)) + e1 * (1 - smooth01((F.len - s) / R))));
  }
}
// Carriageway width (m) and lane count for a road line
function roadDims(L) {
  if (L.osm && L.osm.lanes) return [L.osm.W, L.osm.lanes];
  const W = L.oneway ? (L.ramp ? (L.spec.c <= 1 ? 7 : 6) : L.spec.w[0]) : L.spec.w[1];
  const lanes = L.oneway ? (L.ramp ? (L.spec.c <= 1 ? 2 : 1) : L.spec.l[0]) : L.spec.l[1];
  return [W, lanes];
}
function pointInRingXY(x, y, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const yi = ring[i][1], yj = ring[j][1]; if ((yi > y) !== (yj > y) && x < (ring[j][0] - ring[i][0]) * (y - yi) / (yj - yi) + ring[i][0]) c = !c; } return c; }

// ------------------------------------------------------------------ classification tables
// Road widths in metres: [one-way carriageway, two-way], lanes: [one-way, two-way].
const ROADS = {
  motorway: { w: [17.5, 28], l: [5, 8], c: 0, y: 0.075 },
  trunk: { w: [12.5, 21], l: [3, 6], c: 1, y: 0.07 },
  primary: { w: [10.5, 15], l: [3, 4], c: 2, y: 0.065 },
  secondary: { w: [7.5, 11.5], l: [2, 3], c: 3, y: 0.06 },
  tertiary: { w: [7, 9], l: [2, 2], c: 4, y: 0.055 },
  minor: { w: [6, 7.5], l: [2, 2], c: 5, y: 0.05 },
  service: { w: [4.5, 5.5], l: [1, 1], c: 6, y: 0.045 },
  raceway: { w: [14, 14], l: [1, 1], c: 1, y: 0.07 },
  busway: { w: [4, 7], l: [1, 2], c: 5, y: 0.05 },
  track: { w: [3.5, 3.5], l: [1, 1], c: 8, y: 0.04 },
  pedestrian: { w: [6, 6], l: [1, 1], c: 7, y: 0.042 },
  path: { w: [2.2, 2.2], l: [1, 1], c: 7, y: 0.041 },
};
const SIDEWALK_CLASSES = new Set(["primary", "secondary", "tertiary", "minor"]);
const PALM_CLASSES = new Set(["trunk", "primary", "secondary"]);
const LAMP_CLASSES = new Set(["motorway", "trunk", "primary", "secondary", "tertiary"]);
const AREA_COL = {
  residential: "#d8cdb9", commercial: "#d4ccc0", retail: "#d4ccc0", industrial: "#c9c0b2", railway: "#c4bcae",
  school: "#d7ccb6", university: "#d7ccb6", college: "#d7ccb6", hospital: "#d9d0c2", kindergarten: "#d7ccb6", neighbourhood: null, suburb: null, quarter: null,
  cemetery: "#cdbf9f", military: "#cfc2a4", stadium: "#c9c1b3", bus_station: "#c9c3b8", garages: "#cbc4b8", dam: null, zoo: "#9fae72", theme_park: "#cfc6b6",
  grass: "#6f9a48", park: "#6d9848", garden: "#6d9848", golf_course: "#78a650", pitch: "#5f9444", playground: "#c9ad85", recreation_ground: "#76a04e", village_green: "#6f9a48",
  farmland: "#8aa25e", farm: "#8aa25e", meadow: "#8aa25e", orchard: "#7f9b54", allotments: "#86a05c",
  wood: "#6f8a4c", forest: "#6f8a4c", scrub: "#a3a06b", wetland: "#8a9d6a", sand: "#e6d2a8", beach: "#ecdcb4", bare_rock: "#bba98a", scree: "#bba98a", ice: null, rock: "#bba98a",
  nature_reserve: "#b9b07a", national_park: null, protected_area: null,
};
const AREA_Y = { sand: 0.008, beach: 0.008, bare_rock: 0.008, rock: 0.008, scree: 0.008, scrub: 0.009, wetland: 0.009, residential: 0.011, commercial: 0.011, retail: 0.011, industrial: 0.011, railway: 0.011, school: 0.012, university: 0.012, college: 0.012, hospital: 0.012, kindergarten: 0.012, cemetery: 0.012, military: 0.011, stadium: 0.012, bus_station: 0.012, garages: 0.012 };
const GREEN = new Set(["grass", "park", "garden", "golf_course", "pitch", "recreation_ground", "village_green", "zoo"]);
// Facade palettes (sRGB), Gulf city: sand, cream, white stone; glass in blue-green, silver, bronze.
const WALLS = ["#efe6d6", "#e6d8bf", "#d8c7a6", "#f3efe8", "#cdb896", "#e9dfcf", "#c4ad8b", "#f6f2ea", "#ddd3c3", "#b9a58a", "#d9d6cf", "#c9c6bf", "#e3d3bd", "#bfae94", "#e8e1d5", "#b8b2a7", "#a9a397", "#d6cbb8"];
const GLASS = ["#6d8ea6", "#7c98a3", "#8b9aa4", "#5b6e7c", "#a08c68", "#4e6b72", "#7fa0b5", "#687884", "#3f5566", "#6f8f8f", "#9aa7ad", "#56707f", "#7d8a86"];
const SHED = ["#c8ccd0", "#b8c2cc", "#d6d2c8", "#aeb8bf", "#c9c1b2"];

// ------------------------------------------------------------------ main
if (typeof self !== "undefined") self.onmessage = async (e) => {
  const m = e.data;
  if (m.cmd === "tile") { CN = m.region === "shanghai"; PK = m.region === "pakistan"; if (PK && !M2) { try { M2 = await import("./m2data.js"); } catch (err) { M2 = null; } } }
  if (m.cmd === "prefetch") {
    // download into the cache only, no geometry: the route ahead is ready when we get there
    try { const cache = await caches.open("uae-drive-tiles-v1"); if (!(await cache.match(m.url))) { const r = await fetch(m.url); if (r.ok) await cache.put(m.url, r); } } catch (err) {}
    self.postMessage({ key: m.key, prefetched: true });
    return;
  }
  if (m.cmd !== "tile") return;
  if (m.terrainFar) {
    // a distance-ring tile: no map data, just the land
    try {
      await terrainFor(m.z, m.x, m.y, m.size);
      const o = TM.farMesh(TD, m), t = [];
      collect(o, t);
      self.postMessage({ key: m.key, far: true, terrainFar: true, mesh: o }, t);
    } catch (err) { self.postMessage({ key: m.key, far: true, terrainFar: true, error: String(err && err.message || err) }); }
    return;
  }
  try {
    TH = PK ? await terrainFor(m.z, m.x, m.y, m.size) : null; GG = null;
    // Cache Storage keeps tiles between sessions, so a second drive through the same
    // district loads instantly and works on a weak connection.
    let res = null, cache = null;
    try { cache = await caches.open("uae-drive-tiles-v1"); res = await cache.match(m.url); } catch (e) { cache = null; }
    if (!res) {
      res = await fetch(m.url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      if (cache) { try { await cache.put(m.url, res.clone()); } catch (e) {} }
    }
    const ab = await res.arrayBuffer();
    m.rdb = await roadsDb(m.z, m.x, m.y);
    m.bdb = await buildingsDb(m.z, m.x, m.y);
    if (PK) m.fdb = await footprintsDb(m.z, m.x, m.y);
    const t0 = performance.now();
    const { msg, transfer } = buildTile(ab, m);
    msg.ms = performance.now() - t0; msg.bytes = ab.byteLength;
    self.postMessage(msg, transfer);
  } catch (err) {
    self.postMessage({ key: m.key, error: String(err && err.message || err) });
  }
};

// OpenStreetMap lane counts, speed limits and signal nodes (baked into data/roads by
// build/bake_roads). Optional: without it the tables and rules above are used.
let RDB = undefined;
async function roadsDb(z, x, y) {
  if (RDB === null) return null;
  try {
    if (!RDB) RDB = await import("./roadsdb.js");
    return await RDB.roadsForTile(z, x, y, new URL("../", import.meta.url).href);
  } catch (err) { RDB = null; return null; }
}

// What OpenStreetMap knows about each building (type, storeys, name, roof, colours), baked
// into data/buildings by build/bake_buildings.py. Optional, like the roads database.
let BDB = undefined;
async function buildingsDb(z, x, y) {
  if (BDB === null) return null;
  try {
    if (!BDB) BDB = await import("./buildingsdb.js");
    return await BDB.buildingsForTile(z, x, y, new URL("../", import.meta.url).href);
  } catch (err) { BDB = null; return null; }
}

// Better building footprints for Pakistan (city/footprintsdb.js), when that file has been baked.
let FDB = undefined;
async function footprintsDb(z, x, y) {
  if (FDB === null) return null;
  try {
    if (!FDB) FDB = await import("./footprintsdb.js");
    return await FDB.footprintsForTile(z, x, y, new URL("../", import.meta.url).href);
  } catch (err) { FDB = null; return null; }
}

export function buildTile(ab, m) {
  const { z, x: tx, y: ty, key, size: TS } = m;
  const layers = decodeTile(ab, m.far ? new Set(["water"]) : LAYERS);
  const E = (layers.building || layers.transportation || { extent: 4096 }).extent;
  const S = TS / E;                                  // tile units -> metres
  const N = Math.pow(2, z);
  const lonOf = px => (tx + px / E) / N * 360 - 180;
  const latOf = py => { const n = Math.PI * (1 - 2 * (ty + py / E) / N); return Math.atan(Math.sinh(n)) * 180 / Math.PI; };
  const transfer = [];
  const msg = { key, z, x: tx, y: ty };

  // Far mode (low-zoom tiles): only the sea and lakes, so the water reaches the horizon.
  if (m.far) {
    const Wt = new Mesh({ position: 3, normal: 3, color: 3 });
    const Ew = (layers.water && layers.water.extent) || 4096, Sw = TS / Ew;
    for (const f of (layers.water && layers.water.features) || []) {
      if (f.type !== 3 || f.props.brunnel === "tunnel" || f.props.class === "swimming_pool") continue;
      for (const poly of polygons(f.geom)) {
        const rings = []; for (const r of poly) { const cr = clipRing(r, Ew); if (cr) rings.push(cr); }
        if (rings.length) fillPoly(Wt, rings, Sw, -0.006, [0, 0, 0], 0);
      }
    }
    msg.far = true; msg.water = Wt.out(); collect(msg.water, transfer);
    return { msg, transfer };
  }

  // ---------------------------------------------------------------- POIs: mosques, bus stops, named shops and hotels
  const mosques = [], pois = [], busStops = [], labelPois = [];
  for (const f of (layers.poi && layers.poi.features) || []) {
    if (f.type !== 1) continue;
    const p = f.props; const nm = (p.name_en || p["name:en"] || p.name || "") + " " + (p.name || "");
    if (p.class === "place_of_worship" && (p.subclass === "muslim" || /mosque|masjid|musalla|jami|مسجد|جامع|مصل/i.test(nm))) {
      for (const g of f.geom) mosques.push([g[0], g[1]]);
      const en = latinName(p), ar = arabicName(p);
      if (en || ar) for (const g of f.geom) if (g[0] >= 0 && g[1] >= 0 && g[0] <= E && g[1] <= E) labelPois.push({ x: g[0], y: g[1], en, ar, k: "mosque", rank: +p.rank || 9 });
      continue;
    }
    if (p.class === "bus" && p.subclass === "bus_stop") { for (const g of f.geom) busStops.push([g[0], g[1]]); continue; }
    const lk = labelKind(p);
    if (lk) { const en = latinName(p), ar = arabicName(p); if (en || ar) for (const g of f.geom) if (g[0] >= 0 && g[1] >= 0 && g[0] <= E && g[1] <= E) labelPois.push({ x: g[0], y: g[1], en, ar, k: lk, rank: +p.rank || 9 }); }
    if (!SIGN_CLASSES.has(p.class)) continue;
    const en = latinName(p), ar = arabicName(p);
    if (!en && !ar) continue;
    for (const g of f.geom) if (g[0] >= 0 && g[1] >= 0 && g[0] <= E && g[1] <= E) pois.push({ x: g[0], y: g[1], en, ar, cls: p.class, sub: p.subclass || "", rank: +p.rank || 9 });
  }
  // district and city names (the place layer): the HUD shows the one you are in
  const places = [];
  for (const f of (layers.place && layers.place.features) || []) {
    if (f.type !== 1) continue; const p = f.props;
    if (!/^(city|town|suburb|neighbourhood|quarter|village)$/.test(p.class)) continue;
    const en = latinName(p), ar = arabicName(p); if (!en && !ar) continue;
    for (const g of f.geom) places.push({ en, ar, c: p.class, x: g[0] * S, z: g[1] * S, r: +p.rank || 99 });
  }
  msg.places = places;
  const xOfLon = lon => ((lon + 180) / 360 * N - tx) * E;
  const yOfLat = lat => { const r = lat * Math.PI / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N - ty) * E; };

  // ---------------------------------------------------------------- street names (for the index and the junction signs)
  const names = [], nameLines = [];
  for (const f of (layers.transportation_name && layers.transportation_name.features) || []) {
    if (f.type !== 2) continue; const p = f.props;
    for (const g of f.geom) {
      const fl = [], pm = [];
      for (let i = 0; i < g.length; i += 2) { fl.push(lonOf(g[i]), latOf(g[i + 1])); pm.push([g[i] * S, g[i + 1] * S]); }
      names.push({ c: p.class, en: p["name:en"] || p.name_en || (CN ? p["name:latin"] || "" : ""), lat: p["name:latin"] || "", nm: p.name || "", ar: CN ? (p.name && HANRE.test(p.name) ? p.name : "") : PK ? arabicName(p) : (p["name:ar"] || ""), ref: p.ref || "", g: fl });
      if (NAME_SIGN.has(p.class)) {
        const en = latinName(p), ar = arabicName(p);
        if (en || ar) nameLines.push({ en, ar, ref: p.ref || "", pts: pm, bb: bboxOf(pm) });
      }
    }
  }

  // ---------------------------------------------------------------- roads
  const R = new Mesh({ position: 3, normal: 3, uv: 2, road: 4, junc: 4 });
  const SW = new Mesh({ position: 3, normal: 3, uv: 2, color: 3 });           // sidewalks, curbs, barriers, decks, piers, villa walls
  // 1. gather lines; bridges are densified so their ramps can bend
  const feats = [], roadColl = [];
  const toLL = pts => { const fl = []; for (const q of pts) fl.push(lonOf(q[0]), latOf(q[1])); return fl; };
  for (const f of (layers.transportation && layers.transportation.features) || []) {
    if (f.type !== 2) continue;
    const p = f.props; const cls = p.class;
    const spec = ROADS[cls];
    if (!spec || (p.brunnel === "tunnel" && (spec.c >= 7 || p.service === "parking_aisle"))) {   // footpath and car-park tunnels: in the index, not drawn
      for (const g of f.geom) { const pts = []; for (let i = 0; i < g.length; i += 2) pts.push([g[i], g[i + 1]]); roadColl.push({ c: cls, r: p.ramp === 1 ? 1 : 0, b: p.brunnel || "", g: toLL(pts), e: null }); }
      continue;
    }
    const oneway = p.oneway === 1 || p.oneway === -1 || (cls === "motorway");
    const ramp = p.ramp === 1, bridge = p.brunnel === "bridge", tunnel = p.brunnel === "tunnel";
    for (const g of f.geom) {
      let pts = []; for (let i = 0; i < g.length; i += 2) pts.push([g[i], g[i + 1]]);
      if (p.oneway === -1) pts.reverse();
      if (bridge || tunnel) pts = densify(pts, 15 / S);
      feats.push({ pts, cls, spec, oneway, ramp, bridge, tunnel, layer: +p.layer || 0, el: null });
    }
  }
  // real lane counts and speed limits from OpenStreetMap where the roads database has them
  if (m.rdb) for (const F of feats) { try { F.osm = osmRoad(F, m.rdb, lonOf, latOf); } catch (err) { F.osm = null; } }
  if (PK) pkMotorwayLanes(feats, latOf, lonOf);
  // Murree's Mall Road: OpenStreetMap maps its pedestrian section w288854890 at width=5, and the road section beside it (w288854889, no width tag) is taken to match
  if (PK) pkMallRoads(feats, latOf, lonOf);
  if (PK) pkBazaarPairs(feats, S, latOf, lonOf);
  if (TH) for (const F of feats) F.pts = TM.densifyToField(TH, F.pts, S);
  bridgeProfiles(feats, E, S);
  tunnelProfiles(feats, E, S);
  // decks span valleys: a bridge rises from the road grade to the closed land surface between its ends
  if (TH) for (const F of feats) if (F.bridge) {
    const R = Math.min(110, Math.max(12, 0.45 * F.len));
    for (let i = 0; i < F.pts.length; i++) {
      const s = F.cum[i], w = (F.openS ? 1 : smooth01(s / R)) * (F.openE ? 1 : smooth01((F.len - s) / R));
      if (w > 0) F.el[i] += w * Math.max(0, TH.bridge(F.pts[i][0] * S, F.pts[i][1] * S) - TH.road(F.pts[i][0] * S, F.pts[i][1] * S));
    }
  }
  for (const F of feats) { const [W, lanes] = roadDims(F); roadColl.push({ c: F.cls, r: F.ramp ? 1 : 0, b: F.bridge ? "bridge" : F.tunnel ? "tunnel" : "", g: toLL(F.pts), e: F.el ? F.el.slice() : null, w: W, o: F.oneway ? 1 : 0, l: lanes, m: F.osm && F.osm.m ? F.osm.m : 0, h: TH ? F.pts.map(q => TH.road(q[0] * S, q[1] * S)) : null }); }
  // 2. clip to the tile square, carrying elevation
  const lines = [];
  // The same carriageway can arrive twice (split features with identical geometry). A duplicate
  // makes every vertex look like a junction, which wipes the lane markings: keep one copy.
  const seenLine = new Set();
  for (const F of feats) for (const pl of clipLine3(F.pts, F.el, E)) {
    const sig = pl.pts.map(q => Math.round(q[0] * 4) + ":" + Math.round(q[1] * 4)).join(",");
    const rev = pl.pts.slice().reverse().map(q => Math.round(q[0] * 4) + ":" + Math.round(q[1] * 4)).join(",");
    if (seenLine.has(sig) || seenLine.has(rev)) { msg.dupLines = (msg.dupLines || 0) + 1; continue; }
    seenLine.add(sig);
    lines.push({ pts: pl.pts, el: pl.el, cls: F.cls, spec: F.spec, oneway: F.oneway, ramp: F.ramp, bridge: F.bridge, tunnel: F.tunnel, osm: F.osm });
  }
  if (TH) {
    GG = new TM.GroundGrid(TD, { z, x: tx, y: ty, TS });
    // whole features, buffer included: a road just over the tile edge still carves this tile's ground
    for (const F of feats) {
      if (F.spec.c >= 7) continue;
      const pts = F.pts.map(q => [q[0] * S, q[1] * S]);
      GG.addRoad(pts, pts.map(q => TH.road(q[0], q[1])), roadDims(F)[0] / 2 + (SIDEWALK_CLASSES.has(F.cls) ? 3 : 0) + (F.spec.c === 0 && !F.ramp ? PK_SHOULDER + 0.5 : 0), F.el.map(e => Math.abs(e) < 0.4));
    }
    for (const q of m.suppress || []) {
      if (q.lat === undefined) continue;
      const ringM = (q.padRing || q.ring).map(p => [xOfLon(p[0]) * S, yOfLat(p[1]) * S]);
      if (!ringM.some(p => p[0] > -60 && p[1] > -60 && p[0] < TS + 60 && p[1] < TS + 60)) continue;
      GG.addPad(ringM, TD.groundLL(q.lat, q.lon) + (q.baseOffset || 0), (q.baseOffset || 0) < 0);
    }
    GG.bake();
  }
  // junctions: vertices shared by several lines (in tile units, exact integer matches)
  const vmap = new Map();
  const vk = (x, y) => Math.round(x * 4) + "," + Math.round(y * 4);
  lines.forEach((L, li) => {
    if (L.spec.c >= 7) return;
    const hwL = roadDims(L)[0] / 2;
    L.pts.forEach((q, i) => {
      const k = vk(q[0], q[1]); let e = vmap.get(k);
      if (!e) { e = { lines: new Set(), nb: new Set(), interior: false, maxHalf: 0, topY: 0, topC: 9, elev: 0, x: q[0], y: q[1], edge: q[0] === 0 || q[1] === 0 || q[0] === E || q[1] === E, cl: null }; vmap.set(k, e); }
      e.lines.add(li);
      if (i > 0) e.nb.add(vk(L.pts[i - 1][0], L.pts[i - 1][1]));
      if (i < L.pts.length - 1) e.nb.add(vk(L.pts[i + 1][0], L.pts[i + 1][1]));
      if (i > 0 && i < L.pts.length - 1) e.interior = true;
      if (hwL > e.maxHalf) e.maxHalf = hwL;
      if (L.spec.y > e.topY) { e.topY = L.spec.y; e.topC = L.spec.c; }
      if (L.el[i] > e.elev) e.elev = L.el[i];
    });
  });
  // A junction is where the network branches: three or more distinct neighbouring vertices.
  // Counting lines instead fails on overlapping copies of one carriageway.
  const isJ = e => !e.edge && e.nb.size >= 3;
  const juncs = [];
  for (const e of vmap.values()) if (isJ(e)) juncs.push(e);

  // ---------------------------------------------------------------- traffic signals
  // Signalised junctions: the real OpenStreetMap signal nodes when the roads database covers
  // this tile, otherwise a rule (two main roads crossing at grade, not a one-way roundabout).
  // Junction vertices within 45 m (the two carriageways of a boulevard) share one controller.
  let sigNodes = null;
  if (m.rdb && m.rdb.signals) { try { sigNodes = m.rdb.signals(latOf(E), lonOf(0), latOf(0), lonOf(E)).filter(q => !q[2]).map(q => [xOfLon(q[1]), yOfLat(q[0])]); } catch (err) { sigNodes = null; } }
  const clusters = [];
  for (const e of juncs) {
    if (e.elev > 0.5 || e.topC > 5) continue;
    let major = 0, allOne = true, ramps = 0;
    for (const li of e.lines) { const L = lines[li]; if (L.spec.c <= 4 && !L.ramp) major++; if (!L.oneway) allOne = false; if (L.ramp) ramps++; }
    let sig = false;
    if (sigNodes) { const r2 = (38 / S) ** 2; for (const q of sigNodes) { const dx = q[0] - e.x, dy = q[1] - e.y; if (dx * dx + dy * dy < r2) { sig = true; break; } } }
    else sig = major >= 2 && e.topC <= 4 && !allOne && !ramps;
    if (!sig) continue;
    let cl = null;
    for (const c of clusters) if (Math.hypot(c.x - e.x, c.y - e.y) * S < 45) { cl = c; break; }
    if (!cl) { cl = { x: e.x, y: e.y, n: 0, ref: 0, best: 99, idx: clusters.length }; clusters.push(cl); }
    cl.x = (cl.x * cl.n + e.x) / (cl.n + 1); cl.y = (cl.y * cl.n + e.y) / (cl.n + 1); cl.n++;
    e.cl = cl;
  }
  // each controller's axis: the direction of its most important road
  if (clusters.length) for (const L of lines) {
    if (L.spec.c > 5) continue;
    for (let i = 0; i < L.pts.length; i++) {
      const e = vmap.get(vk(L.pts[i][0], L.pts[i][1])); if (!e || !e.cl || L.spec.c >= e.cl.best) continue;
      const a = L.pts[Math.max(0, i - 1)], b = L.pts[Math.min(L.pts.length - 1, i + 1)];
      e.cl.best = L.spec.c; e.cl.ref = Math.atan2(b[1] - a[1], b[0] - a[0]);
    }
  }
  const sigHeads = new FBuf(256), speedSigns = new FBuf(256);

  // Pakistan: pavements belong in built-up land, not on a road across open hillside. A 60 m grid of where buildings stand
  let builtGrid = null; const builtN = 40, builtAt = (x, z, k = 1) => { const i = Math.floor(x / TS * builtN), j = Math.floor(z / TS * builtN); return i >= 0 && j >= 0 && i < builtN && j < builtN && builtGrid[j * builtN + i] >= k; };
  if (PK) { builtGrid = new Uint8Array(builtN * builtN); const mark = (px, py) => { const i = Math.floor(px / E * builtN), j = Math.floor(py / E * builtN); for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = i + di, b = j + dj; if (a >= 0 && b >= 0 && a < builtN && b < builtN && builtGrid[b * builtN + a] < 250) builtGrid[b * builtN + a]++; } }; for (const f of (layers.building && layers.building.features) || []) for (const g of f.geom || []) if (g && g.length >= 2) mark(g[0], g[1]); if (m.fdb && m.fdb.features) { const kE = E / (m.fdb.extent || 4096); for (const f of m.fdb.features) { const g = f.geom[0]; if (g) mark(g[0] * kE, g[1] * kE); } } }
  const palms = new FBuf(), lamps = new FBuf(), streetTrees = new FBuf(), cuts = new FBuf(64), highways = [];
  const traffic = [], trails = [], kerbSpans = [], belt = new FBuf(256);
  const roadGrid = new SegGrid(40);
  const lhrMall = PK ? pkLahoreMall(nameLines, latOf, lonOf, S) : null, mallCanopy = new FBuf(256);
  for (const L of lines) {
    const pts = L.pts.map(q => [q[0] * S, q[1] * S]);
    const n = pts.length;
    const [W, lanes] = roadDims(L);
    // cumulative distance and junction distances
    const cum = [0]; for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[n - 1]; if (total < 0.5) continue;
    const jAt = L.pts.map(q => { const e = vmap.get(vk(q[0], q[1])); return e && isJ(e) ? e.maxHalf : -1; });
    const aD = new Array(n), aR = new Array(n), bD = new Array(n), bR = new Array(n);
    let last = -1e5, lastR = 0; for (let i = 0; i < n; i++) { if (jAt[i] >= 0) { last = cum[i]; lastR = jAt[i]; } aD[i] = cum[i] - last; aR[i] = lastR; }
    let next = 1e5 + total, nextR = 0; for (let i = n - 1; i >= 0; i--) { if (jAt[i] >= 0) { next = cum[i]; nextR = jAt[i]; } bD[i] = next - cum[i]; bR[i] = nextR; }
    const y0 = L.spec.y + (L.bridge ? 0.012 : 0) + (L.ramp ? 0.004 : 0);
    const Hc = TH ? pts.map(q => TH.road(q[0], q[1])) : null;
    const ys = L.el.map((e, i) => y0 + e + (Hc ? Hc[i] : 0));
    const elevated = L.el.some(e => e > 0.4), sunk = L.el.some(e => e < -0.4);
    const flags = (L.oneway ? 1 : 0) | (L.bridge ? 2 : 0) | (L.ramp ? 8 : 0);
    // Pakistan: footpaths and tracks are worn into the ground picture, not laid on it as ribbons
    if (PK && L.spec.c >= 7 && !L.bridge && !elevated && !sunk) { trails.push(pts); trails.push(L.spec.c); continue; }
    // Pakistan: the district travels to the road shader in the fraction of the class (see PK_ROAD in materials.js)
    const zoneL = PK ? pkZone(latOf(L.pts[n >> 1][1]), lonOf(L.pts[n >> 1][0])) : "";
    // Pakistan: bit 2 of the flags marks a motorway segment with no lamps, so the road shader paints no pools there (art_direction.md section 10: M-2 lighting at interchanges and service areas only)
    const flagsAt = PK && L.spec.c === 0 ? i => flags | (pkMotorwayLit((L.pts[i][0] + L.pts[i + 1][0]) / 2, (L.pts[i][1] + L.pts[i + 1][1]) / 2, L.ramp, lines, S, latOf, lonOf) ? 0 : 4) : flags;
    const off = ribbon(R, pts, cum, W, ys, lanes, flagsAt, L.spec.c + (PK ? pkRoadTag(zoneL, L.spec.c) : 0), aD, bD, aR, bR);
    if (L.spec.c <= 6) for (let i = 0; i < n - 1; i++) roadGrid.add(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], W / 2, L.spec.c, elevated || L.bridge || sunk);
    // sidewalks with curbs, cut back from junctions
    const urban = !PK || pts.filter((q, i) => i % Math.max(1, Math.floor(n / 12)) === 0).filter(q => builtAt(q[0], q[1], zoneL === "murree" ? 14 : 4)).length * Math.max(1, Math.floor(n / 12)) >= n * 0.34;
    if (SIDEWALK_CLASSES.has(L.cls) && !L.ramp && !L.bridge && !elevated && !sunk && urban && !(L.osm && L.osm.mall)) sidewalks(SW, pts, cum, off, W, aD, bD, aR, bR, L.oneway, Hc, PK ? Object.assign(pkSide(zoneL, L.spec.c, hash2(Math.round(pts[0][0]), Math.round(pts[0][1]))), { spans: kerbSpans, wear: PK_WEAR[zoneL] === undefined ? 0.5 : PK_WEAR[zoneL] }, L.osm && L.osm.pair ? { only: L.osm.pair, sw: L.osm.pave || PK_PAIR_PAVE } : null) : null);
    if (sunk) {
      const v0 = SW.vc;
      tunnelWalls(SW, pts, off, W, Hc ? L.el.map(e => y0 + e) : ys, L.el, cuts, PK ? pkUnderMotorway(lines, S) : null);
      if (Hc) drapeRange(SW, v0, (x, z) => TH.road(x, z));
    }
    if (PK && L.spec.c === 0 && !L.ramp && !L.bridge && !elevated && !sunk) pkShoulders(SW, pts, off, W, ys, cum);
    if ((L.bridge || elevated) && L.spec.c <= 6) barriers(SW, pts, off, W, ys);
    if (elevated) deckAndPiers(SW, pts, cum, off, W, ys, L.el);
    if (L.oneway && L.spec.c <= 1 && !L.ramp && !L.bridge && !elevated && !(PK && L.spec.c === 0)) medianBarrier(SW, pts, off, W, ys, PK ? -1 : 1);   // Pakistan keeps left, so the median is on the right of a carriageway; motorways get a planted median instead
    // props along the road
    const seed0 = hash2(Math.round(pts[0][0]), Math.round(pts[0][1]));
    if (L.osm && L.osm.mall) { /* Murree's Mall: shops wall to wall, no room for avenue trees */ }
    else if (lhrMall && !L.ramp && !L.bridge && !elevated && !sunk && lhrMall(pts[n >> 1][0], pts[n >> 1][1], 16)) propsAlong(mallCanopy, pts, cum, off, W, aD, bD, aR, bR, 9.5, W / 2 + 1.4, [-1, 1], seed0, 4, false, null);
    else if (PALM_CLASSES.has(L.cls) && !L.ramp && !L.bridge && !elevated && !sunk) propsAlong(CN || PK ? streetTrees : palms, pts, cum, off, W, aD, bD, aR, bR, 24, W / 2 + 2.6, [-1, 1], seed0, 10, false, null);
    else if (PK && (zoneL === "islamabad" || zoneL === "society") && (L.cls === "tertiary" || L.cls === "minor" || L.cls === "service") && !L.ramp && !L.bridge && !elevated && !sunk && streetTrees.n < 4 * 1100) propsAlong(streetTrees, pts, cum, off, W, aD, bD, aR, bR, 13, W / 2 + (zoneL === "society" ? 2.4 : 1.5), L.oneway ? [1] : [-1, 1], seed0, 7, false, null);   // green lanes: big trees down both verges
    else if ((L.cls === "tertiary" || L.cls === "minor") && !L.ramp && !L.bridge && !elevated && !sunk && seed0 < 0.6 && streetTrees.n < 4 * 450) propsAlong(streetTrees, pts, cum, off, W, aD, bD, aR, bR, 19, W / 2 + 1.9, L.oneway ? [1] : [-1, 1], seed0, 9, false, null);
    if (PK && L.spec.c === 0) { if (!sunk) { const lit = new FBuf(64); propsAlong(lit, pts, cum, off, W, aD, bD, aR, bR, 42, L.ramp ? W / 2 + 0.9 : W / 2 + 1.7, L.oneway ? [-1] : [-1, 1], seed0, 6, true, ys); for (let i = 0; i < lit.n; i += 4) if (pkMotorwayLit(lit.a[i] / S, lit.a[i + 1] / S, L.ramp, lines, S, latOf, lonOf)) lamps.p4(lit.a[i], lit.a[i + 1], lit.a[i + 2], lit.a[i + 3]); } }   // art_direction.md section 10: M-2 lighting at interchanges and service areas only
    else if (LAMP_CLASSES.has(L.cls) && !sunk && !(L.osm && L.osm.mall) && !(PK && pkShortLit(L, latOf, lonOf))) propsAlong(lamps, pts, cum, off, W, aD, bD, aR, bR, 42, L.oneway ? W / 2 + 0.9 : W / 2 + 1.2, L.oneway ? [PK ? -1 : 1] : [-1, 1], seed0, 6, true, ys);
    else if (L.cls === "minor" && !sunk && !L.bridge && !(PK && pkShortLit(L, latOf, lonOf))) propsAlong(lamps, pts, cum, off, W, aD, bD, aR, bR, 36, W / 2 + 1.0, [1], seed0, 6, true, ys);   // side streets: one row of lamps
    // signal approaches: heads at the stop line and stop points for the AI traffic
    const stops = [];
    if (clusters.length && L.spec.c <= 5 && !elevated && !sunk) {
      for (let i = 0; i < n; i++) {
        const e = vmap.get(vk(L.pts[i][0], L.pts[i][1])); if (!e || !e.cl) continue;
        for (const dir of L.oneway ? [1] : [1, -1]) {
          const j = i - dir; if (j < 0 || j >= n) continue;
          const pe = vmap.get(vk(L.pts[j][0], L.pts[j][1])); if (pe && pe.cl === e.cl) continue;        // already inside the junction box
          let dx = pts[i][0] - pts[j][0], dz = pts[i][1] - pts[j][1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
          const back = Math.min(l - 1, e.maxHalf + 2.5); if (back < 3) continue;
          const g = groupOf(Math.atan2(dz, dx), e.cl.ref);
          stops.push(cum[i] - dir * back, dir, e.cl.idx, g);
          const sx = pts[i][0] - dx * back, sz = pts[i][1] - dz * back, rot = Math.atan2(-dx, -dz);
          for (const sd of L.oneway ? [1, -1] : [PK ? -1 : 1]) { const o = sd * (W / 2 + 0.9); sigHeads.p3(sx - dz * o, sz + dx * o, ys[i] - L.spec.y); sigHeads.p3(rot, e.cl.idx, g); }
        }
      }
    }
    // speed-limit signs: after each junction on the main roads, then every 900 m
    if (L.spec.c <= 4 && !L.ramp && !sunk && total > 140) {
      const kmh = (L.osm && L.osm.m) || SPEED_KMH[L.spec.c];
      for (const dir of L.oneway ? [1] : [1, -1]) {
        for (let s = 70; s < total - 50; s += 900) {
          const sAt = dir > 0 ? s : total - s;
          let i = 0; while (i < n - 2 && cum[i + 1] < sAt) i++;
          const since = aD[i] + (sAt - cum[i]), until = bD[i] - (sAt - cum[i]);
          if (since < aR[i] + 18 || until < bR[i] + 18) continue;
          const t = (sAt - cum[i]) / Math.max(1e-6, cum[i + 1] - cum[i]);
          let dx = (pts[i + 1][0] - pts[i][0]) * dir, dz = (pts[i + 1][1] - pts[i][1]) * dir; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
          const o = (PK ? -1 : 1) * (W / 2 + (PK && L.spec.c === 0 ? PK_SHOULDER + 1.2 : 1.7)), x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t - dz * o, zz = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t + dx * o;   // Pakistan keeps left: the sign stands on the driver's left
          speedSigns.p4(x, zz, ys[i] + (ys[i + 1] - ys[i]) * t - L.spec.y, Math.atan2(-dx, -dz)); speedSigns.p1(kmh);
        }
      }
    }
    if (L.spec.c <= 1 && !elevated && !sunk && !L.bridge) highways.push(pts);
    if (L.spec.c <= 6) {
      const fl = new Float32Array(n * 2); for (let i = 0; i < n; i++) { fl[2 * i] = pts[i][0]; fl[2 * i + 1] = pts[i][1]; }
      traffic.push({ p: fl, e: elevated || sunk ? Float32Array.from(L.el) : null, h: Hc ? Float32Array.from(Hc) : null, c: L.spec.c, ow: L.oneway ? 1 : 0, w: W, l: lanes, b: L.bridge ? 1 : 0, st: stops.length ? Float32Array.from(stops) : null });
    }
  }
  // Pakistan: nobody walks the frontage roads along the motorways. Flagged here with the true geometry; peds.js reads it through the traffic line.
  if (PK) for (const T of traffic) {
    if (T.c < 2 || T.c > 6 || !T.p.length) continue;
    const n2 = T.p.length >> 1, mid = n2 >> 1, la = latOf(T.p[2 * mid + 1] / S), lo = lonOf(T.p[2 * mid] / S);
    if (pkZone(la, lo) !== "rural" && !(M2 && M2.m2At(la, lo))) continue;
    for (let i = 0, st = Math.max(1, n2 >> 3); i < n2; i += st) if (roadGrid.nearestSeg(T.p[2 * i], T.p[2 * i + 1], 170, 0, 0)) { T.np = 1; break; }
  }
  // Pakistan: a street tree beside one carriageway can land on the next one (close dual carriageways): drop those
  if (PK) {
    const a = streetTrees.a; let w = 0;
    for (let i = 0; i < streetTrees.n; i += 4) if (roadGrid.clear(a[i], a[i + 1], 12) > 1.2) { a[w] = a[i]; a[w + 1] = a[i + 1]; a[w + 2] = a[i + 2]; a[w + 3] = a[i + 3]; w += 4; }
    streetTrees.n = w;
  }
  for (const e of juncs) junctionDisc(R, e.x * S, e.y * S, e.maxHalf * 1.05, e.topY + e.elev + 0.003, e.topC + (PK ? pkRoadTag(pkZone(latOf(e.y), lonOf(e.x)), e.topC) : 0));
  const pkCh = PK ? pkChowks(lines, S) : [];
  for (const c of pkCh) chowkIsland(SW, c, TH ? TH.road(c.x, c.z) : 0, pkZone(latOf(c.z / S), lonOf(c.x / S)), Math.hypot((lonOf(c.x / S) - 73.05528) * 0.833, latOf(c.z / S) - 33.61306) * 111000 < 45);
  msg.roads = R.out(); collect(msg.roads, transfer);
  msg.cuts = cuts.out(); transfer.push(msg.cuts.buffer);
  const cl32 = new Float32Array(clusters.length * 4);
  clusters.forEach((c, i) => { cl32[4 * i] = c.x * S; cl32[4 * i + 1] = c.y * S; cl32[4 * i + 2] = hash2(Math.round(lonOf(c.x) * 2000), Math.round(latOf(c.y) * 2000)); cl32[4 * i + 3] = c.ref; });
  msg.signals = { c: cl32, h: sigHeads.out() }; transfer.push(msg.signals.c.buffer, msg.signals.h.buffer);

  // ---------------------------------------------------------------- buildings
  // Classify every footprint first, then hang the real shop and hotel names from OpenStreetMap
  // on the right walls (and mark those buildings as having shopfronts), then build geometry.
  const B = new Mesh({ position: 3, normal: 3, uv: 2, color: 3, facade: 4 });
  const BN = PK ? new Mesh({ position: 3, normal: 3, uv: 2, color: 3, facade: 4 }) : null;   // small Overture buildings, drawn near the camera only
  const BA = PK ? new Mesh({ position: 3, normal: 3, uv: 2, color: 3, facade: 4 }) : null;   // Pakistan: shop awnings, with the street dressing's short range and no shadow
  const bColl = [];                                  // collision rings in lon/lat, flat
  let bCount = 0, tallest = 0;
  const recs = [];
  const bl = (layers.building && layers.building.features) || [];
  for (const f of bl) {
    if (f.type !== 3) continue;
    const p = f.props; if (p.hide_3d) continue;
    let h0 = +p.render_height; const minh0 = +p.render_min_height || 0;
    if (!isFinite(h0) || h0 <= 0) h0 = 6;
    if (h0 - minh0 < 1) { if (minh0 > 0) continue; h0 = minh0 + 3; }
    // one tile feature can hold many buildings with the same tags: each gets its own height
    for (const poly of polygons(f.geom)) {
      let h = h0, minh = minh0;
      const rings = [];
      for (const r of poly) { const c = clipRing(r, E); if (c) rings.push(c); }
      if (!rings.length) continue;
      // classify
      const o = rings[0]; let area = 0, cx = 0, cy = 0, minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
      for (let i = 0; i < o.length; i++) { const a = o[i], b = o[(i + 1) % o.length]; const cr = a[0] * b[1] - b[0] * a[1]; area += cr; cx += (a[0] + b[0]) * cr; cy += (a[1] + b[1]) * cr; if (a[0] < minx) minx = a[0]; if (a[0] > maxx) maxx = a[0]; if (a[1] < miny) miny = a[1]; if (a[1] > maxy) maxy = a[1]; }
      area /= 2; if (Math.abs(area) < 1e-6) continue; cx /= (6 * area); cy /= (6 * area);
      const areaM = Math.abs(area) * S * S;
      const seed = hash2(Math.round(o[0][0] * 7 + h), Math.round(o[0][1] * 13 + minh));
      let col = hexRgb(p.colour);
      if (m.suppress && m.suppress.length) { const la = latOf(cy), lo = lonOf(cx); let hide = false; for (const q of m.suppress) { const bb = q.bbox; if (la < bb[0] || la > bb[2] || lo < bb[1] || lo > bb[3]) continue; if (pointInRingXY(lo, la, q.ring)) { hide = true; break; } } if (hide) continue; }
      // the building's own OpenStreetMap tags, found by which baked interior point lies inside it
      let bi = null;
      if (m.bdb) { try { const fl = []; let b0 = 1e9, b1 = 1e9, b2 = -1e9, b3 = -1e9; for (const q of o) { const lo = lonOf(q[0]), la = latOf(q[1]); fl.push(lo, la); if (lo < b0) b0 = lo; if (lo > b2) b2 = lo; if (la < b1) b1 = la; if (la > b3) b3 = la; } bi = m.bdb.inRing(fl, [b0, b1, b2, b3]); } catch (err) { bi = null; } }
      if (bi && !bi.fit) bi = null;                   // a small building's point inside a big footprint is not this building
      if (bi && bi.part) bi = null;                   // a building:part (a roof, a tower section) says nothing about the whole footprint
      const T = bi ? (bi.type || (bi.parent && bi.parent.type) || "") : "";
      // roofs on columns (petrol stations, car ports, shade structures): a slab you can drive under
      const canopy = (T === "roof" || T === "carport") && minh < 1;
      if (canopy) { h = bi.height || Math.min(Math.max(h, 5), 7.5); minh = h - 0.7; }
      // collision (outer ring only is enough to stop the car, holes matter for courtyards)
      if (minh < 3) { const flat = []; for (const r of rings) { const fr = []; for (const q of r) fr.push(lonOf(q[0]), latOf(q[1])); flat.push(fr); } bColl.push(flat); }

      if (bi && !bi.part && !bi.height && minh < 1) {
        // storeys the tile data could not read (the UAE's "G+12" style), and sensible heights for
        // tagged buildings that have no storeys at all
        if (bi.levels && h < bi.levels * 3.0) h = bi.levels * 3.4 + 1.2;
        else if (!bi.levels && h <= 6.5) h = (T === "residential" || T === "apartments") && areaM < 500 ? 7.5 : (TYPE_H[T] || h);
      }
      // Shanghai: OpenStreetMap has a height for only about 1 building in 10, and the tile default is a
      // 2-storey box. Estimate from the footprint instead (point towers, slab blocks, podiums, sheds).
      if (CN && minh < 1 && !canopy && h0 <= 6.5 && !(bi && (bi.levels || bi.height))) h = cnHeight(areaM, (maxx - minx) * S, (maxy - miny) * S, T, seed);
      if (bi && bi.colour) col = hexRgb(bi.colour) || col;
      const glassy = (col && col[2] > col[0] + 0.12) || (bi && bi.material === "glass");            // OSM "glass" material comes through as #5a81a0
      let type, color, floorH = 3.3;
      let isMosque = !!(bi && (T === "mosque" || (bi.amenity === "place_of_worship" && bi.religion === "muslim")) && h < 40);
      if (!isMosque && h < 30 && mosques.length) for (const q of mosques) if (q[0] > minx && q[0] < maxx && q[1] > miny && q[1] < maxy && pointInRingXY(q[0], q[1], o)) { isMosque = true; break; }
      // "residential" on a small footprint without storeys is a villa (common tagging in Abu Dhabi)
      const kind = (!CN && T === "residential" && areaM < 500 && !(bi && bi.levels > 2)) ? "house" : TYPE_KIND[T] || (bi && (bi.shop === "mall" || bi.shop === "supermarket") ? "retail" : bi && bi.tourism === "hotel" ? "hotel" : "");
      if (isMosque) { type = 5; color = lin(hexRgb(seed < 0.5 ? "#f4efe6" : "#ebe1cf")); floorH = 4.5; }
      else if (h >= 45 || (glassy && h >= 18)) {
        if (glassy || seed < 0.62) { type = 0; color = lin(col && glassy ? col : hexRgb(GLASS[Math.floor(seed * 97) % GLASS.length])); floorH = 3.8; }
        else { type = 1; color = lin(col && !glassy ? col : hexRgb(WALLS[Math.floor(seed * 89) % WALLS.length])); floorH = 3.2; }
      } else if (h >= 11) {
        if (seed < 0.7) { type = 1; floorH = 3.2; } else { type = 2; floorH = 3.6; }
        color = lin(col && !glassy ? col : hexRgb(WALLS[Math.floor(seed * 89) % WALLS.length]));
      } else if (areaM > 1800) { type = 4; color = lin(col && !glassy ? col : hexRgb(SHED[Math.floor(seed * 53) % SHED.length])); floorH = 4.5; }
      else { type = 3; color = lin(col && !glassy ? col : hexRgb(WALLS[Math.floor(seed * 71) % WALLS.length])); floorH = 3.2; }
      // what OpenStreetMap says the building is overrides the guess from its height
      if (!isMosque && kind) {
        const wall = () => lin(col && !glassy ? col : hexRgb(WALLS[Math.floor(seed * 89) % WALLS.length]));
        if (kind === "house") { type = 3; floorH = 3.3; color = wall(); }
        else if (kind === "shed") { type = 4; floorH = 4.5; color = lin(col && !glassy ? col : hexRgb(SHED[Math.floor(seed * 53) % SHED.length])); }
        else if (kind === "flats") {
          if (h >= 60 && seed < 0.45) { type = 0; floorH = 3.4; color = lin(glassy && col ? col : hexRgb(GLASS[Math.floor(seed * 97) % GLASS.length])); }
          else if (!glassy || h < 30) { type = 1; floorH = 3.2; color = wall(); }
        }
        else if (kind === "office") { if (h >= 30 || glassy) { type = 0; floorH = 3.8; color = lin(glassy && col ? col : hexRgb(GLASS[Math.floor(seed * 97) % GLASS.length])); } else { type = 2; floorH = 3.6; color = wall(); } }
        else if (kind === "civic") { type = 2; floorH = 4.0; color = wall(); }
        else if (kind === "construction") { type = 7; floorH = 3.4; color = lin(hexRgb("#b9b5ad")); }
      }
      if (bi && bi.material === "glass" && type !== 7 && h >= 12) { type = 0; floorH = 3.8; }
      if (canopy) { type = 6; color = lin(hexRgb(seed < 0.5 ? "#e9eaec" : "#d9d3c6")); }
      recs.push({ rings, o, h, minh, type, color, seed, floorH, cx, cy, minx, miny, maxx, maxy, areaM, isMosque, canopy, retail: kind === "retail" || kind === "hotel" && h < 30 ? 1 : 0, used: null, bi, kind,
        roofShape: bi && bi.roofShape && bi.roofShape !== "flat" ? bi.roofShape : null, roofH: bi && bi.roofHeight ? bi.roofHeight : 0, roofCol: bi && bi.roofColour ? lin(hexRgb(bi.roofColour)) : null,
        name: bi && !bi.part ? (bi.nameEn || (bi.name && LATINRE.test(bi.name) ? bi.name : "")) : "",
        hadCol: !!(col || (bi && bi.colour)), guessH: !CN && h0 <= 6.5 && minh0 === 0 && !(bi && (bi.levels || bi.height)) && (!kind || T === "residential") });
    }
  }
  // Untagged low buildings in a dense district (Karama, Deira, Satwa, Bur Dubai) are G+2 to G+4
  // apartment blocks with shops below, not villas. Tell them apart by how much ground buildings
  // cover around them (measured: villa districts 0.18 to 0.26, Karama 0.39 to 0.42, the Deira souk
  // 0.52 to 0.56) and by the size of the neighbours (industrial areas are dense too, with big sheds).
  {
    const C = 40 / S, cov = new Map(), key = (i, j) => i * 4096 + j;
    for (const r of recs) { if (r.minh > 2) continue; const k = key(Math.floor(r.cx / C), Math.floor(r.cy / C)); let c = cov.get(k); if (!c) cov.set(k, c = [0, 0]); c[0] += r.areaM; c[1]++; }
    for (const r of recs) {
      if (!r.guessH || r.type !== 3 || r.isMosque || r.canopy) continue;
      const la = latOf(r.cy), lo = lonOf(r.cx);
      if (HERITAGE.some(b => la > b[0] && la < b[2] && lo > b[1] && lo < b[3])) {
        r.h = 5.6 + (r.seed < 0.35 ? 2.9 : 0); r.floorH = 3.6; r.heritage = 1;
        r.color = lin(hexRgb(HERITAGE_WALLS[Math.floor(r.seed * 97) % HERITAGE_WALLS.length]));
        continue;
      }
      const gx = Math.floor(r.cx / C), gy = Math.floor(r.cy / C); let a = 0, n = 0;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const c = cov.get(key(gx + i, gy + j)); if (c) { a += c[0]; n += c[1]; } }
      const dens = a / (120 * 120);
      if (dens < 0.33 || a / n > 1500 || r.areaM < 90) continue;
      const floors = 3 + (hash2(Math.round(r.cx * 31), Math.round(r.cy * 17)) < 0.5 ? 0 : 1) + (dens > 0.45 && r.seed < 0.45 ? 1 : 0);
      r.h = floors * 3.3 + 1.1; r.type = 1; r.floorH = 3.3; r.dense = 1;
    }
  }
  // Pakistan: the machine-learned Overture footprints (city/footprintsdb.js). The map tile's own buildings win:
  // a footprint that lands inside one is dropped. None of these carries a height, so storeys come from the
  // district, the footprint size and how built-up the ground around it is.
  if (PK && m.fdb && m.fdb.features && m.fdb.features.length) {
    const kE = E / (m.fdb.extent || 4096), OC = 32 / S, occ = new Map(), okey = (i, j) => i * 4096 + j;
    for (const r of recs) { if (r.minh >= 3) continue; for (let gx = Math.floor(r.minx / OC); gx <= Math.floor(r.maxx / OC); gx++) for (let gy = Math.floor(r.miny / OC); gy <= Math.floor(r.maxy / OC); gy++) { const k = okey(gx, gy); let a = occ.get(k); if (!a) occ.set(k, a = []); a.push(r); } }
    const list = [], Cd = 40 / S, cov = new Map(), ck = (i, j) => i * 4096 + j;
    for (const r of recs) { if (r.minh > 2) continue; const k = ck(Math.floor(r.cx / Cd), Math.floor(r.cy / Cd)); cov.set(k, (cov.get(k) || 0) + r.areaM); }
    for (const f of m.fdb.features) for (const poly of polygons(f.geom)) {
      const rings = []; for (const r of poly) { const c = clipRing(kE === 1 ? r : r.map(v => v * kE), E); if (c) rings.push(c); }
      if (!rings.length) continue;
      const o = rings[0]; let area = 0, cx = 0, cy = 0, minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
      for (let i = 0; i < o.length; i++) { const a = o[i], b = o[(i + 1) % o.length]; const cr = a[0] * b[1] - b[0] * a[1]; area += cr; cx += (a[0] + b[0]) * cr; cy += (a[1] + b[1]) * cr; if (a[0] < minx) minx = a[0]; if (a[0] > maxx) maxx = a[0]; if (a[1] < miny) miny = a[1]; if (a[1] > maxy) maxy = a[1]; }
      area /= 2; if (Math.abs(area) < 1e-6) continue; cx /= (6 * area); cy /= (6 * area);
      const areaM = Math.abs(area) * S * S; if (areaM < 14) continue;
      if (m.suppress && m.suppress.length) { const la = latOf(cy), lo = lonOf(cx); let hide = false; for (const q of m.suppress) { const bb = q.bbox; if (la < bb[0] || la > bb[2] || lo < bb[1] || lo > bb[3]) continue; if (pointInRingXY(lo, la, q.ring)) { hide = true; break; } } if (hide) continue; }
      let inOsm = false; for (const r of occ.get(okey(Math.floor(cx / OC), Math.floor(cy / OC))) || []) if (cx > r.minx && cx < r.maxx && cy > r.miny && cy < r.maxy && pointInRingXY(cx, cy, r.o)) { inOsm = true; break; }
      if (inOsm) continue;
      if (roadGrid.clear(cx * S, cy * S, 8) < 0.5) continue;                       // a mistaken footprint on a carriageway
      list.push({ rings, o, cx, cy, minx, miny, maxx, maxy, areaM });
      const k = ck(Math.floor(cx / Cd), Math.floor(cy / Cd)); cov.set(k, (cov.get(k) || 0) + areaM);
    }
    for (const q of list) {
      const { rings, o, cx, cy, minx, miny, maxx, maxy, areaM } = q;
      const seed = hash2(Math.round(o[0][0] * 7), Math.round(o[0][1] * 13)), s2 = hash2(Math.round(cx * 3), Math.round(cy * 5));
      const gx = Math.floor(cx / Cd), gy = Math.floor(cy / Cd); let a = 0;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) a += cov.get(ck(gx + i, gy + j)) || 0;
      const dens = a / (120 * 120), zone = pkZone(latOf(cy), lonOf(cx));
      const st = pkStoreys(zone, areaM, dens, seed, s2);
      let type, floorH = 3.1, h = st * 3.1 + 0.9;
      const packed = (zone === "pindi" || zone === "lahore") && dens > 0.3;       // wall to wall: blocks with shops below, not detached houses
      if (zone === "murree" && areaM > 2400) continue;                             // no hillside house is this big: a mistaken detection, it showed as a white slab with pines on it
      if (zone === "blue" && areaM > 300) { type = s2 < 0.45 ? 0 : 2; floorH = 3.6; h = st * 3.6 + 1; }
      else if (areaM > 1800) { h = 6.5 + 2.5 * seed; type = 4; floorH = 4.5; }
      else if (packed) { type = 1; floorH = 3.1; h = st * 3.1 + 1; }
      else if (h >= 11) { type = s2 < 0.75 ? 1 : 2; floorH = 3.1; }
      else type = 3;
      const pal = PK_WALLS[zone] || PK_WALLS.rural, color = lin(hexRgb(type === 0 ? PK_GLASS[Math.floor(seed * 97) % PK_GLASS.length] : type === 4 ? PK_WALLS.shed[Math.floor(seed * 97) % PK_WALLS.shed.length] : pal[Math.floor(seed * 89) % pal.length]));
      let isMosque = false, roofCol = null;
      if (h < 30 && mosques.length) for (const p of mosques) if (p[0] > minx && p[0] < maxx && p[1] > miny && p[1] < maxy && pointInRingXY(p[0], p[1], o)) { isMosque = true; break; }
      if (isMosque) { type = 5; h = Math.max(h, 9.5); floorH = 4.5; }
      else if (zone === "murree") roofCol = lin(hexRgb(PK_TIN[Math.floor(s2 * 89) % PK_TIN.length]));
      recs.push({ rings, o, h, minh: 0, type, color: isMosque ? lin(hexRgb("#ece4d4")) : color, seed, floorH, cx, cy, minx, miny, maxx, maxy, areaM, isMosque, canopy: false, retail: 0, used: null, bi: null, kind: "", roofShape: null, roofH: 0, roofCol, name: "", guessH: false, fp: areaM < FP_NEAR_AREA && zone !== "murree" ? 2 : 1, dense: dens > 0.33 || packed ? 1 : 0, packed, zone, dens });
      // collision only where a car can reach: within 35 m of a road
      if (roadGrid.clear(cx * S, cy * S, 35) < 35) { const flat = []; for (const r of rings) { const fr = []; for (const p of r) fr.push(lonOf(p[0]), latOf(p[1])); flat.push(fr); } bColl.push(flat); }
    }
    msg.fpCount = list.length;
  }
  if (PK) pkDress(recs, S, E, latOf, lonOf);
  if (PK) msg.infill = pkInfill(recs, S, E, TS, roadGrid, lines, layers, latOf, lonOf, bColl, pkCh);
  if (PK) pkOldPlots(recs, S, latOf, lonOf, nameLines);
  if (PK) { msg.mallLots = pkMallTerrace(recs, S, E, lines, roadGrid, latOf, lonOf, bColl); pkJinnahBlocks(recs, S, E, xOfLon, yOfLat, lonOf, latOf, bColl); pkFacadeKits(recs, S, E, latOf, lonOf, lhrMall, roadGrid); }
  if (GG) for (const r of recs) { const b = GG.base2(r.o, S, r.cx, r.cy); r.gy = b.y; r.glow = b.low; if (r.frontP && TH) { r.gy = TH.road(r.frontP[0], r.frontP[1]) + 0.07; r.glow = Math.min(r.glow, r.gy); } }
  // Pakistan: share of the ground under roofs, on a 35 m grid smoothed over 3x3 cells, for the ground paint and the bazaar dressing
  let pkCov = null; const pkCN = 64, pkCell = TS / pkCN;
  const pkCover = (x, z) => { if (!pkCov) return 0; const i = Math.floor(x / pkCell), j = Math.floor(z / pkCell); return i >= 0 && j >= 0 && i < pkCN && j < pkCN ? pkCov[j * pkCN + i] : 0; };
  if (PK) {
    const raw = new Float32Array(pkCN * pkCN); pkCov = new Float32Array(pkCN * pkCN);
    for (const r of recs) { if (r.minh > 2) continue; const i = Math.floor(r.cx * S / pkCell), j = Math.floor(r.cy * S / pkCell); if (i >= 0 && j >= 0 && i < pkCN && j < pkCN) raw[j * pkCN + i] += r.areaM; }
    for (let j = 0; j < pkCN; j++) for (let i = 0; i < pkCN; i++) { let a = 0, c = 0; for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) { const ii = i + u, jj = j + v; if (ii >= 0 && jj >= 0 && ii < pkCN && jj < pkCN) { a += raw[jj * pkCN + ii]; c++; } } pkCov[j * pkCN + i] = a / (c * pkCell * pkCell); }
  }
  // footprint grid (tile units) for point lookups
  const GB = 48, gcell = E / GB, bgrid = new Map();
  recs.forEach((r, i) => { if (r.minh > 2) return; for (let gx = Math.max(0, Math.floor(r.minx / gcell)); gx <= Math.min(GB - 1, Math.floor(r.maxx / gcell)); gx++) for (let gy = Math.max(0, Math.floor(r.miny / gcell)); gy <= Math.min(GB - 1, Math.floor(r.maxy / gcell)); gy++) { const k = gx * 64 + gy; let a = bgrid.get(k); if (!a) bgrid.set(k, a = []); a.push(i); } });
  const bldAt = (x, y) => { const k = Math.floor(x / gcell) * 64 + Math.floor(y / gcell); for (const i of bgrid.get(k) || []) { const r = recs[i]; if (x < r.minx || x > r.maxx || y < r.miny || y > r.maxy) continue; if (pointInRingXY(x, y, r.o)) return r; } return null; };
  const bldNear = (x, y, maxT) => { let best = null, bd = maxT; const g0x = Math.floor((x - maxT) / gcell), g1x = Math.floor((x + maxT) / gcell), g0y = Math.floor((y - maxT) / gcell), g1y = Math.floor((y + maxT) / gcell); const seen = new Set(); for (let gx = g0x; gx <= g1x; gx++) for (let gy = g0y; gy <= g1y; gy++) for (const i of bgrid.get(gx * 64 + gy) || []) { if (seen.has(i)) continue; seen.add(i); const r = recs[i]; const d = ringDist(x, y, r.o); if (d < bd) { bd = d; best = r; } } return best; };

  // shop, office and hotel signs on the walls, from the real POI names
  const texts = [], textIds = new Map();
  const textId = (en, ar, ref, cls) => { const k = en + "|" + ar + "|" + ref + "|" + cls; let id = textIds.get(k); if (id === undefined) { id = texts.length; texts.push({ en, ar, ref, cls }); textIds.set(k, id); } return id; };
  const shopSigns = new FBuf(512), towerSigns = new FBuf(64), stockCards = new FBuf(512);
  pois.sort((a, b) => a.rank - b.rank);
  let shopsPlaced = 0;
  const shopCell = new Map(), cellOf = q => Math.floor(q.x * S / 250) * 64 + Math.floor(q.y * S / 250);
  for (const q of pois) {
    if (shopsPlaced >= 1200) break;
    if ((shopCell.get(cellOf(q)) || 0) >= 40) continue;
    const rec = bldAt(q.x, q.y) || bldNear(q.x, q.y, 14 / S);
    if (!rec || rec.minh > 2 || rec.isMosque) continue;
    const tall = rec.h >= 45 && (q.cls === "lodging" || (q.cls === "office" && q.rank <= 2));
    const nameLen = (q.en || q.ar).length;
    if (tall && nameLen <= 28 && !rec.tower) {
      // hotel and company names in big letters near the top of the tower, on the side facing a road
      const letterH = Math.max(2.2, Math.min(5.5, rec.h * 0.035));
      const edge = bestEdge(rec.o, S, q.x, q.y, roadGrid, 16);
      if (edge) {
        const w = Math.min(edge.len * 0.84, letterH * nameLen * 0.66 + 2);
        if (w > letterH * 2.2) {
          // below the lit crown band (the top 7 m of towers over 60 m glows at night)
          const y = rec.h >= 60 ? rec.h - 7.8 - letterH * 0.5 : rec.h - letterH * 0.65 - 1.5;
          towerSigns.p4(edge.mx + edge.nx * 0.2, y + (rec.gy || 0), edge.mz + edge.nz * 0.2, Math.atan2(edge.nx, edge.nz)); towerSigns.p4(w, letterH, textId(q.en || q.ar, "", "", q.cls), 1);
          rec.tower = 1;
        }
      }
      continue;
    }
    if (q.cls === "lodging" && rec.h >= 45) continue;
    const edge = bestEdge(rec.o, S, q.x, q.y, roadGrid, 0);
    if (!edge || edge.len < 3.5) continue;
    const hs = rec.h >= 9 ? 1.1 : 0.9;
    const w = Math.min(edge.len - 0.8, Math.max(3.2, Math.min(8.5, nameLen * 0.42 + 1.4)));
    // along-edge position under the POI, kept clear of signs already on this wall
    let t = Math.max(w / 2 + 0.3, Math.min(edge.len - w / 2 - 0.3, edge.t * edge.len));
    rec.used = rec.used || [];
    let ok = false;
    for (const tryT of [t, t + w + 0.6, t - w - 0.6, t + 2 * (w + 0.6), t - 2 * (w + 0.6)]) {
      if (tryT < w / 2 + 0.3 || tryT > edge.len - w / 2 - 0.3) continue;
      if (rec.used.some(u => u[0] === edge.i && Math.abs(u[1] - tryT) < (u[2] + w) / 2 + 0.4)) continue;
      t = tryT; ok = true; break;
    }
    if (!ok) continue;
    rec.used.push([edge.i, t, w]);
    const y = rec.h >= 7 ? Math.min(rec.h - 0.8, 4.0) : Math.max(1.9, rec.h - 0.75);
    const px = edge.ax + edge.dx * t + edge.nx * 0.12, pz = edge.az + edge.dz * t + edge.nz * 0.12;
    shopSigns.p4(px, y + (rec.gy || 0), pz, Math.atan2(edge.nx, edge.nz)); shopSigns.p4(w, hs, textId(q.en, q.ar, "", q.sub && q.cls === "shop" ? q.sub : q.cls), 1);
    rec.retail = 1; shopsPlaced++; shopCell.set(cellOf(q), (shopCell.get(cellOf(q)) || 0) + 1);
  }

  const VW = new Mesh({ position: 3, normal: 3, uv: 2, color: 3 });          // villa boundary walls and street dressing (drawn near the camera only)
  // Pakistan splits the dressing by how far it can be read (world.js cullNear): VW walls and fences cast shadows and reach furthest, VN is the street furniture, VF the small stuff: stock in the shop mouths, sign brackets, rebar
  const VN = PK ? new Mesh({ position: 3, normal: 3, uv: 2, color: 3 }) : null, VF = PK ? new Mesh({ position: 3, normal: 3, uv: 2, color: 3 }) : null;
  if (PK) msg.pkSigns = pkFrontages(recs, S, roadGrid, textId, shopSigns, VF, VN, latOf, lonOf, pkJharokaStreets(nameLines), pkNamedShopStreets(nameLines), stockCards);
  // named towers carry their name in lettering near the top (the real ones mostly do): the
  // tallest first, and not generic names ("Building 3", "Tower B") or tenants (a gym, a clinic)
  for (const rec of recs.filter(r => r.name && r.h >= 60).sort((a, b) => b.h - a.h)) {
    if (/^(building|tower|block|bldg|the apartments?)\b.{0,4}$/i.test(rec.name) || /\b(gym|clinic|salon|pharmacy|parking)\b/i.test(rec.name)) continue;
    if (!rec.name || rec.tower || rec.h < 60 || rec.minh > 2 || rec.name.length > 26 || towerSigns.n >= 8 * 40) continue;
    const letterH = Math.max(2.2, Math.min(5.0, rec.h * 0.03));
    const edge = bestEdge(rec.o, S, rec.cx, rec.cy, roadGrid, 16); if (!edge) continue;
    const w = Math.min(edge.len * 0.84, letterH * rec.name.length * 0.66 + 2); if (w < letterH * 2.2) continue;
    const y = rec.h - 7.8 - letterH * 0.5;
    towerSigns.p4(edge.mx + edge.nx * 0.2, y + (rec.gy || 0), edge.mz + edge.nz * 0.2, Math.atan2(edge.nx, edge.nz)); towerSigns.p4(w, letterH, textId(rec.name, "", "", "tower"), 1);
    rec.tower = 1;
  }
  // geometry: walls with shopfront flags, roofs, rooftop plant, villa walls
  const roof = new FBuf(1024);
  let roofBudget = PK ? 9000 : 5000, nRebar = 0;
  const pkKitN = { c: 0, h: 0, st: 0 };
  for (const rec of recs) {
    const { rings, h, minh, type, color, seed, floorH } = rec;
    const Bm = rec.fp === 2 ? BN : B;
    // shopfront ground floors: any building with a shop sign, and most mid-rise blocks on a main road
    let retail = rec.retail;
    if (!retail && minh < 1 && (type === 1 || type === 2) && h < 60) {
      if (rec.dense) { const d = roadGrid.nearest(rec.cx * S, rec.cy * S, PK ? 30 : 45, 2, PK ? 6 : 5); if (d) retail = 1; }
      else { const d = roadGrid.nearest(rec.cx * S, rec.cy * S, 60); if (d && d.c >= 2 && d.c <= 5 && seed < 0.75) retail = 1; }
    }
    if (h > tallest) tallest = h;
    // a pitched, pyramid or dome roof from OpenStreetMap sits on walls that stop below it
    const rsh = rec.roofShape && minh < 1 && rings.length === 1 && rec.areaM < 12000 ? rec.roofShape : null;
    const rh = rsh ? Math.min(rec.roofH || roofGuess(rsh, rec, S), h * 0.6) : 0;
    const vB0 = Bm.vc, rf0 = roof.n;
    addPrism(Bm, rings, S, E, h - rh, minh, type + (retail && !rec.colonial ? 0.3 : 0) + (rec.bazaar ? 0.06 : rec.kit || 0), color, seed, floorH, rec.roofCol);
    if (rec.colonial && rec.mallV !== 2 && (rec.name || rec.areaM > 260)) pkColonialFront(Bm, rec, S, roadGrid);
    if (rsh) addRoofShape(Bm, rec, S, h - rh, rh, rsh, rec.roofCol || (rsh === "dome" || rsh === "onion" ? lin(hexRgb(seed < 0.5 ? "#f2eee6" : "#c9b27a")) : lin(hexRgb(seed < 0.5 ? "#9c5a3c" : "#7a7f86"))), seed);
    if (type === 7 && minh < 1 && h > 15 && roofBudget > 0) roofBudget -= craneItems(rec, S, roof);
    if (rec.canopy) { const b = obbOf(rec.o, S); if (b) { const cc = lin(hexRgb("#c9c9cb")), nu = Math.max(1, Math.round(b.eu / 6)), g1 = rec.gy || 0; for (let k = -nu; k <= nu; k += Math.max(1, nu)) for (const sv of [-1, 1]) { const u = k / nu * (b.eu - 1.2), v = sv * (b.ev - 1.2); if (b.ev < 3 && sv > 0) continue; box(SW, b.cx + u * b.ux + (b.ev < 3 ? 0 : v) * b.vx, b.cz + u * b.uz + (b.ev < 3 ? 0 : v) * b.vz, b.ux, b.uz, 0.25, 0.25, rec.glow !== undefined ? rec.glow : 0, g1 + minh, cc); } } }
    if (rec.isMosque && minh === 0) addMosqueParts(Bm, rec.o, S, rec.cx, rec.cy, h, rec.minx, rec.miny, rec.maxx, rec.maxy, seed);
    bCount++;
    if (roofBudget > 0 && minh < 1 && !rec.isMosque && type !== 4 && rec.areaM >= (PK ? (rec.packed ? 14 : 40) : 60) && (PK ? rec.zone !== "murree" && (rec.packed || !rec.fp || seed < 0.7) : (!rec.fp || seed < 0.3))) roofBudget -= PK ? pkRoofItems(rec, S, roof) : roofItems(rec, S, roof);
    if (PK && minh < 1 && !rec.isMosque && type !== 4 && !rsh && (rec.zone === "pindi" || rec.zone === "lahore") && (rec.packed || seed < 0.6) && nRebar < 3200) { nRebar++; pkRebar(VF, rec, S); }
    if (GG) { seatBuilding(Bm, vB0, rec); for (let i = rf0; i < roof.n; i += 9) roof.a[i + 1] += rec.gy; }
    if (BA && rec.aw) { const a0 = BA.vc; for (const q of rec.aw) awning(BA, q, seed); if (GG) seatBuilding(BA, a0, rec); }
    if (!CN && (!rec.fp || rec.villa) && type === 3 && minh < 1 && h < 11 && rec.areaM >= 60 && rec.areaM < 1100 && !retail && !rec.heritage && (!PK || rec.villa)) { const vw0 = VW.vc; if (!PK || !pkCompound(rec, S, roadGrid, bldAt, VW, pkKitN)) villaWall(rec, S, roadGrid, bldAt, VW, recs); if (GG) drapeRange(VW, vw0, (x, z) => GG.at(x, z)); }
    if (PK && minh < 1) pkHouseDress(rec.kit === 0.15 || rec.kit === 0.18 ? VW : VN, rec, S, roadGrid, pkKitN);     // Murree's terraces and arcades carry the street from afar; balconies and dishes do not
  }
  if (PK) pkWires(VN, lines, S, TH, recs, latOf, lonOf);
  if (PK) pkMallPave(VW, lines, S, TH);
  if (PK) pkFaisalKerbs(VW, S, TS, xOfLon, yOfLat);
  if (PK) msg.railN = pkHillRails(VW, lines, S, TS, TH, roadGrid, bldNear, latOf, lonOf);
  let pkFore = null; const pkBeltG = [];
  const pkOpen = PK ? pkOpenLand(layers, S, TS, E) : null;
  if (PK) { pkFore = pkForecourts(SW, VN, recs, S, roadGrid, bldAt); pkStreetLife(VN, lines, S, TH, roadGrid, bldNear, trails, belt, latOf, lonOf, pkCh, pkBeltG, pkOpen); pkShortLamps(VN, lines, S, TH, bldAt, stockCards, latOf, lonOf); pkVerges(VW, lines, S, roadGrid, bldNear, belt, pkOpen, latOf, lonOf); pkBareLots(SW, VW, S, TS, roadGrid, bldNear, pkOpen, latOf, lonOf); pkKerbWear(VN, kerbSpans); pkMotorwayDress(SW, VW, lines, S, TS, roadGrid, bldNear, belt, roof, pkBeltG, latOf, lonOf, xOfLon, yOfLat); }
  msg.buildings = B.out(); collect(msg.buildings, transfer); chunkIndex(msg.buildings, TS, 3, transfer);
  if (BN) { msg.fpn = chunkSplit(BN.out(), TS, 8, transfer); msg.fpa = chunkSplit(BA.out(), TS, 10, transfer); }
  msg.tallest = tallest; msg.bCount = bCount;
  msg.roofs = roof.out(); transfer.push(msg.roofs.buffer);
  if (PK) { msg.vwalls = chunkSplit(VW.out(), TS, 8, transfer); msg.vnear = chunkSplit(VN.out(), TS, 10, transfer); msg.vfine = chunkSplit(VF.out(), TS, 16, transfer); }
  else { msg.vwalls = VW.out(); collect(msg.vwalls, transfer); chunkIndex(msg.vwalls, TS, 4, transfer); }
  // floating name labels for the places people navigate by (metro stations, malls, hotels, sights)
  const labels = [], seenL = new Set();
  labelPois.sort((a, b) => a.rank - b.rank);
  for (const q of labelPois) {
    const nm = q.en || q.ar; if (seenL.has(q.k + nm)) continue; seenL.add(q.k + nm);
    const rec = bldAt(q.x, q.y);
    if (q.k === "hotel" && (!rec || rec.h < 30)) continue;
    labels.push({ en: q.en, ar: q.ar, k: q.k, x: q.x * S, z: q.y * S, y: (q.k === "metro" ? 16 : q.k === "mosque" ? (rec ? Math.max(rec.h, 14) + 10 : 22) : rec ? rec.h + 6 : 10) + (GG ? GG.at(q.x * S, q.y * S) : 0) });
    if (labels.length >= 90) break;
  }
  for (const rec of recs) {
    if (labels.length >= 120) break;
    if (!rec.name || rec.minh > 2) continue;
    const bi = rec.bi || {};
    const k = rec.isMosque ? "mosque" : (bi.shop === "mall" || bi.shop === "department_store" || rec.kind === "retail" && rec.areaM > 3000) ? "mall" : (bi.tourism === "hotel" || rec.kind === "hotel") ? "hotel" : (bi.tourism === "museum" || bi.tourism === "attraction") ? "sight" : "";
    if (!k || seenL.has(k + rec.name)) continue; seenL.add(k + rec.name);
    labels.push({ en: rec.name, ar: "", k, x: rec.cx * S, z: rec.cy * S, y: (rec.isMosque ? Math.max(rec.h, 14) + 10 : rec.h + 6) + (rec.gy || 0) });
  }
  msg.labels = labels;

  // ---------------------------------------------------------------- street-name signs at junction corners
  const streetSigns = new FBuf(256);
  let poles = 0;
  for (const e of juncs) {
    if (poles >= 240) break;
    if (e.elev > 0.5 || e.topC < 2 || e.topC > 5) continue;
    const jx = e.x * S, jz = e.y * S;
    const near = [];
    for (const nl of nameLines) {
      if (jx < nl.bb[0] - 6 || jx > nl.bb[2] + 6 || jz < nl.bb[1] - 6 || jz > nl.bb[3] + 6) continue;
      let bd = 5, bdir = null;
      for (let i = 0; i < nl.pts.length - 1; i++) { const a = nl.pts[i], b = nl.pts[i + 1]; const d = segDistXY(jx, jz, a[0], a[1], b[0], b[1]); if (d < bd) { bd = d; const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; bdir = [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; } }
      if (bdir && !near.some(x => x.nl.en === nl.en && x.nl.ar === nl.ar)) near.push({ nl, dir: bdir });
    }
    if (!near.length) continue;
    // arms leaving the junction
    const arms = [];
    for (const k of e.nb) { const q = vmap.get(k); if (!q) continue; const dx = q.x - e.x, dy = q.y - e.y, l = Math.hypot(dx, dy) || 1; arms.push([dx / l, dy / l]); }
    if (arms.length < 2) continue;
    const A = near[0];
    let B2 = null; for (let k = 1; k < near.length; k++) { const c = Math.abs(near[k].dir[0] * A.dir[1] - near[k].dir[1] * A.dir[0]); if (c > 0.5) { B2 = near[k]; break; } }
    const along = (d) => { let best = null, bs = -1; for (const a of arms) { const s = Math.abs(a[0] * d[0] + a[1] * d[1]); if (s > bs) { bs = s; best = a; } } return best; };
    const a = along(A.dir);
    let b = B2 ? along(B2.dir) : null;
    if (!b || b === a) { let bs = -1; for (const c of arms) { if (c === a) continue; const s = Math.abs(a[0] * c[1] - a[1] * c[0]); if (s > bs) { bs = s; b = c; } } }
    if (!b) continue;
    let cx = a[0] + b[0], cz = a[1] + b[1]; let cl = Math.hypot(cx, cz);
    if (cl < 0.2) { cx = -a[1]; cz = a[0]; cl = 1; }
    cx /= cl; cz /= cl;
    const half = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))) / 2;
    const d = Math.min(e.maxHalf * 2.6 + 4, (e.maxHalf + 2.4) / Math.max(0.42, Math.sin(half)));
    const px = jx + cx * d, pz = jz + cz * d;
    if (px < 0 || pz < 0 || px > E * S || pz > E * S) continue;
    if (bldAt(px / S, pz / S)) continue;
    const rn = roadGrid.nearest(px, pz, 30); if (rn && rn.d < rn.hw + 1.0) continue;     // would stand in a carriageway
    const idA = textId(A.nl.en, A.nl.ar, A.nl.ref, "street");
    const idB = B2 ? textId(B2.nl.en, B2.nl.ar, B2.nl.ref, "street") : -1;
    streetSigns.p4(px, pz, 0.17 + (TH ? TH.road(px, pz) : 0), Math.atan2(-A.dir[1], A.dir[0])); streetSigns.p3(idA, B2 ? Math.atan2(-B2.dir[1], B2.dir[0]) : 0, idB);
    poles++;
  }
  // air-conditioned bus shelters at the mapped bus stops, on the pavement facing the road
  const shelters = new FBuf(64);
  for (const q of busStops) {
    const x = q[0] * S, z = q[1] * S;
    const r = roadGrid.nearestSeg(x, z, 30); if (!r || r.c < 2 || r.c > 5 || r.elev) continue;
    // the side of the road the stop is on, 2.3 m beyond the kerb
    const sx = x - r.px, sz = z - r.pz, sl = Math.hypot(sx, sz) || 1; const nx = sx / sl, nz = sz / sl;
    const cx = r.px + nx * (r.hw + 2.6), cz = r.pz + nz * (r.hw + 2.6);
    if (bldAt(cx / S, cz / S)) continue;
    shelters.p4(cx, cz, Math.atan2(-nx, -nz), 0.17 + (TH ? TH.road(cx, cz) : 0));
  }
  msg.signs = { texts, street: streetSigns.out(), shop: shopSigns.out(), tower: towerSigns.out(), speed: speedSigns.out(), stock: stockCards.out() };
  transfer.push(msg.signs.street.buffer, msg.signs.shop.buffer, msg.signs.tower.buffer, msg.signs.speed.buffer, msg.signs.stock.buffer);
  msg.shelters = shelters.out(); transfer.push(msg.shelters.buffer);

  // Metro and rail: elevated lines (the Dubai Metro along Sheikh Zayed Road) become a concrete
  // viaduct on single piers, 10 m up; lines at grade get a ballast bed with two rails.
  for (const f of (layers.transportation && layers.transportation.features) || []) {
    if (f.type !== 2) continue; const p = f.props;
    if (p.class !== "transit" && p.class !== "rail") continue;
    if (p.brunnel === "tunnel" || p.subclass === "tram") continue;
    const elevated = p.brunnel === "bridge";
    for (const g of f.geom) {
      let pts = []; for (let i = 0; i < g.length; i += 2) pts.push([g[i], g[i + 1]]);
      pts = densify(pts, 20 / S);
      const F = { pts, bridge: elevated, layer: 0, spec: { c: 9 } };
      F.cum = [0]; for (let i = 1; i < pts.length; i++) F.cum.push(F.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) * S);
      F.len = F.cum[F.cum.length - 1];
      let el = null;
      if (elevated) {
        F.H = 10; F.e0 = 10; F.e1 = 10;        // metro decks stay up: the line is split into many ways at stations
        el = profileOf(F);
      }
      for (const pl of clipLine3(pts, el, E)) {
        const P2 = pl.pts.map(q => [q[0] * S, q[1] * S]);
        const cum = [0]; for (let i = 1; i < P2.length; i++) cum.push(cum[i - 1] + Math.hypot(P2[i][0] - P2[i - 1][0], P2[i][1] - P2[i - 1][1]));
        railway(SW, P2, cum, pl.el, elevated, TH ? P2.map(q => TH.road(q[0], q[1])) : null);
      }
    }
  }
  msg.walks = SW.out(); collect(msg.walks, transfer); chunkIndex(msg.walks, TS, 3, transfer);
  msg.palms = palms.out(); transfer.push(msg.palms.buffer);
  msg.lamps = lamps.out(); transfer.push(msg.lamps.buffer);
  msg.traffic = traffic; for (const t of traffic) { transfer.push(t.p.buffer); if (t.e) transfer.push(t.e.buffer); if (t.h) transfer.push(t.h.buffer); if (t.st) transfer.push(t.st.buffer); }

  // ---------------------------------------------------------------- ground areas + water
  const A = new Mesh({ position: 3, normal: 3, color: 3 });
  const Wt = new Mesh({ position: 3, normal: 3, color: 3 });
  const waterColl = [];
  const parkPolys = [];
  const splat = TH ? new Splat(512, TS) : null, woodMask = TH ? new Splat(128, TS) : null;
  for (const lname of ["landcover", "landuse", "park"]) {
    for (const f of (layers[lname] && layers[lname].features) || []) {
      if (f.type !== 3) continue;
      const cls = lname === "park" ? "park" : (f.props.subclass && AREA_COL[f.props.subclass] !== undefined ? f.props.subclass : f.props.class);
      const hex = (PK && cls in PK_AREA ? PK_AREA[cls] : AREA_COL[cls]); if (!hex) continue;
      let c = lin(hexRgb(hex)); const yy = AREA_Y[cls] || (GREEN.has(cls) ? 0.014 : 0.011);
      for (const poly of polygons(f.geom)) {
        const rings = []; for (const r of poly) { const cr = clipRing(r, E); if (cr) rings.push(cr); }
        if (!rings.length) continue;
        const wild = PK && lname === "park" && !(f.props.class && /^(park|garden|pitch|playground|zoo|golf)/.test(f.props.class));   // national parks and reserves are land, not lawn
        if (splat && PK && (cls === "residential" || cls === "commercial" || cls === "retail") && pkZone(latOf(rings[0][0][1]), lonOf(rings[0][0][0])) === "murree") { splat.fill(rings, S, lin(hexRgb("#47513a")), 70); continue; }
        if (splat) { if (!wild) splat.fill(rings, S, c, PK_ALPHA[cls] || 205); if (cls === "wood" || cls === "forest") woodMask.fill(rings, S, c, 255); } else fillPoly(A, rings, S, yy, c, 0);
        if (GREEN.has(cls) && cls !== "pitch" && cls !== "golf_course") parkPolys.push(rings);
      }
    }
  }
  for (const f of (layers.water && layers.water.features) || []) {
    if (f.type !== 3 || f.props.brunnel === "tunnel") continue;
    const pool = f.props.class === "swimming_pool";
    for (const poly of polygons(f.geom)) {
      const rings = []; for (const r of poly) { const cr = clipRing(r, E); if (cr) rings.push(cr); }
      if (!rings.length) continue;
      let wy = 0;
      if (GG) {
        const ringsM = rings.map(r => r.map(q => [q[0] * S, q[1] * S]));
        wy = 1e9; for (const r of ringsM) { const st = Math.max(1, Math.floor(r.length / 48)); for (let i = 0; i < r.length; i += st) if (!GG.inSunkPad(r[i][0], r[i][1])) wy = Math.min(wy, GG.at(r[i][0], r[i][1])); }
        if (wy === 1e9) for (const r of ringsM) for (const q of r) wy = Math.min(wy, GG.at(q[0], q[1]));
        if (pool) wy = GG.at(ringsM[0][0][0], ringsM[0][0][1]) + 0.6; else GG.addWater(ringsM, wy + 0.35);
        if (!pool) wy += 0.35;
      }
      fillPoly(Wt, rings, S, wy + (pool ? 0.02 : 0.004), pool ? [0.05, 0.45, 0.62] : [0.0, 0.0, 0.0], pool ? 1 : 0);
      if (!pool) { const flat = []; for (const r of rings) { const fr = []; for (const q of r) fr.push(lonOf(q[0]), latOf(q[1])); flat.push(fr); } waterColl.push(flat); }
    }
  }
  msg.areas = A.out(); collect(msg.areas, transfer);
  msg.water = Wt.out(); collect(msg.water, transfer);
  // palms scattered in parks
  let budget = PK ? 2600 : 900; const trees = new FBuf();
  for (const rings of parkPolys) {
    const o = rings[0]; let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (const q of o) { if (q[0] < minx) minx = q[0]; if (q[0] > maxx) maxx = q[0]; if (q[1] < miny) miny = q[1]; if (q[1] > maxy) maxy = q[1]; }
    const areaM = Math.abs(ringArea(o.flat())) * S * S;
    let k = Math.min(160, Math.floor(areaM / 450));
    for (let i = 0; i < k * 3 && k > 0 && budget > 0; i++) {
      const hx = hash2(i * 17 + Math.round(minx), Math.round(miny) + i * 31), hy = hash2(i * 29 + Math.round(maxy), Math.round(maxx) + i * 7);
      const px = minx + (maxx - minx) * hx, py = miny + (maxy - miny) * hy;
      if (!pointInRingXY(px, py, o)) continue;
      let inHole = false; for (let r = 1; r < rings.length; r++) if (pointInRingXY(px, py, rings[r])) { inHole = true; break; }
      if (inHole) continue;
      // [x, z, rotation, kind + scale]: kind 0 = date palm, 1 = broadleaf (ghaf / neem); scale in 0.75..1.25
      const kind = !CN && !PK && hash2(i, 99) < 0.72 ? 0 : 1;      // Shanghai parks: broadleaf only
      trees.p4(px * S, py * S, hash2(i, 5) * 6.283, kind * 10 + 0.75 + 0.5 * hash2(i, 11));
      k--; budget--;
    }
  }
  // a palm or two in villa gardens, between the house and the boundary wall
  for (const rec of recs) {
    if (!rec.garden || budget <= 0) continue;
    for (const g of rec.garden) { trees.p4(g[0], g[1], hash2(Math.round(g[0]), Math.round(g[1])) * 6.283, (g[2] || PK ? 10 : 0) + (PK ? 1.1 + 0.5 * hash2(Math.round(g[1]), 3) : 0.8 + 0.3 * hash2(Math.round(g[1]), 3))); budget--; }
  }
  // desert scrub beside the motorways where there is open ground (no building within 60 m)
  let shrubN = 0;
  for (const pts of CN || PK ? [] : highways) {
    let acc = 0;
    for (let i = 0; i < pts.length - 1 && shrubN < 1400; i++) {
      const ax = pts[i][0], az = pts[i][1], dx = pts[i + 1][0] - ax, dz = pts[i + 1][1] - az, l = Math.hypot(dx, dz) || 1;
      for (let d = 0; d < l; d += 7) {
        acc++;
        const h1 = hash2(Math.round(ax + d * 13), Math.round(az * 7 + acc)), h2 = hash2(acc * 31, Math.round(ax * 3 - d));
        if (h1 > 0.55) continue;
        const side = h2 < 0.5 ? 1 : -1, o = 14 + 90 * hash2(acc, Math.round(d * 5)) ** 1.6;
        const x = ax + dx / l * d - dz / l * o * side, z = az + dz / l * d + dx / l * o * side;
        if (x < 0 || z < 0 || x > E * S || z > E * S) continue;
        if (roadGrid.clear(x, z, 25) < 5 || bldNear(x / S, z / S, 60 / S)) continue;
        trees.p4(x, z, h2 * 6.283, 20 + 0.6 + 0.8 * hash2(acc, 7)); shrubN++;
      }
    }
  }
  // Pakistan: the hills beside the roads are wooded: chir pine high up, scattered broadleaf on the lower slopes
  if (GG && (GG.hmax > 620 || woodMask.any())) {
    const C = 40, nn = Math.ceil(TS / C), near = new Uint8Array(nn * nn), idx = (i, j) => j * nn + i;
    const mark = (x, z) => { const i = Math.floor(x / C), j = Math.floor(z / C); if (i >= 0 && j >= 0 && i < nn && j < nn) near[idx(i, j)] = 1; };
    for (const L of lines) { if (L.spec.c > 5) continue; for (let i = 0; i < L.pts.length - 1; i++) { const a = L.pts[i], b = L.pts[i + 1], n2 = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * S / 30)); for (let k = 0; k <= n2; k++) mark((a[0] + (b[0] - a[0]) * k / n2) * S, (a[1] + (b[1] - a[1]) * k / n2) * S); } }
    for (let rep = 0; rep < 5; rep++) { const q = near.slice(); for (let j = 0; j < nn; j++) for (let i = 0; i < nn; i++) if (q[idx(i, j)]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) { const ii = i + dx, jj = j + dz; if (ii >= 0 && jj >= 0 && ii < nn && jj < nn) near[idx(ii, jj)] = 1; } }
    const pool = []; const step = 12, tot = Math.floor(TS / step);
    for (let j = 0; j < tot; j++) for (let i = 0; i < tot; i++) {
      const hx = hash2(i * 31 + tx, j * 17), hz = hash2(i * 13, j * 41 + ty), x = (i + hx) * step, z = (j + hz) * step;
      if (!near[idx(Math.min(nn - 1, Math.floor(x / C)), Math.min(nn - 1, Math.floor(z / C)))]) continue;
      const e = GG.at(x, z), inWood = woodMask.has(x, z); if (e < 620 && !inWood) continue;
      const ridge = GG.at(x + 12, z), rz = GG.at(x, z + 12), sl = Math.hypot(ridge - e, rz - e) / 12; if (sl > 0.75) continue;
      const pine = e > 980 + 240 * hash2(i, j * 3);
      const p = inWood ? (pine ? 0.9 : 0.72) : pine ? 0.62 : 0.2 * Math.max(0, Math.min(1, (e - 620) / 400));
      if (hash2(i * 7, j * 11) > p) continue;
      if (roadGrid.clear(x, z, 14) < 3.5 || bldAt(x / S, z / S) || bldNear(x / S, z / S, 6 / S)) continue;
      pool.push(x, z, hash2(j, i) * 6.283, (pine ? 30 : 10) + 0.7 + 0.8 * hash2(i, j * 7));
    }
    // an even thinning, so the budget does not run out at the north edge of the tile
    const keep = Math.min(1, 2600 / (pool.length / 4 || 1));
    for (let i = 0, q = 0; i < pool.length; i += 4, q++) if (hash2(q, tx ^ ty) < keep) trees.p4(pool[i], pool[i + 1], pool[i + 2], pool[i + 3]);
  }
  // shade trees on the pavements of side streets (neem and ghaf), as broadleaf trees
  for (let i = 0; i < streetTrees.n; i += 4) {
    if (!PK) { trees.p4(streetTrees.a[i], streetTrees.a[i + 1], streetTrees.a[i + 2], 10 + 0.7 + 0.35 * (streetTrees.a[i + 3] - 0.85) / 0.3); continue; }
    const x = streetTrees.a[i], z = streetTrees.a[i + 1], zone = pkZone(latOf(z / S), lonOf(x / S));
    if (bldAt(x / S, z / S)) continue;
    if ((zone === "pindi" || zone === "lahore") && pkCover(x, z) > 0.28) continue;     // packed bazaars have no room for street trees
    const big = zone === "islamabad" || zone === "society";
    trees.p4(x, z, streetTrees.a[i + 2], 10 + (big ? 1.25 + 0.75 * hash2(Math.round(x), Math.round(z * 3)) : 0.7 + 0.35 * (streetTrees.a[i + 3] - 0.85) / 0.3));
  }
  if (PK) for (let i = 0; i < mallCanopy.n; i += 4) { const x = mallCanopy.a[i], z = mallCanopy.a[i + 1]; if (!bldAt(x / S, z / S) && roadGrid.clear(x, z, 5) > 0.75) trees.p4(x, z, mallCanopy.a[i + 2], 10 + 1.5 + 0.45 * hash2(Math.round(x), Math.round(z * 3))); }   // mature avenue trees: Dawn (dawn.com/news/1990880) calls The Mall lined with trees, a shaded avenue
  if (PK) { for (let i = 0; i < belt.n; i += 4) trees.p4(belt.a[i], belt.a[i + 1], belt.a[i + 2], belt.a[i + 3]); pkBeltRows(parkPolys, S, trees, trails, latOf, lonOf); }
  if (PK) pkFaisalTrees(trees, nameLines, S, TS, latOf, lonOf, xOfLon, yOfLat);
  msg.parkTrees = trees.out(); transfer.push(msg.parkTrees.buffer);

  msg.coll = { b: bColl, w: waterColl, r: roadColl, n: names };
  if (GG) {
    // the ground itself: adaptive mesh, a land-use picture to paint it, heights for the props and the camera
    GG.clearRoads();          // water banks may have raised the ground since bake()
    if (pkFore) for (const q of pkFore) splat.fill(q, S, lin(hexRgb("#9d9a92")), 245);
    for (const q of pkBeltG) splat.fill(q, S, lin(hexRgb("#5f7340")), 235);
    pkGroundPaint(splat, pkCov, pkCN, TS, S, latOf, lonOf);
    splat.soften(2); splat.shoulders(GG);
    pkFaisalPaint(splat, S, TS, xOfLon, yOfLat);
    if (xOfLon(73.0592) > 0 && xOfLon(73.055) < E && yOfLat(33.7195) > 0 && yOfLat(33.7222) < E) splat.fill([PK_JINNAH.map(p => [xOfLon(p[1]), yOfLat(p[0])])], S, lin(hexRgb("#8d8c88")), 245);   // the markaz's plazas and parking are paved
    const trailN = 1024, trailA = new Uint8Array(trailN * trailN), trailK = trailN / TS;
    for (let i = 0; i < trails.length; i += 2) trailStamp(trailA, trailN, trailK, trails[i], trails[i + 1] >= 8 ? 1.9 : 1.2, trails[i + 1] >= 8 ? 220 : 170);
    msg.trail = trailA; msg.trailN = trailN; transfer.push(trailA.buffer);
    const tm = TM.tessellate(GG.h, GG.N, 8, TS, { tolFine: 0.45, tolCoarse: 1.6, flags: GG.flagged, skirt: 8 });
    collect(tm, transfer); chunkIndex(tm, TS, 3, transfer);
    msg.terrain = tm; msg.tgrid = { n: GG.N, c: GG.c, h: GG.h }; msg.splat = splat.a; msg.splatN = splat.n; msg.tileLat = latOf(E / 2);
    transfer.push(GG.h.buffer, splat.a.buffer);
    GG = null;
  }
  return { msg, transfer };
}

// ------------------------------------------------------------------ builders
// Extruded prism: walls + roof (+ soffit when floating). rings in tile units, clipped.
function addPrism(M, rings, S, E, h, minh, type, color, seed, floorH, roofColor) {
  const P = M.attr.position, Nn = M.attr.normal, U = M.attr.uv, C = M.attr.color, F = M.attr.facade, I = M.idx;
  const onEdge = (a, b) => (a[0] === 0 && b[0] === 0) || (a[0] === E && b[0] === E) || (a[1] === 0 && b[1] === 0) || (a[1] === E && b[1] === E);
  for (let ri = 0; ri < rings.length; ri++) {
    const r = rings[ri]; let u = 0;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      const ax = a[0] * S, az = a[1] * S, bx = b[0] * S, bz = b[1] * S;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.05) continue;
      if (onEdge(a, b)) { u += len; continue; }
      let nx = (bz - az) / len, nz = -(bx - ax) / len;
      const v0 = M.vc;
      P.p3(ax, minh, az); P.p3(bx, minh, bz); P.p3(bx, h, bz); P.p3(ax, h, az);
      for (let k = 0; k < 4; k++) { Nn.p3(nx, 0, nz); C.p3(color[0], color[1], color[2]); F.p4(type, seed, floorH, h); }
      U.p2(u, minh); U.p2(u + len, minh); U.p2(u + len, h); U.p2(u, h);
      I.p3(v0, v0 + 2, v0 + 1); I.p3(v0, v0 + 3, v0 + 2);
      M.vc += 4; u += len;
    }
  }
  // roof and soffit
  const flat = [], holes = [];
  for (let ri = 0; ri < rings.length; ri++) { if (ri) holes.push(flat.length / 2); for (const q of rings[ri]) flat.push(q[0] * S, q[1] * S); }
  const tri = earcut(flat, holes.length ? holes : null, 2);
  const roofType = roofColor ? 9.6 : type === 0 ? 9.2 : type === 4 ? 9.4 : 9;
  const rc = roofColor || color;
  for (const [yy, up] of minh > 0.5 ? [[h, 1], [minh, -1]] : [[h, 1]]) {
    const v0 = M.vc;
    for (let i = 0; i < flat.length; i += 2) { P.p3(flat[i], yy, flat[i + 1]); Nn.p3(0, up, 0); U.p2(flat[i], flat[i + 1]); const c = up > 0 ? rc : color; C.p3(c[0], c[1], c[2]); F.p4(up > 0 ? roofType : type, seed, floorH, h); }
    M.vc += flat.length / 2;
    for (let i = 0; i < tri.length; i += 3) {
      const a = tri[i], b = tri[i + 1], c = tri[i + 2];
      const cr = (flat[2 * b] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) - (flat[2 * b + 1] - flat[2 * a + 1]) * (flat[2 * c] - flat[2 * a]);
      // cr > 0 means clockwise seen from above in X/Z-down; for +Y normal we need the opposite
      if ((cr > 0) === (up > 0)) I.p3(v0 + a, v0 + c, v0 + b); else I.p3(v0 + a, v0 + b, v0 + c);
    }
  }
}

// Dome on the roof centroid and a minaret at the footprint corner furthest from the dome.
function addMosqueParts(M, o, S, cx, cy, h, minx, miny, maxx, maxy, seed) {
  const w = (maxx - minx) * S, d = (maxy - miny) * S;
  const r = PK ? Math.min(10, Math.max(3, Math.min(w, d) * 0.28)) : Math.max(3, Math.min(w, d) * 0.28);   // Pakistan (REVIEW2 item 10): a neighbourhood mosque's dome, however big the mapped footprint; the great mosques are hand-built landmarks
  const cX = cx * S, cZ = cy * S;
  const stone = lin(hexRgb("#f2ede3")), domeC = lin(hexRgb(seed < 0.35 ? "#8fb3a8" : seed < 0.6 ? "#d9c28a" : "#f4f0e8"));
  // drum
  cylinder(M, cX, cZ, r * 1.02, h, h + r * 0.35, 20, stone, 6);
  hemi(M, cX, h + r * 0.35, cZ, r, 20, 8, domeC, 1.18);
  // minaret at far corner
  let best = null, bd = -1; for (const q of o) { const dd = Math.hypot(q[0] * S - cX, q[1] * S - cZ); if (dd > bd) { bd = dd; best = q; } }
  if (!best) return;
  const mx = cX + (best[0] * S - cX) * 0.82, mz = cZ + (best[1] * S - cZ) * 0.82;
  const mh = Math.max(22, h * 2.4 + 8);
  cylinder(M, mx, mz, 1.7, 0, mh * 0.78, 8, stone, 6);
  cylinder(M, mx, mz, 2.5, mh * 0.78, mh * 0.8, 8, stone, 6);        // balcony
  cylinder(M, mx, mz, 1.3, mh * 0.8, mh * 0.93, 8, stone, 6);
  hemi(M, mx, mh * 0.93, mz, 1.35, 8, 4, domeC, 1.8);
}
function cylinder(M, x, z, r, y0, y1, seg, col, type) {
  const P = M.attr.position, Nn = M.attr.normal, U = M.attr.uv, C = M.attr.color, F = M.attr.facade, I = M.idx;
  const v0 = M.vc;
  for (let i = 0; i <= seg; i++) {
    const a = i / seg * Math.PI * 2, cx = Math.cos(a), sz = Math.sin(a);
    for (const yy of [y0, y1]) { P.p3(x + cx * r, yy, z + sz * r); Nn.p3(cx, 0, sz); U.p2(a * r, yy); C.p3(col[0], col[1], col[2]); F.p4(type, 0.5, 4, 0); }
  }
  for (let i = 0; i < seg; i++) { const a = v0 + i * 2; I.p3(a, a + 1, a + 3); I.p3(a, a + 3, a + 2); }
  M.vc += (seg + 1) * 2;
  // cap
  const c0 = M.vc; P.p3(x, y1, z); Nn.p3(0, 1, 0); U.p2(0, 0); C.p3(col[0], col[1], col[2]); F.p4(9, 0.5, 4, 1); M.vc++;
  for (let i = 0; i <= seg; i++) { const a = i / seg * Math.PI * 2; P.p3(x + Math.cos(a) * r, y1, z + Math.sin(a) * r); Nn.p3(0, 1, 0); U.p2(0, 0); C.p3(col[0], col[1], col[2]); F.p4(9, 0.5, 4, 1); }
  for (let i = 0; i < seg; i++) I.p3(c0, c0 + 2 + i, c0 + 1 + i);
  M.vc += seg + 1;
}
function hemi(M, x, y, z, r, seg, rings, col, point) {
  const P = M.attr.position, Nn = M.attr.normal, U = M.attr.uv, C = M.attr.color, F = M.attr.facade, I = M.idx;
  const v0 = M.vc;
  for (let j = 0; j <= rings; j++) {
    const t = j / rings; const phi = t * Math.PI / 2;
    const rr = Math.cos(phi) * r; const yy = Math.sin(phi) * r * point;
    for (let i = 0; i <= seg; i++) {
      const a = i / seg * Math.PI * 2;
      const nx = Math.cos(a) * Math.cos(phi), ny = Math.sin(phi) / point, nz = Math.sin(a) * Math.cos(phi); const nl = Math.hypot(nx, ny, nz);
      P.p3(x + Math.cos(a) * rr, y + yy, z + Math.sin(a) * rr); Nn.p3(nx / nl, ny / nl, nz / nl); U.p2(a * r, yy); C.p3(col[0], col[1], col[2]); F.p4(6, 0.5, 4, 0);
    }
  }
  const row = seg + 1;
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) { const a = v0 + j * row + i; I.p3(a, a + row, a + row + 1); I.p3(a, a + row + 1, a + 1); }
  M.vc += row * (rings + 1);
}

// Road ribbon with mitred joins. Returns per-vertex left offsets (unit miter * scale) for reuse.
function ribbon(M, pts, cum, W, ys, lanes, flags, cls, aD, bD, aR, bR) {
  const P = M.attr.position, Nn = M.attr.normal, U = M.attr.uv, Rd = M.attr.road, J = M.attr.junc, I = M.idx;
  const n = pts.length, hw = W / 2, off = [];
  for (let i = 0; i < n; i++) {
    let dx0 = 0, dz0 = 0, dx1 = 0, dz1 = 0;
    if (i > 0) { dx0 = pts[i][0] - pts[i - 1][0]; dz0 = pts[i][1] - pts[i - 1][1]; const l = Math.hypot(dx0, dz0) || 1; dx0 /= l; dz0 /= l; }
    if (i < n - 1) { dx1 = pts[i + 1][0] - pts[i][0]; dz1 = pts[i + 1][1] - pts[i][1]; const l = Math.hypot(dx1, dz1) || 1; dx1 /= l; dz1 /= l; }
    if (i === 0) { dx0 = dx1; dz0 = dz1; } if (i === n - 1) { dx1 = dx0; dz1 = dz0; }
    // left normals
    const l0x = dz0, l0z = -dx0, l1x = dz1, l1z = -dx1;
    let mx = l0x + l1x, mz = l0z + l1z; const ml = Math.hypot(mx, mz);
    if (ml < 1e-4) { mx = l1x; mz = l1z; } else { mx /= ml; mz /= ml; }
    let s = 1 / Math.max(0.5, mx * l1x + mz * l1z);
    off.push([mx * s, mz * s]);
  }
  // Four vertices per segment: the junction distances must run continuously along each
  // segment (from the junction behind to the one ahead). Shared per-point values would read
  // 0 at both ends of a stretch between two junctions and wipe its markings.
  for (let i = 0; i < n - 1; i++) {
    const L = cum[i + 1] - cum[i], fl = typeof flags === "function" ? flags(i) : flags;
    const a0 = aD[i], a1 = aD[i] + L, b1 = bD[i + 1] + 0, b0 = b1 + L, ra = aR[i], rb = bR[i + 1];
    const v0 = M.vc;
    for (const [k, a, b] of [[i, a0, b0], [i + 1, a1, b1]]) {
      const [ox, oz] = off[k];
      const x = pts[k][0], z = pts[k][1], y = ys[k];
      P.p3(x + ox * hw, y, z + oz * hw); P.p3(x - ox * hw, y, z - oz * hw);
      Nn.p3(0, 1, 0); Nn.p3(0, 1, 0);
      U.p2(PK ? W : 0, cum[k]); U.p2(PK ? 0 : W, cum[k]);                // Pakistan keeps left: the shader's across-road coordinate is mirrored, so stop lines, lane arrows and gutters land on the left-hand side
      Rd.p4(W, lanes, fl, cls); Rd.p4(W, lanes, fl, cls);
      J.p4(a, b, ra, rb); J.p4(a, b, ra, rb);
    }
    I.p3(v0, v0 + 1, v0 + 2); I.p3(v0 + 1, v0 + 3, v0 + 2);
    M.vc += 4;
  }
  return off;
}
function junctionDisc(M, x, z, r, y, cls) {
  const P = M.attr.position, Nn = M.attr.normal, U = M.attr.uv, Rd = M.attr.road, J = M.attr.junc, I = M.idx;
  const seg = 18, v0 = M.vc;
  P.p3(x, y + (TH ? TH.road(x, z) : 0), z); Nn.p3(0, 1, 0); U.p2(r, 0); Rd.p4(2 * r, 1, 16, cls); J.p4(0, 0, r, r);
  for (let i = 0; i <= seg; i++) { const a = i / seg * Math.PI * 2, xr = x + Math.cos(a) * r, zr = z + Math.sin(a) * r; P.p3(xr, y + (TH ? TH.road(xr, zr) : 0), zr); Nn.p3(0, 1, 0); U.p2(r, 0); Rd.p4(2 * r, 1, 16, cls); J.p4(0, 0, r, r); }
  for (let i = 0; i < seg; i++) I.p3(v0, v0 + 2 + i, v0 + 1 + i);
  M.vc += seg + 2;
}
// Portions of a line at least `gap` metres clear of junctions: [[t0 segment, t0 frac, t1 seg, t1 frac], ...] as callbacks
function clearSpans(cum, aD, bD, aR, bR, extra, cb) {
  const n = cum.length;
  for (let i = 0; i < n - 1; i++) {
    const L = cum[i + 1] - cum[i]; if (L < 0.01) continue;
    const thA = aR[i] + extra, thB = bR[i] + extra;
    const lo = Math.max(0, (thA - aD[i]) / L), hi = Math.min(1, (bD[i] - thB) / L);
    if (hi - lo > 0.02) cb(i, lo, hi);
  }
}
function sidewalks(M, pts, cum, off, W, aD, bD, aR, bR, oneway, Hc, pk) {
  const P = M.attr.position, Nn = M.attr.normal, U = M.attr.uv, C = M.attr.color, I = M.idx;
  const top = pk ? 0.2 : 0.17, sw = pk ? pk.sw : 2.8, hw = W / 2, kerbV = pk ? pk.kerb : 1;
  const pave = lin(hexRgb(pk ? pk.pave : "#cfc6b6")), curbA = lin(hexRgb(pk ? "#8f8b82" : "#e9e6df"));
  clearSpans(cum, aD, bD, aR, bR, 3.0, (i, lo, hi) => {
    for (const side of [1, -1]) {
      if (pk && pk.only && side !== pk.only) continue;
      const A = lerpOff(pts, off, i, lo), Bp = lerpOff(pts, off, i, hi);
      // points: inner edge (curb line) and outer edge
      const ia = [A.x + A.ox * hw * side, A.z + A.oz * hw * side], oa = [A.x + A.ox * (hw + sw) * side, A.z + A.oz * (hw + sw) * side];
      const ib = [Bp.x + Bp.ox * hw * side, Bp.z + Bp.oz * hw * side], ob = [Bp.x + Bp.ox * (hw + sw) * side, Bp.z + Bp.oz * (hw + sw) * side];
      const va = cum[i] + (cum[i + 1] - cum[i]) * lo, vb = cum[i] + (cum[i + 1] - cum[i]) * hi;
      // top
      const ha = Hc ? Hc[i] + (Hc[i + 1] - Hc[i]) * lo : 0, hb = Hc ? Hc[i] + (Hc[i + 1] - Hc[i]) * hi : 0;
      quad(M, [ia[0], top + ha, ia[1]], [ib[0], top + hb, ib[1]], [ob[0], top + hb, ob[1]], [oa[0], top + ha, oa[1]], [0, 1, 0], pave, [va, 0], [vb, 0], side > 0);
      // curb face (towards the road)
      const nx = -A.ox * side, nz = -A.oz * side; const nl = Math.hypot(nx, nz) || 1;
      quad(M, [ia[0], 0.03 + ha, ia[1]], [ib[0], 0.03 + hb, ib[1]], [ib[0], top + hb, ib[1]], [ia[0], top + ha, ia[1]], [nx / nl, 0, nz / nl], curbA, [va, kerbV], [vb, kerbV], side < 0);
      // Pakistan: the 150 mm kerbstone's top carries the same paint
      if (pk) { const k = 0.15 / sw, ka = [ia[0] + (oa[0] - ia[0]) * k, ia[1] + (oa[1] - ia[1]) * k], kb = [ib[0] + (ob[0] - ib[0]) * k, ib[1] + (ob[1] - ib[1]) * k]; quad(M, [ia[0], top + ha + 0.004, ia[1]], [ib[0], top + hb + 0.004, ib[1]], [kb[0], top + hb + 0.004, kb[1]], [ka[0], top + ha + 0.004, ka[1]], [0, 1, 0], curbA, [va, kerbV], [vb, kerbV], side > 0); }
      if (pk && pk.spans) pk.spans.push([ia[0], ia[1], ib[0], ib[1], oa[0], oa[1], ob[0], ob[1], ha, hb, top, pk.wear]);
    }
  });
}
function lerpOff(pts, off, i, t) {
  const a = pts[i], b = pts[i + 1], oa = off[i], ob = off[i + 1];
  // Offsets: use the segment's own left normal in the middle, mitres at ends
  const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; const lx = dz / l, lz = -dx / l;
  const o = t <= 0.001 ? oa : t >= 0.999 ? ob : [lx, lz];
  return { x: a[0] + dx * t, z: a[1] + dz * t, ox: o[0], oz: o[1] };
}
// Quad with explicit winding choice; normals given. uv0 at a,d; uv1 at b,c
function quad(M, a, b, c, d, n, col, uv0, uv1, flip) {
  const P = M.attr.position, Nn = M.attr.normal, U = M.attr.uv, C = M.attr.color, I = M.idx;
  const v0 = M.vc;
  for (const q of [a, b, c, d]) { P.p3(q[0], q[1], q[2]); Nn.p3(n[0], n[1], n[2]); C.p3(col[0], col[1], col[2]); }
  U.p2(uv0[0], uv0[1]); U.p2(uv1[0], uv1[1]); U.p2(uv1[0], uv1[1]); U.p2(uv0[0], uv0[1]);
  // choose winding so the face normal agrees with n
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const dot = cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2];
  if (dot >= 0) { I.p3(v0, v0 + 1, v0 + 2); I.p3(v0, v0 + 2, v0 + 3); } else { I.p3(v0, v0 + 2, v0 + 1); I.p3(v0, v0 + 3, v0 + 2); }
  M.vc += 4;
}
// Concrete parapets on both edges of bridges and elevated ramps (per-vertex deck height)
function barriers(M, pts, off, W, ys) {
  const col = lin(hexRgb(PK ? "#a09c93" : "#c9c4ba")), hw = W / 2, h = 1.0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ya = ys[i], yb = ys[i + 1];
    for (const side of [1, -1]) {
      const a = [pts[i][0] + off[i][0] * hw * side, pts[i][1] + off[i][1] * hw * side], b = [pts[i + 1][0] + off[i + 1][0] * hw * side, pts[i + 1][1] + off[i + 1][1] * hw * side];
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; const nx = -dz / l * side, nz = dx / l * side;
      quad(M, [a[0], ya, a[1]], [b[0], yb, b[1]], [b[0], yb + h, b[1]], [a[0], ya + h, a[1]], [nx, 0, nz], col, [0, 2], [l, 2], false);
      quad(M, [a[0], ya, a[1]], [b[0], yb, b[1]], [b[0], yb + h, b[1]], [a[0], ya + h, a[1]], [-nx, 0, -nz], col, [0, 2], [l, 2], false);
      quad(M, [a[0], ya + h, a[1]], [b[0], yb + h, b[1]], [b[0] - nx * 0.3, yb + h, b[1] - nz * 0.3], [a[0] - nx * 0.3, ya + h, a[1] - nz * 0.3], [0, 1, 0], col, [0, 2], [l, 2], false);
    }
  }
}
// Deck slab under an elevated carriageway, with pier columns down to the ground
function deckAndPiers(M, pts, cum, off, W, ys, el) {
  if (PK) return pkDeckAndPiers(M, pts, cum, off, W, ys, el);
  const col = lin(hexRgb("#cbc5b9")), dark = lin(hexRgb("#a39d92")), hw = W / 2 + 0.3, th = 1.4;
  for (let i = 0; i < pts.length - 1; i++) {
    if (el[i] < 0.4 && el[i + 1] < 0.4) continue;
    const ya = ys[i], yb = ys[i + 1];
    const L = [pts[i][0] + off[i][0] * hw, pts[i][1] + off[i][1] * hw], Rr = [pts[i][0] - off[i][0] * hw, pts[i][1] - off[i][1] * hw];
    const L2 = [pts[i + 1][0] + off[i + 1][0] * hw, pts[i + 1][1] + off[i + 1][1] * hw], R2 = [pts[i + 1][0] - off[i + 1][0] * hw, pts[i + 1][1] - off[i + 1][1] * hw];
    const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1], l = Math.hypot(dx, dz) || 1; const lx = dz / l, lz = -dx / l;
    // fascias (outer faces) and soffit
    quad(M, [L[0], ya - th, L[1]], [L2[0], yb - th, L2[1]], [L2[0], yb, L2[1]], [L[0], ya, L[1]], [lx, 0, lz], col, [0, 2], [l, 2], false);
    quad(M, [Rr[0], ya - th, Rr[1]], [R2[0], yb - th, R2[1]], [R2[0], yb, R2[1]], [Rr[0], ya, Rr[1]], [-lx, 0, -lz], col, [0, 2], [l, 2], false);
    quad(M, [L[0], ya - th, L[1]], [L2[0], yb - th, L2[1]], [R2[0], yb - th, R2[1]], [Rr[0], ya - th, Rr[1]], [0, -1, 0], dark, [0, 2], [l, 2], false);
  }
  // piers every ~32 m where the deck is high enough to need them
  let next = 16;
  for (let i = 0; i < pts.length - 1; i++) {
    while (next <= cum[i + 1]) {
      const t = (next - cum[i]) / Math.max(1e-6, cum[i + 1] - cum[i]);
      const e = el[i] + (el[i + 1] - el[i]) * t, y = ys[i] + (ys[i + 1] - ys[i]) * t;
      if (e > 3.2) {
        const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, z = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
        const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1], l = Math.hypot(dx, dz) || 1; const fx = dx / l, fz = dz / l, lx = fz, lz = -fx;
        const cols = W > 13 ? [-W / 4, W / 4] : [0];
        for (const o of cols) box(M, x + lx * o, z + lz * o, fx, fz, 0.8, 0.8, GG ? GG.at(x + lx * o, z + lz * o) - 1 : 0, y - th, col);
        if (W > 13) box(M, x, z, fx, fz, 1.0, W / 2 + 0.2, y - th - 1.1, y - th, col);   // cap beam
      }
      next += 32;
    }
  }
}
// Railway: a viaduct deck with parapets and piers (elevated) or a ballast bed (at grade), with two tracks.
function railway(M, pts, cum, el, elevated, G) {
  const n = pts.length; if (n < 2) return;
  const off = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; off.push([dz / l, -dx / l]);
  }
  const deck = lin(hexRgb("#d9d3c7")), side = lin(hexRgb("#c7c0b3")), under = lin(hexRgb("#9d978b")), ballast = lin(hexRgb("#7d756a")), rail = lin(hexRgb("#4a4744")), sleeper = lin(hexRgb("#6a6259"));
  const yAt = i => (elevated && el ? el[i] : 0.02) + (G ? G[i] : 0);
  const strip = (o0, o1, dy, col, n0) => {
    for (let i = 0; i < n - 1; i++) {
      const y0 = yAt(i) + dy, y1 = yAt(i + 1) + dy;
      const A = pts[i], B = pts[i + 1], oa = off[i], ob = off[i + 1];
      quad(M, [A[0] + oa[0] * o0, y0, A[1] + oa[1] * o0], [B[0] + ob[0] * o0, y1, B[1] + ob[1] * o0], [B[0] + ob[0] * o1, y1, B[1] + ob[1] * o1], [A[0] + oa[0] * o1, y0, A[1] + oa[1] * o1], n0 || [0, 1, 0], col, [cum[i], 0], [cum[i + 1], 0], false);
    }
  };
  const wall = (o, dy0, dy1, col, sign) => {
    for (let i = 0; i < n - 1; i++) {
      const A = pts[i], B = pts[i + 1], oa = off[i], ob = off[i + 1];
      const nx = oa[0] * sign, nz = oa[1] * sign;
      quad(M, [A[0] + oa[0] * o, yAt(i) + dy0, A[1] + oa[1] * o], [B[0] + ob[0] * o, yAt(i + 1) + dy0, B[1] + ob[1] * o], [B[0] + ob[0] * o, yAt(i + 1) + dy1, B[1] + ob[1] * o], [A[0] + oa[0] * o, yAt(i) + dy1, A[1] + oa[1] * o], [nx, 0, nz], col, [cum[i], 2], [cum[i + 1], 2], false);
    }
  };
  if (elevated) {
    const hw = 4.2, th = 1.8;
    strip(-hw, hw, 0, deck);                          // deck top
    strip(-hw, hw, -th, under, [0, -1, 0]);           // soffit
    wall(hw, -th, 0, side, 1); wall(-hw, -th, 0, side, -1);            // fascias
    wall(hw, 0, 1.1, side, 1); wall(hw - 0.25, 0, 1.1, side, -1);      // parapets
    wall(-hw, 0, 1.1, side, -1); wall(-hw + 0.25, 0, 1.1, side, 1);
    let next = 14;
    for (let i = 0; i < n - 1; i++) {
      while (next <= cum[i + 1]) {
        const t = (next - cum[i]) / Math.max(1e-6, cum[i + 1] - cum[i]);
        const e = el[i] + (el[i + 1] - el[i]) * t;
        if (e > 3) {
          const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, z = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
          const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1], l = Math.hypot(dx, dz) || 1;
          const g0 = G ? G[i] + (G[i + 1] - G[i]) * t : 0;
          box(M, x, z, dx / l, dz / l, 1.0, 1.0, GG ? GG.at(x, z) - 1 : 0, g0 + e - th - 0.9, side);
          box(M, x, z, dx / l, dz / l, 1.2, 3.2, g0 + e - th - 0.9, g0 + e - th, side);     // pier cap
        }
        next += 30;
      }
    }
  } else {
    strip(-2.4, 2.4, 0, ballast);
  }
  for (const c of [-1.8, 1.8]) { strip(c - 0.85, c + 0.85, elevated ? 0.05 : 0.04, sleeper); for (const r of [-0.72, 0.72]) strip(c + r - 0.05, c + r + 0.05, elevated ? 0.16 : 0.15, rail); }
}
// Oriented box: centre (x,z), forward (fx,fz), half-length hl along forward, half-width hwid across, from y0 to y1
function box(M, x, z, fx, fz, hl, hwid, y0, y1, col) {
  const lx = fz, lz = -fx;
  const c = (a, b) => [x + fx * a + lx * b, z + fz * a + lz * b];
  const p00 = c(-hl, -hwid), p10 = c(hl, -hwid), p11 = c(hl, hwid), p01 = c(-hl, hwid);
  const faces = [[p00, p10, [lx * -1, 0, lz * -1]], [p10, p11, [fx, 0, fz]], [p11, p01, [lx, 0, lz]], [p01, p00, [-fx, 0, -fz]]];
  for (const [a, b, n] of faces) { const l = Math.hypot(b[0] - a[0], b[1] - a[1]); quad(M, [a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], n, col, [0, 2], [l, 2], false); }
}
// Jersey barrier on the left (median) edge of one-way motorway and trunk carriageways
function medianBarrier(M, pts, off, W, ys, side = 1) {
  const col = lin(hexRgb(PK ? "#9c9890" : "#d4d0c8")), hw = (W / 2 + 0.35) * side;
  for (let i = 0; i < pts.length - 1; i++) {
    const ya = ys[i], yb = ys[i + 1];
    const a = [pts[i][0] + off[i][0] * hw, pts[i][1] + off[i][1] * hw], b = [pts[i + 1][0] + off[i + 1][0] * hw, pts[i + 1][1] + off[i + 1][1] * hw];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; const nx = dz / l, nz = -dx / l;  // left
    for (const s of [1, -1]) quad(M, [a[0] + nx * 0.25 * s, ya, a[1] + nz * 0.25 * s], [b[0] + nx * 0.25 * s, yb, b[1] + nz * 0.25 * s], [b[0] + nx * 0.1 * s, yb + 0.85, b[1] + nz * 0.1 * s], [a[0] + nx * 0.1 * s, ya + 0.85, a[1] + nz * 0.1 * s], [nx * s, 0.25, nz * s], col, [0, 2], [l, 2], false);
    quad(M, [a[0] + nx * 0.1, ya + 0.85, a[1] + nz * 0.1], [b[0] + nx * 0.1, yb + 0.85, b[1] + nz * 0.1], [b[0] - nx * 0.1, yb + 0.85, b[1] - nz * 0.1], [a[0] - nx * 0.1, ya + 0.85, a[1] - nz * 0.1], [0, 1, 0], col, [0, 2], [l, 2], false);
  }
}
// Evenly spaced props beside a road, clear of junctions. Writes [x, z, rotation, scale],
// or [x, z, rotation, height] when a per-vertex height array is given (lamps on ramps).
function propsAlong(buf, pts, cum, off, W, aD, bD, aR, bR, spacing, offset, sides, seed, clearance, faceRoad, ys) {
  const n = pts.length; let next = spacing * (0.3 + 0.7 * seed);
  for (let i = 0; i < n - 1; i++) {
    const L = cum[i + 1] - cum[i];
    while (next <= cum[i + 1]) {
      const t = (next - cum[i]) / (L || 1);
      const a = aD[i] + (next - cum[i]), b = bD[i] - (next - cum[i]);
      if (a > aR[i] + clearance && b > bR[i] + clearance) {
        const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1], l = Math.hypot(dx, dz) || 1;
        const lx = dz / l, lz = -dx / l;
        for (const s of sides) {
          const x = pts[i][0] + dx * t + lx * offset * s, z = pts[i][1] + dz * t + lz * offset * s;
          // rotation.y that turns a model's local -Z toward the road
          const sg = Math.sign(offset * s) || 1, tx = -lx * sg, tz = -lz * sg;
          const rot = faceRoad ? Math.atan2(-tx, -tz) : hash2(Math.round(x * 3), Math.round(z * 3)) * 6.283;
          buf.p4(x, z, rot, ys ? ys[i] + (ys[i + 1] - ys[i]) * t : 0.85 + 0.3 * hash2(Math.round(z), Math.round(x)));
        }
      }
      next += spacing;
    }
  }
}
// Flat polygon fill (earcut) at height y with vertex colour
function fillPoly(M, rings, S, y, col, kind) {
  const P = M.attr.position, Nn = M.attr.normal, C = M.attr.color, I = M.idx;
  const flat = [], holes = [];
  for (let ri = 0; ri < rings.length; ri++) { if (ri) holes.push(flat.length / 2); for (const q of rings[ri]) flat.push(q[0] * S, q[1] * S); }
  const tri = earcut(flat, holes.length ? holes : null, 2);
  const v0 = M.vc;
  for (let i = 0; i < flat.length; i += 2) { P.p3(flat[i], y, flat[i + 1]); Nn.p3(0, 1, 0); C.p3(col[0], col[1], col[2]); }
  M.vc += flat.length / 2;
  for (let i = 0; i < tri.length; i += 3) {
    const a = tri[i], b = tri[i + 1], c = tri[i + 2];
    const cr = (flat[2 * b] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) - (flat[2 * b + 1] - flat[2 * a + 1]) * (flat[2 * c] - flat[2 * a]);
    if (cr > 0) I.p3(v0 + a, v0 + c, v0 + b); else I.p3(v0 + a, v0 + b, v0 + c);
  }
}

// ------------------------------------------------------------------ names, signs and street detail
// POI classes that put a sign on a wall (OpenMapTiles poi.class)
const SIGN_CLASSES = new Set(["shop", "grocery", "clothing_store", "restaurant", "fast_food", "cafe", "pharmacy", "bank", "hairdresser", "laundry", "bakery", "butcher", "ice_cream", "car", "alcohol_shop", "beer", "lodging", "hospital", "dentist", "office", "bar", "cinema", "library", "post", "police", "museum", "art_gallery", "music", "theatre", "veterinary", "jewelry", "optician", "mobile_phone", "furniture", "electronics", "books", "doctors", "school", "college", "kindergarten"]);
const NAME_SIGN = new Set(["trunk", "primary", "secondary", "tertiary", "minor"]);
const SPEED_KMH = [120, 100, 80, 60, 60];                   // by road class code when OpenStreetMap has no maxspeed
const LATINRE = /^[\x20-\x7EÀ-ɏ’]+$/, ARRE = /[؀-ۿ]/;
function latinName(p) { for (const k of ["name:en", "name_en", "name:latin", "name_int", "name"]) { const v = p[k]; if (v && LATINRE.test(v)) return String(v).trim(); } return ""; }
const HANRE = /[\u4e00-\u9fff]/;
// Shanghai: the second line of a sign carries the Chinese name instead of the Arabic one.
function arabicName(p) { if (PK) { const v = p["name:ur"] || (p.name && ARRE.test(p.name) ? p.name : ""); return v ? String(v).trim() : ""; } if (CN) { const v = p["name:zh"] || p.name; return v && HANRE.test(v) ? String(v).trim() : ""; } const v = p["name:ar"] || (p.name && ARRE.test(p.name) ? p.name : ""); return v ? String(v).trim() : ""; }
function bboxOf(pts) { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const p of pts) { if (p[0] < a) a = p[0]; if (p[0] > c) c = p[0]; if (p[1] < b) b = p[1]; if (p[1] > d) d = p[1]; } return [a, b, c, d]; }
// which half of a signal cycle an approach belongs to: along the controller's main axis or across it
function groupOf(phi, ref) { const d = Math.abs(((phi - ref) % Math.PI + Math.PI) % Math.PI); return d < Math.PI / 4 || d > 3 * Math.PI / 4 ? 0 : 1; }
function segDistXY(px, pz, ax, az, bx, bz) { const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz; const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0; return Math.hypot(px - ax - dx * t, pz - az - dz * t); }
function ringDist(x, y, r) { let d = 1e9; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; const q = segDistXY(x, y, a[0], a[1], b[0], b[1]); if (q < d) d = q; } return d; }
function linToHex(c) { const f = v => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); return (f(c[0]) << 16) | (f(c[1]) << 8) | f(c[2]); }

// Road centre lines in tile metres on a coarse grid: "is there a road here, how wide".
class SegGrid {
  constructor(cell) { this.cell = cell; this.m = new Map(); }
  add(ax, az, bx, bz, hw, c, elev) {
    const s = [ax, az, bx, bz, hw, c, elev ? 1 : 0], C = this.cell;
    for (let gx = Math.floor((Math.min(ax, bx) - hw) / C); gx <= Math.floor((Math.max(ax, bx) + hw) / C); gx++)
      for (let gz = Math.floor((Math.min(az, bz) - hw) / C); gz <= Math.floor((Math.max(az, bz) + hw) / C); gz++) { const k = gx * 4096 + gz; let a = this.m.get(k); if (!a) this.m.set(k, a = []); a.push(s); }
  }
  nearestSeg(x, z, maxD, minC = 0, maxC = 99) {
    const C = this.cell; let best = null, bd = maxD;
    for (let gx = Math.floor((x - maxD) / C); gx <= Math.floor((x + maxD) / C); gx++) for (let gz = Math.floor((z - maxD) / C); gz <= Math.floor((z + maxD) / C); gz++) {
      for (const s of this.m.get(gx * 4096 + gz) || []) {
        if (s[5] < minC || s[5] > maxC) continue;
        const dx = s[2] - s[0], dz = s[3] - s[1], l2 = dx * dx + dz * dz; const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[1]) * dz) / l2)) : 0;
        const px = s[0] + dx * t, pz = s[1] + dz * t, d = Math.hypot(x - px, z - pz);
        if (d < bd) { bd = d; best = { d, hw: s[4], c: s[5], elev: s[6], px, pz }; }
      }
    }
    return best;
  }
  nearest(x, z, maxD, minC, maxC) { return this.nearestSeg(x, z, maxD, minC, maxC); }
  // clearance: distance from (x, z) to the nearest carriageway edge (negative inside one)
  clear(x, z, maxD) { const C = this.cell; let bd = maxD; for (let gx = Math.floor((x - maxD) / C); gx <= Math.floor((x + maxD) / C); gx++) for (let gz = Math.floor((z - maxD) / C); gz <= Math.floor((z + maxD) / C); gz++) for (const s of this.m.get(gx * 4096 + gz) || []) { if (s[6]) continue; const d = segDistXY(x, z, s[0], s[1], s[2], s[3]) - s[4]; if (d < bd) bd = d; } return bd; }
}

// The wall a sign goes on: near the POI, long enough, and facing a street.
function bestEdge(ring, S, px, py, roadGrid, minLen) {
  let best = null, bs = 1e9;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const ax = a[0] * S, az = a[1] * S, bx = b[0] * S, bz = b[1] * S;
    const len = Math.hypot(bx - ax, bz - az); if (len < Math.max(3.5, minLen)) continue;
    const dx = (bx - ax) / len, dz = (bz - az) / len;
    let nx = dz, nz = -dx;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if (pointInRingXY((mx + nx * 0.6) / S, (mz + nz * 0.6) / S, ring)) { nx = -nx; nz = -nz; }     // make the normal point out of the building
    const r = roadGrid.nearest(mx + nx * 6, mz + nz * 6, 45);
    const faces = r && r.d < r.hw + 30 && !r.elev;
    const d = segDistXY(px * S, py * S, ax, az, bx, bz);
    const score = d + (faces ? 0 : 35) + (r ? r.d * 0.15 : 12) - Math.min(len, 30) * 0.05;
    if (score < bs) { bs = score; const t = Math.max(0, Math.min(1, ((px * S - ax) * dx + (py * S - az) * dz) / len)); best = { i, ax, az, dx, dz, len, nx, nz, mx, mz, t }; }
  }
  return best;
}

// Rooftop plant on flat roofs: a stair and lift house, air-conditioning condensers, water
// tanks (round ones on villas, panel tanks on blocks), an antenna on some towers.
// Out: [x, y, z, rot, sx, sy, sz, kind, rgb]; kind 0 box unit, 1 stair house, 2 round tank, 3 antenna, 4 panel tank
function roofItems(rec, S, out) {
  const { o, h, type, seed } = rec;
  // align everything with the longest wall
  let rot = 0, bl = 0;
  for (let i = 0; i < o.length; i++) { const a = o[i], b = o[(i + 1) % o.length]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l > bl) { bl = l; rot = Math.atan2(-(b[1] - a[1]), b[0] - a[0]); } }
  const want = [];
  if (h >= 7.5 && rec.areaM >= 110 && !rec.heritage) want.push(1);
  const nAC = rec.heritage ? 0 : Math.min(type === 0 ? 3 : 7, Math.max(1, Math.round(rec.areaM / 170)));
  for (let k = 0; k < nAC; k++) want.push(0);
  if (rec.heritage) { if (seed < 0.45 && rec.areaM > 70) want.push(5); }
  else if (type === 3) { want.push(2); if (seed > 0.55) want.push(2); }
  else if (type === 1 && h < 60) { want.push(4); if (rec.areaM > 500) want.push(4); }
  if (h >= 90 && seed < 0.3) want.push(3);
  const SZ = { 0: [1.2, 0.95, 1.0], 1: [3.8, 3.0, 3.2], 2: [1.5, 1.7, 1.5], 3: [0.45, 10 + seed * 16, 0.45], 4: [3.2, 2.2, 2.2], 5: [2.6, 4.6 + seed * 1.5, 2.6] };
  const wallHex = linToHex(rec.color);
  const COL = { 0: 0xd6d9dc, 1: wallHex, 2: seed < 0.5 ? 0xf2efe6 : 0x2f5f9e, 3: 0x9aa0a6, 4: 0xe7e2d4, 5: wallHex };
  let n = 0, salt = 0;
  for (const kind of want) {
    const [sx, sy, sz] = SZ[kind];
    const margin = Math.max(sx, sz) * 0.75 + 0.8;
    for (let tries = 0; tries < 14; tries++) {
      salt++;
      let x, y;
      if (kind === 3) { x = rec.cx; y = rec.cy; }
      else { x = rec.minx + (rec.maxx - rec.minx) * hash2(Math.round(seed * 1e6) + salt * 7, salt * 13); y = rec.miny + (rec.maxy - rec.miny) * hash2(salt * 31, Math.round(seed * 1e6) + salt * 3); }
      if (!pointInRingXY(x, y, o) || ringDist(x, y, o) * S < margin) continue;
      out.p4(x * S, h, y * S, rot + (kind === 0 && hash2(salt, 5) < 0.3 ? Math.PI / 2 : 0)); out.p4(sx, sy, sz, kind); out.p1(COL[kind]);
      n++; break;
    }
  }
  return n;
}

// Old Dubai's heritage quarters (Al Fahidi, Al Shindagha) and the heritage-style Al Seef
// waterfront, as lat/lon boxes from OpenStreetMap: coral-stone courtyard houses of one or two
// storeys with wind towers. Untagged footprints here must not become apartment blocks.
const HERITAGE = [[25.2628, 55.2986, 25.2656, 55.3016], [25.2640, 55.2852, 25.2712, 55.2925], [25.2562, 55.3011, 25.2655, 55.3129]];
const HERITAGE_WALLS = ["#d9c3a0", "#d2b98f", "#e0cdaa", "#cdb58c"];

// Villa compound: the boundary wall round the plot (the house's oriented box grown by a
// garden margin), cut where it would cross a road or a neighbour's house, with a gate on the
// side nearest the street. Most UAE villas sit behind exactly this kind of wall.
const VILLA_WALLS = ["#e7dcc6", "#dccfb4", "#efe7d8", "#d2c2a2", "#e9e1d2", "#c9b99a"];
function villaWall(rec, S, roadGrid, bldAt, SW, recs) {
  const pts = rec.o.map(q => [q[0] * S, q[1] * S]);
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]; const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz); if (l < 1.5) continue;
    const ux = dx / l, uz = dz / l, vx = -uz, vz = ux;
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (const p of pts) { const u = p[0] * ux + p[1] * uz, v = p[0] * vx + p[1] * vz; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
    const area = (u1 - u0) * (v1 - v0); if (!best || area < best.area) best = { ux, uz, vx, vz, u0, u1, v0, v1, area };
  }
  if (!best) return;
  const g = 2.4 + rec.seed * 2.6;
  const { ux, uz, vx, vz } = best;
  const P = (u, v) => [u * ux + v * vx, u * uz + v * vz];
  const c = [P(best.u0 - g, best.v0 - g), P(best.u1 + g, best.v0 - g), P(best.u1 + g, best.v1 + g), P(best.u0 - g, best.v1 + g)];
  const col = lin(hexRgb(VILLA_WALLS[Math.floor(rec.seed * 61) % VILLA_WALLS.length])), gateC = lin(hexRgb(rec.seed < 0.5 ? "#3b3631" : "#5a4a3a"));
  // the gate goes on the side whose middle is closest to a street
  let gateSide = -1, gd = 38;
  for (let s = 0; s < 4; s++) { const a = c[s], b = c[(s + 1) % 4]; const r = roadGrid.nearest((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 40); if (r && r.d - r.hw < gd) { gd = r.d - r.hw; gateSide = s; } }
  const H = 2.3, T = 0.12;
  let pieces = 0;
  for (let s = 0; s < 4; s++) {
    const a = c[s], b = c[(s + 1) % 4]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1) continue;
    const dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
    const step = 1.2, n = Math.max(2, Math.ceil(L / step));
    const ok = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      let good = roadGrid.clear(x, z, 18) > 1.3;
      if (good) { const other = bldAt(x / S, z / S); if (other && other !== rec) good = false; }
      if (good && s === gateSide && Math.abs(t * L - L / 2) < 2.1) good = false;
      ok.push(good);
    }
    // runs of good samples become wall pieces
    let k0 = -1;
    for (let k = 0; k <= n + 1; k++) {
      const good = k <= n && ok[k];
      if (good && k0 < 0) k0 = k;
      if (!good && k0 >= 0) {
        const t0 = k0 / n, t1 = (k - 1) / n;
        if ((t1 - t0) * L > 0.8) {
          const mx = a[0] + (b[0] - a[0]) * (t0 + t1) / 2, mz = a[1] + (b[1] - a[1]) * (t0 + t1) / 2;
          wallBox(SW, mx, mz, dx, dz, (t1 - t0) * L / 2, T, 0, H, col); pieces++;
        }
        k0 = -1;
      }
    }
    if (s === gateSide) {
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      if (roadGrid.clear(mx, mz, 18) > 1.3) { wallBox(SW, mx, mz, dx, dz, 2.0, 0.05, 0.05, 2.0, gateC); pieces++; }
    }
  }
  if (!pieces) return;
  // one or two palms in the garden, at the far corners from the gate
  rec.garden = [];
  for (const [u, v] of [[best.u0 - g * 0.5, best.v0 - g * 0.5], [best.u1 + g * 0.5, best.v1 + g * 0.5]]) {
    const [x, z] = P(u, v);
    if (roadGrid.clear(x, z, 20) < 2.5 || bldAt(x / S, z / S)) continue;
    rec.garden.push([x, z, rec.seed > 0.7 ? 1 : 0]);
    if (rec.seed < 0.4) break;
  }
}
function wallBox(M, x, z, fx, fz, hl, hw, y0, y1, col) {
  box(M, x, z, fx, fz, hl, hw, y0, y1, col);
  const lx = fz, lz = -fx;
  const c = (a, b) => [x + fx * a + lx * b, y1, z + fz * a + lz * b];
  quad(M, c(-hl, -hw), c(hl, -hw), c(hl, hw), c(-hl, hw), [0, 1, 0], col, [0, 2], [hl * 2, 2], false);
}

// Lane count, carriageway width and speed limit for one road line from the OpenStreetMap
// roads database (three samples along the line, majority vote).
function osmRoad(F, rdb, lonOf, latOf) {
  const n = F.pts.length; if (n < 2) return null;
  const votes = new Map(); let speed = 0;
  for (const f of [0.2, 0.5, 0.8]) {
    const i = Math.min(n - 2, Math.floor((n - 1) * f));
    const a = F.pts[i], b = F.pts[i + 1];
    const brg = (Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180 / Math.PI + 360) % 360;
    const r = rdb.match(latOf((a[1] + b[1]) / 2), lonOf((a[0] + b[0]) / 2), brg, 14); if (!r) continue;
    const agree = r.dir !== -1;
    let lanes;
    if (F.oneway) lanes = r.oneway ? r.lanes : (agree ? r.lanesFwd : r.lanesBwd) || (r.lanes ? Math.max(1, Math.floor(r.lanes / 2)) : 0);
    else lanes = r.lanes || ((r.lanesFwd || 0) + (r.lanesBwd || 0));
    const ms = (F.oneway && !r.oneway ? (agree ? r.maxFwd : r.maxBwd) : 0) || r.maxspeed || 0;
    if (ms && !speed) speed = ms;
    if (lanes > 0) votes.set(lanes, (votes.get(lanes) || 0) + 1);
  }
  let lanes = 0, bv = 0; for (const [k, v] of votes) if (v > bv) { bv = v; lanes = k; }
  const out = { m: speed > 0 && speed <= 160 ? speed : 0 };
  if (lanes) {
    const c = F.spec.c;
    if (F.oneway) { lanes = Math.max(1, Math.min(8, lanes)); out.W = F.ramp ? lanes * 3.6 + 1.2 : lanes * 3.5 + (c <= 1 ? 3.0 : c <= 3 ? 1.0 : 0.6); }
    else { lanes = Math.max(2, Math.min(10, lanes)); out.W = lanes * 3.3 + 1.0; }
    out.lanes = lanes;
  }
  return out;
}
// Which POIs get a floating label: the places people give and follow directions by.
function labelKind(p) {
  const c = p.class, sc = p.subclass || "";
  if (c === "railway" && /subway|station|halt|tram_stop/.test(sc)) return "metro";
  if (c === "shop" && /mall|department_store/.test(sc)) return "mall";
  if (c === "lodging" && /hotel|resort/.test(sc || "hotel")) return "hotel";
  if (c === "attraction" || c === "museum" || c === "theme_park" || c === "zoo" || c === "stadium" || c === "monument" || c === "aquarium") return "sight";
  if (c === "hospital" && sc === "hospital") return "health";
  if (c === "college" || c === "university") return "edu";
  if (c === "park" || c === "garden" && p.name) return "park";
  if (c === "ferry_terminal") return "ferry";
  return null;
}
// Split a mesh's triangles into an n x n grid of chunks (same vertex buffer, one index list
// and bounding box per chunk). The sun's shadow map only covers a few hundred metres around
// the car and the camera sees less than half the tile, so culling per chunk instead of per
// 2.2 km tile keeps both passes from pushing every vertex of every tile.
function chunkIndex(o, TS, n, transfer) {
  const P = o.position, I = o.index, cs = TS / n, nc = n * n;
  if (!I || I.length < 3 * 600) return;
  const tri = new Uint8Array(I.length / 3), count = new Uint32Array(nc);
  for (let t = 0, k = 0; t < I.length; t += 3, k++) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const gx = Math.min(n - 1, Math.max(0, Math.floor((P[a] + P[b] + P[c]) / 3 / cs)));
    const gz = Math.min(n - 1, Math.max(0, Math.floor((P[a + 2] + P[b + 2] + P[c + 2]) / 3 / cs)));
    tri[k] = gz * n + gx; count[tri[k]]++;
  }
  const lists = [], fill = new Uint32Array(nc), box = [];
  for (let q = 0; q < nc; q++) { lists.push(count[q] ? new Uint32Array(count[q] * 3) : null); box.push([1e9, 1e9, 1e9, -1e9, -1e9, -1e9]); }
  for (let t = 0, k = 0; t < I.length; t += 3, k++) {
    const q = tri[k], L = lists[q], bb = box[q];
    for (let j = 0; j < 3; j++) {
      const v = I[t + j]; L[fill[q]++] = v; const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
      if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (z < bb[2]) bb[2] = z; if (x > bb[3]) bb[3] = x; if (y > bb[4]) bb[4] = y; if (z > bb[5]) bb[5] = z;
    }
  }
  o.chunks = [];
  for (let q = 0; q < nc; q++) if (lists[q]) { o.chunks.push({ i: lists[q], b: box[q] }); transfer.push(lists[q].buffer); }
}

// Pakistan's near-only layers: an n x n grid of chunks that each own compact vertex buffers. A chunk out of range never reaches the GPU,
// and none is big enough to stall a frame when it does (one shared 20 MB buffer per layer froze the game for 300 ms as a tile came into view).
function chunkSplit(o, TS, n, transfer) {
  const P = o.position, I = o.index, T = I ? I.length / 3 : 0, cs = TS / n, nc = n * n;
  if (!T) return { count: 0 };
  const names = Object.keys(o).filter(k => k !== "index" && k !== "count"), dims = names.map(k => o[k].length / o.count);
  const chunkOf = new Uint16Array(T), triN = new Uint32Array(nc);
  for (let t = 0; t < T; t++) {
    const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3;
    const gx = Math.min(n - 1, Math.max(0, Math.floor((P[a] + P[b] + P[c]) / 3 / cs))), gz = Math.min(n - 1, Math.max(0, Math.floor((P[a + 2] + P[b + 2] + P[c + 2]) / 3 / cs)));
    triN[chunkOf[t] = gz * n + gx]++;
  }
  const start = new Uint32Array(nc + 1); for (let q = 0; q < nc; q++) start[q + 1] = start[q] + triN[q];
  const order = new Uint32Array(T), fill = start.slice(0, nc); for (let t = 0; t < T; t++) order[fill[chunkOf[t]]++] = t;
  const parts = [], mark = new Int32Array(o.count).fill(-1), map = new Uint32Array(o.count), list = new Uint32Array(o.count);
  for (let q = 0; q < nc; q++) {
    if (!triN[q]) continue;
    let nv = 0; const idx = new Uint32Array(triN[q] * 3), b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
    for (let k = start[q], w = 0; k < start[q + 1]; k++) for (let j = 0, t = order[k]; j < 3; j++) {
      const v = I[3 * t + j];
      if (mark[v] !== q) { mark[v] = q; map[v] = nv; list[nv++] = v; }
      idx[w++] = map[v];
      const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
      if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (z < b[2]) b[2] = z; if (x > b[3]) b[3] = x; if (y > b[4]) b[4] = y; if (z > b[5]) b[5] = z;
    }
    const part = { index: idx, count: nv, b };
    transfer.push(idx.buffer);
    names.forEach((name, a) => { const d = dims[a], src = o[name], dst = new Float32Array(nv * d); for (let i = 0; i < nv; i++) for (let c = 0, s = list[i] * d; c < d; c++) dst[i * d + c] = src[s + c]; part[name] = dst; transfer.push(dst.buffer); });
    parts.push(part);
  }
  return { count: o.count, parts };
}

// ------------------------------------------------------------------ terrain helpers (Pakistan)
// Land use painted onto the ground instead of draped polygons: RGBA8, rows north to south.
const PK_AREA = { recreation_ground: "#5c6b3e", village_green: "#5c6b3e", golf_course: "#566f3a", pitch: "#5a6e3a", zoo: "#55693a", residential: "#928c7f", commercial: "#8f8a80", retail: "#8f8a80", industrial: "#8c8678", school: "#958f80", university: "#958f80", college: "#958f80", hospital: "#969184", military: "#928b78", cemetery: "#8c826c", farmland: "#7c7e4a", farm: "#7c7e4a", grass: "#6c7845", park: "#596f3c", garden: "#596f3c", wood: "#34472f", forest: "#32452d", scrub: "#6f6d49", meadow: "#77784b", orchard: "#566b3b", nature_reserve: null };
// how strongly each land use covers the natural ground: open land stays mottled, built areas read solid
// Overture footprints: colours from build/pk/research/art_direction.md (estimated), height zones
const FP_NEAR_AREA = 130;                                 // m2: smaller buildings are drawn only near the camera
const PK_WALLS = {
  islamabad: ["#ddd6c6", "#c8b797", "#e6d9bf", "#d6cbb8", "#cfc6b0"],
  pindi: ["#a79b88", "#8f8b83", "#b9ae9a", "#8a5a44", "#c3b8a4", "#9a8f7d"],
  lahore: ["#b3a68f", "#a3937b", "#8a5a44", "#bdb09a", "#c7bba6", "#96846c"],
  murree: ["#d9d3c6", "#bfb8a8", "#8a5a44", "#c9c2b2", "#a9a290"],
  rural: ["#a98f70", "#b69c7c", "#8a5a44", "#c0ac8e", "#9a8468"],
  shed: ["#9aa0a0", "#a8a59a", "#8f8b83", "#b5b1a6"],
};
PK_WALLS.blue = ["#c9c3b4", "#b4b0a6", "#d6d1c4", "#a9a69c", "#9b9486"];
PK_WALLS.society = ["#e6d9bf", "#ece3cf", "#dccdb0", "#e3dccb", "#f0e9da"];
const PK_GLASS = ["#5c7f8e", "#6a8a96", "#4f6f7e", "#7d97a1"];
// Green and red oxide most of all, some galvanised: art_direction.md section 5 (estimated)
const PK_TIN = ["#3f6b4a", "#8c3b2d", "#9aa0a0", "#3f6b4a", "#7a3a2d", "#46724f", "#8c3b2d", "#55654f"];
// footpaths and tracks: a soft line into a one-channel mask (w = half width in texels, about 2.2 m each)
function trailStamp(a, n, k, pts, w, alpha) {
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0] * k, az = pts[i][1] * k, bx = pts[i + 1][0] * k, bz = pts[i + 1][1] * k, L = Math.hypot(bx - ax, bz - az), steps = Math.max(1, Math.ceil(L * 2));
    for (let s = 0; s <= steps; s++) {
      const px = ax + (bx - ax) * s / steps, pz = az + (bz - az) * s / steps, x0 = Math.floor(px - w), z0 = Math.floor(pz - w), span = Math.ceil(w * 2) + 1;
      for (let z = z0; z <= z0 + span; z++) for (let x = x0; x <= x0 + span; x++) {
        if (x < 0 || z < 0 || x >= n || z >= n) continue;
        const d = Math.hypot(x + 0.5 - px, z + 0.5 - pz); if (d >= w + 0.5) continue;
        const cov = 1 - Math.max(0, d - (w - 0.5)), o = z * n + x, v = alpha * cov;
        if (v > a[o]) a[o] = v;
      }
    }
  }
}
function pkZone(lat, lon) {
  if (lat > 33.86 && lat < 33.96 && lon > 73.34 && lon < 73.45) return "murree";
  if (lat > 33.7 && lon > 73.2 && lat < 34.1 && lon < 73.7) return "murree";
  // Bahria Town phases and DHA (build/pk/research/housing_societies.json), as rough boxes
  if ((lat > 33.48 && lat < 33.55 && lon > 73.06 && lon < 73.185) || (lat >= 33.55 && lat < 33.575 && lon > 73.105 && lon < 73.145) || (lat > 33.68 && lat < 33.7 && lon > 73.2 && lon < 73.235)) return "society";
  // Blue Area: the strip along Jinnah Avenue (islamabad_sectors.json: Centaurus to Usmania)
  if (lon > 73.048 && lon < 73.0935 && Math.abs(lat - (33.71322 + (lon - 73.06043) * 0.4416)) * 111000 < 270) return "blue";
  if (pkInJinnahSuper(lat, lon)) return "blue";                                     // the F-7 markaz: paved plazas and parking, not a sector of houses (see pkJinnahSuper)
  if (lat > 33.54 && lat < 33.665 && lon > 72.97 && lon < 73.14) return "pindi";
  if (lat > 33.66 && lat < 33.8 && lon > 72.93 && lon < 73.22) return "islamabad";
  if (lat > 31.38 && lat < 31.68 && lon > 74.12 && lon < 74.52) return "lahore";
  return "rural";
}
// storeys for a footprint with no height of its own (art_direction.md section 5; estimates)
function pkStoreys(zone, areaM, dens, s, s2) {
  const dense = dens > 0.3, tiny = areaM < 45;
  if (zone === "murree") return tiny ? 1 + (s < 0.5 ? 1 : 0) : dens > 0.2 ? (s < 0.2 ? 2 : s < 0.72 ? 3 : s < 0.93 ? 4 : 5) : 1 + (s < 0.6 ? 1 : 0);
  if (zone === "society") return tiny ? 1 : areaM > 450 ? 3 : 2;
  if (zone === "blue") return tiny ? 2 : areaM > 300 ? 8 + Math.floor(s * 8) : 3 + Math.floor(s * 2);
  if (zone === "pindi") return dense ? (areaM > 600 ? 5 + Math.floor(s * 4) : tiny ? 2 + (s < 0.5 ? 1 : 0) : 3 + Math.floor(s * 2.4) + (s2 < 0.2 ? 1 : 0)) : tiny ? 2 : 2 + (s < 0.4 ? 1 : 0);
  if (zone === "islamabad") return tiny ? 1 : areaM > 600 ? 3 + Math.floor(s * 2) : dense ? 2 + (s < 0.5 ? 1 : 0) : 2;
  if (zone === "lahore") return tiny ? 2 : dense ? (areaM > 500 ? 4 + Math.floor(s * 4) : 3 + Math.floor(s * 2.5)) : 2 + (s < 0.45 ? 1 : 0);
  return tiny ? 1 : 1 + (s < 0.5 ? 1 : 0);
}

// ------------------------------------------------------------------ M-2 and other Pakistani motorways
const PK_SHOULDER = 2.6;   // paved hard shoulder on the left of each carriageway, estimated
// The M-2 is six lanes throughout (Wikipedia, and the P3A project profile: p3a.gov.pk/completed_LIM.php); OpenStreetMap tags 3 each way on
// 316 of its 351 ways, so the corridor is set to 3 and the rest keep their own tag. Lane width 3.65 m, estimated.
function pkMotorwayLanes(feats, latOf, lonOf) {
  for (const F of feats) {
    if (F.spec.c !== 0 || F.ramp || !F.oneway) continue;
    const q = F.pts[F.pts.length >> 1], lanes = M2 && M2.m2At(latOf(q[1]), lonOf(q[0])) ? 3 : (F.osm && F.osm.lanes) || 3;
    F.osm = Object.assign(F.osm || { m: 0 }, { lanes, W: lanes * 3.65 + 0.7 });
  }
}
// Is a lamp at tile position (px, py) near an interchange or service area? Off the M-2, where there is no list, a ramp nearby marks the interchange.
function pkMotorwayLit(px, py, ramp, lines, S, latOf, lonOf) {
  const la = latOf(py), lo = lonOf(px);
  if (M2 && M2.m2At(la, lo)) return M2.m2Lit(la, lo, ramp ? 900 : 500);
  if (ramp) return true;
  const r2 = (500 / S) ** 2;
  for (const L of lines) { if (L.spec.c !== 0 || !L.ramp) continue; for (let i = 0; i < L.pts.length; i += 2) { const dx = L.pts[i][0] - px, dy = L.pts[i][1] - py; if (dx * dx + dy * dy < r2) return true; } }
  return false;
}
// Paved strips either side of a carriageway: the hard shoulder on the left, a narrow margin on the median side
function pkShoulders(M, pts, off, W, ys, cum) {
  const col = lin(hexRgb("#55524e")), hw = W / 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const ya = ys[i] - 0.012, yb = ys[i + 1] - 0.012;
    for (const [o0, o1] of [[hw - 0.05, hw + PK_SHOULDER], [-hw + 0.05, -hw - 1.0]]) {
      const a0 = [pts[i][0] + off[i][0] * o0, pts[i][1] + off[i][1] * o0], a1 = [pts[i][0] + off[i][0] * o1, pts[i][1] + off[i][1] * o1];
      const b0 = [pts[i + 1][0] + off[i + 1][0] * o0, pts[i + 1][1] + off[i + 1][1] * o0], b1 = [pts[i + 1][0] + off[i + 1][0] * o1, pts[i + 1][1] + off[i + 1][1] * o1];
      quad(M, [a0[0], ya, a0[1]], [b0[0], yb, b0[1]], [b1[0], yb, b1[1]], [a1[0], ya, a1[1]], [0, 1, 0], col, [cum[i], 2], [cum[i + 1], 2], false);
    }
  }
}
// Fence, roadside plantation, planted median and the green boards.
// Protective fencing along the motorways: dawn.com/news/1884220, app.com.pk (4,027 km reported). Planting along the M-2 right of way: morem2.com/?p=156.
// Eucalyptus as the planted species and the median planting are art_direction.md section 7 estimates.
function pkMotorwayDress(SW, VW, lines, S, TS, roadGrid, bldNear, belt, roof, beltG, latOf, lonOf, xOfLon, yOfLat) {
  if (!GG || !TH) return;
  const wire = lin(hexRgb("#8d9294")), postC = lin(hexRgb("#6d7173")), boardC = lin(hexRgb("#0e6b3f")), steel = lin(hexRgb("#7b8083"));
  const STEP = 6, FENCE = 16.5, inTile = q => q.x >= 0 && q.z >= 0 && q.x <= TS && q.z <= TS;
  let nBoards = 0;
  for (const L of lines) {
    if (L.spec.c !== 0 || L.ramp || L.bridge || L.tunnel || !L.oneway || L.el.some(e => Math.abs(e) > 0.4)) continue;
    const W = roadDims(L)[0], pts = L.pts.map(q => [q[0] * S, q[1] * S]), N = pts.length, cum = [0];
    for (let i = 1; i < N; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[N - 1]; if (total < 12) continue;
    const at = (s, side, o) => { const v = Math.max(0, Math.min(total, s)); let i = 0; while (i < N - 2 && cum[i + 1] < v) i++; const seg = Math.max(1e-6, cum[i + 1] - cum[i]), t = (v - cum[i]) / seg; let dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; const nx = dz * side, nz = -dx * side; return { x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t + nx * o, z: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t + nz * o, ux: dx, uz: dz, nx, nz, rx: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, rz: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t }; };
    const edge = W / 2 + PK_SHOULDER, mid = L.pts[N >> 1], midLa = latOf(mid[1]), isM2 = M2 && M2.m2At(midLa, lonOf(mid[0]));
    // right-of-way fence on the outer (left) side: a chain-link panel on steel posts, broken at ramps and buildings
    let prev = null, pu = 0;
    for (let k = 0, nS = Math.floor(total / STEP); k <= nS; k++) {
      const q = at(k * STEP, 1, edge + FENCE), ok = inTile(q) && roadGrid.clear(q.x, q.z, 6) > 1.4 && !bldNear(q.x / S, q.z / S, 2 / S);
      if (!ok) { prev = null; continue; }
      const y = GG.at(q.x, q.z) - 0.04;
      if (prev) {
        const u = pu + STEP;
        quad(VW, [prev.x, prev.y, prev.z], [q.x, y, q.z], [q.x, y + 1.85, q.z], [prev.x, prev.y + 1.85, prev.z], [q.ux * 0 + q.nx, 0, q.nz], wire, [pu, 4], [u, 4], false);
        quad(VW, [q.x, y, q.z], [prev.x, prev.y, prev.z], [prev.x, prev.y + 1.85, prev.z], [q.x, y + 1.85, q.z], [-q.nx, 0, -q.nz], wire, [u, 4], [pu, 4], false);
        pu = u;
      }
      if (k % 2 === 0) box(VW, q.x, q.z, q.ux, q.uz, 0.04, 0.04, y - 0.3, y + 2.05, postC);
      prev = { x: q.x, y, z: q.z };
    }
    if (isM2) {
      // eucalyptus in runs along the right of way, thinner on the Potohar, none on the Salt Range (build/pk/research/m2_corridor.json sections)
      const salt = midLa > 32.64 && midLa < 32.695, keep = salt ? 0 : midLa >= 32.6 ? 0.34 : 0.72;
      if (keep) for (let s = 4 + hash2(Math.round(pts[0][0]), 5) * 7, k = 0; s < total - 2; s += 9, k++) {
        const c = at(s, 1, edge + 9); if (hash2(Math.floor(c.x / 170), Math.floor(c.z / 170)) > keep) continue;
        for (const [o, salt2] of [[edge + 7 + hash2(k, 3) * 1.6, 1], [edge + 12.5 + hash2(k, 11) * 1.6, 2]]) {
          const q = at(s + salt2 * 2.2, 1, o), h = hash2(k * 7 + salt2, Math.round(q.x));
          if (!inTile(q) || h > 0.86 || roadGrid.clear(q.x, q.z, 12) < 5 || bldNear(q.x / S, q.z / S, 7 / S)) continue;
          belt.p4(q.x, q.z, h * 6.283, 15.7 + 1.3 * hash2(k, 19));   // the 5 in the scale asks props.js for eucalyptus rather than the zone's mix
        }
      }
    }
    // planted median, where the other carriageway is close by on the right
    for (let s = 3 + hash2(Math.round(pts[0][1]), 9) * 4, k = 0; s < total - 2; s += 6.5, k++) {
      const p = at(s, -1, W / 2 + 16), other = roadGrid.nearestSeg(p.x, p.z, 13, 0, 0); if (!other) continue;
      const q = at(s, -1, W / 2 + 2.3), h = hash2(k * 3, Math.round(pts[0][0]));
      if (inTile(q) && h < 0.74 && roadGrid.clear(q.x, q.z, 4) > 0.8) belt.p4(q.x, q.z, h * 6.283, 20.7 + 0.8 * hash2(k, 23));
      if (k % 6 === 0 && beltG.length < 1400) { const A = at(s - 20, -1, W / 2 + 1), B = at(s + 20, -1, W / 2 + 1), C = at(s + 20, -1, W / 2 + 3.6), D = at(s - 20, -1, W / 2 + 3.6); beltG.push([[[A.x / S, A.z / S], [B.x / S, B.z / S], [C.x / S, C.z / S], [D.x / S, D.z / S]]]); }
    }
    if (!isM2 || !M2) continue;
    // green boards on the driver's left, bilingual: names are the research file's own. Advance boards at 2 km and 500 m, one at the exit, a distance board after each interchange.
    const nodes = M2.M2_NODES, nI = M2.M2_INTERCHANGES, placed = [];
    const board = (s, kind, a, b, val) => {
      if (nBoards >= 24 || placed.some(p => Math.abs(p - s) < 110)) return;
      const bw = 7.4, bh = 3.1, q = at(s, 1, edge + 1.2 + bw / 2); if (!inTile(q)) return;
      placed.push(s); nBoards++;
      const y0 = TH.road(q.rx, q.rz) + 2.2, yG = GG.at(q.x, q.z) - 0.5, lx = q.uz, lz = -q.ux;
      for (const o of [-bw * 0.32, bw * 0.32]) box(SW, q.x + lx * o, q.z + lz * o, q.ux, q.uz, 0.07, 0.07, yG, y0 + bh - 0.2, steel);
      box(SW, q.x, q.z, q.ux, q.uz, 0.05, bw / 2, y0, y0 + bh, boardC);
      roof.p4(q.x - q.ux * 0.08, y0 + bh / 2, q.z - q.uz * 0.08, Math.atan2(-q.ux, -q.uz)); roof.p4(bw, bh, kind * 1e6 + a * 1e3 + b, 9); roof.p1(val);
    };
    for (let ni = 0; ni < nodes.length; ni++) {
      const n = nodes[ni], cross = ni < nI; if (Math.abs(n[2] - midLa) > 0.07) continue;
      const nx = xOfLon(n[3]) * S, nz = yOfLat(n[2]) * S, D = i => Math.hypot(pts[i][0] - nx, pts[i][1] - nz);
      let d0 = D(0);
      for (let i = 0; i < N - 1; i++) {
        const d1 = D(i + 1), sAt = dist => cum[i] + (cum[i + 1] - cum[i]) * (d0 - dist) / Math.max(1e-6, d0 - d1);
        if (cross) {
          for (const [dist, kind] of [[2000, 0], [500, 0], [110, 1]]) if (d0 > dist && d1 <= dist) board(sAt(dist), kind, ni, 0, dist);
          if (d0 < 1400 && d1 >= 1400) {                        // leaving the interchange: the next one and the end of the motorway
            const s = sAt(1400), u = at(s, 1, 0), f = ni + 1 < nI ? nodes[ni + 1] : null, g = ni > 0 ? nodes[ni - 1] : null, dot = m => (xOfLon(m[3]) * S - nx) * u.ux + (yOfLat(m[2]) * S - nz) * u.uz;
            const fwd = f && (!g || dot(f) > dot(g)), next = fwd ? ni + 1 : ni - 1, end = fwd ? nI - 1 : 0;
            if (next >= 0 && next < nI) { const km1 = Math.round(Math.abs(nodes[next][4] - n[4]) - 1.4), km2 = Math.round(Math.abs(nodes[end][4] - n[4]) - 1.4); if (km1 >= 2) board(s, 2, next, end, km1 * 1000 + km2); }
          }
        } else if (d0 > 1000 && d1 <= 1000) {
          const s = sAt(1000), u = at(s, 1, 0);
          if ((nx - u.x) * u.nx + (nz - u.z) * u.nz > 0) board(s, 0, ni, 0, 1000);     // a service area is entered from its own carriageway's left
        }
        d0 = d1;
      }
    }
  }
}
// Flyovers: exposed concrete (art_direction.md #8F8B83, estimated) with rain stains, pier caps and plinths
function pkFadeQuad(M, a, b, c, d, n, top, bottom) {
  quad(M, a, b, c, d, n, top, [0, 2], [1, 2], false);
  const C = M.attr.color.a, e = M.attr.color.n - 12;              // the quad's first two corners are its lower edge
  C[e] = C[e + 3] = bottom[0]; C[e + 1] = C[e + 4] = bottom[1]; C[e + 2] = C[e + 5] = bottom[2];
}
function pkDeckAndPiers(M, pts, cum, off, W, ys, el) {
  const col = lin(hexRgb("#8f8b83")), pierC = lin(hexRgb("#8d9091")), soffit = lin(hexRgb("#a8b3bf")), stain = lin(hexRgb("#54514b")), damp = lin(hexRgb("#858b92")), hw = W / 2 + 0.3, th = 1.4;   // the soffit only sees light bounced off warm ground, so it is painted cooler to read as the same grey
  const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  for (let i = 0; i < pts.length - 1; i++) {
    if (el[i] < 0.4 && el[i + 1] < 0.4) continue;
    const ya = ys[i], yb = ys[i + 1], h0 = hash2(Math.floor(cum[i] / 48), Math.round(pts[0][0]));         // one tone per deck section, so the concrete does not stripe
    const L = [pts[i][0] + off[i][0] * hw, pts[i][1] + off[i][1] * hw], Rr = [pts[i][0] - off[i][0] * hw, pts[i][1] - off[i][1] * hw];
    const L2 = [pts[i + 1][0] + off[i + 1][0] * hw, pts[i + 1][1] + off[i + 1][1] * hw], R2 = [pts[i + 1][0] - off[i + 1][0] * hw, pts[i + 1][1] - off[i + 1][1] * hw];
    const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1], l = Math.hypot(dx, dz) || 1; const lx = dz / l, lz = -dx / l;
    const fas = shade(col, 0.96 + 0.08 * h0);
    quad(M, [L[0], ya - th, L[1]], [L2[0], yb - th, L2[1]], [L2[0], yb, L2[1]], [L[0], ya, L[1]], [lx, 0, lz], fas, [0, 2], [l, 2], false);
    quad(M, [Rr[0], ya - th, Rr[1]], [R2[0], yb - th, R2[1]], [R2[0], yb, R2[1]], [Rr[0], ya, Rr[1]], [-lx, 0, -lz], fas, [0, 2], [l, 2], false);
    quad(M, [L[0], ya - th, L[1]], [L2[0], yb - th, L2[1]], [R2[0], yb - th, R2[1]], [Rr[0], ya - th, Rr[1]], [0, -1, 0], shade(soffit, 0.96 + 0.08 * h0), [0, 2], [l, 2], false);
    // rain stains down both fascias, and a damp line where each deck section meets the next
    for (const [sd, p, q] of [[1, L, L2], [-1, Rr, R2]]) for (let k = 0; k < 3; k++) {
      const h = hash2(k * 17 + Math.round(pts[i][0]), sd * 5 + Math.round(pts[i][1]));
      if (h > 0.8) continue;
      const t0 = hash2(k + 3, Math.round(pts[i][1] * 3)) * 0.92, t1 = Math.min(1, t0 + (0.3 + 0.8 * h) / l), nn = [lx * sd, 0, lz * sd], o = 0.02 * sd;
      const A = [p[0] + (q[0] - p[0]) * t0 + lx * o, ya + (yb - ya) * t0, p[1] + (q[1] - p[1]) * t0 + lz * o], B = [p[0] + (q[0] - p[0]) * t1 + lx * o, ya + (yb - ya) * t1, p[1] + (q[1] - p[1]) * t1 + lz * o];
      pkFadeQuad(M, [A[0], A[1] - th - 0.02, A[2]], [B[0], B[1] - th - 0.02, B[2]], [B[0], B[1] - 0.14, B[2]], [A[0], A[1] - 0.14, A[2]], nn, stain, fas);
    }
    if (Math.floor(cum[i] / 48) !== Math.floor(cum[i + 1] / 48)) pkFadeQuad(M, [L[0], ya - th - 0.012, L[1]], [Rr[0], ya - th - 0.012, Rr[1]], [Rr[0] + dx / l * 0.5, ya - th - 0.012, Rr[1] + dz / l * 0.5], [L[0] + dx / l * 0.5, ya - th - 0.012, L[1] + dz / l * 0.5], [0, -1, 0], soffit, damp);
  }
  let next = 16;
  for (let i = 0; i < pts.length - 1; i++) {
    while (next <= cum[i + 1]) {
      const t = (next - cum[i]) / Math.max(1e-6, cum[i + 1] - cum[i]);
      const e = el[i] + (el[i + 1] - el[i]) * t, y = ys[i] + (ys[i + 1] - ys[i]) * t;
      if (e > 3.2) {
        const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, z = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
        const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1], l = Math.hypot(dx, dz) || 1; const fx = dx / l, fz = dz / l, lx = fz, lz = -fx;
        const cols = W > 13 ? [-W / 4, W / 4] : [0], capT = y - th, capB = capT - 1.1, capW = W > 13 ? W / 2 + 0.2 : Math.max(2.2, W * 0.36);
        for (const o of cols) {
          const px = x + lx * o, pz = z + lz * o, g = GG ? GG.at(px, pz) : 0, h0 = hash2(Math.round(px * 3), Math.round(pz * 3));
          box(M, px, pz, fx, fz, 0.72, 0.72, g - 1, capB, pierC);
          box(M, px, pz, fx, fz, 0.98, 0.98, g - 1, g + 0.45, shade(pierC, 0.82));   // plinth
          for (const face of [1, -1]) for (let k = 0; k < 2; k++) {                // stains running down the two faces seen from the road
            const u = (k ? -0.42 : 0.3) + 0.2 * hash2(k + face, Math.round(px)), w = 0.1 + 0.18 * hash2(k * 5, Math.round(pz)), f = face * 0.73;
            const ax = px + fx * f + lx * u, az = pz + fz * f + lz * u, bx = ax + lx * w, bz = az + lz * w, low = capB - (e * (0.35 + 0.5 * h0));
            pkFadeQuad(M, [ax, Math.max(g + 0.45, low), az], [bx, Math.max(g + 0.45, low), bz], [bx, capB, bz], [ax, capB, az], [fx * face, 0, fz * face], stain, pierC);
          }
        }
        box(M, x, z, fx, fz, 1.05, capW, capB, capT, pierC);                                     // cap beam
        box(M, x, z, fx, fz, 1.15, capW + 0.12, capB - 0.08, capB + 0.05, shade(pierC, 0.8));
      }
      next += 32;
    }
  }
}

// ------------------------------------------------------------------ Pakistan dressing (estimated rules, see build/pk/research/art_direction.md)
function pkRoadTag(zone, c) { return zone === "islamabad" || zone === "blue" || zone === "society" ? 0.1 : zone === "pindi" || zone === "lahore" ? 0.2 : zone === "murree" ? 0.3 : c <= 1 ? 0.4 : 0; }
// pavement width and colour, and the kerb paint: uv.y 1.2 yellow and black, 1.0 black and white, 0.8 bare worn concrete
function pkSide(zone, c, seed) {
  const T = { islamabad: [2.4, "#a29c8f"], blue: [3.4, "#9d9a92"], society: [2.2, "#aaa498"], pindi: [1.8, "#807b71"], lahore: [1.8, "#807b71"], murree: [1.1, "#6d695f"] }[zone] || [1.4, "#7a7467"];
  let kerb = 0.8;
  if ((zone === "islamabad" || zone === "blue") && c <= 3) kerb = 1.2;
  else if ((zone === "pindi" || zone === "lahore") && c <= 3 && seed < 0.45) kerb = 1.0;
  return { sw: T[0], pave: T[1], kerb };
}
// Applied to every footprint once the map's and the machine-learned ones are together. Untagged houses take the district's look
// and Murree's blocks are broken into houses stepping with the slope.
function pkDress(recs, S, E, latOf, lonOf) {
  const C = 40 / S, cov = new Map(), key = (i, j) => i * 4096 + j;
  for (const r of recs) { if (r.minh > 2) continue; const k = key(Math.floor(r.cx / C), Math.floor(r.cy / C)); cov.set(k, (cov.get(k) || 0) + r.areaM); }
  const out = [];
  for (const r of recs) {
    const zone = r.zone || pkZone(latOf(r.cy), lonOf(r.cx)); r.zone = zone;
    if (r.dens === undefined) { const gx = Math.floor(r.cx / C), gy = Math.floor(r.cy / C); let a = 0; for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) a += cov.get(key(gx + i, gy + j)) || 0; r.dens = a / (120 * 120); }
    const free = !r.isMosque && !r.canopy && r.minh < 1;
    if (!r.fp && !r.hadCol && r.type !== 0 && r.type !== 7 && free) { const pal = PK_WALLS[zone] || PK_WALLS.rural; r.color = lin(hexRgb(r.type === 4 ? PK_WALLS.shed[Math.floor(r.seed * 97) % PK_WALLS.shed.length] : pal[Math.floor(r.seed * 89) % pal.length])); }
    if (!r.fp && r.guessH && free && r.type === 3 || (!r.fp && r.dense && r.guessH && free)) {
      if ((zone === "pindi" || zone === "lahore") && r.dens > 0.3 && r.areaM < 1800) { r.packed = true; r.dense = 1; r.type = 1; r.floorH = 3.1; r.h = pkStoreys(zone, r.areaM, r.dens, r.seed, hash2(Math.round(r.cx * 3), Math.round(r.cy * 5))) * 3.1 + 1; }
      else if (zone === "islamabad" || zone === "society") { r.type = 3; r.floorH = 3.3; r.h = Math.max(r.h, 7.5); r.dense = 0; }
    }
    if (zone === "blue" && r.guessH && free && r.areaM > 300) { const fl = 8 + Math.floor(r.seed * 8); r.h = fl * 3.6 + 1; r.floorH = 3.6; r.type = r.seed < 0.45 ? 0 : 2; r.color = lin(hexRgb(r.type === 0 ? PK_GLASS[Math.floor(r.seed * 97) % PK_GLASS.length] : PK_WALLS.blue[Math.floor(r.seed * 89) % PK_WALLS.blue.length])); r.dense = 1; }
    if (free && r.type === 3 && (zone === "islamabad" || zone === "society") && r.h < 11 && r.dens < 0.42 && r.areaM >= 60 && r.areaM < 1100) r.villa = 1;
    if (zone === "murree" && free && r.h < 26 && r.type !== 0) { for (const q of pkMurree(r, S, E)) out.push(q); continue; }
    out.push(r);
  }
  recs.length = 0; for (const r of out) recs.push(r);
}
// Separate cottages on a 24 m grid inside an estate outline, aligned to its long side; footprints and spacing estimated
function pkMurreeEstate(r, S, E) {
  const b = obbOf(r.o, S); if (!b) return [];
  let sign = 0; for (let i = 0; i < r.o.length; i++) { const p = r.o[i], q = r.o[(i + 1) % r.o.length]; sign += p[0] * q[1] - q[0] * p[1]; }
  const out = [], C = 24, nu = Math.ceil(b.eu / C), nv = Math.ceil(b.ev / C);
  for (let i = -nu; i <= nu; i++) for (let j = -nv; j <= nv; j++) {
    const h1 = hash2(i * 17 + Math.round(r.cx * 3), j * 23 + Math.round(r.cy * 3)), h2 = hash2(i * 31 + 5, j * 13 + Math.round(r.cx * 7)), h3 = hash2(j * 37 + 2, i * 19 + Math.round(r.cy * 5));
    if (h3 < 0.2) continue;                                                            // a lawn or a gap
    const cu = i * C + (h1 - 0.5) * 7, cv = j * C + (h2 - 0.5) * 7, hu = 5.5 + 2.5 * h1, hv = 3.8 + 1.5 * h2, P = (u, v) => [(b.cx + (cu + u) * b.ux + (cv + v) * b.vx) / S, (b.cz + (cu + u) * b.uz + (cv + v) * b.vz) / S];
    let ring = [P(-hu, -hv), P(hu, -hv), P(hu, hv), P(-hu, hv)];
    if (!ring.every(q => pointInRingXY(q[0], q[1], r.o))) continue;
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9; for (const q of ring) { if (q[0] < minx) minx = q[0]; if (q[0] > maxx) maxx = q[0]; if (q[1] < miny) miny = q[1]; if (q[1] > maxy) maxy = q[1]; }
    if (minx <= 0 || miny <= 0 || maxx >= E || maxy >= E) continue;
    let s2 = 0; for (let k = 0; k < 4; k++) { const p = ring[k], q = ring[(k + 1) % 4]; s2 += p[0] * q[1] - q[0] * p[1]; }
    if (s2 * sign < 0) ring = ring.reverse();
    const c = P(0, 0), fl = h3 > 0.62 ? 2 : 1;
    out.push(Object.assign({}, r, { rings: [ring], o: ring, cx: c[0], cy: c[1], minx, miny, maxx, maxy, areaM: 4 * hu * hv, seed: (r.seed + h1 * 0.37) % 1, h: fl * 3.0 + 2.2, roofShape: h2 < 0.6 ? "hipped" : "gabled", roofH: 0, roofCol: lin(hexRgb(PK_TIN[Math.floor(h1 * 89) % PK_TIN.length])), used: null, part: 1, name: "" }));
  }
  return out;
}
// One Murree house per section of the footprint's long axis: its own storeys and its own ground height, pitched tin on top.
// A section that would poke out of an L-shaped footprint is dropped; footprints cut by the tile edge keep their shape.
function pkMurree(r, S, E) {
  const sh = hash2(Math.round(r.cx * 11), Math.round(r.cy * 7));
  r.type = 3; r.floorH = 3.0; r.retail = 0; r.dense = 0;
  r.roofShape = sh < 0.55 ? "hipped" : "gabled"; r.roofH = 0;
  if (!r.roofCol) r.roofCol = lin(hexRgb(PK_TIN[Math.floor(sh * 89) % PK_TIN.length]));
  const floors = Math.max(1, Math.min(5, Math.round((r.h - 0.9) / 3.1)));
  r.h = floors * 3.0 + 2.2;
  // REVIEW2 item 4: a footprint this big is an estate outline, not one house. The mass beside 33.9064, 73.3903 is OSM way 490007096, "The Legacy - British Era Cottages", 12 rooms, tagged building=yes around about 6,700 m2.
  if (r.areaM > 1500) return pkMurreeEstate(r, S, E);
  const touches = r.minx <= 0 || r.miny <= 0 || r.maxx >= E || r.maxy >= E;
  if (touches || r.rings.length > 1 || r.areaM < 90) return [r];
  const b = obbOf(r.o, S); if (!b) return [r];
  const L = 2 * b.eu, n = Math.max(1, Math.min(10, Math.round(L / (7 + 5 * r.seed)))), rows = Math.max(1, Math.min(4, Math.round(2 * b.ev / (10 + 4 * r.seed))));
  if (n === 1 && rows === 1) return [r];
  let sign = 0; for (let i = 0; i < r.o.length; i++) { const p = r.o[i], q = r.o[(i + 1) % r.o.length]; sign += p[0] * q[1] - q[0] * p[1]; }
  const out = [], sl = L / n, rh = 2 * b.ev / rows;
  for (let rw = 0; rw < rows; rw++) for (let k = 0; k < n; k++) {
    const h1 = hash2(k * 17 + rw * 41 + Math.round(r.cx), Math.round(r.cy) + k * 5 + rw), h2 = hash2(k * 29 + Math.round(r.cy * 2), rw * 13 + k * 3 + Math.round(r.cx * 3));
    if (rows > 1 && h2 < 0.14) continue;                                       // a yard or a gap between houses
    const offU = rows > 1 ? (h1 - 0.5) * sl * 0.5 : 0, u0 = -b.eu + k * sl + 0.18 + offU, u1 = -b.eu + (k + 1) * sl - 0.18 + offU, vm = -b.ev + (rw + 0.5) * rh, dv = vm + (h1 - 0.5) * rh * 0.3, hv = rh / 2 * (0.74 + 0.26 * h2);
    const P = (u, v) => [(b.cx + u * b.ux + v * b.vx) / S, (b.cz + u * b.uz + v * b.vz) / S];
    const cu = (u0 + u1) / 2, c = P(cu, dv); if (!pointInRingXY(c[0], c[1], r.o)) continue;
    let ring = [P(u0, dv - hv), P(u1, dv - hv), P(u1, dv + hv), P(u0, dv + hv)];
    let s2 = 0; for (let i = 0; i < 4; i++) { const p = ring[i], q = ring[(i + 1) % 4]; s2 += p[0] * q[1] - q[0] * p[1]; }
    if (s2 * sign < 0) ring = ring.reverse();
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9; for (const q of ring) { if (q[0] < minx) minx = q[0]; if (q[0] > maxx) maxx = q[0]; if (q[1] < miny) miny = q[1]; if (q[1] > maxy) maxy = q[1]; }
    if (minx <= 0 || miny <= 0 || maxx >= E || maxy >= E) continue;
    const fl = Math.max(1, Math.min(5, floors + (h2 < 0.3 ? -1 : h2 > 0.8 ? 1 : 0)));
    const tin = h1 < 0.72 ? r.roofCol : lin(hexRgb(PK_TIN[Math.floor(h2 * 89) % PK_TIN.length]));
    out.push(Object.assign({}, r, { rings: [ring], o: ring, cx: c[0], cy: c[1], minx, miny, maxx, maxy, areaM: (u1 - u0) * 2 * hv, seed: (r.seed + h1 * 0.37) % 1, h: fl * 3.0 + 2.2, roofShape: h2 < 0.6 ? "hipped" : "gabled", roofCol: tin, used: null, part: 1 }));
  }
  return out.length ? out : [r];
}
// Invented, generic shop names only: a common first name or plain word and a trade (never a real brand)
const PK_NAMES = [["Ali", "علی"], ["Hamza", "حمزہ"], ["Usman", "عثمان"], ["Bilal", "بلال"], ["Asif", "آصف"], ["Javed", "جاوید"], ["Saleem", "سلیم"], ["Tariq", "طارق"], ["Arif", "عارف"], ["Waqas", "وقاص"], ["Naveed", "نوید"], ["Shahzad", "شہزاد"], ["Rashid", "راشد"], ["Kamran", "کامران"], ["Faisal", "فیصل"], ["New", "نیو"], ["City", "سٹی"], ["Royal", "رائل"], ["Star", "سٹار"], ["Friends", "فرینڈز"], ["Modern", "ماڈرن"], ["Sunny", "سنی"], ["Pindi", "پنڈی"], ["Fine", "فائن"], ["Imran", "عمران"], ["Zubair", "زبیر"], ["Yasir", "یاسر"], ["Adnan", "عدنان"], ["Nadeem", "ندیم"], ["Shakeel", "شکیل"], ["Zahid", "زاہد"], ["Akram", "اکرم"], ["Anwar", "انور"], ["Iqbal", "اقبال"], ["Yousaf", "یوسف"], ["Haroon", "ہارون"], ["Sajid", "ساجد"], ["Majid", "ماجد"], ["Khalid", "خالد"], ["Mughal", "مغل"], ["Kashmir", "کشمیر"], ["Madina", "مدینہ"], ["Noor", "نور"], ["Hafiz", "حافظ"]];   // Urdu spellings written from knowledge of these names and not checked by a reader
const PK_TRADES = [["Mobile Centre", "موبائل سنٹر"], ["Cloth House", "کلاتھ ہاؤس"], ["Tailors", "ٹیلرز"], ["Medical Store", "میڈیکل سٹور"], ["Jewellers", "جیولرز"], ["Shoe Store", "شو سٹور"], ["General Store", "جنرل سٹور"], ["Karyana Store", "کریانہ سٹور"], ["Electronics", "الیکٹرانکس"], ["Photo Studio", "فوٹو سٹوڈیو"], ["Hardware Store", "ہارڈ ویئر سٹور"], ["Book Depot", "بک ڈپو"], ["Opticals", "آپٹیکلز"], ["Bakers", "بیکرز"], ["Sweets", "سویٹس"], ["Tikka House", "تکہ ہاؤس"], ["Biryani Centre", "بریانی سنٹر"], ["Hair Salon", "ہیئر سیلون"], ["Travels", "ٹریولز"], ["Property Advisers", "پراپرٹی ایڈوائزر"], ["Computer Centre", "کمپیوٹر سنٹر"], ["Coaching Centre", "کوچنگ سنٹر"], ["Auto Parts", "آٹو پارٹس"], ["Paint House", "پینٹ ہاؤس"], ["Carpet House", "کارپٹ ہاؤس"], ["Crockery House", "کراکری ہاؤس"], ["Dry Cleaners", "ڈرائی کلینرز"], ["Juice Corner", "جوس کارنر"], ["Fruit Shop", "فروٹ شاپ"], ["Bag House", "بیگ ہاؤس"], ["Watch House", "واچ ہاؤس"], ["Ladies Wear", "لیڈیز ویئر"], ["Kids Wear", "کڈز ویئر"], ["Rent a Car", "رینٹ اے کار"]];
// [Urdu only, bilingual] shares of signs (art_direction.md section 6): whatever is left is English only
const PK_LANG = { pindi: [0.55, 0.9], lahore: [0.55, 0.9], islamabad: [0.15, 0.5], blue: [0.1, 0.45], society: [0.12, 0.5], rural: [0.6, 0.9], murree: [0.3, 0.75] };
// [ground-floor sign, awning, upper-floor panel] chances; upper panels stop at the third floor
const PK_SIGNAGE = { pindi: [0.86, 0.5, 0.6], lahore: [0.86, 0.5, 0.55], islamabad: [0.65, 0.2, 0.22], blue: [0.3, 0.05, 0.1], society: [0.55, 0.15, 0.12], rural: [0.7, 0.35, 0.2], murree: [0.85, 0, 0.3] };
const PK_AWNING = ["#2f6f8f", "#a33a2c", "#3f7a4a", "#c9962f", "#6a6f76", "#b9b2a2", "#7c3b5a"];
// Shop zones of Rawalpindi: the old city around Raja Bazaar, Saddar and Commercial Market (boxes around the points in build/pk/research/rawalpindi.json)
const PK_SHOP = [[73.045, 33.605, 73.066, 33.622], [73.043, 33.589, 73.063, 33.603], [73.066, 33.6335, 73.076, 33.6415]];
function pkInShop(lat, lon) { return PK_SHOP.some(b => lon > b[0] && lon < b[2] && lat > b[1] && lat < b[3]); }
// Wear levels of art_direction.md section 1 (estimated): the share of kerb length that is chipped, dusty or unpainted
const PK_WEAR = { islamabad: 0.2, blue: 0.2, society: 0.2, pindi: 0.6, lahore: 0.6, murree: 0.35, rural: 0.5 };
const PK_GOODS = ["#b3261e", "#1f5aa6", "#d9a21b", "#2e7d4f", "#8e3b76", "#c66a2a", "#e7e2d6", "#3a3f47"].map(h => lin(hexRgb(h)));
const PK_PRODUCE = ["#d67a1f", "#d6b21f", "#a82a2a", "#8a9a3a", "#c6462a"].map(h => lin(hexRgb(h)));
const PK_CAR = [["#e8e8e4", 45], ["#b9bcbf", 22], ["#1b1c1e", 8], ["#6f7276", 10], ["#7a2b28", 5], ["#2c4a78", 5], ["#355c43", 5]];
const PK_CAR_C = PK_CAR.map(c => lin(hexRgb(c[0])));
const pkCol = h => lin(hexRgb(h));
function pkCarColour(h) { let q = h * 100; for (let i = 0; i < PK_CAR.length; i++) { q -= PK_CAR[i][1]; if (q <= 0) return PK_CAR_C[i]; } return PK_CAR_C[0]; }

// A box in a local frame: u along (ux, uz), n out along (nx, nz), from the origin. Back face included, underside only when asked
function pkBox(M, ox, oz, ux, uz, nx, nz, u0, u1, n0, n1, y0, y1, col, under, paint, noBack) {
  const V = paint || 2, LU = V === 2 ? 1 : Math.abs(u1 - u0), LN = V === 2 ? 1 : Math.abs(n1 - n0), p = (u, n, y) => [ox + ux * u + nx * n, y, oz + uz * u + nz * n], q = (a, b, c, d, N, L = LU) => quad(M, a, b, c, d, N, col, [0, V], [L, V], false);
  q(p(u0, n1, y0), p(u1, n1, y0), p(u1, n1, y1), p(u0, n1, y1), [nx, 0, nz]);
  q(p(u0, n0, y1), p(u1, n0, y1), p(u1, n1, y1), p(u0, n1, y1), [0, 1, 0]);
  q(p(u0, n1, y0), p(u0, n0, y0), p(u0, n0, y1), p(u0, n1, y1), [-ux, 0, -uz], LN);
  q(p(u1, n0, y0), p(u1, n1, y0), p(u1, n1, y1), p(u1, n0, y1), [ux, 0, uz], LN);
  if (!noBack) q(p(u1, n0, y0), p(u0, n0, y0), p(u0, n0, y1), p(u1, n0, y1), [-nx, 0, -nz]);
  if (under) q(p(u0, n0, y0), p(u1, n0, y0), p(u1, n1, y0), p(u0, n1, y0), [0, -1, 0]);
}
function pkFlat(M, ox, oz, ux, uz, nx, nz, u0, u1, n, y0, y1, col) {
  const p = (u, y) => [ox + ux * u + nx * n, y, oz + uz * u + nz * n];
  quad(M, p(u0, y0), p(u1, y0), p(u1, y1), p(u0, y1), [nx, 0, nz], col, [0, 2], [1, 2], false);
}
// A wheel: a flat octagon in the plane of (fx, fz) and up, faced both ways
function pkDisc(M, x, z, fx, fz, y, r, col) {
  const P = M.attr.position, Nn = M.attr.normal, U = M.attr.uv, C = M.attr.color, I = M.idx, v0 = M.vc, SEG = 8, nx = fz, nz = -fx;
  const v = (a, b, c) => { P.p3(a, b, c); Nn.p3(nx, 0.2, nz); U.p2(0, 2); C.p3(col[0], col[1], col[2]); };
  v(x, y, z);
  for (let i = 0; i < SEG; i++) { const a = i / SEG * 6.2832, ca = Math.cos(a) * r, sa = Math.sin(a) * r; v(x + fx * ca, y + sa, z + fz * ca); }
  for (let i = 0; i < SEG; i++) { const a = v0 + 1 + i, b = v0 + 1 + (i + 1) % SEG; I.p3(v0, a, b); I.p3(v0, b, a); }
  M.vc += SEG + 1;
}
// A thin upright stick as two crossed strips faced both ways (a reinforcing bar)
function pkStick(M, x, y0, y1, z, hw, col) {
  const P = M.attr.position, Nn = M.attr.normal, U = M.attr.uv, C = M.attr.color, I = M.idx;
  for (const [ax, az] of [[hw, 0], [0, hw]]) {
    const v0 = M.vc;
    P.p3(x - ax, y0, z - az); P.p3(x + ax, y0, z + az); P.p3(x + ax, y1, z + az); P.p3(x - ax, y1, z - az);
    for (let k = 0; k < 4; k++) { Nn.p3(0.5, 0.7, 0.5); U.p2(0, 2); C.p3(col[0], col[1], col[2]); }
    I.p3(v0, v0 + 1, v0 + 2); I.p3(v0, v0 + 2, v0 + 3); I.p3(v0, v0 + 2, v0 + 1); I.p3(v0, v0 + 3, v0 + 2);
    M.vc += 4;
  }
}
// An open shutter: dark interior, shelves of stock, and goods spilling onto the pavement in front
function pkShopFront(M, ox, oz, ux, uz, nx, nz, w, gy, yP, clearN, h) {
  const B = (u0, u1, n0, n1, y0, y1, c) => pkBox(M, ox, oz, ux, uz, nx, nz, u0, u1, n0, n1, y0, y1, c, false, undefined, true);     // goods stand against the shop front: no back faces
  if (clearN < 0.55) return;
  const G = Math.floor(h * 5), c0 = PK_GOODS[Math.floor(h * 73) % PK_GOODS.length], c1 = PK_GOODS[Math.floor(h * 137) % PK_GOODS.length], crate = pkCol("#8a6a43"), sack = pkCol("#c9b38a"), n0 = 0.2;
  if (G === 0) { B(-0.55, -0.05, n0, n0 + 0.5, yP, yP + 0.42, crate); B(-0.5, -0.1, n0 + 0.02, n0 + 0.48, yP + 0.42, yP + 0.75, c0); B(0.15, 0.65, n0, n0 + 0.5, yP, yP + 0.42, c1); }
  else if (G === 1) { for (let k = -2; k <= 2; k++) B(k * 0.3 - 0.1, k * 0.3 + 0.1, n0, n0 + 0.2, yP, yP + 1.45 + 0.3 * hash2(k + 9, Math.round(ox)), PK_GOODS[(Math.floor(h * 41) + k + 8) % PK_GOODS.length]); }
  else if (G === 2) { for (let k = -1; k <= 1; k++) B(k * 0.62 - 0.27, k * 0.62 + 0.27, n0, n0 + 0.55, yP, yP + 0.52, sack); }
  else if (G === 3) { B(-0.75, 0.75, n0, n0 + 0.7, yP + 0.72, yP + 0.78, crate); B(-0.7, -0.62, n0 + 0.05, n0 + 0.65, yP, yP + 0.72, crate); B(0.62, 0.7, n0 + 0.05, n0 + 0.65, yP, yP + 0.72, crate); for (let k = 0; k < 3; k++) B(-0.65 + k * 0.45, -0.3 + k * 0.45, n0 + 0.1, n0 + 0.6, yP + 0.78, yP + 0.96 + k * 0.03, PK_PRODUCE[(Math.floor(h * 29) + k) % PK_PRODUCE.length]); }
  else { B(-0.7, -0.64, n0, n0 + 0.06, yP, yP + 1.9, crate); B(0.64, 0.7, n0, n0 + 0.06, yP, yP + 1.9, crate); B(-0.7, 0.7, n0, n0 + 0.06, yP + 1.84, yP + 1.9, crate); for (let k = -3; k <= 3; k++) B(k * 0.19 - 0.07, k * 0.19 + 0.07, n0 + 0.01, n0 + 0.05, yP + 0.85, yP + 1.82, PK_GOODS[(Math.floor(h * 17) + k + 8) % PK_GOODS.length]); }
}
// Jharoka: a projecting timber balcony at the second storey. Raja Bazaar, Jamia Masjid Road, College Road and Qadeemi Imambargah Road keep them (art_direction.md S41; deodar and sheesham wood)
function pkJharoka(M, ox, oz, ux, uz, nx, nz, w, y0) {
  const wood = pkCol("#6b4a2e"), dark = pkCol("#4f3423"), hw = w / 2, out = 0.62, B = (u0, u1, n0, n1, a, b, c, under) => pkBox(M, ox, oz, ux, uz, nx, nz, u0, u1, n0, n1, a, b, c, under);
  B(-hw, hw, 0, out, y0 - 0.12, y0, wood, true);
  for (const s of [-1, 1]) B(s * (hw - 0.25) - 0.1, s * (hw - 0.25) + 0.1, 0, out * 0.8, y0 - 0.62, y0 - 0.12, dark, true);
  pkFlat(M, ox, oz, ux, uz, nx, nz, -hw + 0.08, hw - 0.08, 0.05, y0 + 0.1, y0 + 1.85, pkCol("#1c1713"));
  B(-hw, hw, out - 0.05, out, y0, y0 + 0.62, wood);
  const posts = Math.max(3, Math.round(w / 0.55));
  for (let k = 0; k <= posts; k++) { const u = -hw + 0.05 + k / posts * (w - 0.1); B(u - 0.04, u + 0.04, out - 0.07, out, y0 + 0.62, y0 + 1.84, dark); }
  for (const s of [-1, 1]) { B(s * hw - 0.04, s * hw + 0.04, 0, out, y0, y0 + 0.62, wood); B(s * hw - 0.04, s * hw + 0.04, 0, out, y0 + 1.84, y0 + 1.9, wood); }
  B(-hw, hw, out - 0.08, out, y0 + 1.84, y0 + 1.95, wood);
  B(-hw - 0.2, hw + 0.2, 0, out + 0.42, y0 + 1.98, y0 + 2.08, wood, true);
}
function pkCart(M, x, z, ux, uz, nx, nz, y0, h) {
  const wood = pkCol("#7a5c3a"), tyre = pkCol("#15140f"), B = (u0, u1, n0, n1, a, b, c, under) => pkBox(M, x, z, ux, uz, nx, nz, u0, u1, n0, n1, a, b, c, under);
  B(-1, 1, -0.5, 0.5, y0 + 0.74, y0 + 0.84, wood, true);
  B(-1.7, -1, -0.32, -0.26, y0 + 0.78, y0 + 0.84, wood); B(-1.7, -1, 0.26, 0.32, y0 + 0.78, y0 + 0.84, wood);
  for (const s of [-1, 1]) pkDisc(M, x + nx * s * 0.54, z + nz * s * 0.54, ux, uz, y0 + 0.36, 0.36, tyre);
  for (let k = 0; k < 4; k++) { const c = PK_PRODUCE[(Math.floor(h * 31) + (k < 3 ? 0 : 1)) % PK_PRODUCE.length], hk = hash2(k + 3, Math.round(x * 3)); B(-0.85 + k * 0.45, -0.42 + k * 0.45, -0.4, 0.4, y0 + 0.84, y0 + 1.0 + hk * 0.14, c); }
  if (h < 0.45) { B(-0.02, 0.02, -0.02, 0.02, y0 + 0.84, y0 + 2.3, pkCol("#6e6a60")); B(-0.95, 0.95, -0.72, 0.72, y0 + 2.3, y0 + 2.34, PK_GOODS[Math.floor(h * 19) % PK_GOODS.length], true); }
}
function pkBike(M, x, z, fx, fz, lx, lz, y0, h) {
  const tyre = pkCol("#15140f"), body = h < 0.55 ? pkCol("#9c2420") : h < 0.8 ? pkCol("#1f1f22") : pkCol("#8a8a86"), B = (u0, u1, n0, n1, a, b, c) => pkBox(M, x, z, lx, lz, fx, fz, u0, u1, n0, n1, a, b, c);
  pkDisc(M, x + fx * 0.62, z + fz * 0.62, fx, fz, y0 + 0.3, 0.3, tyre); pkDisc(M, x - fx * 0.62, z - fz * 0.62, fx, fz, y0 + 0.3, 0.3, tyre);
  B(-0.1, 0.1, -0.42, 0.34, y0 + 0.36, y0 + 0.72, body); B(-0.12, 0.12, -0.62, -0.05, y0 + 0.74, y0 + 0.86, pkCol("#17171a")); B(-0.34, 0.34, 0.5, 0.55, y0 + 0.92, y0 + 0.96, pkCol("#9a9a96"));
}
function pkStall(M, x, z, ux, uz, nx, nz, y0, h) {
  const tin = pkCol("#9aa0a0"), wood = pkCol("#6d5a42"), B = (u0, u1, n0, n1, a, b, c, under) => pkBox(M, x, z, ux, uz, nx, nz, u0, u1, n0, n1, a, b, c, under);
  for (const su of [-1, 1]) for (const sn of [-1, 1]) B(su * 1.35 - 0.05, su * 1.35 + 0.05, sn * 0.85 - 0.05, sn * 0.85 + 0.05, y0, y0 + 2.2, wood);
  B(-1.55, 1.55, -1.05, 1.05, y0 + 2.2, y0 + 2.28, tin, true);
  B(-1.3, 1.3, 0.1, 0.75, y0, y0 + 0.82, wood);
  for (let k = 0; k < 4; k++) B(-1.2 + k * 0.62, -0.72 + k * 0.62, 0.15, 0.7, y0 + 0.82, y0 + 1.0, PK_GOODS[(Math.floor(h * 67) + k) % PK_GOODS.length]);
}
// Plant nursery on a sector green belt (nurseries along Islamabad's roads are reported, tribune.com.pk/story/1249906): a shade net on posts over rows of pots
function pkNursery(M, x, z, ux, uz, nx, nz, y0, h) {
  const post = pkCol("#6d6a63"), net = pkCol("#3d5a3c"), pot = pkCol("#9a5b3a"), leaf = [pkCol("#4e7a35"), pkCol("#6d8a3e"), pkCol("#3d6a3a")], B = (u0, u1, n0, n1, a, b, c, under) => pkBox(M, x, z, ux, uz, nx, nz, u0, u1, n0, n1, a, b, c, under);
  for (const su of [-1, 1]) for (const sn of [-1, 1]) B(su * 3 - 0.05, su * 3 + 0.05, sn * 1.5 - 0.05, sn * 1.5 + 0.05, y0, y0 + 2.5, post);
  B(-3.2, 3.2, -1.7, 1.7, y0 + 2.5, y0 + 2.54, net, true);
  for (let r = -1; r <= 1; r += 2) for (let k = -4; k <= 4; k++) { const hk = hash2(k * 7 + 3, r + Math.round(h * 99)), u = k * 0.7, v = r * 0.8; B(u - 0.14, u + 0.14, v - 0.14, v + 0.14, y0, y0 + 0.28, pot); B(u - 0.24, u + 0.24, v - 0.24, v + 0.24, y0 + 0.28, y0 + 0.75 + hk * 0.6, leaf[Math.floor(hk * 3)]); }
}
// Parked car, simple enough for rows: body, sill, glasshouse, roof and axles
function pkCar(M, x, z, fx, fz, lx, lz, y0, col) {
  const B = (u0, u1, n0, n1, a, b, c) => pkBox(M, x, z, lx, lz, fx, fz, u0, u1, n0, n1, a, b, c), dark = pkCol("#15161a"), glass = pkCol("#27303a");
  for (const n of [-1.32, 1.3]) B(-0.86, 0.86, n - 0.3, n + 0.3, y0, y0 + 0.6, dark);
  B(-0.84, 0.84, -2.08, 2.08, y0 + 0.3, y0 + 0.92, col);
  B(-0.74, 0.74, -1.35, 0.75, y0 + 0.92, y0 + 1.38, glass);
  B(-0.7, 0.7, -1.26, 0.66, y0 + 1.38, y0 + 1.42, col);
}
// Streets of the bazaars, kerb by kerb: handcarts, parked bikes and tin stalls; the green belts of the Islamabad sectors: tree rows, a footpath and the odd nursery
function pkStreetLife(M, lines, S, TH, roadGrid, bldNear, trails, belt, latOf, lonOf, chowks, beltG, openLand) {
  let carts = 0, bikes = 0, stalls = 0, nurseries = 0;
  for (const L of lines) {
    if (L.spec.c < 2 || L.spec.c > 6 || L.bridge || L.tunnel || L.ramp || L.el.some(e => Math.abs(e) > 0.4)) continue;
    const mid = L.pts[L.pts.length >> 1], la = latOf(mid[1]), lo = lonOf(mid[0]), zone = pkZone(la, lo);
    if (zone !== "pindi" && zone !== "lahore" && zone !== "islamabad") continue;
    const W = roadDims(L)[0], pts = L.pts.map(q => [q[0] * S, q[1] * S]), n = pts.length, cum = [0], side0 = SIDEWALK_CLASSES.has(L.cls);
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[n - 1]; if (total < 24) continue;
    const seed = hash2(Math.round(pts[0][0]), Math.round(pts[0][1]));
    const at = (s, side, o) => { let i = 0; while (i < n - 2 && cum[i + 1] < s) i++; const t = (s - cum[i]) / Math.max(1e-6, cum[i + 1] - cum[i]); let dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; const nx = dz * side, nz = -dx * side; return { x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t + nx * o, z: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t + nz * o, ux: dx, uz: dz, nx, nz }; };
    if (zone === "pindi" || zone === "lahore") {
      const shop = pkInShop(la, lo), uniform = pkNoWires(la, lo), yOf = (x, z) => (TH ? TH.road(x, z) : 0) + (side0 ? 0.2 : 0.03), pair = L.osm && L.osm.pair ? L.osm.pair : 0, kerb = W / 2 + (pair ? 1.1 : side0 ? 0.95 : 0.75);
      const clearOf = (q) => !chowks.some(c => Math.hypot(q.x - c.x, q.z - c.z) < c.r + 14) && !bldNear(q.x / S, q.z / S, 0.5 / S);
      for (let s = 10 + seed * 18, k = 0; s < total - 8; s += (pair ? 7 + hash2(k++, Math.round(pts[0][1])) * 8 : 19 + hash2(k++, Math.round(pts[0][1])) * 26)) {
        const h = hash2(k * 13 + Math.round(pts[0][0]), k * 7), side = pair || (h < 0.5 ? 1 : -1), q = at(s, side, kerb);
        // the wide pavement of the old-city pairs, and any plaza gap on a shop street: tin stalls (press reports stalls and kiosks on these footpaths), except on the revamped Raja Bazaar stretch
        if (shop && !uniform && stalls < 90) {
          const hs = hash2(k * 5 + 11, Math.round(pts[0][0]) + k), qp = at(Math.min(total - 1, s + 2.6), side, pair ? W / 2 + 2.9 : W / 2 + 5.2);
          if (hs < (pair ? 0.58 : 0.34) && clearOf(qp) && !bldNear(qp.x / S, qp.z / S, (pair ? 1.7 : 3.2) / S) && roadGrid.clear(qp.x, qp.z, 7) > (pair ? 1.8 : 3) && !(openLand && openLand.has(qp.x, qp.z))) { stalls++; pkStall(M, qp.x, qp.z, qp.ux, qp.uz, qp.nx, qp.nz, (TH ? TH.road(qp.x, qp.z) : 0) + (pair ? 0.2 : 0.03), hs); }
        }
        if (!clearOf(q)) continue;
        if (shop && !uniform && h < 0.62 && carts < 140) { carts++; pkCart(M, q.x, q.z, q.ux, q.uz, q.nx, q.nz, yOf(q.x, q.z), h / 0.62); }
        else if (!uniform && bikes < 260) { const nb = 3 + Math.floor(h * 4); for (let b = 0; b < nb && bikes < 260; b++) { const qb = at(Math.min(total - 1, s + b * 0.78), side, kerb + 0.2); pkBike(M, qb.x, qb.z, qb.nx, qb.nz, qb.ux, qb.uz, yOf(qb.x, qb.z), hash2(b + 2, k)); bikes++; } }
        const qs = at(s, -side, kerb + 1.2);
        if (!shop && hash2(k, 77) < 0.1 && stalls < 26 && !bldNear(qs.x / S, qs.z / S, 3 / S) && roadGrid.clear(qs.x, qs.z, 6) > 0.8) { stalls++; pkStall(M, qs.x, qs.z, qs.ux, qs.uz, qs.nx, qs.nz, (TH ? TH.road(qs.x, qs.z) : 0) + 0.03, h); }
      }
      continue;
    }
    if (L.spec.c > 5) continue;
    for (const side of [1, -1]) {
      let run = [];
      const flush = () => { if (run.length >= 3) { trails.push(run); trails.push(7); } run = []; };
      for (let s = 6 + seed * 8, k = 0; s < total - 6; s += 13, k++) {
        const near = at(s, side, W / 2 + 6.5), far = at(s, side, W / 2 + 15), h = hash2(k * 11 + Math.round(pts[0][0]), side + k * 3);
        const open = !chowks.some(c => Math.hypot(near.x - c.x, near.z - c.z) < c.r + 20) && roadGrid.clear(near.x, near.z, 9) > 4.5 && !bldNear(near.x / S, near.z / S, 11 / S);
        if (!open) { flush(); continue; }
        if (beltG.length < 1400) { const A = at(Math.max(0, s - 7), side, W / 2 + 3.2), B = at(Math.min(total - 0.01, s + 7), side, W / 2 + 3.2), C = at(Math.min(total - 0.01, s + 7), side, W / 2 + 21), D = at(Math.max(0, s - 7), side, W / 2 + 21); beltG.push([[[A.x / S, A.z / S], [B.x / S, B.z / S], [C.x / S, C.z / S], [D.x / S, D.z / S]]]); }
        if (belt.n < 4 * 820) belt.p4(near.x, near.z, h * 6.283, 10 + 1.1 + 0.7 * h);
        const open2 = roadGrid.clear(far.x, far.z, 9) > 4.5 && !bldNear(far.x / S, far.z / S, 11 / S);
        if (open2 && belt.n < 4 * 820) belt.p4(far.x, far.z, h * 5.1, 10 + 1 + 0.8 * hash2(k, 31));
        const mid2 = at(s, side, W / 2 + 10.8); run.push([mid2.x, mid2.z]);
        if (open2 && h < 0.02 && nurseries < 6 && !bldNear(far.x / S, far.z / S, 18 / S)) { nurseries++; const nq = at(s, side, W / 2 + 22); pkNursery(M, nq.x, nq.z, nq.ux, nq.uz, nq.nx, nq.nz, (TH ? TH.road(nq.x, nq.z) : 0) + 0.02, h); }
      }
      flush();
    }
  }
}
// Ground the map keeps open: parks, schools, yards and water (the same test as pkInfill)
function pkOpenLand(layers, S, TS, E) {
  const mask = new Splat(256, TS);
  for (const lname of ["landcover", "landuse", "park", "water"]) for (const f of (layers[lname] && layers[lname].features) || []) {
    if (f.type !== 3 || (lname !== "water" && lname !== "park" && !PK_NO_INFILL.has(f.props.subclass) && !PK_NO_INFILL.has(f.props.class))) continue;
    for (const poly of polygons(f.geom)) { const rings = []; for (const r of poly) { const c = clipRing(r, E); if (c) rings.push(c); } if (rings.length) mask.fill(rings.slice(0, 1), S, [1, 1, 1], 255); }
  }
  return mask;
}
// Rawalpindi shop streets take no highway lamps: art_direction.md section 10 asks for 7 to 9 m single-arm poles (estimated), 30 percent not working
function pkShortLit(L, latOf, lonOf) { if (L.spec.c < 2 || L.spec.c > 5 || L.bridge || L.ramp) return false; const m = L.pts[L.pts.length >> 1], la = latOf(m[1]), lo = lonOf(m[0]); return pkZone(la, lo) === "pindi" && pkInShop(la, lo); }
function pkShortLamps(M, lines, S, TH, bldAt, cards, latOf, lonOf) {
  const steel = pkCol("#59606a"), head = pkCol("#d9d2bd"), dead = pkCol("#6d6a60"); let n = 0;
  for (const L of lines) {
    if (n > 420 || !pkShortLit(L, latOf, lonOf) || L.tunnel || L.el.some(e => Math.abs(e) > 0.4)) continue;
    const W = roadDims(L)[0], pair = L.osm && L.osm.pair ? L.osm.pair : 0, base = W / 2 + (pair ? (L.osm.pave || PK_PAIR_PAVE) : 2), pts = L.pts.map(q => [q[0] * S, q[1] * S]), cnt = pts.length, cum = [0];
    for (let i = 1; i < cnt; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[cnt - 1]; if (total < 16) continue;
    const seed = hash2(Math.round(pts[0][0]), Math.round(pts[0][1]));
    for (const side of pair ? [pair] : L.oneway ? [1] : [-1, 1]) for (let s = 8 + seed * 14, k = 0; s < total - 5 && n <= 420; s += 28 + hash2(k++, Math.round(pts[0][1])) * 8) {
      let i = 0; while (i < cnt - 2 && cum[i + 1] < s) i++;
      const t = (s - cum[i]) / Math.max(1e-6, cum[i + 1] - cum[i]); let dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const px = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pz = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t, ox = dz * side, oz = -dx * side, h = hash2(k * 17 + Math.round(px), Math.round(pz) + k), y0 = (TH ? TH.road(px, pz) : 0) + 0.2, works = h > 0.3, hc = works ? head : dead;
      let wall = 0, rec = null;
      for (let d = base - 1.4; d < base + 7; d += 0.6) { const r = bldAt((px + ox * d) / S, (pz + oz * d) / S); if (r) { wall = d; rec = r; break; } }
      let hx, hz, hy;
      if (rec && rec.h >= 7 && rec.minh < 1) {
        // on the wall: a steel bracket at first-floor height reaching towards the road
        const wx = px + ox * wall, wz = pz + oz * wall; hy = y0 + Math.min(6.2, rec.h - 1);
        pkBox(M, wx, wz, dx, dz, -ox, -oz, -0.03, 0.03, 0, 1.25, hy, hy + 0.06, steel); pkBox(M, wx, wz, dx, dz, -ox, -oz, -0.13, 0.13, 1.0, 1.6, hy - 0.1, hy + 0.02, hc);
        hx = wx - ox * 1.3; hz = wz - oz * 1.3;
      } else {
        // a short pole at the kerb with one arm over the carriageway
        const bx = px + ox * (W / 2 + 0.5), bz = pz + oz * (W / 2 + 0.5), H = 7.2 + h * 1.4; hy = y0 + H;
        pkBox(M, bx, bz, dx, dz, -ox, -oz, -0.06, 0.06, -0.06, 0.06, y0, hy, steel); pkBox(M, bx, bz, dx, dz, -ox, -oz, -0.03, 0.03, 0, 1.7, hy - 0.05, hy + 0.02, steel); pkBox(M, bx, bz, dx, dz, -ox, -oz, -0.13, 0.13, 1.5, 2.2, hy - 0.12, hy, hc);
        hx = bx - ox * 1.85; hz = bz - oz * 1.85;
      }
      n++;
      if (works) for (const rot of [Math.atan2(dx, dz), Math.atan2(-dx, -dz)]) { cards.p4(hx, hy - 0.14, hz, rot); cards.p4(0.5, 0.16, 15, 1); }
    }
  }
}
// Sector verges (REVIEW item 8): grass from the kerb to the house walls, dust where it meets the kerb, the odd shrub and scrap of litter; wear per the brief, Islamabad 20 percent
function pkVerges(M, lines, S, roadGrid, bldNear, belt, openLand, latOf, lonOf) {
  const grass = [pkCol("#5f7340"), pkCol("#67793f"), pkCol("#6d7d45"), pkCol("#74794a")], dust = pkCol("#8f8064"), trod = pkCol("#7a6f58"), bits = [pkCol("#e7e2d6"), pkCol("#c9b38a"), pkCol("#1d4fb5")], gAt = (x, z) => GG ? GG.at(x, z) : 0; let quadN = 0;
  for (const L of lines) {
    if (quadN > 3000 || L.spec.c < 2 || L.spec.c > 5 || L.bridge || L.tunnel || L.ramp || L.el.some(e => Math.abs(e) > 0.4)) continue;
    const mid = L.pts[L.pts.length >> 1], zone = pkZone(latOf(mid[1]), lonOf(mid[0])); if (zone !== "islamabad" && zone !== "society") continue;
    const W = roadDims(L)[0], pts = L.pts.map(q => [q[0] * S, q[1] * S]), cnt = pts.length, cum = [0];
    for (let i = 1; i < cnt; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[cnt - 1]; if (total < 28) continue;
    for (const side of [1, -1]) for (let s = 3, k = 0; s + 7 < total && quadN < 3000; s += 7, k++) {
      let i = 0; while (i < cnt - 2 && cum[i + 1] < s) i++;
      let dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const t = s - cum[i], ox = dz * side, oz = -dx * side, bx = pts[i][0] + dx * t, bz = pts[i][1] + dz * t, h = hash2(k * 19 + Math.round(bx), side + Math.round(bz) * 3), h2 = hash2(k + 7, Math.round(bx * 2));
      const v0 = W / 2 + 0.4; let v1 = v0, ok = true;
      for (let v = v0 + 1; v <= v0 + 11; v += 1) { const x = bx + ox * v + dx * 3.5, z = bz + oz * v + dz * 3.5; if (bldNear(x / S, z / S, 1 / S) || roadGrid.clear(x, z, 3) < 0.5 || (openLand && openLand.has(x, z))) break; v1 = v; }
      if (v1 - v0 < 1.6 || !ok) continue;
      const Q = (a, b, v, w, c) => { const P = (u, vv) => { const x = bx + dx * u + ox * vv, z = bz + dz * u + oz * vv; return [x, gAt(x, z) + 0.05, z]; }; quad(M, P(a, v), P(b, v), P(b, w), P(a, w), [0, 1, 0], c, [0, 2], [1, 2], false); quadN++; };
      Q(0, 7.05, v0, v1, grass[Math.floor(h * 4)]);
      if (h2 < 0.42) Q(0.3 + h * 2, 3.4 + h * 3, v0, v0 + 0.5 + h * 0.9, dust);          // dust along the kerb
      if (h < 0.14 && v1 - v0 > 3) Q(0, 7.05, v0 + 2.2, v0 + 2.75, trod);                // a worn line where people walk
      if (h2 > 0.82) { const u = 1 + h * 5, v = v0 + 0.6 + h2 * (v1 - v0 - 1); Q(u, u + 0.16, v, v + 0.16, bits[Math.floor(h * 41) % 3]); }
      if (h < 0.2 && v1 - v0 > 4 && belt.n < 4 * 1150) { const x = bx + dx * 3.5 + ox * (v0 + (v1 - v0) * 0.55), z = bz + dz * 3.5 + oz * (v0 + (v1 - v0) * 0.55); belt.p4(x, z, h * 31 % 6.283, 10 + 0.9 + 0.8 * h2); }
    }
  }
}
// Bare lots (REVIEW item 8). Blue Area beside a plaza: a paved apron with a row of parked cars. Pindi and Lahore: compacted dirt, parked bikes, the odd tin stall. Never on ground the map keeps open
function pkBareLots(SW, VW, S, TS, roadGrid, bldNear, openLand, latOf, lonOf) {
  const G = 24, apron = pkCol("#8f8c85"), dirt = [pkCol("#8a7d66"), pkCol("#81745e"), pkCol("#93866d")], gAt = (x, z) => GG ? GG.at(x, z) : 0; let lots = 0, cars = 0, bikes = 0, stalls = 0;
  for (let z = G; z < TS - G && lots < 420; z += G) for (let x = G; x < TS - G && lots < 420; x += G) {
    const zone = pkZone(latOf(z / S), lonOf(x / S)); if (zone !== "blue" && zone !== "pindi" && zone !== "lahore") continue;
    if (openLand.has(x, z) || roadGrid.clear(x, z, G) < G * 0.62 || bldNear(x / S, z / S, 9 / S)) continue;
    const r = roadGrid.nearestSeg(x, z, 42, 2, 6); if (!r || r.elev) continue;
    if (zone === "blue" && !bldNear(x / S, z / S, 58 / S)) continue;
    const l = Math.hypot(r.px - x, r.pz - z) || 1, fx = (r.px - x) / l, fz = (r.pz - z) / l, ux = -fz, uz = fx, hG = G / 2 + 0.3, Y = (a, b) => { const px = x + ux * a + fx * b, pz = z + uz * a + fz * b; return [px, gAt(px, pz) + 0.06, pz]; }, h = hash2(Math.round(x), Math.round(z)), col = zone === "blue" ? apron : dirt[Math.floor(h * 3)];
    quad(zone === "blue" ? SW : VW, Y(-hG, -hG), Y(hG, -hG), Y(hG, hG), Y(-hG, hG), [0, 1, 0], col, zone === "blue" ? [x, 0] : [0, 2], zone === "blue" ? [x + G, 0] : [1, 2], false); lots++;
    const y = gAt(x, z) + 0.07;
    if (zone === "blue") { for (let k = -2; k <= 2 && cars < 700; k++) { if (hash2(k + 5, Math.round(z + x)) < 0.24) continue; const a = k * 3, cx = x + ux * a + fx * 6, cz = z + uz * a + fz * 6; pkCar(VW, cx, cz, fx, fz, ux, uz, y, pkCarColour(hash2(k + 9, Math.round(x)))); cars++; } continue; }
    for (let k = -2; k <= 2 && bikes < 260; k++) { if (hash2(k + 3, Math.round(x + z)) < 0.45) continue; const a = k * 1.1 + h * 3, cx = x + ux * a + fx * 8, cz = z + uz * a + fz * 8; pkBike(VW, cx, cz, fx, fz, ux, uz, y, hash2(k, Math.round(x))); bikes++; }
    if (h < 0.26 && stalls < 28) { stalls++; pkStall(VW, x, z, ux, uz, fx, fz, y, h / 0.26); }
  }
}
// Mapped green strips in the sectors: a footpath down the long axis and a tree row each side
function pkBeltRows(parkPolys, S, trees, trails, latOf, lonOf) {
  let budget = 420;
  for (const rings of parkPolys) {
    const o = rings[0], b = obbOf(o, S); if (!b || b.eu < 45 || b.ev > 70 || b.eu < b.ev * 1.8) continue;
    if (pkZone(latOf(b.cz / S), lonOf(b.cx / S)) !== "islamabad") continue;
    trails.push([[b.cx - b.ux * b.eu * 0.92, b.cz - b.uz * b.eu * 0.92], [b.cx, b.cz], [b.cx + b.ux * b.eu * 0.92, b.cz + b.uz * b.eu * 0.92]]); trails.push(7);
    for (const sv of [-1, 1]) for (let u = -b.eu + 5; u < b.eu - 5 && budget > 0; u += 12) {
      const v = sv * Math.min(b.ev * 0.62, 10), x = b.cx + u * b.ux + v * b.vx, z = b.cz + u * b.uz + v * b.vz;
      if (!pointInRingXY(x / S, z / S, o)) continue;
      trees.p4(x, z, hash2(Math.round(x), Math.round(z)) * 6.283, 10 + 1 + 0.7 * hash2(Math.round(z), 5)); budget--;
    }
  }
}
// Blue Area: paved forecourts from each plaza's road-facing wall out to the service road, with rows of parked cars. Returns the paved rings for the ground picture
function pkForecourts(SW, VW, recs, S, roadGrid, bldAt) {
  const out = [], pave = pkCol("#9d9a92"), line = pkCol("#d9d6cc"); let cars = 0;
  const gAt = (x, z) => GG ? GG.at(x, z) : 0;
  for (const r of recs.slice().sort((a, b) => a.seed - b.seed)) {
    if (r.zone !== "blue" || r.minh > 1 || r.isMosque || r.canopy || (r.areaM < 300 && r.h < 14)) continue;
    let wallCars = 0;
    const o = r.o;
    for (let i = 0; i < o.length; i++) {
      const a = o[i], b = o[(i + 1) % o.length], ax = a[0] * S, az = a[1] * S, bx = b[0] * S, bz = b[1] * S, len = Math.hypot(bx - ax, bz - az);
      if (len < 10) continue;
      const ux = (bx - ax) / len, uz = (bz - az) / len; let nx = uz, nz = -ux;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      if (pointInRingXY((mx + nx * 0.6) / S, (mz + nz * 0.6) / S, o)) { nx = -nx; nz = -nz; }
      // open ground along this wall's normal, out to 60 m: the strip before the service road, and the parking strip between it and the avenue
      const spans = []; let v0 = 0, open = true, blocked = false;
      for (let d = 1.5; d <= 60; d += 1.5) { const x = mx + nx * d, z = mz + nz * d; if (bldAt(x / S, z / S)) { if (open && d - 3 - v0 >= 2.7) spans.push([v0, d - 3]); blocked = true; break; } const clr = roadGrid.clear(x, z, 8) >= 1.3; if (open && !clr) { spans.push([v0, d - 1.3]); open = false; } else if (!open && clr) { v0 = d + 0.4; open = true; if (spans.length >= 2) break; } }
      if (open && !blocked && 58 - v0 > 6) spans.push([v0, 58]);
      for (const [w0, w1] of spans) {
        const depth = w1 - w0; if (depth < 2.7) continue;
        const u0 = -5, u1 = len + 5, P = (u, v) => [ax + ux * u + nx * v, az + uz * u + nz * v];
        out.push([[P(u0, w0), P(u1, w0), P(u1, w1), P(u0, w1)].map(q => [q[0] / S, q[1] / S])]);
        const nu = Math.max(1, Math.round((u1 - u0) / 9)), nv = Math.max(1, Math.round(depth / 9));
        for (let iu = 0; iu < nu; iu++) for (let iv = 0; iv < nv; iv++) {
          const a0 = u0 + (u1 - u0) * iu / nu, a1 = u0 + (u1 - u0) * (iu + 1) / nu, b0 = w0 + depth * iv / nv, b1 = w0 + depth * (iv + 1) / nv, Y = (u, v) => { const q = P(u, v); return [q[0], gAt(q[0], q[1]) + 0.07, q[1]]; };
          quad(SW, Y(a0, b0), Y(a1, b0), Y(a1, b1), Y(a0, b1), [0, 1, 0], pave, [a0, 0], [a1, 0], false);
        }
        if (depth < 6) {                                                                  // a narrow strip: cars parked end to end along it
          for (let u = u0 + 3.2, k = 0; u < u1 - 3; u += 6.2, k++) { const c = P(u, w1 - 1.05), h = hash2(Math.round(c[0] * 3), Math.round(c[1] * 3)); if (h < 0.7 && cars < 2600 && wallCars < 10) { cars++; wallCars++; pkCar(VW, c[0], c[1], ux, uz, nx, nz, gAt(c[0], c[1]) + 0.08, pkCarColour(hash2(k, Math.round(c[1])))); } }
          continue;
        }
        const rows = depth >= 18 ? [w1 - 3, w0 + 3.2] : [w1 - 3];
        for (const v of rows) for (let u = u0 + 3, k = 0; u < u1 - 2.5; u += 2.7, k++) {
          const c = P(u, v), h = hash2(Math.round(c[0] * 3), Math.round(c[1] * 3)), sgn = v > w0 + depth / 2 ? 1 : -1, y = gAt(c[0], c[1]) + 0.08;
          pkBox(VW, c[0], c[1], ux, uz, nx * sgn, nz * sgn, 1.3, 1.36, -2.5, 2.5, y, y + 0.012, line);
          if (h < 0.74 && cars < 2600 && wallCars < 10) { cars++; wallCars++; pkCar(VW, c[0], c[1], nx * sgn, nz * sgn, ux, uz, y, pkCarColour(hash2(k, Math.round(c[1])))); }
        }
      }
    }
  }
  return out;
}
// Chipped and unpainted kerb, dust and litter on the pavement, at each district's wear level
function pkKerbWear(M, spans) {
  const chipC = [pkCol("#8a867c"), pkCol("#4a4843"), pkCol("#6d695f")], dust = [pkCol("#8f8064"), pkCol("#857a60"), pkCol("#776f5a")], litter = [pkCol("#e7e2d6"), pkCol("#d5202e"), pkCol("#1d4fb5"), pkCol("#c9b38a")], CAPV = M.vc + 70000;   // a budget for the wear itself; this mesh is already large in the bazaars
  for (const q of spans) {
    if (M.vc > CAPV) break;
    const [ix0, iz0, ix1, iz1, ox0, oz0, ox1, oz1, ha, hb, top, wear] = q, L = Math.hypot(ix1 - ix0, iz1 - iz0); if (L < 1) continue;
    const tx = (ix1 - ix0) / L, tz = (iz1 - iz0) / L; let nx = ox0 - ix0, nz = oz0 - iz0; const sw = Math.hypot(nx, nz) || 1; nx /= sw; nz /= sw;
    let s = hash2(Math.round(ix0), Math.round(iz0)) * 2, k = 0;
    for (; s < L - 0.5; s += 1.7 + hash2(k, Math.round(ix0)) * 2.4, k++) {
      const h1 = hash2(Math.round(ix0 * 3) + k * 13, k * 5 + Math.round(iz0 * 3)), h2 = hash2(k * 7 + Math.round(iz1), Math.round(ix1) + k), y = top + ha + (hb - ha) * (s / L);
      const P = (u, v, yy) => [ix0 + tx * u + nx * v, yy, iz0 + tz * u + nz * v], e = Math.min(L, s + 0.25 + h2 * 1.05);
      if (h1 < wear) { const c = chipC[Math.floor(h2 * 3)]; quad(M, P(s, 0, y + 0.01), P(e, 0, y + 0.01), P(e, 0.16, y + 0.01), P(s, 0.16, y + 0.01), [0, 1, 0], c, [0, 2], [1, 2], false); quad(M, P(s, -0.008, y - 0.15), P(e, -0.008, y - 0.15), P(e, -0.008, y + 0.008), P(s, -0.008, y + 0.008), [-nx, 0, -nz], c, [0, 2], [1, 2], false); }
      if (h2 < wear * 0.85 && sw > 0.8) { const de = Math.min(L, s + 1.2 + h1 * 3.6), v1 = 0.16 + 0.3 + h1 * (sw * 0.55); quad(M, P(s, 0.16, y + 0.008), P(de, 0.16, y + 0.008), P(de, v1, y + 0.008), P(s, v1, y + 0.008), [0, 1, 0], dust[Math.floor(h1 * 3)], [0, 2], [1, 2], false); }
      if (h1 > 1 - wear * 0.45) { const v = 0.3 + h2 * (sw - 0.6), r = 0.07 + h2 * 0.12; quad(M, P(s, v - r, y + 0.012), P(s + r * 2, v - r, y + 0.012), P(s + r * 2, v + r, y + 0.012), P(s, v + r, y + 0.012), [0, 1, 0], litter[Math.floor(h1 * 41) % 4], [0, 2], [1, 2], false); }
    }
  }
}
// Rebar left standing for a future floor: clusters of three on the column lines (art_direction.md section 5, the highest value detail on Rawalpindi roofs)
function pkRebar(M, rec, S) {
  const b = obbOf(rec.o, S); if (!b) return;
  const rust = pkCol("#5a4436"), y0 = rec.h + (rec.gy || 0), nu = 2;
  for (let a = 0; a < nu; a++) for (const sv of [-1, 1]) {
    const u = (a / (nu - 1) * 2 - 1) * (b.eu - 0.45), v = sv * (b.ev - 0.45), x = b.cx + u * b.ux + v * b.vx, z = b.cz + u * b.uz + v * b.vz;
    if (!pointInRingXY(x / S, z / S, rec.o) || ringDist(x / S, z / S, rec.o) * S < 0.15) continue;
    const h = hash2(Math.round(x * 5), Math.round(z * 5));
    for (let k = 0; k < 2; k++) pkStick(M, x + Math.cos(k * 3.14) * 0.14, y0 - 0.02, y0 + 0.8 + h * 0.9 + k * 0.08, z + Math.sin(k * 3.14 + 1.57) * 0.14, 0.03, rust);
  }
}
// The flag of Pakistan, built to the published construction (en.wikipedia.org/wiki/Flag_of_Pakistan): 2:3, white hoist one quarter of the length, Pakistan green #00401A,
// crescent from a circle of 3/10 H about the centre of the green less one of 11/40 H about a point 13/20 H from the top fly corner along the diagonal, star in a circle of 1/10 H with one point on that diagonal
function pkFlag(M, px, pz, y0, H) {
  const L = H * 1.5, W = L / 4, green = pkCol("#00401a"), white = pkCol("#f4f3ee"), COLS = 8, dip = u => Math.sin(u / L * 5.4) * 0.045 * H * (u / L);
  for (const side of [1, -1]) {
    const N = [0, 0, side], V = (u, v, e) => [px + u, y0 + v, pz + dip(u) + side * e];
    const rect = (u0, v0, u1, v1, c) => quad(M, V(u0, v0, 0.01), V(u1, v0, 0.01), V(u1, v1, 0.01), V(u0, v1, 0.01), N, c, [0, 2], [1, 2], false);
    for (let k = 0; k < COLS; k++) { const u0 = L * k / COLS, u1 = L * (k + 1) / COLS; if (u0 < W && u1 > W) { rect(u0, 0, W, H, white); rect(W, 0, u1, H, green); } else rect(u0, 0, u1, H, u1 <= W ? white : green); }
    const tri = (a, b, c) => quad(M, V(a[0], a[1], 0.022), V(b[0], b[1], 0.022), V(c[0], c[1], 0.022), V(c[0], c[1], 0.022), N, white, [0, 2], [1, 2], false);
    // geometry in flag coordinates: the green field runs from (W, 0) to (L, H)
    const dx = (W - L), dy = -H, dl = Math.hypot(dx, dy), d = [dx / dl, dy / dl], TR = [L, H], P1 = [(W + L) / 2, H / 2], P2 = [TR[0] + d[0] * 0.65 * H, TR[1] + d[1] * 0.65 * H], R1 = 0.3 * H, R2 = 0.275 * H;
    const SEG = 40, ang = t => t / SEG * Math.PI * 2, rIn = (cs, sn) => { const ox = P1[0] - P2[0], oy = P1[1] - P2[1], b = ox * cs + oy * sn, c = ox * ox + oy * oy - R2 * R2; return -b + Math.sqrt(Math.max(0, b * b - c)); };
    for (let k = 0; k < SEG; k++) {
      const a0 = ang(k), a1 = ang(k + 1), c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1), r0 = rIn(c0, s0), r1 = rIn(c1, s1);
      if (r0 >= R1 && r1 >= R1) continue;
      const A = [P1[0] + c0 * R1, P1[1] + s0 * R1], B = [P1[0] + c1 * R1, P1[1] + s1 * R1], C = [P1[0] + c1 * Math.min(r1, R1), P1[1] + s1 * Math.min(r1, R1)], D = [P1[0] + c0 * Math.min(r0, R1), P1[1] + s0 * Math.min(r0, R1)];
      tri(A, B, C); tri(A, C, D);
    }
    const P3 = [P1[0] - d[0] * R1, P1[1] - d[1] * R1], cen = [P3[0] + d[0] * 0.1 * H, P3[1] + d[1] * 0.1 * H], a0 = Math.atan2(-d[1], -d[0]), ro = 0.1 * H, ri = ro * 0.382;
    for (let k = 0; k < 5; k++) { const a = a0 + k * 1.2566, tip = [cen[0] + Math.cos(a) * ro, cen[1] + Math.sin(a) * ro], l = a - 0.6283, r = a + 0.6283, il = [cen[0] + Math.cos(l) * ri, cen[1] + Math.sin(l) * ri], ir = [cen[0] + Math.cos(r) * ri, cen[1] + Math.sin(r) * ri]; tri(cen, il, tip); tri(cen, tip, ir); }
  }
}
function pkHex(M, cx, cz, r, y0, y1, col) {
  for (let i = 0; i < 6; i++) {
    const a0 = i / 6 * 6.2832, a1 = (i + 1) / 6 * 6.2832, A = [cx + Math.cos(a0) * r, cz + Math.sin(a0) * r], B = [cx + Math.cos(a1) * r, cz + Math.sin(a1) * r], am = (a0 + a1) / 2;
    quad(M, [A[0], y0, A[1]], [B[0], y0, B[1]], [B[0], y1, B[1]], [A[0], y1, A[1]], [Math.cos(am), 0, Math.sin(am)], col, [0, 2], [1, 2], false);
    quad(M, [A[0], y1, A[1]], [B[0], y1, B[1]], [cx, y1, cz], [cx, y1, cz], [0, 1, 0], col, [0, 2], [1, 2], false);
  }
}
// Fawara Chowk. Dawn (27 Sep 2016, dawn.com/news/1286365; and 2017, dawn.com/news/1322269) reports the old fountain demolished and six pillars planned around a new one, roofed like a Mughal bara dari
// and open so the fountain shows from all sides. That is the only published description found and its completion is not confirmed; sizes and colours are estimates.
function pkBaraDari(M, c, y0) {
  const stone = pkCol("#d4cdbd"), trim = pkCol("#a89e8a"), water = pkCol("#3a6f8a"), R = 3.3, H = 4.3, y1 = y0 + 0.5;
  pkHex(M, c.x, c.z, R + 0.9, y0, y1, trim);
  for (let i = 0; i < 6; i++) { const a = (i + 0.5) / 6 * 6.2832, x = c.x + Math.cos(a) * R, z = c.z + Math.sin(a) * R, n = Math.hypot(Math.cos(a), Math.sin(a)); box(M, x, z, Math.cos(a) / n, Math.sin(a) / n, 0.28, 0.28, y1, y1 + H, stone); box(M, x, z, Math.cos(a) / n, Math.sin(a) / n, 0.42, 0.42, y1 + H - 0.3, y1 + H, trim); }
  pkHex(M, c.x, c.z, R + 0.75, y1 + H, y1 + H + 0.32, stone);
  pkHex(M, c.x, c.z, R + 1.1, y1 + H + 0.32, y1 + H + 0.5, trim);
  pkHex(M, c.x, c.z, 1.7, y1, y1 + 0.5, trim);
  pkHex(M, c.x, c.z, 1.45, y1 + 0.05, y1 + 0.46, water);
  pkHex(M, c.x, c.z, 0.28, y1 + 0.3, y1 + 1.5, stone);
}
// Streets a jharoka can stand on (art_direction.md S41), Rawalpindi only
function pkJharokaStreets(nameLines) {
  const L = nameLines.filter(nl => /raja ba[zj]+a+r|jamia masjid|college road|imam ?bargah/i.test(nl.en || ""));
  return (x, z) => { for (const nl of L) { if (x < nl.bb[0] - 22 || x > nl.bb[2] + 22 || z < nl.bb[1] - 22 || z > nl.bb[3] + 22) continue; for (let i = 0; i < nl.pts.length - 1; i++) if (segDistXY(x, z, nl.pts[i][0], nl.pts[i][1], nl.pts[i + 1][0], nl.pts[i + 1][1]) < 20) return true; } return false; };
}
// Named shop streets of the bazaars: a road or market with a name, not a numbered lane or gali
function pkNamedShopStreets(nameLines) {
  const G = new SegGrid(40), RE = /bazaa?r|market|mandi|road|mall/i, NOT = /\bgali\b|\blane\b|\bstreet\b/i;
  for (const nl of nameLines) if (nl.en && RE.test(nl.en) && !NOT.test(nl.en)) for (let i = 0; i < nl.pts.length - 1; i++) G.add(nl.pts[i][0], nl.pts[i][1], nl.pts[i + 1][0], nl.pts[i + 1][1], 0, 3, 0);
  return (x, z) => !!G.nearestSeg(x, z, 24);
}
// What each trade shows in its open bay: an index into the stock cards drawn in signs.js, in the order of PK_TRADES
const PK_TRADE_STOCK = [3, 0, 1, 5, 4, 2, 6, 6, 3, 17, 7, 11, 14, 9, 9, 13, 13, 17, 17, 17, 3, 17, 7, 7, 12, 8, 1, 10, 10, 14, 14, 1, 1, 17];   // 11 is shelves of books, 17 (signs.js) a dim office: photo, salon, travels, property, coaching, rent a car
function pkFrontages(recs, S, roadGrid, textId, shopSigns, VF, VN, latOf, lonOf, jhStreet, namedStreet, stockCards) {
  let n = 0, nAw = 0, nFront = 0, nJh = 0, jhW = 0, wallA = 0, signA = 0; const CAP = 70000, CELL = 170, FRONTS = 5000, cells = new Map(), gcells = new Map(), fcells = new Map(), shopOf = r => (r.zone === "pindi" || r.zone === "lahore") && pkInShop(latOf(r.cy), lonOf(r.cx)) ? (namedStreet(r.cx * S, r.cy * S) ? 0 : 1) : 2, order = recs.slice().sort((a, b) => shopOf(a) - shopOf(b) || a.seed - b.seed), cellOf = r => Math.floor(r.cx * S / CELL) * 4096 + Math.floor(r.cy * S / CELL);
  // REVIEW3 item 10: the same name within 55 m moves on through the pool. 480 of the combinations (about three times as many as before, so the atlas holds them), and the pool index also fixes the language.
  const lastAt = new Map(), NEAR2 = 55 * 55, PK_POOL = 480, pickPool = (h, x, z) => { let pool = Math.floor(h * PK_POOL) % PK_POOL; for (let t = 0; t < 14; t++) { const a = lastAt.get(pool); if (!a || !a.some(q => (q[0] - x) * (q[0] - x) + (q[1] - z) * (q[1] - z) < NEAR2)) break; pool = (pool + 89) % PK_POOL; } let a = lastAt.get(pool); if (!a) lastAt.set(pool, a = []); a.push([x, z]); return pool; };
  const text = (h, zone, uniform, x, z) => {
    const pool = uniform === 2 ? h : pickPool(h, x, z), N = PK_NAMES[pool % PK_NAMES.length], T = PK_TRADES[(pool * 7 + 3) % PK_TRADES.length], L = PK_LANG[zone] || PK_LANG.rural, l = hash2(pool, 41), cls = uniform ? "flexu" : "flex";
    const en = N[0] + " " + T[0], ar = N[1] + " " + T[1];
    return l < L[0] ? textId("", ar, "", cls) : l < L[1] ? textId(en, ar, "", cls) : textId(en, "", "", cls);
  };
  for (const rec of order) {
    if (n >= CAP || rec.minh >= 1 || rec.isMosque || rec.canopy || (rec.part && !rec.mallShop) || rec.noShops || (rec.infill && !rec.retail)) continue;
    const zone = rec.zone, Q = zone === "murree" && !rec.mallShop ? null : PK_SIGNAGE[zone]; if (!Q) continue;
    const la = latOf(rec.cy), lo = lonOf(rec.cx), shop = (zone === "pindi" || zone === "lahore") && pkInShop(la, lo), uniform = shop && pkNoWires(la, lo);
    if (rec.h < (shop ? 4 : 4.5)) continue;
    if (!(rec.packed || rec.retail || rec.type === 1 || rec.type === 2 || (zone === "blue" && rec.type === 0))) continue;
    if ((zone === "islamabad" || zone === "society") && !(rec.dens > 0.3 || rec.retail)) continue;
    const cellK = cellOf(rec); let cellN = cells.get(cellK) || 0, cellG = gcells.get(cellK) || 0, cellF = fcells.get(cellK) || 0;
    const CF = 90;
    const o = rec.o, floors = Math.max(1, Math.floor((rec.h - 1) / rec.floorH)), gh = Math.min(rec.floorH * 1.4, 5.4), gy = rec.gy || 0;
    for (let i = 0; i < o.length && n < CAP; i++) {
      const a = o[i], b = o[(i + 1) % o.length], ax = a[0] * S, az = a[1] * S, bx = b[0] * S, bz = b[1] * S, len = Math.hypot(bx - ax, bz - az);
      if (len < (shop ? 1.6 : 3.2)) continue;
      const dx = (bx - ax) / len, dz = (bz - az) / len; let nx = dz, nz = -dx;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      if (pointInRingXY((mx + nx * 0.6) / S, (mz + nz * 0.6) / S, o)) { nx = -nx; nz = -nz; }
      const r = roadGrid.nearest(mx + nx * 5, mz + nz * 5, shop ? 20 : 14, 2, 6); if (!r || r.elev || Math.hypot(mx - r.px, mz - r.pz) - r.hw > (shop ? 15 : 11) || (r.px - mx) * nx + (r.pz - mz) * nz < 0) continue;
      if (shop && ((r.px - mx) * nx + (r.pz - mz) * nz) / Math.max(0.5, Math.hypot(r.px - mx, r.pz - mz)) < 0.55) continue;      // a party wall: the neighbour stands against it
      const dense = shop && r.c <= 5 && namedStreet(mx, mz), cc = dense ? 720 : 50, cg = dense ? 420 : 130, seed = hash2(Math.round(ax * 2), Math.round(bz * 2)), bay = dense ? 2 + seed : 3.3 + seed * 1.1, nb = Math.max(1, Math.min(40, Math.floor(len / bay))), w0 = len / nb;
      const yaw = Math.atan2(nx, nz), maxF = Math.min(3, floors - 1), jh = zone === "pindi" && shop && floors >= 2 && jhStreet(mx, mz);
      if (jh) jhW++;
      if (dense && !uniform) wallA += len * maxF * rec.floorH;
      for (let k = 0; k < nb && n < CAP; k++) {
        const h = hash2(Math.round(ax * 3) + k * 13, Math.round(az * 3) + k * 7), h2 = hash2(k * 31 + Math.round(bx), Math.round(bz) + k * 3), t = (k + 0.5) * w0;
        if (rec.used && rec.used.some(u => u[0] === i && Math.abs(u[1] - t) < (u[2] + w0) / 2)) continue;
        const px = ax + dx * t + nx * 0.14, pz = az + dz * t + nz * 0.14;
        const bayPool = pickPool(h, px, pz);
        if ((shop || rec.retail || rec.dense || rec.packed) && w0 > 1.4) { const stH = Math.max(1.6, gh - 1.55), shut = hash2(Math.round(ax * 5) + k * 3, Math.round(az * 5) + k) < 0.14; stockCards.p4(ax + dx * t + nx * 0.07, gy + 0.12 + stH / 2, az + dz * t + nz * 0.07, yaw); stockCards.p4(w0 - 0.2, stH, shut ? 16 : PK_TRADE_STOCK[(bayPool * 7 + 3) % PK_TRADES.length], shut ? 0 : 0.34); }
        if (uniform) { if (cellG < cg) { cellG++; shopSigns.p4(px, Math.min(gh - 0.2, 3.7) + gy, pz, yaw); shopSigns.p4(w0 - 0.2, 0.95, text(bayPool, zone, 2, px, pz), 1); n++; } }
        else if (h < (dense ? 0.97 : Q[0]) && cellG < cg) { cellG++; const ph = 0.95 + h2 * 0.35; shopSigns.p4(px, Math.min(gh - 0.2, 3.9) + gy, pz, yaw); shopSigns.p4(w0 - 0.25 + (shop ? 0.22 : 0), ph, text(bayPool, zone, 2, px, pz), h2 < 0.5 ? 1 : 0); n++; }
        if (dense && cellF < CF && nFront < FRONTS && h2 < 0.86) {
          const cl = roadGrid.clear(px + nx * 0.3, pz + nz * 0.3, 8), yP = (TH ? TH.road(px, pz) : gy) + (r.c >= 2 && r.c <= 5 ? 0.2 : 0.03);
          pkShopFront(VF, ax + dx * t, az + dz * t, dx, dz, nx, nz, w0, gy, yP, Math.min(2.2, cl - 0.5), h); nFront++; cellF++;
        }
        if (!uniform && h2 < (dense ? 0.62 : Q[1]) && nAw < 2400 && gh > 3.2) { (rec.aw = rec.aw || []).push([ax + dx * (t - w0 * 0.42), az + dz * (t - w0 * 0.42), ax + dx * (t + w0 * 0.42), az + dz * (t + w0 * 0.42), nx, nz, Math.min(gh - 1.4, 2.95), 0.9 + h * 0.5, PK_AWNING[Math.floor(h2 * 97) % PK_AWNING.length]]); nAw++; }
        const jhHere = jh && k % 2 === 0 && h < 0.5 && nJh < 300;
        if (jhHere) { nJh++; pkJharoka(VN, ax + dx * t, az + dz * t, dx, dz, nx, nz, Math.min(w0 + 0.9, 3), gy + gh + 0.2); }
        if (uniform) continue;
        if (dense && h2 > 0.72 && cellN < cc && floors >= 1) {                               // a board on a bracket standing out from the wall, read from up and down the street
          const yb = gh + 0.5 + hash2(k, 7) * Math.max(0.5, rec.floorH * Math.min(1, floors - 1)), o2 = 1.15, bxp = px + nx * o2, bzp = pz + nz * o2;
          if (yb + 0.4 < rec.h - 0.2) { const id = text(h2, zone, undefined, bxp, bzp); shopSigns.p4(bxp + dx * 0.02, yb + gy, bzp + dz * 0.02, Math.atan2(dx, dz)); shopSigns.p4(1.7, 0.62, id, 1); shopSigns.p4(bxp - dx * 0.02, yb + gy, bzp - dz * 0.02, Math.atan2(-dx, -dz)); shopSigns.p4(1.7, 0.62, id, 1); n += 2; cellN += 2; pkBox(VF, ax + dx * t, az + dz * t, dx, dz, nx, nz, -0.02, 0.02, 0, 2.0, yb + gy + 0.3, yb + gy + 0.34, pkCol("#2a2a2a")); }
        }
        const cover = dense ? 0.84 : Q[2];
        for (let f = 1; f <= maxF && cellN < cc; f++) {
          if (jhHere && f === 1) continue;
          const hf = hash2(Math.round(px * 3) + f * 19, Math.round(pz * 3) + f * 11); if (hf > cover) continue;
          const pw = dense ? Math.max(1.8, w0 * (0.95 + hf * 0.55)) : Math.max(1.6, w0 * (0.75 + hf * 0.9)), ph = dense ? 1.25 + hf * 1.35 : 0.9 + hf * 1.5, yf = gh + (f - 0.5) * rec.floorH + (dense ? (h2 - 0.5) * 0.4 : 0);
          if (yf + ph / 2 > rec.h - 0.3) continue;
          shopSigns.p4(px + nx * 0.02, yf + gy, pz + nz * 0.02, yaw); shopSigns.p4(pw, ph, text(hf, zone, undefined, px, pz), hf < 0.45 ? 1 : 0); n++; cellN++; if (dense) signA += pw * ph;
          if (dense && hf < 0.42) { const lw = Math.max(1.6, pw * 0.72), lh = ph * 0.62, ly = yf + (hf < 0.21 ? 0.55 : -0.5) * ph; if (ly + lh / 2 < rec.h - 0.3) { shopSigns.p4(px + nx * 0.09 + dx * w0 * 0.33, ly + gy, pz + nz * 0.09 + dz * w0 * 0.33, yaw); shopSigns.p4(lw, lh, text(hf * 2.3, zone, undefined, px, pz), 1); n++; cellN++; signA += lw * lh * 0.4; } }
        }
      }
    }
    cells.set(cellK, cellN); gcells.set(cellK, cellG); fcells.set(cellK, cellF);
  }
  return { signs: n, cover: wallA > 0 ? +(signA / wallA).toFixed(3) : 0, fronts: nFront, jharokas: nJh, jhWalls: jhW, awnings: nAw };
}

// Procedural infill, only where the data shows a packed block with gaps in the detections: inside the dense cores of bake_footprints.py,
// on ground not mapped as a park, school, cemetery, yard or water, with at least DENS of the surrounding 105 m square already under detected roofs.
// Terraced lots go wall to wall along the street fronts first, then into the blocks behind with lanes of about a metre.
const PK_CORES = [[73.015, 33.575, 73.085, 33.645], [74.295, 31.565, 74.345, 31.6]];
const PK_NO_INFILL = new Set(["park", "grass", "garden", "pitch", "playground", "recreation_ground", "village_green", "golf_course", "cemetery", "school", "college", "university", "kindergarten", "hospital", "stadium", "bus_station", "railway", "military", "wood", "forest", "farmland", "farm", "meadow", "scrub", "orchard", "allotments", "wetland", "sand", "bare_rock"]);
function pkInfill(recs, S, E, TS, roadGrid, lines, layers, latOf, lonOf, bColl, chowks) {
  const midLat = latOf(E / 2), midLon = lonOf(E / 2), dLat = Math.abs(latOf(0) - latOf(E)), dLon = Math.abs(lonOf(E) - lonOf(0));
  if (!PK_CORES.some(b => midLon + dLon > b[0] && midLon - dLon < b[2] && midLat + dLat > b[1] && midLat - dLat < b[3])) return 0;
  const inCore = (lat, lon) => PK_CORES.some(b => lon > b[0] && lon < b[2] && lat > b[1] && lat < b[3]);
  // ground that must stay open
  const mask = new Splat(256, TS);
  for (const lname of ["landcover", "landuse", "park", "water"]) for (const f of (layers[lname] && layers[lname].features) || []) {
    if (f.type !== 3 || (lname !== "water" && lname !== "park" && !PK_NO_INFILL.has(f.props.subclass) && !PK_NO_INFILL.has(f.props.class))) continue;
    for (const poly of polygons(f.geom)) { const rings = []; for (const r of poly) { const c = clipRing(r, E); if (c) rings.push(c); } if (rings.length) mask.fill(rings.slice(0, 1), S, [1, 1, 1], 255); }
  }
  // occupancy at 3 m: buildings, roads and a kerb's width beyond them
  const N = Math.round(TS / 3), k = N / TS, occ = new Uint8Array(N * N);
  const stamp = (rings) => { const o = rings[0]; let y0 = N, y1 = 0; const ed = []; for (let i = 0; i < o.length; i++) { const p = o[i], q = o[(i + 1) % o.length], ya = p[1] * S * k, yb = q[1] * S * k; ed.push(p[0] * S * k, ya, q[0] * S * k, yb); y0 = Math.min(y0, ya, yb); y1 = Math.max(y1, ya, yb); } y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(N - 1, Math.ceil(y1)); const xs = []; for (let y = y0; y <= y1; y++) { const yc = y + 0.5; xs.length = 0; for (let i = 0; i < ed.length; i += 4) if ((ed[i + 1] > yc) !== (ed[i + 3] > yc)) xs.push(ed[i] + (ed[i + 2] - ed[i]) * (yc - ed[i + 1]) / (ed[i + 3] - ed[i + 1])); xs.sort((a, b) => a - b); for (let q = 0; q + 1 < xs.length; q += 2) { const a = Math.max(0, Math.floor(xs[q])), b = Math.min(N, Math.ceil(xs[q + 1])); for (let x = a; x < b; x++) occ[y * N + x] = 1; } } };
  const C = 35, GN = Math.ceil(TS / C), cov = new Float32Array(GN * GN);
  for (const r of recs) { if (r.minh > 2) continue; stamp(r.rings); const i = Math.floor(r.cx * S / C), j = Math.floor(r.cy * S / C); if (i >= 0 && j >= 0 && i < GN && j < GN) cov[j * GN + i] += r.areaM; }
  const densAt = (x, z) => { const i = Math.floor(x / C), j = Math.floor(z / C); let a = 0; for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) { const ii = i + u, jj = j + v; if (ii >= 0 && jj >= 0 && ii < GN && jj < GN) a += cov[jj * GN + ii]; } return a / (9 * C * C); };
  const RAD = 1;
  const stampSeg = (ax, az, bx, bz, r) => { const d = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(d / 1.5)); for (let i = 0; i <= n; i++) { const x = (ax + (bx - ax) * i / n) * k, z = (az + (bz - az) * i / n) * k, rr = Math.ceil(r * k); for (let v = -rr; v <= rr; v++) for (let u = -rr; u <= rr; u++) { const xi = Math.floor(x) + u, zi = Math.floor(z) + v; if (xi >= 0 && zi >= 0 && xi < N && zi < N && u * u + v * v <= rr * rr + 1) occ[zi * N + xi] = 1; } } };
  const pad = W => W / 2 + 2.2;                                              // the carriageway plus a narrow pavement
  const padL = (L, W) => L.osm && L.osm.pair ? W / 2 + (L.osm.pave || PK_PAIR_PAVE) : pad(W);
  for (const L of lines) { const W = roadDims(L)[0]; for (let i = 0; i < L.pts.length - 1; i++) stampSeg(L.pts[i][0] * S, L.pts[i][1] * S, L.pts[i + 1][0] * S, L.pts[i + 1][1] * S, L.spec.c >= 7 ? 1.3 : padL(L, W)); }
  for (const f of (layers.transportation && layers.transportation.features) || []) { if (f.type !== 2 || (f.props.class !== "rail" && f.props.class !== "transit")) continue; for (const g of f.geom) for (let i = 0; i + 3 < g.length; i += 2) stampSeg(g[i] * S, g[i + 1] * S, g[i + 2] * S, g[i + 3] * S, 4); }
  for (const c of chowks) stampSeg(c.x, c.z, c.x, c.z, c.r + 9);
  // a lot is free when every 3 m cell of its plot is
  const free = (cx, cz, ux, uz, hu, hv) => { const vx = -uz, vz = ux, n1 = Math.ceil(hu / 1.5), n2 = Math.ceil(hv / 1.5); for (let a = -n1; a <= n1; a++) for (let b = -n2; b <= n2; b++) { const x = cx + ux * hu * a / n1 + vx * hv * b / n2, z = cz + uz * hu * a / n1 + vz * hv * b / n2, xi = Math.floor(x * k), zi = Math.floor(z * k); if (xi < 0 || zi < 0 || xi >= N || zi >= N || occ[zi * N + xi] || mask.has(x, z)) return false; } return true; };
  let placed = 0; const MAX = 5200, MAX3 = 12000;
  const place = (cx, cz, ux, uz, hu, hv, front) => {
    const vx = -uz, vz = ux, lat = latOf(cz / S), lon = lonOf(cx / S), zone = pkZone(lat, lon), seed = hash2(Math.round(cx * 3), Math.round(cz * 7)), s2 = hash2(Math.round(cz * 5), Math.round(cx * 2));
    const P = (a, b) => [(cx + ux * a + vx * b) / S, (cz + uz * a + vz * b) / S];
    let ring = [P(-hu, -hv), P(hu, -hv), P(hu, hv), P(-hu, hv)]; let sg = 0; for (let i = 0; i < 4; i++) { const q = ring[i], w = ring[(i + 1) % 4]; sg += q[0] * w[1] - w[0] * q[1]; } if (sg < 0) ring = ring.reverse();
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9; for (const q of ring) { if (q[0] < minx) minx = q[0]; if (q[0] > maxx) maxx = q[0]; if (q[1] < miny) miny = q[1]; if (q[1] > maxy) maxy = q[1]; }
    if (minx <= 0 || miny <= 0 || maxx >= E || maxy >= E) return false;
    const areaM = 4 * hu * hv, floors = areaM < 16 ? 1 + Math.floor(seed * 2) : 2 + Math.floor(seed * 3) + (s2 < 0.18 ? 1 : 0), pal = PK_WALLS[zone] || PK_WALLS.pindi;
    recs.push({ rings: [ring], o: ring, h: floors * 3.1 + 1, minh: 0, type: 1, color: lin(hexRgb(pal[Math.floor(seed * 89) % pal.length])), seed, floorH: 3.1, cx: (minx + maxx) / 2, cy: (miny + maxy) / 2, minx, miny, maxx, maxy, areaM, isMosque: false, canopy: false, retail: front ? 1 : 0, used: null, bi: null, kind: "", roofShape: null, roofH: 0, roofCol: null, name: "", guessH: false, fp: 2, dense: 1, packed: true, zone, dens: 0.4, infill: 1 });
    stamp([ring]);
    if (roadGrid.clear(cx, cz, 35) < 35) { const flat = []; for (const q of ring) flat.push(lonOf(q[0]), latOf(q[1])); bColl.push([flat]); }
    placed++; return true;
  };
  // Sheds and big plain boxes that face a shop street take a row of shops along that wall; on a mapped hospital, school or station ground they become a plain public block instead
  for (const r of recs.slice()) {
    if (r.infill || r.minh > 1 || r.isMosque || r.canopy || (r.zone !== "pindi" && r.zone !== "lahore") || !(r.type === 4 || (r.areaM > 1800 && r.h < 12))) continue;
    const la = latOf(r.cy), lo = lonOf(r.cx); if (!inCore(la, lo)) continue;
    if (mask.has(r.cx * S, r.cy * S)) { r.type = 2; r.floorH = 3.6; r.h = Math.max(r.h, 11 + Math.floor(r.seed * 2) * 3.6); r.retail = 0; r.noShops = 1; r.color = lin(hexRgb(PK_WALLS.pindi[Math.floor(r.seed * 89) % PK_WALLS.pindi.length])); continue; }
    if (!pkInShop(la, lo)) continue;
    let fronted = false; const o = r.o;
    for (let i = 0; i < o.length; i++) {
      const a = o[i], b = o[(i + 1) % o.length], ax = a[0] * S, az = a[1] * S, bx = b[0] * S, bz = b[1] * S, len = Math.hypot(bx - ax, bz - az); if (len < 7) continue;
      const ux = (bx - ax) / len, uz = (bz - az) / len; let nx = uz, nz = -ux; const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      if (pointInRingXY((mx + nx * 0.6) / S, (mz + nz * 0.6) / S, o)) { nx = -nx; nz = -nz; }
      const q = roadGrid.nearest(mx + nx * 5, mz + nz * 5, 16, 2, 6); if (!q || q.elev || (q.px - mx) * nx + (q.pz - mz) * nz < 0) continue;
      for (let t = 1.2, k = 0; t < len - 3; k++) {
        const hw = 2.3 + hash2(k + i * 7, Math.round(ax)) * 1.5, depth = 6 + hash2(i, k * 3 + Math.round(az)) * 3; if (t + 2 * hw > len - 0.8) break;
        const px = ax + ux * (t + hw), pz = az + uz * (t + hw), cx = px - nx * (depth / 2 - 0.16), cz = pz - nz * (depth / 2 - 0.16);
        if (pointInRingXY((px - nx * (depth - 1)) / S, (pz - nz * (depth - 1)) / S, o) && place(cx, cz, ux, uz, hw, depth / 2, true)) fronted = true;
        t += 2 * hw + 0.03;
      }
    }
    if (fronted) { r.h = Math.min(r.h, 6.4); r.noShops = 1; }
  }
  const DENS = 0.16;
  const ok = (x, z) => x > 4 && z > 4 && x < TS - 4 && z < TS - 4 && inCore(latOf(z / S), lonOf(x / S)) && densAt(x, z) >= (pkInShop(latOf(z / S), lonOf(x / S)) ? 0.03 : DENS);
  // 1. the street fronts, both sides of every city street
  for (const L of lines) {
    if (L.spec.c < 2 || L.spec.c > 6 || L.bridge || L.tunnel || L.el.some(e => Math.abs(e) > 0.4) || placed >= MAX) continue;
    const W = roadDims(L)[0], pts = L.pts.map(q => [q[0] * S, q[1] * S]);
    for (let i = 0; i < pts.length - 1 && placed < MAX; i++) {
      const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1], len = Math.hypot(dx, dz); if (len < 4) continue;
      if (chowks.some(c => Math.hypot(pts[i][0] - c.x, pts[i][1] - c.z) < c.r + 11)) continue;
      const ux = dx / len, uz = dz / len;
      for (const side of [1, -1]) {
        if (L.osm && L.osm.pair && side !== -L.osm.pair) continue;
        const nx = -uz * side, nz = ux * side; let t = 3 + hash2(i, Math.round(pts[i][0])) * 3;
        while (t < len - 2.5 && placed < MAX) {
          const hw = 2.6 + hash2(Math.round(t * 7), i + (side > 0 ? 3 : 1)) * 1.4, d = 7 + hash2(i * 3, Math.round(t * 5)) * 5, off = padL(L, W) + 0.4 + d / 2;
          const cx = pts[i][0] + ux * t + nx * off, cz = pts[i][1] + uz * t + nz * off;
          let done = false;
          if (ok(cx, cz)) { if (free(cx, cz, ux, uz, hw, d / 2)) done = place(cx, cz, ux, uz, hw, d / 2, true); else if (free(cx - nx * 1.5, cz - nz * 1.5, ux, uz, hw, d / 2 - 1.5)) done = place(cx - nx * 1.5, cz - nz * 1.5, ux, uz, hw, d / 2 - 1.5, true); }
          t += done ? 2 * hw + 0.12 : 2.5;
        }
      }
    }
  }
  // 2. the blocks behind: lots facing the nearest street
  for (const G of [9, 6.5]) for (let z = G; z < TS - G && placed < MAX; z += G) for (let x = G; x < TS - G && placed < MAX; x += G) {
    const cx = x + (hash2(Math.round(x), Math.round(z)) - 0.5) * 4, cz = z + (hash2(Math.round(z), Math.round(x)) - 0.5) * 4;
    if (!ok(cx, cz)) continue;
    const r = roadGrid.nearestSeg(cx, cz, 60); let ux = 1, uz = 0; if (r) { const dx = r.px - cx, dz = r.pz - cz, l = Math.hypot(dx, dz) || 1; ux = -dz / l; uz = dx / l; }
    const hu = 2.8 + hash2(Math.round(cx * 3), 7) * 1.6, hv = 4 + hash2(Math.round(cz * 3), 11) * 2.4;
    if (free(cx, cz, ux, uz, hu + 0.5, hv + 0.5)) place(cx, cz, ux, uz, hu, hv, false);
  }
  // 3. the shop streets: whatever frontage is still open gets a lot of exactly that width, so no dirt shows between the shops
  if (placed < MAX3 && PK_SHOP.some(b => midLon + dLon > b[0] && midLon - dLon < b[2] && midLat + dLat > b[1] && midLat - dLat < b[3])) {
    const NF = Math.ceil(TS / 1.2), kF = NF / TS, occF = new Uint8Array(NF * NF);
    const fillF = o => { let y0 = NF, y1 = 0; const ed = []; for (let i = 0; i < o.length; i++) { const p = o[i], q = o[(i + 1) % o.length], ya = p[1] * S * kF, yb = q[1] * S * kF; ed.push(p[0] * S * kF, ya, q[0] * S * kF, yb); y0 = Math.min(y0, ya, yb); y1 = Math.max(y1, ya, yb); } y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(NF - 1, Math.ceil(y1)); const xs = []; for (let y = y0; y <= y1; y++) { const yc = y + 0.5; xs.length = 0; for (let i = 0; i < ed.length; i += 4) if ((ed[i + 1] > yc) !== (ed[i + 3] > yc)) xs.push(ed[i] + (ed[i + 2] - ed[i]) * (yc - ed[i + 1]) / (ed[i + 3] - ed[i + 1])); xs.sort((a, b) => a - b); for (let q = 0; q + 1 < xs.length; q += 2) { const a = Math.max(0, Math.floor(xs[q])), b = Math.min(NF, Math.ceil(xs[q + 1])); for (let x = a; x < b; x++) occF[y * NF + x] = 1; } } };
    for (const r of recs) if (r.minh <= 2) fillF(r.rings[0]);
    const discF = (ax, az, bx, bz, r) => { const d = Math.hypot(bx - ax, bz - az), m = Math.max(1, Math.ceil(d / 0.9)), rc = r * kF, rr = Math.ceil(rc), r2 = rc * rc; for (let i = 0; i <= m; i++) { const x = (ax + (bx - ax) * i / m) * kF, z = (az + (bz - az) * i / m) * kF; for (let v = -rr; v <= rr; v++) for (let u = -rr; u <= rr; u++) { const xi = Math.floor(x) + u, zi = Math.floor(z) + v, ex = xi + 0.5 - x, ez = zi + 0.5 - z; if (xi >= 0 && zi >= 0 && xi < NF && zi < NF && ex * ex + ez * ez <= r2) occF[zi * NF + xi] = 1; } } };
    for (const L of lines) { const W = roadDims(L)[0], r = L.spec.c >= 7 ? 1.1 : L.osm && L.osm.pair ? W / 2 + (L.osm.pave || PK_PAIR_PAVE) : W / 2 + (SIDEWALK_CLASSES.has(L.cls) ? 1.85 : 1.0); for (let i = 0; i < L.pts.length - 1; i++) discF(L.pts[i][0] * S, L.pts[i][1] * S, L.pts[i + 1][0] * S, L.pts[i + 1][1] * S, r); }
    for (const c of chowks) discF(c.x, c.z, c.x, c.z, c.r + 9);
    for (const f of (layers.transportation && layers.transportation.features) || []) { if (f.type !== 2 || (f.props.class !== "rail" && f.props.class !== "transit")) continue; for (const g of f.geom) for (let i = 0; i + 3 < g.length; i += 2) discF(g[i] * S, g[i + 1] * S, g[i + 2] * S, g[i + 3] * S, 4); }
    const openF = (x, z) => { const i = Math.floor(x * kF), j = Math.floor(z * kF); return i >= 0 && j >= 0 && i < NF && j < NF && !occF[j * NF + i] && !mask.has(x, z); };
    for (const L of lines) {
      if (L.spec.c < 2 || L.spec.c > 6 || L.bridge || L.tunnel || L.el.some(e => Math.abs(e) > 0.4)) continue;
      const mid = L.pts[L.pts.length >> 1]; if (!pkInShop(latOf(mid[1]), lonOf(mid[0]))) continue;
      const W = roadDims(L)[0], front = L.osm && L.osm.pair ? W / 2 + (L.osm.pave || PK_PAIR_PAVE) + 0.1 : W / 2 + (SIDEWALK_CLASSES.has(L.cls) ? 1.95 : 1.1), pts = L.pts.map(q => [q[0] * S, q[1] * S]);
      for (let i = 0; i < pts.length - 1 && placed < MAX3; i++) {
        const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1], len = Math.hypot(dx, dz); if (len < 1.2) continue;
        if (chowks.some(c => Math.hypot(pts[i][0] - c.x, pts[i][1] - c.z) < c.r + 11)) continue;
        const ux = dx / len, uz = dz / len;
        for (const side of [1, -1]) {
          if (L.osm && L.osm.pair && side !== -L.osm.pair) continue;
          const nx = -uz * side, nz = ux * side;
          if (L.oneway && roadGrid.clear(pts[i][0] + dx / 2 + nx * (front + 9), pts[i][1] + dz / 2 + nz * (front + 9), 12) < 4) continue;        // the median between two carriageways
          const probe = (s, d) => openF(pts[i][0] + ux * s + nx * d, pts[i][1] + uz * s + nz * d), clearAt = s => probe(s, front + 0.7) && probe(s, front + 2.4);
          let s = 0.4;
          while (s < len - 0.4 && placed < MAX3) {
            if (!clearAt(s)) { s += 0.6; continue; }
            let e = s; while (e + 0.6 < len - 0.2 && clearAt(e + 0.6)) e += 0.6;
            for (let a = s; e - a > 1 && placed < MAX3;) {
              let w = Math.min(e - a, 2.6 + hash2(Math.round(a * 7), i + (side > 0 ? 3 : 1)) * 3.4); if (e - a - w < 1.4) w = e - a;
              let depth = 1.2; while (depth < 11 && [0.1, 0.5, 0.9].every(f => probe(a + w * f, front + depth + 0.6))) depth += 0.6;
              if (depth >= 2.2 && place(pts[i][0] + ux * (a + w / 2) + nx * (front + depth / 2), pts[i][1] + uz * (a + w / 2) + nz * (front + depth / 2), ux, uz, w / 2 - 0.03, depth / 2 - 0.03, true)) fillF(recs[recs.length - 1].rings[0]);
              a += w;
            }
            s = e + 0.6;
          }
        }
      }
    }
  }
  return placed;
}
// Rawalpindi's old city, plot by plot (REVIEW3 item 1). Machine footprints here are often whole merged blocks; they are cut along their long side into plots about as wide as the roofs read on Esri World Imagery
// (retrieved 9 Nov 2026; roughly 4 to 9 m), each plot with its own storeys and its own wall, so brick and stained render change house by house and the roofline steps. Storeys: art_direction.md section 5 (Gawalmandi 2 to 3 sourced [S23], Raja Bazaar 2 to 4 estimated);
// the shares below are estimates. Wall colours: the first four are the brief's Rawalpindi palette, the rest estimated. The street's trade is carried in the plot seed's quarter for the shop interiors (materials.js): cloth on Moti Bazaar
// (Express Tribune, "Moti Bazaar: A pearl losing its shine") and Ganj Mandi (unseenmarvelsofpakistan.blogspot.com/2021/06/famous-bazaars-of-rawalpindi.html, a blog, so low confidence), Kapra Bazaar (kapra = cloth); tins and sacks on Namak Mandi and Masala Bazaar (from the names);
// hardware and metalware on Lakkar and Bara Bazaar (Lakkar = timber; Bara from the same blog, low confidence). Anything else keeps a random one.
const PK_OLD = PK_SHOP[0];
function pkInOld(la, lo) { return lo > PK_OLD[0] && lo < PK_OLD[2] && la > PK_OLD[1] && la < PK_OLD[3]; }
const PK_OLD_WALLS = [["#a79b88", 30], ["#b9ae9a", 14], ["#8a5a44", 11], ["#7b4d3a", 8], ["#8f8b83", 10], ["#c3b8a4", 9], ["#d6cfbe", 7], ["#9a8f7d", 6], ["#a6ad9e", 3], ["#b6a58d", 2]].map(c => [lin(hexRgb(c[0])), c[1]]);
const PK_STREET_TRADE = [[/moti|kapra|cloth|bazaz/i, 0], [/ganj ?mandi/i, 0], [/namak|masala|kiryana|karyana|ghalla|sabzi|grain/i, 1], [/hardware|bartan|lakkar|bara ba[zj]|bara market/i, 2]];
function pkOldStoreys(areaM, s, shallow) {
  if (shallow) return s < 0.7 ? 1 : 2;                      // a shop built forward of the old house line
  if (areaM < 30) return s < 0.6 ? 1 : 2;
  if (areaM < 70) return s < 0.42 ? 2 : s < 0.85 ? 3 : 4;
  return s < 0.28 ? 2 : s < 0.72 ? 3 : s < 0.96 ? 4 : 5;
}
function pkClipRing(o, nx, nz, d, S) {                      // keep the side where n . p <= d, p in metres
  const out = [];
  for (let i = 0; i < o.length; i++) {
    const a = o[i], b = o[(i + 1) % o.length], da = (a[0] * nx + a[1] * nz) * S - d, db = (b[0] * nx + b[1] * nz) * S - d;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out.length >= 3 ? out : null;
}
function pkOldPlots(recs, S, latOf, lonOf, nameLines) {
  const streets = nameLines.map(nl => { for (const t of PK_STREET_TRADE) if (t[0].test(nl.en || "")) return { nl, trade: t[1] }; return null; }).filter(Boolean);
  const tradeAt = (x, z) => { let best = -1, bd = 26; for (const q of streets) { const nl = q.nl; if (x < nl.bb[0] - 26 || x > nl.bb[2] + 26 || z < nl.bb[1] - 26 || z > nl.bb[3] + 26) continue; for (let i = 0; i < nl.pts.length - 1; i++) { const d = segDistXY(x, z, nl.pts[i][0], nl.pts[i][1], nl.pts[i + 1][0], nl.pts[i + 1][1]); if (d < bd) { bd = d; best = q.trade; } } } return best; };
  const totalW = PK_OLD_WALLS.reduce((a, c) => a + c[1], 0);
  const wall = s => { let q = s * totalW; for (const c of PK_OLD_WALLS) { q -= c[1]; if (q <= 0) return c[0]; } return PK_OLD_WALLS[0][0]; };
  const dress = (r, shallow) => {
    const X = Math.round(r.cx * S * 3), Z = Math.round(r.cy * S * 5), s = hash2(X + 1, Z), s2 = hash2(Z + 9, X), s3 = hash2(X * 7, Z + 3);
    r.type = 1; r.floorH = 3.1; r.h = pkOldStoreys(r.areaM, s, shallow) * 3.1 + 0.9; r.dense = 1; r.packed = true;
    if (!r.hadCol) { const c = wall(s2), v = 0.88 + 0.22 * s3; r.color = [c[0] * v, c[1] * v, c[2] * v]; }
    const trade = tradeAt(r.cx * S, r.cy * S), fr = (s3 * 4) % 1;
    r.seed = trade < 0 ? s3 : (trade + 0.02 + 0.96 * fr) / 4;
  };
  const out = [];
  for (const r of recs) {
    const la = latOf(r.cy), lo = lonOf(r.cx);
    if (r.zone !== "pindi" || r.minh >= 1 || r.isMosque || r.canopy || r.name || r.colonial || r.mallShop || !pkInOld(la, lo) || !(r.fp || r.guessH) || (r.noShops && r.type !== 4) || (r.type === 4 && !r.fp)) { out.push(r); continue; }
    if (r.areaM < 110 || r.rings.length > 1 || r.o.length > 48) { const b0 = r.infill ? obbOf(r.o, S) : null; dress(r, b0 && b0.ev < 2.3); out.push(r); continue; }
    const b = obbOf(r.o, S); if (!b) { dress(r); out.push(r); continue; }
    const cu = b.cx * b.ux + b.cz * b.uz, cv = b.cx * b.vx + b.cz * b.vz, seed = hash2(Math.round(b.cx * 3), Math.round(b.cz * 3));
    const us = [-b.eu]; for (let i = 0, t = -b.eu; ; i++) { const w = 4.4 + 4.2 * hash2(i + 3, Math.round(seed * 9973)); t += w; if (t >= b.eu - 2.4 || us.length > 14) break; us.push(t); } us.push(b.eu);
    const vs = [-b.ev]; if (b.ev * 2 > 24) { const n = Math.min(3, Math.round(2 * b.ev / 13)); for (let i = 1; i < n; i++) vs.push(-b.ev + 2 * b.ev * i / n + (hash2(i, Math.round(seed * 773)) - 0.5) * 3); } vs.push(b.ev);
    let made = 0;
    for (let i = 0; i + 1 < us.length; i++) for (let j = 0; j + 1 < vs.length; j++) {
      let q = pkClipRing(r.o, b.ux, b.uz, cu + us[i + 1], S); if (q) q = pkClipRing(q, -b.ux, -b.uz, -(cu + us[i]), S); if (q) q = pkClipRing(q, b.vx, b.vz, cv + vs[j + 1], S); if (q) q = pkClipRing(q, -b.vx, -b.vz, -(cv + vs[j]), S);
      if (!q) continue;
      let ar = 0, cx = 0, cy = 0, minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
      for (let k = 0; k < q.length; k++) { const a = q[k], c = q[(k + 1) % q.length], cr = a[0] * c[1] - c[0] * a[1]; ar += cr; cx += (a[0] + c[0]) * cr; cy += (a[1] + c[1]) * cr; if (a[0] < minx) minx = a[0]; if (a[0] > maxx) maxx = a[0]; if (a[1] < miny) miny = a[1]; if (a[1] > maxy) maxy = a[1]; }
      ar /= 2; const areaM = Math.abs(ar) * S * S; if (areaM < 8) continue;
      const piece = Object.assign({}, r, { rings: [q], o: q, cx: cx / (6 * ar), cy: cy / (6 * ar), minx, miny, maxx, maxy, areaM, used: null, bi: null, noShops: r.noShops, dens: r.dens });
      dress(piece, false); out.push(piece); made++;
    }
    if (!made) { dress(r); out.push(r); }
  }
  recs.length = 0; for (const r of out) recs.push(r);
}
// A shop awning: a sloping sheet out from the wall, drawn on both sides (you drive past under them) with a short valance
function awning(M, q, seed) {
  const [ax, az, bx, bz, nx, nz, y, d, hex] = q, base = lin(hexRgb(hex)), light = base.map(v => Math.min(1, v * 1.65 + 0.06)), striped = hash2(Math.round(ax * 3), Math.round(az * 3)) < 0.55, y2 = y - 0.4 - d * 0.18;
  const W = Math.hypot(bx - ax, bz - az), n = Math.max(2, Math.min(4, Math.round(W / 0.7)));
  const f = (a, b, cc, dd, col, nn) => { const P = M.attr.position, Nn = M.attr.normal, U = M.attr.uv, C = M.attr.color, F = M.attr.facade, I = M.idx, v0 = M.vc; for (const p of [a, b, cc, dd]) { P.p3(p[0], p[1], p[2]); Nn.p3(nn[0], nn[1], nn[2]); U.p2(p[0], p[2]); C.p3(col[0], col[1], col[2]); F.p4(9.6, seed, 3.3, y); } const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [cc[0] - a[0], cc[1] - a[1], cc[2] - a[2]], dt = (e1[1] * e2[2] - e1[2] * e2[1]) * nn[0] + (e1[2] * e2[0] - e1[0] * e2[2]) * nn[1] + (e1[0] * e2[1] - e1[1] * e2[0]) * nn[2]; if (dt >= 0) { I.p3(v0, v0 + 1, v0 + 2); I.p3(v0, v0 + 2, v0 + 3); } else { I.p3(v0, v0 + 2, v0 + 1); I.p3(v0, v0 + 3, v0 + 2); } M.vc += 4; };
  const up = [nx * 0.3, 0.95, nz * 0.3], sag = t => y2 - 0.09 * Math.sin(t * Math.PI), at = t => [ax + (bx - ax) * t, az + (bz - az) * t];
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n, p = at(t0), q2 = at(t1), c = striped && i % 2 ? light : base, dark = c.map(v => v * 0.8), v0 = 0.26 + (i % 2 ? 0.07 : 0);
    const A = [p[0], y, p[1]], B = [q2[0], y, q2[1]], Bo = [q2[0] + nx * d, sag(t1), q2[1] + nz * d], Ao = [p[0] + nx * d, sag(t0), p[1] + nz * d], Bv = [Bo[0], Bo[1] - v0, Bo[2]], Av = [Ao[0], Ao[1] - v0, Ao[2]];
    f(A, B, Bo, Ao, c, up); f(A, Ao, Bo, B, dark, [-up[0], -up[1], -up[2]]);
    f(Ao, Bo, Bv, Av, c, [nx, 0, nz]); f(Ao, Av, Bv, Bo, dark, [-nx, 0, -nz]);
  }
}
// ------------------------------------------------------------------ Faisal Mosque precinct (REVIEW2 item 9)
// Plan read off Esri World Imagery, bbox 73.0340..73.0440 by 33.7255..33.7325 at 1200 x 840 px, retrieved 9 Nov 2026, a few metres of position error. Colours sampled from the same image.
// Dossier isb_national__faisal_mosque.json: terraced shrub lanes north and east, parking, round fountain, lawns. The long white block with dark window strips in front of the hall is in the Madain Project and Zameen photos, so it stays.
const pkFP = q => q.map(p => [73.034 + p[0] * 8.3333e-6, 33.7325 - p[1] * 8.3333e-6]);
const PK_FAISAL = {
  site: pkFP([[205, 175], [440, 130], [715, 75], [745, 100], [775, 225], [800, 290], [860, 470], [850, 535], [700, 565], [345, 625], [262, 612], [258, 520], [290, 470], [258, 330], [205, 285]]),
  dry: pkFP([[335, 490], [600, 440], [690, 510], [640, 555], [350, 612]]),
  platform: pkFP([[295, 285], [415, 235], [625, 195], [675, 365], [465, 405], [330, 405]]),
  pave: [pkFP([[645, 262], [668, 245], [745, 232], [770, 225], [798, 262], [760, 285], [668, 302], [645, 312]]), pkFP([[528, 392], [590, 385], [602, 432], [540, 442]])],
  parking: [pkFP([[800, 420], [862, 470], [850, 520], [815, 500]]), pkFP([[262, 520], [330, 510], [338, 600], [270, 606]]), pkFP([[205, 205], [265, 195], [272, 280], [212, 284]])],
  walks: [[pkFP([[575, 432], [640, 470], [690, 505], [735, 540]]), 9], [pkFP([[745, 110], [775, 225]]), 7], [pkFP([[800, 290], [850, 430]]), 7], [pkFP([[450, 180], [720, 130]]), 5], [pkFP([[460, 150], [715, 100]]), 5]],
  orchards: [pkFP([[605, 310], [640, 312], [668, 302], [760, 285], [800, 395], [695, 450], [600, 400]]), pkFP([[305, 415], [470, 405], [540, 430], [330, 480]])],
  shrubs: [pkFP([[448, 205], [720, 135]]), pkFP([[450, 168], [712, 112]]), pkFP([[458, 138], [706, 90]])],
  avenueEnd: [33.72758, 73.03983],
  sightline: [[73.03839, 33.73052], [73.03586, 33.72883], [73.0499, 33.7162], [73.05244, 33.71789]],   // from the hall out to 1.5 km down the avenue, 150 m either side of the line, so the mosque is seen from the carriageways although it lies a few degrees off the road's axis
};
function pkFaisalNear(S, TS, xOfLon, yOfLat) { return PK_FAISAL.site.some(p => { const x = xOfLon(p[0]) * S, z = yOfLat(p[1]) * S; return x > -700 && z > -700 && x < TS + 700 && z < TS + 700; }); }
function pkFaisalStroke(pts, w) { const L = [], R = []; for (let i = 0; i < pts.length; i++) { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]; let dx = b[0] - a[0], dz = b[1] - a[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; L.push([pts[i][0] - dz * w / 2, pts[i][1] + dx * w / 2]); R.push([pts[i][0] + dz * w / 2, pts[i][1] - dx * w / 2]); } return L.concat(R.reverse()); }
function pkFaisalPaint(splat, S, TS, xOfLon, yOfLat) {
  if (!pkFaisalNear(S, TS, xOfLon, yOfLat)) return;
  const toT = r => r.map(p => [xOfLon(p[0]), yOfLat(p[1])]), fill = (r, hex, a) => splat.fill([r], S, lin(hexRgb(hex)), a), toM = r => r.map(p => [xOfLon(p[0]) * S, yOfLat(p[1]) * S]), back = r => r.map(p => [p[0] / S, p[1] / S]);
  fill(toT(PK_FAISAL.site), "#5f6a45", 235);
  fill(toT(PK_FAISAL.dry), "#7d7355", 230);
  for (const r of PK_FAISAL.parking) fill(toT(r), "#6c6661", 245);
  for (const [pts, w] of PK_FAISAL.walks) fill(back(pkFaisalStroke(toM(pts), w)), "#a59d90", 245);
  for (const r of PK_FAISAL.pave) fill(toT(r), "#a89f92", 250);
}
function pkFaisalKerbs(M, S, TS, xOfLon, yOfLat) {
  if (!GG || !pkFaisalNear(S, TS, xOfLon, yOfLat)) return;
  const col = pkCol("#cfc8b8");
  for (const r of PK_FAISAL.pave) {
    const R = r.map(p => [xOfLon(p[0]) * S, yOfLat(p[1]) * S]);
    for (let i = 0; i < R.length; i++) {
      const a = R[i], b = R[(i + 1) % R.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / 6)), ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
      for (let k = 0; k < n; k++) { const u0 = L * k / n, u1 = L * (k + 1) / n, mx = a[0] + ux * (u0 + u1) / 2, mz = a[1] + uz * (u0 + u1) / 2; if (mx < 0 || mz < 0 || mx > TS || mz > TS) continue; const y = GG.at(mx, mz); pkBox(M, a[0], a[1], ux, uz, -uz, ux, u0, u1 + 0.05, -0.16, 0.16, y - 0.3, y + 0.16, col); }
    }
  }
}
// The tree wall on the last 1.5 km of the avenue becomes young replacement planting (art_direction.md: being replanted, [S25]), so the mosque stands at the end of the road; the precinct's own planting comes from the imagery
function pkFaisalTrees(trees, nameLines, S, TS, latOf, lonOf, xOfLon, yOfLat) {
  const G = new SegGrid(60), kx = 92500, ky = 111000, E0 = PK_FAISAL.avenueEnd; let axis = false;
  for (const nl of nameLines) {
    if (!nl.en || !/^faisal (avenue|masjid road)$/i.test(nl.en.trim())) continue;
    for (let i = 0; i < nl.pts.length - 1; i++) { const a = nl.pts[i], b = nl.pts[i + 1], la = latOf((a[1] + b[1]) / 2 / S), lo = lonOf((a[0] + b[0]) / 2 / S); if (Math.hypot((lo - E0[1]) * kx, (la - E0[0]) * ky) > 1550) continue; G.add(a[0], a[1], b[0], b[1], 0, 3, 0); axis = true; }
  }
  const near = pkFaisalNear(S, TS, xOfLon, yOfLat), sight = PK_FAISAL.sightline.map(p => [xOfLon(p[0]) * S, yOfLat(p[1]) * S]);
  if (!axis && !near && !sight.some(p => p[0] > -2500 && p[1] > -2500 && p[0] < TS + 2500 && p[1] < TS + 2500)) return;
  const toM = r => r.map(p => [xOfLon(p[0]) * S, yOfLat(p[1]) * S]), inM = (x, z, r) => pointInRingXY(x, z, r), site = near ? toM(PK_FAISAL.site) : null, plat = near ? toM(PK_FAISAL.platform) : null, hard = near ? PK_FAISAL.pave.concat(PK_FAISAL.parking).map(toM) : [], orch = near ? PK_FAISAL.orchards.map(toM) : [];
  const a = trees.a; let w = 0;
  for (let i = 0; i < trees.n; i += 4) {
    const x = a[i], z = a[i + 1], rot = a[i + 2]; let v = a[i + 3];
    if (near && (inM(x, z, plat) || hard.some(r => inM(x, z, r)))) continue;
    if (near && inM(x, z, site) && !orch.some(r => inM(x, z, r)) && hash2(Math.round(x), Math.round(z * 3)) > 0.3) continue;
    const inSight = sight && inM(x, z, sight);
    if (inSight && hash2(Math.round(x * 7), Math.round(z * 5)) < 0.25) continue;
    if (inSight || (axis && G.nearestSeg(x, z, 42))) v = Math.floor(v / 10) * 10 + 0.36 + 0.12 * hash2(Math.round(x * 3), Math.round(z));
    a[w] = x; a[w + 1] = z; a[w + 2] = rot; a[w + 3] = v; w += 4;
  }
  trees.n = w;
  if (!near) return;
  for (const r of orch) {
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9; for (const p of r) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < z0) z0 = p[1]; if (p[1] > z1) z1 = p[1]; }
    for (let x = x0; x < x1; x += 26) for (let z = z0; z < z1; z += 26) { const h = hash2(Math.round(x), Math.round(z)), px = x + (h - 0.5) * 10, pz = z + (hash2(Math.round(z), Math.round(x)) - 0.5) * 10; if (px > 0 && pz > 0 && px < TS && pz < TS && inM(px, pz, r)) trees.p4(px, pz, h * 6.283, 10 + 0.8 + 0.5 * h); }
  }
  for (const r of PK_FAISAL.shrubs) { const P = toM(r), L = Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]); for (let s = 4; s < L; s += 9) { const t = s / L, x = P[0][0] + (P[1][0] - P[0][0]) * t, z = P[0][1] + (P[1][1] - P[0][1]) * t; if (x > 0 && z > 0 && x < TS && z < TS) trees.p4(x, z, s, 10 + 0.3 + 0.12 * hash2(Math.round(x), 7)); } }
}
// ------------------------------------------------------------------ Pakistan facade kits (build/pk/REVIEW.md items 7, 13, 14)
// The kit travels in the facade type: 3.03 Islamabad sector house, 3.06 Bahria, 3.09 DHA, 3.12 colonial brick, 3.15 Murree house, 3.18 Murree half-timbered (materials.js PK_KIT_*).
// Bahria and DHA share the "society" zone: the nearest named place in build/pk/research/housing_societies.json decides. 0 Bahria, 1 DHA
const PK_SOC = [[33.568543, 73.116879, 0], [33.558172, 73.120811, 0], [33.55325, 73.11434, 0], [33.549863, 73.133108, 0], [33.55534, 73.13078, 0], [33.55582, 73.13741, 0], [33.530822, 73.117963, 0], [33.501268, 73.087263, 0], [33.53791, 73.10741, 0], [33.52662, 73.09317, 0], [33.51593, 73.11913, 0], [33.50348, 73.10201, 0], [33.50009, 73.09259, 0], [33.49126, 73.09741, 0], [33.49588, 73.06582, 0], [33.50448, 73.07633, 0], [33.4877, 73.07527, 0], [33.50098, 73.11121, 0], [33.687718, 73.213988, 0], [33.54476, 73.09367, 1], [33.51704, 73.09891, 1], [33.51085, 73.09236, 1], [33.52726, 73.15365, 1], [33.53649, 73.13197, 1], [33.53181, 73.13092, 1], [33.52485, 73.14542, 1], [33.52159, 73.15637, 1], [33.51957, 73.16397, 1], [33.5258, 73.17751, 1], [33.53356, 73.17904, 1], [33.49928, 73.14535, 1], [33.521614, 73.077369, 1]];
function pkSociety(la, lo) { let b = 1e18, k = 0; for (const p of PK_SOC) { const dx = (p[1] - lo) * 0.83, dy = p[0] - la, d = dx * dx + dy * dy; if (d < b) { b = d; k = p[2]; } } return k; }
const PK_DHA_WALLS = ["#ecebe6", "#e4e3de", "#d9d8d3", "#f0efe9"];
// Murree's Mall Road, OpenStreetMap way 288854889 (lat, lon)
const PK_MURREE_MALL = [[33.90324, 73.39068], [33.903748, 73.390748], [33.904053, 73.390995], [33.904289, 73.391247], [33.904667, 73.391644], [33.904747, 73.391706], [33.904877, 73.391891], [33.905021, 73.392049], [33.905319, 73.392178], [33.905475, 73.392296], [33.905613, 73.392419], [33.905778, 73.392786], [33.905827, 73.393076], [33.905829, 73.393146], [33.906027, 73.393309], [33.906083, 73.393363], [33.906179, 73.39354], [33.906254, 73.393693], [33.906343, 73.393757], [33.90647, 73.393913], [33.906604, 73.394047], [33.906723, 73.394105], [33.906771, 73.394132], [33.906839, 73.394163], [33.906941, 73.394235]];
// A road feature in the tile often runs on past the Mall, so it is cut where it joins and leaves
// Old-city streets of Rawalpindi. OpenStreetMap (checked 9 Nov 2026): Liaqat Road (ways 230824100, 230824103) and Ganj Mandi Road (236165577, 236165578) carry no width or lanes tag,
// and no barrier or median object is mapped between the two one-way ways, which lie about 8.7 m apart (centre lines). Dawn, 16 Nov 2014 (dawn.com/news/1144847): Liaquat Road had shrunk to eight or nine feet behind
// shopkeepers and vendors. Zameen, 9 Feb 2022, mentions greenbelts on the Murree Road to Fawara Chowk section, position not stated. Overture footprints put the walls 25 to 33 m apart on Ganj Mandi Road.
const PK_PAIR_W = 5.2, PK_PAIR_PAVE = 4.85;
// So: no median, one 5.2 m lane each way (an estimate) meeting on the centre line, the building line left where the data has it, and the strip between kerb and wall an encroached pavement.
// Measured since then with a metre ruler laid across the street on Esri World Imagery (retrieved 9 Nov 2026, about 0.32 m per pixel; a few metres of error): Ganj Mandi Road about 15 to 22 m wall to wall with 10 to 12 m of carriageway; Namak Mandi Bazaar 11 to 15 m wall to wall;
// Liaquat Road south-east of Fawara Chowk 18 to 22 m. Dawn, 16 Nov 2014, gives 90 ft for Raja Bazaar Road and 70 ft for Iqbal Road as their stated widths (right of way before encroachment), which is more than the built width on the imagery.
// Per street below: the carriageway width each way, then the pavement each side. Both are estimates from those readings.
const PK_OLD_STREETS = [
  { w: 3.8, pave: 2.6, pts: [[73.05566, 33.61647], [73.05538, 33.61313]] },    // Namak Mandi Bazaar
  { w: 5.2, pave: 3.4, pts: [[73.05059, 33.61653], [73.05519, 33.61309]] },    // Ganj Mandi Road
  { w: 5.2, pave: 4.85, pts: [[73.05556, 33.61284], [73.05875, 33.61]] },      // Liaquat Road, south-east of Fawara Chowk
];
function pkPairWidth(la, lo) {
  const k = Math.cos(la * Math.PI / 180);
  for (const q of PK_OLD_STREETS) for (let i = 0; i + 1 < q.pts.length; i++) { const [ax, ay] = q.pts[i], [bx, by] = q.pts[i + 1], dx = (bx - ax) * k, dy = by - ay, px = (lo - ax) * k, py = la - ay, t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy))); if (Math.hypot(px - dx * t, py - dy * t) * 111000 < 32) return q; }
  return { w: PK_PAIR_W, pave: PK_PAIR_PAVE };
}
function pkBazaarPairs(feats, S, latOf, lonOf) {
  const C = [], MAXD = 21 / S, key = q => Math.round(q[0] * 4) + ":" + Math.round(q[1] * 4), moved = new Map();
  // A roundabout is one-way too and its far side runs the opposite way within 21 m, so the pairing below squeezed the ring out of shape and pkChowks no longer found it (Fawara Chowk lost its island). Rings stay as mapped, and so do the vertices where arms join them.
  const ringF = new Set(), ringK = new Set();
  for (const c of pkChowks(feats.map(F => Object.assign({}, F, { el: F.pts.map(() => 0) })), S)) for (const j of c.lines) { ringF.add(feats[j]); for (const q of feats[j].pts) ringK.add(key(q)); }
  for (const F of feats) {
    if (ringF.has(F) || !F.oneway || F.ramp || F.bridge || F.tunnel || F.spec.c < 2 || F.spec.c > 5 || F.pts.length < 2 || (F.osm && (F.osm.mall || F.osm.lanes >= 2))) continue;   // a lanes=1 match is often a nearby tagged lane, and one lane is what this builds anyway
    const m = F.pts[F.pts.length >> 1], la = latOf(m[1]), lo = lonOf(m[0]);
    if (pkZone(la, lo) === "pindi" && pkInShop(la, lo)) { F.pts = densify(F.pts, 12 / S); C.push(F); }   // vertices can be 50 m apart: the two carriageways flare towards a junction, and a shift taken only at far-apart vertices left a wedge of median
  }
  if (C.length < 2) return;
  const partner = (F, p, tx, ty) => {
    let best = null, bd = MAXD;
    for (const G of C) {
      if (G === F) continue;
      for (let i = 0; i < G.pts.length - 1; i++) {
        const a = G.pts[i], b = G.pts[i + 1]; let ex = b[0] - a[0], ey = b[1] - a[1]; const L = Math.hypot(ex, ey); if (L < 1e-6) continue; ex /= L; ey /= L;
        if (ex * tx + ey * ty > -0.6) continue;                                              // only a carriageway running the other way
        const t = Math.max(0, Math.min(L, (p[0] - a[0]) * ex + (p[1] - a[1]) * ey)), qx = a[0] + ex * t, qy = a[1] + ey * t, d = Math.hypot(p[0] - qx, p[1] - qy);
        if (d < bd) { bd = d; best = [qx, qy, d]; }
      }
    }
    return best;
  };
  for (const F of C) {
    const n = F.pts.length, sh = F.pts.map(() => [0, 0]); let len = 0, got = 0, sideV = 0;
    const mid = F.pts[n >> 1], PW = pkPairWidth(latOf(mid[1]), lonOf(mid[0]));
    for (let i = 0; i < n; i++) {
      const p = F.pts[i], a = F.pts[Math.max(0, i - 1)], b = F.pts[Math.min(n - 1, i + 1)]; let tx = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      len += l; const q = partner(F, p, tx, ty); if (!q) continue;
      got += l; const dx = q[0] - p[0], dy = q[1] - p[1], m = q[2] > 1e-6 ? Math.max(0, q[2] * S - PW.w) / 2 / S / q[2] : 0;
      sh[i][0] = dx * m; sh[i][1] = dy * m; sideV += dx * ty - dy * tx;                      // (ty, -tx) is the ribbon's left normal
    }
    if (got < 0.55 * len) continue;
    F.osm = Object.assign({}, F.osm || { m: 0 }, { W: PW.w, lanes: 1, pair: sideV > 0 ? -1 : 1, pave: PW.pave });
    for (let i = 0; i < n; i++) if (!ringK.has(key(F.pts[i]))) moved.set(key(F.pts[i]), sh[i]);
  }
  if (!moved.size) return;
  for (const F of feats) F.pts = F.pts.map(q => { const v = moved.get(key(q)); return v ? [q[0] + v[0], q[1] + v[1]] : q; });   // side streets keep meeting these vertices
}
function pkMallRoads(feats, latOf, lonOf) {
  const extra = [];
  for (const F of feats) {
    if (F.spec.c > 5 || F.bridge || F.tunnel || F.pts.length < 2) continue;
    const near = F.pts.map(q => pkMurreeMallDist(latOf(q[1]), lonOf(q[0])) < 7);
    if (!near.some(Boolean)) continue;
    const mall = o => Object.assign({ m: 0 }, o, { W: 5, lanes: 2, mall: 1 }), pieces = []; let i = 0;
    while (i < F.pts.length - 1) { const on = near[i] && near[i + 1]; let j = i + 1; while (j < F.pts.length - 1 && (near[j] && near[j + 1]) === on) j++; pieces.push([i, j, on]); i = j; }
    const first = pieces[0];
    for (const p of pieces.slice(1)) extra.push(Object.assign({}, F, { pts: F.pts.slice(p[0], p[1] + 1), osm: p[2] ? mall(F.osm) : F.osm }));
    F.pts = F.pts.slice(first[0], first[1] + 1); if (first[2]) F.osm = mall(F.osm);
  }
  for (const F of extra) feats.push(F);
}
function pkMurreeMallDist(la, lo) { if (la < 33.9 || la > 33.91 || lo < 73.387 || lo > 73.398) return 1e9; const kx = 92500, ky = 111000; let b = 1e9; for (let i = 0; i < PK_MURREE_MALL.length - 1; i++) { const A = PK_MURREE_MALL[i], B = PK_MURREE_MALL[i + 1], ax = (A[1] - lo) * kx, ay = (A[0] - la) * ky, dx = (B[1] - A[1]) * kx, dy = (B[0] - A[0]) * ky, t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))), d = Math.hypot(ax + dx * t, ay + dy * t); if (d < b) b = d; } return b; }
// The Mall in Lahore, found by name; only the stretch through the old public buildings takes the brick kit (see pkFacadeKits)
function pkLahoreMall(nameLines, latOf, lonOf, S) {
  const G = new SegGrid(40), RE = /^(the\s+|upper\s+)?mall(\s+road)?$|^shahrah[- ]e[- ]quaid/i; let any = false;
  for (const nl of nameLines) {
    if (!nl.en || !RE.test(nl.en.trim())) continue;
    const q = nl.pts[nl.pts.length >> 1], la = latOf(q[1] / S), lo = lonOf(q[0] / S); if (la < 31.53 || la > 31.58 || lo < 74.295 || lo > 74.38) continue;
    any = true; for (let i = 0; i < nl.pts.length - 1; i++) G.add(nl.pts[i][0], nl.pts[i][1], nl.pts[i + 1][0], nl.pts[i + 1][1], 0, 3, 0);
  }
  return any ? (x, z, r) => !!G.nearestSeg(x, z, r) : null;
}
// Terraced shops along both sides of Murree's Mall wherever the map shows open ground, and the map's own buildings on it take shops below
function pkMallTerrace(recs, S, E, lines, roadGrid, latOf, lonOf, bColl) {
  if (!lines.some(L => L.osm && L.osm.mall)) return 0;
  const near = recs.filter(r => r.minh < 1 && r.zone === "murree" && pkMurreeMallDist(latOf(r.cy), lonOf(r.cx)) < 45);
  for (const r of near) {
    if (r.isMosque || r.canopy || r.h > 26) continue;
    for (let i = 0; i < r.o.length; i++) { const a = r.o[i], b = r.o[(i + 1) % r.o.length]; if (pkMurreeMallDist(latOf((a[1] + b[1]) / 2), lonOf((a[0] + b[0]) / 2)) < 11) { r.mallShop = 1; r.retail = 1; break; } }
  }
  const hit = (x, z, m) => near.some(r => x > r.minx * S - m && x < r.maxx * S + m && z > r.miny * S - m && z < r.maxy * S + m);
  let placed = 0;
  for (const L of lines) {
    if (!L.osm || !L.osm.mall) continue;
    const W = roadDims(L)[0], pts = L.pts.map(q => [q[0] * S, q[1] * S]), n = pts.length, cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[n - 1]; if (total < 14) continue;
    const at = s => { let i = 0; while (i < n - 2 && cum[i + 1] < s) i++; const t = (s - cum[i]) / Math.max(1e-6, cum[i + 1] - cum[i]); let dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1]; const l = Math.hypot(dx, dz) || 1; return { x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, z: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t, ux: dx / l, uz: dz / l }; };
    for (const side of [1, -1]) for (let s = 3, k = 0; s < total - 4; k++) {
      const h = hash2(k * 7 + Math.round(pts[0][0]), side + 5), h2 = hash2(k * 13 + 3, Math.round(pts[0][1]) + side), hu = 2.6 + h * 1.8, d = 7 + h2 * 3, off = W / 2 + 2.4 + d / 2;
      if (h2 < 0.11) { s += 3.2; continue; }                                             // a stair lane between the shops
      const c = at(s + hu), nx = c.uz * side, nz = -c.ux * side, cx = c.x + nx * off, cz = c.z + nz * off, ux = c.ux, uz = c.uz;
      const corner = (a, b) => [cx + ux * a * hu + nx * b * d / 2, cz + uz * a * hu + nz * b * d / 2];
      const pts4 = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
      let good = !hit(cx, cz, Math.max(hu, d / 2) * 0.72);
      for (const q of pts4) if (hit(q[0], q[1], 0.6) || roadGrid.clear(q[0], q[1], 10) < 0.6) good = false;
      const inT = pts4.every(q => q[0] > 2 && q[1] > 2 && q[0] < E * S - 2 && q[1] < E * S - 2);
      if (!good || !inT) { s += 2.2; continue; }
      let ring = pts4.map(q => [q[0] / S, q[1] / S]), sg = 0; for (let i = 0; i < 4; i++) { const p = ring[i], q = ring[(i + 1) % 4]; sg += p[0] * q[1] - q[0] * p[1]; } if (sg < 0) ring = ring.reverse();
      let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9; for (const q of ring) { if (q[0] < minx) minx = q[0]; if (q[0] > maxx) maxx = q[0]; if (q[1] < miny) miny = q[1]; if (q[1] > maxy) maxy = q[1]; }
      const seed = hash2(Math.round(cx * 3), Math.round(cz * 7)), fl = 2 + (h > 0.62 ? 1 : 0), tin = lin(hexRgb(PK_TIN[Math.floor(h * 89) % PK_TIN.length])), wall = PK_WALLS.murree[Math.floor(seed * 89) % PK_WALLS.murree.length];
      const rec = { rings: [ring], o: ring, h: fl * 3 + 2.2, minh: 0, type: 3, color: lin(hexRgb(wall)), seed, floorH: 3, cx: (minx + maxx) / 2, cy: (miny + maxy) / 2, minx, miny, maxx, maxy, areaM: 4 * hu * d / 2, isMosque: false, canopy: false, retail: 1, used: null, bi: null, kind: "", roofShape: h > 0.5 ? "hipped" : "gabled", roofH: 0, roofCol: tin, name: "", guessH: false, fp: 1, dense: 0, packed: false, zone: "murree", dens: 0.3, mallShop: 1, frontP: [c.x, c.z] };
      recs.push(rec); near.push(rec);
      const flat = []; for (const q of ring) flat.push(lonOf(q[0]), latOf(q[1])); bColl.push([flat]);
      placed++; s += 2 * hu + 0.06;
    }
  }
  return placed;
}
// Jinnah Super, the F-7 markaz (REVIEW2 item 13). Outline read from Esri World Imagery, bbox 73.0525..73.0600 by 33.7180..33.7235 at 1200 x 880 px, retrieved 9 Nov 2026 (OSM landuse=retail w8083926).
// Heights are hand-set. Safa Gold Mall (OSM w550467940): eight floors (zameen.com/blog/comparison-best-shopping-malls-islamabad.html), and the same image's shadow is the longest in the markaz.
// The rest: listings describe triple-storey units and basement, ground and three floors (zameen.com, F-7 Markaz listings); the shadows in the image, against the G+1 houses beside them, read about 12 m for the rows and about 24 m
// for the large block south of the parking, so those two are estimates. Parking plazas on the north and south sides were reported in 2015 (tribune.com.pk/story/891704).
const pkJP = q => q.map(p => [33.7235 - p[1] * 6.25e-6, 73.0525 + p[0] * 6.25e-6]);
const PK_JINNAH = pkJP([[405, 440], [490, 385], [590, 350], [640, 320], [870, 230], [1045, 330], [1040, 400], [770, 500], [700, 560], [640, 640], [480, 640], [405, 540]]);
function pkInJinnahSuper(la, lo) {
  if (la < 33.7195 || la > 33.7222 || lo < 73.055 || lo > 73.0592) return false;
  let c = false; for (let i = 0, j = PK_JINNAH.length - 1; i < PK_JINNAH.length; j = i++) { const a = PK_JINNAH[i], b = PK_JINNAH[j]; if ((a[1] > lo) !== (b[1] > lo) && la < (b[0] - a[0]) * (lo - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c;
}
// The market's main blocks, traced from the same image (the map has only scattered footprints here): image pixels, then storeys (see the note above for where the storeys come from)
const PK_JINNAH_BLOCKS = [
  [[[450, 437], [510, 410], [547, 405], [580, 450], [567, 473], [523, 505], [480, 480]], 8, "Safa Gold Mall"],
  [[[575, 533], [657, 493], [717, 543], [640, 597], [607, 583]], 6], [[[707, 500], [737, 490], [757, 537], [730, 557]], 4], [[[407, 527], [445, 508], [485, 557], [445, 580]], 4],
  [[[495, 577], [557, 547], [577, 563], [567, 630], [513, 638]], 3], [[[570, 410], [593, 380], [627, 390], [607, 413], [580, 423]], 4], [[[625, 345], [665, 330], [745, 410], [710, 450]], 4],
  [[[690, 340], [850, 280], [880, 330], [735, 400]], 3], [[[840, 395], [1010, 325], [1030, 370], [870, 440]], 3], [[[720, 470], [870, 395], [885, 430], [745, 510]], 3], [[[880, 220], [950, 195], [1000, 290], [930, 320]], 3],
];
function pkJinnahBlocks(recs, S, E, xOfLon, yOfLat, lonOf, latOf, bColl) {
  if (xOfLon(73.0592) < 0 || xOfLon(73.055) > E || yOfLat(33.7195) < 0 || yOfLat(33.7222) > E) return;
  const made = [];
  for (const [px, fl, name] of PK_JINNAH_BLOCKS) {
    let ring = pkJP(px).map(p => [xOfLon(p[1]), yOfLat(p[0])]);
    if (!ring.every(q => q[0] > 0 && q[1] > 0 && q[0] < E && q[1] < E)) continue;
    let area = 0, cx = 0, cy = 0, minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length], cr = a[0] * b[1] - b[0] * a[1]; area += cr; cx += (a[0] + b[0]) * cr; cy += (a[1] + b[1]) * cr; if (a[0] < minx) minx = a[0]; if (a[0] > maxx) maxx = a[0]; if (a[1] < miny) miny = a[1]; if (a[1] > maxy) maxy = a[1]; }
    area /= 2; cx /= 6 * area; cy /= 6 * area; if (area < 0) ring = ring.reverse();
    const seed = hash2(Math.round(cx * 3), Math.round(cy * 7));
    made.push({ rings: [ring], o: ring, h: fl * 3.6 + 1, minh: 0, type: 1, color: lin(hexRgb("#c9c3b4")), seed, floorH: 3.6, cx, cy, minx, miny, maxx, maxy, areaM: Math.abs(area) * S * S, isMosque: false, canopy: false, retail: 1, used: null, bi: null, kind: "", roofShape: null, roofH: 0, roofCol: null, name: name || "", guessH: false, fp: 1, dense: 1, packed: false, zone: "blue", dens: 0.4, markFl: fl, hadCol: true });
    const flat = []; for (const q of ring) flat.push(lonOf(q[0]), latOf(q[1])); bColl.push([flat]);
  }
  if (!made.length) return;
  for (let i = recs.length - 1; i >= 0; i--) { const r = recs[i]; if (r.minh > 2 || r.isMosque) continue; if (made.some(m => r.cx > m.minx && r.cx < m.maxx && r.cy > m.miny && r.cy < m.maxy && pointInRingXY(r.cx, r.cy, m.o))) recs.splice(i, 1); }
  for (const m of made) recs.push(m);
}
function pkJinnahSuper(r, la, lo) {
  const near = (a, b, m) => Math.hypot((lo - b) * 92500, (la - a) * 111000) < m, h = hash2(Math.round(r.cx * 5), Math.round(r.cy * 3));
  let fl = r.markFl || 3 + (h < 0.55 ? 1 : 0), fh = 3.6;                               // G+2 or G+3
  if (near(33.72053, 73.05551, 42)) { fl = 8; fh = 4.9; }                             // Safa Gold Mall: tall retail floors, set so the height agrees with its shadow
  else if (!r.markFl && near(33.72011, 73.05646, 48)) fl = 6;
  r.type = fl >= 6 ? 2 : 1; r.floorH = fh; r.h = fl * fh + 1; r.retail = 1; r.dense = 1; r.guessH = false; r.kit = 0; r.bazaar = 0;
  r.color = lin(hexRgb(fl >= 8 ? "#d6d1c4" : PK_WALLS.blue[Math.floor(r.seed * 89) % PK_WALLS.blue.length]));
}
// A house's own place on its plot (REVIEW2 item 12): the footprint is pulled in and moved along the line to the street, always inside the true footprint, so a row of plots stops being one straight wall
function pkSetback(r, S, E, roadGrid) {
  if (r.minx <= 0 || r.miny <= 0 || r.maxx >= E || r.maxy >= E || r.rings.length > 1 || r.areaM > 700) return;
  const q = roadGrid.nearest(r.cx * S, r.cy * S, 40, 2, 6); if (!q) return;
  let dx = r.cx * S - q.px, dz = r.cy * S - q.pz; const l = Math.hypot(dx, dz); if (l < 1) return; dx /= l; dz /= l;
  const k = 0.84 + 0.1 * hash2(Math.round(r.cy * 11) + 5, Math.round(r.cx * 7)), free = (1 - k) * Math.sqrt(r.areaM) * 0.45, sh = (2 * hash2(Math.round(r.cx * 13) + 3, Math.round(r.cy * 17)) - 1) * free / S;
  const m = p => [r.cx + (p[0] - r.cx) * k + dx * sh, r.cy + (p[1] - r.cy) * k + dz * sh], ring = r.o.map(m);
  r.o = ring; r.rings = [ring]; r.cx += dx * sh; r.cy += dz * sh; r.areaM *= k * k;
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9; for (const p of ring) { if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0]; if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1]; }
  r.minx = minx; r.miny = miny; r.maxx = maxx; r.maxy = maxy;
}
// Per-plot paint and storeys inside a house kit (estimated rules; art_direction.md section 5 gives G+1 plus a roof room as the norm)
function pkPlotVary(r, S, E, roadGrid) {
  const h1 = hash2(Math.round(r.cx * 5) + 1, Math.round(r.cy * 9)), h2 = hash2(Math.round(r.cy * 7) + 3, Math.round(r.cx * 3)), h3 = hash2(Math.round(r.cx * 13) + 7, Math.round(r.cy * 2));
  if (!r.hadCol) { const v = 0.84 + 0.26 * h1, w = (h2 - 0.5) * 0.14; r.color = [r.color[0] * v * (1 + w), r.color[1] * v, r.color[2] * v * (1 - w)]; }
  if (r.guessH) { const fh = r.floorH || 3.3, fl = Math.max(1, Math.round((r.h - 0.9) / fh)); r.h = Math.max(1, Math.min(3, fl + (h3 < 0.13 ? -1 : h3 > 0.8 ? 1 : 0))) * fh + 0.9; }
  if (r.villa) pkSetback(r, S, E, roadGrid);
}
function pkFacadeKits(recs, S, E, latOf, lonOf, lhrMall, roadGrid) {
  for (const r of recs) {
    if (r.minh >= 1 || r.isMosque || r.canopy) continue;
    const la = latOf(r.cy), lo = lonOf(r.cx), z = r.zone;
    if (r.markFl || pkInJinnahSuper(la, lo)) { pkJinnahSuper(r, la, lo); continue; }
    if (z === "murree" && r.type === 3) { const oldTown = pkMurreeMallDist(la, lo) < 110; r.kit = oldTown && r.seed < 0.72 ? 0.18 : 0.15; continue; }
    if (z === "islamabad" && r.type === 3 && r.h < 14 && !r.retail) { r.kit = 0.03; pkPlotVary(r, S, E, roadGrid); continue; }
    if (z === "society" && r.type === 3 && r.h < 14 && !r.retail) {
      const dha = pkSociety(la, lo) === 1; r.kit = dha ? 0.09 : 0.06;
      if (!r.hadCol) r.color = lin(hexRgb(dha ? PK_DHA_WALLS[Math.floor(r.seed * 89) % PK_DHA_WALLS.length] : PK_WALLS.society[Math.floor(r.seed * 89) % PK_WALLS.society.length]));
      pkPlotVary(r, S, E, roadGrid);
      continue;
    }
    // Old public frontage on The Mall, Charing Cross and the Museum stretch: brick with stone arches. Sources: Dawn dawn.com/news/1990880 (lined with trees), The News tns 1420394 (red-brick GPO, colonial and Indo-Saracenic)
    if (lhrMall && z === "lahore" && lo > 74.303 && lo < 74.345 && r.h < 26 && (lhrMall(r.cx * S, r.cy * S, 34) || r.o.some(q => lhrMall(q[0] * S, q[1] * S, 26)))) {
      const fl = Math.max(2, Math.min(4, Math.round((Math.max(r.h, 8) - 1) / 4.5)));
      // Three frontages, carried in the seed (materials.js PK_KIT_WALL): 0 red brick with stone arches, 1 plaster with pilasters and square-headed windows, 2 plaster with pointed arches and a deep eave.
      // Wikipedia (The Mall, Lahore): Neoclassical and Neo-Gothic in the west giving way to Indo-Saracenic in the east; Chughtai Library: the Museum and its cluster are red brick. Which plot takes which is an estimate by longitude and plot hash.
      const hv = hash2(Math.round(r.cx * 9) + 2, Math.round(r.cy * 5)), east = lo > 74.318, v = east ? (hv < 0.25 ? 0 : hv < 0.45 ? 1 : 2) : (hv < 0.55 ? 0 : hv < 0.85 ? 1 : 2);
      r.seed = (v + 0.02 + 0.96 * r.seed) / 3; r.mallV = v;
      if (!r.hadCol || r.type === 4) r.color = lin(hexRgb(v === 0 ? "#8a5a44" : v === 1 ? ["#d8cdb4", "#cfc3a8", "#e0d7c2"][Math.floor(hv * 89) % 3] : ["#c9b391", "#d3bf9e", "#bfa985"][Math.floor(hv * 89) % 3]));
      r.type = 3; r.floorH = 4.5 - (v === 1 ? 0.3 : 0); r.h = fl * r.floorH + 1.1; r.kit = 0.12; r.colonial = 1; r.retail = 0; r.noShops = 1; r.packed = false; r.dense = 0;
    }
    if ((z === "pindi" || z === "lahore") && (r.type === 1 || r.type === 2) && r.h < 34 && !r.colonial && (r.packed || pkInShop(la, lo))) { r.type = 1; r.bazaar = 1; }   // bazaar kit: small framed windows, grilles, stains, split air-conditioners (materials.js PK_BAZAAR)
  }
}
// The longest wall that faces a street close by
function pkRoadEdge(rec, S, roadGrid, minLen) {
  const o = rec.o; let e = null;
  for (let i = 0; i < o.length; i++) {
    const a = o[i], b = o[(i + 1) % o.length], ax = a[0] * S, az = a[1] * S, bx = b[0] * S, bz = b[1] * S, len = Math.hypot(bx - ax, bz - az); if (len < minLen || (e && len <= e.len)) continue;
    const ux = (bx - ax) / len, uz = (bz - az) / len; let nx = uz, nz = -ux; const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if (pointInRingXY((mx + nx * 0.6) / S, (mz + nz * 0.6) / S, o)) { nx = -nx; nz = -nz; }
    const r = roadGrid.nearest(mx + nx * 5, mz + nz * 5, 34, 2, 6); if (!r || r.elev) continue;
    const t = (r.px - mx) * nx + (r.pz - mz) * nz; if (t < 1) continue;
    e = { ax, az, ux, uz, nx, nz, len, mx, mz, d: t - r.hw };
  }
  return e;
}
function pkGrille(M, ax, az, bx, bz, y0, y1, col) { const L = Math.hypot(bx - ax, bz - az); if (L < 0.05) return; const nx = (bz - az) / L, nz = -(bx - ax) / L; quad(M, [ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], [nx, 0, nz], col, [0, 4], [L, 4], false); quad(M, [bx, y0, bz], [ax, y0, az], [ax, y1, az], [bx, y1, bz], [-nx, 0, -nz], col, [L, 4], [0, 4], false); }
const PK_GATES = ["#3a3b3d", "#1f1c19", "#3d4a3c", "#5a3a26", "#d3cfc4", "#2e3a4a", "#44403a"];   // gate paint, estimated
const PK_HOUSE = { 0.03: { pillar: "#9b9486", pv: 5, wall: "#d9d1bf", gate: "#3a3b3d", port: "#c9c3b4", tile: null }, 0.06: { pillar: "#efe6d2", pv: 0, wall: "#e6d9bf", gate: "#1f1c19", port: "#a8542f", tile: "#a8542f" }, 0.09: { pillar: "#6f7276", pv: 0, wall: "#e9e8e2", gate: "#3a3d41", port: "#f0efe9", tile: null } };
// Boundary wall, steel gate and grille, carport and a parked car. Heights are from the ground; the caller drapes the range
function pkCompound(rec, S, roadGrid, bldAt, M, cnt) {
  const K = PK_HOUSE[rec.kit]; if (!K || cnt.c >= 1200) return false;
  const b = obbOf(rec.o, S); if (!b) return false;
  const { ux, uz, vx, vz, eu, ev, cx, cz } = b, seed = rec.seed, dirs = [[ux, uz, eu], [-ux, -uz, eu], [vx, vz, ev], [-vx, -vz, ev]];
  let front = -1, dF = 1e9;
  for (let k = 0; k < 4; k++) { const [nx, nz, e] = dirs[k], mx = cx + nx * e, mz = cz + nz * e, r = roadGrid.nearest(mx + nx * 6, mz + nz * 6, 26, 2, 6); if (!r || r.elev) continue; const t = (r.px - mx) * nx + (r.pz - mz) * nz; if (t < 1) continue; if (t - r.hw < dF) { dF = t - r.hw; front = k; } }
  if (front < 0 || dF < 3.6) return false;
  cnt.c++;
  const gF = Math.max(2.8, Math.min(rec.kit === 0.06 ? 5.2 : 7.5, dF - 2.5)), gs = 1.3 + seed * 1.1, gap = k => k === front ? gF : gs;
  const u1 = eu + gap(0), u0 = -eu - gap(1), v1 = ev + gap(2), v0 = -ev - gap(3), P = (u, v) => [cx + u * ux + v * vx, cz + u * uz + v * vz];
  const sides = [[P(u1, v0), P(u1, v1)], [P(u0, v0), P(u0, v1)], [P(u0, v1), P(u1, v1)], [P(u0, v0), P(u1, v0)]];
  const pv = hash2(Math.round(rec.cx * 17) + 1, Math.round(rec.cy * 19)), pv2 = hash2(Math.round(rec.cy * 23) + 9, Math.round(rec.cx * 11));                  // this plot's own wall and gate
  const wallV = 0.82 + 0.3 * pv, wallC = pkCol(K.wall).map(v => Math.min(1, v * wallV)), pillar = pkCol(K.pillar), steel = pkCol(PK_GATES[Math.floor(pv2 * 89) % PK_GATES.length]), concrete = pkCol("#8d897e"), lowFront = rec.kit === 0.09 ? pv > 0.72 : pv > 0.3;
  const gateKind = pv2 < 0.34 ? 0 : pv2 < 0.67 ? 1 : 2;                               // 0 bars above waist height, 1 solid sheet, 2 horizontal slats
  const [nFx, nFz] = dirs[front];
  let pieces = 0, fx = 0, fz = 0, tG = 0, dux = 0, duz = 0, Lf = 0, ok0 = false;
  for (let s = 0; s < 4; s++) {
    const a = sides[s][0], c = sides[s][1], L = Math.hypot(c[0] - a[0], c[1] - a[1]); if (L < 1) continue;
    const dx = (c[0] - a[0]) / L, dz = (c[1] - a[1]) / L, isF = s === front, n = Math.max(2, Math.ceil(L / 1.2)), t0G = (seed < 0.5 ? 0.28 : 0.72) * L;
    if (isF) { fx = a[0]; fz = a[1]; dux = dx; duz = dz; tG = t0G; Lf = L; }
    const okA = [];
    for (let k = 0; k <= n; k++) { const t = k / n, x = a[0] + (c[0] - a[0]) * t, z = a[1] + (c[1] - a[1]) * t; let good = roadGrid.clear(x, z, 18) > 1.0; if (good) { const other = bldAt(x / S, z / S); if (other && other !== rec) good = false; } if (good && isF && Math.abs(t * L - t0G) < 2.1) good = false; okA.push(good); }
    let k0 = -1;
    for (let k = 0; k <= n + 1; k++) {
      const good = k <= n && okA[k];
      if (good && k0 < 0) k0 = k;
      if (!good && k0 >= 0) {
        const t0 = k0 / n, t1 = (k - 1) / n, hl = (t1 - t0) * L / 2;
        if (hl > 0.4) {
          const mx = a[0] + (c[0] - a[0]) * (t0 + t1) / 2, mz = a[1] + (c[1] - a[1]) * (t0 + t1) / 2;
          if (isF && lowFront) {
            wallBox(M, mx, mz, dx, dz, hl, 0.1, 0, 1.15, wallC);
            const a0x = mx - dx * hl, a0z = mz - dz * hl, b0x = mx + dx * hl, b0z = mz + dz * hl;
            pkGrille(M, a0x, a0z, b0x, b0z, 1.15, 2.25, steel);
            wallBox(M, mx, mz, dx, dz, hl, 0.03, 2.25, 2.3, steel);
            for (let q = 0, np = Math.max(1, Math.round(2 * hl / 3.3)); q <= np; q++) { const tt = -hl + 2 * hl * q / np; pkBox(M, mx + dx * tt, mz + dz * tt, dx, dz, -dz, dx, -0.2, 0.2, -0.2, 0.2, 0, 2.5, pillar, false, K.pv || 2); if (K.tile) pkBox(M, mx + dx * tt, mz + dz * tt, dx, dz, -dz, dx, -0.27, 0.27, -0.27, 0.27, 2.5, 2.62, pkCol(K.tile)); }
          } else wallBox(M, mx, mz, dx, dz, hl, 0.1, 0, isF ? 2.4 : 2.25, wallC);
          pieces++;
        }
        k0 = -1;
      }
    }
    if (isF && roadGrid.clear(a[0] + dx * t0G, a[1] + dz * t0G, 18) > 1.0) ok0 = true;
  }
  if (!pieces) return false;
  if (ok0) {
    // gate: dark steel, solid to waist height, bars above, between two heavier piers
    const gx = fx + dux * tG, gz = fz + duz * tG, Pg = (u, v) => [gx + dux * u - nFx * v, gz + duz * u - nFz * v];
    for (const sd of [-1, 1]) { const p = Pg(sd * 2.0, 0); pkBox(M, p[0], p[1], dux, duz, -duz, dux, -0.26, 0.26, -0.26, 0.26, 0, 2.6, pillar, false, K.pv || 2); if (K.tile) pkBox(M, p[0], p[1], dux, duz, -duz, dux, -0.33, 0.33, -0.33, 0.33, 2.6, 2.74, pkCol(K.tile)); }
    pkBox(M, gx, gz, dux, duz, -duz, dux, -1.74, 1.74, -0.03, 0.03, 0.06, 1.05, steel);
    if (gateKind === 2) { for (let q = 0; q < 6; q++) pkBox(M, gx, gz, dux, duz, -duz, dux, -1.74, 1.74, -0.03, 0.03, 1.1 + q * 0.21, 1.26 + q * 0.21, steel); }
    else if (gateKind === 1) pkBox(M, gx, gz, dux, duz, -duz, dux, -1.74, 1.74, -0.03, 0.03, 1.05, 2.26, steel);
    else { const a = Pg(-1.74, 0), c = Pg(1.74, 0); pkGrille(M, a[0], a[1], c[0], c[1], 1.05, 2.2, steel); pkBox(M, gx, gz, dux, duz, -duz, dux, -1.74, 1.74, -0.03, 0.03, 2.2, 2.26, steel); }
    // carport: a slab on two posts from the house to just short of the wall, over a paved pad
    if (gF >= 2.8) {
      const depth = gF - 0.3, hw = 2.75, port = pkCol(K.port), pad = Pg(0, 0), Y = 2.62, P2 = (u, v) => Pg(u, v);
      const [p0, p1, p2, p3] = [P2(-hw, 0.15), P2(hw, 0.15), P2(hw, gF - 0.05), P2(-hw, gF - 0.05)];
      quad(M, [p0[0], 0.03, p0[1]], [p1[0], 0.03, p1[1]], [p2[0], 0.03, p2[1]], [p3[0], 0.03, p3[1]], [0, 1, 0], concrete, [0, 2], [1, 2], false);
      pkBox(M, pad[0], pad[1], dux, duz, -nFx, -nFz, -hw, hw, 0.3, gF - 0.02, Y, Y + 0.16, port, true);
      if (K.tile) pkBox(M, pad[0], pad[1], dux, duz, -nFx, -nFz, -hw - 0.05, hw + 0.05, 0.25, gF - 0.02, Y + 0.16, Y + 0.24, pkCol(K.tile));
      for (const sd of [-1, 1]) { const p = P2(sd * (hw - 0.2), 0.42); pkBox(M, p[0], p[1], dux, duz, -nFx, -nFz, -0.09, 0.09, -0.09, 0.09, 0, Y, rec.kit === 0.09 ? steel : pillar); }
      if (seed > 0.18) { const carC = pkCarColour(hash2(Math.round(gx * 3), Math.round(gz * 3))); if (depth >= 4.6) { const c = P2(0.1, gF / 2 + 0.15); pkCar(M, c[0], c[1], -nFx, -nFz, dux, duz, 0.03, carC); } else if (depth >= 2.3) { const c = P2(0.1, Math.min(1.3, depth / 2 + 0.3)); pkCar(M, c[0], c[1], dux, duz, nFx, nFz, 0.03, carC); } }
    }
  }
  // a shade tree in a back corner
  rec.garden = [];
  for (const [u, v] of [[u0 + 0.9, v0 + 0.9], [u1 - 0.9, v1 - 0.9]]) { const [x, z] = P(u, v); if (roadGrid.clear(x, z, 20) < 2.5 || bldAt(x / S, z / S)) continue; rec.garden.push([x, z, 1]); if (seed < 0.4) break; }
  return true;
}
function pkDish(M, x, y, z, sx, sz) {
  pkStick(M, x, y, y + 0.72, z, 0.028, pkCol("#6f6f6a"));
  const col = pkCol("#d8d6cf"), P = M.attr.position, Nn = M.attr.normal, U = M.attr.uv, C = M.attr.color, I = M.idx, v0 = M.vc, ce = 0.62, se = 0.78, Nd = [sx * ce, se, sz * ce], a = [sz, 0, -sx], b = [Nd[1] * a[2] - Nd[2] * a[1], Nd[2] * a[0] - Nd[0] * a[2], Nd[0] * a[1] - Nd[1] * a[0]], cx = x + sx * 0.05, cy = y + 0.92, cz = z + sz * 0.05, r = 0.44, SEG = 10;
  const v = (px, py, pz) => { P.p3(px, py, pz); Nn.p3(Nd[0], Nd[1], Nd[2]); U.p2(0, 2); C.p3(col[0], col[1], col[2]); };
  v(cx - Nd[0] * 0.09, cy - Nd[1] * 0.09, cz - Nd[2] * 0.09);
  for (let i = 0; i < SEG; i++) { const t = i / SEG * 6.2832, ca = Math.cos(t) * r, sa = Math.sin(t) * r; v(cx + a[0] * ca + b[0] * sa, cy + a[1] * ca + b[1] * sa, cz + a[2] * ca + b[2] * sa); }
  for (let i = 0; i < SEG; i++) { const p = v0 + 1 + i, q = v0 + 1 + (i + 1) % SEG; I.p3(v0, p, q); I.p3(v0, q, p); }
  M.vc += SEG + 1;
  const stick = pkCol("#55554f"), L0 = [cx + Nd[0] * 0.5, cy + Nd[1] * 0.5, cz + Nd[2] * 0.5], c0 = [cx, cy, cz], dd = 0.02, e = [a[0] * dd, 0, a[2] * dd];
  quad(M, [c0[0] - e[0], c0[1], c0[2] - e[2]], [c0[0] + e[0], c0[1], c0[2] + e[2]], [L0[0] + e[0], L0[1], L0[2] + e[2]], [L0[0] - e[0], L0[1], L0[2] - e[2]], [0, 1, 0], stick, [0, 2], [1, 2], false);
}
// What a passer-by reads on the road-facing wall: balconies with grilles, Bahria's columned porch, DHA's projecting frame; a dish on the roof
function pkHouseDress(M, rec, S, roadGrid, cnt) {
  const K = rec.kit;
  if (K === 0.15 || K === 0.18) { pkHillHouse(M, rec, S, cnt); if (rec.mallShop) pkArcade(M, rec, S, roadGrid); return; }
  if (!K || K > 0.1 || cnt.h >= 2600) return;
  const gy = rec.gy || 0, fh = rec.floorH, floors = Math.round((rec.h - 0.9) / fh), seed = rec.seed;
  if (seed > 0.22) { const b = obbOf(rec.o, S); if (b) { const x = b.cx + b.ux * b.eu * (seed < 0.6 ? 0.62 : -0.62) + b.vx * b.ev * 0.55, z = b.cz + b.uz * b.eu * (seed < 0.6 ? 0.62 : -0.62) + b.vz * b.ev * 0.55; if (pointInRingXY(x / S, z / S, rec.o)) pkDish(M, x, gy + rec.h, z, 0, 1); } }
  const e = pkRoadEdge(rec, S, roadGrid, 5.5); if (!e) return;
  cnt.h++;
  const B = (u0, u1, n0, n1, a, b, c, under, v) => pkBox(M, e.mx, e.mz, e.ux, e.uz, e.nx, e.nz, u0, u1, n0, n1, a + gy, b + gy, c, under, v), L = e.len, at = (u, n) => [e.mx + e.ux * u + e.nx * n, e.mz + e.uz * u + e.nz * n];
  if (K === 0.03) {
    const slab = pkCol("#c8c0ae"), steel = pkCol("#2b2c2e");
    for (const uc of L >= 11 ? [-L * 0.25, L * 0.25] : [L * (seed < 0.5 ? 0.18 : -0.18)]) {
      if (floors < 2) break;
      const hw = Math.min(L * 0.2, 2.1), n1 = 1.05, y = fh;
      B(uc - hw, uc + hw, 0, n1, y - 0.14, y, slab, true);
      const a = at(uc - hw, n1), c = at(uc + hw, n1), s0 = at(uc - hw, 0.02), s1 = at(uc + hw, 0.02);
      pkGrille(M, a[0], a[1], c[0], c[1], y + gy, y + 1.05 + gy, steel); pkGrille(M, s0[0], s0[1], a[0], a[1], y + gy, y + 1.05 + gy, steel); pkGrille(M, s1[0], s1[1], c[0], c[1], y + gy, y + 1.05 + gy, steel);
      B(uc - hw, uc + hw, n1 - 0.025, n1 + 0.025, y + 1.05, y + 1.09, steel);
      B(uc - hw - 0.1, uc + hw + 0.1, 0, n1 + 0.1, y + fh - 0.5, y + fh - 0.38, slab, true);
    }
  } else if (K === 0.06) {
    const cream = rec.color.map(v => Math.min(1, v * 1.08)), tile = pkCol("#a8542f"), hw = Math.min(L * 0.3, 3.5), nS = 2, N1 = 1.9, H = 2.75, th = 0.17;
    for (let k = 0; k <= nS; k++) { const u = -hw + hw * k; B(u - th, u + th, N1 - th, N1 + th, 0, H, cream); B(u - th - 0.07, u + th + 0.07, N1 - th - 0.07, N1 + th + 0.07, H, H + 0.14, cream); }
    // a round arch between each pair of columns, built from short lengths
    for (let k = 0; k < nS; k++) { const a0 = -hw + hw * k, span = hw, ra = span / 2 - th, uc = a0 + span / 2, seg = 7; for (let i = 0; i < seg; i++) { const t0 = i / seg * Math.PI, t1 = (i + 1) / seg * Math.PI, c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1); const px = (ct, st, rr) => [e.mx + e.ux * (uc + ct * rr) + e.nx * (N1 - 0.14), H + 0.14 + st * rr + gy, e.mz + e.uz * (uc + ct * rr) + e.nz * (N1 - 0.14)]; const A0 = px(c0, s0, ra), B0 = px(c1, s1, ra), A1 = px(c0, s0, ra + 0.17), B1 = px(c1, s1, ra + 0.17); quad(M, A0, B0, B1, A1, [e.nx, 0, e.nz], cream, [0, 2], [1, 2], false); quad(M, B0, A0, A1, B1, [-e.nx, 0, -e.nz], cream, [0, 2], [1, 2], false); } }
    B(-hw - 0.25, hw + 0.25, 0, N1 + 0.3, H + 0.14 + hw / 2 - 0.05, H + 0.3 + hw / 2, cream, true);
    B(-hw - 0.32, hw + 0.32, 0, N1 + 0.42, H + 0.3 + hw / 2, H + 0.42 + hw / 2, tile);
  } else {
    const white = rec.color.map(v => Math.min(1, v * 1.06)), steel = pkCol("#33363a"), hw = Math.min(L * 0.3, 3.3), y0 = fh, y1 = Math.min(rec.h - 1.1, fh * 2), N1 = 0.95, t = 0.2;
    if (floors >= 2) { B(-hw, hw, 0, N1, y0 - t, y0, white, true); B(-hw, hw, 0, N1, y1, y1 + t, white, true); for (const sd of [-1, 1]) B(sd * hw - t / 2, sd * hw + t / 2, 0, N1, y0, y1, white); B(-hw + 0.1, hw - 0.1, N1 - 0.03, N1 + 0.01, y0, y0 + 1.0, steel); }
    B(-Math.min(L * 0.4, 3.6), Math.min(L * 0.4, 3.6), 0, 1.5, 2.85, 3.0, steel, true);
  }
}
// Murree: a stone-faced terrace on the downhill side of each house, with stair lanes between them
function pkHillHouse(M, rec, S, cnt) {
  if (!GG || rec.areaM < 30) return;
  const drop = rec.gy - rec.glow; if (drop < 0.7) return;
  const stone = pkCol(rec.seed < 0.5 ? "#8f8876" : "#7c7767"), coping = pkCol("#b5ae9e"), o = rec.o; let e = null, low = 1e9;
  for (let i = 0; i < o.length; i++) {
    const a = o[i], b = o[(i + 1) % o.length], ax = a[0] * S, az = a[1] * S, bx = b[0] * S, bz = b[1] * S, len = Math.hypot(bx - ax, bz - az); if (len < 2.5) continue;
    const ux = (bx - ax) / len, uz = (bz - az) / len; let nx = uz, nz = -ux; const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if (pointInRingXY((mx + nx * 0.6) / S, (mz + nz * 0.6) / S, o)) { nx = -nx; nz = -nz; }
    const g = GG.at(mx + nx * 1.6, mz + nz * 1.6); if (g < low) { low = g; e = { ux, uz, nx, nz, len, mx, mz }; }
  }
  if (!e) return;
  const y1 = rec.gy - 0.05, y0 = Math.min(low, rec.glow) - 1.2, dpt = 1.3 + rec.seed * 1.3, hl = e.len / 2 + 0.1;
  pkBox(M, e.mx, e.mz, e.ux, e.uz, e.nx, e.nz, -hl, hl, -0.05, dpt, y0, y1, stone, false, 5);
  pkBox(M, e.mx, e.mz, e.ux, e.uz, e.nx, e.nz, -hl - 0.05, hl + 0.05, dpt - 0.12, dpt + 0.06, y1, y1 + 0.12, coping);
  if (rec.seed > 0.4 && cnt.st < 500) {
    cnt.st++;
    const sd = rec.seed < 0.7 ? 1 : -1; let y = y1;
    for (let k = 0; k < 18 && y > low - 0.1; k++) {
      const u = sd * (hl + 0.06 + k * 0.34), n0 = 0.25, n1 = 1.35, g = GG.at(e.mx + e.ux * u + e.nx * 0.8, e.mz + e.uz * u + e.nz * 0.8);
      pkBox(M, e.mx, e.mz, e.ux, e.uz, e.nx, e.nz, Math.min(u, u + sd * 0.34), Math.max(u, u + sd * 0.34), n0, n1, Math.min(g, y - 0.18) - 0.6, y - 0.18, stone, false, 5);
      y -= 0.18; if (y <= g + 0.05) break;
    }
  }
}
// The Mall, Murree: a covered arcade along every shop wall, timber posts under a green-tin lean-to, with signs on the wall above it
function pkArcade(M, rec, S, roadGrid) {
  const o = rec.o, gy = rec.gy || 0, wood = pkCol("#5b4632"), floorC = pkCol("#8f897b"), tin = rec.roofCol || pkCol("#3f6b4a"), soff = pkCol("#a39a86");
  for (let i = 0; i < o.length; i++) {
    const a = o[i], b = o[(i + 1) % o.length], ax = a[0] * S, az = a[1] * S, bx = b[0] * S, bz = b[1] * S, len = Math.hypot(bx - ax, bz - az); if (len < 3.2) continue;
    const ux = (bx - ax) / len, uz = (bz - az) / len; let nx = uz, nz = -ux; const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if (pointInRingXY((mx + nx * 0.6) / S, (mz + nz * 0.6) / S, o)) { nx = -nx; nz = -nz; }
    const r = roadGrid.nearest(mx + nx * 3, mz + nz * 3, 10, 2, 6); if (!r || r.elev) continue;
    const t = (r.px - mx) * nx + (r.pz - mz) * nz; if (t < 0.5) continue;
    const dpt = Math.min(2.3, t - r.hw - 0.2); if (dpt < 1.1) continue;
    const hl = len / 2, B = (u0, u1, n0, n1, y0, y1, c, under, v) => pkBox(M, mx, mz, ux, uz, nx, nz, u0, u1, n0, n1, y0 + gy, y1 + gy, c, under, v);
    let low = gy; if (GG) for (const [uu, nn] of [[-hl, dpt], [0, dpt], [hl, dpt], [-hl, 0.02], [hl, 0.02]]) low = Math.min(low, GG.at(mx + ux * uu + nx * nn, mz + uz * uu + nz * nn));
    B(-hl, hl, 0.02, dpt, low - gy - 0.6, 0.12, floorC, false, 5);                      // the stone skirt runs down to the lowest ground under the arcade (REVIEW2 item 4)
    const nP = Math.max(1, Math.round(len / 3));
    for (let k = 0; k <= nP; k++) { const u = -hl + len * k / nP; B(u - 0.1, u + 0.1, dpt - 0.2, dpt, 0.12, 2.95, wood); B(u - 0.16, u + 0.16, dpt - 0.26, dpt + 0.06, 2.72, 2.95, wood); }
    B(-hl, hl, dpt - 0.22, dpt + 0.02, 2.82, 3.1, wood);
    B(-hl, hl, 0.02, dpt + 0.02, 3.0, 3.1, soff, true);
    const P = (u, n, y) => [mx + ux * u + nx * n, y + gy, mz + uz * u + nz * n];
    quad(M, P(-hl - 0.1, -0.02, 3.68), P(hl + 0.1, -0.02, 3.68), P(hl + 0.1, dpt + 0.32, 3.08), P(-hl - 0.1, dpt + 0.32, 3.08), [nx * 0.27, 0.96, nz * 0.27], tin, [0, 2], [1, 2], false);
  }
}
// The Mall's street surface runs from the carriageway to the shop fronts
function pkMallPave(M, lines, S, TH) {
  if (!TH) return;
  const col = pkCol("#8f897b"), stone = pkCol("#7c7767");
  for (const L of lines) {
    if (!L.osm || !L.osm.mall) continue;
    const W = roadDims(L)[0], pts = L.pts.map(q => [q[0] * S, q[1] * S]), n = pts.length, cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[n - 1], at = s => { let i = 0; while (i < n - 2 && cum[i + 1] < s) i++; let dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1]; const l = Math.hypot(dx, dz) || 1, t = Math.min(1, (s - cum[i]) / l); return { x: pts[i][0] + dx * t, z: pts[i][1] + dz * t, ux: dx / l, uz: dz / l }; };
    for (const side of [1, -1]) {
      const O = o => s => { const q = at(s), nx = q.uz * side, nz = -q.ux * side; return [q.x + nx * o, TH.road(q.x, q.z) + 0.05, q.z + nz * o]; }, A = O(W / 2 - 0.05), B = O(W / 2 + 5.6);
      for (let s = 0; s < total - 0.5; s += 2.5) {
        const s1 = Math.min(total, s + 2.5), p0 = B(s), p1 = B(s1); quad(M, A(s), A(s1), p1, p0, [0, 1, 0], col, [0, 0], [1, 0], false);
        // where the hill falls away from the pavement, a stone skirt down to the ground (REVIEW2 item 4)
        if (GG) { const g0 = GG.at(p0[0], p0[2]) - 0.5, g1 = GG.at(p1[0], p1[2]) - 0.5; if (Math.min(g0, g1) < Math.max(p0[1], p1[1]) - 0.3) { const q = at(s), nx = q.uz * side, nz = -q.ux * side; quad(M, p0, p1, [p1[0], g1, p1[2]], [p0[0], g0, p0[2]], [nx, 0, nz], stone, [0, 5], [s1 - s, 5], false); } }
      }
    }
  }
}
// Hill roads of Murree: steel railing on the outside of hairpins and where the ground falls away, on a stone wall; stone facing where the road is cut into the slope. Railing form is estimated (no published spec found)
function pkHillRails(M, lines, S, TS, TH, roadGrid, bldNear, latOf, lonOf) {
  if (!GG || !TH) return 0;
  const beam = pkCol("#9aa0a0"), post = pkCol("#6e7377"), stone = pkCol("#8a8473"), coping = pkCol("#b0a998"), CAP = 9000; let n = 0;
  for (const L of lines) {
    if (n >= CAP || L.spec.c < 2 || L.spec.c > 6 || L.bridge || L.tunnel || L.ramp || L.el.some(e => Math.abs(e) > 0.4)) continue;
    const mid = L.pts[L.pts.length >> 1]; if (pkZone(latOf(mid[1]), lonOf(mid[0])) !== "murree") continue;
    const W = roadDims(L)[0], pts = L.pts.map(q => [q[0] * S, q[1] * S]), N = pts.length, cum = [0], mall = L.osm && L.osm.mall, off = W / 2 + 0.7 + (SIDEWALK_CLASSES.has(L.cls) && !mall ? 1.25 : 0);
    for (let i = 1; i < N; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[N - 1]; if (total < 18) continue;
    const at = s => { const q = Math.max(0, Math.min(total, s)); let i = 0; while (i < N - 2 && cum[i + 1] < q) i++; let dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1]; const l = Math.hypot(dx, dz) || 1, t = Math.min(1, (q - cum[i]) / l); return { x: pts[i][0] + dx * t, z: pts[i][1] + dz * t, tx: dx / l, tz: dz / l }; };
    const STEP = 3, nS = Math.floor(total / STEP);
    for (const side of [1, -1]) {
      let prev = null, pu = 0;
      for (let k = 0; k <= nS && n < CAP; k++) {
        const s = k * STEP, q = at(s), nx = q.tz * side, nz = -q.tx * side, x = q.x + nx * off, z = q.z + nz * off;
        if (x < 0 || z < 0 || x > TS || z > TS) { prev = null; continue; }
        const A = at(s - 14), B = at(s + 14), cr = A.tx * B.tz - A.tz * B.tx, dt = A.tx * B.tx + A.tz * B.tz, turn = Math.abs(Math.atan2(cr, dt)), outer = nx * (B.tx - A.tx) + nz * (B.tz - A.tz) < 0, hair = turn > 0.6 && outer;
        const yR = TH.road(q.x, q.z), drop = yR - GG.at(q.x + nx * (W / 2 + 9), q.z + nz * (W / 2 + 9));
        const clear = roadGrid.clear(x, z, 6) > 0.35 && !bldNear(x / S, z / S, 1.8 / S), rail = clear && !mall && (hair || drop > 1.6), wall = clear && !mall && drop < -2;
        if (!rail && !wall) { prev = null; continue; }
        const cur = { x, z, y: yR, rail, wall }, u = pu + STEP;
        if (prev && prev.rail && rail) {
          const dx = x - prev.x, dz = z - prev.z, l = Math.hypot(dx, dz) || 1;
          const nO = [nx, 0, nz], Y0 = 0.5, Y1 = 0.82;
          quad(M, [prev.x, prev.y + Y0, prev.z], [x, yR + Y0, z], [x, yR + Y1, z], [prev.x, prev.y + Y1, prev.z], nO, beam, [0, 2], [1, 2], false);
          quad(M, [x, yR + Y0, z], [prev.x, prev.y + Y0, prev.z], [prev.x, prev.y + Y1, prev.z], [x, yR + Y1, z], [-nx, 0, -nz], beam, [0, 2], [1, 2], false);
          quad(M, [prev.x, prev.y + Y1, prev.z], [x, yR + Y1, z], [x + nx * 0.05, yR + Y1, z + nz * 0.05], [prev.x + nx * 0.05, prev.y + Y1, prev.z + nz * 0.05], [0, 1, 0], beam, [0, 2], [1, 2], false);
          if (drop > 0.8) {
            const by = GG.at(x + nx * 0.4, z + nz * 0.4) - 1, ay = GG.at(prev.x + nx * 0.4, prev.z + nz * 0.4) - 1, w = 0.18;
            quad(M, [prev.x + nx * w, ay, prev.z + nz * w], [x + nx * w, by, z + nz * w], [x + nx * w, yR - 0.02, z + nz * w], [prev.x + nx * w, prev.y - 0.02, prev.z + nz * w], nO, stone, [pu, 5], [u, 5], false);
            quad(M, [prev.x - nx * 0.1, prev.y + 0.02, prev.z - nz * 0.1], [x - nx * 0.1, yR + 0.02, z - nz * 0.1], [x + nx * (w + 0.04), yR + 0.02, z + nz * (w + 0.04)], [prev.x + nx * (w + 0.04), prev.y + 0.02, prev.z + nz * (w + 0.04)], [0, 1, 0], coping, [0, 2], [1, 2], false);
          }
          n++;
        }
        if (rail) box(M, x, z, q.tx, q.tz, 0.04, 0.04, yR - 0.1, yR + 0.8, post);
        if (prev && prev.wall && wall) {
          const hA = Math.min(3.4, Math.max(1.2, -drop * 0.55)), nI = [-nx, 0, -nz];
          quad(M, [x, yR - 0.05, z], [prev.x, prev.y - 0.05, prev.z], [prev.x, prev.y + hA, prev.z], [x, yR + hA, z], nI, stone, [u, 5], [pu, 5], false);
          quad(M, [prev.x, prev.y + hA, prev.z], [x, yR + hA, z], [x + nx * 0.3, yR + hA, z + nz * 0.3], [prev.x + nx * 0.3, prev.y + hA, prev.z + nz * 0.3], [0, 1, 0], coping, [0, 2], [1, 2], false);
          n++;
        }
        prev = cur; pu = u;
      }
    }
  }
  return n;
}
// Lahore's old public buildings: a stone pediment and pilasters on the wall facing the avenue (type 6 is plain stone in the shader)
function pkQuadF(M, a, b, c, d, n, col, uv0, uv1, ft, seed, fh, H) { quad(M, a, b, c, d, n, col, uv0, uv1, false); for (let i = 0; i < 4; i++) M.attr.facade.p4(ft, seed, fh, H); }
function pkColonialFront(Bm, rec, S, roadGrid) {
  const e = pkRoadEdge(rec, S, roadGrid, 11); if (!e) return;
  const stone = pkCol("#c9b89a"), seed = rec.seed, H = rec.h, fh = rec.floorH, hw = Math.min(e.len * 0.36, 9), ped = hw * 0.34, p = (u, n, y) => [e.mx + e.ux * u + e.nx * n, y, e.mz + e.uz * u + e.nz * n];
  const Q = (a, b, c, d, n) => pkQuadF(Bm, a, b, c, d, n, stone, [0, 0], [1, 0], 6, seed, fh, H);
  const Box = (u0, u1, n0, n1, y0, y1) => { Q(p(u0, n1, y0), p(u1, n1, y0), p(u1, n1, y1), p(u0, n1, y1), [e.nx, 0, e.nz]); Q(p(u0, n0, y1), p(u1, n0, y1), p(u1, n1, y1), p(u0, n1, y1), [0, 1, 0]); Q(p(u0, n1, y0), p(u0, n0, y0), p(u0, n0, y1), p(u0, n1, y1), [-e.ux, 0, -e.uz]); Q(p(u1, n0, y0), p(u1, n1, y0), p(u1, n1, y1), p(u1, n0, y1), [e.ux, 0, e.uz]); };
  Q(p(-hw, 0.3, H), p(hw, 0.3, H), p(0, 0.3, H + ped), p(0, 0.3, H + ped), [e.nx, 0, e.nz]);
  Q(p(hw, 0.0, H), p(-hw, 0.0, H), p(0, 0.0, H + ped), p(0, 0.0, H + ped), [-e.nx, 0, -e.nz]);
  // raked mouldings along the two slopes of the pediment
  for (const sd of [-1, 1]) { const a = p(sd * (hw + 0.2), 0.42, H - 0.05), b = p(0, 0.42, H + ped + 0.12), c = p(0, 0.42, H + ped + 0.34), d = p(sd * (hw + 0.2), 0.42, H + 0.17); Q(a, b, c, d, [e.nx, 0, e.nz]); Q(d, c, p(0, 0.0, H + ped + 0.34), p(sd * (hw + 0.2), 0.0, H + 0.17), [0, 1, 0]); }
  Box(-hw - 0.25, hw + 0.25, 0, 0.44, H - 0.5, H);
  for (let k = 0; k <= 3; k++) { const u = -hw + 2 * hw * k / 3; Box(u - 0.34, u + 0.34, 0, 0.3, 0.9, H - 0.5); Box(u - 0.48, u + 0.48, 0, 0.42, 0, 0.9); }
}
// Rooftop kit of art_direction.md section 5: black or white water tanks, a stair mumty, rebar left for the next floor (Rawalpindi), solar panels (Islamabad and the societies)
// Out: as roofItems; kind 2 round tank, 1 stair house, 6 rebar stub, 7 solar panel
function pkRoofItems(rec, S, out) {
  const { o, h, type, seed, zone } = rec;
  if (rec.colonial) return 0;
  let rot = 0, bl = 0;
  for (let i = 0; i < o.length; i++) { const a = o[i], b = o[(i + 1) % o.length]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l > bl) { bl = l; rot = Math.atan2(-(b[1] - a[1]), b[0] - a[0]); } }
  const want = [], R = zone === "pindi" || zone === "lahore";
  want.push(2); if (seed > 0.45 || rec.areaM > 150) want.push(2); if (rec.areaM > 320) want.push(2);
  if (h >= 7 && rec.areaM >= 70 && seed < 0.75) want.push(1);
  if (!R && seed > 0.5 && rec.areaM >= 90) { want.push(7); if (seed > 0.8) want.push(7); }
  if (rec.kit && rec.kit < 0.1 && rec.areaM >= 70) { if (want.indexOf(1) < 0) want.unshift(1); if (seed > 0.3) { want.push(7, 7); if (seed > 0.6) want.push(7, 7); } }
  const SZ = { 1: [2.6, 2.5, 2.4], 2: [1.15, 1.45, 1.15], 6: [0.07, 0.9 + seed * 0.7, 0.07], 7: [1.7, 0.08, 1.05] };
  const wallHex = linToHex(rec.color);
  let n = 0, salt = 0, cx0 = 0, cy0 = 0;
  for (const kind of want) {
    const [sx, sy, sz] = SZ[kind], margin = kind === 6 ? 0.3 : kind === 2 && rec.packed ? 0.75 : Math.max(sx, sz) * 0.75 + 0.4;
    for (let tries = 0; tries < 10; tries++) {
      salt++;
      let x = rec.minx + (rec.maxx - rec.minx) * hash2(Math.round(seed * 1e6) + salt * 7, salt * 13), y = rec.miny + (rec.maxy - rec.miny) * hash2(salt * 31, Math.round(seed * 1e6) + salt * 3);
      // rebar stands in small clusters, on the column lines of the floor not yet built
      if (kind === 6 && n > 0 && cx0) { x = cx0 + (hash2(salt, 3) - 0.5) * 5 / S; y = cy0 + (hash2(salt, 9) - 0.5) * 5 / S; }
      if (!pointInRingXY(x, y, o) || ringDist(x, y, o) * S < margin) continue;
      if (kind === 6 && !cx0) { cx0 = x; cy0 = y; }
      const col = kind === 2 ? (hash2(salt, Math.round(seed * 97)) < 0.62 ? 0x1f1f1f : 0xd9d9d2) : kind === 1 ? wallHex : kind === 6 ? 0x5a4436 : 0x1b2a44;
      out.p4(x * S, h, y * S, rot); out.p4(sx, sy, sz, kind); out.p1(col);
      n++; break;
    }
  }
  return n;
}
// Bazaar cables: bundled strands sagging between poles along the streets of the packed districts. Not on the Fawara Chowk to
// Dingi Khoi stretch of Raja Bazaar, where they were reported underground by 2026 (art_direction.md, S20, S21).
function pkNoWires(lat, lon) {
  // Fawara Chowk, Raja Bazaar and Moti Bazaar as located in build/pk/research/rawalpindi.json; Dingi Khoi itself is not located there
  const P = [[73.05528, 33.61306], [73.056339, 33.612309], [73.058367, 33.613926]], k = Math.cos(33.6 * Math.PI / 180);
  for (let i = 0; i < 2; i++) { const dx = (P[i + 1][0] - P[i][0]) * k, dy = P[i + 1][1] - P[i][1], px = (lon - P[i][0]) * k, py = lat - P[i][1], t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy))); if (Math.hypot(px - dx * t, py - dy * t) * 111000 < 60) return true; }
  return false;
}
function pkWires(VW, lines, S, TH, recs, latOf, lonOf) {
  const C = 60 / S, cov = new Map(), key = (i, j) => i * 4096 + j;
  for (const r of recs) if (r.minh < 2) { const k = key(Math.floor(r.cx / C), Math.floor(r.cy / C)); cov.set(k, (cov.get(k) || 0) + r.areaM); }
  const dense = (x, y) => { const gx = Math.floor(x / C), gy = Math.floor(y / C); let a = 0; for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) a += cov.get(key(gx + i, gy + j)) || 0; return a / (180 * 180) > 0.26; };
  const black = lin(hexRgb("#141312")), poleC = lin(hexRgb("#6d6a63"));
  let gaps = 0; const CAP = 460, CELL = 220, CC = 11, cg = new Map();
  for (const L of lines) {
    if (gaps >= CAP) break;
    if (L.spec.c < 3 || L.spec.c > 6 || L.bridge || L.tunnel || L.ramp) continue;
    if (L.el.some(e => Math.abs(e) > 0.4)) continue;
    const [W] = roadDims(L), pts = L.pts.map(q => [q[0] * S, q[1] * S]), n = pts.length, cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[n - 1]; if (total < 30) continue;
    const seed = hash2(Math.round(pts[0][0]), Math.round(pts[0][1])), side = seed < 0.5 ? 1 : -1, gap = 28 + seed * 8;
    const at = s => { let i = 0; while (i < n - 2 && cum[i + 1] < s) i++; const t = (s - cum[i]) / Math.max(1e-6, cum[i + 1] - cum[i]), dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1], l = Math.hypot(dx, dz) || 1, o = side * (W / 2 + 0.55), x = pts[i][0] + dx * t + dz / l * o, z = pts[i][1] + dz * t - dx / l * o; return [x, z, TH ? TH.road(x, z) : 0]; };
    let prev = null;
    for (let s = gap * 0.5; s < total && gaps < CAP; s += gap) {
      const q = at(s), ck = Math.floor(q[0] / CELL) * 4096 + Math.floor(q[1] / CELL), ok = (cg.get(ck) || 0) < CC && dense(q[0] / S, q[1] / S) && (() => { const zone = pkZone(latOf(q[1] / S), lonOf(q[0] / S)); return (zone === "pindi" || zone === "lahore") && !pkNoWires(latOf(q[1] / S), lonOf(q[0] / S)); })();
      if (!ok) { prev = null; continue; }
      box(VW, q[0], q[1], 1, 0, 0.09, 0.09, q[2], q[2] + 8.2, poleC);
      box(VW, q[0], q[1], 1, 0, 0.3, 0.26, q[2] + 5.8, q[2] + 6.5, black);        // the coil of slack wrapped on the pole
      if (prev) {
        const strands = 4 + Math.floor(hash2(Math.round(q[0]), Math.round(q[1])) * 5);
        for (let k = 0; k < strands; k++) {
          const h = hash2(k * 7 + Math.round(q[0] * 3), k * 11 + Math.round(q[1] * 3)), y0 = 4.4 + h * 3.2, y1 = 4.4 + hash2(k, Math.round(q[0])) * 3.2, sag = 0.3 + h * 0.9, dz = (h - 0.5) * 0.5;
          wireRun(VW, prev[0] + dz, prev[2] + y0, prev[1] - dz, q[0] + dz, q[2] + y1, q[1] - dz, sag, black);
        }
        gaps++; cg.set(ck, (cg.get(ck) || 0) + 1);
      }
      prev = q;
    }
  }
}
// One sagging cable as a thin strip, faced both ways
function wireRun(M, ax, ay, az, bx, by, bz, sag, col) {
  const SEG = 4, w = 0.026, P = M.attr.position, Nn = M.attr.normal, U = M.attr.uv, C = M.attr.color, I = M.idx;
  const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1, nx = dz / l, nz = -dx / l;
  for (let i = 0; i < SEG; i++) {
    const t0 = i / SEG, t1 = (i + 1) / SEG, y0 = ay + (by - ay) * t0 - sag * 4 * t0 * (1 - t0), y1 = ay + (by - ay) * t1 - sag * 4 * t1 * (1 - t1);
    const x0 = ax + dx * t0, z0 = az + dz * t0, x1 = ax + dx * t1, z1 = az + dz * t1, v0 = M.vc;
    P.p3(x0, y0 - w, z0); P.p3(x1, y1 - w, z1); P.p3(x1, y1 + w, z1); P.p3(x0, y0 + w, z0);
    for (let k = 0; k < 4; k++) { Nn.p3(nx * 0.4, 0.9, nz * 0.4); U.p2(0, 2); C.p3(col[0], col[1], col[2]); }
    I.p3(v0, v0 + 1, v0 + 2); I.p3(v0, v0 + 2, v0 + 3); I.p3(v0, v0 + 2, v0 + 1); I.p3(v0, v0 + 3, v0 + 2);
    M.vc += 4;
  }
}
// Roundabouts: one-way carriageways that close on themselves (OpenStreetMap splits the ring wherever an arm joins)
function pkChowks(lines, S) {
  const key = q => Math.round(q[0] * 4) + "," + Math.round(q[1] * 4), starts = new Map(), out = [], used = new Set();
  const lenOf = L => { let d = 0; for (let i = 1; i < L.pts.length; i++) d += Math.hypot(L.pts[i][0] - L.pts[i - 1][0], L.pts[i][1] - L.pts[i - 1][1]) * S; return d; };
  lines.forEach((L, i) => { if (L.oneway && L.spec.c <= 6 && !L.bridge && !L.tunnel && !L.ramp && L.el.every(e => Math.abs(e) < 0.4)) { L.lenM = lenOf(L); if (L.lenM < 280) { const k = key(L.pts[0]); let a = starts.get(k); if (!a) starts.set(k, a = []); a.push(i); } } });
  const walk = (start, i, ring, total, depth, seen) => {
    const L = lines[i]; if (total + L.lenM > 460) return null;
    const pts = ring.concat(L.pts.slice(ring.length ? 1 : 0)), e = L.pts[L.pts.length - 1];
    if (key(e) === start && pts.length >= 6) return { pts, lines: seen.concat(i) };
    if (depth >= 6) return null;
    for (const j of starts.get(key(e)) || []) { if (seen.includes(j) || j === i) continue; const r = walk(start, j, pts, total + L.lenM, depth + 1, seen.concat(i)); if (r) return r; }
    return null;
  };
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i]; if (used.has(i) || L.lenM === undefined || L.lenM >= 280) continue;
    const r = walk(key(L.pts[0]), i, [], 0, 0, []); if (!r) continue;
    let A = 0, P = 0, cx = 0, cz = 0; const m = r.pts.length;
    for (let k = 0; k < m; k++) { const a = r.pts[k], b = r.pts[(k + 1) % m], cr = (a[0] * b[1] - b[0] * a[1]) * S * S; A += cr; cx += (a[0] + b[0]) * S * cr; cz += (a[1] + b[1]) * S * cr; P += Math.hypot(b[0] - a[0], b[1] - a[1]) * S; }
    A /= 2; if (Math.abs(A) < 1) continue; cx /= 6 * A; cz /= 6 * A; A = Math.abs(A);
    const R0 = Math.sqrt(A / Math.PI), round = 4 * Math.PI * A / (P * P); if (round < 0.82 || R0 < 8 || R0 > 75) continue;
    let hw = 3; for (const j of r.lines) { used.add(j); hw = Math.max(hw, roadDims(lines[j])[0] / 2); }
    out.push({ x: cx, z: cz, r: R0 - hw - 0.35, lines: r.lines });
  }
  return out;
}
// The chowk kit of art_direction.md section 10 (estimated): a planted island inside a painted yellow and black kerb, a flag on a pole, one warden's box
function chowkIsland(M, c, y0, zone, fawara) {
  if (c.r < 2.2) return;
  const n = Math.max(14, Math.min(36, Math.round(c.r * 2.4))), green = lin(hexRgb("#5a7236")), top = y0 + 0.26, kerbV = zone === "murree" ? 0.8 : 1.2, kerbC = lin(hexRgb("#8f8b82"));
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a0 = i / n * 6.2832, a1 = (i + 1) / n * 6.2832, ca = Math.cos(a0), sa = Math.sin(a0), cb = Math.cos(a1), sb = Math.sin(a1), r = c.r, ri = r - 0.15, L = Math.hypot((cb - ca) * r, (sb - sa) * r);
    const A = [c.x + ca * r, c.z + sa * r], B = [c.x + cb * r, c.z + sb * r], Ai = [c.x + ca * ri, c.z + sa * ri], Bi = [c.x + cb * ri, c.z + sb * ri];
    quad(M, [A[0], y0 - 0.02, A[1]], [B[0], y0 - 0.02, B[1]], [B[0], top, B[1]], [A[0], top, A[1]], [(ca + cb) / 2, 0, (sa + sb) / 2], kerbC, [s, kerbV], [s + L, kerbV], false);
    quad(M, [A[0], top, A[1]], [B[0], top, B[1]], [Bi[0], top, Bi[1]], [Ai[0], top, Ai[1]], [0, 1, 0], kerbC, [s, kerbV], [s + L, kerbV], false);
    quad(M, [Ai[0], top + 0.01, Ai[1]], [Bi[0], top + 0.01, Bi[1]], [c.x, top + 0.24, c.z], [c.x, top + 0.24, c.z], [0, 1, 0], green, [0, 2], [1, 2], false);
    s += L;
  }
  const pole = lin(hexRgb("#c9cdd2")), box2 = lin(hexRgb("#b9b2a2")), roofW = lin(hexRgb("#3f4a55"));
  if (fawara) { pkBaraDari(M, c, top + 0.24); return; }
  box(M, c.x, c.z, 1, 0, 0.06, 0.06, top, top + 12, pole);
  if (c.r > 4) pkFlag(M, c.x + 0.05, c.z, top + 10.3, 1.7);
  const a = (c.x * 13.7 + c.z * 7.1) % 6.2832, wx = c.x + Math.cos(a) * Math.max(1.6, c.r * 0.55), wz = c.z + Math.sin(a) * Math.max(1.6, c.r * 0.55);
  if (c.r > 4.5) { box(M, wx, wz, 1, 0, 0.6, 0.6, top, top + 2.2, box2); box(M, wx, wz, 1, 0, 0.8, 0.8, top + 2.2, top + 2.36, roofW); }
}
// Ground under the built-up parts: concrete, packed earth and tile in the bazaars, lawn in the walled sectors and societies, paving in Blue Area
function pkGroundPaint(splat, pkCov, N, TS, S, latOf, lonOf) {
  const n = splat.n, a = splat.a, cell = TS / N, Z = new Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) Z[j * N + i] = pkZone(latOf((j + 0.5) * cell / S), lonOf((i + 0.5) * cell / S));
  const COL = { pindi: ["#7a776f", "#6f6657", "#87847c", "#6c6961"], lahore: ["#7a776f", "#6f6657", "#87847c", "#6c6961"], rural: ["#8f7c60", "#857257", "#8f7c60", "#7a6a52"], murree: ["#5f5642", "#6b5a45", "#5f5642", "#585240"], blue: ["#8d8c88", "#9a9994", "#85837d", "#918f88"], islamabad: ["#5f7340", "#66753f", "#6e7c4a", "#5a6b3b"], society: ["#67793f", "#708347", "#5f7340", "#6d7d45"] };
  const sq = v => Math.round(255 * Math.sqrt(srgbToLin(v)));
  const RGB = {}; for (const k in COL) RGB[k] = COL[k].map(h => hexRgb(h).map(sq));
  const LO = { pindi: 0.1, lahore: 0.1, rural: 0.14, murree: 0.08, blue: 0.08, islamabad: 0.06, society: 0.05 }, HI = { pindi: 0.26, lahore: 0.26, rural: 0.34, murree: 0.3, blue: 0.2, islamabad: 0.18, society: 0.16 }, MAXA = { pindi: 245, lahore: 245, rural: 215, murree: 140, blue: 245, islamabad: 205, society: 205 };
  for (let y = 0, o = 0; y < n; y++) for (let x = 0; x < n; x++, o += 4) {
    const i = Math.min(N - 1, Math.floor(x / n * N)), j = Math.min(N - 1, Math.floor(y / n * N)), zone = Z[j * N + i], d = pkCov[j * N + i], lo = LO[zone]; if (lo === undefined) continue;
    if (a[o + 3] > 150 && a[o + 1] > a[o] * 1.08 && zone !== "islamabad" && zone !== "society") continue;             // a mapped park stays a park
    // mapped residential or commercial land, and everything inside the old bazaar cores, is paved or packed even where no roof was detected
    const urban = zone === "pindi" || zone === "lahore" || zone === "blue", grey = a[o + 3] > 30 && Math.max(a[o], a[o + 1], a[o + 2]) - Math.min(a[o], a[o + 1], a[o + 2]) < 34;
    const core = urban && PK_CORES.some(b => { const la = latOf(y / n * TS / S), lo2 = lonOf(x / n * TS / S); return lo2 > b[0] && lo2 < b[2] && la > b[1] && la < b[3]; });
    const inShop = core && pkInShop(latOf(y / n * TS / S), lonOf(x / n * TS / S)), floor = inShop ? 0.96 : core ? 0.75 : urban && grey ? 0.55 : 0;
    if (d <= lo && !floor) continue;
    const t = Math.max(floor, Math.min(1, (d - lo) / (HI[zone] - lo))), v = t * MAXA[zone], c = RGB[zone][Math.floor(hash2(x >> 4, y >> 4) * 4)], av = a[o + 3] / 255, w = v / 255, m = w + (1 - w) * av;
    if (v <= a[o + 3] * 0.2) continue;
    a[o] = (c[0] * w + a[o] * av * (1 - w)) / m; a[o + 1] = (c[1] * w + a[o + 1] * av * (1 - w)) / m; a[o + 2] = (c[2] * w + a[o + 2] * av * (1 - w)) / m; a[o + 3] = 255 * m;
  }
}
const PK_ALPHA = { wood: 175, forest: 175, scrub: 115, meadow: 125, grass: 135, farmland: 140, farm: 140, orchard: 150, residential: 150 };
class Splat {
  constructor(n, TS) { this.n = n; this.TS = TS; this.a = new Uint8Array(n * n * 4); }
  fill(rings, S, c, alpha) {
    const n = this.n, a = this.a, sc = n / this.TS, cr = Math.round(255 * Math.sqrt(c[0])), cg = Math.round(255 * Math.sqrt(c[1])), cb = Math.round(255 * Math.sqrt(c[2]));
    const edges = [];
    for (const r of rings) for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; edges.push(p[0] * S * sc, p[1] * S * sc, q[0] * S * sc, q[1] * S * sc); }
    let y0 = n, y1 = 0; for (let i = 1; i < edges.length; i += 2) { if (edges[i] < y0) y0 = edges[i]; if (edges[i] > y1) y1 = edges[i]; }
    y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(n - 1, Math.ceil(y1));
    const xs = [];
    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5; xs.length = 0;
      for (let i = 0; i < edges.length; i += 4) { const ya = edges[i + 1], yb = edges[i + 3]; if ((ya > yc) !== (yb > yc)) xs.push(edges[i] + (edges[i + 2] - edges[i]) * (yc - ya) / (yb - ya)); }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) { const x0 = Math.max(0, Math.round(xs[k])), x1 = Math.min(n, Math.round(xs[k + 1])); for (let x = x0, o = (y * n + x) * 4; x < x1; x++, o += 4) { a[o] = cr; a[o + 1] = cg; a[o + 2] = cb; a[o + 3] = alpha; } }
    }
  }
  any() { const a = this.a; for (let i = 3; i < a.length; i += 4) if (a[i]) return true; return false; }
  has(x, z) { const k = this.n / this.TS, i = Math.floor(x * k), j = Math.floor(z * k); return i >= 0 && j >= 0 && i < this.n && j < this.n && this.a[(j * this.n + i) * 4 + 3] > 0; }
  // soft edges between land uses (colour weighted by coverage, so nothing bleeds in from empty texels)
  soften(r) {
    const n = this.n, a = this.a, src = new Float32Array(n * n * 4), tmp = new Float32Array(n * n * 4);
    for (let o = 0; o < a.length; o += 4) { const w = a[o + 3]; src[o] = a[o] * w; src[o + 1] = a[o + 1] * w; src[o + 2] = a[o + 2] * w; src[o + 3] = w; }
    const pass = (from, to, step, line) => {
      for (let l = 0; l < n; l++) for (let c = 0; c < 4; c++) {
        let sum = 0; const at = i => from[(l * line + Math.max(0, Math.min(n - 1, i)) * step) * 4 + c];
        for (let i = -r; i <= r; i++) sum += at(i);
        for (let i = 0; i < n; i++) { to[(l * line + i * step) * 4 + c] = sum / (2 * r + 1); sum += at(i + r + 1) - at(i - r); }
      }
    };
    pass(src, tmp, 1, n); pass(tmp, src, n, 1);
    for (let o = 0; o < a.length; o += 4) { const w = src[o + 3]; a[o + 3] = w; if (w > 0.5) { a[o] = src[o] / w; a[o + 1] = src[o + 1] / w; a[o + 2] = src[o + 2] / w; } }
  }
  // a narrow worn verge along each road, about two metres of packed earth
  shoulders(G) {
    const n = this.n, a = this.a, k = n / this.TS, S = G.segs, t = new Float32Array(n * n), R = 3.2;
    for (let q = 0; q < S.length; q += 5) {
      const ax = S[q], az = S[q + 1], bx = S[q + 2], bz = S[q + 3], hw = S[q + 4], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz, M = hw + R;
      const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - M) * k)), x1 = Math.min(n - 1, Math.ceil((Math.max(ax, bx) + M) * k));
      const y0 = Math.max(0, Math.floor((Math.min(az, bz) - M) * k)), y1 = Math.min(n - 1, Math.ceil((Math.max(az, bz) + M) * k));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = (x + 0.5) / k - ax, pz = (y + 0.5) / k - az, u = l2 > 0 ? Math.max(0, Math.min(1, (px * dx + pz * dz) / l2)) : 0;
        const d = Math.hypot(px - dx * u, pz - dz * u), v = 1 - Math.max(0, Math.min(1, (d - hw) / R));
        if (v > t[y * n + x]) t[y * n + x] = v;
      }
    }
    for (let y = 0, o = 0; y < n; y++) for (let x = 0; x < n; x++, o += 4) {
      const w = 0.5 * t[y * n + x]; if (w < 0.02) continue;
      const av = a[o + 3] / 255, m = w + (1 - w) * av;
      a[o] = (a[o] * av * (1 - w) + 128 * w) / m; a[o + 1] = (a[o + 1] * av * (1 - w) + 116 * w) / m; a[o + 2] = (a[o + 2] * av * (1 - w) + 92 * w) / m; a[o + 3] = 255 * m;
    }
  }
}
// add a height to every vertex from v0 on (vertical faces keep their shape: x, z pick the same height)
function drapeRange(M, v0, fn) { const a = M.attr.position.a; for (let v = v0, o = v0 * 3; v < M.vc; v++, o += 3) a[o + 1] += fn(a[o], a[o + 2]); }
// a building's walls run down to the lowest ground under it, its roof keeps the height above its centre
function seatBuilding(M, v0, rec) {
  const P = M.attr.position.a, U = M.attr.uv.a, foot = rec.minh < 1, dn = rec.gy - rec.glow + 0.4;
  for (let v = v0, o = v0 * 3, u = v0 * 2; v < M.vc; v++, o += 3, u += 2) {
    if (foot && P[o + 1] <= rec.minh + 1e-3) { P[o + 1] = rec.glow - 0.4; U[u + 1] -= dn; }
    else P[o + 1] += rec.gy;
  }
}

// ------------------------------------------------------------------ tunnels
// OSM tunnels carry layer -1 or -2 but no depth: 6.8 m a level (less for short ones), ramping
// down from a portal where the tunnel meets a surface road; an end at the tile's buffer edge
// stays deep (the tunnel continues next door), and tunnel-to-tunnel ends share their depth.
function profileOfT(F) {
  const R = Math.min(140, Math.max(15, 0.45 * F.len)), H = F.H, el = [];
  for (let i = 0; i < F.pts.length; i++) {
    const s = F.cum[i];
    const rise = F.e0 + (H - F.e0) * smooth01(s / R), fall = F.e1 + (H - F.e1) * smooth01((F.len - s) / R);
    el.push(Math.min(0, rise + fall - H));
  }
  return el;
}
function tunnelProfiles(feats, E, S) {
  const TU = feats.filter(F => F.tunnel); if (!TU.length) return;
  const outside = q => q[0] < 0 || q[1] < 0 || q[0] > E || q[1] > E;
  const key = q => Math.round(q[0] * 4) + "," + Math.round(q[1] * 4);
  const surf = new Set();
  for (const F of feats) if (!F.tunnel) for (const q of F.pts) surf.add(key(q));
  for (const F of TU) {
    const n = F.pts.length;
    F.H = -Math.min(6.8 * Math.max(1, Math.min(2, -(F.layer || -1))), 0.1 * F.len + 0.5);
    F.openS = outside(F.pts[0]); F.openE = outside(F.pts[n - 1]);
    F.e0 = F.openS ? F.H : 0; F.e1 = F.openE ? F.H : 0;
    F.el = profileOfT(F);
  }
  for (let pass = 0; pass < 3; pass++) {
    const m = new Map();
    TU.forEach((F, fi) => F.pts.forEach((q, i) => { const k = key(q); let a = m.get(k); if (!a) m.set(k, a = []); a.push([fi, F.el[i]]); }));
    TU.forEach((F, fi) => {
      const endE = q => { const k = key(q); if (surf.has(k)) return 0; let e = 0; for (const [g, v] of m.get(k) || []) if (g !== fi && v < e) e = v; return e; };
      if (!F.openS) F.e0 = endE(F.pts[0]);
      if (!F.openE) F.e1 = endE(F.pts[F.pts.length - 1]);
      F.el = profileOfT(F);
    });
  }
}
// The tube: retaining walls with a parapet along the open cutting, walls and a ceiling where
// it is covered, a light strip along the walls, a headwall over each portal. The open cutting
// is also written to `cuts` so the engine can open the ground above it.
// Pakistan: an underpass mapped beneath a motorway. The carriageways are not cut, so its open-cutting parapets stood 0.9 m proud across all the lanes (the pale slab on the M-2 near km 118). No walls within the motorway's width, shoulders and median.
function pkUnderMotorway(lines, S) {
  const M = lines.filter(L => L.spec.c === 0 && !L.ramp && !L.tunnel).map(L => ({ p: L.pts.map(q => [q[0] * S, q[1] * S]), r: roadDims(L)[0] / 2 + 12 }));
  return (x, z) => M.some(m => { for (let i = 0; i + 1 < m.p.length; i++) if (segDistXY(x, z, m.p[i][0], m.p[i][1], m.p[i + 1][0], m.p[i + 1][1]) < m.r) return true; return false; });
}
function tunnelWalls(M, pts, off, W, ys, el, cuts, under) {
  const wallC = lin(hexRgb("#c2bdb2")), ceilC = lin(hexRgb("#6f6b64")), capC = lin(hexRgb("#d6d1c6")), hw = W / 2 + 0.3, H = 5.6, T = 0.3;
  const cov = i => ys[i] + H < -0.5;
  for (let i = 0; i < pts.length - 1; i++) {
    if (el[i] > -0.3 && el[i + 1] > -0.3) continue;
    if (under && [0, 0.25, 0.5, 0.75, 1].some(t => under(pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t))) continue;
    const ya = ys[i], yb = ys[i + 1], cA = cov(i), cB = cov(i + 1);
    const tA = cA ? ya + H : 0.9, tB = cB ? yb + H : 0.9;
    const L = [pts[i][0] + off[i][0] * hw, pts[i][1] + off[i][1] * hw], L2 = [pts[i + 1][0] + off[i + 1][0] * hw, pts[i + 1][1] + off[i + 1][1] * hw];
    const Rr = [pts[i][0] - off[i][0] * hw, pts[i][1] - off[i][1] * hw], R2 = [pts[i + 1][0] - off[i + 1][0] * hw, pts[i + 1][1] - off[i + 1][1] * hw];
    for (const side of [1, -1]) {
      const a = side > 0 ? L : Rr, b = side > 0 ? L2 : R2;
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; const nx = -dz / l * side, nz = dx / l * side;   // toward the road
      quad(M, [a[0], ya, a[1]], [b[0], yb, b[1]], [b[0], tB, b[1]], [a[0], tA, a[1]], [nx, 0, nz], wallC, [0, 2], [l, 2], false);
      if (!cA || !cB) {
        // the parapet above ground: outer face and cap
        quad(M, [a[0] - nx * T, -0.2, a[1] - nz * T], [b[0] - nx * T, -0.2, b[1] - nz * T], [b[0] - nx * T, tB, b[1] - nz * T], [a[0] - nx * T, tA, a[1] - nz * T], [-nx, 0, -nz], wallC, [0, 2], [l, 2], false);
        quad(M, [a[0], tA, a[1]], [b[0], tB, b[1]], [b[0] - nx * T, tB, b[1] - nz * T], [a[0] - nx * T, tA, a[1] - nz * T], [0, 1, 0], capC, [0, 2], [l, 2], false);
      }
      if (cA && cB) {
        // light strip along the wall, 4.4 m up
        const lo = 4.3, hi = 4.45;
        quad(M, [a[0] + nx * 0.02, ya + lo, a[1] + nz * 0.02], [b[0] + nx * 0.02, yb + lo, b[1] + nz * 0.02], [b[0] + nx * 0.02, yb + hi, b[1] + nz * 0.02], [a[0] + nx * 0.02, ya + hi, a[1] + nz * 0.02], [nx, 0, nz], capC, [0, 3], [l, 3], false);
      }
    }
    if (cA && cB) quad(M, [L[0], ya + H, L[1]], [L2[0], yb + H, L2[1]], [R2[0], yb + H, R2[1]], [Rr[0], ya + H, Rr[1]], [0, -1, 0], ceilC, [0, 2], [1, 2], false);
    if (cA !== cB) {
      // portal headwall over the covered end, facing the open cutting
      const k = cA ? i : i + 1, yk = ys[k] + H, Lk = cA ? L : L2, Rk = cA ? Rr : R2;
      const fx = pts[i + 1][0] - pts[i][0], fz = pts[i + 1][1] - pts[i][1], fl = Math.hypot(fx, fz) || 1; const s = cA ? 1 : -1;
      quad(M, [Lk[0], yk, Lk[1]], [Rk[0], yk, Rk[1]], [Rk[0], 0.9, Rk[1]], [Lk[0], 0.9, Lk[1]], [fx / fl * s, 0, fz / fl * s], wallC, [0, 2], [W, 2], false);
    }
    if (!cA || !cB) cuts.p4(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]), cuts.p1(W / 2 + 0.25);
  }
}

// ------------------------------------------------------------------ OpenStreetMap building types
// building=* values grouped by how they look
const TYPE_KIND = {};
for (const t of ["house", "villa", "detached", "semidetached_house", "terrace", "bungalow", "hut", "cabin", "farm", "static_caravan"]) TYPE_KIND[t] = "house";
for (const t of ["warehouse", "industrial", "hangar", "garage", "garages", "manufacture", "service", "shed", "carport", "factory", "storage_tank", "barn", "farm_auxiliary", "greenhouse"]) TYPE_KIND[t] = "shed";
for (const t of ["apartments", "residential", "dormitory", "flats"]) TYPE_KIND[t] = "flats";
for (const t of ["office", "commercial"]) TYPE_KIND[t] = "office";
for (const t of ["retail", "supermarket", "kiosk", "mall", "shop", "store", "marketplace"]) TYPE_KIND[t] = "retail";
TYPE_KIND.hotel = "hotel";
for (const t of ["school", "university", "college", "hospital", "government", "civic", "public", "kindergarten", "train_station", "fire_station", "police", "clinic", "museum", "stadium", "sports_hall", "sports_centre", "transportation"]) TYPE_KIND[t] = "civic";
TYPE_KIND.construction = "construction";
// a height for tagged buildings that have neither height nor storeys (the tiles then default to a few metres)
// Shanghai storeys from the footprint (metres): compact 300 to 1300 m2 footprints are the residential
// point towers that fill Pudong, long thin ones are slab blocks, big ones are podiums, malls and campuses.
function cnHeight(areaM, wM, dM, T, seed) {
  const L = Math.max(wM, dM), Wd = Math.min(wM, dM), fl = (a, b) => Math.round(a + (b - a) * seed);
  const k = TYPE_KIND[T] || "";
  if (k === "shed") return 8 + 6 * seed;
  const low = /school|kindergarten|college|university|hospital|civic|public|church|temple|government|sports|stadium/.test(T);
  let f;
  if (k === "house") f = fl(2, 3);
  else if (areaM < 120) f = fl(1, 3);
  else if (areaM < 300) f = fl(3, 7);
  else if (areaM <= 1300 && L < 70) f = low ? fl(3, 6) : fl(14, 33);
  else if (Wd < 22 && L >= 50) f = low ? fl(4, 6) : fl(6, 18);
  else if (areaM < 4000) f = /office|commercial|hotel/.test(T) ? fl(12, 30) : fl(4, 8);
  else f = fl(3, 5);
  return f * 3.1 + 1.5;
}
const TYPE_H = { apartments: 13, residential: 13, dormitory: 10, flats: 13, hotel: 16, office: 15, commercial: 12, retail: 8, supermarket: 8, mall: 15, house: 7.5, villa: 7.5, detached: 7.5, semidetached_house: 7.5, terrace: 7, school: 9, university: 12, college: 12, hospital: 14, government: 12, civic: 10, public: 10, warehouse: 9, industrial: 9, hangar: 12, garage: 3.5, garages: 3.5, service: 4 };

// the footprint's oriented box, in metres: centre, axes, half extents
function obbOf(ring, S) {
  const pts = ring.map(q => [q[0] * S, q[1] * S]);
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]; const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz); if (l < 1) continue;
    const ux = dx / l, uz = dz / l, vx = -uz, vz = ux;
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (const p of pts) { const u = p[0] * ux + p[1] * uz, v = p[0] * vx + p[1] * vz; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
    const area = (u1 - u0) * (v1 - v0); if (!best || area < best.area) best = { ux, uz, vx, vz, u0, u1, v0, v1, area };
  }
  if (!best) return null;
  const cu = (best.u0 + best.u1) / 2, cv = (best.v0 + best.v1) / 2;
  best.cx = cu * best.ux + cv * best.vx; best.cz = cu * best.uz + cv * best.vz;
  best.eu = (best.u1 - best.u0) / 2; best.ev = (best.v1 - best.v0) / 2;
  if (best.ev > best.eu) { [best.ux, best.uz, best.vx, best.vz] = [best.vx, best.vz, -best.ux, -best.uz]; [best.eu, best.ev] = [best.ev, best.eu]; }   // u = long axis
  return best;
}
function roofGuess(shape, rec, S) {
  const b = obbOf(rec.o, S); const d = b ? 2 * b.ev : 10;
  if (shape === "dome" || shape === "round") return Math.min(0.45 * d, 22);
  if (shape === "onion") return Math.min(0.6 * d, 26);
  if (shape === "pyramidal") return Math.min(0.3 * d, 14);
  if (shape === "skillion") return Math.min(0.12 * d, 3);
  return Math.min(0.25 * d, 6);
}
function triF(M, a, b, c, col, ft, seed, h) {
  const P = M.attr.position, Nn = M.attr.normal, U = M.attr.uv, C = M.attr.color, F = M.attr.facade, I = M.idx;
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; const l = Math.hypot(n[0], n[1], n[2]) || 1; n = n.map(v => v / l);
  let flip = false; if (n[1] < 0) { flip = true; n = n.map(v => -v); }
  const v0 = M.vc;
  for (const p of [a, b, c]) { P.p3(p[0], p[1], p[2]); Nn.p3(n[0], n[1], n[2]); U.p2(p[0], p[2]); C.p3(col[0], col[1], col[2]); F.p4(ft, seed, 3.3, h); }
  if (flip) I.p3(v0, v0 + 2, v0 + 1); else I.p3(v0, v0 + 1, v0 + 2);
  M.vc += 3;
}
// Pitched, pyramid and dome roofs from roof:shape, on walls that stop at y0.
function addRoofShape(M, rec, S, y0, rh, shape, col, seed) {
  if (rh < 0.3) return;
  const b = obbOf(rec.o, S); if (!b) return;
  const top = y0 + rh;
  if (shape === "dome" || shape === "onion" || shape === "round") { const r = Math.max(1.5, b.ev * 0.92); hemi(M, b.cx, y0, b.cz, r, 22, 8, col, rh / r); return; }
  const rectish = rec.areaM > 0.72 * 4 * b.eu * b.ev;
  const P = (u, v, y) => [b.cx + u * b.ux + v * b.vx, y, b.cz + u * b.uz + v * b.vz];
  if (shape === "pyramidal" || !rectish) {
    // faces from each footprint edge up to the apex
    const apex = [b.cx, top, b.cz], o = rec.o;
    for (let i = 0; i < o.length; i++) { const a = o[i], c = o[(i + 1) % o.length]; triF(M, [a[0] * S, y0, a[1] * S], [c[0] * S, y0, c[1] * S], apex, col, 9.8, seed, top); }
    return;
  }
  const eu = b.eu, ev = b.ev;
  if (shape === "skillion") {
    const a = P(-eu, -ev, y0), c = P(eu, -ev, y0), d = P(eu, ev, top), e = P(-eu, ev, top);
    triF(M, a, c, d, col, 9.8, seed, top); triF(M, a, d, e, col, 9.8, seed, top);
    return;
  }
  // gabled: ridge the full length; hipped (and the rest): ridge shortened by the width at each end
  const hip = shape !== "gabled" && shape !== "saltbox" && shape !== "gambrel";
  const r = hip ? Math.max(0, eu - ev) : eu;
  const c00 = P(-eu, -ev, y0), c10 = P(eu, -ev, y0), c11 = P(eu, ev, y0), c01 = P(-eu, ev, y0), rA = P(-r, 0, top), rB = P(r, 0, top);
  triF(M, c00, c10, rB, col, 9.8, seed, top); triF(M, c00, rB, rA, col, 9.8, seed, top);          // one long slope
  triF(M, c11, c01, rA, col, 9.8, seed, top); triF(M, c11, rA, rB, col, 9.8, seed, top);          // the other
  triF(M, c10, c11, rB, col, hip ? 9.8 : 9.6, seed, top); triF(M, c01, c00, rA, col, hip ? 9.8 : 9.6, seed, top);   // ends: hips, or gable walls
}
// A tower crane beside a building under construction: mast, jib, counter-jib and weights.
function craneItems(rec, S, out) {
  const b = obbOf(rec.o, S); if (!b) return 0;
  const H = rec.h + 16 + 10 * rec.seed, rot = rec.seed * 6.283;
  const mx = b.cx + b.ux * b.eu * 0.35, mz = b.cz + b.uz * b.eu * 0.35;
  const dx = Math.cos(rot), dz = -Math.sin(rot);
  const yel = rec.seed < 0.6 ? 0xe2b21c : 0xe8e8e2;
  out.p4(mx, 0, mz, rot); out.p4(2.0, H, 2.0, 0); out.p1(yel);                                  // mast
  out.p4(mx + dx * 13, H, mz + dz * 13, rot); out.p4(56, 1.6, 1.6, 0); out.p1(yel);             // jib and counter-jib
  out.p4(mx - dx * 12, H - 2.6, mz - dz * 12, rot); out.p4(4.5, 2.6, 2.6, 0); out.p1(0x6b6b6b); // counterweights
  out.p4(mx + dx * 1.5, H - 3.4, mz + dz * 1.5, rot); out.p4(2.4, 2.4, 2.4, 0); out.p1(0xf0f0ea); // cab
  out.p4(mx, H + 1.6, mz, rot); out.p4(1.2, 6, 1.2, 0); out.p1(yel);                            // peak
  return 5;
}
