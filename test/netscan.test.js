// Run with: node test/netscan.test.js
const assert = require('assert');
const N = require('../bridge/netscan.js');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }

function buildSacn({ universe = 1, priority = 100, sequence = 7, sourceName = 'QLab', cid = '00112233445566778899aabbccddeeff', slots = [255, 0, 128] } = {}) {
  const b = Buffer.alloc(126 + slots.length);
  b.writeUInt16BE(0x0010, 0);
  b.write('ASC-E1.17\0\0\0', 4, 'latin1');
  b.writeUInt16BE(0x7000 | (b.length - 16), 16);
  b.writeUInt32BE(0x00000004, 18);
  Buffer.from(cid, 'hex').copy(b, 22);
  b.writeUInt16BE(0x7000 | (b.length - 38), 38);
  b.writeUInt32BE(0x00000002, 40);
  b.write(sourceName, 44, 'utf8');
  b.writeUInt8(priority, 108);
  b.writeUInt8(sequence, 111);
  b.writeUInt16BE(universe, 113);
  b.writeUInt16BE(0x7000 | (b.length - 115), 115);
  b.writeUInt8(0x02, 117);
  b.writeUInt8(0xa1, 118);
  b.writeUInt16BE(0x0001, 121);
  b.writeUInt16BE(slots.length + 1, 123);
  b.writeUInt8(0x00, 125);
  Buffer.from(slots).copy(b, 126);
  return b;
}

function buildArtDmx({ net = 0, subUni = 3, seq = 5, slots = [10, 20, 30] } = {}) {
  const b = Buffer.alloc(18 + slots.length);
  b.write('Art-Net\0', 0, 'latin1');
  b.writeUInt16LE(0x5000, 8);
  b.writeUInt8(0, 10); b.writeUInt8(14, 11);
  b.writeUInt8(seq, 12);
  b.writeUInt8(subUni, 14);
  b.writeUInt8(net, 15);
  b.writeUInt16BE(slots.length, 16);
  Buffer.from(slots).copy(b, 18);
  return b;
}

function buildArtPollReply({ ip = '192.168.1.60', shortName = 'Node1', longName = 'Stage Left Node', mac = 'd0:69:d0:11:22:33', ports = [0, 1] } = {}) {
  const b = Buffer.alloc(239);
  b.write('Art-Net\0', 0, 'latin1');
  b.writeUInt16LE(0x2100, 8);
  ip.split('.').forEach((o, i) => b.writeUInt8(Number(o), 10 + i));
  b.write(shortName, 26, 'latin1');
  b.write(longName, 44, 'latin1');
  b.write('#0001 [0001] OK', 108, 'latin1');
  b.writeUInt16BE(ports.length, 172);
  ports.forEach((sw, i) => b.writeUInt8(sw, 190 + i));
  mac.split(':').forEach((o, i) => b.writeUInt8(parseInt(o, 16), 201 + i));
  return b;
}

test('parse sACN round trip', () => {
  const p = N.parseSacn(buildSacn({ universe: 5, priority: 120, sourceName: 'GrandMA', slots: [255, 1, 2, 3] }));
  assert.strictEqual(p.universe, 5);
  assert.strictEqual(p.priority, 120);
  assert.strictEqual(p.sourceName, 'GrandMA');
  assert.deepStrictEqual(Array.from(p.slots), [255, 1, 2, 3]);
  assert.strictEqual(p.cid.length, 32);
});

test('full 512-slot sACN universe', () => {
  const slots = Array.from({ length: 512 }, (_, i) => i % 256);
  const p = N.parseSacn(buildSacn({ slots }));
  assert.strictEqual(p.slots.length, 512);
  assert.strictEqual(p.slots[511], 511 % 256);
});

test('rejects non-sACN and truncated packets', () => {
  assert.strictEqual(N.parseSacn(Buffer.alloc(50)), null);
  assert.strictEqual(N.parseSacn(buildArtDmx()), null);
  const bad = buildSacn();
  bad.writeUInt8(0x05, 125); // non-zero start code (e.g. RDM) -> ignored
  assert.strictEqual(N.parseSacn(bad), null);
});

test('parse ArtDmx 15-bit universe', () => {
  const p = N.parseArtDmx(buildArtDmx({ net: 2, subUni: 0x13, slots: [9, 8, 7] }));
  assert.strictEqual(p.universe, (2 << 8) | 0x13);
  assert.deepStrictEqual(Array.from(p.slots), [9, 8, 7]);
});

test('parse ArtPollReply device', () => {
  const d = N.parseArtPollReply(buildArtPollReply({ ports: [1, 2] }), { address: '192.168.1.60' });
  assert.strictEqual(d.ip, '192.168.1.60');
  assert.strictEqual(d.mac, 'd0:69:d0:11:22:33');
  assert.strictEqual(d.longName, 'Stage Left Node');
  assert.strictEqual(d.numPorts, 2);
  assert.strictEqual(N.ouiName(d.mac), 'Robe');
});

test('ArtPoll packet is well formed', () => {
  const b = N.buildArtPoll();
  assert.strictEqual(b.toString('latin1', 0, 8), 'Art-Net\0');
  assert.strictEqual(b.readUInt16LE(8), 0x2000);
  assert.strictEqual(b.length, 14);
});

test('sACN multicast address mapping', () => {
  assert.strictEqual(N.sacnMulticast(1), '239.255.0.1');
  assert.strictEqual(N.sacnMulticast(256), '239.255.1.0');
  assert.strictEqual(N.sacnMulticast(0x0102), '239.255.1.2');
});

test('ARP table parsing, macOS/Linux and Windows formats', () => {
  const unix = '? (192.168.1.5) at ab:cd:ef:1:2:3 on en0 ifscope [ethernet]\n? (192.168.1.60) at d0:69:d0:11:22:33 on en0 [ethernet]';
  const win = 'Interface: 192.168.1.2 --- 0xb\n  192.168.1.5          ab-cd-ef-01-02-03     dynamic\n  192.168.1.255        ff-ff-ff-ff-ff-ff     static';
  const u = N.parseArpTable(unix);
  assert.deepStrictEqual(u[0], ['192.168.1.5', 'ab:cd:ef:01:02:03']);
  assert.deepStrictEqual(u[1], ['192.168.1.60', 'd0:69:d0:11:22:33']);
  const w = N.parseArpTable(win);
  assert.deepStrictEqual(w[0], ['192.168.1.5', 'ab:cd:ef:01:02:03']);
  assert.strictEqual(w.length, 1); // broadcast MAC dropped
});

test('hex dump shows offset, bytes and ascii', () => {
  const d = N.hexDump(Buffer.from('Art-Net\0', 'latin1'));
  assert.ok(d.startsWith('0000  41 72 74 2d 4e 65 74 00'));
  assert.ok(d.includes('Art-Net.'));
});

test('IP comparison orders numerically', () => {
  const ips = ['192.168.1.20', '192.168.1.3', '192.168.1.100'].sort(N.cmpIp);
  assert.deepStrictEqual(ips, ['192.168.1.3', '192.168.1.20', '192.168.1.100']);
});

test('NetScan ingests packets into universes and devices', () => {
  const ns = new N.NetScan();
  ns._onSacn(buildSacn({ universe: 3, sourceName: 'Hog4', slots: [255, 255, 0] }), { address: '192.168.1.40', port: 5568 });
  ns._onArtnet(buildArtPollReply({ ip: '192.168.1.60' }), { address: '192.168.1.60', port: 6454 });
  ns._onArtnet(buildArtDmx({ net: 0, subUni: 1 }), { address: '192.168.1.60', port: 6454 });
  const snap = ns.snapshot();
  assert.strictEqual(snap.sacn.length, 1);
  assert.strictEqual(snap.sacn[0].universe, 3);
  assert.strictEqual(snap.sacn[0].sources[0].name, 'Hog4');
  assert.strictEqual(snap.sacn[0].active, 2);
  assert.ok(snap.artnet.find((u) => u.universe === 1));
  const dev = snap.devices.find((d) => d.ip === '192.168.1.60');
  assert.ok(dev.roles.includes('Art-Net node'));
  assert.strictEqual(dev.mac, 'd0:69:d0:11:22:33');
  assert.strictEqual(dev.vendor, 'Robe');
});

test('capture off means no packet log; on means hex recorded', () => {
  const ns = new N.NetScan();
  ns._onSacn(buildSacn(), { address: '10.0.0.5', port: 5568 });
  assert.strictEqual(ns.snapshot().packets.length, 0);
  ns.capture = true;
  ns._onSacn(buildSacn({ universe: 2 }), { address: '10.0.0.5', port: 5568 });
  const pk = ns.snapshot().packets;
  assert.strictEqual(pk.length, 1);
  assert.strictEqual(pk[0].proto, 'sACN');
  assert.ok(pk[0].hex.includes('41 72 74') === false && pk[0].summary.includes('U2'));
  assert.strictEqual(ns.counts.total, 2);
});

console.log(`\n${passed} tests passed`);
