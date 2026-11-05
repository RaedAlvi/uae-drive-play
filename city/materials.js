// Materials for the city: procedural facades, roads with lane markings, sidewalks and
// ground areas, water. All are MeshStandardMaterial with shader patches, so the sun,
// shadows, fog and the sky environment map work as usual.
import * as THREE from "three";

// Shared uniforms the engine updates each frame.
export const U = {
  uNight: { value: 0 },          // 0 day .. 1 full night
  uTime: { value: 0 },
  uLampTint: { value: new THREE.Color(1.0, 0.82, 0.58) },
  uHeadPos: { value: new THREE.Vector3() },   // player's headlight origin (world)
  uHeadDir: { value: new THREE.Vector3(0, 0, -1) },
  uHeadOn: { value: 0 },
  // open cuttings of tunnels near the camera (world x0, z0, x1, z1 and half width): the ground,
  // areas, water and pavements are not drawn over them
  uCuts: { value: Array.from({ length: 16 }, () => new THREE.Vector4()) },
  uCutW: { value: new Float32Array(16) },
  uCutN: { value: 0 },
};
const CUTS = /* glsl */`
uniform vec4 uCuts[16]; uniform float uCutW[16]; uniform float uCutN;
bool inCut(vec3 wp) {
  if (uCutN < 0.5 || wp.y < -0.15) return false;
  for (int i = 0; i < 16; i++) {
    if (float(i) >= uCutN) break;
    vec2 a = uCuts[i].xy, ab = uCuts[i].zw - a, q = wp.xz - a;
    float t = clamp(dot(q, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
    if (length(q - ab * t) < uCutW[i]) return true;
  }
  return false;
}`;
function cutUniforms(sh) { sh.uniforms.uCuts = U.uCuts; sh.uniforms.uCutW = U.uCutW; sh.uniforms.uCutN = U.uCutN; }
// Headlight pool painted by ground-level shaders: a cone 60 m long in front of the car.
const HEAD = /* glsl */`
uniform vec3 uHeadPos; uniform vec3 uHeadDir; uniform float uHeadOn;
float headPool(vec3 wp) {
  vec3 d = wp - uHeadPos; if (abs(d.y) > 3.0) return 0.0;
  float dist = length(d.xz); if (dist < 0.3 || dist > 70.0) return 0.0;
  float c = dot(d.xz / dist, uHeadDir.xz);
  return smoothstep(0.86, 0.97, c) * smoothstep(70.0, 6.0, dist) * (0.6 + 0.4 * smoothstep(0.97, 0.995, c)) * uHeadOn;
}
float headPoolN(vec3 wp, vec3 nW) { return headPool(wp) * max(nW.y, 0.3 * max(0.0, -dot(nW.xz, uHeadDir.xz))); }
`;

const HASH = /* glsl */`
float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
// Anti-aliased box pulse: 1 inside [a,b] of the unit cell, filtered by the pixel footprint w.
float boxInt(float t, float a, float b) { return floor(t) * (b - a) + clamp(fract(t) - a, 0.0, b - a); }
float pulse(float x, float a, float b, float w) { w = max(w, 1e-4); return (boxInt(x + w * 0.5, a, b) - boxInt(x - w * 0.5, a, b)) / w; }`;

// ------------------------------------------------------------------ buildings
// facade.x: 0 glass tower, 1 residential (punched windows + balconies), 2 office ribbons,
// 3 villa, 4 industrial shed, 5 mosque walls, 6 dome / minaret, 9.x roof; +0.3 = shopfronts
// on the ground floor. facade.y: per-building seed 0..1, facade.z: floor height,
// facade.w: building height.
// Windows are recessed with a parallax offset (the reveal shows as you drive past), and the
// glass of towers and offices opens onto rooms (interior mapping: back wall, floor, ceiling
// and side walls traced per pixel), which is what makes them read as real buildings at night.
export function makeBuildingMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0, envMapIntensity: 1.0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = U.uNight; sh.uniforms.uTime = U.uTime;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 facade;\nvarying vec4 vFac;\nvarying vec2 vUvB;\nvarying vec3 vWN;\nvarying vec3 vWPB;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\nvFac = facade; vUvB = uv; vWN = normalize(mat3(modelMatrix) * normal);")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWPB = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uNight; uniform float uTime;\nvarying vec4 vFac;\nvarying vec2 vUvB;\nvarying vec3 vWN;\nvarying vec3 vWPB;\n" + HASH + /* glsl */`
// A room behind the glass: trace the view ray through a box (width w, height h, depth d)
// and shade whichever face it meets. Returns the colour and, in .a, the depth fraction.
float gDetail = 1.0;                  // 0 beyond 350 m: rooms and window depth are too small to see there
vec4 roomK(vec2 p, vec3 vt, float w, float h, float d, float seed, float kind);
vec4 room(vec2 p, vec3 vt, float w, float h, float d, float seed) { return roomK(p, vt, w, h, d, seed, 0.0); }
// kind 1 = a shop: shelves of coloured goods on the back and side walls, a light tiled floor
vec4 roomK(vec2 p, vec3 vt, float w, float h, float d, float seed, float kind) {
  if (gDetail < 0.5) return vec4(vec3(0.5, 0.48, 0.45) * (kind > 0.5 ? 1.2 : 1.0), 0.5);
  vec3 rd = -vt; rd.z = min(rd.z, -0.08);
  vec2 cell = floor(vec2(p.x / w, p.y / h));
  vec3 ro = vec3(p.x - cell.x * w, p.y - cell.y * h, 0.0);
  float tx = rd.x > 0.0 ? (w - ro.x) / max(rd.x, 1e-3) : ro.x / max(-rd.x, 1e-3);
  float ty = rd.y > 0.0 ? (h - ro.y) / max(rd.y, 1e-3) : ro.y / max(-rd.y, 1e-3);
  float tz = d / -rd.z;
  float t = min(min(tx, ty), tz);
  vec3 hp = ro + rd * t;
  float r = h21(cell + seed * 13.0);
  vec3 wallC = mix(vec3(0.72, 0.68, 0.6), vec3(0.62, 0.66, 0.7), step(0.5, r));
  vec3 c;
  if (t == tz) { c = wallC; c *= 0.85 + 0.15 * step(0.35, fract(hp.x / w * 2.0 + r)); }      // back wall, a partition
  if (kind > 0.5 && t != ty) {
    // shelving: four shelves of goods in bands of colour, broken into packs
    vec2 sp = t == tz ? vec2(hp.x, hp.y) : vec2(hp.z, hp.y);
    float shelf = step(0.35, hp.y) * step(hp.y, min(h - 0.4, 2.4));
    float band = floor(sp.y / 0.52), pack = floor(sp.x / 0.34 + band * 0.5);
    vec3 goods = 0.35 + 0.6 * vec3(h21(vec2(pack, band) + r * 7.0), h21(vec2(band, pack) + 3.1 + r), h21(vec2(pack + 5.0, band * 3.0) + r * 2.0));
    float edge = step(0.9, fract(sp.y / 0.52));
    c = mix(c, mix(goods, vec3(0.85), edge), shelf);
  }
  if (kind > 0.5 && t == ty && rd.y < 0.0) c = vec3(0.78, 0.76, 0.72) * (0.9 + 0.1 * step(0.5, fract(hp.x * 1.7) + fract(hp.z * 1.7) - 0.5));
  else if (t == ty) c = rd.y > 0.0 ? vec3(0.9, 0.88, 0.84) * (0.8 + 0.4 * step(0.8, fract(hp.z * 0.6 + hp.x * 0.3))) : vec3(0.32, 0.27, 0.22) * (0.8 + 0.3 * r);   // ceiling with light panels / floor
  else c = wallC * 0.78;
  float depth = clamp(-hp.z / d, 0.0, 1.0);
  return vec4(c * (1.0 - 0.45 * depth), depth);
}`)
      .replace("#include <color_fragment>", /* glsl */`
#include <color_fragment>
float fType = vFac.x, seed = vFac.y, floorH = vFac.z, bH = vFac.w;
bool isRoof = fType > 8.5;
float isRetail = (!isRoof && fract(fType + 0.001) > 0.2) ? 1.0 : 0.0;
vec2 uvb = vUvB;
float glassMask = 0.0, litMask = 0.0, spec = 0.0, crown = 0.0, shopGlow = 0.0, signMask = 0.0;
vec3 signC = vec3(0.0);
vec3 roomLit = vec3(0.0);
vec3 base = diffuseColor.rgb;
vec3 col = base;
vec2 fw = fwidth(uvb) + 1e-4;
// view direction in the wall's frame: x along the wall, y up, z out of it
vec3 Nw = normalize(vWN), Tw = vec3(-Nw.z, 0.0, Nw.x), Vw = normalize(cameraPosition - vWPB);
vec3 vt = vec3(dot(Vw, Tw), Vw.y, dot(Vw, Nw));
gDetail = step(length(cameraPosition - vWPB), 350.0);
vec2 par = -vt.xy / max(vt.z, 0.5) * gDetail;          // parallax shift per metre of depth (capped at grazing angles)
float gh = isRetail > 0.5 ? min(floorH * 1.4, 5.4) : 0.0;          // shop storey height
if (fType < 0.5) {
  // glass curtain wall: panels 1.5 m wide, spandrels at each floor, rooms behind
  float pw = 1.5 + floor(seed * 3.0) * 0.25;
  vec2 cell = vec2(uvb.x / pw, uvb.y / floorH);
  float mull = 1.0 - pulse(cell.x, 0.05, 0.95, fw.x / pw);
  float band = 1.0 - pulse(cell.y, 0.14, 1.0, fw.y / floorH);
  vec2 id = floor(cell);
  float var = h21(id + seed * 91.0);
  vec3 glass = base * (0.75 + 0.35 * var);
  vec3 frame = mix(vec3(0.62, 0.64, 0.66), base * 0.6, 0.4);
  col = mix(glass, frame, clamp(mull * 0.9 + band * 0.8, 0.0, 1.0));
  glassMask = 1.0 - clamp(mull + band, 0.0, 1.0);
  float occ = 0.25 + 0.45 * fract(seed * 7.13);                 // how busy this tower is tonight
  vec2 rid = floor(vec2(uvb.x / (pw * 2.0), cell.y));
  float lit = step(1.0 - occ, h21(rid * 1.37 + seed * 17.0));
  vec4 rm = room(uvb, vt, pw * 2.0, floorH, 5.5, seed);
  roomLit = rm.rgb * glassMask;
  // each lit room its own brightness; some have the blinds half down
  float blinds = step(0.72, h21(rid * 2.13 + seed)) * step(fract(cell.y), 0.55);
  litMask = glassMask * (lit * (0.3 + 0.7 * h21(rid + 3.7)) * (1.0 - blinds * 0.85) + 0.04);
  col = mix(col, col * 0.8 + rm.rgb * 0.12, glassMask);          // a hint of the rooms by day
  // lit crown on tall towers: the top floors glow at night, each tower its own colour
  crown = step(60.0, bH) * step(bH - 7.0, uvb.y);
  if (bH > 40.0 && uvb.y > bH - 4.5) {
    // plant floors behind louvres at the top of the tower
    float lv = pulse(uvb.x / 0.45, 0.0, 0.55, fw.x / 0.45);
    col = mix(vec3(0.5, 0.52, 0.55), base * 0.45, lv); glassMask = 0.0; litMask = 0.0; roomLit = vec3(0.0);
  } else if (uvb.y < 6.0 && isRetail < 0.5) {
    // double-height lobby: big panes, thin mullions, a canopy line, lit at night
    float lm = 1.0 - pulse(uvb.x / 2.6, 0.03, 0.97, fw.x / 2.6);
    float canopy = pulse(uvb.y / 6.0, 0.9, 0.94, fw.y / 6.0);
    col = mix(vec3(0.07, 0.09, 0.1), vec3(0.6, 0.62, 0.64), max(lm, canopy));
    glassMask = (1.0 - lm) * (1.0 - canopy) * step(0.2, uvb.y) * step(uvb.y, 5.3);
    roomLit = vec3(0.95, 0.88, 0.75) * glassMask; litMask = glassMask;
  }
} else if (fType < 1.5 || fType > 4.5 && fType < 5.5) {
  // punched windows in rendered block walls, recessed 25 cm; balconies as slab edges
  bool mosque = fType > 4.5;
  bool twr = !mosque && bH > 45.0 && fract(seed * 5.3) > 0.3;
  float ww = mosque ? 4.0 : twr ? 3.0 : 3.4 + floor(seed * 4.0) * 0.35;
  float x0 = mosque ? 0.35 : twr ? 0.04 : 0.22, x1 = mosque ? 0.65 : twr ? 0.96 : 0.78, y0 = mosque ? 0.2 : twr ? 0.08 : 0.28, y1 = mosque ? 0.75 : twr ? 0.97 : 0.8;
  vec2 cell = vec2(uvb.x / ww, uvb.y / floorH);
  vec2 id = floor(cell);
  float winX = pulse(cell.x, x0, x1, fw.x / ww);
  float winY = pulse(cell.y, y0, y1, fw.y / floorH);
  float win = winX * winY;
  if (mosque && fract(cell.y) > 0.62) { float ax = abs(fract(cell.x) - 0.5) * 2.0 / 0.3; win *= step(fract(cell.y) - 0.62, 0.13 * sqrt(max(0.0, 1.0 - ax * ax))); }
  // the same window seen 25 cm deeper: where it misses, we see the reveal
  vec2 q = uvb + par * 0.25;
  vec2 cq = vec2(q.x / ww, q.y / floorH);
  float deep = step(x0, fract(cq.x)) * step(fract(cq.x), x1) * step(y0, fract(cq.y)) * step(fract(cq.y), y1) * step(floor(cq.x), id.x) * step(id.x, floor(cq.x)) * step(floor(cq.y), id.y) * step(id.y, floor(cq.y));
  float ground = step(uvb.y, floorH * 1.1);
  // balconies on some window columns: a lit slab edge, a glass balustrade, a shadow under the slab
  float isB = mosque ? 0.0 : (twr ? 1.0 : step(0.5, h21(vec2(floor(id.x * 0.5) + seed * 13.0, 1.0))) * step(0.25, fract(seed * 3.7))) * (1.0 - ground);
  float fyB = fract(cell.y);
  float bx = pulse(cell.x, 0.04, 0.96, fw.x / ww);
  float slab = isB * bx * pulse(cell.y, 0.0, 0.05, fw.y / floorH);
  float rail = isB * bx * step(0.05, fyB) * step(fyB, 0.05 + 1.05 / floorH);
  float grime = vnoise(uvb * vec2(0.08, 0.35) + seed * 10.0);
  float streak = vnoise(vec2(uvb.x * 1.7, uvb.y * 0.05) + seed * 3.0) * smoothstep(0.0, 0.25, fract(cell.y) - y1 + 0.2);
  col = base * (0.9 + 0.12 * grime) * (1.0 - 0.06 * streak);
  vec3 glass = twr ? mix(vec3(0.24, 0.31, 0.37), vec3(0.4, 0.47, 0.53), h21(id + seed)) : mix(vec3(0.16, 0.2, 0.24), vec3(0.3, 0.36, 0.42), h21(id + seed));
  float wm = win;
  col = mix(col, mix(base * 0.62, glass, deep), wm);              // reveal where the deep window is missed
  col *= 1.0 - 0.28 * isB * bx * smoothstep(0.72, 1.0, fyB);                      // shade under the slab above
  col = mix(col, mix(col * 0.9, vec3(0.42, 0.52, 0.56), 0.5), rail);               // glass balustrade
  col = mix(col, base * 1.1 + 0.06, slab);
  col *= 1.0 - 0.1 * winX * (1.0 - winY) * step(fract(cell.y), y0) * (1.0 - ground);   // sill shadow
  // window air-conditioners on the older blocks (Deira, Bur Dubai, Karama)
  if (!mosque && bH < 26.0 && seed > 0.45) {
    float ac = step(0.6, h21(id * 3.1 + seed)) * pulse(cell.x, 0.6, 0.76, fw.x / ww) * pulse(cell.y, 0.2, 0.31, fw.y / floorH) * (1.0 - ground);
    col = mix(col, vec3(0.78, 0.78, 0.76), ac);
  }
  glassMask = wm * deep;
  float occ = 0.3 + 0.4 * fract(seed * 5.71);
  float lit = step(1.0 - occ, h21(id * 1.71 + seed * 29.0));
  vec4 rm = room(uvb + par * 0.25, vt, ww, floorH, 4.0, seed);
  roomLit = rm.rgb * glassMask;
  // curtains: many flats keep them drawn, a warm glow through the fabric instead of a room
  float curtain = step(0.55, h21(id * 4.1 + seed * 2.0));
  roomLit = mix(roomLit, vec3(0.62, 0.5, 0.36) * (0.8 + 0.2 * vnoise(uvb * vec2(6.0, 0.5))) * glassMask, curtain);
  litMask = glassMask * lit * (0.4 + 0.45 * h21(id.yx)) * (1.0 - ground);
  crown = step(90.0, bH) * step(bH - 5.0, uvb.y) * 0.7;
} else if (fType < 2.5) {
  // office: continuous ribbon windows between concrete bands, open-plan floors behind
  vec2 cell = vec2(uvb.x / 1.8, uvb.y / floorH);
  vec2 id = floor(cell);
  float rib = pulse(cell.y, 0.3, 0.9, fw.y / floorH);
  float mull = 1.0 - pulse(cell.x, 0.04, 0.96, fw.x / 1.8);
  vec3 glass = mix(vec3(0.18, 0.24, 0.3), vec3(0.34, 0.42, 0.5), h21(id + seed * 7.0));
  col = mix(base, glass, rib * (1.0 - mull * 0.8));
  glassMask = rib * (1.0 - mull);
  vec4 rm = room(uvb, vt, 7.2, floorH, 7.0, seed);
  roomLit = rm.rgb * glassMask;
  col = mix(col, col * 0.85 + rm.rgb * 0.1, glassMask);
  litMask = glassMask * step(0.6, h21(floor(vec2(uvb.x / 7.2, cell.y)) + seed * 11.0));
} else if (fType < 3.5) {
  // villa / low house: a few recessed windows, a darker plinth, a parapet band at the top
  float ww = 5.5;
  vec2 cell = vec2(uvb.x / ww, uvb.y / floorH);
  vec2 id = floor(cell);
  float has = step(0.35, h21(id + seed * 5.0));
  float win = has * pulse(cell.x, 0.32, 0.68, fw.x / ww) * pulse(cell.y, 0.3, 0.75, fw.y / floorH);
  vec2 q = uvb + par * 0.2; vec2 cq = vec2(q.x / ww, q.y / floorH);
  float deep = step(0.32, fract(cq.x)) * step(fract(cq.x), 0.68) * step(0.3, fract(cq.y)) * step(fract(cq.y), 0.75) * step(abs(floor(cq.x) - id.x), 0.1) * step(abs(floor(cq.y) - id.y), 0.1);
  col = base * (0.92 + 0.1 * vnoise(uvb * 0.3 + seed));
  col = mix(col, mix(base * 0.62, vec3(0.14, 0.17, 0.2), deep), win);
  col *= 1.0 - 0.25 * (1.0 - smoothstep(0.0, 0.5, uvb.y));
  glassMask = win * deep;
  litMask = glassMask * step(0.45, h21(id * 2.3 + seed)) * (0.45 + 0.4 * h21(id + 1.7));
  vec4 rmv = room(uvb + par * 0.2, vt, ww, floorH, 4.0, seed);
  roomLit = rmv.rgb * glassMask * vec3(1.0, 0.93, 0.8);
} else if (fType < 4.5) {
  // industrial shed: vertical ribs, a high strip of clerestory windows
  float rib = 0.5 + 0.5 * sin(uvb.x * 6.2832 / 0.9);
  col = base * (0.86 + 0.14 * rib);
  float strip = pulse(uvb.y / 1.0, 0.0, 1.0, fw.y) * step(floorH * 0.9, uvb.y) * step(uvb.y, floorH * 0.9 + 0.8);
  col = mix(col, vec3(0.2, 0.24, 0.28), strip * 0.8);
  glassMask = strip; litMask = strip * 0.4; roomLit = vec3(0.7) * strip;
} else if (fType > 6.5 && fType < 7.5) {
  // under construction: bare concrete slab edges and columns, open dark floors, the lower
  // storeys already glazed, orange safety netting on the top three
  vec2 cell = vec2(uvb.x / 6.0, uvb.y / floorH);
  float frame = max(pulse(cell.y, 0.0, 0.11, fw.y / floorH), pulse(cell.x, 0.0, 0.07, fw.x / 6.0));
  float clad = step(uvb.y, bH * (0.15 + 0.5 * seed));
  float net = step(bH - floorH * 3.0, uvb.y);
  vec3 concrete = vec3(0.63, 0.62, 0.59) * (0.88 + 0.12 * vnoise(uvb * 0.6 + seed));
  col = mix(vec3(0.07, 0.07, 0.075), concrete, frame);
  col = mix(col, vec3(0.3, 0.4, 0.47), clad * (1.0 - frame));
  col = mix(col, vec3(0.86, 0.45, 0.14), net * 0.55 * (1.0 - frame));
  glassMask = clad * (1.0 - frame);
} else if (fType < 6.5) {
  // domes and minarets: plain with a faint banding
  col = base * (0.95 + 0.05 * sin(uvb.y * 2.0));
} else {
  // roofs: concrete with noise and tar seams
  float n = vnoise(uvb * 0.35 + seed * 20.0);
  float n2 = vnoise(uvb * 2.1);
  vec3 roofC = mix(vec3(0.52, 0.5, 0.47), vec3(0.64, 0.62, 0.58), n);
  if (fType > 9.1 && fType < 9.3) roofC = mix(vec3(0.34, 0.36, 0.38), vec3(0.46, 0.48, 0.5), n);   // tower roof: dark plant deck
  if (fType > 9.3 && fType < 9.5) roofC = mix(vec3(0.62, 0.64, 0.66), vec3(0.72, 0.73, 0.74), n);   // shed: light metal
  if (fType > 9.5) roofC = base * (0.88 + 0.2 * n);                                                // the roof colour OpenStreetMap gives
  if (fType > 9.7) roofC *= 0.86 + 0.14 * step(0.5, fract(uvb.x * 3.0 + uvb.y * 0.3));             // pitched: courses of tiles
  float seam = 1.0 - 0.08 * (1.0 - pulse(uvb.x / 6.0, 0.02, 0.98, fw.x / 6.0)) - 0.08 * (1.0 - pulse(uvb.y / 6.0, 0.02, 0.98, fw.y / 6.0));
  col = roofC * (0.92 + 0.12 * n2) * seam;
}
if (!isRoof && fType < 4.5) {
  // coping along the roofline with a shadow line under it
  float cop = step(bH - 0.45, uvb.y);
  col = mix(col, base * 1.06 + 0.02, cop);
  col *= 1.0 - 0.22 * step(bH - 0.75, uvb.y) * (1.0 - cop);
  if (fType > 0.5) col *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.7, uvb.y));           // plinth
}
// shopfronts: tall glass bays between piers, a fascia band above for the sign, lit inside at night
if (isRetail > 0.5 && uvb.y < gh) {
  float bay = 4.6 + floor(seed * 3.0) * 0.7;
  float bi = floor(uvb.x / bay);
  float pier = 1.0 - pulse(uvb.x / bay, 0.07, 0.93, fw.x / bay);
  float fascia = step(gh - 1.35, uvb.y);
  float sill = step(uvb.y, 0.3);
  vec2 q = uvb + par * 0.2;                                    // the glass sits 20 cm back
  float deep = step(0.07, fract(q.x / bay)) * step(fract(q.x / bay), 0.93) * step(abs(floor(q.x / bay) - bi), 0.1) * step(q.y, gh - 1.35) * step(0.3, q.y);
  float glassF = (1.0 - pier) * (1.0 - fascia) * (1.0 - sill);
  vec3 pierC = mix(base * 0.78, vec3(0.62, 0.6, 0.57), 0.4);
  vec3 fasciaC = mix(base * 0.5, vec3(0.16, 0.17, 0.18), step(0.45, h21(vec2(bi, seed * 7.0))));
  col = mix(pierC, fasciaC, fascia);
  // every shop has its own signboard across the fascia (red, green, blue, yellow or white, with
  // a band of lettering), as along any Karama or Deira street; one in five keeps a plain fascia
  float sg = h21(vec2(bi, seed * 7.0 + 1.3));
  vec3 board = sg < 0.2 ? vec3(0.62, 0.06, 0.06) : sg < 0.36 ? vec3(0.04, 0.36, 0.16) : sg < 0.52 ? vec3(0.05, 0.16, 0.5) : sg < 0.64 ? vec3(0.85, 0.62, 0.05) : sg < 0.8 ? vec3(0.9, 0.9, 0.88) : vec3(-1.0);
  if (board.r >= 0.0) {
    float fy = (uvb.y - (gh - 1.35)) / 1.35, fx = fract(uvb.x / bay);
    float panel = fascia * step(0.1, fx) * step(fx, 0.9) * step(0.15, fy) * step(fy, 0.85);
    // lettering: short strokes in the middle third, in white (or dark on white and yellow boards)
    float lt = step(0.36, fy) * step(fy, 0.64) * step(0.2, fx) * step(fx, 0.2 + 0.6 * (0.55 + 0.45 * h21(vec2(bi, seed * 5.0))));
    lt *= step(0.35, fract(uvb.x * 1.7 + floor(uvb.x * 0.6) * 0.37)) * step(0.3, h21(vec2(floor(uvb.x * 1.7), bi)));
    vec3 ink = board.g > 0.55 ? vec3(0.08, 0.08, 0.1) : vec3(0.97, 0.96, 0.92);
    signC = mix(board, ink, lt);
    signMask = panel;
    col = mix(col, signC, panel);
  }
  vec4 rm = roomK(q, vt, bay, gh - 1.35, 5.0, seed + 0.37, 1.0);
  vec3 shopIn = rm.rgb * vec3(1.0, 0.97, 0.9);
  col = mix(col, mix(base * 0.55, vec3(0.03, 0.04, 0.05) + shopIn * 0.12, deep), glassF);
  glassMask = glassF * deep;
  roomLit = shopIn * glassMask * 1.25;
  litMask = glassMask * step(0.15, h21(vec2(bi, seed * 3.0)));
  shopGlow = litMask;
}
diffuseColor.rgb = col;
`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, fType < 0.5 ? 0.06 : 0.12, glassMask);")
      .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, fType < 0.5 ? 0.85 : isRetail > 0.5 && uvb.y < gh ? 0.25 : 0.55, glassMask);")
      .replace("#include <emissivemap_fragment>", /* glsl */`#include <emissivemap_fragment>
vec3 warm = mix(vec3(1.0, 0.8, 0.52), vec3(0.88, 0.94, 1.0), step(0.55, h21(vec2(seed * 37.0, floor(uvb.y / floorH)))));
totalEmissiveRadiance += warm * roomLit * roomLit * litMask * uNight * 1.25;      // squared: dim floors, bright ceilings
totalEmissiveRadiance += roomLit * shopGlow * 0.1 * (1.0 - uNight);                  // shops are lit inside by day too
totalEmissiveRadiance += signC * signMask * uNight * 0.9;                             // lit signboards
if (!isRoof && fType < 4.5) totalEmissiveRadiance += vec3(1.0, 0.82, 0.58) * diffuseColor.rgb * uNight * 0.16 * (1.0 - smoothstep(2.0, 12.0, uvb.y)) * (1.0 - glassMask);   // street-lamp spill
// floodlights washing up the facade from the ground at night (some buildings, warm or cool)
if (!isRoof && fType < 6.5 && (fType > 4.5 || fract(seed * 13.7) > 0.55)) {
  bool mosq = fType > 4.5;
  float wash = mosq ? (fType > 5.5 ? 0.75 : 1.0 - 0.6 * smoothstep(0.0, bH + 2.0, uvb.y)) : (1.0 - smoothstep(0.0, mix(12.0, 30.0, fract(seed * 3.3)), uvb.y)) * (0.55 + 0.45 * pulse(uvb.x / 6.0, 0.15, 0.85, fwidth(uvb.x) / 6.0));
  vec3 washC = mosq ? vec3(0.95, 0.97, 1.0) : fract(seed * 7.9) > 0.35 ? vec3(1.0, 0.82, 0.55) : vec3(0.75, 0.85, 1.0);
  totalEmissiveRadiance += diffuseColor.rgb * washC * wash * uNight * 0.55 * (1.0 - glassMask);
}
vec3 crownC = seed < 0.3 ? vec3(0.55, 0.8, 1.0) : seed < 0.5 ? vec3(1.0, 0.95, 0.85) : seed < 0.7 ? vec3(0.75, 0.55, 1.0) : seed < 0.85 ? vec3(1.0, 0.78, 0.4) : vec3(0.5, 1.0, 0.85);
totalEmissiveRadiance += crownC * crown * uNight * 1.3;
`);
  };
  m.customProgramCacheKey = () => "uae-building-v8";
  return m;
}

// ------------------------------------------------------------------ roads
// Shanghai (shanghai.html sets window.CITY): Chinese markings, a yellow line between the two directions.
const CN_ROADS = typeof window !== "undefined" && !!window.CITY && window.CITY.region === "shanghai";
// road: (width, lanes, flags, class) flags bit0 oneway, bit1 bridge, bit3 ramp, bit4 junction disc
// junc: (dist since junction, dist to next junction, radius behind, radius ahead)
// Painted lane arrows (metres; x across the lane to the right, y along travel, tip toward +y)
const ARROWS = /* glsl */`
float box2(vec2 p, vec2 lo, vec2 hi, float w) { vec2 a = smoothstep(lo - w, lo + w, p) * (1.0 - smoothstep(hi - w, hi + w, p)); return a.x * a.y; }
float arrowStraight(vec2 p, float w) {
  float shaft = box2(p, vec2(-0.15, 0.0), vec2(0.15, 3.5), w);
  float hy = (p.y - 3.5) / 1.5;
  float head = smoothstep(-0.02, 0.02, hy) * (1.0 - smoothstep(0.98, 1.0, hy)) * (1.0 - smoothstep(0.55 * (1.0 - hy) - w, 0.55 * (1.0 - hy) + w, abs(p.x)));
  return max(shaft, head);
}
float arrowTurn(vec2 p, float s, float w) {
  p.x *= s;
  float shaft = box2(p, vec2(-0.15, 0.0), vec2(0.15, 2.55), w);
  float bar = box2(p, vec2(-0.15, 2.25), vec2(0.8, 2.55), w);
  float hx = (p.x - 0.8) / 0.9;
  float head = smoothstep(-0.02, 0.02, hx) * (1.0 - smoothstep(0.98, 1.0, hx)) * (1.0 - smoothstep(0.5 * (1.0 - hx) - w, 0.5 * (1.0 - hx) + w, abs(p.y - 2.4)));
  return max(max(shaft, bar), head);
}`;
export function makeRoadMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = U.uNight; sh.uniforms.uLampTint = U.uLampTint; sh.uniforms.uHeadPos = U.uHeadPos; sh.uniforms.uHeadDir = U.uHeadDir; sh.uniforms.uHeadOn = U.uHeadOn;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 road; attribute vec4 junc;\nvarying vec4 vRoad; varying vec4 vJunc; varying vec2 vUvR; varying vec3 vWP;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\nvRoad = road; vJunc = junc; vUvR = uv;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uNight; uniform vec3 uLampTint;\nvarying vec4 vRoad; varying vec4 vJunc; varying vec2 vUvR; varying vec3 vWP;\n" + HASH + HEAD + ARROWS)
      .replace("#include <color_fragment>", /* glsl */`
#include <color_fragment>
float W = vRoad.x, lanes = max(1.0, vRoad.y), flags = vRoad.z, cls = vRoad.w;
float u = vUvR.x, v = vUvR.y;
bool oneway = mod(flags, 2.0) > 0.5;
bool disc = flags > 15.5;
bool bridge = mod(floor(flags / 2.0), 2.0) > 0.5;
vec2 wp = vWP.xz;
float n1 = vnoise(wp * 0.9), n2 = vnoise(wp * 0.07), n3 = h21(floor(wp * 12.0));
vec3 asph = mix(vec3(0.105, 0.105, 0.108), vec3(0.165, 0.162, 0.156), n2) * (0.9 + 0.12 * n1) + 0.015 * n3;
if (cls > 6.5 && cls < 7.5) asph = mix(vec3(0.62, 0.58, 0.52), vec3(0.7, 0.66, 0.6), n1);        // paving
if (cls > 7.5) asph = mix(vec3(0.62, 0.52, 0.38), vec3(0.7, 0.6, 0.45), n1);                     // track
if (bridge) asph *= 1.08;
// tyre wear in the middle of each lane
float lw = W / lanes;
float laneF = fract(u / lw);
asph *= 1.0 - 0.07 * smoothstep(0.15, 0.3, abs(laneF - 0.5)) * (cls < 6.5 ? 1.0 : 0.0);
if (!disc && cls < 6.5 && length(cameraPosition - vWP) < 160.0) {
  // repairs: rectangular patches of newer (darker) or older (paler) asphalt
  vec2 pc = vec2(u / 3.2, v / 7.0); vec2 pid = floor(pc); float ph = h21(pid + 17.3);
  if (ph > 0.93) { vec2 pf = fract(pc); float inP = step(0.12, pf.x) * step(pf.x, 0.88) * step(0.1, pf.y) * step(pf.y, 0.9); asph = mix(asph, asph * (ph > 0.965 ? 0.78 : 1.18), inP); }
  // hairline cracks, only where they can be seen
  float ck = abs(vnoise(wp * 1.3) - 0.5); asph *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.025, ck)) * step(0.55, vnoise(wp * 0.11)) * (1.0 - smoothstep(4.0, 12.0, fwidth(v) * 400.0));
  // a manhole cover in the middle of a lane every so often on city roads
  if (cls > 1.5) { vec2 mc = vec2((floor(u / lw) + 0.5) * lw, (floor(v / 47.0) + 0.5) * 47.0 + (h21(vec2(floor(u / lw), floor(v / 47.0))) - 0.5) * 20.0); float md = length(vec2(u, v) - mc);
    if (h21(vec2(floor(v / 47.0), floor(u / lw) + 3.0)) > 0.6) { asph = mix(asph, vec3(0.13, 0.13, 0.14) * (0.8 + 0.4 * step(0.5, fract((u - mc.x) * 6.0 + (v - mc.y) * 6.0))), 1.0 - smoothstep(0.32, 0.36, md)); asph = mix(asph, vec3(0.3), smoothstep(0.3, 0.33, md) * (1.0 - smoothstep(0.36, 0.4, md))); } }
  // concrete gutter along the kerb of city streets
  if (cls > 1.5 && cls < 5.5) { float g2 = 1.0 - smoothstep(0.32, 0.36, min(u, W - u)); asph = mix(asph, vec3(0.5, 0.49, 0.46), g2 * (oneway ? step(W * 0.5, u) : 1.0)); }
}
float mark = 0.0; vec3 markC = vec3(0.92);
float dJ = min(vJunc.x - vJunc.z, vJunc.y - vJunc.w);                 // metres clear of the nearest junction disc
float fw = max(fwidth(u), 1e-3), fv = max(fwidth(v), 1e-3);
if (!disc && cls < 6.5) {
  float clear = smoothstep(0.5, 2.5, dJ);
  float lineW = 0.15;
  // edge lines: UAE style, yellow on the left (median) edge of a one-way carriageway, white on the right
  float le = 1.0 - smoothstep(lineW * 0.5, lineW * 0.5 + fw, abs(u - 0.35));
  float re = 1.0 - smoothstep(lineW * 0.5, lineW * 0.5 + fw, abs(u - (W - 0.35)));
  if (cls < 3.5 || oneway) {
    mark = max(mark, re * clear);
    if (oneway) { if (le * clear > 0.0) { markC = mix(markC, vec3(0.95, 0.72, 0.1), le); } mark = max(mark, le * clear); }
    else mark = max(mark, le * clear);
  }
  // lane dividers: dashed
  float dashL = cls < 1.5 ? 4.0 : 3.0, gapL = cls < 1.5 ? 8.0 : 6.0;
  float dash = pulse(v / (dashL + gapL), 0.0, dashL / (dashL + gapL), fv / (dashL + gapL));
  for (int k = 1; k < 8; k++) {
    if (float(k) >= lanes) break;
    float lu = float(k) * lw;
    float lm = 1.0 - smoothstep(0.06, 0.06 + fw, abs(u - lu));
    bool centre = !oneway && abs(lu - W * 0.5) < 0.1;
    float pat = centre && cls < 2.5 ? 1.0 : dash;                     // solid centre line on big two-way roads
${CN_ROADS ? `    if (centre) {                                                     // China: yellow centre line, double solid on main roads, dashed on side streets
      float l2 = 1.0 - smoothstep(0.06, 0.06 + fw, abs(abs(u - lu) - 0.18));
      float cm = (cls < 3.5 ? l2 : lm * dash) * clear;
      if (cm > 0.0) markC = mix(markC, vec3(0.95, 0.72, 0.1), cm);
      mark = max(mark, cm); continue;
    }` : ""}
    mark = max(mark, lm * pat * clear);
  }
  // zebra crossing and stop line where urban roads meet a junction
  if (cls > 2.5 && cls < 6.5) {
    float dz = min(vJunc.x - vJunc.z, vJunc.y - vJunc.w);
    float zeb = step(1.0, dz) * step(dz, 4.2) * pulse(u / 1.0, 0.1, 0.55, fw);
    mark = max(mark, zeb * 0.95);
  }
  // stop line and lane arrows on the approach to a junction, in each travel lane
  bool ramp = mod(floor(flags / 8.0), 2.0) > 0.5;
  if (cls > 1.5 && cls < 5.5 && !ramp) {
    float nDir = oneway ? lanes : max(1.0, floor(lanes / 2.0));
    bool fwdH = oneway || u > W * 0.5;
    float dA = fwdH ? (vJunc.y - vJunc.w) : (vJunc.x - vJunc.z);          // metres to the junction, along travel
    float lwD = (oneway ? W : W * 0.5) / nDir;
    float xr = fwdH ? (oneway ? u : u - W * 0.5) : (W * 0.5 - u);          // from the left edge of the travel lanes
    float sl = smoothstep(4.4 - fv, 4.4 + fv, dA) * (1.0 - smoothstep(4.95 - fv, 4.95 + fv, dA)) * step(0.25, xr) * step(xr, lwD * nDir - 0.25);
    mark = max(mark, sl);
    if (nDir >= 2.0 && dA > 7.5 && dA < 14.0) {
      float k = floor(xr / lwD);
      vec2 p = vec2(xr - (k + 0.5) * lwD, 13.4 - dA);
      float g = arrowStraight(p, fw);
      if (k < 0.5) g = max(g, arrowTurn(p, -1.0, fw));
      if (k > nDir - 1.5) g = max(g, arrowTurn(p, 1.0, fw));
      mark = max(mark, g * 0.95);
    }
  }
  mark *= 0.85 + 0.15 * n1;
}
diffuseColor.rgb = mix(asph, markC, clamp(mark, 0.0, 1.0));
// night: street lamps every 42 m pool warm light on the carriageway
float pool = 0.0;
if (cls < 4.5) { float ph = fract(v / 42.0); pool = 0.35 + 0.65 * exp(-pow((ph - 0.5) * 5.0, 2.0)); }
else if (cls < 6.5) pool = 0.25;
`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(0.93, 0.6, clamp(mark, 0.0, 1.0));")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += uLampTint * diffuseColor.rgb * pool * uNight * 1.1 + markC * clamp(mark,0.0,1.0) * uNight * 0.02 + vec3(1.0, 0.95, 0.85) * diffuseColor.rgb * headPool(vWP) * 1.8;");
  };
  m.customProgramCacheKey = () => "uae-road-v4";
  return m;
}

// Sidewalks, curbs, barriers: vertex colour; curbs (uv.y = 1) get painted stripes.
export function makeWalkMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = U.uNight; sh.uniforms.uHeadPos = U.uHeadPos; sh.uniforms.uHeadDir = U.uHeadDir; sh.uniforms.uHeadOn = U.uHeadOn; cutUniforms(sh);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vUvW; varying vec3 vWPW;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\nvUvW = uv;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWPW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uNight;\nvarying vec2 vUvW; varying vec3 vWPW;\n" + HASH + HEAD + CUTS)
      .replace("#include <color_fragment>", /* glsl */`#include <color_fragment>
if (inCut(vWPW)) discard;
float tunnelLight = 0.0;
if (vUvW.y > 2.5) { diffuseColor.rgb = vec3(0.95, 0.93, 0.88); tunnelLight = 1.0; }
else if (vUvW.y > 0.5 && vUvW.y < 1.5) {
  float s = step(0.5, fract(vUvW.x / 1.0));
  diffuseColor.rgb = ${CN_ROADS ? "vec3(0.62, 0.61, 0.58) * (0.94 + 0.06 * s)" : "mix(vec3(0.02, 0.02, 0.02), vec3(0.85, 0.85, 0.82), s)"};      // Shanghai: plain granite kerbs
} else if (vUvW.y < 0.5) {
  // paving slabs
  vec2 t = vWPW.xz / 0.6; vec2 f = abs(fract(t) - 0.5);
  float joint = smoothstep(0.46, 0.5, max(f.x, f.y));
  diffuseColor.rgb *= (0.93 + 0.08 * h21(floor(t))) * (1.0 - 0.12 * joint);
} else {
  diffuseColor.rgb *= 0.92 + 0.08 * vnoise(vWPW.xz * 0.5 + vWPW.y);
}
`)
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n  totalEmissiveRadiance += vec3(1.0, 0.95, 0.85) * diffuseColor.rgb * headPoolN(vWPW, inverseTransformDirection(normal, viewMatrix)) * 1.8 + vec3(1.0, 0.92, 0.78) * tunnelLight * 2.2;");
  };
  m.customProgramCacheKey = () => "uae-walk-v2";
  return m;
}

// Ground areas (parks, sand, paved districts): vertex colour with texture noise.
export function makeAreaMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  m.onBeforeCompile = (sh) => {
    cutUniforms(sh);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPA;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWPA = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPA;\n" + HASH + CUTS)
      .replace("#include <color_fragment>", /* glsl */`#include <color_fragment>
if (inCut(vWPA)) discard;
vec3 c = diffuseColor.rgb;
float g = step(c.r * 1.12, c.g);                                   // green areas
float n = vnoise(vWPA.xz * 0.35), n2 = vnoise(vWPA.xz * 0.03), n3 = h21(floor(vWPA.xz * 6.0));
c *= mix(0.9 + 0.14 * n + 0.08 * n2, 0.78 + 0.3 * n * n2 + 0.08 * n3, g);
diffuseColor.rgb = c;
`);
  };
  m.customProgramCacheKey = () => "uae-area-v2";
  return m;
}

// Endless desert ground under everything, following the camera (Shanghai: bare grey-olive earth).
export function makeGroundMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: CN_ROADS ? 0x8e8f7c : 0xc8aa7e, roughness: 1, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    cutUniforms(sh);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPG;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWPG = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPG;\n" + HASH + CUTS)
      .replace("#include <color_fragment>", /* glsl */`#include <color_fragment>
if (inCut(vWPG + vec3(0.0, 0.1, 0.0))) discard;
vec2 p = vWPG.xz;
float n = vnoise(p * 0.05) * 0.6 + vnoise(p * 0.4) * 0.3 + vnoise(p * 3.0) * 0.1;
float ripple = 0.5 + 0.5 * sin(p.x * 0.9 + p.y * 0.35 + vnoise(p * 0.1) * 6.0);
diffuseColor.rgb *= 0.86 + 0.18 * n + 0.03 * ripple;
`);
  };
  m.customProgramCacheKey = () => "uae-ground-v2";
  return m;
}

// Sea and lakes: dark teal, animated ripples, strong sky reflection.
// far = the low-zoom sea layer: it discards itself inside the detailed tiles (uNearR) so the
// detailed coastline wins there, and only paints the water out to the horizon.
export function makeWaterMaterial(far = false) {
  const m = new THREE.MeshStandardMaterial({ color: 0x0c5a6e, roughness: 0.32, metalness: 0.0, envMapIntensity: 0.3, vertexColors: true });
  m.userData.uNearR = { value: far ? 2300 : 0 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.uTime; sh.uniforms.uNight = U.uNight; sh.uniforms.uNearR = m.userData.uNearR; cutUniforms(sh);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPWa;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWPWa = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uTime; uniform float uNight; uniform float uNearR;\nvarying vec3 vWPWa;\n" + HASH + CUTS)
      .replace("#include <color_fragment>", /* glsl */`#include <color_fragment>
if (uNearR > 0.0 && length(vWPWa.xz - cameraPosition.xz) < uNearR) discard;
if (inCut(vWPWa)) discard;
bool pool = vColor.b > 0.3;
vec3 deep = vec3(0.006, 0.12, 0.16), shallow = vec3(0.02, 0.34, 0.36);
float n = vnoise(vWPWa.xz * 0.004), n2 = vnoise(vWPWa.xz * 0.05 + uTime * 0.05);
diffuseColor.rgb = pool ? vec3(0.05, 0.42, 0.6) : mix(deep, shallow, 0.35 + n * 0.5) * (0.9 + 0.2 * n2);
`)
      .replace("#include <normal_fragment_maps>", /* glsl */`#include <normal_fragment_maps>
{
  vec2 p = vWPWa.xz;
  float t = uTime;
  vec2 g = vec2(0.0);
  g += vec2(cos(p.x * 0.21 + t * 1.1), sin(p.y * 0.17 + t * 0.9)) * 0.06;
  g += vec2(sin(p.x * 0.57 - p.y * 0.31 + t * 1.7), cos(p.y * 0.61 + p.x * 0.23 - t * 1.3)) * 0.035;
  g += (vec2(vnoise(p * 0.9 + t * 0.6), vnoise(p.yx * 0.9 - t * 0.5)) - 0.5) * 0.06;
  vec3 nW = normalize(vec3(-g.x, 1.0, -g.y));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}
`)
      // light scattered up out of shallow Gulf water: the turquoise that a mirror-like surface lacks
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n  totalEmissiveRadiance += (vColor.b > 0.3 ? vec3(0.03, 0.2, 0.26) : vec3(0.02, 0.2, 0.21)) * (1.0 - 0.85 * uNight);");
  };
  m.customProgramCacheKey = () => "uae-water-v3-" + (far ? "far" : "near");
  return m;
}
