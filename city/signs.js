// Signs with real names in the 3D world: Dubai street-name plates, shop fascias, hotel and
// tower lettering, round speed-limit signs and motorway guide signs.
//
// Text is drawn with Canvas 2D into one shared 2048 x 2048 atlas (TextAtlas). Every sign in
// the world is an instance of one of five InstancedMeshes (SignLayer); a per-instance vec4
// aRect remaps the quad's uv into the sign's atlas rectangle, and a per-instance float aLit
// makes light boxes glow at night (U.uNight). Guide signs are few, so makeGuideSign() builds
// a stand-alone group with its own canvas texture.
//
// Conventions (tile-local metres, X east, Z south, Y up; world = local + offsets.get(tile)):
// - a flat sign is built in the local XY plane, readable face toward local +Z, then rotated
//   by rotY about +Y, so its readable-face normal is (sin rotY, 0, cos rotY) and its long
//   axis is (cos rotY, 0, -sin rotY). For a street running along (dx, dz), rot = atan2(-dz, dx).
//
// Tile data (produced by the tile worker, see SignLayer.setTile):
//   texts  : [{ en, ar, ref, cls }, ...] payloads indexed by the numeric ids below
//   street : Float32Array stride 7 [x, z, y, rotA, idA, rotB, idB]   (idB = -1: one plate)
//   shop   : Float32Array stride 8 [x, y, z, rotY, w, h, id, lit]
//   tower  : Float32Array stride 8 [x, y, z, rotY, w, h, id, lit]
//   speed  : Float32Array stride 5 [x, z, y, rotY, kmh]
import * as THREE from "three";
import { U } from "./materials.js";

// ------------------------------------------------------------------ text helpers
const SANS = '"Segoe UI", Tahoma, Arial, sans-serif';
const AR_FONT = '"Segoe UI", Tahoma, Arial, sans-serif';
const NUM_FONT = 'Arial, "Segoe UI", Helvetica, sans-serif';
const PLATE_BLUE = "#0b4f9c";
const GUIDE_BLUE = "#0d4d9e";

const MC = document.createElement("canvas").getContext("2d");
const HAS_LS = "letterSpacing" in MC;

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return h >>> 0;
}
// Sizes are snapped to half pixels: every distinct size is a new font instance in the browser
// with cold shaping and glyph caches (costly for Arabic), so a small set of sizes stays fast.
function font(px, fam = SANS, weight = "bold") { return `${weight} ${Math.max(1, Math.round(px * 2) / 2)}px ${fam}`; }
// letterSpacing is only touched when it is used: any assignment re-resolves the font.
function setLS(g, px) { if (HAS_LS && (px || g._ls)) { g.letterSpacing = (px || 0).toFixed(1) + "px"; g._ls = !!px; } }
function measure(text, f, rtl = false, ls = 0) {
  if (MC.font !== f) MC.font = f;
  MC.direction = rtl ? "rtl" : "ltr"; setLS(MC, ls);
  const w = MC.measureText(text).width; setLS(MC, 0); return w;
}
function isArabic(s) { return /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/.test(s); }
function rr(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.arcTo(x + w, y, x + w, y + r, r);
  g.lineTo(x + w, y + h - r); g.arcTo(x + w, y + h, x + w - r, y + h, r);
  g.lineTo(x + r, y + h); g.arcTo(x, y + h, x, y + h - r, r);
  g.lineTo(x, y + r); g.arcTo(x, y, x + r, y, r); g.closePath();
}
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16 & 255, gg = n >> 8 & 255, b = n & 255;
  if (k < 0) { r *= 1 + k; gg *= 1 + k; b *= 1 + k; } else { r += (255 - r) * k; gg += (255 - gg) * k; b += (255 - b) * k; }
  return `rgb(${r | 0},${gg | 0},${b | 0})`;
}
function rgba(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }
// Draw one line of text centred vertically on cy. Latin sits on its cap height, Arabic on its
// ink box. If it is wider than maxW it is squeezed horizontally, so it can never overflow.
// An optional outline (stroke colour, width) is drawn under the fill.
function drawText(g, str, x, cy, fs, fam, maxW, align = "center", rtl = false, ls = 0, stroke = null, strokeW = 0) {
  g.font = font(fs, fam); g.direction = rtl ? "rtl" : "ltr"; setLS(g, ls);
  g.textBaseline = "alphabetic"; g.textAlign = align;
  const m = g.measureText(str);
  const by = rtl ? cy + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2 : cy + 0.355 * fs;
  const sx = maxW > 0 && m.width > maxW ? maxW / m.width : 1;
  g.save(); g.translate(x, by); g.scale(sx, 1);
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = strokeW; g.lineJoin = "round"; g.strokeText(str, 0, 0); }
  g.fillText(str, 0, 0);
  g.restore();
  setLS(g, 0); g.direction = "ltr";
}
// Best split of a phrase into two lines (smallest widest line).
function split2(text, wOf) {
  const w = text.split(/\s+/); let best = null;
  for (let i = 1; i < w.length; i++) {
    const a = w.slice(0, i).join(" "), b = w.slice(i).join(" "), m = Math.max(wOf(a), wOf(b));
    if (!best || m < best.m) best = { lines: [a, b], m };
  }
  return best;
}

// ------------------------------------------------------------------ style: street plate
// Layout numbers are fractions of the plate height; aspect is clamped so that a 0.4 m plate
// comes out 1.3 to 1.9 m wide.
const STREET_H = 0.4, STREET_MIN_A = 1.3 / STREET_H, STREET_MAX_A = 1.9 / STREET_H;
function layoutStreet(p) {
  const en = String(p.en || "").trim(), ar = String(p.ar || "").trim(), ref = String(p.ref || "").trim();
  if (!en && !ar) return null;
  const R = 100, L = { en, ar, ref, edge: PLATE_BLUE, padX: 0.27 };
  let fixed = 2 * L.padX * R;
  if (ref) { L.badgeFs = 0.25; L.badgeW = (measure(ref, font(L.badgeFs * R)) + 0.22 * R) / R; L.gap = 0.15; fixed += (L.badgeW + L.gap) * R; }
  L.enFs = 0.33; L.arFs = en ? 0.3 : 0.46;
  const wE = en ? measure(en, font(L.enFs * R)) : 0, wA = ar ? measure(ar, font(L.arFs * R, AR_FONT), true) : 0;
  const tb = Math.max(wE, wA);
  let W = fixed + tb;
  if (W > STREET_MAX_A * R) {                       // long name: smaller type, then squeeze
    const s = Math.max(0.64, (STREET_MAX_A * R - fixed) / tb);
    L.enFs *= s; L.arFs *= s; W = STREET_MAX_A * R;
  }
  L.aspect = Math.max(STREET_MIN_A, Math.min(STREET_MAX_A, W / R));
  return L;
}
function drawStreet(g, L, W, H) {
  g.fillStyle = PLATE_BLUE; g.fillRect(0, 0, W, H);
  const sheen = g.createLinearGradient(0, 0, 0, H);
  sheen.addColorStop(0, "rgba(255,255,255,0.08)"); sheen.addColorStop(1, "rgba(0,0,0,0.10)");
  g.fillStyle = sheen; g.fillRect(0, 0, W, H);
  const b = 0.075 * H, lw = Math.max(0.8, 0.045 * H);
  g.strokeStyle = "#ffffff"; g.lineWidth = lw; rr(g, b, b, W - 2 * b, H - 2 * b, 0.13 * H); g.stroke();
  let x0 = L.padX * H;
  if (L.ref) {
    const bw = L.badgeW * H, bh = 0.44 * H;
    g.fillStyle = "#ffffff"; rr(g, x0, (H - bh) / 2, bw, bh, 0.07 * H); g.fill();
    g.fillStyle = PLATE_BLUE; drawText(g, L.ref, x0 + bw / 2, H / 2, L.badgeFs * H, SANS, bw * 0.9);
    x0 += bw + L.gap * H;
  }
  const x1 = W - L.padX * H, cx = (x0 + x1) / 2, mw = x1 - x0;
  g.fillStyle = "#ffffff";
  if (L.en) drawText(g, L.en, cx, L.ar ? 0.335 * H : 0.5 * H, L.enFs * H, SANS, mw);
  if (L.ar) drawText(g, L.ar, cx, L.en ? 0.7 * H : 0.51 * H, L.arFs * H, AR_FONT, mw, "center", true);
}

// ------------------------------------------------------------------ style: shop fascia
// Colour schemes: bg face, fg text, casing (light-box frame), optional bar / border / emblem.
const SCHEMES = {
  pharmacy: [{ bg: "#00894a", fg: "#ffffff", casing: "#e8ebee", emblem: "cross" }, { bg: "#ffffff", fg: "#00833e", casing: "#00833e", emblem: "cross" }, { bg: "#0a7d44", fg: "#ffffff", casing: "#1d2a22", emblem: "cross", bar: "#9fd65b" }],
  bank: [{ bg: "#0b2d5c", fg: "#ffffff", fgAr: "#e2c47a", casing: "#161b22", bar: "#c9a45a" }, { bg: "#0c2a55", fg: "#e2c47a", casing: "#c9a45a" }, { bg: "#ffffff", fg: "#0b2d5c", casing: "#0b2d5c", bar: "#c9a45a" }],
  restaurant: [{ bg: "#8c1c1c", fg: "#fff4e0", casing: "#2a1a14" }, { bg: "#3a2416", fg: "#f3d9a4", casing: "#1a120c", border: "#f3d9a4" }, { bg: "#111111", fg: "#f5c542", casing: "#3a3a3a" }],
  fast_food: [{ bg: "#d7261e", fg: "#ffd23f", casing: "#f4f4f4" }, { bg: "#ffcc00", fg: "#c8102e", casing: "#c8102e" }, { bg: "#141414", fg: "#ffffff", casing: "#d7261e", bar: "#d7261e" }],
  cafe: [{ bg: "#4a2c1d", fg: "#f4e4c8", casing: "#241510" }, { bg: "#0f0f0f", fg: "#ffffff", casing: "#8a6a4a", border: "#8a6a4a" }, { bg: "#7a1f1f", fg: "#ffffff", casing: "#2a1a14" }],
  grocery: [{ bg: "#1d7a36", fg: "#ffffff", casing: "#f2f2f2", bar: "#f2c200" }, { bg: "#c8102e", fg: "#ffffff", casing: "#f2f2f2", bar: "#1d7a36" }, { bg: "#ffffff", fg: "#c8102e", casing: "#1d7a36" }],
  clothing: [{ bg: "#101010", fg: "#ffffff", casing: "#101010" }, { bg: "#f7f7f5", fg: "#111111", casing: "#1a1a1a" }],
  hair: [{ bg: "#d63a7a", fg: "#ffffff", casing: "#3a1022" }, { bg: "#5b2a86", fg: "#ffffff", casing: "#2a1040", border: "#e6c3ff" }],
  laundry: [{ bg: "#1f6fd1", fg: "#ffffff", casing: "#e9eef5" }, { bg: "#ffffff", fg: "#1f5fbf", casing: "#1f5fbf", bar: "#1f6fd1" }],
  lodging: [{ bg: "#5e1526", fg: "#e0bd73", casing: "#2a0a12", border: "#e0bd73", serif: true }, { bg: "#6d1a2a", fg: "#f1d38e", casing: "#1f0a10", serif: true }],
  generic: [
    { bg: "#ffffff", fg: "#b3131b", casing: "#2b2b2b" },
    { bg: "#ffd200", fg: "#111111", casing: "#222222" },
    { bg: "#0f7c7f", fg: "#ffffff", casing: "#e6e6e6" },
    { bg: "#e8641b", fg: "#ffffff", casing: "#303030" },
    { bg: "#2b2f36", fg: "#ffd24a", casing: "#15171a" },
    { bg: "#e9ecef", fg: "#0c2f6b", casing: "#8d949c", bar: "#0c2f6b" },
    { bg: "#7b1e3a", fg: "#ffffff", casing: "#2a0c16" },
    { bg: "#6fb6e8", fg: "#0b2447", casing: "#f2f2f2" },
  ],
};
const CLASS = {
  pharmacy: "pharmacy", chemist: "pharmacy", bank: "bank", atm: "bank", bureau_de_change: "bank", money_exchange: "bank", exchange: "bank",
  restaurant: "restaurant", fast_food: "fast_food", food_court: "fast_food", cafe: "cafe", coffee: "cafe", coffee_shop: "cafe", bakery: "cafe",
  grocery: "grocery", supermarket: "grocery", convenience: "grocery", greengrocer: "grocery", hypermarket: "grocery",
  clothing_store: "clothing", clothes: "clothing", shoes: "clothing", fashion: "clothing", boutique: "clothing",
  hairdresser: "hair", beauty: "hair", barber: "hair", beauty_salon: "hair", laundry: "laundry", dry_cleaning: "laundry",
  lodging: "lodging", hotel: "lodging", hostel: "lodging", guest_house: "lodging", motel: "lodging", apartment: "lodging",
};
// families with their natural weight (Impact and Arial Black are heavy already)
const FAMS = [
  { f: SANS, w: "bold" }, { f: "Arial, Helvetica, sans-serif", w: "bold" }, { f: "Tahoma, Verdana, sans-serif", w: "bold" },
  { f: "Verdana, Tahoma, sans-serif", w: "bold" }, { f: '"Trebuchet MS", Arial, sans-serif', w: "bold" },
  { f: '"Arial Black", Arial, sans-serif', w: "normal" }, { f: 'Impact, "Arial Black", sans-serif', w: "normal" },
  { f: 'Georgia, "Times New Roman", serif', w: "bold" },
];
const SERIF = { f: 'Georgia, "Times New Roman", serif', w: "bold" };
const FIT_BUCKETS = [1.2, 1.6, 2.1, 2.8, 3.6, 4.7, 6.2, 8.2, 11, 15];
function fitBucket(a) {
  if (!(a > 0)) return 0;
  let best = FIT_BUCKETS[0], bd = 1e9;
  for (const b of FIT_BUCKETS) { const d = Math.abs(Math.log(a / b)); if (d < bd) { bd = d; best = b; } }
  return best;
}
function layoutShop(p, fit) {
  const enRaw = String(p.en || "").trim(), ar = String(p.ar || "").trim();
  if (!enRaw && !ar) return null;
  const h = hash32(enRaw + "|" + ar);
  const cls = CLASS[String(p.cls || "").toLowerCase()] || "generic";
  const pal = SCHEMES[cls];
  const S = pal[(h >>> 8) % pal.length];
  const en = ((h >>> 3) & 1) ? enRaw.toUpperCase() : enRaw;
  const fam = S.serif ? SERIF : FAMS[(h >>> 12) % FAMS.length];
  const R = 100, c = 5.5, px = 24, em = S.emblem ? 64 + 16 : 0;
  const fixed = 2 * c + 2 * px + em, B = fit > 0 ? fit : 5, MAXA = 15;
  const wE = (t, fs) => measure(t, font(fs, fam.f, fam.w)), wA = (t, fs) => measure(t, font(fs, AR_FONT), true);
  let best = null;
  const consider = (o, textW, bonus) => {
    let sc = 1, W = fixed + textW;
    if (W > MAXA * R) { sc = (MAXA * R - fixed) / textW; W = MAXA * R; }
    W = Math.max(W, 1.8 * R);
    o.aspect = W / R; o.fsE = (o.fsE || 0) * sc; o.fsA = (o.fsA || 0) * sc;
    o.score = Math.max(o.fsE, o.fsA) * Math.min(1, B / o.aspect) * bonus;
    if (!best || o.score > best.score) best = o;
  };
  if (en && ar) {
    consider({ kind: "enar", fsE: 40, fsA: 29 }, Math.max(wE(en, 40), wA(ar, 29)), 1.3);
    const a = wE(en, 46), b = wA(ar, 44);
    consider({ kind: "side", fsE: 46, fsA: 44, frac: a / (a + b) }, a + 44 + b, 1.24);
  }
  if (en) {
    consider({ kind: "one", fsE: 50 }, wE(en, 50), 1);
    if (/\s/.test(en)) { const s2 = split2(en, t => wE(t, 35)); consider({ kind: "two", fsE: 35, lines: s2.lines }, s2.m, 0.97); }
  }
  if (!en && ar) consider({ kind: "ar", fsA: 50 }, wA(ar, 50), 1);
  return Object.assign(best, { en, ar, S, fam, c: c / R, px: px / R, em: em / R, edge: S.casing });
}
function drawShop(g, L, W, H) {
  const S = L.S, k = H / 100, c = L.c * H;
  g.fillStyle = S.casing; g.fillRect(0, 0, W, H);
  const face = g.createLinearGradient(0, c, 0, H - c);
  face.addColorStop(0, shade(S.bg, 0.1)); face.addColorStop(0.55, S.bg); face.addColorStop(1, shade(S.bg, -0.14));
  g.fillStyle = face; g.fillRect(c, c, W - 2 * c, H - 2 * c);
  if (S.border) { g.strokeStyle = S.border; g.lineWidth = Math.max(0.7, 2.4 * k); g.strokeRect(c + 4.5 * k, c + 4.5 * k, W - 2 * c - 9 * k, H - 2 * c - 9 * k); }
  const barOn = S.bar && L.kind !== "enar";
  if (barOn) { g.fillStyle = S.bar; g.fillRect(c, H - c - 6.5 * k, W - 2 * c, 6.5 * k); }
  let x0 = c + L.px * H;
  const x1 = W - c - L.px * H;
  if (S.emblem === "cross") {
    const e = 64 * k, ex = x0, ey = (H - e) / 2 - (barOn ? 2 * k : 0), t = e * 0.3;
    const light = S.bg.toLowerCase() === "#ffffff";
    if (!light) { g.fillStyle = "#ffffff"; rr(g, ex, ey, e, e, e * 0.18); g.fill(); }
    g.fillStyle = light ? "#00a651" : S.bg;
    g.fillRect(ex + (e - t) / 2, ey + e * 0.14, t, e * 0.72); g.fillRect(ex + e * 0.14, ey + (e - t) / 2, e * 0.72, t);
    x0 += L.em * H;
  }
  const cx = (x0 + x1) / 2, mw = x1 - x0, lift = barOn ? 3 * k : 0;
  const fam = L.fam, fg = S.fg, fgAr = S.fgAr || S.fg;
  const en = (t, x, y, fs, al, maxw) => {
    g.fillStyle = fg; g.font = font(fs, fam.f, fam.w); g.textAlign = al; g.textBaseline = "alphabetic"; g.direction = "ltr";
    const w = g.measureText(t).width, by = y + 0.355 * fs;
    if (w > maxw) { g.save(); g.translate(x, by); g.scale(maxw / w, 1); g.fillText(t, 0, 0); g.restore(); } else g.fillText(t, x, by);
  };
  if (L.kind === "one") en(L.en, cx, 0.5 * H - lift, L.fsE * k, "center", mw);
  else if (L.kind === "two") { en(L.lines[0], cx, 0.335 * H - lift, L.fsE * k, "center", mw); en(L.lines[1], cx, 0.665 * H - lift, L.fsE * k, "center", mw); }
  else if (L.kind === "enar") {
    en(L.en, cx, 0.36 * H, L.fsE * k, "center", mw);
    g.fillStyle = fgAr; drawText(g, L.ar, cx, 0.715 * H, L.fsA * k, AR_FONT, mw, "center", true);
  } else if (L.kind === "side") {
    const gap = 44 * k, wEn = (mw - gap) * L.frac, xa = x0 + wEn + gap;
    en(L.en, x0, 0.5 * H - lift, L.fsE * k, "left", wEn);
    g.fillStyle = fgAr; drawText(g, L.ar, x1, 0.5 * H - lift, L.fsA * k, AR_FONT, x1 - xa, "right", true);
    g.fillStyle = rgba(S.fg.length === 7 ? S.fg : "#ffffff", 0.55); g.fillRect(x0 + wEn + gap / 2 - 1.2 * k, 0.24 * H, 2.4 * k, 0.52 * H);
  } else if (L.kind === "ar") { g.fillStyle = fgAr; drawText(g, L.ar, cx, 0.5 * H - lift, L.fsA * k, AR_FONT, mw, "center", true); }
}

// ------------------------------------------------------------------ style: tower lettering
const TOWER_COLS = ["#f4f6f8", "#e8c27a"];
function layoutTower(p, fit) {
  let text = String(p.en || "").trim();
  if (!text) text = String(p.ar || "").trim();
  if (!text) return null;
  const rtl = isArabic(text), h = hash32(text), col = TOWER_COLS[h & 1];
  const R = 100, B = fit > 0 ? fit : 8, fam = rtl ? AR_FONT : SANS, padX = 0.16 * R;
  let best = null;
  const consider = (o, textW) => {
    let sc = 1, W = 2 * padX + textW;
    if (W > 15 * R) { sc = (15 * R - 2 * padX) / textW; W = 15 * R; }
    o.aspect = Math.max(1, W / R); o.fs *= sc; o.score = o.fs * Math.min(1, B / o.aspect);
    if (!best || o.score > best.score) best = o;
  };
  const w1 = measure(text, font(76, fam), rtl, 76 * 0.06);
  consider({ kind: "one", fs: 76 }, w1);
  if (/\s/.test(text)) { const s2 = split2(text, t => measure(t, font(40, fam), rtl, 40 * 0.06)); consider({ kind: "two", fs: 40, lines: s2.lines }, s2.m); }
  // near-transparent fill in the letter colour: keeps mip fringes from darkening toward black
  return Object.assign(best, { text, rtl, col, fam, edge: rgba(col, 3 / 255) });
}
// Letters with a dark outline: the returns of real channel letters, and contrast against
// pale glass and stone by day.
function drawTower(g, L, W, H) {
  g.fillStyle = L.col;
  const k = H / 100, mw = W - 0.24 * H, fs = L.fs * k, ls = fs * 0.06, sw = Math.max(1, fs * 0.075), out = "rgba(28,32,38,0.92)";
  if (L.kind === "one") drawText(g, L.text, W / 2, 0.5 * H, fs, L.fam, mw, "center", L.rtl, ls, out, sw);
  else { drawText(g, L.lines[0], W / 2, 0.29 * H, fs, L.fam, mw, "center", L.rtl, ls, out, sw); drawText(g, L.lines[1], W / 2, 0.72 * H, fs, L.fam, mw, "center", L.rtl, ls, out, sw); }
}

// ------------------------------------------------------------------ style: speed limit
// Square entry; the disc is inscribed and the corners carry the grey of the metal back,
// which the back face, the rim and the pole of the speed-sign mesh sample.
const METAL = "#7c8288";
function drawSpeed(g, L, W, H, p) {
  const r = H / 2, cx = W / 2, cy = H / 2;
  const disc = (rad, col) => { g.fillStyle = col; g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fill(); };
  disc(r, "#f4f4f2"); disc(r * 0.955, "#d0201c"); disc(r * 0.745, "#fbfbf9");
  const t = String(Math.round(+p.kmh || 0));
  const fs = r * (t.length >= 3 ? 0.84 : 1.02);
  g.fillStyle = "#111111"; drawText(g, t, cx, cy, fs, NUM_FONT, r * 1.24);
}

const STYLES = {
  street: { tiers: [16, 40, 80], layout: layoutStreet, draw: drawStreet },
  shop: { tiers: [16, 40, 80], layout: layoutShop, draw: drawShop },
  tower: { tiers: [16, 40, 80], layout: layoutTower, draw: drawTower },
  speed: { tiers: [80], layout: () => ({ aspect: 1, edge: METAL }), draw: drawSpeed },
};

// ------------------------------------------------------------------ TextAtlas
// One 2048 x 2048 canvas, packed in shelves. Each entry is drawn at a tier height (its row
// height), padded by a gutter of its own edge colour (2 px on 16 px rows, else 4 px) and
// aligned to 4 px, so mip levels 0 to 2 never mix neighbours. Shelves hold one height each;
// empty shelves go back to a free band list. When full, entries not used in the current
// frame are evicted in last-used order (same row height first), their rectangle cleared.
// New entries reach the GPU as small sub-image uploads (see flush), not whole-atlas uploads.
const align4 = v => (v + 3) & ~3;
export class TextAtlas {
  constructor(size = 2048) {
    this.size = size;
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = size;
    // CPU-backed: entries are blitted in from CPU scratch canvases and nothing reads it on the
    // GPU except three's one full upload (and a re-upload after a lost context)
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    const t = new THREE.CanvasTexture(this.canvas);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.flipY = false;
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    this.texture = t;
    this.entries = new Map();          // key -> entry
    this.layouts = new Map();          // base key -> layout (tier independent)
    this.shelves = [];                 // { y, h, free: [x, w, ...], items: Set of entries }
    this.bands = [[0, size]];          // free vertical bands [y, h]
    this.pending = [];                 // { canvas, x, y } drawn but not yet on the GPU
    this.pool = [];                    // spare scratch canvases
    this.partial = true;               // sub-image uploads (falls back to full uploads)
    this._src = new THREE.Texture(); this._src.flipY = false;
    this._pos = new THREE.Vector2();
    this.stats = { drawn: 0, evicted: 0, uploads: 0, fullUploads: 0, failed: 0 };
    this._bk = new WeakMap();
    this._tk = new Map();
    // Resolve every family once now: the first use of a system font can stall for tens of
    // milliseconds, which is better paid at load than in the middle of a drive.
    const g = this._scratch(64, 32).getContext("2d");
    for (const f of [...FAMS, SERIF, { f: NUM_FONT, w: "bold" }]) { g.font = `${f.w} 20px ${f.f}`; g.fillText("Ag 0", 0, 20); }
    g.font = font(20, AR_FONT); g.direction = "rtl"; g.fillText("شارع مخرج", 60, 20); g.direction = "ltr";
    this.pool.push(g.canvas);
  }
  static styles() { return Object.keys(STYLES); }
  static tiers(style) { return STYLES[style] ? STYLES[style].tiers.slice() : []; }
  // Key of a payload independent of the tier. fit is the box aspect (w / h) for shop and tower.
  baseKey(style, p, fit = 0) {
    if (style === "speed") return "speed\u0001" + Math.round(+p.kmh || 0);
    const fb = style === "shop" || style === "tower" ? fitBucket(fit) : 0;
    const c = this._bk.get(p);                                   // payload objects persist per tile
    if (c && c.s === style && c.fb === fb) return c.k;
    const k = style + "\u0001" + fb + "\u0001" + (p.en || "") + "\u0001" + (p.ar || "") + "\u0001" + (p.ref || "") + "\u0001" + (p.cls || "");
    this._bk.set(p, { s: style, fb, k });
    return k;
  }
  // Full entry key; the strings are cached per payload so Map lookups reuse their hash.
  _key(base, tier) {
    let t = this._tk.get(base);
    if (!t) { if (this._tk.size > 20000) this._tk.clear(); t = {}; this._tk.set(base, t); }
    return t[tier] || (t[tier] = base + "#" + tier);
  }
  // Cached entry for (style, payload, tier) without drawing; null if absent.
  peek(style, p, opts = {}) {
    const st = STYLES[style]; if (!st) return null;
    const base = opts.base || this.baseKey(style, p, opts.fit);
    return this.entries.get(this._key(base, opts.tier || st.tiers[st.tiers.length - 1])) || null;
  }
  // Any cached tier of this payload, the closest to opts.tier first.
  peekAny(style, p, opts = {}) {
    const st = STYLES[style]; if (!st) return null;
    const base = opts.base || this.baseKey(style, p, opts.fit), want = opts.tier || 0;
    const order = st.tiers.slice().sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
    for (const t of order) { const e = this.entries.get(this._key(base, t)); if (e) return e; }
    return null;
  }
  // get(style, payload, frameNo, { tier, fit }) -> { u0, v0, u1, v1, aspect, ... } or null.
  // uv convention: the quad's uv (0,0) (bottom-left of the readable face) maps to (u0, v0)
  // and (1,1) to (u1, v1): uvAtlas = mix(vec2(u0, v0), vec2(u1, v1), uv). The texture has
  // flipY = false, so v1 < v0. aspect = drawn width / height in pixels.
  get(style, p, frameNo = 0, opts = {}) {
    const st = STYLES[style]; if (!st || !p) return null;
    const tier = opts.tier && st.tiers.includes(opts.tier) ? opts.tier : st.tiers[st.tiers.length - 1];
    const base = opts.base || this.baseKey(style, p, opts.fit);
    const key = this._key(base, tier);
    let e = this.entries.get(key);
    if (e) { e.lastUsed = frameNo; return e; }
    let L = this.layouts.get(base);
    if (L === undefined) {
      L = st.layout(p, style === "shop" || style === "tower" ? fitBucket(opts.fit) : 0) || null;
      if (this.layouts.size > 8000) this.layouts.clear();
      this.layouts.set(base, L);
    }
    if (!L) return null;
    const H = tier, pad = H >= 32 ? 4 : 2, S = this.size;
    const W = Math.max(4, Math.min(S - 2 * pad - 4, Math.round(L.aspect * H)));
    const aw = align4(W + 2 * pad), ah = align4(H + 2 * pad);
    const r = this._alloc(aw, ah) || this._evict(aw, ah, frameNo);
    if (!r) { this.stats.failed++; return null; }
    const sc = this._scratch(aw, ah), g = sc.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, aw, ah);
    if (L.edge) { g.fillStyle = L.edge; g.fillRect(0, 0, aw, ah); }
    g.translate(pad, pad);
    st.draw(g, L, W, H, p);
    g.setTransform(1, 0, 0, 1, 0, 0);
    const y = r.s.y;
    this.ctx.clearRect(r.x, y, aw, ah);
    this.ctx.drawImage(sc, r.x, y);
    this.pending.push({ canvas: sc, x: r.x, y });
    if (this.pending.length > 384) this._collapse();
    e = {
      key, style, tier: H, x: r.x, y, aw, ah, shelf: r.s, lastUsed: frameNo, aspect: W / H,
      u0: (r.x + pad) / S, u1: (r.x + pad + W) / S, v0: (y + pad + H) / S, v1: (y + pad) / S,
    };
    this.entries.set(key, e);
    r.s.items.add(e);
    this.stats.drawn++;
    return e;
  }
  touch(e, frameNo) { if (e) e.lastUsed = frameNo; }
  // Pixel area of all entries (fill ratio of the canvas).
  usage(frameNo) {
    let a = 0, live = 0;
    for (const e of this.entries.values()) { a += e.aw * e.ah; if (frameNo !== undefined && e.lastUsed === frameNo) live += e.aw * e.ah; }
    const S2 = this.size * this.size;
    return { entries: this.entries.size, shelves: this.shelves.length, fill: a / S2, live: live / S2 };
  }
  // Upload what was drawn since the last call. SignLayer calls it from onBeforeRender, so
  // the renderer is at hand without being passed around.
  flush(renderer) {
    if (!this.pending.length) return;
    const tex = this.texture;
    const props = renderer.properties.get(tex);
    if (!props.__webglTexture || props.__version !== tex.version) {
      // the first (or a forced) full upload of the canvas is still to come and covers these
    } else if (this.partial && renderer.copyTextureToTexture) {
      try {
        tex.generateMipmaps = false;
        for (const q of this.pending) { this._src.image = q.canvas; this._pos.set(q.x, q.y); renderer.copyTextureToTexture(this._src, tex, null, this._pos); }
        tex.generateMipmaps = true;
        const gl = renderer.getContext();
        renderer.state.bindTexture(gl.TEXTURE_2D, props.__webglTexture);
        gl.generateMipmap(gl.TEXTURE_2D);
        renderer.state.unbindTexture();
        this.stats.uploads += this.pending.length;
      } catch (err) {
        tex.generateMipmaps = true; this.partial = false; tex.needsUpdate = true; this.stats.fullUploads++;
        console.warn("signs: partial atlas upload failed, using full uploads", err);
      }
    } else { tex.needsUpdate = true; this.stats.fullUploads++; }
    this._src.image = null;
    for (const q of this.pending) this.pool.push(q.canvas);
    this.pending.length = 0;
  }
  dispose() { this.texture.dispose(); this.entries.clear(); this.layouts.clear(); this.pending.length = 0; this.pool.length = 0; }

  // -------- internals
  _collapse() { for (const q of this.pending) this.pool.push(q.canvas); this.pending.length = 0; this.texture.needsUpdate = true; this.stats.fullUploads++; }
  _scratch(w, h) {
    const c = this.pool.pop() || document.createElement("canvas");
    if (!c._ctx) c._ctx = c.getContext("2d", { willReadFrequently: true });
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return c;
  }
  _alloc(w, h) {
    for (const s of this.shelves) {
      if (s.h !== h) continue;
      const f = s.free;
      for (let i = 0; i < f.length; i += 2) {
        if (f[i + 1] >= w) { const x = f[i]; f[i] += w; f[i + 1] -= w; if (f[i + 1] === 0) f.splice(i, 2); return { s, x }; }
      }
    }
    for (let i = 0; i < this.bands.length; i++) {
      const b = this.bands[i];
      if (b[1] < h) continue;
      const s = { y: b[0], h, free: w < this.size ? [w, this.size - w] : [], items: new Set() };
      b[0] += h; b[1] -= h; if (b[1] === 0) this.bands.splice(i, 1);
      this.shelves.push(s);
      return { s, x: 0 };
    }
    return null;
  }
  // LRU eviction of entries not used in this frame. Same row height: single entries, least
  // recently used first. Other heights: whole shelves whose entries are all unused (their
  // rows go back to the free bands), shelves tall enough for the request first, then by age.
  _evict(w, h, frameNo) {
    const old = [];
    for (const e of this.entries.values()) if (e.lastUsed < frameNo && e.ah === h) old.push(e);
    old.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of old) { this._remove(e); const r = this._alloc(w, h); if (r) return r; }
    const cand = [];
    for (const s of this.shelves) {
      if (s.h === h) continue;
      let last = -Infinity, ok = true;
      for (const e of s.items) { if (e.lastUsed >= frameNo) { ok = false; break; } if (e.lastUsed > last) last = e.lastUsed; }
      if (ok) cand.push({ s, last, tall: s.h >= h ? 0 : 1 });
    }
    cand.sort((a, b) => a.tall - b.tall || a.last - b.last);
    for (const c of cand) {
      for (const e of [...c.s.items]) this._remove(e);
      const r = this._alloc(w, h); if (r) return r;
    }
    return null;
  }
  _remove(e) {
    this.entries.delete(e.key);
    this.ctx.clearRect(e.x, e.y, e.aw, e.ah);
    this.stats.evicted++;
    const s = e.shelf, f = s.free;
    let i = 0; while (i < f.length && f[i] < e.x) i += 2;
    f.splice(i, 0, e.x, e.aw);
    if (i + 2 < f.length && f[i] + f[i + 1] === f[i + 2]) { f[i + 1] += f[i + 3]; f.splice(i + 2, 2); }
    if (i >= 2 && f[i - 2] + f[i - 1] === f[i]) { f[i - 1] += f[i + 1]; f.splice(i, 2); }
    s.items.delete(e);
    if (s.items.size === 0) {
      this.shelves.splice(this.shelves.indexOf(s), 1);
      const B = this.bands; B.push([s.y, s.h]); B.sort((a, b) => a[0] - b[0]);
      for (let j = 0; j + 1 < B.length;) { if (B[j][0] + B[j][1] === B[j + 1][0]) { B[j][1] += B[j + 1][1]; B.splice(j + 1, 1); } else j++; }
    }
  }
}

// ------------------------------------------------------------------ geometry
function builder() { return { p: [], n: [], uv: [], idx: [] }; }
function vtx(B, x, y, z, nx, ny, nz, u, v) { B.p.push(x, y, z); B.n.push(nx, ny, nz); B.uv.push(u, v); return B.p.length / 3 - 1; }
// Quad a-b-c-d (in order around it), wound so that it faces n.
function quad(B, a, b, c, d, n, ua, ub, uc, ud) {
  const v = B.p.length / 3;
  [a, b, c, d].forEach((q, i) => { const t = [ua, ub, uc, ud][i]; vtx(B, q[0], q[1], q[2], n[0], n[1], n[2], t[0], t[1]); });
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
  if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) B.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
  else B.idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
}
function finish(B) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(B.p, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(B.n, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(B.uv, 2));
  g.setIndex(B.idx);
  return g;
}
// Unit box panel (x, y in -0.5..0.5, scaled per instance), faces at z = zb .. zf. The side
// faces sample the outer edge of the sign's own atlas rect (its casing or rim colour).
function panel(B, zb, zf, back) {
  const E = 0.004;
  quad(B, [-.5, -.5, zf], [.5, -.5, zf], [.5, .5, zf], [-.5, .5, zf], [0, 0, 1], [0, 0], [1, 0], [1, 1], [0, 1]);
  // back face readable from behind: u runs the other way so the text is not mirrored
  if (back) quad(B, [.5, -.5, zb], [-.5, -.5, zb], [-.5, .5, zb], [.5, .5, zb], [0, 0, -1], [0, 0], [1, 0], [1, 1], [0, 1]);
  quad(B, [-.5, .5, zf], [.5, .5, zf], [.5, .5, zb], [-.5, .5, zb], [0, 1, 0], [0, 1 - E], [1, 1 - E], [1, 1 - E], [0, 1 - E]);
  quad(B, [-.5, -.5, zb], [.5, -.5, zb], [.5, -.5, zf], [-.5, -.5, zf], [0, -1, 0], [0, E], [1, E], [1, E], [0, E]);
  quad(B, [.5, -.5, zf], [.5, -.5, zb], [.5, .5, zb], [.5, .5, zf], [1, 0, 0], [1 - E, 0], [1 - E, 0], [1 - E, 1], [1 - E, 1]);
  quad(B, [-.5, -.5, zb], [-.5, -.5, zf], [-.5, .5, zf], [-.5, .5, zb], [-1, 0, 0], [E, 0], [E, 0], [E, 1], [E, 1]);
}
function plateGeometry() { const B = builder(); panel(B, -0.0125, 0.0125, true); return finish(B); }
// Fascia: (x, y, z) is on the wall; the box stands 7 cm out of it.
function fasciaGeometry() { const B = builder(); panel(B, 0, 0.07, false); return finish(B); }
// Lettering: letters stand 25 cm proud of the facade.
function letterGeometry() { const B = builder(); quad(B, [-.5, -.5, .25], [.5, -.5, .25], [.5, .5, .25], [-.5, .5, .25], [0, 0, 1], [0, 0], [1, 0], [1, 1], [0, 1]); return finish(B); }
function poleGeometry() {
  const g = new THREE.CylinderGeometry(0.045, 0.05, 1, 10, 1, false);
  g.translate(0, 0.5, 0); g.deleteAttribute("uv");
  return g;
}
// Speed sign: 0.9 m disc with its centre 2.2 m up, in front of its own pole (pole axis at the
// origin). Face, back, rim and pole in one mesh; everything but the face samples the grey
// corner of the entry.
export const SPEED = { diameter: 0.9, centre: 2.2 };
function speedGeometry() {
  const B = builder(), R = SPEED.diameter / 2, C = SPEED.centre, ZF = 0.062, ZB = 0.046, N = 40, K = 0.03;
  const cf = vtx(B, 0, C, ZF, 0, 0, 1, 0.5, 0.5), cb = vtx(B, 0, C, ZB, 0, 0, -1, K, K);
  const f0 = B.p.length / 3; for (let i = 0; i <= N; i++) { const a = i / N * Math.PI * 2; vtx(B, Math.cos(a) * R, C + Math.sin(a) * R, ZF, 0, 0, 1, 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5); }
  const b0 = B.p.length / 3; for (let i = 0; i <= N; i++) { const a = i / N * Math.PI * 2; vtx(B, Math.cos(a) * R, C + Math.sin(a) * R, ZB, 0, 0, -1, K, K); }
  for (let i = 0; i < N; i++) { B.idx.push(cf, f0 + i, f0 + i + 1); B.idx.push(cb, b0 + i + 1, b0 + i); }
  const r0 = B.p.length / 3;
  for (let i = 0; i <= N; i++) { const a = i / N * Math.PI * 2, c = Math.cos(a), s = Math.sin(a); vtx(B, c * R, C + s * R, ZF, c, s, 0, K, K); vtx(B, c * R, C + s * R, ZB, c, s, 0, K, K); }
  for (let i = 0; i < N; i++) { const a = r0 + i * 2; B.idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  const pr = 0.04, top = C + R * 0.6, M = 8, p0 = B.p.length / 3;
  for (let i = 0; i <= M; i++) { const a = i / M * Math.PI * 2, c = Math.cos(a), s = Math.sin(a); vtx(B, c * pr, 0, s * pr, c, 0, s, K, K); vtx(B, c * pr, top, s * pr, c, 0, s, K, K); }
  for (let i = 0; i < M; i++) { const a = p0 + i * 2; B.idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  const ct = vtx(B, 0, top, 0, 0, 1, 0, K, K), t0 = B.p.length / 3;
  for (let i = 0; i <= M; i++) { const a = i / M * Math.PI * 2; vtx(B, Math.cos(a) * pr, top, Math.sin(a) * pr, 0, 1, 0, K, K); }
  for (let i = 0; i < M; i++) B.idx.push(ct, t0 + i + 1, t0 + i);
  // the rim and pole windings above are built by hand; verify against the normals
  const g = finish(B); fixWinding(g); return g;
}
// Flip any triangle whose geometric normal disagrees with its vertex normals.
function fixWinding(g) {
  const P = g.attributes.position.array, Nn = g.attributes.normal.array, I = g.index.array;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const vx = Nn[a] + Nn[b] + Nn[c], vy = Nn[a + 1] + Nn[b + 1] + Nn[c + 1], vz = Nn[a + 2] + Nn[b + 2] + Nn[c + 2];
    if (nx * vx + ny * vy + nz * vz < 0) { const s = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = s; }
  }
}

// ------------------------------------------------------------------ materials
// MeshStandardMaterial on the atlas; the per-instance aRect picks the sign's rectangle and
// aLit adds emissive = texel colour * aLit * uNight * k. k follows the texel's luminance L:
// the emitted luminance is min(uGlow * L^0.7, uCap) with the texel's chroma kept, so
// coloured faces light up like real light boxes while white faces stay under the engine's
// bloom threshold (0.9 at night) and the text on them stays legible. Tower lettering has no
// cap and blooms.
export function makeSignMaterial(map, lettering = false) {
  const m = new THREE.MeshStandardMaterial({ map, roughness: lettering ? 0.35 : 0.52, metalness: 0, alphaTest: lettering ? 0.5 : 0 });
  m.userData.uGlow = { value: lettering ? 1.8 : 1.25 };
  m.userData.uCap = { value: lettering ? 0 : 0.84 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = U.uNight; sh.uniforms.uGlow = m.userData.uGlow; sh.uniforms.uCap = m.userData.uCap;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 aRect;\nattribute float aLit;\nvarying float vLit;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\nvMapUv = mix(aRect.xy, aRect.zw, uv);\nvLit = aLit;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uNight; uniform float uGlow; uniform float uCap;\nvarying float vLit;")
      .replace("#include <emissivemap_fragment>", /* glsl */`#include <emissivemap_fragment>
{ float lt = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float e = uGlow * pow(lt, 0.7); if (uCap > 0.0) e = min(e, uCap);
  totalEmissiveRadiance += diffuseColor.rgb * (e / max(lt, 1e-3)) * vLit * uNight; }`);
    if (lettering) {
      // alpha-tested letters thin out in the smaller mips; grow alpha with the mip level so
      // distant lettering keeps its weight
      sh.fragmentShader = sh.fragmentShader.replace("#include <alphatest_fragment>", /* glsl */`
{ vec2 q = vMapUv * vec2(textureSize(map, 0)); vec2 qx = dFdx(q), qy = dFdy(q);
  float lod = max(0.0, 0.5 * log2(max(dot(qx, qx), dot(qy, qy))));
  diffuseColor.a = min(1.0, diffuseColor.a * (1.0 + 0.28 * lod)); }
#include <alphatest_fragment>`);
    }
  };
  m.customProgramCacheKey = () => lettering ? "uae-sign-letters-v2" : "uae-sign-v2";
  return m;
}

// ------------------------------------------------------------------ SignLayer
const CAPS = { shop: 700, plate: 300, pole: 300, tower: 60, speed: 150 };
const LIT = { plate: 0.22, speed: 0.22, unlitShop: 0.07 };   // retroreflective sheeting under street lamps
const POLE_H = 3.2, PLATE_Y = 2.8, PLATE_GAP = 0.06, POLE_R = 0.045;
const EMPTY = [];

export class SignLayer {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.atlas = opts.atlas || new TextAtlas(2048);
    this.src = new Map();
    this.radius = 450;          // signs further away are not instanced
    this.pxScale = 1300;        // screen px per metre at 1 m, times an oversampling margin
    this.bias = 1;              // lowered automatically when the atlas runs full
    this.budgetMs = 3;          // canvas drawing per refresh; the rest waits for the next frame
    this.frameNo = 0;
    this.dirty = true; this.more = false;
    this._last = { x: 1e9, z: 1e9, t: -1e9 };
    this.stats = { refreshes: 0, lastMs: 0, drawnLast: 0, instances: {} };
    const map = this.atlas.texture;
    this.mat = makeSignMaterial(map, false);
    this.letterMat = makeSignMaterial(map, true);
    this.poleMat = new THREE.MeshStandardMaterial({ color: 0x8e959c, roughness: 0.42, metalness: 0.65 });
    this.meshes = {
      pole: this._mesh(poleGeometry(), this.poleMat, CAPS.pole, true, true, false),
      plate: this._mesh(plateGeometry(), this.mat, CAPS.plate, false, true, true),
      shop: this._mesh(fasciaGeometry(), this.mat, CAPS.shop, false, true, true),
      tower: this._mesh(letterGeometry(), this.letterMat, CAPS.tower, false, false, true),
      speed: this._mesh(speedGeometry(), this.mat, CAPS.speed, true, true, true),
    };
    this._speedP = new Map();
  }
  _mesh(geo, mat, cap, cast, recv, atlas) {
    if (atlas) {
      geo.setAttribute("aRect", new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute("aLit", new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage));
    }
    const im = new THREE.InstancedMesh(geo, mat, cap);
    im.count = 0; im.castShadow = cast; im.receiveShadow = recv; im.frustumCulled = false;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (atlas) im.onBeforeRender = (renderer) => this.atlas.flush(renderer);
    im.name = "signs";
    this.scene.add(im);
    return im;
  }
  setTile(key, data) { this.src.set(key, data); this.dirty = true; }
  dropTile(key) { if (this.src.delete(key)) this.dirty = true; }
  // Cheap every frame: refreshes the instanced set when tiles changed, when the camera moved
  // 40 m, or at most every 0.4 s while it keeps moving. night is accepted for parity with
  // Props.update; the shaders read U.uNight. frameNo drives the atlas LRU (defaults to an
  // internal counter). Returns true when the instances were rewritten.
  update(camX, camZ, offsets, night, frameNo) {
    this.frameNo = frameNo !== undefined ? frameNo : this.frameNo + 1;
    const L = this._last, now = performance.now();
    const d2 = (camX - L.x) ** 2 + (camZ - L.z) ** 2;
    if (!this.dirty && !this.more && d2 < 1600 && !(now - L.t >= 400 && d2 > 1)) return false;
    const t0 = performance.now();
    if (this.more && !this.dirty && this._cur && d2 < 64 && now - L.t < 2000) {
      // still drawing the last set: keep its (sorted) job list and draw the next batch
      for (const j of this._cur.jobs) if (j.e) j.e.lastUsed = this.frameNo;
    } else {
      L.x = camX; L.z = camZ; L.t = now; this.dirty = false;
      this._cur = this._gather(camX, camZ, offsets);
    }
    this._resolve(this._cur);
    this._fill(this._cur);
    this.stats.refreshes++; this.stats.lastMs = performance.now() - t0;
    return true;
  }
  // true while signs in range are still waiting to be drawn into the atlas
  get busy() { return this.more || this.dirty; }
  dispose() {
    for (const m of Object.values(this.meshes)) { this.scene.remove(m); m.geometry.dispose(); m.dispose(); }
    this.mat.dispose(); this.letterMat.dispose(); this.poleMat.dispose(); this.atlas.dispose();
  }

  // Signs within the radius, nearest first and capped, plus one atlas job per sign face.
  _gather(camX, camZ, offsets) {
    const f = this.frameNo, A = this.atlas, R2 = this.radius * this.radius, RT2 = 1600 * 1600;
    const shop = [], tower = [], poles = [], speed = [];
    for (const [key, d] of this.src) {
      const off = offsets && offsets.get(key); if (!off || !d) continue;
      const T = d.texts || EMPTY;
      for (const [arr, out] of [[d.shop, shop], [d.tower, tower]]) {
        if (!arr) continue;
        for (let i = 0; i + 7 < arr.length; i += 8) {
          const x = arr[i] + off.x, z = arr[i + 2] + off.z, dd = (x - camX) ** 2 + (z - camZ) ** 2;
          if (dd > (out === tower ? RT2 : R2)) continue;             // tower lettering reads from far off
          const p = T[arr[i + 6] | 0]; if (!p || (!p.en && !p.ar) || !(arr[i + 4] > 0) || !(arr[i + 5] > 0)) continue;
          out.push({ dd, x, y: arr[i + 1], z, rot: arr[i + 3], w: arr[i + 4], h: arr[i + 5], p, lit: arr[i + 7] > 0.5, e: null });
        }
      }
      const s = d.street;
      if (s) for (let i = 0; i + 6 < s.length; i += 7) {
        const x = s[i] + off.x, z = s[i + 1] + off.z, dd = (x - camX) ** 2 + (z - camZ) ** 2;
        if (dd > R2) continue;
        const pA = T[s[i + 4] | 0], pB = s[i + 6] >= 0 ? T[s[i + 6] | 0] : null;
        if (!pA && !pB) continue;
        poles.push({ dd, x, y: s[i + 2], z, rA: s[i + 3], pA, rB: s[i + 5], pB, eA: null, eB: null });
      }
      const v = d.speed;
      if (v) for (let i = 0; i + 4 < v.length; i += 5) {
        const x = v[i] + off.x, z = v[i + 1] + off.z, dd = (x - camX) ** 2 + (z - camZ) ** 2;
        if (dd > R2 || !(v[i + 4] > 0)) continue;
        const k = Math.round(v[i + 4]);
        let p = this._speedP.get(k); if (!p) { p = { kmh: k }; this._speedP.set(k, p); }
        speed.push({ dd, x, y: v[i + 2], z, rot: v[i + 3], p, e: null });
      }
    }
    const byD = (a, b) => a.dd - b.dd;
    shop.sort(byD); tower.sort(byD); poles.sort(byD); speed.sort(byD);
    if (shop.length > CAPS.shop) shop.length = CAPS.shop;
    if (tower.length > CAPS.tower) tower.length = CAPS.tower;
    if (speed.length > CAPS.speed) speed.length = CAPS.speed;
    { let n = 0, k = 0; while (k < poles.length && k < CAPS.pole && n < CAPS.plate) { n += (poles[k].pA ? 1 : 0) + (poles[k].pB ? 1 : 0); k++; } poles.length = k; }

    // resolution tier from the projected size (a mip choice), then what the atlas has cached
    const jobs = [], bias = this.bias, pxs = this.pxScale;
    const job = (c, slot, style, p, hw, y, fit) => {
      const dist = Math.sqrt(c.dd + (y - 1.8) ** 2), tiers = STYLES[style].tiers, need = hw * pxs * bias / Math.max(dist, 1);
      let tier = tiers[tiers.length - 1]; for (const t of tiers) if (t >= need) { tier = t; break; }
      const j = { c, slot, style, p, fit, tier, dd: c.dd, base: A.baseKey(style, p, fit), e: null, fb: false };
      j.e = A.peek(style, p, j); if (j.e) j.e.lastUsed = f;
      jobs.push(j);
    };
    for (const c of shop) job(c, "e", "shop", c.p, c.h, c.y, c.w / c.h);
    for (const c of tower) job(c, "e", "tower", c.p, c.h, c.y, c.w / c.h);
    for (const c of poles) { if (c.pA) job(c, "eA", "street", c.pA, STREET_H, c.y + PLATE_Y, 0); if (c.pB) job(c, "eB", "street", c.pB, STREET_H, c.y + PLATE_Y, 0); }
    for (const c of speed) job(c, "e", "speed", c.p, SPEED.diameter, c.y + SPEED.centre, 0);
    jobs.sort(byD);
    return { shop, tower, poles, speed, jobs };
  }

  // Draw missing entries, nearest first, within budgetMs (at least 2 per call). A job without
  // its own tier yet borrows any cached tier of the same text (fb) and is upgraded later.
  // If the atlas runs full, the rest of the pass only tries the smallest tier for signs that
  // have nothing at all, the bias drops, and the next frame re-gathers at smaller tiers.
  _resolve(cur) {
    const A = this.atlas, f = this.frameNo, t0 = performance.now();
    let more = false, full = false, drawn = 0;
    for (const j of cur.jobs) {
      if (!j.e || j.fb) {
        if (performance.now() - t0 < this.budgetMs || drawn < 2) {
          const small = STYLES[j.style].tiers[0];
          let e = null;
          if (!full) { e = A.get(j.style, j.p, f, j); if (!e) full = true; }
          if (!e && !j.e && small < j.tier) e = A.get(j.style, j.p, f, { base: j.base, fit: j.fit, tier: small });
          if (e) { drawn++; j.e = e; j.fb = false; }
        } else more = true;
        if (!j.e) { const e = A.peekAny(j.style, j.p, j); if (e) { e.lastUsed = f; j.e = e; j.fb = true; } }
      }
      j.c[j.slot] = j.e;
    }
    this.stats.drawnLast = drawn;
    // keep the atlas below ~80 % live use by trading resolution for room
    const live = A.usage(f).live, b0 = this.bias;
    if (full || live > 0.8) this.bias = Math.max(0.3, this.bias * 0.8);
    else if (live < 0.4 && this.bias < 1) this.bias = Math.min(1, this.bias * 1.12);
    if (full && this.bias < b0) this.dirty = true;       // re-gather next frame at the lower bias
    this.more = more;
  }

  _fill(cur) {
    const M = this.meshes, { shop, tower, poles, speed } = cur;
    let n = 0;
    for (const c of shop) {
      const e = c.e; if (!e) continue;
      let w = c.h * e.aspect, h = c.h; if (w > c.w) { w = c.w; h = w / e.aspect; }
      this._set(M.shop, n++, c.x, c.y, c.z, c.rot, w, h, e, c.lit ? 1 : LIT.unlitShop);
    }
    this._done(M.shop, n);
    n = 0;
    for (const c of tower) {
      const e = c.e; if (!e) continue;
      let w = c.h * e.aspect, h = c.h; if (w > c.w) { w = c.w; h = w / e.aspect; }
      this._set(M.tower, n++, c.x, c.y, c.z, c.rot, w, h, e, c.lit ? 1 : 0);
    }
    this._done(M.tower, n);
    let np = 0, nl = 0;
    for (const c of poles) {
      this._set(M.pole, np++, c.x, c.y, c.z, 0, 1, POLE_H, null, 0);
      let y = c.y + PLATE_Y;
      for (const [e, rot] of [[c.eA, c.rA], [c.eB, c.rB]]) {
        if (!e) { y -= STREET_H + PLATE_GAP; continue; }
        // flag mount: the plate runs from the pole along its long axis (cos rot, 0, -sin rot)
        const w = e.aspect * STREET_H, o = w / 2 + POLE_R + 0.015;
        this._set(M.plate, nl++, c.x + Math.cos(rot) * o, y, c.z - Math.sin(rot) * o, rot, w, STREET_H, e, LIT.plate);
        y -= STREET_H + PLATE_GAP;
      }
    }
    this._done(M.pole, np); this._done(M.plate, nl);
    n = 0;
    for (const c of speed) { if (c.e) this._set(M.speed, n++, c.x, c.y, c.z, c.rot, 1, 1, c.e, LIT.speed); }
    this._done(M.speed, n);
    this.stats.instances = { shop: M.shop.count, tower: M.tower.count, plate: M.plate.count, pole: M.pole.count, speed: M.speed.count };
  }
  // Instance i: translation (x, y, z), rotation rot about +Y, scale (sx, sy, 1).
  _set(im, i, x, y, z, rot, sx, sy, e, lit) {
    const m = im.instanceMatrix.array, o = i * 16, c = Math.cos(rot), s = Math.sin(rot);
    m[o] = c * sx; m[o + 1] = 0; m[o + 2] = -s * sx; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = s; m[o + 9] = 0; m[o + 10] = c; m[o + 11] = 0;
    m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
    if (e) {
      const r = im.geometry.attributes.aRect.array, q = i * 4;
      r[q] = e.u0; r[q + 1] = e.v0; r[q + 2] = e.u1; r[q + 3] = e.v1;
      im.geometry.attributes.aLit.array[i] = lit;
    }
  }
  _done(im, n) {
    im.count = n; im.visible = n > 0;
    im.instanceMatrix.clearUpdateRanges(); im.instanceMatrix.addUpdateRange(0, Math.max(1, n) * 16); im.instanceMatrix.needsUpdate = true;
    const a = im.geometry.attributes;
    if (a.aRect) {
      a.aRect.clearUpdateRanges(); a.aRect.addUpdateRange(0, Math.max(1, n) * 4); a.aRect.needsUpdate = true;
      a.aLit.clearUpdateRanges(); a.aLit.addUpdateRange(0, Math.max(1, n)); a.aLit.needsUpdate = true;
    }
  }
}

// ------------------------------------------------------------------ route shields
// UAE federal E routes: white plate, a small blue falcon shield, "E" and its Arabic letter,
// the number below. Dubai D routes: the same plate with a fort emblem.
function drawRouteShield(g, x, y, h, ref) {
  const m = /^\s*([A-Za-z]+)\s*-?\s*(\d+[A-Za-z]?)\s*$/.exec(ref || "");
  const letter = m ? m[1].toUpperCase() : "", num = m ? m[2] : String(ref || "");
  const w = h * (num.length > 2 ? 1.2 : 1.0);
  g.fillStyle = "#ffffff"; rr(g, x, y, w, h, h * 0.13); g.fill();
  g.strokeStyle = "#1c2430"; g.lineWidth = h * 0.045; rr(g, x + h * 0.06, y + h * 0.06, w - h * 0.12, h - h * 0.12, h * 0.09); g.stroke();
  const ty = y + h * 0.28, ex = x + w / 2;
  if (letter === "E") {
    // blue heraldic shield with a white falcon silhouette
    const sw = h * 0.27, sh = h * 0.3, sx = ex - sw / 2, sy = ty - sh / 2;
    g.fillStyle = "#1553a8"; g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + sw, sy); g.lineTo(sx + sw, sy + sh * 0.55);
    g.quadraticCurveTo(sx + sw, sy + sh * 0.9, ex, sy + sh); g.quadraticCurveTo(sx, sy + sh * 0.9, sx, sy + sh * 0.55); g.closePath(); g.fill();
    g.fillStyle = "#ffffff"; g.beginPath(); g.moveTo(ex, sy + sh * 0.2); g.lineTo(ex + sw * 0.34, sy + sh * 0.42); g.lineTo(ex + sw * 0.1, sy + sh * 0.46);
    g.lineTo(ex, sy + sh * 0.78); g.lineTo(ex - sw * 0.1, sy + sh * 0.46); g.lineTo(ex - sw * 0.34, sy + sh * 0.42); g.closePath(); g.fill();
  } else if (letter) {
    // fort: a wall with three merlons and a gate
    const fw = h * 0.32, fh = h * 0.24, fx = ex - fw / 2, fy = ty - fh / 2;
    g.fillStyle = "#8a5a2b"; g.fillRect(fx, fy + fh * 0.28, fw, fh * 0.72);
    for (let i = 0; i < 4; i++) g.fillRect(fx + i * fw * 0.29, fy + fh * 0.08, fw * 0.13, fh * 0.24);
    g.fillRect(fx + fw * 0.36, fy - fh * 0.12, fw * 0.28, fh * 0.44);
    g.fillStyle = "#ffffff"; rr(g, ex - fw * 0.1, fy + fh * 0.58, fw * 0.2, fh * 0.44, fw * 0.1); g.fill();
  }
  g.fillStyle = "#1c2430";
  if (letter) {
    drawText(g, letter, x + w * 0.8, ty, h * 0.27, SANS, w * 0.2);
    const arL = { E: "إ", D: "د", S: "ش", A: "أ" }[letter] || "";
    if (arL) drawText(g, arL, x + w * 0.2, ty, h * 0.3, AR_FONT, w * 0.2, "center", true);
  }
  drawText(g, num, ex, y + h * 0.7, h * 0.46, NUM_FONT, w * 0.8);
  return w;
}

// ------------------------------------------------------------------ guide sign
// arrow: pointing up in its own frame, then rotated; exit arrows bend off to one side.
function drawArrow(g, cx, cy, s, kind) {
  g.save(); g.translate(cx, cy); g.fillStyle = "#ffffff"; g.strokeStyle = "#ffffff";
  const head = (ang) => {
    g.save(); g.rotate(ang);
    g.beginPath(); g.moveTo(0, -0.5 * s); g.lineTo(0.3 * s, -0.12 * s); g.lineTo(-0.3 * s, -0.12 * s); g.closePath(); g.fill();
    g.fillRect(-0.1 * s, -0.14 * s, 0.2 * s, 0.64 * s);
    g.restore();
  };
  if (kind === "exitright" || kind === "exitleft") {
    const m = kind === "exitright" ? 1 : -1;
    g.lineWidth = 0.2 * s; g.lineJoin = "miter"; g.lineCap = "butt";
    g.beginPath(); g.moveTo(-0.18 * s * m, 0.52 * s); g.lineTo(-0.18 * s * m, 0.06 * s); g.lineTo(0.14 * s * m, -0.26 * s); g.stroke();
    g.translate(0.14 * s * m, -0.26 * s); g.rotate(m * Math.PI / 4);
    g.beginPath(); g.moveTo(0, -0.28 * s); g.lineTo(0.27 * s, 0.06 * s); g.lineTo(-0.27 * s, 0.06 * s); g.closePath(); g.fill();
  } else {
    const ang = { up: 0, upright: Math.PI / 4, right: Math.PI / 2, left: -Math.PI / 2, upleft: -Math.PI / 4 }[kind] ?? 0;
    head(ang);
  }
  g.restore();
}
// makeGuideSign({ lines, ar?, exit?, arrow, ref?, ppm? }) -> THREE.Group
// Panel sized to its content (6 to 10 m wide, 2.5 m tall at least) on a thin backing box;
// readable face toward local +Z; origin at the panel's bottom-centre (mount it on a gantry
// beam). ar is an optional array of Arabic names aligned with lines. group.userData holds
// { width, height, panelHeight, tabHeight, dispose }.
export function makeGuideSign(opts = {}) {
  const PPM = opts.ppm || 128;
  const rows = (opts.lines || []).map((t, i) => ({ en: String(t || "").trim(), ar: String((opts.ar || [])[i] || "").trim() })).filter(r => r.en || r.ar);
  const arrow = opts.arrow || "up";
  const side = /right/.test(arrow) ? "right" : "left";
  const exit = opts.exit != null ? String(opts.exit).trim() : "";
  const ref = String(opts.ref || "").trim();
  // Everything scales with the type size fs, which starts at 0.56 m and shrinks until the
  // widest row fits a 10 m panel (row height, route shield and arrow follow it).
  const pad = 0.32, arrowGap = 0.3;
  const mw = (t, fs, ar) => (t ? measure(t, font(fs * PPM, ar ? AR_FONT : SANS), ar) / PPM : 0);
  const rowW = (fs) => { let w = 0; for (const r of rows) w = Math.max(w, mw(r.en, fs) + (r.ar ? 0.9 * fs + mw(r.ar, fs * 1.04, true) : 0)); return w; };
  let fs = 0.56;
  const arrowOf = f => Math.min(1.35, Math.max(0.95, 2.3 * f));
  for (let it = 0; it < 4; it++) {
    const fixed = 2 * pad + arrowOf(fs) + arrowGap, w = Math.max(rowW(fs), ref ? 2.4 * fs : 0);
    if (fixed + w <= 10.001) break;
    fs = Math.max(0.3, fs * (10 - fixed) / w);
  }
  const fsE = fs, fsA = fs * 1.04, rowH = 1.55 * fs, colGap = 0.9 * fs, arrowW = arrowOf(fs), shieldH = ref ? Math.max(0.8, 2.3 * fs) : 0;
  const textW = Math.max(rowW(fs), shieldH * 1.2);
  const fixed = 2 * pad + arrowW + arrowGap;
  const W = Math.min(10, Math.max(6, fixed + textW));
  const contentH = (ref ? shieldH + 0.4 * fs : 0) + rows.length * rowH;
  const Hm = Math.max(2.5, 2 * pad + contentH);
  const tabH = exit ? 0.8 : 0;
  const tabFs = 0.44, tabW = exit ? 2 * 0.3 + mw("EXIT " + exit, tabFs) + 0.45 + mw("مخرج " + exit, tabFs, true) : 0;
  const tabX = exit ? (side === "right" && arrow !== "up" ? W - tabW : arrow === "up" ? (W - tabW) / 2 : 0) : 0;

  const cv = document.createElement("canvas");
  cv.width = Math.ceil(W * PPM); cv.height = Math.ceil((Hm + tabH) * PPM);
  const g = cv.getContext("2d"), P = PPM;
  const face = (x, y, w, h) => {
    g.fillStyle = GUIDE_BLUE; g.fillRect(x, y, w, h);
    const sh = g.createLinearGradient(0, y, 0, y + h); sh.addColorStop(0, "rgba(255,255,255,0.05)"); sh.addColorStop(1, "rgba(0,0,0,0.08)");
    g.fillStyle = sh; g.fillRect(x, y, w, h);
    g.strokeStyle = "#ffffff"; g.lineWidth = 0.07 * P; rr(g, x + 0.1 * P, y + 0.1 * P, w - 0.2 * P, h - 0.2 * P, 0.22 * P); g.stroke();
  };
  if (exit) {
    face(tabX * P, 0, tabW * P, tabH * P);
    g.fillStyle = "#ffffff";
    drawText(g, "EXIT " + exit, (tabX + 0.3) * P, tabH / 2 * P, tabFs * P, SANS, 0, "left");
    drawText(g, "مخرج " + exit, (tabX + tabW - 0.3) * P, tabH / 2 * P, tabFs * P, AR_FONT, 0, "right", true);
  }
  const y0 = tabH * P;
  face(0, y0, W * P, Hm * P);
  const top = (Hm - contentH) / 2;
  const acx = side === "left" ? pad + arrowW / 2 : W - pad - arrowW / 2;
  drawArrow(g, acx * P, y0 + Hm / 2 * P, arrowW * 0.88 * P, arrow);
  const x0 = side === "left" ? pad + arrowW + arrowGap : pad, x1 = side === "left" ? W - pad : W - pad - arrowW - arrowGap;
  let yy = top;
  if (ref) { drawRouteShield(g, x0 * P, y0 + yy * P, shieldH * P, ref); yy += shieldH + 0.4 * fs; }
  g.fillStyle = "#ffffff";
  for (const r of rows) {
    const cy = y0 + (yy + rowH / 2) * P, room = (x1 - x0) * P;
    if (r.en && r.ar) {
      const we = mw(r.en, fsE) * P, wa = mw(r.ar, fsA, true) * P, sc = Math.min(1, (room - colGap * P) / (we + wa));
      drawText(g, r.en, x0 * P, cy, fsE * P, SANS, we * sc, "left");
      drawText(g, r.ar, x1 * P, cy, fsA * P, AR_FONT, wa * sc, "right", true);
    } else if (r.en) drawText(g, r.en, x0 * P, cy, fsE * P, SANS, room, "left");
    else drawText(g, r.ar, x1 * P, cy, fsA * P, AR_FONT, room, "right", true);
    yy += rowH;
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const Htot = Hm + tabH;
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = U.uNight;
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uNight;")
      // retroreflective sheeting under the gantry lights
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uNight * 0.5;");
  };
  mat.customProgramCacheKey = () => "uae-guide-v1";
  const back = new THREE.MeshStandardMaterial({ color: 0x8a9096, roughness: 0.5, metalness: 0.55 });
  const grp = new THREE.Group(); grp.name = "guideSign";
  const facePlane = (w, h, cx, cy, u0, v0, u1, v1) => {
    const geo = new THREE.PlaneGeometry(w, h);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    const m = new THREE.Mesh(geo, mat); m.position.set(cx, cy, 0.012); m.receiveShadow = true;
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.12), back); box.position.set(cx, cy, -0.05); box.castShadow = true; box.receiveShadow = true;
    grp.add(m, box);
  };
  // canvas rows run top-down; CanvasTexture flips, so v = 1 is the canvas top
  facePlane(W, Hm, 0, Hm / 2, 0, 0, 1, Hm / Htot);
  if (exit) facePlane(tabW, tabH, tabX + tabW / 2 - W / 2, Hm + tabH / 2, tabX / W, Hm / Htot, (tabX + tabW) / W, 1);
  grp.userData = {
    width: W, height: Htot, panelHeight: Hm, tabHeight: tabH, canvas: cv,
    dispose() { tex.dispose(); mat.dispose(); back.dispose(); grp.traverse(o => o.geometry && o.geometry.dispose()); },
  };
  return grp;
}
