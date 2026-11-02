// World: projection, floating origin, tile streaming through workers, and the collision
// index the car physics reads (roads, names, building footprints, water).
import * as THREE from "three";
import { makeBuildingMaterial, makeRoadMaterial, makeWalkMaterial, makeAreaMaterial, makeWaterMaterial } from "./materials.js";

// ---------------------------------------------------------------- projection
// Web Mercator metres scaled by cos(24.9 deg), the latitude between Abu Dhabi and Dubai,
// so one unit is within 0.4 % of a true metre anywhere on the map. Mercator is
// conformal, so shapes are exact; only the scale drifts by that fraction.
export const K = Math.cos(24.9 * Math.PI / 180);
const RE = 6378137, CIRC = 2 * Math.PI * RE;
export const Z = 14;
export const TILE = CIRC / Math.pow(2, Z) * K;         // tile edge in world metres (about 2219)
export const mercX = lon => RE * lon * Math.PI / 180;
export const mercY = lat => RE * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
export const origin = { mx: mercX(55.27), my: mercY(25.2) };
export function toWorld(lat, lon, out = new THREE.Vector3()) { out.x = (mercX(lon) - origin.mx) * K; out.z = -(mercY(lat) - origin.my) * K; return out; }
export function toLatLon(x, z) { const mx = x / K + origin.mx, my = -z / K + origin.my; return [(2 * Math.atan(Math.exp(my / RE)) - Math.PI / 2) * 180 / Math.PI, mx / RE * 180 / Math.PI]; }
const ZF = 10;                                             // far layer: sea out to the horizon
function tileNWz(z, tx, ty) { const n = Math.pow(2, z); return { mx: -Math.PI * RE + tx * CIRC / n, my: Math.PI * RE - ty * CIRC / n }; }
function tileOfZ(z, lat, lon) { const n = Math.pow(2, z); return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n)]; }
function tileNW(tx, ty) { return { mx: -Math.PI * RE + tx * CIRC / Math.pow(2, Z), my: Math.PI * RE - ty * CIRC / Math.pow(2, Z) }; }
export function tileOf(lat, lon) { const n = Math.pow(2, Z); const x = Math.floor((lon + 180) / 360 * n); const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n); return [x, y]; }

// ---------------------------------------------------------------- collision index (lat/lon)
const R = 6371000;
export function hav(a, b) { const la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180, dla = la2 - la1, dlo = (b[1] - a[1]) * Math.PI / 180; const h = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
export function segDist(p, a, b) { const k = Math.cos(p[0] * Math.PI / 180); const px = p[1] * k, py = p[0], ax = a[1] * k, ay = a[0], bx = b[1] * k, by = b[0]; const dx = bx - ax, dy = by - ay; const t = (dx === 0 && dy === 0) ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))); return [Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * 111320, t]; }
export const CAP = { motorway: 100, trunk: 85, primary: 60, secondary: 48, tertiary: 40, minor: 34, service: 20, motorway_link: 50, trunk_link: 42, primary_link: 36, secondary_link: 34, tertiary_link: 30, raceway: 120, track: 18, offroad: 14 };
const HALF = { motorway: 11, trunk: 10, primary: 8, secondary: 7, tertiary: 6, minor: 5, service: 4, track: 3, raceway: 8, motorway_link: 6, trunk_link: 6, primary_link: 5, secondary_link: 5, tertiary_link: 5 };
const DRIVABLE = new Set(Object.keys(CAP));
const LATIN = /^[A-Za-z0-9 ()\-'./&,]+$/;

export class Index {
  constructor(names) { this.cell = 0.0005; this.roads = new Map(); this.names = new Map(); this.blds = new Map(); this.water = new Map(); this.tiles = new Map(); this.D = names; this.ready = false; }
  key(lat, lon) { return Math.floor(lat / this.cell) + "_" + Math.floor(lon / this.cell); }
  cells(a, b, c, d) { const out = []; for (let i = Math.floor(a / this.cell); i <= Math.floor(c / this.cell); i++) for (let j = Math.floor(b / this.cell); j <= Math.floor(d / this.cell); j++) out.push(i + "_" + j); return out; }
  put(store, k, item, reg) { item.__t = this.curKey; let a = store.get(k); if (!a) { a = []; store.set(k, a); } a.push(item); reg.push([store, k]); }
  addLine(store, flat, item, padM, reg, elev) {
    const pad = padM / 111320;
    for (let i = 0; i < flat.length - 2; i += 2) {
      const a = [flat[i + 1], flat[i]], b = [flat[i + 3], flat[i + 2]];
      const e0 = elev ? elev[i / 2] : 0, e1 = elev ? elev[i / 2 + 1] : 0;
      const n = Math.max(1, Math.ceil(hav(a, b) / 60));
      for (let k = 0; k < n; k++) {
        const p = [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n], q = [a[0] + (b[0] - a[0]) * (k + 1) / n, a[1] + (b[1] - a[1]) * (k + 1) / n];
        const seg = Object.assign({ a: p, b: q, ea: e0 + (e1 - e0) * k / n, eb: e0 + (e1 - e0) * (k + 1) / n }, item);
        for (const c of this.cells(Math.min(p[0], q[0]) - pad, Math.min(p[1], q[1]) - pad, Math.max(p[0], q[0]) + pad, Math.max(p[1], q[1]) + pad)) this.put(store, c, seg, reg);
      }
    }
  }
  addPoly(store, rings, reg) {
    // rings: flat [lon, lat, ...] arrays -> [[lon, lat], ...]
    const rr = rings.map(fr => { const o = []; for (let i = 0; i < fr.length; i += 2) o.push([fr[i], fr[i + 1]]); return o; });
    let a = 90, b = 180, c = -90, d = -180;
    for (const p of rr[0]) { if (p[1] < a) a = p[1]; if (p[1] > c) c = p[1]; if (p[0] < b) b = p[0]; if (p[0] > d) d = p[0]; }
    const poly = { rings: rr, bbox: [a, b, c, d] };
    for (const k of this.cells(a, b, c, d)) this.put(store, k, poly, reg);
  }
  addTile(key, coll) { for (const _ of this.addTileSteps(key, coll)) { /* run to completion */ } }
  // The same work in slices (a generator), so a new tile's index is built across a few frames
  // instead of stalling one frame for 100+ ms. Dropped mid-build tiles stop early.
  *addTileSteps(key, coll) {
    const reg = []; this.tiles.set(key, reg);
    let n = 0;
    const tick = () => (++n % 150 === 0);
    this.curKey = key;
    for (const r of coll.r) {
      if (!DRIVABLE.has(r.c)) continue;
      const cls = r.r && CAP[r.c + "_link"] ? r.c + "_link" : r.c;
      this.addLine(this.roads, r.g, { cls, brunnel: r.b, hw: HALF[cls] || 5, w: r.w || 2 * (HALF[cls] || 5), ow: !!r.o, ln: r.l || 2, lim: r.m || 0 }, (HALF[cls] || 5) + 4, reg, r.e);
      if (tick()) { yield; if (this.tiles.get(key) !== reg) return; this.curKey = key; }
    }
    for (const nm of coll.n) {
      if (nm.c && !DRIVABLE.has(nm.c)) continue;               // footways, metro access paths, rails: not street names
      const raw = nm.en || nm.lat || nm.nm || "";
      const item = { name: LATIN.test(raw) ? raw : ((this.D && this.D.names[raw]) || nm.lat || raw), ar: nm.ar || (LATIN.test(nm.nm || "") ? "" : nm.nm || ""), ref: nm.ref || (this.D && this.D.refs[nm.nm]) || "", c: nm.c || "" };
      this.addLine(this.names, nm.g, item, 30, reg);
      if (tick()) { yield; if (this.tiles.get(key) !== reg) return; this.curKey = key; }
    }
    for (const b of coll.b) { this.addPoly(this.blds, b, reg); if (tick()) { yield; if (this.tiles.get(key) !== reg) return; this.curKey = key; } }
    for (const w of coll.w) this.addPoly(this.water, w, reg);
    this.ready = true;
  }
  dropTile(key) {
    const reg = this.tiles.get(key); if (!reg) return;
    this.tiles.delete(key);
    const seen = new Set();
    for (const [store, k] of reg) {
      const id = k + (store === this.roads ? "r" : store === this.names ? "n" : store === this.blds ? "b" : "w");
      if (seen.has(id)) continue; seen.add(id);
      const a = store.get(k); if (!a) continue;
      const f = a.filter(it => it.__t !== key);
      if (f.length) store.set(k, f); else store.delete(k);
    }
  }
  // Nearest drivable segment. With a height y, stacked roads are told apart: the deck
  // closest to the car's current height wins, so driving under a flyover stays underneath.
  roadAt(lat, lon, y) {
    let best = null, bd = 1e9, bt = 0;
    for (const s of this.roads.get(this.key(lat, lon)) || []) {
      const [d, t] = segDist([lat, lon], s.a, s.b); if (d >= s.hw + 2.5) continue;
      const e = s.ea + (s.eb - s.ea) * t;
      const score = d + (y === undefined ? e * 0.01 : 2.5 * Math.abs(e - y));
      if (score < bd) { bd = score; best = s; bt = t; }
    }
    if (best) best.eAt = best.ea + (best.eb - best.ea) * bt;
    return best;
  }
  // Nearest street name; service-road and access-path names lose to a real street nearby
  nameAt(lat, lon, maxD) { let bestD = maxD, bestF = null; for (const s of this.names.get(this.key(lat, lon)) || []) { const d = segDist([lat, lon], s.a, s.b)[0] + (s.c === "service" ? 12 : 0) + (/(access|entrance|exit|parking|car park)/i.test(s.name) ? 25 : 0); if (d < bestD) { bestD = d; bestF = s; } } return bestF; }
  inPoly(lat, lon, poly) { const bb = poly.bbox; if (lat < bb[0] || lat > bb[2] || lon < bb[1] || lon > bb[3]) return false; if (!ring(lat, lon, poly.rings[0])) return false; for (let k = 1; k < poly.rings.length; k++) if (ring(lat, lon, poly.rings[k])) return false; return true; }
  // the nearest proper street name within maxD metres (searching the cells around), skipping
  // service lanes and access ways: for naming an unnamed slip road after the road beside it
  nameNear(lat, lon, maxD) {
    const i0 = Math.floor(lat / this.cell), j0 = Math.floor(lon / this.cell), r = Math.ceil(maxD / 50);
    let bestD = maxD, bestF = null;
    for (let i = i0 - r; i <= i0 + r; i++) for (let j = j0 - r; j <= j0 + r; j++) for (const s of this.names.get(i + "_" + j) || []) {
      if (s.c === "service" || /(access|entrance|exit|parking|car park)/i.test(s.name)) continue;
      const d = segDist([lat, lon], s.a, s.b)[0]; if (d < bestD) { bestD = d; bestF = s; }
    }
    return bestF;
  }
  building(lat, lon) { for (const p of this.blds.get(this.key(lat, lon)) || []) if (this.inPoly(lat, lon, p)) return p; return null; }
  blocked(lat, lon) { const k = this.key(lat, lon); for (const p of this.blds.get(k) || []) if (this.inPoly(lat, lon, p)) return true; for (const p of this.water.get(k) || []) if (this.inPoly(lat, lon, p)) return true; return false; }
  hits(lat, lon) { if (!this.ready) return false; if (this.roadAt(lat, lon)) return false; return this.blocked(lat, lon); }
}
function ring(lat, lon, r) { let inside = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const yi = r[i][1], xi = r[i][0], yj = r[j][1], xj = r[j][0]; if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside; } return inside; }

// ---------------------------------------------------------------- tile manager
export class Tiles {
  constructor(scene, opts) {
    this.scene = scene; this.opts = opts;
    this.template = "https://tiles.openfreemap.org/planet/20260913_164504_pt/{z}/{x}/{y}.pbf";
    this.mats = { b: makeBuildingMaterial(), r: makeRoadMaterial(), w: makeWalkMaterial(), a: makeAreaMaterial(), wa: makeWaterMaterial() };
    this.tiles = new Map();
    this.queue = [];
    const n = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
    this.workers = []; this.busy = 0;
    for (let i = 0; i < n; i++) { const w = new Worker(new URL("./tileworker.js", import.meta.url), { type: "module" }); w.onmessage = e => this.onTile(e.data, w); w.onerror = e => console.error("worker", e.message); w.idle = true; this.workers.push(w); }
    this.radius = opts.radius || 2600;
    this.far = new Map(); this.farQueue = []; this.farMat = makeWaterMaterial(true);
    this.farMat.userData.uNearR.value = Math.max(1200, this.radius - 400);
    this.suppress = [];     // [{ poly: [[lat, lon], ...], bbox: [minLat, minLon, maxLat, maxLon] }]: OSM buildings whose centroid is inside are not drawn (landmarks replace them)
    this.stats = { loaded: 0, ms: 0 };
  }
  async init() {
    try { const r = await fetch("https://tiles.openfreemap.org/planet"); const j = await r.json(); if (j.tiles && j.tiles[0]) this.template = j.tiles[0]; } catch (e) { console.warn("tilejson", e); }
  }
  url(x, y) { return this.template.replace("{z}", Z).replace("{x}", x).replace("{y}", y); }
  offsetOfZ(z, tx, ty) { const nw = tileNWz(z, tx, ty); return { x: (nw.mx - origin.mx) * K, z: -(nw.my - origin.my) * K }; }
  updateFar(lat, lon) {
    const [cx, cy] = tileOfZ(ZF, lat, lon); const want = new Set();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = "f" + (cx + dx) + "/" + (cy + dy); want.add(k);
      if (!this.far.has(k)) { this.far.set(k, { key: k, x: cx + dx, y: cy + dy, state: "queued" }); this.farQueue.push(k); }
    }
    for (const [k, t] of this.far) if (!want.has(k) && t.state !== "loading") { if (t.group) { this.scene.remove(t.group); t.group.traverse(o => o.geometry && o.geometry.dispose()); } this.far.delete(k); }
    this.pump();
  }
  offsetOf(tx, ty) { const nw = tileNW(tx, ty); return { x: (nw.mx - origin.mx) * K, z: -(nw.my - origin.my) * K }; }
  // Move the floating origin to (lat, lon) and shift every loaded tile accordingly.
  rebase(lat, lon) {
    origin.mx = mercX(lon); origin.my = mercY(lat);
    for (const t of this.tiles.values()) if (t.group) { const o = this.offsetOf(t.x, t.y); t.group.position.set(o.x, 0, o.z); t.off = o; }
    for (const t of this.far.values()) if (t.group) { const o = this.offsetOfZ(ZF, t.x, t.y); t.group.position.set(o.x, 0, o.z); }
  }
  update(lat, lon, camX, camZ) {
    const [cx, cy] = tileOf(lat, lon);
    const want = new Map();
    const span = Math.ceil(this.radius / TILE) + 1;
    for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) {
      const x = cx + dx, y = cy + dy; const o = this.offsetOf(x, y);
      // distance from the camera to the tile rectangle
      const ddx = Math.max(o.x - camX, 0, camX - (o.x + TILE)), ddz = Math.max(o.z - camZ, 0, camZ - (o.z + TILE));
      const d = Math.hypot(ddx, ddz);
      if (d < this.radius) want.set(x + "/" + y, { x, y, d });
    }
    for (const [k, t] of this.tiles) if (!want.has(k)) { const o = this.offsetOf(t.x, t.y); const ddx = Math.max(o.x - camX, 0, camX - (o.x + TILE)), ddz = Math.max(o.z - camZ, 0, camZ - (o.z + TILE)); if (Math.hypot(ddx, ddz) > this.radius + 900) this.drop(k); }
    const todo = [];
    for (const [k, w] of want) if (!this.tiles.has(k)) todo.push([k, w]);
    todo.sort((a, b) => a[1].d - b[1].d);
    for (const [k, w] of todo) { this.tiles.set(k, { key: k, x: w.x, y: w.y, state: "queued" }); this.queue.push(k); }
    // re-prioritise the queue by distance
    this.queue.sort((a, b) => (want.get(a) ? want.get(a).d : 1e9) - (want.get(b) ? want.get(b).d : 1e9));
    this.pump();
  }
  // Queue the tiles along a route (lat/lon points) for background download into the cache.
  prefetchRoute(geom) {
    const seen = new Set(this.tiles.keys()); const list = [];
    let acc = 0;
    for (let i = 0; i < geom.length; i++) {
      if (i > 0) acc += hav(geom[i - 1], geom[i]);
      if (i > 0 && i < geom.length - 1 && acc < 250) continue; acc = 0;
      const [x, y] = tileOf(geom[i][0], geom[i][1]);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const k = (x + dx) + "/" + (y + dy); if (!seen.has(k)) { seen.add(k); list.push({ key: k, url: this.url(x + dx, y + dy) }); } }
    }
    this.prefetchQ = list;
    this.pump();
    return list.length;
  }
  pump() {
    for (const w of this.workers) {
      if (w.idle && !this.queue.length && this.prefetchQ && this.prefetchQ.length && this.workers.filter(x => x.prefetching).length < 2) {
        const p = this.prefetchQ.shift(); w.idle = false; w.prefetching = true; w.postMessage({ cmd: "prefetch", key: p.key, url: p.url }); continue;
      }
      if (w.idle && !this.queue.length && this.farQueue.length && !this.workers.some(x => x.farBusy)) {
        const k = this.farQueue.shift(); const t = this.far.get(k); if (!t) continue;
        t.state = "loading"; w.idle = false; w.farBusy = true;
        const size = CIRC / Math.pow(2, ZF) * K;
        w.postMessage({ cmd: "tile", far: true, key: k, z: ZF, x: t.x, y: t.y, url: this.template.replace("{z}", ZF).replace("{x}", t.x).replace("{y}", t.y), size });
        continue;
      }
      if (!w.idle || !this.queue.length) continue;
      const k = this.queue.shift(); const t = this.tiles.get(k); if (!t || t.state !== "queued") { continue; }
      t.state = "loading"; w.idle = false;
      w.postMessage({ cmd: "tile", key: k, z: Z, x: t.x, y: t.y, url: this.url(t.x, t.y), size: TILE, suppress: this.suppress });
    }
  }
  // near-only detail (villa walls): chunk by chunk, visible within `r` metres of the camera
  cullNear(camX, camZ, r = 650) {
    for (const t of this.tiles.values()) {
      const m = t.meshes && t.meshes.vw; if (!m || !t.off) continue;
      for (const q of m.userData.parts || [m]) {
        const bb = q.geometry.boundingBox; if (!bb) continue;
        const dx = Math.max(bb.min.x + t.off.x - camX, 0, camX - (bb.max.x + t.off.x)), dz = Math.max(bb.min.z + t.off.z - camZ, 0, camZ - (bb.max.z + t.off.z));
        q.visible = dx * dx + dz * dz < r * r;
      }
    }
  }
  pending() { let n = 0; for (const t of this.tiles.values()) if (t.state !== "ready") n++; return n; }
  onTile(msg, w) {
    const tIn = performance.now();
    try { return this.onTileInner(msg, w); } finally { if (window.PERF_TRACE) window.PERF_TRACE.tileMs += performance.now() - tIn; }
  }
  onTileInner(msg, w) {
    w.idle = true;
    if (msg.far || (msg.key && msg.key[0] === "f")) {
      w.farBusy = false;
      const t = this.far.get(msg.key);
      if (t && !msg.error && msg.water && msg.water.count) {
        const geo = new THREE.BufferGeometry();
        for (const [name, size] of [["position", 3], ["normal", 3], ["color", 3]]) geo.setAttribute(name, new THREE.BufferAttribute(msg.water[name], size));
        geo.setIndex(new THREE.BufferAttribute(msg.water.index, 1)); geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, this.farMat); mesh.matrixAutoUpdate = false; mesh.updateMatrix();
        const g = new THREE.Group(); g.add(mesh); const o = this.offsetOfZ(ZF, t.x, t.y); g.position.set(o.x, 0, o.z);
        this.scene.add(g); t.group = g; t.state = "ready";
      } else if (t) t.state = msg.error ? "error" : "ready";
      this.pump(); return;
    }
    w.prefetching = false;
    if (msg.prefetched) { this.pump(); return; }
    const t = this.tiles.get(msg.key);
    if (!t) { this.pump(); return; }
    if (msg.error) { console.warn("tile", msg.key, msg.error); t.state = "error"; setTimeout(() => { if (this.tiles.get(msg.key) === t) { this.tiles.delete(msg.key); } }, 8000); this.pump(); return; }
    const g = new THREE.Group(); g.name = "tile " + msg.key;
    const o = this.offsetOf(t.x, t.y); g.position.set(o.x, 0, o.z); t.off = o;
    const mk = (d, attrs, mat, cast, recv) => {
      if (!d || !d.count) return null;
      const shared = attrs.map(([name, size]) => [name, new THREE.BufferAttribute(d[name], size)]);
      // chunked meshes: one Mesh per chunk sharing the vertex buffers, each with its own box so
      // the camera and the shadow pass cull them separately
      const parts = d.chunks && d.chunks.length ? d.chunks.map(c => ({ index: c.i, b: c.b })) : [{ index: d.index, b: null }];
      const meshes = [];
      for (const part of parts) {
        const geo = new THREE.BufferGeometry();
        for (const [name, attr] of shared) geo.setAttribute(name, attr);
        geo.setIndex(new THREE.BufferAttribute(part.index, 1));
        if (part.b) { geo.boundingBox = new THREE.Box3(new THREE.Vector3(part.b[0], part.b[1], part.b[2]), new THREE.Vector3(part.b[3], part.b[4], part.b[5])); geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere()); }
        else { geo.computeBoundingSphere(); geo.computeBoundingBox(); }
        const m = new THREE.Mesh(geo, mat); m.castShadow = cast; m.receiveShadow = recv; m.matrixAutoUpdate = false; m.updateMatrix();
        g.add(m); meshes.push(m);
      }
      const first = meshes[0]; first.userData.parts = meshes;
      return first;
    };
    t.meshes = {
      b: mk(msg.buildings, [["position", 3], ["normal", 3], ["uv", 2], ["color", 3], ["facade", 4]], this.mats.b, true, true),
      r: mk(msg.roads, [["position", 3], ["normal", 3], ["uv", 2], ["road", 4], ["junc", 4]], this.mats.r, false, true),
      w: mk(msg.walks, [["position", 3], ["normal", 3], ["uv", 2], ["color", 3]], this.mats.w, true, true),
      vw: mk(msg.vwalls, [["position", 3], ["normal", 3], ["uv", 2], ["color", 3]], this.mats.w, true, true),
      a: mk(msg.areas, [["position", 3], ["normal", 3], ["color", 3]], this.mats.a, false, true),
      wa: mk(msg.water, [["position", 3], ["normal", 3], ["color", 3]], this.mats.wa, false, false),
    };

    this.scene.add(g);
    t.group = g; t.state = "ready"; t.buildingsRaw = msg.buildings;
    // props: split park trees into palms and broadleaf
    const palms = [], trees = [], shrubs = [];
    for (let i = 0; i < msg.palms.length; i += 4) palms.push(msg.palms[i], msg.palms[i + 1], msg.palms[i + 2], msg.palms[i + 3]);
    for (let i = 0; i < msg.parkTrees.length; i += 4) { const kind = Math.floor(msg.parkTrees[i + 3] / 10); (kind === 2 ? shrubs : kind ? trees : palms).push(msg.parkTrees[i], msg.parkTrees[i + 1], msg.parkTrees[i + 2], msg.parkTrees[i + 3] % 10); }
    t.props = { palm: new Float32Array(palms), tree: new Float32Array(trees), shrub: new Float32Array(shrubs), lamp: msg.lamps, roof: msg.roofs, shelter: msg.shelters };
    t.signs = msg.signs; t.signals = msg.signals; t.labels = msg.labels || []; t.places = msg.places || []; t.cuts = msg.cuts && msg.cuts.length ? msg.cuts : null;
    t.traffic = msg.traffic;
    t.coll = msg.coll;
    this.stats.loaded++; this.stats.ms += msg.ms;
    if (this.opts.onReady) this.opts.onReady(t);
    this.pump();
  }
  drop(k) {
    const t = this.tiles.get(k); if (!t) return;
    if (t.group) { this.scene.remove(t.group); t.group.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
    this.tiles.delete(k);
    this.queue = this.queue.filter(q => q !== k);
    if (this.opts.onDrop) this.opts.onDrop(t);
  }
}
