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

export function makeTrafficMaterials() {
  return {
    paint: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.2 }),
    detail: makeDetailMaterial(),
    lights: makeLightsMaterial(),
  };
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
  const plateTex = plateTexture(plate);
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
  const pg1 = new THREE.PlaneGeometry(0.52, 0.114); pg1.rotateY(Math.PI); pg1.translate(0, 0.262, B.zN - 0.012);
  const pg2 = new THREE.PlaneGeometry(0.52, 0.114); pg2.translate(0, 0.545, zT + 0.012);
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
function wheelLo(kit, x, z, R, w, side, rim = C.rim, n = 12) {
  const y = R, xo = x + side * w / 2, xi = x - side * w / 2, rr = R * 0.63;
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
  const paint = geo("paint", false), detail = geo("detail", true), lights = geo("lights", true);
  const box = new THREE.Box3();
  for (const g of [paint, detail, lights]) { g.computeBoundingBox(); g.computeBoundingSphere(); if (g.boundingBox && isFinite(g.boundingBox.min.x)) box.union(g.boundingBox); }
  const count = g => (g.index ? g.index.count : g.attributes.position.count) / 3;
  const tris = { paint: count(paint), detail: count(detail), lights: count(lights) };
  tris.total = tris.paint + tris.detail + tris.lights;
  if (tris.total > 1500) console.warn(`vehicles.js: traffic type ${T.name} has ${tris.total} triangles`);
  return {
    name: T.name, weight: T.weight,
    length: +(box.max.z - box.min.z).toFixed(3), width: +(T.width ?? (box.max.x - box.min.x)).toFixed(3), height: +box.max.y.toFixed(3),
    zFront: +box.min.z.toFixed(3), zRear: +box.max.z.toFixed(3), wheelbase: T.wheelbase, wheelRadius: T.wheels[0].R,
    paint, detail, lights, paints: T.paints, tris,
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

// Deterministic list of every traffic type, in spawn order. Paints are plausible UAE colours.
export function makeTrafficTypes() {
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
