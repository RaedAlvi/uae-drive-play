// Tile worker: fetches one OpenMapTiles vector tile, decodes it and builds render-ready
// geometry (buildings with facade attributes, roads with lane-marking attributes,
// sidewalks, ground areas, water, props) plus the collision and traffic data the game
// needs. Everything comes back as transferable typed arrays in tile-local metres:
// X east from the tile's west edge, Z south from its north edge, Y up.

import { decodeTile, polygons, ringArea } from "./mvt.js";
import earcut from "./earcut.js";

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
  if (m.cmd === "prefetch") {
    // download into the cache only, no geometry: the route ahead is ready when we get there
    try { const cache = await caches.open("uae-drive-tiles-v1"); if (!(await cache.match(m.url))) { const r = await fetch(m.url); if (r.ok) await cache.put(m.url, r); } } catch (err) {}
    self.postMessage({ key: m.key, prefetched: true });
    return;
  }
  if (m.cmd !== "tile") return;
  try {
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
      names.push({ c: p.class, en: p["name:en"] || p.name_en || "", lat: p["name:latin"] || "", nm: p.name || "", ar: p["name:ar"] || "", ref: p.ref || "", g: fl });
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
  bridgeProfiles(feats, E, S);
  tunnelProfiles(feats, E, S);
  for (const F of feats) { const [W, lanes] = roadDims(F); roadColl.push({ c: F.cls, r: F.ramp ? 1 : 0, b: F.bridge ? "bridge" : F.tunnel ? "tunnel" : "", g: toLL(F.pts), e: F.el ? F.el.slice() : null, w: W, o: F.oneway ? 1 : 0, l: lanes, m: F.osm && F.osm.m ? F.osm.m : 0 }); }
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

  const palms = new FBuf(), lamps = new FBuf(), streetTrees = new FBuf(), cuts = new FBuf(64), highways = [];
  const traffic = [];
  const roadGrid = new SegGrid(40);
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
    const ys = L.el.map(e => y0 + e);
    const elevated = L.el.some(e => e > 0.4), sunk = L.el.some(e => e < -0.4);
    const flags = (L.oneway ? 1 : 0) | (L.bridge ? 2 : 0) | (L.ramp ? 8 : 0);
    const off = ribbon(R, pts, cum, W, ys, lanes, flags, L.spec.c, aD, bD, aR, bR);
    if (L.spec.c <= 6) for (let i = 0; i < n - 1; i++) roadGrid.add(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], W / 2, L.spec.c, elevated || L.bridge || sunk);
    // sidewalks with curbs, cut back from junctions
    if (SIDEWALK_CLASSES.has(L.cls) && !L.ramp && !L.bridge && !elevated && !sunk) sidewalks(SW, pts, cum, off, W, aD, bD, aR, bR, L.oneway);
    if (sunk) tunnelWalls(SW, pts, off, W, ys, L.el, cuts);
    if ((L.bridge || elevated) && L.spec.c <= 6) barriers(SW, pts, off, W, ys);
    if (elevated) deckAndPiers(SW, pts, cum, off, W, ys, L.el);
    if (L.oneway && L.spec.c <= 1 && !L.ramp && !L.bridge && !elevated) medianBarrier(SW, pts, off, W, ys);
    // props along the road
    const seed0 = hash2(Math.round(pts[0][0]), Math.round(pts[0][1]));
    if (PALM_CLASSES.has(L.cls) && !L.ramp && !L.bridge && !elevated && !sunk) propsAlong(palms, pts, cum, off, W, aD, bD, aR, bR, 24, W / 2 + 2.6, [-1, 1], seed0, 10, false, null);
    else if ((L.cls === "tertiary" || L.cls === "minor") && !L.ramp && !L.bridge && !elevated && !sunk && seed0 < 0.6 && streetTrees.n < 4 * 450) propsAlong(streetTrees, pts, cum, off, W, aD, bD, aR, bR, 19, W / 2 + 1.9, L.oneway ? [1] : [-1, 1], seed0, 9, false, null);
    if (LAMP_CLASSES.has(L.cls) && !sunk) propsAlong(lamps, pts, cum, off, W, aD, bD, aR, bR, 42, L.oneway ? W / 2 + 0.9 : W / 2 + 1.2, L.oneway ? [1] : [-1, 1], seed0, 6, true, ys);
    else if (L.cls === "minor" && !sunk && !L.bridge) propsAlong(lamps, pts, cum, off, W, aD, bD, aR, bR, 36, W / 2 + 1.0, [1], seed0, 6, true, ys);   // side streets: one row of lamps
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
          for (const sd of L.oneway ? [1, -1] : [1]) { const o = sd * (W / 2 + 0.9); sigHeads.p3(sx - dz * o, sz + dx * o, ys[i] - L.spec.y); sigHeads.p3(rot, e.cl.idx, g); }
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
          const o = W / 2 + 1.7, x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t - dz * o, zz = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t + dx * o;
          speedSigns.p4(x, zz, ys[i] + (ys[i + 1] - ys[i]) * t - L.spec.y, Math.atan2(-dx, -dz)); speedSigns.p1(kmh);
        }
      }
    }
    if (L.spec.c <= 1 && !elevated && !sunk && !L.bridge) highways.push(pts);
    if (L.spec.c <= 6) {
      const fl = new Float32Array(n * 2); for (let i = 0; i < n; i++) { fl[2 * i] = pts[i][0]; fl[2 * i + 1] = pts[i][1]; }
      traffic.push({ p: fl, e: elevated || sunk ? Float32Array.from(L.el) : null, c: L.spec.c, ow: L.oneway ? 1 : 0, w: W, l: lanes, b: L.bridge ? 1 : 0, st: stops.length ? Float32Array.from(stops) : null });
    }
  }
  for (const e of juncs) junctionDisc(R, e.x * S, e.y * S, e.maxHalf * 1.05, e.topY + e.elev + 0.003, e.topC);
  msg.roads = R.out(); collect(msg.roads, transfer);
  msg.cuts = cuts.out(); transfer.push(msg.cuts.buffer);
  const cl32 = new Float32Array(clusters.length * 4);
  clusters.forEach((c, i) => { cl32[4 * i] = c.x * S; cl32[4 * i + 1] = c.y * S; cl32[4 * i + 2] = hash2(Math.round(lonOf(c.x) * 2000), Math.round(latOf(c.y) * 2000)); cl32[4 * i + 3] = c.ref; });
  msg.signals = { c: cl32, h: sigHeads.out() }; transfer.push(msg.signals.c.buffer, msg.signals.h.buffer);

  // ---------------------------------------------------------------- buildings
  // Classify every footprint first, then hang the real shop and hotel names from OpenStreetMap
  // on the right walls (and mark those buildings as having shopfronts), then build geometry.
  const B = new Mesh({ position: 3, normal: 3, uv: 2, color: 3, facade: 4 });
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
      if (bi && bi.colour) col = hexRgb(bi.colour) || col;
      const glassy = (col && col[2] > col[0] + 0.12) || (bi && bi.material === "glass");            // OSM "glass" material comes through as #5a81a0
      let type, color, floorH = 3.3;
      let isMosque = !!(bi && (T === "mosque" || (bi.amenity === "place_of_worship" && bi.religion === "muslim")) && h < 40);
      if (!isMosque && h < 30 && mosques.length) for (const q of mosques) if (q[0] > minx && q[0] < maxx && q[1] > miny && q[1] < maxy && pointInRingXY(q[0], q[1], o)) { isMosque = true; break; }
      // "residential" on a small footprint without storeys is a villa (common tagging in Abu Dhabi)
      const kind = (T === "residential" && areaM < 500 && !(bi && bi.levels > 2)) ? "house" : TYPE_KIND[T] || (bi && (bi.shop === "mall" || bi.shop === "supermarket") ? "retail" : bi && bi.tourism === "hotel" ? "hotel" : "");
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
        guessH: h0 <= 6.5 && minh0 === 0 && !(bi && (bi.levels || bi.height)) && (!kind || T === "residential") });
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
  // footprint grid (tile units) for point lookups
  const GB = 48, gcell = E / GB, bgrid = new Map();
  recs.forEach((r, i) => { if (r.minh > 2) return; for (let gx = Math.max(0, Math.floor(r.minx / gcell)); gx <= Math.min(GB - 1, Math.floor(r.maxx / gcell)); gx++) for (let gy = Math.max(0, Math.floor(r.miny / gcell)); gy <= Math.min(GB - 1, Math.floor(r.maxy / gcell)); gy++) { const k = gx * 64 + gy; let a = bgrid.get(k); if (!a) bgrid.set(k, a = []); a.push(i); } });
  const bldAt = (x, y) => { const k = Math.floor(x / gcell) * 64 + Math.floor(y / gcell); for (const i of bgrid.get(k) || []) { const r = recs[i]; if (x < r.minx || x > r.maxx || y < r.miny || y > r.maxy) continue; if (pointInRingXY(x, y, r.o)) return r; } return null; };
  const bldNear = (x, y, maxT) => { let best = null, bd = maxT; const g0x = Math.floor((x - maxT) / gcell), g1x = Math.floor((x + maxT) / gcell), g0y = Math.floor((y - maxT) / gcell), g1y = Math.floor((y + maxT) / gcell); const seen = new Set(); for (let gx = g0x; gx <= g1x; gx++) for (let gy = g0y; gy <= g1y; gy++) for (const i of bgrid.get(gx * 64 + gy) || []) { if (seen.has(i)) continue; seen.add(i); const r = recs[i]; const d = ringDist(x, y, r.o); if (d < bd) { bd = d; best = r; } } return best; };

  // shop, office and hotel signs on the walls, from the real POI names
  const texts = [], textIds = new Map();
  const textId = (en, ar, ref, cls) => { const k = en + "|" + ar + "|" + ref + "|" + cls; let id = textIds.get(k); if (id === undefined) { id = texts.length; texts.push({ en, ar, ref, cls }); textIds.set(k, id); } return id; };
  const shopSigns = new FBuf(512), towerSigns = new FBuf(64);
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
          towerSigns.p4(edge.mx + edge.nx * 0.2, y, edge.mz + edge.nz * 0.2, Math.atan2(edge.nx, edge.nz)); towerSigns.p4(w, letterH, textId(q.en || q.ar, "", "", q.cls), 1);
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
    shopSigns.p4(px, y, pz, Math.atan2(edge.nx, edge.nz)); shopSigns.p4(w, hs, textId(q.en, q.ar, "", q.sub && q.cls === "shop" ? q.sub : q.cls), 1);
    rec.retail = 1; shopsPlaced++; shopCell.set(cellOf(q), (shopCell.get(cellOf(q)) || 0) + 1);
  }

  // named towers carry their name in lettering near the top (the real ones mostly do): the
  // tallest first, and not generic names ("Building 3", "Tower B") or tenants (a gym, a clinic)
  for (const rec of recs.filter(r => r.name && r.h >= 60).sort((a, b) => b.h - a.h)) {
    if (/^(building|tower|block|bldg|the apartments?)\b.{0,4}$/i.test(rec.name) || /\b(gym|clinic|salon|pharmacy|parking)\b/i.test(rec.name)) continue;
    if (!rec.name || rec.tower || rec.h < 60 || rec.minh > 2 || rec.name.length > 26 || towerSigns.n >= 8 * 40) continue;
    const letterH = Math.max(2.2, Math.min(5.0, rec.h * 0.03));
    const edge = bestEdge(rec.o, S, rec.cx, rec.cy, roadGrid, 16); if (!edge) continue;
    const w = Math.min(edge.len * 0.84, letterH * rec.name.length * 0.66 + 2); if (w < letterH * 2.2) continue;
    const y = rec.h - 7.8 - letterH * 0.5;
    towerSigns.p4(edge.mx + edge.nx * 0.2, y, edge.mz + edge.nz * 0.2, Math.atan2(edge.nx, edge.nz)); towerSigns.p4(w, letterH, textId(rec.name, "", "", "tower"), 1);
    rec.tower = 1;
  }
  // geometry: walls with shopfront flags, roofs, rooftop plant, villa walls
  const roof = new FBuf(1024);
  const VW = new Mesh({ position: 3, normal: 3, uv: 2, color: 3 });          // villa boundary walls (drawn near the camera only)
  let roofBudget = 5000;
  for (const rec of recs) {
    const { rings, h, minh, type, color, seed, floorH } = rec;
    // shopfront ground floors: any building with a shop sign, and most mid-rise blocks on a main road
    let retail = rec.retail;
    if (!retail && minh < 1 && (type === 1 || type === 2) && h < 60) {
      if (rec.dense) { const d = roadGrid.nearest(rec.cx * S, rec.cy * S, 45, 2, 5); if (d) retail = 1; }
      else { const d = roadGrid.nearest(rec.cx * S, rec.cy * S, 60); if (d && d.c >= 2 && d.c <= 5 && seed < 0.75) retail = 1; }
    }
    if (h > tallest) tallest = h;
    // a pitched, pyramid or dome roof from OpenStreetMap sits on walls that stop below it
    const rsh = rec.roofShape && minh < 1 && rings.length === 1 && rec.areaM < 12000 ? rec.roofShape : null;
    const rh = rsh ? Math.min(rec.roofH || roofGuess(rsh, rec, S), h * 0.6) : 0;
    addPrism(B, rings, S, E, h - rh, minh, type + (retail ? 0.3 : 0), color, seed, floorH, rec.roofCol);
    if (rsh) addRoofShape(B, rec, S, h - rh, rh, rsh, rec.roofCol || (rsh === "dome" || rsh === "onion" ? lin(hexRgb(seed < 0.5 ? "#f2eee6" : "#c9b27a")) : lin(hexRgb(seed < 0.5 ? "#9c5a3c" : "#7a7f86"))), seed);
    if (type === 7 && minh < 1 && h > 15 && roofBudget > 0) roofBudget -= craneItems(rec, S, roof);
    if (rec.canopy) { const b = obbOf(rec.o, S); if (b) { const cc = lin(hexRgb("#c9c9cb")), nu = Math.max(1, Math.round(b.eu / 6)); for (let k = -nu; k <= nu; k += Math.max(1, nu)) for (const sv of [-1, 1]) { const u = k / nu * (b.eu - 1.2), v = sv * (b.ev - 1.2); if (b.ev < 3 && sv > 0) continue; box(SW, b.cx + u * b.ux + (b.ev < 3 ? 0 : v) * b.vx, b.cz + u * b.uz + (b.ev < 3 ? 0 : v) * b.vz, b.ux, b.uz, 0.25, 0.25, 0, minh, cc); } } }
    if (rec.isMosque && minh === 0) addMosqueParts(B, rec.o, S, rec.cx, rec.cy, h, rec.minx, rec.miny, rec.maxx, rec.maxy, seed);
    bCount++;
    if (roofBudget > 0 && minh < 1 && !rec.isMosque && type !== 4 && rec.areaM >= 60) roofBudget -= roofItems(rec, S, roof);
    if (type === 3 && minh < 1 && h < 11 && rec.areaM >= 60 && rec.areaM < 1100 && !retail && !rec.heritage) villaWall(rec, S, roadGrid, bldAt, VW, recs);
  }
  msg.buildings = B.out(); collect(msg.buildings, transfer); chunkIndex(msg.buildings, TS, 3, transfer);
  msg.tallest = tallest; msg.bCount = bCount;
  msg.roofs = roof.out(); transfer.push(msg.roofs.buffer);
  msg.vwalls = VW.out(); collect(msg.vwalls, transfer); chunkIndex(msg.vwalls, TS, 4, transfer);
  // floating name labels for the places people navigate by (metro stations, malls, hotels, sights)
  const labels = [], seenL = new Set();
  labelPois.sort((a, b) => a.rank - b.rank);
  for (const q of labelPois) {
    const nm = q.en || q.ar; if (seenL.has(q.k + nm)) continue; seenL.add(q.k + nm);
    const rec = bldAt(q.x, q.y);
    if (q.k === "hotel" && (!rec || rec.h < 30)) continue;
    labels.push({ en: q.en, ar: q.ar, k: q.k, x: q.x * S, z: q.y * S, y: q.k === "metro" ? 16 : q.k === "mosque" ? (rec ? Math.max(rec.h, 14) + 10 : 22) : rec ? rec.h + 6 : 10 });
    if (labels.length >= 90) break;
  }
  for (const rec of recs) {
    if (labels.length >= 120) break;
    if (!rec.name || rec.minh > 2) continue;
    const bi = rec.bi || {};
    const k = rec.isMosque ? "mosque" : (bi.shop === "mall" || bi.shop === "department_store" || rec.kind === "retail" && rec.areaM > 3000) ? "mall" : (bi.tourism === "hotel" || rec.kind === "hotel") ? "hotel" : (bi.tourism === "museum" || bi.tourism === "attraction") ? "sight" : "";
    if (!k || seenL.has(k + rec.name)) continue; seenL.add(k + rec.name);
    labels.push({ en: rec.name, ar: "", k, x: rec.cx * S, z: rec.cy * S, y: rec.isMosque ? Math.max(rec.h, 14) + 10 : rec.h + 6 });
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
    streetSigns.p4(px, pz, 0.17, Math.atan2(-A.dir[1], A.dir[0])); streetSigns.p3(idA, B2 ? Math.atan2(-B2.dir[1], B2.dir[0]) : 0, idB);
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
    shelters.p4(cx, cz, Math.atan2(-nx, -nz), 0.17);
  }
  msg.signs = { texts, street: streetSigns.out(), shop: shopSigns.out(), tower: towerSigns.out(), speed: speedSigns.out() };
  transfer.push(msg.signs.street.buffer, msg.signs.shop.buffer, msg.signs.tower.buffer, msg.signs.speed.buffer);
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
        railway(SW, P2, cum, pl.el, elevated);
      }
    }
  }
  msg.walks = SW.out(); collect(msg.walks, transfer); chunkIndex(msg.walks, TS, 3, transfer);
  msg.palms = palms.out(); transfer.push(msg.palms.buffer);
  msg.lamps = lamps.out(); transfer.push(msg.lamps.buffer);
  msg.traffic = traffic; for (const t of traffic) { transfer.push(t.p.buffer); if (t.e) transfer.push(t.e.buffer); if (t.st) transfer.push(t.st.buffer); }

  // ---------------------------------------------------------------- ground areas + water
  const A = new Mesh({ position: 3, normal: 3, color: 3 });
  const Wt = new Mesh({ position: 3, normal: 3, color: 3 });
  const waterColl = [];
  const parkPolys = [];
  for (const lname of ["landcover", "landuse", "park"]) {
    for (const f of (layers[lname] && layers[lname].features) || []) {
      if (f.type !== 3) continue;
      const cls = lname === "park" ? "park" : (f.props.subclass && AREA_COL[f.props.subclass] !== undefined ? f.props.subclass : f.props.class);
      const hex = AREA_COL[cls]; if (!hex) continue;
      const c = lin(hexRgb(hex)); const yy = AREA_Y[cls] || (GREEN.has(cls) ? 0.014 : 0.011);
      for (const poly of polygons(f.geom)) {
        const rings = []; for (const r of poly) { const cr = clipRing(r, E); if (cr) rings.push(cr); }
        if (!rings.length) continue;
        fillPoly(A, rings, S, yy, c, 0);
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
      fillPoly(Wt, rings, S, pool ? 0.02 : 0.004, pool ? [0.05, 0.45, 0.62] : [0.0, 0.0, 0.0], pool ? 1 : 0);
      if (!pool) { const flat = []; for (const r of rings) { const fr = []; for (const q of r) fr.push(lonOf(q[0]), latOf(q[1])); flat.push(fr); } waterColl.push(flat); }
    }
  }
  msg.areas = A.out(); collect(msg.areas, transfer);
  msg.water = Wt.out(); collect(msg.water, transfer);
  // palms scattered in parks
  let budget = 900; const trees = new FBuf();
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
      const kind = hash2(i, 99) < 0.72 ? 0 : 1;
      trees.p4(px * S, py * S, hash2(i, 5) * 6.283, kind * 10 + 0.75 + 0.5 * hash2(i, 11));
      k--; budget--;
    }
  }
  // a palm or two in villa gardens, between the house and the boundary wall
  for (const rec of recs) {
    if (!rec.garden || budget <= 0) continue;
    for (const g of rec.garden) { trees.p4(g[0], g[1], hash2(Math.round(g[0]), Math.round(g[1])) * 6.283, (g[2] ? 10 : 0) + 0.8 + 0.3 * hash2(Math.round(g[1]), 3)); budget--; }
  }
  // desert scrub beside the motorways where there is open ground (no building within 60 m)
  let shrubN = 0;
  for (const pts of highways) {
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
  // shade trees on the pavements of side streets (neem and ghaf), as broadleaf trees
  for (let i = 0; i < streetTrees.n; i += 4) trees.p4(streetTrees.a[i], streetTrees.a[i + 1], streetTrees.a[i + 2], 10 + 0.7 + 0.35 * (streetTrees.a[i + 3] - 0.85) / 0.3);
  msg.parkTrees = trees.out(); transfer.push(msg.parkTrees.buffer);

  msg.coll = { b: bColl, w: waterColl, r: roadColl, n: names };
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
  const r = Math.max(3, Math.min(w, d) * 0.28);
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
    const L = cum[i + 1] - cum[i];
    const a0 = aD[i], a1 = aD[i] + L, b1 = bD[i + 1] + 0, b0 = b1 + L, ra = aR[i], rb = bR[i + 1];
    const v0 = M.vc;
    for (const [k, a, b] of [[i, a0, b0], [i + 1, a1, b1]]) {
      const [ox, oz] = off[k];
      const x = pts[k][0], z = pts[k][1], y = ys[k];
      P.p3(x + ox * hw, y, z + oz * hw); P.p3(x - ox * hw, y, z - oz * hw);
      Nn.p3(0, 1, 0); Nn.p3(0, 1, 0);
      U.p2(0, cum[k]); U.p2(W, cum[k]);
      Rd.p4(W, lanes, flags, cls); Rd.p4(W, lanes, flags, cls);
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
  P.p3(x, y, z); Nn.p3(0, 1, 0); U.p2(r, 0); Rd.p4(2 * r, 1, 16, cls); J.p4(0, 0, r, r);
  for (let i = 0; i <= seg; i++) { const a = i / seg * Math.PI * 2; P.p3(x + Math.cos(a) * r, y, z + Math.sin(a) * r); Nn.p3(0, 1, 0); U.p2(r, 0); Rd.p4(2 * r, 1, 16, cls); J.p4(0, 0, r, r); }
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
function sidewalks(M, pts, cum, off, W, aD, bD, aR, bR, oneway) {
  const P = M.attr.position, Nn = M.attr.normal, U = M.attr.uv, C = M.attr.color, I = M.idx;
  const top = 0.17, sw = 2.8, hw = W / 2;
  const pave = lin(hexRgb("#cfc6b6")), curbA = lin(hexRgb("#e9e6df"));
  clearSpans(cum, aD, bD, aR, bR, 3.0, (i, lo, hi) => {
    for (const side of [1, -1]) {
      const A = lerpOff(pts, off, i, lo), Bp = lerpOff(pts, off, i, hi);
      // points: inner edge (curb line) and outer edge
      const ia = [A.x + A.ox * hw * side, A.z + A.oz * hw * side], oa = [A.x + A.ox * (hw + sw) * side, A.z + A.oz * (hw + sw) * side];
      const ib = [Bp.x + Bp.ox * hw * side, Bp.z + Bp.oz * hw * side], ob = [Bp.x + Bp.ox * (hw + sw) * side, Bp.z + Bp.oz * (hw + sw) * side];
      const va = cum[i] + (cum[i + 1] - cum[i]) * lo, vb = cum[i] + (cum[i + 1] - cum[i]) * hi;
      // top
      quad(M, [ia[0], top, ia[1]], [ib[0], top, ib[1]], [ob[0], top, ob[1]], [oa[0], top, oa[1]], [0, 1, 0], pave, [va, 0], [vb, 0], side > 0);
      // curb face (towards the road)
      const nx = -A.ox * side, nz = -A.oz * side; const nl = Math.hypot(nx, nz) || 1;
      quad(M, [ia[0], 0.03, ia[1]], [ib[0], 0.03, ib[1]], [ib[0], top, ib[1]], [ia[0], top, ia[1]], [nx / nl, 0, nz / nl], curbA, [va, 1], [vb, 1], side < 0);
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
  const col = lin(hexRgb("#c9c4ba")), hw = W / 2, h = 1.0;
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
        for (const o of cols) box(M, x + lx * o, z + lz * o, fx, fz, 0.8, 0.8, 0, y - th, col);
        if (W > 13) box(M, x, z, fx, fz, 1.0, W / 2 + 0.2, y - th - 1.1, y - th, col);   // cap beam
      }
      next += 32;
    }
  }
}
// Railway: a viaduct deck with parapets and piers (elevated) or a ballast bed (at grade), with two tracks.
function railway(M, pts, cum, el, elevated) {
  const n = pts.length; if (n < 2) return;
  const off = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; off.push([dz / l, -dx / l]);
  }
  const deck = lin(hexRgb("#d9d3c7")), side = lin(hexRgb("#c7c0b3")), under = lin(hexRgb("#9d978b")), ballast = lin(hexRgb("#7d756a")), rail = lin(hexRgb("#4a4744")), sleeper = lin(hexRgb("#6a6259"));
  const yAt = i => elevated && el ? el[i] : 0.02;
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
          box(M, x, z, dx / l, dz / l, 1.0, 1.0, 0, e - th - 0.9, side);
          box(M, x, z, dx / l, dz / l, 1.2, 3.2, e - th - 0.9, e - th, side);     // pier cap
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
function medianBarrier(M, pts, off, W, ys) {
  const col = lin(hexRgb("#d4d0c8")), hw = W / 2 + 0.35;
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
function arabicName(p) { const v = p["name:ar"] || (p.name && ARRE.test(p.name) ? p.name : ""); return v ? String(v).trim() : ""; }
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
function tunnelWalls(M, pts, off, W, ys, el, cuts) {
  const wallC = lin(hexRgb("#c2bdb2")), ceilC = lin(hexRgb("#6f6b64")), capC = lin(hexRgb("#d6d1c6")), hw = W / 2 + 0.3, H = 5.6, T = 0.3;
  const cov = i => ys[i] + H < -0.5;
  for (let i = 0; i < pts.length - 1; i++) {
    if (el[i] > -0.3 && el[i + 1] > -0.3) continue;
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
