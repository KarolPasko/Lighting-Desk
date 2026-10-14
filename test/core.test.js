// Run with: node test/core.test.js
// Loads the browser scripts into one context, the way the page does.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = { console, module: undefined, URL, Blob: class {} };
vm.createContext(ctx);
for (const f of ['timecode.js', 'ltc.js', 'mtc.js', 'export.js']) {
  const file = path.join(__dirname, '..', 'js', f);
  if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: f });
}
const T = new Proxy({}, { get: (_, name) => vm.runInContext(String(name), ctx) });
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }

test('frame round trip, all rates', () => {
  for (const key of Object.keys(vm.runInContext('FPS_OPTIONS', ctx))) {
    const fps = T.fpsInfo(key);
    for (let fn = 0; fn < T.framesPerDay(fps); fn += 997) {
      assert.strictEqual(T.partsToFrames(T.framesToParts(fn, fps), fps), fn, `${key} ${fn}`);
    }
  }
});

test('drop frame skips ;00 and ;01 except every tenth minute', () => {
  const df = T.fpsInfo('29.97df');
  assert.strictEqual(T.formatParts(T.framesToParts(1799, df), df), '00:00:59;29');
  assert.strictEqual(T.formatParts(T.framesToParts(1800, df), df), '00:01:00;02');
  assert.strictEqual(T.formatParts(T.framesToParts(17982, df), df), '00:10:00;00');
  assert.strictEqual(T.formatTC(3600, df), '01:00:00;00');
});

test('parse and format', () => {
  const f25 = T.fpsInfo('25');
  assert.strictEqual(T.formatTC(T.parseTC('01:02:03:04', f25), f25), '01:02:03:04');
  assert.strictEqual(T.parseTC('1:00', f25), 1);
  assert.strictEqual(T.parseTC('62.5', f25), 62.5);
  assert.strictEqual(T.parseTC('00:00:00:25', f25), null);
  assert.strictEqual(T.parseTC('abc', f25), null);
  assert.strictEqual(T.formatCountdown(65.25), '1:05.3');
});

function ltcRoundTrip(key, sr, startLabel, frames, noise) {
  const fps = T.fpsInfo(key);
  const enc = new T.LtcEncoder(sr);
  enc.configure(fps.rate, fps.nominal, fps.drop);
  enc.labelFn = fn => T.framesToParts(fn, fps);
  const start = T.partsToFrames(startLabel, fps);
  enc.frame = start;
  enc.running = true;
  const got = [];
  const dec = new T.LtcDecoder(sr, fr => got.push(fr));
  const buf = new Float32Array(128);
  const total = Math.ceil((frames / fps.rate) * sr / 128);
  for (let i = 0; i < total; i++) {
    enc.render(buf);
    if (noise) for (let j = 0; j < buf.length; j++) buf[j] = buf[j] * 0.3 + (Math.random() - 0.5) * noise;
    dec.process(buf);
  }
  assert.ok(got.length >= frames - 3, `${key}@${sr}: decoded ${got.length} of ${frames}`);
  // Frames must count up one at a time from the start label.
  const first = T.partsToFrames(got[0], fps);
  got.forEach((fr, i) => assert.strictEqual(T.partsToFrames(fr, fps), first + i, `${key} frame ${i}`));
  assert.ok(first - start <= 2, `${key} locked late (${first - start} frames)`);
  assert.strictEqual(got[0].drop, fps.drop);
  assert.ok(Math.abs(got[got.length - 1].fps - fps.rate) < 0.3, `${key} rate estimate ${got[got.length - 1].fps}`);
}

test('LTC encode -> decode at every rate, 48 kHz and 44.1 kHz', () => {
  for (const key of ['24', '25', '29.97df', '30']) for (const sr of [48000, 44100]) {
    ltcRoundTrip(key, sr, { h: 1, m: 9, s: 59, f: 20 }, 60, 0);
  }
});

test('LTC decodes through noise at low level', () => {
  ltcRoundTrip('25', 48000, { h: 10, m: 0, s: 0, f: 0 }, 50, 0.05);
});

test('MTC quarter frames and full frame round trip', () => {
  for (const key of ['24', '25', '29.97df', '30']) {
    const fps = T.fpsInfo(key);
    const p = { h: 13, m: 47, s: 29, f: fps.nominal - 2 };
    const seen = [];
    const dec = new T.MtcDecoder((t, offset) => seen.push([t, offset]));
    for (let q = 0; q < 8; q++) dec.handle(T.mtcQuarterFrame(q, p, fps.mtc));
    dec.handle(T.mtcFullFrame(p, fps.mtc));
    assert.strictEqual(seen.length, 2);
    for (const [t, off] of seen) {
      assert.deepStrictEqual([t.h, t.m, t.s, t.f, t.rateKey], [p.h, p.m, p.s, p.f, key]);
    }
    assert.strictEqual(seen[0][1], 2);
    assert.strictEqual(seen[1][1], 0);
  }
});

if (fs.existsSync(path.join(__dirname, '..', 'js', 'export.js'))) {
  test('python export is valid and keeps timings', () => {
    const show = {
      name: 'Test "show"', fps: '25',
      categories: [{ id: 'l', name: 'Lighting', color: '#fff' }, { id: 'a', name: "Audio's", color: '#000' }],
      tracks: [{ id: 't', name: 'Song 1', start: 10, duration: 200 }],
      cues: [
        { id: '1', time: 12.48, name: 'Blackout\nthen go', category: 'l', notes: 'tab\there', titan: { userNumber: 5, cue: 2, legend: 'Main' } },
        { id: '2', time: 3.2, name: 'Intro', category: 'a', notes: '', titan: null },
      ],
    };
    const py = T.exportPython(show);
    fs.mkdirSync('/tmp/cueclock-test', { recursive: true });
    fs.writeFileSync('/tmp/cueclock-test/show_cues.py', py);
    const out = require('child_process').execFileSync('python3', ['-I', '-c',
      'import importlib.util as u;s=u.spec_from_file_location("m","/tmp/cueclock-test/show_cues.py");m=u.module_from_spec(s);s.loader.exec_module(m);' +
      'print(len(m.CUES), m.CUES[0]["tc"], m.CUES[1]["seconds"], m.CUES[1]["titan"], m.FPS, m.tc_to_seconds("00:00:12:12"), m.SHOW_NAME, m.CUES[1]["name"])']).toString().trim();
    assert.strictEqual(out, `2 00:00:03:05 12.48 {'cue_list': 5, 'cue': 2, 'legend': 'Main'} 25 12.48 Test "show" Blackout\nthen go`);
    const listed = require('child_process').execFileSync('python3', ['-I', '/tmp/cueclock-test/show_cues.py', '--list']).toString();
    assert.ok(listed.includes('00:00:12:12') && listed.includes('Lighting'), listed);
  });
}

console.log(`\n${passed} tests passed`);
