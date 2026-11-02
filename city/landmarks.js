// Hand-built procedural models of UAE landmarks for the driving game.
//
// Conventions: metres, Y up, X east, north is -Z. Each build() returns a Group whose origin is the
// ground-level centre of the landmark footprint. Models are authored in a canonical frame and the engine
// applies rotation.y = -headingDeg * PI / 180 (headingDeg = clockwise from north). OSM-derived coordinates
// below are local metres (x east, y north) around each landmark's lat/lon and are converted to the
// canonical frame with osm2c().
//
// Every group sets group.userData.nightMats = [{ mat, day, night }] for the engine's day/night lerp.

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

// ================================================================================================
// 1. BURJ AL ARAB
// OSM way 12700546 (building=hotel, height=321). Footprint is a 45 degree sector: apex (the spine and
// mast) to the NW, curved front (the fabric sail) facing the shore at bearing ~127 deg. Radius ~100 m
// at the wing tips and ~108 m at the middle of the arc. Model front (fabric) faces -Z, headingDeg=127.3.
// ================================================================================================
function buildBurjAlArab() {
  const K = new Kit();
  const ALPHA = 22.7 * DEG;       // half opening angle of the V
  const APEX_Z = 68.8;            // apex distance behind the footprint centroid
  const R0 = (phi) => 100 + 8 * Math.cos((phi / ALPHA) * Math.PI / 2);
  const HS = 216, P = 2.1, YTOP = 204;
  const g = (y) => {
    const base = 1 - Math.pow(Math.min(y, HS) / HS, P);
    const belly = 0.955 + 0.045 * Math.sin(Math.min(1, y / 70) * Math.PI / 2);
    return Math.max(0, base * belly);
  };
  const at = (r, phi, y) => V3(r * Math.sin(phi), y, APEX_Z - r * Math.cos(phi));

  const wingTex = curtainTex("baa-wing", { cols: 6, rows: 8, glass: [52, 96, 128], frame: "#e8ecef", mullion: 0.07, spandrel: 0.2, vary: 0.25, litFrac: 0.55, seed: 3, glassMetal: 0.3, glassRough: 0.08, frameMetal: 0.2, frameRough: 0.45 });
  const glass = glassMat(K, "baa_glass", wingTex, { night: 1.4 });

  const fabricTex = canvasTex("baa-fabric", 256, (ctx, W, H) => {
    ctx.fillStyle = "#f4f4f1"; ctx.fillRect(0, 0, W, H);
    // horizontal sagging seams between the fabric trusses
    ctx.strokeStyle = "rgba(150,155,165,0.75)"; ctx.lineWidth = 3;
    for (let i = 0; i < 4; i++) {
      const y0 = (i + 0.5) * H / 4;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 4) ctx.lineTo(x, y0 + 10 * Math.sin((x / W) * Math.PI));
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(190,195,200,0.6)"; ctx.lineWidth = 1.5;
    for (let x = 0; x < W; x += W / 8) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  });
  const fabric = K.nightMat(std("baa_fabric", {
    color: 0xffffff, map: fabricTex, roughness: 0.55, metalness: 0.0,
    emissive: 0x9a8cff, emissiveMap: fabricTex, side: THREE.DoubleSide,
  }), 0, 1.1);
  const steel = K.nightMat(std("baa_steel", { color: 0xf1f1ee, roughness: 0.4, metalness: 0.25, emissive: 0xdfe8ff }), 0, 0.35);
  const deck = std("baa_deck", { color: 0x6f7378, roughness: 0.7, metalness: 0.2 });

  // --- wings: two vertical planar faces along the V edges, from the apex to the leading edge
  for (const side of [-1, 1]) {
    const phi = side * ALPHA;
    const surf = paramSurface((u, v) => {
      const y = v * YTOP;
      return at(u * R0(phi) * g(y), phi, y);
    }, 18, 44, {
      flip: side < 0,
      uvFn: (u, v, p) => [Math.hypot(p.x, p.z - APEX_Z) / 16, p.y / 14],
    });
    K.add(glass, surf);
  }

  // --- fabric sail across the front, bowed between the two leading edges
  K.add(fabric, paramSurface((u, v) => {
    const phi = (u * 2 - 1) * ALPHA, y = v * YTOP;
    return at(R0(phi) * g(y), phi, y);
  }, 24, 44, { flip: false, uvFn: (u, v, p) => [u * 6, p.y / 30] }));

  // --- top cap (small sector at the roof)
  {
    const pts = [[0, APEX_Z]];
    for (let i = 0; i <= 12; i++) { const phi = (i / 12 * 2 - 1) * ALPHA; const p = at(R0(phi) * g(YTOP), phi, YTOP); pts.push([p.x, p.z]); }
    K.add(steel, capXZ(pts, YTOP, true));
  }

  // --- exoskeleton: leading-edge legs (twin-chord trusses), rear spine, cross bracing on the wing faces
  const edgePts = (phi, off = 0) => {
    const pts = [];
    for (let i = 0; i <= 26; i++) {
      const y = (i / 26) * (YTOP + 6);
      const r = R0(phi) * g(Math.min(y, YTOP)) * (y > YTOP ? (1 - (y - YTOP) / 8) : 1) + off;
      pts.push(at(Math.max(2, r), phi * (1 + (off ? 0 : 0)), y));
    }
    return pts;
  };
  for (const side of [-1, 1]) {
    const phi = side * ALPHA;
    const nrm = V3(side * Math.cos(ALPHA), 0, Math.sin(ALPHA)); // outward normal of that wing face
    const leg = edgePts(phi, 1.5).map((p) => p.addScaledVector(nrm, 1.2));
    K.add(steel, tubeAlong(leg, 2.4, 10, false, 80));
    const leg2 = edgePts(phi, -4.5).map((p) => p.addScaledVector(nrm, 1.6));
    K.add(steel, tubeAlong(leg2, 1.3, 8, false, 80));
    // lacing between the two chords
    for (let i = 1; i < 24; i++) {
      const a = leg[i], b = leg2[i + (i % 2 ? 1 : -1)] || leg2[i];
      K.add(steel, strut(a, b, 0.45, 0.45, 5));
    }
    // big X braces across the wing face, stepping up the building
    const bands = [[14, 70], [70, 124], [124, 170]];
    for (const [ya, yb] of bands) {
      const ra = R0(phi) * g(ya) - 5, rb = R0(phi) * g(yb) - 5;
      const pA = at(ra, phi, ya).addScaledVector(nrm, 2.2), pB = at(12, phi, yb).addScaledVector(nrm, 2.2);
      const pC = at(12, phi, ya).addScaledVector(nrm, 2.2), pD = at(rb, phi, yb).addScaledVector(nrm, 2.2);
      K.add(steel, strut(pA, pB, 1.1, 1.1, 8));
      K.add(steel, strut(pC, pD, 1.1, 1.1, 8));
      K.add(steel, strut(pC, pA, 0.8, 0.8, 6));
    }
  }
  // spine at the apex and the mast
  K.add(steel, cyl(4.2, 4.6, YTOP + 10, 0, 0, APEX_Z + 1.5, 16));
  K.add(steel, cyl(0.5, 2.6, 321 - (YTOP + 10), 0, YTOP + 10, APEX_Z + 1.5, 12));
  for (let i = 0; i < 6; i++) {
    const y = YTOP + 20 + i * 15, r = 2.6 - (i * 15 + 10) / 107 * 2.1;
    K.add(steel, cyl(r + 0.5, r + 0.5, 1.2, 0, y, APEX_Z + 1.5, 12));
  }

  // --- helipad (on the +X wing, near the top) with its support truss
  {
    const d = V3(Math.sin(ALPHA), 0, -Math.cos(ALPHA)), n = V3(Math.cos(ALPHA), 0, Math.sin(ALPHA));
    const c = V3(0, 210, APEX_Z).addScaledVector(d, 16).addScaledVector(n, 15);
    K.add(deck, cyl(12, 12, 1.6, c.x, c.y, c.z, 32));
    K.add(steel, cyl(12.6, 12.6, 0.8, c.x, c.y - 0.6, c.z, 32));
    const root = V3(0, 196, APEX_Z).addScaledVector(d, 10).addScaledVector(n, 2);
    K.add(steel, strut(root, c.clone().add(V3(0, -0.5, 0)), 1.4, 1.0, 8));
    K.add(steel, strut(root.clone().add(V3(0, 10, 0)), c.clone().addScaledVector(n, -6), 0.9, 0.9, 6));
  }
  // --- Al Muntaha skybar cantilever on the -X wing (wedge ~27 m long)
  {
    const d = V3(-Math.sin(ALPHA), 0, -Math.cos(ALPHA)), n = V3(-Math.cos(ALPHA), 0, Math.sin(ALPHA));
    const root = V3(0, 196, APEX_Z).addScaledVector(d, 12);
    const tip = root.clone().addScaledVector(n, 27).addScaledVector(d, -2);
    const side = d.clone();
    const shape = [];
    const L = 27, W0 = 9, W1 = 3;
    const pts2 = [[0, -W0 / 2], [L, -W1 / 2], [L + 1.5, 0], [L, W1 / 2], [0, W0 / 2]];
    for (const [a, b] of pts2) { const p = root.clone().addScaledVector(n, a).addScaledVector(side, b); shape.push([p.x, p.z]); }
    K.add(glass, prism(shape, 193, 201, { su: 1 / 16, sv: 1 / 14 }));
    K.add(steel, capXZ(shape, 193, false));
    K.add(steel, prism(shape.map(([x, z]) => [x, z]), 201, 202.2, {}));
    void tip;
  }
  // --- low podium ring at the base (entrance level)
  {
    const pts = [[0, APEX_Z + 6]];
    for (let i = 0; i <= 16; i++) { const phi = (i / 16 * 2 - 1) * (ALPHA + 3 * DEG); const p = at(R0(phi) * 0.99 + 3, phi, 0); pts.push([p.x, p.z]); }
    K.add(steel, prism(pts, 0, 6, { su: 1 / 10, sv: 1 / 6 }));
  }
  return K.group("burj_al_arab");
}

// ================================================================================================
// 2. MUSEUM OF THE FUTURE
// OSM way 1054289435 (building:part, height=77): an elongated footprint 137 x 38 m, long axis bearing
// ~40 deg. The torus is built in the canonical X-Y plane (long axis = X, faces +-Z), headingDeg = -50.
// Silver stainless skin, the Arabic calligraphy windows are a procedural dark stroke pattern (they glow
// at night). It sits on a planted mound.
// ================================================================================================
function calligraphyTex() {
  const draw = (lit) => (ctx, W, H) => {
    ctx.fillStyle = lit ? "#000" : "#c9ced3"; ctx.fillRect(0, 0, W, H);
    if (!lit) {
      // faint panel seams
      ctx.strokeStyle = "rgba(120,128,136,0.35)"; ctx.lineWidth = 1;
      for (let i = 0; i < 16; i++) { ctx.beginPath(); ctx.moveTo(i * W / 16, 0); ctx.lineTo(i * W / 16 + W / 32, H); ctx.stroke(); }
      for (let j = 0; j < 12; j++) { ctx.beginPath(); ctx.moveTo(0, j * H / 12); ctx.lineTo(W, j * H / 12 + H / 40); ctx.stroke(); }
    }
    const rnd = mulberry32(1234);
    const ink = lit ? "#fff3dc" : "#17202a";
    ctx.fillStyle = ink; ctx.strokeStyle = ink;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    // broad-nib stroke: width depends on the stroke direction, like a reed pen held at 45 degrees
    const strokes = [];
    const nib = (pts, w) => strokes.push({ pts, w });
    const bez = (p0, p1, p2, p3, n = 20) => {
      const out = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n, a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, c = 3 * (1 - t) * t * t, d = t ** 3;
        out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
      }
      return out;
    };
    const lines = 4, lh = H / lines;
    for (let L = 0; L < lines; L++) {
      const base = (L + 0.66) * lh;
      let x = rnd() * 30;
      while (x < W - 20) {
        const len = 38 + rnd() * 80;
        const sag = (rnd() - 0.3) * lh * 0.12;
        nib(bez([x, base], [x + len * 0.3, base + sag], [x + len * 0.7, base + sag], [x + len, base - rnd() * 4]), 7 + rnd() * 5);
        const n = 2 + Math.floor(rnd() * 4);
        for (let k = 0; k < n; k++) {
          const px = x + 6 + rnd() * (len - 6), t = rnd();
          if (t < 0.22) {        // alif / lam ascender
            const h = lh * (0.42 + rnd() * 0.22);
            nib(bez([px, base], [px + 3, base - h * 0.4], [px + 1, base - h * 0.8], [px - 2, base - h]), 8 + rnd() * 3);
          } else if (t < 0.56) { // bowl (waw / mim)
            const r = lh * (0.1 + rnd() * 0.07);
            nib(bez([px, base], [px - r * 1.8, base - r * 1.6], [px + r * 1.8, base - r * 2.4], [px + r * 0.4, base]), 7);
          } else if (t < 0.8) {  // descending sweep (ra / nun / ya)
            const d = lh * (0.18 + rnd() * 0.12);
            nib(bez([px, base], [px + 6, base + d * 0.8], [px - 16, base + d * 1.1], [px - 34 - rnd() * 20, base + d * 0.2]), 7 + rnd() * 3);
          } else {               // kaf-like overstroke
            nib(bez([px - 16, base - lh * 0.34], [px, base - lh * 0.42], [px + 10, base - lh * 0.3], [px + 22, base - lh * 0.12]), 6);
          }
          if (rnd() < 0.55) {    // dots
            const dx = px + (rnd() - 0.5) * 16, dy = base + (rnd() < 0.5 ? -lh * 0.3 : lh * 0.18);
            nib([[dx - 3, dy + 2], [dx + 3, dy - 2]], 7);
            if (rnd() < 0.4) nib([[dx + 6, dy + 2], [dx + 12, dy - 2]], 7);
          }
        }
        x += len + 8 + rnd() * 16;
      }
    }
    // paint every stroke with 3x3 wrap offsets so the tile repeats seamlessly
    for (const ox of [-W, 0, W]) for (const oy of [-H, 0, H]) {
      for (const s of strokes) {
        for (let i = 1; i < s.pts.length; i++) {
          const [x0, y0] = s.pts[i - 1], [x1, y1] = s.pts[i];
          const a = Math.atan2(y1 - y0, x1 - x0);
          ctx.lineWidth = Math.max(2.2, s.w * Math.abs(Math.sin(a - 0.8)) + 1.5);
          ctx.beginPath(); ctx.moveTo(x0 + ox, y0 + oy); ctx.lineTo(x1 + ox, y1 + oy); ctx.stroke();
        }
      }
    }
  };
  return {
    map: canvasTex("motf-callig", 512, draw(false)),
    emissive: canvasTex("motf-callig-lit", 512, draw(true)),
  };
}

function buildMuseumFuture() {
  const K = new Kit();
  const tex = calligraphyTex();
  const skin = K.nightMat(std("motf_skin", {
    color: 0xffffff, map: tex.map, metalness: 0.88, roughness: 0.42,
    emissive: 0xffe9c8, emissiveMap: tex.emissive,
  }), 0, 1.6);
  // Torus: outer ellipse A x B, void ellipse a x b raised by dy, depth D(theta)
  const A = 63, B = 38.5, YC = 38.5, a = 40, b = 18, DY = 7.5;
  const depth = (th) => 23 + 15 * Math.pow(Math.cos(th / 2), 2);
  const SE = 4.6; // superellipse exponent of the tube cross-section (flat faces, rounded edges)
  const se = (t) => Math.sign(t) * Math.pow(Math.abs(t), 2 / SE);
  const torus = (u, v) => {
    const th = u * Math.PI * 2, ps = v * Math.PI * 2;
    const ox = A * Math.sin(th), oy = YC - B * Math.cos(th);
    const ix = a * Math.sin(th), iy = YC + DY - b * Math.cos(th);
    const mx = (ox + ix) / 2, my = (oy + iy) / 2;
    let ex = ox - ix, ey = oy - iy;
    const w = Math.hypot(ex, ey) / 2; ex /= 2 * w; ey /= 2 * w;
    const d = depth(th) / 2;
    const c = se(Math.cos(ps)), s = se(Math.sin(ps));
    return V3(mx + ex * w * c, my + ey * w * c, d * s);
  };
  // The calligraphy runs in horizontal lines across the facade like a page (as on the real building):
  // planar X-Y projection, unfolded along the depth where the skin turns sideways.
  const S = 34;
  K.add(skin, paramSurface(torus, 180, 36, {
    flip: true,
    uvFn: (u, v, p) => {
      const th = u * Math.PI * 2, ps = v * Math.PI * 2;
      const ex0 = (A - a) * Math.sin(th), ey0 = (-B + b) * Math.cos(th) - DY * 0;
      const l = Math.hypot(ex0, ey0) || 1, c = Math.cos(ps);
      return [(p.x + p.z * (ex0 / l) * c) / S, (p.y + p.z * (ey0 / l) * c) / S];
    },
  }));
  // Mound: smooth planted hill; the lower ring is buried in it
  const grassTex = canvasTex("grass", 256, (ctx, W, H) => {
    ctx.fillStyle = "#5f7d3c"; ctx.fillRect(0, 0, W, H);
    const r = mulberry32(99);
    for (let i = 0; i < 1800; i++) {
      const g = 90 + r() * 70;
      ctx.fillStyle = `rgba(${40 + r() * 40 | 0},${g | 0},${30 + r() * 30 | 0},0.5)`;
      ctx.fillRect(r() * W, r() * H, 2 + r() * 5, 2 + r() * 5);
    }
  });
  const grass = std("motf_grass", { color: 0xffffff, map: grassTex, roughness: 0.95, metalness: 0 });
  const AM = 80, BM = 34, HM = 13;
  K.add(grass, paramSurface((u, v) => {
    const ang = u * Math.PI * 2, r = v;
    const x = AM * r * Math.cos(ang), z = BM * r * Math.sin(ang);
    const y = HM * Math.pow(Math.max(0, 1 - r * r), 0.55) - 0.3;
    return V3(x, y, z);
  }, 64, 14, { flip: false, uvFn: (u, v, p) => [p.x / 12, p.z / 12] }));
  // paved plaza rim around the mound and a glazed entrance slot cut into the mound on the +Z side
  const paving = std("motf_paving", { color: 0xd8d2c6, roughness: 0.85, metalness: 0 });
  const rim = [];
  for (let i = 0; i < 48; i++) { const t = i / 48 * Math.PI * 2; rim.push([(AM + 6) * Math.cos(t), (BM + 6) * Math.sin(t)]); }
  K.add(paving, prism(rim, 0, 0.35, { su: 1 / 10, sv: 1 / 10 }));
  const lobby = std("motf_lobby", { color: 0x223040, roughness: 0.1, metalness: 0.8, emissive: 0xffd6a0 });
  K.nightMat(lobby, 0, 0.8);
  for (const s of [-1, 1]) {
    const z = s * (BM * 0.72);
    K.add(lobby, box(34, 6, 2, 0, 3, z));
  }
  return K.group("museum_future");
}

// ================================================================================================
// 3. BURJ KHALIFA
// OSM building:parts (ways 137140331..137153144) map every setback lobe: three wings at bearings
// 66.4, 186.4 and 306.4 deg whose tips step in by ~9 m at each setback, spiralling clockwise
// (NW 70, NE 105, S 130, NW 160, ...), then six small lobes, the core to 710 m and the spire to 828 m.
// The model is built in true orientation (headingDeg = 0) straight from that data. Origin = tower axis.
// ================================================================================================
function buildBurjKhalifa() {
  const K = new Kit();
  const tex = curtainTex("bk-wall", { cols: 6, rows: 4, glass: [70, 88, 106], frame: "#dfe3e7", spandrelColor: "#5d6874", mullion: 0.3, spandrel: 0.08, vary: 0.1, litFrac: 0.3, warm: 0.35, seed: 41, glassMetal: 0.55, glassRough: 0.05, frameMetal: 1.0, frameRough: 0.28 });
  const glass = glassMat(K, "bk_glass", tex, { night: 1.3 });
  const terrace = std("bk_terrace", { color: 0x8d949b, roughness: 0.55, metalness: 0.6 });
  const steel = K.nightMat(std("bk_spire", { color: 0xd9dee3, roughness: 0.22, metalness: 0.95, emissive: 0xcfe0ff }), 0, 0.6);
  const beacon = K.nightMat(std("bk_beacon", { color: 0xff2a1a, roughness: 0.4, emissive: 0xff2010 }), 0.2, 6);
  const podTex = curtainTex("bk-podium", { cols: 4, rows: 2, glass: [40, 52, 62], frame: "#b9c0c6", mullion: 0.12, spandrel: 0.12, litFrac: 0.7, warm: 0.9, seed: 5, glassMetal: 0.4, glassRough: 0.06 });
  const podiumMat = glassMat(K, "bk_podium", podTex, { night: 1.5 });

  // bearings (deg) of the wing axes, converted to canonical angle (x east, z south)
  const dirOf = (brg) => [Math.sin(brg * DEG), -Math.cos(brg * DEG)];
  // arm: { brg, tip, h0 (root half width), hTip (cap radius), top }
  const arms = [];
  const wing = (brg, list) => {
    const hwTip = { 35: 9.1, 1: 10.7, 2: 12.0, 3: 13.2, 4: 14.0 };
    list.forEach(([tip, top], i) => {
      const hTip = i === 0 ? 9.1 : i < 5 ? [9.1, 10.7, 12.0, 13.2, 14.0][i] : 10;
      arms.push({ brg, tip, h0: i < 5 ? 16.3 : 10, hTip, top });
    });
    void hwTip;
  };
  wing(66.4, [[63.2, 35], [52.8, 105], [43.6, 200], [35.3, 315], [26.0, 460], [15.6, 605]]);
  wing(186.4, [[62.3, 35], [52.0, 130], [42.9, 235], [34.6, 360], [25.4, 520], [15.0, 625]]);
  wing(306.4, [[62.6, 35], [52.2, 70], [43.1, 160], [34.7, 270], [25.5, 405], [15.1, 645]]);
  for (const [brg, top] of [[6.4, 545], [126.4, 560], [246.4, 580]]) arms.push({ brg, tip: 18.6, h0: 13.2, hTip: 13.2, top });
  for (const [brg, top] of [[6.4, 660], [126.4, 680], [246.4, 700]]) arms.push({ brg, tip: 11.5, h0: 7.9, hTip: 7.9, top });

  // polar extent of one arm along a ray at canonical angle ang
  const armR = (arm, ang) => {
    const [ax, az] = dirOf(arm.brg);
    const ux = Math.cos(ang), uz = Math.sin(ang);
    const cd = ux * ax + uz * az;                 // cos(delta)
    const sd = Math.abs(ux * -az + uz * ax);       // |sin(delta)|
    const sc = arm.tip - arm.hTip, R = arm.hTip;   // cap centre along the axis, cap radius
    const k = (arm.h0 - R) / Math.max(1e-6, sc);
    let r = 0;
    if (cd > 0) {
      const tSide = arm.h0 / (sd + k * cd);
      r = Math.min(tSide, sc / cd);
    }
    const cu = cd * sc, disc = cu * cu - sc * sc + R * R;
    if (disc >= 0) r = Math.max(r, cu + Math.sqrt(disc));
    return r;
  };
  const N = 300;
  const outlineAt = (h) => {
    // longest active arm per direction
    const act = new Map();
    for (const a of arms) {
      if (a.top <= h) continue;
      const cur = act.get(a.brg);
      if (!cur || a.tip > cur.tip) act.set(a.brg, a);
    }
    const list = [...act.values()];
    const pts = [];
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * Math.PI * 2;
      let r = h < 710 ? 7.4 : 0;
      for (const a of list) r = Math.max(r, armR(a, ang));
      pts.push([r * Math.cos(ang), r * Math.sin(ang)]);
    }
    return pts;
  };
  const levels = [0, ...new Set(arms.map((a) => a.top))].sort((x, y) => x - y);
  levels.push(710);
  const uniq = [...new Set(levels)].sort((x, y) => x - y);
  for (let i = 0; i < uniq.length - 1; i++) {
    const y0 = uniq[i], y1 = uniq[i + 1];
    const pts = outlineAt(y0 + 0.01);
    K.add(glass, prism(pts, y0, y1, { su: 1 / 12, sv: 1 / 16, crease: 40, top: false }));
    K.add(terrace, capXZ(pts, y1, true));
  }
  // spire: tapered stainless shaft with a few rings, beacon at the tip
  K.add(steel, cyl(4.2, 5.6, 40, 0, 700, 0, 16));
  K.add(steel, cyl(0.35, 4.2, 88, 0, 740, 0, 12));
  for (let i = 0; i < 5; i++) K.add(steel, cyl(4.4 - i * 0.7, 4.4 - i * 0.7, 1.2, 0, 712 + i * 12, 0, 16));
  K.add(beacon, cyl(0.45, 0.45, 2.2, 0, 826, 0, 8));
  // podium (OSM parts at 15 m + tower base footprint), glazed
  const podium = [[-17.7, -18.6], [-19.5, -70.0], [-8.8, -94.3], [-4.9, -88.3], [5.7, -72.3], [13.2, -20.5], [14.0, -20.9], [15.5, -30.6], [19.8, -29.5], [23.8, -27.6], [27.3, -24.9], [30.2, -21.6], [32.4, -17.7], [33.7, -13.5], [34.1, -9.1], [33.7, -4.7], [24.3, -6.8], [23.9, -6.0], [67.7, 14.1], [84.9, 34.3], [58.7, 37.5], [11.5, 22.3], [11.4, 23.2], [18.6, 29.3], [14.9, 32.7], [10.6, 35.2], [5.8, 36.8], [0.8, 37.2], [-4.2, 36.5], [-9.0, 34.8], [-13.2, 32.1], [-6.3, 24.5], [-6.6, 23.7], [-47.0, 49.5], [-73.4, 53.3], [-62.2, 29.4], [-24.9, -1.9], [-25.8, -2.6], [-34.3, 1.1], [-35.6, -3.2], [-36.0, -7.7], [-35.4, -12.2], [-33.8, -16.5], [-31.7, -20.4], [-28.8, -23.9], [-25.2, -26.6], [-21.1, -28.4], [-18.7, -19.1]];
  const pod = osmPoly(podium, 0);
  K.add(podiumMat, prism(pod, 0, 15, { su: 1 / 12, sv: 1 / 16, crease: 30, top: false }));
  K.add(terrace, capXZ(pod, 15, true));
  return K.group("burj_khalifa");
}

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

// ================================================================================================
// 4. DUBAI FRAME
// OSM way 386649647 (height 150) and its parts 1333261517..20: the two legs are 18.0 x 14.9 m and their
// centres are 74.4 m apart along bearing 111.5 deg (the overall footprint is a parallelogram, so its own
// long axis is misleading). Golden-rectangle frame 150 x 92.4 m: legs, the Sky Deck bridge on top
// (OSM: 140-150 m), a low museum span at the base. Canonical frame plane = X-Y, headingDeg = 21.5
// (the faces look NNE to old Dubai and SSW to new Dubai).
// ================================================================================================
function goldTex() {
  const rosette = (ctx, W, H, hole, bg, edge) => {
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    // panel seams
    ctx.strokeStyle = edge; ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, W - 3, H - 3);
    ctx.fillStyle = hole;
    const cx = W / 2, cy = H / 2;
    for (const [ox, oy] of [[0, 0], [-W / 2, -H / 2], [W / 2, -H / 2], [-W / 2, H / 2], [W / 2, H / 2]]) {
      // Expo-2020-style ring of dots around a circle
      for (let ring = 0; ring < 3; ring++) {
        const R = W * (0.12 + ring * 0.1), n = 8 + ring * 6, rr = W * (0.028 - ring * 0.005);
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + ring * 0.2;
          ctx.beginPath(); ctx.arc(cx + ox + Math.cos(a) * R, cy + oy + Math.sin(a) * R, rr, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.beginPath(); ctx.arc(cx + ox, cy + oy, W * 0.05, 0, Math.PI * 2); ctx.fill();
    }
  };
  return {
    map: canvasTex("gold-map", 256, (c, W, H) => rosette(c, W, H, "#3a2a10", "#e2b457", "#b8893a")),
    orm: canvasTex("gold-orm", 256, (c, W, H) => rosette(c, W, H, "rgb(0,200,0)", "rgb(0,70,255)", "rgb(0,110,255)"), { srgb: false }),
    em: canvasTex("gold-em", 256, (c, W, H) => rosette(c, W, H, "#ffd890", "#5a4418", "#3a2a10")),
  };
}
function buildDubaiFrame() {
  const K = new Kit();
  const W = 92.4, H = 150, LEG = 18, DEP = 14.9, BR = 13, BASE = 8;
  const gt = goldTex();
  const gold = K.nightMat(std("frame_gold", {
    color: 0xffffff, map: gt.map, metalness: 1, roughness: 1, metalnessMap: gt.orm, roughnessMap: gt.orm,
    emissive: 0xffc870, emissiveMap: gt.em,
  }), 0, 1.3);
  const gtex = curtainTex("frame-glass", { cols: 3, rows: 3, glass: [60, 90, 110], frame: "#b8bec4", mullion: 0.08, spandrel: 0.06, litFrac: 0.8, warm: 0.2, seed: 9, glassMetal: 0.5, glassRough: 0.05 });
  const glass = glassMat(K, "frame_glass", gtex, { night: 1.6 });
  const trim = std("frame_trim", { color: 0xb08a3e, metalness: 1, roughness: 0.35 });
  // box faces with separate materials: gold on front/back/outer sides, glass on the inner reveals
  const faceBox = (x0, x1, y0, y1, z0, z1, mats) => {
    // mats: { px, nx, py, ny, pz, nz } material per face, UV in metres / 6
    const s = 1 / 6;
    const quad = (a, b, c, d, n, uv) => {
      const pos = [...a, ...b, ...c, ...a, ...c, ...d];
      const nor = [...n, ...n, ...n, ...n, ...n, ...n];
      return fromArrays(pos, nor, [...uv[0], ...uv[1], ...uv[2], ...uv[0], ...uv[2], ...uv[3]]);
    };
    const F = {
      pz: [quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], [[x0 * s, y0 * s], [x1 * s, y0 * s], [x1 * s, y1 * s], [x0 * s, y1 * s]])],
      nz: [quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], [[-x1 * s, y0 * s], [-x0 * s, y0 * s], [-x0 * s, y1 * s], [-x1 * s, y1 * s]])],
      px: [quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], [[z1 * s, y0 * s], [z0 * s, y0 * s], [z0 * s, y1 * s], [z1 * s, y1 * s]].map(([u, v]) => [-u, v]))],
      nx: [quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], [[z0 * s, y0 * s], [z1 * s, y0 * s], [z1 * s, y1 * s], [z0 * s, y1 * s]])],
      py: [quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], [[x0 * s, z1 * s], [x1 * s, z1 * s], [x1 * s, z0 * s], [x0 * s, z0 * s]])],
      ny: [quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], [[x0 * s, z0 * s], [x1 * s, z0 * s], [x1 * s, z1 * s], [x0 * s, z1 * s]])],
    };
    for (const k of Object.keys(F)) if (mats[k]) for (const g of F[k]) K.add(mats[k], g);
  };
  const hw = W / 2, z0 = -DEP / 2, z1 = DEP / 2;
  // legs
  faceBox(-hw, -hw + LEG, 0, H, z0, z1, { pz: gold, nz: gold, nx: gold, px: glass, py: gold });
  faceBox(hw - LEG, hw, 0, H, z0, z1, { pz: gold, nz: gold, px: gold, nx: glass, py: gold });
  // Sky Deck bridge: gold faces, glazed underside (glass floor)
  faceBox(-hw + LEG, hw - LEG, H - BR, H, z0, z1, { pz: gold, nz: gold, py: gold, ny: glass });
  // base museum span, set back slightly, glazed
  faceBox(-hw + LEG, hw - LEG, 0, BASE, z0 + 1.5, z1 - 1.5, { pz: glass, nz: glass, py: trim });
  // gold edge trims framing the opening and outer corners
  const e = 0.6;
  for (const zz of [z0 - e / 2, z1 + e / 2]) {
    K.add(trim, box(e, H - BR - BASE, e, -hw + LEG, BASE + (H - BR - BASE) / 2, zz));
    K.add(trim, box(e, H - BR - BASE, e, hw - LEG, BASE + (H - BR - BASE) / 2, zz));
    K.add(trim, box(W - 2 * LEG, e, e, 0, H - BR, zz));
    K.add(trim, box(e, H, e, -hw, H / 2, zz));
    K.add(trim, box(e, H, e, hw, H / 2, zz));
    K.add(trim, box(W, e, e, 0, H, zz));
  }
  // entrance plaza pads at the foot of each leg
  const pave = std("frame_pave", { color: 0xd9d2c2, roughness: 0.9 });
  K.add(pave, box(W + 30, 0.3, DEP + 30, 0, 0.15, 0));
  return K.group("dubai_frame");
}

// ================================================================================================
// 5. AIN DUBAI
// OSM way 1047288986 (attraction=big_wheel): footprint 241 x 12 m along bearing 168.5 deg on Bluewaters.
// 250 m tall: hub at ~126 m, rim radius ~114.5 m, 48 cabins outside the rim, cable-spoke fans from the
// hub ends, two splayed pairs of legs whose feet are the four small OSM ways 1047294490..93 (about 35 m
// along and 38 m across the wheel plane). Canonical wheel plane = X-Y, headingDeg = 78.5.
// ================================================================================================
function buildAinDubai() {
  const K = new Kit();
  const HUB = 126, R = 114.5, CAB = 48;
  const white = K.nightMat(std("ain_steel", { color: 0xf3f4f5, roughness: 0.38, metalness: 0.35, emissive: 0xbfd4ff }), 0, 0.25);
  const rimMat = K.nightMat(std("ain_rim", { color: 0xe9ecef, roughness: 0.3, metalness: 0.6, emissive: 0x7fb8ff }), 0, 2.2);
  const cable = std("ain_cable", { color: 0xb8bec6, roughness: 0.4, metalness: 0.8 });
  // rim truss: two chords + zigzag lacing
  for (const z of [-3.6, 3.6]) {
    const g = new THREE.TorusGeometry(R, 1.5, 8, 160);
    g.translate(0, HUB, z);
    K.add(rimMat, g);
  }
  {
    const g = new THREE.TorusGeometry(R - 5.5, 0.9, 6, 160);
    g.translate(0, HUB, 0);
    K.add(white, g);
  }
  const P = (ang, r, z) => V3(Math.sin(ang) * r, HUB + Math.cos(ang) * r, z);
  for (let i = 0; i < 96; i++) {
    const a0 = (i / 96) * Math.PI * 2, a1 = ((i + 1) / 96) * Math.PI * 2;
    const zA = i % 2 ? -3.6 : 3.6;
    K.add(white, strut(P(a0, R, zA), P(a1, R, -zA), 0.45, 0.45, 5));
    K.add(white, strut(P(a0, R, zA), P(a0, R - 5.5, 0), 0.4, 0.4, 5));
  }
  // hub and axle
  K.add(white, strut(V3(0, HUB, -16), V3(0, HUB, 16), 5.5, 5.5, 20));
  for (const s of [-1, 1]) K.add(white, strut(V3(0, HUB, s * 16), V3(0, HUB, s * 19), 5.5, 3, 20));
  // cable spokes: 2 fans per side, crossing like a bicycle wheel
  for (const s of [-1, 1]) {
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2 + (s > 0 ? 0 : Math.PI / 96);
      const hubAng = a + (i % 2 ? 0.35 : -0.35);
      const h = V3(Math.sin(hubAng) * 5, HUB + Math.cos(hubAng) * 5, s * 14);
      K.add(cable, strut(h, P(a, R - 5.5, s * 1.2), 0.16, 0.16, 3));
    }
  }
  // cabin mounts
  for (let i = 0; i < CAB; i++) {
    const a = (i / CAB) * Math.PI * 2;
    K.add(white, strut(P(a, R + 1.2, 0), P(a, R + 3.2, 0), 0.8, 0.8, 6));
  }
  // legs: two splayed pairs meeting the hub ends
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const foot = V3(sx * 35, 0, sz * 38), top = V3(sx * 3.5, HUB - 2, sz * 17);
    K.add(white, strut(foot, top, 3.6, 2.4, 14));
    K.add(white, cyl(6, 7, 3, foot.x, 0, foot.z, 16));
  }
  for (const sz of [-1, 1]) K.add(white, strut(V3(-24.8, 40, sz * 31.2), V3(24.8, 40, sz * 31.2), 1.6, 1.6, 10));
  for (const sx of [-1, 1]) K.add(white, strut(V3(sx * 24.8, 40, -31.2), V3(sx * 24.8, 40, 31.2), 1.4, 1.4, 10));
  // boarding building under the wheel
  const podTex = curtainTex("ain-podium", { cols: 4, rows: 2, glass: [40, 60, 76], frame: "#e8eaec", mullion: 0.1, spandrel: 0.2, litFrac: 0.8, warm: 0.8, seed: 12 });
  const pod = glassMat(K, "ain_podium", podTex, { night: 1.6 });
  const podOutline = [];
  for (let i = 0; i < 40; i++) { const t = (i / 40) * Math.PI * 2; podOutline.push([38 * Math.cos(t), 16 * Math.sin(t)]); }
  K.add(pod, prism(podOutline, 0, 7, { su: 1 / 8, sv: 1 / 7 }));
  // cabins (instanced): glass capsules kept level, long axis across the wheel plane
  const capG = new THREE.CapsuleGeometry(2.7, 7.5, 4, 12);
  capG.rotateX(Math.PI / 2);
  const cabMat = K.nightMat(std("ain_cabin", { color: 0x3c5566, metalness: 0.7, roughness: 0.08, emissive: 0xfff0d0 }), 0, 1.2);
  const inst = new THREE.InstancedMesh(capG, cabMat, CAB);
  inst.name = "ain_cabins";
  const m = new THREE.Matrix4();
  for (let i = 0; i < CAB; i++) {
    const a = (i / CAB) * Math.PI * 2;
    const p = P(a, R + 6.2, 0);
    m.makeTranslation(p.x, p.y, p.z);
    inst.setMatrixAt(i, m);
  }
  inst.castShadow = true; inst.receiveShadow = true;
  inst.computeBoundingSphere();
  K.object(inst);
  return K.group("ain_dubai");
}

// ================================================================================================
// 6. ATLANTIS THE PALM
// OSM way 89790675 (hotel, height 90.2): a 27 m wide spine along bearing 39.5 deg, forking at both
// ends. Royal Towers in the middle, joined over the great arch by the Royal Bridge Suite. Canonical
// X = spine (NE), +Z = the Palm trunk side (SE). headingDeg = -50.5. Origin = spine centre.
// ================================================================================================
function atlantisTex() {
  const cols = 4, rows = 4;
  const paint = (lit) => (ctx, W, H) => {
    const cw = W / cols, ch = H / rows;
    ctx.fillStyle = lit ? "#000" : "#cf7f63"; ctx.fillRect(0, 0, W, H);
    const rnd = mulberry32(lit ? 77 : 78);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      // pilasters
      if (!lit) { ctx.fillStyle = "#dc9478"; ctx.fillRect(c * cw, r * ch, cw * 0.12, ch); }
      const x = c * cw + cw * 0.24, y = r * ch + ch * 0.2, w = cw * 0.56, h = ch * 0.64;
      if (lit) {
        if (rnd() < 0.55) { const b = 0.6 + rnd() * 0.4; ctx.fillStyle = `rgb(${255 * b | 0},${205 * b | 0},${140 * b | 0})`; ctx.fillRect(x, y, w, h); }
      } else {
        ctx.fillStyle = "#ead3b4"; ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
        ctx.fillStyle = "#1f5a63"; ctx.fillRect(x, y, w, h);
        ctx.beginPath(); ctx.arc(x + w / 2, y + 1, w / 2, Math.PI, 0); ctx.fill();
      }
    }
    if (!lit) { ctx.fillStyle = "#ead3b4"; ctx.fillRect(0, H - ch * 0.1, W, ch * 0.1); }
  };
  return {
    map: canvasTex("atl-map", 256, paint(false)),
    em: canvasTex("atl-em", 256, paint(true)),
  };
}
function buildAtlantis() {
  const K = new Kit();
  const HD = -50.5;
  const t = atlantisTex();
  const wall = K.nightMat(std("atl_wall", { color: 0xffffff, map: t.map, roughness: 0.75, metalness: 0.05, emissive: 0xffffff, emissiveMap: t.em }), 0, 1.4);
  const cream = K.nightMat(std("atl_cream", { color: 0xf1dfc3, roughness: 0.7, metalness: 0.0, emissive: 0x6a7dff }), 0, 0.35);
  const goldM = std("atl_gold", { color: 0xd9ad55, roughness: 0.35, metalness: 1.0 });
  const osm = [[41.5, 63.8], [17.8, 126.4], [28.4, 140.8], [42.6, 131.2], [60.5, 86.8], [78.0, 73.2], [111.7, 67.6], [108.8, 42.9], [65.2, 50.7], [17.0, -7.9], [-0.6, -29.3], [-36.7, -73.1], [-43.7, -81.6], [-27.9, -125.8], [-51.6, -133.4], [-68.5, -86.8], [-102.2, -79.9], [-96.9, -55.9], [-94.4, -42.4], [-91.9, -28.6], [-73.5, -31.7], [-76.0, -45.8], [-78.5, -59.7], [-64.2, -62.0], [-12.7, -1.2], [-6.7, 6.4]];
  const poly = ccw(osmPoly(osm, HD, 1.5, -5.2));
  // stepped height profile along the spine
  const slabs = [
    [-400, -118, 40], [-118, -84, 50], [-84, -64, 58], [-64, -46, 64], [-46, -18, 78],
    [18, 46, 78], [46, 64, 64], [64, 84, 58], [84, 118, 50], [118, 400, 40],
  ];
  let zmin = Infinity, zmax = -Infinity;
  for (const [x0, x1, h] of slabs) {
    const piece = clipX(poly, x0, x1);
    if (piece.length < 3 || Math.abs(areaXZ(piece)) < 4) continue;
    K.add(wall, prism(piece, 0, h, { su: 1 / 16, sv: 1 / 12.8, crease: 30, top: false }));
    K.add(cream, capXZ(piece, h, true));
    K.add(cream, prism(scalePoly(piece, 1.0), h, h + 1.2, { top: false, su: 1 / 8, sv: 1 / 8 }));
  }
  const mid = clipX(poly, -18, 18);
  for (const p of mid) { zmin = Math.min(zmin, p[1]); zmax = Math.max(zmax, p[1]); }
  // the great arch: bridge block with a tall pointed arch cut out, extruded through the spine depth
  const AW = 15, AS = 45, AT = 65;
  {
    const sh = new THREE.Shape();
    sh.moveTo(-18, 0.01);
    sh.lineTo(-AW, 0.01); sh.lineTo(-AW, AS);
    sh.bezierCurveTo(-AW, AS + 11, -5, AT - 5, 0, AT);
    sh.bezierCurveTo(5, AT - 5, AW, AS + 11, AW, AS);
    sh.lineTo(AW, 0.01); sh.lineTo(18, 0.01); sh.lineTo(18, 80); sh.lineTo(-18, 80); sh.lineTo(-18, 0.01);
    const g = new THREE.ExtrudeGeometry(sh, { depth: zmax - zmin, bevelEnabled: false, curveSegments: 10 });
    g.translate(0, 0, zmin);
    // uv in metres for the wall texture
    const p = g.attributes.position, uv = g.attributes.uv, n0 = g.attributes.normal;
    g.computeVertexNormals();
    for (let i = 0; i < p.count; i++) {
      const nx = Math.abs(g.attributes.normal.getX(i)), nz = Math.abs(g.attributes.normal.getZ(i));
      uv.setXY(i, (nz > nx ? p.getX(i) : p.getZ(i)) / 16, p.getY(i) / 12.8);
    }
    void n0;
    K.add(wall, g);
    K.add(cream, box(40, 1.2, zmax - zmin + 1, 0, 80.6, (zmin + zmax) / 2));
  }
  // arch soffit lining (cream) so the underside reads as a lit vault
  {
    // follow the same two bezier halves as the cut-out, slightly inside it
    const bz = (t, p0, p1, p2, p3) => (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3;
    const soff = paramSurface((u, v) => {
      const half = u < 0.5, t = half ? u * 2 : (u - 0.5) * 2;
      const x = half ? bz(t, -AW, -AW, -5, 0) : bz(t, 0, 5, AW, AW);
      const y = half ? bz(t, AS, AS + 11, AT - 5, AT) : bz(t, AT, AT - 5, AS + 11, AS);
      return V3(x * 0.99, y - 0.08, zmin + v * (zmax - zmin));
    }, 24, 4, { flip: false, uvFn: (u, v) => [u * 4, v * 3] });
    K.add(cream, soff);
    // lit arch jambs
    for (const s of [-1, 1]) K.add(cream, box(0.6, AS, zmax - zmin, s * (AW - 0.25), AS / 2, (zmin + zmax) / 2));
  }
  // crowns: stepped towers with little domes, and the higher crown over the bridge
  const crown = (cx, w, d, base, steps) => {
    let y = base;
    for (let i = 0; i < steps; i++) {
      const s = 1 - i * 0.24, hgt = 3.6 - i * 0.6;
      K.add(cream, box(w * s, hgt, d * s, cx, y + hgt / 2, (zmin + zmax) / 2));
      y += hgt;
    }
    K.add(goldM, lathe(domeProfile(w * 0.16, w * 0.22, "onion", 8), 12, cx, y, (zmin + zmax) / 2));
    K.add(goldM, cyl(0.2, 0.4, 3, cx, y + w * 0.22, (zmin + zmax) / 2, 6));
    return y;
  };
  crown(-32, 24, zmax - zmin - 2, 79.2, 3);
  crown(32, 24, zmax - zmin - 2, 79.2, 3);
  crown(0, 34, zmax - zmin, 81.2, 2);
  // corner turrets on the towers
  for (const cx of [-45, -19, 19, 45]) for (const cz of [zmin + 1.5, zmax - 1.5]) {
    K.add(cream, cyl(1.8, 1.8, 6, cx, 78, cz, 8));
    K.add(goldM, lathe(domeProfile(2, 3, "onion", 6), 8, cx, 84, cz));
  }
  return K.group("atlantis");
}

// ================================================================================================
// 7. JUMEIRAH EMIRATES TOWERS
// OSM ways 393391114 (west) and 393391115 (east): equilateral triangles ~54 m a side, point symmetric
// about the complex. The west tower's OSM parts top out at 309 m (sloping skillion roof rising to the
// SE corner), so west = hotel 309 m and east = office tower 355 m (roof rising to its NW corner).
// Built in true orientation. Origin = midpoint between the two towers.
// ================================================================================================
function buildEmiratesTowers() {
  const K = new Kit();
  const tex = curtainTex("et-wall", { cols: 4, rows: 2, glass: [44, 74, 86], frame: "#cfd5da", spandrelColor: "#c3cacf", mullion: 0.1, spandrel: 0.42, vary: 0.12, litFrac: 0.35, warm: 0.5, seed: 17, glassMetal: 0.5, glassRough: 0.05, spandrelMetal: 1, spandrelRough: 0.3 });
  const glass = glassMat(K, "et_glass", tex, { night: 1.3 });
  const alu = K.nightMat(std("et_alu", { color: 0xd4d9dd, roughness: 0.42, metalness: 0.55, emissive: 0xdfe8ff }), 0, 0.5);
  const OX = 0.4, OY = 0;
  const towers = [
    { tri: [[-90.5, -16.3], [-61.5, 28.9], [-36.6, -18.7]], spire: 2, roof0: 232, roof1: 282, top: 309 },
    { tri: [[36.7, 17.2], [90.7, 17.6], [64.0, -29.0]], spire: 0, roof0: 265, roof1: 322, top: 355 },
  ];
  for (const T of towers) {
    const pts = osmPoly(T.tri, 0, OX, OY);
    // chamfer the two non-spire corners slightly
    K.add(glass, prism(pts, 0, T.roof0, { su: 1 / 12, sv: 1 / 8, crease: 20, top: false }));
    const S = pts[T.spire], A = pts[(T.spire + 1) % 3], B = pts[(T.spire + 2) % 3];
    // sloped roof plane: A and B at roof0, S at roof1
    const s3 = V3(S[0], T.roof1, S[1]), a3 = V3(A[0], T.roof0, A[1]), b3 = V3(B[0], T.roof0, B[1]);
    const tri = (p, q, r, mat) => {
      const g = new THREE.BufferGeometry().setFromPoints([p, q, r]);
      g.computeVertexNormals();
      const up = g.attributes.normal.getY(0);
      K.add(mat, up < 0 && p.y > 1 ? new THREE.BufferGeometry().setFromPoints([p, r, q]) : g);
    };
    // walls under the slope (trapezoids S-A and S-B) as glass
    const wallQuad = (P0, P1, h0, h1) => {
      const g = paramSurface((u, v) => V3(P0[0] + (P1[0] - P0[0]) * u, T.roof0 + v * (h0 + (h1 - h0) * u), P0[1] + (P1[1] - P0[1]) * u), 6, 6, {
        uvFn: (u, v, p) => [Math.hypot(p.x - P0[0], p.z - P0[1]) / 12, p.y / 8],
      });
      return g;
    };
    // orientation: the outward normal must point away from the triangle centroid
    const cen = [(S[0] + A[0] + B[0]) / 3, (S[1] + A[1] + B[1]) / 3];
    for (const [P0, P1, h0, h1] of [[A, S, 0, T.roof1 - T.roof0], [S, B, T.roof1 - T.roof0, 0]]) {
      let g = wallQuad(P0, P1, h0, h1);
      const nx = g.attributes.normal.getX(0), nz = g.attributes.normal.getZ(0);
      const mx = (P0[0] + P1[0]) / 2 - cen[0], mz = (P0[1] + P1[1]) / 2 - cen[1];
      if (nx * mx + nz * mz < 0) g = wallQuad(P1, P0, h1, h0);
      K.add(glass, g);
    }
    tri(a3, s3, b3, alu);
    // make sure the roof faces up
    // spire: tapering triangular needle rising from the S corner
    const inward = V3(cen[0] - S[0], 0, cen[1] - S[1]).normalize();
    const sb = V3(S[0], T.roof1 - 2, S[1]).addScaledVector(inward, 3);
    K.add(alu, strut(sb, V3(sb.x, T.top, sb.z), 2.2, 0.25, 3));
    // vertical aluminium corner fins
    for (const P of [S, A, B]) K.add(alu, cyl(0.9, 0.9, T.roof0, P[0], 0, P[1], 6));
  }
  return K.group("emirates_towers");
}

// ================================================================================================
// 8. CAYAN TOWER
// OSM way 195527255 (height 306.4, 73 levels): ~40 x 37 m plate, sides at bearing ~39.7 deg.
// Every floor turns 1.2 deg, 90 deg over the height. White vertical fins spiral with the twist.
// Canonical plate axis-aligned at the base, headingDeg = 39.7.
// ================================================================================================
function buildCayan() {
  const K = new Kit();
  const tex = curtainTex("cayan-wall", { cols: 4, rows: 4, glass: [58, 88, 108], frame: "#f1f1ee", spandrelColor: "#aeb8bf", mullion: 0.3, spandrel: 0.1, vary: 0.1, litFrac: 0.45, warm: 0.7, seed: 21, glassMetal: 0.4, glassRough: 0.05, frameMetal: 0.1, frameRough: 0.5 });
  const glass = glassMat(K, "cayan_glass", tex, { night: 1.4 });
  const white = K.nightMat(std("cayan_white", { color: 0xeeeeea, roughness: 0.5, metalness: 0.1, emissive: 0xffffff }), 0, 0.2);
  const H = 306, FLOORS = 73, TW = Math.PI / 2;
  const plate = [];
  const N = 64, A = 19.8, B = 18.4, E = 7;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
    plate.push([A * Math.sign(c) * Math.pow(Math.abs(c), 2 / E), B * Math.sign(s) * Math.pow(Math.abs(s), 2 / E)]);
  }
  const eq = ccw(resamplePoly(plate, N));
  const rings = [];
  const podium = 10;
  for (let f = 0; f <= FLOORS; f++) {
    const y = podium + (f / FLOORS) * (H - 4 - podium);
    const a = (f / FLOORS) * TW;
    const c = Math.cos(a), s = Math.sin(a);
    rings.push(eq.map(([x, z]) => V3(x * c + z * s, y, -x * s + z * c)));
  }
  K.add(glass, loftRings(rings, { su: 1 / 12, sv: 1 / 16.8, vFromY: true, capTop: false }));
  const top = rings[rings.length - 1];
  K.add(white, capXZ(top.map((p) => [p.x, p.z]), top[0].y, true));
  // crown parapet
  K.add(white, prism(top.map((p) => [p.x * 1.01, p.z * 1.01]), top[0].y, H, { su: 1 / 8, sv: 1 / 4 }));
  // podium
  K.add(glass, prism(eq.map(([x, z]) => [x * 1.25, z * 1.25]), 0, podium, { su: 1 / 12, sv: 1 / 16.8 }));
  return K.group("cayan");
}

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

// ================================================================================================
// 9. JUMEIRAH MOSQUE
// OSM way 217936504 (building=mosque): prayer hall ~25 x 29 m with an entrance porch projecting east
// toward Jumeirah Beach Road, qibla wall to the west. Fatimid style: one large ribbed dome and two
// minarets flanking the porch. White/cream stone, warm floodlight at night. True orientation.
// ================================================================================================
function buildJumeirahMosque() {
  const K = new Kit();
  const at = archTex("jm-arch", { n: 2, bg: "#efe6d4", hole: "#8b8577", holeTop: "#5d574c", frame: "#e3d6bd", glow: "#ffcf8a", lattice: "rgba(90,80,60,0.5)" });
  const wall = K.nightMat(std("jm_wall", { color: 0xffffff, map: at.map, roughness: 0.7, emissive: 0xffffff, emissiveMap: at.em }), 0, 1.2);
  const stone = K.nightMat(std("jm_stone", { color: 0xf1e8d6, roughness: 0.65, emissive: 0xffc98a }), 0, 0.28);
  const gold = goldMat("jm_gold");
  const OUT = [[-16.3, 5.4], [-11.9, 6.1], [-13.2, 15.9], [-10.1, 16.3], [-10.5, 19.6], [7.7, 21.8], [9.5, 7.0], [15.6, 7.7], [16.1, 3.8], [17.3, -6.0], [6.4, -7.4], [8.8, -26.6], [-0.3, -27.7], [-1.9, -14.8], [-7.9, -15.6], [-8.3, -12.1], [-11.1, -12.5], [-11.9, -6.1], [-14.8, -6.6]];
  const out = osmPoly(OUT, 0);
  const main = clipHalf(out, (p) => -p[1] - (-7.4)); // hall + porch north of y=-7.4
  const south = clipHalf(out, (p) => -7.4 - -p[1]);
  K.add(wall, prism(main, 0, 11, { su: 1 / 7, sv: 1 / 9, top: false }));
  K.add(stone, capXZ(main, 11, true));
  K.add(stone, prism(main, 11, 12.2, { top: false, su: 1 / 6, sv: 1 / 6 }));
  K.add(wall, prism(south, 0, 7, { su: 1 / 7, sv: 1 / 7 }));
  // crenellated parapet blocks along the hall roof edge
  const pm = ccw(main);
  for (let i = 0; i < pm.length; i++) {
    const a = pm[i], b = pm[(i + 1) % pm.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let s = 1.2; s < L - 0.6; s += 2.4) {
      const t = s / L;
      K.add(stone, box(0.9, 1.2, 0.9, a[0] + (b[0] - a[0]) * t, 12.8, a[1] + (b[1] - a[1]) * t));
    }
  }
  // main dome over the hall (ribbed Fatimid dome on an octagonal drum)
  const [dx, dz] = osm2c(-3.2, 7.2, 0);
  K.add(stone, cyl(7.4, 7.4, 3.2, dx, 12.2, dz, 8));
  K.add(stone, domeGeom(6.6, 1.2, 7.0, 9.5, "pointed", 24, 12).translate(dx, 15.4, dz));
  const ribs = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const pts = domeProfile(7.05, 9.5, "pointed", 10).map(([r, h]) => V3(dx + Math.cos(a) * r, 16.6 + h, dz + Math.sin(a) * r));
    ribs.push(tubeAlong(pts, 0.16, 4, false, 20));
  }
  ribs.forEach((g) => K.add(stone, g));
  K.add(gold, finialGeom(0.6, 3.2).translate(dx, 26, dz));
  // small domes over the porch and the hall corners
  const smalls = [[13.2, 1.0, 2.8], [-11.5, 17.0, 2.2], [4.8, 18.5, 2.2], [-12.5, -3.2, 2.2]];
  for (const [x, y, r] of smalls) {
    const [cx, cz] = osm2c(x, y, 0);
    K.add(stone, domeGeom(r * 0.95, 1.4, r, r * 1.3, "pointed", 16, 8).translate(cx, 12.2, cz));
    K.add(gold, finialGeom(0.3, 1.4).translate(cx, 12.2 + 1.4 + r * 1.3, cz));
  }
  // two minarets flanking the porch
  for (const [x, y] of [[13.8, 10.8], [15.0, -9.6]]) {
    const [cx, cz] = osm2c(x, y, 0);
    K.add(stone, box(3.6, 12, 3.6, cx, 6, cz));
    K.add(stone, cyl(1.55, 1.7, 10, cx, 12, cz, 8));
    K.add(stone, cyl(2.3, 1.6, 1.2, cx, 21.2, cz, 12));
    K.add(stone, cyl(1.3, 1.45, 7, cx, 22.4, cz, 8));
    K.add(stone, cyl(2.0, 1.3, 1.0, cx, 28.6, cz, 12));
    K.add(stone, cyl(1.05, 1.05, 3.2, cx, 29.6, cz, 8));
    K.add(stone, lathe(domeProfile(1.35, 3.0, "pointed", 8), 12, cx, 32.8, cz));
    K.add(gold, finialGeom(0.22, 1.8).translate(cx, 35.7, cz));
  }
  // forecourt paving
  const pave = std("jm_pave", { color: 0xe6dccb, roughness: 0.85 });
  K.add(pave, prism(scalePoly(ccw(out), 1.25), 0, 0.25, { su: 1 / 6, sv: 1 / 6 }));
  return K.group("jumeirah_mosque");
}

// ================================================================================================
// 10. SHEIKH ZAYED GRAND MOSQUE
// OSM relation 1635169 (outline), domes as building:part=dome with heights 85/65/50/43 and the four
// 104-107 m minarets (man_made=tower) at the corners of the courtyard. Prayer hall to the west (qibla),
// arcades with small domes round the courtyard, raised on a podium. True orientation, all positions
// from OSM. White marble, gold finials; blue-white moonlight at night.
// ================================================================================================
function courtyardTex() {
  return canvasTex("szgm-court", 512, (ctx, W, H) => {
    ctx.fillStyle = "#f2f0ea"; ctx.fillRect(0, 0, W, H);
    const rnd = mulberry32(5);
    const cols = ["#b8433d", "#3f7a4a", "#d6a13a", "#476fa8", "#8a5a9a"];
    // vines
    ctx.strokeStyle = "rgba(90,130,80,0.55)"; ctx.lineWidth = 3;
    for (let i = 0; i < 26; i++) {
      ctx.beginPath(); let x = rnd() * W, y = rnd() * H; ctx.moveTo(x, y);
      for (let k = 0; k < 5; k++) { const nx = x + (rnd() - 0.5) * 160, ny = y + (rnd() - 0.5) * 160; ctx.quadraticCurveTo(x + (rnd() - 0.5) * 120, y + (rnd() - 0.5) * 120, nx, ny); x = nx; y = ny; }
      ctx.stroke();
    }
    for (let i = 0; i < 38; i++) {
      const x = rnd() * W, y = rnd() * H, r = 10 + rnd() * 26, c = cols[(rnd() * cols.length) | 0], n = 5 + ((rnd() * 4) | 0);
      for (const [ox, oy] of [[0, 0], [W, 0], [-W, 0], [0, H], [0, -H]]) {
        ctx.fillStyle = c;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2;
          ctx.beginPath(); ctx.ellipse(x + ox + Math.cos(a) * r * 0.6, y + oy + Math.sin(a) * r * 0.6, r * 0.5, r * 0.22, a, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = "#e9c46a"; ctx.beginPath(); ctx.arc(x + ox, y + oy, r * 0.22, 0, Math.PI * 2); ctx.fill();
      }
    }
  });
}
function buildSZGM() {
  const K = new Kit();
  const PLAT = 8, ARC = 22, HALL = 33;
  const aTex = archTex("szgm-arch", { n: 1, bg: "#f5f3ee", hole: "#aab2bb", holeTop: "#6a7482", frame: "#d9c79a", glow: "#fff0d0", pier: 0.14, spring: 0.45, top: 0.12 });
  const arcade = K.nightMat(std("szgm_arcade", { color: 0xffffff, map: aTex.map, roughness: 0.42, emissive: 0xffffff, emissiveMap: aTex.em }), 0, 0.7);
  const white = marble(K, "szgm_marble", { night: 0.42 });
  const gold = goldMat("szgm_gold");
  const floor = std("szgm_court", { color: 0xffffff, map: courtyardTex(), roughness: 0.3, metalness: 0 });
  const OUT = [[-88.7, -108.5], [-99.8, -58.5], [-101.6, -58.9], [-103.4, -51.5], [-107.1, -34.4], [-118.5, -36.9], [-120.5, -27.8], [-123.7, -25.6], [-121.8, -22.5], [-123.6, -14.5], [-112.1, -11.9], [-116.1, 6.4], [-117.7, 13.3], [-116.0, 13.6], [-126.3, 59.8], [-108.6, 63.7], [-110.4, 71.6], [-102.3, 73.4], [-88.4, 76.5], [-86.5, 68.7], [-83.9, 69.3], [-50.9, 76.6], [-44.8, 77.9], [-9.4, 85.7], [-3.6, 86.9], [31.8, 94.7], [36.9, 95.8], [70.9, 103.3], [69.1, 111.1], [76.7, 112.7], [92.4, 116.2], [96.6, 97.7], [97.5, 93.7], [91.5, 92.4], [101.5, 48.1], [107.1, 49.3], [112.0, 27.7], [116.4, 7.5], [117.3, 3.7], [111.7, 2.4], [121.2, -40.4], [127.2, -39.1], [132.2, -61.5], [108.4, -66.7], [108.1, -65.3], [73.9, -72.8], [33.4, -81.7], [-7.8, -90.7], [-47.4, -99.5], [-50.2, -100.0], [-49.7, -102.2], [-71.5, -107.0], [-72.0, -104.8]];
  const out = ccw(osmPoly(OUT, 0));
  const C = (x, y) => osm2c(x, y, 0);
  const NW = C(-37.0, 66.6), NE = C(78.6, 91.5), SE = C(109.9, -49.9), SW = C(-7.0, -75.2);
  // podium (courtyard level), faced with small arches
  K.add(arcade, prism(out, 0, PLAT, { su: 1 / 6, sv: 1 / 8, top: false }));
  // prayer hall: the part of the outline west of the NW-SW minaret line
  const west = C(-110, 0);
  const hall = clipLine(out, SW, NW, west);
  const rest = clipLine(out, SW, NW, C(60, 0));
  K.add(arcade, prism(hall, PLAT, HALL, { su: 1 / 11, sv: 1 / 25, vOff: PLAT, top: false }));
  K.add(white, capXZ(hall, HALL, true));
  K.add(white, prism(hall, HALL, HALL + 1.6, { top: false, su: 1 / 4, sv: 1 / 4 }));
  // arcades: ring between the outer outline and the courtyard, courtyard walls face inward
  const inset = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const court = [inset(NW, NE, 0.004), NE, SE, inset(SW, SE, 0.004)];
  K.add(arcade, prism(rest, PLAT, ARC, { su: 1 / 8, sv: 1 / 14, vOff: PLAT, top: false }));
  K.add(white, capXZ(rest, ARC, true, 1 / 20, [court]));
  K.add(arcade, prism(court, PLAT, ARC, { su: 1 / 8, sv: 1 / 14, vOff: PLAT, inward: true }));
  K.add(white, prism(rest, ARC, ARC + 1.2, { top: false, su: 1 / 4, sv: 1 / 4 }));
  K.add(floor, capXZ(court, PLAT + 0.05, true, 1 / 30));
  // domes from OSM: [x, y, osmRadius, osmHeight]
  const DOMES = [[-80.6, -15.9, 18.7, 85], [-88.1, 31.5, 12.9, 65], [-66.9, -58.1, 12.8, 65], [-37.5, -5.0, 7.9, 50], [102.3, 26.0, 6.6, 50], [-96.7, 64.0, 7.0, 50], [-61.3, -91.9, 7.0, 50], [-110.5, -22.4, 7.0, 50]];
  for (const [x, y, r, h] of DOMES) {
    const [cx, cz] = C(x, y);
    const onHall = pointInPoly([cx, cz], hall);
    const base = onHall ? HALL : ARC + 4;
    if (!onHall) K.add(white, box(r * 2.4, base - ARC, r * 2.4, cx, ARC + (base - ARC) / 2, cz));
    const fin = h >= 80 ? 7 : h >= 60 ? 5 : 4;
    const domeTop = h - fin;
    const drumH = (domeTop - base) * 0.34, domeH = (domeTop - base) - drumH;
    K.add(white, domeGeom(r * 0.86, drumH, r * 0.96, domeH, "onion", h >= 60 ? 36 : 24, h >= 60 ? 16 : 11).translate(cx, base, cz));
    K.add(white, cyl(r * 0.95, r * 0.95, 1.0, cx, base + drumH - 0.5, cz, h >= 60 ? 36 : 24));
    K.add(gold, finialGeom(r * 0.07 + 0.25, fin).translate(cx, domeTop - 0.3, cz));
  }
  // small arcade domes (instanced)
  const SMALL = [[-114.7, 54.6], [-78.6, 63.7], [-62.1, 67.6], [-46.5, 71.1], [-29.1, 75.0], [-12.2, 79.1], [5.1, 82.8], [21.3, 86.2], [38.5, 90.2], [54.7, 93.5], [68.3, 96.3], [87.1, 84.9], [90.5, 70.6], [93.2, 56.0], [106.8, -3.2], [110.1, -19.3], [113.0, -32.9], [101.8, -58.9], [87.4, -61.6], [71.8, -65.2], [55.7, -68.2], [37.8, -72.2], [20.9, -75.6], [5.6, -79.0], [-13.2, -83.2], [-27.9, -85.8], [-43.3, -89.3], [-81.2, -97.5], [-43.1, 56.8], [-40.3, 42.6], [-36.9, 27.2], [-23.5, -33.7], [-20.7, -48.1], [-17.5, -63.3]];
  const smallG = domeGeom(4.3, 3.0, 4.9, 10.5, "onion", 14, 7);
  const finG = finialGeom(0.45, 4.2, 6);
  const list = [], flist = [];
  for (const [x, y] of SMALL) {
    const [cx, cz] = C(x, y);
    const base = pointInPoly([cx, cz], hall) ? HALL : ARC;
    list.push({ x: cx, y: base, z: cz });
    flist.push({ x: cx, y: base + 13.3, z: cz });
  }
  instanced(K, smallG, white, list, "szgm_small_domes");
  instanced(K, finG, gold, flist, "szgm_small_finials");
  // four minarets (~107 m)
  for (const [x, y] of [[-37.0, 66.6], [78.6, 91.5], [109.9, -49.9], [-7.0, -75.2]]) {
    const [cx, cz] = C(x, y);
    K.add(white, box(10, ARC + 6 - PLAT, 10, cx, PLAT + (ARC + 6 - PLAT) / 2, cz, 12.9 * DEG));
    K.add(white, cyl(4.3, 4.6, 34, cx, ARC + 6, cz, 8));
    K.add(white, cyl(6.0, 4.3, 2.2, cx, 62, cz, 16));
    K.add(white, cyl(3.6, 3.8, 18, cx, 64.2, cz, 12));
    K.add(white, cyl(5.0, 3.6, 2.0, cx, 82.2, cz, 16));
    K.add(white, cyl(2.9, 2.9, 8, cx, 84.2, cz, 12));
    K.add(white, cyl(3.8, 3.8, 1.2, cx, 92.2, cz, 12));
    K.add(gold, lathe(domeProfile(3.2, 7.5, "onion", 10), 12, cx, 93.4, cz));
    K.add(gold, finialGeom(0.35, 6, 6).translate(cx, 100.8, cz));
  }
  return K.group("sz_mosque");
}

// ================================================================================================
// 11. ETIHAD TOWERS
// OSM ways 168401781..85: five towers (305, 277, 260, 234, 218 m) on a 4-storey podium (1465342507).
// Footprints from OSM, softened; each crown curves down to the north-west like a blade. Dark blue glass.
// True orientation; origin = centre of the tower cluster.
// ================================================================================================
function buildEtihad() {
  const K = new Kit();
  const tex = curtainTex("etihad-wall", { cols: 4, rows: 4, glass: [34, 50, 64], frame: "#8c969f", spandrelColor: "#2c3a46", mullion: 0.06, spandrel: 0.12, vary: 0.08, litFrac: 0.35, warm: 0.55, seed: 33, glassMetal: 0.65, glassRough: 0.04, frameMetal: 0.9, frameRough: 0.3 });
  const glass = glassMat(K, "etihad_glass", tex, { night: 1.3 });
  const cap = std("etihad_cap", { color: 0x5d6770, roughness: 0.4, metalness: 0.8 });
  const podTex = curtainTex("etihad-podium", { cols: 3, rows: 2, glass: [40, 56, 68], frame: "#cfd3d6", mullion: 0.1, spandrel: 0.25, litFrac: 0.7, warm: 0.9, seed: 34 });
  const podium = glassMat(K, "etihad_podium", podTex, { night: 1.5 });
  const OX = 16, OY = 42; // cluster centre in the OSM local frame
  const T = [
    { h: 260, p: [[31.1, 20.9], [34.9, 31.1], [36.0, 46.7], [34.3, 68.2], [-0.6, 58.5], [2.4, 46.4], [7.5, 33.5], [14.6, 25.4], [23.2, 20.0], [27.3, 19.2]] },
    { h: 218, p: [[-46.9, 104.8], [-36.9, 98.9], [-26.1, 97.5], [-16.3, 97.0], [-12.5, 97.8], [-7.9, 109.9], [-13.6, 114.2], [-20.1, 117.5], [-27.2, 119.6], [-36.1, 120.7], [-43.7, 120.1]] },
    { h: 234, p: [[22.4, 106.2], [31.1, 106.4], [39.8, 109.9], [44.6, 116.1], [48.7, 122.3], [49.8, 125.8], [48.7, 131.2], [31.9, 130.1], [21.1, 126.1], [15.4, 122.8], [11.8, 117.5]] },
    { h: 277, p: [[78.5, -22.0], [83.0, -9.8], [71.8, -2.9], [60.0, 1.2], [44.1, 3.1], [39.2, -9.8], [52.6, -19.5], [65.9, -23.5]] },
    { h: 305, p: [[-2.7, -45.9], [10.8, -33.5], [18.9, -21.9], [20.8, -9.8], [15.5, -1.3], [5.5, -0.7], [-4.9, -9.1], [-11.7, -17.6], [-21.1, -34.2]] },
  ];
  // Each crown is a curved roof falling from the south-east edge (full height) to the north-west edge.
  const lean = norm2([-0.7, -0.7]); // direction the roofs fall toward (canonical: -x west, -z north)
  for (const t of T) {
    const base = ccw(resamplePoly(chaikin(ccw(osmPoly(t.p, 0, OX, OY)), 2), 72));
    const pr = base.map(([x, z]) => -(x * lean[0] + z * lean[1]));
    const lo = Math.min(...pr), hi = Math.max(...pr);
    const drop = t.h * 0.2;
    const roofY = (x, z) => { const s = (-(x * lean[0] + z * lean[1]) - lo) / (hi - lo); return t.h - drop * Math.pow(1 - Math.min(1, Math.max(0, s)), 1.7); };
    // walls: vertical, ending on the roof curve
    const rings = [];
    const NW = 18;
    for (let j = 0; j <= NW; j++) rings.push(base.map(([x, z]) => V3(x, 20 + (roofY(x, z) - 20) * (j / NW), z)));
    K.add(glass, loftRings(rings, { su: 1 / 12, sv: 1 / 14, vFromY: true }));
    // roof surface: rings shrinking toward the highest (south-east) point, following the curve
    let anc = base[0], best = -Infinity;
    base.forEach((p, i) => { if (pr[i] > best) { best = pr[i]; anc = p; } });
    const roof = [];
    for (let k = 0; k <= 8; k++) {
      const s = 1 - k / 8 * 0.995;
      roof.push(base.map(([x, z]) => { const px = anc[0] + (x - anc[0]) * s, pz = anc[1] + (z - anc[1]) * s; return V3(px, roofY(px, pz) + 0.05, pz); }));
    }
    K.add(cap, loftRings(roof, { su: 1 / 20, sv: 1 / 20 }));
  }
  const POD = [[42.0, 98.8], [52.0, 88.5], [67.9, 66.5], [76.4, 52.6], [82.3, 40.4], [85.9, 25.5], [86.5, 3.0], [86.3, -5.6], [84.9, -16.2], [79.5, -30.6], [73.9, -39.7], [63.9, -51.1], [56.3, -56.5], [43.2, -63.2], [33.5, -65.9], [21.0, -67.9], [4.5, -66.4], [-7.3, -61.7], [-22.4, -54.0], [-19.7, -47.6], [-20.3, -42.2], [-24.1, -31.6], [-39.4, -8.5], [-51.5, 19.9], [-51.4, 36.8], [-55.0, 56.9], [-62.7, 94.0], [-49.7, 87.4], [-37.4, 80.8], [-15.4, 73.8], [-1.8, 73.3], [12.7, 77.4], [23.0, 82.8], [31.3, 88.2]];
  const pod = osmPoly(POD, 0, OX, OY);
  K.add(podium, prism(pod, 0, 20, { su: 1 / 10, sv: 1 / 10, top: false }));
  K.add(cap, capXZ(pod, 20, true));
  // the towers 4 and 5 stand on their own lower bases north of the main podium
  for (const t of [T[1], T[2]]) K.add(podium, prism(scalePoly(osmPoly(t.p, 0, OX, OY), 1.35), 0, 20, { su: 1 / 10, sv: 1 / 10 }));
  return K.group("etihad");
}

// ================================================================================================
// 12. CAPITAL GATE
// OSM way 103779658 (height 160): the 68 x 60 m footprint is the plan projection of the leaning tower.
// 35 floors; vertical to ~30 m, then leaning progressively 18 deg westward (top offset ~28 m). Diagrid
// glass skin, and the stainless "splash" canopy sweeping down on the east side. Origin = OSM centroid.
// ================================================================================================
function diagridTex() {
  const draw = (mode) => (ctx, W, H) => {
    // mode 0: colour, 1: orm, 2: emissive
    ctx.fillStyle = mode === 0 ? "#29435a" : mode === 1 ? "rgb(0,12,150)" : "#000"; ctx.fillRect(0, 0, W, H);
    if (mode === 2) {
      const r = mulberry32(3);
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) if (r() < 0.45) { ctx.fillStyle = `rgba(255,${200 + r() * 40 | 0},${140 + r() * 60 | 0},${0.5 + r() * 0.5})`; ctx.fillRect(i * W / 8 + 2, j * H / 8 + 2, W / 8 - 4, H / 8 - 5); }
    } else {
      ctx.strokeStyle = mode === 0 ? "rgba(170,185,198,0.6)" : "rgb(0,80,200)"; ctx.lineWidth = 1.5;
      for (let j = 1; j < 8; j++) { ctx.beginPath(); ctx.moveTo(0, j * H / 8); ctx.lineTo(W, j * H / 8); ctx.stroke(); }
    }
    ctx.strokeStyle = mode === 0 ? "#e9edf0" : mode === 1 ? "rgb(0,70,255)" : "rgba(160,200,255,0.8)"; ctx.lineWidth = mode === 2 ? 3 : 7;
    for (const s of [-1, 0, 1]) {
      ctx.beginPath(); ctx.moveTo(s * W, 0); ctx.lineTo(s * W + W, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(s * W + W, 0); ctx.lineTo(s * W, H); ctx.stroke();
    }
  };
  return { map: canvasTex("diag-map", 256, draw(0)), orm: canvasTex("diag-orm", 256, draw(1), { srgb: false }), em: canvasTex("diag-em", 256, draw(2)) };
}
function buildCapitalGate() {
  const K = new Kit();
  const dt = diagridTex();
  const glass = K.nightMat(std("cg_glass", { color: 0xffffff, map: dt.map, metalness: 1, roughness: 1, metalnessMap: dt.orm, roughnessMap: dt.orm, emissive: 0xffffff, emissiveMap: dt.em }), 0, 1.3);
  const steel = K.nightMat(std("cg_steel", { color: 0xd5dade, roughness: 0.3, metalness: 1.0, emissive: 0x9ec3ff }), 0, 0.4);
  const cap = std("cg_cap", { color: 0x7d868e, roughness: 0.5, metalness: 0.6 });
  const H = 160, A = 22, B = 27, BASE_X = 14;
  const plate = [];
  for (let i = 0; i < 64; i++) { const t = (i / 64) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t); plate.push([A * Math.sign(c) * Math.pow(Math.abs(c), 0.85), B * Math.sign(s) * Math.pow(Math.abs(s), 0.85)]); }
  const eq = ccw(resamplePoly(plate, 64));
  const off = (y) => { const t = Math.max(0, y - 28) / (H - 28); return -30 * t * t * 0.55 - 30 * t * 0.45; };
  const rings = [];
  for (let j = 0; j <= 40; j++) {
    const y = (j / 40) * H;
    const ox = BASE_X + off(y);
    // floor plates also creep north a little and rotate slightly, as the real plates are staggered
    const rot = (y / H) * 8 * DEG, cr = Math.cos(rot), sr = Math.sin(rot);
    rings.push(eq.map(([x, z]) => V3(ox + x * cr + z * sr, y, -x * sr + z * cr - (y / H) * 4)));
  }
  K.add(glass, loftRings(rings, { su: 1 / 16, sv: 1 / 16, vFromY: true }));
  const top = rings[rings.length - 1];
  K.add(cap, capXZ(top.map((p) => [p.x, p.z]), H, true));
  // the splash: a stainless canopy peeling off the east face at ~58 m and sweeping down and out over
  // the low grandstand building on the east side (OSM way 396939669), curling up at its edges
  const sp = paramSurface((u, v) => {
    const y = 12 + 46 * Math.pow(1 - v, 2.1);
    const x = BASE_X + A * 0.72 + off(y) * 0.2 + 36 * Math.pow(v, 0.75);
    const w = 22 + 22 * Math.pow(v, 0.7);
    const zc = -2 - 7 * v;
    const t = u - 0.5;
    return V3(x - 4 * t * t * v, y + 7 * t * t * (0.4 + v), zc + t * w);
  }, 18, 30, { flip: true, uvFn: (u, v) => [u * 5, v * 7] });
  // the grandstand block under the canopy
  const gs = [[36.8, 28.3], [62.7, 20.5], [53.7, -10.7], [45.4, -7.6], [42.3, -2.1], [41.3, 2.1], [41.5, 12.5], [41.1, 18.2], [39.7, 24.1]];
  K.add(cap, prism(osmPoly(gs, 0), 0, 11, { su: 1 / 8, sv: 1 / 8 }));
  const splashTex = canvasTex("splash", 128, (ctx, W, H2) => {
    ctx.fillStyle = "#cfd5da"; ctx.fillRect(0, 0, W, H2);
    ctx.strokeStyle = "#8d969e"; ctx.lineWidth = 2;
    for (let i = 0; i <= 8; i++) { ctx.beginPath(); ctx.moveTo(i * W / 8, 0); ctx.lineTo(i * W / 8, H2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i * H2 / 8); ctx.lineTo(W, i * H2 / 8); ctx.stroke(); }
  });
  const splash = K.nightMat(std("cg_splash", { color: 0xffffff, map: splashTex, roughness: 0.45, metalness: 0.6, side: THREE.DoubleSide, emissive: 0x6fa8ff }), 0, 0.5);
  K.add(splash, sp);
  // grandstand-level podium under the splash
  const pod = [];
  for (let i = 0; i < 32; i++) { const t = (i / 32) * Math.PI * 2; pod.push([BASE_X + 16 + 30 * Math.cos(t), -6 + 24 * Math.sin(t)]); }
  K.add(steel, prism(pod, 0, 3, { su: 1 / 8, sv: 1 / 8 }));
  return K.group("capital_gate");
}

// ================================================================================================
// 13. ALDAR HQ
// OSM way 168404139 ("Al Dar Headquarters", height 110): 132 x 38 m lens-shaped footprint, long axis
// bearing 339.4 deg. A 121 m circular disc standing on edge, convex on both faces (38 m thick at the
// centre), glass diagrid. Canonical disc plane = X-Y, headingDeg = 69.4.
// ================================================================================================
function buildAldar() {
  const K = new Kit();
  const dt = diagridTex();
  const glass = K.nightMat(std("aldar_glass", { color: 0xd8e6ee, map: dt.map, metalness: 1, roughness: 1, metalnessMap: dt.orm, roughnessMap: dt.orm, emissive: 0xffffff, emissiveMap: dt.em }), 0, 1.2);
  const rim = K.nightMat(std("aldar_rim", { color: 0xcfd6dc, roughness: 0.3, metalness: 0.9, emissive: 0xbfd8ff }), 0, 0.5);
  const R = 60.5, YC = 110 - R, T0 = 19, TR = 5;
  // front and back convex faces
  for (const s of [1, -1]) {
    K.add(glass, paramSurface((u, v) => {
      const a = u * Math.PI * 2, r = v * R;
      const z = s * (TR + (T0 - TR) * Math.sqrt(Math.max(0, 1 - (r / R) ** 2)));
      return V3(Math.cos(a) * r, Math.max(0, YC + Math.sin(a) * r), z);
    }, 64, 16, { flip: s < 0, uvFn: (u, v, p) => [p.x / 10, p.y / 10] }));
  }
  // rim band
  K.add(rim, paramSurface((u, v) => {
    const a = u * Math.PI * 2;
    return V3(Math.cos(a) * R, Math.max(0, YC + Math.sin(a) * R), (v - 0.5) * 2 * TR);
  }, 96, 1, { flip: false, uvFn: (u, v) => [u * 40, v] }));
  // lobby podium the disc stands in
  const pod = [];
  for (let i = 0; i < 32; i++) { const t = (i / 32) * Math.PI * 2; pod.push([40 * Math.cos(t), 17 * Math.sin(t)]); }
  const pt = curtainTex("aldar-podium", { cols: 3, rows: 2, glass: [40, 60, 74], frame: "#dfe3e6", mullion: 0.1, spandrel: 0.2, litFrac: 0.8, warm: 0.9, seed: 8 });
  K.add(glassMat(K, "aldar_podium", pt, { night: 1.5 }), prism(pod, 0, 6, { su: 1 / 8, sv: 1 / 6 }));
  return K.group("aldar");
}

// ================================================================================================
// 14. EMIRATES PALACE
// OSM way 30394921 (hotel, 8 levels): the palace is 520 m long along bearing ~60 deg, wings bending
// forward at both ends. Central dome from OSM (w1520930332, 42 m wide), smaller domes from OSM near the
// centre plus domed pavilions on the wing corners (the real hotel has 114 domes). Desert-sand walls,
// arched windows; gold finials. True orientation; origin = OSM centroid.
// ================================================================================================
function buildEmiratesPalace() {
  const K = new Kit();
  const at = archTex("ep-arch", { n: 3, bg: "#d9b48e", hole: "#6d5a4a", holeTop: "#4d3f35", frame: "#ecd3b3", glow: "#ffd08a", pier: 0.22, spring: 0.5, top: 0.26, base: 0.86, band: "#c9a27c" });
  const wall = K.nightMat(std("ep_wall", { color: 0xffffff, map: at.map, roughness: 0.8, emissive: 0xffffff, emissiveMap: at.em }), 0, 1.0);
  const sand = K.nightMat(std("ep_sand", { color: 0xdcb993, roughness: 0.75, emissive: 0xffb070 }), 0, 0.45);
  const domeM = K.nightMat(std("ep_dome", { color: 0xe7cfae, roughness: 0.45, metalness: 0.1, emissive: 0xffd9a8 }), 0, 0.35);
  const gold = goldMat("ep_gold");
  const OUT = [[-240.2, -20.1], [-236.3, -26.6], [-242.2, -30.1], [-235.4, -41.6], [-230.8, -38.9], [-207.0, -77.3], [-172.0, -56.0], [-173.7, -53.0], [-150.1, -39.6], [-142.5, -52.7], [-116.2, -37.7], [-125.0, -22.4], [-111.8, -14.8], [-102.7, -30.4], [-81.6, -18.3], [-90.6, -2.9], [-95.0, -5.4], [-110.1, 20.4], [-113.5, 18.5], [-123.5, 35.2], [-108.6, 44.1], [-104.8, 37.9], [-70.0, 58.8], [-56.7, 37.0], [-12.3, 63.6], [-7.9, 66.3], [-21.7, 88.3], [13.4, 110.2], [10.1, 115.3], [24.1, 124.0], [34.2, 108.1], [21.1, 99.9], [47.5, 57.1], [76.0, 74.3], [66.5, 89.9], [77.4, 96.5], [86.4, 81.8], [109.1, 95.5], [108.4, 97.8], [121.2, 105.2], [120.6, 109.7], [138.0, 120.5], [141.4, 120.7], [166.1, 135.3], [143.6, 172.8], [149.2, 176.1], [142.4, 187.6], [138.8, 185.5], [136.0, 190.2], [132.6, 189.7], [125.1, 202.0], [165.2, 226.1], [173.3, 212.9], [169.5, 210.6], [171.9, 206.6], [169.7, 203.6], [175.3, 194.4], [179.1, 196.7], [207.9, 149.9], [202.6, 146.8], [216.3, 124.6], [154.5, 87.1], [192.1, 26.1], [122.1, -16.4], [103.3, -28.2], [101.0, -35.8], [99.5, -40.6], [90.8, -45.8], [60.4, -63.6], [49.6, -69.9], [27.5, -82.9], [17.3, -88.8], [-14.1, -107.6], [-26.5, -108.1], [-107.3, -155.5], [-129.4, -118.3], [-138.4, -123.5], [-155.4, -93.7], [-207.8, -122.6], [-219.5, -101.7], [-228.4, -106.6], [-257.3, -55.0], [-262.8, -57.9], [-269.7, -46.8], [-274.7, -49.7], [-285.4, -33.1], [-274.5, -26.5], [-272.2, -30.0], [-254.8, -20.0], [-257.0, -16.4], [-246.5, -10.1]];
  const out = ccw(osmPoly(OUT, 0));
  const [dcx, dcz] = osm2c(-15.0, -9.5, 0);
  // heights step down away from the central dome: rings of distance
  const zones = [[0, 70, 34], [70, 140, 30], [140, 230, 26], [230, 400, 22]];
  const axis = norm2([Math.sin(60.1 * DEG), -Math.cos(60.1 * DEG)]);
  for (const [d0, d1, h] of zones) {
    for (const sgn of [1, -1]) {
      const piece = clipAxis(out, [axis[0] * sgn, axis[1] * sgn], d0 + (dcx * axis[0] + dcz * axis[1]) * sgn, d1 + (dcx * axis[0] + dcz * axis[1]) * sgn);
      if (piece.length < 3 || Math.abs(areaXZ(piece)) < 10) continue;
      K.add(wall, prism(piece, 0, h, { su: 1 / 12, sv: 1 / 8, crease: 30, top: false }));
      K.add(sand, capXZ(piece, h, true));
      K.add(sand, prism(piece, h, h + 1.4, { top: false, su: 1 / 6, sv: 1 / 6 }));
    }
  }
  // central dome: 42 m wide on a tall drum, top ~73 m with finial
  K.add(sand, cyl(24, 24, 6, dcx, 34, dcz, 32));
  K.add(domeM, domeGeom(20.5, 8, 21.5, 24, "pointed", 40, 16).translate(dcx, 40, dcz));
  K.add(gold, finialGeom(1.2, 9, 10).translate(dcx, 71.5, dcz));
  // OSM small domes near the centre (height 32) + domed pavilions on convex corners of the outline
  const SM = [[1.0, 46.5], [-35.0, 28.0], [25.0, 13.5], [-72.0, 4.5], [45.0, -25.0], [-53.0, -34.0], [12.0, -51.0], [-25.0, -67.0], [-102.0, -72.0]];
  const list = [], fl = [];
  const addDome = (cx, cz, base, s) => { list.push({ x: cx, y: base, z: cz, s }); fl.push({ x: cx, y: base + 11.5 * s, z: cz, s }); };
  for (const [x, y] of SM) { const [cx, cz] = osm2c(x, y, 0); addDome(cx, cz, 34.5, 1); }
  // corner pavilions: convex vertices, pushed 6 m inside, spaced apart
  const used = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
    const cr = (b[0] - a[0]) * (-(c[1] - b[1])) - (-(b[1] - a[1])) * (c[0] - b[0]);
    if (cr <= 0) continue; // convex corners only (CCW outline)
    const bis = norm2([(a[0] - b[0]) / Math.hypot(a[0] - b[0], a[1] - b[1]) + (c[0] - b[0]) / Math.hypot(c[0] - b[0], c[1] - b[1]), (a[1] - b[1]) / Math.hypot(a[0] - b[0], a[1] - b[1]) + (c[1] - b[1]) / Math.hypot(c[0] - b[0], c[1] - b[1])]);
    const p = [b[0] + bis[0] * 7, b[1] + bis[1] * 7];
    if (!pointInPoly(p, out) || used.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 24)) continue;
    used.push(p);
    const d = Math.abs((p[0] - dcx) * axis[0] + (p[1] - dcz) * axis[1]);
    const base = d < 70 ? 34 : d < 140 ? 30 : d < 230 ? 26 : 22;
    K.add(sand, box(11, 5, 11, p[0], base + 2.5, p[1]));
    addDome(p[0], p[1], base + 5, 0.75);
  }
  const dG = domeGeom(5.2, 2.2, 5.8, 9.3, "pointed", 16, 8);
  instanced(K, dG, domeM, list, "ep_domes");
  instanced(K, finialGeom(0.45, 2.6, 6), gold, fl, "ep_finials");
  return K.group("emirates_palace");
}

// ================================================================================================
// 15. LOUVRE ABU DHABI
// OSM: dome part w403276371 (182 m across, centre = origin) over the museum w498046180. The 180 m dome
// is very shallow: rim ~21 m up, crown ~40 m, ~4.5 m thick edge band, carried on four hidden piers. Two
// perforated star-lattice layers (alpha tested) give the "rain of light". White gallery blocks below.
// True orientation.
// ================================================================================================
function starLattice(key, holeScale, seed) {
  return canvasTex(key, 512, (ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(196,200,204,1)"; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "destination-out";
    const n = 8, cw = W / n;
    const rnd = mulberry32(seed);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const cx = (i + 0.5) * cw + (j % 2 ? cw / 2 : 0), cy = (j + 0.5) * cw;
      const r = cw * holeScale * (0.8 + rnd() * 0.4);
      ctx.beginPath();
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2, rr = k % 2 ? r * 0.45 : r;
        ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
      ctx.closePath(); ctx.fill();
      if (cx + r > W) { ctx.save(); ctx.translate(-W, 0); ctx.fill(); ctx.restore(); }
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(150,156,162,1)"; ctx.lineWidth = 2;
    for (let j = 0; j <= n; j++) { ctx.beginPath(); ctx.moveTo(0, j * cw); ctx.lineTo(W, j * cw); ctx.stroke(); }
  });
}
function buildLouvre() {
  const K = new Kit();
  const R = 90, RIM = 21, CROWN = 40, EDGE = 4.5;
  const sag = CROWN - (RIM + EDGE), Rs = (R * R + sag * sag) / (2 * sag);
  const capY = (r, top) => (top ? RIM + EDGE : RIM) + (Math.sqrt(Math.max(0, Rs * Rs - r * r)) - (Rs - sag)) * (top ? 1 : 0.92);
  const top = std("louvre_top", { color: 0xe6e9ec, map: starLattice("louvre-l1", 0.22, 4), alphaTest: 0.5, roughness: 0.7, metalness: 0.1, side: THREE.DoubleSide });
  const under = K.nightMat(std("louvre_under", { color: 0xffffff, map: starLattice("louvre-l2", 0.3, 9), alphaTest: 0.5, roughness: 0.55, metalness: 0.3, side: THREE.DoubleSide, emissive: 0xffe2b8, emissiveMap: starLattice("louvre-l2", 0.3, 9) }), 0, 0.9);
  const polar = (yFn, rep) => paramSurface((u, v) => { const a = u * Math.PI * 2, r = v * R; return V3(Math.cos(a) * r, yFn(r), Math.sin(a) * r); }, 72, 18, { flip: true, uvFn: (u, v, p) => [p.x / rep, p.z / rep] });
  K.add(top, polar((r) => capY(r, true), 22));
  K.add(under, polar((r) => capY(r, false), 16));
  const rimMat = K.nightMat(std("louvre_rim", { color: 0xd9dcdf, roughness: 0.4, metalness: 0.8, emissive: 0xfff0d8 }), 0, 0.4);
  K.add(rimMat, paramSurface((u, v) => { const a = u * Math.PI * 2; return V3(Math.cos(a) * R, RIM + v * EDGE, Math.sin(a) * R); }, 96, 1, { flip: true, uvFn: (u, v) => [u * 60, v] }));
  // four piers (hidden among the galleries)
  const white = K.nightMat(std("louvre_white", { color: 0xf4f3ef, roughness: 0.6, emissive: 0xffe6c4 }), 0, 0.15);
  for (let k = 0; k < 4; k++) { const a = (k / 4) * Math.PI * 2 + Math.PI / 4; K.add(white, box(5, RIM, 5, Math.cos(a) * 55, RIM / 2, Math.sin(a) * 55)); }
  // gallery blocks: a grid of white cubes inside the museum outline, aligned with its main axis
  const BLD = [[-23.5, 99.3], [-51.9, 136.6], [-57.2, 133.1], [-37.2, 105.9], [-80.1, 75.4], [-66.7, 57.5], [-95.5, 36.2], [-86.7, 24.5], [-88.4, 12.9], [-122.9, -17.2], [-107.4, -35.1], [-120.7, -46.8], [-81.7, -92.0], [-67.6, -80.6], [-52.0, -102.4], [-39.8, -93.5], [-37.4, -96.7], [-49.1, -106.4], [-40.3, -119.4], [-30.8, -112.6], [-25.3, -120.4], [-28.1, -123.8], [-12.9, -144.4], [-21.6, -150.9], [-19.2, -153.9], [2.7, -137.6], [6.1, -142.2], [-1.1, -147.5], [7.4, -158.9], [23.2, -147.1], [24.9, -149.4], [18.5, -154.2], [22.7, -159.7], [31.6, -153.1], [20.0, -138.0], [25.5, -133.8], [28.5, -137.8], [32.4, -133.8], [47.4, -152.9], [64.5, -137.9], [62.8, -136.0], [67.8, -131.6], [69.5, -133.5], [96.5, -109.8], [91.2, -103.4], [84.9, -108.5], [72.0, -117.7], [68.6, -113.4], [75.9, -107.7], [56.7, -85.1], [69.6, -74.1], [75.5, -89.8], [71.6, -93.2], [76.8, -99.1], [83.2, -93.6], [77.1, -86.6], [83.4, -81.2], [75.2, -71.9], [78.8, -68.8], [87.7, -78.9], [102.2, -68.5], [110.4, -69.8], [107.2, -72.4], [114.0, -80.1], [116.4, -77.9], [125.9, -88.4], [120.9, -93.6], [125.6, -99.3], [142.0, -85.4], [129.9, -71.6], [146.8, -59.1], [142.5, -54.9], [150.3, -46.6], [152.6, -44.5], [156.0, -48.2], [166.1, -39.0], [169.3, -32.6], [168.2, -31.4], [173.5, -26.0], [163.8, -14.4], [157.2, -20.9], [139.9, -1.6], [146.1, 3.7], [138.6, 12.3], [118.4, -6.5], [112.8, 1.8], [114.4, 2.9], [103.1, 19.4], [106.4, 21.8], [101.4, 29.1], [98.3, 27.1], [80.4, 53.4], [100.7, 67.5], [95.5, 75.4], [113.2, 87.2], [98.1, 107.6], [68.8, 86.8], [61.2, 97.4], [73.0, 105.8], [64.4, 117.4], [44.8, 102.9], [50.4, 95.3], [36.3, 85.3], [-1.6, 128.6], [-19.4, 113.7], [-14.5, 107.5]];
  const bld = ccw(osmPoly(BLD, 0));
  const ax = norm2([Math.sin(54.6 * DEG), -Math.cos(54.6 * DEG)]), px = [-ax[1], ax[0]];
  const rnd = mulberry32(2017);
  const blocks = [], walls = [];
  for (let i = -8; i <= 8; i++) for (let j = -8; j <= 8; j++) {
    const cellU = 21, cellV = 21, gap = 4 + rnd() * 3;
    const u = i * cellU + (rnd() - 0.5) * 3, v = j * cellV + (rnd() - 0.5) * 3;
    const c = [ax[0] * u + px[0] * v, ax[1] * u + px[1] * v];
    const hu = (cellU - gap) / 2 * (0.7 + rnd() * 0.3), hv = (cellV - gap) / 2 * (0.7 + rnd() * 0.3);
    const corners = [[-hu, -hv], [hu, -hv], [hu, hv], [-hu, hv]].map(([a, b]) => [c[0] + ax[0] * a + px[0] * b, c[1] + ax[1] * a + px[1] * b]);
    if (!corners.every((p) => pointInPoly(p, bld))) continue;
    const r = Math.hypot(c[0], c[1]);
    const h = r < 80 ? 7 + rnd() * 9 : 6 + rnd() * 6;
    blocks.push(prism(corners, 0, h, { su: 1 / 6, sv: 1 / 6 }));
    void walls;
  }
  const galTex = canvasTex("louvre-gal", 128, (ctx, W, H) => {
    ctx.fillStyle = "#f6f5f1"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#e4e2dc"; for (let i = 0; i < 4; i++) ctx.fillRect(0, i * H / 4, W, 2);
  });
  const gal = K.nightMat(std("louvre_gal", { color: 0xffffff, map: galTex, roughness: 0.75, emissive: 0xffe2b8 }), 0, 0.3);
  blocks.forEach((g) => K.add(gal, g));
  // plaza deck at water level under the dome
  const deck = std("louvre_deck", { color: 0xe9e5dc, roughness: 0.9 });
  K.add(deck, prism(bld, 0, 0.4, { su: 1 / 10, sv: 1 / 10 }));
  const g = K.group("louvre");
  return g;
}

// ================================================================================================

export const LANDMARKS = [
  {
    id: "burj_al_arab",
    name: "Burj Al Arab",
    lat: 25.141306, lon: 55.185346,
    headingDeg: 127.3,
    suppress: [[25.141727, 55.184743], [25.140859, 55.185294], [25.140887, 55.185410], [25.140925, 55.185500], [25.140977, 55.185582], [25.141039, 55.185653], [25.141112, 55.185712], [25.141193, 55.185757], [25.141279, 55.185786], [25.141368, 55.185798], [25.141476, 55.185794]],
    height: 321,
    build: buildBurjAlArab,
  },
  {
    id: "museum_future",
    name: "Museum of the Future",
    lat: 25.219112, lon: 55.281829,
    headingDeg: -50.1,
    suppress: [[25.218739, 55.281244], [25.218703, 55.281230], [25.218663, 55.281228], [25.218625, 55.281241], [25.218592, 55.281266], [25.218568, 55.281301], [25.218555, 55.281343], [25.218555, 55.281384], [25.218561, 55.281415], [25.218579, 55.281487], [25.218600, 55.281557], [25.218628, 55.281626], [25.218662, 55.281692], [25.218701, 55.281754], [25.218745, 55.281812], [25.218801, 55.281870], [25.218837, 55.281905], [25.218860, 55.281928], [25.219168, 55.282210], [25.219275, 55.282309], [25.219314, 55.282340], [25.219361, 55.282362], [25.219412, 55.282373], [25.219464, 55.282370], [25.219514, 55.282354], [25.219560, 55.282327], [25.219599, 55.282289], [25.219629, 55.282243], [25.219649, 55.282191], [25.219658, 55.282134], [25.219656, 55.282077], [25.219642, 55.282022], [25.219617, 55.281972], [25.219583, 55.281929], [25.219547, 55.281901], [25.219138, 55.281538]],
    height: 77,
    build: buildMuseumFuture,
  },
  {
    id: "burj_khalifa",
    name: "Burj Khalifa",
    lat: 25.197221, lon: 55.274156,
    headingDeg: 0,
    suppress: [[25.197022, 55.273959], [25.196584, 55.273942], [25.196330, 55.274065], [25.196412, 55.274124], [25.196561, 55.274232], [25.197009, 55.274303], [25.197019, 55.274277], [25.196922, 55.274293], [25.196937, 55.274359], [25.196955, 55.274403], [25.196982, 55.274441], [25.197015, 55.274473], [25.197053, 55.274496], [25.197095, 55.274510], [25.197138, 55.274515], [25.197200, 55.274507], [25.197180, 55.274408], [25.197158, 55.274421], [25.197333, 55.274841], [25.197545, 55.275038], [25.197578, 55.274736], [25.197446, 55.274286], [25.197423, 55.274290], [25.197485, 55.274371], [25.197531, 55.274316], [25.197556, 55.274269], [25.197571, 55.274217], [25.197575, 55.274163], [25.197569, 55.274109], [25.197552, 55.274058], [25.197515, 55.273994], [25.197439, 55.274070], [25.197462, 55.274081], [25.197686, 55.273696], [25.197725, 55.273394], [25.197476, 55.273522], [25.197203, 55.273878], [25.197218, 55.273897], [25.197256, 55.273804], [25.197195, 55.273783], [25.197150, 55.273779], [25.197106, 55.273785], [25.197064, 55.273803], [25.197026, 55.273825], [25.196992, 55.273857], [25.196965, 55.273896], [25.196938, 55.273960], [25.197036, 55.273987]],
    height: 828,
    build: buildBurjKhalifa,
  },
  {
    id: "dubai_frame",
    name: "Dubai Frame",
    lat: 25.235456, lon: 55.300367,
    headingDeg: 21.5,
    suppress: [[25.235706, 55.299951], [25.235530, 55.299874], [25.235461, 55.300068], [25.235275, 55.300589], [25.235206, 55.300784], [25.235382, 55.300861], [25.235451, 55.300666], [25.235517, 55.300483], [25.235549, 55.300497], [25.235606, 55.300344], [25.235572, 55.300328], [25.235637, 55.300145]],
    height: 150,
    build: buildDubaiFrame,
  },
  {
    id: "ain_dubai",
    name: "Ain Dubai",
    lat: 25.080052, lon: 55.123795,
    headingDeg: 78.5,
    suppress: [[25.080377, 55.123257], [25.079561, 55.123439], [25.079727, 55.124333], [25.080543, 55.124151]],
    height: 250,
    build: buildAinDubai,
  },
  {
    id: "atlantis",
    name: "Atlantis The Palm",
    lat: 25.130410, lon: 55.117097,
    headingDeg: -50.5,
    suppress: [[25.130526, 55.117000], [25.130458, 55.116940], [25.129915, 55.116437], [25.129932, 55.116326], [25.130040, 55.116347], [25.130185, 55.116376], [25.130219, 55.116154], [25.130077, 55.116126], [25.129955, 55.116101], [25.129720, 55.116044], [25.129656, 55.116387], [25.129228, 55.116558], [25.129308, 55.116830], [25.129715, 55.116671], [25.129785, 55.116734], [25.130180, 55.117091], [25.130374, 55.117266], [25.130896, 55.117737], [25.130824, 55.118179], [25.131084, 55.118212], [25.131136, 55.117864], [25.131253, 55.117699], [25.131655, 55.117521], [25.131755, 55.117360], [25.131603, 55.117237], [25.131037, 55.117471]],
    height: 98,
    build: buildAtlantis,
  },
  {
    id: "emirates_towers",
    name: "Jumeirah Emirates Towers",
    lat: 25.217600, lon: 55.283004,
    headingDeg: 0,
    suppress: [[25.217402, 55.282687], [25.217462, 55.282653], [25.217482, 55.282641], [25.217537, 55.282610], [25.217582, 55.282583], [25.217781, 55.282469], [25.217915, 55.282392], [25.217793, 55.282306], [25.217668, 55.282218], [25.217549, 55.282134], [25.217427, 55.282048], [25.217421, 55.282215], [25.217410, 55.282468], [25.217408, 55.282523], [25.217406, 55.282589], [25.217405, 55.282613], [25.217396, 55.282693], [25.217284, 55.283636], [25.217787, 55.283952], [25.217784, 55.283480], [25.217783, 55.283312], [25.217278, 55.283630]],
    height: 355,
    build: buildEmiratesTowers,
  },
  {
    id: "cayan",
    name: "Cayan Tower",
    lat: 25.086846, lon: 55.145171,
    headingDeg: 39.7,
    suppress: [[25.087166, 55.145147], [25.086805, 55.144819], [25.086526, 55.145195], [25.086886, 55.145522]],
    height: 306,
    build: buildCayan,
  },
  {
    id: "jumeirah_mosque",
    name: "Jumeirah Mosque",
    lat: 25.233961, lon: 55.265527,
    headingDeg: 0,
    suppress: [[25.233869, 55.265354], [25.233874, 55.265383], [25.233818, 55.265391], [25.233821, 55.265418], [25.233790, 55.265423], [25.233797, 55.265482], [25.233680, 55.265499], [25.233697, 55.265648], [25.233871, 55.265624], [25.233883, 55.265732], [25.233999, 55.265716], [25.234061, 55.265708], [25.234054, 55.265647], [25.234189, 55.265629], [25.234162, 55.265390], [25.234132, 55.265394], [25.234128, 55.265363], [25.234039, 55.265376], [25.234032, 55.265332]],
    height: 38,
    build: buildJumeirahMosque,
  },
  {
    id: "sz_mosque",
    name: "Sheikh Zayed Grand Mosque",
    lat: 24.412406, lon: 54.474964,
    headingDeg: 0,
    suppress: [[24.411436, 54.474239], [24.411417, 54.474243], [24.411438, 54.474348], [24.411445, 54.474384], [24.411453, 54.474423], [24.411468, 54.474497], [24.411487, 54.474492], [24.411489, 54.474500], [24.411557, 54.474836], [24.411562, 54.474864], [24.411568, 54.474891], [24.411638, 54.475242], [24.411644, 54.475271], [24.411649, 54.475298], [24.411719, 54.475647], [24.411724, 54.475672], [24.411730, 54.475697], [24.411794, 54.476015], [24.411782, 54.476018], [24.411797, 54.476095], [24.411800, 54.476109], [24.411803, 54.476125], [24.411812, 54.476167], [24.411820, 54.476206], [24.411836, 54.476291], [24.411910, 54.476274], [24.411946, 54.476265], [24.411984, 54.476255], [24.412000, 54.476251], [24.412010, 54.476249], [24.412074, 54.476234], [24.412062, 54.476175], [24.412414, 54.476089], [24.412426, 54.476145], [24.412478, 54.476132], [24.412660, 54.476088], [24.412825, 54.476047], [24.412873, 54.476036], [24.412862, 54.475980], [24.413228, 54.475891], [24.413240, 54.475949], [24.413294, 54.475936], [24.413306, 54.475933], [24.413320, 54.475930], [24.413357, 54.475921], [24.413392, 54.475913], [24.413478, 54.475891], [24.413462, 54.475807], [24.413454, 54.475768], [24.413443, 54.475716], [24.413424, 54.475622], [24.413354, 54.475640], [24.413290, 54.475324], [24.413285, 54.475299], [24.413280, 54.475274], [24.413210, 54.474924], [24.413204, 54.474895], [24.413198, 54.474867], [24.413128, 54.474518], [24.413123, 54.474491], [24.413116, 54.474457], [24.413050, 54.474132], [24.413049, 54.474125], [24.413120, 54.474106], [24.413104, 54.474029], [24.413095, 54.473989], [24.413087, 54.473950], [24.413067, 54.473852], [24.412996, 54.473869], [24.412961, 54.473695], [24.412543, 54.473796], [24.412540, 54.473779], [24.412460, 54.473799], [24.412312, 54.473835], [24.412289, 54.473721], [24.412205, 54.473741], [24.412169, 54.473717], [24.412144, 54.473758], [24.412051, 54.473780], [24.412073, 54.473893], [24.411937, 54.473925], [24.411851, 54.473947], [24.411855, 54.473964], [24.411403, 54.474074]],
    height: 107,
    build: buildSZGM,
  },
  {
    id: "etihad",
    name: "Etihad Towers",
    lat: 24.458880, lon: 54.321758,
    headingDeg: 0,
    suppress: [[24.459357, 54.320950], [24.458673, 54.321063], [24.457992, 54.321355], [24.457917, 54.321516], [24.457873, 54.321637], [24.457859, 54.321809], [24.457877, 54.321937], [24.457903, 54.322037], [24.457966, 54.322171], [24.458018, 54.322251], [24.458124, 54.322353], [24.458211, 54.322411], [24.458347, 54.322467], [24.458447, 54.322482], [24.458527, 54.322483], [24.458734, 54.322477], [24.458873, 54.322440], [24.459715, 54.322101], [24.459704, 54.321912], [24.459612, 54.321152]],
    height: 305,
    build: buildEtihad,
  },
  {
    id: "capital_gate",
    name: "Capital Gate",
    lat: 24.418699, lon: 54.434692,
    headingDeg: 0,
    suppress: [[24.418630, 54.434324], [24.418557, 54.434341], [24.418515, 54.434364], [24.418478, 54.434395], [24.418445, 54.434435], [24.418421, 54.434480], [24.418404, 54.434531], [24.418397, 54.434585], [24.418407, 54.434675], [24.418581, 54.435246], [24.418902, 54.435347], [24.418982, 54.435061], [24.418996, 54.434784], [24.418986, 54.434725], [24.418966, 54.434674], [24.418893, 54.434512], [24.418840, 54.434427], [24.418775, 54.434362], [24.418700, 54.434330]],
    height: 160,
    build: buildCapitalGate,
  },
  {
    id: "aldar",
    name: "Aldar HQ",
    lat: 24.441420, lon: 54.575328,
    headingDeg: 69.4,
    suppress: [[24.440785, 54.575508], [24.440788, 54.575539], [24.440824, 54.575627], [24.440837, 54.575644], [24.440857, 54.575655], [24.440879, 54.575656], [24.441100, 54.575638], [24.441553, 54.575522], [24.441672, 54.575465], [24.441858, 54.575354], [24.442027, 54.575159], [24.442035, 54.575145], [24.442042, 54.575126], [24.442040, 54.575106], [24.442037, 54.575091], [24.442013, 54.575015], [24.441961, 54.574988], [24.441858, 54.575002], [24.441711, 54.575012], [24.441576, 54.575050], [24.441420, 54.575102], [24.441261, 54.575174], [24.441174, 54.575209], [24.441053, 54.575261], [24.441006, 54.575289], [24.440959, 54.575324], [24.440808, 54.575454], [24.440792, 54.575474]],
    height: 110,
    build: buildAldar,
  },
  {
    id: "emirates_palace",
    name: "Emirates Palace",
    lat: 24.462060, lon: 54.317159,
    headingDeg: 0,
    suppress: [[24.461994, 54.314732], [24.461918, 54.314596], [24.461886, 54.314617], [24.461813, 54.314479], [24.461844, 54.314456], [24.461767, 54.314315], [24.461586, 54.314442], [24.461612, 54.314491], [24.461512, 54.314559], [24.461539, 54.314612], [24.461072, 54.314898], [24.461116, 54.314985], [24.460927, 54.315101], [24.461189, 54.315618], [24.460919, 54.315786], [24.460966, 54.315875], [24.460629, 54.316093], [24.461065, 54.316903], [24.461069, 54.317026], [24.461242, 54.317340], [24.461295, 54.317440], [24.461412, 54.317659], [24.461470, 54.317765], [24.461630, 54.318066], [24.461681, 54.318158], [24.461731, 54.318175], [24.461793, 54.318195], [24.461896, 54.318375], [24.462290, 54.319082], [24.462842, 54.318711], [24.463181, 54.319321], [24.463381, 54.319186], [24.463410, 54.319238], [24.463864, 54.318933], [24.463843, 54.318895], [24.463900, 54.318857], [24.463927, 54.318879], [24.463958, 54.318859], [24.463979, 54.318896], [24.464130, 54.318796], [24.463893, 54.318367], [24.463756, 54.318458], [24.463761, 54.318491], [24.463713, 54.318522], [24.463732, 54.318557], [24.463659, 54.318604], [24.463629, 54.318549], [24.463290, 54.318771], [24.463169, 54.318548], [24.463168, 54.318515], [24.463061, 54.318328], [24.463021, 54.318334], [24.462954, 54.318206], [24.462932, 54.318213], [24.462824, 54.318018], [24.462957, 54.317929], [24.462879, 54.317788], [24.462738, 54.317882], [24.462601, 54.317635], [24.462958, 54.317394], [24.463032, 54.317524], [24.463207, 54.317403], [24.463109, 54.317232], [24.463062, 54.317264], [24.462864, 54.316917], [24.462665, 54.317054], [24.462650, 54.317028], [24.462419, 54.316606], [24.462617, 54.316475], [24.462428, 54.316131], [24.462484, 54.316094], [24.462385, 54.315913], [24.462269, 54.315989], [24.462202, 54.316032], [24.462220, 54.316066], [24.461986, 54.316215], [24.462009, 54.316258], [24.461901, 54.316326], [24.461810, 54.316152], [24.461951, 54.316063], [24.461864, 54.315898], [24.461726, 54.315985], [24.461608, 54.315760], [24.461727, 54.315685], [24.461587, 54.315418], [24.461560, 54.315435], [24.461386, 54.315122], [24.461733, 54.314888], [24.461708, 54.314842], [24.461782, 54.314796], [24.461813, 54.314855], [24.461887, 54.314806]],
    height: 81,
    build: buildEmiratesPalace,
  },
  {
    id: "louvre",
    name: "Louvre Abu Dhabi",
    lat: 24.533776, lon: 54.398445,
    headingDeg: 0,
    suppress: [[24.534701, 54.398216], [24.535036, 54.397937], [24.534985, 54.397852], [24.534738, 54.398050], [24.534462, 54.397626], [24.534300, 54.397758], [24.534107, 54.397474], [24.533993, 54.397568], [24.533902, 54.397554], [24.533622, 54.397203], [24.533461, 54.397357], [24.533355, 54.397225], [24.532919, 54.397636], [24.533021, 54.397774], [24.532825, 54.397927], [24.532905, 54.398048], [24.532904, 54.398048], [24.532817, 54.397934], [24.532671, 54.398042], [24.532732, 54.398136], [24.532688, 54.398170], [24.532657, 54.398142], [24.532474, 54.398290], [24.532414, 54.398204], [24.532359, 54.398251], [24.532506, 54.398468], [24.532494, 54.398478], [24.532445, 54.398406], [24.532314, 54.398514], [24.532420, 54.398670], [24.532429, 54.398663], [24.532385, 54.398600], [24.532306, 54.398665], [24.532388, 54.398785], [24.532525, 54.398670], [24.532540, 54.398693], [24.532502, 54.398724], [24.532539, 54.398765], [24.532555, 54.398750], [24.532545, 54.398738], [24.532368, 54.398911], [24.532527, 54.399110], [24.532545, 54.399093], [24.532561, 54.399113], [24.532543, 54.399130], [24.532781, 54.399425], [24.532866, 54.399349], [24.532820, 54.399286], [24.532830, 54.399277], [24.532738, 54.399159], [24.532747, 54.399151], [24.532799, 54.399223], [24.533004, 54.399033], [24.533081, 54.399130], [24.533084, 54.399127], [24.533050, 54.399083], [24.532966, 54.399163], [24.532935, 54.399124], [24.532854, 54.399201], [24.532927, 54.399295], [24.532991, 54.399234], [24.533040, 54.399296], [24.533124, 54.399216], [24.533128, 54.399221], [24.533038, 54.399308], [24.533153, 54.399483], [24.533165, 54.399472], [24.533160, 54.399466], [24.533138, 54.399486], [24.533151, 54.399504], [24.533147, 54.399508], [24.533123, 54.399476], [24.533026, 54.399569], [24.533046, 54.399593], [24.532977, 54.399662], [24.532930, 54.399612], [24.532852, 54.399683], [24.533002, 54.399875], [24.533051, 54.399829], [24.533086, 54.399795], [24.533126, 54.399757], [24.533240, 54.399925], [24.533281, 54.399878], [24.533302, 54.399895], [24.533341, 54.399942], [24.533348, 54.399951], [24.533315, 54.399984], [24.533412, 54.400101], [24.533484, 54.400141], [24.533492, 54.400133], [24.533540, 54.400185], [24.533672, 54.400064], [24.533613, 54.399998], [24.533760, 54.399854], [24.533808, 54.399916], [24.533913, 54.399816], [24.533745, 54.399617], [24.533787, 54.399586], [24.533797, 54.399602], [24.533947, 54.399490], [24.533968, 54.399523], [24.534065, 54.399451], [24.534046, 54.399421], [24.534254, 54.399266], [24.534381, 54.399466], [24.534453, 54.399415], [24.534560, 54.399592], [24.534710, 54.399469], [24.534775, 54.399418], [24.534586, 54.399129], [24.534654, 54.399076], [24.534653, 54.399077], [24.534729, 54.399194], [24.534775, 54.399158], [24.534863, 54.399085], [24.534710, 54.398860], [24.534642, 54.398915], [24.534572, 54.398807], [24.534964, 54.398431], [24.534807, 54.398227], [24.534750, 54.398275]],
    height: 40,
    build: buildLouvre,
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
