// roadsdb.js: lane counts, turn lanes, speed limits and traffic signals from OpenStreetMap,
// baked by build/bake_roads.py into zoom-12 chunk files, plus lane guidance from an
// OSRM-format route. Dependency free (no DOM, no three.js): runs in a module Web Worker
// and on the main thread.
//
// CHUNK FILES
//   data/roads/12/{x}/{y}.json, keyed by the zoom-12 slippy tile (x, y). A zoom-14 tile
//   (x, y) lies in chunk (x >> 2, y >> 2). A missing file (404) means no data there.
//   data/roads/index.json lists the chunks with the generation date and counts.
//
//   { "v": 1,
//     "a": [ attrs, ... ],               deduplicated attribute sets, referenced by index
//     "w": [ [ai, lat0, lon0, dlat1, dlon1, dlat2, dlon2, ...], ... ],   polylines
//     "s": [ [lat, lon, ped], ... ] }    traffic signal nodes
//
//   attrs keys (a key is omitted when OSM has no usable value, except "o" and "r"):
//     l  lanes              lf lanes:forward        lb lanes:backward        (integers)
//     t  turn:lanes         tf turn:lanes:forward   tb turn:lanes:backward   (raw OSM strings,
//        for example "left;through|through|right")
//     m  maxspeed           mf maxspeed:forward     mb maxspeed:backward     (integer km/h;
//        "50 mph" is stored as 80, values like "none" or "AE:urban" are dropped)
//     o  oneway: 1 along the digitised direction, -1 against it, 0 two-way. Implied 1 for
//        highway=motorway and junction=roundabout unless OSM says oneway=no.
//     r  1 for junction=roundabout, else 0
//     h  OSM highway class ("motorway", "primary_link", "residential", ...)
//
//   Polylines: ai indexes "a". Coordinates are integers in 1e-6 degrees; the first vertex
//   is absolute, every later vertex is the difference from the one before it. Vertex
//   order is the OSM way's digitised order. A way crossing chunk borders is split per
//   chunk; every segment that touches a chunk, or passes within about 30 m of it, is in
//   that chunk, so the border-crossing segment appears in both neighbours. One OSM way
//   can therefore appear as several polylines.
//
//   Signals: lat and lon in 1e-6 degrees (absolute). ped = 0 for highway=traffic_signals
//   (a signal for vehicles), 1 for a node that is only a signalled pedestrian crossing
//   (crossing=traffic_signals, usually highway=crossing). Each signal is in exactly one
//   chunk, the one containing it.
//
// API
//   roadsForTile(z, x, y, baseUrl)  -> Promise<RoadsTile | null>
//       z >= 12. Resolves to the chunk containing the tile, or null when there is no data
//       (404) or the fetch failed (a failure is not cached, so a later call retries).
//       Chunks are kept in an LRU of 16 and each chunk is fetched at most once at a time.
//       baseUrl is the folder that holds data/, ending in "/". It defaults to the folder
//       above this file (new URL("../", import.meta.url)), which is right both on the main
//       thread and in a module worker, where a bare relative URL would resolve against
//       the worker script's own folder instead.
//   roadsForLatLon(lat, lon, baseUrl) -> Promise<RoadsTile | null>   same, by position.
//   RoadsTile.match(lat, lon, bearingDeg, maxDistM = 12) -> null | {
//       lanes, lanesFwd, lanesBwd, turn, turnFwd, turnBwd, maxspeed, maxFwd, maxBwd,
//       oneway, roundabout, hw,   (the attributes above; null when absent)
//       dir,    +1 if bearingDeg agrees with the way's digitised direction, -1 if opposite
//       dist,   metres from the point to the matched segment
//       angle } degrees between bearingDeg and the segment, folded to 0..90
//     Best segment = smallest dist + 0.2 m per degree of angle, plus 3 m when the segment
//     is one-way and bearingDeg runs against it (this keeps a car on its own carriageway
//     of a dual carriageway). Segments more than 35 degrees off are rejected. With a
//     non-finite bearingDeg the angle test is skipped and dir is 0.
//   RoadsTile.signals(minLat, minLon, maxLat, maxLon) -> [[lat, lon, ped], ...]
//   resolveLanes(m, travelAgreesWithWay) -> { count, turns, maxspeed }
//   lanesFromOsrm(osrmJson, geom, maxDistM = 30) -> [{ at, lanes: [{ ind, valid, active }] }]
//
// Data: OpenStreetMap contributors, ODbL.

const CHUNK_Z = 12;
const LRU_MAX = 16;
const CELL_DEG = 0.0005;     // grid cell edge
const PAD_M = 12;            // a cell lists every segment within this distance of it (default maxDistM)
const ANGLE_W = 0.2;         // metres of penalty per degree of heading difference
const WRONG_WAY_M = 3;       // penalty for running against a one-way segment
const MAX_ANGLE = 35;        // degrees
const COS_MAX = Math.cos(MAX_ANGLE * Math.PI / 180);
const RAD = Math.PI / 180;

const cache = new Map();     // key -> Promise<RoadsTile|null>; Map order is the LRU order
const DEFAULT_BASE = new URL("../", import.meta.url).href;

function lat2tileY(lat, z) {
  const r = Math.max(-85.05, Math.min(85.05, lat)) * RAD;
  return Math.floor((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * (1 << z));
}
function lon2tileX(lon, z) {
  return Math.floor((lon + 180) / 360 * (1 << z));
}
function tileY2lat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / (1 << z);
  return Math.atan(Math.sinh(n)) / RAD;
}

// metres per degree at a latitude (WGS84 series), good to well under 0.1 percent
function metresPerDeg(lat) {
  const p = lat * RAD;
  return {
    kx: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p),
    ky: 111132.954 - 559.822 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p),
  };
}

export function roadsForTile(z, x, y, baseUrl = DEFAULT_BASE) {
  if (!(z >= CHUNK_Z)) return Promise.resolve(null);
  const d = 2 ** (z - CHUNK_Z);
  return loadChunk(Math.floor(x / d), Math.floor(y / d), baseUrl);
}

export function roadsForLatLon(lat, lon, baseUrl = DEFAULT_BASE) {
  return loadChunk(lon2tileX(lon, CHUNK_Z), lat2tileY(lat, CHUNK_Z), baseUrl);
}

function loadChunk(cx, cy, baseUrl) {
  const key = baseUrl + "|" + cx + "/" + cy;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = (async () => {
    const r = await fetch(baseUrl + "data/roads/" + CHUNK_Z + "/" + cx + "/" + cy + ".json");
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("roads chunk " + cx + "/" + cy + ": HTTP " + r.status);
    const json = await r.json();
    return json && ((json.w && json.w.length) || (json.s && json.s.length)) ? new RoadsTile(json, cx, cy) : null;
  })().catch(() => {
    if (cache.get(key) === p) cache.delete(key);
    return null;
  });
  cache.set(key, p);
  while (cache.size > LRU_MAX) cache.delete(cache.keys().next().value);
  return p;
}

function expandAttrs(a) {
  const v = (k) => (a[k] === undefined ? null : a[k]);
  return {
    lanes: v("l"), lanesFwd: v("lf"), lanesBwd: v("lb"),
    turn: v("t"), turnFwd: v("tf"), turnBwd: v("tb"),
    maxspeed: v("m"), maxFwd: v("mf"), maxBwd: v("mb"),
    oneway: a.o | 0, roundabout: a.r | 0, hw: v("h"),
  };
}

export class RoadsTile {
  constructor(json, cx, cy) {
    this.z = CHUNK_Z;
    this.x = cx;
    this.y = cy;
    this.west = cx / (1 << CHUNK_Z) * 360 - 180;
    this.east = (cx + 1) / (1 << CHUNK_Z) * 360 - 180;
    this.north = tileY2lat(cy, CHUNK_Z);
    this.south = tileY2lat(cy + 1, CHUNK_Z);
    this.attrs = (json.a || []).map(expandAttrs);
    this.lat0 = this.south;
    this.lon0 = this.west;
    const { kx, ky } = metresPerDeg((this.north + this.south) / 2);
    this.kx = kx;
    this.ky = ky;

    // vertices in local metres (x east, y north from the chunk's south-west corner)
    const lines = json.w || [];
    let nv = 0;
    for (const l of lines) nv += (l.length - 1) >> 1;
    const vx = new Float64Array(nv), vy = new Float64Array(nv);
    const segA = new Int32Array(Math.max(0, nv - lines.length));   // segment -> first vertex
    const segAttr = this.attrs.length > 65535 ? new Uint32Array(segA.length) : new Uint16Array(segA.length);
    const lineStart = new Int32Array(lines.length + 1);
    let vi = 0, si = 0;
    for (let li = 0; li < lines.length; li++) {
      const l = lines[li];
      lineStart[li] = vi;
      let la = 0, lo = 0;
      for (let k = 1; k < l.length; k += 2) {
        la += l[k];
        lo += l[k + 1];
        vx[vi] = (lo / 1e6 - this.lon0) * kx;
        vy[vi] = (la / 1e6 - this.lat0) * ky;
        if (k > 1) {
          segA[si] = vi - 1;
          segAttr[si] = l[0];
          si++;
        }
        vi++;
      }
    }
    lineStart[lines.length] = vi;
    this.vx = vx;
    this.vy = vy;
    this.segA = segA;
    this.segAttr = segAttr;
    this.lineStart = lineStart;
    const segOneway = new Int8Array(si);
    for (let k = 0; k < si; k++) segOneway[k] = this.attrs[segAttr[k]] ? this.attrs[segAttr[k]].oneway : 0;
    this.segOneway = segOneway;
    this.lineAttr = Int32Array.from(lines, (l) => l[0]);
    this.lineCount = lines.length;
    this.segCount = si;

    const s = json.s || [];
    this.sigLat = new Float64Array(s.length);
    this.sigLon = new Float64Array(s.length);
    this.sigPed = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      this.sigLat[i] = s[i][0] / 1e6;
      this.sigLon[i] = s[i][1] / 1e6;
      this.sigPed[i] = s[i][2] ? 1 : 0;
    }
    this.grid = null;
  }

  // Uniform grid over the vertex extent, CSR layout: cells[cellStart[c] .. cellStart[c+1])
  // are the segments within PAD_M of cell c.
  buildGrid() {
    const { vx, vy, segA } = this;
    const cw = CELL_DEG * this.kx, ch = CELL_DEG * this.ky;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < vx.length; i++) {
      if (vx[i] < minX) minX = vx[i];
      if (vx[i] > maxX) maxX = vx[i];
      if (vy[i] < minY) minY = vy[i];
      if (vy[i] > maxY) maxY = vy[i];
    }
    if (!(maxX >= minX)) {
      this.grid = { nx: 0, ny: 0 };
      return this.grid;
    }
    minX -= PAD_M; minY -= PAD_M; maxX += PAD_M; maxY += PAD_M;
    const nx = Math.max(1, Math.ceil((maxX - minX) / cw));
    const ny = Math.max(1, Math.ceil((maxY - minY) / ch));
    let pc = new Int32Array(1 << 16), ps = new Int32Array(1 << 16), np = 0;
    const counts = new Int32Array(nx * ny + 1);
    for (let s = 0; s < segA.length; s++) {
      const a = segA[s];
      const ax = vx[a], ay = vy[a], bx = vx[a + 1], by = vy[a + 1];
      const dx = bx - ax, dy = by - ay;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - PAD_M - minX) / cw));
      const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + PAD_M - minX) / cw));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by) - PAD_M - minY) / ch));
      const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by) + PAD_M - minY) / ch));
      for (let j = j0; j <= j1; j++) {
        const y0 = minY + j * ch - PAD_M, y1 = y0 + ch + 2 * PAD_M;
        for (let i = i0; i <= i1; i++) {
          // keep the segment when it crosses the cell grown by PAD_M on every side
          // (Liang-Barsky clip), so any point in the cell sees every segment within PAD_M
          const x0 = minX + i * cw - PAD_M, x1 = x0 + cw + 2 * PAD_M;
          let t0 = 0, t1 = 1;
          if (dx === 0) { if (ax < x0 || ax > x1) continue; }
          else {
            let r0 = (x0 - ax) / dx, r1 = (x1 - ax) / dx;
            if (r0 > r1) { const tmp = r0; r0 = r1; r1 = tmp; }
            if (r0 > t0) t0 = r0;
            if (r1 < t1) t1 = r1;
          }
          if (dy === 0) { if (ay < y0 || ay > y1) continue; }
          else {
            let r0 = (y0 - ay) / dy, r1 = (y1 - ay) / dy;
            if (r0 > r1) { const tmp = r0; r0 = r1; r1 = tmp; }
            if (r0 > t0) t0 = r0;
            if (r1 < t1) t1 = r1;
          }
          if (t0 > t1) continue;
          if (np === pc.length) {
            const n1 = new Int32Array(np * 2); n1.set(pc); pc = n1;
            const n2 = new Int32Array(np * 2); n2.set(ps); ps = n2;
          }
          const c = j * nx + i;
          pc[np] = c;
          ps[np] = s;
          np++;
          counts[c + 1]++;
        }
      }
    }
    for (let c = 0; c < nx * ny; c++) counts[c + 1] += counts[c];
    const cellSegs = new Int32Array(np);
    const fill = counts.slice(0, nx * ny);
    for (let k = 0; k < np; k++) cellSegs[fill[pc[k]]++] = ps[k];
    // per-segment start, direction, 1/length^2 and 1/length packed together, so testing a
    // candidate reads one short run of memory
    const sg = new Float32Array(segA.length * 6);
    for (let s = 0; s < segA.length; s++) {
      const a = segA[s], dx = vx[a + 1] - vx[a], dy = vy[a + 1] - vy[a], L2 = dx * dx + dy * dy;
      sg[s * 6] = vx[a];
      sg[s * 6 + 1] = vy[a];
      sg[s * 6 + 2] = dx;
      sg[s * 6 + 3] = dy;
      sg[s * 6 + 4] = L2 > 0 ? 1 / L2 : 0;
      sg[s * 6 + 5] = L2 > 0 ? 1 / Math.sqrt(L2) : 0;
    }
    this.segGeom = sg;
    this.grid = { nx, ny, minX, minY, cw, ch, cellStart: counts, cellSegs };
    this.stamp = new Uint32Array(segA.length);
    this.stampId = 0;
    return this.grid;
  }

  match(lat, lon, bearingDeg, maxDistM = 12) {
    const g = this.grid || this.buildGrid();
    if (!g.nx) return null;
    const px = (lon - this.lon0) * this.kx, py = (lat - this.lat0) * this.ky;
    const hasB = Number.isFinite(bearingDeg);
    const hx = hasB ? Math.sin(bearingDeg * RAD) : 0, hy = hasB ? Math.cos(bearingDeg * RAD) : 0;
    const sg = this.segGeom, segOne = this.segOneway;
    const { nx, ny, minX, minY, cw, ch, cellStart, cellSegs } = g;
    const max2 = maxDistM * maxDistM;
    let best = Infinity, bestS = -1, bestD2 = 0, bestCos = 0;

    // one cell when every segment within maxDistM is registered in it, else a block of
    // cells with a stamp so a segment seen in two cells is tested once
    let i0, i1, j0, j1, stamp = null, id = 0;
    if (maxDistM <= PAD_M) {
      i0 = i1 = Math.floor((px - minX) / cw);
      j0 = j1 = Math.floor((py - minY) / ch);
      if (i0 < 0 || j0 < 0 || i0 >= nx || j0 >= ny) return null;
    } else {
      const reach = maxDistM - PAD_M;
      i0 = Math.max(0, Math.floor((px - reach - minX) / cw));
      i1 = Math.min(nx - 1, Math.floor((px + reach - minX) / cw));
      j0 = Math.max(0, Math.floor((py - reach - minY) / ch));
      j1 = Math.min(ny - 1, Math.floor((py + reach - minY) / ch));
      stamp = this.stamp;
      id = this.stampId = (this.stampId + 1) >>> 0;
      if (id === 0) {
        stamp.fill(0);
        id = this.stampId = 1;
      }
    }
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * nx + i;
        for (let k = cellStart[c], e = cellStart[c + 1]; k < e; k++) {
          const s = cellSegs[k];
          if (stamp !== null) {
            if (stamp[s] === id) continue;
            stamp[s] = id;
          }
          const o6 = s * 6;
          const rx = px - sg[o6], ry = py - sg[o6 + 1], dx = sg[o6 + 2], dy = sg[o6 + 3];
          let t = (rx * dx + ry * dy) * sg[o6 + 4];
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = rx - t * dx, ey = ry - t * dy;
          const d2 = ex * ex + ey * ey;
          if (d2 > max2) continue;
          let score = Math.sqrt(d2), cs = 0;
          if (hasB) {
            cs = (dx * hx + dy * hy) * sg[o6 + 5];
            const ac = cs < 0 ? -cs : cs;
            if (ac < COS_MAX) continue;
            score += ANGLE_W * Math.acos(ac > 1 ? 1 : ac) / RAD;
            const o = segOne[s];
            if (o !== 0 && o * cs < 0) score += WRONG_WAY_M;
          }
          if (score < best) {
            best = score;
            bestS = s;
            bestD2 = d2;
            bestCos = cs;
          }
        }
      }
    }
    if (bestS < 0) return null;
    const m = this.attrs[this.segAttr[bestS]];
    const ac = bestCos < 0 ? -bestCos : bestCos;
    return {
      lanes: m.lanes, lanesFwd: m.lanesFwd, lanesBwd: m.lanesBwd,
      turn: m.turn, turnFwd: m.turnFwd, turnBwd: m.turnBwd,
      maxspeed: m.maxspeed, maxFwd: m.maxFwd, maxBwd: m.maxBwd,
      oneway: m.oneway, roundabout: m.roundabout, hw: m.hw,
      dir: hasB ? (bestCos >= 0 ? 1 : -1) : 0,
      dist: Math.sqrt(bestD2),
      angle: hasB ? Math.acos(ac > 1 ? 1 : ac) / RAD : null,
    };
  }

  signals(minLat, minLon, maxLat, maxLon) {
    const out = [];
    const { sigLat, sigLon, sigPed } = this;
    for (let i = 0; i < sigLat.length; i++) {
      const la = sigLat[i], lo = sigLon[i];
      if (la >= minLat && la <= maxLat && lo >= minLon && lo <= maxLon) out.push([la, lo, sigPed[i]]);
    }
    return out;
  }
}

function splitTurns(s) {
  if (s == null) return null;
  return String(s).split("|").map((x) => x.trim() || "none");
}

// Lane count, per-lane turn strings and speed limit for the direction of travel.
// travelAgreesWithWay: true (or a positive number, such as match().dir) when travelling
// along the way's digitised direction.
export function resolveLanes(m, travelAgreesWithWay = true) {
  if (!m) return { count: null, turns: null, maxspeed: null };
  const fwd = typeof travelAgreesWithWay === "number" ? travelAgreesWithWay >= 0 : !!travelAgreesWithWay;
  let count = null, turn = null;
  if (m.oneway) {
    const own = m.oneway > 0 ? "Fwd" : "Bwd";
    count = m.lanes != null ? m.lanes : m["lanes" + own] != null ? m["lanes" + own] : null;
    turn = m.turn != null ? m.turn : m["turn" + own] != null ? m["turn" + own] : null;
  } else {
    const own = fwd ? m.lanesFwd : m.lanesBwd;
    if (own != null) count = own;
    else if (m.lanes != null) count = Math.max(1, Math.floor(m.lanes / 2));
    turn = fwd ? m.turnFwd : m.turnBwd;
    if (turn === undefined) turn = null;
  }
  const dirMax = fwd ? m.maxFwd : m.maxBwd;
  const maxspeed = dirMax != null ? dirMax : m.maxspeed != null ? m.maxspeed : null;
  return { count, turns: splitTurns(turn), maxspeed };
}

// Lane guidance for a route. osrmJson: a Valhalla or OSRM response in OSRM format;
// geom: the route as [[lat, lon], ...]. Every intersection that carries lanes is mapped
// to the nearest geom index, searching forward from the previous match so a route that
// passes the same spot twice maps each pass to its own index. Intersections further than
// maxDistM from the route are dropped. build/bake_route_lanes.py implements the same
// mapping in Python for the baked routes.
export function lanesFromOsrm(osrmJson, geom, maxDistM = 30) {
  const route = osrmJson && osrmJson.routes && osrmJson.routes[0];
  const out = [];
  if (!route || !geom || !geom.length) return out;
  let prevSeg = 0;
  for (const leg of route.legs || []) {
    for (const step of leg.steps || []) {
      for (const ix of step.intersections || []) {
        if (!ix.lanes || !ix.lanes.length || !ix.location) continue;
        const hit = nearestOnRoute(geom, ix.location[1], ix.location[0], prevSeg, maxDistM);
        if (!hit) continue;
        prevSeg = hit.seg;
        out.push({
          at: hit.at,
          lanes: ix.lanes.map((l) => ({ ind: (l.indications || []).slice(), valid: !!l.valid, active: !!l.active })),
        });
      }
    }
  }
  return out;
}

function nearestOnRoute(geom, lat, lon, fromSeg, maxDistM) {
  const { kx, ky } = metresPerDeg(lat);
  const n = geom.length;
  if (n === 1) {
    const d = Math.hypot((geom[0][1] - lon) * kx, (geom[0][0] - lat) * ky);
    return d <= maxDistM ? { at: 0, seg: 0 } : null;
  }
  const dist = new Float64Array(n - 1), tt = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const ax = (geom[i][1] - lon) * kx, ay = (geom[i][0] - lat) * ky;
    const dx = (geom[i + 1][1] - geom[i][1]) * kx, dy = (geom[i + 1][0] - geom[i][0]) * ky;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    dist[i] = Math.hypot(ax + t * dx, ay + t * dy);
    tt[i] = t;
  }
  const pick = (lo) => {
    let best = Infinity;
    for (let i = lo; i < n - 1; i++) if (dist[i] < best) best = dist[i];
    if (best > maxDistM) return -1;
    for (let i = lo; i < n - 1; i++) if (dist[i] <= best + 2) return i;
    return -1;
  };
  let seg = pick(Math.min(fromSeg, n - 2));
  if (seg < 0 && fromSeg > 0) seg = pick(0);
  if (seg < 0) return null;
  return { at: tt[seg] <= 0.5 ? seg : seg + 1, seg };
}
