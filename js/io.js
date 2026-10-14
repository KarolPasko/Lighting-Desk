// Clock, timecode inputs/outputs (MTC over Web MIDI, LTC over Web Audio)
// and the link to the Avolites bridge.

// ---------- clock ----------
// The show position comes from one of three sources. Internal is a transport
// you play and stop; MTC and LTC chase incoming timecode, filling in between
// incoming frames so the playhead moves smoothly.
class Clock {
  constructor() {
    this.source = 'internal';
    this.t0 = 0;           // internal: position when last started/located
    this.n0 = 0;
    this.running = false;
    this.ext = { tc: 0, at: 0, prevTc: 0, prevAt: 0, running: false, seen: false, rateKey: null };
  }

  setSource(source) {
    const now = performance.now();
    if (this.source === 'internal' && source !== 'internal') this.t0 = this.time(now);
    if (source === 'internal') { this.t0 = this.time(now); this.running = false; }
    this.source = source;
    this.ext.seen = false;
    this.ext.running = false;
  }

  // Called for every incoming timecode position (in seconds).
  external(tc, now, rateKey) {
    const e = this.ext;
    const gap = now - e.at;
    const advancing = e.seen && gap < 250 && tc > e.tc && tc - e.tc < 0.5;
    e.prevTc = e.tc; e.prevAt = e.at;
    e.tc = tc; e.at = now; e.seen = true; e.rateKey = rateKey;
    e.running = advancing;
  }

  extStatus(now) {
    const e = this.ext;
    if (!e.seen) return 'none';
    if (now - e.at > 400) return 'stopped';
    return e.running ? 'running' : 'held';
  }

  time(now = performance.now()) {
    if (this.source === 'internal') return this.running ? this.t0 + (now - this.n0) / 1000 : this.t0;
    const e = this.ext;
    if (!e.seen) return this.t0;
    if (e.running && now - e.at < 400) return e.tc + Math.min(now - e.at, 300) / 1000;
    return e.tc;
  }

  isRunning(now = performance.now()) {
    if (this.source === 'internal') return this.running;
    return this.ext.running && now - this.ext.at < 400;
  }

  play() { if (this.source !== 'internal' || this.running) return; this.n0 = performance.now(); this.running = true; }
  pause() { if (this.source !== 'internal' || !this.running) return; this.t0 = this.time(); this.running = false; }
  locate(t) {
    this.t0 = Math.max(0, t);
    this.n0 = performance.now();
  }
}

// ---------- MIDI ----------
class MidiIO {
  constructor(onChange) {
    this.access = null;
    this.input = null;
    this.output = null;
    this.onChange = onChange;
    this.onMessage = null;
    this.error = '';
    this.sysex = false;
  }

  get supported() { return typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess; }

  async enable() {
    if (!this.supported) { this.error = 'This browser has no Web MIDI. Use Chrome or Edge.'; return false; }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: true });
      this.sysex = true;
    } catch (_) {
      try {
        this.access = await navigator.requestMIDIAccess();
        this.sysex = false;
      } catch (err) {
        this.error = 'MIDI access was blocked. Allow MIDI for this page in the browser settings.';
        return false;
      }
    }
    this.error = '';
    this.access.onstatechange = () => this.onChange();
    return true;
  }

  inputs() { return this.access ? [...this.access.inputs.values()] : []; }
  outputs() { return this.access ? [...this.access.outputs.values()] : []; }

  selectInput(id) {
    if (this.input) this.input.onmidimessage = null;
    this.input = this.inputs().find(p => p.id === id) || null;
    if (this.input) this.input.onmidimessage = e => this.onMessage && this.onMessage(e.data, e.timeStamp);
  }

  selectOutput(id) { this.output = this.outputs().find(p => p.id === id) || null; }

  send(bytes, when) {
    if (!this.output) return;
    if (bytes[0] === 0xF0 && !this.sysex) return;
    try { this.output.send(bytes, when); } catch (_) {}
  }
}

// Sends MTC quarter frames that follow the clock, scheduled slightly ahead
// with MIDI timestamps so they go out evenly.
class MtcSender {
  constructor(midi) {
    this.midi = midi;
    this.enabled = false;
    this.q = null;           // next quarter-frame index to schedule
    this.wasRunning = false;
    this.lastFull = -1;
  }

  tick(clock, fps, now) {
    if (!this.enabled || !this.midi.output) { this.q = null; return; }
    const running = clock.isRunning(now);
    const t = clock.time(now);
    const qRate = fps.rate * 4;
    if (!running) {
      const frame = secondsToFrames(t, fps);
      if (this.wasRunning || frame !== this.lastFull) {
        this.midi.send(mtcFullFrame(framesToParts(frame, fps), fps.mtc), now);
        this.lastFull = frame;
      }
      this.wasRunning = false;
      this.q = null;
      return;
    }
    const nowQ = t * qRate;
    if (this.q === null || this.q < nowQ - qRate * 0.15 || this.q > nowQ + qRate * 0.3) {
      // Started or jumped: announce the position, then start a fresh set of pieces.
      const frame = secondsToFrames(t, fps);
      this.midi.send(mtcFullFrame(framesToParts(frame, fps), fps.mtc), now);
      this.q = Math.ceil(nowQ);
    }
    this.wasRunning = true;
    this.lastFull = -1;
    const horizon = t + 0.06;
    while (this.q / qRate <= horizon) {
      const frame = Math.floor(this.q / 4);
      const piece = (frame % 2) * 4 + (this.q % 4);
      const base = frame - (frame % 2);
      const when = Math.max(now, now + (this.q / qRate - t) * 1000);
      this.midi.send(mtcQuarterFrame(piece, framesToParts(base, fps), fps.mtc), when);
      this.q++;
    }
  }
}

// ---------- LTC through Web Audio ----------
class LtcIO {
  constructor() {
    this.ctxIn = null; this.ctxOut = null;
    this.nodeIn = null; this.nodeOut = null;
    this.stream = null;
    this.level = 0;
    this.onFrame = null;
    this.error = '';
    this.outDevice = '';
    this.workletUrl = null;
  }

  get supported() { return typeof AudioWorkletNode !== 'undefined'; }

  url() { return this.workletUrl || (this.workletUrl = buildLtcWorkletUrl()); }

  async startInput(deviceId) {
    await this.stopInput();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.ctxIn = new AudioContext({ latencyHint: 'interactive' });
      await this.ctxIn.audioWorklet.addModule(this.url());
      const src = this.ctxIn.createMediaStreamSource(this.stream);
      this.nodeIn = new AudioWorkletNode(this.ctxIn, 'ltc-in', { numberOfOutputs: 0 });
      this.nodeIn.port.onmessage = e => {
        if (e.data.type === 'level') this.level = e.data.level;
        else if (e.data.type === 'frame' && this.onFrame) this.onFrame(e.data.frame);
      };
      src.connect(this.nodeIn);
      this.error = '';
      return true;
    } catch (err) {
      this.error = err.name === 'NotAllowedError'
        ? 'Audio input was blocked. Allow the microphone for this page to read LTC.'
        : 'Could not open the audio input: ' + err.message;
      await this.stopInput();
      return false;
    }
  }

  async stopInput() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.ctxIn) { try { await this.ctxIn.close(); } catch (_) {} }
    this.stream = null; this.ctxIn = null; this.nodeIn = null; this.level = 0;
  }

  async startOutput(deviceId, fps, gain) {
    await this.stopOutput();
    try {
      this.ctxOut = new AudioContext({ latencyHint: 'interactive' });
      if (deviceId && this.ctxOut.setSinkId) await this.ctxOut.setSinkId(deviceId);
      await this.ctxOut.audioWorklet.addModule(this.url());
      this.nodeOut = new AudioWorkletNode(this.ctxOut, 'ltc-out', { numberOfInputs: 0, outputChannelCount: [2] });
      this.nodeOut.connect(this.ctxOut.destination);
      this.nodeOut.port.postMessage({ fps: { rate: fps.rate, nominal: fps.nominal, drop: fps.drop }, gain });
      this.outFpsKey = fps.key;
      if (this.ctxOut.state === 'suspended') await this.ctxOut.resume();
      this.error = '';
      return true;
    } catch (err) {
      this.error = 'Could not start LTC output: ' + err.message;
      await this.stopOutput();
      return false;
    }
  }

  async stopOutput() {
    if (this.ctxOut) { try { await this.ctxOut.close(); } catch (_) {} }
    this.ctxOut = null; this.nodeOut = null;
  }

  // Keep the generator in step with the clock. It runs on the audio clock and
  // only jumps when it's more than two frames out.
  sync(clock, fps, gain, now) {
    if (!this.nodeOut) return;
    const msg = { running: clock.isRunning(now), gain };
    if (this.outFpsKey !== fps.key) {
      msg.fps = { rate: fps.rate, nominal: fps.nominal, drop: fps.drop };
      this.outFpsKey = fps.key;
    }
    const latency = (this.ctxOut.outputLatency || this.ctxOut.baseLatency || 0);
    msg.frame = secondsToFrames(clock.time(now) + latency, fps);
    this.nodeOut.port.postMessage(msg);
  }
}

// ---------- Avolites bridge ----------
class TitanLink {
  constructor(onState) {
    this.onState = onState;
    this.state = null;      // last state from the bridge
    this.reachable = false;
    this.base = '';
    this.es = null;
  }

  static defaultBase() {
    return location.protocol.startsWith('http') ? location.origin : 'http://localhost:8080';
  }

  connect(base) {
    this.base = (base || TitanLink.defaultBase()).replace(/\/+$/, '');
    if (this.es) this.es.close();
    try {
      this.es = new EventSource(this.base + '/api/events');
    } catch (_) {
      this.reachable = false; this.onState(); return;
    }
    this.es.onmessage = e => {
      try { this.state = JSON.parse(e.data); } catch (_) { return; }
      this.reachable = true;
      this.onState();
    };
    this.es.onerror = () => { this.reachable = false; this.onState(); };
  }

  async post(path, body) {
    const res = await fetch(this.base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Bridge replied HTTP ${res.status}`);
    return data;
  }

  go(userNumber, cue) { return this.post('/api/titan/go', { userNumber, cue: cue || null }); }
  configure(cfg) { return this.post('/api/titan/config', cfg); }

  cueLists() { return (this.state && this.state.cueLists) || []; }
}
