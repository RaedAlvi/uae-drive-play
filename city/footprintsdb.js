// Extra building footprints for Pakistan, machine-learned shapes that OpenStreetMap does not have,
// baked by build/bake_footprints.py from Overture Maps. Dependency free: runs in a module Web Worker.
// Footprints that overlap an OpenStreetMap building are excluded at bake time, so what is returned
// here can be added to the tile's own buildings without double-drawing.
//
//   footprintsForTile(z, x, y, baseUrl)  the call city/tileworker.js makes
//   getTile(z, x, y, baseUrl)            the same; baseUrl is optional
//
// Both resolve to null when the tile has nothing, else to the same shape as one layer of
// city/mvt.js decodeTile:
//   { extent: 4096, features: [{ type: 3, props: { fp_source }, geom: [ring, ...] }] }
// Each ring is a flat closed [x, y, ..., x0, y0] in tile units, outer rings with positive
// mvt.js ringArea and holes negative, so polygons(f.geom) and clipRing work as they do for
// vector tile buildings. Coordinates can lie outside 0..4096: a building touching several tiles is
// stored in each one and the engine clips it, as it does for vector tiles.
// props.fp_source is "microsoft" or "google". There is no render_height: none of these sources has
// a height here, and none is invented, so the caller chooses the default.
//
// Files: data/footprints_pk/index.json (which tiles exist, attribution, counts) and
// data/footprints_pk/14/X/Y.bin:
//   "F" "P" version(1)  varint count  then count records, sorted along a Morton curve:
//   flags byte: bit 0 kind (0 box, 1 polygon), bits 1-2 source (0 microsoft, 1 google), bit 3 holes
//   box:     svarint dx, svarint dy (centre, from the previous record's anchor),
//            varint width, varint length, byte angle (angle = b / 256 * PI of the width edge)
//   polygon: [varint ringCount if holes] then per ring: varint n, then n points; the ring's first
//            point is svarint dx, dy from the previous anchor and becomes the new anchor, the rest
//            are deltas along the ring. Rings are not closed in the file.
// All values are tile units. varint is LEB128, svarint is zigzag over varint.

const Z = 14, EXTENT = 4096, SOURCES = ["microsoft", "google"];

export const ATTRIBUTION = "Building footprints: Overture Maps Foundation (overturemaps.org), ODbL 1.0; © OpenStreetMap contributors; Google Open Buildings (CC BY 4.0); Microsoft Global ML Building Footprints (CDLA Permissive 2.0, via Overture under ODbL)";

const DEFAULT_BASE = new URL("../", import.meta.url).href;
let indexP = null, indexBase = null;

function loadIndex(base) {
  if (!indexP || indexBase !== base) {
    indexBase = base;
    indexP = fetch(base + "data/footprints_pk/index.json")
      .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(j => { const m = new Map(); for (const x in j.tiles) m.set(+x, new Set(j.tiles[x])); return m; })
      .catch(() => new Map());
  }
  return indexP;
}

// Decode one tile file into the layer shape above. Exported for tests.
export function decodeFootprints(ab) {
  const b = new Uint8Array(ab); let p = 3;
  if (b[0] !== 70 || b[1] !== 80 || b[2] !== 1) throw new Error("bad footprint tile");
  // values fit 32 bits: shifts stay in range
  const uv = () => { let v = 0, s = 0, c; do { c = b[p++]; v |= (c & 127) << s; s += 7; } while (c & 128); return v >>> 0; };
  const sv = () => { const v = uv(); return (v >>> 1) ^ -(v & 1); };
  const count = uv(), features = new Array(count);
  let px = 0, py = 0;
  for (let i = 0; i < count; i++) {
    const f = b[p++], src = (f >> 1) & 3;
    const geom = [];
    if ((f & 1) === 0) {
      const cx = (px += sv()), cy = (py += sv());
      const w = uv(), l = uv(), a = b[p++] / 256 * Math.PI;
      const ux = Math.cos(a) * w / 2, uy = Math.sin(a) * w / 2, vx = -Math.sin(a) * l / 2, vy = Math.cos(a) * l / 2;
      const x0 = Math.round(cx - ux - vx), y0 = Math.round(cy - uy - vy);
      geom.push([x0, y0, Math.round(cx + ux - vx), Math.round(cy + uy - vy), Math.round(cx + ux + vx), Math.round(cy + uy + vy), Math.round(cx - ux + vx), Math.round(cy - uy + vy), x0, y0]);
    } else {
      const rings = (f & 8) ? uv() : 1;
      for (let r = 0; r < rings; r++) {
        const n = uv(), ring = new Array(n * 2 + 2);
        let x = (px += sv()), y = (py += sv());
        ring[0] = x; ring[1] = y;
        for (let k = 1; k < n; k++) { x += sv(); y += sv(); ring[k * 2] = x; ring[k * 2 + 1] = y; }
        ring[n * 2] = ring[0]; ring[n * 2 + 1] = ring[1];
        geom.push(ring);
      }
    }
    features[i] = { type: 3, props: { fp_source: SOURCES[src] || "unknown" }, geom };
  }
  return { extent: EXTENT, features };
}

export async function getTile(z, x, y, baseUrl = DEFAULT_BASE) {
  if (z !== Z) return null;
  const idx = await loadIndex(baseUrl);
  const ys = idx.get(x);
  if (!ys || !ys.has(y)) return null;
  const r = await fetch(baseUrl + "data/footprints_pk/" + z + "/" + x + "/" + y + ".bin");
  if (!r.ok) return null;
  return decodeFootprints(await r.arrayBuffer());
}

export const footprintsForTile = getTile;
