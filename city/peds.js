// Pedestrians on the sidewalks of urban roads: low-poly people (kandura, abaya, casual),
// instanced, walking along the same road graph the traffic uses, offset onto the pavement.
// They step out of the way of the player's car.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { CITY, K } from "./world.js";

const PK = CITY.region === "pakistan";
const RE = 6378137;

function tint(g, hex) { const c = new THREE.Color(hex); const n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[3 * i] = c.r; a[3 * i + 1] = c.g; a[3 * i + 2] = c.b; } g.setAttribute("color", new THREE.BufferAttribute(a, 3)); for (const k of Object.keys(g.attributes)) if (!["position", "normal", "color"].includes(k)) g.deleteAttribute(k); return g.index ? g.toNonIndexed() : g; }

// Three outfits share one skeleton layout: torso/robe (instance colour), head (skin), legs (swing).
function bodyGeometry(long) {
  // long = robe to the ankle (kandura, abaya); short = shirt with trousers below
  const parts = [];
  if (long) { const r = new THREE.CylinderGeometry(0.2, 0.3, 1.38, 8); r.translate(0, 0.72, 0); parts.push(tint(r, "#ffffff")); }
  else { const t = new THREE.CylinderGeometry(0.2, 0.19, 0.62, 8); t.translate(0, 1.12, 0); parts.push(tint(t, "#ffffff")); }
  const sh = new THREE.SphereGeometry(0.21, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2); sh.scale(1.15, 0.5, 0.8); sh.translate(0, 1.42, 0); parts.push(tint(sh, "#ffffff"));
  for (const s of [-1, 1]) { const a = new THREE.CylinderGeometry(0.06, 0.055, 0.6, 5); a.translate(s * 0.26, 1.14, 0); a.rotateZ(s * 0.06); parts.push(tint(a, "#ffffff")); }
  return mergeGeometries(parts);
}
function headGeometry() {
  const h = new THREE.SphereGeometry(0.12, 8, 6); h.scale(0.9, 1.1, 1); h.translate(0, 1.6, 0);
  return tint(h, "#ffffff");
}
function legGeometry() {
  // hip pivot at y = 0.82: a leg hangs down from the origin, rotated around x to swing
  const l = new THREE.CylinderGeometry(0.075, 0.06, 0.82, 5); l.translate(0, -0.41, 0);
  const f = new THREE.BoxGeometry(0.1, 0.06, 0.22); f.translate(0, -0.79, -0.05);
  return mergeGeometries([tint(l, "#ffffff"), tint(f, "#ffffff")]);
}

const OUTFITS = [
  { w: 0.2, long: true, robe: 0xf4f2ec, legs: 0xd9d4c8, head: 0xfbfbf8 },        // kandura + ghutra
  { w: 0.18, long: true, robe: 0x151515, legs: 0x111111, head: 0x1a1a1a },       // abaya + shayla
  { w: 0.62, long: false, robe: null, legs: null, head: null },                  // casual
];
const SHIRTS = [0x2f5d8a, 0xd4d4d4, 0x8a2c2c, 0x3c6e47, 0xe0c28a, 0x222222, 0x6b5b95, 0xf0f0f0, 0x1f3a5f];
const TROUSERS = [0x2b2f3a, 0x3d3a33, 0x1e2a3a, 0x6b6456, 0x222222];
const SKIN = [0x8d5a3b, 0xb07a52, 0xc99474, 0x6e4630, 0xe0b08e];

// ------------------------------------------------------------------ Pakistan
// Shalwar kameez is the national dress for men and women (en.wikipedia.org/wiki/Pakistani_clothing). No survey of
// who wears what on a given street was found, so every weight below is an estimate to tune against photos.
function kameezGeometry() {
  const parts = [];
  const t = new THREE.CylinderGeometry(0.2, 0.29, 0.86, 8); t.translate(0, 1.0, 0); parts.push(tint(t, "#ffffff"));
  const sh = new THREE.SphereGeometry(0.21, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2); sh.scale(1.15, 0.5, 0.8); sh.translate(0, 1.42, 0); parts.push(tint(sh, "#ffffff"));
  for (const s of [-1, 1]) { const a = new THREE.CylinderGeometry(0.065, 0.06, 0.6, 5); a.translate(s * 0.26, 1.14, 0); a.rotateZ(s * 0.06); parts.push(tint(a, "#ffffff")); }
  return mergeGeometries(parts);
}
// a dupatta: round the shoulders, one long panel down the back and a tail down the front (people face -z)
function dupattaGeometry() {
  const c = new THREE.CylinderGeometry(0.22, 0.25, 0.17, 8, 1, true); c.translate(0, 1.4, 0);
  const b = new THREE.BoxGeometry(0.42, 0.66, 0.03); b.translate(0, 1.04, 0.225);
  const f = new THREE.BoxGeometry(0.13, 0.62, 0.03); f.translate(0.12, 1.06, -0.225);
  return mergeGeometries([tint(c, "#ffffff"), tint(b, "#ffffff"), tint(f, "#ffffff")]);
}
// hair, a cap, or the dupatta drawn over the head: the same cap over the crown and back of the head
function hairGeometry() {
  const h = new THREE.SphereGeometry(0.132, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.56); h.scale(0.94, 1.0, 1.04); h.translate(0, 1.615, 0.016);
  return tint(h, "#ffffff");
}
const WIDE = new THREE.Vector3(1.42, 1, 1.42);                   // shalwar: loose trousers
const MEN_SK = [0xe9e6dc, 0xe9e6dc, 0xd8cdb4, 0xd8cdb4, 0x8f9296, 0x9cc3de, 0x7a6248, 0xc9c6bc];
const WOMEN_SK = [0xb83a4b, 0x2f7f7a, 0xd98c2b, 0x7a4a9a, 0x3f66b0, 0xd46a9a, 0x6a9a4a, 0xe3c7a1, 0x9a3b6a, 0xf0d9c8];
const DUPATTA = [0xf3efe6, 0xe9c9d2, 0x2c2c34, 0xd9b44a, 0x8fb6d8, 0xc96a5a, 0x5e8a6e];
// Bazaars are mostly men; the shares are estimates. School colours vary by school: khaki and white for boys, white
// shalwar and a green dupatta for girls follow one district's published list (bhakkar.punjab.gov.pk/node/75).
const MIX = { busy: [0.54, 0.09, 0.23, 0.14], calm: [0.33, 0.29, 0.31, 0.07] };   // men sk, men casual, women sk, burqa
function zoneMul(lat, lon) {
  for (const [a, b, r, m] of DENSE) if (Math.hypot((lat - a) * 111320, (lon - b) * 92700) < r) return m;
  if (lat > 33.76 && lon >= 73.2) return 1.2;                    // the Murree hills
  if (lat > 33.54 && lat < 33.665 && lon > 72.98 && lon < 73.13) return 1.8;   // Rawalpindi
  if (lat >= 33.665 && lat < 33.78 && lon > 72.95 && lon < 73.2) return 0.75;  // Islamabad's sectors
  if (lat > 33.47 && lat <= 33.57 && lon > 73.05 && lon < 73.22) return 0.45;  // Bahria and DHA
  if (lat < 31.75) return 1.5;                                   // Lahore
  return 0.06;                                                   // along the motorway: only the odd villager
}
// [lat, lon, radius m, multiple of Blue Area's crowd] from build/pk/research: Raja Bazaar, Moti Bazaar, Fawara Chowk, Saddar, Mall Plaza, Murree Mall and GPO, then three circles along the Blue Area strip (the baseline)
const DENSE = [[33.7150, 73.0654, 420, 1], [33.7190, 73.0728, 420, 1], [33.7225, 73.0800, 420, 1], [33.612309, 73.056339, 700, 5], [33.613926, 73.058367, 300, 5], [33.61306, 73.05528, 260, 5], [33.596865, 73.05116, 800, 4], [33.594359, 73.050647, 320, 4], [33.90561, 73.39271, 430, 3.5], [33.90694, 73.39424, 200, 3.5]];

export class Peds {
  constructor(scene, traffic) {
    this.traffic = traffic; this.list = []; this.target = 50; this.cap = PK ? 260 : 140; this.mul = 1; this._zT = 0; this.hour = 12;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
    const mk = geo => { const im = new THREE.InstancedMesh(geo, mat, this.cap); im.count = 0; im.castShadow = true; im.frustumCulled = false; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 3).fill(1), 3); scene.add(im); return im; };
    this.robe = mk(bodyGeometry(true)); this.shirt = mk(bodyGeometry(false)); this.head = mk(headGeometry());
    this.legL = mk(legGeometry()); this.legR = mk(legGeometry());
    if (PK) { this.kameez = mk(kameezGeometry()); this.dup = mk(dupattaGeometry()); this.hair = mk(hairGeometry()); this.dup.castShadow = false; this.hair.castShadow = false; }
    this._m = new THREE.Matrix4(); this._m2 = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(1, 1, 1); this._e = new THREE.Euler(); this._c = new THREE.Color();
  }
  ll(x, z) { const G = this.traffic.G0; return [(2 * Math.atan(Math.exp((-z / K + G.my) / RE)) - Math.PI / 2) * 180 / Math.PI, (x / K + G.mx) / RE * 180 / Math.PI]; }
  // Pakistan: how busy this street's pavement is. None beside a motorway.
  lineWeight(L, near) {
    if (L.pedW !== undefined) return L.pedW;
    const mid = (L.n >> 1) * 2, x = L.pts[mid], z = L.pts[mid + 1], [lat, lon] = this.ll(x, z);
    let w = zoneMul(lat, lon);
    for (const M of near) {
      if (M.c !== 0 || !M.bb || w === 0) continue;
      if (x < M.bb[0] - 180 || x > M.bb[2] + 180 || z < M.bb[1] - 180 || z > M.bb[3] + 180) continue;
      for (let i = 0; i < M.n; i++) if (Math.hypot(M.pts[2 * i] - x, M.pts[2 * i + 1] - z) < 180) { w = 0; break; }
    }
    L.pedW = w; return w;
  }
  pickPakistani() {
    const pick = a => a[Math.floor(Math.random() * a.length)];
    const school = this.hour >= 7 && this.hour < 15 && Math.random() < 0.05;
    const skin = pick(SKIN), darkHair = Math.random() < 0.9 ? 0x17130f : 0x8a8780;
    if (school) {
      if (Math.random() < 0.5) return { kind: "shirt", robe: 0xf1efe8, legs: 0xa8956b, head: skin, hair: 0x17130f, sc: 0.76 };
      return { kind: "kameez", robe: 0x8fb6d8, legs: 0xf1efe8, head: skin, hair: 0x2c6e49, dup: 0x2c6e49, wide: true, sc: 0.76 };
    }
    const m = this.mul >= 3 ? MIX.busy : MIX.calm; let r = Math.random();
    if ((r -= m[0]) <= 0) { const c = pick(MEN_SK); return { kind: "kameez", robe: c, legs: c, head: skin, hair: Math.random() < 0.1 ? 0xeeeae0 : darkHair, wide: true }; }
    if ((r -= m[1]) <= 0) return { kind: "shirt", robe: pick(SHIRTS), legs: pick(TROUSERS), head: skin, hair: darkHair };
    if ((r -= m[2]) <= 0) { const c = pick(WOMEN_SK), d = pick(DUPATTA), cover = Math.random() < 0.55; return { kind: "kameez", robe: c, legs: Math.random() < 0.5 ? c : 0xf1efe8, head: skin, hair: cover ? d : 0x17130f, dup: d, wide: true }; }
    return { kind: "robe", robe: 0x151515, legs: 0x111111, head: 0x1a1a1a, hair: 0x151515 };
  }
  spawnPakistani(px, pz) {
    const T = this.traffic, near = T.nearLines(px, pz), cand = [], minD = this.mul >= 3 ? 22 : 40, n0 = Math.floor(Math.random() * near.length);
    for (let q = 0; q < near.length && cand.length < 24; q++) {        // from a random start, or the first lines listed would take everyone
      const L = near[(q + n0) % near.length];
      if (L.c < 2 || L.c > 5 || L.e || L.np) continue;
      const w = this.lineWeight(L, near);
      if (w <= 0 || Math.random() > w / Math.max(1, this.mul)) continue;
      const i = Math.floor(Math.random() * (L.n - 1)), d = Math.hypot(L.pts[2 * i] - px, L.pts[2 * i + 1] - pz);
      if (d > minD && d < 170) cand.push([L, i, d]);
    }
    if (!cand.length) return;
    cand.sort((a, b) => a[2] - b[2]);                                  // the streets you can see get most of them
    const [L, i] = cand[Math.floor(Math.pow(Math.random(), 1.7) * cand.length)], busy = (L.pedW || 0) >= 3, s = L.cum[i] + Math.random() * (L.cum[i + 1] - L.cum[i]), side = L.ow ? 1 : (Math.random() < 0.5 ? 1 : -1);
    const idle = this.list.reduce((n, p) => n + (p.idle ? 1 : 0), 0), roomIdle = idle < this.cap * (busy ? 0.48 : 0.3);
    if (roomIdle && Math.random() < 0.12 && this.spawnVendor(px, pz)) return;
    if (roomIdle && Math.random() < (busy ? 0.55 : 0.22) && this.spawnGroup(L, s, side, busy)) return;
    // walkers: anywhere across the width of the pavement, never out on the road; a third walk as a pair
    const place = 1.25 * Math.random(), v = (busy ? 0.75 : 0.95) + Math.random() * 0.6, dir = Math.random() < 0.5 ? 1 : -1;
    this.addWalker(L, s, dir, side, place, v);
    if (Math.random() < 0.33 && this.list.length < this.cap - 3) this.addWalker(L, s + dir * (Math.random() - 0.5) * 0.7, dir, side, place > 0.62 ? place - 0.6 : place + 0.6, v);
  }
  blockedAt(x, z) {
    const gm = window.GAME, idx = gm && gm.IDX; if (!idx || !idx.ready) return false;
    const [la, lo] = this.ll(x, z); return !!idx.building(la, lo);
  }
  addWalker(L, s, dir, side, place, v) {
    if (s < 0 || s > L.len) return false;
    const T = this.traffic, off = L.w / 2 + 0.35 + place, q = T.posAt(L, s, off * side);
    if (T.roadClear(q.x, q.z) < 0.25 || this.blockedAt(q.x, q.z)) return false;
    const o = this.pickPakistani();
    this.list.push({
      line: L.id, s, dir, side, jit: 0.35 + place - 1.4, wv: 0.08 + Math.random() * 0.12,
      v, phase: Math.random() * 6.28, long: o.kind === "robe", kam: o.kind === "kameez", wide: !!o.wide, sc: o.sc || 1,
      robe: o.robe, legs: o.legs, head: o.head, hair: o.hair, dupC: o.dup ?? null, dodge: 0, x: q.x, z: q.z, hx: 0, hz: 1,
    });
    return true;
  }
  addIdler(L, x, z, face, cart) {
    const o = this.pickPakistani();
    this.list.push({
      idle: true, line: L.id, s: 0, dir: 1, side: 1, ax: x, az: z, face, v: 0, cart: cart || null, phase: Math.random() * 6.28, long: o.kind === "robe", kam: o.kind === "kameez", wide: !!o.wide, sc: o.sc || 1,
      robe: o.robe, legs: o.legs, head: o.head, hair: o.hair, dupC: o.dup ?? null, dodge: 0, x, z, hx: Math.sin(face), hz: Math.cos(face),
    });
  }
  // The first wall out from the road on this side, in metres from the centre line.
  frontage(L, s, side) {
    const gm = window.GAME, idx = gm && gm.IDX; if (!idx || !idx.ready) return null;
    for (let o = L.w / 2 + 0.8; o < L.w / 2 + 11; o += 0.7) { const q = this.traffic.posAt(L, s, o * side), [la, lo] = this.ll(q.x, q.z); if (idx.building(la, lo)) return o; }
    return null;
  }
  // Two to five people loitering together in front of a shop, turned to the window or to one another.
  spawnGroup(L, s, side, busy) {
    const T = this.traffic, f = this.frontage(L, s, side); if (f === null || f < L.w / 2 + 1) return false;
    const c = T.posAt(L, s, (Math.max(L.w / 2 + 0.8, f - 0.9)) * side);
    if (T.roadClear(c.x, c.z) < 0.4) return false;
    for (const p of this.list) if (p.idle && Math.abs(p.x - c.x) < 3 && Math.abs(p.z - c.z) < 3) return false;   // the groups stay apart, not in a row
    const n = 2 + Math.floor(Math.pow(Math.random(), 1.5) * 4), nx = c.uz * side, nz = -c.ux * side;
    const members = [];
    for (let k = 0; k < n; k++) {
      const a = (Math.random() - 0.5) * (1.1 + n * 0.5), b = (Math.random() - 0.5) * 0.9, x = c.x + c.ux * a + nx * b, z = c.z + c.uz * a + nz * b;
      if (T.roadClear(x, z) < 0.3 || this.blockedAt(x, z)) continue;
      members.push([x, z]);
    }
    if (members.length < 2) return false;
    let mx = 0, mz = 0; for (const m of members) { mx += m[0]; mz += m[1]; } mx /= members.length; mz /= members.length;
    for (const [x, z] of members) {
      const toShop = Math.random() < 0.5, fx = toShop ? nx : mx - x, fz = toShop ? nz : mz - z;
      this.addIdler(L, x, z, Math.atan2(fx, fz) + (Math.random() - 0.5) * 0.7);
    }
    return true;
  }
  // The man with the barrow stands at its handles; sometimes a customer beside it.
  spawnVendor(px, pz) {
    const T = this.traffic; let best = null, bd = 150;
    for (const c of T.carts) { const d = Math.hypot(c.x - px, c.z - pz); if (d < bd && d > 18 && !this.list.some(p => p.cart === c)) { bd = d; best = c; } }
    if (!best) return false;
    const L = T.lines.get(best.line); if (!L) return false;
    const x = best.x - best.hx * 1.75, z = best.z - best.hz * 1.75;
    if (T.roadClear(x, z) < 0.1 || this.blockedAt(x, z)) return false;
    this.addIdler(L, x, z, Math.atan2(best.hx, best.hz), best);
    if (Math.random() < 0.6) { const cx = best.x + best.hx * 0.3 + best.hz * 0.95, cz = best.z + best.hz * 0.3 - best.hx * 0.95; if (T.roadClear(cx, cz) > 0.1 && !this.blockedAt(cx, cz)) this.addIdler(L, cx, cz, Math.atan2(best.x - cx, best.z - cz), best); }
    return true;
  }
  spawn(px, pz) {
    if (PK) return this.spawnPakistani(px, pz);
    const T = this.traffic; const cand = [];
    for (const L of T.nearLines(px, pz)) {
      if (L.c < 2 || L.c > 5 || L.e) continue;                // pavements on primary..minor streets, not on flyovers
      const i = Math.floor(Math.random() * (L.n - 1));
      const d = Math.hypot(L.pts[2 * i] - px, L.pts[2 * i + 1] - pz);
      if (d > 40 && d < 170) { cand.push([L, i]); if (cand.length > 12) break; }
    }
    if (!cand.length) return;
    const [L, i] = cand[Math.floor(Math.random() * cand.length)];
    let r = Math.random(), o = OUTFITS[2]; for (const x of OUTFITS) { r -= x.w; if (r <= 0) { o = x; break; } }
    const pick = a => a[Math.floor(Math.random() * a.length)];
    this.list.push({
      // one-way carriageways (half of a dual road) only have a pavement on the outer, right-hand side
      line: L.id, s: L.cum[i] + Math.random() * (L.cum[i + 1] - L.cum[i]), dir: Math.random() < 0.5 ? 1 : -1, side: L.ow ? -1 : (Math.random() < 0.5 ? 1 : -1),
      v: 1.1 + Math.random() * 0.5, phase: Math.random() * 6.28, long: o.long,
      robe: o.robe ?? pick(SHIRTS), legs: o.legs ?? pick(TROUSERS), head: o.head ?? pick(SKIN), dodge: 0, x: 0, z: 0, hx: 0, hz: 1,
    });
  }
  update(dt, player, gx, gz, night) {
    const T = this.traffic; const px = player.x + gx, pz = player.z + gz;
    let want = Math.round(this.target * (1 - 0.6 * night));
    if (PK) {
      const now = performance.now();
      if (now - this._zT > 1000) { this._zT = now; const [la, lo] = this.ll(px, pz); this.mul = zoneMul(la, lo); }
      want = Math.min(this.cap - 2, Math.round(want * this.mul));
    }
    this.list = this.list.filter(p => T.lines.has(p.line) && Math.hypot(p.x - px, p.z - pz) < 230);
    if (this.list.length < want) this.spawn(px, pz);
    if (PK) for (let q = 0; q < 5 && this.list.length < want; q++) this.spawn(px, pz);
    let nr = 0, ns = 0, nk = 0, nd = 0;
    this._t = (this._t || 0) + dt; this._fr = ((this._fr || 0) + 1) & 7;
    let walkN = 0;
    for (const p of this.list) {
      let x, z;
      if (p.idle) {                                                  // standing about: a slow shift of weight, and out of the way of the car
        x = p.ax; z = p.az;
        const cx = x - px, cz = z - pz, cd = Math.hypot(cx, cz);
        if (cd < 5) p.dodge = Math.min(3, p.dodge + dt * 6); else p.dodge = Math.max(0, p.dodge - dt);
        if (p.dodge > 0 && cd > 0.01) { x += cx / cd * p.dodge; z += cz / cd * p.dodge; }
        const f = p.face + Math.sin(this._t * 0.3 + p.phase) * 0.2;
        p.x = x; p.z = z; p.hx = Math.sin(f); p.hz = Math.cos(f);
      } else {
      const L = T.lines.get(p.line);
      p.s += p.v * dt * p.dir;
      if (p.s < 0 || p.s > L.len) { p.dir = -p.dir; p.s = Math.max(0, Math.min(L.len, p.s)); }
      let i = 0; while (i < L.n - 2 && L.cum[i + 1] < p.s) i++;
      const t = (p.s - L.cum[i]) / Math.max(1e-6, L.cum[i + 1] - L.cum[i]);
      let dx = L.pts[2 * i + 2] - L.pts[2 * i], dz = L.pts[2 * i + 3] - L.pts[2 * i + 1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const off = (L.w / 2 + 1.4 + (p.jit || 0) + (p.wv ? Math.sin(p.phase * 0.09) * p.wv : 0)) * p.side;        // on the pavement beside the carriageway
      x = L.pts[2 * i] + dx * l * t + dz * off; z = L.pts[2 * i + 1] + dz * l * t - dx * off;
      // step aside when the player's car comes close
      const cx = x - px, cz = z - pz, cd = Math.hypot(cx, cz);
      if (cd < 5) p.dodge = Math.min(3, p.dodge + dt * 6); else p.dodge = Math.max(0, p.dodge - dt);
      if (p.dodge > 0 && cd > 0.01) { x += cx / cd * p.dodge; z += cz / cd * p.dodge; }
      p.x = x; p.z = z; p.hx = dx * p.dir; p.hz = dz * p.dir;
      if (PK) {                                                      // at the mouth of a side road, turn back rather than walk out into it
        p.turnT = (p.turnT || 0) - dt;
        if (p.turnT <= 0 && ((++walkN + this._fr) & 7) === 0 && p.dodge === 0 && T.roadClear(x, z) < 0.15) { p.dir = -p.dir; p.turnT = 2.5; }
      }
      }
      p.phase += dt * p.v * 5.2;
      const yaw = Math.atan2(-p.hx, -p.hz);
      this._p.set(x - gx, 0.17 + (this.groundAt ? this.groundAt(x - gx, z - gz) : 0), z - gz); this._q.setFromEuler(this._e.set(0, yaw, 0)); this._s.setScalar(p.sc || 1); this._m.compose(this._p, this._q, this._s);
      const body = p.kam ? this.kameez : p.long ? this.robe : this.shirt; const j = p.kam ? nk++ : p.long ? nr++ : ns++;
      body.setMatrixAt(j, this._m); body.setColorAt(j, this._c.set(p.robe));
      const k = nr + ns + nk - 1;
      this.head.setMatrixAt(k, this._m); this.head.setColorAt(k, this._c.set(p.head));
      if (PK) {
        this.hair.setMatrixAt(k, this._m); this.hair.setColorAt(k, this._c.set(p.hair));
        if (p.dupC !== null) { this.dup.setMatrixAt(nd, this._m); this.dup.setColorAt(nd, this._c.set(p.dupC)); nd++; }
      }
      const swing = (p.idle ? Math.sin(this._t * 0.8 + p.phase) * 0.035 : Math.sin(p.phase)) * (p.long ? 0.25 : p.kam ? 0.4 : 0.5);
      for (const [im, sgn, sx] of [[this.legL, 1, -0.1], [this.legR, -1, 0.1]]) {
        this._m2.makeRotationX(swing * sgn); if (p.wide) this._m2.scale(WIDE); this._m2.setPosition(sx, 0.82, 0);
        im.setMatrixAt(k, this._m2.premultiply(this._m)); im.setColorAt(k, this._c.set(p.legs));
      }
    }
    const all = nr + ns + nk;
    for (const [im, n] of [[this.robe, nr], [this.shirt, ns], [this.head, all], [this.legL, all], [this.legR, all], ...(PK ? [[this.kameez, nk], [this.dup, nd], [this.hair, all]] : [])]) { im.count = n; im.visible = n > 0; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }
  }
}
