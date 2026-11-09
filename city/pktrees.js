// Pakistan trees: alpha-card leaf clusters on one small atlas painted in code, species chosen by
// zone and elevation (build/pk/research/art_direction.md section 7, whose hex values and game
// heights are estimates). Five crown shapes, each a near and a far InstancedMesh; a species is a
// shape plus a leaf tile, a bark tile, a height range and a spread, set per instance.
import * as THREE from "three";
import { toLatLon } from "./world.js";
import { U } from "./materials.js";

// ---------------------------------------------------------------- species
// shape: 0 broad, 1 umbrella, 2 tall, 3 open pine, 4 cone, 5 low shrub. leaf: atlas tile 0-11. bark: tile 0-3.
const SP = [
  { name: "mulberry", shape: 0, leaf: 0, bark: 0, h: [9, 15], spread: 1.05 },
  { name: "jacaranda", shape: 0, leaf: 1, bark: 3, h: [8, 14], spread: 0.95 },
  { name: "avenue", shape: 0, leaf: 2, bark: 0, h: [8, 13], spread: 1.0 },       // Arjan, Siris and the other replacement planting
  { name: "shisham", shape: 0, leaf: 3, bark: 0, h: [11, 20], spread: 0.9 },
  { name: "eucalyptus", shape: 2, leaf: 4, bark: 2, h: [18, 27], spread: 0.85 },
  { name: "kikar", shape: 1, leaf: 5, bark: 3, h: [5, 9], spread: 1.0 },
  { name: "phulai", shape: 1, leaf: 6, bark: 3, h: [4.5, 8], spread: 0.85 },
  { name: "oak", shape: 0, leaf: 7, bark: 3, h: [9, 15], spread: 1.05 },
  { name: "chir", shape: 3, leaf: 8, bark: 1, h: [15, 26], spread: 0.9 },
  { name: "blue pine", shape: 3, leaf: 9, bark: 3, h: [16, 28], spread: 0.85 },
  { name: "deodar", shape: 4, leaf: 10, bark: 3, h: [18, 30], spread: 0.85 },
  { name: "silver fir", shape: 4, leaf: 11, bark: 3, h: [18, 28], spread: 0.58 },
  { name: "shrub", shape: 5, leaf: 2, bark: 0, h: [1.4, 2.4], spread: 0.85 },     // median planting and dry scrub
  { name: "undergrowth", shape: 5, leaf: 7, bark: 0, h: [0.9, 1.9], spread: 1.2 },   // the forest floor
];
const [MUL, JAC, AVE, SHI, EUC, KIK, PHU, OAK, CHI, BLU, DEO, FIR, SHR, UND] = SP.keys();
// Avenue trees borrow a related leaf tile now and then, so one row is not one specimen.
const LEAF_ALT = { [AVE]: 3, [SHI]: 2, [MUL]: 7 };
const hash = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
function pick(mix, u) { let tot = 0; for (let i = 1; i < mix.length; i += 2) tot += mix[i]; let c = 0; u *= tot; for (let i = 1; i < mix.length; i += 2) { c += mix[i]; if (u < c) return mix[i - 1]; } return mix[mix.length - 2]; }

// Which tree stands here. `pine` is the tile worker's own flag for the high slopes.
function mixFor(lat, lon, e, pine) {
  const north = lat > 33.6 && lon > 72.9;
  if (north && (e >= 760 || pine)) {                       // Margalla, Murree and the Galyat: the elevation decides (brief section 7, build rule)
    if (pine) return e < 1300 ? [CHI, 88, PHU, 12] : e < 1900 ? [CHI, 80, OAK, 20] : e < 2300 ? [BLU, 58, DEO, 38, CHI, 4] : [DEO, 55, FIR, 40, BLU, 5];
    return e < 1300 ? [CHI, 52, PHU, 30, KIK, 10, MUL, 8] : e < 1900 ? [OAK, 70, CHI, 30] : e < 2300 ? [OAK, 45, BLU, 30, DEO, 25] : [DEO, 45, FIR, 35, OAK, 20];
  }
  if (lat > 33.7 && lon > 73.2 && lat < 34.1 && lon < 73.7) return e >= 520 ? [CHI, 34, PHU, 36, KIK, 22, MUL, 8] : [PHU, 40, MUL, 30, KIK, 30];   // the foot of the Murree road: chir starts at about 500 m (brief section 7)
  if ((lat > 33.48 && lat < 33.575 && lon > 73.06 && lon < 73.185) || (lat > 33.68 && lat < 33.7 && lon > 73.2 && lon < 73.235)) return [AVE, 56, SHI, 24, JAC, 20];   // Bahria and DHA
  if (lat > 33.54 && lat < 33.665 && lon > 72.97 && lon < 73.14) return [SHI, 40, KIK, 25, AVE, 20, MUL, 15];       // Rawalpindi
  if (lat > 33.66 && lat < 33.8 && lon > 72.93 && lon < 73.22) return lat > 33.735 ? [MUL, 32, AVE, 30, JAC, 20, SHI, 10, KIK, 8] : [AVE, 46, JAC, 26, SHI, 14, MUL, 14];   // Islamabad: paper mulberry survives towards the foothills, avenues are replanted
  if (lat > 31.38 && lat < 31.68 && lon > 74.12 && lon < 74.52) return [SHI, 50, AVE, 36, EUC, 14];                 // Lahore
  if (lat >= 32.6) return [PHU, 44, KIK, 40, SHI, 16];                                                              // Potohar and the Salt Range: dry scrub
  return [SHI, 48, EUC, 42, KIK, 10];                                                                               // Punjab plains and the M-2 south of the Salt Range
}
// Neighbouring trees mostly share a species (a run along a road, a stand on a slope); some do not.
export function pkSpecies(lat, lon, e, pine) {
  const a = Math.floor(lat * 2000), b = Math.floor(lon * 2000), fine = hash(lat * 90000, lon * 90000);
  return pick(mixFor(lat, lon, e, pine), fine < 0.7 ? hash(a, b) : hash(lon * 70000, lat * 50000));
}

// ---------------------------------------------------------------- atlas
const TS = 256, GRID = 4, ATLAS = TS * GRID, MARGIN = 8, LEVELS = 6;
function rng32(s) { return () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rgb = hex => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const tone = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

class Tile {
  constructor() { this.d = new Float32Array(TS * TS * 4); }
  put(x, y, c, a) {
    if (x < MARGIN || y < MARGIN || x >= TS - MARGIN || y >= TS - MARGIN || a <= 0) return;
    const i = (y * TS + x) * 4, d = this.d, o = d[i + 3];
    if (o <= 0) { d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; } else { d[i] += (c[0] - d[i]) * a; d[i + 1] += (c[1] - d[i + 1]) * a; d[i + 2] += (c[2] - d[i + 2]) * a; }
    if (a > o) d[i + 3] = a;
  }
  // a lens-shaped leaf, lit a little differently either side of its midrib
  leaf(cx, cy, ang, L, W, c) {
    const R = Math.ceil(Math.max(L, W)) + 1, x0 = Math.floor(cx), y0 = Math.floor(cy), co = Math.cos(ang), si = Math.sin(ang);
    for (let y = y0 - R; y <= y0 + R; y++) for (let x = x0 - R; x <= x0 + R; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy, u = dx * co + dy * si, v = -dx * si + dy * co, t = u / L;
      if (t * t >= 1) continue;
      const w = W * Math.pow(1 - t * t, 0.7), av = Math.abs(v); if (av >= w) continue;
      const k = (v > 0 ? 1.07 : 0.92) * (av < w * 0.14 ? 1.12 : 1);
      this.put(x, y, tone(c, k), Math.min(1, (w - av) * 1.5));
    }
  }
  line(x0, y0, x1, y1, r, c) {
    const a = Math.floor(Math.min(x0, x1) - r - 1), b = Math.ceil(Math.max(x0, x1) + r + 1), e = Math.floor(Math.min(y0, y1) - r - 1), f = Math.ceil(Math.max(y0, y1) + r + 1), dx = x1 - x0, dy = y1 - y0, ll = dx * dx + dy * dy || 1;
    for (let y = e; y <= f; y++) for (let x = a; x <= b; x++) {
      const px = x + 0.5 - x0, py = y + 0.5 - y0, t = Math.max(0, Math.min(1, (px * dx + py * dy) / ll)), qx = px - dx * t, qy = py - dy * t, dd = Math.sqrt(qx * qx + qy * qy);
      if (dd < r + 0.7) this.put(x, y, c, Math.min(1, r + 0.7 - dd));
    }
  }
  // a curved needle: starts along ang, bends towards the ground by `sag`
  needle(x, y, ang, L, sag, r, c) {
    let px = x, py = y, a = ang; const n = 4, st = L / n;
    for (let i = 0; i < n; i++) { const qx = px + Math.cos(a) * st, qy = py + Math.sin(a) * st; this.line(px, py, qx, qy, r, c); px = qx; py = qy; a += (a > -Math.PI / 2 && a < Math.PI / 2 ? -sag : sag); }
  }
}
// a point in a ragged disc, so a cluster has no round edge
function spot(r, phase, reach = 1) { const th = r() * 6.2832, rad = Math.sqrt(r()) * (TS / 2 - MARGIN - 6) * reach * (0.8 + 0.2 * Math.cos(3 * th + phase)); return [TS / 2 + Math.cos(th) * rad, TS / 2 + Math.sin(th) * rad, th]; }
const shade = (c, r, f, lo = 0.6, hi = 1.2) => tone(c, (lo + (hi - lo) * f) * (0.92 + 0.16 * r()));

function broadleaf(t, r, o) {
  const twig = rgb(0x4a3a2a), ph = r() * 6;
  for (let i = 0; i < o.twigs; i++) { const [x, y, th] = spot(r, ph), L = 40 + r() * 40; t.line(TS / 2 + Math.cos(th) * 10, TS / 2 + Math.sin(th) * 10, x, y, 1.1, twig); if (L < 0) break; }
  for (let i = 0; i < o.n; i++) {
    const f = i / o.n, [x, y, th] = spot(r, ph), ang = (o.hang ? -Math.PI / 2 + (r() - 0.5) * o.hang : th + (r() - 0.5) * 1.6);
    t.leaf(x, y, ang, o.L * (0.75 + 0.5 * r()), o.W * (0.75 + 0.5 * r()), shade(o.c, r, f));
  }
  if (o.bloom) for (let i = 0; i < o.bloom; i++) { const [x, y] = spot(r, ph, 0.95), b = shade(rgb(0x7C6BC4), r, 0.7); for (let k = 0; k < 5; k++) t.leaf(x + (r() - 0.5) * 10, y + (r() - 0.5) * 10, r() * 6.28, 5.5, 3.2, b); }
}
// compound leaves: a thin stalk with paired leaflets, for siris, shisham, kikar, phulai and jacaranda
function compound(t, r, o) {
  const twig = rgb(0x4f4030), ph = r() * 6;
  for (let i = 0; i < o.fronds; i++) {
    const f = i / o.fronds, [x, y, th] = spot(r, ph, 0.92), ang = th + (r() - 0.5) * 2, L = o.len * (0.75 + 0.5 * r()), c = shade(o.c, r, f), ca = Math.cos(ang), sa = Math.sin(ang);
    t.line(x, y, x + ca * L, y + sa * L, 0.7, twig);
    const nl = Math.floor(L / o.gap);
    for (let k = 1; k <= nl; k++) { const d = k * o.gap, px = x + ca * d, py = y + sa * d, s = 1 - 0.4 * (k / nl); t.leaf(px - sa * o.ll * 0.8, py + ca * o.ll * 0.8, ang + 1.25, o.ll * s, o.lw, c); t.leaf(px + sa * o.ll * 0.8, py - ca * o.ll * 0.8, ang - 1.25, o.ll * s, o.lw, c); }
  }
}
// needles in tufts: chir (long, spraying out and up, yellow-green), blue pine (long and hanging)
function tufts(t, r, o) {
  const twig = rgb(0x4b3a2c), ph = r() * 6;
  for (let i = 0; i < o.n; i++) {
    const f = i / o.n, [x, y] = spot(r, ph, 0.72), c = shade(o.c, r, f, 0.68, 1.16);
    t.line(TS / 2 + (x - TS / 2) * 0.3, TS / 2 + (y - TS / 2) * 0.3 + 18, x, y, 1.6, twig);
    for (let k = 0; k < o.per; k++) { const a = o.dir + (r() - 0.5) * o.fan; t.needle(x, y, a, o.L * (0.7 + 0.5 * r()), o.sag, 0.8, tone(c, 0.9 + 0.2 * r())); }
  }
}
// level branchlets with short hanging sprays: deodar (drooping tips) and fir (flat and dense)
function sprays(t, r, o) {
  const twig = rgb(0x3f352a);
  for (let i = 0; i < o.n; i++) {
    const f = i / o.n, y = MARGIN + 20 + (TS - 2 * MARGIN - 40) * r(), half = (TS / 2 - MARGIN - 8) * (0.55 + 0.45 * Math.sqrt(1 - Math.pow(Math.abs(y - TS / 2) / (TS / 2), 2))), span = half * (0.35 + 0.4 * r()), mid = TS / 2 + (r() - 0.5) * 2 * (half - span), x0 = mid - span, drop = 6 + r() * 14, c = shade(o.c, r, f, 0.62, 1.14);   // short branchlets at scattered places, so a stack of cards shows no even shelves
    const x1 = mid + span, n = Math.max(2, Math.floor((x1 - x0) / o.step)); let py = y + drop * 0.6, px = x0;
    for (let k = 1; k <= n; k++) {
      const t0 = k / n, qx = x0 + (x1 - x0) * t0, qy = y + drop * 0.6 * (1 - 2 * Math.abs(t0 - 0.5)) * 1.4 - drop * 0.6 * Math.abs(t0 - 0.5) * 2;
      t.line(px, py, qx, qy, 1, twig); px = qx; py = qy;
      for (let m = 0; m < o.per; m++) { const a = -Math.PI / 2 + (r() - 0.5) * o.fan; t.needle(qx + (r() - 0.5) * o.step, qy + 1, m % 2 ? a : (o.up ? Math.PI / 2 + (r() - 0.5) * 1.0 : a), o.L * (0.7 + 0.6 * r()), o.sag, 0.7, tone(c, 0.9 + 0.2 * r())); }
    }
  }
}
function bark(t, r, base, deep, freq, patch) {
  const a = r() * 6, b = r() * 6, d = t.d;
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const w = x / TS * 6.2832, v = y / TS * 6.2832, fur = Math.sin(w * freq + 0.7 * Math.sin(v * 3 + a + w * 2) + 0.45 * Math.sin(v * 9 + b - w * 3) + 0.3 * Math.sin(v * 17 + w * 5)) + 0.35 * Math.sin(w * freq * 2.3 + v * 2 + b), ridge = Math.max(0, Math.min(1, fur * 0.75 + 0.3));
    let c = mixc(deep, base, ridge);
    if (patch) { const p = Math.sin(w * 4 + 2.4 * Math.sin(v * 3 + b)) * Math.sin(v * 7 + 1.5 * Math.sin(w * 3 + a)); if (p > 0.25) c = mixc(c, patch, 0.8); }
    const k = 0.92 + 0.16 * r(), i = (y * TS + x) * 4;
    d[i] = c[0] * k; d[i + 1] = c[1] * k; d[i + 2] = c[2] * k; d[i + 3] = 1;
  }
}
// One level down: alpha-weighted colour, so transparent pixels never darken the leaves
function shrink(a, n) {
  const m = n >> 1, b = new Float32Array(m * m * 4);
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
    let r = 0, g = 0, bl = 0, w = 0, A = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const i = ((2 * y + dy) * n + 2 * x + dx) * 4, q = a[i + 3], w1 = q + 0.001; r += a[i] * w1; g += a[i + 1] * w1; bl += a[i + 2] * w1; w += w1; A += q; }
    const o = (y * m + x) * 4; b[o] = r / w; b[o + 1] = g / w; b[o + 2] = bl / w; b[o + 3] = A / 4;
  }
  return b;
}
// One mip level of a leaf tile, softened: the banding of leaflets and midribs goes, the pockets inside a dense mass close (the weave at normal quality), and the outline loses its stair-steps. Up close the sharper levels keep their leaves.
function soften(a, n, r, amount) {
  const w = 2 * r + 1, N = n * n, pr = new Float32Array(N), pg = new Float32Array(N), pb = new Float32Array(N), pa = new Float32Array(N), b = (src, out) => {
    const t = new Float32Array(N);
    for (let y = 0; y < n; y++) { let s = 0; for (let x = -r; x <= r; x++) s += src[y * n + Math.max(0, x)]; for (let x = 0; x < n; x++) { t[y * n + x] = s / w; s += src[y * n + Math.min(n - 1, x + r + 1)] - src[y * n + Math.max(0, x - r)]; } }
    for (let x = 0; x < n; x++) { let s = 0; for (let y = -r; y <= r; y++) s += t[Math.max(0, y) * n + x]; for (let y = 0; y < n; y++) { out[y * n + x] = s / w; s += t[Math.min(n - 1, y + r + 1) * n + x] - t[Math.max(0, y - r) * n + x]; } }
  };
  for (let i = 0; i < N; i++) { const q = a[i * 4 + 3]; pr[i] = a[i * 4] * q; pg[i] = a[i * 4 + 1] * q; pb[i] = a[i * 4 + 2] * q; pa[i] = q; }
  const br = new Float32Array(N), bg = new Float32Array(N), bb = new Float32Array(N), ba = new Float32Array(N); b(pr, br); b(pg, bg); b(pb, bb); b(pa, ba);
  for (let i = 0; i < N; i++) {
    const o = i * 4, A = ba[i], q0 = a[o + 3]; if (A < 0.02) continue;
    const dark = 1 - 0.3 * (1 - q0) * Math.min(1, A / 0.6);         // what was a gap stays a little deeper than the leaves around it
    a[o] += (br[i] / A * dark - a[o]) * amount; a[o + 1] += (bg[i] / A * dark - a[o + 1]) * amount; a[o + 2] += (bb[i] / A * dark - a[o + 2]) * amount;
    const t = Math.max(0, Math.min(1, (A - 0.5) / 0.22)), fill = t * t * (3 - 2 * t);
    a[o + 3] = Math.max(q0 + (A - q0) * amount, fill);
  }
}
const covered = (a, n, s) => { let k = 0; for (let i = 3; i < n * n * 4; i += 4) if (a[i] * s > 0.5) k++; return k / (n * n); };
// Keep the crown as full at a distance as up close: without this, alpha-tested leaves thin out and vanish in the small mips
function keepCoverage(a, n, target, lo = 0.5) { let hi = 16; for (let i = 0; i < 12; i++) { const s = (lo + hi) / 2; if (covered(a, n, s) < target) lo = s; else hi = s; } const s = (lo + hi) / 2; for (let i = 3; i < n * n * 4; i += 4) a[i] = Math.min(1, a[i] * s); }

export function buildLeafAtlas() {
  const paint = [
    (t, r) => broadleaf(t, r, { n: 260, twigs: 8, L: 12.5, W: 8, c: rgb(0x6D8A3E) }),          // mulberry
    (t, r) => { compound(t, r, { fronds: 60, len: 46, gap: 6, ll: 7, lw: 2.1, c: rgb(0x5F8540) }); broadleaf(t, r, { n: 0, twigs: 0, L: 1, W: 1, c: rgb(0), bloom: 24 }); },   // jacaranda, feathery, some violet
    (t, r) => compound(t, r, { fronds: 60, len: 46, gap: 7.5, ll: 8.2, lw: 3.5, c: rgb(0x587A38) }),   // avenue: Siris, Arjan
    (t, r) => compound(t, r, { fronds: 34, len: 54, gap: 15, ll: 11, lw: 7, c: rgb(0x5F7E3B) }),    // shisham: fewer, rounder leaflets, airy
    (t, r) => broadleaf(t, r, { n: 150, twigs: 6, L: 28, W: 4.2, c: rgb(0x7C8E76), hang: 0.9 }),    // eucalyptus: long hanging blades
    (t, r) => compound(t, r, { fronds: 62, len: 30, gap: 3.4, ll: 5, lw: 1.5, c: rgb(0x7A8A45) }),  // kikar: fine, thin, airy
    (t, r) => compound(t, r, { fronds: 80, len: 26, gap: 3.6, ll: 5.4, lw: 2, c: rgb(0x6B7A3E) }),  // phulai
    (t, r) => broadleaf(t, r, { n: 210, twigs: 6, L: 13, W: 6.5, c: rgb(0x4F6B3A) }),               // oak and mixed hill broadleaf
    (t, r) => tufts(t, r, { n: 15, per: 34, L: 58, sag: 0.1, dir: Math.PI / 2, fan: 3.6, c: tone(rgb(0x7E9248), 0.8) }),    // chir: long, yellow-green, spraying
    (t, r) => tufts(t, r, { n: 16, per: 30, L: 62, sag: 0.05, dir: -Math.PI / 2, fan: 1.1, c: rgb(0x4F7560) }),  // blue pine: long and hanging
    (t, r) => sprays(t, r, { n: 30, step: 12, per: 9, L: 18, sag: 0.06, fan: 1.0, c: rgb(0x3D6556) }),          // deodar
    (t, r) => sprays(t, r, { n: 40, step: 10, per: 10, L: 12, sag: 0, fan: 2.2, up: true, c: rgb(0x2E4F46) }),  // silver fir
    (t, r) => bark(t, r, rgb(0x6A5844), rgb(0x3A2E23), 9),                                     // plain furrowed
    (t, r) => bark(t, r, rgb(0x7E4F38), rgb(0x3B2419), 6),                                     // chir: red-brown plates
    (t, r) => bark(t, r, rgb(0xC6BCA8), rgb(0x9B8F7C), 3, rgb(0x8F7F68)),                      // eucalyptus: pale and shedding
    (t, r) => bark(t, r, rgb(0x5C5046), rgb(0x332B25), 11),                                    // dark grey
  ];
  const levels = []; for (let L = 0; L < LEVELS; L++) { const n = ATLAS >> L; levels.push({ data: new Uint8Array(n * n * 4), width: n, height: n }); }
  paint.forEach((fn, idx) => {
    const t = new Tile(), isBark = idx >= 12; fn(t, rng32(101 + idx * 37));
    const a = t.d;
    if (!isBark) {        // transparent pixels take the leaves' mean colour, so no dark fringe appears when filtering
      let r = 0, g = 0, b = 0, n = 0; for (let i = 0; i < a.length; i += 4) if (a[i + 3] > 0.3) { r += a[i]; g += a[i + 1]; b += a[i + 2]; n++; }
      r /= n || 1; g /= n || 1; b /= n || 1; for (let i = 0; i < a.length; i += 4) if (a[i + 3] <= 0) { a[i] = r; a[i + 1] = g; a[i + 2] = b; }
    }
    const target = covered(a, TS, 1), col = idx % GRID, row = Math.floor(idx / GRID);
    let cur = a, n = TS;
    for (let L = 0; L < LEVELS; L++) {
      if (L) { cur = shrink(cur, n); n >>= 1; if (!isBark) { const pine = idx === 8 || idx === 9; if (L >= 2) { if (pine) soften(cur, n, 1, 0.35); else soften(cur, n, L === 2 ? 2 : 1, L === 2 ? 0.8 : 0.5); } keepCoverage(cur, n, target, L >= 2 && !pine ? 1 : 0.5); } }      // needles stay spiky: only the broad crowns have a weave to close
      const lv = levels[L], m = lv.width, ox = col * n, oy = row * n;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const i = (y * n + x) * 4, o = ((y + oy) * m + x + ox) * 4; lv.data[o] = cur[i]; lv.data[o + 1] = cur[i + 1]; lv.data[o + 2] = cur[i + 2]; lv.data[o + 3] = cur[i + 3] * 255; }
    }
  });
  const tex = new THREE.DataTexture(levels[0].data, ATLAS, ATLAS, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = levels; tex.generateMipmaps = false; tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.anisotropy = 2; tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------- crowns
// Leaf cards carry uv in atlas tile 0 and bark uv in tile 12 (row 3, y >= 0.75); the vertex shader
// moves them to the instance's own tiles. The shadow pass does not, and has no need to: at shadow
// resolution one leaf mask reads like another.
const INSET = 0.004, CELL = 1 / GRID;
class Build {
  constructor() { this.p = []; this.n = []; this.c = []; this.uv = []; this.ix = []; }
  v(x, y, z, nx, ny, nz, u, v, s) { this.p.push(x, y, z); this.n.push(nx, ny, nz); this.c.push(s, s, s); this.uv.push(u, v); return this.p.length / 3 - 1; }
  // a card centred at C; yaw about up, tilt about its own width, roll within its plane; normals lean out of the crown so the mass shades as one soft form
  card(C, w, h, yaw, tilt, roll, flip, crown) {
    const ux0 = Math.cos(yaw), uz0 = Math.sin(yaw), nx0 = uz0, nz0 = -ux0, ct = Math.cos(tilt), st = Math.sin(tilt);
    const vx0 = nx0 * st, vy0 = ct, vz0 = nz0 * st, cr = Math.cos(roll), sr = Math.sin(roll);
    const U = [(ux0 * cr + vx0 * sr) * w / 2, (vy0 * sr) * w / 2, (uz0 * cr + vz0 * sr) * w / 2], V = [(-ux0 * sr + vx0 * cr) * h / 2, (vy0 * cr) * h / 2, (-uz0 * sr + vz0 * cr) * h / 2];
    const u0 = flip ? CELL - INSET : INSET, u1 = flip ? INSET : CELL - INSET, v0 = INSET, v1 = CELL - INSET, ids = [];
    for (const [a, b, us, vs] of [[-1, -1, u0, v0], [1, -1, u1, v0], [1, 1, u1, v1], [-1, 1, u0, v1]]) {
      const x = C[0] + U[0] * a + V[0] * b, y = C[1] + U[1] * a + V[1] * b, z = C[2] + U[2] * a + V[2] * b;
      const ex = (x - crown.c[0]) / crown.r[0], ey = (y - crown.c[1]) / crown.r[1], ez = (z - crown.c[2]) / crown.r[2], rad = Math.hypot(ex, ey, ez);
      let nx = ex, ny = (ey < 0 ? ey * 0.35 : ey) + 0.35, nz = ez;      // the lower crown faces out, not down: facing the ground it went black in the sun const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      const up = Math.max(0, Math.min(1, ey * 0.5 + 0.5));
      ids.push(this.v(x, y, z, nx, ny, nz, us, vs, (0.62 + 0.46 * up) * (0.74 + 0.3 * Math.min(1, rad))));
    }
    this.ix.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
  }
  // a tapered limb from A to B, open-ended, bark uv
  limb(A, B, r0, r1, sides, reps) {
    const d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], L = Math.hypot(...d) || 1, ax = d.map(q => q / L);
    const hx = Math.abs(ax[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], s = [ax[1] * hx[2] - ax[2] * hx[1], ax[2] * hx[0] - ax[0] * hx[2], ax[0] * hx[1] - ax[1] * hx[0]], sl = Math.hypot(...s); s[0] /= sl; s[1] /= sl; s[2] /= sl;
    const t = [ax[1] * s[2] - ax[2] * s[1], ax[2] * s[0] - ax[0] * s[2], ax[0] * s[1] - ax[1] * s[0]], base = this.p.length / 3, vt = 0.75 + INSET, vb = 1 - INSET;
    for (let i = 0; i <= sides; i++) {
      const a = i / sides * 6.2832, ca = Math.cos(a), sa = Math.sin(a), nx = s[0] * ca + t[0] * sa, ny = s[1] * ca + t[1] * sa, nz = s[2] * ca + t[2] * sa, u = INSET + (CELL - 2 * INSET) * (i / sides) * reps % CELL;
      this.v(A[0] + nx * r0, A[1] + ny * r0, A[2] + nz * r0, nx, ny, nz, u, vt, 0.8);
      this.v(B[0] + nx * r1, B[1] + ny * r1, B[2] + nz * r1, nx, ny, nz, u, vb, 1);
    }
    for (let i = 0; i < sides; i++) { const a = base + i * 2, b = a + 1, c = a + 2, e = a + 3; this.ix.push(a, b, c, b, e, c); }
  }
  geo() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3)); g.setAttribute("normal", new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.c, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2)); g.setIndex(this.ix);
    g.computeBoundingSphere(); return g;
  }
}
const PI = Math.PI, GA = 2.399963;
function shell(b, r, crown, N, size, scatter, cards) {
  const [cx, cy, cz] = crown.c, [rx, ry, rz] = crown.r;
  for (let i = 0; i < N; i++) {
    const y = 1 - 2 * (i + 0.5) / N, ring = Math.sqrt(Math.max(0, 1 - y * y)), phi = i * GA, k = scatter[0] + (scatter[1] - scatter[0]) * r();
    const C = [cx + Math.cos(phi) * ring * rx * k, cy + y * ry * k, cz + Math.sin(phi) * ring * rz * k];
    for (let j = 0; j < cards; j++) { const s = size * (0.85 + 0.3 * r()); b.card(C, s, s, phi + j * PI / cards + r() * 0.4, (r() - 0.5) * 1.1, r() * 6.28, r() < 0.5, crown); }
  }
}
// height of the model before an instance scales it
const SHAPES = [
  { H: 10, near(b, r) { b.limb([0, 0, 0], [0.1, 4.3, 0.05], 0.38, 0.2, 6, 1); b.limb([0.1, 3.7, 0.05], [1.5, 5.8, 0.5], 0.14, 0.05, 4, 1); b.limb([0.1, 3.6, 0.05], [-1.3, 5.6, -0.8], 0.13, 0.05, 4, 1);
      const crown = { c: [0, 6.7, 0], r: [3.7, 3.0, 3.7] }; shell(b, r, crown, 14, 3.1, [0.55, 0.86], 2);
      for (const [x, z, s] of [[0.4, -0.3, 3.6], [-0.9, 0.9, 3.2]]) b.card([x, 9.2, z], s, s, r() * 6, PI / 2 - 0.15, r() * 6, false, crown);
      for (const [x, z, s] of [[0.2, 0.5, 3.8], [-0.7, -0.8, 3.2]]) b.card([x, 4.6, z], s, s, r() * 6, PI / 2 + 0.12, r() * 6, false, crown); },
    far(b, r) { b.limb([0, 0, 0], [0.1, 4.4, 0.05], 0.38, 0.2, 4, 1); shell(b, r, { c: [0, 6.7, 0], r: [3.7, 3.0, 3.7] }, 5, 5.0, [0.45, 0.6], 2); } },
  { H: 7, near(b, r) { b.limb([0, 0, 0], [0.08, 2.3, 0.04], 0.26, 0.16, 5, 1); for (const a of [0.4, 2.5, 4.5]) b.limb([0.08, 2.1, 0.04], [Math.cos(a) * 2, 4.5, Math.sin(a) * 2], 0.1, 0.04, 3, 1);
      const crown = { c: [0, 5.3, 0], r: [4.2, 1.4, 4.2] };
      for (let i = 0; i < 9; i++) { const a = i * GA, d = 3.3 * Math.sqrt((i + 0.5) / 9), s = 3.6 * (0.85 + 0.3 * r()); b.card([Math.cos(a) * d, 5.6 + (r() - 0.5) * 0.9, Math.sin(a) * d], s, s, r() * 6, PI / 2 - 0.08 - r() * 0.35, r() * 6, r() < 0.5, crown); }
      for (let i = 0; i < 13; i++) { const a = i * GA, d = 3.8 * Math.sqrt((i + 0.5) / 13), s = 2.3 * (0.85 + 0.3 * r()); b.card([Math.cos(a) * d, 4.9 + (r() - 0.5) * 0.8, Math.sin(a) * d], s, s * 0.8, a + r() * 0.8, (r() - 0.5) * 0.5, r() * 6, r() < 0.5, crown); } },
    far(b, r) { b.limb([0, 0, 0], [0.08, 2.6, 0.04], 0.26, 0.12, 3, 1); const crown = { c: [0, 5.3, 0], r: [4.2, 1.4, 4.2] };
      for (let i = 0; i < 3; i++) { const a = i * 2.1; b.card([Math.cos(a) * 1.5, 5.7, Math.sin(a) * 1.5], 5.6, 5.6, r() * 6, PI / 2 - 0.15, r() * 6, false, crown); }
      for (let i = 0; i < 4; i++) { const a = i * PI / 2; b.card([Math.cos(a) * 2.3, 4.9, Math.sin(a) * 2.3], 4.2, 2.8, a + PI / 2, 0.05, 0, false, crown); } } },
  { H: 24, near(b, r) { b.limb([0, 0, 0], [0.2, 18, 0.1], 0.38, 0.11, 6, 3); b.limb([0.1, 11, 0.05], [2.1, 16, 0.7], 0.12, 0.04, 4, 1); b.limb([0.14, 13, 0.08], [-1.8, 18, -1.0], 0.1, 0.04, 4, 1);
      const crown = { c: [0.2, 17.6, 0.1], r: [3.7, 6.3, 3.7] };
      for (let i = 0; i < 22; i++) { const y = 1 - 2 * (i + 0.5) / 22, ring = Math.sqrt(1 - y * y), a = i * GA, k = 0.5 + 0.42 * r(), w = 2.7 * (0.85 + 0.3 * r()); b.card([crown.c[0] + Math.cos(a) * ring * 3.7 * k, 17.6 + y * 6.3 * k, crown.c[2] + Math.sin(a) * ring * 3.7 * k], w, w * 1.9, a + r() * 1.2, (r() - 0.5) * 0.4, (r() - 0.5) * 0.3, r() < 0.5, crown); } },
    far(b, r) { b.limb([0, 0, 0], [0.2, 18, 0.1], 0.38, 0.11, 3, 3); const crown = { c: [0.2, 17.6, 0.1], r: [3.7, 6.3, 3.7] };
      for (let i = 0; i < 7; i++) { const y = 1 - 2 * (i + 0.5) / 7, ring = Math.sqrt(1 - y * y), a = i * GA; b.card([crown.c[0] + Math.cos(a) * ring * 2.2, 17.6 + y * 4.2, crown.c[2] + Math.sin(a) * ring * 2.2], 4.6, 7, a, 0, 0, i % 2 > 0, crown); } } },
  { H: 20, near(b, r) { b.limb([0, 0, 0], [0.1, 19.3, 0.05], 0.36, 0.05, 6, 2);
      const crown = { c: [0, 14, 0], r: [3.6, 6.6, 3.6] };
      for (let t = 0; t < 6; t++) { const f = t / 5, y = 9.4 + 9 * f, R = 3.7 * Math.pow(Math.sin(PI * (0.14 + 0.72 * f)), 0.8) * (1 - 0.35 * f);
        for (let k = 0; k < 4; k++) { const a = k * PI / 2 + t * 1.1 + r() * 0.5, d = R * 0.6; b.card([Math.cos(a) * d, y, Math.sin(a) * d], R * 1.2 + 1.0, 3.3, a + PI / 2, 0.32, (r() - 0.5) * 0.3, r() < 0.5, crown); }
        const a = t * 2.4; b.card([Math.cos(a) * R * 0.3, y, Math.sin(a) * R * 0.3], R * 1.6 + 0.7, 3.2, a, 0.08, 0, t % 2 > 0, crown); } },
    far(b, r) { b.limb([0, 0, 0], [0.1, 19.3, 0.05], 0.36, 0.05, 3, 2); const crown = { c: [0, 14, 0], r: [3.6, 6.6, 3.6] };
      for (let k = 0; k < 3; k++) b.card([0, 14, 0], 8.8, 11.5, k * PI / 3 + 0.3, 0, 0, k > 0, crown);
      for (let k = 0; k < 2; k++) b.card([0, 18, 0], 4.6, 5.2, k * PI / 2 + 0.9, 0, 0, k > 0, crown); } },
  { H: 24, near(b, r) { b.limb([0, 0, 0], [0.04, 23.4, 0.02], 0.42, 0.05, 6, 2);
      const crown = { c: [0, 12, 0], r: [5.6, 11.5, 5.6] }, per = [5, 5, 4, 4, 4, 3, 3, 2];
      for (let t = 0; t < 8; t++) { const f = t / 7, y = 2.6 + 19.4 * f, R = 5.2 * Math.pow(1 - f * 0.97, 0.9) + 0.3;
        for (let k = 0; k < per[t]; k++) { const a = k * 6.2832 / per[t] + t * 0.9 + r() * 0.5, d = R * 0.58; b.card([Math.cos(a) * d, y, Math.sin(a) * d], R * 1.25 + 0.9, 2.7 + (1 - f) * 1.3, a + PI / 2, 0.3, (r() - 0.5) * 0.25, r() < 0.5, crown); } }
      for (let k = 0; k < 2; k++) b.card([0, 21.6, 0], 2.2, 5, k * PI / 2 + 0.4, 0, 0, k > 0, crown); },
    far(b, r) { b.limb([0, 0, 0], [0.04, 23.4, 0.02], 0.42, 0.05, 3, 2); const crown = { c: [0, 12, 0], r: [5.6, 11.5, 5.6] };
      for (const [y, R, H] of [[5, 5, 6.5], [10.6, 3.9, 6.2], [16, 2.5, 5.8], [21, 1.1, 5]]) for (let k = 0; k < 2; k++) b.card([0, y, 0], 2 * R + 1, H, k * PI / 2 + y, 0, 0, k > 0, crown); } },
  // a shrub is four leaf cards and no trunk: the same atlas as the trees, 8 triangles
  { H: 1.5, bush: true, near() {}, far(b, r) { const crown = { c: [0, 0.75, 0], r: [1.1, 0.85, 1.1] };
      for (let k = 0; k < 3; k++) b.card([(r() - 0.5) * 0.3, 0.72, (r() - 0.5) * 0.3], 2.1, 1.55, k * PI / 3 + r() * 0.4, (r() - 0.5) * 0.2, r() * 0.5, k > 0, crown);
      b.card([0, 1.05, 0], 1.7, 1.7, r() * 6, PI / 2 - 0.2, r() * 6, false, crown); } },
];

// ---------------------------------------------------------------- instances
const NEAR_R = [95, 95, 110, 140, 140, 0], FAR_R2 = [380 * 380, 380 * 380, 420 * 420, 520 * 520, 520 * 520, 0], NEAR_CAP = 300, FAR_CAP = 3900, BUSH_CAP = 1500, BUSH_A = 5;
const LEAF_CUT = 0.62;      // no multisampled target: the opaque pass stops at this alpha and a blended pass draws the soft edge below it
const FOREST_E = 1300, THIN_E = 1050, MEDIAN_R = 300, FLOOR_R = 150;      // brief section 7: closed forest from about 1,300 m
// Shrubs stand at most 3 m from a tree: the worker keeps its trees 3.5 m off the road, so these are clear of it too.
function addBushes(out, x0, z0, sp, n, salt, key, groundAt) {
  for (let k = 0; k < n; k++) {
    const h0 = hash(x0 * 1.7 + salt + k, z0 * 2.3), h1 = hash(z0 * 1.9 - k, x0 * 1.1 + salt), ang = h0 * 6.2832, rad = 1.2 + 1.8 * h1, x = x0 + Math.cos(ang) * rad, z = z0 + Math.sin(ang) * rad;
    if (x < 0 || z < 0) continue;
    out.push(x, z, h1 * 6.2832, sp * 10 + 0.7 + 0.9 * h0, groundAt(key, x, z));
  }
}
export class PkTrees {
  constructor(scene, make) {
    const t0 = performance.now();
    this.atlas = buildLeafAtlas();
    this.mat = new THREE.MeshStandardMaterial({ map: this.atlas, vertexColors: true, roughness: 0.9, metalness: 0, alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide });      // coverage only takes effect on the high preset, which has a multisampled target
    const leafShader = soft => s => {
      s.uniforms.uNight = U.uNight;
      s.vertexShader = "attribute vec2 aLeaf;\n" + s.vertexShader.replace("#include <uv_vertex>", "#include <uv_vertex>\n  vMapUv += uv.y < 0.75 ? vec2(mod(aLeaf.x, 4.0), floor(aLeaf.x / 4.0)) * 0.25 : vec2(aLeaf.y * 0.25, 0.0);");
      // read the leaf mask a little blurred: at 0.6 render scale the sharpest levels break into single pixels, and keepCoverage has made the softer levels just as full
      s.fragmentShader = s.fragmentShader.replace("#include <map_fragment>", THREE.ShaderChunk.map_fragment.replace("texture2D( map, vMapUv )", "texture2D( map, vMapUv, 1.25 )"));
      s.fragmentShader = s.fragmentShader.replace("#include <normal_fragment_begin>", THREE.ShaderChunk.normal_fragment_begin.replace("normal *= faceDirection;", ""));   // both faces of a card use the crown's normal
      s.fragmentShader = "uniform float uNight;\n" + s.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * vec3(0.27, 0.29, 0.36) * uNight;");      // moon and sky glow, as on the hillsides, so a crown at night is a shape and not a hole
      if (soft) s.fragmentShader = s.fragmentShader.replace("#include <alphatest_fragment>", `#include <alphatest_fragment>\n  if (diffuseColor.a >= ${LEAF_CUT.toFixed(2)}) discard;`);
    };
    this.mat.onBeforeCompile = leafShader(false);
    this.mat.customProgramCacheKey = () => "pkleaf3";
    this.leafShader = leafShader; this.scene = scene;
    const mk = (geo, cap, shadow) => { const im = make(geo, this.mat, cap, shadow); im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3); const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2); a.setUsage(THREE.DynamicDrawUsage); im.geometry.setAttribute("aLeaf", a); im.leaf = a; return im; };
    this.shapes = SHAPES.map((S, i) => { const n = new Build(), f = new Build(), r = rng32(7 + i); S.near(n, r); S.far(f, r); return S.bush ? { near: null, far: mk(f.geo(), BUSH_CAP, false) } : { near: mk(n.geo(), NEAR_CAP, true), far: mk(f.geo(), FAR_CAP, i >= 3) }; });
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(); this._e = new THREE.Euler(); this._c = new THREE.Color();
    this.lastX = 1e12; this.lastZ = 1e12;
    this.stats = { atlasMs: Math.round(performance.now() - t0), near: 0, far: 0, species: {} };
  }
  // Hue: a stand shares a cast (30 m patches), and each tree then moves away from it
  tint(x, z, shape) {
    const st = hash(Math.floor(x / 30), Math.floor(z / 30)), h = hash(Math.round(x * 0.5), Math.round(z * 0.5)), h2 = hash(z * 0.73, x * 0.91), g = 0.8 + 0.2 * st + 0.2 * h, warm = shape >= 3 ? 0.5 + 0.5 * h2 : st * 0.5 + h2 * 0.5;
    return this._c.setRGB(g * (0.86 + 0.3 * warm), g, g * (0.98 - 0.26 * warm));
  }
  // M-2 median shrubs: take them from the faceted mound list, they are drawn as leaf cards here
  absorb(src) { for (const d of src.values()) if (d.shrub) { if (d.shrub.length) d.pkShrub = d.shrub; d.shrub = null; } }
  // Thicken one tile's woods, nearest tile first. Runs on the main thread after the tile's road index exists,
  // because a tree added here must keep off the carriageways as the worker's own trees do.
  densify(src, camX, camZ, offsets, groundAt) {
    const G = window.GAME, I = G && G.IDX; if (!I || !groundAt) return false;
    let best = null, bk = null, bd = 1e18, wait = false;
    for (const [key, d] of src) {
      if (!d.pk || d.pkDense) continue;
      if (!I.tiles.has(key) || G.snapState.idxJobs) { wait = true; continue; }
      const off = offsets.get(key); if (!off) continue;
      const dd = (off.x + 1100 - camX) ** 2 + (off.z + 1100 - camZ) ** 2;
      if (dd < bd) { bd = dd; best = d; bk = key; }
    }
    if (!best) return wait;
    const off = offsets.get(bk), a = best.pk, more = [], bush = [];
    for (let i = 0; i < a.length; i += 4) {
      const x0 = a[i], z0 = a[i + 1], sp = Math.floor(a[i + 3] / 10), shape = SP[sp].shape, e = groundAt(bk, x0, z0), forest = shape >= 3 || sp === OAK;
      const ll0 = toLatLon(x0 + off.x, z0 + off.z), slopes = ll0[0] > 33.72 && ll0[0] < 33.98 && ll0[1] > 73.2 && ll0[1] < 73.54 && e >= 600 && e < THIN_E;      // the Expressway's lower slopes: chir and scrub, brief section 7
      const n = !forest ? (slopes ? 1 : 0) : e >= FOREST_E ? 5 : e >= THIN_E ? 1 : slopes ? 3 : 0;      // the worker thins each tile to 2,600 trees, so a tile of road-side forest arrives sparse
      for (let k = 0; k < n; k++) {
        const h0 = hash(x0 + k * 3.1, z0 - k * 1.7), h1 = hash(z0 + k * 7.3, x0 + k * 2.9), ang = h0 * 6.2832, rad = 6 + 16 * h1, x = x0 + Math.cos(ang) * rad, z = z0 + Math.sin(ang) * rad;
        if (x < 0 || z < 0) continue;
        const [la, lo] = toLatLon(x + off.x, z + off.z);
        if (I.roadAt(la, lo) || (I.building && I.building(la, lo))) continue;
        const y = groundAt(bk, x, z), v = pkSpecies(la, lo, y, true) * 10 + 0.7 + 0.8 * h1;
        more.push(x, z, h0 * 6.2832, v, y);
        addBushes(bush, x, z, UND, 1, k + 5, bk, groundAt);
      }
      if (forest && (e >= THIN_E - 100 || slopes)) addBushes(bush, x0, z0, UND, 2, 1, bk, groundAt);
      else if (sp === KIK || sp === PHU) addBushes(bush, x0, z0, SHR, 2, 2, bk, groundAt);
    }
    best.pkMore = Float32Array.from(more); best.pkBush = Float32Array.from(bush); best.pkDense = true;
    return true;
  }
  // Normal and low quality have no multisampled target, so alpha-to-coverage does nothing there and every leaf edge is a hard stair. Second pass, same instance buffers:
  // only the fringe between the two alpha cuts, blended, no depth written, and the opaque pass's depth keeps it out of the leaf interiors.
  initSoft() {
    const G = window.GAME, rt = G && G.fx && G.fx.composer && G.fx.composer.renderTarget1; if (!rt) return;
    this.softDone = true;
    if (rt.samples > 0) return;
    this.mat.alphaTest = LEAF_CUT;
    const soft = this.softMat = new THREE.MeshStandardMaterial({ map: this.atlas, vertexColors: true, roughness: 0.9, metalness: 0, alphaTest: 0.05, side: THREE.DoubleSide, transparent: true, depthWrite: false, depthFunc: THREE.LessDepth });
    soft.onBeforeCompile = this.leafShader(true); soft.customProgramCacheKey = () => "pkleaf3-soft";
    this.soft = new Map();
    for (const s of this.shapes) for (const im of [s.near, s.far]) {
      if (!im) continue;
      const m = new THREE.InstancedMesh(im.geometry, soft, 1); m.instanceMatrix = im.instanceMatrix; m.instanceColor = im.instanceColor; m.count = 0; m.visible = false; m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false; m.renderOrder = 5;
      this.scene.add(m); this.soft.set(im, m);
    }
  }
  update(src, camX, camZ, offsets, groundAt, force) {
    if (!this.softDone) this.initSoft();
    if (force) this.absorb(src);
    const added = this.densify(src, camX, camZ, offsets, groundAt);
    if (!force && !added && (camX - this.lastX) ** 2 + (camZ - this.lastZ) ** 2 < 36) return;     // nothing has moved enough to change the list
    this.lastX = camX; this.lastZ = camZ;
    const cand = [];
    for (const [key, d] of src) {
      const off = offsets.get(key), a = d.pk; if (!off || !a) continue;
      for (let i = 0; i < a.length; i += 4) {
        const x = a[i] + off.x, z = a[i + 1] + off.z, dx = x - camX, dz = z - camZ, dd = dx * dx + dz * dz, v = a[i + 3];
        if (dd < FAR_R2[SP[Math.floor(v / 10)].shape]) cand.push(dd, x, z, a[i + 2], v, groundAt ? groundAt(key, a[i], a[i + 1]) : 0);
      }
      const m = d.pkMore;     // the added trees thin out with distance, so no ring shows
      if (m) for (let i = 0; i < m.length; i += 5) { const x = m[i] + off.x, z = m[i + 1] + off.z, dx = x - camX, dz = z - camZ, dd = dx * dx + dz * dz, R = 220 + 150 * (m[i + 3] % 1); if (dd < R * R) cand.push(dd, x, z, m[i + 2], m[i + 3], m[i + 4]); }
      const b = d.pkBush;
      if (b) for (let i = 0; i < b.length; i += 5) { const x = b[i] + off.x, z = b[i + 1] + off.z, dx = x - camX, dz = z - camZ, dd = dx * dx + dz * dz; if (dd < FLOOR_R * FLOOR_R) cand.push(dd, x, z, b[i + 2], b[i + 3], b[i + 4]); }
      const s = d.pkShrub;
      if (s) for (let i = 0; i < s.length; i += 4) { const x = s[i] + off.x, z = s[i + 1] + off.z, dx = x - camX, dz = z - camZ, dd = dx * dx + dz * dz; if (dd < MEDIAN_R * MEDIAN_R) cand.push(dd, x, z, s[i + 2], SHR * 10 + s[i + 3], groundAt ? groundAt(key, s[i], s[i + 1]) : 0); }
    }
    const n = cand.length / 6, order = new Array(n); for (let i = 0; i < n; i++) order[i] = i;
    order.sort((p, q) => cand[p * 6] - cand[q * 6]);
    const nc = [0, 0, 0, 0, 0, 0], fc = [0, 0, 0, 0, 0, 0], seen = {};
    let nearUsed = 0, farUsed = 0, bushUsed = 0;
    for (let j = 0; j < n; j++) {
      const o = order[j] * 6, v = cand[o + 4], sp = Math.floor(v / 10), S = SP[sp], A = S.shape, bushy = A === BUSH_A, near = !bushy && nearUsed < NEAR_CAP && cand[o] < NEAR_R[A] * NEAR_R[A];
      if (bushy ? bushUsed >= BUSH_CAP : !near && farUsed >= FAR_CAP) continue;
      const im = near ? this.shapes[A].near : this.shapes[A].far, idx = near ? nc[A]++ : fc[A]++;
      if (bushy) bushUsed++; else if (near) nearUsed++; else farUsed++;
      const px = cand[o + 1], pz = cand[o + 2], f = Math.max(0, Math.min(1, (v - sp * 10 - 0.7) / 1.3));
      // no two alike: height, the two crown widths, a slight lean, and now and then a young tree
      const hA = hash(px * 1.31, pz * 0.77), hB = hash(pz * 1.13, px * 0.59), hC = hash(px * 0.47 + 9.1, pz * 1.91), hD = hash(pz * 0.83 + 3.3, px * 1.57), young = !bushy && A !== 2 && hD < 0.1 ? 0.62 : 1;
      const sy = (S.h[0] + (S.h[1] - S.h[0]) * f) / SHAPES[A].H * (0.84 + 0.32 * hA) * young, sxz = sy * S.spread;
      this._p.set(px, cand[o + 5], pz); this._q.setFromEuler(this._e.set(bushy ? 0 : (hB - 0.5) * 0.09, cand[o + 3] + hC * 6.2832, bushy ? 0 : (hC - 0.5) * 0.09)); this._s.set(sxz * (0.86 + 0.28 * hB), sy, sxz * (0.86 + 0.28 * hD));
      this._m.compose(this._p, this._q, this._s); im.setMatrixAt(idx, this._m); im.setColorAt(idx, this.tint(px, pz, A)); im.leaf.setXY(idx, LEAF_ALT[sp] !== undefined && hB < 0.35 ? LEAF_ALT[sp] : S.leaf, S.bark);
      seen[S.name] = (seen[S.name] || 0) + 1;
    }
    this.shapes.forEach((s, A) => { for (const [im, c] of [[s.near, nc[A]], [s.far, fc[A]]]) { if (!im) continue; im.count = c; im.visible = c > 0; im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; im.leaf.needsUpdate = true; const q = this.soft && this.soft.get(im); if (q) { q.count = c; q.visible = c > 0; } } });
    this.stats.near = nearUsed; this.stats.far = farUsed; this.stats.bush = bushUsed; this.stats.species = seen;
  }
}
