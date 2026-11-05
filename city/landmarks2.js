// Hand-built procedural models of UAE landmarks, second set (Dubai Marina, Downtown, DIFC, Business Bay,
// Jumeirah, Palm and Abu Dhabi skylines). Same format and conventions as LANDMARKS in landmarks.js:
//
// Metres, Y up, X east, north is -Z. Each build() returns a Group whose origin is the ground-level centre
// of the landmark footprint (the lat/lon of the entry). Models are authored in a canonical frame and the
// engine applies rotation.y = -headingDeg * PI / 180 (headingDeg = clockwise from north). OSM-derived
// coordinates below are local metres (x east, y north) around each landmark's lat/lon, converted to the
// canonical frame with osm2c(). OSM data: Overpass, cached by city/tools/fetch_landmarks2.py.
//
// Every group sets group.userData.nightMats = [{ mat, day, night }] for the engine's day/night lerp.
// Budget per landmark: under 60k triangles, at most 6 draw calls (one merged mesh per material).
//
// The geometry and texture kit below is copied from landmarks.js (only LANDMARKS and disposeLandmark are
// exported there), so this module stands alone.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const DEG = Math.PI / 180;
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------------------------------------ utilities

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// OSM local metres (x east, y north) -> canonical model frame [x, z] for a model rotated by headingDeg.
function osm2c(xE, yN, hDeg) {
  const t = hDeg * DEG, c = Math.cos(t), s = Math.sin(t);
  const xw = xE, zw = -yN;
  return [xw * c + zw * s, -xw * s + zw * c];
}
function osmPoly(pts, hDeg, dx = 0, dy = 0) {
  return pts.map(([x, y]) => osm2c(x - dx, y - dy, hDeg));
}

// Signed area of an [x,z] outline; positive = counter-clockwise seen from above (+Y).
function areaXZ(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return -0.5 * a;
}
function ccw(pts) {
  let p = pts.slice();
  if (p.length > 2) {
    const f = p[0], l = p[p.length - 1];
    if (Math.abs(f[0] - l[0]) < 1e-6 && Math.abs(f[1] - l[1]) < 1e-6) p.pop();
  }
  return areaXZ(p) < 0 ? p.reverse() : p;
}
// Chaikin corner cutting for softened outlines.
function chaikin(pts, iters = 2, keep = 0.25) {
  let p = pts;
  for (let k = 0; k < iters; k++) {
    const out = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      out.push([a[0] * (1 - keep) + b[0] * keep, a[1] * (1 - keep) + b[1] * keep]);
      out.push([a[0] * keep + b[0] * (1 - keep), a[1] * keep + b[1] * (1 - keep)]);
    }
    p = out;
  }
  return p;
}
function centroidXZ(pts) {
  let A = 0, cx = 0, cz = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const c = p[0] * q[1] - q[0] * p[1];
    A += c; cx += (p[0] + q[0]) * c; cz += (p[1] + q[1]) * c;
  }
  A *= 0.5;
  return [cx / (6 * A), cz / (6 * A)];
}
function scalePoly(pts, s, c = centroidXZ(pts)) {
  return pts.map(([x, z]) => [c[0] + (x - c[0]) * s, c[1] + (z - c[1]) * s]);
}
function resamplePoly(pts, n) {
  // evenly resample a closed outline to n points by arc length
  const L = [0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    L.push(L[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = L[L.length - 1], out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const t = (k / n) * total;
    while (L[j + 1] < t) j++;
    const a = pts[j], b = pts[(j + 1) % pts.length], f = (t - L[j]) / Math.max(1e-9, L[j + 1] - L[j]);
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  return out;
}

// ------------------------------------------------------------------------------------------ geometry

function finish(g) {
  if (g.userData.finished) return g;
  if (g.index) g = g.toNonIndexed();
  if (!g.attributes.normal) g.computeVertexNormals();
  {
    // zero-length normals make NaN in the shader, which bloom then smears over the whole frame
    const n = g.attributes.normal.array;
    for (let i = 0; i < n.length; i += 3) {
      const l = n[i] * n[i] + n[i + 1] * n[i + 1] + n[i + 2] * n[i + 2];
      if (!(l > 1e-12)) { n[i] = 0; n[i + 1] = 1; n[i + 2] = 0; }
    }
  }
  g.userData.finished = true;
  if (!g.attributes.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal" && k !== "uv") g.deleteAttribute(k);
  g.morphAttributes = {};
  return g;
}

function fromArrays(pos, nor, uv) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

// Vertical walls of an outline between y0 and y1, optional top/bottom caps.
// opts: su, sv (uv per metre), crease (deg), top, bottom, u0 (uv offset)
function prism(outline, y0, y1, opts = {}) {
  let pts = ccw(outline);
  if (opts.inward) pts = pts.slice().reverse();
  const vOff = opts.vOff ?? 0;
  if (vOff) { const g = prism(outline, y0 - vOff, y1 - vOff, { ...opts, vOff: 0, top: false, bottom: false }); g.translate(0, vOff, 0); const parts = [g]; if (opts.top !== false && !opts.inward) parts.push(capXZ(pts, y1, true, opts.capScale ?? 1 / 20)); return parts.length === 1 ? g : mergeGeometries(parts); }
  const n = pts.length, su = opts.su ?? 1 / 8, sv = opts.sv ?? 1 / 8, crease = Math.cos((opts.crease ?? 35) * DEG);
  const en = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
    en.push([-dz / l, dx / l]);
  }
  const pos = [], nor = [], uv = [];
  let u = opts.u0 ?? 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const nPrev = en[(i - 1 + n) % n], nCur = en[i], nNext = en[(i + 1) % n];
    const dA = nPrev[0] * nCur[0] + nPrev[1] * nCur[1];
    const dB = nNext[0] * nCur[0] + nNext[1] * nCur[1];
    const na = dA > crease ? norm2([nPrev[0] + nCur[0], nPrev[1] + nCur[1]]) : nCur;
    const nb = dB > crease ? norm2([nNext[0] + nCur[0], nNext[1] + nCur[1]]) : nCur;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u1 = u + l * su;
    const A = [a[0], y0, a[1]], B = [b[0], y0, b[1]], C = [b[0], y1, b[1]], D = [a[0], y1, a[1]];
    const NA = [na[0], 0, na[1]], NB = [nb[0], 0, nb[1]];
    pos.push(...A, ...B, ...C, ...A, ...C, ...D);
    nor.push(...NA, ...NB, ...NB, ...NA, ...NB, ...NA);
    uv.push(u, y0 * sv, u1, y0 * sv, u1, y1 * sv, u, y0 * sv, u1, y1 * sv, u, y1 * sv);
    u = u1;
  }
  const parts = [fromArrays(pos, nor, uv)];
  if (opts.top !== false && !opts.inward) parts.push(capXZ(pts, y1, true, opts.capScale ?? 1 / 20));
  if (opts.bottom) parts.push(capXZ(pts, y0, false, opts.capScale ?? 1 / 20));
  return parts.length === 1 ? parts[0] : mergeGeometries(parts);
}
function norm2(v) { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; }

// Flat horizontal cap for an outline at height y (up = normal +Y when up=true), optional holes.
function capXZ(outline, y, up = true, s = 1 / 20, holes = []) {
  const pts = ccw(outline);
  const hs = holes.map((h) => ccw(h).reverse());
  const contour = pts.map(([x, z]) => new THREE.Vector2(x, -z));
  const tris = THREE.ShapeUtils.triangulateShape(contour, hs.map((h) => h.map(([x, z]) => new THREE.Vector2(x, -z))));
  const all = pts.concat(...hs);
  const pos = [], nor = [], uv = [];
  for (const t of tris) {
    let [i, j, k] = t;
    const a = all[i], b = all[j], c = all[k];
    // orientation seen from above
    const cr = (b[0] - a[0]) * (-(c[1] - a[1])) - (-(b[1] - a[1])) * (c[0] - a[0]);
    let order = cr > 0 ? [a, b, c] : [a, c, b];
    if (!up) order = [order[0], order[2], order[1]];
    for (const p of order) { pos.push(p[0], y, p[1]); nor.push(0, up ? 1 : -1, 0); uv.push(p[0] * s, p[1] * s); }
  }
  return fromArrays(pos, nor, uv);
}

// Parametric surface. fn(u, v) -> Vector3. Front face is the side of cross(dP/du, dP/dv) (flip reverses).
// uvFn(u, v) -> [s, t] optional custom uv.
function paramSurface(fn, nu, nv, opts = {}) {
  const u0 = opts.u0 ?? 0, u1 = opts.u1 ?? 1, v0 = opts.v0 ?? 0, v1 = opts.v1 ?? 1;
  const P = [], N = [], UV = [];
  const eu = (u1 - u0) * 1e-4, ev = (v1 - v0) * 1e-4;
  for (let j = 0; j <= nv; j++) {
    const v = v0 + (v1 - v0) * (j / nv);
    for (let i = 0; i <= nu; i++) {
      const u = u0 + (u1 - u0) * (i / nu);
      const p = fn(u, v);
      const pu = fn(u + eu, v).sub(fn(u - eu, v));
      const pv = fn(u, v + ev).sub(fn(u, v - ev));
      const n = new THREE.Vector3().crossVectors(pu, pv);
      if (n.lengthSq() < 1e-20) {
        // degenerate (pole): take the derivatives slightly inside the patch
        const vs = v + (j === nv ? -1 : 1) * (v1 - v0) * 0.01;
        const pv2 = fn(u, vs + ev).sub(fn(u, vs - ev));
        const pu2 = fn(u + eu, vs).sub(fn(u - eu, vs));
        n.crossVectors(pu2, pv2);
      }
      if (n.lengthSq() < 1e-20) n.set(0, 1, 0);
      n.normalize();
      if (opts.flip) n.negate();
      P.push(p); N.push(n);
      UV.push(opts.uvFn ? opts.uvFn(u, v, p) : [u * (opts.su ?? 1), v * (opts.sv ?? 1)]);
    }
  }
  const pos = [], nor = [], uv = [];
  const idx = (i, j) => j * (nu + 1) + i;
  const push = (k) => { const p = P[k], n = N[k]; pos.push(p.x, p.y, p.z); nor.push(n.x, n.y, n.z); uv.push(UV[k][0], UV[k][1]); };
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = idx(i, j), b = idx(i + 1, j), c = idx(i + 1, j + 1), d = idx(i, j + 1);
      if (opts.flip) { push(a); push(c); push(b); push(a); push(d); push(c); }
      else { push(a); push(b); push(c); push(a); push(c); push(d); }
    }
  }
  return fromArrays(pos, nor, uv);
}

// Loft through closed rings (arrays of Vector3, equal counts, CCW from above, going upward).
function loftRings(rings, opts = {}) {
  const n = rings[0].length;
  const su = opts.su ?? 1 / 8, sv = opts.sv ?? 1 / 8;
  const fn = (u, v) => {
    const j = Math.min(rings.length - 1, Math.round(v));
    const i = Math.round(u) % n;
    return rings[j][i].clone();
  };
  // compute smooth normals from neighbours
  const pos = [], nor = [], uv = [];
  const normals = rings.map((ring, j) => ring.map((p, i) => {
    const pn = ring[(i + 1) % n], pp = ring[(i - 1 + n) % n];
    const up = rings[Math.min(rings.length - 1, j + 1)][i], dn = rings[Math.max(0, j - 1)][i];
    const tu = pn.clone().sub(pp), tv = up.clone().sub(dn);
    return new THREE.Vector3().crossVectors(tu, tv).normalize();
  }));
  // arc-length u per ring
  const us = rings.map((ring) => {
    const out = [0];
    for (let i = 0; i < n; i++) out.push(out[i] + ring[i].distanceTo(ring[(i + 1) % n]));
    return out;
  });
  const vs = [0];
  for (let j = 1; j < rings.length; j++) {
    let d = 0;
    for (let i = 0; i < n; i++) d += rings[j][i].distanceTo(rings[j - 1][i]);
    vs.push(vs[j - 1] + d / n);
  }
  const push = (j, i, ii) => {
    const p = rings[j][i % n], nn = normals[j][i % n];
    pos.push(p.x, p.y, p.z); nor.push(nn.x, nn.y, nn.z);
    uv.push(us[j][ii] * su, (opts.vFromY ? p.y : vs[j]) * sv);
  };
  for (let j = 0; j < rings.length - 1; j++) {
    for (let i = 0; i < n; i++) {
      push(j, i, i); push(j, i + 1, i + 1); push(j + 1, i + 1, i + 1);
      push(j, i, i); push(j + 1, i + 1, i + 1); push(j + 1, i, i);
    }
  }
  void fn;
  const parts = [fromArrays(pos, nor, uv)];
  if (opts.capTop) {
    const top = rings[rings.length - 1];
    parts.push(capXZ(top.map((p) => [p.x, p.z]), top[0].y, true, opts.capScale ?? 1 / 20));
  }
  return parts.length === 1 ? parts[0] : mergeGeometries(parts);
}

// Cylinder/tube between two points.
function strut(a, b, r0, r1 = r0, seg = 8) {
  const d = b.clone().sub(a), L = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, L, seg, 1, false);
  g.translate(0, L / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), d.normalize());
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return finish(g);
}
// Box beam between two points (width w across, depth h along 'up' hint).
function beam(a, b, w, h, up = V3(0, 1, 0)) {
  const d = b.clone().sub(a), L = d.length();
  const g = new THREE.BoxGeometry(w, h, L);
  g.translate(0, 0, L / 2);
  const z = d.clone().normalize();
  let x = new THREE.Vector3().crossVectors(up, z);
  if (x.lengthSq() < 1e-6) x = new THREE.Vector3().crossVectors(V3(1, 0, 0), z);
  x.normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  const m = new THREE.Matrix4().makeBasis(x, y, z).setPosition(a);
  g.applyMatrix4(m);
  return finish(g);
}
function tubeAlong(points, radius, radial = 10, closed = false, segs) {
  const curve = new THREE.CatmullRomCurve3(points, closed, "catmullrom", 0.5);
  return finish(new THREE.TubeGeometry(curve, segs ?? points.length * 4, radius, radial, closed));
}
function box(w, h, d, x = 0, y = 0, z = 0, ry = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return finish(g);
}
function cyl(rTop, rBot, h, x = 0, y = 0, z = 0, seg = 16, open = false) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);
  g.translate(x, y + h / 2, z);
  return finish(g);
}
function lathe(profile, seg = 24, x = 0, y = 0, z = 0) {
  const g = new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(Math.max(0, r), h)), seg);
  g.translate(x, y, z);
  return finish(g);
}
// Dome profile helpers: returns [[r, h], ...] from base (r=R) to the top (r=0).
function domeProfile(R, H, shape = "onion", steps = 14) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps; // 0 base -> 1 top
    let r, h;
    if (shape === "hemi") { const a = t * Math.PI / 2; r = R * Math.cos(a); h = H * Math.sin(a); }
    else if (shape === "pointed") { const a = t * Math.PI / 2; r = R * Math.pow(Math.cos(a), 0.9); h = H * Math.sin(a) * (1 - 0.0 * t); r *= (1 - 0.15 * t * t); }
    else { // onion: bulge above the base, then a tapering tip
      const a = t * Math.PI;
      r = R * (1 + 0.12 * Math.sin(Math.min(1, t * 1.6) * Math.PI)) * Math.pow(Math.cos(t * Math.PI / 2), 0.8);
      h = H * (1 - Math.pow(1 - t, 1.6));
      void a;
    }
    out.push([r, h]);
  }
  out[out.length - 1][0] = 0;
  return out;
}

// ------------------------------------------------------------------------------------------ textures
// Small procedural canvas textures, cached and shared between builds (flagged shared so dispose skips them).

const TEX = new Map();
function canvasTex(key, size, draw, { repeat = true, srgb = true, w, h } = {}) {
  if (TEX.has(key)) return TEX.get(key);
  const cw = w ?? size, ch = h ?? size;
  let c;
  if (typeof document !== "undefined") { c = document.createElement("canvas"); c.width = cw; c.height = ch; }
  else c = new OffscreenCanvas(cw, ch);
  const ctx = c.getContext("2d");
  draw(ctx, cw, ch);
  const t = new THREE.CanvasTexture(c);
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.userData.shared = true;
  t.needsUpdate = true;
  TEX.set(key, t);
  return t;
}

// Curtain wall: cols x rows cells in one tile. Returns { map, emissive, orm }.
// orm: G = roughness, B = metalness (glass panes vs metal frame), used with metalness = roughness = 1.
function curtainTex(key, o) {
  const cols = o.cols ?? 8, rows = o.rows ?? 8, size = o.size ?? 256;
  const rnd = mulberry32(o.seed ?? 7);
  const lit = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) lit.push(rnd());
  const paint = (ctx, W, H, frameStyle, glassStyle, spandrelStyle, finStyle, bandStyle) => {
    const cw = W / cols, ch = H / rows;
    const mx = cw * (o.mullion ?? 0.08), my = ch * (o.spandrel ?? 0.22);
    ctx.fillStyle = frameStyle; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      ctx.fillStyle = glassStyle(r, c);
      ctx.fillRect(c * cw + mx / 2, r * ch + my, cw - mx, ch - my);
      if (spandrelStyle) { ctx.fillStyle = spandrelStyle; ctx.fillRect(c * cw + mx / 2, r * ch, cw - mx, my); }
      if (o.fin && finStyle) { ctx.fillStyle = finStyle; ctx.fillRect(c * cw + cw * 0.5 - cw * 0.03, r * ch, cw * 0.06, ch); }
    }
    if (o.band && bandStyle) { ctx.fillStyle = bandStyle; for (let r = 0; r < rows; r++) ctx.fillRect(0, r * ch, W, ch * (o.bandW ?? 0.12)); }
  };
  const map = canvasTex(key + ":map", size, (ctx, W, H) => {
    const r2 = mulberry32((o.seed ?? 7) + 11);
    const g = o.glass ?? [70, 95, 120];
    const tints = [];
    for (let i = 0; i < rows * cols; i++) tints.push(1 + (r2() - 0.5) * (o.vary ?? 0.18));
    paint(ctx, W, H, o.frame ?? "#c9ccd0", (r, c) => {
      const v = tints[r * cols + c];
      return `rgb(${Math.min(255, g[0] * v) | 0},${Math.min(255, g[1] * v) | 0},${Math.min(255, g[2] * v) | 0})`;
    }, o.spandrelColor, o.fin, o.band);
  });
  const rg = (x) => Math.round(x * 255);
  const orm = canvasTex(key + ":orm", size, (ctx, W, H) => {
    const gl = `rgb(0,${rg(o.glassRough ?? 0.06)},${rg(o.glassMetal ?? 0.35)})`;
    const fr = `rgb(0,${rg(o.frameRough ?? 0.35)},${rg(o.frameMetal ?? 0.9)})`;
    const sp = o.spandrelColor ? `rgb(0,${rg(o.spandrelRough ?? 0.3)},${rg(o.spandrelMetal ?? 0.7)})` : null;
    paint(ctx, W, H, fr, () => gl, sp, o.fin ? fr : null, o.band ? fr : null);
  }, { srgb: false });
  const emissive = canvasTex(key + ":em", size, (ctx, W, H) => {
    const cw = W / cols, ch = H / rows;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    const r2 = mulberry32((o.seed ?? 7) + 23);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const k = lit[r * cols + c];
      if (k > (o.litFrac ?? 0.45)) continue;
      const warm = r2() < (o.warm ?? 0.7);
      const b = 0.55 + r2() * 0.45;
      const col = warm ? [255, 214, 150] : [205, 225, 255];
      ctx.fillStyle = `rgb(${col[0] * b | 0},${col[1] * b | 0},${col[2] * b | 0})`;
      const mx = cw * (o.mullion ?? 0.08), my = ch * (o.spandrel ?? 0.22);
      ctx.fillRect(c * cw + mx / 2, r * ch + my, cw - mx, ch - my);
    }
  });
  return { map, emissive, orm };
}
// Glass curtain-wall material from a curtainTex (per-texel metal/roughness, lit windows at night).
function glassMat(K, name, t, o = {}) {
  const m = std(name, {
    color: o.color ?? 0xffffff, map: t.map, metalness: 1, roughness: 1, metalnessMap: t.orm, roughnessMap: t.orm,
    emissive: o.emissive ?? 0xffffff, emissiveMap: t.emissive, envMapIntensity: o.env ?? 1.0,
  });
  return K.nightMat(m, 0, o.night ?? 1.4);
}

// ------------------------------------------------------------------------------------------ build kit

class Kit {
  constructor() { this.buckets = new Map(); this.night = []; this.extra = []; }
  add(mat, geom) {
    if (!geom) return;
    if (!this.buckets.has(mat)) this.buckets.set(mat, []);
    this.buckets.get(mat).push(finish(geom));
  }
  nightMat(mat, day, night) { this.night.push({ mat, day, night }); mat.emissiveIntensity = day; return mat; }
  object(o) { this.extra.push(o); }
  group(name) {
    const g = new THREE.Group();
    g.name = name;
    for (const [mat, list] of this.buckets) {
      const geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
      geo.computeBoundingSphere();
      const m = new THREE.Mesh(geo, mat);
      m.name = mat.name;
      m.castShadow = mat.userData.noShadow ? false : true;
      m.receiveShadow = true;
      g.add(m);
    }
    for (const o of this.extra) g.add(o);
    g.userData.nightMats = this.night;
    return g;
  }
}

function std(name, o) { const m = new THREE.MeshStandardMaterial(o); m.name = name; return m; }
function phys(name, o) { const m = new THREE.MeshPhysicalMaterial(o); m.name = name; return m; }

// ------------------------------------------------------------------------------------------ polygon clip
// Sutherland-Hodgman against the half plane f(p) >= 0.
function clipHalf(poly, f) {
  const out = [];
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n], da = f(a), db = f(b);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}
const clipX = (poly, x0, x1) => clipHalf(clipHalf(poly, (p) => p[0] - x0), (p) => x1 - p[0]);

// ------------------------------------------------------------------------------------------ shared kit 2
const clipAxis = (poly, d, s0, s1) => clipHalf(clipHalf(poly, (p) => p[0] * d[0] + p[1] * d[1] - s0), (p) => s1 - (p[0] * d[0] + p[1] * d[1]));
// keep the part of poly on the left of the directed line a->b (seen from above, x east / -z north)
const clipLine = (poly, a, b, keepSideOf) => {
  const f = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const s = Math.sign(f(keepSideOf)) || 1;
  return clipHalf(poly, (p) => s * f(p));
};
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

// Pointed-arch arcade texture: `n` arches per tile. Returns { map, em } (em = lit arch openings).
function archTex(key, o = {}) {
  const n = o.n ?? 1;
  const draw = (lit) => (ctx, W, H) => {
    ctx.fillStyle = lit ? "#000" : (o.bg ?? "#f3f1ec"); ctx.fillRect(0, 0, W, H);
    const cw = W / n;
    for (let i = 0; i < n; i++) {
      const x0 = i * cw + cw * (o.pier ?? 0.16), x1 = (i + 1) * cw - cw * (o.pier ?? 0.16);
      const yb = H * (o.base ?? 0.98), ys = H * (o.spring ?? 0.42), yt = H * (o.top ?? 0.14);
      const path = () => {
        ctx.beginPath(); ctx.moveTo(x0, yb); ctx.lineTo(x0, ys);
        ctx.quadraticCurveTo(x0, yt + (ys - yt) * 0.25, (x0 + x1) / 2, yt);
        ctx.quadraticCurveTo(x1, yt + (ys - yt) * 0.25, x1, ys); ctx.lineTo(x1, yb); ctx.closePath();
      };
      if (!lit && o.frame) { ctx.save(); ctx.strokeStyle = o.frame; ctx.lineWidth = cw * 0.06; path(); ctx.stroke(); ctx.restore(); }
      path();
      if (lit) { ctx.fillStyle = o.glow ?? "#ffd9a0"; ctx.fill(); }
      else {
        const gr = ctx.createLinearGradient(0, yt, 0, yb);
        gr.addColorStop(0, o.holeTop ?? "#5f6a78"); gr.addColorStop(1, o.hole ?? "#9aa3ad");
        ctx.fillStyle = gr; ctx.fill();
      }
      if (!lit && o.lattice) {
        ctx.save(); path(); ctx.clip(); ctx.strokeStyle = o.lattice; ctx.lineWidth = 1.2;
        for (let k = -H; k < H * 2; k += 9) { ctx.beginPath(); ctx.moveTo(x0, k); ctx.lineTo(x1, k + (x1 - x0)); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x1, k); ctx.lineTo(x0, k + (x1 - x0)); ctx.stroke(); }
        ctx.restore();
      }
    }
    if (!lit && o.band) { ctx.fillStyle = o.band; ctx.fillRect(0, 0, W, H * 0.06); }
  };
  return { map: canvasTex(key + ":map", o.size ?? 128, draw(false)), em: canvasTex(key + ":em", o.size ?? 128, draw(true)) };
}

// Drum + dome (+ optional finial) as one geometry, base at y = 0.
function domeGeom(rDrum, hDrum, rDome, hDome, shape = "onion", seg = 20, steps = 10) {
  const parts = [];
  if (hDrum > 0) parts.push(cyl(rDrum, rDrum, hDrum, 0, 0, 0, seg, true));
  if (hDrum > 0 && rDome > rDrum) parts.push(lathe([[rDrum, 0], [rDome, 0.01]], seg, 0, hDrum, 0));
  parts.push(lathe(domeProfile(rDome, hDome, shape, steps), seg, 0, hDrum, 0));
  return mergeGeometries(parts.map(finish));
}
function finialGeom(r, h, seg = 8) {
  return mergeGeometries([
    lathe([[r * 0.9, 0], [r, h * 0.1], [r * 0.2, h * 0.25], [r * 0.55, h * 0.35], [r * 0.2, h * 0.45], [r * 0.12, h * 0.8], [0, h]], seg),
  ].map(finish));
}
function instanced(K, geom, mat, list, name) {
  const g = finish(geom);
  const im = new THREE.InstancedMesh(g, mat, list.length);
  im.name = name || mat.name;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  list.forEach((p, i) => {
    q.setFromAxisAngle(V3(0, 1, 0), p.ry || 0);
    s.set(p.s ?? 1, p.sy ?? p.s ?? 1, p.s ?? 1);
    m.compose(V3(p.x, p.y, p.z), q, s);
    im.setMatrixAt(i, m);
  });
  im.castShadow = true; im.receiveShadow = true;
  im.computeBoundingSphere();
  K.object(im);
  return im;
}
const marble = (K, name, o = {}) => K.nightMat(std(name, { color: o.color ?? 0xf6f4ee, roughness: o.rough ?? 0.38, metalness: 0, emissive: o.emissive ?? 0x9fb2ff }), 0, o.night ?? 0.3);
const goldMat = (name) => std(name, { color: 0xe0b45a, roughness: 0.28, metalness: 1.0 });

// ------------------------------------------------------------------------------------------ kit additions
const TAU = Math.PI * 2;
function rectPoly(w, d, cx = 0, cz = 0) { const a = w / 2, b = d / 2; return [[cx - a, cz - b], [cx + a, cz - b], [cx + a, cz + b], [cx - a, cz + b]]; }
function chamferRect(w, d, c, cx = 0, cz = 0) {
  const a = w / 2, b = d / 2;
  return [[cx - a + c, cz - b], [cx + a - c, cz - b], [cx + a, cz - b + c], [cx + a, cz + b - c], [cx + a - c, cz + b], [cx - a + c, cz + b], [cx - a, cz + b - c], [cx - a, cz - b + c]];
}
function ngon(n, r, rot = 0, cx = 0, cz = 0) {
  const out = [];
  for (let i = 0; i < n; i++) { const a = rot + (i / n) * TAU; out.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]); }
  return out;
}
function superEllipse(a, b, e, n = 64, rot = 0) {
  const out = [], c = Math.cos(rot), s = Math.sin(rot);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU, ct = Math.cos(t), st = Math.sin(t);
    const x = a * Math.sign(ct) * Math.pow(Math.abs(ct), 2 / e), z = b * Math.sign(st) * Math.pow(Math.abs(st), 2 / e);
    out.push([x * c - z * s, x * s + z * c]);
  }
  return out;
}
function rotPoly(pts, ang) { const c = Math.cos(ang), s = Math.sin(ang); return pts.map(([x, z]) => [x * c - z * s, x * s + z * c]); }
function movePoly(pts, dx, dz) { return pts.map(([x, z]) => [x + dx, z + dz]); }
// Miter offset of a (ccw-normalised) outline: d > 0 grows it, d < 0 shrinks it.
function offsetPoly(outline, d) {
  const p = ccw(outline), n = p.length, out = [];
  const en = [];
  for (let i = 0; i < n; i++) { const a = p[i], b = p[(i + 1) % n]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; en.push([-(b[1] - a[1]) / l, (b[0] - a[0]) / l]); }
  for (let i = 0; i < n; i++) {
    const n1 = en[(i - 1 + n) % n], n2 = en[i];
    const m = norm2([n1[0] + n2[0], n1[1] + n2[1]]);
    const k = d / Math.max(0.25, m[0] * n1[0] + m[1] * n1[1]);
    out.push([p[i][0] + m[0] * k, p[i][1] + m[1] * k]);
  }
  return out;
}
// Outline with a material tag per edge (edge i runs from vertex i to i+1), normalised to ccw.
function tagged(pts, tags) {
  if (areaXZ(pts) >= 0) return { pts, tags };
  const n = pts.length;
  return { pts: pts.slice().reverse(), tags: pts.map((_, j) => tags[((n - 2 - j) % n + n) % n]) };
}
// Walls of only the edges whose tag is `want` (uv u runs continuously around the whole loop).
function wallsTagged(T, want, y0, y1, opts = {}) {
  const pts = T.pts, n = pts.length, su = opts.su ?? 1 / 8, sv = opts.sv ?? 1 / 8, crease = Math.cos((opts.crease ?? 35) * DEG);
  const en = [];
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; en.push([-(b[1] - a[1]) / l, (b[0] - a[0]) / l]); }
  const pos = [], nor = [], uv = [];
  let u = opts.u0 ?? 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u1 = u + l * su;
    if (T.tags[i] === want) {
      const nP = en[(i - 1 + n) % n], nC = en[i], nN = en[(i + 1) % n];
      const na = nP[0] * nC[0] + nP[1] * nC[1] > crease ? norm2([nP[0] + nC[0], nP[1] + nC[1]]) : nC;
      const nb = nN[0] * nC[0] + nN[1] * nC[1] > crease ? norm2([nN[0] + nC[0], nN[1] + nC[1]]) : nC;
      pos.push(a[0], y0, a[1], b[0], y0, b[1], b[0], y1, b[1], a[0], y0, a[1], b[0], y1, b[1], a[0], y1, a[1]);
      nor.push(na[0], 0, na[1], nb[0], 0, nb[1], nb[0], 0, nb[1], na[0], 0, na[1], nb[0], 0, nb[1], na[0], 0, na[1]);
      uv.push(u, y0 * sv, u1, y0 * sv, u1, y1 * sv, u, y0 * sv, u1, y1 * sv, u, y1 * sv);
    }
    u = u1;
  }
  return fromArrays(pos, nor, uv);
}
// Planar polygon in 3D (convex, ordered), fan triangulated, normal flipped to face `toward` if given.
function facet(points, toward, uvScale = 1 / 10) {
  const a = points[0], b = points[1], c = points[2];
  const nrm = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
  let pts = points;
  if (toward && nrm.dot(toward) < 0) { pts = points.slice().reverse(); nrm.negate(); }
  nrm.normalize();
  const t1 = pts[1].clone().sub(pts[0]).normalize(), t2 = new THREE.Vector3().crossVectors(nrm, t1);
  const pos = [], nor = [], uv = [];
  for (let i = 1; i < pts.length - 1; i++) {
    for (const p of [pts[0], pts[i], pts[i + 1]]) {
      pos.push(p.x, p.y, p.z); nor.push(nrm.x, nrm.y, nrm.z);
      const d = p.clone().sub(pts[0]); uv.push(d.dot(t1) * uvScale, d.dot(t2) * uvScale);
    }
  }
  return fromArrays(pos, nor, uv);
}
// Blocks (merlons, fins) spaced along a closed outline, facing outward.
function teethAlong(outline, y, h, w, gap, depth, inset = 0) {
  const p = ccw(outline), n = p.length, parts = [];
  let L = 0; const seg = [];
  for (let i = 0; i < n; i++) { const a = p[i], b = p[(i + 1) % n]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]); seg.push([a, b, l, L]); L += l; }
  const count = Math.max(4, Math.round(L / (w + gap)));
  for (let k = 0; k < count; k++) {
    const t = ((k + 0.5) / count) * L;
    const s = seg.find((q) => t >= q[3] && t <= q[3] + q[2]) || seg[seg.length - 1];
    const f = (t - s[3]) / (s[2] || 1), a = s[0], b = s[1];
    const x = a[0] + (b[0] - a[0]) * f, z = a[1] + (b[1] - a[1]) * f;
    const nx = -(b[1] - a[1]) / (s[2] || 1), nz = (b[0] - a[0]) / (s[2] || 1);
    const ry = Math.atan2(nx, nz);
    parts.push(box(w, h, depth, x - nx * (depth / 2 + inset), y + h / 2, z - nz * (depth / 2 + inset), ry));
  }
  return mergeGeometries(parts);
}
// Facade texture set painted by one function in three modes: "map", "orm" (G rough, B metal), "em" (lit).
function facadeSet(key, painter, { w = 256, h = 256 } = {}) {
  return {
    map: canvasTex(key + ":map", w, (ctx, W, H) => painter(ctx, W, H, "map", mulberry32(7)), { w, h }),
    orm: canvasTex(key + ":orm", w, (ctx, W, H) => painter(ctx, W, H, "orm", mulberry32(7)), { w, h, srgb: false }),
    em: canvasTex(key + ":em", w, (ctx, W, H) => painter(ctx, W, H, "em", mulberry32(7)), { w, h }),
  };
}
function facadeMat(K, name, set, night = 1.3, o = {}) {
  const m = std(name, {
    color: o.color ?? 0xffffff, map: set.map, metalness: 1, roughness: 1, metalnessMap: set.orm, roughnessMap: set.orm,
    emissive: o.emissive ?? 0xffffff, emissiveMap: set.em, envMapIntensity: o.env ?? 1.0, side: o.side ?? THREE.FrontSide,
  });
  return K.nightMat(m, o.day ?? 0, night);
}
const ORM = (rough, metal) => `rgb(0,${Math.round(rough * 255)},${Math.round(metal * 255)})`;
// Lit-window colour for the emissive pass (warm or cool, varying brightness).
function litColor(rnd, warmFrac = 0.7) {
  const warm = rnd() < warmFrac, b = 0.55 + rnd() * 0.45, c = warm ? [255, 212, 148] : [205, 226, 255];
  return `rgb(${c[0] * b | 0},${c[1] * b | 0},${c[2] * b | 0})`;
}
// Striped texture (vertical ribs), used on domes and crowns.
function stripeTex(key, a, b, n = 8, frac = 0.35) {
  return canvasTex(key, 128, (ctx, W, H) => {
    ctx.fillStyle = a; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = b;
    for (let i = 0; i < n; i++) ctx.fillRect((i + 0.5 - frac / 2) * W / n, 0, (W / n) * frac, H);
  });
}
function cylinderWall(r, y0, y1, seg, su, sv, x = 0, z = 0) {
  return paramSurface((u, v) => V3(x + r * Math.cos(u * TAU), y0 + v * (y1 - y0), z - r * Math.sin(u * TAU)), seg, 1, {
    uvFn: (u, v) => [u * TAU * r * su, (y0 + v * (y1 - y0)) * sv],
  });
}

// ================================================================================================
// 1. PRINCESS TOWER (Dubai Marina)
// OSM part w186351092 (height 357, 101 levels): a 37.6 m square turned 45.4 deg; crown parts w295954577
// (drum, 36 m, 357-370), w288039567 (dome, 370-387) and the spire w295954576 (387-414). Beige stone frame
// and blue-grey glass, gently bowed balcony bays in the middle of each face, windows round the corners.
// The crown steps back behind two rings of crenellated teeth to a vertically striped gold dome and spire.
// Canonical: faces on +-X / +-Z, headingDeg = 45.4.
// ================================================================================================
function buildPrincessTower() {
  const K = new Kit();
  const FH = 3.45;
  const fac = facadeSet("pt-fac", (ctx, W, H, mode, rnd) => {
    // 3 bays x 4 floors: beige pilasters and spandrels, tall blue-grey windows
    const cols = 3, rows = 4, cw = W / cols, rh = H / rows;
    ctx.fillStyle = mode === "map" ? "#c9b89d" : mode === "orm" ? ORM(0.7, 0.05) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * cw + cw * 0.17, y = r * rh + rh * 0.2, w = cw * 0.66, h = rh * 0.72;
      if (mode === "map") { const v = 0.9 + rnd() * 0.2; ctx.fillStyle = `rgb(${52 * v | 0},${72 * v | 0},${86 * v | 0})`; }
      else if (mode === "orm") ctx.fillStyle = ORM(0.08, 0.6);
      else ctx.fillStyle = rnd() < 0.42 ? litColor(rnd) : "#000";
      ctx.fillRect(x, y, w, h);
      if (mode === "map") { ctx.fillStyle = "rgba(230,220,200,0.9)"; ctx.fillRect(x + w / 2 - 1, y, 2, h); }
    }
    if (mode === "map") { ctx.fillStyle = "#b3a184"; for (let r = 0; r < rows; r++) ctx.fillRect(0, r * rh, W, rh * 0.05); }
  });
  const bal = facadeSet("pt-bal", (ctx, W, H, mode, rnd) => {
    // 1 floor per 64 px: white bowed balcony slab edge over a glass balustrade, dark glass behind
    const rows = 4, rh = H / rows;
    ctx.fillStyle = mode === "map" ? "#2e3f4b" : mode === "orm" ? ORM(0.1, 0.55) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) {
      if (mode === "em") { for (let c = 0; c < 4; c++) if (rnd() < 0.45) { ctx.fillStyle = litColor(rnd); ctx.fillRect(c * W / 4 + 4, r * rh + rh * 0.3, W / 4 - 8, rh * 0.62); } continue; }
      ctx.fillStyle = mode === "map" ? "#efeae0" : ORM(0.55, 0.05); ctx.fillRect(0, r * rh, W, rh * 0.2);
      ctx.fillStyle = mode === "map" ? "rgba(150,175,190,0.9)" : ORM(0.1, 0.4); ctx.fillRect(0, r * rh + rh * 0.2, W, rh * 0.22);
      if (mode === "map") { ctx.fillStyle = "#1f2c35"; for (let c = 0; c < 4; c++) ctx.fillRect(c * W / 4, r * rh + rh * 0.42, 3, rh * 0.58); }
    }
  });
  const facade = facadeMat(K, "pt_facade", fac, 1.3);
  const balc = facadeMat(K, "pt_balcony", bal, 1.3);
  const domeTex = stripeTex("pt-dome", "#d7b36a", "#f3e3b5", 12, 0.3);
  const gold = K.nightMat(std("pt_gold", { color: 0xffffff, map: domeTex, metalness: 0.95, roughness: 0.3, emissive: 0xffc46a, emissiveMap: domeTex }), 0, 1.25);
  const stone = K.nightMat(std("pt_stone", { color: 0xcdbd9f, roughness: 0.75, metalness: 0.05, emissive: 0xffd9a0 }), 0, 0.12);

  const a = 18.8, c = 3.4, bw = 7.2, rd = 1.8;
  // one face (normal +Z) from x = -(a - c) to +(a - c), then rotated round the four sides
  const face = [[[-(a - c), a], "f"], [[-bw, a], "b"]];
  const NA = 10;
  for (let i = 0; i <= NA; i++) { const x = -bw + (2 * bw * i) / NA; face.push([[x, a - rd + (rd - 0.25) * (1 - (x / bw) ** 2)], "b"]); }
  face.push([[bw, a], "f"], [[a - c, a], "f"]);
  const pts = [], tags = [];
  for (let k = 0; k < 4; k++) for (const [[x, z], t] of face) {
    let p = [x, z];
    for (let r = 0; r < k; r++) p = [p[1], -p[0]];
    pts.push(p); tags.push(t);
  }
  const T = tagged(pts, tags);
  const SV = 1 / (4 * FH);
  const Y1 = 330;
  K.add(facade, wallsTagged(T, "f", 0, Y1, { su: 1 / 9.6, sv: SV, crease: 20 }));
  K.add(balc, wallsTagged(T, "b", 0, Y1, { su: 1 / 6, sv: SV, crease: 50 }));
  // shallow cornices marking the facade sections and the base
  for (const y of [22, 110, 200, 268]) K.add(stone, prism(offsetPoly(T.pts, 0.45), y, y + 1.4, { su: 1 / 8, sv: 1 / 8, bottom: true }));
  K.add(stone, capXZ(T.pts, Y1, true));
  // crown tier 1: chamfered square with the upper crosscut pattern, crenellated teeth on top
  const t1 = chamferRect(36.6, 36.6, 7);
  K.add(facade, prism(t1, Y1, 346, { su: 1 / 9.6, sv: SV, top: false, crease: 20 }));
  K.add(stone, capXZ(t1, 346, true));
  K.add(stone, prism(offsetPoly(t1, 0.4), 346, 347.2, { top: false }));
  K.add(gold, teethAlong(t1, 347.2, 3.6, 1.5, 1.3, 0.9, -0.2));
  // drum: glazed, gold ribs, second ring of teeth
  const RD = 15.6;
  K.add(facade, cylinderWall(RD, 346, 362, 40, 1 / 9.6, SV));
  K.add(stone, prism(ngon(40, RD + 0.6), 362, 363.2, { bottom: true, top: false }));
  K.add(gold, teethAlong(ngon(40, RD + 0.6), 363.2, 3.0, 1.3, 1.2, 0.8, 0));
  for (let i = 0; i < 16; i++) { const t = (i / 16) * TAU; K.add(gold, box(1.0, 16, 0.8, Math.cos(t) * (RD + 0.3), 354, -Math.sin(t) * (RD + 0.3), Math.PI / 2 - t)); }
  // dome: slightly pointed, vertical gold stripes (uv u wraps 12 x round)
  const RDm = 15.0, HDm = 22, YD = 364;
  K.add(gold, paramSurface((u, v) => {
    const t = u * TAU, r = RDm * Math.pow(Math.cos(v * Math.PI / 2), 0.85) * (1 + 0.06 * Math.sin(v * Math.PI));
    return V3(r * Math.cos(t), YD + HDm * Math.sin(v * Math.PI / 2) ** 1.1, -r * Math.sin(t));
  }, 48, 14, { uvFn: (u, v) => [u * 4, v] }));
  // spire: stacked tapering shafts with rings and a ball
  K.add(gold, cyl(1.4, 2.4, 8, 0, YD + HDm - 1, 0, 12));
  K.add(gold, cyl(0.25, 1.4, 414 - (YD + HDm + 7), 0, YD + HDm + 7, 0, 10));
  for (const [y, r] of [[YD + HDm + 9, 2.0], [YD + HDm + 13, 1.6]]) K.add(gold, cyl(r, r, 0.8, 0, y, 0, 12));
  K.add(gold, lathe(domeProfile(1.6, 3.2, "hemi", 6).map(([r, h]) => [r, h]).concat([]), 10, 0, YD + HDm + 15, 0));
  return K.group("princess_tower");
}

// ================================================================================================
// 2. MARINA 101
// OSM part w195527261 ("Marina 101", 101 levels): a 38 m square turned 40.3 deg. 425 m to the top of the
// crown, roof ~390 m. Two-tone aluminium cladding (white verticals over blue-green glass), recessed corners,
// and a 45 m crown of sky-blue angular aluminium panels converging to a four-point pinnacle, lit at night.
// Canonical: faces on +-X / +-Z, headingDeg = 40.3.
// ================================================================================================
function buildMarina101() {
  const K = new Kit();
  const FH = 3.8;
  const fac = facadeSet("m101-fac", (ctx, W, H, mode, rnd) => {
    // 4 bays x 4 floors: white aluminium verticals, silver spandrel, blue-green glass
    const cols = 4, rows = 4, cw = W / cols, rh = H / rows;
    ctx.fillStyle = mode === "map" ? "#dfe6ea" : mode === "orm" ? ORM(0.35, 0.8) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * cw + cw * 0.14, y = r * rh + rh * 0.16, w = cw * 0.72, h = rh * 0.8;
      if (mode === "map") { const v = 0.92 + rnd() * 0.16; ctx.fillStyle = `rgb(${58 * v | 0},${104 * v | 0},${122 * v | 0})`; }
      else if (mode === "orm") ctx.fillStyle = ORM(0.06, 0.55);
      else ctx.fillStyle = rnd() < 0.4 ? litColor(rnd, 0.6) : "#000";
      ctx.fillRect(x, y, w, h);
    }
    if (mode === "map") { ctx.fillStyle = "#9fb3bd"; for (let r = 0; r < rows; r++) ctx.fillRect(0, r * rh + rh * 0.04, W, rh * 0.1); }
  });
  const facade = facadeMat(K, "m101_facade", fac, 1.3);
  const white = K.nightMat(std("m101_white", { color: 0xeef2f4, roughness: 0.4, metalness: 0.5, emissive: 0xdfeaff }), 0, 0.6);
  const crownTex = canvasTex("m101-crown", 128, (ctx, W, H) => {
    ctx.fillStyle = "#8fc7e6"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#5f9fc4"; ctx.lineWidth = 3;
    for (let i = 0; i <= 4; i++) { ctx.beginPath(); ctx.moveTo(i * W / 4, 0); ctx.lineTo(i * W / 4, H); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i * H / 4); ctx.lineTo(W, i * H / 4); ctx.stroke(); }
  });
  const crown = K.nightMat(std("m101_crown", { color: 0xffffff, map: crownTex, roughness: 0.3, metalness: 0.75, emissive: 0x9fdcff, emissiveMap: crownTex, side: THREE.DoubleSide }), 0, 1.1);

  const a = 19, nch = 2.4;
  const plan = (h, n) => [[-h + n, -h], [h - n, -h], [h - n, -h + n], [h, -h + n], [h, h - n], [h - n, h - n], [h - n, h], [-h + n, h], [-h + n, h - n], [-h, h - n], [-h, -h + n], [-h + n, -h + n]];
  const SV = 1 / (4 * FH), SU = 1 / 12;
  const p0 = plan(a, nch);
  K.add(facade, prism(p0, 0, 372, { su: SU, sv: SV, top: false, crease: 10 }));
  // white mechanical belts and corner piers
  for (const y of [96, 192, 288]) K.add(white, prism(offsetPoly(p0, 0.35), y, y + 3.2, { top: false, bottom: true, su: 1 / 8, sv: 1 / 8 }));
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) K.add(white, box(1.2, 380, 1.2, sx * (a - nch), 190, sz * (a - nch)));
  // top floors, slightly set back
  const p1 = plan(a - 1.2, nch);
  K.add(facade, prism(p1, 372, 392, { su: SU, sv: SV, top: false, crease: 10 }));
  K.add(white, prism(offsetPoly(p1, 0.4), 390, 393.5, { su: 1 / 8, sv: 1 / 8, bottom: true }));
  // crown: four inward-leaning panels whose top edges dip in the middle, so every corner rises as a point;
  // a slender four-sided pinnacle stands in the middle and runs up to 425 m
  const B = a - 1.6, Y0 = 393.5, YT = 415, T = 9.0, YM = 401.5;
  const zAt = (y) => B - (B - T) * (y - Y0) / (YT - Y0);
  for (let k = 0; k < 4; k++) {
    const ang = k * Math.PI / 2, c = Math.cos(ang), s = Math.sin(ang);
    const R = (x, y, z) => V3(x * c - z * s, y, x * s + z * c);
    const c0 = R(-B, Y0, B), c1 = R(B, Y0, B), t0 = R(-T, YT, T), t1 = R(T, YT, T), m = R(0, YM, zAt(YM));
    const out = R(0, 0, 1);
    K.add(crown, facet([c0, c1, m], out, 1 / 6));
    K.add(crown, facet([c0, m, t0], out, 1 / 6));
    K.add(crown, facet([c1, t1, m], out, 1 / 6));
    // lit white edges: the corner ridges and the dipping top edges
    K.add(white, beam(c1, t1, 0.7, 0.7));
    K.add(white, beam(t0, m, 0.5, 0.5));
    K.add(white, beam(m, t1, 0.5, 0.5));
  }
  const pin = lathe([[8 * Math.SQRT2, 0], [6.2, 8], [3.2, 20], [1.2, 27], [0, 425 - Y0]], 4, 0, 0, 0);
  pin.rotateY(Math.PI / 4); pin.translate(0, Y0, 0);
  K.add(crown, pin);
  // three-storey podium (OSM w1074877791, whose centroid falls under the tower, so it is suppressed too)
  const pod = osmPoly([[2.0, -44.0], [-43.4, -4.1], [-6.0, 37.2], [40.9, -3.9]], 40.3);
  K.add(white, prism(pod, 0, 12, { su: 1 / 8, sv: 1 / 4, top: true }));
  return K.group("marina_101");
}

// ================================================================================================
// 3. 23 MARINA
// OSM part w907717855 (height 395, roof:shape pyramidal, roof:height 50): a regular octagon, apothem
// 19.6 m, face normals at bearing 265.6 deg; spire part w186351102 (393). 392.4 m to the tip, 88 levels.
// White cladding and blue glass in multi-storey frames on the four main faces, balcony bands on the
// diagonals, and a tall pointed canopy of white ribs over the rooftop terrace, lit at night.
// Canonical: faces on +-X / +-Z and the diagonals, headingDeg = -4.4.
// ================================================================================================
function buildMarina23() {
  const K = new Kit();
  const FH = 3.85;
  const frames = facadeSet("m23-fr", (ctx, W, H, mode, rnd) => {
    // 2 frames across x 2 frames up, each frame = 2 floors, thick white surround, blue glass
    ctx.fillStyle = mode === "map" ? "#f1f2f0" : mode === "orm" ? ORM(0.5, 0.15) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
      const x = c * W / 2 + W * 0.05, y = r * H / 2 + H * 0.06, w = W / 2 - W * 0.1, h = H / 2 - H * 0.12;
      if (mode === "map") { ctx.fillStyle = "#3b6f95"; ctx.fillRect(x, y, w, h); ctx.fillStyle = "#e8ecee"; ctx.fillRect(x, y + h / 2 - 2, w, 4); ctx.fillRect(x + w / 2 - 1.5, y, 3, h); }
      else if (mode === "orm") { ctx.fillStyle = ORM(0.07, 0.55); ctx.fillRect(x, y, w, h); }
      else { for (const yy of [y, y + h / 2]) if (rnd() < 0.45) { ctx.fillStyle = litColor(rnd); ctx.fillRect(x, yy + 3, w, h / 2 - 6); } }
    }
  });
  const bands = facadeSet("m23-bd", (ctx, W, H, mode, rnd) => {
    // 4 floors: blue glass with thin white balcony edges and glass balustrades
    const rows = 4, rh = H / rows;
    ctx.fillStyle = mode === "map" ? "#3e7399" : mode === "orm" ? ORM(0.07, 0.55) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) {
      if (mode === "em") { for (let c = 0; c < 3; c++) if (rnd() < 0.45) { ctx.fillStyle = litColor(rnd); ctx.fillRect(c * W / 3 + 3, r * rh + rh * 0.3, W / 3 - 6, rh * 0.62); } continue; }
      ctx.fillStyle = mode === "map" ? "#f3f3f1" : ORM(0.5, 0.15); ctx.fillRect(0, r * rh, W, rh * 0.12);
      if (mode === "map") { ctx.fillStyle = "rgba(170,205,225,0.9)"; ctx.fillRect(0, r * rh + rh * 0.12, W, rh * 0.18); ctx.fillStyle = "#2a5575"; for (let c = 0; c < 3; c++) ctx.fillRect(c * W / 3, r * rh + rh * 0.3, 3, rh * 0.7); }
    }
  });
  const frameMat = facadeMat(K, "m23_frames", frames, 1.3);
  const bandMat = facadeMat(K, "m23_bands", bands, 1.3);
  const white = K.nightMat(std("m23_white", { color: 0xf4f5f3, roughness: 0.45, metalness: 0.2, emissive: 0xfff4e0 }), 0, 0.12);
  const ribs = K.nightMat(std("m23_ribs", { color: 0xf4f5f3, roughness: 0.4, metalness: 0.3, emissive: 0xcfe6ff }), 0, 1.5);
  const cap = std("m23_cap", { color: 0x8c969c, roughness: 0.6, metalness: 0.4 });

  const AP = 19.6, R = AP / Math.cos(Math.PI / 8), Y1 = 342, TOP = 392.4;
  const oct = ngon(8, R, -Math.PI / 8);
  // octagon vertices at -22.5 + k*45 deg, so edge k has its normal at k*45 deg: even k = main faces
  const T = tagged(oct, oct.map((_, i) => (i % 2 === 0 ? "m" : "d")));
  const SV = 1 / (4 * FH);
  K.add(frameMat, wallsTagged(T, "m", 0, Y1, { su: 1 / 16.2, sv: SV, crease: 10 }));
  K.add(bandMat, wallsTagged(T, "d", 0, Y1, { su: 1 / 8.1, sv: SV, crease: 10 }));
  // white vertical piers on the octagon corners, and white belts at the sky lobbies
  for (const [x, z] of oct) K.add(white, box(1.3, Y1 + 2, 1.3, x, (Y1 + 2) / 2, z, Math.atan2(x, z)));
  for (const y of [116, 232]) K.add(white, prism(offsetPoly(oct, 0.4), y, y + 2.4, { top: false, bottom: true }));
  K.add(white, prism(offsetPoly(oct, 0.5), Y1, Y1 + 2.2, { top: false, bottom: true }));
  K.add(cap, capXZ(oct, Y1, true));
  // rooftop terrace pavilion under the canopy
  const pav = ngon(8, 13, Math.PI / 8);
  K.add(bandMat, prism(pav, Y1, Y1 + 7.7, { su: 1 / 8.1, sv: SV, top: false }));
  K.add(cap, capXZ(pav, Y1 + 7.7, true));
  // the canopy: eight ribs from the corners to the tip (slightly convex), rings, and diagonal lacing
  const rib = (k, t) => {
    const ang = Math.PI / 8 + (k / 8) * TAU, r = (R + 0.4) * Math.pow(1 - t, 0.82);
    return V3(r * Math.cos(ang), Y1 + 2 + t * (TOP - 6 - Y1 - 2), r * Math.sin(ang));
  };
  const NS = 12;
  for (let k = 0; k < 8; k++) {
    for (let s = 0; s < NS; s++) {
      const a = rib(k, s / NS), b = rib(k, (s + 1) / NS);
      K.add(ribs, beam(a, b, 1.5 * (1 - 0.6 * s / NS), 1.5 * (1 - 0.6 * s / NS), V3(a.x, 0, a.z).normalize()));
    }
  }
  for (const t of [0.22, 0.44, 0.64, 0.8]) {
    for (let k = 0; k < 8; k++) K.add(ribs, beam(rib(k, t), rib((k + 1) % 8, t), 0.7, 0.7));
  }
  for (let k = 0; k < 8; k++) for (const [t0, t1] of [[0, 0.22], [0.22, 0.44], [0.44, 0.64]]) {
    K.add(ribs, beam(rib(k, t0), rib((k + 1) % 8, t1), 0.45, 0.45));
    K.add(ribs, beam(rib((k + 1) % 8, t0), rib(k, t1), 0.45, 0.45));
  }
  K.add(ribs, cyl(0.25, 1.4, 12, 0, TOP - 12, 0, 8));
  // podium (OSM outline w186351097, suppressed with the tower): parking levels in white with dark slots
  const pod = osmPoly([[-1.9, 34.8], [-37.2, -6.3], [5.7, -44.2], [34.7, -11.8], [33.2, 6.2]], -4.4);
  K.add(bandMat, prism(pod, 0, 30, { su: 1 / 8.1, sv: SV, top: false }));
  K.add(cap, capXZ(pod, 30, true));
  K.add(white, prism(offsetPoly(pod, 0.4), 30, 31.5, { top: false, bottom: true }));
  return K.group("marina_23");
}

// Roof made of planes meeting at an apex (a cut-gem top): h(p) = top - max_i k_i * dot(d_i, p - A).
// Returns { h(x, z), facets(poly) -> geometry } with exact facet boundaries (clipped per plane).
function gemRoof(A, top, planes) {
  const h = (x, z) => { let m = 0; for (const [d, k] of planes) m = Math.max(m, k * (d[0] * (x - A[0]) + d[1] * (z - A[1]))); return top - m; };
  const facets = (poly) => {
    const parts = [];
    planes.forEach(([di, ki], i) => {
      let reg = ccw(poly);
      planes.forEach(([dj, kj], j) => {
        if (i === j || reg.length < 3) return;
        const gx = ki * di[0] - kj * dj[0], gz = ki * di[1] - kj * dj[1];
        reg = clipHalf(reg, (p) => gx * (p[0] - A[0]) + gz * (p[1] - A[1]));
      });
      if (reg.length < 3 || Math.abs(areaXZ(reg)) < 0.01) return;
      const g = capXZ(reg, 0, true, 1 / 8);
      const pa = g.attributes.position;
      for (let v = 0; v < pa.count; v++) pa.setY(v, h(pa.getX(v), pa.getZ(v)) + 0.02);
      g.deleteAttribute("normal"); g.computeVertexNormals();
      parts.push(g);
    });
    return parts.length ? mergeGeometries(parts) : null;
  };
  return { h, facets };
}
function wallsUnder(outline, y0, hFn, opts = {}) {
  const base = ccw(resamplePoly(ccw(outline), opts.n ?? 96));
  const rings = [base.map(([x, z]) => V3(x, y0, z)), base.map(([x, z]) => V3(x, hFn(x, z), z))];
  return loftRings(rings, { su: opts.su ?? 1 / 12, sv: opts.sv ?? 1 / 12, vFromY: true });
}

// ================================================================================================
// 4. ALMAS TOWER (Jumeirah Lake Towers)
// OSM part w1491743595 (height 360, 68 levels) on its star-shaped island podium w1137607706 (20 m).
// The tower plan is two half-almonds sliding past each other along a shared cut (notches at the two
// ends of that cut); each half ends in a faceted, diamond-cut glass top at a different height (363 m and
// ~318 m). Blue-green reflective glass with silver floor bands. True orientation; origin = tower centre.
// ================================================================================================
function buildAlmas() {
  const K = new Kit();
  const FH = 4.2;
  const fac = facadeSet("almas-fac", (ctx, W, H, mode, rnd) => {
    const cols = 6, rows = 4, cw = W / cols, rh = H / rows;
    ctx.fillStyle = mode === "map" ? "#b8c4c9" : mode === "orm" ? ORM(0.25, 0.9) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * cw + 1.5, y = r * rh + rh * 0.13, w = cw - 3, h = rh * 0.84;
      if (mode === "map") { const v = 0.94 + rnd() * 0.12; ctx.fillStyle = `rgb(${46 * v | 0},${92 * v | 0},${96 * v | 0})`; }
      else if (mode === "orm") ctx.fillStyle = ORM(0.05, 0.7);
      else ctx.fillStyle = rnd() < 0.38 ? litColor(rnd, 0.6) : "#000";
      ctx.fillRect(x, y, w, h);
    }
  });
  const glass = facadeMat(K, "almas_glass", fac, 1.3);
  const gemTex = canvasTex("almas-gem", 128, (ctx, W, H) => {
    ctx.fillStyle = "#6fa3ad"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#d9e6ea"; ctx.lineWidth = 2.5;
    for (let i = -2; i <= 4; i++) { ctx.beginPath(); ctx.moveTo(i * W / 2, 0); ctx.lineTo(i * W / 2 + W, H); ctx.stroke(); ctx.beginPath(); ctx.moveTo(i * W / 2 + W, 0); ctx.lineTo(i * W / 2, H); ctx.stroke(); }
  });
  const gem = K.nightMat(std("almas_gem", { color: 0xffffff, map: gemTex, roughness: 0.12, metalness: 0.85, emissive: 0x9fe8ff, emissiveMap: gemTex }), 0, 0.9);
  const pod = curtainTex("almas-podium", { cols: 4, rows: 2, glass: [48, 84, 92], frame: "#dfe4e6", mullion: 0.1, spandrel: 0.25, litFrac: 0.7, warm: 0.85, seed: 12 });
  const podium = glassMat(K, "almas_podium", pod, { night: 1.4 });
  const white = std("almas_white", { color: 0xe9ecec, roughness: 0.6, metalness: 0.2 });

  const N1 = [-9.3, 4.1], N2 = [12.4, -11.7];
  const NE = [N2, [18.5, -9.5], [23.4, -5.9], [25.2, -0.1], [24.6, 5.9], [19.8, 12.9], [11.7, 19.2], [4.7, 22.8], [-4.2, 25.3], [-15.5, 10.3], N1];
  const SW = [N1, [-13.4, 4.1], [-18.3, 2.4], [-21.7, -1.8], [-22.6, -9.0], [-20.3, -14.9], [-13.4, -22.4], [-1.3, -31.8], N2];
  const cut = norm2([N2[0] - N1[0], -(N2[1] - N1[1])]); // along the shared cut, canonical (x, z)
  const lobes = [
    // tall half: apex over the south tip, facets falling to the north and to both sides
    { poly: osmPoly(SW, 0), apex: osm2c(-1.3, -27.5, 0), top: 363, planes: [[[cut[0], cut[1]], 1.6], [[-cut[0], -cut[1]], 2.0], [osm2c(0, 1, 0), 1.5]] },
    // lower half: apex over the north tip, facets falling to the south
    { poly: osmPoly(NE, 0), apex: osm2c(-4.2, 21.5, 0), top: 330, planes: [[[cut[0], cut[1]], 1.7], [[-cut[0], -cut[1]], 1.4], [osm2c(0, -1, 0), 1.5]] },
  ];
  for (const L of lobes) {
    const poly = ccw(chaikin(ccw(L.poly), 2, 0.2));
    const roof = gemRoof(L.apex, L.top, L.planes.map(([d, k]) => [norm2(d), k]));
    K.add(glass, wallsUnder(poly, 0, (x, z) => roof.h(x, z) - 0.02, { n: 120, su: 1 / 10, sv: 1 / (4 * FH) }));
    K.add(gem, roof.facets(poly));
    // the glazed crown band: walls between the last full floor and the facets use the gem glass
  }
  // podium on the island
  const P = [[-3.4, 49.7], [57.5, 84.0], [38.4, 19.5], [74.8, 8.3], [62.6, 2.8], [37.6, -7.1], [35.0, -15.3], [53.4, -43.2], [20.3, -31.2], [9.9, -37.9], [6.9, -50.4], [3.2, -72.4], [-10.8, -39.9], [-17.4, -31.1], [-22.5, -35.0], [-44.3, -51.8], [-35.0, -27.9], [-32.0, -20.1], [-35.8, -13.5], [-42.3, -16.6], [-80.6, -5.3], [-49.4, 8.9], [-42.8, 8.9], [-40.5, 17.1], [-63.3, 48.3], [-39.2, 40.6], [-43.9, 46.9], [-33.7, 55.1], [-19.5, 60.4], [-13.0, 78.6]];
  const pp = osmPoly(P, 0);
  K.add(podium, prism(pp, 0, 14, { su: 1 / 10, sv: 1 / 7, top: false, crease: 20 }));
  K.add(white, capXZ(pp, 14, true));
  K.add(white, prism(offsetPoly(pp, 0.4), 14, 15.2, { top: false }));
  return K.group("almas");
}


// Walls of an outline with the material picked per edge from its outward normal (nx, nz), canonical frame.
function addWallsBy(K, outline, y0, y1, pick, opts = {}) {
  const p = ccw(outline), n = p.length, su = opts.su ?? 1 / 8, sv = opts.sv ?? 1 / 8;
  const by = new Map();
  let u = 0;
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-6) continue;
    const nx = -(b[1] - a[1]) / l, nz = (b[0] - a[0]) / l;
    const mat = pick(nx, nz, a, b);
    if (mat) {
      if (!by.has(mat)) by.set(mat, { pos: [], nor: [], uv: [] });
      const G = by.get(mat), u1 = u + l * su;
      G.pos.push(a[0], y0, a[1], b[0], y0, b[1], b[0], y1, b[1], a[0], y0, a[1], b[0], y1, b[1], a[0], y1, a[1]);
      for (let k = 0; k < 6; k++) G.nor.push(nx, 0, nz);
      G.uv.push(u, y0 * sv, u1, y0 * sv, u1, y1 * sv, u, y0 * sv, u1, y1 * sv, u, y1 * sv);
    }
    u += l * su;
  }
  for (const [mat, G] of by) K.add(mat, fromArrays(G.pos, G.nor, G.uv));
}
// Axis-aligned rectangle [x0, x1] x [z0, z1] in the canonical frame.
const rectXZ = (x0, x1, z0, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
function sphereGeom(r, x, y, z, ws = 16, hs = 10) { const g = new THREE.SphereGeometry(r, ws, hs); g.translate(x, y, z); return finish(g); }

// ================================================================================================
// 5. THE ADDRESS DOWNTOWN
// OSM part w532836513 (height 306.2, 63 levels): a leaf-shaped plan, ~47 x 80 m, pointed to the NNE and
// rounded to the south. The tower rises in a series of curved, terraced setbacks that close in on a
// spine toward the north tip, ending in a pointed crown and a slender spire. Dark blue-grey glass with
// silver vertical fins, white terrace edges; the crown is lit at night. True orientation.
// ================================================================================================
function buildAddressDowntown() {
  const K = new Kit();
  const FH = 4.3;
  const fac = facadeSet("adr-fac", (ctx, W, H, mode, rnd) => {
    const cols = 8, rows = 4, cw = W / cols, rh = H / rows;
    ctx.fillStyle = mode === "map" ? "#c3c9cd" : mode === "orm" ? ORM(0.3, 0.9) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * cw + cw * 0.12, y = r * rh + rh * 0.1, w = cw * 0.76, h = rh * 0.86;
      if (mode === "map") { const v = 0.9 + rnd() * 0.18; ctx.fillStyle = `rgb(${50 * v | 0},${64 * v | 0},${78 * v | 0})`; }
      else if (mode === "orm") ctx.fillStyle = ORM(0.05, 0.65);
      else ctx.fillStyle = rnd() < 0.45 ? litColor(rnd, 0.8) : "#000";
      ctx.fillRect(x, y, w, h);
    }
  });
  const glass = facadeMat(K, "adr_glass", fac, 1.3);
  const white = K.nightMat(std("adr_white", { color: 0xe8ebec, roughness: 0.45, metalness: 0.4, emissive: 0xfff1d6 }), 0, 0.9);
  const crownTex = canvasTex("adr-crown", 128, (ctx, W, H) => {
    ctx.fillStyle = "#58708a"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#c9d3da"; for (let i = 0; i < 8; i++) ctx.fillRect(i * W / 8, 0, 3, H);
  });
  const crown = K.nightMat(std("adr_crown", { color: 0xffffff, map: crownTex, roughness: 0.2, metalness: 0.8, emissive: 0xfff0d0, emissiveMap: crownTex, side: THREE.DoubleSide }), 0, 1.0);
  const ADR = [[13.4, 38.1], [11.3, 39.2], [8.5, 38.8], [2.3, 34.6], [-4.8, 27.3], [-11.4, 20.1], [-16.1, 14.1], [-19.4, 5.5], [-23.1, -11.5], [-25.9, -20.5], [-24.9, -27.5], [-21.1, -33.7], [-15.3, -38.1], [-7.1, -40.9], [-0.7, -40.6], [5.8, -36.1], [12.7, -25.5], [18.2, -13.9], [20.9, -3.3], [21.4, 6.2], [20.6, 13.3], [18.4, 22.9], [16.3, 31.3]];
  const base = ccw(resamplePoly(chaikin(ccw(osmPoly(ADR, 0)), 1, 0.18), 64));
  const [ax, az] = osm2c(7.5, 22, 0); // the spine the terraces close in on (toward the north tip)
  const tier = (s, sx = s) => base.map(([x, z]) => [ax + (x - ax) * sx, az + (z - az) * s]);
  // shallow terraces every few floors from 140 m, following a smooth curve that closes in on the spine
  const T = [[140, 1.0]];
  for (let i = 1; i <= 13; i++) { const t = i / 13; T.push([140 + 136 * t, 1 - 0.56 * Math.pow(t, 1.5)]); }
  let y0 = 0;
  const SV = 1 / (4 * FH);
  for (const [y1, sc] of T) {
    const pl = tier(sc, sc * 0.98);
    K.add(glass, prism(pl, y0, y1, { su: 1 / 16, sv: SV, top: false, crease: 25 }));
    K.add(white, capXZ(pl, y1, true));
    K.add(white, prism(offsetPoly(pl, 0.25), y1 - 0.5, y1 + 0.4, { top: false, bottom: true, su: 1 / 8, sv: 1 / 8 }));
    y0 = y1;
  }
  // crown: the last terrace tapers to a sharp, slanted point over the spine
  const top = tier(0.44, 0.43);
  const rings = [];
  for (let j = 0; j <= 6; j++) {
    const t = j / 6, s = 1 - 0.93 * Math.pow(t, 0.85);
    rings.push(top.map(([x, z]) => V3(ax + (x - ax) * s, 276 + t * 20 + (z - az) * -0.25 * t, az + (z - az) * s)));
  }
  K.add(crown, loftRings(rings, { su: 1 / 6, sv: 1 / 10 }));
  K.add(white, cyl(0.35, 1.4, 306 - 294, ax, 294, az, 8));
  return K.group("address_downtown");
}

// ================================================================================================
// 6. ROSE TOWER (Rose Rayhaan by Rotana, Sheikh Zayed Road)
// OSM w64890199 (height 315, 72 levels; 333 m to the tip). A triangular tower: each side is two convex
// cylindrical bulges folding into a central narrow panel of gold rings; blue and silver mirror glass. At the
// top the sides flatten and rise into three intersecting pointed petals, then a sphere and the spire.
// OSM maps only a rough ~25 m square; the tower is modelled as the triangle it is, 37 m a side, centred on
// that footprint. Canonical: one side faces +Z; headingDeg = -56 (that side faces Sheikh Zayed Road, SE).
// ================================================================================================
function buildRoseTower() {
  const K = new Kit();
  const FH = 3.9;
  const fac = facadeSet("rose-fac", (ctx, W, H, mode, rnd) => {
    // 4 floors: alternating deep blue and silver mirror bands, fine mullions
    const rows = 4, rh = H / rows, cols = 6, cw = W / cols;
    for (let r = 0; r < rows; r++) {
      const silver = r % 2 === 0;
      ctx.fillStyle = mode === "map" ? (silver ? "#aebfcc" : "#3e6282") : mode === "orm" ? ORM(0.05, silver ? 0.95 : 0.7) : "#000";
      ctx.fillRect(0, r * rh, W, rh);
      if (mode === "em") for (let c = 0; c < cols; c++) if (rnd() < 0.42) { ctx.fillStyle = litColor(rnd, 0.75); ctx.fillRect(c * cw + 2, r * rh + rh * 0.2, cw - 4, rh * 0.7); }
      if (mode === "map") { ctx.fillStyle = "rgba(225,232,238,0.7)"; for (let c = 0; c < cols; c++) ctx.fillRect(c * cw, r * rh, 2, rh); ctx.fillRect(0, r * rh, W, 2); }
    }
  });
  const glass = facadeMat(K, "rose_glass", fac, 1.3);
  const ringsTex = canvasTex("rose-rings", 64, (ctx, W, H) => {
    ctx.fillStyle = "#b99a55"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#f6dc93"; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.ellipse(W / 2, H / 2, W * 0.36, H * 0.44, 0, 0, TAU); ctx.stroke();
    ctx.fillStyle = "#6f5a2e"; ctx.beginPath(); ctx.ellipse(W / 2, H / 2, W * 0.2, H * 0.28, 0, 0, TAU); ctx.fill();
  });
  const gold = K.nightMat(std("rose_gold", { color: 0xffffff, map: ringsTex, metalness: 0.95, roughness: 0.28, emissive: 0xffc870, emissiveMap: ringsTex }), 0, 1.2);
  const petalMat = facadeMat(K, "rose_petals", fac, 1.1, { side: THREE.DoubleSide });
  const silver = K.nightMat(std("rose_silver", { color: 0xdfe4e8, roughness: 0.25, metalness: 0.95, emissive: 0xe6f0ff }), 0, 0.5);

  const S = 37, Rc = S / Math.sqrt(3), BUL = 1.7, SLOT = 1.2, NOTCH = 0.9;
  const V = [30, 150, 270].map((d) => [Rc * Math.cos(d * DEG), Rc * Math.sin(d * DEG)]);
  // one side = bulge, gold slot, bulge; tags: g = glass, o = the gold slot's back wall
  const pts = [], tags = [];
  for (let k = 0; k < 3; k++) {
    const A = V[k], B = V[(k + 1) % 3], M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const dx = (B[0] - A[0]) / S, dz = (B[1] - A[1]) / S;
    let nx = -dz, nz = dx;
    if (M[0] * nx + M[1] * nz < 0) { nx = -nx; nz = -nz; }
    const at = (t, off) => [A[0] + dx * S * t + nx * off, A[1] + dz * S * t + nz * off];
    const half = 0.5 - SLOT / S, NB = 7;
    for (let i = 0; i <= NB; i++) { const t = 0.05 + (half - 0.05) * i / NB; pts.push(at(t, BUL * Math.sin(Math.PI * (i / NB)))); tags.push(i === NB ? "s" : "g"); }
    pts.push(at(half, -NOTCH)); tags.push("o");
    pts.push(at(1 - half, -NOTCH)); tags.push("s");
    for (let i = 0; i <= NB; i++) { const t = 1 - half + (half - 0.05) * i / NB; pts.push(at(t, BUL * Math.sin(Math.PI * (i / NB)))); tags.push("g"); }
  }
  const T = tagged(pts, tags);
  const SV = 1 / (4 * FH), Y1 = 258;
  K.add(glass, wallsTagged(T, "g", 0, Y1, { su: 1 / 10, sv: SV, crease: 40 }));
  K.add(silver, wallsTagged(T, "s", 0, Y1, { su: 1 / 4, sv: 1 / 4, crease: 10 }));
  K.add(gold, wallsTagged(T, "o", 0, Y1, { su: 1 / 2.6, sv: 1 / 3.2, crease: 10 }));
  K.add(silver, capXZ(T.pts, Y1, true));
  // petals: above the roof each side rises as a pointed, slightly bowed petal leaning inward; the three
  // intersect near the corners. The gold ring panel follows each petal's centre line to its tip.
  const PH = 50, lean = (v) => 1 - 0.24 * v * v;
  for (let k = 0; k < 3; k++) {
    const A = V[k], B = V[(k + 1) % 3], M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const d = [(B[0] - A[0]) / S, (B[1] - A[1]) / S], n = norm2(M);
    const P = (u, v) => {
      const w = (S / 2 - 1) * Math.pow(Math.max(0, 1 - Math.pow(v, 2.0)), 0.55), L = lean(v), bul = BUL * Math.cos(u * Math.PI / 2) * (1 - v);
      return V3(M[0] * L + d[0] * u * w + n[0] * bul, Y1 + v * PH, M[1] * L + d[1] * u * w + n[1] * bul);
    };
    K.add(petalMat, paramSurface((u, v) => P(u * 2 - 1, v), 14, 10, { uvFn: (u, v, p) => [u * S / 10, p.y * SV] }));
    for (let j = 0; j < 6; j++) {
      const v0 = j / 6, v1 = (j + 1) / 6;
      const p0 = P(0, v0).addScaledVector(V3(n[0], 0, n[1]), 0.3), p1 = P(0, Math.min(0.97, v1)).addScaledVector(V3(n[0], 0, n[1]), 0.3);
      K.add(gold, beam(p0, p1, 2.4 * (1 - 0.6 * v0), 0.7, V3(n[0], 0, n[1])));
    }
  }
  K.add(gold, sphereGeom(4.2, 0, Y1 + 47, 0));
  K.add(silver, cyl(1.6, 3.2, 24, 0, Y1 + 20, 0, 10));
  K.add(silver, cyl(0.3, 1.5, 333 - (Y1 + 50), 0, Y1 + 50, 0, 10));
  return K.group("rose_tower");
}

// ================================================================================================
// 7. THE INDEX (DIFC)
// OSM Index Tower w182071958 and its parts w935572013..41, w937048146, w936115283: an 80-storey slab,
// 77 x 23 m, exactly east-west, roof 322 m, glazed bays to 326 m. Four tapering concrete A-frame fins cross
// the slab (3.4 m thick, proud of both faces) up to 300 m, and each end is an open U-shaped concrete core,
// 297 m of void capped by a slab. Horizontal sun shades on the south face. True orientation.
// ================================================================================================
function buildIndex() {
  const K = new Kit();
  const FH = 3.95;
  const south = facadeSet("idx-s", (ctx, W, H, mode, rnd) => {
    // 4 floors: deep horizontal brise-soleil blades in front of blue-grey glass
    const rows = 4, rh = H / rows, cols = 4, cw = W / cols;
    ctx.fillStyle = mode === "map" ? "#4d6573" : mode === "orm" ? ORM(0.07, 0.6) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) {
      if (mode === "em") { for (let c = 0; c < cols; c++) if (rnd() < 0.45) { ctx.fillStyle = litColor(rnd); ctx.fillRect(c * cw + 2, r * rh + rh * 0.36, cw - 4, rh * 0.6); } continue; }
      ctx.fillStyle = mode === "map" ? "#d9dcdc" : ORM(0.45, 0.6);
      ctx.fillRect(0, r * rh, W, rh * 0.16); ctx.fillRect(0, r * rh + rh * 0.52, W, rh * 0.08);
      if (mode === "map") { ctx.fillStyle = "rgba(20,30,36,0.55)"; ctx.fillRect(0, r * rh + rh * 0.16, W, rh * 0.06); ctx.fillStyle = "#a7b1b5"; for (let c = 0; c < cols; c++) ctx.fillRect(c * cw, r * rh, 2, rh); }
    }
  });
  const north = facadeSet("idx-n", (ctx, W, H, mode, rnd) => {
    const rows = 4, rh = H / rows, cols = 4, cw = W / cols;
    ctx.fillStyle = mode === "map" ? "#9aa7ae" : mode === "orm" ? ORM(0.3, 0.8) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (mode === "map") { const v = 0.92 + rnd() * 0.14; ctx.fillStyle = `rgb(${72 * v | 0},${96 * v | 0},${110 * v | 0})`; }
      else if (mode === "orm") ctx.fillStyle = ORM(0.05, 0.65);
      else ctx.fillStyle = rnd() < 0.45 ? litColor(rnd) : "#000";
      ctx.fillRect(c * cw + 2, r * rh + rh * 0.12, cw - 4, rh * 0.84);
    }
  });
  const sMat = facadeMat(K, "idx_south", south, 1.3);
  const nMat = facadeMat(K, "idx_north", north, 1.3);
  const concTex = canvasTex("idx-conc", 128, (ctx, W, H) => {
    ctx.fillStyle = "#bdae9c"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(120,105,90,0.35)"; for (let i = 0; i < 4; i++) ctx.fillRect(0, i * H / 4, W, 2);
    const r = mulberry32(5); for (let i = 0; i < 300; i++) { ctx.fillStyle = `rgba(${150 + r() * 60 | 0},${135 + r() * 55 | 0},${115 + r() * 50 | 0},0.25)`; ctx.fillRect(r() * W, r() * H, 3, 3); }
  });
  const conc = K.nightMat(std("idx_concrete", { color: 0xffffff, map: concTex, roughness: 0.85, metalness: 0, emissive: 0xffe0b8 }), 0, 0.12);
  const pick = (nx, nz) => (nz > 0.5 ? sMat : nMat);
  const SV = 1 / (4 * FH), SU = 1 / 11.2;
  const R = (x0, x1, y0, y1) => rectXZ(x0, x1, -y1, -y0); // OSM x/y extents -> canonical rectangle
  // slab (the office floors are a little deeper), glazed bays standing proud up to 326 m
  addWallsBy(K, R(-52.8, 23.9, -4.1, 21.1), 4, 130, pick, { su: SU, sv: SV });
  K.add(conc, capXZ(R(-52.8, 23.9, -4.1, 21.1), 130, true));
  addWallsBy(K, R(-52.8, 23.9, -3.1, 20.2), 130, 322, pick, { su: SU, sv: SV });
  K.add(conc, capXZ(R(-52.8, 23.9, -3.1, 20.2), 322, true));
  for (const [x0, x1] of [[16.3, 21.9], [3.0, 8.7], [-9.8, -4.2], [-23.5, -17.9], [-36.7, -31.1], [-50.4, -44.8]]) {
    addWallsBy(K, R(x0, x1, -4.1, 21.1), 130, 326, pick, { su: SU, sv: SV });
    K.add(conc, capXZ(R(x0, x1, -4.1, 21.1), 326, true));
  }
  // A-frame fins: 3.4 m thick, 6 m proud of each face at the foot, ~1 m proud at 300 m
  for (const [x0, x1] of [[-56.2, -52.8], [-28.4, -25.3], [-2.2, 1.2], [23.9, 27.3]]) {
    const zs0 = 3.1 + 6.0, zs1 = 3.1 + 1.0, zn0 = -(20.2 + 6.0), zn1 = -(20.2 + 1.0);
    const sec = (x) => [V3(x, 0, zs0), V3(x, 300, zs1), V3(x, 300, zn1), V3(x, 0, zn0)];
    const A = sec(x0), B = sec(x1);
    K.add(conc, facet([A[0], A[1], A[2], A[3]], V3(-1, 0, 0), 1 / 8));
    K.add(conc, facet([B[0], B[1], B[2], B[3]], V3(1, 0, 0), 1 / 8));
    K.add(conc, facet([A[0], B[0], B[1], A[1]], V3(0, 0.02, 1), 1 / 8));
    K.add(conc, facet([A[3], A[2], B[2], B[3]], V3(0, 0.02, -1), 1 / 8));
    K.add(conc, facet([A[1], B[1], B[2], A[2]], V3(0, 1, 0), 1 / 8));
  }
  // end cores: U-shaped walls open to the outside, the void capped at 297-300 m
  for (const [x0, x1] of [[27.3, 35.8], [-64.6, -56.2]]) {
    K.add(conc, prism(R(x0, x1, -3.1, -0.2), 0, 297, { su: 1 / 8, sv: 1 / 8, top: false }));
    K.add(conc, prism(R(x0, x1, 16.7, 19.9), 0, 297, { su: 1 / 8, sv: 1 / 8, top: false }));
    K.add(conc, prism(R(x0, x1, -3.1, 19.9), 297, 300, { su: 1 / 8, sv: 1 / 8, bottom: true }));
  }
  // lift-lobby glazing at the back of each void (on the outer fin)
  addWallsBy(K, R(27.3, 27.4, -0.2, 16.7), 0, 297, (nx) => (nx > 0.5 ? nMat : null), { su: SU, sv: SV });
  addWallsBy(K, R(-56.3, -56.2, -0.2, 16.7), 0, 297, (nx) => (nx < -0.5 ? nMat : null), { su: SU, sv: SV });
  // Gate Avenue level podium (4 m)
  K.add(conc, prism(R(-84.8, 48.8, -9.3, 33.2), 0, 4, { su: 1 / 8, sv: 1 / 4 }));
  return K.group("index");
}


// Quads between two rings of equal length (closed loops); material per edge from pick(midpoint, i).
function loft2(K, ringA, ringB, pick, opts = {}) {
  const n = ringA.length, su = opts.su ?? 1 / 8, sv = opts.sv ?? 1 / 8;
  const by = new Map();
  let u = 0;
  for (let i = 0; i < n; i++) {
    const a0 = ringA[i], a1 = ringA[(i + 1) % n], b0 = ringB[i], b1 = ringB[(i + 1) % n];
    const l = a0.distanceTo(a1);
    const mid = a0.clone().add(a1).add(b0).add(b1).multiplyScalar(0.25);
    const mat = pick(mid, i);
    const u1 = u + l * su;
    if (mat) {
      if (!by.has(mat)) by.set(mat, { pos: [], nor: [], uv: [] });
      const G = by.get(mat);
      const nrm = new THREE.Vector3().crossVectors(a1.clone().sub(a0), b0.clone().sub(a0)).normalize();
      if (opts.flip) nrm.negate();
      const quad = opts.flip ? [a0, b0, b1, a0, b1, a1] : [a0, a1, b1, a0, b1, b0];
      const uvq = opts.flip ? [[u, a0.y], [u, b0.y], [u1, b1.y], [u, a0.y], [u1, b1.y], [u1, a1.y]] : [[u, a0.y], [u1, a1.y], [u1, b1.y], [u, a0.y], [u1, b1.y], [u, b0.y]];
      quad.forEach((p, k) => { G.pos.push(p.x, p.y, p.z); G.nor.push(nrm.x, nrm.y, nrm.z); G.uv.push(uvq[k][0], uvq[k][1] * sv); });
    }
    u = u1;
  }
  for (const [mat, G] of by) K.add(mat, fromArrays(G.pos, G.nor, G.uv));
}
// Flat cap of an outline lifted per vertex to y = hFn(x, z) (normals recomputed).
function liftedCap(outline, hFn, s = 1 / 10) {
  const g = capXZ(outline, 0, true, s);
  const pa = g.attributes.position;
  for (let v = 0; v < pa.count; v++) pa.setY(v, hFn(pa.getX(v), pa.getZ(v)));
  g.deleteAttribute("normal"); g.computeVertexNormals();
  return g;
}
// Principal axis of an outline: { c: centroid, ang: angle of the long axis in the canonical x-z plane }.
function principal(pts) {
  const c = centroidXZ(ccw(pts));
  let sxx = 0, szz = 0, sxz = 0;
  for (const [x, z] of pts) { const dx = x - c[0], dz = z - c[1]; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
  return { c, ang: 0.5 * Math.atan2(2 * sxz, sxx - szz) };
}

// ================================================================================================
// 8. JW MARRIOTT MARQUIS (Business Bay)
// OSM parts w238284907 / w238284909 (77 levels, roof 330) with pinnacles w238284917 / w238284919 (355),
// joined by the hotel podium outline w238284905. Twin towers, each a long plan with stepped (serrated)
// edges, like a date-palm trunk, rising in a series of stepped setbacks to a crown and pinnacle at 355 m.
// Bronze fins over dark glass; the crowns are floodlit at night. True orientation.
// ================================================================================================
function buildJWMarriott() {
  const K = new Kit();
  const FH = 4.2;
  const fac = facadeSet("jwm-fac", (ctx, W, H, mode, rnd) => {
    // 6 bays x 4 floors: bronze-gold vertical fins, dark glass, thin spandrels
    const cols = 6, rows = 4, cw = W / cols, rh = H / rows;
    ctx.fillStyle = mode === "map" ? "#b39469" : mode === "orm" ? ORM(0.35, 0.85) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * cw + cw * 0.2, y = r * rh + rh * 0.12, w = cw * 0.6, h = rh * 0.82;
      if (mode === "map") { const v = 0.9 + rnd() * 0.2; ctx.fillStyle = `rgb(${46 * v | 0},${50 * v | 0},${52 * v | 0})`; }
      else if (mode === "orm") ctx.fillStyle = ORM(0.06, 0.6);
      else ctx.fillStyle = rnd() < 0.45 ? litColor(rnd, 0.85) : "#000";
      ctx.fillRect(x, y, w, h);
    }
    if (mode === "map") { ctx.fillStyle = "rgba(255,230,180,0.35)"; for (let c = 0; c < cols; c++) ctx.fillRect(c * cw + cw * 0.08, 0, 2, H); }
  });
  const glass = facadeMat(K, "jwm_glass", fac, 1.3);
  const bronze = K.nightMat(std("jwm_bronze", { color: 0xc9a46c, roughness: 0.35, metalness: 0.9, emissive: 0xffd28a }), 0, 0.9);
  const pod = curtainTex("jwm-podium", { cols: 4, rows: 2, glass: [40, 44, 46], frame: "#c5a77a", mullion: 0.12, spandrel: 0.22, litFrac: 0.7, warm: 0.9, seed: 19 });
  const podium = glassMat(K, "jwm_podium", pod, { night: 1.4 });

  // stepped half-lens: plateaus of the long plan (local x along the long axis)
  const L = 26, Wd = 13.5;
  const xs = [-26, -21.5, -15.5, -8.5, 8.5, 15.5, 21.5, 26];
  const zOf = (x) => Wd * Math.pow(Math.max(0, 1 - (x / L) ** 2), 0.75);
  const half = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const zc = Math.max(3.2, zOf((xs[i] + xs[i + 1]) / 2));
    half.push([xs[i], zc], [xs[i + 1], zc]);
  }
  const plan = half.concat(half.slice().reverse().map(([x, z]) => [x, -z]));
  const towers = [
    [[-32.2, -59.7], [-29.6, -59.9], [-27.0, -60.0], [-24.7, -57.6], [-22.2, -50.6], [-20.6, -42.7], [-19.9, -33.1], [-21.3, -24.3], [-23.5, -18.1], [-32.7, -14.4], [-35.1, -14.0], [-36.7, -16.3], [-39.7, -23.1], [-42.0, -30.8], [-43.5, -40.4], [-42.9, -49.2], [-41.2, -55.6], [-37.6, -62.6]],
    [[57.0, 40.1], [55.7, 45.2], [49.7, 53.7], [42.3, 53.8], [34.2, 52.9], [24.8, 50.5], [16.8, 46.5], [11.6, 42.4], [6.5, 36.3], [3.1, 32.3], [3.6, 30.2], [9.2, 21.8], [16.6, 21.1], [24.8, 21.3], [34.3, 23.0], [42.6, 26.3], [48.1, 29.9]],
  ];
  // [top of tier, scale along, scale across]
  const tiers = [[214, 1, 1], [246, 0.93, 0.95], [272, 0.84, 0.9], [292, 0.73, 0.84], [308, 0.61, 0.76], [320, 0.48, 0.66], [330, 0.35, 0.55]];
  const SV = 1 / (4 * FH);
  for (const osm of towers) {
    const { c, ang } = principal(osmPoly(osm, 0));
    const place = (pts, sa, sc) => pts.map(([x, z]) => { const X = x * sa, Z = z * sc; return [c[0] + X * Math.cos(ang) - Z * Math.sin(ang), c[1] + X * Math.sin(ang) + Z * Math.cos(ang)]; });
    let y0 = 0;
    for (const [y1, sa, sc] of tiers) {
      const pl = place(plan, sa, sc);
      K.add(glass, prism(pl, y0, y1, { su: 1 / 12, sv: SV, top: false, crease: 5 }));
      K.add(bronze, prism(offsetPoly(pl, 0.35), y1 - 1.6, y1, { su: 1 / 8, sv: 1 / 8, bottom: true }));
      y0 = y1;
    }
    // crown: a short bronze lantern, then the pinnacle
    const top = place(plan, 0.24, 0.42);
    K.add(bronze, prism(top, 330, 336, { su: 1 / 8, sv: 1 / 8 }));
    K.add(bronze, cyl(0.3, 2.2, 355 - 336, c[0], 336, c[1], 8));
  }
  // podium joining the two towers (hotel outline, 9 levels)
  const P = [[6.5, 36.3], [3.1, 32.3], [-35.1, -14.0], [-36.7, -16.3], [-39.7, -23.1], [-42.0, -30.8], [-43.5, -40.4], [-42.9, -49.2], [-41.2, -55.6], [-37.6, -62.6], [-32.2, -59.7], [-29.6, -59.9], [-27.0, -60.0], [-21.0, -64.1], [-8.3, -55.3], [42.6, 6.4], [61.5, 36.0], [57.0, 40.1], [55.7, 45.2], [57.7, 52.1], [49.7, 53.7], [42.3, 53.8], [34.2, 52.9], [24.8, 50.5], [16.8, 46.5], [11.6, 42.4]];
  const pp = osmPoly(P, 0);
  K.add(podium, prism(pp, 0, 34, { su: 1 / 10, sv: 1 / 8, top: false, crease: 25 }));
  K.add(bronze, capXZ(pp, 34, true));
  return K.group("jw_marriott_marquis");
}

// ================================================================================================
// 9. DUBAI OPERA
// OSM w475848632 (civic, height 44): a hull-shaped plan 132 x 84 m, the narrow rounded bow to the east
// (toward the Burj Khalifa lake), a broad transom to the west. The dhow's hull walls flare outward as
// they rise, the roof climbs from the stern to the glazed bow, whose prow sweeps up to ~46 m. Silver-grey
// hull panels with horizontal strakes, the glass bow glows warm at night. True orientation.
// ================================================================================================
function buildDubaiOpera() {
  const K = new Kit();
  const hullTex = canvasTex("opera-hull", 256, (ctx, W, H) => {
    ctx.fillStyle = "#9aa2a8"; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 16; i++) { ctx.fillStyle = i % 2 ? "#8b949a" : "#a7aeb3"; ctx.fillRect(0, i * H / 16, W, H / 16); }
    ctx.fillStyle = "rgba(60,66,70,0.8)"; for (let i = 0; i < 16; i++) ctx.fillRect(0, i * H / 16, W, 2);
    ctx.fillStyle = "rgba(70,76,80,0.4)"; for (let j = 0; j < 8; j++) ctx.fillRect(j * W / 8, 0, 1.5, H);
  });
  const hull = K.nightMat(std("opera_hull", { color: 0xffffff, map: hullTex, roughness: 0.4, metalness: 0.7, emissive: 0x9fb8ff, emissiveMap: hullTex }), 0, 0.18);
  const gt = curtainTex("opera-glass", { cols: 6, rows: 3, glass: [56, 74, 86], frame: "#cdd3d7", mullion: 0.1, spandrel: 0.06, vary: 0.1, litFrac: 0.95, warm: 0.95, seed: 31, glassMetal: 0.5, glassRough: 0.05 });
  const glass = glassMat(K, "opera_glass", gt, { night: 1.15 });
  const roof = std("opera_roof", { color: 0x6f777d, roughness: 0.55, metalness: 0.6 });
  const plinth = std("opera_plinth", { color: 0xd9d2c4, roughness: 0.85, metalness: 0 });
  const OP = [[51.3, 11.9], [42.3, 18.8], [32.8, 25.1], [22.9, 30.6], [12.6, 35.5], [2.1, 39.6], [-8.8, 43.0], [-19.9, 45.7], [-31.1, 47.5], [-49.1, 48.0], [-53.6, 40.3], [-57.4, 32.1], [-60.2, 23.6], [-62.9, 15.1], [-64.5, 6.2], [-65.3, -2.7], [-65.4, -11.7], [-56.6, -18.6], [-49.3, -23.1], [-41.6, -26.9], [-33.6, -30.1], [-25.4, -32.6], [-17.0, -34.4], [-8.5, -35.5], [0.1, -35.8], [10.4, -35.1], [20.6, -33.8], [30.6, -31.7], [40.5, -28.9], [50.2, -25.4], [62.0, -18.9], [64.7, -15.9], [66.4, -12.2], [67.0, -8.1], [66.5, -4.1], [64.9, -0.4], [62.3, 2.7]];
  // pinch the rounded east end into a bow
  const top = ccw(resamplePoly(chaikin(ccw(osmPoly(OP, 0)), 1, 0.2), 128)).map(([x, z]) => {
    const k = Math.max(0, (x - 30) / 37);
    return [x + 5 * k * k, -6 + (z + 6) * (1 - 0.45 * k * k)];
  });
  const foot = offsetPoly(top, -3.2);
  // roof line: stern ~27 m, rising gently to the bow, the prow sweeping up at the east tip
  const roofY = (x, z) => {
    const s = Math.min(1, Math.max(0, (x + 66) / 138));
    const prow = Math.pow(Math.max(0, (x - 30) / 42), 2.4) * 20;
    return 22 + 6 * s + prow + 1.2 * Math.cos(Math.min(1, Math.abs(z + 6) / 42) * Math.PI / 2);
  };
  const ringTop = top.map(([x, z]) => V3(x, roofY(x, z), z)), ringFoot = foot.map(([x, z]) => V3(x, 0, z));
  loft2(K, ringFoot, ringTop, (m) => (m.x > 34 ? glass : hull), { su: 1 / 12, sv: 1 / 12 });
  K.add(roof, liftedCap(top, roofY, 1 / 12));
  // a thin bright edge along the roof line (the gunwale)
  K.add(plinth, prism(offsetPoly(foot, 6), 0, 1.2, { su: 1 / 10, sv: 1 / 10 }));
  return K.group("dubai_opera");
}

// ================================================================================================
// 10. DUBAI WORLD TRADE CENTRE (Sheikh Rashid Tower, 1979)
// OSM w103846997 (height 149, 39 levels): a ~47 m square turned 48.3 deg on Sheikh Zayed Road. White
// concrete outer facade of deep-set arched windows in a close honeycomb-like grid (the glazing recessed
// behind it), crowned by taller arches, a roof plant storey and the mast to 184 m. Canonical faces +-X / +-Z.
// ================================================================================================
function buildDWTC() {
  const K = new Kit();
  const FH = 3.7;
  const arches = facadeSet("dwtc-arch", (ctx, W, H, mode, rnd) => {
    // 4 bays x 4 floors of narrow arched openings in white concrete, shaded at the top of each recess
    const cols = 4, rows = 4, cw = W / cols, rh = H / rows;
    ctx.fillStyle = mode === "map" ? "#f1eee6" : mode === "orm" ? ORM(0.8, 0) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x0 = c * cw + cw * 0.2, x1 = (c + 1) * cw - cw * 0.2, yb = (r + 1) * rh - rh * 0.1, ys = r * rh + rh * 0.4, yt = r * rh + rh * 0.12;
      ctx.beginPath(); ctx.moveTo(x0, yb); ctx.lineTo(x0, ys); ctx.quadraticCurveTo(x0, yt, (x0 + x1) / 2, yt); ctx.quadraticCurveTo(x1, yt, x1, ys); ctx.lineTo(x1, yb); ctx.closePath();
      if (mode === "map") {
        const g = ctx.createLinearGradient(0, yt, 0, yb); g.addColorStop(0, "#1c2328"); g.addColorStop(0.35, "#34434e"); g.addColorStop(1, "#4b5d69");
        ctx.fillStyle = g; ctx.fill();
        ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(x0 - 2, ys, 2, yb - ys);
      } else if (mode === "orm") { ctx.fillStyle = ORM(0.1, 0.5); ctx.fill(); }
      else { ctx.fillStyle = rnd() < 0.45 ? litColor(rnd, 0.8) : "#000"; ctx.fill(); }
    }
  });
  const facade = facadeMat(K, "dwtc_facade", arches, 1.2);
  const white = K.nightMat(std("dwtc_white", { color: 0xf2efe8, roughness: 0.8, metalness: 0, emissive: 0xfff2dc }), 0, 0.35);
  const dark = std("dwtc_dark", { color: 0x3a4650, roughness: 0.3, metalness: 0.6 });
  const [cx, cz] = osm2c(2.15, 5.05, 48.3);
  const S = 47, ch = 3.2, SV = 1 / (4 * FH);
  const pl = movePoly(chamferRect(S, S, ch), cx, cz);
  K.add(facade, prism(pl, 8, 136, { su: 1 / 9.2, sv: SV, top: false, crease: 10 }));
  // ground floors: big arcade
  const arcade = archTex("dwtc-arcade", { n: 1, bg: "#f1eee6", hole: "#3f4b55", holeTop: "#20282e", glow: "#ffd9a0", pier: 0.14, spring: 0.45, top: 0.1, base: 1.0 });
  const arc = K.nightMat(std("dwtc_arcade", { color: 0xffffff, map: arcade.map, roughness: 0.8, emissive: 0xffffff, emissiveMap: arcade.em }), 0, 1.0);
  K.add(arc, prism(pl, 0, 8, { su: 1 / 6.5, sv: 1 / 8, top: false, crease: 10 }));
  // crown: a band of taller arches, a white parapet, a set-back plant storey and the mast
  K.add(arc, prism(offsetPoly(pl, 0.3), 136, 146, { su: 1 / 6.5, sv: 1 / 10, top: false, crease: 10, vOff: 136 }));
  K.add(white, prism(offsetPoly(pl, 0.6), 146, 149, { su: 1 / 8, sv: 1 / 8, bottom: true }));
  const plant = movePoly(chamferRect(26, 26, 2), cx, cz);
  K.add(white, prism(plant, 149, 155, { su: 1 / 8, sv: 1 / 8 }));
  K.add(dark, cyl(0.35, 1.0, 184 - 155, cx, 155, cz, 8));
  // white cornices every ten floors
  for (const y of [8, 45, 82, 119]) K.add(white, prism(offsetPoly(pl, 0.5), y - 0.4, y + 0.8, { su: 1 / 8, sv: 1 / 8, top: false, bottom: true }));
  return K.group("dubai_world_trade_centre");
}

// ================================================================================================
// 11. JUMEIRAH BEACH HOTEL
// OSM w10316322 (height 104, 26 levels): a 262 m long, 12-25 m deep curved block running NNE-SSW along
// the beach, concave to the sea. Its roofline is a breaking wave: low at the southern end, climbing to
// the 104 m crest near the north end and curling down at the tip. Blue glass with white balcony bands
// and a white crest, lit blue at night. True orientation.
// ================================================================================================
function buildJBH() {
  const K = new Kit();
  const FH = 3.9;
  const fac = facadeSet("jbh-fac", (ctx, W, H, mode, rnd) => {
    const rows = 4, rh = H / rows, cols = 5, cw = W / cols;
    ctx.fillStyle = mode === "map" ? "#3b77a8" : mode === "orm" ? ORM(0.06, 0.55) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) {
      if (mode === "em") { for (let c = 0; c < cols; c++) if (rnd() < 0.5) { ctx.fillStyle = litColor(rnd, 0.8); ctx.fillRect(c * cw + 2, r * rh + rh * 0.3, cw - 4, rh * 0.62); } continue; }
      ctx.fillStyle = mode === "map" ? "#f4f6f6" : ORM(0.5, 0.2); ctx.fillRect(0, r * rh, W, rh * 0.18);
      if (mode === "map") { ctx.fillStyle = "rgba(150,190,220,0.8)"; ctx.fillRect(0, r * rh + rh * 0.18, W, rh * 0.12); ctx.fillStyle = "#2d6190"; for (let c = 0; c < cols; c++) ctx.fillRect(c * cw, r * rh + rh * 0.3, 3, rh * 0.7); }
    }
  });
  const glass = facadeMat(K, "jbh_glass", fac, 1.3);
  const white = K.nightMat(std("jbh_white", { color: 0xf3f5f5, roughness: 0.4, metalness: 0.2, emissive: 0x6fb4ff }), 0, 1.3);
  const JB = [[50.8, 71.3], [49.2, 58.1], [44.1, 42.8], [45.7, 36.0], [46.1, 31.4], [45.0, 25.7], [41.1, 16.4], [37.8, 11.9], [33.0, 6.7], [28.2, 2.2], [19.8, -3.7], [24.9, -5.8], [1.7, -19.7], [-2.9, -23.2], [-21.3, -40.5], [-26.0, -45.8], [-34.8, -60.0], [-38.0, -65.3], [-42.8, -74.0], [-47.4, -84.4], [-52.3, -100.8], [-51.7, -102.8], [-51.5, -104.7], [-51.5, -106.5], [-51.9, -108.3], [-53.2, -110.4], [-54.8, -111.6], [-55.8, -116.9], [-56.7, -124.9], [-57.1, -135.6], [-59.4, -139.3], [-64.2, -140.6], [-68.5, -139.3], [-71.4, -136.9], [-71.0, -123.7], [-69.7, -108.4], [-62.2, -83.3], [-55.5, -67.6], [-51.3, -59.8], [-46.8, -53.3], [-38.7, -42.3], [-30.1, -33.7], [-19.1, -24.1], [-17.1, -18.4], [-15.0, -14.8], [-12.2, -12.9], [-8.3, -11.5], [-4.5, -11.5], [1.9, -4.3], [8.8, 4.3], [18.1, 19.6], [24.7, 34.1], [30.5, 48.4], [35.3, 66.9], [36.9, 75.0], [37.7, 83.6], [38.5, 93.8], [38.7, 104.5], [38.8, 115.4], [38.8, 116.1], [38.9, 116.8], [39.2, 117.7], [40.2, 119.2], [41.5, 120.4], [43.1, 121.1], [44.9, 121.3], [47.0, 120.9], [48.4, 120.2], [49.7, 118.8], [50.4, 117.4], [50.8, 115.7], [50.9, 110.3], [51.3, 104.3], [51.4, 98.2], [51.2, 84.0]];
  const out = ccw(resamplePoly(ccw(osmPoly(JB, 0)), 200));
  const zN = -121.3, zS = 140.6; // canonical z of the north and south tips
  const roofY = (x, z) => {
    const s = Math.min(1, Math.max(0, (zS - z) / (zS - zN))); // 0 south .. 1 north
    if (s < 0.84) return 20 + 84 * Math.pow(s / 0.84, 1.45);
    const t = (s - 0.84) / 0.16;
    return 104 - 44 * t * t;
  };
  const ringB = out.map(([x, z]) => V3(x, 0, z)), ringT = out.map(([x, z]) => V3(x, roofY(x, z), z));
  loft2(K, ringB, ringT, () => glass, { su: 1 / 10, sv: 1 / (4 * FH) });
  K.add(white, liftedCap(out, (x, z) => roofY(x, z) + 1.6, 1 / 10));
  // the white crest: a band standing proud all round the roofline
  const outO = offsetPoly(out, 0.5);
  loft2(K, outO.map(([x, z]) => V3(x, roofY(x, z) - 2.5, z)), outO.map(([x, z]) => V3(x, roofY(x, z) + 1.6, z)), () => white, { su: 1 / 8, sv: 1 / 8 });
  // ground-floor lobby band
  K.add(white, prism(offsetPoly(out, 0.4), 6, 7.2, { su: 1 / 8, sv: 1 / 8, top: false, bottom: true }));
  return K.group("jumeirah_beach_hotel");
}


// ================================================================================================
// 12. ATLANTIS THE ROYAL (Palm Jumeirah crescent)
// OSM outline w959856802 (193 m, 43 levels) is mapped part by part (w964652235..280, w964879814,
// w1243097903..905): stacked rectangular blocks, rotated against each other and separated by open
// sky-terrace gaps, round six cores; the west tower tops out at 193 m, the east at 161 m, and a sky bridge
// joins them at 76-92 m. Each block is glass with white balcony edges and planted terraces on its roof.
// Built straight from the OSM parts. True orientation.
// ================================================================================================
const ROYAL_PARTS = [
  [0, 189, "w964652235 Core 1", [[-160.2, -62.2], [-146.8, -75.1], [-134.7, -63.5], [-122.6, -52.1], [-134.8, -37.9], [-148.8, -50.7]]],
  [0, 145, "w964652236 Core 2", [[-75.2, -0.1], [-68.1, -18.8], [-76.0, -22.4], [-88.9, -28.5], [-98.7, -34.1], [-108.4, -17.0], [-92.5, -8.0]]],
  [0, 95, "w964652237 Core 3", [[-17.5, -7.8], [-19.2, 11.8], [-31.1, 10.7], [-42.4, 9.2], [-47.1, 8.3], [-43.8, -11.7], [-30.6, -9.5]]],
  [0, 80, "w964652238 Core A", [[34.2, -2.9], [31.6, 16.8], [46.1, 18.4], [59.4, 20.4], [62.4, 0.6], [52.0, -0.9]]],
  [0, 110, "w964652239 Core B", [[91.1, 6.2], [85.1, 26.7], [100.3, 31.8], [112.4, 37.0], [121.4, 18.5], [106.7, 11.5]]],
  [0, 157, "w964652240 Core C", [[147.8, 34.5], [135.3, 50.9], [151.5, 63.8], [161.5, 73.7], [177.4, 60.0], [168.6, 51.1], [156.1, 40.6]]],
  [24, 41, "w964652241 ", [[196.1, 80.9], [176.6, 94.5], [169.9, 84.7], [161.6, 74.7], [150.5, 64.1], [133.8, 50.9], [147.4, 33.2], [148.5, 31.7], [157.4, 38.3], [169.7, 48.1], [180.7, 58.9], [188.9, 69.4]]],
  [60, 73, "w964652242 ", [[148.5, 31.7], [157.4, 38.3], [169.7, 48.1], [180.7, 58.9], [188.9, 69.4], [187.9, 70.2], [169.9, 84.7], [161.6, 74.7], [150.5, 64.1], [133.8, 50.9], [147.4, 33.2]]],
  [92, 105, "w964652243 ", [[169.9, 84.7], [161.6, 74.7], [150.5, 64.1], [133.8, 50.9], [147.4, 33.2], [148.5, 31.7], [157.4, 38.3], [169.7, 48.1], [180.7, 58.9], [188.9, 69.4], [187.9, 70.2]]],
  [124, 137, "w964652244 ", [[169.9, 84.7], [161.6, 74.7], [150.5, 64.1], [133.8, 50.9], [147.4, 33.2], [148.5, 31.7], [157.4, 38.3], [169.7, 48.1], [180.7, 58.9], [188.9, 69.4], [187.9, 70.2]]],
  [152, 161, "w964652245 ", [[169.9, 84.7], [161.6, 74.7], [150.5, 64.1], [133.8, 50.9], [147.4, 33.2], [148.5, 31.7], [157.4, 38.3], [169.7, 48.1], [180.7, 58.9], [188.9, 69.4], [187.9, 70.2]]],
  [44, 57, "w964652246 ", [[159.9, 76.4], [179.1, 60.0], [168.1, 49.5], [156.3, 39.5], [147.4, 33.2], [136.6, 25.5], [121.4, 17.2], [106.9, 10.6], [90.6, 5.1], [84.0, 27.1], [83.6, 28.7], [99.0, 33.8], [112.7, 40.0], [123.3, 46.5], [135.7, 55.0], [148.2, 65.1]]],
  [76, 89, "w964652247 ", [[159.9, 76.4], [179.1, 60.0], [168.1, 49.5], [156.3, 39.5], [147.4, 33.2], [136.6, 25.5], [121.4, 17.2], [106.9, 10.6], [90.6, 5.1], [84.0, 27.1], [83.6, 28.7], [99.0, 33.8], [112.7, 40.0], [123.3, 46.5], [135.7, 55.0], [148.2, 65.1]]],
  [108, 121, "w964652248 ", [[159.9, 76.4], [179.1, 60.0], [168.1, 49.5], [156.3, 39.5], [147.4, 33.2], [136.6, 25.5], [121.4, 17.2], [106.9, 10.6], [90.6, 5.1], [84.0, 27.1], [83.6, 28.7], [99.0, 33.8], [112.7, 40.0], [123.3, 46.5], [135.7, 55.0], [148.2, 65.1]]],
  [140, 149, "w964652249 ", [[159.9, 76.4], [179.1, 60.0], [168.1, 49.5], [156.3, 39.5], [147.4, 33.2], [136.6, 25.5], [123.3, 46.5], [135.7, 55.0], [148.2, 65.1]]],
  [24, 41, "w964652250 ", [[112.8, 38.0], [123.7, 16.2], [113.5, 11.2], [102.6, 6.8], [91.1, 3.2], [78.6, 0.1], [63.5, -2.3], [48.3, -4.3], [33.7, -5.8], [33.5, -3.9], [30.7, 17.6], [45.6, 19.5], [58.9, 21.4], [72.7, 24.2], [84.0, 27.1], [100.3, 32.6]]],
  [60, 73, "w964652251 ", [[112.8, 38.0], [123.7, 16.2], [113.5, 11.2], [102.6, 6.8], [91.1, 3.2], [78.6, 0.1], [63.5, -2.3], [48.3, -4.3], [33.7, -5.8], [33.5, -3.9], [30.7, 17.6], [45.6, 19.5], [58.9, 21.4], [72.7, 24.2], [84.0, 27.1], [100.3, 32.6]]],
  [92, 105, "w964652252 ", [[112.8, 38.0], [123.7, 16.2], [113.5, 11.2], [102.6, 6.8], [91.1, 3.2], [78.6, 0.1], [72.7, 24.2], [84.0, 27.1], [100.3, 32.6]]],
  [44, 57, "w964652253 ", [[59.6, 23.4], [63.2, -0.1], [51.4, -1.8], [33.5, -3.9], [29.5, -4.3], [26.7, 18.8], [43.3, 20.7]]],
  [24, 41, "w964652254 ", [[-171.6, -68.5], [-162.1, -77.1], [-154.0, -84.4], [-143.9, -73.7], [-132.5, -62.5], [-121.3, -52.1], [-136.2, -35.0], [-146.1, -43.2], [-156.7, -53.3]]],
  [60, 73, "w964652255 ", [[-171.6, -68.5], [-162.1, -77.1], [-154.0, -84.4], [-143.9, -73.7], [-132.5, -62.5], [-121.3, -52.1], [-136.2, -35.0], [-146.1, -43.2], [-156.7, -53.3]]],
  [92, 105, "w964652256 ", [[-136.2, -35.0], [-146.1, -43.2], [-156.7, -53.3], [-171.6, -68.5], [-162.1, -77.1], [-154.0, -84.4], [-143.9, -73.7], [-132.5, -62.5], [-121.3, -52.1]]],
  [124, 137, "w964652257 ", [[-171.6, -68.5], [-162.1, -77.1], [-154.0, -84.4], [-143.9, -73.7], [-132.5, -62.5], [-121.3, -52.1], [-136.2, -35.0], [-146.1, -43.2], [-156.7, -53.3]]],
  [156, 169, "w964652258 ", [[-171.6, -68.5], [-162.1, -77.1], [-154.0, -84.4], [-143.9, -73.7], [-132.5, -62.5], [-121.3, -52.1], [-136.2, -35.0], [-146.1, -43.2], [-156.7, -53.3]]],
  [184, 193, "w964652259 ", [[-136.2, -35.0], [-146.1, -43.2], [-156.7, -53.3], [-171.6, -68.5], [-162.1, -77.1], [-154.0, -84.4], [-143.9, -73.7], [-132.5, -62.5], [-121.3, -52.1]]],
  [44, 57, "w964652260 ", [[-161.2, -62.3], [-144.7, -78.2], [-133.2, -66.4], [-121.1, -55.0], [-118.5, -52.9], [-114.6, -49.7], [-109.0, -45.1], [-97.6, -37.2], [-83.4, -29.4], [-69.4, -22.7], [-66.3, -21.5], [-74.7, 1.2], [-93.3, -7.2], [-109.1, -16.4], [-123.2, -27.0], [-129.6, -32.4], [-135.4, -37.2], [-148.3, -48.8]]],
  [76, 89, "w964652261 ", [[-161.2, -62.3], [-144.7, -78.2], [-133.2, -66.4], [-121.1, -55.0], [-118.5, -52.9], [-114.6, -49.7], [-109.0, -45.1], [-97.6, -37.2], [-83.4, -29.4], [-69.4, -22.7], [-66.3, -21.5], [-74.7, 1.2], [-93.3, -7.2], [-109.1, -16.4], [-123.2, -27.0], [-129.6, -32.4], [-135.4, -37.2], [-148.3, -48.8]]],
  [109, 121, "w964652262 ", [[-161.2, -62.3], [-144.7, -78.2], [-133.2, -66.4], [-121.1, -55.0], [-118.5, -52.9], [-114.6, -49.7], [-109.0, -45.1], [-97.6, -37.2], [-83.4, -29.4], [-69.4, -22.7], [-66.3, -21.5], [-74.7, 1.2], [-93.3, -7.2], [-109.1, -16.4], [-123.2, -27.0], [-129.6, -32.4], [-135.4, -37.2], [-148.3, -48.8]]],
  [140, 153, "w964652263 ", [[-161.2, -62.3], [-144.7, -78.2], [-133.2, -66.4], [-121.1, -55.0], [-118.5, -52.9], [-114.6, -49.7], [-109.0, -45.1], [-97.6, -37.2], [-83.4, -29.4], [-69.4, -22.7], [-66.3, -21.5], [-74.7, 1.2], [-93.3, -7.2], [-109.1, -16.4], [-123.2, -27.0], [-129.6, -32.4], [-135.4, -37.2], [-148.3, -48.8]]],
  [172, 181, "w964652264 ", [[-161.2, -62.3], [-144.7, -78.2], [-133.2, -66.4], [-121.1, -55.0], [-118.5, -52.9], [-114.6, -49.7], [-129.6, -32.4], [-135.4, -37.2], [-148.3, -48.8]]],
  [24, 41, "w964652265 ", [[-110.7, -15.4], [-99.2, -35.4], [-88.3, -29.3], [-74.6, -22.8], [-67.7, -19.7], [-60.1, -17.0], [-54.4, -15.1], [-47.8, -13.4], [-35.5, -11.3], [-16.5, -8.8], [-18.5, 14.1], [-31.7, 12.9], [-40.7, 11.8], [-48.2, 10.6], [-54.2, 9.5], [-60.7, 7.8], [-68.5, 5.6], [-75.5, 3.1], [-85.8, -1.4], [-99.0, -8.2]]],
  [60, 73, "w964652266 ", [[-110.7, -15.4], [-99.2, -35.4], [-88.3, -29.3], [-74.6, -22.8], [-67.7, -19.7], [-60.1, -17.0], [-54.4, -15.1], [-47.8, -13.4], [-35.5, -11.3], [-16.5, -8.8], [-18.5, 14.1], [-31.7, 12.9], [-40.7, 11.8], [-48.2, 10.6], [-54.2, 9.5], [-60.7, 7.8], [-68.5, 5.6], [-75.5, 3.1], [-85.8, -1.4], [-99.0, -8.2]]],
  [92, 105, "w964652267 ", [[-110.7, -15.4], [-99.2, -35.4], [-88.3, -29.3], [-74.6, -22.8], [-67.7, -19.7], [-60.1, -17.0], [-54.4, -15.1], [-47.8, -13.4], [-35.5, -11.3], [-16.5, -8.8], [-18.5, 14.1], [-31.7, 12.9], [-40.7, 11.8], [-48.2, 10.6], [-54.2, 9.5], [-60.7, 7.8], [-68.5, 5.6], [-75.5, 3.1], [-85.8, -1.4], [-99.0, -8.2]]],
  [124, 137, "w964652268 ", [[-110.7, -15.4], [-99.2, -35.4], [-88.3, -29.3], [-74.6, -22.8], [-67.7, -19.7], [-60.1, -17.0], [-54.4, -15.1], [-60.7, 7.8], [-68.5, 5.6], [-75.5, 3.1], [-85.8, -1.4], [-99.0, -8.2]]],
  [44, 57, "w964652269 ", [[-48.0, 8.9], [-44.1, -14.6], [-34.5, -12.9], [-12.1, -10.0], [-14.0, 13.1], [-19.6, 12.7], [-31.2, 11.5], [-42.1, 10.1]]],
  [76, 90, "w964652270 ", [[-44.1, -14.6], [-34.5, -12.9], [-12.1, -10.0], [33.7, -5.8], [48.3, -4.3], [63.5, -2.3], [63.2, -0.1], [59.6, 23.4], [43.3, 20.7], [26.7, 18.8], [-18.5, 14.1], [-31.7, 12.9], [-40.7, 11.8], [-48.2, 10.6], [-48.0, 8.9]]],
  [0, 21, "w964652272 ", [[90.6, 5.1], [106.9, 10.6], [121.4, 17.2], [136.6, 25.5], [147.4, 33.2], [156.3, 39.5], [168.1, 49.5], [179.1, 60.0], [187.9, 70.2], [169.9, 84.7], [168.2, 86.1], [159.9, 76.4], [148.2, 65.1], [135.7, 55.0], [123.3, 46.5], [112.7, 40.0], [99.0, 33.8], [83.6, 28.7], [84.0, 27.1]]],
  [0, 22, "w964652273 ", [[-152.2, -86.0], [-154.0, -84.4], [-162.1, -77.1], [-171.6, -68.5], [-156.7, -53.3], [-146.1, -43.2], [-136.2, -35.0], [-123.7, -24.6], [-110.7, -15.4], [-99.0, -8.2], [-85.8, -1.4], [-75.5, 3.1], [-74.7, 1.2], [-66.3, -21.5], [-69.4, -22.7], [-83.4, -29.4], [-97.6, -37.2], [-109.0, -45.1], [-114.6, -49.7], [-118.5, -52.9], [-121.1, -55.0], [-133.2, -66.4], [-144.7, -78.2], [-148.0, -81.7]]],
  [0, 13, "w964652274 ", [[175.0, 95.6], [176.6, 94.5], [196.1, 80.9], [188.9, 69.4], [180.7, 58.9], [169.7, 48.1], [157.4, 38.3], [148.5, 31.7], [136.6, 23.4], [123.7, 16.2], [113.5, 11.2], [102.6, 6.8], [91.1, 3.2], [90.6, 5.1], [84.0, 27.1], [83.6, 28.7], [99.0, 33.8], [112.7, 40.0], [123.3, 46.5], [135.7, 55.0], [148.2, 65.1], [159.9, 76.4], [168.2, 86.1]]],
  [0, 21, "w964652278 ", [[-12.6, -38.4], [-10.9, -38.2], [-12.4, -23.5], [-14.2, -23.7]]],
  [0, 21, "w964652279 ", [[36.8, -33.3], [35.0, -33.5], [33.2, -18.8], [35.0, -18.7]]],
  [0, 20, "w964879814 ", [[-75.5, 3.1], [-74.7, 1.2], [-66.3, -21.5], [-53.5, -17.1], [-44.1, -14.6], [-34.5, -12.9], [-12.1, -10.0], [33.7, -5.8], [48.3, -4.3], [63.5, -2.3], [78.6, 0.1], [91.1, 3.2], [90.6, 5.1], [84.0, 27.1], [83.6, 28.7], [71.8, 25.9], [59.6, 23.4], [43.3, 20.7], [26.7, 18.8], [-18.5, 14.1], [-31.7, 12.9], [-40.7, 11.8], [-48.2, 10.6], [-54.2, 9.5], [-60.7, 7.8]]],
  [20, 21, "w1243097903 ", [[-23.0, 55.0], [-19.9, 55.3], [22.5, 60.5], [25.7, 60.8], [26.0, 58.2], [29.3, 29.0], [20.1, 27.9], [17.5, 51.1], [-12.3, 47.7], [-9.8, 24.5], [-19.6, 23.4], [-22.7, 52.3]]],
  [0, 21, "w1243097904 ", [[-23.0, 55.0], [-19.9, 55.3], [-19.6, 52.6], [-22.7, 52.3]]],
  [0, 21, "w1243097905 ", [[22.5, 60.5], [25.7, 60.8], [26.0, 58.2], [22.8, 57.8]]],
  [90, 92, "w964652271 Sky Bridge", [[-75.2, -0.1], [-77.1, 4.5], [-69.6, 7.4], [-61.5, 10.0], [-51.9, 12.2], [-41.0, 13.8], [-29.6, 15.4], [-17.4, 16.6], [11.9, 19.2], [26.6, 20.5], [39.8, 22.1], [51.2, 23.7], [60.4, 25.5], [71.8, 27.9], [83.9, 30.6], [85.1, 26.7], [91.1, 6.2], [92.6, 1.7], [79.6, -1.8], [63.7, -4.4], [34.1, -7.9], [-12.1, -12.1], [-34.1, -14.8], [-43.7, -16.6], [-52.9, -19.1], [-66.1, -23.6], [-68.1, -18.8]]],
];
function buildAtlantisRoyal() {
  const K = new Kit();
  const FH = 3.25;
  const fac = facadeSet("royal-fac", (ctx, W, H, mode, rnd) => {
    // 4 floors: deep white balcony slab edges, glass balustrade, grey-green glass behind
    const rows = 4, rh = H / rows, cols = 5, cw = W / cols;
    ctx.fillStyle = mode === "map" ? "#6d858c" : mode === "orm" ? ORM(0.07, 0.55) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) {
      if (mode === "em") { for (let c = 0; c < cols; c++) if (rnd() < 0.5) { ctx.fillStyle = litColor(rnd, 0.9); ctx.fillRect(c * cw + 2, r * rh + rh * 0.34, cw - 4, rh * 0.6); } continue; }
      ctx.fillStyle = mode === "map" ? "#f3f1ec" : ORM(0.6, 0.05); ctx.fillRect(0, r * rh, W, rh * 0.2);
      if (mode === "map") { ctx.fillStyle = "rgba(190,210,212,0.75)"; ctx.fillRect(0, r * rh + rh * 0.2, W, rh * 0.14); ctx.fillStyle = "#4c6167"; for (let c = 0; c < cols; c++) ctx.fillRect(c * cw, r * rh + rh * 0.34, 3, rh * 0.66); }
    }
  });
  const glass = facadeMat(K, "royal_glass", fac, 1.3);
  const coreTex = canvasTex("royal-core", 128, (ctx, W, H) => {
    ctx.fillStyle = "#e9e4da"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#b9b2a5"; for (let i = 0; i < 4; i++) ctx.fillRect(i * W / 4 + W / 8 - 3, 0, 6, H);
    ctx.fillStyle = "rgba(150,140,125,0.4)"; for (let j = 0; j < 8; j++) ctx.fillRect(0, j * H / 8, W, 1.5);
  });
  const core = K.nightMat(std("royal_core", { color: 0xffffff, map: coreTex, roughness: 0.8, metalness: 0, emissive: 0xffe4c0 }), 0, 0.15);
  const terraceTex = canvasTex("royal-terrace", 128, (ctx, W, H) => {
    ctx.fillStyle = "#cbbfa8"; ctx.fillRect(0, 0, W, H);
    const r = mulberry32(8);
    for (let i = 0; i < 70; i++) { ctx.fillStyle = r() < 0.7 ? `rgb(${60 + r() * 40 | 0},${110 + r() * 50 | 0},${50 + r() * 30 | 0})` : `rgb(${70 + r() * 30 | 0},${170 + r() * 40 | 0},${200 + r() * 40 | 0})`; ctx.beginPath(); ctx.arc(r() * W, r() * H, 3 + r() * 8, 0, TAU); ctx.fill(); }
  });
  const terrace = std("royal_terrace", { color: 0xffffff, map: terraceTex, roughness: 0.9, metalness: 0 });
  const SV = 1 / (4 * FH);
  for (const [h0, h1, name, pts] of ROYAL_PARTS) {
    if (h1 - h0 < 0.5) continue;
    const pl = osmPoly(pts, 0);
    const isCore = name.includes("Core");
    const low = h0 === 0 && h1 <= 22;
    if (isCore) {
      K.add(core, prism(pl, h0, h1, { su: 1 / 10, sv: 1 / 10, top: false, crease: 20 }));
      K.add(terrace, capXZ(pl, h1, true, 1 / 12));
    } else {
      K.add(glass, prism(pl, h0, h1, { su: 1 / 12, sv: SV, top: false, crease: 20, vOff: h0 }));
      K.add(terrace, capXZ(pl, h1, true, 1 / 12));
      if (h0 > 0) K.add(core, capXZ(pl, h0, false, 1 / 12));
      // white slab edge round the top of every block
      if (!low) K.add(core, prism(offsetPoly(pl, 0.35), h1 - 1.1, h1 + 0.5, { top: false, bottom: true, su: 1 / 8, sv: 1 / 8 }));
    }
  }
  return K.group("atlantis_the_royal");
}

// ================================================================================================
// 13. THE GATE (DIFC)
// OSM w256973497 ("Dubai International Financial Centre", 15 levels, height 60): a 62.5 m square turned
// 27.8 deg. Twin granite-clad blocks linked at the top by a steel-framed bridge, a triumphal arch whose
// opening lines up with the DIFC promenade (east-south-east). Canonical: the passage runs along X.
// ================================================================================================
function buildTheGate() {
  const K = new Kit();
  const FH = 4.0;
  const stone = facadeSet("gate-stone", (ctx, W, H, mode, rnd) => {
    // 3 bays x 2 floors of tall punched windows in pale granite
    const cols = 3, rows = 2, cw = W / cols, rh = H / rows;
    ctx.fillStyle = mode === "map" ? "#d6cfc2" : mode === "orm" ? ORM(0.6, 0.05) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * cw + cw * 0.22, y = r * rh + rh * 0.16, w = cw * 0.56, h = rh * 0.7;
      if (mode === "map") { ctx.fillStyle = "#3a4852"; ctx.fillRect(x, y, w, h); ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(x, y, w, 4); }
      else if (mode === "orm") { ctx.fillStyle = ORM(0.06, 0.6); ctx.fillRect(x, y, w, h); }
      else if (rnd() < 0.5) { ctx.fillStyle = litColor(rnd, 0.6); ctx.fillRect(x, y, w, h); }
    }
    if (mode === "map") { ctx.fillStyle = "rgba(150,140,125,0.5)"; for (let r = 0; r < rows; r++) ctx.fillRect(0, r * rh, W, 2); }
  });
  const facade = facadeMat(K, "gate_stone", stone, 1.2);
  const gt = curtainTex("gate-glass", { cols: 4, rows: 4, glass: [60, 88, 104], frame: "#aeb6bc", mullion: 0.08, spandrel: 0.1, litFrac: 0.6, warm: 0.7, seed: 23, glassMetal: 0.6, glassRough: 0.05 });
  const glass = glassMat(K, "gate_glass", gt, { night: 1.4 });
  const cap = K.nightMat(std("gate_cap", { color: 0xc9c2b5, roughness: 0.6, metalness: 0.1, emissive: 0xfff0d8 }), 0, 0.25);
  const steel = std("gate_steel", { color: 0x8e979e, roughness: 0.4, metalness: 0.8 });
  const [cx, cz] = osm2c(0, 0, 27.8);
  void cx; void cz;
  const A = 31.2, OW = 11.5, OH = 44, TOP = 60, SV = 1 / (2 * FH);
  // the two legs (outer faces stone, faces toward the opening glass)
  for (const s of [-1, 1]) {
    const z0 = s < 0 ? -A : OW, z1 = s < 0 ? -OW : A;
    addWallsBy(K, rectXZ(-A, A, z0, z1), 0, TOP, (nx, nz) => ((nz > 0.5 && s < 0) || (nz < -0.5 && s > 0) ? glass : facade), { su: 1 / 10.5, sv: SV });
    K.add(cap, capXZ(rectXZ(-A, A, z0, z1), TOP, true));
  }
  // the bridge over the opening: glass soffit, stone faces
  addWallsBy(K, rectXZ(-A, A, -OW, OW), OH, TOP, (nx) => (Math.abs(nx) > 0.5 ? facade : null), { su: 1 / 10.5, sv: SV });
  K.add(glass, capXZ(rectXZ(-A, A, -OW, OW), OH, false, 1 / 8));
  K.add(cap, capXZ(rectXZ(-A, A, -OW, OW), TOP, true));
  // deep portal frame round the opening on both fronts, and the steel arch trusses in the soffit
  for (const sx of [-1, 1]) {
    const x = sx * (A + 0.8);
    K.add(cap, box(1.6, TOP + 1.5, 2.6, x, (TOP + 1.5) / 2, -OW - 1.3));
    K.add(cap, box(1.6, TOP + 1.5, 2.6, x, (TOP + 1.5) / 2, OW + 1.3));
    K.add(cap, box(1.6, 3, 2 * OW + 5.2, x, OH - 1.5, 0));
    K.add(cap, box(1.6, 2, 2 * A + 3.2, x, TOP + 0.5, 0, Math.PI / 2 * 0));
  }
  for (let i = -3; i <= 3; i++) K.add(steel, box(1.0, 2.2, 2 * OW, i * 9, OH - 1.1, 0));
  // parapet
  K.add(cap, prism(offsetPoly(rectXZ(-A, A, -A, A), 0.4), TOP, TOP + 1.6, { top: false, bottom: true }));
  return K.group("the_gate");
}


// ================================================================================================
// 14. ADNOC HEADQUARTERS (Abu Dhabi Corniche)
// OSM w242540551 (342 m, 65 levels) with parts: glass body w1101331781 (24-284), upper glass w1101331794
// (284-308), the two sharp end blades w499309691 / w499309692 (to 332) and the crown plate w1101331782
// (332-342). A slim slab, its long faces gently curved, its ends drawn to blade-like edges; the top is an
// open frame, the crown plate floating on the two end blades above the last floors. Silver-blue double-skin
// glass; the blades and crown are lit at night. Canonical: long faces along X, headingDeg = -13.4.
// ================================================================================================
function buildADNOC() {
  const K = new Kit();
  const H0 = -13.4, FH = 4.0;
  const fac = facadeSet("adnoc-fac", (ctx, W, H, mode, rnd) => {
    // 8 bays x 4 floors: silver-blue glass, fine white vertical fins, light spandrels
    const cols = 8, rows = 4, cw = W / cols, rh = H / rows;
    ctx.fillStyle = mode === "map" ? "#dfe6ea" : mode === "orm" ? ORM(0.3, 0.9) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * cw + cw * 0.1, y = r * rh + rh * 0.08, w = cw * 0.8, h = rh * 0.86;
      if (mode === "map") { const v = 0.93 + rnd() * 0.12; ctx.fillStyle = `rgb(${86 * v | 0},${116 * v | 0},${138 * v | 0})`; }
      else if (mode === "orm") ctx.fillStyle = ORM(0.05, 0.75);
      else ctx.fillStyle = rnd() < 0.45 ? litColor(rnd, 0.5) : "#000";
      ctx.fillRect(x, y, w, h);
    }
  });
  const glass = facadeMat(K, "adnoc_glass", fac, 1.3);
  const bladeTex = canvasTex("adnoc-blade", 128, (ctx, W, H) => {
    ctx.fillStyle = "#cfd8de"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#9fb0bb"; for (let i = 0; i < 8; i++) ctx.fillRect(0, i * H / 8, W, 3);
  });
  const blade = K.nightMat(std("adnoc_blade", { color: 0xffffff, map: bladeTex, roughness: 0.25, metalness: 0.85, emissive: 0xcfe6ff, emissiveMap: bladeTex }), 0, 0.9);
  const lobbyT = curtainTex("adnoc-lobby", { cols: 3, rows: 1, glass: [70, 96, 112], frame: "#d9dee2", mullion: 0.06, spandrel: 0.03, litFrac: 0.9, warm: 0.8, seed: 44 });
  const lobby = glassMat(K, "adnoc_lobby", lobbyT, { night: 1.6 });
  const P = (pts) => osmPoly(pts, H0);
  // glass body: the OSM outline with its long faces bowed out ~1.5 m
  const BODY = [[-38.6, 6.0], [-38.4, 8.8], [12.0, 20.8], [16.8, 19.1], [38.0, -4.3], [36.2, -7.5], [19.5, -11.5], [-12.6, -19.2], [-17.1, -17.7]];
  const bow = (pts, amt) => {
    const out = [];
    const p = ccw(pts);
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      out.push(a);
      if (l > 25) {
        const n = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
        for (let k = 1; k < 8; k++) { const t = k / 8, s = Math.sin(Math.PI * t) * amt; out.push([a[0] + (b[0] - a[0]) * t + n[0] * s, a[1] + (b[1] - a[1]) * t + n[1] * s]); }
      }
    }
    return out;
  };
  const body = bow(P(BODY), 1.5);
  const SV = 1 / (4 * FH);
  K.add(glass, prism(body, 24, 284, { su: 1 / 14, sv: SV, top: false, crease: 12 }));
  K.add(lobby, prism(offsetPoly(body, -3), 0, 24, { su: 1 / 10, sv: 1 / 12, top: false, crease: 12 }));
  K.add(blade, capXZ(body, 24, false));
  const upper = bow(P([[17.5, 16.2], [34.4, -2.3], [-17.9, -14.7], [-35.1, 3.8]]), 1.2);
  K.add(glass, prism(upper, 284, 308, { su: 1 / 14, sv: SV, top: false, crease: 12 }));
  K.add(blade, capXZ(body, 284, true));
  K.add(blade, capXZ(upper, 308, true));
  // the end blades, full height to the crown plate
  for (const B of [[[25.8, 24.1], [16.8, 19.1], [38.0, -4.3], [51.3, -3.9]], [[-38.6, 6.0], [-51.4, 5.7], [-26.0, -22.3], [-17.1, -17.7]]]) {
    K.add(blade, prism(P(B), 0, 332, { su: 1 / 8, sv: 1 / 8, top: false, crease: 10 }));
  }
  // crown plate 332-342 over the whole outline, with a thin lit edge
  const OUT = [[-51.4, 5.7], [-26.0, -22.3], [19.5, -11.5], [51.3, -3.9], [25.8, 24.1]];
  const crown = bow(P(OUT), 1.5);
  K.add(blade, prism(crown, 332, 342, { su: 1 / 8, sv: 1 / 10, bottom: true, crease: 12 }));
  // slender columns round the recessed lobby, under the edge of the glass body
  for (const [x, z] of resamplePoly(offsetPoly(body, -1.2), 22)) K.add(blade, cyl(0.6, 0.6, 24, x, 0, z, 8));
  return K.group("adnoc_hq");
}

// ================================================================================================
// 15. THE LANDMARK (Abu Dhabi Corniche)
// OSM w284811564 (office, 72 levels, 324 m): a long lozenge ~77 x 55 m, two curved faces and two short
// straight faces, point-symmetric (the "desert flower / dodecagon" plan) with notched corners. Top floor
// ~268 m, then a 60 m glass-and-steel towertop that tapers to the mast at 324 m. Pale blue-green glass
// with fine vertical mullions. True orientation.
// ================================================================================================
function buildLandmark() {
  const K = new Kit();
  const FH = 3.7;
  const fac = facadeSet("lmk-fac", (ctx, W, H, mode, rnd) => {
    const cols = 8, rows = 4, cw = W / cols, rh = H / rows;
    ctx.fillStyle = mode === "map" ? "#cfdadc" : mode === "orm" ? ORM(0.3, 0.9) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * cw + 2, y = r * rh + rh * 0.12, w = cw - 4, h = rh * 0.82;
      if (mode === "map") { const v = 0.93 + rnd() * 0.12; ctx.fillStyle = `rgb(${88 * v | 0},${132 * v | 0},${140 * v | 0})`; }
      else if (mode === "orm") ctx.fillStyle = ORM(0.05, 0.7);
      else ctx.fillStyle = rnd() < 0.42 ? litColor(rnd, 0.6) : "#000";
      ctx.fillRect(x, y, w, h);
    }
  });
  const glass = facadeMat(K, "lmk_glass", fac, 1.3);
  const screenTex = canvasTex("lmk-screen", 128, (ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(150,200,210,0.55)"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#eef3f4"; for (let i = 0; i < 8; i++) ctx.fillRect(i * W / 8, 0, 4, H);
    ctx.fillRect(0, 0, W, 4); ctx.fillRect(0, H / 2, W, 3);
  });
  const screen = K.nightMat(std("lmk_screen", { color: 0xffffff, map: screenTex, alphaTest: 0.35, transparent: false, roughness: 0.2, metalness: 0.7, side: THREE.DoubleSide, emissive: 0xbfeaff, emissiveMap: screenTex }), 0, 1.0);
  const steel = K.nightMat(std("lmk_steel", { color: 0xe3e8ea, roughness: 0.35, metalness: 0.7, emissive: 0xffffff }), 0, 0.3);
  const LM = [[38.3, -2.0], [30.5, 3.6], [22.1, 9.7], [8.8, 17.8], [-6.6, 23.2], [-21.4, 26.6], [-26.6, 27.8], [-38.4, 2.5], [-28.2, -5.0], [-20.5, -10.6], [-8.7, -17.6], [5.8, -23.2], [18.2, -25.7], [26.5, -27.3]];
  // notch the four corners (a recessed slot running the full height)
  const base = ccw(osmPoly(LM, 0));
  const notched = [];
  for (let i = 0; i < base.length; i++) {
    const a = base[(i - 1 + base.length) % base.length], b = base[i], c = base[(i + 1) % base.length];
    const turn = Math.abs(Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])));
    if (turn > 0.6) {
      const la = Math.hypot(b[0] - a[0], b[1] - a[1]), lc = Math.hypot(c[0] - b[0], c[1] - b[1]), d = 2.2;
      const pa = [b[0] + (a[0] - b[0]) * d / la, b[1] + (a[1] - b[1]) * d / la], pc = [b[0] + (c[0] - b[0]) * d / lc, b[1] + (c[1] - b[1]) * d / lc];
      notched.push(pa, [pa[0] + pc[0] - b[0], pa[1] + pc[1] - b[1]], pc);
    } else notched.push(b);
  }
  const SV = 1 / (4 * FH), Y1 = 266;
  K.add(glass, prism(notched, 0, Y1, { su: 1 / 12, sv: SV, top: false, crease: 25 }));
  K.add(steel, capXZ(notched, Y1, true));
  // the towertop: the facade continues as a glass-and-steel screen, drawn in to the mast
  const c0 = centroidXZ(base);
  const ring = ccw(resamplePoly(base, 72));
  const rings = [];
  for (let j = 0; j <= 8; j++) {
    const t = j / 8, s = 1 - 0.8 * Math.pow(t, 1.25);
    rings.push(ring.map(([x, z]) => V3(c0[0] + (x - c0[0]) * s, Y1 + t * 46, c0[1] + (z - c0[1]) * s)));
  }
  K.add(screen, loftRings(rings, { su: 1 / 8, sv: 1 / 12, vFromY: true }));
  for (let k = 0; k < 12; k++) {
    const i = Math.round((k / 12) * ring.length) % ring.length;
    for (let j = 0; j < 8; j++) K.add(steel, beam(rings[j][i], rings[j + 1][i], 0.6, 0.6));
  }
  K.add(steel, prism(offsetPoly(ring, 0.3), Y1, Y1 + 1.4, { top: false, bottom: true }));
  K.add(steel, cyl(0.35, 1.6, 324 - (Y1 + 30), c0[0], Y1 + 30, c0[1], 8));
  return K.group("the_landmark");
}

// ================================================================================================
// 16. AL BAHAR TOWERS (Al Bahr, Abu Dhabi)
// OSM parts w169979400 / w169979402 (29 levels, 145 m) on the podium outline w170243985. Two round
// towers, gently swelling and domed at the top, wrapped (except on the north side) in the computer-
// controlled mashrabiya: a honeycomb of hexagonal units, each six folding triangular fabric panels,
// standing ~2 m off the glass. True orientation.
// ================================================================================================
function buildAlBahar() {
  const K = new Kit();
  const FH = 4.3;
  const gtex = curtainTex("bahar-glass", { cols: 6, rows: 4, glass: [52, 74, 86], frame: "#b9c1c6", mullion: 0.06, spandrel: 0.1, litFrac: 0.45, warm: 0.7, seed: 51, glassMetal: 0.6, glassRough: 0.05 });
  const glass = glassMat(K, "bahar_glass", gtex, { night: 1.3 });
  // honeycomb of hexagonal units made of six triangles, panels partly open (alpha) with a frame
  const hexDraw = (lit) => (ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    const cols = 2, R = W / cols / Math.sqrt(3); // pointy-top hexes: width sqrt(3) R; H must be 3R per 2 rows
    const cells = [];
    for (let r = -1; r <= 2; r++) for (let c = -1; c <= cols; c++) cells.push([c * Math.sqrt(3) * R + (r % 2 ? Math.sqrt(3) * R / 2 : 0) + Math.sqrt(3) * R / 2, r * 1.5 * R + R]);
    for (const [cx, cy] of cells) {
      for (let k = 0; k < 6; k++) {
        const a0 = (k / 6) * TAU - Math.PI / 2, a1 = ((k + 1) / 6) * TAU - Math.PI / 2;
        const p0 = [cx + R * 0.94 * Math.cos(a0), cy + R * 0.94 * Math.sin(a0)], p1 = [cx + R * 0.94 * Math.cos(a1), cy + R * 0.94 * Math.sin(a1)];
        // panel: a triangle folded toward the centre, with a gap at the hub (the "umbrella" opened a little)
        const q0 = [cx + (p0[0] - cx) * 0.2, cy + (p0[1] - cy) * 0.2], q1 = [cx + (p1[0] - cx) * 0.2, cy + (p1[1] - cy) * 0.2];
        ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.lineTo(q1[0], q1[1]); ctx.lineTo(q0[0], q0[1]); ctx.closePath();
        ctx.fillStyle = lit ? "#000" : (k % 2 ? "#e2d9c6" : "#d3c9b4"); ctx.fill();
        ctx.strokeStyle = lit ? "#ffd49a" : "#a89e8a"; ctx.lineWidth = lit ? 2 : 1.5; ctx.stroke();
      }
    }
  };
  const hexMap = canvasTex("bahar-hex", 256, hexDraw(false), { w: 256, h: 222 });
  const hexEm = canvasTex("bahar-hex-em", 256, hexDraw(true), { w: 256, h: 222 });
  const screen = K.nightMat(std("bahar_screen", { color: 0xffffff, map: hexMap, alphaTest: 0.5, roughness: 0.7, metalness: 0.05, side: THREE.DoubleSide, emissive: 0xffffff, emissiveMap: hexEm }), 0, 0.9);
  const top = K.nightMat(std("bahar_top", { color: 0xcfd6da, roughness: 0.3, metalness: 0.7, emissive: 0xcfe0ff }), 0, 0.3);
  const podT = curtainTex("bahar-podium", { cols: 4, rows: 2, glass: [50, 70, 80], frame: "#ddd6c8", mullion: 0.1, spandrel: 0.3, litFrac: 0.7, warm: 0.85, seed: 52 });
  const podium = glassMat(K, "bahar_podium", podT, { night: 1.4 });
  const r = (y) => (y < 128 ? 15.4 + 1.3 * Math.sin(Math.PI * Math.min(1, y / 128)) : 15.4 * Math.sqrt(Math.max(0, 1 - ((y - 128) / 17) ** 2)));
  const SV = 1 / (4 * FH);
  for (const [ox, oy] of [[22.7, -37.9], [-21.7, 37.4]]) {
    const [cx, cz] = osm2c(ox, oy, 0);
    const body = paramSurface((u, v) => { const y = v * 145, R = r(y); return V3(cx + R * Math.cos(u * TAU), y, cz - R * Math.sin(u * TAU)); }, 48, 40, { uvFn: (u, v, p) => [u * TAU * 16 / 12, p.y * SV] });
    K.add(glass, body);
    K.add(top, sphereGeom(1.2, cx, 145.5, cz, 8, 6));
    // the mashrabiya shell: from the south-west round to the north-east through south (north side left open)
    const a0 = -30 * DEG, a1 = 210 * DEG; // canonical angles: 0 = east, 90 = south (+z)
    K.add(screen, paramSurface((u, v) => {
      const y = 10 + v * 118, R = r(y) + 2.2, a = a0 + u * (a1 - a0);
      return V3(cx + R * Math.cos(a), y, cz + R * Math.sin(a));
    }, 40, 24, { uvFn: (u, v, p) => [u * (a1 - a0) * 17.6 / 8.2, (p.y - 10) / 7.1] }));
  }
  const POD = [[-81.5, 57.2], [8.3, -96.5], [73.9, -58.7], [70.5, -52.9], [57.0, -60.6], [54.3, -56.0], [51.3, -50.8], [64.2, -43.3], [-5.2, 75.5], [-19.1, 67.5], [-22.1, 72.5], [-25.1, 77.7], [-11.2, 85.6], [-16.5, 94.6]];
  const pp = osmPoly(POD, 0);
  K.add(podium, prism(pp, 0, 9, { su: 1 / 10, sv: 1 / 9, top: false }));
  K.add(top, capXZ(pp, 9, true));
  return K.group("al_bahar_towers");
}

// ================================================================================================
// 17. WORLD TRADE CENTER ABU DHABI (Burj Mohammed bin Rashid)
// OSM part w285326216 (381 m, 88 levels, roof:shape skillion): a round plan ~46 m across. The tallest
// tower in Abu Dhabi; its top is sliced by a steep inclined plane that rises to a sharp tip at 381 m,
// a glazed "quill". Blue-green glass with horizontal banding. True orientation (the tip faces east).
// ================================================================================================
function buildWTCAbuDhabi() {
  const K = new Kit();
  const FH = 4.0;
  const fac = facadeSet("wtcad-fac", (ctx, W, H, mode, rnd) => {
    const cols = 8, rows = 4, cw = W / cols, rh = H / rows;
    ctx.fillStyle = mode === "map" ? "#c9d3d6" : mode === "orm" ? ORM(0.3, 0.9) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * cw + 1.5, y = r * rh + rh * 0.18, w = cw - 3, h = rh * 0.78;
      if (mode === "map") { const v = 0.93 + rnd() * 0.12; ctx.fillStyle = `rgb(${54 * v | 0},${98 * v | 0},${112 * v | 0})`; }
      else if (mode === "orm") ctx.fillStyle = ORM(0.05, 0.7);
      else ctx.fillStyle = rnd() < 0.42 ? litColor(rnd, 0.7) : "#000";
      ctx.fillRect(x, y, w, h);
    }
  });
  const glass = facadeMat(K, "wtcad_glass", fac, 1.3);
  const quillTex = canvasTex("wtcad-quill", 128, (ctx, W, H) => {
    ctx.fillStyle = "#7fb0bf"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#e6f1f4"; ctx.lineWidth = 3;
    for (let i = 0; i <= 4; i++) { ctx.beginPath(); ctx.moveTo(i * W / 4, 0); ctx.lineTo(i * W / 4, H); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i * H / 4); ctx.lineTo(W, i * H / 4); ctx.stroke(); }
  });
  const quill = K.nightMat(std("wtcad_quill", { color: 0xffffff, map: quillTex, roughness: 0.15, metalness: 0.85, emissive: 0xbfe8ff, emissiveMap: quillTex }), 0, 1.0);
  const white = std("wtcad_white", { color: 0xe7ecee, roughness: 0.4, metalness: 0.5 });
  const R = 23, ELL = 0.9; // slightly elliptical, long axis east-west
  const ring = [];
  for (let i = 0; i < 72; i++) { const a = (i / 72) * TAU; ring.push([R * Math.cos(a), R * ELL * Math.sin(a)]); }
  // the cut: plane through y = 381 at the east edge, falling steeply westward
  const topY = (x) => 381 - (R - x) * 1.25;
  const SV = 1 / (4 * FH);
  const base = ccw(ring);
  K.add(glass, loftRings([base.map(([x, z]) => V3(x, 0, z)), base.map(([x, z]) => V3(x, topY(x) - 0.05, z))], { su: 1 / 14, sv: SV, vFromY: true }));
  K.add(quill, liftedCap(base, (x) => topY(x), 1 / 8));
  // horizontal white belts at the sky lobbies and a lit edge round the cut
  for (const y of [90, 180, 270]) K.add(white, prism(offsetPoly(base, 0.4), y, y + 1.6, { top: false, bottom: true, su: 1 / 8, sv: 1 / 8 }));
  const edge = offsetPoly(base, 0.35);
  loft2(K, edge.map(([x, z]) => V3(x, topY(x) - 2.2, z)), edge.map(([x, z]) => V3(x, topY(x) + 0.4, z)), () => quill, { su: 1 / 6, sv: 1 / 6 });
  return K.group("wtc_abu_dhabi");
}

// ================================================================================================
// 18. YAS VICEROY (W Abu Dhabi - Yas Island, at Yas Marina Circuit)
// OSM parts w1228229328 (W hotel, 47 m incl. a 9 m domed roof) and w520940413 (Marina Wing, 52 m), the
// bridge over the circuit w1387292013 (9-18 m) and the podium w1387292014 (10 m). Two curving hotel blocks
// under a flowing steel-and-glass grid shell of diamond panels, which lights up in shifting colours at
// night. True orientation.
// ================================================================================================
function buildYasViceroy() {
  const K = new Kit();
  const FH = 3.2;
  const fac = facadeSet("yas-fac", (ctx, W, H, mode, rnd) => {
    const rows = 4, rh = H / rows, cols = 6, cw = W / cols;
    ctx.fillStyle = mode === "map" ? "#4b6a7a" : mode === "orm" ? ORM(0.06, 0.6) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) {
      if (mode === "em") { for (let c = 0; c < cols; c++) if (rnd() < 0.55) { ctx.fillStyle = litColor(rnd, 0.85); ctx.fillRect(c * cw + 2, r * rh + rh * 0.3, cw - 4, rh * 0.62); } continue; }
      ctx.fillStyle = mode === "map" ? "#f2f3f1" : ORM(0.5, 0.1); ctx.fillRect(0, r * rh, W, rh * 0.24);
    }
  });
  const hotel = facadeMat(K, "yas_hotel", fac, 1.3);
  const latDraw = (lit) => (ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    if (!lit) {
      // a few pivoting glass panels are closed (opaque), the rest see-through
      const r = mulberry32(61);
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (r() < 0.55) {
        const cx = (i + 0.5) * W / 4 + (j % 2 ? W / 8 : 0), cy = (j + 0.5) * H / 4;
        ctx.fillStyle = "rgba(200,214,222,1)"; ctx.beginPath(); ctx.moveTo(cx, cy - H / 8); ctx.lineTo(cx + W / 8, cy); ctx.lineTo(cx, cy + H / 8); ctx.lineTo(cx - W / 8, cy); ctx.closePath(); ctx.fill();
      }
    }
    ctx.strokeStyle = lit ? "#b98cff" : "#e9edf0"; ctx.lineWidth = lit ? 6 : 9;
    for (let k = -4; k <= 8; k++) {
      ctx.beginPath(); ctx.moveTo(k * W / 4, 0); ctx.lineTo(k * W / 4 + H, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(k * W / 4, 0); ctx.lineTo(k * W / 4 - H, H); ctx.stroke();
    }
  };
  const latMap = canvasTex("yas-lattice", 256, latDraw(false));
  const latEm = canvasTex("yas-lattice-em", 256, latDraw(true));
  const shell = K.nightMat(std("yas_shell", { color: 0xffffff, map: latMap, alphaTest: 0.5, roughness: 0.35, metalness: 0.6, side: THREE.DoubleSide, emissive: 0xffffff, emissiveMap: latEm }), 0, 1.6);
  const white = std("yas_white", { color: 0xeeefec, roughness: 0.6, metalness: 0.1 });
  const W = [[-66.0, -19.9], [-65.1, -23.6], [-62.1, -26.5], [-57.2, -29.1], [-54.7, -30.0], [-50.0, -31.1], [-42.8, -31.8], [-33.9, -32.7], [-19.4, -32.3], [-3.0, -30.4], [35.7, -21.7], [65.0, -14.8], [64.5, 16.6], [60.8, 15.8], [54.4, 15.5], [49.6, 15.2], [46.2, 15.1], [31.3, 14.9], [9.3, 13.4], [-24.9, 11.7], [-33.6, 9.5], [-43.3, 7.0], [-49.8, 3.4], [-56.8, -2.2], [-60.2, -6.2], [-63.6, -11.6], [-65.4, -15.5], [-66.0, -17.6]];
  const MW = [[99.6, 26.9], [99.7, 29.0], [99.0, 35.9], [98.1, 45.6], [97.1, 55.0], [96.0, 65.6], [95.9, 68.6], [96.4, 71.4], [98.2, 75.4], [100.4, 77.6], [103.2, 78.8], [105.6, 79.2], [108.1, 78.8], [110.9, 77.5], [114.0, 74.9], [116.8, 70.9], [120.2, 64.4], [122.8, 58.4], [124.8, 51.5], [126.8, 43.5], [128.3, 35.8], [130.1, 24.8], [131.3, 17.6], [132.3, 11.3], [133.7, 1.9], [134.5, -6.1], [135.2, -12.4], [135.7, -17.8], [135.8, -24.1], [135.9, -30.2], [135.7, -35.5], [134.8, -42.4], [133.5, -47.2], [131.9, -50.9], [130.5, -53.4], [129.4, -54.6], [127.8, -55.4], [126.0, -55.5], [124.1, -55.1], [121.8, -54.0], [119.7, -52.9], [118.3, -52.1], [117.0, -51.4], [115.4, -50.2], [113.7, -48.5], [112.3, -47.1], [110.9, -45.5], [108.3, -41.0], [107.7, -37.4], [106.9, -32.6], [103.9, -11.7], [103.0, -7.4]];
  const SV = 1 / (4 * FH);
  for (const [pts, h] of [[W, 38], [MW, 43]]) {
    const pl = ccw(resamplePoly(ccw(osmPoly(pts, 0)), 96));
    K.add(hotel, prism(pl, 0, h, { su: 1 / 12, sv: SV, top: false, crease: 30 }));
    K.add(white, capXZ(pl, h, true));
    // grid shell: a pillow over the roof whose skirt drops down the facade toward the ends
    const c = centroidXZ(pl);
    const rings = [];
    // the skirt swoops lowest at the far ends of each block (down to ~40% of the height)
    const steps = [[9, -1], [8.4, -0.62], [7.2, -0.3], [5.2, -0.05], [2.4, 0.12], [-1.5, 0.2], [-6, 0.23], [-10, 0.24]];
    for (const [off, f] of steps) rings.push(offsetPoly(pl, off).map(([x, z]) => {
      const e = Math.min(1, Math.hypot(x - c[0], z - c[1]) / 62);
      const drop = f < 0 ? -f * (6 + 0.55 * h * e * e) : 0;
      return V3(x, h + Math.max(0, f) * 40 - drop, z);
    }));
    K.add(shell, loftRings(rings, { su: 1 / 9, sv: 1 / 9 }));
    const topRing = rings[rings.length - 1];
    K.add(shell, capXZ(topRing.map((p) => [p.x, p.z]), topRing[0].y, true, 1 / 9));
  }
  // bridge over the track (9-18 m) wrapped in its own shell tube
  const BR = [[68.8, 17.4], [78.5, 19.3], [93.5, 21.9], [95.0, 22.7], [96.6, 23.7], [99.2, 25.7], [99.6, 26.9], [103.0, -7.4], [102.1, -6.1], [99.8, -4.5], [98.1, -3.8], [96.7, -3.3], [79.9, -9.1], [68.5, -13.1], [66.2, -13.9], [65.0, -14.8], [64.5, 16.6], [66.5, 17.0]];
  const br = osmPoly(BR, 0);
  K.add(hotel, prism(br, 9, 18, { su: 1 / 12, sv: SV, bottom: true }));
  const bc = centroidXZ(ccw(br));
  K.add(shell, paramSurface((u, v) => {
    const x = 62 + u * 42, a = v * Math.PI, rr = 17 + 3 * Math.sin(u * Math.PI);
    return V3(x, 13 + rr * Math.sin(a) * 0.8, bc[1] + rr * Math.cos(a));
  }, 16, 12, { uvFn: (u, v, p) => [p.x / 9, (p.y + p.z) / 9] }));
  // podium round the W hotel (10 m)
  const POD = [[31.3, 14.9], [26.8, 18.7], [23.9, 20.3], [20.6, 20.4], [19.0, 19.9], [9.9, 18.2], [-6.2, 16.4], [-12.7, 17.1], [-20.8, 18.5], [-28.7, 20.9], [-32.8, 21.8], [-41.6, 22.7], [-46.0, 22.0], [-48.6, 20.0], [-52.8, 12.8], [-60.3, -2.8], [-65.0, -10.6], [-70.4, -17.5], [-81.5, -22.2], [-118.1, -26.7], [-131.0, -28.8], [-135.4, -33.0], [-135.9, -35.7], [-130.1, -68.4], [-127.5, -76.0], [-124.0, -78.8], [-106.0, -79.2], [-93.0, -77.8], [-90.1, -75.2], [-89.5, -72.3], [-88.0, -58.2], [-85.4, -57.1], [-80.6, -56.2], [26.4, -40.8], [31.1, -39.8], [34.2, -37.8], [39.3, -35.7], [45.3, -34.0], [58.5, -32.0], [62.7, -30.2], [63.5, -27.4], [64.2, -17.9], [65.0, -14.8], [35.7, -21.7], [-3.0, -30.4], [-19.4, -32.3], [-33.9, -32.7], [-42.8, -31.8], [-50.0, -31.1], [-54.7, -30.0], [-57.2, -29.1], [-62.1, -26.5], [-65.1, -23.6], [-66.0, -19.9], [-66.0, -17.6], [-65.4, -15.5], [-63.6, -11.6], [-60.2, -6.2], [-56.8, -2.2], [-49.8, 3.4], [-43.3, 7.0], [-33.6, 9.5], [-24.9, 11.7], [9.3, 13.4]];
  const pp = osmPoly(POD, 0);
  K.add(hotel, prism(pp, 0, 8, { su: 1 / 12, sv: SV, top: false }));
  K.add(white, capXZ(pp, 8, true));
  return K.group("yas_viceroy");
}


// ================================================================================================
// 19. QASR AL WATAN (Presidential Palace, Abu Dhabi)
// OSM multipolygon r7232861 ("Al-Watan Palace"): outer way w492539777 (~390 x 490 m) with a courtyard
// (inner way w492539774). Three linked blocks turned -16.6 deg: the main palace to the south under the
// 37 m Great Hall dome, the round Spirit of Collaboration hall to its west under a second dome, and the
// northern block round a courtyard. White granite and limestone, arcaded walls, white domes with gold
// finials, lit warm at night. Canonical: palace axis along Z, headingDeg = -16.6.
// ================================================================================================
function buildQasrAlWatan() {
  const K = new Kit();
  const HD = -16.6;
  const OUTER = [[-55.1, 22.9], [-99.5, 9.8], [-126.3, 99.8], [-141.0, 95.5], [-150.4, 127.2], [-168.6, 121.9], [-171.9, 132.9], [-153.7, 138.2], [-162.9, 169.0], [-140.5, 175.5], [-138.7, 169.4], [-124.3, 173.6], [-129.2, 190.2], [-108.5, 196.3], [-117.0, 224.9], [-121.6, 223.6], [-124.5, 233.5], [-113.9, 236.6], [-113.0, 233.4], [-97.3, 237.9], [-98.3, 241.2], [-87.4, 244.4], [-84.4, 234.5], [-79.2, 236.0], [-75.6, 223.7], [-84.6, 221.1], [-79.7, 204.7], [-57.6, 211.3], [-52.7, 194.7], [-37.8, 199.1], [-39.6, 205.2], [-17.7, 211.6], [-8.5, 180.9], [9.2, 186.1], [12.5, 175.1], [-5.2, 169.8], [4.2, 138.0], [-8.6, 134.3], [14.5, 43.3], [-29.9, 30.3], [-29.3, 28.1], [-14.2, 32.5], [6.7, -37.8], [22.6, -33.1], [20.9, -27.2], [29.5, -24.6], [36.1, -46.8], [42.7, -44.8], [46.1, -56.2], [84.8, -44.8], [95.9, -81.9], [105.1, -79.2], [97.8, -54.9], [164.1, -35.4], [172.8, -64.7], [194.2, -58.4], [197.3, -69.0], [176.0, -75.3], [183.4, -100.3], [117.1, -119.8], [109.2, -93.0], [100.0, -95.7], [110.7, -131.8], [96.6, -136.0], [102.9, -157.2], [95.0, -159.5], [100.8, -178.9], [44.0, -195.5], [44.9, -198.4], [38.5, -200.3], [49.8, -238.1], [28.4, -244.4], [17.1, -206.6], [10.7, -208.4], [9.9, -205.6], [-44.9, -221.7], [-50.7, -202.3], [-58.6, -204.6], [-64.9, -183.4], [-79.6, -187.7], [-88.2, -158.8], [-97.4, -161.5], [-94.8, -170.3], [-99.0, -171.5], [-96.7, -179.4], [-102.6, -181.1], [-100.3, -188.5], [-150.5, -203.3], [-152.7, -195.8], [-160.4, -198.1], [-162.7, -190.3], [-169.8, -192.3], [-174.5, -176.8], [-193.6, -182.4], [-197.3, -169.9], [-178.2, -164.2], [-184.4, -143.3], [-177.3, -141.3], [-179.3, -134.6], [-171.6, -132.3], [-174.1, -124.0], [-123.9, -109.2], [-121.4, -117.6], [-115.6, -115.9], [-113.6, -122.5], [-109.4, -121.3], [-105.7, -133.6], [-96.5, -130.9], [-105.5, -100.7], [-71.3, -90.7], [-74.7, -79.3], [-64.0, -76.2], [-70.6, -54.0], [-61.0, -51.2], [-59.3, -57.1], [-43.4, -52.5], [-64.4, 17.8], [-54.5, 20.7]];
  const INNER = [[-31.8, 36.6], [6.3, 47.7], [-21.6, 141.4], [-55.5, 130.1], [-52.4, 119.7], [-69.3, 114.9], [-72.9, 125.4], [-122.8, 111.6], [-94.9, 18.0], [-57.0, 29.2], [-59.1, 36.0], [-53.1, 37.8], [-56.7, 49.8], [-42.4, 54.0], [-38.9, 42.0], [-33.8, 43.4]];
  const at = archTex("watan-arch", { n: 2, bg: "#f4f1ea", hole: "#9aa3a8", holeTop: "#5c666d", frame: "#e3dccd", glow: "#ffd9a0", pier: 0.18, spring: 0.5, top: 0.18, base: 0.92, band: "#e6dfd0" });
  const wall = K.nightMat(std("watan_wall", { color: 0xffffff, map: at.map, roughness: 0.6, emissive: 0xffffff, emissiveMap: at.em }), 0, 1.0);
  const stone = K.nightMat(std("watan_stone", { color: 0xf3f0e9, roughness: 0.5, metalness: 0, emissive: 0xffe2b8 }), 0, 0.35);
  const domeTex = stripeTex("watan-dome", "#f1f0ec", "#d9dbdb", 8, 0.12);
  const domeM = K.nightMat(std("watan_dome", { color: 0xffffff, map: domeTex, roughness: 0.35, metalness: 0.05, emissive: 0xfff0d6, emissiveMap: domeTex }), 0, 0.95);
  const gold = goldMat("watan_gold");
  const P = (pts) => osmPoly(pts, HD);
  const out = P(OUTER), inn = P(INNER);
  const HW = 22;
  K.add(wall, prism(out, 0, HW, { su: 1 / 11, sv: 1 / 11, top: false, crease: 10 }));
  K.add(wall, prism(inn, 0, HW, { su: 1 / 11, sv: 1 / 11, inward: true, crease: 10 }));
  K.add(stone, capXZ(out, HW, true, 1 / 20, [inn]));
  K.add(stone, prism(offsetPoly(out, 0.5), HW, HW + 1.6, { top: false, bottom: true, su: 1 / 8, sv: 1 / 8 }));
  const dome = (x, z, y0, rDrum, hDrum, rDome, hDome, seg = 32) => {
    K.add(stone, cyl(rDrum, rDrum, hDrum, x, y0, z, seg));
    K.add(stone, cyl(rDrum + 0.8, rDrum + 0.8, 1.2, x, y0 + hDrum, z, seg));
    K.add(domeM, paramSurface((u, v) => {
      const t = u * TAU, r = rDome * Math.pow(Math.cos(v * Math.PI / 2), 0.9) * (1 + 0.05 * Math.sin(v * Math.PI));
      return V3(x + r * Math.cos(t), y0 + hDrum + 1.2 + hDome * Math.sin(v * Math.PI / 2), z - r * Math.sin(t));
    }, seg, 12, { uvFn: (u, v) => [u * 4, v] }));
    K.add(gold, finialGeom(Math.max(0.5, rDome * 0.06), Math.max(3, rDome * 0.45), 8).translate(x, y0 + hDrum + 1.2 + hDome - 0.4, z));
  };
  // Great Hall: a raised square base, an arcaded drum, the 37 m dome, four corner domes
  const [gx, gz] = osm2c(2, -132, HD);
  K.add(wall, prism(rectXZ(gx - 30, gx + 30, gz - 30, gz + 30), HW, HW + 10, { su: 1 / 11, sv: 1 / 11, top: false, vOff: HW }));
  K.add(stone, capXZ(rectXZ(gx - 30, gx + 30, gz - 30, gz + 30), HW + 10, true));
  K.add(wall, prism(ngon(24, 21.5), HW + 10, HW + 20, { su: 1 / 11, sv: 1 / 10, top: false, vOff: HW + 10 }).translate(gx, 0, gz));
  dome(gx, gz, HW + 20, 20.5, 2.5, 18.5, 24, 40);
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) dome(gx + sx * 24, gz + sz * 24, HW + 10, 5.5, 4, 5.2, 7, 20);
  // Spirit of Collaboration: the round hall to the west
  const [wx, wz] = osm2c(-146, -157, HD);
  dome(wx, wz, HW, 17, 7, 15.5, 18, 36);
  // north block: a central dome on its axis and pavilion domes along the fronts
  const [nx, nz] = osm2c(-60, 30, HD);
  dome(nx, nz, HW, 9, 5, 8.5, 11, 24);
  for (const [ox, oy] of [[-40, -45], [45, -60], [-80, -205], [60, -225], [-110, 185], [-20, 160]]) {
    const [px, pz] = osm2c(ox, oy, HD);
    dome(px, pz, HW, 4.5, 3, 4.3, 6, 16);
  }
  return K.group("qasr_al_watan");
}

// ================================================================================================

export const LANDMARKS2 = [
  {
    id: "princess_tower",
    name: "Princess Tower",
    lat: 25.088646, lon: 55.146772,
    headingDeg: 45.4,
    suppress: [[25.088641, 55.146484], [25.088386, 55.146761], [25.088651, 55.147059], [25.088906, 55.146783]],
    height: 414,
    build: buildPrincessTower,
  },
  {
    id: "marina_101",
    name: "Marina 101",
    lat: 25.089056, lon: 55.148624,
    headingDeg: 40.3,
    suppress: [[25.089025, 55.148333], [25.088791, 55.148636], [25.089088, 55.148916], [25.089322, 55.148613]],
    height: 425,
    build: buildMarina101,
  },
  {
    id: "marina_23",
    name: "23 Marina",
    lat: 25.089748, lon: 55.150709,
    headingDeg: -4.4,
    suppress: [[25.089690, 55.150325], [25.089335, 55.150766], [25.089638, 55.151067], [25.089809, 55.151052], [25.090076, 55.150687]],
    height: 392,
    build: buildMarina23,
  },
  {
    id: "almas",
    name: "Almas Tower",
    lat: 25.069013, lon: 55.141107,
    headingDeg: 0,
    suppress: [[25.068963, 55.140293], [25.068533, 55.140659], [25.068345, 55.141139], [25.068613, 55.141648], [25.069088, 55.141864], [25.069783, 55.141686], [25.069737, 55.140975], [25.069457, 55.140466]],
    height: 363,
    build: buildAlmas,
  },
  {
    id: "address_downtown",
    name: "The Address Downtown",
    lat: 25.194030, lon: 55.278908,
    headingDeg: 0,
    suppress: [[25.193836, 55.278639], [25.193771, 55.278651], [25.193714, 55.278691], [25.193673, 55.278750], [25.193647, 55.278835], [25.193650, 55.278900], [25.193690, 55.278967], [25.193787, 55.279040], [25.193896, 55.279101], [25.193998, 55.279130], [25.194090, 55.279135], [25.194158, 55.279125], [25.194248, 55.279099], [25.194325, 55.279076], [25.194387, 55.279046], [25.194398, 55.279024], [25.194395, 55.278995], [25.194357, 55.278932], [25.194290, 55.278858], [25.194223, 55.278786], [25.194166, 55.278737], [25.194083, 55.278701]],
    height: 306,
    build: buildAddressDowntown,
  },
  {
    id: "rose_tower",
    name: "Rose Tower",
    lat: 25.211666, lon: 55.276636,
    headingDeg: -56,
    suppress: [[25.211623, 55.276407], [25.211499, 55.276623], [25.211680, 55.276753], [25.211719, 55.276777], [25.211842, 55.276556]],
    height: 333,
    build: buildRoseTower,
  },
  {
    id: "index",
    name: "The Index",
    lat: 25.207353, lon: 55.277895,
    headingDeg: 0,
    suppress: [[25.207271, 55.277038], [25.207268, 55.277323], [25.207258, 55.277786], [25.207265, 55.278394], [25.207506, 55.278395], [25.207535, 55.278395], [25.207659, 55.278394], [25.207655, 55.277039]],
    height: 326,
    build: buildIndex,
  },
  {
    id: "jw_marriott_marquis",
    name: "JW Marriott Marquis",
    lat: 25.185720, lon: 55.258050,
    headingDeg: 0,
    suppress: [[25.185346, 55.257608], [25.185265, 55.257615], [25.185207, 55.257632], [25.185142, 55.257670], [25.185127, 55.257837], [25.185207, 55.257965], [25.185780, 55.258488], [25.186053, 55.258673], [25.186201, 55.258634], [25.186216, 55.258554], [25.186217, 55.258479], [25.186210, 55.258397], [25.186189, 55.258303], [25.186153, 55.258222], [25.186117, 55.258169], [25.186026, 55.258083], [25.185588, 55.257688], [25.185566, 55.257673], [25.185504, 55.257643], [25.185433, 55.257621]],
    height: 355,
    build: buildJWMarriott,
  },
  {
    id: "dubai_opera",
    name: "Dubai Opera",
    lat: 25.195616, lon: 55.271974,
    headingDeg: 0,
    suppress: [[25.195508, 55.271310], [25.195443, 55.271398], [25.195401, 55.271471], [25.195365, 55.271549], [25.195334, 55.271629], [25.195310, 55.271713], [25.195292, 55.271799], [25.195282, 55.271887], [25.195278, 55.271975], [25.195285, 55.272082], [25.195299, 55.272186], [25.195319, 55.272289], [25.195347, 55.272389], [25.195380, 55.272486], [25.195441, 55.272604], [25.195469, 55.272631], [25.195503, 55.272648], [25.195540, 55.272655], [25.195577, 55.272650], [25.195612, 55.272634], [25.195641, 55.272608], [25.195727, 55.272498], [25.195791, 55.272408], [25.195851, 55.272312], [25.195904, 55.272211], [25.195949, 55.272105], [25.195988, 55.271996], [25.196018, 55.271884], [25.196041, 55.271771], [25.196057, 55.271657], [25.196060, 55.271477], [25.195988, 55.271430], [25.195913, 55.271391], [25.195834, 55.271363], [25.195755, 55.271336], [25.195673, 55.271319], [25.195591, 55.271311]],
    height: 46,
    build: buildDubaiOpera,
  },
  {
    id: "dubai_world_trade_centre",
    name: "Dubai World Trade Centre",
    lat: 25.227571, lon: 55.288771,
    headingDeg: 48.3,
    suppress: [[25.227621, 55.288442], [25.227377, 55.288679], [25.227300, 55.288759], [25.227615, 55.289144], [25.227932, 55.288829]],
    height: 184,
    build: buildDWTC,
  },
  {
    id: "jumeirah_beach_hotel",
    name: "Jumeirah Beach Hotel",
    lat: 25.141666, lon: 55.190754,
    headingDeg: 0,
    suppress: [[25.142425, 55.191282], [25.142554, 55.191284], [25.142610, 55.191283], [25.142664, 55.191279], [25.142714, 55.191278], [25.142735, 55.191274], [25.142752, 55.191263], [25.142767, 55.191246], [25.142777, 55.191227], [25.142782, 55.191201], [25.142779, 55.191177], [25.142771, 55.191156], [25.142757, 55.191138], [25.142738, 55.191125], [25.142727, 55.191122], [25.142718, 55.191119], [25.142710, 55.191119], [25.142611, 55.191118], [25.142515, 55.191116], [25.142424, 55.191109], [25.142347, 55.191101], [25.142275, 55.191085], [25.142109, 55.191039], [25.141982, 55.190982], [25.141852, 55.190916], [25.141715, 55.190825], [25.141639, 55.190758], [25.141580, 55.190701], [25.141580, 55.190668], [25.141566, 55.190624], [25.141544, 55.190591], [25.141507, 55.190567], [25.141458, 55.190548], [25.141375, 55.190442], [25.141295, 55.190355], [25.141195, 55.190274], [25.141135, 55.190229], [25.141063, 55.190186], [25.140919, 55.190118], [25.140690, 55.190044], [25.140549, 55.190030], [25.140419, 55.190025], [25.140390, 55.190065], [25.140376, 55.190117], [25.140391, 55.190178], [25.140435, 55.190207], [25.140535, 55.190212], [25.140607, 55.190220], [25.140647, 55.190229], [25.140655, 55.190241], [25.140680, 55.190258], [25.140701, 55.190264], [25.140720, 55.190263], [25.140740, 55.190261], [25.140755, 55.190256], [25.140897, 55.190303], [25.140989, 55.190347], [25.141066, 55.190394], [25.141114, 55.190426], [25.141241, 55.190513], [25.141287, 55.190557], [25.141443, 55.190739], [25.141473, 55.190783], [25.141617, 55.191046], [25.141637, 55.190992], [25.141672, 55.191047], [25.141714, 55.191096], [25.141762, 55.191145], [25.141806, 55.191180], [25.141894, 55.191221], [25.141950, 55.191232], [25.141995, 55.191228], [25.142053, 55.191212], [25.142188, 55.191262], [25.142309, 55.191279]],
    height: 104,
    build: buildJBH,
  },
  {
    id: "atlantis_the_royal",
    name: "Atlantis The Royal",
    lat: 25.138209, lon: 55.127649,
    headingDeg: 0,
    suppress: [[25.137589, 55.125925], [25.137502, 55.126030], [25.137436, 55.126111], [25.137412, 55.126140], [25.137461, 55.126191], [25.137492, 55.126224], [25.137599, 55.126338], [25.137701, 55.126457], [25.137720, 55.126483], [25.137749, 55.126522], [25.137790, 55.126576], [25.137861, 55.126688], [25.137931, 55.126828], [25.137991, 55.126967], [25.138002, 55.126996], [25.138042, 55.127122], [25.138064, 55.127215], [25.138079, 55.127309], [25.138105, 55.127530], [25.138143, 55.127985], [25.138156, 55.128130], [25.138174, 55.128281], [25.138196, 55.128432], [25.138224, 55.128557], [25.138258, 55.128672], [25.138298, 55.128781], [25.138343, 55.128883], [25.138409, 55.129012], [25.138485, 55.129132], [25.138545, 55.129220], [25.138633, 55.129342], [25.138733, 55.129453], [25.138829, 55.129536], [25.138945, 55.129615], [25.139075, 55.129410], [25.139092, 55.129382], [25.138996, 55.129306], [25.138909, 55.129224], [25.138807, 55.129110], [25.138717, 55.128987], [25.138641, 55.128864], [25.138582, 55.128760], [25.138527, 55.128626], [25.138481, 55.128474], [25.138456, 55.128358], [25.138434, 55.128238], [25.138410, 55.128077], [25.138392, 55.127912], [25.138350, 55.127464], [25.138339, 55.127333], [25.138329, 55.127243], [25.138318, 55.127168], [25.138308, 55.127108], [25.138293, 55.127043], [25.138272, 55.126965], [25.138249, 55.126895], [25.138208, 55.126791], [25.138146, 55.126659], [25.138081, 55.126543], [25.137997, 55.126412], [25.137903, 55.126288], [25.137828, 55.126189], [25.137737, 55.126084]],
    height: 193,
    build: buildAtlantisRoyal,
  },
  {
    id: "the_gate",
    name: "The Gate (DIFC)",
    lat: 25.214557, lon: 55.281156,
    headingDeg: 27.8,
    suppress: [[25.214437, 55.280722], [25.214316, 55.280963], [25.214164, 55.281292], [25.214679, 55.281591], [25.214951, 55.281026]],
    height: 62,
    build: buildTheGate,
  },
  {
    id: "adnoc_hq",
    name: "ADNOC Headquarters",
    lat: 24.461974, lon: 54.324089,
    headingDeg: -13.4,
    suppress: [[24.462027, 54.323567], [24.461764, 54.323821], [24.461791, 54.323954], [24.461907, 54.324479], [24.461937, 54.324610], [24.462202, 54.324353], [24.462190, 54.324287]],
    height: 342,
    build: buildADNOC,
  },
  {
    id: "the_landmark",
    name: "The Landmark",
    lat: 24.484831, lon: 54.350649,
    headingDeg: 0,
    suppress: [[24.484855, 54.350255], [24.484729, 54.350434], [24.484660, 54.350557], [24.484608, 54.350710], [24.484575, 54.350921], [24.484813, 54.351042], [24.484925, 54.350880], [24.485005, 54.350742], [24.485055, 54.350579], [24.485093, 54.350376]],
    height: 324,
    build: buildLandmark,
  },
  {
    id: "al_bahar_towers",
    name: "Al Bahar Towers",
    lat: 24.456126, lon: 54.401024,
    headingDeg: 0,
    suppress: [[24.456648, 54.400200], [24.455235, 54.401101], [24.455590, 54.401773], [24.455666, 54.401725], [24.455596, 54.401592], [24.455626, 54.401573], [24.455662, 54.401550], [24.455730, 54.401678], [24.456827, 54.400978], [24.456755, 54.400841], [24.456789, 54.400819], [24.456823, 54.400797], [24.456895, 54.400933], [24.457000, 54.400867]],
    height: 145,
    build: buildAlBahar,
  },
  {
    id: "wtc_abu_dhabi",
    name: "World Trade Center Abu Dhabi",
    lat: 24.488128, lon: 54.357139,
    headingDeg: 0,
    suppress: [[24.488153, 54.356896], [24.488103, 54.356896], [24.488055, 54.356908], [24.488010, 54.356932], [24.487972, 54.356966], [24.487941, 54.357008], [24.487919, 54.357057], [24.487907, 54.357110], [24.487907, 54.357164], [24.487917, 54.357217], [24.487938, 54.357267], [24.487968, 54.357310], [24.488007, 54.357344], [24.488051, 54.357369], [24.488100, 54.357382], [24.488151, 54.357383], [24.488200, 54.357372], [24.488245, 54.357348], [24.488285, 54.357314], [24.488317, 54.357271], [24.488339, 54.357221], [24.488350, 54.357168], [24.488350, 54.357112], [24.488339, 54.357058], [24.488317, 54.357009], [24.488285, 54.356966], [24.488246, 54.356931], [24.488201, 54.356908]],
    height: 381,
    build: buildWTCAbuDhabi,
  },
  {
    id: "yas_viceroy",
    name: "Yas Viceroy (W Abu Dhabi)",
    lat: 24.4674155, lon: 54.6057052,
    headingDeg: 0,
    suppress: [[24.467090, 54.604349], [24.466759, 54.604411], [24.466723, 54.604433], [24.466698, 54.604467], [24.466694, 54.604646], [24.466697, 54.604744], [24.466907, 54.606979], [24.466914, 54.606994], [24.466926, 54.607006], [24.466948, 54.607020], [24.466983, 54.607036], [24.467026, 54.607049], [24.467090, 54.607058], [24.467138, 54.607061], [24.467252, 54.607059], [24.467302, 54.607054], [24.467433, 54.607040], [24.467520, 54.607026], [24.467644, 54.607003], [24.467745, 54.606985], [24.467816, 54.606969], [24.467889, 54.606949], [24.467953, 54.606929], [24.468007, 54.606902], [24.468067, 54.606868], [24.468104, 54.606839], [24.468128, 54.606809], [24.468139, 54.606780], [24.468143, 54.606755], [24.468140, 54.606732], [24.467618, 54.605237], [24.467611, 54.605222], [24.467153, 54.604398], [24.467135, 54.604369], [24.467115, 54.604355]],
    height: 53,
    build: buildYasViceroy,
  },
  {
    id: "qasr_al_watan",
    name: "Qasr Al Watan",
    lat: 24.4632867, lon: 54.3054425,
    headingDeg: -16.6,
    suppress: [[24.463483, 54.304886], [24.463456, 54.304789], [24.462821, 54.304996], [24.462787, 54.304868], [24.462840, 54.304850], [24.462807, 54.304728], [24.462607, 54.304793], [24.462579, 54.304687], [24.462476, 54.304721], [24.462385, 54.304383], [24.462112, 54.304472], [24.462096, 54.304409], [24.462206, 54.304373], [24.462195, 54.304332], [24.462256, 54.304312], [24.462240, 54.304254], [24.462316, 54.304229], [24.462175, 54.303706], [24.462099, 54.303731], [24.462079, 54.303654], [24.462018, 54.303674], [24.461999, 54.303604], [24.461811, 54.303666], [24.461760, 54.303477], [24.461621, 54.303522], [24.461671, 54.303711], [24.461530, 54.303757], [24.461549, 54.303826], [24.461478, 54.303850], [24.461499, 54.303926], [24.461432, 54.303948], [24.461572, 54.304471], [24.461640, 54.304449], [24.461655, 54.304507], [24.461726, 54.304484], [24.461737, 54.304525], [24.461817, 54.304499], [24.461834, 54.304562], [24.461572, 54.304647], [24.461611, 54.304792], [24.461419, 54.304854], [24.461440, 54.304932], [24.461265, 54.304989], [24.461411, 54.305530], [24.461385, 54.305538], [24.461402, 54.305602], [24.461060, 54.305713], [24.461124, 54.305952], [24.461466, 54.305841], [24.461483, 54.305904], [24.461509, 54.305896], [24.461660, 54.306455], [24.461835, 54.306399], [24.461856, 54.306477], [24.462048, 54.306414], [24.462085, 54.306554], [24.462412, 54.306448], [24.462428, 54.306510], [24.462187, 54.306589], [24.462371, 54.307271], [24.462597, 54.307197], [24.462654, 54.307408], [24.462775, 54.307369], [24.462719, 54.307158], [24.462984, 54.307072], [24.462800, 54.306389], [24.462580, 54.306461], [24.462563, 54.306399], [24.462898, 54.306290], [24.462795, 54.305907], [24.462898, 54.305873], [24.462881, 54.305809], [24.463081, 54.305744], [24.463050, 54.305630], [24.462997, 54.305647], [24.462962, 54.305519], [24.463597, 54.305312], [24.463557, 54.305164], [24.463551, 54.305166], [24.463669, 54.305603], [24.464492, 54.305375], [24.464525, 54.305503], [24.464814, 54.305409], [24.464861, 54.305584], [24.464986, 54.305544], [24.464939, 54.305368], [24.465217, 54.305278], [24.465151, 54.305033], [24.465096, 54.305051], [24.465064, 54.304932], [24.465214, 54.304884], [24.465155, 54.304666], [24.465277, 54.304626], [24.465301, 54.304715], [24.465438, 54.304671], [24.465424, 54.304619], [24.465514, 54.304590], [24.465477, 54.304454], [24.465448, 54.304463], [24.465414, 54.304337], [24.465443, 54.304328], [24.465407, 54.304195], [24.465292, 54.304233], [24.465304, 54.304277], [24.465071, 54.304353], [24.465016, 54.304149], [24.464866, 54.304197], [24.464836, 54.304083], [24.464891, 54.304065], [24.464824, 54.303817], [24.464546, 54.303907], [24.464498, 54.303728], [24.464372, 54.303769], [24.464420, 54.303948], [24.464134, 54.304041], [24.464173, 54.304186], [24.463359, 54.304450], [24.463477, 54.304888]],
    height: 72,
    build: buildQasrAlWatan,
  },
];

export function disposeLandmark(group) {
  const mats = new Set();
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m));
    if (o.isInstancedMesh && o.dispose) o.dispose();
  });
  for (const m of mats) {
    for (const k of Object.keys(m)) {
      const v = m[k];
      if (v && v.isTexture && !v.userData.shared) v.dispose();
    }
    m.dispose();
  }
}

// The geometry and texture kit, shared with the Shanghai landmarks (city/landmarks_sh.js).
export const KIT = {
  THREE, mergeGeometries, DEG, TAU, V3, mulberry32, Kit, finish, fromArrays, prism, capXZ, loftRings, loft2, liftedCap,
  addWallsBy, offsetPoly, ccw, areaXZ, clipAxis, ngon, cyl, lathe, strut, beam, box, sphereGeom, canvasTex, facadeSet,
  facadeMat, std, phys, ORM, litColor,
};
