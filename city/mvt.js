// Minimal Mapbox Vector Tile decoder (spec 2.1). Enough for OpenMapTiles:
// layers, features, tags, and POINT / LINESTRING / POLYGON geometry in tile units.
// Used by the tile worker; also runs in Node for tests.

function readVarint(buf, st) {
  let res = 0, shift = 0, b;
  do {
    b = buf[st.p++];
    if (shift < 28) res |= (b & 0x7f) << shift;
    else res += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (b & 0x80);
  return res >>> 0 === res ? res : res; // may exceed 2^31 for large values; fine for our use
}
function readSVarint(buf, st) { const n = readVarint(buf, st); return (n % 2 === 1) ? (n + 1) / -2 : n / 2; }
function skip(buf, st, wire) {
  if (wire === 0) { while (buf[st.p++] & 0x80); }
  else if (wire === 2) { const len = readVarint(buf, st); st.p += len; }
  else if (wire === 5) st.p += 4;
  else if (wire === 1) st.p += 8;
  else throw new Error("wire " + wire);
}
const td = new TextDecoder();
function readString(buf, st) { const len = readVarint(buf, st); const s = td.decode(buf.subarray(st.p, st.p + len)); st.p += len; return s; }
function readValue(buf, st, end) {
  let v = null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (st.p < end) {
    const tag = readVarint(buf, st), field = tag >> 3, wire = tag & 7;
    if (field === 1) v = readString(buf, st);
    else if (field === 2) { v = dv.getFloat32(st.p, true); st.p += 4; }
    else if (field === 3) { v = dv.getFloat64(st.p, true); st.p += 8; }
    else if (field === 4 || field === 5) v = readVarint(buf, st);
    else if (field === 6) v = readSVarint(buf, st);
    else if (field === 7) v = !!readVarint(buf, st);
    else skip(buf, st, wire);
  }
  return v;
}

// Returns { layerName: { extent, features: [{ type, props, geom }] } } where geom is an
// array of rings/lines/points, each a flat array [x0,y0,x1,y1,...] in tile units.
// `want` (optional Set) limits which layers are decoded.
export function decodeTile(arrayBuffer, want) {
  const buf = new Uint8Array(arrayBuffer);
  const st = { p: 0 };
  const out = {};
  while (st.p < buf.length) {
    const tag = readVarint(buf, st), field = tag >> 3, wire = tag & 7;
    if (field === 3 && wire === 2) {
      const len = readVarint(buf, st); const end = st.p + len;
      const layer = readLayer(buf, st, end, want);
      if (layer) out[layer.name] = layer;
      st.p = end;
    } else skip(buf, st, wire);
  }
  return out;
}

function readLayer(buf, st, end, want) {
  let name = "", extent = 4096; const keys = [], values = [], feats = [];
  const start = st.p;
  // first pass: name (field 1) may come first; OpenMapTiles writes it first
  while (st.p < end) {
    const tag = readVarint(buf, st), field = tag >> 3, wire = tag & 7;
    if (field === 1) { name = readString(buf, st); if (want && !want.has(name)) return null; }
    else if (field === 2) { const len = readVarint(buf, st); feats.push([st.p, st.p + len]); st.p += len; }
    else if (field === 3) keys.push(readString(buf, st));
    else if (field === 4) { const len = readVarint(buf, st); const e = st.p + len; values.push(readValue(buf, st, e)); st.p = e; }
    else if (field === 5) extent = readVarint(buf, st);
    else skip(buf, st, wire);
  }
  const features = [];
  for (const [a, b] of feats) features.push(readFeature(buf, { p: a }, b, keys, values));
  return { name, extent, features };
}

function readFeature(buf, st, end, keys, values) {
  let type = 0; const props = {}; let geomStart = -1, geomEnd = -1;
  while (st.p < end) {
    const tag = readVarint(buf, st), field = tag >> 3, wire = tag & 7;
    if (field === 2) { const len = readVarint(buf, st); const e = st.p + len; while (st.p < e) { const k = readVarint(buf, st), v = readVarint(buf, st); props[keys[k]] = values[v]; } }
    else if (field === 3) type = readVarint(buf, st);
    else if (field === 4) { const len = readVarint(buf, st); geomStart = st.p; geomEnd = st.p + len; st.p += len; }
    else skip(buf, st, wire);
  }
  const geom = [];
  if (geomStart >= 0) {
    const g = { p: geomStart }; let x = 0, y = 0, cur = null;
    while (g.p < geomEnd) {
      const ci = readVarint(buf, g); const cmd = ci & 7; let count = ci >> 3;
      if (cmd === 1 || cmd === 2) {
        while (count--) {
          x += readSVarint(buf, g); y += readSVarint(buf, g);
          if (cmd === 1) { cur = [x, y]; geom.push(cur); } else cur.push(x, y);
        }
      } else if (cmd === 7) { if (cur) cur.push(cur[0], cur[1]); }
    }
  }
  return { type, props, geom };
}

// Signed area of a flat ring (tile coords, y down). OpenMapTiles/MVT: exterior rings have
// positive area in this convention (clockwise on screen), interiors negative.
export function ringArea(r) { let s = 0; for (let i = 0, n = r.length - 2; i < n; i += 2) s += r[i] * r[i + 3] - r[i + 2] * r[i + 1]; return s / 2; }

// Group polygon rings into [outer, ...holes] polygons.
export function polygons(geom) {
  const polys = []; let cur = null;
  for (const r of geom) {
    const a = ringArea(r);
    if (a === 0) continue;
    if (a > 0 || !cur) { cur = [r]; polys.push(cur); } else cur.push(r);
  }
  return polys;
}
