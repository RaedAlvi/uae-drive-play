// UAE Drive: City. A Three.js driving game on the real Dubai and Abu Dhabi, built live
// from OpenStreetMap vector tiles: procedural facades, lane-marked roads, sidewalks,
// palms, street lamps, AI traffic, hand-built landmarks, day/night, and the same
// missions, GPS, rerouting and Salik/Darb billing as the original game.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Tiles, Index, toWorld, toLatLon, origin, K, TILE, mercX, mercY, hav, segDist, CAP, tileOf, CITY } from "./world.js";
import { Atmosphere } from "./sky.js";
import { Props } from "./props.js";
import { FX, PRESETS } from "./fx.js";
import { Traffic, fallbackTypes, fallbackMaterials } from "./traffic.js";
import { U, makeGroundMaterial } from "./materials.js";
import { CarAudio } from "./audio.js";
import { Peds } from "./peds.js";
import { Nav, remainingSeconds, pointAt } from "./nav.js";
import { Signals, signalState } from "./signals.js";

let VEH = null, LM = null, SG = null, LM2 = null;
try { SG = await import("./signs.js"); } catch (e) { console.warn("signs.js not loaded", e && e.message); }
try { VEH = await import("./vehicles.js"); } catch (e) { console.warn("vehicles.js not loaded, using simple cars", e && e.message); }
try { LM = await import("./landmarks.js"); } catch (e) { console.warn("landmarks.js not loaded", e && e.message); }
try { LM2 = await import("./landmarks2.js"); } catch (e) { console.warn("landmarks2.js not loaded", e && e.message); }
let LMSH = null;
if (CITY.region === "shanghai") try { LMSH = await import("./landmarks_sh.js"); } catch (e) { console.warn("landmarks_sh.js not loaded", e && e.message); }

// ================================================================== data and settings
const D = window.UAE_DRIVE;
const P = Object.fromEntries(D.places.map(p => [p.id, p]));
const LEVELS = CITY.levels || { 1: "Dubai: short hops", 2: "Dubai: cross-city", 3: "Abu Dhabi", 4: "Intercity on the E11" };
const BANDS = {
  offpeak: { label: "Off-peak (10-16, 20-01)", salik: 4.20, darbBridge: 0 },
  peak: { label: "Peak (Mon-Sat 6-10, 16-20)", salik: 6.30, darbBridge: 4 },
  night: { label: "Night (01-06)", salik: 0, darbBridge: 0 },
  sunday: { label: "Sunday", salik: 4.20, darbBridge: 0 },
};
const REF = /^[EDM]\s?\d{1,4}$/, LATIN = /^[A-Za-z0-9 ()\-'./&,]+$/;
const TIMES = [["Morning", 8.2], ["Noon", 12.5], ["Golden hour", 17.55], ["Dusk", 18.45], ["Night", 21.5]];
const CAMS = ["chase", "far", "hood", "heli", "top"];
const CAM_NAMES = { chase: "chase", far: "far chase", hood: "bonnet", heli: "helicopter", top: "top-down" };
function load(k, def) { try { const v = localStorage.getItem(k); return v ? Object.assign({}, def, JSON.parse(v)) : def; } catch (e) { return def; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
const settings = load("uaecity.settings", { band: "offpeak", gps: true, cam: "chase", time: 2, look: "normal", quality: "normal", traffic: "normal", color: 0xf97316, fps: false, sound: true, voice: true, labels: true, vol: 0.7, preview: "drive" });
if (!CAMS.includes(settings.cam)) settings.cam = "chase";
function saveSettings() { save("uaecity.settings", settings); }
function best(id, variant) { return load(`uaecity.best.${id}.${variant}`, null); }
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function fmtKm(km) { return km >= 10 ? km.toFixed(0) + " km" : km.toFixed(1) + " km"; }
function fmtM(m) { return m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m / 10) * 10 + " m"; }
function fmtT(s) { s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
function aed(x) { return x ? "AED " + x.toFixed(2) : "free"; }
function costFor(v, band) {
  const b = BANDS[band]; const ids = new Set(v.gates.map(x => x.id));
  let salik = v.gates.filter(x => x.sys === "salik").length;
  if (ids.has("safa_n") && ids.has("safa_s")) salik--; if (ids.has("mamzar_n") && ids.has("mamzar_s")) salik--;
  return salik * b.salik + v.gates.filter(x => x.sys === "darb").length * b.darbBridge + v.gates.filter(x => x.sys === "darb24").length * 4;
}
function gateCost(g, band) { const b = BANDS[band]; return g.sys === "salik" ? b.salik : g.sys === "darb24" ? 4 : b.darbBridge; }
function gateRule(g) { return g.sys === "salik" ? "AED 4.20 off-peak, 6.30 peak, free 01:00-06:00." : g.sys === "darb24" ? "AED 4 at any hour." : "AED 4 only Mon-Sat 07:00-09:00 and 15:00-19:00, otherwise free."; }
function bearing(a, b) { const la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180, dlo = (b[1] - a[1]) * Math.PI / 180; const y = Math.sin(dlo) * Math.cos(la2), x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dlo); return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360; }
function cumulative(geom) { const c = [0]; for (let i = 1; i < geom.length; i++) c.push(c[i - 1] + hav(geom[i - 1], geom[i])); return c; }
function nearestIdx(geom, p) { let bst = 1e12, bi = -1; for (let i = 0; i < geom.length - 1; i++) { const d = segDist(p, geom[i], geom[i + 1])[0]; if (d < bst) { bst = d; bi = i; } } return [bst, bi]; }
function move(lat, lon, hdg, dist) { const h = hdg * Math.PI / 180; return [lat + dist * Math.cos(h) / 111320, lon + dist * Math.sin(h) / (111320 * Math.cos(lat * Math.PI / 180))]; }

// ================================================================== live routing (same rules as the bake)
const T = { 1: ["start", null], 2: ["start", null], 3: ["start", null], 4: ["arrive", null], 5: ["arrive", null], 6: ["arrive", null], 7: ["becomes", null], 8: ["continue", null], 9: ["turn", "right"], 10: ["turn", "right"], 11: ["turn", "right"], 12: ["turn", "uturn"], 13: ["turn", "uturn"], 14: ["turn", "left"], 15: ["turn", "left"], 16: ["turn", "left"], 17: ["ramp", "straight"], 18: ["ramp", "right"], 19: ["ramp", "left"], 20: ["exit", "right"], 21: ["exit", "left"], 22: ["keep", "straight"], 23: ["keep", "right"], 24: ["keep", "left"], 25: ["merge", null], 37: ["merge", null], 38: ["merge", null], 26: ["roundabout", "exit"], 27: ["roundabout_exit", null] };
const ASK = new Set(["turn", "ramp", "exit", "keep", "roundabout"]);
const AR = /[؀-ۿ\u4e00-\u9fff][؀-ۿ\u4e00-\u9fff\s\-()0-9']*/g;      // Arabic, or Chinese in Shanghai
function enName(n) { if (!n) return ""; if (LATIN.test(n)) return n; return D.names[n] || ""; }
function translate(s) { const found = [...new Set((s.match(AR) || []).map(x => x.trim()).filter(Boolean))].sort((a, b) => b.length - a.length); for (const ar of found) { const en = D.names[ar]; if (en) s = s.split(ar).join(en); } return s.replace(/\/\s*[؀-ۿ][^/.,]*/g, "").replace(/[؀-ۿ][؀-ۿ\s]*/g, "").replace(/\s{2,}/g, " ").replace(/ \./g, ".").trim(); }
function decode6(str) { const out = []; let i = 0, lat = 0, lon = 0; while (i < str.length) { for (let w = 0; w < 2; w++) { let res = 0, sh = 0, b; do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20); const dl = res & 1 ? ~(res >> 1) : res >> 1; if (w === 0) lat += dl; else lon += dl; } out.push([lat / 1e6, lon / 1e6]); } return out; }
function buildVariant(json, fromId, toId) {
  const leg = json.trip.legs[0]; const geom = decode6(leg.shape);
  const steps = leg.maneuvers.map(m => { const [kind, ans] = T[m.type] || ["other", null]; const names = m.street_names || []; const refs = names.filter(n => REF.test(n)); const plain = names.filter(n => !REF.test(n)); const en = plain.map(enName).find(Boolean) || ""; const ar = plain.find(n => !LATIN.test(n)) || ""; const ref = refs[0] || D.refs[ar] || ""; const sign = m.sign || {}; let ask = ASK.has(kind), answer = null; if (kind === "roundabout") { answer = ["exit", m.roundabout_exit_count]; if (!m.roundabout_exit_count) ask = false; } else if (ans) answer = ["dir", ans]; return { kind, type: m.type, en, ar, ref, text: translate(m.instruction), toward: (sign.exit_toward_elements || []).map(x => translate(x.text)).filter(Boolean), exit_no: (sign.exit_number_elements || []).map(x => x.text), km: m.length, sec: m.time, idx: m.begin_shape_index, end: m.end_shape_index, ask, ans: answer, toll: !!m.toll }; });
  const roads = []; for (const s of steps) { const label = s.en || s.ar || s.ref; if (!label || s.kind === "arrive") continue; if (roads.length && roads[roads.length - 1].en === label) roads[roads.length - 1].km += s.km; else roads.push({ en: label, ar: s.ar, ref: s.ref, km: s.km }); }
  const gates = []; for (const g of D.gates) { const [d, bi] = nearestIdx(geom, [g.lat, g.lon]); if (d >= (g.sys === "darb24" ? 60 : 45)) continue; if (g.sys !== "darb24") { const cov = steps.filter(s => s.idx <= bi && bi < Math.max(s.end, s.idx + 1)); if (cov.length && !cov[cov.length - 1].toll) continue; } gates.push({ id: g.id, sys: g.sys, name: g.name, road: g.road, idx: bi, m: Math.round(d) }); }
  gates.sort((a, b) => a.idx - b.idx);
  const passes = []; for (const p of D.places) { if (p.id === fromId || p.id === toId) continue; const [d, bi] = nearestIdx(geom, [p.lat, p.lon]); if (d < 600) passes.push({ id: p.id, idx: bi, d: Math.round(d) }); } passes.sort((a, b) => a.idx - b.idx);
  return { km: +json.trip.summary.length.toFixed(1), min: Math.round(json.trip.summary.time / 60), geom, steps, roads, gates, passes };
}
// Lane guidance for a live route: the same request in OSRM format carries OpenStreetMap turn lanes.
let RDBM = null;
async function liveLanes(a, b, avoid, v) {
  try {
    if (!RDBM) RDBM = await import("./roadsdb.js");
    const json = await valhalla(a, b, avoid, "osrm");
    v.lanes = RDBM.lanesFromOsrm(json, v.geom);
    if (M && M.v === v) setNav();
  } catch (e) { console.warn("live lanes", e && e.message); }
}
async function valhalla(a, b, avoid, format) {
  const sf = { search_filter: { min_road_class: "residential" } };
  const body = { locations: [{ lat: a.lat, lon: a.lon, ...sf }, { lat: b.lat, lon: b.lon, ...sf }], costing: "auto", units: "kilometers", language: "en-US", costing_options: { auto: { use_tolls: 1 } }, directions_options: { units: "kilometers" } };
  if (avoid) body.exclude_locations = D.gates.filter(g => g.sys !== "darb").map(g => ({ lat: g.lat, lon: g.lon }));
  if (format) body.format = format;
  const r = await fetch("https://valhalla1.openstreetmap.de/route", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("router " + r.status);
  return r.json();
}

// ================================================================== renderer, scene, camera
const QUALITY = {
  low: { pr: 0.75, shadow: 0, samples: 0, traffic: 30, radius: 1900, bloom: false },
  normal: { pr: 1, shadow: 2048, samples: 0, traffic: 60, radius: 2600, bloom: true },
  high: { pr: Math.min(1.5, devicePixelRatio || 1), shadow: 4096, samples: 4, traffic: 100, radius: 3300, bloom: true },
};
const Q = QUALITY[settings.quality] || QUALITY.normal;
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance", reversedDepthBuffer: true, stencil: false });
renderer.setPixelRatio(Q.pr);
renderer.setSize(innerWidth, innerHeight);
// Reading back each shader's compile log waits on the GPU (a visible hitch whenever a new material first draws).
renderer.debug.checkShaderErrors = /[?&]debug=1/.test(location.search);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = Q.shadow > 0;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.info.autoReset = false;
document.getElementById("game").appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.3, 60000);
const atmo = new Atmosphere(renderer, scene);
if (Q.shadow) atmo.sun.shadow.mapSize.set(Q.shadow, Q.shadow); else atmo.sun.castShadow = false;
atmo.setHour(TIMES[settings.time] ? TIMES[settings.time][1] : 17.55);
const fx = new FX(renderer, scene, camera, Q.samples);
fx.bloomWanted = Q.bloom;
fx.setMode(settings.look);
fx.setSize(innerWidth, innerHeight);
// endless desert under the tiles
const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), makeGroundMaterial());
ground.rotation.x = -Math.PI / 2; ground.scale.set(80000, 80000, 1); ground.position.y = -0.02; ground.receiveShadow = true;
scene.add(ground);

// ================================================================== world
const IDX = new Index(D);
const trafficTypes = VEH && VEH.makeTrafficTypes ? VEH.makeTrafficTypes() : fallbackTypes();
const trafficMats = VEH && VEH.makeTrafficMaterials ? VEH.makeTrafficMaterials() : fallbackMaterials();
const traffic = new Traffic(scene, trafficTypes, trafficMats);
traffic.target = settings.traffic === "off" ? 0 : settings.traffic === "heavy" ? Q.traffic * 1.6 : Q.traffic;
const props = new Props(scene);
const peds = new Peds(scene, traffic);
const signals = new Signals(scene); traffic.signals = signals;
// street-name plates, shop and hotel signs, speed-limit signs (signs.js)
const signLayer = SG && SG.SignLayer ? new SG.SignLayer(scene) : null;
// names the worker could only find in Arabic get their English form from the route data's table
function englishTexts(signs) { if (!signs || !signs.texts) return signs; for (const t of signs.texts) if (!t.en && t.ar && D.names[t.ar]) t.en = D.names[t.ar]; return signs; }
peds.target = settings.quality === "low" ? 0 : settings.quality === "high" ? 90 : 45;
// Collision-index builds for new tiles, run a few milliseconds per frame (the tile under the
// car first, and to completion, so the physics never runs on a half-built index).
const idxJobs = [];
function runIndexJobs(budgetMs) {
  const t0 = performance.now();
  const [cx, cy] = tileOf(S.lat, S.lon);
  for (let i = 0; i < idxJobs.length; i++) {
    const j = idxJobs[i];
    if (Math.abs(j.x - cx) <= 0 && Math.abs(j.y - cy) <= 0) { for (const _ of j.it) { /* finish */ } idxJobs.splice(i--, 1); gantriesDirty = true; ribbonDirty = true; }
  }
  while (idxJobs.length && performance.now() - t0 < budgetMs) {
    if (idxJobs[0].it.next().done) { idxJobs.shift(); gantriesDirty = true; ribbonDirty = true; }
  }
}
// Global frame for traffic: fixed at load, independent of the floating origin.
const G0 = { mx: origin.mx, my: origin.my };
function globalShift() { return { x: (origin.mx - G0.mx) * K, z: -(origin.my - G0.my) * K }; }
const tiles = new Tiles(scene, {
  radius: Q.radius,
  onReady: t => {
    idxJobs.push({ key: t.key, x: t.x, y: t.y, it: IDX.addTileSteps(t.key, t.coll) }); t.coll = null;
    props.setTile(t.key, t.props);
    signals.setTile(t.key, t.signals); t.signals = null;
    if (signLayer && t.signs) { try { signLayer.setTile(t.key, englishTexts(t.signs)); } catch (e) { console.warn("signs", e); } } t.signs = null;
    const sh = globalShift();
    t.trafficIds = traffic.addTile(t.key, t.traffic, t.off.x + sh.x, t.off.z + sh.z); t.traffic = null;
    gantriesDirty = true; ribbonDirty = true;
  },
  onDrop: t => { IDX.dropTile(t.key); props.dropTile(t.key); traffic.dropTile(t.trafficIds); signals.dropTile(t.key); if (signLayer) signLayer.dropTile(t.key); },
});
// landmarks: suppress OSM buildings under them, place the hand-built models
const landmarks = [];
const ALL_LANDMARKS = [...(LM && LM.LANDMARKS ? LM.LANDMARKS : []), ...(LM2 && LM2.LANDMARKS2 ? LM2.LANDMARKS2.map(L => ({ ...L, dispose: LM2.disposeLandmark })) : []), ...(LMSH ? LMSH.LANDMARKS_SH.map(L => ({ ...L, dispose: LM2.disposeLandmark })) : [])];
{
  for (const L of ALL_LANDMARKS) {
    if (L.suppress && L.suppress.length > 2) {
      let a = 90, b = 180, c = -90, d = -180; const ringLL = [];
      for (const [la, lo] of L.suppress) { if (la < a) a = la; if (la > c) c = la; if (lo < b) b = lo; if (lo > d) d = lo; ringLL.push([lo, la]); }
      tiles.suppress.push({ bbox: [a, b, c, d], ring: ringLL });
    }
    landmarks.push({ def: L, group: null });
  }
}

// Objects placed at a lat/lon keep that anchor; after a rebase they move with it.
const anchors = [];
function anchor(obj, lat, lon) { const y = obj.position.y; obj.userData.ll = [lat, lon]; toWorld(lat, lon, obj.position); obj.position.y = y; if (!anchors.includes(obj)) anchors.push(obj); return obj; }
function reanchor() { for (const o of anchors) { const y = o.position.y; toWorld(o.userData.ll[0], o.userData.ll[1], o.position); o.position.y = y; } }

// ================================================================== the player's car
let car;
if (VEH && VEH.makePlayerCar) car = VEH.makePlayerCar({ color: settings.color, beams: false });
else {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.7, 4.5), new THREE.MeshPhysicalMaterial({ color: settings.color, metalness: 0.6, roughness: 0.35, clearcoat: 1 }));
  body.position.y = 0.6; body.castShadow = true; g.add(body);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 2), new THREE.MeshStandardMaterial({ color: 0x111820, roughness: 0.1, metalness: 0.5 })); cab.position.set(0, 1.15, 0.3); g.add(cab);
  car = { group: g, body, wheels: [], setBrake() {}, setHeadlights() {}, setReverse() {}, setColor(c) { body.material.color.set(c); }, update() {}, dims: { length: 4.5, width: 1.95, height: 1.3 } };
}
car.group.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
scene.add(car.group);
// Headlights: a real SpotLight would add a light to every material's shader. Instead the road,
// sidewalk, area and ground shaders paint the beam pool from these uniforms (materials.js).

// ================================================================== GPS ribbon, destination beam, gantries, labels
const GPS_BLUE = new THREE.Color(0x2f7bff);
// the road material is drawn with a polygon offset (to sit over the ground areas), so the
// route line and turn arrows need a stronger one to stay on top of the asphalt at a distance
const gpsMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, fog: true, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -16,
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uCol: { value: GPS_BLUE.clone() }, uProg: { value: -1e9 }, uAlphaMul: { value: 1 } }]),
  vertexShader: /* glsl */`#include <common>
#include <fog_pars_vertex>
varying vec2 vUv; void main() { vUv = uv; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
#include <fog_vertex>
}`,
  fragmentShader: /* glsl */`#include <common>
#include <fog_pars_fragment>
uniform float uTime; uniform vec3 uCol; uniform float uProg; uniform float uAlphaMul; varying vec2 vUv;
void main() {
  float ahead = vUv.y - uProg;                       // metres ahead of the car along the route
  if (ahead < -3.0) discard;
  float across = abs(vUv.x - 0.5) * 2.0;
  float edge = smoothstep(1.0, 0.88, across);
  float border = smoothstep(0.6, 0.78, across);
  float chev = fract(vUv.y / 10.0 - uTime * 0.45 + across * 0.32);
  float c = smoothstep(0.0, 0.05, chev) * smoothstep(0.26, 0.19, chev) * (1.0 - border);
  vec3 col = mix(uCol, uCol * 0.45, border);
  col = mix(col, vec3(1.0), c * 0.7);
  float a = mix(0.5, 0.72, border) + 0.2 * c;
  a *= edge * smoothstep(-3.0, 8.0, ahead);
  gl_FragColor = vec4(col, a * uAlphaMul * mix(0.35, 1.0, smoothstep(4.0, 30.0, ahead)));
#include <fog_fragment>
}`,
});
let gpsMesh = null, altMesh = null;
function ribbonMesh(geom, width, mat, y, cum) {
  if (!geom || geom.length < 2) return null;
  const [la0, lo0] = geom[0];
  const base = toWorld(la0, lo0);
  const pts = geom.map(([la, lo]) => { const v = toWorld(la, lo); return [v.x - base.x, v.z - base.z]; });
  const pos = [], uv = [], idx = [], nrm = []; let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    if (i > 0) acc += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    const lx = dz, lz = -dx; nrm.push([lx, lz]);
    pos.push(p[0] + lx * width / 2, y, p[1] + lz * width / 2, p[0] - lx * width / 2, y, p[1] - lz * width / 2);
    const v = cum ? cum[i] : acc;
    uv.push(0, v, 1, v);
    if (i < pts.length - 1) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.renderOrder = 2;
  anchor(m, la0, lo0); m.position.y = 0;
  m.userData.geom = geom; m.userData.y = y; m.userData.pts = pts; m.userData.nrm = nrm; m.userData.w = width;
  return m;
}
// Lift the GPS ribbon onto flyovers: each route point takes the height of the indexed road
// beneath it that runs the same way (so a route under a bridge stays on the ground).
function alignedRoad(lat, lon, brg) {
  let best = null, bd = 1e9, bt = 0;
  for (const s of IDX.roads.get(IDX.key(lat, lon)) || []) {
    const [d, t] = segDist([lat, lon], s.a, s.b); if (d > s.hw + 3) continue;
    let db = Math.abs(((bearing(s.a, s.b) - brg + 540) % 360) - 180); db = Math.min(db, 180 - db);
    const score = d + db * 0.6;
    if (score < bd) { bd = score; best = s; bt = t; }
  }
  return best ? { s: best, e: best.ea + (best.eb - best.ea) * bt } : null;
}
function elevAligned(lat, lon, brg) { const r = alignedRoad(lat, lon, brg); return r ? r.e : null; }
// On a two-way road the route runs down the middle; drivers keep right, so the line and the
// turn arrows move into the right-hand half (a quarter of the road width off the centre).
function rightShift(r) { return r && !r.s.ow && r.s.w ? r.s.w * 0.25 : 0; }
function liftRibbon(m) {
  if (!m || !IDX.ready) return;
  const geom = m.userData.geom, pos = m.geometry.attributes.position, y0 = m.userData.y, pts = m.userData.pts, nrm = m.userData.nrm, hw = m.userData.w / 2;
  let sh = 0;
  for (let i = 0; i < geom.length; i++) {
    const o = geom[Math.max(0, i - 1)], q = geom[Math.min(geom.length - 1, i + 1)];
    const r = alignedRoad(geom[i][0], geom[i][1], bearing(o, q));
    if (r) sh += (rightShift(r) - sh) * (i ? 0.5 : 1);
    const [lx, lz] = nrm[i], p = pts[i];
    const cx = p[0] - lx * sh, cz = p[1] - lz * sh, y = y0 + (r ? r.e : 0);
    pos.setXYZ(2 * i, cx + lx * hw, y, cz + lz * hw); pos.setXYZ(2 * i + 1, cx - lx * hw, y, cz - lz * hw);
  }
  pos.needsUpdate = true;
}
function setGps(geom, alt) {
  for (const m of [gpsMesh, altMesh]) if (m) { scene.remove(m); m.geometry.dispose(); const i = anchors.indexOf(m); if (i >= 0) anchors.splice(i, 1); }
  gpsMesh = geom && geom.length > 1 ? ribbonMesh(geom, 2.6, gpsMat, 0.14, M && M.v && M.v.geom === geom ? M.cum : null) : null; if (gpsMesh) { scene.add(gpsMesh); ribbonDirty = true; }
  clearTurnArrow(); clearGuides(true);
  const altMat = new THREE.MeshBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.35, depthWrite: false });
  altMesh = alt && alt.length > 1 ? ribbonMesh(alt, 1.6, altMat, 0.13) : null; if (altMesh) scene.add(altMesh);
  if (mini && mini.getSource && mini.getSource("gps")) mini.getSource("gps").setData({ type: "Feature", geometry: { type: "LineString", coordinates: (geom || []).map(p => [p[1], p[0]]) } });
}
// The big arrow painted on the road through the next turn (like a satnav's live view):
// it follows the route from 32 m before the maneuver to 18 m after and ends in an arrowhead.
const arrowMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, fog: true, polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -20,
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uAlpha: { value: 1 } }]),
  vertexShader: /* glsl */`#include <common>
#include <fog_pars_vertex>
varying vec2 vUv; void main() { vUv = uv; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
#include <fog_vertex>
}`,
  fragmentShader: /* glsl */`#include <common>
#include <fog_pars_fragment>
uniform float uTime; uniform float uAlpha; varying vec2 vUv;
void main() {
  float across = abs(vUv.x - 0.5) * 2.0;
  float border = smoothstep(0.62, 0.74, across);
  float sweep = smoothstep(0.0, 0.25, fract(vUv.y * 0.05 - uTime * 0.8)) * 0.25;
  vec3 col = mix(vec3(1.0) - sweep * 0.2, vec3(0.1, 0.36, 0.95), border);
  gl_FragColor = vec4(col, uAlpha * smoothstep(1.0, 0.94, across) * smoothstep(0.0, 6.0, vUv.y));
#include <fog_fragment>
}`,
});
let turnArrow = null, turnArrowFor = -1;
// Overhead direction signs over the motorway before each exit and fork on the route, with the
// exit number and destinations from the route's own sign data (OpenStreetMap destination tags).
const guides = new Map();          // maneuver distance -> gantry group
function clearGuides(all) {
  for (const [at, g] of guides) {
    if (!all && M && at > M.progress - 30) continue;
    guides.delete(at);
    dropGantry(g);
  }
}
const GUIDE_ARROW = { exit: s => s > 0 ? "exitright" : "exitleft", ramp: s => s > 0 ? "exitright" : "exitleft", keep: s => s > 0 ? "upright" : s < 0 ? "upleft" : "up" };
function buildGuide(m) {
  guides.set(m.at, null);
  if (!SG || !SG.makeGuideSign || !GUIDE_ARROW[m.shape]) return;
  const g = M.v.geom, cum = M.cum;
  const s = m.at - 280; if (s < M.progress + 60) return;
  const [la, lo] = pointAt(g, cum, s), a = pointAt(g, cum, s - 12), b = pointAt(g, cum, s + 12);
  if (!worldReadyAt(la, lo)) { guides.delete(m.at); return; }            // not loaded yet: try again next time
  const hdg = bearing(a, b), r = alignedRoad(la, lo, hdg);
  if (!r || !/^(motorway|trunk)/.test(r.s.cls)) return;
  const lines = (m.toward.length ? m.toward : [m.main || m.road]).filter(Boolean).slice(0, 3);
  if (!lines.length) return;
  const ref = /^[EDM]\s?\d/.test(m.roadRef) ? m.roadRef : "";
  const grp = makeGantry(la, lo, hdg, r, { lines, exit: m.exitNo || undefined, arrow: GUIDE_ARROW[m.shape](m.side), ref: ref || undefined }, m.side);
  if (grp) guides.set(m.at, grp);
}
// A sign gantry across the carriageway at (la, lo) facing traffic heading `hdg`, the panel over
// the lanes it points to (side +1 right, -1 left, 0 middle). Returns the group (in the scene).
const GANTRY_STEEL = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.6, roughness: 0.4 });
function makeGantry(la, lo, hdg, r, signOpts, side) {
  let sign;
  try { sign = SG.makeGuideSign(signOpts); } catch (e) { console.warn("guide sign", e); return null; }
  const w = Math.max(9, r.s.w || 12), grp = new THREE.Group();
  const half = w / 2 + 1.4, top = 6.2 + (sign.userData.height || 3);
  const frame = [];
  for (const x of [-half, half]) { const post = new THREE.BoxGeometry(0.5, top + 0.4, 0.5); post.translate(x, (top + 0.4) / 2, 0); frame.push(post); }
  for (const y of [6.0, top]) { const beam = new THREE.BoxGeometry(2 * half + 0.5, 0.35, 0.35); beam.translate(0, y, -0.25); frame.push(beam); }
  grp.add(new THREE.Mesh(mergeGeometries(frame), GANTRY_STEEL));
  const room = Math.max(0, half - (sign.userData.width || 8) / 2 - 0.3);
  sign.position.set(side > 0 ? Math.min(room, w / 4) : side < 0 ? -Math.min(room, w / 4) : 0, 6.15, 0); grp.add(sign);
  grp.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  grp.rotation.y = -hdg * Math.PI / 180;
  grp.position.y = r.e || 0;
  grp.userData.sign = sign;
  anchor(grp, la, lo); scene.add(grp);
  return grp;
}
function dropGantry(g) {
  if (!g) return;
  scene.remove(g); const i = anchors.indexOf(g); if (i >= 0) anchors.splice(i, 1);
  g.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  if (g.userData.sign && g.userData.sign.userData.dispose) g.userData.sign.userData.dispose();
}
// Direction signs at every motorway exit (data/exits.js, OpenStreetMap destination tags), not
// just on your route: a gantry 250 m before the exit with its number and destinations.
const EXITS = (window.UAE_EXITS || []).map(e => ({ lat: e[0], lon: e[1], brg: e[2], no: e[3], dest: e[4].split("|").filter(Boolean), ref: e[5], g: undefined, tries: 0 }));
const EXIT_CELL = 0.02, exitGrid = new Map();
for (const e of EXITS) { const k = Math.floor(e.lat / EXIT_CELL) + "_" + Math.floor(e.lon / EXIT_CELL); let a = exitGrid.get(k); if (!a) exitGrid.set(k, a = []); a.push(e); }
const exitsBuilt = new Set();
function updateExits() {
  if (!SG || !SG.makeGuideSign || !EXITS.length || !IDX.ready) return;
  const i0 = Math.floor(S.lat / EXIT_CELL), j0 = Math.floor(S.lon / EXIT_CELL);
  let built = 0;
  for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) for (const e of exitGrid.get(i + "_" + j) || []) {
    if (e.g !== undefined || built >= 2) continue;
    const d = hav([S.lat, S.lon], [e.lat, e.lon]); if (d > 1400) continue;
    built++; buildExit(e);
  }
  for (const e of [...exitsBuilt]) if (hav([S.lat, S.lon], [e.lat, e.lon]) > 2200) { dropGantry(e.g); e.g = undefined; exitsBuilt.delete(e); }
}
function buildExit(e) {
  // the main carriageway the link leaves: a motorway or trunk running within 35 degrees of it
  if (!worldReadyAt(e.lat, e.lon)) return;
  let main = null, bd = 1e9;
  for (const sg of IDX.roads.get(IDX.key(e.lat, e.lon)) || []) {
    if (!/^(motorway|trunk)$/.test(sg.cls)) continue;
    const [d] = segDist([e.lat, e.lon], sg.a, sg.b); if (d > sg.hw + 6) continue;
    let db = ((bearing(sg.a, sg.b) - e.brg + 540) % 360) - 180; if (Math.abs(db) > 35) continue;
    if (d + Math.abs(db) * 0.3 < bd) { bd = d + Math.abs(db) * 0.3; main = sg; }
  }
  if (!main) { if (++e.tries > 3) e.g = null; return; }
  const h = bearing(main.a, main.b);
  const side = ((e.brg - h + 540) % 360) - 180 >= 0 ? 1 : -1;       // the link peels off to this side
  const [qa, qo] = move(e.lat, e.lon, h + 180, 250);
  if (!worldReadyAt(qa, qo)) return;
  const r = alignedRoad(qa, qo, h);
  if (!r || !/^(motorway|trunk)$/.test(r.s.cls)) { e.g = null; return; }
  // centre the gantry on that carriageway
  const [, t] = segDist([qa, qo], r.s.a, r.s.b), cla = r.s.a[0] + (r.s.b[0] - r.s.a[0]) * t, clo = r.s.a[1] + (r.s.b[1] - r.s.a[1]) * t;
  // the route's own gantry for this exit is already there
  for (const g of guides.values()) if (g && g.userData.ll && hav(g.userData.ll, [cla, clo]) < 150) { e.g = null; return; }
  e.g = makeGantry(cla, clo, h, r, { lines: e.dest.slice(0, 3), exit: e.no || undefined, arrow: side > 0 ? "exitright" : "exitleft", ref: /^[EDM]\s?\d/.test(e.ref) ? e.ref : undefined }, side);
  if (e.g) exitsBuilt.add(e);
}
function clearTurnArrow() { if (turnArrow) { scene.remove(turnArrow); turnArrow.geometry.dispose(); const i = anchors.indexOf(turnArrow); if (i >= 0) anchors.splice(i, 1); turnArrow = null; } turnArrowFor = -1; }
function buildTurnArrow(at) {
  clearTurnArrow();
  turnArrowFor = at;
  const g = M.v.geom, cum = M.cum, total = cum[cum.length - 1];
  const s0 = Math.max(0, at - 32), s1 = Math.min(total, at + 18); if (s1 - s0 < 12) return;
  const [la0, lo0] = pointAt(g, cum, at); const base = toWorld(la0, lo0);
  const P = [];
  for (let s = s0; s <= s1 + 0.01; s += 1.5) { const [la, lo] = pointAt(g, cum, s); const v = toWorld(la, lo); P.push({ x: v.x - base.x, z: v.z - base.z, la, lo }); }
  // smooth the polyline a little so the turn reads as one sweep
  for (let it = 0; it < 3; it++) for (let i = 1; i < P.length - 1; i++) { P[i].x = (P[i - 1].x + 2 * P[i].x + P[i + 1].x) / 4; P[i].z = (P[i - 1].z + 2 * P[i].z + P[i + 1].z) / 4; }
  const W = 1.7, HW = 4.2, HL = 6, n = P.length, pos = [], uv = [], idx = [];
  const headStart = Math.max(2, n - 1 - Math.round(HL / 1.5));
  let sh = 0, acc = 0;
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const lx = dz, lz = -dx;
    const r = IDX.ready ? alignedRoad(P[i].la, P[i].lo, (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360) : null;
    sh += (rightShift(r) - sh) * (i ? 0.3 : 1);
    const y = (r ? r.e : 0) + 0.2;
    if (i) acc += Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z);
    const cx = P[i].x - lx * sh, cz = P[i].z - lz * sh;
    // the shaft, then a step out to the arrowhead's full width, tapering to the tip
    const rows = i === headStart ? [W, HW] : [i > headStart ? HW * (1 - (i - headStart) / Math.max(1, n - 1 - headStart)) : W];
    for (let r2 = 0; r2 < rows.length; r2++) {
      const w = Math.max(0.02, rows[r2]);
      const k = pos.length / 3;
      pos.push(cx + lx * w, y, cz + lz * w, cx - lx * w, y, cz - lz * w); uv.push(0, acc, 1, acc);
      if (k > 0 && !(i === headStart && r2 === 1)) idx.push(k - 2, k - 1, k, k - 1, k + 1, k);
    }
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(idx);
  turnArrow = new THREE.Mesh(geo, arrowMat); turnArrow.frustumCulled = false; turnArrow.renderOrder = 3;
  anchor(turnArrow, la0, lo0); turnArrow.position.y = 0; scene.add(turnArrow);
}
// GTA-style destination beam
const beam = new THREE.Group();
{
  const mat = new THREE.MeshBasicMaterial({ color: 0x4d8dff, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 320, 24, 1, true), mat); cyl.position.y = 160; beam.add(cyl);
  const ring = new THREE.Mesh(new THREE.RingGeometry(5, 7.5, 40), new THREE.MeshBasicMaterial({ color: 0x9cc2ff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.2; beam.add(ring);
  beam.visible = false; scene.add(beam);
}
// Salik / Darb gantries across the carriageway, built once the road under them is indexed
const gantries = new Map(); let gantriesDirty = false, ribbonDirty = false;
function signTexture(text, bg, fg) {
  const c = document.createElement("canvas"); c.width = 256; c.height = 64; const x = c.getContext("2d");
  x.fillStyle = bg; x.fillRect(0, 0, 256, 64); x.fillStyle = fg; x.font = "bold 40px Segoe UI, Arial"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(text, 128, 34);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const signTex = { salik: signTexture("SALIK", "#0f3d6e", "#ffffff"), darb: signTexture("DARB", "#b45309", "#ffffff") };
function buildGantries() {
  gantriesDirty = false;
  const RANK = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, motorway_link: 5, trunk_link: 5 };
  for (const g of D.gates) {
    if (gantries.has(g.id)) continue;
    // Gate nodes sit on or beside a carriageway (often 10 to 20 m from its centre line), and real
    // gantries span the whole road: find every parallel carriageway within 45 m and cover them all.
    const c = IDX.cell, i0 = Math.floor(g.lat / c), j0 = Math.floor(g.lon / c);
    const near = [];
    for (let i = i0 - 2; i <= i0 + 2; i++) for (let j = j0 - 2; j <= j0 + 2; j++) for (const s of IDX.roads.get(i + "_" + j) || []) {
      if (RANK[s.cls] === undefined || s.brunnel === "tunnel") continue;
      const [d, t] = segDist([g.lat, g.lon], s.a, s.b); if (d < 45) near.push({ s, d, t });
    }
    if (!near.length) continue;
    near.sort((a, b) => RANK[a.s.cls] - RANK[b.s.cls] || a.d - b.d);
    const main = near[0].s, hdg = bearing(main.a, main.b);
    const h = hdg * Math.PI / 180, rE = Math.cos(h), rN = -Math.sin(h);            // right of travel, as (east, north)
    const kx = 111320 * Math.cos(g.lat * Math.PI / 180), ky = 110574;
    let lo = 1e9, hi = -1e9;
    for (const { s, t } of near) {
      if (RANK[s.cls] > RANK[main.cls] + 1) continue;
      let db = Math.abs(((bearing(s.a, s.b) - hdg + 540) % 360) - 180); db = Math.min(db, 180 - db); if (db > 25) continue;
      const pLat = s.a[0] + (s.b[0] - s.a[0]) * t, pLon = s.a[1] + (s.b[1] - s.a[1]) * t;
      const off = (pLon - g.lon) * kx * rE + (pLat - g.lat) * ky * rN;
      lo = Math.min(lo, off - s.hw); hi = Math.max(hi, off + s.hw);
    }
    if (lo > hi) { lo = -main.hw; hi = main.hw; }
    const width = Math.max(14, hi - lo + 3), mid = (lo + hi) / 2;
    const cLat = g.lat + mid * rN / ky, cLon = g.lon + mid * rE / kx;
    const r = { eAt: main.ea + (main.eb - main.ea) * near[0].t };
    const grp = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.7, roughness: 0.35 });
    const frame = [];
    for (const s of [-1, 1]) { const post = new THREE.BoxGeometry(0.6, 8, 0.6); post.translate(s * width / 2, 4, 0); frame.push(post); }
    const beamG = new THREE.BoxGeometry(width + 0.6, 1.1, 1.2); beamG.translate(0, 7.6, 0); frame.push(beamG);
    grp.add(new THREE.Mesh(mergeGeometries(frame), steel));
    const sys = g.sys === "salik" ? "salik" : "darb";
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.5), new THREE.MeshStandardMaterial({ map: signTex[sys], emissive: 0xffffff, emissiveMap: signTex[sys], emissiveIntensity: 0.25 }));
    sign.position.set(0, 7.6, 0.62); grp.add(sign);
    const back = sign.clone(); back.rotation.y = Math.PI; back.position.z = -0.62; grp.add(back);
    const cams = []; for (let k = -2; k <= 2; k++) { const cam = new THREE.BoxGeometry(0.4, 0.4, 0.6); cam.translate(k * width / 5, 6.8, 0.3); cams.push(cam); }
    grp.add(new THREE.Mesh(mergeGeometries(cams), new THREE.MeshStandardMaterial({ color: 0x222222 })));
    grp.rotation.y = -hdg * Math.PI / 180;                  // local X spans across the road
    grp.position.y = r.eAt || 0;                             // gantries on flyovers stand on the deck
    grp.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    anchor(grp, cLat, cLon); scene.add(grp);
    gantries.set(g.id, grp);
  }
}
// screen-space labels
const POI_TAG = { metro: "M", mall: "Mall", hotel: "Hotel", sight: "", health: "+", edu: "", park: "", ferry: "Ferry", landmark: "", mosque: "" };
const labelsEl = document.getElementById("labels");
const labelPool = [];
// in front of the camera? (with the reversed depth buffer a point behind it still projects to a
// depth inside 0..1, mirrored onto the screen, so test in camera space instead)
const _cv = new THREE.Vector3();
function ahead(v) { return _cv.copy(v).applyMatrix4(camera.matrixWorldInverse).z < -2; }
function labelAt(i, html, cls) { let el = labelPool[i]; if (!el) { el = document.createElement("div"); labelsEl.appendChild(el); labelPool[i] = el; } if (el._h !== html) { el.innerHTML = html; el._h = html; } el.className = "lbl " + (cls || ""); el.style.display = ""; return el; }
const _v = new THREE.Vector3();
function drawLabels() {
  let n = 0;
  const list = [];
  const fLL = PV.on ? PV.ll : [S.lat, S.lon], fR = PV.sky ? 2600 : 1400, lf = PV.on ? PV.w : carPos;
  if (running) {
    for (const p of D.places) { if (M && (p.id === M.route.to)) continue; const d = hav(fLL, [p.lat, p.lon]); if (d < fR) list.push({ lat: p.lat, lon: p.lon, y: 30, html: esc(p.label), cls: "", d: PV.sky ? d * 0.6 : d }); }
    for (const g of D.gates) { const d = hav([S.lat, S.lon], [g.lat, g.lon]); if (d < 900) list.push({ lat: g.lat, lon: g.lon, y: 10.5, html: (g.sys === "salik" ? "SALIK " : "DARB ") + esc(g.name), cls: g.sys === "salik" ? "gate" : "darb", d }); }
    if (M && !M.free) { const dest = M.v.geom[M.v.geom.length - 1]; const d = hav(fLL, dest); list.push({ lat: dest[0], lon: dest[1], y: 40, html: esc(P[M.route.to] ? P[M.route.to].label : "Destination") + `<small>${fmtM(d)}</small>`, cls: "dest", d }); }
  }
  const W = innerWidth, H = innerHeight;
  for (const L of list) {
    toWorld(L.lat, L.lon, _v); _v.y = L.y;
    if (!ahead(_v)) continue; _v.project(camera);
    if ( Math.abs(_v.x) > 1.1 || Math.abs(_v.y) > 1.1) continue;
    const el = labelAt(n++, L.html, L.cls);
    el.style.left = ((_v.x + 1) / 2 * W).toFixed(0) + "px"; el.style.top = ((1 - _v.y) / 2 * H).toFixed(0) + "px";
    el.style.opacity = L.cls === "dest" ? 1 : Math.max(0.25, 1 - L.d / 1600);
  }
  // named places from the map around you: metro stations, malls, hotels, sights (nearest first, no overlaps)
  if (running && settings.labels !== false && S.y > -1.5) {                // not through the walls of a tunnel
    const fx = camera.position.x, fz = camera.position.z, cand = [];
    for (const t of tiles.tiles.values()) {
      if (!t.labels || !t.off || t.state !== "ready") continue;
      for (const L of t.labels) { const x = L.x + t.off.x, z = L.z + t.off.z, d = Math.hypot(x - lf.x, z - lf.z); if (d < (PV.sky ? 1500 : 700)) cand.push({ L, x, z, d: PV.sky ? d / 2 : d }); }
    }
    // the hand-built landmarks are named too (they come first within 1.5 km)
    for (const L of landmarks) {
      if (!L.group) continue;
      const x = L.group.position.x, z = L.group.position.z, d = Math.hypot(x - lf.x, z - lf.z);
      if (d < (PV.sky ? 3000 : 1500)) cand.push({ L: { en: L.def.name, k: "landmark", y: Math.min((L.def.height || 60) * 0.55, 140) }, x, z, d: d * 0.4 });
    }
    cand.sort((a, b) => a.d - b.d);
    const used = [], perKind = {}, seenNames = new Set(list.map(L => L.html.replace(/<[^>]*>.*$/, "").toLowerCase())); let shown = 0;
    for (const c of cand) {
      if (shown >= 5) break;
      if ((perKind[c.L.k] || 0) >= 2) continue;
      _v.set(c.x, c.L.y, c.z);
      if (!ahead(_v)) continue; _v.project(camera);
      if ( Math.abs(_v.x) > 1.02 || _v.y > 0.95 || _v.y < -0.6) continue;
      const sx = (_v.x + 1) / 2 * W, sy = (1 - _v.y) / 2 * H;
      if (used.some(u => Math.abs(u[0] - sx) < 150 && Math.abs(u[1] - sy) < 30)) continue;
      used.push([sx, sy]); shown++; perKind[c.L.k] = (perKind[c.L.k] || 0) + 1;
      const nm = c.L.en || D.names[c.L.ar] || "";
      if (!nm || nm.length > 34 || seenNames.has(nm.toLowerCase())) continue;
      seenNames.add(nm.toLowerCase());
      const el = labelAt(n++, `<i>${POI_TAG[c.L.k] || ""}</i>${esc(nm)}`, "poi k-" + c.L.k);
      el.style.left = sx.toFixed(0) + "px"; el.style.top = sy.toFixed(0) + "px";
      el.style.opacity = Math.max(0.35, 1 - c.d / 800).toFixed(2);
    }
  }
  for (let i = n; i < labelPool.length; i++) labelPool[i].style.display = "none";
}

// ================================================================== minimap (MapLibre, north-up)
let mini = null, miniCar = null, miniDest = null;
try {
  mini = new maplibregl.Map({ container: "minimap", style: "https://tiles.openfreemap.org/styles/positron", center: [CITY.lon, CITY.lat], zoom: 13.2, interactive: false, attributionControl: false, fadeDuration: 0 });
  mini.on("load", () => {
    for (const l of mini.getStyle().layers) {
      const tf = l.layout && l.layout["text-field"];
      if (l.type === "symbol" && tf && JSON.stringify(tf).includes("name")) mini.setLayoutProperty(l.id, "text-field", ["coalesce", ["get", "name:en"], ["get", "name_en"], ["get", "name:latin"], ""]);
    }
    mini.addSource("gps", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } } });
    // route drawn like a satnav: a dark casing under a bright blue line, above the street labels' roads
    mini.addLayer({ id: "gps-case", type: "line", source: "gps", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#1d4ed8", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 6, 17, 13] } });
    mini.addLayer({ id: "gps", type: "line", source: "gps", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#4c8dff", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3.5, 17, 9] } });
    const ce = document.createElement("div"); ce.className = "mini-car"; miniCar = new maplibregl.Marker({ element: ce, rotationAlignment: "map" }).setLngLat([55.27, 25.2]).addTo(mini);
    const dd = document.createElement("div"); dd.className = "mini-dest"; miniDest = new maplibregl.Marker({ element: dd, anchor: "bottom" }).setLngLat([55.27, 25.2]).addTo(mini); dd.hidden = true;
    if (M) setGps(settings.gps && !M.free ? M.v.geom : [], null);
  });
} catch (e) { console.warn("minimap", e); }

// ================================================================== car physics (ported unchanged from the vector game)
const keys = {};
const audio = new CarAudio(); audio.on = settings.sound !== false; audio.vol = settings.vol ?? 0.7;
addEventListener("keydown", e => { audio.start(); if (e.repeat) return; keys[e.key.toLowerCase()] = true; if (e.key.toLowerCase() === "h") audio.hornOn = true; onKey(e); });
addEventListener("keyup", e => { keys[e.key.toLowerCase()] = false; if (e.key.toLowerCase() === "h") audio.hornOn = false; });
addEventListener("pointerdown", () => audio.start());
const Kk = { up: () => keys["w"] || keys["arrowup"], down: () => keys["s"] || keys["arrowdown"], left: () => keys["a"] || keys["arrowleft"], right: () => keys["d"] || keys["arrowright"], hb: () => keys[" "] };
const LIMIT = { motorway: 120, trunk: 100, primary: 80, secondary: 60, tertiary: 60, minor: 40, service: 25, motorway_link: 80, trunk_link: 60, raceway: 300 };
const S = { lat: CITY.lat, lon: CITY.lon, y: 0, yT: 0, hdg: 0, v: 0, steer: 0, onRoad: true, cls: "minor", name: "", ref: "", nameAr: "", brunnel: "", lastNameT: 0, lastRoadT: 0, crashT: 0 };
let M = null, paused = false, running = false, lastT = performance.now();
function step(dt) {
  const throttle = Kk.up() ? 1 : 0, brake = Kk.down() ? 1 : 0, sIn = Kk.left() ? -1 : Kk.right() ? 1 : 0;
  S.steer += (sIn - S.steer) * Math.min(1, dt * 9);
  const cap = S.onRoad ? (CAP[S.cls] || CAP.minor) : CAP.offroad;
  let v = S.v;
  if (throttle) v += (v < cap ? (v < 25 ? 10 : 6.5) : -4) * dt;
  else if (brake) v += (v > 0.4 ? -13 : v > -9 ? -4 : 0) * dt;
  else v -= Math.sign(v) * Math.min(Math.abs(v), (1.4 + 0.0025 * v * v) * dt);
  if (!S.onRoad && v > cap) v -= 6 * dt;
  if (Kk.hb()) { v -= Math.sign(v) * Math.min(Math.abs(v), 14 * dt); }
  if (Math.abs(v) > 0.15) {
    const omega = Math.min(1, Math.abs(v) / 4) * ((Kk.hb() ? 115 : 75) - 30 * Math.min(1, Math.abs(v) / 70));
    S.hdg = (S.hdg + S.steer * omega * dt * Math.sign(v) + 360) % 360;
  }
  const [nlat, nlon] = move(S.lat, S.lon, S.hdg, v * dt);
  if (v !== 0 && S.y < -1.2) { const r = IDX.roadAt(nlat, nlon, S.y); if (!r || Math.abs(r.eAt - S.y) > 3) { S.v = -v * 0.25; if (performance.now() - S.crashT > 400) audio.crash(Math.abs(v)); S.crashT = performance.now(); flash(); return; } }
  if (v !== 0 && IDX.hits(nlat, nlon)) { S.v = -v * 0.25; if (performance.now() - S.crashT > 400) audio.crash(Math.abs(v)); S.crashT = performance.now(); flash(); return; }
  S.lat = nlat; S.lon = nlon; S.v = v;
  S.brake = brake && v > 0.5; S.reverse = v < -0.3;
  if (M) { M.dist += Math.abs(v * dt); if (!S.onRoad) M.offroadT += dt; }
}
function senseRoad(t) {
  if (t - S.lastRoadT < 80 || !IDX.ready) return; S.lastRoadT = t;
  const r = IDX.roadAt(S.lat, S.lon, S.y);
  if (r) { S.onRoad = true; S.cls = r.cls; S.brunnel = r.brunnel; S.yT = r.eAt || 0; S.limit = r.lim || 0; } else { S.onRoad = false; S.yT = 0; S.limit = 0; }
  if (t - S.lastNameT > 300) {
    S.lastNameT = t;
    const f = IDX.nameAt(S.lat, S.lon, 32);
    // "Metro access : Burj Khalifa / Dubai Mall station" is where a lane goes, not a street name
    const acc = f && /(^|\s)(access|entrance|exit|parking|car park)(\s|:|$)/i.test(f.name) ? f.name.replace(/^.*?:\s*/, "") : "";
    if (f && !acc) { S.name = f.name; S.nameAr = f.ar; S.ref = f.ref; S.near = ""; S.toward = ""; }
    else if (acc) { S.name = ""; S.ref = ""; S.nameAr = ""; S.near = ""; S.toward = acc; }
    else {
      S.name = ""; S.ref = ""; S.nameAr = "";
      // an unnamed slip road or lane still sits next to a named road: say which
      const g = S.onRoad ? IDX.nameNear(S.lat, S.lon, 120) : null; S.toward = "";
      S.near = g ? g.name : "";
    }
  }
}
function flash() { const f = document.getElementById("flash"); f.style.opacity = 1; setTimeout(() => f.style.opacity = 0, 120); }

// ================================================================== missions (ported)
function startMission(route, variantKey, opts) {
  const v = route[variantKey] || route.fast;
  M = { route, variant: variantKey, v, cum: cumulative(v.geom), ri: 0, progress: 0, offRoute: false, offSince: 0, lastFull: 0, reroutes: 0, rerouting: false, lastReroute: -1e9, passed: new Set(), cost: 0, gatesHit: [], dist: 0, offroadT: 0, t0: 0, started: false, free: !!(opts && opts.free), announced: {}, done: false };
  const g = v.geom;
  S.lat = g[0][0]; S.lon = g[0][1]; S.hdg = bearing(g[0], g[Math.min(3, g.length - 1)]); S.v = 0; S.steer = 0; S.y = 0; S.yT = 0;
  rebaseTo(S.lat, S.lon);
  setGps(M.free || !settings.gps ? [] : g, !M.free && settings.gps && route[variantKey === "fast" ? "notoll" : "fast"] ? route[variantKey === "fast" ? "notoll" : "fast"].geom : null);
  const dest = g[g.length - 1];
  beam.visible = !M.free; anchor(beam, dest[0], dest[1]);
  if (miniDest) { miniDest.setLngLat([dest[1], dest[0]]); miniDest.getElement().hidden = M.free; }
  document.getElementById("menu").hidden = true; document.getElementById("hud").hidden = false; document.getElementById("intro").hidden = true;
  M.hour0 = atmo.hour != null ? atmo.hour : TIMES[settings.time][1];
  M.destName = P[route.to] ? P[route.to].label : "your destination";
  setNav();
  const keysEl = document.getElementById("keys"); keysEl.classList.remove("gone"); clearTimeout(keysEl._t); keysEl._t = setTimeout(() => keysEl.classList.add("gone"), 14000);
  running = true; paused = false; lastT = performance.now(); camInit = true;
  waitWorld = performance.now(); pendingLane = true;
  if (!M.free) tiles.prefetchRoute(g);
  LOOK.yaw = 0; LOOK.pitch = 0; LOOK.zoom = 1;
  if (!M.free && settings.preview !== false && !(opts && opts.noPreview) && !navigator.webdriver) startPreview();      // automated tests call startPreview() themselves
  toast(M.free ? `Free roam from ${esc(P[route.from].label)}. Drive anywhere.` : `<b>${esc(route.title)}</b><small>Get to ${esc(P[route.to].label)}. ${settings.gps ? "Follow the directions and the blue line." : "GPS is off: find your own way."}</small>`, "good");
  if (!M.free && settings.gps && nav.voice) setTimeout(() => { if (M && !M.free && M.route === route) nav.say(`Starting route to ${M.destName}. ${Math.round(M.v.km * 10) / 10} kilometres.`); }, 600);
}
// Turn-by-turn for the current route (baked lane guidance where OpenStreetMap has turn lanes).
const nav = new Nav(); nav.voice = settings.voice !== false;
function setNav() {
  if (!M || M.free || !settings.gps) { nav.hide(); clearTurnArrow(); return; }
  const LN = window.UAE_LANES && M.route && window.UAE_LANES[M.route.id];
  const lanes = M.v.lanes || (LN && M.v === M.route[M.variant] ? LN[M.variant] : null);
  nav.setRoute(M.v, M.cum, lanes || null, M.destName);
}
// Start in the right-hand lane, not on the centre line: after the tiles under the car are
// indexed, shift right by a lane (two-way roads: to the middle of the right half).
let pendingLane = false;
function laneStart() {
  pendingLane = false;
  const r = alignedRoad(S.lat, S.lon, S.hdg); if (!r) return;
  const w = r.s.w || 2 * r.s.hw, lanes = Math.max(1, r.s.ln || 2);
  const off = r.s.ow ? Math.max(0, w / 2 - (w / lanes) / 2) : w / 4;
  if (off < 0.5) return;
  const [la, lo] = move(S.lat, S.lon, S.hdg + 90, off);
  if (IDX.roadAt(la, lo, S.y)) { S.lat = la; S.lon = lo; camInit = true; }
}
function trackMission(t) {
  const carLL = [S.lat, S.lon]; const g = M.v.geom;
  if (!M.started && Math.abs(S.v) > 0.5) { M.started = true; M.t0 = t; }
  for (const gate of D.gates) {
    if (M.passed.has(gate.id)) continue;
    if (hav(carLL, [gate.lat, gate.lon]) < 42) {
      M.passed.add(gate.id);
      const PAIR = { safa_n: "safa_s", safa_s: "safa_n", mamzar_n: "mamzar_s", mamzar_s: "mamzar_n" };
      const paired = PAIR[gate.id] && M.passed.has(PAIR[gate.id]);
      const c = paired ? 0 : gateCost(gate, settings.band); M.cost += c; M.gatesHit.push(gate.name);
      toast(`<b>${gate.sys === "salik" ? "Salik" : "Darb"} gate: ${esc(gate.name)}</b><small>${paired ? "Counted with the gate you just passed (one-hour rule), no extra charge" : c ? "AED " + c.toFixed(2) + " at " + BANDS[settings.band].label.toLowerCase() : "Free at " + BANDS[settings.band].label.toLowerCase()}</small>`, gate.sys === "salik" ? "gate" : "darb");
    }
  }
  for (const p of D.places) {
    if (p.id === M.route.to || p.id === M.route.from) continue;
    const d = hav(carLL, [p.lat, p.lon]);
    if (d < 260 && !(M.announced[p.id] > t - 90000)) { M.announced[p.id] = t; toast(`Passing <b>${esc(p.label)}</b><small>${Math.round(d)} m ${side(p)}</small>`, "good"); }
  }
  if (M.free) return;
  let bestD = 1e12, bi = M.ri, along = 0;
  for (let i = Math.max(0, M.ri - 40); i < Math.min(g.length - 1, M.ri + 90); i++) { const [d, tt] = segDist(carLL, g[i], g[i + 1]); if (d < bestD) { bestD = d; bi = i; along = tt; } }
  if (bestD > 150 && t - M.lastFull > 1500) { M.lastFull = t; const [d2, b2] = nearestIdx(g, carLL); if (d2 < bestD) { bestD = d2; bi = b2; along = 0; } }
  M.ri = bi; M.progress = M.cum[bi] + along * (M.cum[bi + 1] - M.cum[bi]); M.offDist = bestD;
  const off = bestD > 110;
  if (off && !M.offRoute) M.offSince = t;
  M.offRoute = off;
  if (off && settings.gps && !M.rerouting && t - M.offSince > 5000 && t - M.lastReroute > 20000) reroute();
  const dest = g[g.length - 1];
  if (hav(carLL, dest) < 45 && !M.done) finish(t);
}
function side(p) { const b = bearing([S.lat, S.lon], [p.lat, p.lon]); const d = (b - S.hdg + 540) % 360 - 180; return Math.abs(d) < 25 ? "ahead" : d > 0 ? "on your right" : "on your left"; }
async function reroute() {
  const m = M, seq = (M.seq = (M.seq || 0) + 1);
  M.rerouting = true; M.lastReroute = performance.now();
  try {
    const dest = M.v.geom[M.v.geom.length - 1];
    const json = await valhalla({ lat: S.lat, lon: S.lon }, { lat: dest[0], lon: dest[1] }, M.variant === "notoll");
    const nv = buildVariant(json, M.route.from, M.route.to);
    liveLanes({ lat: S.lat, lon: S.lon }, { lat: dest[0], lon: dest[1] }, M.variant === "notoll", nv);
    if (M === m && !M.done && M.seq === seq) { M.v = nv; M.cum = cumulative(nv.geom); M.ri = 0; M.reroutes++; setGps(nv.geom, null); setNav(); toast(`<b>Rerouting</b><small>New route: ${fmtKm(nv.km)}, ${nv.min} min</small>`, "warn"); nav.say("Rerouting. " + (nav.mans[0] ? nav.mans[0].say + "." : "")); }
  } catch (e) { toast(`<b>Off route</b><small>Could not reroute (${esc(e.message)}). Press R to jump back.</small>`, "warn"); }
  if (M === m) M.rerouting = false;
}
function respawn() {
  if (!M) return; const g = M.v.geom; const i = Math.min(g.length - 2, Math.max(0, M.ri));
  S.lat = g[i][0]; S.lon = g[i][1]; S.hdg = bearing(g[i], g[i + 1]); S.v = 0; S.steer = 0; M.offRoute = false; M.seq = (M.seq || 0) + 1; camInit = true;
  toast("Back on the route.", "warn"); pendingLane = true;
}
function finish(t) {
  M.done = true; running = false; clearTurnArrow();
  nav.say(`You have arrived at ${M.destName || "your destination"}.`);
  const secs = M.started ? (t - M.t0) / 1000 : 0;
  const rec = { time: Math.round(secs), km: +(M.dist / 1000).toFixed(1), cost: M.cost, reroutes: M.reroutes, date: new Date().toISOString().slice(0, 10) };
  const prev = best(M.route.id, M.variant);
  const isBest = M.route.id !== "live" && (!prev || rec.time < prev.time);
  if (isBest) save(`uaecity.best.${M.route.id}.${M.variant}`, rec);
  document.getElementById("debriefPanel").innerHTML = `<h3>Arrived: ${esc(P[M.route.to] ? P[M.route.to].label : "destination")}</h3><p class="sub">${esc(M.route.title)}${isBest ? ' <span class="best">new best time</span>' : prev ? ` <span class="sub">best ${fmtT(prev.time)}</span>` : ""}</p>
    <div class="stats"><div class="stat"><b>${fmtT(secs)}</b><span>your time</span></div><div class="stat"><b>${rec.km} km</b><span>driven (route ${M.v.km} km)</span></div><div class="stat"><b>${aed(M.cost)}</b><span>tolls, ${BANDS[settings.band].label.split(" ")[0].toLowerCase()}</span></div><div class="stat"><b>${M.reroutes}</b><span>wrong turns rerouted</span></div></div>
    <p class="sub">Off road for ${Math.round(M.offroadT)} s. Gates: ${M.gatesHit.length ? M.gatesHit.map(esc).join(", ") : "none"}.</p>
    <h2>Roads on the route</h2><p class="sub" style="color:var(--ink)">${esc(oneBreath(M.v))}</p>
    <div class="row2"><button class="btn primary" onclick="retry()">Drive again</button>${M.route.notoll && M.variant === "fast" ? `<button class="btn" onclick="startMission(M.route,'notoll')">Try without Salik</button>` : ""}<button class="btn" onclick="nextMission()">Next route</button><button class="btn" onclick="quitToMenu()">Menu</button></div>`;
  document.getElementById("debrief").hidden = false;
  toast(`<b>Arrived</b><small>${fmtT(secs)}</small>`, "good");
}
function retry() { document.getElementById("debrief").hidden = true; startMission(M.route, M.variant); }
function nextMission() { document.getElementById("debrief").hidden = true; const i = D.routes.findIndex(r => r.id === M.route.id); const n = D.routes[(i + 1) % D.routes.length]; startMission(n, "fast"); }
function quitToMenu() { document.getElementById("debrief").hidden = true; document.getElementById("pause").hidden = true; running = false; M = null; document.getElementById("hud").hidden = true; setGps([], null); nav.hide(); beam.visible = false; renderMenu("missions"); }
function oneBreath(v) { const roads = v.roads.filter(r => r.km >= 0.8).map(r => r.en + (r.ref ? " (" + r.ref + ")" : "")); const u = roads.filter((x, i) => roads.indexOf(x) === i); return u.length ? u.join(", then ") + "." : "Local streets only."; }

// ================================================================== floating origin
function rebaseTo(lat, lon) {
  tiles.rebase(lat, lon);
  reanchor();
  for (const L of landmarks) if (L.group) { const v = toWorld(L.def.lat, L.def.lon); L.group.position.set(v.x, 0, v.z); }
}

// ================================================================== free look
// Drag the screen (mouse or finger) to swing the camera round the car and tilt it up at the towers;
// the wheel zooms the chase boom; Q and E look left and right. Once you drive on, the view eases back
// behind the car after two seconds (it stays put while you are stopped).
const LOOK = { yaw: 0, pitch: 0, zoom: 1, t: -1e9, drag: null, keys: 0 };
function lookDecay(dt) {
  if (keys["q"] || keys["e"]) { LOOK.yaw += (keys["q"] ? -1 : 1) * dt * 1.8; LOOK.t = performance.now(); }
  if (LOOK.drag || performance.now() - LOOK.t < 2000 || Math.abs(S.v) < 2) return;
  const k = Math.min(1, dt * 1.6);
  LOOK.yaw -= LOOK.yaw * k; LOOK.pitch -= LOOK.pitch * k;
  if (Math.abs(LOOK.yaw) < 1e-3) LOOK.yaw = 0; if (Math.abs(LOOK.pitch) < 1e-3) LOOK.pitch = 0;
}
{
  const el = renderer.domElement;
  el.addEventListener("pointerdown", e => {
    if (PV.on) { endPreview(); return; }
    if (!running || paused || (e.pointerType === "mouse" && e.button !== 0 && e.button !== 2)) return;
    LOOK.drag = { id: e.pointerId, x: e.clientX, y: e.clientY }; try { el.setPointerCapture(e.pointerId); } catch (_) {}
  });
  el.addEventListener("pointermove", e => {
    const d = LOOK.drag; if (!d || d.id !== e.pointerId) return;
    const sx = 3.4 / Math.max(320, innerWidth);                // a full-width drag turns about 200 degrees
    LOOK.yaw -= (e.clientX - d.x) * sx; LOOK.pitch = THREE.MathUtils.clamp(LOOK.pitch - (e.clientY - d.y) * sx, -0.45, 1.25);
    while (LOOK.yaw > Math.PI) LOOK.yaw -= 2 * Math.PI; while (LOOK.yaw < -Math.PI) LOOK.yaw += 2 * Math.PI;
    d.x = e.clientX; d.y = e.clientY; LOOK.t = performance.now();
  });
  const up = e => { if (LOOK.drag && LOOK.drag.id === e.pointerId) { LOOK.drag = null; LOOK.t = performance.now(); } };
  el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
  el.addEventListener("contextmenu", e => e.preventDefault());
  el.addEventListener("wheel", e => { if (!running) return; e.preventDefault(); LOOK.zoom = THREE.MathUtils.clamp(LOOK.zoom * Math.exp(e.deltaY * 0.0012), 0.55, 3.2); }, { passive: false });
  el.addEventListener("dblclick", () => { LOOK.yaw = 0; LOOK.pitch = 0; LOOK.zoom = 1; });
}

// ================================================================== route preview
// Before you drive it, see the route. "drive" (default): your car drives the whole route on fast-forward
// along the real roads, the chase camera pulled back so you see the streets and the places on the way;
// it eases off wherever the city ahead has not loaded yet, then puts you back at the start. "sky": a
// fly-over from a few hundred metres up. Any key or tap skips; O plays it again.
const PV = window.__PV = { on: false, sky: false, ll: [0, 0], w: new THREE.Vector3(), t: 0, T: 10, el: null, look: new THREE.Vector3(), pos: new THREE.Vector3() };
function routePoint(s, out) {
  const g = M.v.geom, c = M.cum; s = Math.max(0, Math.min(c[c.length - 1], s));
  let lo = 0, hi = c.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
  const f = (s - c[lo]) / Math.max(1e-6, c[hi] - c[lo]);
  out[0] = g[lo][0] + (g[hi][0] - g[lo][0]) * f; out[1] = g[lo][1] + (g[hi][1] - g[lo][1]) * f; return out;
}
function startPreview(mode) {
  if (!M || M.free || !M.cum || M.cum.length < 2) return;
  if (PV.on) endPreview();
  const total = M.cum[M.cum.length - 1], km = total / 1000;
  mode = mode || (settings.preview === "sky" ? "sky" : "drive");
  Object.assign(PV, { on: true, sky: mode === "sky", t: 0, s: 0, T: Math.min(16, Math.max(7, 5 + km * 0.8)), total, alt: Math.min(460, Math.max(170, 130 + km * 22)), back: Math.min(520, Math.max(220, 160 + km * 25)),
    V: Math.min(320, Math.max(40, total / 20)), vs: 0, dir: null, t0: 0 });
  PV.ll = [S.lat, S.lon]; toWorld(S.lat, S.lon, PV.w);
  PV.pos.copy(camera.position); PV.look.copy(carPos);
  if (!PV.el) { PV.el = document.createElement("div"); PV.el.id = "pvcard"; PV.el.style.cssText = "position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:950;background:rgba(14,17,22,.82);color:#eef2f7;font:600 14px/1.3 'Segoe UI',system-ui,sans-serif;padding:9px 16px;border-radius:12px;box-shadow:0 6px 20px rgba(0,0,0,.35);text-align:center;pointer-events:none;max-width:90vw"; document.body.appendChild(PV.el); }
  PV.el.innerHTML = `Route preview${PV.sky ? " from the sky" : ", fast-forward"}: ${esc(P[M.route.from] ? P[M.route.from].label : "start")} to ${esc(M.destName)}, ${km.toFixed(1)} km<br><span style="opacity:.7;font-weight:400;font-size:12px">press any key or tap to skip &middot; <span id="pvpct">0</span>%</span>`;
  PV.el.hidden = false; S.v = 0;
}
function endPreview() {
  if (!PV.on) return;
  PV.on = false; if (PV.el) PV.el.hidden = true;
  if (!PV.sky && M && M.v) {                                         // back to the start of the route
    const g = M.v.geom; S.lat = g[0][0]; S.lon = g[0][1]; S.hdg = bearing(g[0], g[Math.min(3, g.length - 1)]); S.v = 0; S.y = 0; S.yT = 0;
    M.progress = 0; M.ri = 0; rebaseTo(S.lat, S.lon); toWorld(S.lat, S.lon, carPos); camInit = true;
  } else { camPos.copy(camera.position); camInit = false; }          // the chase camera swoops down from where the sky preview left it
  waitWorld = performance.now(); lastT = performance.now();         // hold the car until the ground under it is back
}
const _pa = [0, 0], _pb = [0, 0], _pc = [0, 0];
function previewStep(dt) {
  if (!PV.sky) {
    // fast-forward along the route; ease off while the ground ahead is still loading
    routePoint(PV.s + 300, _pc);
    const ready = worldReadyAt(S.lat, S.lon) && worldReadyAt(_pc[0], _pc[1]);
    const left = PV.total - PV.s, vt = Math.min(ready ? PV.V : PV.V * 0.4, 12 + left * 0.8);     // ease in at the destination
    PV.vs += (vt - PV.vs) * Math.min(1, dt * 1.2);
    PV.s = Math.min(PV.total, PV.s + dt * PV.vs);
    routePoint(PV.s, _pa); routePoint(PV.s + 20, _pb);
    S.lat = _pa[0]; S.lon = _pa[1]; S.v = 0;
    if (IDX.ready) { const r = alignedRoad(S.lat, S.lon, bearing(_pa, _pb)); if (r) { S.y = S.yT = r.e || 0; } }      // ride the route's own deck (fast-forward jumps past ramps too quickly to climb them)
    if (PV.s + 1 < PV.total) { let d = bearing(_pa, _pb) - S.hdg; while (d > 180) d -= 360; while (d < -180) d += 360; S.hdg = (S.hdg + d * Math.min(1, dt * 6) + 360) % 360; }
    M.progress = PV.s; PV.ll = [S.lat, S.lon]; toWorld(S.lat, S.lon, PV.w);
    if ((PV.nameT = (PV.nameT || 0) + dt) > 0.3) { PV.nameT = 0; try { senseRoad(performance.now()); } catch (_) {} S.v = 0; }      // keep the street card current
    const pc = document.getElementById("pvpct"); if (pc) pc.textContent = Math.round(100 * PV.s / PV.total);
    if (PV.s >= PV.total) { PV.t += dt; if (PV.t > 1.2) endPreview(); }       // a moment at the destination
    return;
  }
  PV.t += dt; const u = Math.min(1, PV.t / PV.T);
  const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;          // ease in and out
  const s = PV.total * e;
  routePoint(s, _pa); PV.ll = [_pa[0], _pa[1]]; toWorld(_pa[0], _pa[1], PV.w);
  if (u >= 1) endPreview();
}
function previewChase(dt) {
  if (camera.view && camera.view.enabled) { camera.clearViewOffset(); camera.updateProjectionMatrix(); }
  // the camera is tied to the car (fixed distance, so the car never shrinks away at speed); only its
  // direction is smoothed, taken from the route 150 m behind to 150 m ahead so bends turn it gently
  routePoint(PV.s - 150, _pb); routePoint(PV.s + 150, _pc);
  const b = toWorld(_pb[0], _pb[1]), a = toWorld(_pc[0], _pc[1]);
  let dx = a.x - b.x, dz = a.z - b.z; const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
  if (!PV.dir) PV.dir = new THREE.Vector2(dx, dz);
  PV.dir.x += (dx - PV.dir.x) * Math.min(1, dt * 1.8); PV.dir.y += (dz - PV.dir.y) * Math.min(1, dt * 1.8); PV.dir.normalize();
  const ramp = Math.min(1, PV.t0 = (PV.t0 || 0) + dt);                    // first second: rise from the chase camera
  const BACK = 44, UP = 25;
  const wantPos = new THREE.Vector3(carPos.x - PV.dir.x * BACK, carPos.y + UP, carPos.z - PV.dir.y * BACK);
  const wantLook = new THREE.Vector3(carPos.x + PV.dir.x * 38, carPos.y + 1, carPos.z + PV.dir.y * 38);
  PV.pos.lerp(wantPos, ramp < 1 ? Math.min(1, dt * 3) : 1); PV.look.lerp(wantLook, ramp < 1 ? Math.min(1, dt * 3) : 1);
  camera.position.copy(PV.pos); camera.up.set(0, 1, 0); camera.lookAt(PV.look);
  if (Math.abs(camera.fov - 58) > 0.05) { camera.fov += (58 - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix(); }
}
function previewCamera(dt) {
  if (camera.view && camera.view.enabled) { camera.clearViewOffset(); camera.updateProjectionMatrix(); }
  const u = Math.min(1, PV.t / PV.T), e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2, s = PV.total * e;
  // climb for the first 15%, cruise, come down over the last 15% towards the car's chase position
  const up = Math.min(1, u / 0.15, (1 - u) / 0.15 + 0.25);
  routePoint(s - PV.back * up, _pb); routePoint(s + 600 + 500 * up, _pc);
  const b = toWorld(_pb[0], _pb[1]), a = toWorld(_pc[0], _pc[1]);
  const wantPos = new THREE.Vector3(b.x, carPos.y + 6 + PV.alt * up, b.z), wantLook = new THREE.Vector3(a.x, 0, a.z);
  const k = Math.min(1, dt * 2.2);
  PV.pos.lerp(wantPos, k); PV.look.lerp(wantLook, Math.min(1, dt * 1.6));
  camera.position.copy(PV.pos); camera.up.set(0, 1, 0); camera.lookAt(PV.look);
  if (Math.abs(camera.fov - 55) > 0.05) { camera.fov += (55 - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix(); }
}

// ================================================================== camera
const carPos = new THREE.Vector3(), camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
let camYaw = 0, camInit = true, camDist = 7.5;
const CAMCFG = { chase: { back: 7.2, up: 2.3, look: 1.15, ahead: 5, fov: 60 }, far: { back: 15, up: 5.2, look: 1.5, ahead: 8, fov: 58 }, hood: { back: -0.9, up: 1.28, look: 1.2, ahead: 30, fov: 68 }, heli: { back: 70, up: 48, look: 0, ahead: 20, fov: 55 }, top: { back: 0.1, up: 210, look: 0, ahead: 0, fov: 50 } };
function updateCamera(dt) {
  if (camera.view && camera.view.enabled) { camera.clearViewOffset(); camera.updateProjectionMatrix(); }   // the title screen shifts the view right of the menu
  const cfg = CAMCFG[settings.cam] || CAMCFG.chase;
  const hdg = S.hdg * Math.PI / 180;
  // yaw follows the car with a lag, which is what makes a chase camera feel alive
  let d = hdg - camYaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
  camYaw += d * (camInit ? 1 : Math.min(1, dt * (settings.cam === "hood" ? 20 : 3.2)));
  lookDecay(dt);
  const yawB = camYaw + LOOK.yaw, fx = Math.sin(yawB), fz = -Math.cos(yawB);
  const speed = Math.abs(S.v);
  let back = cfg.back + (settings.cam === "chase" || settings.cam === "far" ? Math.min(3.5, speed * 0.05) : 0);
  // keep the camera outside buildings: shorten the boom if a footprint is behind the car
  if ((settings.cam === "chase" || settings.cam === "far") && IDX.ready) {
    back *= LOOK.zoom;
    for (let s = 2; s <= back; s += 1.5) { const [la, lo] = move(S.lat, S.lon, yawB * 180 / Math.PI + 180, s); if (IDX.building(la, lo) && !IDX.roadAt(la, lo)) { back = Math.max(3.2, s - 1.2); break; } }
  }
  camDist += (back - camDist) * (back < camDist ? 0.4 : Math.min(1, dt * 2.5));
  const tilt = settings.cam === "chase" || settings.cam === "far" ? LOOK.pitch : 0;      // looking up drops the camera towards the car's roof line
  const want = new THREE.Vector3(carPos.x - fx * camDist, carPos.y + Math.max(0.9, cfg.up * LOOK.zoom - tilt * 1.6 + (settings.cam === "chase" ? speed * 0.012 : 0)), carPos.z - fz * camDist);
  if (settings.cam === "top") want.set(carPos.x, carPos.y + cfg.up, carPos.z + 0.1);
  if (camInit) { camPos.copy(want); camInit = false; } else camPos.lerp(want, settings.cam === "hood" ? 1 : Math.min(1, dt * 7));
  camera.position.copy(camPos);
  camLook.set(carPos.x + fx * cfg.ahead, carPos.y + cfg.look, carPos.z + fz * cfg.ahead);
  if (settings.cam === "top") { camera.up.set(fx, 0, fz); } else camera.up.set(0, 1, 0);
  if (LOOK.pitch && settings.cam !== "top" && settings.cam !== "heli") {
    // tilt the view up (or down) about the camera: keep the heading, add the pitch
    const dx = camLook.x - camPos.x, dy = camLook.y - camPos.y, dz = camLook.z - camPos.z, hz = Math.hypot(dx, dz) || 1;
    const p = THREE.MathUtils.clamp(Math.atan2(dy, hz) + LOOK.pitch, -1.2, 1.35), R = 60;
    camLook.set(camPos.x + dx / hz * Math.cos(p) * R, camPos.y + Math.sin(p) * R, camPos.z + dz / hz * Math.cos(p) * R);
  }
  camera.lookAt(camLook);
  const fov = cfg.fov + (settings.cam === "chase" || settings.cam === "hood" ? Math.min(14, speed * 0.2) : 0);
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix(); }
}
// Menu attract mode: a slow orbit around a landmark at golden hour
const ATTRACT = CITY.attract || [{ lat: 25.1972, lon: 55.2744, r: 1500, h: 420, look: 260, name: "Downtown Dubai" }, { lat: 25.0805, lon: 55.1403, r: 1100, h: 320, look: 150, name: "Dubai Marina" }, { lat: 25.2180, lon: 55.2820, r: 900, h: 260, look: 120, name: "Sheikh Zayed Road" }];
let attractI = 0, attractT = 0;
let attractOverride = null;
// Orbit a landmark (tests and "photo mode" from the console: GAME.viewLandmark("burj_al_arab"))
function viewLandmark(id, hour, o = {}) {      // o: { r, h, look, ang } to frame a closer shot
  const L = landmarks.find(x => x.def.id === id); if (!L) return false;
  const h = L.def.height || 100;
  attractOverride = { lat: L.def.lat, lon: L.def.lon, r: o.r ?? Math.max(260, h * 1.7), h: o.h ?? Math.max(60, h * 0.55), look: o.look ?? h * 0.4, ang0: o.ang ?? 0, name: L.def.name };
  attractT = 0;
  if (hour !== undefined) atmo.setHour(hour);
  document.getElementById("menu").hidden = true; document.getElementById("intro").hidden = true;
  return true;
}
function attractCamera(dt) {
  attractT += dt;
  if (attractT > 40 && !attractOverride) { attractT = 0; attractI = (attractI + 1) % ATTRACT.length; }
  const A = attractOverride || ATTRACT[attractI];
  const wEl = document.getElementById("where"); if (wEl && wEl.textContent !== A.name) wEl.textContent = A.name;
  if (Math.abs(S.lat - A.lat) > 1e-6 || Math.abs(S.lon - A.lon) > 1e-6) { S.lat = A.lat; S.lon = A.lon; rebaseTo(A.lat, A.lon); }
  const c = toWorld(A.lat, A.lon);
  const ang = (A.ang0 || 0) + attractT * 0.05;
  camera.position.set(c.x + Math.cos(ang) * A.r, A.h, c.z + Math.sin(ang) * A.r);
  camera.up.set(0, 1, 0);
  camera.lookAt(c.x, A.look, c.z);
  if (camera.fov !== 50 || !camera.view || !camera.view.enabled) { camera.fov = 50; camera.setViewOffset(innerWidth, innerHeight, -innerWidth * 0.2, 0, innerWidth, innerHeight); camera.updateProjectionMatrix(); }
}

// ================================================================== frame loop
const PERF = { traffic: 0, props: 0, render: 0, frame: 0, n: 0 };
let frameNo = 0, fpsAcc = 0, fpsN = 0, fpsShow = 0, tileTick = 0, prMode = Q.pr, rawDt = 0;
const loadingEl = document.getElementById("loading");
function frame(t) {
  requestAnimationFrame(frame);
  rawDt = Math.min(1, (t - lastT) / 1000); const dt = Math.min(0.05, rawDt); lastT = t; frameNo++;
  U.uTime.value = t / 1000;
  gpsMat.uniforms.uTime.value = t / 1000; arrowMat.uniforms.uTime.value = t / 1000;
  gpsMat.uniforms.uProg.value = M && !M.free ? M.progress + (PV.on ? 6 : 0) : -1e9;      // the preview looks down on the car: start the line past its nose
  gpsMat.uniforms.uAlphaMul.value = settings.cam === "hood" ? 0.45 : 1;
  const PT = window.PERF_TRACE; const tI0 = performance.now();
  if (warmGroup) warmStep();
  if (idxJobs.length) runIndexJobs(4);
  if (PT) PT.idxMs += performance.now() - tI0;
  if (pendingSnap && frameNo % 10 === 0) trySnap();
  // Hold the car (and the clock) until the ground under it has loaded, with a loading card.
  if (PV.on) previewStep(Math.min(0.25, rawDt));      // real time, so the preview takes as long on a slow machine
  else if (waitWorld) {
    const ready = worldReadyAt(S.lat, S.lon);
    if (loadingEl) { loadingEl.hidden = ready; if (!ready) loadingEl.firstChild.textContent = "Loading " + (M && P[M.route.from] ? P[M.route.from].label : "the city") + "…"; }
    if (ready || performance.now() - waitWorld > 20000) { waitWorld = 0; if (loadingEl) loadingEl.hidden = true; lastT = performance.now(); }
  }
  if (waitWorld || PV.on) { /* frozen while loading or previewing */ }
  else if (pendingSnap && running) { S.v = 0; }                     // free roam: hold still until placed on a road
  else if (pendingLane && running && IDX.ready && frameNo % 5 === 0) laneStart();
  else if (running && !paused && AUTO.on && M && !M.free) { autopilot(dt); trackMission(t); }
  else if (running && !paused) { step(dt); senseRoad(t); if (M) trackMission(t); }
  toWorld(S.lat, S.lon, carPos);
  if (running && Math.hypot(carPos.x, carPos.z) > 2500) { const bx = carPos.x, bz = carPos.z; rebaseTo(S.lat, S.lon); toWorld(S.lat, S.lon, carPos); const ddx = carPos.x - bx, ddz = carPos.z - bz; camPos.x += ddx; camPos.z += ddz; camera.position.x += ddx; camera.position.z += ddz; PV.pos.x += ddx; PV.pos.z += ddz; PV.look.x += ddx; PV.look.z += ddz; }
  // car
  car.group.visible = running || !!M;
  if (running && IDX.ready) {
    const r = IDX.roadAt(S.lat, S.lon, S.y); S.yT = r ? (r.eAt || 0) : 0;
    // slope under the car: the deck 2.2 m ahead and behind gives the pitch, and the higher of the
    // centre and the mean keeps the body out of the ramp on a change of grade
    const f = move(S.lat, S.lon, S.hdg, 2.2), b = move(S.lat, S.lon, S.hdg + 180, 2.2);
    const rf = IDX.roadAt(f[0], f[1], S.y), rb = IDX.roadAt(b[0], b[1], S.y);
    const ef = rf && Math.abs((rf.eAt || 0) - S.yT) < 3 ? rf.eAt || 0 : S.yT, eb = rb && Math.abs((rb.eAt || 0) - S.yT) < 3 ? rb.eAt || 0 : S.yT;
    S.pitchT = Math.atan2(ef - eb, 4.4); S.yT = Math.max(S.yT, (ef + eb) / 2);
  }
  S.pitch = (S.pitch || 0) + ((S.pitchT || 0) - (S.pitch || 0)) * Math.min(1, dt * 8);
  S.y += (S.yT - S.y) * Math.min(1, dt * (PV.on ? 30 : S.yT < S.y - 2 ? 4 : 14));
  carPos.y = S.y;
  car.group.position.set(carPos.x, 0.07 + S.y, carPos.z);
  car.group.rotation.order = "YXZ"; car.group.rotation.y = -S.hdg * Math.PI / 180; car.group.rotation.x = S.pitch || 0;
  car.update(dt, S.v, S.steer);
  car.setBrake(!!S.brake); car.setReverse(!!S.reverse); car.setHeadlights(atmo.night > 0.35);
  U.uHeadOn.value = atmo.night > 0.35 && (running || M) ? 1 : 0;
  U.uHeadPos.value.set(carPos.x + Math.sin(S.hdg * Math.PI / 180) * 1.8, carPos.y, carPos.z - Math.cos(S.hdg * Math.PI / 180) * 1.8);
  U.uHeadDir.value.set(Math.sin(S.hdg * Math.PI / 180), 0, -Math.cos(S.hdg * Math.PI / 180));
  // camera
  if (PV.on) (PV.sky ? previewCamera : previewChase)(dt); else if (running || M) updateCamera(dt); else attractCamera(dt);
  // tiles around the camera focus
  if (ribbonDirty && frameNo % 20 === 0) { ribbonDirty = false; liftRibbon(gpsMesh); }
  if (frameNo % 240 === 5 || PV.on && frameNo % 60 === 5) { const [la, lo] = PV.on ? PV.ll : running ? [S.lat, S.lon] : toLatLon(camera.position.x, camera.position.z); tiles.updateFar(la, lo); }
  if (++tileTick % 15 === 1) { const [la, lo] = PV.on ? PV.ll : running ? [S.lat, S.lon] : toLatLon(camera.position.x, camera.position.z); tiles.update(la, lo, PV.on ? PV.w.x : running ? carPos.x : camera.position.x, PV.on ? PV.w.z : running ? carPos.z : camera.position.z); if (gantriesDirty) buildGantries(); placeLandmarks(); tiles.cullNear(camera.position.x, camera.position.z); }
  // traffic, props
  const tA = performance.now();
  const sh = globalShift();
  traffic.t = t / 1000;
  const hitCar = traffic.update(dt, { x: running ? carPos.x : camera.position.x, z: running ? carPos.z : camera.position.z, hx: Math.sin(S.hdg * Math.PI / 180), hz: -Math.cos(S.hdg * Math.PI / 180) }, sh.x, sh.z, atmo.night);
  if (hitCar && running && Math.abs(S.v) > 1 && performance.now() - S.crashT > 600) { audio.crash(Math.abs(S.v)); S.v = -S.v * 0.3; S.crashT = performance.now(); hitCar.stopT = 2.5; flash(); }
  audio.update(dt, S.v, Kk.up() ? 1 : 0, !!Kk.hb(), S.steer, running && !paused && !PV.on);
  peds.update(dt, { x: running ? carPos.x : camera.position.x, z: running ? carPos.z : camera.position.z }, sh.x, sh.z, atmo.night);
  const tB = performance.now();
  const OFF = offsets();
  props.update(running ? carPos.x : camera.position.x, running ? carPos.z : camera.position.z, OFF, atmo.night);
  signals.update(camera.position.x, camera.position.z, OFF, t / 1000);
  if (signLayer) signLayer.update(camera.position.x, camera.position.z, OFF, atmo.night, frameNo);
  if (running && frameNo % 6 === 0) redLight(t, OFF);
  if (running && frameNo % 30 === 11) updateExits();
  if (frameNo % 10 === 0) updateCuts(OFF);
  const tC = performance.now();
  // sky follows the focus
  atmo.update(running ? carPos : new THREE.Vector3(camera.position.x, 0, camera.position.z), camera);
  ground.position.x = camera.position.x; ground.position.z = camera.position.z;
  for (const L of landmarks) if (L.group && L.group.userData.nightMats) for (const n of L.group.userData.nightMats) n.mat.emissiveIntensity = n.day + (n.night - n.day) * atmo.night;
  atmo.sky.material.uniforms.time.value = t / 1000;
  renderer.info.reset();
  const tD = performance.now();
  fx.frame(dt, atmo.night);
  const tE = performance.now();
  if (PT) { const fr = { dt: Math.round(dt * 1000), frame: Math.round(tE - t), render: Math.round(tE - tD), props: Math.round(tC - tB), traffic: Math.round(tB - tA), tile: Math.round(PT.tileMs), idx: Math.round(PT.idxMs), tiles: tiles.stats.loaded }; if (fr.dt > 70 || fr.frame > 50) PT.slow.push(fr); PT.tileMs = 0; PT.idxMs = 0; }
  PERF.traffic += tB - tA; PERF.props += tC - tB; PERF.render += tE - tD; PERF.frame += tE - t; PERF.n++;
  // loading overlay
  if (loadingEl && !loadingEl.hidden && !waitWorld) { const pend = tiles.pending(), tot = tiles.tiles.size || 1; loadingEl.querySelector("i").style.width = Math.round(100 * (1 - pend / tot)) + "%"; if (tiles.stats.loaded >= 4 || (tot > 0 && pend === 0 && tiles.stats.loaded > 0)) { loadingEl.hidden = true; if (!running && !M) { renderMenu("missions"); document.getElementById("intro").hidden = false; } } }
  // fps
  fpsAcc += rawDt; fpsN++;
  if (fpsAcc > 1) { fpsShow = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; adaptQuality(fpsShow); const k = Math.max(1, PERF.n); window.PERF_LAST = { traffic: PERF.traffic / k, props: PERF.props / k, render: PERF.render / k, frame: PERF.frame / k }; PERF.traffic = PERF.props = PERF.render = PERF.frame = 0; PERF.n = 0; if (settings.fps) { const el = document.getElementById("fps"); el.hidden = false; const P2 = window.PERF_LAST; el.textContent = `${fpsShow.toFixed(0)} fps  ${renderer.info.render.calls} calls  ${(renderer.info.render.triangles / 1000).toFixed(0)}k tris  tiles ${tiles.tiles.size}  cars ${traffic.cars.length}  pr ${prMode.toFixed(2)}  cpu ms: traffic ${P2.traffic.toFixed(1)} props ${P2.props.toFixed(1)} render-submit ${P2.render.toFixed(1)} frame ${P2.frame.toFixed(1)}`; } }
  if (frameNo % 2 === 0 && !window.NOLABELS) drawLabels();
  if (running && mini && miniCar && frameNo % 3 === 0 && !window.NOMINI) {
    // heading-up like a satnav, zoomed out with speed, the car low in the frame to show the road ahead
    const big = document.getElementById("mini").classList.contains("big");
    const zWant = big ? 14.2 : 16.4 - Math.min(1.9, Math.abs(S.v) / 22);
    miniZoom = miniZoom == null ? zWant : miniZoom + (zWant - miniZoom) * 0.08;
    const hMini = document.getElementById("mini").clientHeight || 250;
    mini.jumpTo({ center: [S.lon, S.lat], bearing: big ? 0 : S.hdg, zoom: miniZoom, padding: { top: big ? 0 : hMini * 0.38, bottom: 0, left: 0, right: 0 } });
    miniCar.setLngLat([S.lon, S.lat]); miniCar.setRotation(S.hdg);
    const nEl = document.getElementById("north"); if (nEl) nEl.style.transform = `rotate(${big ? 0 : -S.hdg}deg)`;
  }
  if (frameNo % 3 === 0 && running && !window.NOHUD) hud(t);
}
// Tunnel cuttings within 900 m of the camera go to the ground, area, water and pavement shaders.
function updateCuts(OFF) {
  const cx = camera.position.x, cz = camera.position.z, list = [];
  for (const t of tiles.tiles.values()) {
    if (!t.cuts || !t.off) continue;
    const c = t.cuts;
    for (let i = 0; i < c.length; i += 5) { const x0 = c[i] + t.off.x, z0 = c[i + 1] + t.off.z, x1 = c[i + 2] + t.off.x, z1 = c[i + 3] + t.off.z; const d = Math.hypot((x0 + x1) / 2 - cx, (z0 + z1) / 2 - cz); if (d < 900) list.push([d, x0, z0, x1, z1, c[i + 4]]); }
  }
  list.sort((a, b) => a[0] - b[0]);
  const n = Math.min(16, list.length);
  for (let i = 0; i < n; i++) { U.uCuts.value[i].set(list[i][1], list[i][2], list[i][3], list[i][4]); U.uCutW.value[i] = list[i][5]; }
  U.uCutN.value = n;
}
// Running a red light: entering a signalised junction while your phase is red.
let rlInside = null;
function redLight(t, OFF) {
  if (Math.abs(S.v) < 3 || AUTO.on) { rlInside = null; return; }
  const near = signals.near(carPos.x, carPos.z, OFF, 22);
  const c = near[0];
  if (!c) { rlInside = null; return; }
  const id = c.key + ":" + c.i;
  if (rlInside === id) return;
  rlInside = id;
  // travel direction in world x/z, compared with the controller's main axis (x east, z south)
  const phi = Math.atan2(-Math.cos(S.hdg * Math.PI / 180), Math.sin(S.hdg * Math.PI / 180));
  const d = Math.abs(((phi - c.ref) % Math.PI + Math.PI) % Math.PI), g = d < Math.PI / 4 || d > 3 * Math.PI / 4 ? 0 : 1;
  if (signalState(c.seed, g, t / 1000) === 2) { if (M) M.redLights = (M.redLights || 0) + 1; toast(`<b>Red light</b><small>You went through on red. In real life that means a fine and black points on your licence.</small>`, "gate"); flash(); }
}
// Test autopilot: glides along the mission route at a set speed (used by the screenshot
// harness to reach views deep into a route; also a "demo mode" from the console).
const AUTO = { on: false, speed: 24, s: 0 };
function autopilot(dt) {
  const g = M.v.geom, cum = M.cum;
  AUTO.s = Math.min(cum[cum.length - 1] - 1, AUTO.s + AUTO.speed * dt);
  let i = Math.max(0, Math.min(g.length - 2, M.ri));
  while (i < g.length - 2 && cum[i + 1] < AUTO.s) i++;
  const t = (AUTO.s - cum[i]) / Math.max(1e-6, cum[i + 1] - cum[i]);
  S.lat = g[i][0] + (g[i + 1][0] - g[i][0]) * t; S.lon = g[i][1] + (g[i + 1][1] - g[i][1]) * t;
  const want = bearing(g[i], g[Math.min(g.length - 1, i + 2)]);
  // keep to a lane: the right half of two-way roads, the middle of a lane on one-way roads
  if (IDX.ready) {
    const r = alignedRoad(S.lat, S.lon, want);
    let off = 0; if (r) { const w = r.s.w || 2 * r.s.hw, n = Math.max(1, r.s.ln || 2); off = r.s.ow ? (n % 2 === 0 ? w / n / 2 : 0) : w / 4; }
    AUTO.sh = (AUTO.sh || 0) + (off - (AUTO.sh || 0)) * Math.min(1, dt * 1.5);
    [S.lat, S.lon] = move(S.lat, S.lon, want + 90, AUTO.sh);
  }
  let d = want - S.hdg; while (d > 180) d -= 360; while (d < -180) d += 360; S.hdg = (S.hdg + d * Math.min(1, dt * 4) + 360) % 360;
  S.v = AUTO.speed; S.steer = THREE.MathUtils.clamp(d / 25, -1, 1);
  M.ri = i; M.progress = AUTO.s; if (!M.started) { M.started = true; M.t0 = performance.now(); }
  senseRoad(performance.now());
}
let waitWorld = 0;
function worldReadyAt(lat, lon) { const [x, y] = tileOf(lat, lon); const t = tiles.tiles.get(x + "/" + y); return !!(t && t.state === "ready") && IDX.ready && !idxJobs.some(j => j.x === x && j.y === y); }
function offsets() { const m = new Map(); for (const t of tiles.tiles.values()) if (t.off && t.state === "ready") m.set(t.key, t.off); return m; }
// Dynamic resolution: on "normal", drop the pixel ratio when frames run long and restore it when there is headroom.
let slowSecs = 0, fastSecs = 0;
// Each change rebuilds the render targets, which freezes a frame for 100-300 ms, so it changes rarely:
// one bigger step down after 3 slow seconds, back up only after 12 fast seconds, at least 20 s apart,
// at most 4 changes a session, and never during the route preview.
let prChanges = 0, prLastT = -1e9;
function adaptQuality(fps) {
  if (settings.quality !== "normal" || PV.on) return;
  if (fps < 24) { slowSecs++; fastSecs = 0; } else if (fps > 55) { fastSecs++; slowSecs = 0; } else { slowSecs = 0; fastSecs = 0; }
  const now = performance.now(); if (prChanges >= 4 || now - prLastT < 20000) return;
  if (slowSecs >= 3 && prMode > 0.62) { prMode = Math.max(0.6, prMode - 0.2); applyPR(); slowSecs = 0; prChanges++; prLastT = now; }
  else if (fastSecs >= 12 && prMode < Q.pr) { prMode = Math.min(Q.pr, prMode + 0.2); applyPR(); fastSecs = 0; prChanges++; prLastT = now; }
}
function applyPR() { renderer.setPixelRatio(prMode); renderer.setSize(innerWidth, innerHeight); fx.setSize(innerWidth, innerHeight); }
function placeLandmarks() {
  for (const L of landmarks) {
    const d = hav([S.lat, S.lon], [L.def.lat, L.def.lon]);
    const near = d < 16000;
    if (near && !L.group && !L.loading) {
      let g;
      try { g = L.def.build(); } catch (e) { console.warn("landmark", L.def.id, e); L.def.build = () => new THREE.Group(); continue; }
      g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; if (o.material && !o.material.name) o.material.name = "lm:" + L.def.id; } });
      g.rotation.y = -(L.def.headingDeg || 0) * Math.PI / 180;
      // Compile its shaders in the background first (a first-time compile of a lit material can
      // stall a frame for a second or more on Windows), then show it.
      L.loading = true;
      const show = () => {
        L.loading = false;
        if (hav([S.lat, S.lon], [L.def.lat, L.def.lon]) > 17000 || L.group) { (L.def.dispose || LM.disposeLandmark || (() => {}))(g); return; }
        const v = toWorld(L.def.lat, L.def.lon); g.position.set(v.x, 0, v.z);
        L.group = g; scene.add(g);
      };
      const v = toWorld(L.def.lat, L.def.lon); g.position.set(v.x, 0, v.z);
      if (renderer.compileAsync) compileLikeFrame(g).then(show, show); else show();
    } else if (!near && L.group) { scene.remove(L.group); (L.def.dispose || LM.disposeLandmark)(L.group); L.group = null; }
  }
}

// ================================================================== HUD
let miniZoom = null;
// The district you are in: the nearest suburb or neighbourhood point from the map's place layer,
// with the nearest city or town. A toast when you cross into a new one.
const AREA = { name: "", city: "", t: 0, shown: "" };
function updateArea(t) {
  if (t - AREA.t < 1000) return; AREA.t = t;
  let best = null, bd = 3500, city = null, cd = 60000, curD = 1e9;
  const W = { suburb: 1, quarter: 1.2, neighbourhood: 1.4, town: 1.8, village: 1.6, hamlet: 1.8 };
  for (const tl of tiles.tiles.values()) {
    if (!tl.places || !tl.off) continue;
    for (const p of tl.places) {
      const d = Math.hypot(p.x + tl.off.x - carPos.x, p.z + tl.off.z - carPos.z);
      if (p.c === "city") { if (d < cd) { cd = d; city = p; } continue; }
      const sc = d * (W[p.c] || 1.4);
      if (sc < bd) { bd = sc; best = p; }
      if ((p.en || D.names[p.ar] || p.ar) === AREA.name && sc < curD) curD = sc;
    }
  }
  let nm = best ? (best.en || D.names[best.ar] || best.ar) : "";
  if (AREA.name && nm !== AREA.name && curD < 3500 && bd > curD * 0.75) nm = AREA.name;
  AREA.city = city ? (city.en || city.ar) : CITY.region === "shanghai" ? "Shanghai" : (S.lon < 54.95 ? "Abu Dhabi" : "Dubai");
  if (nm && nm !== AREA.name) { if (AREA.name && running && !paused) toast(`Entering <b>${esc(nm)}</b><small>${esc(AREA.city)}</small>`, "good"); AREA.name = nm; }
}
function hud(t) {
  updateArea(t);
  const kmh = Math.round(Math.abs(S.v) * 3.6), lim = S.onRoad ? (S.limit || LIMIT[S.cls] || 40) : 40;
  document.querySelector("#speed .v").textContent = kmh;
  document.querySelector("#speed .lim").textContent = S.onRoad ? lim : "-";
  document.getElementById("speed").classList.toggle("over", kmh > lim + 5);
  const st = document.getElementById("street");
  const nm = S.name || (S.onRoad ? (/link/.test(S.cls) ? "Slip road" : S.cls === "service" ? "Service road" : /motorway|trunk/.test(S.cls) ? "Main road" : "Local street") : "Off road");
  if (st._nm !== nm) { st._nm = nm; st.querySelector(".nm").textContent = nm; }
  const area = AREA.name ? `${AREA.name} \u00b7 ${AREA.city}` : AREA.city;
  const ae = st.querySelector(".area"); if (ae && ae._a !== area) { ae._a = area; ae.textContent = area; }
  const meta = `${!S.name && S.toward ? `<span>to ${esc(S.toward)}</span>` : !S.name && S.near ? `<span>off ${esc(S.near)}</span>` : ""}${S.ref ? `<span class="ref">${esc(S.ref)}</span>` : ""}${S.nameAr && S.nameAr !== S.name ? `<span class="ar">${esc(S.nameAr)}</span>` : ""}${S.brunnel ? `<span>${S.brunnel}</span>` : ""}${!S.onRoad ? `<span class="off">off road, max 40</span>` : M && M.offRoute && !M.free ? `<span class="off">off route</span>` : ""}`;
  if (st._meta !== meta) { st._meta = meta; st.querySelector(".meta").innerHTML = meta; }
  if (!M) return;
  const mi = document.getElementById("mission");
  let html;
  if (M.free) html = `<span class="dest">Free roam</span><span>driven <b>${(M.dist / 1000).toFixed(1)} km</b></span><span>tolls <b>${aed(M.cost)}</b></span>`;
  else {
    const rem = Math.max(0, M.cum[M.cum.length - 1] - M.progress);
    const secs = remainingSeconds(M.v, M.cum, M.progress);
    const elapsed = M.started ? (t - M.t0) / 1000 : 0;
    const arr = ((M.hour0 || 12) + (elapsed + secs) / 3600) % 24;
    const clock = `${String(Math.floor(arr)).padStart(2, "0")}:${String(Math.floor((arr % 1) * 60)).padStart(2, "0")}`;
    html = `<span class="min">${secs < 60 ? "<1" : Math.round(secs / 60)} min</span><span><b>${fmtM(rem)}</b></span><span>arrive <b>${clock}</b></span><span class="dest">${esc(M.destName)}</span><span>tolls <b>${aed(M.cost)}</b></span>`;
  }
  if (mi._h !== html) { mi._h = html; mi.innerHTML = html; }
  if (M.free || !settings.gps) { nav.hide(); if (turnArrow) clearTurnArrow(); return; }
  const r = nav.update(M.progress, Math.abs(S.v), M.offRoute, M.rerouting, M.offDist);
  // the road arrow through the next real turn, shown in the last 260 m
  const show = r && !M.offRoute && r.m.shape !== "arrive" && r.d < 260;
  if (show && turnArrowFor !== r.m.at) buildTurnArrow(r.m.at);
  if (!show && turnArrow) clearTurnArrow();
  if (turnArrow) arrowMat.uniforms.uAlpha.value = Math.min(1, (260 - r.d) / 60);
  if (r && !M.offRoute && IDX.ready) for (let k = r.i; k < Math.min(nav.mans.length, r.i + 3); k++) { const mm = nav.mans[k]; if (mm.at - M.progress > 1300) break; if (!guides.has(mm.at)) buildGuide(mm); }
  if (guides.size && frameNo % 30 === 0) clearGuides(false);
}

// ================================================================== keys and menus
function onKey(e) {
  const k = e.key.toLowerCase();
  if (PV.on) { endPreview(); return; }
  if (k === "o" && running && M && !M.free) { startPreview(); return; }
  if (k === "f" && !running) { cycleLook(); return; }
  if (k === "t" && !running) { cycleTime(); return; }
  if (!running && !paused) return;
  if (k === "escape") togglePause();
  else if (k === "g") { settings.gps = !settings.gps; saveSettings(); toast(settings.gps ? "GPS on" : "GPS off. Find your own way.", "warn"); if (M) setGps(settings.gps && !M.free ? M.v.geom : [], null); setNav(); }
  else if (k === "v") { settings.voice = !settings.voice; nav.voice = settings.voice; saveSettings(); if (!nav.voice) try { speechSynthesis.cancel(); } catch (e2) {} toast(settings.voice ? "Voice directions on" : "Voice directions off", "warn"); if (nav.voice) nav.say("Voice directions on."); }
  else if (k === "c") { settings.cam = CAMS[(CAMS.indexOf(settings.cam) + 1) % CAMS.length]; saveSettings(); camInit = true; toast("Camera: " + CAM_NAMES[settings.cam], "warn"); }
  else if (k === "t") cycleTime();
  else if (k === "f") cycleLook();
  else if (k === "m") { document.getElementById("mini").classList.toggle("big"); setTimeout(() => mini && mini.resize(), 50); }
  else if (k === "r") respawn();
  else if (k === "p") { settings.fps = !settings.fps; saveSettings(); document.getElementById("fps").hidden = !settings.fps; }
}
function cycleTime() { settings.time = (settings.time + 1) % TIMES.length; saveSettings(); atmo.setHour(TIMES[settings.time][1]); toast("Time: " + TIMES[settings.time][0], "warn"); if (!running) renderMenu(); }
function cycleLook() { const i = (PRESETS.indexOf(settings.look) + 1) % PRESETS.length; settings.look = PRESETS[i]; saveSettings(); fx.setMode(settings.look); toast("Look: " + settings.look, "warn"); if (!running) renderMenu(); }
function togglePause() {
  if (!M) return;
  paused = !paused;
  document.getElementById("pause").hidden = !paused;
  if (paused) document.getElementById("pausePanel").innerHTML = `<h3>Paused</h3><p class="sub">${esc(M.route.title)}</p>
    <div class="row2"><button class="btn primary" onclick="togglePause()">Resume</button><button class="btn" onclick="respawn();togglePause()">Back on route</button><button class="btn" onclick="onKey({key:'g'});togglePause()">GPS ${settings.gps ? "off" : "on"}</button><button class="btn" onclick="onKey({key:'c'});togglePause()">Next camera</button><button class="btn" onclick="onKey({key:'t'});togglePause()">Time of day</button><button class="btn" onclick="onKey({key:'f'});togglePause()">Visual look</button><button class="btn" onclick="togglePause();startPreview()">Route preview</button><button class="btn" onclick="quitToMenu()">Quit to menu</button></div>
    <h2>Keys</h2><p class="sub"><span class="kbd">W</span> accelerate &middot; <span class="kbd">S</span> brake / reverse &middot; <span class="kbd">A</span> <span class="kbd">D</span> steer &middot; <span class="kbd">Space</span> handbrake &middot; <span class="kbd">H</span> horn &middot; <span class="kbd">C</span> camera &middot; <span class="kbd">T</span> time of day &middot; <span class="kbd">F</span> visual look &middot; <span class="kbd">G</span> GPS &middot; <span class="kbd">V</span> voice &middot; <span class="kbd">M</span> big map &middot; <span class="kbd">R</span> back on route &middot; <span class="kbd">O</span> route preview &middot; <span class="kbd">P</span> frame rate &middot; <span class="kbd">Esc</span> this menu &middot; drag the screen (or <span class="kbd">Q</span> <span class="kbd">E</span>) to look around, scroll to zoom</p>`;
  else lastT = performance.now();
}
let menuTab = "missions", menuRoute = null, menuVariant = "fast";
function renderMenu(tab, routeId) {
  menuTab = tab || menuTab; if (routeId) { menuRoute = D.routes.find(r => r.id === routeId); menuVariant = "fast"; }
  document.getElementById("menu").hidden = false;
  const tabs = ["missions", "free", "live", "look", "tolls", "help"].filter(t => t !== "tolls" || !CITY.noTolls).map(t => `<button class="${menuTab === t ? "on" : ""}" onclick="renderMenu('${t}')">${{ missions: "Missions", free: "Free roam", live: "Any A to B", look: "Look & feel", tolls: "Salik & Darb", help: "How to play" }[t]}</button>`).join("");
  let h = CITY.title ? `<h1>${CITY.title}</h1><p class="sub">${CITY.sub}</p>` : `<h1>UAE Drive</h1><p class="sub">The real Dubai and Abu Dhabi in 3D: every street, junction and toll gate from OpenStreetMap, with buildings, palms, traffic and the landmarks built in.</p><div class="tabs">${tabs}</div>`;
  if (menuTab === "missions") h += menuRoute ? briefing(menuRoute) : missionList();
  else if (menuTab === "free") h += freeRoam();
  else if (menuTab === "live") h += liveForm();
  else if (menuTab === "look") h += lookPage();
  else if (menuTab === "tolls") h += tollsPage();
  else h += helpPage();
  document.getElementById("menuPanel").innerHTML = h;
  const b = document.getElementById("band"); if (b) b.onchange = e => { settings.band = e.target.value; saveSettings(); renderMenu(); };
  const gp = document.getElementById("gpsopt"); if (gp) gp.onchange = e => { settings.gps = e.target.checked; saveSettings(); };
  const go = document.getElementById("go"); if (go) go.onclick = liveGo;
}
function missionList() {
  let h = `<div class="note">Start with Level 1. Each route is a real trip: you start at A on the real road, the satnav card tells you each turn (with the lane to be in, where OpenStreetMap has it), a blue line and big arrows on the road show the way, and you arrive at B. Turn the GPS off once a route feels familiar; that is the actual test.</div>`;
  for (const lv of [1, 2, 3, 4]) {
    h += `<h2>Level ${lv}: ${LEVELS[lv]}</h2><div class="grid">`;
    for (const r of D.routes.filter(x => x.level === lv)) {
      const f = r.fast; const b = best(r.id, "fast");
      const gates = f.gates.length ? `<span class="pill ${f.gates.some(g => g.sys === "salik") ? "salik" : "darb"}">${f.gates.length} gate${f.gates.length > 1 ? "s" : ""}</span>` : CITY.noTolls ? `` : `<span class="pill free">no tolls</span>`;
      h += `<div class="card" onclick="renderMenu('missions','${r.id}')"><div class="nm">${esc(r.title)}${gates}<small>${esc(P[r.from].label)} to ${esc(P[r.to].label)}${b ? ` <span class="best">best ${fmtT(b.time)}</span>` : ""}</small></div><div class="pr">${fmtKm(f.km)}<br>${f.min} min real</div></div>`;
    }
    h += `</div>`;
  }
  return h;
}
function briefing(r) {
  const v = r[menuVariant] || r.fast; const has2 = !!r.notoll; const band = settings.band;
  let h = `<span class="link" onclick="menuRoute=null;renderMenu('missions')">&larr; all missions</span><h3 style="margin-top:10px">${esc(r.title)}</h3><p class="sub">${esc(P[r.from].label)} &rarr; ${esc(P[r.to].label)} &middot; Level ${r.level}</p>`;
  if (has2) h += `<div class="tabs" style="margin-top:0"><button class="${menuVariant === "fast" ? "on" : ""}" onclick="menuVariant='fast';renderMenu()">Fastest</button><button class="${menuVariant === "notoll" ? "on" : ""}" onclick="menuVariant='notoll';renderMenu()">Without Salik</button></div>`;
  h += `<div class="stats"><div class="stat"><b>${fmtKm(v.km)}</b><span>distance</span></div><div class="stat"><b>${v.min} min</b><span>real drive time</span></div><div class="stat"><b>${aed(costFor(v, band))}</b><span>tolls, ${BANDS[band].label.split(" ")[0].toLowerCase()}</span></div><div class="stat"><b>${v.steps.filter(s => s.ask).length}</b><span>junctions</span></div></div>`;
  h += `<div class="row2"><button class="btn primary big" onclick="startMission(menuRoute,menuVariant)">Start driving</button><label class="opt"><input type="checkbox" id="gpsopt" ${settings.gps ? "checked" : ""}> GPS line</label><label class="opt">tolls at <select id="band">${Object.entries(BANDS).map(([k, b]) => `<option value="${k}" ${k === band ? "selected" : ""}>${b.label}</option>`).join("")}</select></label></div>`;
  const b = best(r.id, menuVariant); if (b) h += `<p class="best">Best: ${fmtT(b.time)}, ${b.km} km driven, ${b.reroutes} wrong turns, ${b.date}</p>`;
  h += `<h2>The route in one breath</h2><p class="sub" style="color:var(--ink)">${esc(oneBreath(v))}</p>`;
  if (v.gates.length) h += `<p class="sub">Gates: ${v.gates.map(g => esc(g.name) + " (" + aed(gateCost(g, band)) + ")").join(", ")}.</p>`;
  if (has2) {
    const f = r.fast, n = r.notoll; const dm = n.min - f.min, dc = costFor(f, band) - costFor(n, band);
    h += `<h2>Fastest vs without Salik</h2><table><tr><th></th><th class="num">Fastest</th><th class="num">No Salik</th></tr><tr><td>Distance</td><td class="num">${f.km} km</td><td class="num">${n.km} km</td></tr><tr><td>Real drive time</td><td class="num">${f.min} min</td><td class="num">${n.min} min</td></tr>`;
    for (const k of ["peak", "offpeak", "night", "sunday"]) h += `<tr><td>${BANDS[k].label}</td><td class="num">${aed(costFor(f, k))}</td><td class="num">${aed(costFor(n, k))}</td></tr>`;
    h += `<tr><td>Gates</td><td>${f.gates.map(g => g.name).join(", ") || "none"}</td><td>${n.gates.map(g => g.name).join(", ") || "none"}</td></tr></table>`;
    h += dm <= 1 ? `<div class="note">The toll-free route is <b>as quick</b> (${n.min} vs ${f.min} min). Take it and save ${aed(dc)}.</div>` : dc <= 0 ? `<div class="note">At ${BANDS[band].label.toLowerCase()} rates the gates here are free, so there is nothing to avoid.</div>` : `<div class="note">Avoiding the gates costs <b>${dm} extra minutes</b> and saves <b>${aed(dc)}</b> at ${BANDS[band].label.toLowerCase()} rates: AED ${(dc / dm * 60).toFixed(0)} per hour of your time.</div>`;
  }
  h += `<h2>Turn by turn</h2><ul class="steps">${walkthroughRows(v)}</ul>`;
  return h;
}
function walkthroughRows(v) {
  const cum = cumulative(v.geom); const rows = [];
  for (const s of v.steps) if (s.kind !== "start") rows.push({ at: cum[s.idx], html: `<span class="km">${(cum[s.idx] / 1000).toFixed(1)}</span>${esc(s.text)}${s.toward.length ? `<div class="ar" style="direction:ltr">Sign: ${esc(s.toward.join(" / "))}${s.exit_no.length ? " &middot; Exit " + esc(s.exit_no.join("/")) : ""}</div>` : ""}`, cls: "" });
  for (const g of v.gates) rows.push({ at: cum[g.idx] + 0.5, html: `<span class="km">${(cum[g.idx] / 1000).toFixed(1)}</span>${g.sys === "salik" ? "Salik" : "Darb"} gate: <b>${esc(g.name)}</b>, ${esc(g.road)}. ${gateRule(g)}`, cls: "gate" });
  for (const p of v.passes) rows.push({ at: cum[p.idx] + 0.25, html: `<span class="km">${(cum[p.idx] / 1000).toFixed(1)}</span>Passing ${esc(P[p.id].label)}, ${p.d} m away`, cls: "pass" });
  rows.sort((a, b) => a.at - b.at);
  return rows.map(r => `<li class="${r.cls}">${r.html}</li>`).join("");
}
function freeRoam() {
  const stops = D.places.filter(p => p.kind === "stop").sort((a, b) => (a.city + a.label).localeCompare(b.city + b.label));
  return `<h3>Free roam</h3><p class="sub">No destination. Start somewhere and explore. Gates still charge, landmarks still get called out, the street name is always on screen.</p><div class="grid">${stops.map(p => `<div class="card" onclick="startFree('${p.id}')"><div class="nm">${esc(p.label)}<small>${p.city === "DXB" ? "Dubai" : p.city === "AUH" ? "Abu Dhabi" : esc(p.city)}</small></div></div>`).join("")}</div>`;
}
function startFree(pid) {
  const p = P[pid];
  const route = { id: "free", level: 0, title: "Free roam from " + p.label, from: pid, to: pid, fast: { km: 0, min: 0, geom: [[p.lat, p.lon], [p.lat + 0.0004, p.lon]], steps: [], roads: [], gates: [], passes: [] } };
  startMission(route, "fast", { free: true });
  pendingSnap = { lat: p.lat, lon: p.lon, t: performance.now() };
}
// Free roam starts at a place pin, which often sits on a building. Once the tiles around it
// are indexed, move the car to the nearest proper road and face along it.
let pendingSnap = null;
const SNAP_RANK = { motorway: 5, trunk: 3, primary: 1, secondary: 0, tertiary: 0, minor: 1.6, service: 3, track: 4 };
function trySnap() {
  if (!pendingSnap || !IDX.ready) return;
  const { lat, lon } = pendingSnap;
  let best = null, bd = 1e9;
  const c = IDX.cell, i0 = Math.floor(lat / c), j0 = Math.floor(lon / c);
  for (let i = i0 - 9; i <= i0 + 9; i++) for (let j = j0 - 9; j <= j0 + 9; j++) {
    for (const s of IDX.roads.get(i + "_" + j) || []) {
      if (s.brunnel === "tunnel" || /link/.test(s.cls)) continue;
      const [d, t] = segDist([lat, lon], s.a, s.b);
      const score = d + 25 * (SNAP_RANK[s.cls] ?? 3);
      if (score >= bd) continue;
      const pl = s.a[0] + (s.b[0] - s.a[0]) * t, po = s.a[1] + (s.b[1] - s.a[1]) * t;
      if (IDX.building(pl, po)) continue;                     // a ramp or road running under a mall
      bd = score; best = { s, t };
    }
  }
  if (!best) { if (performance.now() - pendingSnap.t > 15000) pendingSnap = null; return; }
  const { s, t } = best;
  S.lat = s.a[0] + (s.b[0] - s.a[0]) * t; S.lon = s.a[1] + (s.b[1] - s.a[1]) * t; S.hdg = bearing(s.a, s.b);
  pendingSnap = null; camInit = true; S.v = 0; pendingLane = true;
}
function liveForm() {
  const stops = D.places.filter(p => p.kind === "stop").sort((a, b) => (a.city + a.label).localeCompare(b.city + b.label));
  const opt = sel => stops.map(p => `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${p.city}: ${esc(p.label)}</option>`).join("");
  return `<h3>Any A to B</h3><p class="sub">Routed live by the public Valhalla router on current OpenStreetMap data. Needs internet.</p><div class="row2"><label class="opt">from <select id="fa">${opt("dxb")}</select></label><label class="opt">to <select id="fb2">${opt("difc")}</select></label><label class="opt"><input type="checkbox" id="avoid"> avoid Salik and 24/7 Darb gates</label><button class="btn primary" id="go">Route it</button></div><div id="fres"></div>`;
}
async function liveGo() {
  const a = P[document.getElementById("fa").value], b = P[document.getElementById("fb2").value], avoid = document.getElementById("avoid").checked;
  const res = document.getElementById("fres"); res.innerHTML = `<p class="sub">Routing...</p>`;
  try {
    const v = buildVariant(await valhalla(a, b, avoid), a.id, b.id);
    liveLanes(a, b, avoid, v);
    const route = { id: "live", level: 0, title: `${a.label} to ${b.label}`, from: a.id, to: b.id, fast: v };
    if (avoid) route.notoll = v;
    res.innerHTML = `<div class="stats"><div class="stat"><b>${fmtKm(v.km)}</b><span>distance</span></div><div class="stat"><b>${v.min} min</b><span>real drive time</span></div><div class="stat"><b>${aed(costFor(v, settings.band))}</b><span>tolls</span></div><div class="stat"><b>${v.steps.filter(s => s.ask).length}</b><span>junctions</span></div></div><div class="row2"><button class="btn primary big" id="liveStart">Start driving</button></div><p class="sub" style="color:var(--ink)">${esc(oneBreath(v))}</p>${v.gates.length ? `<p class="sub">Gates: ${v.gates.map(g => esc(g.name)).join(", ")}</p>` : ""}<h2>Turn by turn</h2><ul class="steps">${walkthroughRows(v)}</ul>`;
    document.getElementById("liveStart").onclick = () => startMission(route, avoid ? "notoll" : "fast");
  } catch (e) { res.innerHTML = `<div class="note">Routing failed (${esc(e.message)}). The public router is rate-limited; wait a few seconds and try again.</div>`; }
}
function seg(name, options, cur) { return `<div class="seg">${options.map(([v, l]) => `<button class="${String(cur) === String(v) ? "on" : ""}" onclick="setOpt('${name}','${v}')">${l}</button>`).join("")}</div>`; }
function lookPage() {
  const colors = [[0xf97316, "Orange"], [0xdc2626, "Red"], [0x0ea5e9, "Blue"], [0xf5f5f4, "Pearl"], [0x111827, "Black"], [0xeab308, "Gold"], [0x16a34a, "Green"]];
  return `<h3>Look & feel</h3>
  <h2>Time of day</h2>${seg("time", TIMES.map((t, i) => [i, t[0]]), settings.time)} <span class="sub">&nbsp;or press <span class="kbd">T</span> while driving</span>
  <h2>Visual look</h2>${seg("look", PRESETS.map(p => [p, p === "nightvision" ? "night vision" : p]), settings.look)} <span class="sub">&nbsp;<span class="kbd">F</span> while driving. Thermal, night vision and CRT are borrowed from God's Eye View.</span>
  <h2>Camera</h2>${seg("cam", CAMS.map(c => [c, CAM_NAMES[c]]), settings.cam)}
  <h2>Traffic</h2>${seg("traffic", [["off", "off"], ["normal", "normal"], ["heavy", "heavy"]], settings.traffic)}
  <h2>Car colour</h2>${seg("color", colors.map(([c, n]) => [c, n]), settings.color)}
  <h2>Sound</h2>${seg("sound", [["1", "on"], ["0", "off"]], settings.sound === false ? "0" : "1")} ${seg("vol", [["0.35", "quiet"], ["0.7", "medium"], ["1", "loud"]], settings.vol ?? 0.7)} <span class="sub">&nbsp;engine, tyres, wind; <span class="kbd">H</span> is the horn</span>
  <h2>Route preview</h2>${seg("preview", [["drive", "fast-forward drive"], ["sky", "from the sky"], ["0", "off"]], settings.preview === false ? "0" : settings.preview === "sky" ? "sky" : "drive")} <span class="sub">&nbsp;when a mission starts, see the whole route first; <span class="kbd">O</span> plays it again, any key or tap skips it</span>
  <h2>Spoken directions</h2>${seg("voice", [["1", "on"], ["0", "off"]], settings.voice === false ? "0" : "1")} <span class="sub">&nbsp;or <span class="kbd">V</span> while driving</span>
  <h2>Place names over the city</h2>${seg("labels", [["1", "on"], ["0", "off"]], settings.labels === false ? "0" : "1")} <span class="sub">&nbsp;metro stations, malls, hotels and sights near you</span>
  <h2>Graphics quality</h2>${seg("quality", [["low", "low"], ["normal", "normal (adaptive)"], ["high", "high"]], settings.quality)} <p class="sub">Quality changes apply after a reload. Press <span class="kbd">P</span> while driving to see the frame rate.</p>`;
}
function setOpt(name, v) {
  if (name === "time") { settings.time = +v; atmo.setHour(TIMES[settings.time][1]); }
  else if (name === "look") { settings.look = v; fx.setMode(v); }
  else if (name === "cam") { settings.cam = v; camInit = true; }
  else if (name === "traffic") { settings.traffic = v; traffic.target = v === "off" ? 0 : v === "heavy" ? Q.traffic * 1.6 : Q.traffic; if (v === "off") traffic.cars.length = 0; }
  else if (name === "color") { settings.color = +v; car.setColor(+v); }
  else if (name === "quality") { settings.quality = v; saveSettings(); location.reload(); return; }
  else if (name === "sound") { settings.sound = v === "1"; audio.setEnabled(settings.sound); }
  else if (name === "vol") { settings.vol = +v; audio.setVolume(settings.vol); }
  else if (name === "preview") { settings.preview = v === "0" ? false : v; }
  else if (name === "voice") { settings.voice = v === "1"; nav.voice = settings.voice; }
  else if (name === "labels") { settings.labels = v === "1"; }
  saveSettings(); renderMenu();
}
function tollsPage() {
  return `<h3>Salik and Darb, verified September 2026</h3>
  <h2>Salik (Dubai), 10 gates</h2><table><tr><th>When</th><th class="num">Per crossing</th></tr><tr><td>Peak: 06:00-10:00 and 16:00-20:00</td><td class="num">AED 6.30</td></tr><tr><td>Off-peak: 10:00-16:00 and 20:00-01:00</td><td class="num">AED 4.20</td></tr><tr><td>Night: 01:00-06:00, every day</td><td class="num">free</td></tr><tr><td>Sunday (not public holidays): flat, except night</td><td class="num">AED 4.20</td></tr></table>
  <p class="sub">Base tariff AED 6 / 4 since 31 Jan 2025; 5% VAT added from 1 June 2026. Ramadan shifts peak to 09:00-17:00. Al Safa North + South, and Al Mamzar North + South, count once if you pass both the same way within an hour.</p>
  <table><tr><th>Gate</th><th>Road</th></tr>${D.gates.filter(g => g.sys === "salik").map(g => `<tr><td>${esc(g.name)}</td><td>${esc(g.road)}</td></tr>`).join("")}</table>
  <h2>Darb (Abu Dhabi), 6 gates</h2><table><tr><th>Gate</th><th>Charged</th></tr>${D.gates.filter(g => g.sys === "darb").map(g => `<tr><td>${esc(g.name)}</td><td>AED 4, Mon-Sat 07:00-09:00 and 15:00-19:00 only</td></tr>`).join("")}${D.gates.filter(g => g.sys === "darb24").map(g => `<tr><td>${esc(g.name)}<div class="ar" style="direction:ltr">${esc(g.road)}</div></td><td>AED 4, every crossing, 24/7 (since 4 May 2026)</td></tr>`).join("")}</table>
  <p class="sub">Bridge gates are free outside those windows and all day Sunday and public holidays. Daily and monthly caps were removed on 1 Sep 2025.</p>`;
}
function helpPage() {
  return `<h3>How to play</h3><p class="sub">You struggle with directions. This puts you behind the wheel on the real roads until the city sticks.</p>
  <h2>Driving</h2><p class="sub"><span class="kbd">W</span> or <span class="kbd">&uarr;</span> accelerate &middot; <span class="kbd">S</span> brake, then reverse &middot; <span class="kbd">A</span> <span class="kbd">D</span> steer &middot; <span class="kbd">Space</span> handbrake. Buildings, water and other cars stop you. Off road you are capped at 40 km/h; motorways are fast, side streets are not.</p>
  <h2>Missions</h2><p class="sub">Every mission is a real trip between two real places. The green card at the top left is the satnav: the next turn, how far, the road to take and where it leads, with lane arrows where the real road has turn lanes, spoken aloud too (<span class="kbd">V</span> turns the voice off). The blue line on the road is the route, a big arrow is painted through each turn as you reach it, the blue beam is the destination, and the map turns with the car. The bar at the bottom shows minutes and distance to go and your arrival time. Take a wrong turn and the GPS reroutes you after five seconds. Drive under a Salik or Darb gantry and it bills you at the time band you picked.</p>
  <h2>The world</h2><p class="sub">Streets, buildings, heights, parks and water are OpenStreetMap, streamed as OpenFreeMap vector tiles and built into 3D on your machine: window facades by building type, lane markings, sidewalks with painted curbs, palms and street lamps along the main roads, domes and minarets on mapped mosques. The famous landmarks are hand-built models. Traffic is simulated on the real road network. Routes are from the Valhalla router, baked ${D.generated}.</p>
  <h2>Keys</h2><p class="sub"><span class="kbd">C</span> camera &middot; <span class="kbd">T</span> time of day &middot; <span class="kbd">F</span> visual look &middot; <span class="kbd">G</span> GPS &middot; <span class="kbd">V</span> voice &middot; <span class="kbd">M</span> big map &middot; <span class="kbd">R</span> back on route &middot; <span class="kbd">P</span> frame rate &middot; <span class="kbd">Esc</span> pause</p>`;
}
function toast(html, cls) { const t = document.createElement("div"); t.className = "toast " + (cls || ""); t.innerHTML = html; document.getElementById("toasts").appendChild(t); setTimeout(() => t.remove(), 4600); }
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); fx.setSize(innerWidth, innerHeight); });

// expose for inline handlers and tests
Object.assign(window, { startMission, retry, nextMission, quitToMenu, renderMenu, togglePause, respawn, onKey, startFree, setOpt, liveGo, startPreview });
// used by build/bake_shanghai_routes.js to bake missions with the same code the live router uses
window.__routeKit = { buildVariant, valhalla };
Object.defineProperties(window, {
  menuRoute: { get: () => menuRoute, set: v => { menuRoute = v; }, configurable: true },
  menuVariant: { get: () => menuVariant, set: v => { menuVariant = v; }, configurable: true },
  M: { get: () => M, configurable: true },
});
const __fr = new THREE.Frustum();
function __inFrustum(m, o) { __fr.setFromProjectionMatrix(m); if (o.isInstancedMesh || !o.geometry) return true; if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere(); const sp = o.geometry.boundingSphere.clone().applyMatrix4(o.matrixWorld); return __fr.intersectsSphere(sp); }
window.GAME = { get snapState() { return { pendingSnap, pendingLane, waitWorld, idxJobs: idxJobs.length }; }, __Raycaster: THREE.Raycaster, __makeFrustum: __inFrustum, guides, get turnArrow() { return turnArrow; }, get gpsMesh() { return gpsMesh; }, viewLandmark, S, IDX, tiles, traffic, peds, props, signals, signLayer, nav, atmo, fx, renderer, scene, camera, settings, car, landmarks, rebaseTo, AUTO, ground, gantries, setHour: h => atmo.setHour(h) };

await tiles.init();
// Draw every kind of mesh the city uses once while the loading screen is up. On Windows the
// browser draws through Direct3D, which compiles each shader again for every vertex layout
// the first time it is drawn (a second or more for the facade shader): done here, that cost
// is paid behind the loading card instead of as a freeze on the first drive into town.
let warmGroup = null, warmFrames = 0;
function warmShaders() {
  const g = new THREE.Group();
  const geo = attrs => { const q = new THREE.BufferGeometry(); for (const [name, size] of attrs) q.setAttribute(name, new THREE.BufferAttribute(new Float32Array(3 * size), size)); q.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1)); return q; };
  const P = [["position", 3], ["normal", 3]];
  const kinds = [[tiles.mats.b, [...P, ["uv", 2], ["color", 3], ["facade", 4]]], [tiles.mats.r, [...P, ["uv", 2], ["road", 4], ["junc", 4]]], [tiles.mats.w, [...P, ["uv", 2], ["color", 3]]], [tiles.mats.a, [...P, ["color", 3]]], [tiles.mats.wa, [...P, ["color", 3]]], [tiles.farMat, [...P, ["color", 3]]]];
  for (const [mat, attrs] of kinds) { const m = new THREE.Mesh(geo(attrs), mat); m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; g.add(m); }
  scene.traverse(o => {
    if (!o.isInstancedMesh || o.parent === g) return;
    const d = new THREE.InstancedMesh(o.geometry, o.material, 1); d.castShadow = o.castShadow; d.receiveShadow = o.receiveShadow; d.frustumCulled = false;
    if (o.instanceColor) d.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3).fill(1), 3);
    d.setMatrixAt(0, new THREE.Matrix4().makeScale(0.001, 0.001, 0.001));
    g.add(d);
  });
  if (window.__warmSign) g.add(window.__warmSign);
  g.scale.setScalar(0.001);
  warmGroup = g; warmFrames = 3; scene.add(g);
}
function warmStep() {
  if (!warmGroup) return;
  camera.getWorldDirection(_v); warmGroup.position.copy(camera.position).addScaledVector(_v, 2);
  if (--warmFrames <= 0) { scene.remove(warmGroup); warmGroup.traverse(o => { if (o.isInstancedMesh) o.dispose(); }); warmGroup = null; }
}
// compile for the target the scene is really drawn into: the post-processing buffer (no tone
// mapping, linear output), not the screen, or the program keys do not match the frame's
function compileLikeFrame(obj) {
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(fx.composer.readBuffer);
  try { return renderer.compileAsync(obj, camera, scene); } finally { renderer.setRenderTarget(prev); }
}
// Shaders that first appear mid-drive (guide signs) are compiled up front and kept alive.
if (SG && SG.makeGuideSign && renderer.compileAsync) { try { const warm = SG.makeGuideSign({ lines: ["Dubai"], exit: "1", arrow: "exitright", ref: "E11" }); const wg = new THREE.Group(); wg.add(warm); wg.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), GANTRY_STEEL)); wg.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); window.__warmSign = wg; } catch (e) { console.warn("warm", e); } }
warmShaders();
rebaseTo(ATTRACT[0].lat, ATTRACT[0].lon);
S.lat = ATTRACT[0].lat; S.lon = ATTRACT[0].lon;
window.ready = true;
requestAnimationFrame(frame);
