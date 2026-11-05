// Hand-built procedural models of Shanghai landmarks for shanghai.html: the Lujiazui towers (Shanghai Tower,
// Shanghai World Financial Center, Jin Mao Tower, Oriental Pearl Tower) and the NYU Shanghai campus at Qiantan.
// Same format and conventions as LANDMARKS2 in landmarks2.js, whose geometry and texture kit this module uses:
// metres, Y up, X east, north is -Z; build() returns a Group centred on the entry's lat/lon at ground level;
// the engine applies rotation.y = -headingDeg. Footprints, heights and zone levels are from OpenStreetMap
// (Overpass, 5 Nov 2026): ways 165792123 + the 1573412411.. zone parts (Shanghai Tower), 10691100 and the
// 279942892.. crown parts (SWFC), 188377486 / 376016310 / 376075961 (Jin Mao), 1164785875 (NYU Shanghai,
// 567 West Yangsi Road, 9 storeys round a courtyard).

import { KIT } from "./landmarks2.js";

const {
  THREE, DEG, TAU, V3, mulberry32, Kit, prism, capXZ, loftRings, loft2, addWallsBy, ccw, clipAxis, cyl, lathe,
  strut, sphereGeom, canvasTex, facadeSet, facadeMat, std, ORM, litColor,
} = KIT;

// OSM local metres (x east, y north) -> canonical [x, z] for a model turned by hDeg (clockwise from north).
function osm2c(xE, yN, hDeg = 0) {
  const t = hDeg * DEG, c = Math.cos(t), s = Math.sin(t), zw = -yN;
  return [xE * c + zw * s, -xE * s + zw * c];
}
const osmPoly = (pts, h = 0, dx = 0, dy = 0) => pts.map(([x, y]) => osm2c(x - dx, y - dy, h));
// A point at a compass bearing (degrees clockwise from north) and radius, in the canonical frame.
const atBearing = (b, r) => [r * Math.sin(b * DEG), -r * Math.cos(b * DEG)];
const lerpTable = (T, y) => {
  if (y <= T[0][0]) return T[0][1];
  for (let i = 1; i < T.length; i++) if (y <= T[i][0]) { const [y0, a] = T[i - 1], [y1, b] = T[i]; return a + (b - a) * (y - y0) / (y1 - y0); }
  return T[T.length - 1][1];
};
const ringV3 = (pts, y) => pts.map(([x, z]) => V3(x, y, z));

// ================================================================================================
// 1. SHANGHAI TOWER (632 m, 128 floors)
// A rounded triangle in plan that twists 120 degrees anticlockwise and tapers as it rises, with a V notch
// running up one corner. Plan areas follow the OSM zone parts (about 6,500 m2 at the foot, 4,400 m2 at
// 180 m, 1,800 m2 at 587 m). Nine sky-lobby belts mark the zones; the crown rises in a sloping screen to
// 632 m over the notch.
// ================================================================================================
function buildShanghaiTower() {
  const K = new Kit();
  const set = facadeSet("sht-glass", (ctx, W, H, mode, rnd) => {
    const rows = 4, cols = 6, rh = H / rows, cw = W / cols;
    ctx.fillStyle = mode === "map" ? "#c8d5dc" : mode === "orm" ? ORM(0.4, 0.8) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * cw + 1, y = r * rh + rh * 0.08, w = cw - 2, h = rh * 0.9;
      if (mode === "map") { const v = 0.94 + rnd() * 0.1; ctx.fillStyle = `rgb(${118 * v | 0},${146 * v | 0},${164 * v | 0})`; }
      else if (mode === "orm") ctx.fillStyle = ORM(0.05, 0.8);
      else ctx.fillStyle = rnd() < 0.22 ? litColor(rnd, 0.35) : "#000";
      ctx.fillRect(x, y, w, h);
    }
  });
  const glass = facadeMat(K, "sht_glass", set, 0.5);
  const crownMat = facadeMat(K, "sht_crown", set, 0.4, { side: THREE.DoubleSide });
  const belt = K.nightMat(std("sht_belt", { color: 0xd9e0e4, roughness: 0.45, metalness: 0.6, emissive: 0xdfeeff }), 0, 0.55);
  const roof = std("sht_roof", { color: 0x8d969b, roughness: 0.7, metalness: 0.3 });

  const A = [[0, 6400], [90, 5500], [180, 4450], [270, 3500], [360, 3100], [450, 2700], [540, 2250], [590, 1850], [640, 1650]];
  const a3 = 0.2, N = 120, TOP = 590;
  const cornerAt = (y) => 22 - 120 * Math.min(1, y / 632);
  const ring = (y, off = 0) => {
    const b0 = cornerAt(y), R = Math.sqrt(lerpTable(A, y) / (Math.PI * (1 + a3 * a3 / 2)));
    const pts = [];
    for (let i = 0; i < N; i++) {
      const b = -(i / N) * 360, d = b - b0;
      const dn = ((d % 360) + 540) % 360 - 180;
      const r = R * (1 + a3 * Math.cos(3 * d * DEG)) - R * 0.1 * Math.max(0, 1 - Math.abs(dn) / 6) + off;
      pts.push(atBearing(b, r));
    }
    return pts;
  };
  const rings = [];
  for (let y = 0; y < TOP; y += 7) rings.push(ringV3(ring(y), y));
  rings.push(ringV3(ring(TOP), TOP));
  const SU = 1 / 27, SV = 1 / (4 * 4.9);
  K.add(glass, loftRings(rings, { su: SU, sv: SV, vFromY: true }));
  K.add(roof, capXZ(ring(TOP - 0.5), TOP - 0.5, true));
  // crown: the skin carries on above the roof as a screen, rising from 596 m to 632 m over the notch
  const bn = cornerAt(632), top = ring(TOP);
  const lifted = top.map(([x, z]) => {
    const b = Math.atan2(x, -z) / DEG;
    return V3(x, 596 + 36 * (0.5 + 0.5 * Math.cos((b - bn) * DEG)), z);
  });
  loft2(K, ringV3(top, TOP), lifted, () => crownMat, { su: SU, sv: SV });
  // sky-lobby belts at the zone breaks (OSM zone parts start at 180, 270, 360, 405, 450, 495, 540, 565 m)
  for (const y of [90, 180, 270, 360, 405, 450, 495, 540, 565]) {
    K.add(belt, loftRings([ringV3(ring(y, 0.45), y), ringV3(ring(y + 2.6, 0.45), y + 2.6)], { su: 1 / 8, sv: 1 / 8 }));
  }
  return K.group("shanghai_tower");
}

// ================================================================================================
// 2. SHANGHAI WORLD FINANCIAL CENTER (492 m, 101 floors)
// A square prism (about 58 m a side, OSM w10691100, turned 5 degrees) cut by two curved planes that meet
// along the south-west to north-east diagonal at the top, leaving the trapezoid aperture (the "bottle
// opener") through the crown between 446 and 478 m. Podium: OSM w165591946, 5 storeys.
// ================================================================================================
function buildSWFC() {
  const K = new Kit();
  const set = facadeSet("swfc-glass", (ctx, W, H, mode, rnd) => {
    const rows = 4, cols = 6, rh = H / rows, cw = W / cols;
    ctx.fillStyle = mode === "map" ? "#cfd6da" : mode === "orm" ? ORM(0.35, 0.9) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * cw + 2, y = r * rh + rh * 0.14, w = cw - 4, h = rh * 0.82;
      if (mode === "map") { const v = 0.93 + rnd() * 0.1; ctx.fillStyle = `rgb(${96 * v | 0},${122 * v | 0},${140 * v | 0})`; }
      else if (mode === "orm") ctx.fillStyle = ORM(0.05, 0.75);
      else ctx.fillStyle = rnd() < 0.25 ? litColor(rnd, 0.4) : "#000";
      ctx.fillRect(x, y, w, h);
    }
  });
  const glass = facadeMat(K, "swfc_glass", set, 0.55);
  const steel = K.nightMat(std("swfc_steel", { color: 0xc3cacf, roughness: 0.35, metalness: 0.9, emissive: 0xcfe2ff }), 0, 0.5);
  const podium = K.nightMat(std("swfc_podium", { color: 0x9aa6ad, roughness: 0.5, metalness: 0.4, emissive: 0xffd9a8 }), 0, 0.25);
  const S = 29, D = Math.SQRT2, TOPY = 492;
  const w = (y) => 8.5 + (S * D - 8.5) * (1 - Math.pow(Math.min(1, y / TOPY), 1.45));
  const plan = (y) => {
    const c = Math.min(S, w(y) * D - S);
    return ccw([[S, -S], [S, c], [c, S], [-S, S], [-S, -c], [-c, -S]]);
  };
  const SU = 1 / 24, SV = 1 / (4 * 4.2);
  const lo = (ys, fn) => { for (let i = 0; i + 1 < ys.length; i++) loft2(K, ringV3(fn(ys[i]), ys[i]), ringV3(fn(ys[i + 1]), ys[i + 1]), () => glass, { su: SU, sv: SV }); };
  const ys = []; for (let y = 0; y < 446; y += 6) ys.push(y); ys.push(446);
  lo(ys, plan);
  // the aperture: two legs either side of the opening, which widens from 38 m to 50 m
  const dl = [Math.SQRT1_2, -Math.SQRT1_2];              // along the long (south-west to north-east) diagonal
  const hw = (y) => 19 + 6 * (y - 446) / 32;
  const legYs = [446, 454, 462, 470, 478];
  for (const side of [1, -1]) {
    const leg = (y) => side > 0 ? clipAxis(plan(y), dl, hw(y), 1e3) : clipAxis(plan(y), dl, -1e3, -hw(y));
    const n0 = leg(446).length;
    if (legYs.every((y) => leg(y).length === n0)) lo(legYs, leg);
    else K.add(glass, prism(leg(446), 446, 478, { su: SU, sv: SV, top: false }));
  }
  K.add(steel, capXZ(plan(446), 446, true));
  K.add(steel, capXZ(plan(478), 478, false));
  lo([478, 485, 492], plan);
  K.add(steel, capXZ(plan(492), 492, true));
  // steel frame round the aperture
  for (const side of [1, -1]) {
    const y0 = 446, y1 = 478, n = [-Math.SQRT1_2, -Math.SQRT1_2];
    for (const k of [-1, 1]) {
      const off = k * (w(462) + 0.4);
      const a = V3(side * hw(y0) * dl[0] + off * n[0], y0, side * hw(y0) * dl[1] + off * n[1]);
      const b = V3(side * hw(y1) * dl[0] + off * n[0], y1, side * hw(y1) * dl[1] + off * n[1]);
      K.add(steel, strut(a, b, 0.7, 0.7, 6));
    }
  }
  // podium
  K.add(podium, prism(osmPoly(SWFC_PODIUM, -5, 2.5, 0), 0, 24, { su: 1 / 8, sv: 1 / 6 }));
  return K.group("swfc");
}
const SWFC_PODIUM = [[-5.88, 74.11], [3.29, 71.13], [24.42, 64.03], [32.04, 61.48], [34.36, 60.69], [36.47, 59.99], [46.12, 56.77], [51.42, 55.01], [65.96, 50.16], [76.88, 46.52], [77.39, 33.33], [81.68, 33.54], [81.68, 27.95], [71.47, 27.44], [75.86, -77.24], [84.8, -89.65], [87.04, -89.96], [87.09, -100.57], [83.22, -100.87], [71.73, -104.67], [69.42, -97.06], [50.79, -100.61], [-3.29, -117.3], [-5.12, -123.18], [-3.29, -127.96], [-22.48, -133.84], [-24.99, -131.76], [-14.31, -128.25], [-8.69, -103.41], [-15.79, -105.12], [-9.97, -75.51], [-10.74, -58.01], [-12.81, -31.03], [35.08, -26.81], [29.79, 32.53], [-16.96, 28.43], [-17.89, 41.4], [-40.3, 74.67], [-37.75, 78.22], [-12.53, 45.2], [-5.38, 48.75], [-8.08, 58.92], [-10.18, 66.81]];

// ================================================================================================
// 3. JIN MAO TOWER (420.5 m, 88 floors)
// A square plan with a projecting bay on each face (OSM w188377486, 54 m across), rising in setbacks that
// get shorter as they climb (each segment about seven-eighths of the one below), every step marked by a
// flared metal lip, then a stepped octagonal crown (348-382 m, w376016310) and the spire to 420.5 m.
// Silver aluminium lattice over dark glass. Entrance wings from w376075961.
// ================================================================================================
function jinMaoPlan(s) {
  const k = s / 27, bw = 9.4 * k, bp = 3.7 * k;
  const side = [[s, -s], [bw, -s], [bw, -s - bp], [-bw, -s - bp], [-bw, -s]];
  const out = [];
  for (let q = 0; q < 4; q++) for (let [x, z] of side) { for (let r = 0; r < q; r++) [x, z] = [z, -x]; out.push([x, z]); }
  return ccw(out);
}
function octagon(r) { const out = []; for (let i = 0; i < 8; i++) out.push(atBearing(-i * 45 - 22.5, r)); return ccw(out); }
function buildJinMao() {
  const K = new Kit();
  const set = facadeSet("jinmao", (ctx, W, H, mode, rnd) => {
    const rows = 4, cols = 8, rh = H / rows, cw = W / cols;
    ctx.fillStyle = mode === "map" ? "#d4d8da" : mode === "orm" ? ORM(0.3, 0.95) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * cw + cw * 0.18, y = r * rh + rh * 0.16, w = cw * 0.64, h = rh * 0.74;
      if (mode === "map") { const v = 0.9 + rnd() * 0.14; ctx.fillStyle = `rgb(${46 * v | 0},${60 * v | 0},${70 * v | 0})`; }
      else if (mode === "orm") ctx.fillStyle = ORM(0.06, 0.7);
      else ctx.fillStyle = rnd() < 0.3 ? litColor(rnd, 0.8) : "#000";
      ctx.fillRect(x, y, w, h);
    }
    if (mode === "map") { ctx.fillStyle = "#eef1f2"; for (let c = 0; c < cols; c++) ctx.fillRect(c * cw + cw * 0.47, 0, cw * 0.06, H); }
  });
  const glass = facadeMat(K, "jinmao_glass", set, 0.6);
  const metal = K.nightMat(std("jinmao_metal", { color: 0xd6dadc, roughness: 0.3, metalness: 0.95, emissive: 0xffd28a }), 0, 0.6);
  const crown = K.nightMat(std("jinmao_crown", { color: 0xcfd3d5, roughness: 0.3, metalness: 0.9, emissive: 0xffc870 }), 0, 1.4);
  const stone = K.nightMat(std("jinmao_stone", { color: 0x8f969a, roughness: 0.6, metalness: 0.3, emissive: 0xffdcae }), 0, 0.3);
  const SU = 1 / 12, SV = 1 / 16;
  // body segments: heights shrink by 0.87 per step, half-width 28.5 m at the foot to 20.5 m at 348 m
  const hs = []; let y = 0, h = 62;
  while (y + h < 330) { hs.push(h); y += h; h *= 0.87; }
  hs.push(348 - y);
  const s0 = 28.5, s1 = 20.5, n = hs.length;
  y = 0;
  for (let k = 0; k < n; k++) {
    const s = s0 * Math.pow(s1 / s0, k / (n - 1)), sTop = s * 0.985, yt = y + hs[k];
    loft2(K, ringV3(jinMaoPlan(s), y), ringV3(jinMaoPlan(sTop), yt - 1.6), () => glass, { su: SU, sv: SV });
    K.add(metal, prism(jinMaoPlan(sTop + 0.9), yt - 1.6, yt, { su: 1 / 8, sv: 1 / 8, bottom: true }));
    y = yt;
  }
  // stepped octagonal crown and spire
  const tiers = [[348, 356, 20], [356, 363, 17], [363, 369, 14], [369, 375, 11], [375, 382, 8]];
  for (const [a, b, r] of tiers) {
    K.add(crown, prism(octagon(r), a, b - 1.2, { su: 1 / 6, sv: 1 / 6 }));
    K.add(metal, prism(octagon(r + 1.1), b - 1.2, b, { su: 1 / 8, sv: 1 / 8, bottom: true }));
  }
  for (const [x, z] of octagon(18.5)) K.add(metal, cyl(0.05, 0.9, 6, x, 356, z, 6));
  K.add(metal, cyl(0.25, 2.8, 420.5 - 382, 0, 382, 0, 10));
  // entrance wings (OSM w376075961 less the tower) at 12 m
  K.add(stone, prism(osmPoly(JINMAO_BASE, 0, 0, 0), 0, 12, { su: 1 / 8, sv: 1 / 6 }));
  return K.group("jin_mao");
}
const JINMAO_BASE = [[-30.96, 8.87], [-27.15, 8.88], [-27.19, 26.97], [-8.63, 27.03], [-8.64, 30.92], [-8.7, 47.0], [9.32, 47.04], [9.38, 30.96], [9.38, 27.03], [26.88, 27.08], [26.93, 8.98], [29.9, 8.99], [46.54, 9.05], [46.59, -9.03], [29.94, -9.09], [26.94, -9.1], [26.98, -26.8], [9.45, -26.86], [9.46, -30.75], [9.52, -47.21], [-8.7, -47.27], [-8.76, -26.86], [-27.1, -26.91], [-27.15, -9.27], [-30.91, -9.29], [-42.37, -9.32], [-42.42, 8.84]];

// ================================================================================================
// 4. ORIENTAL PEARL TOWER (468 m)
// Three 9 m concrete columns braced by three raking legs, the 50 m lower sphere (68-118 m), five small
// spheres between, the 45 m upper sphere (250-295 m), the space module (about 342 m) and the mast.
// Pink-magenta glass spheres that glow at night.
// ================================================================================================
function buildPearlTower() {
  const K = new Kit();
  const ballTex = canvasTex("pearl-ball", 256, (ctx, W, H) => {
    ctx.fillStyle = "#b8336f"; ctx.fillRect(0, 0, W, H);
    const r = mulberry32(3), n = 16;
    for (let i = 0; i < n; i++) for (let j = 0; j < n / 2; j++) {
      const x = (i + 0.5) * W / n, y = (j + 0.5) * H / (n / 2), v = 0.85 + r() * 0.3;
      ctx.fillStyle = `rgb(${228 * v | 0},${86 * v | 0},${150 * v | 0})`;
      ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 7); ctx.lineTo(x - 6, y); ctx.fill();
    }
    ctx.fillStyle = "rgba(240,240,245,0.85)"; for (let j = 0; j <= n / 2; j++) ctx.fillRect(0, j * H / (n / 2) - 1, W, 2);
  });
  const ball = K.nightMat(std("pearl_ball", { color: 0xffffff, map: ballTex, roughness: 0.22, metalness: 0.55, emissive: 0xff4fa8, emissiveMap: ballTex }), 0.02, 1.3);
  const conc = K.nightMat(std("pearl_concrete", { color: 0xe4e2de, roughness: 0.65, metalness: 0.05, emissive: 0xb9c8ff }), 0, 0.25);
  const steel = std("pearl_steel", { color: 0xd0d4d8, roughness: 0.35, metalness: 0.85 });
  const COL = 9.5;                                         // column centres from the axis
  for (let i = 0; i < 3; i++) {
    const [x, z] = atBearing(i * 120, COL);
    K.add(conc, cyl(4.5, 4.5, 290, x, 0, z, 20));
    // raking leg from the ground out at 38 m up to the column at 76 m
    const [gx, gz] = atBearing(i * 120 + 60, 38), [tx, tz] = atBearing(i * 120 + 60, 8);
    K.add(conc, strut(V3(gx, 0, gz), V3(tx, 76, tz), 3.6, 3.0, 14));
  }
  K.add(ball, sphereGeom(25, 0, 93, 0, 40, 26));
  for (const y of [140, 163, 186, 209, 230]) K.add(ball, sphereGeom(6.2, 0, y, 0, 20, 12));
  K.add(ball, sphereGeom(22.5, 0, 272, 0, 40, 26));
  K.add(conc, cyl(4.2, 5.2, 345 - 290, 0, 290, 0, 18));
  K.add(ball, sphereGeom(7.5, 0, 342, 0, 24, 14));
  // observation rings round the spheres
  K.add(steel, lathe([[25.6, -1], [26.4, 0], [26.4, 1.4], [25.6, 2]], 48, 0, 93, 0));
  K.add(steel, lathe([[23.1, -1], [23.9, 0], [23.9, 1.4], [23.1, 2]], 48, 0, 263, 0));
  // mast: tapering steel in three stages with rings
  K.add(steel, cyl(2.4, 3.6, 40, 0, 349, 0, 12));
  K.add(steel, cyl(1.2, 2.2, 45, 0, 389, 0, 10));
  K.add(steel, cyl(0.25, 1.0, 34, 0, 434, 0, 8));
  for (const y of [360, 375, 389, 405, 420, 434]) K.add(steel, cyl(3.4 - (y - 360) / 30, 3.4 - (y - 360) / 30, 1.2, 0, y, 0, 12));
  return K.group("oriental_pearl");
}

// ================================================================================================
// 5. NYU SHANGHAI, QIANTAN CAMPUS (567 West Yangsi Road)
// OSM w1164785875: one building of 9 storeys (about 41 m) wrapped round a central courtyard, 150 by 150 m.
// White vertical fins over glass, a glazed ground floor, a planted roof, and the violet NYU Shanghai name.
// ================================================================================================
const NYU_OUT = [[-61.99, 16.84], [-43.23, -85.64], [-35.86, -86.52], [86.21, -30.03], [72.24, 51.31], [64.93, 50.2], [62.52, 64.49], [-47.95, 44.8], [-43.39, 20.79]];
const NYU_COURT = [[-43.39, 20.79], [30.68, 35.08], [40.61, -21.63], [-21.85, -49.45], [-26.59, -14.35], [-34.69, -15.15], [-41.63, 19.27]];
function buildNYU() {
  const K = new Kit();
  const set = facadeSet("nyu-fins", (ctx, W, H, mode, rnd) => {
    const rows = 4, cols = 8, rh = H / rows, cw = W / cols;
    ctx.fillStyle = mode === "map" ? "#efede8" : mode === "orm" ? ORM(0.6, 0.05) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * cw + cw * 0.2, y = r * rh + rh * 0.12, w = cw * 0.6, h = rh * 0.8;
      if (mode === "map") { const v = 0.92 + rnd() * 0.12; ctx.fillStyle = `rgb(${84 * v | 0},${104 * v | 0},${116 * v | 0})`; }
      else if (mode === "orm") ctx.fillStyle = ORM(0.08, 0.6);
      else ctx.fillStyle = rnd() < 0.5 ? litColor(rnd, 0.6) : "#000";
      ctx.fillRect(x, y, w, h);
    }
  });
  const fins = facadeMat(K, "nyu_facade", set, 1.2);
  const lobbySet = facadeSet("nyu-lobby", (ctx, W, H, mode, rnd) => {
    const cols = 6, cw = W / cols;
    ctx.fillStyle = mode === "map" ? "#e9e6df" : mode === "orm" ? ORM(0.5, 0.1) : "#000"; ctx.fillRect(0, 0, W, H);
    for (let c = 0; c < cols; c++) {
      if (mode === "map") ctx.fillStyle = "#6f8a96"; else if (mode === "orm") ctx.fillStyle = ORM(0.05, 0.5); else ctx.fillStyle = litColor(rnd, 0.9);
      ctx.fillRect(c * cw + 3, H * 0.06, cw - 6, H * 0.94);
    }
  });
  const lobby = facadeMat(K, "nyu_lobby", lobbySet, 1.4, { day: 0.15 });
  const roof = std("nyu_roof", { color: 0x9aa39a, roughness: 0.9, metalness: 0 });
  const green = std("nyu_green", { color: 0x5f8a4e, roughness: 0.95, metalness: 0 });
  const plant = std("nyu_plant", { color: 0xb8bcbd, roughness: 0.6, metalness: 0.4 });
  const out = ccw(osmPoly(NYU_OUT)), court = ccw(osmPoly(NYU_COURT));
  const H1 = 6, H = 41, SU = 1 / 14, SV = 1 / 18;
  addWallsBy(K, out, 0, H1, () => lobby, { su: 1 / 18, sv: 1 / H1 });
  addWallsBy(K, out, H1, H, () => fins, { su: SU, sv: SV });
  K.add(lobby, prism(court, 0, H1, { inward: true, top: false, su: 1 / 18, sv: 1 / H1 }));
  K.add(fins, prism(court, H1, H, { inward: true, top: false, su: SU, sv: SV }));
  K.add(roof, capXZ(out, H, true, 1 / 20, [court]));
  // parapet, roof gardens and plant
  K.add(plant, prism(out, H, H + 1.3, { su: 1 / 8, sv: 1 / 8, top: false }));
  const rnd = mulberry32(11);
  for (const [cx, cz, w, d] of [[-50, 60, 18, 26], [60, -10, 16, 30], [-5, -70, 30, 14], [20, 45, 26, 12]]) {
    K.add(green, prism([[cx - w / 2, cz - d / 2], [cx + w / 2, cz - d / 2], [cx + w / 2, cz + d / 2], [cx - w / 2, cz + d / 2]], H, H + 0.5, {}));
    void rnd;
  }
  K.add(plant, prism([[-8, -78], [8, -78], [8, -66], [-8, -66]], H, H + 4, {}));
  // the violet NYU Shanghai name on two outer faces, lit at night
  const nameTex = canvasTex("nyu-name", 1024, (ctx, W, Hh) => {
    ctx.fillStyle = "#57068c"; ctx.fillRect(0, 0, W, Hh);
    ctx.fillStyle = "#ffffff"; ctx.font = "bold 84px Segoe UI, Arial, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("NYU SHANGHAI", W / 2, Hh / 2 + 4);
  }, { w: 1024, h: 128, repeat: false });
  const nameMat = K.nightMat(std("nyu_name", { color: 0xffffff, map: nameTex, roughness: 0.5, metalness: 0, emissive: 0xffffff, emissiveMap: nameTex }), 0.1, 1.1);
  const C = out.reduce((a, p) => [a[0] + p[0] / out.length, a[1] + p[1] / out.length], [0, 0]);
  for (const [i, j] of [[1, 2], [6, 7], [2, 3]]) {
    const a = osm2c(...NYU_OUT[i]), b = osm2c(...NYU_OUT[j]);
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let nx = -(b[1] - a[1]) / l, nz = (b[0] - a[0]) / l;
    if (nx * (m[0] - C[0]) + nz * (m[1] - C[1]) < 0) { nx = -nx; nz = -nz; }
    const W = Math.min(26, l * 0.6), g = new THREE.PlaneGeometry(W, W / 8);
    g.rotateY(Math.atan2(nx, nz)); g.translate(m[0] + nx * 0.25, H - 4.5, m[1] + nz * 0.25);
    K.add(nameMat, g);
  }
  return K.group("nyu_shanghai");
}

export const LANDMARKS_SH = [
  {
    id: "shanghai_tower", name: "Shanghai Tower",
    lat: 31.2355401, lon: 121.5013276, headingDeg: 0, height: 632,
    suppress: [[31.235499, 121.500727], [31.235432, 121.50076], [31.235346, 121.500802], [31.235324, 121.500872], [31.235259, 121.500846], [31.23522, 121.500972], [31.235189, 121.501156], [31.23519, 121.501324], [31.235199, 121.501398], [31.235213, 121.50147], [31.235243, 121.501603], [31.235273, 121.501674], [31.235303, 121.501745], [31.235345, 121.501785], [31.235399, 121.501806], [31.235443, 121.501796], [31.235488, 121.501787], [31.235525, 121.501763], [31.235578, 121.501729], [31.235688, 121.501659], [31.235824, 121.501572], [31.235936, 121.501469], [31.236012, 121.501397], [31.236049, 121.501331], [31.236032, 121.501262], [31.236016, 121.501236], [31.235984, 121.501184], [31.235886, 121.501047], [31.235698, 121.500858], [31.235612, 121.5008]],
    build: buildShanghaiTower,
  },
  {
    id: "swfc", name: "Shanghai World Financial Center",
    lat: 31.2365748, lon: 121.5030408, headingDeg: -5, height: 492,
    suppress: [[31.236821, 121.502698], [31.236832, 121.502836], [31.236848, 121.503046], [31.23686, 121.50321], [31.236869, 121.503327], [31.236768, 121.503338], [31.236629, 121.503352], [31.236332, 121.503383], [31.236306, 121.503035], [31.236294, 121.50288], [31.236294, 121.502872], [31.236285, 121.502754], [31.236385, 121.502743], [31.236525, 121.502729]],
    build: buildSWFC,
  },
  {
    id: "jin_mao", name: "Jin Mao Tower",
    lat: 31.2372513, lon: 121.5013978, headingDeg: 0, height: 420.5,
    suppress: [[31.237331, 121.501073], [31.237332, 121.501113], [31.237495, 121.501112], [31.237496, 121.501307], [31.237531, 121.501307], [31.237676, 121.501306], [31.237677, 121.501496], [31.237531, 121.501496], [31.237496, 121.501496], [31.237496, 121.50168], [31.237333, 121.501681], [31.237333, 121.501712], [31.237333, 121.501887], [31.23717, 121.501887], [31.237169, 121.501712], [31.237169, 121.501681], [31.237009, 121.501681], [31.237008, 121.501497], [31.236973, 121.501497], [31.236824, 121.501498], [31.236824, 121.501306], [31.237008, 121.501306], [31.237008, 121.501113], [31.237167, 121.501113], [31.237167, 121.501073], [31.237167, 121.500953], [31.237331, 121.500952]],
    build: buildJinMao,
  },
  {
    id: "oriental_pearl", name: "Oriental Pearl Tower",
    lat: 31.2419464, lon: 121.4952604, headingDeg: 0, height: 468,
    suppress: [[31.24229, 121.49526], [31.242244, 121.49546], [31.242118, 121.495606], [31.241946, 121.49566], [31.241775, 121.495606], [31.241649, 121.49546], [31.241603, 121.49526], [31.241649, 121.495061], [31.241775, 121.494915], [31.241946, 121.494861], [31.242118, 121.494915], [31.242244, 121.495061]],
    build: buildPearlTower,
  },
  {
    id: "nyu_shanghai", name: "NYU Shanghai (Qiantan campus)",
    lat: 31.1508289, lon: 121.4769831, headingDeg: 0, height: 42,
    suppress: [[31.150981, 121.476332], [31.150054, 121.476529], [31.150046, 121.476607], [31.150557, 121.477888], [31.151293, 121.477741], [31.151283, 121.477665], [31.151412, 121.477639], [31.151234, 121.47648], [31.151017, 121.476528]],     // outer edge only: the courtyard holds the centroid
    build: buildNYU,
  },
];
