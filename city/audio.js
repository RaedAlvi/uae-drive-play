// Synthesised car audio (Web Audio, no samples): an engine whose pitch follows RPM through a
// simple six-speed gearbox, tyre squeal under the handbrake, wind and road noise at speed,
// a horn, and a soft crash thump. Starts on the first key press (browser autoplay rules).
export class CarAudio {
  constructor() { this.ctx = null; this.on = true; this.gear = 1; this.rpm = 900; this.hornOn = false; }
  start() {
    if (this.ctx || !this.on) return;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const c = this.ctx = new AC();
    this.master = c.createGain(); this.master.gain.value = 0.55; this.master.connect(c.destination);
    // engine: two detuned saws + a sub square through a lowpass, with a little distortion
    this.eng = c.createGain(); this.eng.gain.value = 0;
    this.lp = c.createBiquadFilter(); this.lp.type = "lowpass"; this.lp.frequency.value = 900; this.lp.Q.value = 3;
    const shaper = c.createWaveShaper(); const curve = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(2.2 * x); } shaper.curve = curve;
    this.o1 = c.createOscillator(); this.o1.type = "sawtooth";
    this.o2 = c.createOscillator(); this.o2.type = "sawtooth"; this.o2.detune.value = 18;
    this.o3 = c.createOscillator(); this.o3.type = "square";
    const g3 = c.createGain(); g3.gain.value = 0.35;
    this.o1.connect(this.lp); this.o2.connect(this.lp); this.o3.connect(g3); g3.connect(this.lp);
    this.lp.connect(shaper); shaper.connect(this.eng); this.eng.connect(this.master);
    for (const o of [this.o1, this.o2, this.o3]) o.start();
    // noise source shared by wind, road and squeal
    const len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = c.createBufferSource(); noise.buffer = buf; noise.loop = true; noise.start();
    this.wind = c.createGain(); this.wind.gain.value = 0; const wf = c.createBiquadFilter(); wf.type = "bandpass"; wf.frequency.value = 600; wf.Q.value = 0.6;
    noise.connect(wf); wf.connect(this.wind); this.wind.connect(this.master);
    this.road = c.createGain(); this.road.gain.value = 0; const rf = c.createBiquadFilter(); rf.type = "lowpass"; rf.frequency.value = 220;
    noise.connect(rf); rf.connect(this.road); this.road.connect(this.master);
    this.sq = c.createGain(); this.sq.gain.value = 0; const sf = c.createBiquadFilter(); sf.type = "bandpass"; sf.frequency.value = 2600; sf.Q.value = 9;
    noise.connect(sf); sf.connect(this.sq); this.sq.connect(this.master);
    // horn: two square tones (the classic car horn interval)
    this.horn = c.createGain(); this.horn.gain.value = 0;
    for (const f of [415, 494]) { const o = c.createOscillator(); o.type = "square"; o.frequency.value = f; const hf = c.createBiquadFilter(); hf.type = "lowpass"; hf.frequency.value = 1800; o.connect(hf); hf.connect(this.horn); o.start(); }
    this.horn.connect(this.master);
  }
  setEnabled(on) { this.on = on; if (this.ctx) this.master.gain.value = on ? 0.55 : 0; }
  // speed in m/s (signed), throttle 0/1, handbrake bool, steering -1..1
  update(dt, v, throttle, handbrake, steer, running) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime, sp = Math.abs(v);
    // gearbox: shift up at 6200 rpm, down at 2600
    const ratios = [0, 3.4, 2.3, 1.7, 1.3, 1.05, 0.86];
    const wheelRpm = sp / 0.34 * 60 / (2 * Math.PI) * 3.7;
    let rpm = wheelRpm * ratios[this.gear];
    if (rpm > 6200 && this.gear < 6) { this.gear++; rpm = wheelRpm * ratios[this.gear]; }
    else if (rpm < 2600 && this.gear > 1) { this.gear--; rpm = wheelRpm * ratios[this.gear]; }
    rpm = Math.max(850 + (throttle ? 900 : 0) * (sp < 1 ? 1 : 0), rpm);
    this.rpm += (rpm - this.rpm) * Math.min(1, dt * 9);
    const f = this.rpm / 60 * 2;                      // firing frequency of a 4-stroke four (x2 per rev)
    this.o1.frequency.setTargetAtTime(f, t, 0.03); this.o2.frequency.setTargetAtTime(f * 1.005, t, 0.03); this.o3.frequency.setTargetAtTime(f / 2, t, 0.03);
    this.lp.frequency.setTargetAtTime(500 + this.rpm * 0.35 + (throttle ? 900 : 0), t, 0.05);
    const vol = running ? (0.07 + (throttle ? 0.1 : 0.03) + Math.min(0.08, this.rpm / 90000)) : 0;
    this.eng.gain.setTargetAtTime(vol, t, 0.08);
    this.wind.gain.setTargetAtTime(running ? Math.min(0.22, sp * sp / 9000) : 0, t, 0.2);
    this.road.gain.setTargetAtTime(running ? Math.min(0.25, sp / 120) : 0, t, 0.2);
    const squeal = running && sp > 6 && (handbrake || Math.abs(steer) > 0.85 && sp > 22) ? Math.min(0.12, sp / 300) : 0;
    this.sq.gain.setTargetAtTime(squeal, t, 0.05);
    this.horn.gain.setTargetAtTime(this.hornOn && running ? 0.09 : 0, t, 0.02);
  }
  crash(strength) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(); o.type = "sine"; o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    const g = c.createGain(); g.gain.setValueAtTime(Math.min(0.6, 0.15 + strength / 40), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.4);
  }
}
