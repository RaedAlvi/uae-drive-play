// UAE Drive vehicles: a detailed player coupe and instancing-ready traffic, all procedural.
//
// Conventions: metres, Y up, every vehicle faces -Z, origin on the ground midway between the
// axles (so zFront is negative and zRear positive, and they are not always equal).
// No downloaded models or textures; the only texture is a small canvas number plate.
//
// Bodies are lofts: a symmetric cross-section ring is sampled along Z from spline profiles
// (half width, sill, shoulder, hood/deck height), with wheel arches cut by raising the section
// floor over each axle. Every loft face is assigned a slot (paint, glass, trim, lights...) so
// colour boundaries follow the mesh and nothing is layered coplanar (no z-fighting at range).

import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { PkNightPaint } from "./materials.js";

// ---------------------------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------------------------

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const bez = (p0, p1, p2, t) => { const u = 1 - t; return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]; };

// Monotone cubic (Fritsch-Carlson) through [[x, y], ...]; also accepts a number or a function.
function spline(keys) {
  if (typeof keys === "function") return keys;
  if (typeof keys === "number") return () => keys;
  const n = keys.length, xs = keys.map(k => k[0]), ys = keys.map(k => k[1]);
  if (n === 1) return () => ys[0];
  const d = [], m = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return x => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

const _col = new THREE.Color();
const _colCache = new Map();
// sRGB hex to linear RGB, the space three.js expects in vertex colours.
function lin(hex) {
  let c = _colCache.get(hex);
  if (!c) { _col.setHex(hex); c = [_col.r, _col.g, _col.b]; _colCache.set(hex, c); }
  return c;
}

// ---------------------------------------------------------------------------------------------
// Triangle collection. A slot is { k: bucket key, c: optional hex colour }.
// ---------------------------------------------------------------------------------------------

class Bucket {
  constructor() { this.p = []; this.n = []; this.c = []; }
  add(p, n, rgb) {
    for (let i = 0; i < 9; i++) { this.p.push(p[i]); this.n.push(n[i]); }
    const c = rgb || [1, 1, 1];
    for (let v = 0; v < 3; v++) this.c.push(c[0], c[1], c[2]);
  }
  get tris() { return this.p.length / 9; }
  geometry(withColor) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.n, 3));
    if (withColor) g.setAttribute("color", new THREE.Float32BufferAttribute(this.c, 3));
    return g;
  }
}

class Kit {
  constructor() { this.buckets = new Map(); }
  bucket(k) { let b = this.buckets.get(k); if (!b) { b = new Bucket(); this.buckets.set(k, b); } return b; }
  rgb(s) { return s.c != null ? lin(s.c) : null; }
  // Flat triangle. If ref is given the winding is flipped so the face points along ref.
  tri(s, a, b, c, ref) {
    let n = cross(sub(b, a), sub(c, a));
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-12) return;
    if (ref && dot(n, ref) < 0) { const t = b; b = c; c = t; n = [-n[0], -n[1], -n[2]]; }
    n = [n[0] / l, n[1] / l, n[2] / l];
    this.bucket(s.k).add([...a, ...b, ...c], [...n, ...n, ...n], this.rgb(s));
  }
  // Triangle with vertex normals; winding follows the normals.
  triN(s, a, b, c, na, nb, nc) {
    const g = cross(sub(b, a), sub(c, a));
    if (Math.hypot(g[0], g[1], g[2]) < 1e-12) return;
    const avg = [na[0] + nb[0] + nc[0], na[1] + nb[1] + nc[1], na[2] + nb[2] + nc[2]];
    if (dot(g, avg) < 0) { let t = b; b = c; c = t; t = nb; nb = nc; nc = t; }
    this.bucket(s.k).add([...a, ...b, ...c], [...na, ...nb, ...nc], this.rgb(s));
  }
  quad(s, a, b, c, d, ref) { this.tri(s, a, b, c, ref); this.tri(s, a, c, d, ref); }
  // Axis-aligned box; skip is a string of faces to leave out: "px nx py ny pz nz".
  box(s, x0, y0, z0, x1, y1, z1, skip = "") {
    const F = {
      px: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]],
      nx: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
      py: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]],
      ny: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
      pz: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
      nz: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]],
    };
    for (const f in F) if (!skip.includes(f)) this.quad(s, ...F[f]);
  }
  // Import a three.js geometry (optionally transformed).
  geo(s, geometry, matrix) {
    let g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    if (matrix) g.applyMatrix4(matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    const p = g.attributes.position, n = g.attributes.normal, rgb = this.rgb(s), b = this.bucket(s.k);
    for (let i = 0; i < p.count; i += 3) {
      const pp = [], nn = [];
      for (let v = 0; v < 3; v++) { pp.push(p.getX(i + v), p.getY(i + v), p.getZ(i + v)); nn.push(n.getX(i + v), n.getY(i + v), n.getZ(i + v)); }
      b.add(pp, nn, rgb);
    }
    g.dispose();
  }
  // Loft triangles [{ s, a, b, c }] with crease-aware smooth normals.
  smooth(list, crease) {
    if (!list.length) return;
    const pos = new Float32Array(list.length * 9);
    list.forEach((t, i) => { pos.set(t.a, i * 9); pos.set(t.b, i * 9 + 3); pos.set(t.c, i * 9 + 6); });
    const nor = creaseNormals(pos, crease);
    list.forEach((t, i) => this.bucket(t.s.k).add(Array.from(pos.subarray(i * 9, i * 9 + 9)), Array.from(nor.subarray(i * 9, i * 9 + 9)), this.rgb(t.s)));
  }
}

// Smooth normals that break where neighbouring faces differ by more than the crease angle.
// Positions are welded at 0.1 mm, area weighted.
function creaseNormals(pos, angle) {
  const nf = pos.length / 9, cosA = Math.cos(angle);
  const fn = new Float64Array(nf * 3), fa = new Float64Array(nf);
  for (let f = 0; f < nf; f++) {
    const o = f * 9;
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    fa[f] = l;
    if (l > 0) { nx /= l; ny /= l; nz /= l; }
    fn[f * 3] = nx; fn[f * 3 + 1] = ny; fn[f * 3 + 2] = nz;
  }
  const ids = new Int32Array(nf * 3), map = new Map(), groups = [];
  for (let v = 0; v < nf * 3; v++) {
    const k = Math.round(pos[v * 3] * 1e4) + "," + Math.round(pos[v * 3 + 1] * 1e4) + "," + Math.round(pos[v * 3 + 2] * 1e4);
    let id = map.get(k);
    if (id === undefined) { id = groups.length; map.set(k, id); groups.push([]); }
    ids[v] = id;
    groups[id].push((v / 3) | 0);
  }
  const out = new Float32Array(nf * 9);
  for (let v = 0; v < nf * 3; v++) {
    const f = (v / 3) | 0, fx = fn[f * 3], fy = fn[f * 3 + 1], fz = fn[f * 3 + 2];
    let sx = 0, sy = 0, sz = 0;
    for (const o of groups[ids[v]]) {
      const ox = fn[o * 3], oy = fn[o * 3 + 1], oz = fn[o * 3 + 2];
      if (fx * ox + fy * oy + fz * oz >= cosA) { sx += ox * fa[o]; sy += oy * fa[o]; sz += oz * fa[o]; }
    }
    let l = Math.hypot(sx, sy, sz);
    if (l < 1e-12) { sx = fx; sy = fy; sz = fz; l = Math.hypot(sx, sy, sz) || 1; }
    out[v * 3] = sx / l; out[v * 3 + 1] = sy / l; out[v * 3 + 2] = sz / l;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Lofts
// ---------------------------------------------------------------------------------------------

// Outward 2D normals of a half ring (right half, bottom centre to top centre, mirrored in x).
function ringNormals(pts) {
  const n = pts.length, N = [];
  const get = k => {
    if (k < 0) { const q = pts[Math.min(-k, n - 1)]; return [-q[0], q[1]]; }
    if (k > n - 1) { const q = pts[Math.max(2 * (n - 1) - k, 0)]; return [-q[0], q[1]]; }
    return pts[k];
  };
  for (let k = 0; k < n; k++) {
    let tx = 0, ty = 0;
    for (let a = 1; a < n; a++) {
      const p = get(k - a), q = get(k + a);
      tx = q[0] - p[0]; ty = q[1] - p[1];
      if (tx * tx + ty * ty > 1e-10) break;
    }
    const l = Math.hypot(tx, ty) || 1;
    N.push([ty / l, -tx / l]);
  }
  return N;
}

// Rounded ends: rings inset along their normals on a quarter circle of radius r.
function roundRows(base, zEdge, r, steps, dir) {
  const N = ringNormals(base.pts), rows = [];
  const order = [];
  for (let s = 1; s <= steps; s++) order.push(s);
  if (dir < 0) order.reverse();
  for (const s of order) {
    const th = (s / steps) * Math.PI / 2, inset = r * (1 - Math.cos(th));
    const z = dir < 0 ? zEdge + r * (1 - Math.sin(th)) : zEdge - r * (1 - Math.sin(th));
    const pts = base.pts.map((p, k) => [Math.max(0, p[0] - N[k][0] * inset), p[1] - N[k][1] * inset]);
    // Fold guard: an inset larger than a corner radius would flip the corner over itself.
    for (let k = 1; k < pts.length; k++) {
      const o = base.pts[k], op = base.pts[k - 1];
      if ((pts[k][0] - pts[k - 1][0]) * (o[0] - op[0]) + (pts[k][1] - pts[k - 1][1]) * (o[1] - op[1]) < 0) pts[k] = [pts[k - 1][0], pts[k - 1][1]];
    }
    rows.push({ z, round: dir < 0 ? "start" : "end", pts });
  }
  return rows;
}

// Build loft triangles. rows: [{ z, pts }] ordered by z. slot(face) returns a slot or null.
function loft(rows, layout, slot, { capStart = false, capEnd = false } = {}) {
  const n = rows[0].pts.length, R = 2 * n - 2, out = [];
  const P = (row, k) => {
    if (k < n) { const q = row.pts[k]; return [q[0], q[1], row.z]; }
    const q = row.pts[2 * n - 2 - k];
    return [-q[0], q[1], row.z];
  };
  const push = (s, a, b, c) => {
    const g = cross(sub(b, a), sub(c, a));
    if (g[0] * g[0] + g[1] * g[1] + g[2] * g[2] > 1e-14) out.push({ s, a, b, c });
  };
  for (let i = 0; i < rows.length - 1; i++) {
    const r0 = rows[i], r1 = rows[i + 1];
    for (let k = 0; k < R; k++) {
      const k1 = (k + 1) % R;
      const a = P(r0, k), b = P(r0, k1), c = P(r1, k1), d = P(r1, k);
      const right = k <= n - 2, j = right ? k : 2 * n - 3 - k;
      const nn = norm(cross(sub(c, a), sub(d, b)));
      const s = slot({
        part: "side", j, type: layout[j], side: right ? 1 : -1,
        x: (a[0] + b[0] + c[0] + d[0]) / 4, y: (a[1] + b[1] + c[1] + d[1]) / 4, z: (a[2] + b[2] + c[2] + d[2]) / 4,
        n: nn, r0, r1, step: r0.z === r1.z,
      });
      if (!s) continue;
      push(s, a, b, d); push(s, b, c, d);
    }
  }
  const cap = (row, start) => {
    for (let j = 0; j < n - 1; j++) {
      const Rj = P(row, j), Rj1 = P(row, j + 1);
      if (Rj1[1] < Rj[1] - 0.003) break; // the top has turned downward (valley or tub): stop
      if (Math.abs(Rj1[1] - Rj[1]) < 1e-5) continue;
      const Lj = [-Rj[0], Rj[1], Rj[2]], Lj1 = [-Rj1[0], Rj1[1], Rj1[2]];
      const s = slot({ part: start ? "capS" : "capE", j, type: layout[j], side: 0, x: 0, y: (Rj[1] + Rj1[1]) / 2, z: row.z, n: [0, 0, start ? -1 : 1], r0: row, r1: row, step: false, xw: Math.max(Rj[0], Rj1[0]) });
      if (!s) continue;
      if (start) { push(s, Rj, Lj1, Rj1); push(s, Rj, Lj, Lj1); }
      else { push(s, Rj, Rj1, Lj1); push(s, Rj, Lj1, Lj); }
    }
  };
  if (capStart) cap(rows[0], true);
  if (capEnd) cap(rows[rows.length - 1], false);
  return out;
}

// Lower body: floor, lower corner, side, shoulder, hood/deck top. Wheel arches raise the floor.
function bodyModel(B, Q) {
  const F = {};
  for (const k of ["w", "yB", "ymax", "ysh", "yt", "rs", "rb", "ku", "kt", "pw"]) F[k] = spline(B[k]);
  const P = z => ({ w: F.w(z), yB: F.yB(z), ymax: F.ymax(z), ysh: F.ysh(z), yt: F.yt(z), rs: F.rs(z), rb: F.rb(z), ku: F.ku(z), kt: F.kt(z), pw: F.pw(z) });
  const xs = (p, z, y, opt) => p.w - (y < p.ymax ? p.ku * (p.ymax - y) ** 2 : p.kt * (y - p.ymax) ** 2) - (B.scoop && !(opt && opt.noScoop) ? B.scoop(z, y) : 0);
  const edge = (p, z) => { const rs = Math.min(p.rs, (p.ysh - p.yB) * 0.3); return { rs, xe: xs(p, z, p.ysh, { noScoop: true }) - rs, ye: p.ysh }; };

  function ring(z, yBot = null, opt = {}) {
    const p = P(z), e = edge(p, z);
    const y1 = p.ysh - e.rs;
    let yb = yBot == null ? p.yB : Math.max(p.yB, yBot);
    yb = Math.min(yb, y1 - 0.004);
    const rb = Math.min(p.rb, (y1 - yb) * 0.4);
    const y0ref = p.yB + p.rb;
    const pts = [];
    const xb = xs(p, z, yb + rb, opt) - rb;
    if (Q.notch) {
      // Wheel well: only the outer part of the floor rises over the axle; the middle stays low.
      const xi = Math.min(B.wellX ?? 0.6, xb - 0.02), yLow = Math.min(p.yB, yb);
      pts.push([0, yLow], [xi, yLow], [xi, yb], [xb, yb]);
    } else for (let i = 0; i < Q.floor; i++) pts.push([xb * (i / (Q.floor - 1)), yb]);
    for (let c = 1; c <= Q.nC; c++) { const a = (c / (Q.nC + 1)) * Math.PI / 2; pts.push([xb + rb * Math.sin(a), yb + rb * (1 - Math.cos(a))]); }
    for (let s = 0; s < Q.nS; s++) {
      const y = clamp(lerp(y0ref, y1, s / (Q.nS - 1)), yb + rb, y1);
      pts.push([xs(p, z, y, opt), y]);
    }
    const p0 = pts[pts.length - 1];
    const slope = (e.ye - p.yt) * p.pw / Math.max(e.xe, 1e-3);
    const ctrl = [p0[0], e.ye + slope * (p0[0] - e.xe)];
    for (let c = 1; c <= Q.nSh; c++) pts.push(bez(p0, ctrl, [e.xe, e.ye], c / (Q.nSh + 1)));
    pts.push([e.xe, e.ye]);
    for (let t = 1; t <= Q.nT; t++) { const u = 1 - t / Q.nT; pts.push([e.xe * u, p.yt + (e.ye - p.yt) * u ** p.pw]); }
    return pts;
  }

  const layout = [];
  if (Q.notch) layout.push("floor", "well", "floor");
  else for (let j = 0; j < Q.floor - 1; j++) layout.push("floor");
  for (let j = 0; j < Q.nC + 1; j++) layout.push("corner");
  for (let j = 0; j < Q.nS - 1; j++) layout.push("side");
  for (let j = 0; j < Q.nSh + 1; j++) layout.push("shoulder");
  for (let j = 0; j < Q.nT; j++) layout.push("top");

  // Rows: regular samples, feature stations, arch cuts, then rounded ends.
  const z0 = B.zN + (B.noseR || 0), z1 = B.zT - (B.tailR || 0);
  const special = [];
  for (const a of B.axles) Q.archDz.forEach(f => special.push(a.z + f * a.ra));
  for (const st of B.steps || []) special.push(st.z);
  const dzMax = Math.max(...Q.archDz.map(Math.abs));
  const inArch = z => B.axles.some(a => Math.abs(z - a.z) < a.ra * dzMax + 0.02);
  const nearSpecial = z => special.some(s => Math.abs(s - z) < 0.015);
  const zs = [];
  const nMain = Math.max(2, Math.round((z1 - z0) / Q.dz));
  for (let i = 0; i <= nMain; i++) zs.push(z0 + (z1 - z0) * i / nMain);
  for (const z of B.features || []) if (z > z0 + 0.01 && z < z1 - 0.01) zs.push(z);
  let rows = zs.filter(z => z === z0 || z === z1 || (!inArch(z) && !nearSpecial(z))).map(z => ({ z, o: 1, pts: ring(z) }));
  for (const a of B.axles) {
    Q.archDz.forEach((f, i) => {
      const z = a.z + f * a.ra, yA = a.y + a.ra * Math.sqrt(Math.max(0, 1 - f * f));
      if (i === 0) rows.push({ z, o: 0, pts: ring(z) });
      rows.push({ z, o: 1, arch: a, pts: ring(z, yA) });
      if (i === Q.archDz.length - 1) rows.push({ z, o: 2, pts: ring(z) });
    });
  }
  for (const st of B.steps || []) rows.push({ z: st.z, o: 0, pts: ring(st.z, null, st.a) }, { z: st.z, o: 1, stepB: true, pts: ring(st.z, null, st.b) });
  rows.sort((p, q) => p.z - q.z || p.o - q.o);
  if (B.noseR > 0) rows = [...roundRows(rows[0], B.zN, B.noseR, Q.round, -1), ...rows];
  if (B.tailR > 0) rows = [...rows, ...roundRows(rows[rows.length - 1], B.zT, B.tailR, Q.round, 1)];

  function topY(z, x) {
    const p = P(z), e = edge(p, z);
    if (x >= e.xe) return e.ye;
    return p.yt + (e.ye - p.yt) * (Math.max(0, x) / e.xe) ** p.pw;
  }
  // Point on the surface at station z and fractional ring index u, plus the outward normal.
  function surf(z, u, side = 1) {
    const pts = ring(z), n = pts.length;
    const i = clamp(Math.floor(u), 0, n - 2), t = clamp(u - i, 0, 1);
    const N = ringNormals(pts);
    const x = lerp(pts[i][0], pts[i + 1][0], t), y = lerp(pts[i][1], pts[i + 1][1], t);
    const nn = norm([side * lerp(N[i][0], N[i + 1][0], t), lerp(N[i][1], N[i + 1][1], t), 0]);
    return { p: [side * x, y, z], n: nn };
  }
  return { B, P, rows, ring, layout, topY, surf, xe: z => edge(P(z), z).xe, n: rows[0].pts.length };
}

// Greenhouse / upper body: sits on the lower body, sides with tumblehome, rounded roof corners.
function houseModel(H, body, Q) {
  const roofF = spline(H.roof), gbF = spline(H.gb), gtF = spline(H.gt), rrF = spline(H.rr ?? 0.08), crF = spline(H.crown ?? 0.02);
  const gbAt = z => Math.min(gbF(z), body.xe(z) - (H.inset ?? 0.012));
  const baseAt = z => Math.min(body.topY(z, 0), body.topY(z, gbAt(z))) - (H.sink ?? 0.02);
  function ring(z) {
    const base = baseAt(z), roof = Math.max(base, roofF(z)), h = roof - base;
    const gb = gbAt(z), gt = Math.min(gtF(z), gb);
    const crown = Math.min(crF(z), h * 0.3), ye = roof - crown;
    const rr = Math.max(0, Math.min(rrF(z), (ye - base) * 0.45, gt * 0.45));
    const pts = [[0, base - 0.04], [gb, base - 0.04], [gb, base]];
    const s1 = [gt, ye - rr];
    for (let i = 1; i <= Q.hS; i++) {
      const t = i / (Q.hS + 1);
      pts.push([lerp(gb, s1[0], t) + (H.bulge ?? 0) * Math.sin(Math.PI * t) * Math.min(1, h * 5), lerp(base, s1[1], t)]);
    }
    pts.push(s1);
    const c1 = [gt - rr, ye];
    for (let i = 1; i <= Q.hC; i++) pts.push(bez(s1, [gt, ye], c1, i / (Q.hC + 1)));
    pts.push(c1);
    for (let i = 1; i <= Q.hT; i++) { const u = 1 - i / (Q.hT + 1); pts.push([c1[0] * u, roof - crown * u * u]); }
    pts.push([0, roof]);
    return pts;
  }
  const layout = ["hidden", "hidden"];
  for (let j = 0; j < Q.hS + 1; j++) layout.push("side");
  for (let j = 0; j < Q.hC + 1; j++) layout.push("corner");
  for (let j = 0; j < Q.hT + 1; j++) layout.push("top");
  let zs = H.rows ? [...H.rows] : [];
  if (!H.rows) {
    const nn = Math.max(2, Math.round((H.z1 - H.z0) / H.dz));
    for (let i = 0; i <= nn; i++) zs.push(H.z0 + (H.z1 - H.z0) * i / nn);
    for (const f of H.features || []) { zs = zs.filter(z => Math.abs(z - f) > 0.015); zs.push(f); }
    zs.sort((a, b) => a - b);
  }
  let rows = zs.map(z => ({ z, pts: ring(z) }));
  if (H.roundStart) rows = [...roundRows(rows[0], rows[0].z - H.roundStart, H.roundStart, Q.round, -1), ...rows];
  if (H.roundEnd) rows = [...rows, ...roundRows(rows[rows.length - 1], rows[rows.length - 1].z + H.roundEnd, H.roundEnd, Q.round, 1)];
  return { rows, ring, layout, baseAt, gbAt };
}

// ---------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------

// Vertex-coloured standard material where blue-tinted colours (glass, gloss black, chrome) get a
// low roughness and neutral or warm colours (tyres, plastics, cream paint) stay satin.
// Subclasses (not onBeforeCompile on an instance) so material.clone() keeps the patch.
class GlossDetailMaterial extends THREE.MeshStandardMaterial {
  constructor(params = {}) { super({ color: 0xffffff, vertexColors: true, roughness: 0.55, metalness: 0.1, ...params }); }
  onBeforeCompile(s) {
    s.fragmentShader = s.fragmentShader.replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
	float uaeGloss = clamp( ( vColor.b - vColor.r ) / max( vColor.b, 0.001 ) * 2.2, 0.0, 1.0 ) * step( vColor.g, vColor.b );
	roughnessFactor = mix( roughnessFactor, 0.06, uaeGloss );
#endif`);
  }
  customProgramCacheKey() { return "uae-detail-gloss-v2"; }
}

// Emissive that takes the vertex colour, so red tail lights glow red and headlights warm white.
class TintedLightsMaterial extends THREE.MeshStandardMaterial {
  constructor(params = {}) { super({ color: 0xffffff, vertexColors: true, roughness: 0.25, metalness: 0, emissive: 0xffffff, emissiveIntensity: 0.35, ...params }); }
  onBeforeCompile(s) {
    s.fragmentShader = s.fragmentShader.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
	totalEmissiveRadiance *= vColor.rgb;
#endif`);
  }
  customProgramCacheKey() { return "uae-lights-tint-v1"; }
}

const makeDetailMaterial = opts => new GlossDetailMaterial(opts);
const makeLightsMaterial = opts => new TintedLightsMaterial(opts);

// Pakistan traffic: the side glass is a lighter tint, so a mirror-sharp sun on it would blow out. Roughness gets a floor and the brightest reflections a soft shoulder.
class PkTrafficDetailMaterial extends GlossDetailMaterial {
  onBeforeCompile(s) {
    super.onBeforeCompile(s);
    s.fragmentShader = s.fragmentShader.replace("roughnessFactor = mix( roughnessFactor, 0.06, uaeGloss );", "roughnessFactor = mix( roughnessFactor, 0.16, uaeGloss );")
      .replace("#include <opaque_fragment>", `#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
	float pkPeak = max( outgoingLight.r, max( outgoingLight.g, outgoingLight.b ) );
	outgoingLight *= mix( 1.0, 1.0 / ( 1.0 + 4.0 * max( pkPeak - 0.22, 0.0 ) ), uaeGloss * ( 1.0 - smoothstep( 0.15, 0.4, vColor.b ) ) );
#endif
#include <opaque_fragment>`);
  }
  customProgramCacheKey() { return "pk-traffic-detail-v1"; }
}

const PK_REGION = () => typeof window !== "undefined" && window.CITY && window.CITY.region === "pakistan";

export function makeTrafficMaterials() {
  const pk = PK_REGION();
  const m = {
    paint: pk ? new PkNightPaint({ color: 0xffffff, roughness: 0.3, metalness: 0.2 }) : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.2 }),   // Pakistan: bodies keep some colour under the street lights (REVIEW3 item 8)
    detail: pk ? new PkTrafficDetailMaterial() : makeDetailMaterial(),
    lights: makeLightsMaterial(),
  };
  if (pk) m.art = new THREE.MeshStandardMaterial({ map: truckArtTexture(), roughness: 0.55, metalness: 0.05 });
  return m;
}

// Dubai private plate: white, black text, DUBAI in English and Arabic.
function plateTexture(text = "O 1234") {
  if (typeof document === "undefined") return null;
  const W = 256, H = 56, cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  if (window.CITY && window.CITY.region === "shanghai") {
    // Shanghai private plate: blue, white border and characters, 沪A then a dot and five characters
    g.fillStyle = "#1f4fa8"; g.fillRect(0, 0, W, H);
    g.strokeStyle = "#f2f4f8"; g.lineWidth = 3; g.strokeRect(5, 5, W - 10, H - 10);
    g.fillStyle = "#f2f4f8"; g.textAlign = "center"; g.textBaseline = "middle";
    g.font = "bold 32px 'Microsoft YaHei', 'SimHei', sans-serif"; g.fillText("沪A", 52, 29);
    g.beginPath(); g.arc(94, 29, 3.5, 0, Math.PI * 2); g.fill();
    g.font = "bold 36px Arial, sans-serif"; g.fillText("D7Q28", 172, 30);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    return tex;
  }
  g.fillStyle = "#f6f6f1"; g.fillRect(0, 0, W, H);
  g.strokeStyle = "#1a1a1a"; g.lineWidth = 3; g.strokeRect(2.5, 2.5, W - 5, H - 5);
  g.fillStyle = "#111"; g.textAlign = "center"; g.textBaseline = "middle";
  g.font = "bold 15px Tahoma, Arial, sans-serif"; g.fillText("دبي", 36, 18);
  g.font = "bold 13px Arial, sans-serif"; g.fillText("DUBAI", 36, 39);
  g.fillRect(70, 9, 2, H - 18);
  const [code, num] = String(text).split(/\s+/);
  g.font = "bold 36px Arial, sans-serif"; g.fillText(code || "O", 98, 30);
  g.font = "bold 38px Arial, sans-serif"; g.fillText(num || "1234", 184, 30);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ---------------------------------------------------------------------------------------------
// Player car
// ---------------------------------------------------------------------------------------------

const Q_HI = { floor: 4, notch: true, nC: 2, nS: 10, nSh: 3, nT: 6, dz: 0.075, round: 3, hS: 1, hC: 2, hT: 3,
  archDz: [-0.97, -0.9, -0.78, -0.62, -0.42, -0.2, 0, 0.2, 0.42, 0.62, 0.78, 0.9, 0.97] };

const COUPE = (() => {
  const zN = -2.305, zT = 2.195;
  return {
    zN, zT, noseR: 0.09, tailR: 0.1, wheelbase: 2.65, R: 0.34,
    axles: [{ z: -1.325, y: 0.34, ra: 0.39 }, { z: 1.325, y: 0.34, ra: 0.395 }],
    w: [[zN, 0.78], [-2.15, 0.875], [-1.9, 0.93], [-1.5, 0.957], [-1.1, 0.96], [-0.6, 0.94], [0.0, 0.928], [0.6, 0.95], [1.1, 0.975], [1.6, 0.972], [1.95, 0.945], [zT, 0.885]],
    yB: [[zN, 0.16], [-2.05, 0.12], [1.3, 0.115], [1.8, 0.2], [zT, 0.32]],
    ymax: [[zN, 0.33], [-1.5, 0.46], [0, 0.49], [1.4, 0.54], [zT, 0.55]],
    ysh: [[zN, 0.43], [-2.12, 0.55], [-1.85, 0.68], [-1.55, 0.78], [-1.3, 0.83], [-1.05, 0.84], [-0.8, 0.835], [-0.3, 0.86], [0.3, 0.9], [0.8, 0.96], [1.2, 1.0], [1.6, 0.995], [2.0, 0.965], [zT, 0.93]],
    yt: [[zN, 0.425], [-2.12, 0.53], [-1.85, 0.635], [-1.5, 0.7], [-1.2, 0.745], [-0.95, 0.775], [-0.5, 0.8], [0.4, 0.84], [0.9, 0.88], [1.2, 0.93], [1.5, 0.95], [1.9, 0.94], [2.1, 0.93], [zT, 0.925]],
    rs: [[zN, 0.07], [-1.3, 0.07], [0, 0.08], [1.3, 0.1], [zT, 0.1]],
    rb: [[zN, 0.08], [-2.0, 0.05], [1.8, 0.05], [zT, 0.09]], ku: 0.55, kt: 0.55, pw: 2.0,
    // Side intake: the door surface scoops inward toward the rear wheel, then steps out.
    scoop: (z, y) => z > 0.8 + 1e-9 ? 0 : 0.12 * sstep(-0.3, 0.78, z) ** 1.3 * sstep(0.27, 0.43, y) * (1 - sstep(0.64, 0.79, y)),
    steps: [{ z: 0.8, a: {}, b: { noScoop: true } }],
    features: [-0.78, 0.5],
    house: {
      z0: -1.02, z1: 1.4, dz: 0.06, features: [-0.22, 0.5, 0.72],
      roof: [[-1.05, 0.7], [-0.8, 0.86], [-0.5, 1.03], [-0.22, 1.17], [0.0, 1.235], [0.2, 1.25], [0.4, 1.235], [0.5, 1.215], [0.75, 1.13], [1.0, 1.04], [1.2, 0.975], [1.4, 0.93]],
      gb: [[-1.0, 0.74], [-0.4, 0.745], [0.3, 0.72], [0.8, 0.66], [1.4, 0.5]],
      gt: [[-1.0, 0.64], [-0.4, 0.57], [0.2, 0.55], [0.8, 0.5], [1.4, 0.4]],
      rr: 0.085, crown: 0.035, bulge: 0.012,
    },
  };
})();

const PT = {
  paint: { k: "paint" }, glass: { k: "glass" },
  carbon: { k: "trim", c: 0x1a1a1a }, intake: { k: "trim", c: 0x0a0b0e }, under: { k: "trim", c: 0x0d0d0d },
  gloss: { k: "trim", c: 0x07080b }, ti: { k: "trim", c: 0x4a4b4f },
};

function coupeBodySlot(B) {
  return f => {
    if (f.part === "capS") return f.y < 0.31 ? PT.intake : PT.paint;
    if (f.part === "capE") return f.y < 0.46 ? PT.carbon : f.y < 0.74 ? PT.intake : PT.paint;
    if (f.type === "floor" || f.type === "well") return PT.under;
    if (f.step) return PT.intake;
    if (f.z < B.zN + B.noseR + 0.03 && f.y < 0.31 && f.n[2] < -0.25) return PT.intake;
    if (f.z > B.zT - B.tailR - 0.01) {
      if (f.y < 0.46) return PT.carbon;
      if (f.y < 0.74 && f.n[2] > 0.3) return PT.intake;
    }
    if (f.type === "corner") return PT.carbon;
    if (f.z > 0.58 && f.z < 0.8 && B.scoop(f.z, f.y) > 0.075) return PT.intake;
    return PT.paint;
  };
}

function coupeHouseSlot() {
  return f => {
    if (f.type === "hidden") return null;
    if (f.part !== "side") return PT.glass;
    if (f.type === "side") return f.z > 0.72 ? PT.paint : PT.glass;
    if (f.type === "corner") return PT.paint;
    return f.z > -0.22 && f.z < 0.5 ? PT.paint : PT.glass;
  };
}

// Surface-following patch on a loft body. fn(a, b) -> [z, u], a and b in 0..1.
function patch(kit, s, model, side, nu, nv, fn, off) {
  const g = [];
  for (let i = 0; i <= nv; i++) {
    const row = [];
    for (let j = 0; j <= nu; j++) {
      const [z, u] = fn(j / nu, i / nv), q = model.surf(z, u, side);
      row.push({ p: [q.p[0] + q.n[0] * off, q.p[1] + q.n[1] * off, q.p[2] + q.n[2] * off], n: q.n });
    }
    g.push(row);
  }
  for (let i = 0; i < nv; i++) for (let j = 0; j < nu; j++) {
    const a = g[i][j], b = g[i][j + 1], c = g[i + 1][j + 1], d = g[i + 1][j];
    kit.triN(s, a.p, b.p, c.p, a.n, b.n, c.n);
    kit.triN(s, a.p, c.p, d.p, a.n, c.n, d.n);
  }
}

// Multi-spoke rim face: a disc with windows between twin spokes, extruded and bevelled.
function rimFaceGeometry(rOut, depth) {
  const arc = (path, r, a0, a1, n, first) => {
    for (let i = 0; i <= n; i++) {
      const a = a0 + (a1 - a0) * (i / n), x = r * Math.cos(a), y = r * Math.sin(a);
      if (i === 0 && first) path.moveTo(x, y); else path.lineTo(x, y);
    }
  };
  const shape = new THREE.Shape();
  arc(shape, rOut, 0, Math.PI * 2 * (63 / 64), 63, true);
  shape.closePath();
  // Ten spokes in five twin pairs; windows between them show the disc and caliper.
  const rIn = 0.078, rO = rOut - 0.028, spokes = [];
  for (let k = 0; k < 5; k++) { const c = (k / 5) * Math.PI * 2 + Math.PI / 2; spokes.push(c - 0.16, c + 0.16); }
  const hwIn = 0.016 / rIn, hwOut = 0.012 / rO;
  for (let i = 0; i < spokes.length; i++) {
    const a0 = spokes[i], a1 = i + 1 < spokes.length ? spokes[i + 1] : spokes[0] + Math.PI * 2;
    const span = a1 - a0;
    const hole = new THREE.Path();
    arc(hole, rIn, a0 + hwIn, a1 - hwIn, Math.max(1, Math.round(span * 4)), true);
    arc(hole, rO, a1 - hwOut, a0 + hwOut, Math.max(2, Math.round(span * 9)), false);
    hole.closePath();
    shape.holes.push(hole);
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.007, bevelSize: 0.005, bevelSegments: 2, curveSegments: 4 });
  g.rotateY(Math.PI / 2); // extrusion +Z becomes +X (outboard)
  return g;
}

function tyreGeometry(R, rimR, tw) {
  const w = tw / 2, pts = [
    [rimR - 0.004, w - 0.022], [rimR + 0.02, w - 0.004], [R - 0.05, w + 0.004], [R - 0.022, w - 0.002], [R - 0.006, w - 0.02],
    [R, w - 0.045], [R, w * 0.34 + 0.007], [R - 0.009, w * 0.34], [R, w * 0.34 - 0.007], [R, -w * 0.34 + 0.007], [R - 0.009, -w * 0.34], [R, -w * 0.34 - 0.007],
    [R, -w + 0.045], [R - 0.006, -w + 0.02], [R - 0.022, -w + 0.002], [R - 0.05, -w - 0.004], [rimR + 0.02, -w + 0.004], [rimR - 0.004, -w + 0.022],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const g = new THREE.LatheGeometry(pts, 40);
  g.rotateZ(-Math.PI / 2); // lathe axis Y becomes X
  return g;
}

function caliperGeometry() {
  const s = new THREE.Shape(), a0 = 1.95, a1 = 2.75, r0 = 0.118, r1 = 0.212;
  s.absarc(0, 0, r1, a0, a1, false);
  s.absarc(0, 0, r0, a1, a0, true);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.042, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2, curveSegments: 10 });
  g.rotateY(Math.PI / 2);
  return g;
}

export function makePlayerCar({ color = 0xf97316, style = "coupe", plate = "O 1234", beams: withBeams = true } = {}) {
  if (style === "sedan") return makePlayerSedan({ color, beams: withBeams });
  if (style !== "coupe") console.warn(`vehicles.js: player style "${style}" is not built yet, using "coupe"`);
  const B = COUPE;
  const group = new THREE.Group();
  group.name = "playerCar";
  const body = new THREE.Group();          // pivots about the roll centre, 0.45 m up
  body.name = "playerBody";
  body.position.y = 0.45;
  const shell = new THREE.Group();
  shell.position.y = -0.45;
  body.add(shell);
  group.add(body);

  // --- materials (per car, so setColor never leaks between cars)
  const mats = {
    paint: new THREE.MeshPhysicalMaterial({ color, metalness: 0.6, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.05 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x06090d, metalness: 0, roughness: 0.04, ior: 1.5, specularIntensity: 1, envMapIntensity: 1.3 }),
    trim: makeDetailMaterial({ roughness: 0.6, metalness: 0.15 }),
    head: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xe8f1ff, emissiveIntensity: 1.2, roughness: 0.2 }),
    tail: new THREE.MeshStandardMaterial({ color: 0x3a0306, emissive: 0xff1418, emissiveIntensity: 0.5, roughness: 0.25 }),
    rev: new THREE.MeshStandardMaterial({ color: 0x2a2a2a, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.25 }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9, metalness: 0, side: THREE.DoubleSide }),
    rim: new THREE.MeshStandardMaterial({ color: 0x26282c, roughness: 0.3, metalness: 0.85, side: THREE.DoubleSide }),
    lip: new THREE.MeshStandardMaterial({ color: 0xb9bdc3, roughness: 0.18, metalness: 1 }),
    disc: new THREE.MeshStandardMaterial({ color: 0x55585c, roughness: 0.55, metalness: 0.85 }),
    caliper: new THREE.MeshStandardMaterial({ color: 0xd11820, roughness: 0.35, metalness: 0.15 }),
    plate: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0 }),
  };
  const pkCarReg = PK_REGION();
  let plateTex = pkCarReg ? pkPlateTexture(pkPlateKind()) : plateTexture(plate);
  if (plateTex) mats.plate.map = plateTex;

  // --- body and greenhouse lofts
  const kit = new Kit();
  const bm = bodyModel(B, Q_HI);
  kit.smooth(loft(bm.rows, bm.layout, coupeBodySlot(B), { capStart: true, capEnd: true }), 0.72);
  const hm = houseModel(B.house, bm, Q_HI);
  kit.smooth(loft(hm.rows, hm.layout, coupeHouseSlot(), {}), 0.72);

  // Ring index landmarks for surface patches.
  const uSide0 = Q_HI.floor + Q_HI.nC, uEdge = uSide0 + Q_HI.nS + Q_HI.nSh, uTop = uEdge + Q_HI.nT;
  const zF = B.zN + B.noseR + 0.004;

  for (const side of [-1, 1]) {
    // Headlight: gloss black swept housing with an LED strip along its leading edge.
    const hz = (a, b, z0, len) => [z0 + a * 0.13 + b * len, uEdge - 5 + a * 7.5];
    patch(kit, PT.gloss, bm, side, 10, 2, (a, b) => hz(a, b, zF, 0.2), 0.004);
    patch(kit, { k: "head" }, bm, side, 10, 1, (a, b) => { const [z, u] = hz(a, 0, zF, 0); return [z + 0.022 + b * 0.022, u]; }, 0.007);
    patch(kit, { k: "head" }, bm, side, 6, 1, (a, b) => { const [z, u] = hz(0.35 + a * 0.45, 0, zF, 0); return [z + 0.11 + b * 0.014, u]; }, 0.007);
    // Door shut lines.
    for (const zl of [-0.78, 0.5]) patch(kit, PT.gloss, bm, side, 1, 12, (a, b) => [zl + a * 0.006, uSide0 + 1 + b * (Q_HI.nS + 1.5)], 0.0025);
    // Hood vents, one each side of the centre line.
    patch(kit, PT.intake, bm, side, 2, 3, (a, b) => [-1.92 + b * 0.3, uTop - 3.3 + a * 0.9], 0.003);
    // Engine cover louvres between the haunches.
    for (let k = 0; k < 6; k++) patch(kit, PT.intake, bm, side, 3, 1, (a, b) => [1.42 + k * 0.095 + b * 0.04, uTop - 2.6 + a * 2.6], 0.003);
  }

  // Tail light bar, reverse lamps, exhausts, lip, splitter. The floor ramps up into the diffuser.
  const zT = B.zT;
  kit.box({ k: "tail" }, -0.74, 0.765, zT - 0.01, 0.74, 0.805, zT + 0.009, "nz");
  kit.box(PT.gloss, -0.76, 0.755, zT - 0.01, 0.76, 0.815, zT + 0.005, "nz");
  for (const s of [-1, 1]) kit.box({ k: "rev" }, s > 0 ? 0.44 : -0.58, 0.6, zT - 0.01, s > 0 ? 0.58 : -0.44, 0.625, zT + 0.006, "nz");
  const exh = new THREE.CylinderGeometry(0.05, 0.05, 0.14, 20, 1, true);
  exh.rotateX(Math.PI / 2);
  const exhIn = new THREE.CircleGeometry(0.043, 20);
  for (const s of [-1, 1]) {
    kit.geo(PT.ti, exh, new THREE.Matrix4().makeTranslation(s * 0.14, 0.4, zT - 0.03));
    kit.geo(PT.under, exhIn, new THREE.Matrix4().makeTranslation(s * 0.14, 0.4, zT + 0.02));
  }
  // Ducktail lip along the deck edge.
  const lip = new THREE.Shape();
  lip.moveTo(-0.17, -0.012); lip.lineTo(0.02, 0.026); lip.lineTo(0.035, 0.028); lip.lineTo(0.03, 0.01); lip.lineTo(-0.17, -0.024); lip.closePath();
  const lipG = new THREE.ExtrudeGeometry(lip, { depth: 1.36, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 1 });
  lipG.rotateY(-Math.PI / 2); // shape x -> +z, extrusion along -x
  kit.geo(PT.carbon, lipG, new THREE.Matrix4().makeTranslation(0.68, bm.topY(zT - B.tailR, 0) + 0.004, zT - B.tailR + 0.03));
  // Front splitter following the nose in plan.
  const wF = spline(B.w), spl = new THREE.Shape(), zs = [];
  for (let i = 0; i <= 8; i++) zs.push(B.zN + 0.5 * (i / 8));
  spl.moveTo(-(wF(zs[0]) - 0.16), zs[0] - 0.022);
  for (const z of zs) spl.lineTo(-(wF(z) - 0.07), z);
  for (const z of [...zs].reverse()) spl.lineTo(wF(z) - 0.07, z);
  spl.lineTo(wF(zs[0]) - 0.16, zs[0] - 0.022);
  spl.closePath();
  const splG = new THREE.ExtrudeGeometry(spl, { depth: 0.018, bevelEnabled: false });
  splG.rotateX(Math.PI / 2);
  kit.geo(PT.under, splG, new THREE.Matrix4().makeTranslation(0, 0.122, 0));

  // Mirrors: flat body-colour housing on a black stalk, dark glass facing back.
  const hous = new THREE.SphereGeometry(1, 20, 12);
  const mglass = new THREE.CircleGeometry(1, 18);
  for (const s of [-1, 1]) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -s * 0.1, s * 0.06));
    kit.geo(PT.paint, hous, new THREE.Matrix4().compose(new THREE.Vector3(s * 0.975, 0.925, -0.6), q, new THREE.Vector3(0.088, 0.04, 0.058)));
    kit.geo(PT.gloss, mglass, new THREE.Matrix4().compose(new THREE.Vector3(s * 0.975, 0.925, -0.5435), q, new THREE.Vector3(0.078, 0.032, 1)));
    kit.box(PT.gloss, s > 0 ? 0.82 : -0.92, 0.88, -0.62, s > 0 ? 0.92 : -0.82, 0.9, -0.58);
  }

  // --- meshes from buckets
  const meshes = [];
  const addMesh = (key, mat, withColor = false) => {
    const b = kit.buckets.get(key);
    if (!b || !b.tris) return null;
    const g = mergeVertices(b.geometry(withColor), 1e-5);
    const m = new THREE.Mesh(g, mat);
    m.name = "car_" + key;
    m.castShadow = true; m.receiveShadow = true;
    shell.add(m); meshes.push(m);
    return m;
  };
  addMesh("paint", mats.paint);
  addMesh("glass", mats.glass);
  addMesh("trim", mats.trim, true);
  addMesh("head", mats.head);
  addMesh("tail", mats.tail);
  addMesh("rev", mats.rev);

  // Plates: front on the nose, rear in the black band.
  const plW = pkCarReg ? 0.3 : 0.52, plH = pkCarReg ? 0.15 : 0.114;   // Pakistan: the standard 300 x 150 mm plate
  const pg1 = new THREE.PlaneGeometry(plW, plH); pg1.rotateY(Math.PI); pg1.translate(0, 0.262, B.zN - 0.012);
  const pg2 = new THREE.PlaneGeometry(plW, plH); pg2.translate(0, 0.545, zT + 0.012);
  const plateMesh = new THREE.Mesh(mergeGeometriesSimple([pg1, pg2]), mats.plate);
  plateMesh.name = "car_plates";
  shell.add(plateMesh); meshes.push(plateMesh);

  // --- wheels (not children of body)
  const wheels = [];
  const rimR = 0.245;
  const shared = {
    tyreF: tyreGeometry(B.R, 0.238, 0.255), tyreR: tyreGeometry(B.R, 0.238, 0.295),
    caliper: caliperGeometry(),
  };
  const wheelDefs = [
    { x: -0.795, z: B.axles[0].z, front: true, tw: 0.255 }, { x: 0.795, z: B.axles[0].z, front: true, tw: 0.255 },
    { x: -0.8, z: B.axles[1].z, front: false, tw: 0.295 }, { x: 0.8, z: B.axles[1].z, front: false, tw: 0.295 },
  ];
  for (const wd of wheelDefs) {
    const s = Math.sign(wd.x), fx = wd.tw / 2 - 0.065;
    const pivot = new THREE.Group(); pivot.position.set(wd.x, B.R, wd.z); pivot.name = wd.front ? "wheelPivotFront" : "wheelPivotRear";
    const spin = new THREE.Group(); pivot.add(spin);
    const mir = new THREE.Group(); mir.scale.x = s; spin.add(mir);
    const tyre = new THREE.Mesh(wd.front ? shared.tyreF : shared.tyreR, mats.tyre);
    // rim: spoke face + barrel + centre cap merged
    const face = rimFaceGeometry(rimR, 0.022); face.translate(fx, 0, 0);
    const barrel = new THREE.CylinderGeometry(0.238, 0.238, wd.tw - 0.03 + (fx - wd.tw / 2 + 0.02), 40, 1, true);
    barrel.rotateZ(Math.PI / 2); barrel.translate((-wd.tw / 2 + 0.015 + fx + 0.02) / 2, 0, 0);
    const cap = new THREE.CylinderGeometry(0.046, 0.05, 0.02, 24); cap.rotateZ(-Math.PI / 2); cap.translate(fx + 0.03, 0, 0);
    const rim = new THREE.Mesh(mergeGeometriesSimple([face, barrel, cap]), mats.rim);
    const lipRing = new THREE.TorusGeometry(0.237, 0.0075, 8, 48); lipRing.rotateY(Math.PI / 2); lipRing.translate(fx + 0.027, 0, 0);
    const lipM = new THREE.Mesh(lipRing, mats.lip);
    const discG = new THREE.CylinderGeometry(0.196, 0.196, 0.028, 36); discG.rotateZ(Math.PI / 2); discG.translate(fx - 0.05, 0, 0);
    const disc = new THREE.Mesh(discG, mats.disc);
    mir.add(tyre, rim, lipM, disc);
    const cmir = new THREE.Group(); cmir.scale.x = s; pivot.add(cmir);
    const cal = new THREE.Mesh(shared.caliper, mats.caliper); cal.position.x = fx - 0.075;
    cmir.add(cal);
    for (const m of [tyre, rim, lipM, disc, cal]) { m.castShadow = true; m.receiveShadow = true; meshes.push(m); }
    group.add(pivot);
    wheels.push({ pivot, spin, front: wd.front });
  }

  // --- headlight beams (always present so toggling never recompiles shaders)
  const beams = [];
  if (withBeams) for (const s of [-1, 1]) {
    const L = new THREE.SpotLight(0xfff4e0, 0, 80, 0.4, 0.6, 1.6);
    L.position.set(s * 0.66, 0.56, B.zN + 0.25);
    L.target.position.set(s * 1.2, 0, B.zN - 22);
    L.castShadow = false;
    shell.add(L, L.target);
    beams.push(L);
  }

  // --- state
  const st = { brake: false, head: false, rev: false, prevSpeed: 0, acc: 0, roll: 0, pitch: 0 };
  const LIGHT = { drl: 1.4, drlNight: 6, tail: 0.5, tailNight: 2.2, brake: 9, rev: 5, beam: 30 };
  const applyLights = () => {
    mats.head.emissiveIntensity = st.head ? LIGHT.drlNight : LIGHT.drl;
    mats.tail.emissiveIntensity = st.brake ? LIGHT.brake : st.head ? LIGHT.tailNight : LIGHT.tail;
    mats.rev.emissiveIntensity = st.rev ? LIGHT.rev : 0;
    for (const L of beams) L.intensity = st.head ? LIGHT.beam : 0;
  };
  applyLights();

  const MAX_STEER = 32 * Math.PI / 180, WB = B.wheelbase, R = B.R;
  // Measured extents: body width from the loft, overall box from every mesh (plates, lip, mirrors).
  group.updateMatrixWorld(true);
  const ext = new THREE.Box3();
  for (const m of meshes) ext.expandByObject(m, true);
  let halfW = 0;
  for (const r of bm.rows) for (const q of r.pts) halfW = Math.max(halfW, q[0]);
  const car = {
    group, body, wheels, beams, materials: mats, lean: true,
    dims: {
      length: +(B.zT - B.zN).toFixed(3), width: +(2 * halfW).toFixed(3), height: +ext.max.y.toFixed(3), wheelbase: WB, wheelRadius: R,
      zFront: +ext.min.z.toFixed(3), zRear: +ext.max.z.toFixed(3), widthWithMirrors: +(ext.max.x - ext.min.x).toFixed(3),
      trackFront: 2 * Math.abs(wheelDefs[1].x), trackRear: 2 * Math.abs(wheelDefs[3].x),
    },
    setBrake(on) { st.brake = !!on; applyLights(); },
    setHeadlights(on) { st.head = !!on; applyLights(); },
    setReverse(on) { st.rev = !!on; applyLights(); },
    setColor(hex) { mats.paint.color.setHex(hex); },
    setPlate(kind) { if (!pkCarReg) return; const t = pkPlateTexture(kind === "punjab" ? "punjab" : "ict"); if (plateTex) plateTex.dispose(); plateTex = t; mats.plate.map = t; mats.plate.needsUpdate = true; },
    // steer: -1 full left .. +1 full right (same sign as the game's A/D input).
    update(dt, speedMps = 0, steer = 0) {
      dt = Math.min(Math.max(dt || 0, 0), 0.1);
      const ang = -clamp(steer, -1, 1) * MAX_STEER;
      for (const w of wheels) {
        if (w.front) w.pivot.rotation.y = ang;
        w.spin.rotation.x = (w.spin.rotation.x - (speedMps / R) * dt) % (Math.PI * 2);
      }
      if (dt <= 0) return;
      const acc = (speedMps - st.prevSpeed) / dt;
      st.prevSpeed = speedMps;
      st.acc += (clamp(acc, -14, 10) - st.acc) * Math.min(1, dt * 5);
      if (!car.lean) return;
      const lat = speedMps * speedMps * Math.tan(-ang) / WB;              // + when turning right
      const rollT = clamp(lat * 0.0045, -0.045, 0.045);                   // lean out of the turn
      const pitchT = clamp(st.acc * 0.0032 - (st.brake && Math.abs(speedMps) > 0.5 ? 0.008 : 0), -0.035, 0.025);
      const k = Math.min(1, dt * 6);
      st.roll += (rollT - st.roll) * k; st.pitch += (pitchT - st.pitch) * k;
      body.rotation.set(st.pitch, 0, st.roll);
    },
    dispose() {
      group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      for (const m of Object.values(mats)) m.dispose();
      for (const g of Object.values(shared)) g.dispose();
      if (plateTex) plateTex.dispose();
      for (const L of beams) L.dispose();
      group.removeFromParent();
    },
    triangles: meshes.reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0),
    drawCalls: meshes.length,
  };
  return car;
}

// Minimal merge for same-material helper parts (position, normal, uv), no groups.
function mergeGeometriesSimple(list) {
  const parts = list.map(g => (g.index ? g.toNonIndexed() : g));
  let n = 0;
  for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of parts) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array.subarray(0, c * 3), o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array.subarray(0, c * 3), o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array.subarray(0, c * 2), o * 2);
    o += c;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  for (const g of list) g.dispose();
  for (const g of parts) g.dispose();
  return out;
}

// ---------------------------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------------------------

const Q_LO = { floor: 2, nC: 0, nS: 3, nSh: 1, nT: 2, dz: 1.1, round: 1, hS: 0, hC: 0, hT: 0, archDz: [-0.95, -0.55, 0, 0.55, 0.95] };

const C = {
  glass: 0x1a2634, black: 0x0d0e10, dark: 0x1e1f22, under: 0x121314, tyre: 0x161616, rim: 0xb4b8bd,
  chrome: 0xc7ccd3, plate: 0xefefea, head: 0xfff1d6, tail: 0xa50d10, amber: 0xffa31a, grille: 0x16171a,
};
const sP = { k: "paint" };
const _sd = new Map(), _sl = new Map();
const sD = hex => { let s = _sd.get(hex); if (!s) { s = { k: "detail", c: hex }; _sd.set(hex, s); } return s; };
const sL = hex => { let s = _sl.get(hex); if (!s) { s = { k: "lights", c: hex }; _sl.set(hex, s); } return s; };

// Simple traffic wheel: tread, sidewall and a dished rim with alternating wedges (reads as spokes).
function wheelLo(kit, x, z, R, w, side, rim = C.rim, n = 12, rimK = 0.63) {
  const y = R, xo = x + side * w / 2, xi = x - side * w / 2, rr = R * rimK;
  const T = sD(C.tyre), hub = [xo - side * 0.035, y, z];
  const P = (xx, r, a) => [xx, y + r * Math.cos(a), z + r * Math.sin(a)];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2 + Math.PI / n, a1 = ((i + 1) / n) * Math.PI * 2 + Math.PI / n;
    const n0 = [0, Math.cos(a0), Math.sin(a0)], n1 = [0, Math.cos(a1), Math.sin(a1)];
    kit.triN(T, P(xi, R, a0), P(xo, R, a0), P(xo, R, a1), n0, n0, n1);
    kit.triN(T, P(xi, R, a0), P(xo, R, a1), P(xi, R, a1), n0, n1, n1);
    kit.quad(T, P(xo, R, a0), P(xo, rr, a0), P(xo, rr, a1), P(xo, R, a1), [side, 0, 0]);
    kit.tri(sD(rim), hub, P(xo, rr, a0), P(xo, rr, a1), [side, 0, 0]);
  }
}

// Decals: flat quads a little proud of the front (-Z) or rear (+Z) face.
function decals(kit, list, zN, zT) {
  for (const d of list) {
    const front = d.face === "front";
    const z = d.z != null ? d.z : front ? zN - (d.off ?? 0.012) : zT + (d.off ?? 0.012);
    const ref = [0, 0, front ? -1 : 1];
    const spans = d.sym ? [[d.x0, d.x1], [-d.x1, -d.x0]] : [[d.x0, d.x1]];
    for (const [x0, x1] of spans) {
      if (d.lamp) { // light strip over a dark lens, side by side in one plane
        const ym = d.y1 - (d.y1 - d.y0) * d.lamp;
        kit.quad(d.s, [x0, ym, z], [x1, ym, z], [x1, d.y1, z], [x0, d.y1, z], ref);
        kit.quad(sD(0x2b3440), [x0, d.y0, z], [x1, d.y0, z], [x1, ym, z], [x0, ym, z], ref);
        continue;
      }
      kit.quad(d.s, [x0, d.y0, z], [x1, d.y0, z], [x1, d.y1, z], [x0, d.y1, z], ref);
    }
  }
}

// Generic car-like type: lower body loft + greenhouse loft + wheels + decals + extras.
function buildType(T) {
  const kit = new Kit();
  const Q = T.q ? { ...Q_LO, ...T.q } : Q_LO;
  const bm = bodyModel(T.body, Q);
  kit.smooth(loft(bm.rows, bm.layout, T.bodySlot, { capStart: true, capEnd: true }), T.crease ?? 0.8);
  if (T.house) {
    const hm = houseModel(T.house, bm, Q);
    kit.smooth(loft(hm.rows, hm.layout, T.houseSlot, { capStart: !!T.house.capStart, capEnd: !!T.house.capEnd }), T.crease ?? 0.8);
  }
  for (const w of T.wheels) for (const s of [-1, 1]) wheelLo(kit, s * w.x, w.z, w.R, w.w, s, w.rim ?? T.rim ?? C.rim);
  decals(kit, T.decals || [], T.body.zN, T.body.zT);
  if (T.extras) T.extras(kit, bm);
  return finishType(T, kit);
}

function finishType(T, kit) {
  const geo = (k, withColor) => {
    const b = kit.buckets.get(k) || new Bucket();
    return b.tris ? mergeVertices(b.geometry(withColor), 1e-5) : b.geometry(withColor);
  };
  const paint = geo("paint", false), detail = geo("detail", true), lights = geo("lights", true), tank = kit.buckets.has("tank") ? geo("tank", false) : null;
  const box = new THREE.Box3();
  for (const g of [paint, detail, lights]) { g.computeBoundingBox(); g.computeBoundingSphere(); if (g.boundingBox && isFinite(g.boundingBox.min.x)) box.union(g.boundingBox); }
  const count = g => (g.index ? g.index.count : g.attributes.position.count) / 3;
  const tris = { paint: count(paint), detail: count(detail), lights: count(lights) };
  tris.total = tris.paint + tris.detail + tris.lights + (T.art ? count(T.art) : 0);
  if (tris.total > 1500) console.warn(`vehicles.js: traffic type ${T.name} has ${tris.total} triangles`);
  return {
    name: T.name, weight: T.weight,
    length: +(box.max.z - box.min.z).toFixed(3), width: +(T.width ?? (box.max.x - box.min.x)).toFixed(3), height: +box.max.y.toFixed(3),
    zFront: +box.min.z.toFixed(3), zRear: +box.max.z.toFixed(3), wheelbase: T.wheelbase, wheelRadius: T.wheels[0].R,
    paint, detail, lights, tank, art: T.art || null, paints: T.paints, tris,
  };
}

// Common body slot: dark underbody and arch walls, optional cladding and livery.
function bodySlot({ body = sP, clad = null, flare = false, fn = null } = {}) {
  return f => {
    if (fn) { const r = fn(f); if (r !== undefined) return r; }
    if (f.type === "floor" || f.type === "well" || f.step) return sD(C.under);
    if (f.type === "corner") return clad ? sD(clad) : f.r0.arch && f.r1.arch ? sD(C.under) : body;
    if (flare && f.r0.arch && f.r1.arch && f.type === "side" && f.j === 2) return sD(clad || C.dark);
    return body;
  };
}

// Greenhouse slot from z stations: windshield ends at zW, roof ends at zR, pillars are [z0, z1] ranges.
function houseSlot({ zW, zR, pillars = [], pillar = sP, roof = sP, glass = sD(C.glass), sideSolid = null, capS = null, capE = null, aPillar = sP } = {}) {
  return f => {
    if (f.type === "hidden") return null;
    if (f.part === "capS") return capS ? capS(f) : glass;
    if (f.part === "capE") return capE ? capE(f) : glass;
    const inPillar = pillars.some(([a, b]) => f.z > a && f.z < b);
    if (f.type === "side") {
      if (sideSolid && sideSolid(f.z)) return pillar === sP ? roof : pillar;
      return inPillar ? pillar : glass;
    }
    if (f.type === "corner") return f.z < zW ? aPillar : roof;
    return f.z < zW || f.z > zR ? glass : roof;
  };
}

function sedanLike({ name, weight, paints, taxi = false, police = false }) {
  const zN = -2.3825, zT = 2.5025, CREAM = 0xd2b784, GREEN = 0x0a5c34;
  const body = {
    zN, zT, noseR: 0.08, tailR: 0.07,
    axles: [{ z: -1.4125, y: 0.33, ra: 0.37 }, { z: 1.4125, y: 0.33, ra: 0.37 }],
    w: [[zN, 0.8], [-2.2, 0.875], [-1.9, 0.91], [-1.4, 0.92], [1.4, 0.92], [2.2, 0.905], [zT, 0.86]],
    yB: [[zN, 0.24], [-2.1, 0.18], [2.1, 0.18], [zT, 0.3]],
    ymax: 0.62, ku: 0.5, kt: 0.45, rb: 0.06, rs: 0.1, pw: 2.2,
    ysh: [[zN, 0.69], [-2.15, 0.79], [-1.6, 0.85], [-0.85, 0.9], [0.2, 0.95], [1.3, 0.99], [2.2, 1.02], [zT, 1.0]],
    yt: [[zN, 0.69], [-2.15, 0.8], [-1.6, 0.865], [-0.85, 0.915], [0, 0.93], [1.25, 0.97], [1.55, 1.03], [2.2, 1.05], [zT, 1.02]],
    features: [-2.05, -0.85, 0.0, 0.75, 2.1],
  };
  const house = {
    rows: [-0.86, -0.55, -0.3, -0.06, 0.42, 0.52, 1.0, 1.3, 1.62],
    roof: [[-0.9, 0.84], [-0.6, 1.06], [-0.3, 1.27], [-0.06, 1.405], [0.4, 1.445], [0.8, 1.44], [1.0, 1.405], [1.3, 1.25], [1.62, 1.03], [1.7, 0.98]],
    gb: 0.76, gt: 0.63, rr: 0.08, crown: 0.03,
  };
  const bodyPaint = taxi ? sD(CREAM) : sP;
  const T = {
    name, weight, paints, body, house, wheelbase: 2.825, width: 1.84,
    wheels: [{ x: 0.79, z: -1.4125, R: 0.33, w: 0.225 }, { x: 0.79, z: 1.4125, R: 0.33, w: 0.225 }],
    bodySlot: bodySlot({
      body: bodyPaint,
      fn: police ? f => (f.part === "side" && (f.type === "side") && f.z > -0.98 && f.z < 1.0 && f.y < 0.78 ? sD(GREEN) : undefined) : null,
    }),
    houseSlot: houseSlot({ zW: -0.06, zR: 1.0, pillars: [[0.42, 0.52]], pillar: sD(C.black), roof: sP, aPillar: taxi ? sD(CREAM) : sP }),
    decals: [
      { face: "front", sym: true, x0: 0.44, x1: 0.75, y0: 0.54, y1: 0.63, s: sL(C.head), lamp: 0.4 },
      { face: "front", x0: -0.36, x1: 0.36, y0: 0.56, y1: 0.62, s: sD(C.grille) },
      { face: "front", x0: -0.56, x1: 0.56, y0: 0.31, y1: 0.44, s: sD(C.grille) },
      { face: "front", x0: -0.26, x1: 0.26, y0: 0.455, y1: 0.54, s: sD(C.plate) },
      { face: "rear", sym: true, x0: 0.4, x1: 0.76, y0: 0.84, y1: 0.93, s: sL(C.tail) },
      { face: "rear", x0: -0.26, x1: 0.26, y0: 0.6, y1: 0.7, s: sD(C.plate) },
      { face: "rear", x0: -0.7, x1: 0.7, y0: 0.37, y1: 0.43, s: sD(C.dark) },
    ],
    extras: (kit, bm) => {
      for (const s of [-1, 1]) kit.box(taxi ? sD(CREAM) : sP, s > 0 ? 0.86 : -1.0, 0.94, -0.66, s > 0 ? 1.0 : -0.86, 1.02, -0.56, s > 0 ? "nx" : "px");
      if (taxi) {
        kit.box(sL(0xffe7a0), -0.3, 1.43, 0.18, 0.3, 1.6, 0.46, "ny");
        kit.box(sD(C.dark), -0.33, 1.42, 0.15, 0.33, 1.45, 0.49, "ny");
      }
      if (police) {
        kit.box(sL(0xff2a2a), -0.55, 1.44, 0.2, -0.02, 1.53, 0.42, "ny");
        kit.box(sL(0x2a5cff), 0.02, 1.44, 0.2, 0.55, 1.53, 0.42, "ny");
        kit.box(sD(C.dark), -0.02, 1.44, 0.2, 0.02, 1.53, 0.42, "ny");
      }
    },
  };
  if (taxi) {
    // Body is the fixed cream in detail; the roof panel is the only painted part (operator colour).
    T.houseSlot = houseSlot({ zW: -0.06, zR: 1.0, pillars: [[0.42, 0.52]], pillar: sD(C.black), roof: sP, aPillar: sD(CREAM) });
    const hs = T.houseSlot;
    T.houseSlot = f => { const r = hs(f); if (r === sP && f.type === "corner") return sD(CREAM); return r; };
  }
  return T;
}

function suvType() {
  const zN = -2.355, zT = 2.63;
  return {
    name: "suv", weight: 0.22, wheelbase: 2.85, width: 1.98,
    paints: [0xf7f7f5, 0xf7f7f5, 0xf2f1ec, 0xf7f7f5, 0xe6e4dc, 0xbfc3c7, 0x1b1c1e, 0x2b2d30, 0x5b6065, 0xbdae8e],
    body: {
      zN, zT, noseR: 0.08, tailR: 0.05,
      axles: [{ z: -1.425, y: 0.39, ra: 0.44 }, { z: 1.425, y: 0.39, ra: 0.44 }],
      w: [[zN, 0.9], [-2.2, 0.965], [-1.8, 0.985], [2.4, 0.99], [zT, 0.97]],
      yB: [[zN, 0.44], [-2.1, 0.33], [2.3, 0.33], [zT, 0.46]],
      ymax: 0.85, ku: 0.25, kt: 0.2, rb: 0.06, rs: 0.06, pw: 3,
      ysh: [[zN, 1.02], [-2.15, 1.1], [-1.4, 1.14], [-0.75, 1.16], [0.5, 1.18], [zT, 1.2]],
      yt: [[zN, 1.01], [-2.15, 1.1], [-0.75, 1.15], [0.5, 1.17], [zT, 1.19]],
      features: [-2.1, -0.75, 0.3, 2.3],
    },
    house: {
      rows: [-0.76, -0.45, -0.12, 0.04, 0.55, 0.66, 1.52, 1.63, 2.2, 2.55], capEnd: true,
      roof: [[-0.8, 1.1], [-0.5, 1.43], [-0.15, 1.8], [0.1, 1.87], [1.2, 1.885], [2.4, 1.875], [2.55, 1.86]],
      gb: 0.9, gt: 0.8, rr: 0.07, crown: 0.02,
    },
    wheels: [{ x: 0.83, z: -1.425, R: 0.39, w: 0.26 }, { x: 0.83, z: 1.425, R: 0.39, w: 0.26 }],
    bodySlot: bodySlot({ clad: C.dark, flare: true }),
    houseSlot: houseSlot({ zW: 0.04, zR: 2.55, pillars: [[0.55, 0.66], [1.52, 1.63]], pillar: sD(C.black), sideSolid: z => z > 2.2,
      capE: f => (f.type === "side" ? sD(C.glass) : sP) }),
    decals: [
      { face: "front", x0: -0.52, x1: 0.52, y0: 0.74, y1: 0.99, s: sD(0x2a2c30) },
      { face: "front", x0: -0.52, x1: 0.52, y0: 0.99, y1: 1.015, s: sD(C.chrome) },
      { face: "front", sym: true, x0: 0.55, x1: 0.86, y0: 0.85, y1: 0.97, s: sL(C.head), lamp: 0.35 },
      { face: "front", x0: -0.6, x1: 0.6, y0: 0.5, y1: 0.61, s: sD(C.grille) },
      { face: "front", x0: -0.26, x1: 0.26, y0: 0.63, y1: 0.72, s: sD(C.plate) },
      { face: "rear", sym: true, x0: 0.7, x1: 0.88, y0: 0.86, y1: 1.12, s: sL(C.tail) },
      { face: "rear", x0: -0.26, x1: 0.26, y0: 0.72, y1: 0.82, s: sD(C.plate) },
      { face: "rear", x0: -0.8, x1: 0.8, y0: 0.48, y1: 0.58, s: sD(C.dark) },
    ],
    extras: kit => {
      for (const s of [-1, 1]) {
        kit.box(sD(0x2e3034), s * 0.62 - 0.03, 1.87, -0.1, s * 0.62 + 0.03, 1.935, 2.3, "ny");
        kit.box(sP, s > 0 ? 0.95 : -1.1, 1.13, -0.62, s > 0 ? 1.1 : -0.95, 1.25, -0.5, s > 0 ? "nx" : "px");
      }
    },
  };
}

function pickupType() {
  const zN = -2.4425, zT = 2.8875, cabEnd = 1.08;
  return {
    name: "pickup", weight: 0.1, wheelbase: 3.085, width: 1.855,
    paints: [0xf7f7f5, 0xf7f7f5, 0xf7f7f5, 0xf2f1ec, 0xc3c7cb, 0xc3c7cb, 0x8a8e92, 0x2a2b2d, 0xc9b48b],
    body: {
      zN, zT, noseR: 0.07, tailR: 0,
      axles: [{ z: -1.5425, y: 0.38, ra: 0.43 }, { z: 1.5425, y: 0.38, ra: 0.43 }],
      w: [[zN, 0.84], [-2.25, 0.9], [-1.9, 0.925], [zT, 0.927]],
      yB: [[zN, 0.44], [-2.2, 0.37], [2.6, 0.37], [zT, 0.5]],
      ymax: 0.8, ku: 0.3, kt: 0.25, rb: 0.06, rs: 0.05, pw: 3,
      ysh: [[zN, 0.98], [-2.25, 1.08], [-1.6, 1.12], [-0.95, 1.16], [0.8, 1.22], [cabEnd, 1.24], [zT, 1.26]],
      yt: [[zN, 0.97], [-2.25, 1.08], [-0.95, 1.15], [1.0, 1.2], [cabEnd + 0.04, 1.245], [zT, 1.255]],
      features: [-2.2, -0.95, 0.2, cabEnd, cabEnd + 0.05, 2.6],
    },
    house: {
      rows: [-0.96, -0.65, -0.3, -0.12, 0.35, 0.44, 0.96, 1.05], capEnd: true,
      roof: [[-1.0, 1.1], [-0.7, 1.45], [-0.35, 1.76], [-0.1, 1.805], [0.9, 1.815], [1.05, 1.8]],
      gb: 0.83, gt: 0.745, rr: 0.06, crown: 0.02,
    },
    wheels: [{ x: 0.78, z: -1.5425, R: 0.38, w: 0.255 }, { x: 0.78, z: 1.5425, R: 0.38, w: 0.255 }],
    bodySlot: bodySlot({ clad: C.dark, fn: f => (f.type === "top" && f.z > cabEnd + 0.06 && f.part === "side" ? sD(0x26272a) : undefined) }),
    houseSlot: houseSlot({ zW: -0.12, zR: 1.2, pillars: [[0.35, 0.44]], pillar: sD(C.black), sideSolid: z => z > 0.96, capE: () => sP }),
    decals: [
      { face: "front", x0: -0.45, x1: 0.45, y0: 0.72, y1: 0.96, s: sD(0x1f2124) },
      { face: "front", sym: true, x0: 0.49, x1: 0.8, y0: 0.85, y1: 0.97, s: sL(C.head), lamp: 0.35 },
      { face: "front", x0: -0.5, x1: 0.5, y0: 0.5, y1: 0.6, s: sD(C.grille) },
      { face: "front", x0: -0.26, x1: 0.26, y0: 0.62, y1: 0.705, s: sD(C.plate) },
      { face: "rear", sym: true, x0: 0.76, x1: 0.88, y0: 0.82, y1: 1.15, s: sL(C.tail) },
      { face: "rear", x0: -0.26, x1: 0.26, y0: 0.62, y1: 0.72, s: sD(C.plate) },
    ],
    extras: kit => {
      kit.box(sD(0x3a3c40), -0.86, 0.43, zT - 0.02, 0.86, 0.56, zT + 0.12, "ny");
      kit.quad(sD(C.glass), [-0.5, 1.4, 1.062], [0.5, 1.4, 1.062], [0.5, 1.68, 1.062], [-0.5, 1.68, 1.062], [0, 0, 1]);
      kit.quad(sD(0x26272a), [-0.8, 1.25, zT - 0.03], [0.8, 1.25, zT - 0.03], [0.8, 0.9, zT - 0.03], [-0.8, 0.9, zT - 0.03], [0, 0, -1]);
      for (const s of [-1, 1]) kit.box(sP, s > 0 ? 0.88 : -1.04, 1.2, -0.84, s > 0 ? 1.04 : -0.88, 1.31, -0.73, s > 0 ? "nx" : "px");
    },
  };
}

function vanType() {
  const zN = -2.535, zT = 2.765;
  return {
    name: "van", weight: 0.08, wheelbase: 3.21, width: 1.95,
    paints: [0xf7f7f5, 0xf7f7f5, 0xf7f7f5, 0xf7f7f5, 0xf2f1ec, 0xc3c7cb, 0x9aa0a5],
    body: {
      zN, zT, noseR: 0.07, tailR: 0.03,
      axles: [{ z: -1.605, y: 0.35, ra: 0.4 }, { z: 1.605, y: 0.35, ra: 0.4 }],
      w: [[zN, 0.86], [-2.35, 0.94], [-2.1, 0.965], [zT, 0.975]],
      yB: [[zN, 0.4], [-2.3, 0.3], [2.5, 0.3], [zT, 0.4]],
      ymax: 0.8, ku: 0.2, kt: 0.1, rb: 0.05, rs: 0.04, pw: 3,
      ysh: [[zN, 0.86], [-2.3, 1.0], [-2.05, 1.06], [zT, 1.1]],
      yt: [[zN, 0.85], [-2.3, 1.0], [-2.05, 1.05], [zT, 1.08]],
      features: [-2.3, -0.9, 0.2, 2.5],
    },
    house: {
      rows: [-2.06, -1.76, -1.46, -1.26, -0.95, -0.85, 0.4, 2.74], capEnd: true,
      roof: [[-2.1, 1.02], [-1.8, 1.42], [-1.45, 1.82], [-1.2, 1.97], [-0.9, 2.0], [2.74, 2.0]],
      gb: 0.95, gt: 0.885, rr: 0.08, crown: 0.02, inset: 0.004,
    },
    wheels: [{ x: 0.83, z: -1.605, R: 0.35, w: 0.215 }, { x: 0.83, z: 1.605, R: 0.35, w: 0.215 }],
    bodySlot: bodySlot({ clad: C.dark }),
    houseSlot: houseSlot({ zW: -1.26, zR: -1.26, pillar: sP, sideSolid: z => z > -0.95, aPillar: sD(C.black), capE: () => sP }),
    decals: [
      { face: "front", x0: -0.45, x1: 0.45, y0: 0.86, y1: 0.99, s: sD(0x24262a) },
      { face: "front", sym: true, x0: 0.5, x1: 0.84, y0: 0.87, y1: 1.0, s: sL(C.head), lamp: 0.35 },
      { face: "front", x0: -0.56, x1: 0.56, y0: 0.46, y1: 0.62, s: sD(C.grille) },
      { face: "front", x0: -0.26, x1: 0.26, y0: 0.66, y1: 0.75, s: sD(C.plate) },
      { face: "rear", sym: true, x0: 0.8, x1: 0.93, y0: 0.78, y1: 1.3, s: sL(C.tail) },
      { face: "rear", x0: -0.26, x1: 0.26, y0: 0.56, y1: 0.66, s: sD(C.plate) },
      { face: "rear", x0: -0.9, x1: 0.9, y0: 0.32, y1: 0.46, s: sD(C.dark) },
      { face: "rear", sym: true, x0: 0.07, x1: 0.8, y0: 1.42, y1: 1.86, s: sD(C.glass), z: 2.74 + 0.012 },
      { face: "rear", x0: -0.012, x1: 0.012, y0: 0.47, y1: 1.94, s: sD(C.black) },
    ],
    extras: kit => {
      for (const s of [-1, 1]) kit.box(sP, s > 0 ? 0.96 : -1.12, 1.3, -1.9, s > 0 ? 1.12 : -0.96, 1.46, -1.78, s > 0 ? "nx" : "px");
    },
  };
}

function busType() {
  const zN = -5.6, zT = 6.4, W = 1.27;
  const doors = [[-5.3, -4.25], [-0.6, 0.6]];
  const inDoor = z => doors.some(([a, b]) => z > a && z < b);
  return {
    name: "bus", weight: 0.04, wheelbase: 5.9, width: 2.55,
    paints: [0xf7f7f5],
    crease: 0.9,
    body: {
      zN, zT, noseR: 0.14, tailR: 0.1,
      axles: [{ z: -2.95, y: 0.5, ra: 0.56 }, { z: 2.95, y: 0.5, ra: 0.56 }],
      w: [[zN, W - 0.06], [-5.4, W], [6.2, W], [zT, W - 0.03]],
      yB: 0.32, ymax: 0.75, ku: 0.1, kt: 0.05, rb: 0.05, rs: 0.04, pw: 3,
      ysh: 1.15, yt: 1.14,
      features: [...doors.flat(), 5.2],
    },
    house: {
      rows: [-5.46, -4.3, 5.55, 6.3], capStart: true, capEnd: true, roundStart: 0.14, roundEnd: 0.1,
      roof: 2.98, gb: 1.235, gt: 1.19, rr: 0.2, crown: 0.02, inset: 0.004,
    },
    wheels: [{ x: 1.07, z: -2.95, R: 0.5, w: 0.3 }, { x: 0.97, z: 2.95, R: 0.5, w: 0.52 }],
    bodySlot: bodySlot({
      clad: 0x2a2c30,
      fn: f => {
        if (f.part === "side" && f.type === "top") return null; // hidden under the house
        if (f.part === "side" && (f.type === "side" || f.type === "shoulder") && inDoor(f.z) && Math.abs(f.n[0]) > 0.5) return sD(C.glass);
        return undefined;
      },
    }),
    houseSlot: f => {
      if (f.type === "hidden") return null;
      if (f.part === "capS") return f.type === "side" ? sD(C.glass) : sP;
      if (f.part === "capE") return f.type === "side" ? (f.y > 1.9 ? sD(C.glass) : sP) : sP;
      if (f.type === "side") return f.z < 5.55 ? sD(C.glass) : sP;
      return sP;
    },
    decals: [
      { face: "front", sym: true, x0: 0.78, x1: 1.12, y0: 0.46, y1: 0.62, s: sL(C.head), lamp: 0.4 },
      { face: "front", x0: -0.26, x1: 0.26, y0: 0.48, y1: 0.58, s: sD(C.plate) },
      { face: "front", x0: -0.6, x1: 0.6, y0: 0.66, y1: 0.8, s: sD(C.grille) },
      { face: "rear", sym: true, x0: 0.98, x1: 1.16, y0: 0.5, y1: 1.02, s: sL(C.tail) },
      { face: "rear", x0: -0.85, x1: 0.85, y0: 0.5, y1: 1.02, s: sD(C.grille) },
      { face: "rear", x0: -0.26, x1: 0.26, y0: 1.06, y1: 1.12, s: sD(C.plate) },
    ],
    extras: kit => {
      const zH = -5.46 - 0.14 - 0.012; // house front face
      kit.quad(sL(C.amber), [-0.9, 2.6, zH], [0.9, 2.6, zH], [0.9, 2.84, zH], [-0.9, 2.84, zH], [0, 0, -1]);
      kit.box(sP, -0.95, 2.97, -3.6, 0.95, 3.22, -1.2, "ny");
      kit.box(sP, -1.1, 2.97, 4.2, 1.1, 3.15, 6.0, "ny");
      for (const s of [-1, 1]) {
        kit.box(sD(C.dark), s * 1.38 - 0.06, 2.1, -5.95, s * 1.38 + 0.06, 2.5, -5.85);
        kit.box(sD(C.dark), s > 0 ? 1.2 : -1.38, 2.62, -5.8, s > 0 ? 1.38 : -1.2, 2.66, -5.5, "");
      }
    },
  };
}

function truckType() {
  const zN = -3.95, zT = 5.05, cabBack = -1.78;
  const tankRows = (() => {
    // Elliptical water tank on the chassis, white with a blue band.
    const cy = 2.06, a = 1.2, b = 0.93, n = 7, z0 = -1.55, z1 = 4.95, r = 0.22;
    const ring = s => { const pts = []; for (let i = 0; i < n; i++) { const t = -Math.PI / 2 + (i / (n - 1)) * Math.PI; pts.push([Math.max(0, a * s * Math.cos(t)), cy + b * s * Math.sin(t)]); } return pts; };
    return { rows: [{ z: z0, pts: ring(0.8) }, { z: z0 + r, pts: ring(1) }, { z: z1 - r, pts: ring(1) }, { z: z1, pts: ring(0.8) }], layout: ["t", "t", "band", "t", "t", "t"] };
  })();
  return {
    name: "truck", weight: 0.05, wheelbase: 5.0, width: 2.5,
    paints: [0xf7f7f5, 0xf7f7f5, 0xf7f7f5, 0x1f4f8f, 0xb8322a, 0x2f6e3f, 0xe8b720],
    crease: 0.9,
    body: {
      zN, zT: cabBack, noseR: 0.1, tailR: 0.03,
      axles: [{ z: -2.5, y: 0.52, ra: 0.58 }],
      w: [[zN, 1.16], [-3.8, 1.22], [cabBack, 1.24]],
      yB: 0.55, ymax: 1.2, ku: 0.05, kt: 0.03, rb: 0.05, rs: 0.05, pw: 3,
      ysh: 1.75, yt: 1.74,
      features: [-3.6],
    },
    house: {
      rows: [-3.83, -2.75, -2.62, cabBack - 0.02], capStart: true, capEnd: true, roundStart: 0.1,
      roof: 3.0, gb: 1.2, gt: 1.1, rr: 0.14, crown: 0.02, inset: 0.004,
    },
    wheels: [{ x: 1.02, z: -2.5, R: 0.52, w: 0.3 }, { x: 0.95, z: 1.82, R: 0.52, w: 0.5, rim: 0xc9ccd0 }, { x: 0.95, z: 3.18, R: 0.52, w: 0.5, rim: 0xc9ccd0 }],
    bodySlot: bodySlot({ clad: 0x2a2c30, fn: f => (f.part === "side" && f.type === "top" ? null : undefined) }),
    houseSlot: f => {
      if (f.type === "hidden") return null;
      if (f.part === "capS") return f.type === "side" ? sD(C.glass) : sP;
      if (f.part === "capE") return sP;
      if (f.type === "side") return f.z < -2.75 ? sD(C.glass) : sP;
      return sP;
    },
    decals: [
      { face: "front", x0: -0.7, x1: 0.7, y0: 0.98, y1: 1.5, s: sD(0x202226) },
      { face: "front", sym: true, x0: 0.78, x1: 1.1, y0: 0.66, y1: 0.84, s: sL(C.head), lamp: 0.4 },
      { face: "front", x0: -0.26, x1: 0.26, y0: 0.62, y1: 0.72, s: sD(C.plate), off: 0.025 },
      { face: "rear", sym: true, x0: 0.78, x1: 1.12, y0: 0.5, y1: 0.6, s: sL(C.tail), z: zT + 0.012 },
      { face: "rear", x0: -0.26, x1: 0.26, y0: 0.62, y1: 0.72, s: sD(C.plate), z: zT - 0.08 },
    ],
    extras: kit => {
      kit.box(sD(0x2a2c30), -1.2, 0.45, zN - 0.02, 1.2, 0.62, zN + 0.25, "ny"); // front bumper
      kit.box(sD(0x1d1e20), -0.5, 0.62, cabBack, 0.5, 0.98, zT - 0.05, "ny");      // chassis rails
      kit.box(sD(0x2a2c30), -1.2, 0.45, zT - 0.1, 1.2, 0.62, zT, "ny");           // rear bumper
      for (const z of [-1.2, 1.2, 4.3]) kit.box(sD(0x1d1e20), -0.75, 0.98, z - 0.1, 0.75, 1.3, z + 0.1, "ny");
      for (const s of [-1, 1]) {
        kit.box(sD(0x1d1e20), s > 0 ? 0.68 : -1.24, 1.07, 1.1, s > 0 ? 1.24 : -0.68, 1.12, 3.9, "");
        kit.box(sD(C.dark), s > 0 ? 1.24 : -1.4, 2.0, -3.95, s > 0 ? 1.4 : -1.24, 2.5, -3.85);
      }
      const tank = loft(tankRows.rows, tankRows.layout, f => (f.type === "band" ? sD(0x1f5fa8) : sD(0xe9ebed)), { capStart: true, capEnd: true });
      kit.smooth(tank, 0.9);
    },
  };
}

function supercarType() {
  const zN = -2.4, zT = 2.12;
  return {
    name: "supercar", weight: 0.04, wheelbase: 2.7, width: 2.03, q: { floor: 4, notch: true },
    paints: [0xff6a00, 0x8fd12f, 0xffc800, 0xd4101a, 0x6a2cc4, 0x0a6cff, 0xf5f5f5, 0x111214, 0x00b3a4],
    body: {
      zN, zT, noseR: 0.06, tailR: 0.05,
      axles: [{ z: -1.35, y: 0.345, ra: 0.39 }, { z: 1.35, y: 0.345, ra: 0.395 }],
      w: [[zN, 0.78], [-2.2, 0.9], [-1.8, 0.97], [-1.35, 0.99], [0, 0.96], [1.35, 1.01], [1.9, 0.99], [zT, 0.93]],
      yB: [[zN, 0.13], [1.6, 0.11], [zT, 0.26]],
      ymax: 0.42, ku: 0.6, kt: 0.6, rb: 0.04, rs: 0.08, pw: 2,
      ysh: [[zN, 0.34], [-2.1, 0.5], [-1.7, 0.66], [-1.35, 0.78], [-0.9, 0.8], [0.3, 0.86], [1.0, 0.94], [1.6, 0.96], [zT, 0.93]],
      yt: [[zN, 0.34], [-2.1, 0.47], [-1.7, 0.6], [-1.35, 0.68], [-0.9, 0.76], [0.3, 0.84], [1.0, 0.95], [zT, 0.93]],
      features: [-2.0, -0.9, 0.0, 0.8, 1.9],
    },
    house: {
      rows: [-0.95, -0.55, -0.15, 0.12, 0.55, 0.8, 1.0],
      roof: [[-1.0, 0.72], [-0.6, 0.92], [-0.2, 1.075], [0.15, 1.135], [0.45, 1.12], [0.75, 1.03], [1.0, 0.93]],
      gb: 0.74, gt: 0.53, rr: 0.08, crown: 0.03,
    },
    wheels: [{ x: 0.83, z: -1.35, R: 0.345, w: 0.25, rim: 0x2c2e33 }, { x: 0.84, z: 1.35, R: 0.345, w: 0.32, rim: 0x2c2e33 }],
    bodySlot: bodySlot({
      clad: C.black,
      fn: f => {
        if (f.part === "capS") return f.y < 0.26 ? sD(C.black) : undefined;
        if (f.part === "capE") return f.y < 0.62 ? sD(C.black) : undefined;
        if (f.part === "side" && f.type === "top" && f.z > 1.1 && f.z < 1.95) return sD(C.black);
        if (f.part === "side" && f.type === "side" && f.z > 0.5 && f.z < 0.9 && f.y > 0.3 && f.y < 0.72) return sD(C.black);
        return undefined;
      },
    }),
    houseSlot: houseSlot({ zW: 0.12, zR: 0.55, roof: sP, aPillar: sD(C.black) }),
    decals: [
      { face: "rear", sym: true, x0: 0.3, x1: 0.84, y0: 0.74, y1: 0.79, s: sL(C.tail) },
      { face: "rear", x0: -0.26, x1: 0.26, y0: 0.44, y1: 0.54, s: sD(C.plate) },
    ],
    extras: (kit, bm) => {
      const uE = 4 + Q_LO.nC + Q_LO.nS + Q_LO.nSh;
      for (const s of [-1, 1]) patch(kit, sL(C.head), bm, s, 2, 1, (a, b) => [zN + 0.07 + a * 0.2 + b * 0.05, uE - 0.6 + a * 1.2], 0.012);
      kit.box(sD(C.black), -0.6, 0.085, zN + 0.03, 0.6, 0.11, zN + 0.4, "");
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Pakistan traffic (build/pk/research/art_direction.md section 4). Dimensions are general
// knowledge of each model and the shares and paints are the brief's [EST] art-direction values.
// ---------------------------------------------------------------------------------------------

const PK_PAINT = [0xeeeee8, 0xeeeee8, 0xeeeee8, 0xeeeee8, 0xeeeee8, 0xeeeee8, 0xeeeee8, 0xeeeee8, 0xeeeee8, 0xbfc2c5, 0xbfc2c5, 0xbfc2c5, 0xbfc2c5, 0x2c2f34, 0x2c2f34, 0x74787c, 0x74787c, 0x7f2b2b, 0x2a4a78, 0x2f5a44];
const PK_OLD_PAINT = [0xddd8c8, 0xddd8c8, 0xddd8c8, 0xddd8c8, 0xa8a8a4, 0xa8a8a4, 0x6c2c2a, 0x34507a, 0x7a7466, 0x8d7f5a];
// Lighter than the Dubai glass: at noon a near-black side window on a white body read as one solid sheet (REVIEW3 item 7)
const PK_GLASS = 0x34485a;
const PK_SHUT = 0x25262a;
const PK_TRUCK_PAINT = [[0xd2142b, 0xf5b60f, 0xe9398c], [0x0a7b6c, 0x1e44c8, 0xd2142b]];

// CD 70 tank colours: red, black and blue are the listed colours (blog.olx.com.pk "Honda CD 70 2026 price", gari.pk, pakwheels.com), grey on the Dream listing. The shares are [EST].
const PK_BIKE_TANK = [0xb5141c, 0xb5141c, 0xa8171d, 0xb5141c, 0xb5141c, 0x1d1f24, 0x1d1f24, 0x1d1f24, 0x1f3f8a, 0x6b7075];

// Two- and three-box Pakistani cars from a handful of station values.
function pkCar(o) {
  const { name, wb, fo, L, hw, h, R, hood, belt, cowl, ws, rEnd, tail, hatch = false, box = false, paints = PK_PAINT, lamp = [0.42, 0.72], chrome = false, grille = 0.3, extras = null, glass = C.glass, pillar = sD(C.black), morePillars = [], shut = false } = o;
  const zN = -(wb / 2 + fo), zT = zN + L, ax = wb / 2, rnd = box ? 0.05 : 0.09;
  const bp = lerp(ws, rEnd, 0.42);
  const body = {
    zN, zT, noseR: rnd, tailR: rnd * 0.8,
    axles: [{ z: -ax, y: R, ra: R + 0.045 }, { z: ax, y: R, ra: R + 0.045 }],
    w: [[zN, hw * (box ? 0.94 : 0.86)], [zN + 0.2, hw * 0.96], [zN + 0.55, hw], [zT - 0.4, hw], [zT, hw * (box ? 0.97 : 0.93)]],
    yB: [[zN, 0.27], [zN + 0.3, 0.19], [zT - 0.3, 0.19], [zT, 0.29]],
    ymax: hood - 0.2, ku: 0.4, kt: 0.3, rb: 0.05, rs: box ? 0.05 : 0.09, pw: box ? 3 : 2.2,
    ysh: [[zN, hood - 0.1], [zN + 0.22, hood - 0.02], [cowl, hood + 0.03], [zT - 0.35, belt], [zT, belt - 0.02]],
    yt: [[zN, hood - 0.11], [zN + 0.22, hood], [cowl, hood + 0.05], [zT - 0.35, belt + 0.01], [zT, belt - 0.02]],
    features: [zN + 0.3, cowl, zT - 0.3],
  };
  const mid = lerp(cowl, ws, 0.5);
  const rows = [cowl, mid, ws, bp, bp + 0.09, rEnd];
  for (const p of morePillars) rows.push(p, p + 0.09);
  rows.sort((a, b) => a - b);
  if (tail > rEnd + 0.02) rows.push(tail);
  const house = {
    rows, capEnd: hatch,
    roof: [[cowl - 0.04, hood + 0.06], [mid, lerp(hood + 0.08, h, 0.62)], [ws, h - 0.03], [lerp(ws, rEnd, 0.5), h], [rEnd, h - 0.025], [tail + 0.04, hatch ? h - 0.14 : belt + 0.02]],
    gb: hw * 0.9, gt: hw * (box ? 0.84 : 0.76), rr: box ? 0.05 : 0.08, crown: 0.025,
  };
  const yl = hood - 0.24;
  return {
    name, wheelbase: wb, width: 2 * hw, paints, body, house,
    wheels: [{ x: hw - 0.12, z: -ax, R, w: 0.18 }, { x: hw - 0.12, z: ax, R, w: 0.18 }],
    bodySlot: bodySlot({}),
    houseSlot: houseSlot({ zW: ws, zR: hatch ? tail + 0.1 : rEnd, pillars: [[bp, bp + 0.09], ...morePillars.map(p => [p, p + 0.09])], pillar, roof: sP, glass: sD(glass), capE: hatch ? f => (f.type === "side" && f.y > belt + 0.06 ? sD(glass) : sP) : null }),
    decals: [
      { face: "front", sym: true, x0: lamp[0] * hw / 0.72, x1: lamp[1] * hw / 0.72, y0: yl, y1: yl + 0.14, s: sL(C.head), lamp: 0.42 },
      { face: "front", x0: -grille, x1: grille, y0: yl + 0.01, y1: yl + 0.11, s: sD(C.grille) },
      { face: "front", x0: -0.17, x1: 0.17, y0: yl - 0.2, y1: yl - 0.09, s: sD(C.plate) },
      { face: "rear", sym: true, x0: hw * 0.52, x1: hw * 0.86, y0: belt - 0.22, y1: belt - 0.07, s: sL(C.tail) },
      { face: "rear", x0: -0.17, x1: 0.17, y0: belt - 0.42, y1: belt - 0.3, s: sD(C.plate) },
    ],
    extras: (kit, bm) => {
      for (const s of [-1, 1]) kit.box(sP, s > 0 ? hw - 0.02 : -hw - 0.1, belt + 0.03, cowl + 0.12, s > 0 ? hw + 0.1 : -hw + 0.02, belt + 0.11, cowl + 0.21, s > 0 ? "nx" : "px");
      const bump = chrome ? sD(C.chrome) : sD(0x2b2c2f);
      kit.box(bump, -hw * 0.98, yl - 0.26, zN - 0.05, hw * 0.98, yl - 0.2 + (chrome ? 0 : 0.03), zN + 0.08, "ny");
      kit.box(bump, -hw * 0.96, belt - 0.58, zT - 0.08, hw * 0.96, belt - 0.5, zT + 0.05, "ny");
      if (shut) {   // door shut lines and handles, which are what give a plain body its scale from close to
        const uS = Q_LO.floor + Q_LO.nC, ra = R + 0.045, lines = [Math.max(cowl + 0.1, -ax + ra + 0.05), bp + 0.045];
        if (L > 3.45) lines.push(Math.min(lerp(ws, rEnd, 0.92), ax - ra - 0.05));
        for (const side of [-1, 1]) {
          for (const zl of lines) patch(kit, sD(PK_SHUT), bm, side, 1, 5, (a, b) => [zl + a * 0.012, uS + 0.5 + b * 3.3], 0.006);
          for (let i = 0; i < lines.length - 1; i++) patch(kit, sD(PK_SHUT), bm, side, 1, 1, (a, b) => [lines[i + 1] - 0.24 + a * 0.15, uS + 3.1 + b * 0.22], 0.008);
        }
      }
      if (extras) extras(kit, bm, { zN, zT, hw, belt, hood });
    },
  };
}

// Atlas regions in pixels for variant v of the hand-painted truck art (canvas 1024 x 1024).
const ART_R = v => { const y = v * 512; return { side: [0, y, 720, 300], tail: [720, y, 304, 300], taj: [0, y + 300, 512, 212], door: [512, y + 300, 256, 212], band: [768, y + 300, 256, 212] }; };

function drawFlower(g, x, y, r, a, b, n = 6) {
  g.fillStyle = a;
  for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2; g.beginPath(); g.ellipse(x + Math.cos(t) * r * 0.58, y + Math.sin(t) * r * 0.58, r * 0.5, r * 0.26, t, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = b; g.beginPath(); g.arc(x, y, r * 0.3, 0, Math.PI * 2); g.fill();
}
function chevrons(g, x, y, w, h, c1, c2) {
  const n = Math.round(w / h / 1.1); g.fillStyle = c1; g.fillRect(x, y, w, h); g.fillStyle = c2;
  for (let i = 0; i < n; i++) { const a = x + (i / n) * w, s = w / n; g.beginPath(); g.moveTo(a, y + h); g.lineTo(a + s / 2, y); g.lineTo(a + s, y + h); g.fill(); }
}
function dots(g, x, y, w, n, c, r) { g.fillStyle = c; for (let i = 0; i <= n; i++) { g.beginPath(); g.arc(x + (i / n) * w, y, r, 0, Math.PI * 2); g.fill(); } }
function arch(g, x, y, w, h) { g.beginPath(); g.moveTo(x, y + h); g.lineTo(x, y + h * 0.34); g.quadraticCurveTo(x + w * 0.02, y + h * 0.1, x + w / 2, y); g.quadraticCurveTo(x + w * 0.98, y + h * 0.1, x + w, y + h * 0.34); g.lineTo(x + w, y + h); g.closePath(); }
function peacock(g, x, y, s, P) {
  for (let i = -5; i <= 5; i++) { const t = -Math.PI / 2 + i * 0.27, R = s * 0.95; g.strokeStyle = P.teal; g.lineWidth = s * 0.05; g.beginPath(); g.moveTo(x, y + s * 0.2); g.lineTo(x + Math.cos(t) * R, y + s * 0.1 + Math.sin(t) * R); g.stroke(); g.fillStyle = P.teal; g.beginPath(); g.arc(x + Math.cos(t) * R, y + s * 0.1 + Math.sin(t) * R, s * 0.15, 0, 7); g.fill(); g.fillStyle = P.yellow; g.beginPath(); g.arc(x + Math.cos(t) * R, y + s * 0.1 + Math.sin(t) * R, s * 0.09, 0, 7); g.fill(); g.fillStyle = P.blue; g.beginPath(); g.arc(x + Math.cos(t) * R, y + s * 0.1 + Math.sin(t) * R, s * 0.045, 0, 7); g.fill(); }
  g.fillStyle = P.blue; g.beginPath(); g.ellipse(x, y + s * 0.42, s * 0.2, s * 0.34, 0, 0, 7); g.fill();
  g.beginPath(); g.moveTo(x - s * 0.08, y + s * 0.2); g.quadraticCurveTo(x + s * 0.02, y - s * 0.1, x + s * 0.1, y - s * 0.16); g.lineTo(x + s * 0.14, y - s * 0.08); g.quadraticCurveTo(x + s * 0.08, y + s * 0.1, x + s * 0.1, y + s * 0.26); g.fill();
  g.fillStyle = P.yellow; g.beginPath(); g.moveTo(x + s * 0.14, y - s * 0.15); g.lineTo(x + s * 0.27, y - s * 0.11); g.lineTo(x + s * 0.14, y - s * 0.07); g.fill();
}
function landscape(g, x, y, w, h, P) {
  g.fillStyle = P.sky; g.fillRect(x, y, w, h * 0.6);
  g.fillStyle = P.yellow; g.beginPath(); g.arc(x + w * 0.72, y + h * 0.24, h * 0.1, 0, 7); g.fill();
  g.fillStyle = "#3f5a8c"; g.beginPath(); g.moveTo(x, y + h * 0.6); g.lineTo(x + w * 0.3, y + h * 0.16); g.lineTo(x + w * 0.56, y + h * 0.6); g.fill();
  g.fillStyle = "#5e3f8a"; g.beginPath(); g.moveTo(x + w * 0.36, y + h * 0.6); g.lineTo(x + w * 0.7, y + h * 0.26); g.lineTo(x + w, y + h * 0.6); g.fill();
  g.fillStyle = "#f7f4ea"; g.beginPath(); g.moveTo(x + w * 0.24, y + h * 0.25); g.lineTo(x + w * 0.3, y + h * 0.16); g.lineTo(x + w * 0.37, y + h * 0.26); g.fill();
  g.fillStyle = P.teal; g.fillRect(x, y + h * 0.6, w, h * 0.4);
  g.strokeStyle = "#d9f2f0"; g.lineWidth = 2; for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(x + w * 0.1 * i, y + h * (0.65 + i * 0.08)); g.lineTo(x + w * (0.45 + i * 0.1), y + h * (0.65 + i * 0.08)); g.stroke(); }
}
function bouquet(g, x, y, s, P) {
  g.strokeStyle = "#1f7a3c"; g.lineWidth = s * 0.05;
  for (let i = -2; i <= 2; i++) { g.beginPath(); g.moveTo(x, y + s); g.quadraticCurveTo(x + i * s * 0.12, y + s * 0.4, x + i * s * 0.34, y + s * 0.12 - Math.abs(i) * -s * 0.05); g.stroke(); }
  [[-0.68, 0.22, P.pink], [-0.34, -0.1, P.red], [0, -0.26, P.yellow], [0.34, -0.1, P.red], [0.68, 0.22, P.pink]].forEach(([a, b, c]) => drawFlower(g, x + a * s, y + b * s + s * 0.2, s * 0.26, c, P.white, 7));
  g.fillStyle = "#c98a2c"; g.beginPath(); g.moveTo(x - s * 0.22, y + s * 0.74); g.lineTo(x + s * 0.22, y + s * 0.74); g.lineTo(x + s * 0.14, y + s * 1.12); g.lineTo(x - s * 0.14, y + s * 1.12); g.fill();
}
function urduLine(g, text, x, y, size, c) {
  g.save(); g.direction = "rtl"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = c;
  g.font = `bold ${size}px 'Jameel Noori Nastaleeq','Noto Nastaliq Urdu','Urdu Typesetting','Segoe UI',Tahoma,sans-serif`;
  g.fillText(text, x, y); g.restore();
}

function paintTruckVariant(g, v) {
  const P = { red: "#D2142B", yellow: "#F5B60F", teal: "#0A7B6C", blue: "#1E44C8", pink: "#E9398C", white: "#F7F4EA", silver: "#DDE3E8", sky: "#8ccbe8", wood: "#7a4a24" };
  const R = ART_R(v), base = v ? P.blue : P.red, alt = v ? P.yellow : P.teal, trim = v ? P.pink : P.yellow;
  { // cargo side: chamak patti bands, three arches with hand-painted scenes, floral foot
    const [x, y, w, h] = R.side;
    g.fillStyle = base; g.fillRect(x, y, w, h);
    chevrons(g, x, y, w, 26, P.silver, trim); chevrons(g, x, y + h - 26, w, 26, P.silver, alt);
    g.fillStyle = alt; g.fillRect(x, y + 26, w, 9); g.fillRect(x, y + h - 35, w, 9);
    dots(g, x + 10, y + 30, w - 20, 60, P.white, 2.5);
    const n = 3, aw = w / n;
    for (let i = 0; i < n; i++) {
      const ax = x + i * aw + 16, ay = y + 44, wA = aw - 32, hA = h - 88;
      g.save(); arch(g, ax, ay, wA, hA); g.fillStyle = i === 1 ? P.white : alt; g.fill(); g.clip();
      if (i === 0) { g.fillStyle = "#17335f"; g.fillRect(ax, ay, wA, hA); peacock(g, ax + wA / 2, ay + hA * 0.5, hA * 0.5, P); }
      if (i === 1) landscape(g, ax, ay, wA, hA, P);
      if (i === 2) { g.fillStyle = "#fff0c4"; g.fillRect(ax, ay, wA, hA); bouquet(g, ax + wA / 2, ay + hA * 0.28, hA * 0.5, P); }
      g.restore();
      arch(g, ax, ay, wA, hA); g.strokeStyle = trim; g.lineWidth = 7; g.stroke();
      arch(g, ax - 7, ay - 7, wA + 14, hA + 14); g.strokeStyle = P.silver; g.lineWidth = 3; g.stroke();
      drawFlower(g, ax - 2, ay + 12, 13, P.pink, P.yellow); drawFlower(g, ax + wA + 2, ay + 12, 13, P.pink, P.yellow);
    }
  }
  { // tailgate: a framed bird and the classic road couplets
    const [x, y, w, h] = R.tail;
    g.fillStyle = alt; g.fillRect(x, y, w, h);
    chevrons(g, x, y, w, 22, P.silver, trim); chevrons(g, x, y + h - 22, w, 22, P.silver, trim);
    g.fillStyle = P.white; g.fillRect(x + 22, y + 30, w - 44, 64);
    urduLine(g, "پپو یار تنگ نہ کر", x + w / 2, y + 62, 34, P.red);
    g.save(); arch(g, x + 56, y + 102, w - 112, 130); g.fillStyle = base; g.fill(); g.clip(); drawFlower(g, x + w / 2, y + 176, 46, P.yellow, P.white, 8); drawFlower(g, x + 78, y + 214, 22, P.pink, P.white); drawFlower(g, x + w - 78, y + 214, 22, P.pink, P.white); g.restore();
    arch(g, x + 56, y + 102, w - 112, 130); g.strokeStyle = P.silver; g.lineWidth = 5; g.stroke();
    g.fillStyle = base; g.fillRect(x + 22, y + 238, w - 44, 38);
    urduLine(g, "ہارن دے کر پاس کریں", x + w / 2, y + 256, 24, P.white);
  }
  { // taj: mirror work and a sunburst crest
    const [x, y, w, h] = R.taj;
    g.fillStyle = P.silver; g.fillRect(x, y, w, h);
    g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); g.translate(x + w / 2, y + h * 0.9);
    for (let i = 0; i < 26; i++) { g.rotate(Math.PI / 26); g.fillStyle = i % 2 ? base : trim; g.beginPath(); g.moveTo(0, 0); g.lineTo(-26, -h * 1.3); g.lineTo(26, -h * 1.3); g.fill(); }
    g.restore();
    g.fillStyle = alt; g.beginPath(); g.arc(x + w / 2, y + h * 0.62, 56, 0, 7); g.fill();
    drawFlower(g, x + w / 2, y + h * 0.62, 50, P.yellow, P.white, 10);
    for (let i = 0; i < 9; i++) { const a = x + 28 + i * (w - 56) / 8; g.fillStyle = P.white; g.beginPath(); g.moveTo(a, y + h - 34); g.lineTo(a + 11, y + h - 18); g.lineTo(a, y + h - 2); g.lineTo(a - 11, y + h - 18); g.fill(); g.fillStyle = "#6fd3ff"; g.beginPath(); g.arc(a, y + h - 18, 4.5, 0, 7); g.fill(); }
    chevrons(g, x, y, w, 16, trim, base);
  }
  { // cab door: carved wood look
    const [x, y, w, h] = R.door;
    g.fillStyle = P.wood; g.fillRect(x, y, w, h);
    g.strokeStyle = "#3f2410"; g.lineWidth = 4; g.strokeRect(x + 10, y + 10, w - 20, h - 20); g.strokeRect(x + 26, y + 26, w - 52, h - 52);
    drawFlower(g, x + w / 2, y + h / 2, 56, trim, P.white, 8);
    for (const [a, b] of [[34, 34], [w - 34, 34], [34, h - 34], [w - 34, h - 34]]) drawFlower(g, x + a, y + b, 16, P.yellow, P.red);
  }
  { // band: bumper, mudflaps and bonnet front
    const [x, y, w, h] = R.band;
    g.fillStyle = trim; g.fillRect(x, y, w, h);
    chevrons(g, x, y, w, 40, P.silver, base); chevrons(g, x, y + h - 40, w, 40, P.silver, base);
    for (let i = 0; i < 4; i++) drawFlower(g, x + 32 + i * 64, y + h / 2, 26, i % 2 ? P.pink : P.red, P.white, 7);
  }
}

let _artTex = null;
function truckArtTexture() {
  if (_artTex || typeof document === "undefined") return _artTex;
  const cv = document.createElement("canvas"); cv.width = cv.height = 1024;
  const g = cv.getContext("2d");
  paintTruckVariant(g, 0); paintTruckVariant(g, 1);
  _artTex = new THREE.CanvasTexture(cv); _artTex.colorSpace = THREE.SRGBColorSpace; _artTex.anisotropy = 4;
  return _artTex;
}

class ArtBuilder {
  constructor() { this.p = []; this.n = []; this.u = []; }
  // a, b, c, d counter-clockwise from outside = bottom-left, bottom-right, top-right, top-left of the region
  quad(a, b, c, d, [x, y, w, h], uvOf = null) {
    const nn = norm(cross(sub(b, a), sub(c, a)));
    const U = k => { const q = uvOf ? uvOf(k) : [[0, 1], [1, 1], [1, 0], [0, 0]][k]; return [(x + q[0] * w) / 1024, 1 - (y + q[1] * h) / 1024]; };
    for (const [pt, k] of [[a, 0], [b, 1], [c, 2], [a, 0], [c, 2], [d, 3]]) { this.p.push(...pt); this.n.push(...nn); this.u.push(...U(k)); }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.u, 2));
    return g;
  }
}

// Bedford J-series rocket: snub bonnet, wooden high-sided body, the taj over the cab.
// Overall 6.55 m and 2.28 m wide, the top of the J-series ranges in the brief; taj 1.1 m above the cab.
function bedfordType(v) {
  const kit = new Kit(), art = new ArtBuilder(), R = ART_R(v);
  const zN = -3.3, zBon = -2.25, zCab = -1.0, zB0 = -0.92, zT = 3.25, cabW = 1.02, W = 1.14, yCab = 2.18, yF = 1.02, yB = 1.05, yTop = 2.72;
  const P = sP, D = hex => sD(hex), wood = D(0x6a3f1e), dk = D(0x1d1e20), chrome = D(C.chrome);
  // bonnet: sloped top, flat sides
  const bW = 0.86, yBon0 = 1.42, yBon1 = 1.72;
  kit.quad(P, [-bW, yBon0, zN + 0.06], [bW, yBon0, zN + 0.06], [bW, yBon1, zBon], [-bW, yBon1, zBon], [0, 1, 0]);
  kit.quad(P, [bW, 0.82, zN + 0.06], [bW, 0.82, zBon], [bW, yBon1, zBon], [bW, yBon0, zN + 0.06], [1, 0, 0]);
  kit.quad(P, [-bW, 0.82, zBon], [-bW, 0.82, zN + 0.06], [-bW, yBon0, zN + 0.06], [-bW, yBon1, zBon], [-1, 0, 0]);
  art.quad([bW, 0.84, zN + 0.05], [-bW, 0.84, zN + 0.05], [-bW, yBon0, zN + 0.05], [bW, yBon0, zN + 0.05], R.band);
  kit.box(chrome, -0.52, 0.92, zN + 0.03, 0.52, 1.32, zN + 0.05, "ny pz");           // grille
  for (let i = 0; i < 5; i++) kit.quad(dk, [-0.5, 0.97 + i * 0.075, zN + 0.025], [0.5, 0.97 + i * 0.075, zN + 0.025], [0.5, 1.01 + i * 0.075, zN + 0.025], [-0.5, 1.01 + i * 0.075, zN + 0.025], [0, 0, -1]);
  for (const s of [-1, 1]) {
    kit.quad(sL(C.head), [s * 0.62 - 0.11, 1.08, zN + 0.03], [s * 0.62 + 0.11, 1.08, zN + 0.03], [s * 0.62 + 0.11, 1.3, zN + 0.03], [s * 0.62 - 0.11, 1.3, zN + 0.03], [0, 0, -1]);
    kit.box(P, s > 0 ? 0.84 : -1.16, 0.74, -3.2, s > 0 ? 1.16 : -0.84, 0.92, -1.75, "ny");    // front wing
    kit.box(dk, s * 1.2 - 0.04, 1.75, -2.28, s * 1.2 + 0.04, 2.15, -2.2);                     // mirror
  }
  // bumper with painted band and hanging chains
  kit.box(chrome, -1.12, 0.62, zN - 0.02, 1.12, 0.78, zN + 0.2, "ny");
  art.quad([1.12, 0.63, zN - 0.03], [-1.12, 0.63, zN - 0.03], [-1.12, 0.77, zN - 0.03], [1.12, 0.77, zN - 0.03], R.band);
  for (let i = 0; i < 13; i++) { const x = -1.02 + i * 0.17, y1 = 0.62, y0 = 0.3 + (i % 2) * 0.08; kit.quad(chrome, [x + 0.018, y0, zN - 0.03], [x - 0.018, y0, zN - 0.03], [x - 0.018, y1, zN - 0.03], [x + 0.018, y1, zN - 0.03], [0, 0, -1]); kit.quad(i % 3 ? sD(0xd2142b) : sD(0xf5b60f), [x + 0.04, y0 - 0.06, zN - 0.031], [x - 0.04, y0 - 0.06, zN - 0.031], [x - 0.04, y0, zN - 0.031], [x + 0.04, y0, zN - 0.031], [0, 0, -1]); }
  // cab
  kit.box(P, -cabW, 0.82, zBon, cabW, yCab, zCab, "ny pz");
  kit.quad(D(C.glass), [cabW - 0.1, 1.74, zBon - 0.012], [-cabW + 0.1, 1.74, zBon - 0.012], [-cabW + 0.1, yCab - 0.1, zBon - 0.012], [cabW - 0.1, yCab - 0.1, zBon - 0.012], [0, 0, -1]);
  for (const s of [-1, 1]) {
    const x = s * (cabW + 0.012), q = s > 0 ? (y0, y1, z0, z1) => [[x, y0, z1], [x, y0, z0], [x, y1, z0], [x, y1, z1]] : (y0, y1, z0, z1) => [[x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0]];
    art.quad(...q(0.86, 1.68, -2.1, -1.14), R.door);
    kit.quad(D(C.glass), ...q(1.74, 2.06, -2.08, -1.2), [s, 0, 0]);
  }
  // taj: a crown over the cab, leaning forward
  const tajY0 = yCab, tajH = 1.1, tajHW = 1.12, zTaj = zBon - 0.02, nT = 8;
  const top = u => tajY0 + tajH * (0.42 + 0.58 * Math.cos(u * Math.PI / 2) ** 1.4), lean = y => zTaj - (y - tajY0) * 0.32;
  for (let i = 0; i < nT; i++) {
    const u0 = -1 + (2 * i) / nT, u1 = -1 + (2 * (i + 1)) / nT, x0 = -u0 * tajHW, x1 = -u1 * tajHW, y0 = top(u0), y1 = top(u1);
    const uvs = [[(u0 + 1) / 2, 1], [(u1 + 1) / 2, 1], [(u1 + 1) / 2, 1 - (y1 - tajY0) / tajH], [(u0 + 1) / 2, 1 - (y0 - tajY0) / tajH]];
    art.quad([x0, tajY0, zTaj], [x1, tajY0, zTaj], [x1, y1, lean(y1)], [x0, y0, lean(y0)], R.taj, k => uvs[k]);
    kit.quad(chrome, [x0, y0, lean(y0)], [x1, y1, lean(y1)], [x1, y1 + 0.05, lean(y1) + 0.04], [x0, y0 + 0.05, lean(y0) + 0.04], [0, 1, 0]);
    kit.quad(wood, [x1, tajY0, zTaj + 0.05], [x0, tajY0, zTaj + 0.05], [x0, y0 + 0.05, lean(y0) + 0.05], [x1, y1 + 0.05, lean(y1) + 0.05], [0, 0, 1]);
  }
  // cargo body
  kit.box(dk, -0.56, 0.74, zCab, 0.56, 1.02, zT - 0.05, "ny");
  kit.box(wood, -W, yB, zB0, W, yB + 0.06, zT, "");
  kit.box(P, -W, yB + 0.05, zB0, W, yTop, zT, "ny py");
  // tarpaulin over the load
  const tarp = D(v ? 0x3d4a3a : 0x4a4436), hT = yTop + 0.55;
  kit.quad(tarp, [-W, yTop, zB0], [0, hT, zB0 + 0.2], [0, hT, zT - 0.2], [-W, yTop, zT], [-1, 1, 0]);
  kit.quad(tarp, [W, yTop, zT], [0, hT, zT - 0.2], [0, hT, zB0 + 0.2], [W, yTop, zB0], [1, 1, 0]);
  kit.tri(tarp, [-W, yTop, zT], [W, yTop, zT], [0, hT, zT - 0.2], [0, 0.4, 1]); kit.tri(tarp, [-W, yTop, zB0], [W, yTop, zB0], [0, hT, zB0 + 0.2], [0, 0.4, -1]);
  for (const s of [-1, 1]) {
    const x = s * (W + 0.015), yA = yB + 0.08;
    if (s > 0) art.quad([x, yA, zT - 0.05], [x, yA, zB0 + 0.05], [x, yTop - 0.03, zB0 + 0.05], [x, yTop - 0.03, zT - 0.05], R.side);
    else art.quad([x, yA, zB0 + 0.05], [x, yA, zT - 0.05], [x, yTop - 0.03, zT - 0.05], [x, yTop - 0.03, zB0 + 0.05], R.side);
  }
  art.quad([-W + 0.04, yB + 0.08, zT + 0.015], [W - 0.04, yB + 0.08, zT + 0.015], [W - 0.04, yTop - 0.03, zT + 0.015], [-W + 0.04, yTop - 0.03, zT + 0.015], R.tail);
  art.quad([1.08, 1.05, zB0 - 0.015], [-1.08, 1.05, zB0 - 0.015], [-1.08, yTop - 0.03, zB0 - 0.015], [1.08, yTop - 0.03, zB0 - 0.015], R.tail);
  // rear rig: bumper, lamps, plate, mud flaps
  kit.box(dk, -1.08, 0.72, zT - 0.08, 1.08, 0.88, zT + 0.03, "ny");
  kit.quad(D(C.plate), [-0.17, 0.75, zT + 0.04], [0.17, 0.75, zT + 0.04], [0.17, 0.86, zT + 0.04], [-0.17, 0.86, zT + 0.04], [0, 0, 1]);
  for (const s of [-1, 1]) {
    kit.quad(sL(C.tail), [s * 0.9 - 0.13, 0.76, zT + 0.04], [s * 0.9 + 0.13, 0.76, zT + 0.04], [s * 0.9 + 0.13, 0.85, zT + 0.04], [s * 0.9 - 0.13, 0.85, zT + 0.04], [0, 0, 1]);
    art.quad([s * 0.92 - 0.2, 0.22, 2.02], [s * 0.92 + 0.2, 0.22, 2.02], [s * 0.92 + 0.2, 0.74, 2.02], [s * 0.92 - 0.2, 0.74, 2.02], R.band);
  }
  const wheels = [{ x: 0.86, z: -2.35, R: 0.5, w: 0.26 }, { x: 0.88, z: 1.15, R: 0.5, w: 0.46 }];
  for (const w of wheels) for (const s of [-1, 1]) wheelLo(kit, s * w.x, w.z, w.R, w.w, s, 0xc9ccd0, 10);
  return finishType({ name: "bedford" + (v ? "B" : "A"), wheelbase: 3.5, width: 2.28, wheels, paints: PK_TRUCK_PAINT[v], art: art.geometry() }, kit);
}

function personInto(kit, top, x, ySeat, z, { helmet = false, lean = 0.1 } = {}) {
  const skin = sD(0x8a5a3c), hair = sD(0x15120f), pants = sD(0xcfc9ba);
  const yS = ySeat, yC = yS + 0.56, zT0 = z, zT1 = z - lean;
  kit.quad(top, [x - 0.17, yS, zT0 + 0.11], [x + 0.17, yS, zT0 + 0.11], [x + 0.18, yC, zT1 + 0.1], [x - 0.18, yC, zT1 + 0.1], [0, 0, 1]);
  kit.quad(top, [x + 0.17, yS, zT0 - 0.1], [x - 0.17, yS, zT0 - 0.1], [x - 0.18, yC, zT1 - 0.1], [x + 0.18, yC, zT1 - 0.1], [0, 0, -1]);
  kit.quad(top, [x + 0.17, yS, zT0 + 0.11], [x + 0.17, yS, zT0 - 0.1], [x + 0.18, yC, zT1 - 0.1], [x + 0.18, yC, zT1 + 0.1], [1, 0, 0]);
  kit.quad(top, [x - 0.17, yS, zT0 - 0.1], [x - 0.17, yS, zT0 + 0.11], [x - 0.18, yC, zT1 + 0.1], [x - 0.18, yC, zT1 - 0.1], [-1, 0, 0]);
  kit.quad(top, [x - 0.18, yC, zT1 + 0.1], [x + 0.18, yC, zT1 + 0.1], [x + 0.18, yC, zT1 - 0.1], [x - 0.18, yC, zT1 - 0.1], [0, 1, 0]);
  const head = new THREE.SphereGeometry(helmet ? 0.135 : 0.105, 7, 5);
  kit.geo(helmet ? sD(0x1a1c20) : skin, head, new THREE.Matrix4().makeTranslation(x, yC + 0.15, zT1 - 0.02)); head.dispose();
  if (!helmet) { const h2 = new THREE.SphereGeometry(0.11, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2); kit.geo(hair, h2, new THREE.Matrix4().makeTranslation(x, yC + 0.17, zT1 - 0.0)); h2.dispose(); }
  return { pants, skin, yC };
}

// A four-sided limb between two points (a rider's arms and legs were single flat quads, which read as sails from close to)
function pkLimb(kit, s, a, b, r) {
  const d = sub(b, a), l = Math.hypot(d[0], d[1], d[2]), ax = [d[0] / l, d[1] / l, d[2] / l];
  let u = cross(ax, Math.abs(ax[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]); const ul = Math.hypot(u[0], u[1], u[2]); u = [u[0] / ul * r, u[1] / ul * r, u[2] / ul * r];
  const v0 = cross(ax, u), v = [v0[0], v0[1], v0[2]];
  const corner = (p, i) => { const su = i === 0 || i === 3 ? 1 : -1, sv = i < 2 ? 1 : -1; return [p[0] + su * u[0] + sv * v[0], p[1] + su * u[1] + sv * v[1], p[2] + su * u[2] + sv * v[2]]; };
  for (let i = 0; i < 4; i++) { const j = (i + 1) % 4, mid = [corner(a, i)[0] + corner(a, j)[0] - 2 * a[0], corner(a, i)[1] + corner(a, j)[1] - 2 * a[1], corner(a, i)[2] + corner(a, j)[2] - 2 * a[2]]; kit.quad(s, corner(a, i), corner(a, j), corner(b, j), corner(b, i), mid); }
}

// Honda CD70 style: pressed frame, painted tank, side cover and mudguards (their own part, so each bike can differ), one rider. Paint = the rider's shirt.
function cd70Type() {
  const kit = new Kit(), R = 0.29, zF = -0.62, zR = 0.6, dk = sD(0x17181b), tk = { k: "tank" }, chrome = sD(C.chrome), P = sP;
  for (const z of [zF, zR]) {                                                     // a thin tyre, the spokes reading as a dark disc, a small hub
    wheelLo(kit, 0, z, R, 0.08, 1, 0x4a4d52, 10, 0.86); wheelLo(kit, 0, z, R, 0.08, -1, 0x4a4d52, 10, 0.86);
    kit.box(chrome, -0.055, R - 0.055, z - 0.055, 0.055, R + 0.055, z + 0.055, "");
  }
  // the tank: narrow at the steering head, widest under the rider's knees, sloping down to the seat
  const tr = [[-0.38, 0.055, 0.76, 0.86], [-0.28, 0.11, 0.74, 0.925], [-0.1, 0.125, 0.74, 0.94], [0.02, 0.085, 0.77, 0.895]];
  for (let i = 0; i < tr.length - 1; i++) {
    const [z0, w0, a0, t0] = tr[i], [z1, w1, a1, t1] = tr[i + 1], in0 = w0 * 0.6, in1 = w1 * 0.6;
    kit.quad(tk, [-in0, t0, z0], [in0, t0, z0], [in1, t1, z1], [-in1, t1, z1], [0, 1, 0]);
    for (const s of [-1, 1]) {
      kit.quad(tk, [s * in0, t0, z0], [s * w0, t0 - 0.05, z0], [s * w1, t1 - 0.05, z1], [s * in1, t1, z1], [s, 1, 0]);
      kit.quad(tk, [s * w0, t0 - 0.05, z0], [s * w0, a0, z0], [s * w1, a1, z1], [s * w1, t1 - 0.05, z1], [s, 0, 0]);
    }
  }
  kit.quad(tk, [-0.055, 0.76, -0.38], [0.055, 0.76, -0.38], [0.055, 0.86, -0.38], [-0.055, 0.86, -0.38], [0, 0, -1]);
  kit.box(tk, -0.115, 0.56, 0.1, 0.115, 0.76, 0.34, "");                          // side cover
  kit.box(dk, -0.07, 0.42, -0.42, 0.07, 0.74, 0.12, "");                          // pressed frame
  kit.box(chrome, -0.12, 0.28, -0.15, 0.12, 0.47, 0.14, "");                      // engine
  kit.box(dk, -0.1, 0.44, 0.1, 0.1, 0.6, 0.3, "");                                // battery box under the cover
  kit.box(chrome, 0.1, 0.3, 0.05, 0.145, 0.355, 0.84, "ny");                      // exhaust
  kit.box(dk, -0.05 - 0.06, 0.29, 0.14, -0.06, 0.38, 0.62, "");                   // chain guard
  kit.box(dk, -0.125, 0.79, 0.02, 0.125, 0.885, 0.66, "ny");                      // seat
  kit.box(dk, -0.1, 0.885, 0.1, 0.1, 0.905, 0.6, "ny");
  kit.box(chrome, -0.13, 0.86, 0.68, 0.13, 0.885, 0.88, "ny py");                 // rear carrier
  for (const s of [-1, 1]) kit.box(chrome, s * 0.11 - 0.012, 0.42, 0.56, s * 0.11 + 0.012, 0.82, 0.59, "ny py");   // rear shock
  for (const s of [-1, 1]) kit.box(chrome, s * 0.07 - 0.016, 0.3, -0.7, s * 0.07 + 0.016, 0.98, -0.66, "ny py");   // fork legs
  kit.box(chrome, -0.33, 1.0, -0.56, 0.33, 1.025, -0.535, "");                    // handlebar
  for (const s of [-1, 1]) kit.box(dk, s > 0 ? 0.24 : -0.34, 0.995, -0.565, s > 0 ? 0.34 : -0.24, 1.03, -0.53, "");   // grips
  kit.box(chrome, -0.09, 0.93, -0.66, 0.09, 1.07, -0.56, "");                     // headlamp shell
  kit.quad(sL(C.head), [0.075, 0.95, -0.67], [-0.075, 0.95, -0.67], [-0.075, 1.05, -0.67], [0.075, 1.05, -0.67], [0, 0, -1]);
  // mudguards follow the tyre instead of lying on it as a plank
  const guard = (zc, a0, a1, hw) => { const r = R + 0.035, n = 5, p = a => [R + r * Math.cos(a), zc + r * Math.sin(a)]; for (let i = 0; i < n; i++) { const [y0, z0] = p(a0 + (a1 - a0) * i / n), [y1, z1] = p(a0 + (a1 - a0) * (i + 1) / n), am = a0 + (a1 - a0) * (i + 0.5) / n, nn = [0, Math.cos(am), Math.sin(am)]; kit.quad(tk, [-hw, y0, z0], [hw, y0, z0], [hw, y1, z1], [-hw, y1, z1], nn); kit.quad(tk, [-hw, y0, z0], [hw, y0, z0], [hw, y1, z1], [-hw, y1, z1], [-nn[0], -nn[1], -nn[2]]); } };
  guard(zR, -0.55, 1.95, 0.075); guard(zF, -1.0, 0.75, 0.06);
  kit.quad(sL(C.tail), [-0.06, 0.8, 0.905], [0.06, 0.8, 0.905], [0.06, 0.86, 0.905], [-0.06, 0.86, 0.905], [0, 0, 1]);
  kit.box(sD(C.plate), -0.09, 0.68, 0.87, 0.09, 0.78, 0.88, "ny");
  const body = personInto(kit, P, 0, 0.9, 0.3, { helmet: false, lean: 0.14 });
  for (const s of [-1, 1]) {
    const elbow = [s * 0.26, body.yC - 0.24, -0.2], knee = [s * 0.2, 0.74, -0.16];
    pkLimb(kit, P, [s * 0.19, body.yC - 0.04, 0.1], elbow, 0.05); pkLimb(kit, P, elbow, [s * 0.29, 1.03, -0.5], 0.042);
    pkLimb(kit, body.pants, [s * 0.12, 0.92, 0.26], knee, 0.075); pkLimb(kit, body.pants, knee, [s * 0.2, 0.38, -0.02], 0.055);
  }
  return finishType({ name: "cd70", wheelbase: 1.22, width: 0.7, wheels: [{ R }], paints: [0xf0efe8, 0xf0efe8, 0x9fb7cf, 0xc6b896, 0x6f7377, 0x2a2d33, 0x4f6b58, 0x8c5a48] }, kit);
}

// CNG auto rickshaw: one front wheel, a stubby cowl, a pressed tub, a canvas hood with a fringe.
function rickshawType() {
  const kit = new Kit(), dk = sD(0x17181b), P = sP, hw = 0.68, zN = -1.3, zW = -0.98, zT = 1.32, hood = sD(0x1a1b1d), yH0 = 1.62, yH1 = 1.72;
  wheelLo(kit, 0.07, -0.86, 0.24, 0.12, 1, 0xb4b8bd, 9); wheelLo(kit, -0.07, -0.86, 0.24, 0.12, -1, 0xb4b8bd, 9);
  for (const s of [-1, 1]) wheelLo(kit, s * 0.6, 0.74, 0.24, 0.14, s, 0xb4b8bd, 9);
  kit.box(P, -hw, 0.32, zW, hw, 0.86, zT, "");                                         // tub
  kit.box(sD(0xf1c21f), -hw - 0.01, 0.62, zW, hw + 0.01, 0.7, zT + 0.01, "ny py");    // yellow waist band
  // short upright nose in front of the windscreen
  kit.quad(P, [-0.5, 0.92, zN], [0.5, 0.92, zN], [0.62, 1.02, zW], [-0.62, 1.02, zW], [0, 1, -0.3]);
  kit.quad(P, [0.5, 0.42, zN], [-0.5, 0.42, zN], [-0.5, 0.92, zN], [0.5, 0.92, zN], [0, 0, -1]);
  kit.quad(P, [0.5, 0.42, zN], [hw, 0.42, zW], [0.62, 1.02, zW], [0.5, 0.92, zN], [1, 0, 0]);
  kit.quad(P, [-hw, 0.42, zW], [-0.5, 0.42, zN], [-0.5, 0.92, zN], [-0.62, 1.02, zW], [-1, 0, 0]);
  for (const s of [-1, 1]) kit.quad(sL(C.head), [s * 0.34 - 0.09, 0.68, zN - 0.012], [s * 0.34 + 0.09, 0.68, zN - 0.012], [s * 0.34 + 0.09, 0.82, zN - 0.012], [s * 0.34 - 0.09, 0.82, zN - 0.012], [0, 0, -1]);
  kit.quad(sD(C.plate), [0.13, 0.5, zN - 0.012], [-0.13, 0.5, zN - 0.012], [-0.13, 0.6, zN - 0.012], [0.13, 0.6, zN - 0.012], [0, 0, -1]);
  kit.box(dk, -0.6, 1.02, zW - 0.02, 0.6, yH0, zW + 0.03, "ny py");                    // windscreen frame
  kit.quad(sD(C.glass), [0.52, 1.07, zW - 0.03], [-0.52, 1.07, zW - 0.03], [-0.52, yH0 - 0.05, zW - 0.03], [0.52, yH0 - 0.05, zW - 0.03], [0, 0, -1]);
  for (const s of [-1, 1]) for (const z of [zW + 0.02, 0.1, zT - 0.05]) kit.box(dk, s * 0.64 - 0.02, 0.86, z - 0.02, s * 0.64 + 0.02, yH0, z + 0.02, "ny py");
  // canvas hood: closed roof and back, sides open over the driver and rolled half way at the rear
  kit.box(hood, -0.68, yH0, zW - 0.12, 0.68, yH1, zT, "");
  kit.quad(hood, [-0.66, 0.86, zT + 0.005], [0.66, 0.86, zT + 0.005], [0.66, yH0, zT + 0.005], [-0.66, yH0, zT + 0.005], [0, 0, 1]);
  for (let i = 0; i < 5; i++) { const x = -0.56 + i * 0.28, c = i % 2 ? sD(0xf1c21f) : sD(0xd2142b); kit.quad(c, [x + 0.13, yH0 - 0.1, zW - 0.13], [x - 0.13, yH0 - 0.1, zW - 0.13], [x - 0.13, yH0, zW - 0.13], [x + 0.13, yH0, zW - 0.13], [0, 0, -1]); }
  for (const s of [-1, 1]) {
    const x = s * 0.665, q = (a, b, c, d) => (s > 0 ? [[x, a, d], [x, a, c], [x, b, c], [x, b, d]] : [[x, a, c], [x, a, d], [x, b, d], [x, b, c]]);
    kit.quad(hood, ...q(1.22, yH0, 0.3, zT), [s, 0, 0]);
    const x0 = s > 0 ? 0.42 : -0.58, x1 = x0 + 0.16;
    kit.quad(sL(C.tail), [x0, 0.62, zT + 0.012], [x1, 0.62, zT + 0.012], [x1, 0.72, zT + 0.012], [x0, 0.72, zT + 0.012], [0, 0, 1]);
  }
  kit.quad(sD(C.plate), [-0.13, 0.42, zT + 0.012], [0.13, 0.42, zT + 0.012], [0.13, 0.52, zT + 0.012], [-0.13, 0.52, zT + 0.012], [0, 0, 1]);
  personInto(kit, sD(0xd8d4c6), 0, 0.76, -0.5, { lean: 0.04 });
  return finishType({ name: "rickshaw", wheelbase: 1.6, width: 1.36, wheels: [{ R: 0.24 }], paints: [0x1f7a4d, 0x1f7a4d, 0x1d5fa8, 0x2c2f34, 0xb5141c] }, kit);
}

// Qingqi: a motorcycle front towing a bench carriage under a flat tin canopy.
function qingqiType() {
  const kit = new Kit(), dk = sD(0x17181b), P = sP, chrome = sD(C.chrome), zF = -1.35, zB0 = -0.25, zB1 = 1.5;
  wheelLo(kit, 0.05, zF, 0.28, 0.1, 1, 0xb4b8bd, 9); wheelLo(kit, -0.05, zF, 0.28, 0.1, -1, 0xb4b8bd, 9);
  for (const s of [-1, 1]) wheelLo(kit, s * 0.62, 0.65, 0.28, 0.13, s, 0xb4b8bd, 9);
  kit.box(dk, -0.08, 0.42, -1.2, 0.08, 0.72, -0.25, "");
  kit.box(sD(0xb5141c), -0.11, 0.72, -1.05, 0.11, 0.9, -0.68, "ny");
  kit.box(dk, -0.03, 0.34, -1.42, 0.03, 0.98, -1.34, "");
  kit.box(chrome, -0.34, 1.0, -1.3, 0.34, 1.03, -1.27, "");
  kit.quad(sL(C.head), [0.08, 0.95, -1.44], [-0.08, 0.95, -1.44], [-0.08, 1.06, -1.44], [0.08, 1.06, -1.44], [0, 0, -1]);
  kit.box(P, -0.72, 0.5, zB0, 0.72, 0.86, zB1, "");
  for (const z of [0.42, 1.1]) kit.box(sD(0x34302c), -0.66, 0.86, z - 0.2, 0.66, 1.0, z + 0.2, "ny");
  for (const s of [-1, 1]) for (const z of [zB0 + 0.03, zB1 - 0.03]) kit.box(chrome, s * 0.69 - 0.02, 0.86, z - 0.02, s * 0.69 + 0.02, 1.86, z + 0.02, "ny py");
  kit.box(P, -0.76, 1.86, zB0 - 0.25, 0.76, 1.92, zB1 + 0.1, "");
  for (let i = 0; i < 6; i++) kit.quad(i % 2 ? sD(0xf5b60f) : sD(0xe9398c), [0.76 - i * 0.2533, 1.78, zB0 - 0.26], [0.76 - (i + 1) * 0.2533, 1.78, zB0 - 0.26], [0.76 - (i + 1) * 0.2533, 1.86, zB0 - 0.26], [0.76 - i * 0.2533, 1.86, zB0 - 0.26], [0, 0, -1]);
  for (const s of [-1, 1]) kit.quad(sL(C.tail), s > 0 ? [0.44, 0.66, zB1 + 0.012] : [-0.62, 0.66, zB1 + 0.012], s > 0 ? [0.62, 0.66, zB1 + 0.012] : [-0.44, 0.66, zB1 + 0.012], s > 0 ? [0.62, 0.76, zB1 + 0.012] : [-0.44, 0.76, zB1 + 0.012], s > 0 ? [0.44, 0.76, zB1 + 0.012] : [-0.62, 0.76, zB1 + 0.012], [0, 0, 1]);
  personInto(kit, sD(0xd8d4c6), 0, 0.84, -0.74, { lean: 0.14 });
  return finishType({ name: "qingqi", wheelbase: 2.0, width: 1.52, wheels: [{ R: 0.28 }], paints: [0x1d5fa8, 0xb5141c, 0x1f7a4d, 0x6a2c8c] }, kit);
}

// Things seen through a bus or van window, laid on the glass: a seat back low down, an aluminium slider rail, a ceiling lamp strip that only shows after dark.
function pkBayDress(kit, xAt, bays, y0, y1, seats = true) {
  const dressed = (s, ya, yb, z0, z1, slot) => { const xa = s * (xAt(ya) + 0.012), xb = s * (xAt(yb) + 0.012); kit.quad(slot, [xa, ya, z0], [xa, ya, z1], [xb, yb, z1], [xb, yb, z0], [s, 0, 0]); };
  for (const s of [-1, 1]) for (const [z0, z1] of bays) {
    const h = y1 - y0, zm = (z0 + z1) / 2;
    if (seats) dressed(s, y0, y0 + h * 0.34, zm - Math.min(0.24, (z1 - z0) * 0.3), zm + Math.min(0.24, (z1 - z0) * 0.3), sD(0x2b3845));
    dressed(s, y0 + h * 0.58, y0 + h * 0.6, z0, z1, sD(0xaeb3b8));
    dressed(s, y1 - h * 0.1, y1 - h * 0.05, z0 + 0.08, z1 - 0.08, sL(0x34291a));
  }
}
// Vertical door lines, a little proud of a flat body side
function pkDoorLine(kit, s, x, y0, y1, z) { const X = s * (x + 0.01); kit.quad(sD(PK_SHUT), [X, y0, z - 0.008], [X, y0, z + 0.008], [X, y1, z + 0.008], [X, y1, z - 0.008], [s, 0, 0]); }

function hiaceType() {
  const T = vanType();
  T.name = "hiace"; T.paints = [0xf1f0ea, 0xf1f0ea, 0xf1f0ea, 0xf1f0ea, 0xe6e4da, 0xc3c7cb];
  T.house.roof = [[-2.1, 1.02], [-1.8, 1.48], [-1.45, 2.02], [-1.2, 2.24], [-0.9, 2.28], [2.74, 2.28]];
  T.houseSlot = houseSlot({ zW: -1.26, zR: 2.74, pillars: [[-0.95, -0.85], [0.4, 0.5], [1.5, 1.6]], pillar: sP, aPillar: sD(C.black), sideSolid: z => z > 2.5, capE: () => sP, glass: sD(PK_GLASS) });
  for (const d of T.decals) if (d.s === sD(C.glass)) d.s = sD(PK_GLASS);
  T.house.rows = [-2.06, -1.76, -1.46, -1.26, -0.95, -0.85, 0.4, 0.5, 1.5, 1.6, 2.5, 2.74];
  const xt = T.extras;
  T.extras = (kit, bm) => {
    xt(kit, bm); kit.box(sD(0x2a2c30), -0.8, 2.28, 0.0, 0.8, 2.33, 2.2, "ny");
    pkBayDress(kit, y => lerp(0.95, 0.885, (y - 1.06) / 1.2), [[-0.85, 0.4], [0.5, 1.5], [1.6, 2.5]], 1.14, 2.14);
    for (const s of [-1, 1]) for (const z of [-0.95, 0.42]) pkDoorLine(kit, s, 0.975, 0.42, 1.04, z);   // cab door and sliding door edges
    pkDoorLine(kit, -1, 0.975, 0.42, 1.04, 1.15);   // ends ahead of the rear wheel arch
    kit.quad(sD(PK_SHUT), [-0.987, 1.0, 0.42], [-0.987, 1.0, 2.1], [-0.987, 1.016, 2.1], [-0.987, 1.016, 0.42], [-1, 0, 0]);   // sliding door rail
  };
  return T;
}

const COASTER_PILLARS = [-2.5, -1.55, -0.6, 0.35, 1.3, 2.25, 3.2];   // bays of about a metre, general knowledge of the type
function coasterType() {
  const zN = -3.3, zT = 3.7, W = 1.01;
  return {
    name: "coaster", wheelbase: 3.94, width: 2.02, paints: [0xf1f0ea, 0xf1f0ea, 0xf1f0ea, 0xe6e4da], crease: 0.9,
    body: {
      zN, zT, noseR: 0.16, tailR: 0.08,
      axles: [{ z: -1.97, y: 0.42, ra: 0.48 }, { z: 1.97, y: 0.42, ra: 0.48 }],
      w: [[zN, W - 0.08], [-3.05, W], [zT - 0.1, W], [zT, W - 0.03]],
      yB: 0.3, ymax: 0.72, ku: 0.1, kt: 0.05, rb: 0.05, rs: 0.04, pw: 3, ysh: 1.14, yt: 1.13,
      features: [-2.9, -2.1, 3.3],
    },
    house: { rows: [-3.1, ...COASTER_PILLARS.flatMap(p => [p, p + 0.11]), 3.4, 3.62], capStart: true, capEnd: true, roundStart: 0.14, roundEnd: 0.08, roof: 2.58, gb: 0.98, gt: 0.92, rr: 0.18, crown: 0.03, inset: 0.004 },
    wheels: [{ x: 0.84, z: -1.97, R: 0.42, w: 0.24 }, { x: 0.8, z: 1.97, R: 0.42, w: 0.4 }],
    bodySlot: bodySlot({ clad: 0x2a2c30, fn: f => (f.part === "side" && f.type === "top" ? null : undefined) }),
    houseSlot: f => {
      if (f.type === "hidden") return null;
      if (f.part === "capS") return f.type === "side" ? sD(PK_GLASS) : sP;
      if (f.part === "capE") return f.type === "side" ? (f.y > 1.5 ? sD(PK_GLASS) : sP) : sP;
      if (f.type === "side") return f.z < 3.4 && !COASTER_PILLARS.some(p => f.z > p && f.z < p + 0.11) ? sD(PK_GLASS) : sP;
      return sP;
    },
    decals: [
      { face: "front", sym: true, x0: 0.58, x1: 0.92, y0: 0.62, y1: 0.8, s: sL(C.head), lamp: 0.4 },
      { face: "front", x0: -0.17, x1: 0.17, y0: 0.42, y1: 0.54, s: sD(C.plate) },
      { face: "front", x0: -0.5, x1: 0.5, y0: 0.66, y1: 0.86, s: sD(C.grille) },
      { face: "rear", sym: true, x0: 0.72, x1: 0.92, y0: 0.72, y1: 1.1, s: sL(C.tail) },
      { face: "rear", x0: -0.17, x1: 0.17, y0: 0.56, y1: 0.68, s: sD(C.plate) },
    ],
    extras: kit => {
      for (const s of [-1, 1]) {
        const x = s * (W + 0.012), q = (a, b) => (s > 0 ? [[x, a, 3.4], [x, a, -3.0], [x, b, -3.0], [x, b, 3.4]] : [[x, a, -3.0], [x, a, 3.4], [x, b, 3.4], [x, b, -3.0]]);
        kit.quad(sD(0x1e5aa8), ...q(0.82, 0.98), [s, 0, 0]);
        kit.quad(sD(0xd2142b), ...q(0.74, 0.8), [s, 0, 0]);
        kit.box(sD(C.dark), s * 1.14 - 0.05, 1.75, -3.46, s * 1.14 + 0.05, 2.1, -3.38);
      }
      kit.box(sD(0x2a2c30), -1.0, 0.34, zN - 0.04, 1.0, 0.5, zN + 0.14, "ny");
      const xAt = y => lerp(0.98, 0.92, (y - 1.14) / 1.41), bays = COASTER_PILLARS.slice(0, -1).map((p, i) => [p + 0.11, COASTER_PILLARS[i + 1]]);
      pkBayDress(kit, xAt, bays, 1.2, 2.34);
      for (const s of [-1, 1]) { const x = xAt(2.4) + 0.012; kit.quad(sD(0x8f9498), [s * x, 2.38, 3.4], [s * x, 2.38, -3.0], [s * x, 2.41, -3.0], [s * x, 2.41, 3.4], [s, 0, 0]); }   // gutter
      for (const z of [-1.62, -0.72]) { pkDoorLine(kit, -1, W, 0.36, 1.12, z); const x = -(xAt(1.2) + 0.014); kit.quad(sD(PK_SHUT), [x, 1.16, z - 0.02], [x, 1.16, z + 0.02], [-(xAt(2.36) + 0.014), 2.36, z + 0.02], [-(xAt(2.36) + 0.014), 2.36, z - 0.02], [-1, 0, 0]); }   // passenger door, kerb side
    },
  };
}

// 18 m Metrobus body. Rigid in one piece so it stays one instance; the concertina is painted on.
// Bus paint is not documented in the brief's sources: red and green here are art direction.
function metrobusType() {
  const zN = -9, zT = 9, W = 1.27, jointA = -0.45, jointB = 0.55, inJoint = z => z > jointA && z < jointB;
  const doors = [[-7.6, -6.5], [-2.5, -1.4], [2.6, 3.7]], inDoor = z => doors.some(([a, b]) => z > a && z < b);
  const bus = [-7.8, -6.2, -4.6, -3.0, -1.5, 1.1, 2.7, 4.3, 5.9, 7.5], inBusPillar = z => bus.some(p => z > p && z < p + 0.13);
  return {
    name: "metrobus", wheelbase: 12, width: 2.55, q: { dz: 3.2 }, paints: [0xb5161f, 0x1f7a3f], crease: 0.9,
    body: {
      zN, zT, noseR: 0.16, tailR: 0.1,
      axles: [{ z: -5.5, y: 0.5, ra: 0.56 }, { z: -1.0 + 0.0, y: 0.5, ra: 0.56 }, { z: 6.2, y: 0.5, ra: 0.56 }],
      w: [[zN, W - 0.06], [-8.8, W], [8.8, W], [zT, W - 0.03]],
      yB: 0.32, ymax: 0.75, ku: 0.1, kt: 0.05, rb: 0.05, rs: 0.04, pw: 3, ysh: 1.15, yt: 1.14,
      features: [...doors.flat(), jointA, jointB],
    },
    house: { rows: [-8.85, ...bus.flatMap(p => [p, p + 0.13]), jointA, jointB, 8.3, 8.86].sort((a, b) => a - b), capStart: true, capEnd: true, roundStart: 0.14, roundEnd: 0.1, roof: 3.1, gb: 1.235, gt: 1.19, rr: 0.2, crown: 0.02, inset: 0.004 },
    wheels: [{ x: 1.07, z: -5.5, R: 0.5, w: 0.3 }, { x: 0.97, z: -1.0, R: 0.5, w: 0.5 }, { x: 0.97, z: 6.2, R: 0.5, w: 0.5 }],
    bodySlot: bodySlot({
      clad: 0x2a2c30,
      fn: f => {
        if (f.part === "side" && f.type === "top") return null;
        if (f.part === "side" && inJoint(f.z) && (f.type === "side" || f.type === "shoulder")) return sD(0x1b1c1e);
        if (f.part === "side" && (f.type === "side" || f.type === "shoulder") && inDoor(f.z) && Math.abs(f.n[0]) > 0.5) return sD(C.glass);
        return undefined;
      },
    }),
    houseSlot: f => {
      if (f.type === "hidden") return null;
      if (f.part === "capS") return f.type === "side" ? sD(PK_GLASS) : sP;
      if (f.part === "capE") return f.type === "side" ? (f.y > 1.9 ? sD(PK_GLASS) : sP) : sP;
      if (inJoint(f.z)) return sD(0x1b1c1e);
      if (f.type === "side") return f.z < 8.3 && !inBusPillar(f.z) ? sD(PK_GLASS) : sP;
      return sP;
    },
    decals: [
      { face: "front", sym: true, x0: 0.78, x1: 1.12, y0: 0.46, y1: 0.62, s: sL(C.head), lamp: 0.4 },
      { face: "front", x0: -0.17, x1: 0.17, y0: 0.48, y1: 0.6, s: sD(C.plate) },
      { face: "front", x0: -0.6, x1: 0.6, y0: 0.66, y1: 0.8, s: sD(C.grille) },
      { face: "rear", sym: true, x0: 0.98, x1: 1.16, y0: 0.5, y1: 1.02, s: sL(C.tail) },
      { face: "rear", x0: -0.17, x1: 0.17, y0: 1.0, y1: 1.12, s: sD(C.plate) },
    ],
    extras: kit => {
      const zH = -8.85 - 0.14 - 0.012;
      kit.quad(sL(C.amber), [-0.9, 2.72, zH], [0.9, 2.72, zH], [0.9, 2.96, zH], [-0.9, 2.96, zH], [0, 0, -1]);
      kit.box(sP, -0.9, 3.09, -6.2, 0.9, 3.3, -3.8, "ny");
      kit.box(sP, -0.9, 3.09, 3.0, 0.9, 3.3, 5.4, "ny");
      for (const z of [-0.3, -0.1, 0.1, 0.3]) kit.box(sD(0x30322f), -1.3, 0.3, z, 1.3, 3.05, z + 0.06, "ny");
      const bays = bus.slice(0, -1).map((p, i) => [p + 0.13, bus[i + 1]]).filter(([a, b]) => b - a < 2 && !(a < jointB && b > jointA));
      pkBayDress(kit, y => lerp(1.235, 1.19, (y - 1.15) / 1.75), bays, 1.2, 2.86, false);
    },
  };
}

// Spawn shares by road setting (brief section 4, column totals 100; gt is the same estimate for
// the GT Road and other trunk roads). Metrobus weight applies only on its corridor (traffic.js).
function pakistanTraffic() {
  const def = (obj, mix, extra = {}) => Object.assign(obj, { mix, weight: Math.max(...Object.values(mix)) / 100 }, extra);
  const hatch = (o) => pkCar({ box: false, glass: PK_GLASS, shut: true, ...o });
  return [
    def(buildType(hatch({ name: "mehran", wb: 2.175, fo: 0.53, L: 3.3, hw: 0.7, h: 1.41, R: 0.26, hood: 0.86, belt: 0.92, cowl: -0.56, ws: -0.1, rEnd: 0.92, tail: 1.12, box: true, paints: PK_OLD_PAINT, chrome: true, lamp: [0.4, 0.66], grille: 0.2, hatch: false })), { isb: 5, rwp: 7, bah: 4, mur: 6, m2: 3, gt: 4 }, { vmax: 21 }),
    def(buildType(hatch({ name: "alto", wb: 2.38, fo: 0.5, L: 3.395, hw: 0.737, h: 1.475, R: 0.27, hood: 0.92, belt: 0.98, cowl: -0.68, ws: -0.26, rEnd: 1.28, tail: 1.46, hatch: true, lamp: [0.42, 0.7], grille: 0.22 })), { isb: 13, rwp: 7, bah: 16, mur: 12, m2: 9, gt: 6 }, { vmax: 25 }),
    def(buildType(hatch({ name: "cultus", wb: 2.425, fo: 0.62, L: 3.6, hw: 0.8, h: 1.54, R: 0.285, hood: 0.96, belt: 1.03, cowl: -0.66, ws: -0.18, rEnd: 1.36, tail: 1.52, hatch: true, lamp: [0.44, 0.72], grille: 0.26 })), { isb: 10, rwp: 6, bah: 10, mur: 10, m2: 10, gt: 6 }),
    def(buildType(hatch({ name: "corolla", wb: 2.7, fo: 0.9, L: 4.63, hw: 0.89, h: 1.475, R: 0.315, hood: 0.92, belt: 1.02, cowl: -0.82, ws: -0.1, rEnd: 1.02, tail: 1.68, lamp: [0.42, 0.74], grille: 0.34 })), { isb: 13, rwp: 6, bah: 13, mur: 14, m2: 20, gt: 10 }),
    def(buildType(hatch({ name: "civic", wb: 2.735, fo: 0.92, L: 4.66, hw: 0.9, h: 1.415, R: 0.32, hood: 0.86, belt: 0.99, cowl: -0.94, ws: -0.18, rEnd: 0.72, tail: 1.8, lamp: [0.46, 0.76], grille: 0.3 })), { isb: 7, rwp: 2, bah: 8, mur: 6, m2: 10, gt: 3 }),
    def(buildType(Object.assign(pickupType(), { name: "hilux", paints: [0xf1f0ea, 0xf1f0ea, 0xf1f0ea, 0xc3c7cb, 0x7c8186, 0x2c2f34, 0x8a7a58], houseSlot: houseSlot({ zW: -0.12, zR: 1.2, pillars: [[0.35, 0.44]], pillar: sD(C.black), sideSolid: z => z > 0.96, capE: () => sP, glass: sD(PK_GLASS) }) })), { isb: 7, rwp: 2, bah: 8, mur: 12, m2: 10, gt: 6 }),
    def(buildType(pkCar({ name: "carry", wb: 2.35, fo: 0.42, L: 3.3, hw: 0.73, h: 1.87, R: 0.26, hood: 0.94, belt: 1.02, cowl: -1.14, ws: -0.82, rEnd: 1.5, tail: 1.58, hatch: true, box: true, paints: [0xf1f0ea, 0xf1f0ea, 0xf1f0ea, 0xd9d4c2, 0x6f94b0, 0x8fa78a], lamp: [0.44, 0.7], grille: 0.24, glass: PK_GLASS, pillar: sP, morePillars: [0.72], shut: true })), { isb: 4, rwp: 6, bah: 3, mur: 5, m2: 1, gt: 5 }, { vmax: 20, slow: true }),
    def(buildType(hiaceType()), { isb: 3, rwp: 5, bah: 2, mur: 12, m2: 10, gt: 7 }),
    def(buildType(coasterType()), { isb: 2, rwp: 3, bah: 1, mur: 6, m2: 10, gt: 8 }, { vmax: 24, slow: true }),
    def(bedfordType(0), { isb: 1, rwp: 0.5, bah: 4, mur: 2.5, m2: 9, gt: 10 }, { vmax: 21, slow: true, isbHighwayOnly: true }),
    def(bedfordType(1), { isb: 1, rwp: 0.5, bah: 4, mur: 2.5, m2: 8, gt: 10 }, { vmax: 20, slow: true, isbHighwayOnly: true }),
    def(rickshawType(), { isb: 2, rwp: 8, bah: 2, mur: 0, m2: 0, gt: 5 }, { vmax: 12.5, slow: true, latH: 1.25 }),
    def(qingqiType(), { isb: 0, rwp: 1, bah: 0, mur: 0, m2: 0, gt: 0 }, { vmax: 10, slow: true, latH: 1.3, sideOnly: true }),
    def(cd70Type(), { isb: 30, rwp: 45, bah: 25, mur: 12, m2: 0, gt: 20 }, { vmax: 16, bike: true, latH: 0.95, tanks: PK_BIKE_TANK }),
    def(buildType(metrobusType()), { isb: 2, rwp: 1, bah: 0, mur: 0, m2: 0, gt: 0 }, { vmax: 15, corridor: true }),
  ];
}

// Pakistani private plates to the brief's section 3: 300 x 150 mm, white with black text.
// kind "ict": dark blue left strip with the mosque motif, two letters and three digits, ICT-ISLAMABAD below.
// kind "punjab": PUNJAB across the top, a plain roundel left, ET&NC right, three digits.
function pkPlateTexture(kind) {
  if (typeof document === "undefined") return null;
  const W = 512, H = 256, cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  g.fillStyle = "#f1f1ec"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#141414"; g.textAlign = "center"; g.textBaseline = "middle";
  if (kind === "punjab") {
    g.font = "bold 40px Arial, sans-serif"; g.fillText("PUNJAB", W / 2, 44);
    g.fillStyle = "#0f6a3a"; g.beginPath(); g.arc(58, 44, 28, 0, 7); g.fill();
    g.fillStyle = "#f1f1ec"; g.beginPath(); g.arc(58, 44, 15, 0, 7); g.fill();
    g.fillStyle = "#141414"; g.font = "bold 20px Arial, sans-serif"; g.fillText("ET&NC", W - 60, 44);
    g.font = "bold 124px Arial, sans-serif"; g.fillText("LXE 482", W / 2, 164);
  } else {
    g.fillStyle = "#1b2f6b"; g.fillRect(0, 0, 92, H);
    g.fillStyle = "#f1f1ec";
    g.beginPath(); g.moveTo(16, 150); g.lineTo(46, 96); g.lineTo(76, 150); g.closePath(); g.fill();                 // mosque motif: tent roof
    for (const x of [14, 34, 58, 78]) { const h = x === 14 || x === 78 ? 76 : 40; g.fillRect(x - 2, 150 - h, 4, h); }
    g.fillRect(14, 150, 64, 8);
    g.fillStyle = "#141414"; g.font = "bold 128px Arial, sans-serif"; g.fillText("AK 482", 92 + (W - 92) / 2, 102);
    g.font = "bold 40px Arial, sans-serif"; g.fillText("ICT-ISLAMABAD", 92 + (W - 92) / 2, 214);
  }
  g.strokeStyle = "#141414"; g.lineWidth = 6; g.strokeRect(3, 3, W - 6, H - 6);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}
// The saloon's glass: the sun's mirror highlight on near-black glass blew out to white blotches, so its roughness has a floor and its output a ceiling.
class SaloonDetailMaterial extends GlossDetailMaterial {
  onBeforeCompile(s) {
    super.onBeforeCompile(s);
    s.fragmentShader = s.fragmentShader.replace("roughnessFactor = mix( roughnessFactor, 0.06, uaeGloss );", "roughnessFactor = mix( roughnessFactor, 0.3, uaeGloss );")
      .replace("#include <opaque_fragment>", `#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
	float saloonPeak = max( outgoingLight.r, max( outgoingLight.g, outgoingLight.b ) );
	outgoingLight *= mix( 1.0, 1.0 / ( 1.0 + 5.0 * saloonPeak ), uaeGloss * ( 1.0 - smoothstep( 0.1, 0.3, vColor.b ) ) );
#endif
#include <opaque_fragment>`);
  }
  customProgramCacheKey() { return "uae-detail-gloss-saloon-v2"; }
}

// Pakistan's default: a white Corolla-class saloon. Overall 4,620 x 1,775 x 1,475 mm on a 2,700 mm wheelbase
// (Corolla Altis figures, propakistani.pk and pakwheels.com); the standard 300 x 150 mm plate, Islamabad by default.
// It has the same interface as the coupe, so the engine needs no other change.
function makePlayerSedan({ color = 0xf3f2ec, beams: withBeams = false } = {}) {
  const wb = 2.7, fo = 0.9, L = 4.62, hw = 0.8875, h = 1.475, R = 0.315, hood = 0.97, belt = 1.05, cowl = -1.0, ws = -0.08, rEnd = 0.92, tail = 1.62;
  const T = pkCar({ name: "player", wb, fo, L, hw, h, R, hood, belt, cowl, ws, rEnd, tail, lamp: [0.42, 0.74], grille: 0.34 });
  // a modern saloon's wedge: a low nose rising to the scuttle, a high short boot
  {
    const zn = T.body.zN, zt = T.body.zT;
    T.body.ysh = [[zn, 0.68], [zn + 0.16, 0.77], [zn + 0.5, 0.86], [cowl, 0.97], [0.3, 0.99], [zt - 0.4, 1.05], [zt - 0.08, 1.03], [zt, 0.98]];
    T.body.yt = [[zn, 0.68], [zn + 0.16, 0.79], [zn + 0.5, 0.885], [cowl, 0.995], [0.3, 1.02], [zt - 0.4, 1.075], [zt - 0.08, 1.05], [zt, 0.99]];
    T.body.ymax = [[zn, 0.5], [zn + 0.5, 0.62], [zt - 0.5, 0.68], [zt, 0.62]];
    T.body.features = [zn + 0.16, zn + 0.5, cowl, zt - 0.4];
  }
  const Q = { ...Q_HI };
  // finer greenhouse rows between the traffic model's stations (the pillar and glass edges stay on their stations)
  const base = T.house.rows.slice(), dense = [];
  for (let i = 0; i < base.length - 1; i++) { dense.push(base[i]); const n = Math.max(1, Math.round((base[i + 1] - base[i]) / 0.08)); for (let k = 1; k < n; k++) dense.push(lerp(base[i], base[i + 1], k / n)); }
  dense.push(base[base.length - 1]);
  T.house.rows = dense;
  const zN = T.body.zN, zT = T.body.zT;
  const group = new THREE.Group(); group.name = "playerCar";
  const body = new THREE.Group(); body.name = "playerBody"; body.position.y = 0.45;
  const shell = new THREE.Group(); shell.position.y = -0.45; body.add(shell); group.add(body);
  const mats = {
    paint: new PkNightPaint({ color, metalness: 0.25, roughness: 0.42, clearcoat: 1, clearcoatRoughness: 0.08 }),   // keeps some colour at night (REVIEW2 item 11)
    detail: new SaloonDetailMaterial({ roughness: 0.55, metalness: 0.1 }),
    head: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff1d6, emissiveIntensity: 0.9, roughness: 0.2 }),
    tail: new THREE.MeshStandardMaterial({ color: 0x4a0508, emissive: 0xff1418, emissiveIntensity: 0.4, roughness: 0.25 }),
    rev: new THREE.MeshStandardMaterial({ color: 0xc9c9c9, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.25 }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.92, metalness: 0, side: THREE.DoubleSide }),
    rim: new THREE.MeshStandardMaterial({ color: 0xb4b8bd, roughness: 0.38, metalness: 0.75, side: THREE.DoubleSide }),
    plate: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0 }),
  };
  let plateTex = pkPlateTexture(pkPlateKind()); if (plateTex) mats.plate.map = plateTex;
  const kit = new Kit();
  const bm = bodyModel(T.body, Q);
  kit.smooth(loft(bm.rows, bm.layout, T.bodySlot, { capStart: true, capEnd: true }), 0.75);
  const hm = houseModel(T.house, bm, Q);
  kit.smooth(loft(hm.rows, hm.layout, T.houseSlot, {}), 0.75);
  decals(kit, [
    { face: "front", sym: true, x0: 0.44, x1: 0.74, y0: 0.6, y1: 0.7, s: { k: "head" }, lamp: 0.7 },
    { face: "front", x0: -0.3, x1: 0.3, y0: 0.6, y1: 0.665, s: sD(C.grille) },
    { face: "front", x0: -0.46, x1: 0.46, y0: 0.27, y1: 0.36, s: sD(C.grille) },
    // tail lamp: a dark housing with three rows of lens on it
    { face: "rear", sym: true, x0: 0.4, x1: 0.745, y0: 0.8, y1: 0.955, s: sD(0x2a0608), off: 0.01 },
    { face: "rear", sym: true, x0: 0.42, x1: 0.74, y0: 0.892, y1: 0.946, s: { k: "tail" }, off: 0.015 },
    { face: "rear", sym: true, x0: 0.545, x1: 0.74, y0: 0.846, y1: 0.884, s: { k: "tail" }, off: 0.015 },
    { face: "rear", sym: true, x0: 0.42, x1: 0.535, y0: 0.846, y1: 0.884, s: { k: "rev" }, off: 0.015 },
    { face: "rear", sym: true, x0: 0.42, x1: 0.625, y0: 0.81, y1: 0.838, s: sD(0x7a0d10), off: 0.015 },
    { face: "rear", sym: true, x0: 0.635, x1: 0.74, y0: 0.81, y1: 0.838, s: sD(0xb5701a), off: 0.015 },
    // boot lid: garnish between the lamps, shut lines down the lamp edges and across above the plate
    { face: "rear", x0: -0.385, x1: 0.385, y0: 0.815, y1: 0.85, s: sD(0x5a6068), off: 0.012 },
    { face: "rear", sym: true, x0: 0.388, x1: 0.396, y0: 0.73, y1: 0.97, s: sD(0x15161a), off: 0.006 },
    { face: "rear", x0: -0.396, x1: 0.396, y0: 0.725, y1: 0.733, s: sD(0x15161a), off: 0.006 },
    // plate recess
    { face: "rear", x0: -0.2, x1: 0.2, y0: 0.525, y1: 0.712, s: sD(0x26272a), off: 0.006 },
    // bumper shut line, then the lower valance and reflectors on the bumper's own face
    { face: "rear", x0: -0.745, x1: 0.745, y0: 0.507, y1: 0.517, s: sD(0x15161a), off: 0.006 },
    { face: "rear", x0: -hw * 0.72, x1: hw * 0.72, y0: 0.3, y1: 0.365, s: sD(C.dark), z: zT + 0.05 },
    { face: "rear", sym: true, x0: 0.5, x1: 0.68, y0: 0.42, y1: 0.445, s: sD(0x7a0d10), z: zT + 0.05 },
  ], zN, zT);
  // the bumper stands proud of the boot panel, stepped in at the corners; a lip finishes the lid
  kit.box(sP, -0.7, 0.3, zT - 0.03, 0.7, 0.5, zT + 0.045);
  kit.box(sP, -0.76, 0.31, zT - 0.04, 0.76, 0.495, zT + 0.018);
  kit.box(sP, -0.62, 0.962, zT - 0.09, 0.62, 0.998, zT + 0.012, "ny");
  kit.box(sD(C.black), 0.46, 0.235, zT - 0.12, 0.58, 0.295, zT + 0.02, "pz");   // exhaust
  kit.box(sD(0x050506), 0.475, 0.245, zT + 0.015, 0.565, 0.285, zT + 0.021, "nz");
  // the lamps wrap round the rear corner onto the wing
  const uAtY = (z, y) => { const p = bm.ring(z); for (let i = 0; i < p.length - 1; i++) if (p[i][1] <= y && p[i + 1][1] > y) return i + (y - p[i][1]) / (p[i + 1][1] - p[i][1]); return p.length - 2; };
  const zW0 = zT - 0.26, zW1 = zT - T.body.tailR, y0W = 0.85, y1W = 0.944;
  for (const side of [-1, 1]) {
    patch(kit, { k: "tail" }, bm, side, 2, 1, (a, b) => { const z = lerp(zW0, zW1, a); return [z, uAtY(z, lerp(y0W, y1W, b))]; }, 0.005);
    const end = y => bm.surf(zW1, uAtY(zW1, y), side).p, r = T.body.tailR, x0 = Math.abs(end(y0W)[0]), x1 = Math.abs(end(y1W)[0]);
    const arc = (t, xe, y) => [side * (xe - r + r * Math.cos(t) + 0.006), y, zW1 + r * Math.sin(t) + 0.006];
    for (let k = 0; k < 3; k++) { const a = k / 3 * Math.PI / 2, b = (k + 1) / 3 * Math.PI / 2; kit.quad({ k: "tail" }, arc(a, x0, y0W), arc(b, x0, y0W), arc(b, x1, y1W), arc(a, x1, y1W), [side * Math.cos((a + b) / 2), 0, Math.sin((a + b) / 2)]); }
  }
  for (const s of [-1, 1]) {                                        // door mirrors
    kit.box(sP, s > 0 ? hw - 0.02 : -hw - 0.12, 1.03, cowl + 0.3, s > 0 ? hw + 0.12 : -hw + 0.02, 1.13, cowl + 0.4, s > 0 ? "nx" : "px");
  }
  // door shut lines and handles
  const uSide0 = Q.floor + Q.nC;
  for (const side of [-1, 1]) {
    for (const zl of [-0.86, 0.33, 1.12]) patch(kit, sD(0x15161a), bm, side, 1, 12, (a, b) => [zl + a * 0.006, uSide0 + 1 + b * (Q.nS + 1.5)], 0.0025);
    for (const zh of [0.2, 0.98]) kit.box(sP, side > 0 ? hw - 0.01 : -hw - 0.02, 0.86, zh - 0.08, side > 0 ? hw + 0.02 : -hw + 0.01, 0.89, zh + 0.08);
  }
  const meshes = [];
  for (const [key, mat, withColor] of [["paint", mats.paint, false], ["detail", mats.detail, true], ["head", mats.head, false], ["tail", mats.tail, false], ["rev", mats.rev, false]]) {
    const b = kit.buckets.get(key); if (!b || !b.tris) continue;
    const m = new THREE.Mesh(mergeVertices(b.geometry(withColor), 1e-5), mat); m.name = "car_" + key; m.castShadow = true; m.receiveShadow = true; shell.add(m); meshes.push(m);
  }
  // plates, front and rear, sitting proud of the bumpers
  const pg1 = new THREE.PlaneGeometry(0.3, 0.15); pg1.rotateY(Math.PI); pg1.translate(0, 0.46, zN - 0.016);
  const pg2 = new THREE.PlaneGeometry(0.3, 0.15); pg2.translate(0, 0.62, zT + 0.014);
  const plateMesh = new THREE.Mesh(mergeGeometriesSimple([pg1, pg2]), mats.plate); plateMesh.name = "car_plates"; shell.add(plateMesh); meshes.push(plateMesh);
  // wheels: silver alloys on 15-inch-class tyres, not children of the body
  const rimR = 0.2, tw = 0.195, fx = tw / 2 - 0.05, axle = wb / 2, wx = hw - 0.12;
  const shared = { tyre: tyreGeometry(R, rimR, tw) };
  const wheels = [];
  for (const [x, z, front] of [[-wx, -axle, true], [wx, -axle, true], [-wx, axle, false], [wx, axle, false]]) {
    const s = Math.sign(x);
    const pivot = new THREE.Group(); pivot.position.set(x, R, z); pivot.name = front ? "wheelPivotFront" : "wheelPivotRear";
    const spin = new THREE.Group(); pivot.add(spin);
    const mir = new THREE.Group(); mir.scale.x = s; spin.add(mir);
    const tyre = new THREE.Mesh(shared.tyre, mats.tyre);
    const face = rimFaceGeometry(rimR, 0.02); face.translate(fx, 0, 0);
    const barrel = new THREE.CylinderGeometry(rimR - 0.005, rimR - 0.005, tw - 0.03, 32, 1, true); barrel.rotateZ(Math.PI / 2);
    const cap = new THREE.CylinderGeometry(0.044, 0.048, 0.02, 20); cap.rotateZ(-Math.PI / 2); cap.translate(fx + 0.03, 0, 0);
    const rim = new THREE.Mesh(mergeGeometriesSimple([face, barrel, cap]), mats.rim);
    mir.add(tyre, rim);
    for (const m of [tyre, rim]) { m.castShadow = true; m.receiveShadow = true; meshes.push(m); }
    group.add(pivot); wheels.push({ pivot, spin, front });
  }
  const beams = [];
  if (withBeams) for (const s of [-1, 1]) { const B = new THREE.SpotLight(0xfff4e0, 0, 80, 0.4, 0.6, 1.6); B.position.set(s * 0.62, 0.68, zN + 0.25); B.target.position.set(s * 1.2, 0, zN - 22); B.castShadow = false; shell.add(B, B.target); beams.push(B); }
  const st = { brake: false, head: false, rev: false, prevSpeed: 0, acc: 0, roll: 0, pitch: 0 };
  const applyLights = () => { mats.head.emissiveIntensity = st.head ? 5 : 0.9; mats.tail.emissiveIntensity = st.brake ? 7 : st.head ? 1.8 : 0.4; mats.rev.emissiveIntensity = st.rev ? 4 : 0; for (const B of beams) B.intensity = st.head ? 30 : 0; };
  applyLights();
  const MAX_STEER = 32 * Math.PI / 180;
  group.updateMatrixWorld(true);
  const ext = new THREE.Box3(); for (const m of meshes) ext.expandByObject(m, true);
  const car = {
    group, body, wheels, beams, materials: mats, lean: true,
    dims: { length: L, width: 2 * hw, height: +ext.max.y.toFixed(3), wheelbase: wb, wheelRadius: R, zFront: +ext.min.z.toFixed(3), zRear: +ext.max.z.toFixed(3), widthWithMirrors: +(ext.max.x - ext.min.x).toFixed(3), trackFront: 2 * wx, trackRear: 2 * wx },
    setBrake(on) { st.brake = !!on; applyLights(); },
    setHeadlights(on) { st.head = !!on; applyLights(); },
    setReverse(on) { st.rev = !!on; applyLights(); },
    setColor(hex) { mats.paint.color.setHex(hex); },
    setPlate(kind) { const t = pkPlateTexture(kind === "punjab" ? "punjab" : "ict"); if (plateTex) plateTex.dispose(); plateTex = t; mats.plate.map = t; mats.plate.needsUpdate = true; },
    update(dt, speedMps = 0, steer = 0) {
      dt = Math.min(Math.max(dt || 0, 0), 0.1);
      const ang = -clamp(steer, -1, 1) * MAX_STEER;
      for (const w of wheels) { if (w.front) w.pivot.rotation.y = ang; w.spin.rotation.x = (w.spin.rotation.x - (speedMps / R) * dt) % (Math.PI * 2); }
      if (dt <= 0) return;
      const acc = (speedMps - st.prevSpeed) / dt; st.prevSpeed = speedMps;
      st.acc += (clamp(acc, -14, 10) - st.acc) * Math.min(1, dt * 5);
      if (!car.lean) return;
      const lat = speedMps * speedMps * Math.tan(-ang) / wb;
      const rollT = clamp(lat * 0.006, -0.06, 0.06);                      // a softer saloon leans a little more than the coupe
      const pitchT = clamp(st.acc * 0.004 - (st.brake && Math.abs(speedMps) > 0.5 ? 0.01 : 0), -0.04, 0.03);
      const k = Math.min(1, dt * 6);
      st.roll += (rollT - st.roll) * k; st.pitch += (pitchT - st.pitch) * k;
      body.rotation.set(st.pitch, 0, st.roll);
    },
    dispose() {
      group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      for (const m of Object.values(mats)) m.dispose();
      for (const g of Object.values(shared)) g.dispose();
      if (plateTex) plateTex.dispose();
      for (const B of beams) B.dispose();
      group.removeFromParent();
    },
    triangles: meshes.reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0),
    drawCalls: meshes.length,
  };
  return car;
}

// Which jurisdiction the player's car is registered in: ?plate=punjab, then CITY.plate, default Islamabad.
function pkPlateKind() {
  let q = null;
  try { q = new URLSearchParams(location.search).get("plate"); } catch (e) { /* no location outside a page */ }
  const k = q || (window.CITY && window.CITY.plate) || "ict";
  return k === "punjab" ? "punjab" : "ict";
}

// Deterministic list of every traffic type, in spawn order. Paints are plausible UAE colours.
export function makeTrafficTypes() {
  if (PK_REGION()) return pakistanTraffic();
  const white = 0xf7f7f5, pearl = 0xefeee8, silver = 0xc3c7cb, grey = 0x7c8186, black = 0x17181b, beige = 0xc9b99a, navy = 0x1f3558, maroon = 0x6e1f26;
  const defs = [
    sedanLike({ name: "sedan", weight: 0.32, paints: [white, white, white, pearl, silver, silver, grey, grey, black, black, beige, navy, maroon] }),
    suvType(),
    sedanLike({ name: "taxi", weight: 0.12, taxi: true, paints: [0xc8161d, 0xc8161d, 0xc8161d, 0xc8161d, 0xd9558c] }),
    pickupType(),
    vanType(),
    busType(),
    truckType(),
    sedanLike({ name: "police", weight: 0.03, police: true, paints: [0xf8f8f6] }),
    supercarType(),
  ];
  return defs.map(buildType);
}
