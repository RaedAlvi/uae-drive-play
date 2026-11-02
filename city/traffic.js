// AI traffic on the real road graph. The idea comes from God's Eye View's traffic layer
// (simulated vehicles flowing along OSM roads at class speeds); here they are 3D cars in
// lanes, keep right, follow the car ahead, overtake slower cars by changing lane, stop at
// red lights, brake for the player, and turn at junctions.
import * as THREE from "three";

const SPEED = [27, 22, 16.5, 14, 12, 9.5, 6.5];           // m/s by road class code 0 motorway .. 6 service
const LANE_W = 3.4;

export class Traffic {
  constructor(scene, types, mats) {
    this.scene = scene; this.types = types; this.mats = mats;
    this.lines = new Map();       // id -> { pts: Float32Array (global coords), c, ow, w, l, tileKey, len, cum }
    this.nodes = new Map();       // nodeKey -> [{ id, end }]
    this.nextId = 1;
    this.cars = [];
    this.target = 60;
    this.meshes = types.map(t => {
      const cap = Math.max(8, Math.ceil(120 * t.weight * 2.2));
      const mk = (geo, mat, colors) => { if (!geo) return null; const im = new THREE.InstancedMesh(geo, mat, cap); im.count = 0; im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); if (colors) im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3); scene.add(im); return im; };
      const r = { cap, paint: mk(t.paint, mats.paint, true), detail: mk(t.detail, mats.detail, false), lights: mk(t.lights, mats.lights, false), used: 0 };
      // only the body casts a shadow (the detail and light meshes add draw calls, not visible shadow)
      if (r.detail) r.detail.castShadow = false; if (r.lights) r.lights.castShadow = false;
      return r;
    });
    this.wsum = types.reduce((s, t) => s + t.weight, 0);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(1, 1, 1); this._e = new THREE.Euler(); this._c = new THREE.Color();
    this.gx = 0; this.gz = 0;          // global-to-world shift (set by the engine each frame)
    this.signals = null; this.t = 0;   // traffic-light controllers (signals.js) and the clock, set by the engine
  }
  // lines from one tile, in tile-local metres; gx0/gz0 = tile's global offset
  addTile(key, lines, gx0, gz0) {
    const ids = [];
    for (const L of lines) {
      const n = L.p.length / 2; if (n < 2) continue;
      const pts = new Float64Array(n * 2); for (let i = 0; i < n; i++) { pts[2 * i] = L.p[2 * i] + gx0; pts[2 * i + 1] = L.p[2 * i + 1] + gz0; }
      const cum = new Float64Array(n); for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
      if (cum[n - 1] < 4) continue;
      const id = this.nextId++;
      const rec = { id, pts, cum, len: cum[n - 1], c: L.c, ow: L.ow, w: L.w, l: L.l, key, n, e: L.e || null, st: L.st || null };
      this.lines.set(id, rec); ids.push(id);
      for (const end of [0, 1]) { const i = end ? n - 1 : 0; const k = nodeKey(pts[2 * i], pts[2 * i + 1]); let a = this.nodes.get(k); if (!a) { a = []; this.nodes.set(k, a); } a.push({ id, end }); }
    }
    return ids;
  }
  dropTile(ids) {
    for (const id of ids || []) {
      const L = this.lines.get(id); if (!L) continue;
      for (const end of [0, 1]) { const i = end ? L.n - 1 : 0; const k = nodeKey(L.pts[2 * i], L.pts[2 * i + 1]); const a = this.nodes.get(k); if (a) { const f = a.filter(e => e.id !== id); if (f.length) this.nodes.set(k, f); else this.nodes.delete(k); } }
      this.lines.delete(id);
    }
    this.cars = this.cars.filter(c => this.lines.has(c.line));
  }
  pickType() { let r = Math.random() * this.wsum; for (let i = 0; i < this.types.length; i++) { r -= this.types[i].weight; if (r <= 0) return i; } return 0; }
  lanesPerDir(L) { return L.ow ? Math.max(1, L.l) : Math.max(1, Math.floor(L.l / 2)); }
  // Lines within 600 m of the player, refreshed every second: spawning (cars and pedestrians)
  // scans this short list instead of every line loaded, which ran to 30,000 on long drives.
  nearLines(px, pz) {
    const now = performance.now();
    if (!this._near || now - this._nearT > 1000 || Math.hypot(px - this._nearX, pz - this._nearZ) > 150) {
      const out = [];
      for (const L of this.lines.values()) {
        if (!L.bb) { let a = 1e12, b = 1e12, c = -1e12, d = -1e12; for (let i = 0; i < L.n; i++) { const x = L.pts[2 * i], z = L.pts[2 * i + 1]; if (x < a) a = x; if (x > c) c = x; if (z < b) b = z; if (z > d) d = z; } L.bb = [a, b, c, d]; }
        const bb = L.bb; const dx = Math.max(bb[0] - px, 0, px - bb[2]), dz = Math.max(bb[1] - pz, 0, pz - bb[3]);
        if (dx * dx + dz * dz < 600 * 600) out.push(L);
      }
      this._near = out; this._nearT = now; this._nearX = px; this._nearZ = pz;
    }
    return this._near;
  }
  spawn(px, pz, hx, hz) {
    // choose a random line near the player (global coords), preferring ahead of them
    const cand = [];
    const near = this.nearLines(px, pz);
    for (let q = 0; q < near.length && cand.length < 60; q++) {
      const L = near[(q * 7919 + Math.floor(Math.random() * near.length)) % near.length];
      if (L.c > 5) continue;
      const i = Math.floor(Math.random() * (L.n - 1));
      const x = L.pts[2 * i], z = L.pts[2 * i + 1];
      const dx = x - px, dz = z - pz, d = Math.hypot(dx, dz);
      if (d < 60 || d > 380) continue;
      const ahead = (dx * hx + dz * hz) / (d || 1);
      cand.push([L, i, ahead + (L.c <= 2 ? 0.6 : 0) + Math.random() * 0.8]);
    }
    if (!cand.length) return false;
    cand.sort((a, b) => b[2] - a[2]);
    const [L, i] = cand[Math.floor(Math.random() * Math.min(6, cand.length))];
    const dir = L.ow ? 1 : (Math.random() < 0.5 ? 1 : -1);
    const s = L.cum[i] + Math.random() * (L.cum[i + 1] - L.cum[i]);
    const lane = Math.floor(Math.random() * this.lanesPerDir(L));
    for (const c of this.cars) if (c.line === L.id && c.dir === dir && Math.abs(c.s - s) < 18) return false;
    const ti = this.pickType(); const T = this.types[ti];
    const col = T.paints[Math.floor(Math.random() * T.paints.length)];
    const car = { line: L.id, s, dir, lane, laneF: lane, v: SPEED[L.c] * (0.75 + Math.random() * 0.3), ti, color: col, x: 0, z: 0, hx: 0, hz: 1, stopT: 0, len: T.length || 4.6, lcT: 2 + Math.random() * 4, keen: 0.85 + Math.random() * 0.3 };
    this.place(car, L);
    this.cars.push(car);
    return true;
  }
  // position on the line at arc length s with lane offset
  place(car, L) {
    let s = Math.max(0, Math.min(L.len - 1e-3, car.s));
    let i = car.seg != null && L.cum[car.seg] <= s && L.cum[car.seg + 1] >= s ? car.seg : 0;
    while (i < L.n - 2 && L.cum[i + 1] < s) i++;
    while (i > 0 && L.cum[i] > s) i--;
    car.seg = i;
    const t = (s - L.cum[i]) / Math.max(1e-6, L.cum[i + 1] - L.cum[i]);
    const ax = L.pts[2 * i], az = L.pts[2 * i + 1], bx = L.pts[2 * i + 2], bz = L.pts[2 * i + 3];
    let dx = (bx - ax), dz = (bz - az); const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const fx = dx * car.dir, fz = dz * car.dir;
    // right-hand traffic: offset to the right of the travel direction
    const rx = -fz, rz = fx;
    const lw = L.w / Math.max(1, L.l);
    let off;
    const lf = car.laneF != null ? car.laneF : car.lane;
    if (L.ow) off = -L.w / 2 + (lf + 0.5) * lw;
    else off = (lf + 0.5) * lw;
    car.x = ax + (bx - ax) * t + rx * off; car.z = az + (bz - az) * t + rz * off;
    car.y = L.e ? L.e[i] + (L.e[i + 1] - L.e[i]) * t : 0;
    // smooth heading
    const k = 0.35; car.hx += (fx - car.hx) * k; car.hz += (fz - car.hz) * k; const hl = Math.hypot(car.hx, car.hz) || 1; car.hx /= hl; car.hz /= hl;
  }
  // turn onto the next line at the node we reached
  // The line a car takes at the end of this one, chosen early so it can slow for the turn.
  pickNext(car, L) {
    const endIdx = car.dir > 0 ? L.n - 1 : 0;
    const k = nodeKey(L.pts[2 * endIdx], L.pts[2 * endIdx + 1]);
    const opts = [];
    const inx = car.hx, inz = car.hz;
    for (const e of this.nodes.get(k) || []) {
      if (e.id === L.id) continue;
      const M = this.lines.get(e.id); if (!M || M.c > 5) continue;
      const dir = e.end === 0 ? 1 : -1;
      if (M.ow && dir < 0) continue;
      const i0 = e.end === 0 ? 0 : M.n - 1, i1 = e.end === 0 ? 1 : M.n - 2;
      let dx = M.pts[2 * i1] - M.pts[2 * i0], dz = M.pts[2 * i1 + 1] - M.pts[2 * i0 + 1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const dot = dx * inx + dz * inz;
      if (dot < -0.3) continue;                                      // no U-turns
      opts.push({ M, dir, dot, score: dot + Math.random() * 0.9 + (M.c <= L.c ? 0.2 : 0) });
    }
    if (!opts.length) return null;
    opts.sort((a, b) => b.score - a.score);
    return opts[0];
  }
  advanceLine(car, L) {
    const nx = car.next && this.lines.has(car.next.M.id) ? car.next : this.pickNext(car, L);
    car.next = null;
    if (!nx) return false;
    const { M, dir } = nx;
    car.line = M.id; car.dir = dir; car.s = dir > 0 ? 0.01 : M.len - 0.01; car.seg = null;
    car.lane = Math.min(car.lane, this.lanesPerDir(M) - 1); car.laneF = Math.min(car.laneF, car.lane + 0.5);
    return true;
  }
  update(dt, player, gx, gz, night) {
    this.gx = gx; this.gz = gz;
    // player in global coords
    const px = player.x + gx, pz = player.z + gz;
    // despawn far cars
    this.cars = this.cars.filter(c => { const d = Math.hypot(c.x - px, c.z - pz); return d < 520 && this.lines.has(c.line); });
    let tries = 6;
    while (this.cars.length < this.target && tries-- > 0) this.spawn(px, pz, player.hx, player.hz);
    // bucket by line for following
    const byLine = new Map();
    for (const c of this.cars) { const k = c.line * 2 + (c.dir > 0 ? 1 : 0); let a = byLine.get(k); if (!a) { a = []; byLine.set(k, a); } a.push(c); }
    for (const a of byLine.values()) a.sort((p, q) => (p.s - q.s) * p.dir);
    let hitCar = null;
    for (const c of this.cars) {
      const L = this.lines.get(c.line); if (!L) continue;
      let want = SPEED[L.c] * (0.85 + ((c.ti * 7919) % 13) / 60) * c.keen;
      const free = want;
      // car ahead on the same line and direction, in (or moving into) the same lane
      const a = byLine.get(c.line * 2 + (c.dir > 0 ? 1 : 0));
      const idx = a.indexOf(c);
      let ahead = null, gapAhead = 1e9;
      for (let j = idx + 1; j < a.length; j++) { const o = a[j]; if (Math.abs(o.laneF - c.laneF) > 0.7) continue; const gap = (o.s - c.s) * c.dir - (c.len + o.len) / 2; ahead = o; gapAhead = gap; if (gap < 30) { want = Math.min(want, Math.max(0, (gap - 4) * 0.9), o.v + gap * 0.2); } break; }
      // traffic lights: stop at the line on amber (if there is room) and red
      if (L.st && this.signals) {
        let best = 1e9, bi = -1;
        for (let k = 0; k < L.st.length; k += 4) { if (L.st[k + 1] !== c.dir) continue; const d = (L.st[k] - c.s) * c.dir - c.len / 2; if (d > -1 && d < best) { best = d; bi = k; } }
        if (bi >= 0 && best < 75) {
          const st = this.signals.stateFor(L.key, L.st[bi + 2], L.st[bi + 3], this.t);
          if (st === 2 || (st === 1 && best > c.v * 1.1)) want = Math.min(want, Math.max(0, (best - 1.2) * 0.55));
        }
      }
      // slow down for a turn at the end of this line (straight on keeps its speed)
      const toEnd = c.dir > 0 ? L.len - c.s : c.s;
      if (toEnd < 40) {
        if (c.next === undefined || c.next === null || c.nextFor !== c.line) { c.next = this.pickNext(c, L); c.nextFor = c.line; }
        if (c.next && c.next.dot < 0.8) { const vt = c.next.dot < 0.2 ? 5.5 : 8.5; want = Math.min(want, vt + toEnd * 0.35); }
      }
      // overtake: a slower car close ahead and a free gap in the next lane over
      c.lcT -= dt;
      const nl = this.lanesPerDir(L);
      if (nl > 1 && ahead && gapAhead < 22 && ahead.v < free - 2.5 && c.lcT <= 0 && Math.abs(c.laneF - c.lane) < 0.05) {
        c.lcT = 3 + Math.random() * 3;
        for (const nlane of [c.lane - 1, c.lane + 1]) {
          if (nlane < 0 || nlane >= nl) continue;
          let clear = true;
          for (const o of a) { if (o === c || Math.abs(o.laneF - nlane) > 0.7) continue; const rel = (o.s - c.s) * c.dir; if (rel > -12 && rel < 20) { clear = false; break; } }
          if (clear) { c.lane = nlane; break; }
        }
      }
      if (c.laneF !== c.lane) { const dl = c.lane - c.laneF; c.laneF = Math.abs(dl) < 0.02 ? c.lane : c.laneF + Math.sign(dl) * Math.min(Math.abs(dl), dt * 0.55); }
      // the player
      const dx = px - c.x, dz = pz - c.z; const along = dx * c.hx + dz * c.hz; const lat = Math.abs(-dx * c.hz + dz * c.hx);
      if (along > 0 && along < 26 && lat < 1.7) want = Math.min(want, Math.max(0, (along - 7) * 0.8));
      if (Math.abs(along) < (c.len / 2 + 2.2) && lat < 1.75) hitCar = c;
      if (c.stopT > 0) { c.stopT -= dt; want = 0; }
      c.v += Math.max(-9 * dt, Math.min(3.2 * dt, want - c.v));
      c.s += c.v * dt * c.dir;
      if (c.s > L.len || c.s < 0) { if (!this.advanceLine(c, L)) { c.dead = true; continue; } }
      const L2 = this.lines.get(c.line); if (L2) this.place(c, L2);
    }
    this.cars = this.cars.filter(c => !c.dead);
    this.render(gx, gz, night);
    return hitCar;
  }
  render(gx, gz, night) {
    for (const m of this.meshes) m.used = 0;
    for (const c of this.cars) {
      const m = this.meshes[c.ti]; if (m.used >= m.cap) continue;
      const j = m.used++;
      this._p.set(c.x - gx, 0.07 + (c.y || 0), c.z - gz);
      this._q.setFromEuler(this._e.set(0, Math.atan2(-c.hx, -c.hz), 0));
      this._m.compose(this._p, this._q, this._s);
      for (const part of [m.paint, m.detail, m.lights]) if (part) part.setMatrixAt(j, this._m);
      if (m.paint) m.paint.setColorAt(j, this._c.set(c.color));
    }
    for (const m of this.meshes) for (const part of [m.paint, m.detail, m.lights]) if (part) { part.count = m.used; part.visible = m.used > 0; part.instanceMatrix.needsUpdate = true; if (part.instanceColor) part.instanceColor.needsUpdate = true; }
    if (this.mats.lights) this.mats.lights.emissiveIntensity = 0.35 + 1.5 * night;
  }
}
function nodeKey(x, z) { return Math.round(x * 2) + "," + Math.round(z * 2); }

// Fallback traffic when vehicles.js is not available: simple two-box cars.
export function fallbackTypes() {
  const body = new THREE.BoxGeometry(1.85, 0.8, 4.5); body.translate(0, 0.65, 0);
  const cab = new THREE.BoxGeometry(1.6, 0.6, 2.2); cab.translate(0, 1.35, 0.2);
  const lights = new THREE.BoxGeometry(1.7, 0.15, 0.05); lights.translate(0, 0.8, -2.26);
  const setC = (g, hex) => { const c = new THREE.Color(hex); const a = new Float32Array(g.attributes.position.count * 3); for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; } g.setAttribute("color", new THREE.BufferAttribute(a, 3)); return g; };
  setC(cab, "#1b2530"); setC(lights, "#fff2c0");
  return [{ name: "box", weight: 1, length: 4.5, width: 1.85, height: 1.6, paint: body, detail: cab, lights, paints: [0xffffff, 0xc0c4c8, 0x2a2d31, 0x8a8f96] }];
}
export function fallbackMaterials() {
  return { paint: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.5 }), detail: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.2 }), lights: new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0.5 }) };
}
