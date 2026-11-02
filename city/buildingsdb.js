// buildingsdb.js: what OpenStreetMap knows about each building (type, name, storeys,
// height, roof shape, colours, materials, amenity / shop / tourism / office tags), baked
// by build/bake_buildings.py into zoom-12 chunk files. The OpenFreeMap vector tiles only
// carry render_height, render_min_height, colour and hide_3d, so this is how the engine
// learns what a footprint really is: it asks which baked interior point lies inside the
// footprint ring. Dependency free (no DOM, no three.js): runs in a module Web Worker and
// on the main thread.
//
// CHUNK FILES
//   data/buildings/12/{x}/{y}.json, keyed by the zoom-12 slippy tile (x, y) that holds the
//   record's point. A zoom-14 tile (x, y) lies in chunk (x >> 2, y >> 2). A missing file
//   (404) means no data there. data/buildings/index.json lists the chunks with the
//   generation date and counts (by type, names, storeys, heights, roof shapes, colours).
//
//   { "v": 1,
//     "a": [ attrs, ... ],                     deduplicated attribute sets, referenced by index
//     "b": [ [ai, lat, lon, area, id], ... ] } one row per point, sorted by lat then lon
//
//   Rows: ai indexes "a". lat and lon are integers in 1e-6 degrees (absolute), a point
//   guaranteed to lie inside the building: the area-weighted centroid when it is at least
//   2 m inside the outline (holes count as outside), otherwise the pole of inaccessibility.
//   area is the footprint in square metres (the outer ring minus its holes; at least 1).
//   id is the OSM element: a way id, or minus the id of a multipolygon relation. A
//   multipolygon with several outer rings has one row per outer ring (same id and attrs,
//   each with its own point and area), so every ring the engine draws can find it.
//   An optional sixth element says how the building meets the zoom-14 tile grid the engine
//   clips rings to:
//     absent  the whole building lies in one zoom-14 tile
//     1       the building's main point, for a building that crosses a zoom-14 tile edge
//     2       a piece point: the interior point of the part of such a building that lies in
//             another zoom-14 tile (same attrs and area as the main row, which may sit in a
//             different chunk). Every piece of at least 12 m2 has one, so a clipped ring
//             still finds its building.
//
//   attrs keys (a key is omitted when OSM has no usable value):
//     t   building type: the building=* value ("apartments", "house", "villa", "office",
//         "hotel", "retail", "commercial", "warehouse", "mosque", "school", ...), lower
//         case; absent for building=yes. For a building:part, its building:part value
//         when that is not "yes" (or its building=* value).
//     n   name        ne  name:en        na  name:ar        (as in OSM)
//     l   building:levels, storeys above ground (number, may be fractional). The UAE
//         style "G+12" is stored as 13, "B+G+4" as 5, "G+M+4" as 6 (mezzanine counted).
//     ml  building:min_level
//     h   height (metres)      mh  min_height (metres)
//         Numbers are parsed from "12", "12 m", "12,5", "40;41" (first value), "30 ft".
//     rs  roof:shape (lower case: "flat", "dome", "gabled", "hipped", "pyramidal", ...)
//     rh  roof:height (metres)     rl  roof:levels
//     rc  roof:colour, c  building:colour (or colour): "#rrggbb", from hex or CSS names
//     bm  building:material        rm  roof:material        (lower case, as in OSM)
//     am  amenity   sh  shop   tu  tourism   of  office   rg  religion   le  leisure
//     p   1 for a building:part (an OSM building:part way or multipolygon)
//     pa  for a building:part: the type / name / amenity / shop / tourism / office /
//         religion / leisure keys (same short keys) of the smallest baked building
//         outline that holds the part's point, when that outline has any of them
//
// WHAT IS BAKED
//   Building ways and multipolygon relations with at least one tag beyond a bare
//   building=yes, and every building:part. A building=yes with no other useful tag has no
//   record, so a footprint without a match is simply an untagged building.
//
// API
//   buildingsForTile(z, x, y, baseUrl) -> Promise<BuildingsTile | null>
//       z >= 12. Resolves to the chunk containing the tile, or null when there is no data
//       (404) or the fetch failed (a failure is not cached, so a later call retries).
//       Chunks are kept in an LRU of 24 and each chunk is fetched at most once at a time.
//       baseUrl is the folder that holds data/, ending in "/". It defaults to the folder
//       above this file (new URL("../", import.meta.url)), which is right both on the main
//       thread and in a module worker.
//   buildingsForLatLon(lat, lon, baseUrl) -> Promise<BuildingsTile | null>   same, by position.
//   BuildingsTile.inRing(ringLonLat, bbox) -> null | record
//       ringLonLat: a footprint's outer ring as a flat [lon, lat, lon, lat, ...] array
//       (closed or not). bbox: [minLon, minLat, maxLon, maxLat] of the ring (computed when
//       omitted). Only points in this chunk are searched: ask the chunk of the zoom-14
//       tile the ring came from. Of the points inside the ring:
//         - non-part buildings win over parts;
//         - among non-parts, those whose area "fits" the ring win (area within a factor
//           of 3 of the ring's area; for a building split across zoom-14 tiles only the
//           lower bound applies, since the ring is then a clipped piece), and of those
//           the largest; with none fitting, the one closest to the ring's area;
//         - with only parts inside, the part closest to the ring's area (stacked parts
//           overlap in plan, so area is the best geometric hint; parts carry h / mh to
//           match against render_height / render_min_height).
//       The record has every attrs field expanded (below) plus
//         lat, lon, area   the chosen point and the building's area (m2)
//         osm              "way/123" or "relation/456" (openstreetmap.org/<osm>)
//         split, piece     booleans from the row's sixth element
//         ringArea         the query ring's area (m2)
//         areaRatio        area / ringArea
//         fit              whether the area fits the ring as described above
//         count            how many baked points lie inside the ring
//         parts            the building:part records inside the ring other than the
//                          chosen one (one per OSM part), sorted by minHeight then
//                          area (empty array if none)
//   BuildingsTile.near(lat, lon, radiusM = 50) -> [record + { dist }] sorted by distance
//       (metres from the point to each baked point). A building with several points in
//       range (a split building's main and piece points) is listed once, at its nearest
//       point. For debugging.
//   BuildingsTile.records(minLat, minLon, maxLat, maxLon, withPieces = false) -> [record]
//       every record whose point lies in the box (piece points only when asked).
//   Expanded attrs fields (null when absent): type, name, nameEn, nameAr, levels,
//   minLevel, height, minHeight, roofShape, roofHeight, roofLevels, roofColour, colour,
//   material, roofMaterial, amenity, shop, tourism, office, religion, leisure,
//   part (boolean), parent (null or { type, name, nameEn, nameAr, amenity, shop,
//   tourism, office, religion, leisure } with nulls for absent keys).
//
// Data: OpenStreetMap contributors, ODbL.

const CHUNK_Z = 12;
const LRU_MAX = 24;
const CELL_DEG = 0.0005;     // grid cell edge, about 50 m
const FIT = 3;               // a record "fits" a ring when its area is within this factor
const RAD = Math.PI / 180;

const cache = new Map();     // key -> Promise<BuildingsTile|null>; Map order is the LRU order
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

export function buildingsForTile(z, x, y, baseUrl = DEFAULT_BASE) {
  if (!(z >= CHUNK_Z)) return Promise.resolve(null);
  const d = 2 ** (z - CHUNK_Z);
  return loadChunk(Math.floor(x / d), Math.floor(y / d), baseUrl);
}

export function buildingsForLatLon(lat, lon, baseUrl = DEFAULT_BASE) {
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
    const r = await fetch(baseUrl + "data/buildings/" + CHUNK_Z + "/" + cx + "/" + cy + ".json");
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("buildings chunk " + cx + "/" + cy + ": HTTP " + r.status);
    const json = await r.json();
    return json && json.b && json.b.length ? new BuildingsTile(json, cx, cy) : null;
  })().catch(() => {
    if (cache.get(key) === p) cache.delete(key);
    return null;
  });
  cache.set(key, p);
  while (cache.size > LRU_MAX) cache.delete(cache.keys().next().value);
  return p;
}

function expandParent(a) {
  if (!a) return null;
  const v = (k) => (a[k] === undefined ? null : a[k]);
  return Object.freeze({
    type: v("t"), name: v("n"), nameEn: v("ne"), nameAr: v("na"), amenity: v("am"), shop: v("sh"),
    tourism: v("tu"), office: v("of"), religion: v("rg"), leisure: v("le"),
  });
}

function expandAttrs(a) {
  const v = (k) => (a[k] === undefined ? null : a[k]);
  return Object.freeze({
    type: v("t"), name: v("n"), nameEn: v("ne"), nameAr: v("na"),
    levels: v("l"), minLevel: v("ml"), height: v("h"), minHeight: v("mh"),
    roofShape: v("rs"), roofHeight: v("rh"), roofLevels: v("rl"), roofColour: v("rc"), colour: v("c"),
    material: v("bm"), roofMaterial: v("rm"),
    amenity: v("am"), shop: v("sh"), tourism: v("tu"), office: v("of"), religion: v("rg"), leisure: v("le"),
    part: a.p === 1, parent: expandParent(a.pa),
  });
}

export class BuildingsTile {
  constructor(json, cx, cy) {
    this.z = CHUNK_Z;
    this.x = cx;
    this.y = cy;
    this.west = cx / (1 << CHUNK_Z) * 360 - 180;
    this.east = (cx + 1) / (1 << CHUNK_Z) * 360 - 180;
    this.north = tileY2lat(cy, CHUNK_Z);
    this.south = tileY2lat(cy + 1, CHUNK_Z);
    const { kx, ky } = metresPerDeg((this.north + this.south) / 2);
    this.kx = kx;
    this.ky = ky;
    this.attrs = (json.a || []).map(expandAttrs);
    const b = json.b || [];
    const n = b.length;
    this.count = n;
    this.lat = new Float64Array(n);
    this.lon = new Float64Array(n);
    this.area = new Float64Array(n);
    this.id = new Float64Array(n);       // OSM way id, or minus the relation id
    this.ai = this.attrs.length > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    this.kind = new Uint8Array(n);       // 0 whole, 1 main point of a split building, 2 piece point
    this.isPart = new Uint8Array(n);
    let pieces = 0;
    for (let i = 0; i < n; i++) {
      const r = b[i];
      this.ai[i] = r[0];
      this.lat[i] = r[1] / 1e6;
      this.lon[i] = r[2] / 1e6;
      this.area[i] = r[3];
      this.id[i] = r[4];
      this.kind[i] = r.length > 5 ? r[5] : 0;
      if (this.kind[i] === 2) pieces++;
      this.isPart[i] = this.attrs[r[0]] && this.attrs[r[0]].part ? 1 : 0;
    }
    this.pieceCount = pieces;
    this.grid = null;
    this.cand = new Int32Array(64);
  }

  // Uniform grid over the chunk, CSR layout: pts[start[c] .. start[c+1]) are the points in
  // cell c. Points outside the chunk bounds (none, by construction) are clamped in.
  buildGrid() {
    const nx = Math.max(1, Math.ceil((this.east - this.west) / CELL_DEG));
    const ny = Math.max(1, Math.ceil((this.north - this.south) / CELL_DEG));
    const n = this.count;
    const cellOf = new Int32Array(n);
    const start = new Int32Array(nx * ny + 1);
    for (let k = 0; k < n; k++) {
      let i = Math.floor((this.lon[k] - this.west) / CELL_DEG);
      let j = Math.floor((this.lat[k] - this.south) / CELL_DEG);
      i = i < 0 ? 0 : i >= nx ? nx - 1 : i;
      j = j < 0 ? 0 : j >= ny ? ny - 1 : j;
      const c = j * nx + i;
      cellOf[k] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < nx * ny; c++) start[c + 1] += start[c];
    const pts = new Int32Array(n);
    const fill = start.slice(0, nx * ny);
    for (let k = 0; k < n; k++) pts[fill[cellOf[k]]++] = k;
    this.grid = { nx, ny, start, pts };
    return this.grid;
  }

  record(k) {
    return Object.assign({}, this.attrs[this.ai[k]], {
      lat: this.lat[k], lon: this.lon[k], area: this.area[k],
      osm: this.id[k] < 0 ? "relation/" + -this.id[k] : "way/" + this.id[k],
      split: this.kind[k] === 1, piece: this.kind[k] === 2,
    });
  }

  inRing(ring, bbox) {
    const n = ring.length >> 1;
    if (n < 3 || !this.count) return null;
    let minLon, minLat, maxLon, maxLat;
    if (bbox) {
      minLon = bbox[0]; minLat = bbox[1]; maxLon = bbox[2]; maxLat = bbox[3];
    } else {
      minLon = minLat = Infinity; maxLon = maxLat = -Infinity;
      for (let i = 0; i < 2 * n; i += 2) {
        const lo = ring[i], la = ring[i + 1];
        if (lo < minLon) minLon = lo;
        if (lo > maxLon) maxLon = lo;
        if (la < minLat) minLat = la;
        if (la > maxLat) maxLat = la;
      }
    }
    if (maxLon < this.west || minLon > this.east || maxLat < this.south || minLat > this.north) return null;
    const g = this.grid || this.buildGrid();
    const { nx, ny, start, pts } = g;
    const i0 = Math.max(0, Math.floor((minLon - this.west) / CELL_DEG));
    const i1 = Math.min(nx - 1, Math.floor((maxLon - this.west) / CELL_DEG));
    const j0 = Math.max(0, Math.floor((minLat - this.south) / CELL_DEG));
    const j1 = Math.min(ny - 1, Math.floor((maxLat - this.south) / CELL_DEG));
    const LA = this.lat, LO = this.lon;
    let cand = this.cand, found = 0;
    for (let j = j0; j <= j1; j++) {
      for (let c = j * nx + i0, ce = j * nx + i1; c <= ce; c++) {
        for (let p = start[c], e = start[c + 1]; p < e; p++) {
          const k = pts[p];
          const la = LA[k], lo = LO[k];
          if (lo < minLon || lo > maxLon || la < minLat || la > maxLat) continue;
          // even-odd ray cast on the flat ring
          let inside = false;
          for (let a = 0, b = 2 * n - 2; a < 2 * n; b = a, a += 2) {
            const ya = ring[a + 1], yb = ring[b + 1];
            if ((ya > la) !== (yb > la) && lo < (ring[b] - ring[a]) * (la - ya) / (yb - ya) + ring[a]) inside = !inside;
          }
          if (!inside) continue;
          if (found === cand.length) {
            const c2 = new Int32Array(found * 2); c2.set(cand); cand = this.cand = c2;
          }
          cand[found++] = k;
        }
      }
    }
    if (!found) return null;

    // ring area in m2 (shoelace in degrees, scaled at the chunk's latitude)
    let s = 0;
    for (let a = 0, b = 2 * n - 2; a < 2 * n; b = a, a += 2) s += ring[b] * ring[a + 1] - ring[a] * ring[b + 1];
    const ringArea = Math.max(1e-6, Math.abs(s) / 2 * this.kx * this.ky);
    const AR = this.area, KIND = this.kind, PART = this.isPart;
    const fits = (k) => {
      const r = AR[k] / ringArea;
      return KIND[k] ? r >= 1 / FIT : r >= 1 / FIT && r <= FIT;
    };
    let best = -1, bestFit = false, bestClose = Infinity;
    for (let q = 0; q < found; q++) {
      const k = cand[q];
      if (PART[k]) continue;
      if (fits(k)) {
        if (!bestFit || AR[k] > AR[best]) { best = k; bestFit = true; }
      } else if (!bestFit) {
        const close = Math.abs(Math.log(AR[k] / ringArea));
        if (close < bestClose) { best = k; bestClose = close; }
      }
    }
    if (best < 0) {
      for (let q = 0; q < found; q++) {
        const k = cand[q];
        const close = Math.abs(Math.log(AR[k] / ringArea));
        if (close < bestClose) { best = k; bestClose = close; }
      }
      bestFit = fits(best);
    }
    const out = this.record(best);
    out.ringArea = ringArea;
    out.areaRatio = AR[best] / ringArea;
    out.fit = bestFit;
    out.count = found;
    const parts = [], partIds = [];   // one entry per OSM part (an unclipped ring can hold a main and a piece point)
    for (let q = 0; q < found; q++) {
      const k = cand[q];
      if (!PART[k]) continue;
      const id = this.id[k];
      if (id === this.id[best] || partIds.includes(id)) continue;
      partIds.push(id);
      parts.push(this.record(k));
    }
    if (parts.length > 1) parts.sort((a, b) => (a.minHeight || 0) - (b.minHeight || 0) || b.area - a.area);
    out.parts = parts;
    return out;
  }

  near(lat, lon, radiusM = 50) {
    if (!this.count) return [];
    const g = this.grid || this.buildGrid();
    const { nx, ny, start, pts } = g;
    const dLon = radiusM / this.kx, dLat = radiusM / this.ky;
    const i0 = Math.max(0, Math.floor((lon - dLon - this.west) / CELL_DEG));
    const i1 = Math.min(nx - 1, Math.floor((lon + dLon - this.west) / CELL_DEG));
    const j0 = Math.max(0, Math.floor((lat - dLat - this.south) / CELL_DEG));
    const j1 = Math.min(ny - 1, Math.floor((lat + dLat - this.south) / CELL_DEG));
    const nearest = new Map();   // OSM id -> [k, dist], one entry per building
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * nx + i;
        for (let p = start[c], e = start[c + 1]; p < e; p++) {
          const k = pts[p];
          const d = Math.hypot((this.lon[k] - lon) * this.kx, (this.lat[k] - lat) * this.ky);
          if (d > radiusM) continue;
          const had = nearest.get(this.id[k]);
          if (!had || d < had[1]) nearest.set(this.id[k], [k, d]);
        }
      }
    }
    const out = [];
    for (const [k, d] of nearest.values()) {
      const r = this.record(k);
      r.dist = d;
      out.push(r);
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  records(minLat, minLon, maxLat, maxLon, withPieces = false) {
    const out = [];
    for (let k = 0; k < this.count; k++) {
      if (!withPieces && this.kind[k] === 2) continue;
      const la = this.lat[k], lo = this.lon[k];
      if (la >= minLat && la <= maxLat && lo >= minLon && lo <= maxLon) out.push(this.record(k));
    }
    return out;
  }
}
