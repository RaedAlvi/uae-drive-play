// Turn-by-turn navigation: the green direction card (maneuver icon, distance, the road to
// take, where it leads), lane guidance, a "then" chip for close pairs of turns, the
// arrival-time bar and spoken directions. Maneuvers come from the Valhalla steps baked
// into each route; icons use the real geometry so a slight right looks slight.

const TYPE = {
  4: ["arrive", 0], 5: ["arrive", 1], 6: ["arrive", -1],
  7: ["continue", 0], 8: ["continue", 0],
  9: ["turn", 35], 10: ["turn", 90], 11: ["turn", 140], 12: ["uturn", 1], 13: ["uturn", -1],
  14: ["turn", -140], 15: ["turn", -90], 16: ["turn", -35],
  17: ["ramp", 0], 18: ["ramp", 1], 19: ["ramp", -1], 20: ["exit", 1], 21: ["exit", -1],
  22: ["keep", 0], 23: ["keep", 1], 24: ["keep", -1], 25: ["merge", 0], 37: ["merge", 1], 38: ["merge", -1],
  26: ["roundabout", 0], 27: ["skip", 0],
};
const ORD = n => n + (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th");
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ------------------------------------------------------------------ icons (SVG, white on the card)
const SW = 'stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" fill="none"';
function head(x, y, dx, dy, s) { const px = -dy, py = dx; return `<path d="M${(x + dx * s).toFixed(1)} ${(y + dy * s).toFixed(1)} L${(x + px * s * 1.05).toFixed(1)} ${(y + py * s * 1.05).toFixed(1)} L${(x - px * s * 1.05).toFixed(1)} ${(y - py * s * 1.05).toFixed(1)} Z" fill="currentColor" stroke="none"/>`; }
// an arrow that leaves a stem and turns by `ang` degrees (+ right); drawn in a 64 x 64 box
function turnPath(ang, w = 7, dim = false) {
  const a = ang * Math.PI / 180, dx = Math.sin(a), dy = -Math.cos(a);
  const cx = 32, cy = 26, ex = cx + dx * 14, ey = cy + dy * 14;
  const op = dim ? ' opacity=".35"' : "";
  return `<g${op}><path d="M32 60 L32 38 Q${cx} ${cy} ${ex.toFixed(1)} ${ey.toFixed(1)}" ${SW} stroke-width="${w}"/>${head(ex, ey, dx, dy, 8)}</g>`;
}
export function maneuverIcon(m) {
  let body = "";
  if (m.shape === "arrive") body = `<path d="M32 58 C22 44 16 36 16 27 A16 16 0 0 1 48 27 C48 36 42 44 32 58 Z" fill="currentColor"/><circle cx="32" cy="27" r="6.5" fill="#0b6e3f"/>`;
  else if (m.shape === "uturn") {
    // right-hand traffic: U-turns go round to the left
    const L = m.side > 0 ? -1 : 1;
    const x0 = 32 + 9 * L, x1 = 32 - 9 * L;
    body = `<path d="M${x0} 60 L${x0} 28 A9 9 0 0 ${L > 0 ? 0 : 1} ${x1} 28 L${x1} 40" ${SW} stroke-width="7"/>${head(x1, 42, 0, 1, 8)}`;
  } else if (m.shape === "roundabout") {
    const a = m.ang * Math.PI / 180, dx = Math.sin(a), dy = -Math.cos(a);
    const R = 11, cx = 32, cy = 29, sx = cx, sy = cy + R, ex = cx + dx * R, ey = cy + dy * R;
    let sweep = 180 - m.ang; while (sweep < 0) sweep += 360; while (sweep > 360) sweep -= 360;
    body = `<circle cx="${cx}" cy="${cy}" r="${R}" ${SW} stroke-width="4" opacity=".35"/>` +
      `<path d="M32 62 L${sx} ${sy} A${R} ${R} 0 ${sweep > 180 ? 1 : 0} 0 ${ex.toFixed(1)} ${ey.toFixed(1)} L${(ex + dx * 9).toFixed(1)} ${(ey + dy * 9).toFixed(1)}" ${SW} stroke-width="6"/>` +
      head(ex + dx * 9, ey + dy * 9, dx, dy, 7);
  } else if (m.shape === "keep" || m.shape === "fork") {
    const s = m.side;
    const left = `<path d="M32 60 L32 42 Q32 34 20 22 L16 16" ${SW} stroke-width="7"/>${head(15, 14.5, -0.6, -0.8, 8)}`;
    const right = `<path d="M32 60 L32 42 Q32 34 44 22 L48 16" ${SW} stroke-width="7"/>${head(49, 14.5, 0.6, -0.8, 8)}`;
    const straight = `<path d="M32 60 L32 18" ${SW} stroke-width="7"/>${head(32, 14, 0, -1, 8)}`;
    if (s > 0) body = `<g opacity=".35">${left}</g>${right}`;
    else if (s < 0) body = `<g opacity=".35">${right}</g>${left}`;
    else body = `<g opacity=".35">${right}</g>${straight}`;
  } else if (m.shape === "exit" || m.shape === "ramp") {
    const s = m.side || 1;
    const main = `<g opacity=".35"><path d="M${32 - 6 * s} 60 L${32 - 6 * s} 8" ${SW} stroke-width="7"/></g>`;
    const bx = 32 - 6 * s, tx = bx + 22 * s;
    body = main + `<path d="M${bx} 60 L${bx} 44 Q${bx} 32 ${tx - 6 * s} 22" ${SW} stroke-width="7"/>` + head(tx - 4 * s, 19, 0.55 * s, -0.83, 8);
  } else if (m.shape === "merge") {
    const s = m.side || 1;
    body = `<g opacity=".35"><path d="M${32 + 12 * s} 60 L${32 + 12 * s} 44 Q${32 + 12 * s} 36 32 28" ${SW} stroke-width="6"/></g><path d="M32 60 L32 18" ${SW} stroke-width="7"/>${head(32, 14, 0, -1, 8)}`;
  } else body = turnPath(m.ang || 0);
  return `<svg viewBox="0 0 64 64" width="100%" height="100%">${body}</svg>`;
}
// lane arrows: indications from OSM turn:lanes / Valhalla ("left", "slight right", "straight", ...)
const IND = { "sharp left": -140, "left": -90, "slight left": -40, "straight": 0, "through": 0, "slight right": 40, "right": 90, "sharp right": 140, "none": 0, "uturn": 999, "merge_to_left": -20, "merge_to_right": 20 };
export function laneIcon(inds, on) {
  let body = "";
  for (const i of inds.length ? inds : ["straight"]) {
    const a = IND[i] ?? 0;
    if (a === 999) body += `<path d="M38 60 L38 30 A7 7 0 0 0 24 30 L24 38" ${SW} stroke-width="6"/>${head(24, 41, 0, 1, 7)}`;
    else body += turnPath(a, 6);
  }
  return `<svg viewBox="0 0 64 64" class="${on ? "on" : ""}">${body}</svg>`;
}

// ------------------------------------------------------------------ helpers
function hav(a, b) { const R = 6371000, p1 = a[0] * Math.PI / 180, p2 = b[0] * Math.PI / 180, dp = p2 - p1, dl = (b[1] - a[1]) * Math.PI / 180; const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
function bearing(a, b) { const la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180, dlo = (b[1] - a[1]) * Math.PI / 180; const y = Math.sin(dlo) * Math.cos(la2), x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dlo); return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360; }
// point on the route at arc length s
export function pointAt(geom, cum, s) {
  s = Math.max(0, Math.min(cum[cum.length - 1], s));
  let lo = 0, hi = cum.length - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const t = (s - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
  return [geom[lo][0] + (geom[hi][0] - geom[lo][0]) * t, geom[lo][1] + (geom[hi][1] - geom[lo][1]) * t];
}
function turnAngle(geom, cum, sIn, sOut) {
  const a = pointAt(geom, cum, sIn - 22), b = pointAt(geom, cum, sIn), c = pointAt(geom, cum, sOut), d = pointAt(geom, cum, sOut + 22);
  let x = bearing(c, d) - bearing(a, b); while (x > 180) x -= 360; while (x < -180) x += 360; return x;
}
function roundDist(m) {
  if (m >= 1000) return (m / 1000).toFixed(m >= 10000 ? 0 : 1) + " km";
  if (m >= 300) return Math.round(m / 50) * 50 + " m";
  if (m >= 100) return Math.round(m / 10) * 10 + " m";
  return Math.max(0, Math.round(m / 5) * 5) + " m";
}
function sayDist(m) {
  if (m >= 1500) return `${Math.round(m / 500) / 2} kilometres`.replace(".0 ", " ");
  if (m >= 950) return "1 kilometre";
  const r = m >= 300 ? Math.round(m / 100) * 100 : Math.round(m / 50) * 50;
  return `${Math.max(50, r)} metres`;
}

// ------------------------------------------------------------------ the navigator
export class Nav {
  constructor() {
    this.el = document.getElementById("nav");
    this.card = this.el.querySelector(".card");
    this.lanesEl = this.el.querySelector(".lanes");
    this.thenEl = this.el.querySelector(".then");
    this.mans = []; this.cur = null; this._h = {};
    this.voice = true; this.voiceObj = null;
    try { const pick = () => { const vs = speechSynthesis.getVoices(); this.voiceObj = vs.find(v => /en-GB/i.test(v.lang) && /female|libby|sonia|hazel|susan/i.test(v.name)) || vs.find(v => /en-GB/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null; }; pick(); speechSynthesis.onvoiceschanged = pick; } catch (e) {}
  }
  // v: route variant (geom, steps), cum: cumulative metres, lanes: [{ at: geomIndex, lanes: [...] }] or null, destName: label
  setRoute(v, cum, lanes, destName) {
    const geom = v.geom, mans = [];
    const steps = v.steps || [];
    for (let k = 0; k < steps.length; k++) {
      const s = steps[k];
      const [shape0, p] = TYPE[s.type] || ["continue", 0];
      if (shape0 === "skip" || s.kind === "start") continue;
      const at = cum[Math.min(cum.length - 1, s.idx)];
      let shape = shape0, ang = 0, side = 0;
      if (shape === "turn") { ang = turnAngle(geom, cum, at, at); if (Math.sign(ang) !== Math.sign(p) || Math.abs(ang) < 15) ang = p; }
      else if (shape === "roundabout") { const endS = cum[Math.min(cum.length - 1, s.end || s.idx)]; ang = turnAngle(geom, cum, at, Math.max(at + 5, endS)); }
      else if (shape === "uturn" || shape === "exit" || shape === "ramp" || shape === "keep" || shape === "merge" || shape === "arrive") side = p;
      else if (shape === "continue") { ang = turnAngle(geom, cum, at, at); if (Math.abs(ang) < 28) continue; shape = "turn"; }
      if (shape === "ramp" && side === 0) shape = "keep";
      // words
      let road = s.en || (s.ref && !(s.toward || []).length ? s.ref : "") || "";
      let towardL = [...new Set((s.toward || []).map(x => String(x).replace(/\(\s*\)/g, "").trim()).filter(x => /[A-Za-z]/.test(x)))];
      // a quarter of the steps carry no name fields, but Valhalla's own sentence often has one
      // ("Bear left toward Zaa'beel.", "Keep left to take D61 toward Hessa Street/Hessa Street.")
      if (!road && !towardL.length && s.text) {
        const mt = s.text.match(/\b(onto|toward|to take)\s+(.+?)\.?$/i);
        if (mt) {
          const names = [...new Set(mt[2].split(/\s*\/\s*|\s+toward\s+/i).map(x => x.trim()).filter(x => /[A-Za-z0-9]/.test(x)))];
          if (/onto/i.test(mt[1])) road = names[0] || ""; else towardL = names.slice(0, 2);
        }
      }
      // still nothing: name the next road the route follows
      const nextNamed = !road && !towardL.length ? steps.slice(k + 1).find(t => t.en || t.ref) : null;
      const dirW = x => x > 0 ? "right" : "left";
      let verb;
      if (shape === "turn") verb = Math.abs(ang) < 50 ? `Bear ${dirW(ang)}` : Math.abs(ang) > 125 ? `Sharp ${dirW(ang)}` : `Turn ${dirW(ang)}`;
      else if (shape === "uturn") verb = "Make a U-turn";
      else if (shape === "roundabout") verb = s.ans && s.ans[1] ? `At the roundabout, take the ${ORD(s.ans[1])} exit` : "At the roundabout, continue";
      else if (shape === "exit") verb = s.exit_no.length ? `Take exit ${s.exit_no[0]}` : `Take the exit on the ${dirW(side)}`;
      else if (shape === "ramp") verb = `Take the ramp on the ${dirW(side)}`;
      else if (shape === "keep") verb = side ? `Keep ${dirW(side)}` : "Keep straight";
      else if (shape === "merge") verb = "Merge";
      else if (shape === "arrive") verb = side ? `Arrive: destination on the ${dirW(side)}` : "Arrive";
      else verb = "Continue";
      const toward = towardL.slice(0, 2).join(" / ");
      const onto = shape === "arrive" ? destName : road;
      const sub = [toward && (onto ? "toward " + toward : ""), s.exit_no.length && shape !== "exit" ? "Exit " + s.exit_no.join("/") : "", nextNamed && shape !== "arrive" ? "then " + (nextNamed.en || nextNamed.ref) : ""].filter(Boolean).join(" · ");
      const main = onto || (toward ? "toward " + toward : "");
      const clean = x => x.replace(/\s+\.$/, ".").replace(/\.$/, "");
      const say = shape === "arrive" ? `${clean(verb)}${destName ? ", " + destName : ""}` : clean(s.text || verb);
      // lane guidance: the lane record at or just before the maneuver point
      let ln = null;
      if (lanes) for (const L of lanes) { if (L.at <= s.idx + 3 && at - cum[Math.min(cum.length - 1, L.at)] < 450) { if (!ln || L.at > ln.at) ln = L; } }
      mans.push({ at, shape, ang, side, verb, main, ref: s.ref && s.ref !== main ? s.ref : "", sub, say, lanes: ln ? ln.lanes : null, said: 0, idx: s.idx,
        toward: towardL, exitNo: (s.exit_no || [])[0] || "", roadRef: s.ref || "", road });
    }
    this.mans = mans; this.cur = null; this._h = {};
    this.el.hidden = false;
  }
  hide() { this.el.hidden = true; this.mans = []; }
  // the next maneuver ahead of `progress` (metres along the route)
  next(progress) { for (let i = 0; i < this.mans.length; i++) if (this.mans[i].at > progress - 12) return i; return -1; }
  update(progress, speed, offRoute, rerouting, offDist) {
    if (!this.mans.length && !offRoute) { this.el.hidden = true; return null; }
    this.el.hidden = false;
    if (offRoute) {
      this.put("card", `<div class="ic">${maneuverIcon({ shape: "uturn", side: 1 })}</div><div class="tx"><div class="dist">${roundDist(offDist || 0)}</div><div class="verb">Off route</div><div class="road">${rerouting ? "Finding a new route" : "Turn back to the blue line"}</div><div class="sub">or press R to jump back</div></div>`);
      this.card.classList.add("off"); this.lanesEl.hidden = true; this.thenEl.hidden = true;
      return null;
    }
    this.card.classList.remove("off");
    const i = this.next(progress); if (i < 0) return null;
    const m = this.mans[i], d = Math.max(0, m.at - progress);
    this.put("card", `<div class="ic">${maneuverIcon(m)}</div><div class="tx"><div class="dist">${roundDist(d)}</div><div class="verb">${esc(m.verb)}${m.main && m.shape !== "arrive" && !/^toward /.test(m.main) ? (m.shape === "keep" || m.shape === "exit" || m.shape === "ramp" ? " for" : " onto") : ""}</div>${m.main ? `<div class="road">${esc(m.main)}${m.ref ? ` <span class="ref">${esc(m.ref)}</span>` : ""}</div>` : ""}${m.sub ? `<div class="sub">${esc(m.sub)}</div>` : ""}</div>`);
    // lanes, within a kilometre of the turn
    if (m.lanes && d < 1000) { this.lanesEl.hidden = false; this.put("lanes", m.lanes.map(l => laneIcon(l.ind || [], !!l.valid)).join("")); } else this.lanesEl.hidden = true;
    // "then": the following maneuver comes quickly after this one
    const n = this.mans[i + 1];
    if (n && n.at - m.at < 350 && d < 900) { this.thenEl.hidden = false; this.put("then", `<span>Then</span><div class="ic2">${maneuverIcon(n)}</div>`); } else this.thenEl.hidden = true;
    this.speak(m, n, d, speed);
    return { m, d, i };
  }
  put(k, html) { if (this._h[k] === html) return; this._h[k] = html; (k === "card" ? this.card : k === "lanes" ? this.lanesEl : this.thenEl).innerHTML = html; }
  // Spoken prompts: an early one (about 20 s out, or 2 km on a motorway) and one at the turn.
  speak(m, n, d, speed) {
    if (!this.voice) return;
    const v = Math.max(8, speed);
    if (m.said < 1 && d > 900 && d < Math.max(1200, v * 60) && v > 22) { m.said = 1; this.say(`In ${sayDist(d)}, ${lc(m.say)}.`); return; }
    if (m.said < 2 && d < Math.max(260, v * 16) && d > Math.max(60, v * 5)) { m.said = 2; this.say(`In ${sayDist(d)}, ${lc(m.say)}.${n && n.at - m.at < 250 ? " Then " + lc(n.say) + "." : ""}`); return; }
    if (m.said < 3 && d <= Math.max(50, v * 4)) { m.said = 3; this.say(`${m.say}.${n && n.at - m.at < 200 ? " Then " + lc(n.say) + "." : ""}`); }
  }
  say(text) {
    if (!this.voice || typeof speechSynthesis === "undefined") return;
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); if (this.voiceObj) u.voice = this.voiceObj; u.lang = this.voiceObj ? this.voiceObj.lang : "en-GB"; u.rate = 1.04; u.volume = 0.95; speechSynthesis.speak(u); } catch (e) {}
    this.lastSaid = text;
  }
}
function lc(s) { return s ? s[0].toLowerCase() + s.slice(1) : s; }

// Remaining time along a route, from its real drive time (Valhalla's per-step seconds).
export function remainingSeconds(v, cum, progress) {
  let sec = 0; const steps = v.steps || [];
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k], a = cum[Math.min(cum.length - 1, s.idx)], b = cum[Math.min(cum.length - 1, Math.max(s.end || s.idx, s.idx))];
    if (b <= progress) continue;
    const len = Math.max(1, b - a), frac = a >= progress ? 1 : (b - progress) / len;
    sec += (s.sec || 0) * frac;
  }
  if (!sec) { const tot = cum[cum.length - 1] || 1; sec = (v.min || 0) * 60 * Math.max(0, tot - progress) / tot; }
  return sec;
}
export { hav, bearing };
