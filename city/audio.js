// Synthesised car audio (Web Audio, no samples): an engine whose pitch follows RPM through a
// simple six-speed gearbox, tyre squeal under the handbrake, a low road rumble and a little wind at
// speed, a horn, and a soft crash thump. Starts on the first key press (browser autoplay rules).
// Tuned to sit under the game, not over it: rounded waveforms through a gentle low-pass, brown (deep)
// noise instead of white hiss for road and wind, and a compressor on the master so nothing spikes.
export class CarAudio {
  constructor() { this.ctx = null; this.on = true; this.vol = 1; this.gear = 1; this.rpm = 900; this.hornOn = false; }
  start() {
    if (this.ctx || !this.on) return;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const c = this.ctx = new AC();
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -22; comp.knee.value = 18; comp.ratio.value = 4; comp.attack.value = 0.01; comp.release.value = 0.25;
    comp.connect(c.destination);
    this.master = c.createGain(); this.master.gain.value = this.level(); this.master.connect(comp);
    // engine: a sine at the firing frequency, a triangle sub an octave down and a quiet saw for texture,
    // through a soft low-pass and a light saturation
    this.eng = c.createGain(); this.eng.gain.value = 0;
    this.lp = c.createBiquadFilter(); this.lp.type = "lowpass"; this.lp.frequency.value = 600; this.lp.Q.value = 0.7;
    const shaper = c.createWaveShaper(); const curve = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(1.3 * x); } shaper.curve = curve;
    this.o1 = c.createOscillator(); this.o1.type = "sine";
    this.o2 = c.createOscillator(); this.o2.type = "triangle";
    this.o3 = c.createOscillator(); this.o3.type = "sawtooth";
    const g1 = c.createGain(); g1.gain.value = 0.8; const g2 = c.createGain(); g2.gain.value = 0.7; const g3 = c.createGain(); g3.gain.value = 0.12;
    this.o1.connect(g1); this.o2.connect(g2); this.o3.connect(g3);
    for (const g of [g1, g2, g3]) g.connect(this.lp);
    this.lp.connect(shaper); shaper.connect(this.eng); this.eng.connect(this.master);
    for (const o of [this.o1, this.o2, this.o3]) o.start();
    // brown noise (integrated white noise): a deep rumble rather than a hiss
    const len = c.sampleRate * 3, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    const noise = c.createBufferSource(); noise.buffer = buf; noise.loop = true; noise.start();
    this.wind = c.createGain(); this.wind.gain.value = 0; const wf = c.createBiquadFilter(); wf.type = "lowpass"; wf.frequency.value = 700; wf.Q.value = 0.5;
    noise.connect(wf); wf.connect(this.wind); this.wind.connect(this.master);
    this.road = c.createGain(); this.road.gain.value = 0; const rf = c.createBiquadFilter(); rf.type = "lowpass"; rf.frequency.value = 160;
    noise.connect(rf); rf.connect(this.road); this.road.connect(this.master);
    // tyre squeal: a narrow band of white noise, only under the handbrake or hard cornering
    const wbuf = c.createBuffer(1, c.sampleRate, c.sampleRate), wd = wbuf.getChannelData(0);
    for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
    const white = c.createBufferSource(); white.buffer = wbuf; white.loop = true; white.start();
    this.sq = c.createGain(); this.sq.gain.value = 0; const sf = c.createBiquadFilter(); sf.type = "bandpass"; sf.frequency.value = 2200; sf.Q.value = 12;
    white.connect(sf); sf.connect(this.sq); this.sq.connect(this.master);
    // horn: two tones (the classic car horn interval), rounded off
    this.horn = c.createGain(); this.horn.gain.value = 0;
    for (const f of [415, 494]) { const o = c.createOscillator(); o.type = "square"; o.frequency.value = f; const hf = c.createBiquadFilter(); hf.type = "lowpass"; hf.frequency.value = 1300; o.connect(hf); hf.connect(this.horn); o.start(); }
    this.horn.connect(this.master);
  }
  level() { return this.on ? 0.42 * this.vol : 0; }
  setEnabled(on) { this.on = on; if (this.ctx) this.master.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.05); }
  setVolume(v) { this.vol = v; if (this.ctx) this.master.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.05); }
  // speed in m/s (signed), throttle 0/1, handbrake bool, steering -1..1
  update(dt, v, throttle, handbrake, steer, running) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime, sp = Math.abs(v);
    // gearbox: shift up at 5800 rpm, down at 2400
    const ratios = [0, 3.4, 2.3, 1.7, 1.3, 1.05, 0.86];
    const wheelRpm = sp / 0.34 * 60 / (2 * Math.PI) * 3.7;
    let rpm = wheelRpm * ratios[this.gear];
    if (rpm > 5800 && this.gear < 6) { this.gear++; rpm = wheelRpm * ratios[this.gear]; }
    else if (rpm < 2400 && this.gear > 1) { this.gear--; rpm = wheelRpm * ratios[this.gear]; }
    rpm = Math.max(850 + (throttle ? 700 : 0) * (sp < 1 ? 1 : 0), rpm);
    this.rpm += (rpm - this.rpm) * Math.min(1, dt * 6);
    const f = this.rpm / 60 * 2;                      // firing frequency of a 4-stroke four (x2 per rev)
    this.o1.frequency.setTargetAtTime(f, t, 0.06); this.o2.frequency.setTargetAtTime(f / 2, t, 0.06); this.o3.frequency.setTargetAtTime(f * 1.003, t, 0.06);
    this.lp.frequency.setTargetAtTime(380 + this.rpm * 0.16 + (throttle ? 350 : 0), t, 0.1);
    const vol = running ? (0.09 + (throttle ? 0.07 : 0.02) + Math.min(0.05, this.rpm / 140000)) : 0;
    this.eng.gain.setTargetAtTime(vol, t, 0.12);
    this.wind.gain.setTargetAtTime(running && sp > 14 ? Math.min(0.06, (sp - 14) * (sp - 14) / 16000) : 0, t, 0.4);
    this.road.gain.setTargetAtTime(running ? Math.min(0.14, sp / 200) : 0, t, 0.3);
    const squeal = running && sp > 6 && (handbrake || Math.abs(steer) > 0.9 && sp > 24) ? Math.min(0.05, sp / 600) : 0;
    this.sq.gain.setTargetAtTime(squeal, t, 0.08);
    this.horn.gain.setTargetAtTime(this.hornOn && running ? 0.07 : 0, t, 0.02);
  }
  crash(strength) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(); o.type = "sine"; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    const g = c.createGain(); g.gain.setValueAtTime(Math.min(0.4, 0.1 + strength / 60), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.4);
  }
}
