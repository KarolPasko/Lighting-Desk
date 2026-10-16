// Run with: node test/features.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// Load the browser scripts into one context (same approach as core.test.js).
const ctx = { console, module: undefined };
vm.createContext(ctx);
for (const f of ['timecode.js', 'export.js', 'show.js', 'features.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'), ctx, { filename: f });
}
const T = new Proxy({}, { get: (_, n) => vm.runInContext(String(n), ctx) });

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }
function eq(a, b, m) { assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m); }

function show() {
  return T.normalizeShow({
    name: 'Test', fps: '25',
    categories: [{ id: 'l', name: 'Lighting', color: '#ffffff' }, { id: 'a', name: 'Audio', color: '#000000' }],
    cues: [
      { id: '1', time: 10, name: 'Chorus hit', category: 'l', titan: { userNumber: 2, cue: 5, legend: 'Song' } },
      { id: '2', time: 11, name: 'Strobe', category: 'l', titan: { userNumber: 2, cue: 6, legend: 'Song' } },
      { id: '3', time: 12, name: 'SFX', category: 'a' },
    ],
    markers: [{ id: 'm1', time: 60, name: 'Chorus 2', color: '#6fb6f2' }, { id: 'm2', time: 120, name: 'Chorus 3', color: '#6fb6f2' }],
  });
}

test('pasteCues preserves spacing and lands at target', () => {
  const s = show();
  const fps = T.fpsInfo('25');
  const pasted = T.pasteCues(s.cues, 100, fps);
  eq(pasted.map(c => c.time), [100, 101, 102]);
  assert.strictEqual(pasted[0].name, 'Chorus hit');
  // originals unchanged
  assert.strictEqual(s.cues[0].time, 10);
});

test('offsetCues snaps and clamps at zero', () => {
  const s = show();
  const fps = T.fpsInfo('25');
  const out = T.offsetCues(s.cues, -100, fps);
  eq(out.map(c => c.time), [0, 0, 0]);
  const fwd = T.offsetCues(s.cues, 5.004, fps); // snaps to frame (1/25 = .04)
  assert.strictEqual(fwd[0].time, 15); // 15.004 -> frame 375 -> 15.0
});

test('repeatCues makes N copies at intervals', () => {
  const s = show();
  const fps = T.fpsInfo('25');
  const block = s.cues.slice(0, 2); // 10,11
  const out = T.repeatCues(block, 200, 30, 3, fps);
  assert.strictEqual(out.length, 6);
  eq(out.map(c => c.time), [200, 201, 230, 231, 260, 261]);
});

test('repeatAtMarkers pastes the block at each marker', () => {
  const s = show();
  const fps = T.fpsInfo('25');
  const block = s.cues.slice(0, 2);
  const out = T.repeatAtMarkers(block, s.markers.map(m => m.time), fps);
  eq(out.map(c => c.time), [60, 61, 120, 121]);
});

test('renumberTitan gives pasted cues free cue numbers per list', () => {
  const s = show(); // list 2 has cues 5,6
  const fps = T.fpsInfo('25');
  const pasted = T.pasteCues(s.cues.slice(0, 2), 100, fps); // both on list 2
  T.renumberTitan(pasted, s);
  eq(pasted.map(c => c.titan.cue), [7, 8]);
  assert.strictEqual(pasted[0].titan.userNumber, 2);
});

test('Avolites CSV groups by cue list', () => {
  const csv = T.exportAvolitesCsv(show());
  const lines = csv.trim().split('\r\n');
  assert.ok(lines[0].startsWith('Cue List,'));
  assert.ok(lines.some(l => l.startsWith('2,Song,5,00:00:10:00')));
  assert.ok(lines.some(l => l.includes('(not linked to a cue list)') && l.includes('SFX')));
});

test('Avolites printable sheet is valid HTML with the cue list', () => {
  const html = T.exportAvolitesSheet(show());
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('Cue list 2 — Song'));
  assert.ok(html.includes('Chorus hit'));
});

test('QLab CSV has timecode + name', () => {
  const csv = T.exportQlabCsv(show());
  assert.ok(csv.startsWith('Timecode,Name,Category,Notes'));
  assert.ok(csv.includes('00:00:10:00,Chorus hit,Lighting'));
});

test('CSV import round-trips the Avolites CSV back into cues', () => {
  const s = show();
  const csv = T.exportAvolitesCsv(s);
  const res = T.importCsv(csv, s);
  assert.strictEqual(res.count, 3);
  const hit = res.cues.find(c => c.name === 'Chorus hit');
  assert.strictEqual(hit.time, 10);
  assert.strictEqual(hit.category, 'l');       // matched "Lighting"
  assert.strictEqual(hit.titan.userNumber, 2);
  assert.strictEqual(hit.titan.cue, 5);
});

test('CSV import is lenient about headers and bad rows', () => {
  const s = show();
  const csv = 'Time,Name\n00:00:05:00,Intro\nnonsense,Bad\n10,Later\n';
  const res = T.importCsv(csv, s);
  assert.strictEqual(res.count, 2);
  assert.strictEqual(res.skipped, 1);
  assert.strictEqual(res.cues[0].time, 5);  // 00:00:05:00
  assert.strictEqual(res.cues[1].time, 10); // plain seconds
});

test('CSV import reports a missing time column', () => {
  const res = T.importCsv('Foo,Bar\n1,2\n', show());
  assert.strictEqual(res.count, 0);
  assert.ok(/Timecode|Time/.test(res.error));
});

test('normalizeShow keeps markers and per-cue fade', () => {
  const s = T.normalizeShow({ cues: [{ id: 'x', time: 3, name: 'A', fade: 2.5 }], markers: [{ id: 'm', time: 9, name: 'Drop', color: '#112233' }] });
  assert.strictEqual(s.cues[0].fade, 2.5);
  assert.strictEqual(s.markers[0].name, 'Drop');
  assert.strictEqual(s.markers[0].color, '#112233');
});

console.log(`\n${passed} tests passed`);
