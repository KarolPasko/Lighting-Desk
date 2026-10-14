// LTC (SMPTE linear timecode) as audio.
// LtcEncoder and LtcDecoder are plain classes with no browser APIs so they can be
// tested in Node. The browser runs them inside an AudioWorklet built from their
// source text (see buildLtcWorkletUrl), which also works when the page is opened
// straight from disk.

// Sync word, in transmission order, bits 64-79 of every frame.
const LTC_SYNC = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];

class LtcEncoder {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.nominal = 25;
    this.rate = 25;
    this.drop = false;
    this.frame = 0;            // frame number currently being written
    this.labelFn = null;       // frame number -> {h,m,s,f}
    this.bits = null;
    this.bitIndex = 80;
    this.phase = 0;            // position inside the current bit, 0..1
    this.level = 0.5;
    this.halfDone = false;
    this.running = false;
    this.amplitude = 0.5;
  }

  configure(rate, nominal, drop) { this.rate = rate; this.nominal = nominal; this.drop = drop; }

  static frameBits(p, nominal, drop) {
    const b = new Array(80).fill(0);
    const put = (start, count, value) => { for (let i = 0; i < count; i++) b[start + i] = (value >> i) & 1; };
    put(0, 4, p.f % 10);  put(8, 2, Math.floor(p.f / 10));
    b[10] = drop ? 1 : 0;
    put(16, 4, p.s % 10); put(24, 3, Math.floor(p.s / 10));
    put(32, 4, p.m % 10); put(40, 3, Math.floor(p.m / 10));
    put(48, 4, p.h % 10); put(56, 2, Math.floor(p.h / 10));
    for (let i = 0; i < 16; i++) b[64 + i] = LTC_SYNC[i];
    // Polarity correction bit keeps the count of zero bits even.
    const polarityBit = nominal === 25 ? 59 : 27;
    let zeros = 0;
    for (let i = 0; i < 80; i++) if (i !== polarityBit && b[i] === 0) zeros++;
    b[polarityBit] = zeros % 2 === 0 ? 1 : 0;
    return b;
  }

  loadFrame() {
    const p = this.labelFn(this.frame);
    this.bits = LtcEncoder.frameBits(p, this.nominal, this.drop);
    this.bitIndex = 0;
  }

  // Fill a block of samples. Writes silence while stopped.
  render(out) {
    if (!this.running || !this.labelFn) { out.fill(0); return; }
    const step = (80 * this.rate) / this.sampleRate; // bits per sample
    for (let i = 0; i < out.length; i++) {
      if (this.bitIndex >= 80) this.loadFrame();
      out[i] = this.level * this.amplitude * 2;
      this.phase += step;
      if (!this.halfDone && this.phase >= 0.5) {
        this.halfDone = true;
        if (this.bits[this.bitIndex] === 1) this.level = -this.level;
      }
      if (this.phase >= 1) {
        this.phase -= 1;
        this.halfDone = false;
        this.bitIndex++;
        if (this.bitIndex >= 80) this.frame++;
        this.level = -this.level; // every bit starts with a transition
      }
    }
  }
}

class LtcDecoder {
  constructor(sampleRate, onFrame) {
    this.sampleRate = sampleRate;
    this.onFrame = onFrame;
    this.period = sampleRate / (80 * 27.5); // samples per bit, adapts as it locks
    this.sign = 0;
    this.count = 0;
    this.peak = 0.05;
    this.halfPending = false;
    this.bits = new Uint8Array(80);
    this.filled = 0;
  }

  pushBit(bit) {
    this.bits.copyWithin(0, 1);
    this.bits[79] = bit;
    if (this.filled < 80) this.filled++;
    if (this.filled < 80) return;
    for (let i = 0; i < 16; i++) if (this.bits[64 + i] !== LTC_SYNC[i]) return;
    const b = this.bits;
    const get = (start, count) => { let v = 0; for (let i = 0; i < count; i++) v |= b[start + i] << i; return v; };
    const f = get(0, 4) + 10 * get(8, 2);
    const s = get(16, 4) + 10 * get(24, 3);
    const m = get(32, 4) + 10 * get(40, 3);
    const h = get(48, 4) + 10 * get(56, 2);
    if (f > 29 || s > 59 || m > 59 || h > 23) return;
    const fps = this.sampleRate / (80 * this.period);
    this.onFrame({ h, m, s, f, drop: b[10] === 1, fps });
  }

  process(samples) {
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      const ax = x < 0 ? -x : x;
      this.peak = ax > this.peak ? ax : this.peak * 0.99995;
      const th = Math.max(0.004, this.peak * 0.25);
      this.count++;
      let s = this.sign;
      if (x > th) s = 1; else if (x < -th) s = -1;
      if (s === this.sign) continue;
      const prev = this.sign;
      this.sign = s;
      if (prev === 0) { this.count = 0; continue; }
      const len = this.count;
      this.count = 0;
      if (len > this.period * 2.5 || len < this.period * 0.2) { // noise or silence
        this.halfPending = false;
        continue;
      }
      if (len < this.period * 0.75) {
        this.period += (len * 2 - this.period) * 0.05;
        if (this.halfPending) { this.halfPending = false; this.pushBit(1); }
        else this.halfPending = true;
      } else {
        this.period += (len - this.period) * 0.05;
        this.halfPending = false;
        this.pushBit(0);
      }
    }
  }
}

// AudioWorklet: port messages in, samples out (encoder) / frames out (decoder).
function ltcWorkletSource() {
  return `
${'const LTC_SYNC = ' + JSON.stringify(LTC_SYNC) + ';'}
${LtcEncoder.toString()}
${LtcDecoder.toString()}
${framesToParts.toString()}
${framesPerDay.toString()}

class LtcOutProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enc = new LtcEncoder(sampleRate);
    this.port.onmessage = e => {
      const d = e.data;
      if (d.fps) {
        this.fps = d.fps;
        this.enc.configure(d.fps.rate, d.fps.nominal, d.fps.drop);
        this.enc.labelFn = fn => framesToParts(fn, this.fps);
      }
      if (d.gain !== undefined) this.enc.amplitude = d.gain;
      if (d.running !== undefined) {
        const was = this.enc.running;
        this.enc.running = d.running;
        if (d.running && (!was || Math.abs(d.frame - this.enc.frame) > 2)) {
          this.enc.frame = d.frame;
          this.enc.bitIndex = 80;
          this.enc.phase = 0;
          this.enc.halfDone = false;
        }
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    this.enc.render(out[0]);
    for (let c = 1; c < out.length; c++) out[c].set(out[0]);
    return true;
  }
}

class LtcInProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.level = 0;
    this.n = 0;
    this.dec = new LtcDecoder(sampleRate, fr => this.port.postMessage({ type: 'frame', frame: fr, t: currentTime }));
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.dec.process(ch);
      let pk = 0;
      for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > pk) pk = a; }
      this.level = Math.max(pk, this.level * 0.95);
      if (++this.n % 20 === 0) this.port.postMessage({ type: 'level', level: this.level });
    }
    return true;
  }
}
registerProcessor('ltc-out', LtcOutProcessor);
registerProcessor('ltc-in', LtcInProcessor);
`;
}

function buildLtcWorkletUrl() {
  // Pages opened straight from disk can't load worklets from blob: URLs; a data: URL works there.
  if (location.protocol === 'file:') return 'data:text/javascript;base64,' + btoa(unescape(encodeURIComponent(ltcWorkletSource())));
  return URL.createObjectURL(new Blob([ltcWorkletSource()], { type: 'application/javascript' }));
}

if (typeof module !== 'undefined') module.exports = { LtcEncoder, LtcDecoder, LTC_SYNC, ltcWorkletSource };
