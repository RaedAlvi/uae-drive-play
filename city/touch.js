// Phone and tablet controls, laid out like a handheld console: steering pad under the left thumb, gas and
// brake under the right, small buttons along the top. Every button sends the same keyboard events the game
// already listens for (ArrowLeft, w, s, space, c, m, r, Escape), so the engine needs no touch code.
// Shown on touch screens only (or with ?touch=1 for testing on a desktop).
const want = matchMedia("(pointer: coarse)").matches || "ontouchstart" in window || /[?&]touch=1/.test(location.search);
if (want) setup();

function send(type, key) { dispatchEvent(new KeyboardEvent(type, { key, bubbles: true })); }

function setup() {
  document.documentElement.classList.add("touch");
  const meta = document.querySelector('meta[name="viewport"]');
  if (meta) meta.content = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";
  const css = document.createElement("style");
  css.textContent = `
  html.touch, html.touch body { touch-action: none; overscroll-behavior: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
  #tc { position: fixed; inset: 0; z-index: 900; pointer-events: none; display: none; font: 700 15px/1 "Segoe UI", system-ui, sans-serif; }
  #tc.on { display: block; }
  #tc .b { position: absolute; pointer-events: auto; touch-action: none; display: grid; place-items: center; color: #fff;
    background: rgba(14,17,22,.42); border: 2px solid rgba(255,255,255,.55); box-shadow: 0 4px 14px rgba(0,0,0,.35); backdrop-filter: blur(3px); }
  #tc .b.down { background: rgba(240,180,41,.75); border-color: #fff; transform: scale(.96); }
  #tc .pad { position: absolute; left: max(18px, env(safe-area-inset-left)); bottom: max(18px, env(safe-area-inset-bottom)); width: 236px; height: 104px; pointer-events: none; }
  #tc .pad .b { top: 0; width: 108px; height: 104px; border-radius: 22px; font-size: 38px; }
  #tc .pad .l { left: 0; } #tc .pad .r { right: 0; }
  #tc .gas { right: max(22px, env(safe-area-inset-right)); bottom: max(26px, env(safe-area-inset-bottom)); width: 112px; height: 112px; border-radius: 50%; font-size: 17px; background: rgba(22,163,74,.55); }
  #tc .brk { right: calc(max(22px, env(safe-area-inset-right)) + 124px); bottom: max(18px, env(safe-area-inset-bottom)); width: 92px; height: 92px; border-radius: 50%; font-size: 15px; background: rgba(220,38,38,.5); }
  #tc .hb { right: calc(max(22px, env(safe-area-inset-right)) + 40px); bottom: calc(max(26px, env(safe-area-inset-bottom)) + 124px); width: 64px; height: 44px; border-radius: 12px; font-size: 12px; }
  #tc .top { top: max(10px, env(safe-area-inset-top)); right: max(10px, env(safe-area-inset-right)); display: flex; gap: 8px; pointer-events: none; position: absolute; }
  #tc .top .b { position: static; width: 46px; height: 40px; border-radius: 10px; font-size: 13px; }
  #rot { position: fixed; inset: 0; z-index: 2000; background: #0e1116; color: #eef2f7; display: none; place-items: center; text-align: center; font: 600 18px/1.4 "Segoe UI", system-ui, sans-serif; padding: 24px; }
  @media (orientation: portrait) { html.touch #rot.on { display: grid; } }
  /* the game's own panels, sized for a phone */
  @media (max-width: 900px), (max-height: 520px) {
    html.touch #menu .panel, html.touch #pause .panel { width: min(96vw, 620px) !important; max-height: 92vh; overflow: auto; -webkit-overflow-scrolling: touch; touch-action: pan-y; }
    html.touch #nav { width: 300px !important; transform: scale(.82); transform-origin: top left; }
    html.touch #mini { width: 150px !important; height: 150px !important; bottom: auto !important; top: 58px !important; right: 10px !important; }
    html.touch #keys { display: none !important; }
    html.touch #speed { bottom: auto !important; top: 12px !important; left: auto !important; right: 290px !important; transform: scale(.8); transform-origin: top right; }
    html.touch #bottomc { bottom: 132px !important; transform: translateX(-50%) scale(.85) !important; }
  }
  /* phones held sideways (short screens): compact controls and a HUD that keeps the road clear */
  @media (max-height: 460px) {
    #tc .pad { left: max(10px, env(safe-area-inset-left)); bottom: max(10px, env(safe-area-inset-bottom)); width: 136px; height: 56px; }
    #tc .pad .b { width: 64px; height: 56px; border-radius: 14px; font-size: 22px; }
    #tc .gas { right: max(12px, env(safe-area-inset-right)); bottom: max(12px, env(safe-area-inset-bottom)); width: 70px; height: 70px; font-size: 13px; }
    #tc .brk { right: calc(max(12px, env(safe-area-inset-right)) + 78px); bottom: max(10px, env(safe-area-inset-bottom)); width: 56px; height: 56px; font-size: 11px; }
    #tc .hb { right: calc(max(12px, env(safe-area-inset-right)) + 78px); bottom: calc(max(10px, env(safe-area-inset-bottom)) + 64px); width: 56px; height: 26px; border-radius: 8px; font-size: 10px; }
    #tc .top { top: max(6px, env(safe-area-inset-top)); right: max(8px, env(safe-area-inset-right)); gap: 5px; }
    #tc .top .b { width: 34px; height: 28px; border-radius: 8px; font-size: 10px; border-width: 1.5px; }
    #tc .b { border-width: 1.5px; }
    html.touch #nav { width: 330px !important; top: 6px !important; left: max(6px, env(safe-area-inset-left)) !important; transform: scale(.56) !important; transform-origin: top left; }
    html.touch #speed { top: 6px !important; bottom: auto !important; left: auto !important; right: calc(max(8px, env(safe-area-inset-right)) + 200px) !important; transform: scale(.55) !important; transform-origin: top right; }
    html.touch #mini:not(.big) { top: 42px !important; right: max(8px, env(safe-area-inset-right)) !important; bottom: auto !important; width: 92px !important; height: 92px !important; border-width: 2px !important; border-radius: 12px !important; }
    html.touch #bottomc { bottom: max(4px, env(safe-area-inset-bottom)) !important; transform: translateX(-50%) scale(.6) !important; transform-origin: bottom center; gap: 3px !important; }
  }`;
  document.head.appendChild(css);

  const tc = document.createElement("div"); tc.id = "tc";
  tc.innerHTML = `
    <div class="pad"><div class="b l" data-k="ArrowLeft">&#9664;</div><div class="b r" data-k="ArrowRight">&#9654;</div></div>
    <div class="b brk" data-k="ArrowDown">BRAKE</div>
    <div class="b gas" data-k="ArrowUp">GAS</div>
    <div class="b hb" data-k=" ">HAND</div>
    <div class="top">
      <div class="b" data-tap="c" title="Camera">CAM</div>
      <div class="b" data-tap="m" title="Big map">MAP</div>
      <div class="b" data-tap="r" title="Back on the road">R</div>
      <div class="b" data-tap="Escape" title="Pause">II</div>
      <div class="b" data-full="1" title="Full screen">&#x26F6;</div>
    </div>`;
  document.body.appendChild(tc);
  const rot = document.createElement("div"); rot.id = "rot";
  rot.innerHTML = `<div><div style="font-size:54px;margin-bottom:10px">&#x21BB;</div>Turn your phone sideways to drive.<br><span style="opacity:.7;font-size:14px">Tip: tap &#x26F6; for full screen.</span></div>`;
  document.body.appendChild(rot);

  // hold buttons: any finger that presses, slides onto, or leaves a button counts (multi-touch)
  const held = new Map();                       // pointerId -> key
  const count = {};                             // key -> fingers holding it
  const press = (k, el) => { count[k] = (count[k] || 0) + 1; if (count[k] === 1) send("keydown", k); el && el.classList.add("down"); };
  const release = (k) => { if (!count[k]) return; count[k]--; if (!count[k]) { send("keyup", k); tc.querySelectorAll(`[data-k="${CSS.escape(k)}"]`).forEach(e => e.classList.remove("down")); } };
  const holdAt = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.closest && el.closest("[data-k]"); };
  tc.addEventListener("pointerdown", e => {
    const t = e.target.closest("[data-k],[data-tap],[data-full]"); if (!t) return;
    e.preventDefault();
    if (t.dataset.tap) { send("keydown", t.dataset.tap); send("keyup", t.dataset.tap); t.classList.add("down"); setTimeout(() => t.classList.remove("down"), 140); if (navigator.vibrate) navigator.vibrate(8); return; }
    if (t.dataset.full) { const d = document.documentElement; (document.fullscreenElement ? document.exitFullscreen() : (d.requestFullscreen || d.webkitRequestFullscreen || (() => {})).call(d))?.catch?.(() => {}); try { screen.orientation.lock("landscape").catch(() => {}); } catch (_) {} return; }
    try { tc.setPointerCapture(e.pointerId); } catch (_) {}
    held.set(e.pointerId, t.dataset.k); press(t.dataset.k, t);
    if (navigator.vibrate) navigator.vibrate(6);
  });
  tc.addEventListener("pointermove", e => {
    if (!held.has(e.pointerId)) return;
    const t = holdAt(e.clientX, e.clientY); const k = t ? t.dataset.k : null, old = held.get(e.pointerId);
    if (k && k !== old) { release(old); held.set(e.pointerId, k); press(k, t); }      // slide a thumb from left to right
  });
  const end = e => { if (!held.has(e.pointerId)) return; release(held.get(e.pointerId)); held.delete(e.pointerId); };
  tc.addEventListener("pointerup", end); tc.addEventListener("pointercancel", end); tc.addEventListener("lostpointercapture", end);
  addEventListener("blur", () => { for (const k of Object.keys(count)) { count[k] = 1; release(k); } held.clear(); });

  // show the pads only while driving; the menus stay fully tappable
  const hud = document.getElementById("hud");
  const sync = () => { const driving = hud && !hud.hidden && document.getElementById("pause")?.hidden !== false; tc.classList.toggle("on", !!driving); rot.classList.toggle("on", !!driving); };
  new MutationObserver(sync).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden"] });
  sync();
}
