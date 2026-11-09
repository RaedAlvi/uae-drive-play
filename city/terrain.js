// Real elevation for the Pakistan map. No Three.js in here: the tile workers and the main
// thread both use this module.
//
// Three fields, all baked by build/bake_dem.py from the Terrarium tiles (SRTM 30 m), all
// addressed by position only, so neighbouring tiles and the car always agree:
//   ground()  z12, the land itself
//   road()    z11, a smooth grade (about 70 m Gaussian): what every road rides on
//   bridge()  z11, a closing of the land: spans valleys under bridge decks
// A deck, tunnel or ramp height (the engine's "el", "eAt") stays relative to road().
const S = 256;
const DEC = (z, layers) => ({ z, layers });

async function gunzip(res) {
  const ds = new DecompressionStream("gzip");
  return new Response(res.body.pipeThrough(ds)).arrayBuffer();
}
function decodeLayer(bytes, off) {
  const N = S * S, out = new Int16Array(N);
  for (let i = 0; i < N; i++) {
    const zz = bytes[off + i] | (bytes[off + N + i] << 8);
    const r = (zz >>> 1) ^ -(zz & 1);
    const x = i & (S - 1), y = i >> 8;
    const left = x ? out[i - 1] : 0, up = y ? out[i - S] : 0, ul = x && y ? out[i - S - 1] : 0;
    out[i] = r + (x && y ? left + up - ul : x ? left : y ? up : 0);
  }
  return out;
}

export class Terrain {
  constructor(base) {
    this.base = base.endsWith("/") ? base : base + "/";
    this.sets = null;
    this.t = { g12: new Map(), r11: new Map(), f10: new Map() };   // "x_y" -> { z, layers: [Int16Array] } or null (known absent)
    this.wait = new Map();
    this.max = { g12: 48, r11: 24, f10: 36 };
  }
  async init() {
    if (this.sets) return this;
    const r = await fetch(this.base + "index.json");
    if (!r.ok) throw new Error("dem index " + r.status);
    const j = await r.json();
    this.sets = { g12: new Set(j.g12), r11: new Set(j.r11), f10: new Set(j.f10) };
    return this;
  }
  _load(kind, x, y) {
    const key = x + "_" + y, map = this.t[kind];
    if (map.has(key)) return Promise.resolve();
    if (!this.sets[kind].has(key)) { map.set(key, null); return Promise.resolve(); }
    const wk = kind + key;
    if (this.wait.has(wk)) return this.wait.get(wk);
    const p = (async () => {
      let res = null;
      for (let attempt = 0; attempt < 4 && !res; attempt++) { try { const r = await fetch(`${this.base}${kind}/${key}.bin`); if (r.ok) res = r; else throw new Error("HTTP " + r.status); } catch (err) { if (attempt === 3) throw err; await new Promise(q => setTimeout(q, 250 * (attempt + 1))); } }
      const buf = new Uint8Array(await gunzip(res));
      const n = buf.length / (2 * S * S), layers = [];
      for (let k = 0; k < n; k++) layers.push(decodeLayer(buf, k * 2 * S * S));
      if (map.size >= this.max[kind]) { for (const [q, v] of map) { if (v) { map.delete(q); break; } } }
      map.set(key, DEC(kind === "g12" ? 12 : kind === "r11" ? 11 : 10, layers));
    })().catch(err => { console.warn("terrain", err && err.message); }).finally(() => this.wait.delete(wk));
    this.wait.set(wk, p);
    return p;
  }
  // every tile of each layer that touches the normalised mercator box
  ensureBox(u0, v0, u1, v1) {
    const jobs = [];
    for (const [kind, z] of [["g12", 12], ["r11", 11], ["f10", 10]]) {
      const n = 2 ** z, pad = 3 / (S * n);
      for (let x = Math.floor((u0 - pad) * n); x <= Math.floor((u1 + pad) * n); x++) for (let y = Math.floor((v0 - pad) * n); y <= Math.floor((v1 + pad) * n); y++) jobs.push(this._load(kind, x, y));
    }
    return Promise.all(jobs);
  }
  ensureLL(lat, lon, m = 3000) {
    if (!this.sets) return Promise.resolve();
    const [u, v] = uv(lat, lon), d = m / 40075016 / Math.cos(lat * Math.PI / 180);
    return this.ensureBox(u - d, v - d, u + d, v + d);
  }
  hasLL(lat, lon) { const [u, v] = uv(lat, lon); const q = (kind, z) => this.t[kind].get(Math.floor(u * 2 ** z) + "_" + Math.floor(v * 2 ** z)); return !!q("r11", 11) || !!q("f10", 10); }
  _px(kind, z, lay, ix, iy, mul) {
    const x = ix >> 8, y = iy >> 8, t = this.t[kind].get(x + "_" + y);
    if (t) return t.layers[lay][(iy & 255) * S + (ix & 255)] * mul;
    return NaN;
  }
  _cubic(kind, z, lay, mul, u, v) {
    const n = S * 2 ** z, px = u * n - 0.5, py = v * n - 0.5, ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
    const tx = ix >> 8, ty = iy >> 8, t = this.t[kind].get(tx + "_" + ty);
    if (!t) return NaN;
    const wx = cr(fx), wy = cr(fy);
    const lx = ix & 255, ly = iy & 255;
    let sum = 0;
    if (lx >= 1 && lx <= 253 && ly >= 1 && ly <= 253) {
      const a = t.layers[lay];
      let k = (ly - 1) * S + lx - 1;
      for (let j = 0; j < 4; j++, k += S) sum += wy[j] * (wx[0] * a[k] + wx[1] * a[k + 1] + wx[2] * a[k + 2] + wx[3] * a[k + 3]);
      return sum * mul;
    }
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      let p = this._px(kind, z, lay, ix - 1 + i, iy - 1 + j, mul);
      if (p !== p) p = this._px(kind, z, lay, ix, iy, mul);          // edge of the bake: repeat the nearest known sample
      sum += wy[j] * wx[i] * p;
    }
    return sum;
  }
  // heights by normalised mercator position; NaN when nothing is loaded there
  far(u, v) { return this._cubic("f10", 10, 0, 0.5, u, v); }
  ground(u, v) { const h = this._cubic("g12", 12, 0, 0.5, u, v); return h === h ? h : this.far(u, v); }
  road(u, v) { const h = this._cubic("r11", 11, 0, 0.25, u, v); return h === h ? h : this.ground(u, v); }
  bridge(u, v) { const h = this._cubic("r11", 11, 1, 0.25, u, v); return h === h ? h : this.ground(u, v); }
  groundLL(lat, lon) { const [u, v] = uv(lat, lon); return this.ground(u, v); }
  roadLL(lat, lon) { const [u, v] = uv(lat, lon); return this.road(u, v); }
  // a view in one z/x/y tile's local metres, for the worker's geometry code
  view(z, x, y, TS) {
    const n = 2 ** z, T = this, h2 = (fn, a, b) => { const r = fn.call(T, (x + a / TS) / n, (y + b / TS) / n); return r === r ? r : 0; };
    return {
      ground: (a, b) => h2(T.ground, a, b),
      road: (a, b) => h2(T.road, a, b),
      bridge: (a, b) => h2(T.bridge, a, b),
      TS,
    };
  }
}
function cr(f) { const f2 = f * f, f3 = f2 * f; return [-0.5 * f3 + f2 - 0.5 * f, 1.5 * f3 - 2.5 * f2 + 1, -1.5 * f3 + 2 * f2 + 0.5 * f, 0.5 * f3 - 0.5 * f2]; }
export function uv(lat, lon) { const r = lat * Math.PI / 180; return [(lon + 180) / 360, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2]; }
const smooth = t => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ road lines
// Insert vertices so a road line follows the smooth grade to within 8 cm (tile units in, tile units out).
export function densifyToField(view, pts, S0) {
  const out = [pts[0]], H = (q) => view.road(q[0] * S0, q[1] * S0);
  const rec = (a, b, ha, hb, depth) => {
    const dx = (b[0] - a[0]) * S0, dz = (b[1] - a[1]) * S0, L = Math.hypot(dx, dz);
    if (L < 8 || depth > 9) { out.push(b); return; }
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], hm = H(m);
    if (L < 90 && Math.abs(hm - (ha + hb) / 2) < 0.08) { out.push(b); return; }
    rec(a, m, ha, hm, depth + 1); rec(m, b, hm, hb, depth + 1);
  };
  for (let i = 1; i < pts.length; i++) rec(pts[i - 1], pts[i], H(pts[i - 1]), H(pts[i]), 0);
  return out;
}

// ------------------------------------------------------------------ the ground grid of one tile
export const GRID_N = 192;
const DROP = 0.5;      // the ground sits this far under an at-grade road
const RP = 9, RB = 28;  // the corridor: held flat this far beyond the carriageway edge, then back to the land over this distance
const CUTS = new WeakMap();   // heights array -> how far the road cut lowered each sample: read by tessellate, which carries it to the shader in the length of the normal

export class GroundGrid {
  // T: Terrain, tile: { z, x, y, TS }
  constructor(T, tile) {
    this.T = T; this.N = GRID_N; const M = this.M = GRID_N + 1; this.TS = tile.TS; this.c = tile.TS / GRID_N;
    this.h = new Float32Array(M * M); this.base = new Float32Array(M * M); this.w = new Float32Array(M * M); this.rh = new Float32Array(M * M); this.d = new Float32Array(M * M).fill(1e9); this.under = [];
    this.flagged = new Uint8Array(M * M); this.segs = [];      // segs: at-grade road pieces [ax, az, bx, bz, half width], for the painted verge
    const n = 2 ** tile.z;
    let hmin = 1e9, hmax = -1e9;
    for (let j = 0, k = 0; j < M; j++) for (let i = 0; i < M; i++, k++) {
      let g = T.ground((tile.x + i / GRID_N) / n, (tile.y + j / GRID_N) / n);
      if (g !== g) g = 0;
      this.base[k] = g; if (g < hmin) hmin = g; if (g > hmax) hmax = g;
    }
    this.hmin = hmin; this.hmax = hmax;
    // flat city ground: SRTM reads buildings and trees as bumps of a metre or two, so smooth it away (hills stay as they are)
    const blur = boxBlur(boxBlur(this.base, M, 4), M, 4), rel = new Float32Array(M * M);
    for (let k = 0; k < rel.length; k++) rel[k] = Math.abs(this.base[k] - blur[k]);
    const rb = boxBlur(rel, M, 8);
    for (let k = 0; k < rel.length; k++) { const f = 1 - smooth((rb[k] - 0.8) / 4.2); this.base[k] += (blur[k] - this.base[k]) * f; }
  }
  // one road line: pts [[x, z] metres], h road height at each, hw half width, grade[i] = at grade there
  addRoad(pts, h, hw, grade) {
    const R0 = hw + RP, R1 = R0 + RB, c = this.c, N = this.N, M = this.M, W = this.w, RH = this.rh, F = this.flagged, D = this.d;
    for (let i = 0; i < pts.length - 1; i++) {
      if (!grade[i] && !grade[i + 1]) continue;
      this.segs.push(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], hw);
      this.under.push(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], h[i], h[i + 1], hw);
      const a = pts[i], b = pts[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]), steps = Math.max(1, Math.ceil(L / 36));
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps, t1 = (s + 1) / steps;
        const ax = a[0] + (b[0] - a[0]) * t0, az = a[1] + (b[1] - a[1]) * t0, bx = a[0] + (b[0] - a[0]) * t1, bz = a[1] + (b[1] - a[1]) * t1;
        const ha = h[i] + (h[i + 1] - h[i]) * t0, hb = h[i] + (h[i + 1] - h[i]) * t1;
        const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - R1) / c)), x1 = Math.min(N, Math.ceil((Math.max(ax, bx) + R1) / c));
        const z0 = Math.max(0, Math.floor((Math.min(az, bz) - R1) / c)), z1 = Math.min(N, Math.ceil((Math.max(az, bz) + R1) / c));
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
        for (let j = z0; j <= z1; j++) for (let q = x0; q <= x1; q++) {
          const px = q * c - ax, pz = j * c - az;
          const tt = l2 > 0 ? Math.max(0, Math.min(1, (px * dx + pz * dz) / l2)) : 0;
          const d = Math.hypot(px - dx * tt, pz - dz * tt);
          if (d >= R1) continue;
          const w = d <= R0 ? 1 : 1 - smooth((d - R0) / RB), k = j * M + q;
          // two carriageways share a sample inside both corridors: the road grade differs across a hillside, so the nearer one sets the height
          if (w > W[k] || (w === W[k] && d < D[k])) { W[k] = w; D[k] = d; RH[k] = ha + (hb - ha) * tt; }
          if (d <= R0 + c) F[k] = 1;
        }
      }
    }
  }
  // flatten under a landmark: a [[x, z], ...] ring in metres, to height y, blending over 26 m outside
  // sunk: this pad is cut below the land, so a lake beside it must not take its level from it (see inSunkPad)
  addPad(ring, y, sunk) {
    let a = 1e9, b = 1e9, c2 = -1e9, d = -1e9;
    for (const p of ring) { if (p[0] < a) a = p[0]; if (p[0] > c2) c2 = p[0]; if (p[1] < b) b = p[1]; if (p[1] > d) d = p[1]; }
    const c = this.c, N = this.N, M = this.M, pad = 26;
    for (let j = Math.max(0, Math.floor((b - pad) / c)); j <= Math.min(N, Math.ceil((d + pad) / c)); j++) for (let q = Math.max(0, Math.floor((a - pad) / c)); q <= Math.min(N, Math.ceil((c2 + pad) / c)); q++) {
      const x = q * c, z = j * c; let w;
      if (inRing(x, z, ring)) w = 1; else { let dm = 1e9; for (let i = 0; i < ring.length; i++) { const e = ring[(i + 1) % ring.length]; const dd = segD(x, z, ring[i][0], ring[i][1], e[0], e[1]); if (dd < dm) dm = dd; } if (dm >= pad) continue; w = 1 - smooth(dm / pad); }
      const k = j * M + q; if (sunk) (this.sunk || (this.sunk = new Uint8Array(M * M)))[k] = 1; if (w >= this.w[k]) { this.w[k] = w; this.rh[k] = y + DROP; this.flagged[k] = 1; }
    }
  }
  inSunkPad(x, z) { if (!this.sunk) return false; const c = this.c, N = this.N, i = Math.round(x / c), j = Math.round(z / c); return i >= 0 && j >= 0 && i <= N && j <= N && !!this.sunk[j * this.M + i]; }
  // call once after the roads and pads
  bake() {
    const n = this.M * this.M, h = this.h, b = this.base, w = this.w, r = this.rh;
    for (let k = 0; k < n; k++) h[k] = b[k] + (r[k] - DROP - b[k]) * w[k];
    this.baked = true;
    this.clearRoads();
    const cut = new Float32Array(n);
    for (let k = 0; k < n; k++) { const d = b[k] - h[k]; cut[k] = d > 0.3 ? Math.min(d, 60) : 0; }
    CUTS.set(h, cut);
  }
  // the guarantee: walk every at-grade carriageway, centre and edges, and press the ground below it wherever it still stands above
  clearRoads() {
    const U = this.under, c = this.c, N = this.N, M = this.M, H = this.h, step = c * 0.5;
    for (let q = 0; q < U.length; q += 7) {
      const ax = U[q], az = U[q + 1], bx = U[q + 2], bz = U[q + 3], ha = U[q + 4], hb = U[q + 5], hw = U[q + 6], dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
      if (L < 1e-3) continue;
      const nx = -dz / L, nz = dx / L, steps = Math.max(1, Math.ceil(L / step)), across = Math.max(1, Math.ceil(hw / step));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps, cx = ax + dx * t, cz = az + dz * t, top = ha + (hb - ha) * t - DROP;
        for (let o = -across; o <= across; o++) {
          const x = cx + nx * hw * o / across, z = cz + nz * hw * o / across, fx = x / c, fz = z / c;
          if (fx < 0 || fz < 0 || fx > N || fz > N) continue;
          const over = this.at(x, z) - top;
          if (over <= 0) continue;
          const i = Math.min(N - 1, Math.floor(fx)), j = Math.min(N - 1, Math.floor(fz)), k = j * M + i;
          H[k] -= over; H[k + 1] -= over; H[k + M] -= over; H[k + M + 1] -= over;
          this.flagged[k] = this.flagged[k + 1] = this.flagged[k + M] = this.flagged[k + M + 1] = 1;
        }
      }
    }
  }
  // water: rings in metres, surface at level; ground under it is carved
  addWater(rings, level) {
    let a = 1e9, b = 1e9, c2 = -1e9, d = -1e9;
    for (const p of rings[0]) { if (p[0] < a) a = p[0]; if (p[0] > c2) c2 = p[0]; if (p[1] < b) b = p[1]; if (p[1] > d) d = p[1]; }
    const c = this.c, N = this.N, M = this.M, h = this.h, x0 = Math.max(0, Math.floor(a / c) - 1), x1 = Math.min(N, Math.ceil(c2 / c) + 1), z0 = Math.max(0, Math.floor(b / c) - 1), z1 = Math.min(N, Math.ceil(d / c) + 1);
    for (let j = z0; j <= z1; j++) for (let q = x0; q <= x1; q++) {
      const x = q * c, z = j * c; let inside = false;
      for (const ring of rings) if (inRing(x, z, ring)) inside = !inside;
      const k = j * M + q;
      if (inside) { if (h[k] > level - 0.9) h[k] = level - 0.9; this.flagged[k] = 1; }
      else if (h[k] < level + 0.25) { let near = false; for (let dj = -1; dj <= 1 && !near; dj++) for (let di = -1; di <= 1; di++) { let ins = false; const xx = (q + di) * c, zz = (j + dj) * c; for (const ring of rings) if (inRing(xx, zz, ring)) ins = !ins; if (ins) { near = true; break; } } if (near) { h[k] = level + 0.25; this.flagged[k] = 1; } }
    }
  }
  at(x, z) {
    const c = this.c, N = this.N, M = this.M;
    const fx = Math.max(0, Math.min(N - 1e-3, x / c)), fz = Math.max(0, Math.min(N - 1e-3, z / c)), i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * M + i, h = this.h;
    return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - tz) + (h[k + M] * (1 - tx) + h[k + M + 1] * tx) * tz;
  }
  // a building's base: the height at its centre, and the lowest point of its footprint for the walls
  base2(ring, S0, cx, cy) {
    const y = this.at(cx * S0, cy * S0); let low = y;
    for (let i = 0; i < ring.length; i++) { const h = this.at(ring[i][0] * S0, ring[i][1] * S0); if (h < low) low = h; }
    return { y, low };
  }
}
function boxBlur(a, M, r) {
  const out = new Float32Array(a.length), w = 2 * r + 1, line = new Float32Array(M);
  for (let j = 0; j < M; j++) { let s = 0; for (let i = -r; i <= r; i++) s += a[j * M + Math.max(0, Math.min(M - 1, i))]; for (let i = 0; i < M; i++) { line[i] = s / w; s += a[j * M + Math.min(M - 1, i + r + 1)] - a[j * M + Math.max(0, i - r)]; } for (let i = 0; i < M; i++) out[j * M + i] = line[i]; }
  const o2 = new Float32Array(a.length);
  for (let i = 0; i < M; i++) { let s = 0; for (let j = -r; j <= r; j++) s += out[Math.max(0, Math.min(M - 1, j)) * M + i]; for (let j = 0; j < M; j++) { o2[j * M + i] = s / w; s += out[Math.min(M - 1, j + r + 1) * M + i] - out[Math.max(0, j - r) * M + i]; } }
  return o2;
}
function inRing(x, z, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const zi = ring[i][1], zj = ring[j][1]; if ((zi > z) !== (zj > z) && x < (ring[j][0] - ring[i][0]) * (z - zi) / (zj - zi) + ring[i][0]) c = !c; } return c; }
function segD(px, pz, ax, az, bx, bz) { const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz, t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0; return Math.hypot(px - ax - dx * t, pz - az - dz * t); }

// ------------------------------------------------------------------ the mesh
// Error-driven blocks on a regular grid: every block takes the coarsest step whose surface stays
// within tol of the true heights. Where a fine block meets a coarser one, the fine edge vertices are
// moved onto the coarse edge, so there are no cracks without any extra triangles. A skirt hides any
// difference at the tile border. H: heights (M x M), flags: (M x M) or null: blocks touching a flagged
// sample use tolFine and the finest step.
export function tessellate(H, N, B, TS, opts) {
  const M = N + 1, c = TS / N, nb = N / B, steps = new Uint8Array(nb * nb), R = H.slice();
  const tolFine = opts.tolFine, tolCoarse = opts.tolCoarse, flags = opts.flags || null, minFine = opts.minFine || 1, minCoarse = opts.minCoarse || 2;
  for (let bj = 0, q = 0; bj < nb; bj++) for (let bi = 0; bi < nb; bi++, q++) {
    const i0 = bi * B, j0 = bj * B;
    let flagged = false;
    if (flags) for (let j = j0; j <= j0 + B && !flagged; j++) for (let i = i0; i <= i0 + B; i++) if (flags[j * M + i]) { flagged = true; break; }
    const tol = flagged ? tolFine : tolCoarse, smin = flagged ? minFine : minCoarse;
    let s = B;
    for (; s > smin; s >>= 1) {
      let ok = true;
      for (let j = j0; j <= j0 + B && ok; j++) for (let i = i0; i <= i0 + B; i++) {
        const cx = Math.min(i0 + B - s, i0 + Math.floor((i - i0) / s) * s), cz = Math.min(j0 + B - s, j0 + Math.floor((j - j0) / s) * s), tx = (i - cx) / s, tz = (j - cz) / s;
        const k = cz * M + cx, p = (H[k] * (1 - tx) + H[k + s] * tx) * (1 - tz) + (H[k + s * M] * (1 - tx) + H[k + s * M + s] * tx) * tz;
        if (Math.abs(p - H[j * M + i]) > tol) { ok = false; break; }
      }
      if (ok) break;
    }
    steps[q] = s;
  }
  // fine edges onto coarse neighbours
  const stepAt = (bi, bj) => (bi < 0 || bj < 0 || bi >= nb || bj >= nb) ? 0 : steps[bj * nb + bi];
  for (let bj = 0; bj < nb; bj++) for (let bi = 0; bi < nb; bi++) {
    const s = stepAt(bi, bj), i0 = bi * B, j0 = bj * B;
    const fix = (sn, horiz, line) => {
      if (sn <= s) return;
      for (let t = 0; t <= B; t += s) {
        const q0 = Math.floor(t / sn) * sn, tt = (t - q0) / sn; if (tt === 0) continue;
        const a = (horiz ? i0 + q0 + line * M : line + (j0 + q0) * M), b = horiz ? i0 + q0 + sn + line * M : line + (j0 + q0 + sn) * M;
        const at = horiz ? i0 + t + line * M : line + (j0 + t) * M;
        R[at] = H[a] * (1 - tt) + H[b] * tt;
      }
    };
    fix(stepAt(bi, bj - 1), true, j0); fix(stepAt(bi, bj + 1), true, j0 + B);
    fix(stepAt(bi - 1, bj), false, i0); fix(stepAt(bi + 1, bj), false, i0 + B);
  }
  // emit
  const map = new Int32Array(M * M).fill(-1), pos = [], nor = [], idx = [];
  const norAt = (i, j) => {
    const il = Math.max(0, i - 1), ir = Math.min(N, i + 1), jl = Math.max(0, j - 1), jr = Math.min(N, j + 1);
    const dx = (H[j * M + ir] - H[j * M + il]) / ((ir - il) * c), dz = (H[jr * M + i] - H[jl * M + i]) / ((jr - jl) * c), l = Math.hypot(dx, 1, dz);
    return [-dx / l, 1 / l, -dz / l];
  };
  const cut = CUTS.get(H) || null;
  const v = (i, j) => {
    const k = j * M + i; let id = map[k];
    if (id < 0) { id = map[k] = pos.length / 3; pos.push(i * c, R[k], j * c); const n = norAt(i, j), q = cut ? 1 + cut[k] / 6 : 1; nor.push(n[0] * q, n[1] * q, n[2] * q); }   // every use of the normal normalises it; makeTerrainMaterial reads the length back
    return id;
  };
  for (let bj = 0, q = 0; bj < nb; bj++) for (let bi = 0; bi < nb; bi++, q++) {
    const s = steps[q], i0 = bi * B, j0 = bj * B;
    for (let j = j0; j < j0 + B; j += s) for (let i = i0; i < i0 + B; i += s) {
      const a = v(i, j), b = v(i + s, j), d = v(i, j + s), e = v(i + s, j + s);
      // split along the diagonal that follows the slope best
      if (Math.abs(R[j * M + i] - R[(j + s) * M + i + s]) < Math.abs(R[j * M + i + s] - R[(j + s) * M + i])) { idx.push(a, d, e, a, e, b); } else { idx.push(a, d, b, b, d, e); }
    }
  }
  // skirts down the four tile edges (front faces outwards)
  const skirtDepth = opts.skirt;
  const border = (fixed, horiz, flip) => {
    for (let b = 0; b < nb; b++) {
      const q = horiz ? (fixed === 0 ? b : (nb - 1) * nb + b) : (fixed === 0 ? b * nb : b * nb + nb - 1);
      const s = steps[q], t0 = b * B;
      for (let t = t0; t < t0 + B; t += s) {
        const ai = horiz ? t : fixed, aj = horiz ? fixed : t, bi = horiz ? t + s : fixed, bj = horiz ? fixed : t + s;
        const a = v(ai, aj), bb = v(bi, bj), aP = a * 3, bP = bb * 3;
        const a2 = pos.length / 3; pos.push(pos[aP], pos[aP + 1] - skirtDepth, pos[aP + 2]); nor.push(nor[aP], nor[aP + 1], nor[aP + 2]);
        pos.push(pos[bP], pos[bP + 1] - skirtDepth, pos[bP + 2]); nor.push(nor[bP], nor[bP + 1], nor[bP + 2]);
        const b2 = a2 + 1;
        if (flip) idx.push(a, a2, bb, bb, a2, b2); else idx.push(a, bb, a2, bb, b2, a2);
      }
    }
  };
  border(0, true, false); border(N, true, true); border(0, false, true); border(N, false, false);
  const count = pos.length / 3;
  return { position: Float32Array.from(pos), normal: Float32Array.from(nor), index: Uint32Array.from(idx), count };
}

// A distance-ring tile: heights from the far layer, a coarse mesh, a thick skirt.
export function farMesh(T, m) {
  const N = m.cells || 64, M = N + 1, TS = m.size, n = 2 ** m.z, H = new Float32Array(M * M);
  for (let j = 0, k = 0; j < M; j++) for (let i = 0; i < M; i++, k++) {
    const u = (m.x + i / N) / n, v = (m.y + j / N) / n;
    let h = m.z >= 12 ? T.ground(u, v) : T.far(u, v);
    if (h !== h) h = T.far(u, v);
    H[k] = h === h ? h : -1;
  }
  return tessellate(H, N, 8, TS, { tolFine: 2, tolCoarse: m.z >= 12 ? 3 : 6, minCoarse: 1, skirt: m.z >= 12 ? 25 : 60 });
}
