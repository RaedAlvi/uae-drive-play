// Materials for the city: procedural facades, roads with lane markings, sidewalks and
// ground areas, water. All are MeshStandardMaterial with shader patches, so the sun,
// shadows, fog and the sky environment map work as usual.
import * as THREE from "three";

// Pakistan (pakistan.html sets window.CITY): every shader change below is compiled only on that page.
const PK_ROAD = typeof window !== "undefined" && !!window.CITY && window.CITY.region === "pakistan";
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

// ------------------------------------------------------------------ Pakistan facade kits (REVIEW items 7, 13, 14; colours from art_direction.md, estimated)
// The kit travels in the type code: 3.03 Islamabad sector house, 3.06 Bahria, 3.09 DHA, 3.12 colonial brick, 3.15 Murree house, 3.18 Murree half-timbered (+0.3 = shops below)
const PK_KIT_FN = /* glsl */`
vec3 kitCourse(vec2 p, vec3 a, vec3 b, float w, float h, float near) {
  float r = floor(p.y / h), u = p.x / w + 0.5 * mod(r, 2.0);
  vec2 id = vec2(floor(u), r);
  vec3 c = mix(a, b, h21(id * 1.31 + 4.7)) * (0.9 + 0.2 * h21(id + 1.9));
  float fx = fract(u), fy = fract(p.y / h), jt = min(min(fx, 1.0 - fx) * w, min(fy, 1.0 - fy) * h);
  return mix(mix(a, b, 0.5), mix(c, a * 0.62 + 0.03, 1.0 - smoothstep(0.008, 0.024, jt)), near);
}
float kitArch(vec2 p, float cx, float hw, float y0, float ys) {
  if (p.y < y0) return 0.0;
  if (p.y < ys) return step(abs(p.x - cx), hw);
  return step(length(p - vec2(cx, ys)), hw);
}
float kitPoint(vec2 p, float cx, float hw, float y0, float ys, float rise) { if (p.y < y0) return 0.0; if (p.y < ys) return step(abs(p.x - cx), hw); float t = (p.y - ys) / rise; return t < 1.0 ? step(abs(p.x - cx), hw * (1.0 - t * t)) : 0.0; }
float kitRect(vec2 p, float bw, float fh, float x0, float x1, float y0, float y1) { float u = fract(p.x / bw), v = fract(p.y / fh); return step(x0, u) * step(u, x1) * step(y0, v) * step(v, y1); }
float kitBars(vec2 p, float sp, float near) { return near * max(step(fract(p.x / sp), 0.14), step(fract(p.y / 0.5), 0.05)); }
`;
const PK_KIT_HEAD = /* glsl */`
float kit = 0.0;
if (fType > 2.99 && fType < 3.49) { float kf = fType - 3.0; if (kf > 0.25) kf -= 0.3; kit = floor(kf / 0.03 + 0.5); }`;
const PK_KIT_WALL = /* glsl */`
  if (kit > 0.5) {
    float kN = 1.0 - smoothstep(0.03, 0.12, max(fw.x, fw.y));              // 1 close up, 0 where masonry joints would shimmer
    float kFl = floor(uvb.y / floorH), kFy = fract(uvb.y / floorH);
    vec2 q0 = uvb + par * 0.18, kid = vec2(0.0);
    float kWin = 0.0, kDeep = 0.0, kBar = 0.0, kRing = 0.0;
    vec3 kRingC = base * 1.12 + 0.04;
    col = base * (0.93 + 0.1 * vnoise(uvb * vec2(0.35, 1.1) + seed * 9.0));
    if (kit < 1.5) {
      // Islamabad sector house: plaster with Margalla stone panels, a stone plinth and floor bands, steel grilles on the windows
      float bw = 6.4 + floor(seed * 3.0) * 0.7, bi = floor(uvb.x / bw), bx = fract(uvb.x / bw), pan = step(mod(bi + floor(seed * 4.0), 2.0), 0.5);
      float stone = max(max(pan * step(bx, 0.4), step(uvb.y, 0.85)), step(kFy, 0.07) * step(0.5, kFl));
      col = mix(col, kitCourse(uvb, vec3(0.25, 0.22, 0.175), vec3(0.42, 0.39, 0.32), 0.62, 0.22, kN), stone);
      kWin = pulse(kFy, 0.26, 0.76, fw.y / floorH) * (pulse(bx, 0.5, 0.92, fw.x / bw) + (1.0 - pan) * pulse(bx, 0.08, 0.42, fw.x / bw));
      kDeep = kitRect(q0, bw, floorH, 0.08, 0.92, 0.26, 0.76);
      kBar = kitBars(uvb, 0.15, kN); kid = vec2(bi, kFl);
    } else if (kit < 2.5) {
      // Bahria: rough cream stucco, round-headed openings with a raised surround, iron across the lower half, a terracotta tile band under the parapet
      float bw = 4.6 + floor(seed * 3.0) * 0.5, bi = floor(uvb.x / bw), cx = (bi + 0.5) * bw, y0 = kFl * floorH + 0.75, ys = y0 + 1.25, hw = 0.78;
      col = base * (0.9 + 0.16 * vnoise(uvb * 2.6 + seed * 3.0));
      kWin = kitArch(uvb, cx, hw, y0, ys); kDeep = kitArch(q0, cx, hw, y0, ys);
      kRing = kitArch(uvb, cx, hw + 0.15, y0 - 0.12, ys) * (1.0 - kWin);
      kBar = kitBars(uvb, 0.2, kN) * step(uvb.y, ys); kid = vec2(bi, kFl);
      float tile = step(bH - 1.2, uvb.y) * step(uvb.y, bH - 0.45), barrel = 0.5 + 0.5 * sin(uvb.x * 6.2832 / 0.24);
      col *= 1.0 - 0.3 * step(bH - 1.42, uvb.y) * step(uvb.y, bH - 1.2);
      col = mix(col, mix(vec3(0.27, 0.11, 0.06), vec3(0.5, 0.22, 0.11), barrel) * (0.85 + 0.3 * vnoise(uvb * 0.7 + seed)), tile);
    } else if (kit < 3.5) {
      // DHA: white box, near floor-height glass, one bay in three clad in grey panels, a dark parapet band
      float bw = 5.4 - floor(seed * 3.0) * 0.7, bi = floor(uvb.x / bw), bx = fract(uvb.x / bw), clad = step(mod(bi + floor(seed * 3.0), 4.0), 0.5);
      vec2 pn = uvb / vec2(1.2, 0.6), pf = fract(pn);
      float jt = kN * (1.0 - smoothstep(0.0, 0.02, min(min(pf.x, 1.0 - pf.x) * 1.2, min(pf.y, 1.0 - pf.y) * 0.6)));
      col = mix(col, mix(vec3(0.15, 0.16, 0.17) * (0.9 + 0.2 * h21(floor(pn) + seed)), vec3(0.04), jt), clad);
      float kBig = step(mod(bi + floor(seed * 5.0), 2.0), 0.5);
      kWin = (1.0 - clad) * pulse(kFy, 0.2, 0.88, fw.y / floorH) * (kBig * pulse(bx, 0.1, 0.9, fw.x / bw) + (1.0 - kBig) * pulse(bx, 0.3, 0.7, fw.x / bw));
      kDeep = kitRect(q0, bw, floorH, 0.1, 0.9, 0.2, 0.88);
      kBar = kN * step(fract(uvb.x / 1.5), 0.04); kid = vec2(bi, kFl);
      col = mix(col, vec3(0.1, 0.105, 0.11), step(bH - 1.1, uvb.y) * step(uvb.y, bH - 0.55));
    } else if (kit < 4.5) {
      // colonial brick (The Mall): brick courses, arched openings in pale stone, pilasters, string courses, a stone cornice
      float kV = floor(seed * 3.0);                                                     // the seed carries the frontage: 0 brick, 1 plaster with pilasters, 2 plaster with pointed arches (tileworker.js pkFacadeKits)
      float bw = kV < 0.5 ? 3.9 : kV < 1.5 ? 4.4 : 3.5, bi = floor(uvb.x / bw), bx = fract(uvb.x / bw), cx = (bi + 0.5) * bw, y0 = kFl * floorH + 0.95, ys = y0 + floorH * 0.42, hw = 0.82;
      if (kV < 0.5) {
        col = kitCourse(uvb, vec3(0.19, 0.075, 0.042), vec3(0.34, 0.14, 0.08), 0.46, 0.16, kN);
        col = mix(col, col * 1.22 + 0.012, max(step(bx, 0.07), step(0.93, bx)));
        kWin = kitArch(uvb, cx, hw, y0, ys); kDeep = kitArch(q0, cx, hw, y0, ys);
        kRing = kitArch(uvb, cx, hw + 0.22, y0 - 0.18, ys) * (1.0 - kWin); kRingC = vec3(0.52, 0.44, 0.31) * (0.9 + 0.15 * vnoise(uvb * 3.0));
        float st = max(max(step(kFy, 0.05) * step(0.5, kFl), step(uvb.y, 0.9)), step(bH - 1.15, uvb.y));
        col = mix(col, vec3(0.5, 0.42, 0.3) * (0.88 + 0.2 * vnoise(uvb * vec2(0.8, 3.0))), st);
        col *= 1.0 - 0.3 * step(bH - 0.8, uvb.y) * step(fract(uvb.x / 0.46), 0.42);       // dentils
      } else if (kV < 1.5) {
        // plaster: pilasters between bays, square-headed windows with a moulded surround, string courses and a plain cornice
        col = base * (0.9 + 0.14 * vnoise(uvb * vec2(0.3, 0.9) + seed * 5.0));
        col = mix(col, base * 1.08 + 0.01, max(step(bx, 0.08), step(0.92, bx)));
        kWin = pulse(bx, 0.26, 0.74, fw.x / bw) * pulse(kFy, 0.2, 0.74, fw.y / floorH); kDeep = kitRect(q0, bw, floorH, 0.26, 0.74, 0.2, 0.74);
        kRing = pulse(bx, 0.2, 0.8, fw.x / bw) * pulse(kFy, 0.14, 0.82, fw.y / floorH) * (1.0 - kWin); kRingC = base * 1.12 + 0.03;
        kBar = kN * max(step(fract(uvb.x / 0.48), 0.06), step(fract(uvb.y / 0.62), 0.05));
        col = mix(col, base * 0.72 + 0.02, max(max(step(kFy, 0.05) * step(0.5, kFl), step(uvb.y, 0.8)), step(bH - 1.0, uvb.y)));
      } else {
        // plaster with pointed arches and a deep shadow under each floor's eave
        float rise = floorH * 0.3;
        col = base * (0.88 + 0.16 * vnoise(uvb * vec2(0.4, 1.2) + seed * 3.0));
        kWin = kitPoint(uvb, cx, hw, y0, ys, rise); kDeep = kitPoint(q0, cx, hw, y0, ys, rise);
        kRing = kitPoint(uvb, cx, hw + 0.2, y0 - 0.16, ys, rise + 0.22) * (1.0 - kWin); kRingC = vec3(0.46, 0.36, 0.24) * (0.9 + 0.15 * vnoise(uvb * 3.0));
        col *= 1.0 - 0.34 * step(kFy, 0.1) * step(0.5, kFl);
        col = mix(col, vec3(0.34, 0.26, 0.17) * (0.9 + 0.2 * vnoise(uvb * 2.0)), max(step(uvb.y, 0.9), step(bH - 0.95, uvb.y)));
      }
      kid = vec2(bi, kFl);
    } else {
      // Murree: plaster and small framed windows; the Mall's older houses add black timbering on the upper storey over stone
      float bw = 3.4 + floor(seed * 3.0) * 0.4, bi = floor(uvb.x / bw), bx = fract(uvb.x / bw), has = step(0.22, h21(vec2(bi, kFl) + seed * 5.0));
      if (kit > 5.5) {
        if (uvb.y > floorH * 0.98) {
          col = vec3(0.68, 0.65, 0.57) * (0.94 + 0.1 * vnoise(uvb * 0.9));
          float ux = uvb.x / 2.2, tm = max(step(fract(ux * 2.0), 0.1), step(fract(uvb.y / (floorH * 0.5)), 0.08));
          float diag = step(abs(fract(ux + uvb.y / floorH) - 0.5), 0.035) * step(floorH * 1.05, uvb.y);
          col = mix(col, vec3(0.05, 0.035, 0.025), max(tm, diag) * max(kN, 0.45));
        } else col = kitCourse(uvb, vec3(0.21, 0.19, 0.155), vec3(0.4, 0.37, 0.3), 0.72, 0.3, kN);
      }
      kWin = has * pulse(bx, 0.3, 0.7, fw.x / bw) * pulse(kFy, 0.28, 0.78, fw.y / floorH);
      kDeep = kitRect(q0, bw, floorH, 0.3, 0.7, 0.28, 0.78);
      kRing = has * pulse(bx, 0.25, 0.75, fw.x / bw) * pulse(kFy, 0.22, 0.84, fw.y / floorH) * (1.0 - kWin); kRingC = kit > 5.5 ? vec3(0.42, 0.4, 0.34) : vec3(0.62, 0.6, 0.53);
      kBar = kN * step(abs(fract(uvb.x / bw) - 0.5), 0.012); kid = vec2(bi, kFl);
    }
    vec3 kGl = mix(vec3(0.1, 0.13, 0.16), vec3(0.27, 0.33, 0.39), h21(kid + seed * 7.0));
    if (kit > 2.5 && kit < 3.5) kGl = mix(kGl, mix(vec3(0.17, 0.12, 0.08), vec3(0.07, 0.15, 0.19), fract(seed * 7.3)), 0.6);   // DHA: tinted glass differs from plot to plot
    kGl = mix(kGl, vec3(0.47, 0.42, 0.32) * (0.85 + 0.2 * sin(uvb.x * 20.0)), step(0.74, h21(kid * 3.1 + seed * 2.0)) * step(kit, 3.5));   // a drawn curtain
    vec3 kFr = fract(seed * 11.0) > 0.55 ? vec3(0.58, 0.56, 0.52) : vec3(0.09, 0.09, 0.1);
    col = mix(col, kRingC, clamp(kRing, 0.0, 1.0));
    col = mix(col, mix(base * 0.55, mix(kGl, kFr, kBar), kDeep), clamp(kWin, 0.0, 1.0));
    glassMask = clamp(kWin, 0.0, 1.0) * kDeep * (1.0 - kBar);
    litMask = glassMask * step(0.45, h21(kid * 2.3 + seed)) * (0.45 + 0.4 * h21(kid + 1.7));
    roomLit = room(q0, vt, 5.5, floorH, 4.0, seed).rgb * glassMask * vec3(1.0, 0.93, 0.8);
    if (kit > 4.5) { litMask = glassMask * step(0.3, h21(kid * 2.3 + seed)) * (0.75 + 0.25 * h21(kid + 1.7)) * (1.0 + 0.9 * smoothstep(0.08, 0.7, max(fw.x, fw.y))); roomLit = vec3(0.92, 0.66, 0.38) * glassMask; }   // Murree after dark: most houses lit and warm, still visible across the valley
  }`;
// Rawalpindi and Lahore shop streets (REVIEW2 item 2, type code x.06 or x.36): small framed windows with steel grilles, rain stains, split air-conditioners, cable runs. All dimensions estimated
const PK_BAZAAR = /* glsl */`
  if (abs(fract(fType) - 0.06) < 0.02 || abs(fract(fType) - 0.36) < 0.02) {
    float zN = 1.0 - smoothstep(0.015, 0.1, max(fw.x, fw.y));                       // 1 close to the wall, 0 where fine lines would shimmer
    float zW = 2.9 + floor(seed * 3.0) * 0.45, zHw = 0.62 + 0.18 * fract(seed * 7.3);
    vec2 zC = vec2(uvb.x / zW, uvb.y / floorH), zId = floor(zC), zF = fract(zC);
    float zY0 = (zId.y < 1.5 ? 0.44 : 0.34) * floorH, zY1 = (zId.y < 1.5 ? 0.86 : 0.8) * floorH;   // the first row sits clear of the shop fascia
    float zX = (zF.x - 0.5) * zW, zFy = zF.y * floorH, zH = h21(zId + seed * 13.0), zHas = step(0.14, h21(zId * 1.7 + seed * 3.0));
    // render: patchy repaints and damp
    vec3 zWall = base * (0.82 + 0.26 * vnoise(uvb * vec2(0.25, 0.7) + seed * 6.0));
    zWall *= 1.0 - 0.28 * smoothstep(0.55, 0.85, vnoise(uvb * vec2(0.09, 0.18) + seed * 17.0));
    // rain: streaks under each sill, down from the parapet, and along the floor slabs
    float zStreak = smoothstep(0.35, 0.72, vnoise(vec2(uvb.x * 5.5, uvb.y * 0.4 + seed * 9.0)));
    float zBelow = zY0 - zFy, zIn = (1.0 - step(zHw + 0.14, abs(zX))) * zHas;
    float zRain = zIn * smoothstep(-0.02, 0.06, zBelow) * (1.0 - smoothstep(0.1, 0.9 + 1.4 * zH, zBelow)) * zStreak;
    zRain += (1.0 - smoothstep(0.0, 2.6, bH - uvb.y)) * 0.65 * zStreak;
    float zSlab = 1.0 - smoothstep(0.0, 0.12, abs(zFy - 0.06));
    zRain += (1.0 - smoothstep(0.0, 0.7, zFy)) * zStreak * 0.22;
    col = zWall * (1.0 - 0.5 * clamp(zRain, 0.0, 1.0));
    col = mix(col, base * 1.08 + 0.015, zSlab * 0.55 * step(0.5, zId.y));
    // frame, sill and the opening itself
    float zOpen = zHas * (1.0 - smoothstep(zHw - fw.x, zHw + fw.x, abs(zX))) * smoothstep(zY0 - fw.y, zY0 + fw.y, zFy) * (1.0 - smoothstep(zY1 - fw.y, zY1 + fw.y, zFy));
    float zFrame = zHas * (1.0 - smoothstep(zHw + 0.1 - fw.x, zHw + 0.1 + fw.x, abs(zX))) * smoothstep(zY0 - 0.12 - fw.y, zY0 - 0.12 + fw.y, zFy) * (1.0 - smoothstep(zY1 + 0.1 - fw.y, zY1 + 0.1 + fw.y, zFy));
    vec2 zQ = uvb + par * 0.18, zCq = vec2(zQ.x / zW, zQ.y / floorH);
    float zQy = fract(zCq.y) * floorH, zDeep = step(abs((fract(zCq.x) - 0.5) * zW), zHw) * step(zY0, zQy) * step(zQy, zY1) * step(abs(floor(zCq.x) - zId.x), 0.1) * step(abs(floor(zCq.y) - zId.y), 0.1);
    col = mix(col, base * 1.14 + 0.05, zFrame * (1.0 - zOpen));
    col *= 1.0 - 0.35 * zIn * step(zBelow, 0.0) * step(-0.05, zBelow);                                   // shadow line under the sill
    vec3 zGlass = mix(vec3(0.07, 0.09, 0.11), vec3(0.2, 0.25, 0.3), h21(zId + seed));
    if (zH > 0.55) zGlass = mix(zGlass, vec3(0.5, 0.42, 0.3) * (0.8 + 0.2 * sin(uvb.x * 22.0)), 0.75);    // a drawn curtain
    float zGr = step(0.3, h21(zId * 2.9 + seed * 5.0)) * zN;
    vec2 zB = uvb - par * 0.05;
    float zBar = zGr * max(step(fract(zB.x / 0.11), 0.22), step(fract(zB.y / 0.36), 0.1));
    col = mix(col, mix(base * 0.42, mix(zGlass, vec3(0.1, 0.1, 0.11), zBar), zDeep), zOpen);
    // split air-conditioner, standing 20 cm proud of the wall below the sill
    vec2 zA = uvb - par * 0.2, zCa = vec2(zA.x / zW, zA.y / floorH), zIa = floor(zCa);
    float zAon = step(0.46, h21(zIa * 3.3 + seed * 2.0)) * step(1.5, zIa.y), zOx = (h21(zIa + 7.0 + seed) - 0.5) * (zW - 1.1), zAx = (fract(zCa.x) - 0.5) * zW - zOx, zAy = fract(zCa.y) * floorH - zY0;
    float zAc = zAon * step(abs(zAx), 0.42) * step(-0.62, zAy) * step(zAy, -0.08);
    float zAsh = zAon * step(abs(zAx), 0.42) * step(-0.8, zAy) * step(zAy, -0.62);
    col *= 1.0 - 0.3 * zAsh;
    vec3 zAcC = vec3(0.72, 0.72, 0.68) * (0.86 + 0.14 * step(0.5, fract(zAy / 0.05)) * zN);
    float zFan = zN * (1.0 - step(0.17, length(vec2(zAx + 0.12, zAy + 0.35))));
    col = mix(col, mix(zAcC, vec3(0.2, 0.2, 0.2) * (0.7 + 0.5 * sin(atan(zAy + 0.35, zAx + 0.12) * 8.0)), zFan), zAc);
    col = mix(col, vec3(0.32, 0.2, 0.12), zN * zAon * step(abs(zAx - 0.34), 0.012) * step(-0.08, zAy) * step(zAy, 0.5));   // the copper pipe up to the room
    // cable runs and a drain pipe
    float zRow = floor(uvb.y / floorH), zCy = uvb.y - zRow * floorH - 0.24 - 0.07 * sin(uvb.x * 0.9 + seed * 20.0);
    float zCab = zN * step(gh + 0.1, uvb.y) * max(step(0.42, h21(vec2(zRow, seed * 9.0))) * (1.0 - step(0.018 + 0.6 * fw.y, abs(zCy))), 1.0 - step(0.018 + 0.6 * fw.x, abs(fract(uvb.x / 8.7 + seed) - 0.5) * 8.7));
    col = mix(col, vec3(0.03, 0.03, 0.035), zCab);
    float zPipe = 1.0 - step(0.04 + 0.5 * fw.x, abs(fract(uvb.x / 11.3 + seed * 3.0) - 0.5) * 11.3);
    col = mix(col, vec3(0.34, 0.34, 0.32), zPipe * step(gh, uvb.y));
    glassMask = zOpen * zDeep * (1.0 - zBar);
    float zLit = step(0.52, h21(zId * 1.3 + seed * 29.0));
    litMask = glassMask * zLit * (0.4 + 0.45 * h21(zId.yx + 1.1));
    roomLit = (zH > 0.55 ? vec3(0.62, 0.5, 0.36) : room(zQ, vt, zW, floorH, 4.0, seed).rgb) * glassMask;
    crown = 0.0;
  }`;
// below the floor line a hill house stands on coursed rubble
const PK_KIT_POST = /* glsl */`
if (!isRoof && kit > 0.5 && uvb.y < (kit > 4.5 ? 0.16 : 0.0)) {
  col = kitCourse(uvb, vec3(0.2, 0.185, 0.15), vec3(0.42, 0.385, 0.31), 0.72, 0.28, 1.0 - smoothstep(0.03, 0.12, max(fw.x, fw.y)));
  glassMask = 0.0; litMask = 0.0; roomLit = vec3(0.0); shopGlow = 0.0; signMask = 0.0;
}`;

// The player's car in Pakistan keeps some paint colour at night (REVIEW2 item 11): a little ambient, strongest on the surfaces facing up to the street lamps. A subclass, so clones keep it.
export class PkNightPaint extends THREE.MeshPhysicalMaterial {
  onBeforeCompile(s) {
    s.uniforms.uNight = U.uNight;
    s.fragmentShader = s.fragmentShader.replace("#include <common>", "#include <common>\nuniform float uNight;").replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.93, 0.82) * uNight * (0.09 + 0.1 * max(0.0, dot(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz))));");
  }
  customProgramCacheKey() { return "pk-night-paint"; }
}

// Pakistan shop interiors (REVIEW3 item 3): the room behind an open front, seen past the near stock cards in signs.js. Goods colours are dull and chosen by what the street sells (the street's trade
// comes from the plot seed, see tileworker pkOldPlots): cloth, tins and sacks, hardware, general stock. All hex values and shares are estimates, in the spirit of art_direction.md section 5.
const pkG3 = h => "vec3(" + [1, 3, 5].map(i => Math.pow(parseInt(h.substr(i, 2), 16) / 255, 2.2).toFixed(3)).join(", ") + ")";
const pkGPick = (list, v) => list.map((h, i) => i < list.length - 1 ? v + " < " + ((i + 1) / list.length).toFixed(3) + " ? " + pkG3(h) + " : " : pkG3(h)).join("");
const PK_GOODS_CLOTH = ["#6b2b2b", "#26344f", "#5a4030", "#b0a288", "#5f6140", "#3f5a58", "#8a7235", "#4f3244", "#7a4a35"];
const PK_GOODS_TINS = ["#9a7a35", "#9c8a40", "#8a7350", "#a89a7c", "#7a2f25", "#3f5a39", "#5a3d25", "#8c6a3a"];
const PK_GOODS_HARD = ["#7f8488", "#3f4348", "#6e4a2f", "#4a5868", "#222326", "#9aa0a0", "#5c5a54"];
const PK_GOODS_GEN = ["#5d4a3b", "#8a6f52", "#44586f", "#7a3a30", "#777053", "#3d3f44", "#a39274", "#2f4a44"];
const PK_SHOP_ROOM = /* glsl */`
  if (kind > 0.5) {
    float sd = fract(seed + 0.63), trade = floor(sd * 4.0);                                // roomK gets seed + 0.37; the plot seed's quarter is the street's trade
    float shade = h21(cell * 1.7 + seed * 5.0), off = step(0.7, shade);                    // about three shops in ten have the lights off inside
    float t1 = h21(cell + 2.3 + seed * 3.0), wide = mix(0.62, 1.1, t1), bandH = mix(0.6, 0.86, fract(t1 * 7.0));
    vec3 cO;
    if (t != ty) {
      // goods on the walls, packs in uneven runs with empty places, the shelf boards dark
      vec2 sp = t == tz ? vec2(hp.x, hp.y) : vec2(hp.z, hp.y);
      float band = floor(sp.y / bandH), pw = wide * (trade < 0.5 ? 0.55 : 1.0) * (0.75 + 0.5 * h21(vec2(band, t1 * 31.0)));
      float pack = floor(sp.x / pw + band * 0.5), v = h21(vec2(pack, band) + r * 7.0);
      float filled = step(0.2, h21(vec2(pack * 1.3 + 9.0, band) + r * 3.0)) * step(0.35, hp.y) * step(hp.y, min(h - 0.5, 2.5)) * step(fract(sp.y / bandH), 0.86);
      vec3 g = trade < 0.5 ? (` + pkGPick(PK_GOODS_CLOTH, "v") + `) : trade < 1.5 ? (` + pkGPick(PK_GOODS_TINS, "v") + `) : trade < 2.5 ? (` + pkGPick(PK_GOODS_HARD, "v") + `) : (` + pkGPick(PK_GOODS_GEN, "v") + `);
      g *= 0.72 + 0.5 * h21(vec2(band, pack) + 3.1 + r);
      cO = mix(t == tz ? vec3(0.12, 0.1, 0.078) : vec3(0.09, 0.075, 0.06), g, filled);
    } else if (rd.y > 0.0) cO = vec3(0.1, 0.09, 0.08) + vec3(0.45, 0.43, 0.38) * step(0.88, fract(hp.z * 0.7 + hp.x * 0.2));   // ceiling and a tube light
    else cO = vec3(0.1, 0.09, 0.075) * (0.85 + 0.3 * vnoise(hp.xz * 3.0));                 // a worn floor
    float depth = clamp(-hp.z / d, 0.0, 1.0);
    return vec4(cO * (1.0 - 0.55 * depth) * mix(1.0, 0.42, off) * (0.72 + 0.38 * smoothstep(0.2, 2.2, hp.y)), depth);
  }
`;

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
  if (gDetail < 0.5) return vec4(vec3(0.5, 0.48, 0.45) * (kind > 0.5 ? ${PK_ROAD ? "0.3" : "1.2"} : 1.0), 0.5);
  vec3 rd = -vt; rd.z = min(rd.z, -0.08);
  vec2 cell = floor(vec2(p.x / w, p.y / h));
  vec3 ro = vec3(p.x - cell.x * w, p.y - cell.y * h, 0.0);
  float tx = rd.x > 0.0 ? (w - ro.x) / max(rd.x, 1e-3) : ro.x / max(-rd.x, 1e-3);
  float ty = rd.y > 0.0 ? (h - ro.y) / max(rd.y, 1e-3) : ro.y / max(-rd.y, 1e-3);
  float tz = d / -rd.z;
  float t = min(min(tx, ty), tz);
  vec3 hp = ro + rd * t;
  float r = h21(cell + seed * 13.0);
${PK_ROAD ? PK_SHOP_ROOM : ""}
  vec3 wallC = mix(vec3(0.72, 0.68, 0.6), vec3(0.62, 0.66, 0.7), step(0.5, r));
  vec3 c = wallC * 0.78;
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
  else ${PK_ROAD ? "if (kind < 0.5)" : ""} c = wallC * 0.78;   // Pakistan keeps the shelves of goods drawn above
  float depth = clamp(-hp.z / d, 0.0, 1.0);
  return vec4(c * (1.0 - 0.45 * depth), depth);
}
${PK_ROAD ? PK_KIT_FN : ""}`)
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
${PK_ROAD ? PK_KIT_HEAD : ""}
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
${PK_ROAD ? "  if (abs(fract(fType) - 0.06) >= 0.02 && abs(fract(fType) - 0.36) >= 0.02) {     // the bazaar kit below redraws the whole wall, so this one is skipped for it" : ""}
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
  col = base * (0.9 + 0.12 * grime) * (1.0 - ${PK_ROAD ? "0.2" : "0.06"} * streak);
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
${PK_ROAD ? "  }" : ""}
${PK_ROAD ? PK_BAZAAR : ""}
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
${PK_ROAD ? PK_KIT_WALL : ""}
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
${PK_ROAD ? "  roofC = mix(vec3(0.27, 0.26, 0.24), vec3(0.4, 0.385, 0.35), n) * (0.82 + 0.3 * seed);   // Pakistan: stained concrete and bitumen, not bright white" : ""}
  if (fType > 9.1 && fType < 9.3) roofC = mix(vec3(0.34, 0.36, 0.38), vec3(0.46, 0.48, 0.5), n);   // tower roof: dark plant deck
  if (fType > 9.3 && fType < 9.5) roofC = ${PK_ROAD ? "mix(vec3(0.36, 0.38, 0.39), vec3(0.45, 0.42, 0.37), n)" : "mix(vec3(0.62, 0.64, 0.66), vec3(0.72, 0.73, 0.74), n)"};   // shed: light metal
  if (fType > 9.5) roofC = base * (0.88 + 0.2 * n);                                                // the roof colour OpenStreetMap gives
${PK_ROAD ? "" : "  if (fType > 9.7) roofC *= 0.86 + 0.14 * step(0.5, fract(uvb.x * 3.0 + uvb.y * 0.3));             // pitched: courses of tiles"}
${PK_ROAD ? "  if (fType > 9.7) { vec2 rsd = normalize(vWN.xz + vec2(1e-4, 0.0)); float ra = dot(uvb, rsd), rb = dot(uvb, vec2(-rsd.y, rsd.x)), ribI = floor(rb / 0.42), ribF = fract(rb / 0.42), rN = 1.0 - smoothstep(0.1, 0.55, max(fw.x, fw.y)); roofC *= 1.0 - 0.18 * rN * smoothstep(0.15, 0.45, abs(ribF - 0.5)); float sheet = floor(ra / 3.1), sF = fract(ra / 3.1), hR = h21(vec2(ribI * 0.37 + seed * 61.0, sheet)), rRun = step(0.74, hR) * smoothstep(0.0, 0.05, sF) * (1.0 - smoothstep(0.12 + 0.7 * hR * hR, 0.96, sF)); roofC = mix(roofC, vec3(0.2, 0.11, 0.06) * (0.75 + 0.5 * hR), rRun * 0.55 * rN); roofC = mix(roofC, vec3(0.2, 0.12, 0.07), (1.0 - rN) * 0.07); }   /* corrugated tin: ribs run down the slope, rust runs from the sheet laps along single ribs (REVIEW2 item 14) */" : ""}
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
  float bay = ${PK_ROAD ? "3.3 + floor(seed * 3.0) * 0.45" : "4.6 + floor(seed * 3.0) * 0.7"};
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
    lt *= step(0.35, fract(uvb.x * 1.7 + floor(uvb.x * 0.6) * 0.37)) * step(0.3, h21(vec2(floor(uvb.x * 1.7), bi)));${PK_ROAD ? " lt = 0.0;  /* Pakistan: the 3D flex boards carry the real lettering */" : ""}
    vec3 ink = board.g > 0.55 ? vec3(0.08, 0.08, 0.1) : vec3(0.97, 0.96, 0.92);
    signC = mix(board, ink, lt);
    signMask = panel;
    col = mix(col, signC, panel);
  }
  vec4 rm = roomK(q, vt, bay, gh - 1.35, 5.0, seed + 0.37, 1.0);
  vec3 shopIn = rm.rgb * vec3(1.0, 0.97, 0.9);
  col = mix(col, mix(base * 0.55, ${PK_ROAD ? "shopIn * 0.8 + vec3(0.03, 0.025, 0.02)" : "vec3(0.03, 0.04, 0.05) + shopIn * 0.12"}, deep), glassF);
${PK_ROAD ? `  // about one shop in seven has its steel shutter down
  float shut = step(0.86, h21(vec2(bi, seed * 11.0))) * glassF;
  if (shut > 0.5) { float ribS = 0.5 + 0.5 * sin(uvb.y * 6.2832 / 0.11); col = mix(vec3(0.31, 0.33, 0.36), vec3(0.21, 0.23, 0.26), ribS) * (0.78 + 0.3 * vnoise(uvb * vec2(0.8, 0.2) + bi)); deep = 0.0; }` : ""}
  glassMask = glassF * deep;
  roomLit = shopIn * glassMask * 1.25;
  litMask = glassMask * step(0.15, h21(vec2(bi, seed * 3.0)));
  shopGlow = litMask;
${PK_ROAD ? "  glassMask = 0.0;   // an open front has no pane to reflect the sky" : ""}
}
${PK_ROAD ? PK_KIT_POST : ""}
diffuseColor.rgb = col;
`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, fType < 0.5 ? 0.06 : 0.12, glassMask);")
      .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, fType < 0.5 ? 0.85 : isRetail > 0.5 && uvb.y < gh ? 0.25 : 0.55, glassMask);")
      .replace("#include <emissivemap_fragment>", /* glsl */`#include <emissivemap_fragment>
vec3 warm = mix(vec3(1.0, 0.8, 0.52), vec3(0.88, 0.94, 1.0), step(0.55, h21(vec2(seed * 37.0, floor(uvb.y / floorH)))));
totalEmissiveRadiance += warm * roomLit * roomLit * litMask * uNight * 1.25;      // squared: dim floors, bright ceilings
totalEmissiveRadiance += roomLit * shopGlow * 0.1 * (1.0 - uNight);                  // shops are lit inside by day too
${PK_ROAD ? "totalEmissiveRadiance += min(roomLit, vec3(0.32)) * shopGlow * uNight * 1.3;    // Pakistan: tube-lit shelves after dark, capped so a street of open shops never blooms white (REVIEW3 item 3)" : ""}
totalEmissiveRadiance += signC * signMask * uNight * ${PK_ROAD ? "0.3" : "0.9"};                             // lit signboards (Pakistan: under the bloom threshold, REVIEW2 item 11)
if (!isRoof && fType < 4.5) totalEmissiveRadiance += vec3(1.0, 0.82, 0.58) * diffuseColor.rgb * uNight * 0.16 * (1.0 - smoothstep(2.0, 12.0, uvb.y)) * (1.0 - glassMask);   // street-lamp spill
// floodlights washing up the facade from the ground at night (some buildings, warm or cool)
if (!isRoof && fType < 6.5 && (fType > 4.5 || fract(seed * 13.7) > 0.55)) {
  bool mosq = fType > 4.5;
  float wash = mosq ? (fType > 5.5 ? 0.75 : 1.0 - 0.6 * smoothstep(0.0, bH + 2.0, uvb.y)) : (1.0 - smoothstep(0.0, mix(12.0, 30.0, fract(seed * 3.3)), uvb.y)) * (0.55 + 0.45 * pulse(uvb.x / 6.0, 0.15, 0.85, fwidth(uvb.x) / 6.0));
  vec3 washC = mosq ? vec3(0.95, 0.97, 1.0) : fract(seed * 7.9) > 0.35 ? vec3(1.0, 0.82, 0.55) : vec3(0.75, 0.85, 1.0);
  totalEmissiveRadiance += diffuseColor.rgb * washC * wash * uNight * 0.55 * (1.0 - glassMask);
}
vec3 crownC = seed < 0.3 ? vec3(0.55, 0.8, 1.0) : seed < 0.5 ? vec3(1.0, 0.95, 0.85) : seed < 0.7 ? vec3(0.75, 0.55, 1.0) : seed < 0.85 ? vec3(1.0, 0.78, 0.4) : vec3(0.5, 1.0, 0.85);
totalEmissiveRadiance += crownC * crown * uNight * ${PK_ROAD ? "0.55" : "1.3"};
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
${PK_ROAD ? `// district in the fraction of the class: 1 Islamabad, 2 Rawalpindi and Lahore, 3 Murree, 4 motorway, 0 elsewhere (art_direction.md section 1, estimated)
float zd = floor(fract(cls + 1e-3) * 10.0 + 0.5);
if (cls < 6.5) { vec3 a0 = zd < 1.5 && zd > 0.5 ? vec3(0.05) : zd > 3.5 ? vec3(0.063, 0.061, 0.069) : vec3(0.076, 0.070, 0.063); vec3 a1 = zd < 1.5 && zd > 0.5 ? vec3(0.102, 0.098, 0.091) : zd > 3.5 ? vec3(0.117, 0.112, 0.107) : vec3(0.147, 0.130, 0.105); asph = mix(a0, a1, smoothstep(0.25, 0.8, n2 + (n1 - 0.5) * 0.25)) * (0.94 + 0.12 * n1) * 1.35 + 0.012 * n3; }
float wearK = zd < 1.5 && zd > 0.5 ? 0.2 : zd > 1.5 && zd < 2.5 ? 0.6 : zd > 2.5 && zd < 3.5 ? 0.45 : zd > 3.5 ? 0.15 : 0.9;` : ""}
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
  if (cls > 1.5 && cls < 5.5) { float g2 = 1.0 - smoothstep(0.32, 0.36, min(u, W - u)); asph = mix(asph, ${PK_ROAD ? "vec3(0.18, 0.175, 0.16)" : "vec3(0.5, 0.49, 0.46)"}, g2 * (oneway ? step(W * 0.5, u) : 1.0)); }
}
float mark = 0.0; vec3 markC = vec3(0.92);
float dJ = min(vJunc.x - vJunc.z, vJunc.y - vJunc.w);                 // metres clear of the nearest junction disc
float fw = max(fwidth(u), 1e-3), fv = max(fwidth(v), 1e-3);
if (!disc && cls < 6.5) {
  float clear = smoothstep(0.5, 2.5, dJ);
  float lineW = ${PK_ROAD ? "cls < 1.5 ? 0.15 : 0.1" : "0.15"};
  // edge lines: UAE style, yellow on the left (median) edge of a one-way carriageway, white on the right
  float le = 1.0 - smoothstep(lineW * 0.5, lineW * 0.5 + fw, abs(u - 0.35));
  float re = 1.0 - smoothstep(lineW * 0.5, lineW * 0.5 + fw, abs(u - (W - 0.35)));
  if (cls < 3.5 || oneway) {
    mark = max(mark, re * clear);
    if (oneway) { ${PK_ROAD ? "" : "if (le * clear > 0.0) { markC = mix(markC, vec3(0.95, 0.72, 0.1), le); }"} mark = max(mark, le * clear); }
    else mark = max(mark, le * clear);
  }
  // lane dividers: dashed
  float dashL = cls < 1.5 ? 4.0 : 3.0, gapL = cls < 1.5 ? 8.0 : 6.0;
  float dash = pulse(v / (dashL + gapL), 0.0, dashL / (dashL + gapL), fv / (dashL + gapL));
  for (int k = 1; k < 8; k++) {
    if (float(k) >= lanes) break;
    float lu = float(k) * lw;
    float lm = 1.0 - smoothstep(${PK_ROAD ? "0.05, 0.05 + fw" : "0.06, 0.06 + fw"}, abs(u - lu));
    bool centre = !oneway && abs(lu - W * 0.5) < 0.1;
    float pat = centre && cls < 2.5 ? 1.0 : dash;                     // solid centre line on big two-way roads
${CN_ROADS ? `    if (centre) {                                                     // China: yellow centre line, double solid on main roads, dashed on side streets
      float l2 = 1.0 - smoothstep(0.06, 0.06 + fw, abs(abs(u - lu) - 0.18));
      float cm = (cls < 3.5 ? l2 : lm * dash) * clear;
      if (cm > 0.0) markC = mix(markC, vec3(0.95, 0.72, 0.1), cm);
      mark = max(mark, cm); continue;
    }` : ""}
${PK_ROAD ? `    if (centre && zd > 2.5 && zd < 3.5) { float ym = lm * clear; if (ym > 0.0) markC = mix(markC, vec3(0.76, 0.43, 0.02), ym); mark = max(mark, ym); continue; }   // Murree: solid yellow centre line (no overtaking in the hills)` : ""}
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
${PK_ROAD ? `  // paint wears off in patches, whole segments go missing in Rawalpindi, and lines fade out with distance so far hills do not carry white threads
  { float wn = vnoise(wp * 0.13) * 0.65 + vnoise(wp * 1.7) * 0.35, gone = smoothstep(1.0 - wearK * 0.95, 1.0 - wearK * 0.95 + 0.14, wn); float seg = step(0.55 * step(1.5, zd) * step(zd, 2.5) + 2.0 * step(zd, 0.5) * 0.45, h21(vec2(floor(v / 11.0), floor(u / 1.5))) + 0.25);
    float fresh = 1.0 - clamp(wn * wearK * 1.5, 0.0, 1.0); markC = mix(markC * vec3(0.72, 0.72, 0.68), markC * vec3(0.9, 0.89, 0.85), fresh); mark *= (1.0 - gone * 0.9) * mix(1.0, seg, smoothstep(1.5, 2.0, zd) * (1.0 - smoothstep(2.0, 2.5, zd)));
    mark *= 1.0 - smoothstep(420.0, 1100.0, length(cameraPosition - vWP)); }` : ""}
}
diffuseColor.rgb = mix(asph, markC, clamp(mark, 0.0, 1.0));
// night: street lamps every 42 m pool warm light on the carriageway
float pool = 0.0;
if (cls < 4.5) { float ph = fract(v / 42.0); pool = 0.35 + 0.65 * exp(-pow((ph - 0.5) * 5.0, 2.0)); }
else if (cls < 6.5) pool = 0.25;
${PK_ROAD ? "if (mod(floor(flags / 4.0), 2.0) > 0.5) pool = 0.0;   // M-2 away from interchanges and service areas: no lamps stand there (tileworker.js sets bit 2)" : ""}
`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(0.93, 0.6, clamp(mark, 0.0, 1.0));")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += uLampTint * diffuseColor.rgb * pool * uNight * 1.1 + markC * clamp(mark,0.0,1.0) * uNight * 0.02 + vec3(1.0, 0.95, 0.85) * diffuseColor.rgb * headPool(vWP) * 1.8;");
  };
  m.customProgramCacheKey = () => "uae-road-v4";
  return m;
}

// Sidewalks, curbs, barriers: vertex colour; curbs (uv.y = 1) get painted stripes.
// Pakistan kerbs: 1.0 m bands. uv.y picks the paint: 1.2 yellow and black, 1.0 black and white, 0.8 bare worn concrete (art_direction.md, estimated)
const PK_KERB = `(vUvW.y > 1.1 ? mix(vec3(0.012, 0.012, 0.012), vec3(0.8, 0.5, 0.012), step(0.5, fract(vUvW.x / 2.0))) * (0.72 + 0.34 * vnoise(vWPW.xz * 0.7)) : vUvW.y > 0.9 ? mix(vec3(0.012, 0.012, 0.012), vec3(0.72, 0.71, 0.66), step(0.5, fract(vUvW.x / 2.0))) * (0.62 + 0.42 * vnoise(vWPW.xz * 0.7)) : vec3(0.24, 0.23, 0.205) * (0.8 + 0.42 * vnoise(vWPW.xz * 1.3)))`;
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
${PK_ROAD ? `if (vUvW.y > 4.5) { float sr = floor(vWPW.y / 0.3), su = vUvW.x / 0.72 + 0.5 * mod(sr, 2.0); vec2 sid = vec2(floor(su), sr); diffuseColor.rgb *= 0.74 + 0.48 * h21(sid * 1.3 + 2.0); float sf = fract(su), sy = fract(vWPW.y / 0.3); diffuseColor.rgb *= 0.58 + 0.42 * smoothstep(0.012, 0.04, min(min(sf, 1.0 - sf) * 0.72, min(sy, 1.0 - sy) * 0.3)); }
else if (vUvW.y > 3.5) { float gw = fwidth(vUvW.x) / 0.15; if (gw < 0.45 && fract(vUvW.x / 0.15) > 0.2) discard; if (gw >= 0.45 && mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 2.0) < 1.0) discard; }
else ` : ""}if (vUvW.y > 2.5) { diffuseColor.rgb = vec3(0.95, 0.93, 0.88); tunnelLight = 1.0; }
else if (vUvW.y > 0.5 && vUvW.y < 1.5) {
  float s = step(0.5, fract(vUvW.x / 1.0));
  diffuseColor.rgb = ${CN_ROADS ? "vec3(0.62, 0.61, 0.58) * (0.94 + 0.06 * s)" : PK_ROAD ? PK_KERB : "mix(vec3(0.02, 0.02, 0.02), vec3(0.85, 0.85, 0.82), s)"};      // Shanghai: plain granite kerbs
} else if (vUvW.y < 0.5) {
  // paving slabs
  vec2 t = vWPW.xz / 0.6; vec2 f = abs(fract(t) - 0.5);
  float joint = smoothstep(0.46, 0.5, max(f.x, f.y));
  diffuseColor.rgb *= (0.93 + 0.08 * h21(floor(t))) * (1.0 - 0.12 * joint);
} else {
  diffuseColor.rgb *= 0.92 + 0.08 * vnoise(vWPW.xz * 0.5 + vWPW.y);
}
${PK_ROAD ? "// pale paving must not read as a white thread on a far hillside\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.11, 0.105, 0.09), smoothstep(180.0, 900.0, distance(vWPW, cameraPosition)) * 0.85);" : ""}
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

// The real ground (Pakistan): slope, height and noise pick plains, scrub, pine and rock; a per-tile picture
// paints the mapped parks, farmland and built-up areas over it. far = the distance rings, which do not
// draw inside uNearR (the detailed tiles win there) and sink a little at their inner edge so they cannot
// poke through the near ground.
// Latitude and longitude of world (0, 0): the floating origin moves, the map does not. Atmosphere.update keeps it current.
export const TERR_GEO = { value: new THREE.Vector2(33.6938, 73.0652) };
// Shader helpers for the Pakistan ground. All take stable map metres (gp), so near tiles and the distance rings agree and the pattern holds still when the origin moves.
const TERR_FN = /* glsl */`
// a plot on a wandering grid that turns from block to block: x, y = its hashes, z = metres to its edge, w = along its furrows
vec4 plotAt(vec2 g, float rowH, float len) {
  vec2 w = g + (vec2(vnoise(g * 0.0034), vnoise(g.yx * 0.0029 + 7.3)) - 0.5) * 90.0, blk = floor(w / 1730.0);
  float a = h21(blk + 11.0) * 3.1416, ca = cos(a), sa = sin(a);
  vec2 q = vec2(ca * w.x + sa * w.y, ca * w.y - sa * w.x);
  float rid = floor(q.y / rowH), rh = h21(vec2(rid * 1.37, blk.x * 3.1 + blk.y * 7.7));
  float L = len * (0.6 + 0.9 * rh), qx = q.x + rh * 731.0, cid = floor(qx / L);
  vec2 f = vec2(qx / L - cid, q.y / rowH - rid);
  float d = min(min(f.x, 1.0 - f.x) * L, min(f.y, 1.0 - f.y) * rowH), u = h21(vec2(rid, cid) + blk * 13.1), v = h21(vec2(cid * 1.7, rid * 0.9) + blk);
  return vec4(u, v, d, v < 0.5 ? q.x : q.y);
}
// one round bush or crown per cell, some cells empty
float clumpAt(vec2 g, float cell, float dens) {
  vec2 c = floor(g / cell), f = fract(g / cell) - 0.5, j = (vec2(h21(c + 1.7), h21(c + 9.2)) - 0.5) * 0.5;
  float r = 0.2 + 0.22 * h21(c + 4.1), ragged = (vnoise(g * 0.9) - 0.5) * 0.22 + (vnoise(g * 0.31 + 3.0) - 0.5) * 0.16;
  return step(h21(c + 6.6), dens) * (1.0 - smoothstep(r * 0.45, r, length(f - j) + ragged));
}
`;
export function makeTerrainMaterial(opts = {}) {
  const far = !!opts.far;
  // world metres are web-mercator metres times K, about an origin that moves: gO adds that origin back
  const K_T = Math.cos(((typeof window !== "undefined" && window.CITY && window.CITY.kLat) || 33.7) * Math.PI / 180), MK = (6378137 * K_T).toFixed(3), LK = (Math.PI / 180 * 6378137 * K_T).toFixed(4), MREF = Math.log(Math.tan(Math.PI / 4 + 33 * Math.PI / 360)).toFixed(8);
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.97, metalness: 0 });
  const holes = opts.holes || null, HOLES = holes ? `uniform vec4 uHoles[${holes.v.length}]; uniform int uHoleN; bool inHole(vec2 p) { for (int i = 0; i < uHoleN; i++) { vec4 q = uHoles[i]; if (p.x > q.x && p.x < q.z && p.y > q.y && p.y < q.w) return true; } return false; }\n` : "";
  const ux = { uSplat: { value: opts.splat || null }, uTrail: { value: opts.trail || null }, uTS: { value: opts.ts || 2219 }, uNoiseOff: { value: new THREE.Vector2(opts.ox || 0, opts.oz || 0) }, uNearR: { value: opts.nearR || 0 }, ...(holes ? { uHoles: { value: holes.v }, uHoleN: holes.n } : {}), uGeo0: TERR_GEO };
  m.userData.tu = ux;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, ux); sh.uniforms.uNight = U.uNight; cutUniforms(sh);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>
uniform float uNearR; uniform vec2 uNoiseOff; varying vec3 vWPT; varying vec3 vWNT; varying vec2 vLPT; varying vec2 vNP; varying float vCut; float sinkF = 0.0;
${HOLES}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
${far ? `{ vec3 wpF = (modelMatrix * vec4(transformed, 1.0)).xyz; float sink = ${holes ? "20.0 * (1.0 - smoothstep(uNearR, uNearR + 2500.0, distance(wpF.xz, cameraPosition.xz)))" : "420.0 * (1.0 - smoothstep(uNearR, uNearR + 3000.0, distance(wpF.xz, cameraPosition.xz)))"}; ${holes ? "if (inHole(wpF.xz)) sink = 0.0;" : ""} transformed.y -= sink; sinkF = sink; }` : ""}`)
      .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>
vWPT = (modelMatrix * vec4(transformed, 1.0)).xyz; vWPT.y += sinkF; vWNT = normalize(mat3(modelMatrix) * normal); vLPT = transformed.xz; vNP = transformed.xz + uNoiseOff; vCut = max(0.0, length(normal) - 1.0) * 6.0;`);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
uniform float uNight; uniform float uNearR; uniform float uTS; uniform vec2 uGeo0; ${far ? "" : "uniform sampler2D uSplat; uniform sampler2D uTrail;"} varying vec3 vWPT; varying vec3 vWNT; varying vec2 vLPT; varying vec2 vNP; varying float vCut;
${HOLES}` + HASH + CUTS + TERR_FN)
      .replace("#include <color_fragment>", `#include <color_fragment>
${far ? (holes ? "if (length(vWPT.xz - cameraPosition.xz) < uNearR && !inHole(vWPT.xz)) discard;" : "if (length(vWPT.xz - cameraPosition.xz) < 3600.0) discard;") : "if (inCut(vWPT + vec3(0.0, 0.1, 0.0))) discard;"}
vec3 Nt = normalize(vWNT);
float sl = 1.0 - clamp(Nt.y, 0.0, 1.0), e = vWPT.y;
vec2 p = ${far ? "vWPT.xz" : "vNP"};
float n1 = vnoise(p * 0.0021), n2 = vnoise(p * 0.014), n3 = vnoise(p * 0.09), n4 = vnoise(p * 0.55);
float geoLat = uGeo0.x - vWPT.z / 110000.0, geoLon = uGeo0.y + vWPT.x / 92500.0;
float salt = clamp((1.0 - abs(geoLat - 32.72) / 0.26) * 2.4, 0.0, 1.0);   // the Salt Range corridor of the M-2, by latitude
float marg = smoothstep(33.66, 33.72, geoLat) * (1.0 - smoothstep(33.84, 33.9, geoLat)) * (1.0 - smoothstep(73.24, 73.3, geoLon));   // the Margalla Hills
vec3 soil = mix(vec3(0.30, 0.22, 0.13), vec3(0.20, 0.16, 0.10), n2);
vec3 crop = mix(vec3(0.10, 0.17, 0.05), vec3(0.23, 0.24, 0.09), n3);
vec3 low = mix(soil, crop, smoothstep(0.35, 0.72, n1 + (n2 - 0.5) * 0.45) * 0.85);
// Margalla scrub: dark olive and dry, paler on the sunny south faces and in winter patches, darkest in the folds
float sunny = clamp(Nt.z * 1.7 + 0.42, 0.0, 1.0);
vec3 scrub = mix(vec3(0.046, 0.054, 0.025), vec3(0.122, 0.112, 0.052), smoothstep(0.2, 0.8, n3 * 0.6 + n4 * 0.4));
float paleS = smoothstep(0.38, 0.86, n1 * 0.55 + n2 * 0.22 + n4 * 0.08 + sunny * 0.32);
scrub = mix(scrub, vec3(0.255, 0.215, 0.122), paleS * (0.45 + 0.4 * n3));
scrub *= mix(0.62, 1.08, smoothstep(0.28, 0.82, n2 * 0.65 + sunny * 0.35));
vec3 forest = mix(vec3(0.024, 0.052, 0.026), vec3(0.046, 0.08, 0.036), n4 * 0.5 + n2 * 0.5);
vec3 rock = mix(vec3(0.31, 0.29, 0.26), vec3(0.15, 0.145, 0.135), smoothstep(0.25, 0.75, n3));        // Margalla limestone: grey, weathering pale
scrub = mix(scrub, mix(vec3(0.042, 0.078, 0.03), vec3(0.235, 0.22, 0.18), smoothstep(0.62, 0.9, n1 * 0.4 + n2 * 0.34 + n3 * 0.14 + sunny * 0.16)), marg * 0.72);   // chir on the Margallas, weathered limestone showing through
rock = mix(rock, vec3(0.3, 0.285, 0.25) * (0.82 + 0.3 * n3), marg);
float up = smoothstep(480.0 + n2 * 120.0, 760.0 + n2 * 120.0, e);
vec3 land = mix(low, scrub, up);
float pine = smoothstep(980.0 + 220.0 * n1, 1420.0 + 220.0 * n1, e) * smoothstep(0.12, 0.5, n2 + n1 * 0.3);
pine = max(pine, smoothstep(1250.0, 1500.0, e + (n2 - 0.5) * 160.0) * smoothstep(33.7, 33.76, geoLat) * (1.0 - 0.3 * smoothstep(0.6, 0.85, n3)));   // brief section 7: closed forest above 1,300 m
vec2 gO = vec2((uGeo0.y - 73.0) * ${LK}, -(log(tan(0.78539816 + uGeo0.x * 0.00872665)) - ${MREF}) * ${MK});
vec2 gp = vWPT.xz + gO;
float fw = length(fwidth(gp)) + 1e-3;
if (pine > 0.002) {
  float crown = mix(clumpAt(gp, 9.0, 0.85) * 0.75 + clumpAt(gp + 41.0, 5.5, 0.6) * 0.45, 0.42, smoothstep(2.0, 8.0, fw));
  vec3 lit = mix(vec3(0.095, 0.135, 0.05), vec3(0.06, 0.11, 0.07), smoothstep(1500.0, 2000.0, e));          // yellow-green chir below, blue-green blue pine and deodar above
  vec3 canopy = mix(forest * 0.72, lit, crown) * (0.86 + 0.28 * n2);
  vec3 floorF = mix(vec3(0.075, 0.062, 0.036), vec3(0.06, 0.085, 0.036), smoothstep(0.35, 0.7, n3 * 0.5 + n4 * 0.5)) * (0.8 + 0.4 * n4);     // needle litter and low green under the trees
  forest = mix(floorF, canopy, smoothstep(240.0, 460.0, distance(vWPT, cameraPosition)));                    // the instanced trees end at about 370 m
}
land = mix(land, forest, pine);
// the slopes of the Murree road below the closed forest: chir and scrub (brief section 7), as clumps near the road and a mottle further out, with dry earth between them
float murC = smoothstep(33.70, 33.74, geoLat) * (1.0 - smoothstep(33.98, 34.02, geoLat)) * smoothstep(73.18, 73.22, geoLon) * (1.0 - smoothstep(73.52, 73.56, geoLon)) * smoothstep(560.0, 680.0, e) * (1.0 - smoothstep(1150.0, 1400.0, e + (n2 - 0.5) * 80.0));
if (murC > 0.002) {
  float dC = 0.3 + 0.5 * smoothstep(0.3, 0.7, n1 * 0.5 + n2 * 0.5), cC = max(clumpAt(gp, 8.0, dC), clumpAt(gp + 29.0, 4.2, dC * 0.9) * 0.8);
  cC = mix(cC, dC * 0.55, smoothstep(2.5, 9.0, fw));
  land = mix(land, vec3(0.2, 0.155, 0.095) * (0.8 + 0.4 * n3), murC * (1.0 - cC) * 0.4);
  land = mix(land, mix(vec3(0.07, 0.1, 0.038), vec3(0.125, 0.15, 0.055), n3), murC * cC * 0.9);
}
float rk = smoothstep(0.10, 0.30, sl + (n2 - 0.5) * 0.14 + (n3 - 0.5) * 0.12 + (n4 - 0.5) * 0.05);
rk = max(rk, 0.75 * smoothstep(0.62, 0.8, n2) * smoothstep(0.05, 0.16, sl));   // outcrops on the steeper ground
land = mix(land, rock, rk * (1.0 - pine * 0.75));
land *= 0.9 + 0.2 * n4;
float potohar = smoothstep(32.46, 32.6, geoLat) * (1.0 - smoothstep(33.42, 33.54, geoLat)), plainsK = 1.0 - smoothstep(32.36, 32.52, geoLat);
float dryK = max(salt * 0.85, potohar * 0.8 * (1.0 - marg));
vec3 dry = mix(vec3(0.27, 0.19, 0.11), vec3(0.445, 0.33, 0.19), smoothstep(0.25, 0.8, n3 * 0.6 + n4 * 0.4)) * (0.85 + 0.3 * n2);
if (dryK > 0.002 || plainsK > 0.002) {
  float steep = smoothstep(0.05, 0.14, sl);
  vec3 bare = dry;
  // dry scrub on the tops and bare ground: phulai and kikar, as clumps near the road and as a mottle further out (brief sections 7 and 8)
  float dens = (0.14 + 0.5 * smoothstep(0.38, 0.72, n1 * 0.5 + n2 * 0.5)) * (1.0 - steep * 0.8);
  float cl = max(clumpAt(gp, 7.5, dens), clumpAt(gp + 37.0, 3.6, dens * 1.3) * 0.85);
  cl = mix(cl, dens * 0.34, smoothstep(2.5, 9.0, fw));
  bare = mix(bare, mix(vec3(0.075, 0.095, 0.034), vec3(0.135, 0.15, 0.058), n3), cl * 0.92);
  // gullies of the Potohar: a meandering channel with side branches, a dark floor and a pale eroded rim
  float gullyZ = potohar * (1.0 - plainsK) * smoothstep(0.42, 0.72, vnoise(gp * 0.0013 + 31.0)) * (1.0 - smoothstep(60.0, 240.0, fw)), rim = 0.0;
  if (gullyZ > 0.002) {
    vec2 gq = gp + (vec2(vnoise(gp * 0.0071), vnoise(gp.yx * 0.0063 + 3.1)) - 0.5) * 110.0;
    float ga = abs(vnoise(gq * 0.0115) - 0.5) * 2.0, gb = abs(vnoise(gq * 0.034 + 9.0) - 0.5) * 2.0;
    float gully = max(1.0 - smoothstep(0.0, 0.05, ga), (1.0 - smoothstep(0.0, 0.1, gb)) * (1.0 - smoothstep(0.08, 0.36, ga)) * 0.8);
    rim = (1.0 - smoothstep(0.03, 0.17, ga)) * gullyZ;
    bare = mix(bare, vec3(0.571, 0.407, 0.216) * (0.8 + 0.3 * n4), rim * 0.6);
    bare = mix(bare, vec3(0.13, 0.095, 0.06), gully * gullyZ);
  }
  land = mix(land, bare, max(dryK, plainsK * 0.7));
  // field patches (brief section 7): small rainfed plots on the Potohar, bigger irrigated ones on the plains
  float cityBox = min(min(geoLat - 31.36, 31.7 - geoLat), min(geoLon - 74.1, 74.54 - geoLon));
  float agri = (1.0 - smoothstep(0.016, 0.05, sl + (n3 - 0.5) * 0.012)) * (1.0 - smoothstep(780.0, 940.0, e)) * (1.0 - smoothstep(33.42, 33.54, geoLat)) * (1.0 - smoothstep(0.0, 0.05, cityBox)) * (1.0 - rim) * (1.0 - marg);
  agri *= 1.0 - smoothstep(0.0, 0.02, min(geoLat - 32.59, 32.75 - geoLat));         // brief section 7: the Salt Range itself is scrub, and the flat motorway corridor must not read as a field through it
  agri = smoothstep(0.42, 0.62, agri);                                               // a plot is ploughed or it is not: no see-through plots on the slopes
  if (agri > 0.002) {
    vec4 pl = plotAt(gp + plainsK * 400.0, mix(88.0, 150.0, plainsK), mix(135.0, 240.0, plainsK));
    float wet = vnoise(gp * 0.0009 + 5.0), green = mix(0.26 + 0.34 * wet, 0.56 + 0.26 * wet, plainsK);
    vec3 wheat = mix(vec3(0.159, 0.356, 0.044), vec3(0.2, 0.27, 0.09), 0.3 + 0.3 * n2) * 0.72, fallow = vec3(0.397, 0.266, 0.147), soil = mix(vec3(0.445, 0.27, 0.122), vec3(0.27, 0.174, 0.098), plainsK);
    vec3 fc = mix(soil, fallow, step(0.45, pl.y));                                   // ploughed or resting
    fc = mix(fc, vec3(0.61, 0.423, 0.107) * 0.82, step(0.86, pl.y));                 // the last of the ripe crop
    if (pl.x < green) { fc = wheat; if (plainsK > 0.5) { if (pl.y > 0.74) fc = vec3(0.105, 0.258, 0.042) * 0.9; else if (pl.y > 0.5) fc = vec3(0.191, 0.413, 0.07) * 0.78; } }   // young wheat, with cane and paddy on the plains
    fc *= (0.84 + 0.3 * pl.y) * (0.82 + 0.36 * vnoise(gp * 0.05 + 9.0));
    float near1 = 1.0 - smoothstep(0.25, 1.0, fw);
    fc *= 1.0 - 0.13 * near1 * (0.5 + 0.5 * sin(pl.w * 4.1));                        // furrows
    fc = mix(fc, mix(wheat, fallow, 0.6 - 0.3 * plainsK) * (0.8 + 0.4 * n2), smoothstep(16.0, 60.0, fw));   // far away the plots blend, so they do not shimmer
    float bund = (1.0 - smoothstep(0.7, 1.7 + fw * 0.8, pl.z)) * (1.0 - smoothstep(4.0, 24.0, fw));
    fc = mix(fc, mix(vec3(0.3, 0.23, 0.14), vec3(0.12, 0.14, 0.06), pl.y) * (0.9 + 0.2 * n4), bund * 0.75);     // earth banks, some with weeds on
    land = mix(land, fc, agri * step(pl.x, 0.93 + 0.07 * plainsK));                  // the odd plot is left to scrub
  }
}
${far ? "" : "vec4 sp = texture2D(uSplat, vLPT / uTS); float spa = clamp(sp.a * (1.0 + (n2 - 0.5) * 0.9 + (n3 - 0.5) * 0.7) - (1.0 - sp.a) * (n3 - 0.35) * 0.5, 0.0, 1.0); land = mix(land, sp.rgb * (0.8 + 0.4 * n3 * n4 + 0.14 * n2), spa); land = mix(land, dry * (0.82 + 0.2 * n3), dryK * 0.85 * spa * smoothstep(0.01, 0.05, sp.g - sp.r)); float urbDist = distance(vWPT, cameraPosition); if (urbDist < 420.0) { float cmax = max(sp.r, max(sp.g, sp.b)), urb = spa * (1.0 - smoothstep(0.03, 0.12, cmax - min(sp.r, min(sp.g, sp.b)))) * (1.0 - smoothstep(280.0, 420.0, urbDist)); if (urb > 0.02) { vec2 c5 = floor(p / 3.2); float pick = h21(c5 * 0.37), fw5 = fwidth(p.x) + 1e-3; vec2 f5 = abs(fract(p / 3.2) - 0.5); float joint = smoothstep(0.47, 0.5, max(f5.x, f5.y)) * (1.0 - smoothstep(0.12, 0.4, fw5)); vec2 t6 = fract(p / 0.6) - 0.5; float tile = step(0.72, pick) * step(max(abs(t6.x), abs(t6.y)), 0.46); vec3 pv = land * (0.82 + 0.3 * n3) * (1.0 - 0.28 * joint); pv = mix(pv, land * vec3(1.12, 1.08, 1.0) * (0.92 + 0.14 * h21(floor(p / 0.6))), tile * (1.0 - smoothstep(0.12, 0.4, fw5))); pv = mix(pv, land * vec3(0.92, 0.82, 0.68), smoothstep(0.55, 0.8, n2 * 0.6 + n4 * 0.4) * 0.6); pv *= 1.0 - 0.28 * smoothstep(0.62, 0.82, n4) * n3; land = mix(land, pv, urb); } } float tr = texture2D(uTrail, vLPT / uTS).r; float trD = distance(vWPT, cameraPosition); tr *= 1.0 - smoothstep(90.0, 620.0, trD); tr *= smoothstep(0.08, 0.62, tr + (n4 - 0.5) * 0.55); land = mix(land, mix(vec3(0.26, 0.20, 0.135), vec3(0.34, 0.285, 0.20), n3), tr * 0.72);"}
${far ? "" : `// a face the road was cut through: bedded rock with fractures and a little scrub. vCut is how far the ground was lowered here, from terrain.js
float cutM = smoothstep(1.2, 3.5, vCut) * smoothstep(0.05, 0.13, sl + (n3 - 0.5) * 0.03) * (1.0 - 0.8 * smoothstep(1.2, 5.0, fw));
if (cutM > 0.003) {
  float bedC = (e + 11.0 * vnoise(gp * 0.021) + 2.4 * (n3 - 0.5)) * 0.4, pkC = vnoise(vec2(bedC, 1.7)), thC = vnoise(vec2(bedC * 3.1 + 7.0, 4.3));
  vec3 cutR = mix(vec3(0.098, 0.046, 0.038), vec3(0.2, 0.142, 0.118), smoothstep(0.26, 0.72, pkC + (thC - 0.5) * 0.3));   // brief section 8, Murree Formation: claystone #6E3B36 and sandstone #8A6F6A, weathered and dusted down so a sunlit face is not pink
  cutR = mix(cutR, vec3(0.145, 0.092, 0.075), smoothstep(0.5, 2.0, fwidth(bedC)));
  cutR *= (0.8 + 0.34 * n4) * (0.82 + 0.34 * smoothstep(0.32, 0.7, vnoise(vec2(dot(gp, vec2(0.71, 0.71)) * 0.42, e * 0.06))));
  float cutS = clumpAt(gp + 13.0, 3.1, 0.14 + 0.3 * n2) * (1.0 - smoothstep(0.1, 0.24, sl));
  cutR = mix(cutR, mix(vec3(0.06, 0.085, 0.032), vec3(0.11, 0.125, 0.05), n3), cutS * 0.9);
  land = mix(land, cutR, cutM * (0.62 + 0.3 * smoothstep(0.3, 0.7, n2)));
}`}
if (salt > 0.002) {
  // rock only on steep faces, in beds that dip and fold across the hills rather than following the height: red clay and grey sandstone (brief, section 8)
  float face = smoothstep(0.075, 0.17, sl + (n2 - 0.5) * 0.05 + (n3 - 0.5) * 0.02);
  face *= 0.3 + 0.7 * smoothstep(0.3, 0.65, n2 * 0.4 + n3 * 0.4 + n4 * 0.1 + sl * 1.6);          // dust and scrub lie on the gentler parts, so the rock comes through in ribs
  if (face > 0.003) {
    float bed = e * 0.6 + 420.0 * vnoise(gp * 0.0011) + 90.0 * vnoise(gp * 0.0051 + 17.0) + (n3 - 0.5) * 5.0;
    float s0 = bed * 0.032; s0 += 1.3 * vnoise(vec2(s0 * 0.37, 2.2));                         // beds of very uneven thickness
    float pack = vnoise(vec2(s0, 3.7)), th = vnoise(vec2(s0 * 2.9 + 13.0, 8.1)), thin = vnoise(vec2(s0 * 8.7 + 5.0, 1.3));
    float fine = 1.0 - smoothstep(0.3, 1.5, fwidth(s0 * 8.7));
    vec3 strata = mix(vec3(0.205, 0.075, 0.056), vec3(0.262, 0.245, 0.195), smoothstep(0.36, 0.5, pack + (th - 0.5) * 0.35));
    strata = mix(strata, vec3(0.18, 0.19, 0.14), smoothstep(0.68, 0.76, th) * 0.8);            // greenish-grey shale
    strata *= (0.82 + 0.3 * th) * (1.0 - 0.26 * fine * smoothstep(0.58, 0.68, thin)) * (0.78 + 0.38 * n4);
    strata *= 0.8 + 0.34 * smoothstep(0.32, 0.68, vnoise(vec2(dot(gp, vec2(0.71, 0.71)), dot(gp, vec2(-0.71, 0.71)) * 0.16) * 0.34));   // runnels and fractures down the face
    land = mix(land, mix(strata, dry, 0.42), salt * face);
  }
}
diffuseColor.rgb = land;
// Murree after dark: scattered warm house lights in clusters up the slopes, beyond the range where the houses themselves carry (REVIEW2 item 11). Dot size stays at least about a pixel wide.
float hillL = 0.0;
if (uNight > 0.02) {
  float mzL = smoothstep(33.85, 33.87, geoLat) * (1.0 - smoothstep(33.955, 33.975, geoLat)) * smoothstep(73.335, 73.355, geoLon) * (1.0 - smoothstep(73.445, 73.465, geoLon)) * smoothstep(1500.0, 1700.0, e);
  float dL0 = distance(vWPT, cameraPosition);
  if (mzL > 0.01 && dL0 > 180.0) {
    float setL = smoothstep(0.38, 0.66, vnoise(gp * 0.0042 + 21.0)) * (1.0 - smoothstep(0.18, 0.4, sl));
    vec2 cidL = floor(gp / 17.0); float hL = h21(cidL + 3.7);
    if (hL < setL * 0.5) {
      vec2 oL = 0.22 + 0.56 * vec2(h21(cidL + 11.3), h21(cidL * 1.7 + 5.1));
      // measured in screen pixels through the ground-to-screen derivatives, so a light stays a round point on a slope seen at a grazing angle
      vec2 dGL = (fract(gp / 17.0) - oL) * 17.0, gxL = dFdx(gp), gyL = dFdy(gp);
      float detL = gxL.x * gyL.y - gxL.y * gyL.x; if (abs(detL) < 1e-5) detL = 1e-5;
      vec2 pxL = vec2(dGL.x * gyL.y - dGL.y * gyL.x, gxL.x * dGL.y - gxL.y * dGL.x) / detL;
      float rPx = max(1.15, 1.4 / sqrt(abs(detL)));
      hillL = (1.0 - smoothstep(rPx * 0.45, rPx, length(pxL))) * (0.55 + 0.45 * h21(cidL + 23.1)) * mzL * smoothstep(180.0, 320.0, dL0) * min(1.0, 14.0 / max(fw, 1.0));
    }
  }
}
`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
totalEmissiveRadiance += vec3(1.0, 0.66, 0.34) * hillL * uNight * 1.15 + land * vec3(0.3, 0.34, 0.44) * uNight;`)
      // the haze lies in the valley: ground high above the plain stands clear of it, so a ridge keeps its colour
      .replace("#include <fog_fragment>", `#ifdef USE_FOG
float fogT = (1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth)) * (1.0 - 0.55 * smoothstep(420.0, 1500.0, vWPT.y));
float fogUp = smoothstep(700.0, 1600.0, cameraPosition.y);     // a high viewpoint looks down through thin air: the plains stay land, dulled by haze, and only meet the sky at the far edge of the map
fogT = mix(fogT, min(fogT, 0.6) + (fogT - min(fogT, 0.6)) * smoothstep(38000.0, 62000.0, vFogDepth), fogUp);
gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogT);
#endif`);
  };
  m.customProgramCacheKey = () => "uae-terrain-v6-" + (far ? "far" : "near") + (holes ? "-h" : "");
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
