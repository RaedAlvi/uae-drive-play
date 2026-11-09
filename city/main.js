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
// Pakistan: real elevation (city/terrain.js, data/dem_pk) and hand-built landmarks if they exist
let LMPK = null, TRN = null;
if (CITY.region === "pakistan") {
  try { const m = await import("./terrain.js"); TRN = new m.Terrain(new URL("../data/dem_pk/", import.meta.url).href); await TRN.init(); } catch (e) { console.warn("terrain not loaded", e && e.message); TRN = null; }
  try { LMPK = await import("./landmarks_pk/index.js"); } catch (e) { console.warn("landmarks_pk not loaded", e && e.message); }
}
const PK = CITY.region === "pakistan";
const M2D = PK ? await import("./m2data.js") : null;
const KEEP = PK ? -1 : 1;                                // Pakistan drives on the left: lane offsets mirror
if (PK) document.documentElement.classList.add("pk");    // responsive.css scopes the Pakistan phone layout with this

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
if (PK) { settings.pkCar = settings.pkCar || "saloon"; settings.pkColor = settings.pkColor ?? 0xf3f2ec; }
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
const PHONE_PK = PK && (matchMedia("(pointer: coarse)").matches || "ontouchstart" in window);
if (PHONE_PK && settings.quality === "normal") Q.pr = Math.max(Q.pr, Math.min(1.5, devicePixelRatio || 1));    // CSS pixels alone look soft on a phone; the adaptive step below still lowers it
const PR_MIN = PHONE_PK ? 0.85 : 0.6;
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
ground.visible = !TRN;              // Pakistan draws real ground in the tiles and the distance rings instead
scene.add(ground);

// ================================================================== world
const IDX = new Index(D);
const trafficTypes = VEH && VEH.makeTrafficTypes ? VEH.makeTrafficTypes() : fallbackTypes();
const trafficMats = VEH && VEH.makeTrafficMaterials ? VEH.makeTrafficMaterials() : fallbackMaterials();
const traffic = new Traffic(scene, trafficTypes, trafficMats);
traffic.target = settings.traffic === "off" ? 0 : settings.traffic === "heavy" ? Q.traffic * 1.6 : Q.traffic;
const props = new Props(scene);
const peds = new Peds(scene, traffic);
// Pakistan: world height of the drawn ground at a point (NaN until its tile is built), and the fallback from the raw elevation
function groundY(lat, lon) { let h = tiles.groundAt(lat, lon); if (h !== h && TRN) h = TRN.groundLL(lat, lon); return h === h ? h : 0; }
function roadGrade(lat, lon) { const h = TRN ? TRN.roadLL(lat, lon) : 0; return h === h ? h : 0; }
if (TRN) {
  props.groundAt = (key, lx, lz) => { const h = tiles.groundLocal(tiles.tiles.get(key), lx, lz); return h === h ? h : 0; };
  peds.groundAt = (wx, wz) => { const [la, lo] = toLatLon(wx, wz); return groundY(la, lo) + 0.28; };
}
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
// Pakistan: the worker numbers a speed sign from the road class where a road has no tagged limit. A sign stands only beside a road that carries that limit in OpenStreetMap (a zero is skipped by signs.js).
function pkTaggedSigns(t) {
  const v = t.signs && t.signs.speed, rs = t.coll && t.coll.r; if (!v || !v.length || !rs) return;
  const tagged = rs.filter(r => r.m > 0), P = 0.0006;
  for (let i = 0; i + 4 < v.length; i += 5) {
    const [la, lo] = toLatLon(v[i] + t.off.x, v[i + 1] + t.off.z), kmh = Math.round(v[i + 4]);
    let ok = false;
    for (const r of tagged) {
      if (r.m !== kmh) continue;
      const g = r.g, reach = (r.w || 16) / 2 + 8;
      for (let j = 0; j + 3 < g.length && !ok; j += 2) {
        if (lo < Math.min(g[j], g[j + 2]) - P || lo > Math.max(g[j], g[j + 2]) + P || la < Math.min(g[j + 1], g[j + 3]) - P || la > Math.max(g[j + 1], g[j + 3]) + P) continue;
        ok = segDist([la, lo], [g[j + 1], g[j]], [g[j + 3], g[j + 2]])[0] < reach;
      }
      if (ok) break;
    }
    if (!ok) v[i + 4] = 0;
  }
}
// Global frame for traffic: fixed at load, independent of the floating origin.
const G0 = { mx: origin.mx, my: origin.my };
function globalShift() { return { x: (origin.mx - G0.mx) * K, z: -(origin.my - G0.my) * K }; }
const tiles = new Tiles(scene, {
  radius: Q.radius,
  onReady: t => {
    if (PK) pkTaggedSigns(t);
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
const ALL_LANDMARKS = [...(LM && LM.LANDMARKS ? LM.LANDMARKS : []), ...(LM2 && LM2.LANDMARKS2 ? LM2.LANDMARKS2.map(L => ({ ...L, dispose: LM2.disposeLandmark })) : []), ...(LMSH ? LMSH.LANDMARKS_SH.map(L => ({ ...L, dispose: LM2.disposeLandmark })) : []), ...(LMPK ? (LMPK.LANDMARKS_PK || LMPK.LANDMARKS || LMPK.default || []).map(L => ({ ...L, dispose: L.dispose || LM2.disposeLandmark })) : [])];
{
  for (const L of ALL_LANDMARKS) {
    if (L.suppress && L.suppress.length > 2) {
      let a = 90, b = 180, c = -90, d = -180; const ringLL = [];
      for (const [la, lo] of L.suppress) { if (la < a) a = la; if (la > c) c = la; if (lo < b) b = lo; if (lo > d) d = lo; ringLL.push([lo, la]); }
      tiles.suppress.push(TRN ? { bbox: [a, b, c, d], ring: ringLL, lat: L.lat, lon: L.lon, baseOffset: L.baseOffset || 0, padRing: L.padRing ? L.padRing.map(([la, lo]) => [lo, la]) : null } : { bbox: [a, b, c, d], ring: ringLL });
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
const saloon = () => PK && settings.pkCar !== "supercar";
const newPlayerCar = () => saloon() ? VEH.makePlayerCar({ color: settings.pkColor, style: "sedan", beams: false }) : VEH.makePlayerCar({ color: settings.color, beams: false });
function swapPlayerCar() {
  if (!VEH || !VEH.makePlayerCar) return;
  scene.remove(car.group); if (car.dispose) car.dispose();
  car = newPlayerCar();
  car.group.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(car.group);
}
if (VEH && VEH.makePlayerCar) car = newPlayerCar();
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
  transparent: true, depthWrite: false, fog: true, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -16, defines: PK ? { PK_TURN: 1 } : {},
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uCol: { value: GPS_BLUE.clone() }, uProg: { value: -1e9 }, uAlphaMul: { value: 1 }, uTurn: { value: new THREE.Vector2(-1e9, -1e9) } }]),
  vertexShader: /* glsl */`#include <common>
#include <fog_pars_vertex>
varying vec2 vUv; void main() { vUv = uv; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
#include <fog_vertex>
}`,
  fragmentShader: /* glsl */`#include <common>
#include <fog_pars_fragment>
uniform float uTime; uniform vec3 uCol; uniform float uProg; uniform float uAlphaMul; varying vec2 vUv;
#ifdef PK_TURN
uniform vec2 uTurn;
float turnZone(float at) { float d = vUv.y - at; return smoothstep(-44.0, -26.0, d) * (1.0 - smoothstep(16.0, 32.0, d)); }
#endif
void main() {
  float ahead = vUv.y - uProg;                       // metres ahead of the car along the route
  if (ahead < -3.0) discard;
  float across = abs(vUv.x - 0.5) * 2.0;
#ifdef PK_TURN
  float tz = max(turnZone(uTurn.x), turnZone(uTurn.y));     // through a turn: half the width and 40 percent opacity, so the junction stays visible
  across *= 1.0 + tz;
#endif
  float edge = smoothstep(1.0, 0.88, across);
  float border = smoothstep(0.6, 0.78, across);
  float chev = fract(vUv.y / 10.0 - uTime * 0.45 + across * 0.32);
  float c = smoothstep(0.0, 0.05, chev) * smoothstep(0.26, 0.19, chev) * (1.0 - border);
#ifdef PK_TURN
  c *= 1.0 - tz;                                             // no white chevrons through a turn: on the narrowed line they read as a white strip
#endif
  vec3 col = mix(uCol, uCol * 0.45, border);
  col = mix(col, vec3(1.0), c * 0.7);
  float a = mix(0.5, 0.72, border) + 0.2 * c;
  a *= edge * smoothstep(-3.0, 8.0, ahead);
#ifdef PK_TURN
  a *= mix(1.0, 0.4, tz);
#endif
  gl_FragColor = vec4(col, a * uAlphaMul * mix(0.35, 1.0, smoothstep(4.0, 30.0, ahead)));
#include <fog_fragment>
}`,
});
let gpsMesh = null, altMesh = null;
function ribbonMesh(geom, width, mat, y, cum) {
  if (!geom || geom.length < 2) return null;
  if (TRN) {
    // route points can be a kilometre apart: add enough vertices for the line to follow the hills
    const g2 = [geom[0]], c2 = cum ? [cum[0]] : null;
    for (let i = 1; i < geom.length; i++) { const L = hav(geom[i - 1], geom[i]), n = Math.max(1, Math.ceil(L / 30)); for (let k = 1; k <= n; k++) { g2.push([geom[i - 1][0] + (geom[i][0] - geom[i - 1][0]) * k / n, geom[i - 1][1] + (geom[i][1] - geom[i - 1][1]) * k / n]); if (c2) c2.push(cum[i - 1] + (cum[i] - cum[i - 1]) * k / n); } }
    geom = g2; if (cum) cum = c2;
    TRN.ensureLL(geom[0][0], geom[0][1]).then(() => { ribbonDirty = true; });
  }
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
  return best ? { s: best, e: best.ea + (best.eb - best.ea) * bt, h: best.ha + (best.hb - best.ha) * bt } : null;
}
function elevAligned(lat, lon, brg) { const r = alignedRoad(lat, lon, brg); return r ? r.e : null; }
// On a two-way road the route runs down the middle; drivers keep right, so the line and the
// turn arrows move into the right-hand half (a quarter of the road width off the centre).
function rightShift(r) {
  if (PK && r && r.s.ow && r.s.w) { const n = Math.max(1, r.s.ln || 2); return n % 2 === 0 ? -r.s.w / n / 2 : 0; }   // a one-way carriageway: the left-hand lane of an even count, where the car drives
  return r && !r.s.ow && r.s.w ? r.s.w * 0.25 * KEEP : 0;
}
function liftRibbon(m) {
  if (!m || !IDX.ready) return;
  const geom = m.userData.geom, pos = m.geometry.attributes.position, y0 = m.userData.y, pts = m.userData.pts, nrm = m.userData.nrm, hw = m.userData.w / 2;
  let sh = 0;
  for (let i = 0; i < geom.length; i++) {
    const o = geom[Math.max(0, i - 1)], q = geom[Math.min(geom.length - 1, i + 1)];
    const r = alignedRoad(geom[i][0], geom[i][1], bearing(o, q));
    if (r) sh += (rightShift(r) - sh) * (i ? 0.5 : 1);
    const [lx, lz] = nrm[i], p = pts[i];
    const cx = p[0] - lx * sh, cz = p[1] - lz * sh, y = y0 + (r ? r.e : 0) + (TRN ? (r ? r.h : roadGrade(geom[i][0], geom[i][1])) : 0);
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
  transparent: true, depthWrite: false, fog: true, polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -20, defines: PK ? { PK_ARROW: 1 } : {},
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uAlpha: { value: 1 }, uHead: { value: 0 } }]),
  vertexShader: /* glsl */`#include <common>
#include <fog_pars_vertex>
varying vec2 vUv; void main() { vUv = uv; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
#include <fog_vertex>
}`,
  fragmentShader: /* glsl */`#include <common>
#include <fog_pars_fragment>
uniform float uTime; uniform float uAlpha; uniform float uHead; varying vec2 vUv;
void main() {
  float across = abs(vUv.x - 0.5) * 2.0;
  float border = smoothstep(0.62, 0.74, across);
  float sweep = smoothstep(0.0, 0.25, fract(vUv.y * 0.05 - uTime * 0.8)) * 0.25;
  vec3 col = mix(vec3(1.0) - sweep * 0.2, vec3(0.1, 0.36, 0.95), border);
  float al = 1.0;
#ifdef PK_ARROW
  al = smoothstep(uHead - 0.25, uHead + 0.05, vUv.y);                  // arrowhead only: the blue line is the shaft, and a pale one on top read as a painted strip down the lane
#endif
  gl_FragColor = vec4(col, al * uAlpha * smoothstep(1.0, 0.94, across) * smoothstep(0.0, 6.0, vUv.y));
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
  grp.position.y = (r.e || 0) + (r.h || 0);
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
  const s0 = Math.max(0, at - (PK ? 24 : 32)), s1 = Math.min(total, at + (PK ? 16 : 18)); if (s1 - s0 < 12) return;
  const [la0, lo0] = pointAt(g, cum, at); const base = toWorld(la0, lo0);
  const P = [];
  for (let s = s0; s <= s1 + 0.01; s += 1.5) { const [la, lo] = pointAt(g, cum, s); const v = toWorld(la, lo); P.push({ x: v.x - base.x, z: v.z - base.z, la, lo }); }
  // smooth the polyline a little so the turn reads as one sweep
  for (let it = 0; it < 3; it++) for (let i = 1; i < P.length - 1; i++) { P[i].x = (P[i - 1].x + 2 * P[i].x + P[i + 1].x) / 4; P[i].z = (P[i - 1].z + 2 * P[i].z + P[i + 1].z) / 4; }
  const W = PK ? 0.3 : 1.7, HW = PK ? 1.0 : 4.2, HL = PK ? 3.6 : 6, n = P.length, pos = [], uv = [], idx = [];   // Pakistan: one thin curved arrow, not a painted slab
  const headStart = Math.max(2, n - 1 - Math.round(HL / 1.5));
  let sh = 0, acc = 0;
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const lx = dz, lz = -dx;
    const r = IDX.ready ? alignedRoad(P[i].la, P[i].lo, (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360) : null;
    sh += (rightShift(r) - sh) * (i ? 0.3 : 1);
    const y = (r ? r.e : 0) + 0.2 + (TRN ? (r ? r.h : roadGrade(P[i].la, P[i].lo)) : 0);
    if (i) acc += Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z);
    const cx = P[i].x - lx * sh, cz = P[i].z - lz * sh;
    if (PK && i === headStart) arrowMat.uniforms.uHead.value = acc;
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
// Pakistan's tags: at most three on screen (one on a phone), the destination first, then whatever is nearest the
// road ahead. A tag hides when a building or hill stands between it and the camera, and shrinks and fades with distance.
const PK_PHONE_MQ = matchMedia("(max-height: 500px), (max-width: 760px)");
const pkOcc = new Map();
let pkShown = new Set();
// Walks the sight line over the 2D building index. Heights are not in the index, so a building counts while the line is under 9 m above the ground.
function pkOccluded(key, x, y, z, now) {
  const c = pkOcc.get(key); if (c && now - c.t < 450) return c.v;
  const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z, dx = x - cx, dz = z - cz, D2 = Math.hypot(dx, dz), stop = D2 - 45;
  let v = false;
  for (let s = 8; s < stop && !v; s += 10) {
    const u = s / D2, [la, lo] = toLatLon(cx + dx * u, cz + dz * u), g = roadGrade(la, lo), yy = cy + (y - cy) * u;
    if (yy < g + 1) v = true;
    else if (yy - g < 9 && IDX.building(la, lo)) v = true;
  }
  pkOcc.set(key, { t: now, v }); if (pkOcc.size > 400) pkOcc.clear();
  return v;
}
function drawLabelsPK() {
  let n = 0;
  const W = innerWidth, H = innerHeight, now = performance.now(), lf = PV.on ? PV.w : carPos, fLL = PV.on ? PV.ll : [S.lat, S.lon];
  let room = PK_PHONE_MQ.matches ? 1 : 3;
  const seen = new Set(), shown = new Set();
  const topY = H > W * 1.15 && PK_PHONE_MQ.matches ? 262 : 0;        // portrait: keep the tag below the card, buttons and map
  const put = (sx, sy, html, cls, op, sc) => { const el = labelAt(n++, html, cls); el.style.left = sx.toFixed(0) + "px"; el.style.top = Math.max(sy, topY).toFixed(0) + "px"; el.style.opacity = op; el.style.transform = `translate(-50%, -100%) scale(${sc})`; };
  if (running && M && !M.free) {
    const dest = M.v.geom[M.v.geom.length - 1], d = hav(fLL, dest), name = pkFix(P[M.route.to] ? P[M.route.to].label : "Destination");
    toWorld(dest[0], dest[1], _v); _v.y = 40 + roadGrade(dest[0], dest[1]); seen.add(name.toLowerCase());
    if (ahead(_v)) { _v.project(camera); if (Math.abs(_v.x) <= 1.1 && Math.abs(_v.y) <= 1.1) { put((_v.x + 1) / 2 * W, (1 - _v.y) / 2 * H, esc(name) + `<small>${fmtM(d)}</small>`, "dest", 1, 1); room--; } }
  }
  const hoodOff = settings.cam === "hood" && settings.hoodLabels !== true && !PV.on;
  if (running && settings.labels !== false && S.y > -1.5 && room > 0 && !hoodOff) {
    const cand = [], fwd = camera.getWorldDirection(_cv.set(0, 0, 0)), fl = Math.hypot(fwd.x, fwd.z) || 1, fx = fwd.x / fl, fz = fwd.z / fl;
    const push = (name, tag, cls, x, y, z, d, weight) => {
      if (!name || name.length > 34) return;
      const ox = x - camera.position.x, oz = z - camera.position.z, along = ox * fx + oz * fz, lat = Math.abs(ox * fz - oz * fx);
      if (along < 4) return;
      const k = name.toLowerCase();
      cand.push({ name, tag, cls, x, y, z, d, k, score: (d + lat * 1.3) * weight * (pkShown.has(k) ? 0.8 : 1) });   // the bonus stops tags swapping back and forth
    };
    for (const p of D.places) { if (M && p.id === M.route.to) continue; const d = hav(fLL, [p.lat, p.lon]); if (d < 900) { const v = toWorld(p.lat, p.lon); push(pkFix(p.label), "", "poi", v.x, 18 + roadGrade(p.lat, p.lon), v.z, d, 1); } }
    for (const t of tiles.tiles.values()) {
      if (!t.labels || !t.off || t.state !== "ready") continue;
      for (const L of t.labels) { const x = L.x + t.off.x, z = L.z + t.off.z, d = Math.hypot(x - lf.x, z - lf.z); if (d < 700) push(pkFix(L.en || D.names[L.ar] || ""), POI_TAG[L.k] || "", "poi k-" + L.k, x, L.y, z, d, 1); }
    }
    for (const L of landmarks) {
      if (!L.group) continue;
      const x = L.group.position.x, z = L.group.position.z, d = Math.hypot(x - lf.x, z - lf.z);
      if (d < 1500) push(L.def.name, "", "poi k-landmark", x, Math.min((L.def.height || 60) * 0.55, 140) + L.group.position.y, z, d, 0.5);
    }
    cand.sort((a, b) => a.score - b.score);
    const used = []; let tested = 0;
    for (const c of cand) {
      if (room <= 0 || tested >= 12) break;
      if (seen.has(c.k)) continue; seen.add(c.k);
      _v.set(c.x, c.y, c.z);
      if (!ahead(_v)) continue; _v.project(camera);
      if (Math.abs(_v.x) > 0.95 || _v.y > 0.95 || _v.y < -0.35) continue;
      const sx = (_v.x + 1) / 2 * W, sy = (1 - _v.y) / 2 * H;
      if (used.some(u => Math.abs(u[0] - sx) < 170 && Math.abs(u[1] - sy) < 40)) continue;
      tested++;
      if (pkOccluded(c.k, c.x, c.y, c.z, now)) continue;
      used.push([sx, sy]); room--; shown.add(c.k);
      const f = Math.min(1, c.d / 900);
      put(sx, sy, `<i>${c.tag}</i>${esc(c.name)}<small>${fmtM(c.d)}</small>`, c.cls, (1 - 0.45 * f).toFixed(2), (1 - 0.24 * f).toFixed(2));
    }
  }
  pkShown = shown;
  for (let i = n; i < labelPool.length; i++) labelPool[i].style.display = "none";
}
function drawLabels() {
  if (PK) return drawLabelsPK();
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
    toWorld(L.lat, L.lon, _v); _v.y = L.y + (TRN ? roadGrade(L.lat, L.lon) : 0);
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
      if (d < (PV.sky ? 3000 : 1500)) cand.push({ L: { en: L.def.name, k: "landmark", y: Math.min((L.def.height || 60) * 0.55, 140) + L.group.position.y }, x, z, d: d * 0.4 });
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
  if (TRN && S.pitch) v -= Math.sin(S.pitch) * 9.8 * 0.6 * dt;        // hills pull you back; a descent runs on
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
  if (PK) pkSenseLimit(t, r);
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
    if (PK) { S.name = pkFix(S.name); S.near = pkFix(S.near); S.toward = pkFix(S.toward); }
  }
}
// Pakistan: the dial shows the limit tagged on the way under the car (OpenStreetMap, data/roads). A way with no tag shows no limit, never a guess from the road class.
// A slip road, or an untagged piece of the same named road, keeps the limit of the road it came from, as a posted limit holds until the next sign.
const PKL = { tile: null, busy: false, t: 0, loadT: 0, cur: 0, v: 0, name: "", la: 0, lo: 0 };
const PK_RANK = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, minor: 5, unclassified: 5, residential: 5, living_street: 5, service: 6 };
const pkRank = c => PK_RANK[String(c || "").replace("_link", "")] ?? 5;
function pkSenseLimit(t, r) {
  if (!r) { S.limit = 0; PKL.cur = 0; return; }
  if (t - PKL.t < 240) { S.limit = PKL.cur; return; }
  PKL.t = t;
  if (!RDBM) { if (!PKL.busy) { PKL.busy = true; import("./roadsdb.js").then(mod => { RDBM = mod; PKL.busy = false; }, () => { PKL.busy = false; }); } S.limit = 0; return; }
  const tl = PKL.tile;
  if ((!tl || S.lat > tl.north || S.lat < tl.south || S.lon > tl.east || S.lon < tl.west) && !PKL.busy && t - PKL.loadT > 500) {
    PKL.busy = true; PKL.loadT = t;
    RDBM.roadsForLatLon(S.lat, S.lon).then(x => { PKL.tile = x; PKL.busy = false; }, () => { PKL.busy = false; });
  }
  let v = 0;
  const m = tl && tl.match(S.lat, S.lon, S.hdg);                                   // nothing within 12 m and 35 degrees: this way has no record
  if (m && Math.abs(pkRank(m.hw) - pkRank(S.cls)) <= 1) v = RDBM.resolveLanes(m, m.dir).maxspeed || 0;      // a service lane does not take the limit of the motorway beside it
  if (v > 130) v = 0;                                                               // Pakistan's highest limit is 120: anything above it is a mistyped tag
  if (v) { PKL.v = v; PKL.name = S.name; PKL.la = S.lat; PKL.lo = S.lon; PKL.cur = v; }
  else PKL.cur = PKL.v && (/_link$/.test(S.cls) || (S.name && S.name === PKL.name)) && hav([S.lat, S.lon], [PKL.la, PKL.lo]) < 900 ? PKL.v : 0;
  S.limit = PKL.cur;
}
// Pakistan: OpenStreetMap's spellings where the research files use another (research/rawalpindi.json) or the printed name differs:
// Liaquat Road (en.wikipedia.org/wiki/Raja_Bazaar), Cart Road in Murree (street addresses on booking.com and hotels.com), M-2 (art_direction.md S15)
const PK_SPELL = [[/\bFowara\b/g, "Fawara"], [/\bBazar\b/g, "Bazaar"], [/\bLiaqat\b/g, "Liaquat"], [/\bCuart\b/g, "Cart"], [/\bM2\b/g, "M-2"]];
function pkFix(s) { if (!PK || !s) return s; for (const [a, b] of PK_SPELL) s = s.replace(a, b); return s; }
function flash() { const f = document.getElementById("flash"); f.style.opacity = 1; setTimeout(() => f.style.opacity = 0, 120); }

// ================================================================== missions (ported)
function startMission(route, variantKey, opts) {
  const v = route[variantKey] || route.fast;
  M = { route, variant: variantKey, v, cum: cumulative(v.geom), ri: 0, progress: 0, offRoute: false, offSince: 0, lastFull: 0, reroutes: 0, rerouting: false, lastReroute: -1e9, passed: new Set(), cost: 0, gatesHit: [], dist: 0, offroadT: 0, t0: 0, started: false, free: !!(opts && opts.free), announced: {}, done: false };
  const g = v.geom;
  S.lat = g[0][0]; S.lon = g[0][1]; S.hdg = bearing(g[0], g[Math.min(3, g.length - 1)]); S.v = 0; S.steer = 0; S.y = 0; S.yT = 0; S.hv = NaN;
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
  PV.ask = false; if (PV.on) { PV.on = false; } pvRender();
  if (!M.free && settings.preview !== false && !(opts && opts.noPreview) && !navigator.webdriver) askPreview();      // automated tests call startPreview() themselves
  toast(M.free ? `Free roam from ${esc(P[route.from].label)}. Drive anywhere.` : `<b>${esc(route.title)}</b><small>Get to ${esc(P[route.to].label)}. ${settings.gps ? "Follow the directions and the blue line." : "GPS is off: find your own way."}</small>`, "good");
  if (!M.free && settings.gps && nav.voice) setTimeout(() => { if (M && !M.free && M.route === route) nav.say(`Starting route to ${M.destName}. ${Math.round(M.v.km * 10) / 10} kilometres.`); }, 600);
}
// Turn-by-turn for the current route (baked lane guidance where OpenStreetMap has turn lanes).
const nav = new Nav(); nav.voice = settings.voice !== false;
if (PK) { nav.pk = true; nav.fix = pkFix; nav.m2 = { nodes: M2D.M2_NODES }; }
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
  const [la, lo] = move(S.lat, S.lon, S.hdg + 90 * KEEP, off);
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
    ${PK && M.route.to === "mall_road" ? `<div class="note">You are on The Mall. OpenStreetMap maps an 85 m pedestrian section right beside this road, so this is where you leave the car and walk.</div>` : ""}<p class="sub">Off road for ${Math.round(M.offroadT)} s. Gates: ${M.gatesHit.length ? M.gatesHit.map(esc).join(", ") : "none"}.</p>
    <h2>Roads on the route</h2><p class="sub" style="color:var(--ink)">${esc(oneBreath(M.v))}</p>
    <div class="row2"><button class="btn primary" onclick="retry()">Drive again</button>${M.route.notoll && M.variant === "fast" ? `<button class="btn" onclick="startMission(M.route,'notoll')">Try without Salik</button>` : ""}<button class="btn" onclick="nextMission()">Next route</button><button class="btn" onclick="quitToMenu()">Menu</button></div>`;
  document.getElementById("debrief").hidden = false;
  toast(`<b>Arrived</b><small>${fmtT(secs)}</small>`, "good");
}
function retry() { document.getElementById("debrief").hidden = true; startMission(M.route, M.variant); }
function nextMission() { document.getElementById("debrief").hidden = true; const i = D.routes.findIndex(r => r.id === M.route.id); const n = D.routes[(i + 1) % D.routes.length]; startMission(n, "fast"); }
function quitToMenu() { if (PV.on) endPreview(); PV.ask = false; pvRender(); document.getElementById("debrief").hidden = true; document.getElementById("pause").hidden = true; running = false; M = null; document.getElementById("hud").hidden = true; setGps([], null); nav.hide(); beam.visible = false; renderMenu("missions"); }
function oneBreath(v) { const roads = v.roads.filter(r => r.km >= 0.8).map(r => r.en + (r.ref ? " (" + r.ref + ")" : "")); const u = roads.filter((x, i) => roads.indexOf(x) === i); return u.length ? u.join(", then ") + "." : "Local streets only."; }

// ================================================================== floating origin
function rebaseTo(lat, lon) {
  tiles.rebase(lat, lon);
  reanchor();
  for (const L of landmarks) if (L.group) { const v = toWorld(L.def.lat, L.def.lon); L.group.position.set(v.x, L.group.position.y, v.z); }
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
// When a mission starts the car waits at A with a card: "Preview route" or "Drive", so you first see
// where you are. The preview (default "drive"): your car drives the whole route on fast-forward, seen
// from a raised chase camera you can swing round by dragging (or Q / E); speed from a quarter to four
// times with the - + buttons or keys. "sky" (setting): a fly-over from a few hundred metres up.
// Skip, Esc or Enter ends it and puts you back at the start; O plays it again.
const PV_SPEEDS = [0.25, 0.5, 1, 2, 4];
const PV = window.__PV = { on: false, ask: false, sky: false, mult: PV_SPEEDS.includes(settings.pvSpeed) ? settings.pvSpeed : 1, ll: [0, 0], w: new THREE.Vector3(), t: 0, T: 10, ui: null, look: new THREE.Vector3(), pos: new THREE.Vector3() };
function routePoint(s, out) {
  const g = M.v.geom, c = M.cum; s = Math.max(0, Math.min(c[c.length - 1], s));
  let lo = 0, hi = c.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
  const f = (s - c[lo]) / Math.max(1e-6, c[hi] - c[lo]);
  out[0] = g[lo][0] + (g[hi][0] - g[lo][0]) * f; out[1] = g[lo][1] + (g[hi][1] - g[lo][1]) * f; return out;
}
const fmtMult = m => (m === 0.25 ? "&frac14;" : m === 0.5 ? "&frac12;" : m) + "&times;";
function pvRender() {
  if (!PV.ui) { PV.ui = document.createElement("div"); PV.ui.id = "pvui"; document.body.appendChild(PV.ui); PV.ui.addEventListener("pointerdown", e => e.stopPropagation()); }
  const el = PV.ui;
  document.documentElement.classList.toggle("pv", PV.on);
  if (!M || (!PV.on && !PV.ask)) { el.hidden = true; return; }
  el.hidden = false;
  const km = (M.cum[M.cum.length - 1] / 1000).toFixed(1), from = P[M.route.from] ? P[M.route.from].label : "the start";
  const speeds = `<div class="pvsp" title="Preview speed"><button onclick="pvSpeed(-1)" aria-label="Slower">&minus;</button><b><span id="pvmult">${fmtMult(PV.mult)}</span><small>speed</small></b><button onclick="pvSpeed(1)" aria-label="Faster">+</button></div>`;
  if (PV.on && PV.arrived) el.innerHTML = `<div class="pvt">Preview finished at <b>${esc(M.destName)}</b><span class="pvh">drag to look around</span></div><div class="pvrow"><button class="btn primary" onclick="endPreview()">&#9654; Start drive</button><button class="btn" onclick="startPreview()">Watch again</button></div>`;
  else if (PV.on) el.innerHTML = `<div class="pvt">Route preview${PV.sky ? " from the sky" : ""} &middot; <span id="pvpct">0</span>%<span class="pvh">drag to look around</span></div><div class="pvrow">${speeds}<button class="btn" onclick="endPreview()">Skip</button></div>`;
  else el.innerHTML = `<div class="pvt">You are at <b>${esc(from)}</b><br>Going to <b>${esc(M.destName)}</b>, ${km} km</div><div class="pvrow"><button class="btn primary" onclick="startPreview()">&#9654; Preview route</button>${PV.sky ? "" : speeds}<button class="btn" onclick="pvDismiss()">Drive</button></div>`;
}
function pvSpeed(d) {
  const i = Math.max(0, Math.min(PV_SPEEDS.length - 1, PV_SPEEDS.indexOf(PV.mult) + d));
  PV.mult = PV_SPEEDS[i]; settings.pvSpeed = PV.mult; saveSettings();
  const el = document.getElementById("pvmult"); if (el) el.innerHTML = fmtMult(PV.mult);
}
function askPreview() { if (!M || M.free) return; PV.ask = true; pvRender(); }
function pvDismiss() { PV.ask = false; pvRender(); }
function startPreview(mode) {
  if (!M || M.free || !M.cum || M.cum.length < 2) return;
  if (PV.on) endPreview();
  const total = M.cum[M.cum.length - 1], km = total / 1000;
  mode = mode || (settings.preview === "sky" ? "sky" : "drive");
  Object.assign(PV, { on: true, ask: false, sky: mode === "sky", t: 0, s: 0, T: Math.min(16, Math.max(7, 5 + km * 0.8)), total, alt: Math.min(460, Math.max(170, 130 + km * 22)), back: Math.min(520, Math.max(220, 160 + km * 25)),
    V: Math.min(320, Math.max(40, total / 20)), vs: 0, dir: null, t0: 0, readyT: 1, cy: carPos.y, nameT: 0 });
  PV.ll = [S.lat, S.lon]; toWorld(S.lat, S.lon, PV.w);
  PV.pos.copy(camera.position); PV.look.copy(carPos);
  LOOK.yaw = 0; LOOK.pitch = 0; LOOK.zoom = 1;
  S.v = 0; pvRender();
}
function endPreview() {
  if (!PV.on) return;
  PV.on = false; PV.arrived = false; pvRender();
  LOOK.yaw = 0; LOOK.pitch = 0; LOOK.zoom = 1;
  if (!PV.sky && M && M.v) {                                         // back to the start of the route
    const g = M.v.geom; S.lat = g[0][0]; S.lon = g[0][1]; S.hdg = bearing(g[0], g[Math.min(3, g.length - 1)]); S.v = 0; S.y = 0; S.yT = 0;
    M.progress = 0; M.ri = 0; rebaseTo(S.lat, S.lon); toWorld(S.lat, S.lon, carPos); camInit = true;
  } else { camPos.copy(camera.position); camInit = false; }          // the chase camera swoops down from where the sky preview left it
  waitWorld = performance.now(); lastT = performance.now();         // hold the car until the ground under it is back
}
const _pa = [0, 0], _pb = [0, 0], _pc = [0, 0];
function previewStep(dt) {
  if (loadingEl && !loadingEl.hidden) loadingEl.hidden = true;      // the loading card belongs to the drive, not the preview
  if (!PV.sky) {
    // fast-forward along the route at a steady speed; slow down (gently, with hysteresis) while the city
    // ahead is still loading, and ease in at the destination
    routePoint(PV.s + 300, _pc);
    const ready = worldReadyAt(S.lat, S.lon) && worldReadyAt(_pc[0], _pc[1]);
    PV.readyT = ready ? PV.readyT + dt : 0;
    const left = PV.total - PV.s, vt = Math.min((PV.readyT > 0.8 ? 1 : 0.35) * PV.V * PV.mult, 10 + left * 0.9);
    PV.vs += (vt - PV.vs) * Math.min(1, dt * 0.9);
    PV.s = Math.min(PV.total, PV.s + dt * PV.vs);
    routePoint(PV.s, _pa); routePoint(PV.s + 35, _pb);
    S.lat = _pa[0]; S.lon = _pa[1]; S.v = 0;
    if (IDX.ready) { const r = alignedRoad(S.lat, S.lon, bearing(_pa, _pb)); if (r) { S.y = S.yT = r.e || 0; S.hT = r.h; } else if (TRN) S.hT = roadGrade(S.lat, S.lon); }      // ride the route's own deck (the camera height is smoothed separately)
    if (PV.s + 1 < PV.total) { let d = bearing(_pa, _pb) - S.hdg; while (d > 180) d -= 360; while (d < -180) d += 360; S.hdg = (S.hdg + d * Math.min(1, dt * 4) + 360) % 360; }
    M.progress = PV.s; PV.ll = [S.lat, S.lon]; toWorld(S.lat, S.lon, PV.w);
    if ((PV.nameT += dt) > 0.3) { PV.nameT = 0; try { senseRoad(performance.now()); } catch (_) {} S.v = 0; }      // keep the street card current
    const pc = document.getElementById("pvpct"); if (pc) pc.textContent = Math.round(100 * PV.s / PV.total);
    if (PV.s >= PV.total && !PV.arrived) { PV.arrived = true; pvRender(); }       // stay at the destination until the player presses Start drive
    return;
  }
  PV.t += dt * PV.mult; const u = Math.min(1, PV.t / PV.T);
  const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;          // ease in and out
  const s = PV.total * e;
  routePoint(s, _pa); PV.ll = [_pa[0], _pa[1]]; toWorld(_pa[0], _pa[1], PV.w);
  const pc = document.getElementById("pvpct"); if (pc) pc.textContent = Math.round(100 * u);
  if (u >= 1 && !PV.arrived) { PV.arrived = true; pvRender(); }
}
function previewChase(dt) {
  if (camera.view && camera.view.enabled) { camera.clearViewOffset(); camera.updateProjectionMatrix(); }
  lookDecay(dt);
  // the camera is tied to the car (fixed distance, so the car never shrinks away at speed); its direction
  // follows the route 150 m behind to 150 m ahead, smoothed (faster at higher speed so it keeps up)
  routePoint(PV.s - 150, _pb); routePoint(PV.s + 150, _pc);
  const b = toWorld(_pb[0], _pb[1]), a = toWorld(_pc[0], _pc[1]);
  let dx = a.x - b.x, dz = a.z - b.z; const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
  if (!PV.dir) PV.dir = new THREE.Vector2(dx, dz);
  const kd = Math.min(1, dt * (1.1 + PV.vs / 160));
  PV.dir.x += (dx - PV.dir.x) * kd; PV.dir.y += (dz - PV.dir.y) * kd; PV.dir.normalize();
  // your drag swings the camera round the car (yaw) and tilts it (pitch: up to look at the towers)
  const c = Math.cos(LOOK.yaw), sn = Math.sin(LOOK.yaw);
  const ux = PV.dir.x * c - PV.dir.y * sn, uz = PV.dir.x * sn + PV.dir.y * c;
  PV.cy += (carPos.y - PV.cy) * Math.min(1, dt * 3);                     // the camera's height eases over ramps
  const z = LOOK.zoom, BACK = 44 * z, UP = Math.max(3, 25 * z * (1 - 0.7 * LOOK.pitch));
  const wantPos = new THREE.Vector3(carPos.x - ux * BACK, PV.cy + UP, carPos.z - uz * BACK);
  const wantLook = new THREE.Vector3(carPos.x + ux * 28, PV.cy + 1 + Math.max(0, LOOK.pitch) * 60, carPos.z + uz * 28);      // the car sits just below the middle, clear of the street card
  if (TRN) { const [pa, po] = toLatLon(wantPos.x, wantPos.z), gp = groundY(pa, po); wantPos.y = Math.max(wantPos.y, gp + 6); }
  const ramp = Math.min(1, PV.t0 += dt), k = ramp < 1 ? Math.min(1, dt * 3) : Math.min(1, dt * 12);
  PV.pos.lerp(wantPos, k); PV.look.lerp(wantLook, k);
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
// the saloon's bonnet is long: sit further forward and higher so it is a sliver at the bottom, not half the screen
const HOOD_SALOON = { back: -1.1, up: 1.42, look: 1.25, ahead: 30, fov: 68 };
function updateCamera(dt) {
  const portrait = PK && innerHeight > innerWidth * 1.15;
  if (portrait) {                                                  // the controls sit over the bottom of a tall screen, so lift the view above them
    const pH = innerHeight, pW = innerWidth, oy = Math.round(pH * 0.12), vw = camera.view;
    if (!vw || !vw.enabled || vw.offsetY !== oy || vw.fullWidth !== pW || vw.fullHeight !== pH) camera.setViewOffset(pW, pH, 0, oy, pW, pH);
  } else if (camera.view && camera.view.enabled) { camera.clearViewOffset(); camera.updateProjectionMatrix(); }   // the title screen shifts the view right of the menu
  const cfg = saloon() && settings.cam === "hood" ? HOOD_SALOON : CAMCFG[settings.cam] || CAMCFG.chase;
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
  if (TRN && settings.cam !== "top" && settings.cam !== "hood") { const [wa, wo] = toLatLon(want.x, want.z), gw = tiles.groundAt(wa, wo); if (gw === gw) want.y = Math.max(want.y, gw + 1.4); }
  if (camInit) { camPos.copy(want); camInit = false; } else camPos.lerp(want, settings.cam === "hood" ? 1 : Math.min(1, dt * 7));
  if (TRN && settings.cam !== "top" && settings.cam !== "hood") { const [wa, wo] = toLatLon(camPos.x, camPos.z), gc = tiles.groundAt(wa, wo); if (gc === gc && camPos.y < gc + 1.0) camPos.y = gc + 1.0; }
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
  const fov = cfg.fov + (portrait ? (settings.cam === "chase" || settings.cam === "far" || settings.cam === "hood" ? 24 : 12) : 0) + (settings.cam === "chase" || settings.cam === "hood" ? Math.min(14, speed * 0.2) : 0);   // portrait: wider, or a tall screen shows only a slot of the road
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
  const gA = TRN ? groundY(A.lat, A.lon) : 0;
  camera.position.set(c.x + Math.cos(ang) * A.r, A.h + gA, c.z + Math.sin(ang) * A.r);
  if (TRN) { const [ca, co] = toLatLon(camera.position.x, camera.position.z), gc = groundY(ca, co); camera.position.y = Math.max(camera.position.y, gc + 25); }
  camera.up.set(0, 1, 0);
  camera.lookAt(c.x, A.look + gA, c.z);
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
  if (running && IDX.ready && !PV.on) {                             // (the preview sets the height from the route's own deck)
    const r = IDX.roadAt(S.lat, S.lon, S.y); S.yT = r ? (r.eAt || 0) : 0;
    const hC = r ? r.hAt : 0;                                    // (roadAt writes eAt, hAt onto the shared segment: read them at once)
    // slope under the car: the deck 2.2 m ahead and behind gives the pitch, and the higher of the
    // centre and the mean keeps the body out of the ramp on a change of grade
    const f = move(S.lat, S.lon, S.hdg, 2.2), b = move(S.lat, S.lon, S.hdg + 180, 2.2);
    const rf = IDX.roadAt(f[0], f[1], S.y), hF = rf ? rf.hAt : 0, rb = IDX.roadAt(b[0], b[1], S.y), hB = rb ? rb.hAt : 0;
    let ef = rf && Math.abs((rf.eAt || 0) - S.yT) < 3 ? rf.eAt || 0 : S.yT, eb = rb && Math.abs((rb.eAt || 0) - S.yT) < 3 ? rb.eAt || 0 : S.yT;
    if (TRN) {
      // the land under the car: from the road's own grade on a road, from the drawn ground off it
      if (r) { S.hT = hC; if (rf) ef += hF - hC; if (rb) eb += hB - hC; }
      else { const g = tiles.groundAt(S.lat, S.lon); S.hT = g === g ? g : (S.hT || 0); const gf = tiles.groundAt(f[0], f[1]), gb = tiles.groundAt(b[0], b[1]); if (gf === gf && gb === gb) { ef = gf - S.hT; eb = gb - S.hT; } }
    }
    S.pitchT = Math.atan2(ef - eb, 4.4); S.yT = Math.max(S.yT, (ef + eb) / 2);
  }
  S.pitch = (S.pitch || 0) + ((S.pitchT || 0) - (S.pitch || 0)) * Math.min(1, dt * 8);
  S.y += (S.yT - S.y) * Math.min(1, dt * (PV.on ? 30 : S.yT < S.y - 2 ? 4 : 14));
  carPos.y = S.y;
  if (TRN) {
    // the land height eases only across the small step between road and open ground, and snaps on a teleport
    if (S.hT === undefined || S.hT !== S.hT) S.hT = roadGrade(S.lat, S.lon);
    if (S.hv !== S.hv || S.hv === undefined || Math.abs(S.hT - S.hv) > 12) S.hv = S.hT; else S.hv += (S.hT - S.hv) * Math.min(1, dt * 25);
    carPos.y = S.y + S.hv;
  }
  car.group.position.set(carPos.x, 0.07 + carPos.y, carPos.z);
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
  if (PK) peds.hour = atmo.hour;
  peds.update(dt, { x: running ? carPos.x : camera.position.x, z: running ? carPos.z : camera.position.z }, sh.x, sh.z, atmo.night);
  const tB = performance.now();
  const OFF = offsets();
  props.update(running ? carPos.x : camera.position.x, running ? carPos.z : camera.position.z, OFF, atmo.night);
  signals.update(camera.position.x, camera.position.z, OFF, t / 1000);
  if (signLayer) signLayer.update(camera.position.x, camera.position.z, OFF, atmo.night, frameNo);
  if (PK && frameNo % 3 === 2) tiles.cullNear(camera.position.x, camera.position.z);     // the near layers' ranges are short: a chunk must not wait a quarter of a second to appear
  if (PK) tiles.stepHeld(camera.position.x, camera.position.z, !running || !!waitWorld);
  if (running && frameNo % 6 === 0) redLight(t, OFF);
  if (running && frameNo % 30 === 11) updateExits();
  if (frameNo % 10 === 0) updateCuts(OFF);
  const tC = performance.now();
  // sky follows the focus
  atmo.update(running ? carPos : new THREE.Vector3(camera.position.x, TRN ? camera.position.y - 60 : 0, camera.position.z), camera);
  if (TRN) {
    // clearer air than the Gulf, thinner still up in the hills, so the Margallas read from the city
    const alt = THREE.MathUtils.smoothstep(camera.position.y, 900, 2200);
    scene.fog.density *= 0.62 - 0.22 * alt;
    if (frameNo % 40 === 7) { const [la, lo] = running ? [S.lat, S.lon] : toLatLon(camera.position.x, camera.position.z); TRN.ensureLL(la, lo, 4000); if (beam.visible && beam.userData.ll) beam.position.y = roadGrade(beam.userData.ll[0], beam.userData.ll[1]); }
  }
  ground.position.x = camera.position.x; ground.position.z = camera.position.z;
  for (const L of landmarks) if (L.group && L.group.userData.nightMats) for (const n of L.group.userData.nightMats) n.mat.emissiveIntensity = n.day + (n.night - n.day) * atmo.night;
  atmo.sky.material.uniforms.time.value = t / 1000;
  renderer.info.reset();
  const tD = performance.now();
  if (prDirty) { prDirty = false; applyPR(true); }
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
    [S.lat, S.lon] = move(S.lat, S.lon, want + 90 * KEEP, AUTO.sh);
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
  if (slowSecs >= 3 && prMode > PR_MIN + 0.02) { prMode = Math.max(PR_MIN, prMode - 0.2); applyPR(); slowSecs = 0; prChanges++; prLastT = now; }
  else if (fastSecs >= 12 && prMode < Q.pr) { prMode = Math.min(Q.pr, prMode + 0.2); applyPR(); fastSecs = 0; prChanges++; prLastT = now; }
}
// Pakistan: setSize clears the canvas, and adaptQuality runs after the frame is drawn, so the browser showed one empty frame (build/pk/test_blank_canvas.js). Resize just before the next draw instead.
let prDirty = false;
function applyPR(now) { if (PK && !now) { prDirty = true; return; } renderer.setPixelRatio(prMode); renderer.setSize(innerWidth, innerHeight); fx.setSize(innerWidth, innerHeight); }
// a landmark stands on the elevation at its own point (the worker flattens the same height under its footprint)
function landmarkBase(def) { if (!TRN) return 0; const h = TRN.groundLL(def.lat, def.lon); return (h === h ? h : 0) + (def.baseOffset || 0); }
function placeLandmarks() {
  for (const L of landmarks) {
    const d = hav([S.lat, S.lon], [L.def.lat, L.def.lon]);
    const near = d < 16000;
    if (near && !L.group && !L.loading) {
      if (TRN && TRN.groundLL(L.def.lat, L.def.lon) !== TRN.groundLL(L.def.lat, L.def.lon)) { TRN.ensureLL(L.def.lat, L.def.lon, 200); continue; }          // its elevation has not arrived yet
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
        const v = toWorld(L.def.lat, L.def.lon); g.position.set(v.x, landmarkBase(L.def), v.z);
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
// Pakistan, when no city label is in the loaded tiles: the Murree hills, Lahore, the twin cities, else the motorway between them
function pkArea(lat, lon) {
  if (lat > 33.78 && lon > 73.25) return "Murree";
  if (lat < 31.75) return "Lahore";
  if (lat >= 33.645) return "Islamabad";
  if (lat >= 33.5) return "Rawalpindi";
  return "M-2 Motorway";
}
// [name, lat, lon, reach in metres, city or society] from build/pk/research: sector label points, society phases and
// the anchors named for a phase, the Rawalpindi bazaars. The closest point relative to its reach wins.
const PK_AREAS = [["F-5",33.73221,73.08878,1650,"Islamabad"],["F-6",33.72862,73.07352,1650,"Islamabad"],["F-7",33.72043,73.05612,1650,"Islamabad"],["F-8",33.7115,73.0396,1650,"Islamabad"],["F-10",33.69182,73.00668,1650,"Islamabad"],["F-11",33.68439,72.98954,1650,"Islamabad"],["G-5",33.72081,73.09826,1650,"Islamabad"],["G-6",33.71543,73.08564,1650,"Islamabad"],["G-7",33.7066,73.06902,1650,"Islamabad"],["G-8",33.69668,73.0509,1650,"Islamabad"],["G-9",33.69144,73.03072,1650,"Islamabad"],["G-10",33.67772,73.0187,1650,"Islamabad"],["G-11",33.66872,72.99874,1650,"Islamabad"],["G-12",33.65954,72.98098,1650,"Islamabad"],["G-13",33.65145,72.96207,1650,"Islamabad"],["G-14",33.64185,72.94751,1650,"Islamabad"],["G-15",33.63263,72.92302,1650,"Islamabad"],["E-7",33.72531,73.04544,1650,"Islamabad"],["E-8",33.72189,73.03492,1650,"Islamabad"],["E-9",33.71553,73.02007,1650,"Islamabad"],["E-11",33.69512,72.97242,1650,"Islamabad"],["I-8",33.66886,73.07296,1650,"Islamabad"],["I-9",33.65755,73.05556,1650,"Islamabad"],["I-10",33.64821,73.03692,1650,"Islamabad"],["I-11",33.64067,73.02069,1650,"Islamabad"],["I-12",33.6277,73.00176,1650,"Islamabad"],["I-14",33.61161,72.96745,1650,"Islamabad"],["I-15",33.60152,72.95206,1650,"Islamabad"],["I-16",33.59358,72.93294,1650,"Islamabad"],["H-8",33.68031,73.06205,1650,"Islamabad"],["H-9",33.67276,73.04437,1650,"Islamabad"],["H-10",33.66253,73.02549,1650,"Islamabad"],["H-11",33.65439,73.00915,1650,"Islamabad"],["H-12",33.64373,72.99198,1650,"Islamabad"],["H-13",33.63668,72.97545,1650,"Islamabad"],["D-12",33.70181,72.94862,1650,"Islamabad"],["F-9",33.70156,73.02214,1650,"Islamabad"],["Phase 1",33.54476,73.09367,1500,"DHA"],["Phase 1",33.51704,73.09891,1500,"DHA"],["Phase 2",33.52726,73.15365,1500,"DHA"],["Phase 3",33.49928,73.14535,1500,"DHA"],["Phase 4",33.521614,73.077369,1500,"DHA"],["Phase 1",33.568543,73.116879,1500,"Bahria Town"],["Phase 2",33.558172,73.120811,1500,"Bahria Town"],["Phase 3",33.55325,73.11434,1500,"Bahria Town"],["Phase 4",33.549863,73.133108,1500,"Bahria Town"],["Phase 5",33.55534,73.13078,1500,"Bahria Town"],["Phase 6",33.55582,73.13741,1500,"Bahria Town"],["Phase 7",33.530822,73.117963,1500,"Bahria Town"],["Phase 8",33.501268,73.087263,2300,"Bahria Town"],["Safari Villas",33.5731,73.10879,320,"Bahria Town"],["Safari Villas 2",33.53791,73.10741,320,"Bahria Town"],["Safari Villas 3",33.55576,73.12652,320,"Bahria Town"],["Phase 4",33.54315,73.12151,1100,"Bahria Town"],["Phase 7",33.53245,73.11123,1100,"Bahria Town"],["Phase 7",33.53159,73.11498,1100,"Bahria Town"],["Phase 7",33.53395,73.12354,1100,"Bahria Town"],["Phase 8",33.49126,73.09741,1100,"Bahria Town"],["Raja Bazaar",33.612309,73.056339,520,"Rawalpindi"],["Moti Bazaar",33.613926,73.058367,190,"Rawalpindi"],["Saddar",33.596865,73.05116,850,"Rawalpindi"]];
// Blue Area is a strip along Jinnah Avenue (research/islamabad_sectors.json); the extent, Stock Exchange to Parade Ground stations, is an estimate.
const PK_BLUE = [[33.71166, 73.0593], [33.72475, 73.084338]];
function pkAreaAt(lat, lon) {
  if (segDist([lat, lon], PK_BLUE[0], PK_BLUE[1])[0] < (AREA.name === "Blue Area" ? 360 : 320)) return { name: "Blue Area", city: "Islamabad" };
  let best = null, bs = 1, cur = null, cs = 1e9;
  for (const a of PK_AREAS) {
    const s = hav([lat, lon], [a[1], a[2]]) / a[3];
    if (s < bs) { bs = s; best = a; }
    if (a[0] === AREA.name && s < cs) { cs = s; cur = a; }
  }
  if (cur && cs < 1 && cs < bs * 1.08) best = cur;                // no flicker along a boundary
  return best ? { name: best[0], city: best[4] } : null;
}
function updateArea(t) {
  if (t - AREA.t < 1000) return; AREA.t = t;
  if (PK) {
    if (S.onRoad && /motorway/.test(S.cls || "")) { AREA.name = ""; AREA.city = M2D.m2At(S.lat, S.lon) ? "M-2 Motorway" : "Motorway"; return; }      // villages you cannot see from the motorway are not places you are entering
    const a = pkAreaAt(S.lat, S.lon);
    if (a) { AREA.city = a.city; if (a.name !== AREA.name) { if (AREA.name && running && !paused) toast(`Entering <b>${esc(a.name)}</b><small>${esc(a.city)}</small>`, "good"); AREA.name = a.name; } return; }
  }
  let best = null, bd = 3500, city = null, cd = 60000, curD = 1e9;
  const W = { suburb: 1, quarter: 1.2, neighbourhood: 1.4, town: 1.8, village: 1.6, hamlet: 1.8 };
  for (const tl of tiles.tiles.values()) {
    if (!tl.places || !tl.off) continue;
    for (const p of tl.places) {
      const d = Math.hypot(p.x + tl.off.x - carPos.x, p.z + tl.off.z - carPos.z);
      if (p.c === "city") { if (d < cd) { cd = d; city = p; } continue; }
      const sc = d * (W[p.c] || 1.4);
      if (sc < bd) { bd = sc; best = p; }
      if (pkFix(p.en || D.names[p.ar] || p.ar) === AREA.name && sc < curD) curD = sc;
    }
  }
  let nm = pkFix(best ? (best.en || D.names[best.ar] || best.ar) : "");
  if (AREA.name && nm !== AREA.name && curD < 3500 && bd > curD * (PK ? 0.92 : 0.75)) nm = AREA.name;
  AREA.city = city ? (city.en || city.ar) : CITY.region === "shanghai" ? "Shanghai" : CITY.region === "pakistan" ? pkArea(S.lat, S.lon) : (S.lon < 54.95 ? "Abu Dhabi" : "Dubai");
  if (nm && nm !== AREA.name) { if (AREA.name && running && !paused) toast(`Entering <b>${esc(nm)}</b><small>${esc(AREA.city)}</small>`, "good"); AREA.name = nm; }
}
function hud(t) {
  updateArea(t);
  const kmh = Math.round(Math.abs(S.v) * 3.6), lim = PK ? (S.onRoad ? S.limit || 0 : 0) : S.onRoad ? (S.limit || LIMIT[S.cls] || 40) : 40;
  document.querySelector("#speed .v").textContent = kmh;
  const limEl = document.querySelector("#speed .lim");
  if (PK) { limEl.hidden = !lim; if (lim && limEl._v !== lim) { limEl._v = lim; limEl.textContent = lim; } } else limEl.textContent = S.onRoad ? lim : "-";
  document.getElementById("speed").classList.toggle("over", lim > 0 && kmh > lim + 5);
  const st = document.getElementById("street");
  const nm = S.name || (S.onRoad ? (/link/.test(S.cls) ? "Slip road" : S.cls === "service" ? "Service road" : /motorway|trunk/.test(S.cls) ? "Main road" : PK ? (AREA.name ? `Street in ${AREA.name}` : "Side street") : "Local street") : "Off road");
  if (st._nm !== nm) { st._nm = nm; st.querySelector(".nm").textContent = nm; }
  const area = AREA.name ? `${AREA.name} \u00b7 ${AREA.city}` : AREA.city;
  const ae = st.querySelector(".area"); if (ae && ae._a !== area) { ae._a = area; ae.textContent = area; }
  const meta = `${!S.name && S.toward ? `<span>to ${esc(S.toward)}</span>` : !S.name && S.near ? `<span>off ${esc(S.near)}</span>` : ""}${S.ref ? `<span class="ref">${esc(S.ref)}</span>` : ""}${S.nameAr && S.nameAr !== S.name ? `<span class="ar">${esc(S.nameAr)}</span>` : ""}${S.brunnel ? `<span>${S.brunnel}</span>` : ""}${!S.onRoad ? `<span class="off">${PK ? "off road" : "off road, max 40"}</span>` : M && M.offRoute && !M.free ? `<span class="off">off route</span>` : ""}`;
  if (st._meta !== meta) { st._meta = meta; st.querySelector(".meta").innerHTML = meta; }
  if (!M) return;
  const mi = document.getElementById("mission");
  let html;
  if (M.free) html = `<span class="dest">Free roam</span><span>driven <b>${(M.dist / 1000).toFixed(1)} km</b></span>${PK ? "" : `<span>tolls <b>${aed(M.cost)}</b></span>`}`;
  else {
    const rem = Math.max(0, M.cum[M.cum.length - 1] - M.progress);
    const secs = remainingSeconds(M.v, M.cum, M.progress);
    const elapsed = M.started ? (t - M.t0) / 1000 : 0;
    const arr = ((M.hour0 || 12) + (elapsed + secs) / 3600) % 24;
    const clock = `${String(Math.floor(arr)).padStart(2, "0")}:${String(Math.floor((arr % 1) * 60)).padStart(2, "0")}`;
    html = `<span class="min">${secs < 60 ? "<1" : Math.round(secs / 60)} min</span><span><b>${fmtM(rem)}</b></span><span>arrive <b>${clock}</b></span><span class="dest">${esc(M.destName)}</span>${PK ? "" : `<span>tolls <b>${aed(M.cost)}</b></span>`}`;
  }
  if (mi._h !== html) { mi._h = html; mi.innerHTML = html; }
  if (M.free || !settings.gps) { nav.hide(); if (turnArrow) clearTurnArrow(); return; }
  const r = nav.update(M.progress, Math.abs(S.v), M.offRoute, M.rerouting, M.offDist, S.hdg);
  if (PK) { const n2 = r ? nav.mans[r.i + 1] : null; gpsMat.uniforms.uTurn.value.set(r && !M.offRoute ? r.m.at : -1e9, n2 && !M.offRoute ? n2.at : -1e9); }
  // the road arrow through the next real turn, shown in the last 260 m
  const show = r && !M.offRoute && r.m.shape !== "arrive" && r.d < 260;
  if (show && turnArrowFor !== r.m.at) buildTurnArrow(r.m.at);
  if (!show && turnArrow) clearTurnArrow();
  if (turnArrow) arrowMat.uniforms.uAlpha.value = Math.min(1, (260 - r.d) / 60) * (PK ? 0.8 : 1);
  if (r && !M.offRoute && IDX.ready) for (let k = r.i; k < Math.min(nav.mans.length, r.i + 3); k++) { const mm = nav.mans[k]; if (mm.at - M.progress > 1300) break; if (!guides.has(mm.at)) buildGuide(mm); }
  if (guides.size && frameNo % 30 === 0) clearGuides(false);
}

// ================================================================== keys and menus
function onKey(e) {
  const k = e.key.toLowerCase();
  if (PV.on) {
    if (k === "escape" || k === "enter" || k === " ") endPreview();
    else if (k === "+" || k === "=" || k === "]") pvSpeed(1); else if (k === "-" || k === "_" || k === "[") pvSpeed(-1);
    return;
  }
  if (PV.ask && running) { if (k === "enter" || k === "o") { startPreview(); return; } if (k !== "q" && k !== "e" && k !== "c" && k !== "t" && k !== "f") pvDismiss(); }
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
    <div class="kbdhelp"><h2>Keys</h2><p class="sub"><span class="kbd">W</span> accelerate &middot; <span class="kbd">S</span> brake / reverse &middot; <span class="kbd">A</span> <span class="kbd">D</span> steer &middot; <span class="kbd">Space</span> handbrake &middot; <span class="kbd">H</span> horn &middot; <span class="kbd">C</span> camera &middot; <span class="kbd">T</span> time of day &middot; <span class="kbd">F</span> visual look &middot; <span class="kbd">G</span> GPS &middot; <span class="kbd">V</span> voice &middot; <span class="kbd">M</span> big map &middot; <span class="kbd">R</span> back on route &middot; <span class="kbd">O</span> route preview &middot; <span class="kbd">P</span> frame rate &middot; <span class="kbd">Esc</span> this menu &middot; drag the screen (or <span class="kbd">Q</span> <span class="kbd">E</span>) to look around, scroll to zoom</p></div><p class="sub">Drag the screen to look around; double-tap to reset the view.</p>`;
  else lastT = performance.now();
}
let menuTab = "missions", menuRoute = null, menuVariant = "fast";
function renderMenu(tab, routeId) {
  menuTab = tab || menuTab; if (routeId) { menuRoute = D.routes.find(r => r.id === routeId); menuVariant = "fast"; }
  document.getElementById("menu").hidden = false;
  const tabs = ["missions", "free", "live", "look", "tolls", "help"].filter(t => t !== "tolls" || !CITY.noTolls).map(t => `<button class="${menuTab === t ? "on" : ""}" onclick="renderMenu('${t}')">${{ missions: "Missions", free: "Free roam", live: "Any A to B", look: "Look & feel", tolls: "Salik & Darb", help: "How to play" }[t]}</button>`).join("");
  let h = CITY.title ? `<h1>${CITY.title}</h1><p class="sub">${CITY.sub}</p>${CITY.credit ? `<p class="sub" style="font-size:11px;opacity:.65">${CITY.credit}</p>` : ""}<div class="tabs">${tabs}</div>` : `<h1>UAE Drive</h1><p class="sub">The real Dubai and Abu Dhabi in 3D: every street, junction and toll gate from OpenStreetMap, with buildings, palms, traffic and the landmarks built in.</p><div class="tabs">${tabs}<a class="btn" href="index.html" title="The earlier map-style driving world">Classic map mode</a></div>`;
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
  for (const s of v.steps) if (s.kind !== "start") rows.push({ at: cum[s.idx], html: `<span class="km">${(cum[s.idx] / 1000).toFixed(1)}</span>${esc(PK && /^Take exit \S+ toward M-?2\.?$/i.test(s.text) ? `Keep ${s.type === 20 ? "right" : "left"}, leaving the M-2.` : pkFix(s.text))}${s.toward.length ? `<div class="ar" style="direction:ltr">Sign: ${esc(s.toward.join(" / "))}${s.exit_no.length ? " &middot; Exit " + esc(s.exit_no.join("/")) : ""}</div>` : ""}`, cls: "" });
  for (const g of v.gates) rows.push({ at: cum[g.idx] + 0.5, html: `<span class="km">${(cum[g.idx] / 1000).toFixed(1)}</span>${g.sys === "salik" ? "Salik" : "Darb"} gate: <b>${esc(g.name)}</b>, ${esc(g.road)}. ${gateRule(g)}`, cls: "gate" });
  for (const p of v.passes) rows.push({ at: cum[p.idx] + 0.25, html: `<span class="km">${(cum[p.idx] / 1000).toFixed(1)}</span>Passing ${esc(P[p.id].label)}, ${p.d} m away`, cls: "pass" });
  rows.sort((a, b) => a.at - b.at);
  return rows.map(r => `<li class="${r.cls}">${r.html}</li>`).join("");
}
function freeRoam() {
  const stops = D.places.filter(p => p.kind === "stop").sort((a, b) => (a.city + a.label).localeCompare(b.city + b.label));
  return `<h3>Free roam</h3><p class="sub">No destination. Start somewhere and explore. ${CITY.region === "pakistan" ? "" : "Gates still charge, "}${CITY.region === "pakistan" ? "Landmarks" : "landmarks"} still get called out, the street name is always on screen.</p><div class="grid">${stops.map(p => `<div class="card" onclick="startFree('${p.id}')"><div class="nm">${esc(p.label)}<small>${p.city === "DXB" ? "Dubai" : p.city === "AUH" ? "Abu Dhabi" : esc(p.city)}</small></div></div>`).join("")}</div>`;
}
function startFree(pid) {
  const p = P[pid];
  const route = { id: "free", level: 0, title: "Free roam from " + p.label, from: pid, to: pid, fast: { km: 0, min: 0, geom: [[p.lat, p.lon], [p.lat + 0.0004, p.lon]], steps: [], roads: [], gates: [], passes: [] } };
  startMission(route, "fast", { free: true });
  pendingSnap = { lat: p.lat, lon: p.lon, t: performance.now(), fixed: PK ? PK_FREE_START[pid] : null };
}
// Free roam starts at a place pin, which often sits on a building. Once the tiles around it
// are indexed, move the car to the nearest proper road and face along it.
let pendingSnap = null;
// Pakistan: places where the nearest road is the wrong start. Faisal Mosque: its pin is in the courtyard and the nearest road is a lane on the north flank that ends at a house; start on the north leg of the east approach (OpenStreetMap service road, 33.73055,73.04038 to 33.73036,73.03945), which runs at the mosque and clear of the small building on its axis.
const PK_FREE_START = { faisal_mosque: { lat: 33.73053, lon: 73.04030, hdg: 256.3 } };
const SNAP_RANK = { motorway: 5, trunk: 3, primary: 1, secondary: 0, tertiary: 0, minor: 1.6, service: 3, track: 4 };
function trySnap() {
  if (!pendingSnap || !IDX.ready) return;
  const { lat, lon } = pendingSnap;
  if (PK && performance.now() - pendingSnap.t < 12000) { const [tx, ty] = tileOf(lat, lon); if (idxJobs.some(j => j.x === tx && j.y === ty) || !IDX.tiles.has(tx + "/" + ty)) return; }   // an index that lacks the pin's own tile picks a road hundreds of metres away
  if (pendingSnap.fixed) { const f = pendingSnap.fixed; S.lat = f.lat; S.lon = f.lon; S.hdg = f.hdg; pendingSnap = null; camInit = true; S.v = 0; return; }
  let best = null, bd = 1e9;
  const c = IDX.cell, i0 = Math.floor(lat / c), j0 = Math.floor(lon / c);
  for (let i = i0 - 9; i <= i0 + 9; i++) for (let j = j0 - 9; j <= j0 + 9; j++) {
    for (const s of IDX.roads.get(i + "_" + j) || []) {
      if (s.brunnel === "tunnel" || /link/.test(s.cls)) continue;
      const [d, t] = segDist([lat, lon], s.a, s.b);
      const score = d + 25 * (SNAP_RANK[s.cls] ?? 3);
      if (score >= bd) continue;
      const pl = s.a[0] + (s.b[0] - s.a[0]) * t, po = s.a[1] + (s.b[1] - s.a[1]) * t;
      if (IDX.building(pl, po) && !(PK && /trunk|primary|secondary|tertiary/.test(s.cls))) continue;                     // a ramp or road running under a mall (Pakistan: footprints crowd old-city streets, so main roads always count)
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
  return `<h3>Any A to B</h3><p class="sub">Routed live by the public Valhalla router on current OpenStreetMap data. Needs internet.</p><div class="row2"><label class="opt">from <select id="fa">${opt(P.dxb ? "dxb" : D.places[0].id)}</select></label><label class="opt">to <select id="fb2">${opt(P.difc ? "difc" : (D.places[6] || D.places[1]).id)}</select></label>${CITY.noTolls ? "<input type=\"checkbox\" id=\"avoid\" hidden>" : "<label class=\"opt\"><input type=\"checkbox\" id=\"avoid\"> avoid Salik and 24/7 Darb gates</label>"}<button class="btn primary" id="go">Route it</button></div><div id="fres"></div>`;
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
  const colors = saloon() ? [[0xf3f2ec, "White"], [0xbfc2c5, "Silver"], [0x74787c, "Grey"], [0x17181b, "Black"], [0x7f2b2b, "Red"], [0x2a4a78, "Blue"]] : [[0xf97316, "Orange"], [0xdc2626, "Red"], [0x0ea5e9, "Blue"], [0xf5f5f4, "Pearl"], [0x111827, "Black"], [0xeab308, "Gold"], [0x16a34a, "Green"]];
  return `<h3>Look & feel</h3>
  <h2>Time of day</h2>${seg("time", TIMES.map((t, i) => [i, t[0]]), settings.time)} <span class="sub">&nbsp;or press <span class="kbd">T</span> while driving</span>
  <h2>Visual look</h2>${seg("look", PRESETS.map(p => [p, p === "nightvision" ? "night vision" : p]), settings.look)} <span class="sub">&nbsp;<span class="kbd">F</span> while driving. Thermal, night vision and CRT are borrowed from God's Eye View.</span>
  <h2>Camera</h2>${seg("cam", CAMS.map(c => [c, CAM_NAMES[c]]), settings.cam)}
  <h2>Traffic</h2>${seg("traffic", [["off", "off"], ["normal", "normal"], ["heavy", "heavy"]], settings.traffic)}
  ${PK ? `<h2>Your car</h2>${seg("pkCar", [["saloon", "saloon"], ["supercar", "supercar"]], settings.pkCar)}` : ""}
  <h2>Car colour</h2>${seg("color", colors.map(([c, n]) => [c, n]), saloon() ? settings.pkColor : settings.color)}
  <h2>Sound</h2>${seg("sound", [["1", "on"], ["0", "off"]], settings.sound === false ? "0" : "1")} ${seg("vol", [["0.35", "quiet"], ["0.7", "medium"], ["1", "loud"]], settings.vol ?? 0.7)} <span class="sub">&nbsp;engine, tyres, wind; <span class="kbd">H</span> is the horn</span>
  <h2>Route preview</h2>${seg("preview", [["drive", "fast-forward drive"], ["sky", "from the sky"], ["0", "off"]], settings.preview === false ? "0" : settings.preview === "sky" ? "sky" : "drive")} <span class="sub">&nbsp;when a mission starts, see the whole route first; <span class="kbd">O</span> plays it again, any key or tap skips it</span>
  <h2>Spoken directions</h2>${seg("voice", [["1", "on"], ["0", "off"]], settings.voice === false ? "0" : "1")} <span class="sub">&nbsp;or <span class="kbd">V</span> while driving</span>
  <h2>Place names over the city</h2>${seg("labels", [["1", "on"], ["0", "off"]], settings.labels === false ? "0" : "1")} <span class="sub">&nbsp;metro stations, malls, hotels and sights near you</span>
  ${PK ? `<h2>Place names in bonnet view</h2>${seg("hoodLabels", [["0", "off"], ["1", "on"]], settings.hoodLabels === true ? "1" : "0")}` : ""}
  <h2>Graphics quality</h2>${seg("quality", [["low", "low"], ["normal", "normal (adaptive)"], ["high", "high"]], settings.quality)} <p class="sub">Quality changes apply after a reload. Press <span class="kbd">P</span> while driving to see the frame rate.</p>`;
}
function setOpt(name, v) {
  if (name === "time") { settings.time = +v; atmo.setHour(TIMES[settings.time][1]); }
  else if (name === "look") { settings.look = v; fx.setMode(v); }
  else if (name === "cam") { settings.cam = v; camInit = true; }
  else if (name === "traffic") { settings.traffic = v; traffic.target = v === "off" ? 0 : v === "heavy" ? Q.traffic * 1.6 : Q.traffic; if (v === "off") traffic.cars.length = 0; }
  else if (name === "color") { if (saloon()) settings.pkColor = +v; else settings.color = +v; car.setColor(+v); }
  else if (name === "pkCar") { settings.pkCar = v; swapPlayerCar(); }
  else if (name === "hoodLabels") { settings.hoodLabels = v === "1"; }
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
  <h2>Missions</h2><p class="sub">Every mission is a real trip between two real places. The green card at the top left is the satnav: the next turn, how far, the road to take and where it leads, with lane arrows where the real road has turn lanes, spoken aloud too (<span class="kbd">V</span> turns the voice off). The blue line on the road is the route, a big arrow is painted through each turn as you reach it, the blue beam is the destination, and the map turns with the car. The bar at the bottom shows minutes and distance to go and your arrival time. Take a wrong turn and the GPS reroutes you after five seconds.${CITY.region === "pakistan" ? "" : " Drive under a Salik or Darb gantry and it bills you at the time band you picked."}</p>
  <h2>The world</h2><p class="sub">Streets, buildings, heights, parks and water are OpenStreetMap, streamed as OpenFreeMap vector tiles and built into 3D on your machine: window facades by building type, lane markings, sidewalks with painted curbs, palms and street lamps along the main roads, domes and minarets on mapped mosques. The famous landmarks are hand-built models. Traffic is simulated on the real road network. Routes are from the Valhalla router, baked ${D.generated}.</p>
  <h2>Keys</h2><p class="sub"><span class="kbd">C</span> camera &middot; <span class="kbd">T</span> time of day &middot; <span class="kbd">F</span> visual look &middot; <span class="kbd">G</span> GPS &middot; <span class="kbd">V</span> voice &middot; <span class="kbd">M</span> big map &middot; <span class="kbd">R</span> back on route &middot; <span class="kbd">P</span> frame rate &middot; <span class="kbd">Esc</span> pause</p>`;
}
function toast(html, cls) { const t = document.createElement("div"); t.className = "toast " + (cls || ""); t.innerHTML = html; document.getElementById("toasts").appendChild(t); setTimeout(() => t.remove(), 4600); }
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); fx.setSize(innerWidth, innerHeight); });

// expose for inline handlers and tests
Object.assign(window, { startMission, retry, nextMission, quitToMenu, renderMenu, togglePause, respawn, onKey, startFree, setOpt, liveGo, startPreview, endPreview, pvSpeed, pvDismiss, askPreview });
// used by build/bake_shanghai_routes.js to bake missions with the same code the live router uses
window.__routeKit = { buildVariant, valhalla };
Object.defineProperties(window, {
  menuRoute: { get: () => menuRoute, set: v => { menuRoute = v; }, configurable: true },
  menuVariant: { get: () => menuVariant, set: v => { menuVariant = v; }, configurable: true },
  M: { get: () => M, configurable: true },
});
const __fr = new THREE.Frustum();
function __inFrustum(m, o) { __fr.setFromProjectionMatrix(m); if (o.isInstancedMesh || !o.geometry) return true; if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere(); const sp = o.geometry.boundingSphere.clone().applyMatrix4(o.matrixWorld); return __fr.intersectsSphere(sp); }
window.GAME = { get signLayer() { return signLayer; }, groundY: TRN ? groundY : () => 0, roadGrade: TRN ? roadGrade : () => 0, terrain: TRN, viewPoint(lat, lon, o = {}) { attractOverride = { lat, lon, r: o.r ?? 800, h: o.h ?? 200, look: o.look ?? 0, ang0: o.ang ?? 0, name: o.name || "" }; attractT = 0; document.getElementById("menu").hidden = true; document.getElementById("intro").hidden = true; }, get snapState() { return { pendingSnap, pendingLane, waitWorld, idxJobs: idxJobs.length }; }, __Raycaster: THREE.Raycaster, __makeFrustum: __inFrustum, guides, get turnArrow() { return turnArrow; }, get gpsMesh() { return gpsMesh; }, viewLandmark, S, IDX, tiles, traffic, peds, props, signals, signLayer, nav, atmo, fx, renderer, scene, camera, settings, get car() { return car; }, landmarks, rebaseTo, AUTO, ground, gantries, setHour: h => atmo.setHour(h) };

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
  const kinds = [[tiles.mats.b, [...P, ["uv", 2], ["color", 3], ["facade", 4]]], [tiles.mats.r, [...P, ["uv", 2], ["road", 4], ["junc", 4]]], [tiles.mats.w, [...P, ["uv", 2], ["color", 3]]], [tiles.mats.a, [...P, ["color", 3]]], [tiles.mats.wa, [...P, ["color", 3]]], ...(tiles.farTerr ? [[tiles.warmTerr, P], [tiles.farTerr[12], P], [tiles.farTerr[10], P]] : []), [tiles.farMat, [...P, ["color", 3]]]];
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
