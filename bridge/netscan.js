// Network monitoring for lighting protocols, used by the bridge.
//
// What this does, on your own show network:
//   - sACN (E1.31) monitor on UDP 5568: which universes are live, who's sending
//     them, priority, packet rate, and the 512 DMX levels per universe.
//   - Art-Net monitor on UDP 6454: ArtDmx universes, plus ArtPoll discovery that
//     makes Art-Net nodes announce themselves (IP, name, ports, universes).
//   - Device list: everything seen on the above, merged with the computer's ARP
//     table (IP + MAC + manufacturer) and an optional ping sweep to populate it.
//   - Packet view: a rolling log of the sACN/Art-Net packets it receives, with a
//     hex dump of each, so you can see exactly what's on the wire.
//
// It only listens to lighting-protocol traffic and reads the OS ARP table; it is
// not a general promiscuous capture (that would need libpcap and admin rights).
// Everything here is passive except ArtPoll and the optional ping sweep, which
// are the normal, polite ways to ask lighting gear to identify itself.

'use strict';

const dgram = require('dgram');
const os = require('os');
const { execFile } = require('child_process');

const SACN_PORT = 5568;
const ARTNET_PORT = 6454;
const ACN_PID = 'ASC-E1.17\0\0\0';
const ARTNET_ID = 'Art-Net\0';

// ---------- pure parsers (tested in test/netscan.test.js) ----------

// E1.31 data packet -> { cid, sourceName, priority, sequence, universe, slots, startCode }
// Returns null for anything that isn't a well-formed E1.31 DMP data packet.
function parseSacn(buf) {
  if (buf.length < 126) return null;
  if (buf.readUInt16BE(0) !== 0x0010) return null;            // preamble size
  if (buf.toString('latin1', 4, 16) !== ACN_PID) return null; // ACN packet identifier
  if (buf.readUInt32BE(18) !== 0x00000004) return null;       // root vector: E1.31 data
  if (buf.readUInt32BE(40) !== 0x00000002) return null;       // framing vector: data packet
  if (buf.readUInt8(117) !== 0x02) return null;               // DMP vector
  if (buf.readUInt8(125) !== 0x00) return null;               // start code 0 = DMX (ignore others)
  const cid = buf.toString('hex', 22, 38);
  const sourceName = buf.toString('utf8', 44, 108).replace(/\0.*$/, '').trim();
  const priority = buf.readUInt8(108);
  const sequence = buf.readUInt8(111);
  const universe = buf.readUInt16BE(113);
  const propCount = buf.readUInt16BE(123);                     // includes the start code byte
  const slotCount = Math.max(0, Math.min(512, propCount - 1, buf.length - 126));
  const slots = buf.subarray(126, 126 + slotCount);
  return { cid, sourceName, priority, sequence, universe, startCode: 0, slots };
}

// ArtDmx -> { universe, net, subUni, seq, slots }
function parseArtDmx(buf) {
  if (buf.length < 18) return null;
  if (buf.toString('latin1', 0, 8) !== ARTNET_ID) return null;
  if (buf.readUInt16LE(8) !== 0x5000) return null;            // OpOutput / ArtDmx
  const seq = buf.readUInt8(12);
  const subUni = buf.readUInt8(14);
  const net = buf.readUInt8(15);
  const len = Math.min(buf.readUInt16BE(16), buf.length - 18, 512);
  const universe = (net << 8) | subUni;                       // 15-bit Art-Net port-address
  return { universe, net, subUni, seq, slots: buf.subarray(18, 18 + len) };
}

// ArtPollReply -> device record
function parseArtPollReply(buf, rinfo) {
  if (buf.length < 207) return null;
  if (buf.toString('latin1', 0, 8) !== ARTNET_ID) return null;
  if (buf.readUInt16LE(8) !== 0x2100) return null;            // OpPollReply
  const ip = `${buf[10]}.${buf[11]}.${buf[12]}.${buf[13]}`;
  const clean = (s) => s.replace(/\0.*$/, '').trim();
  const shortName = clean(buf.toString('latin1', 26, 44));
  const longName = clean(buf.toString('latin1', 44, 108));
  const nodeReport = clean(buf.toString('latin1', 108, 172));
  const numPorts = Math.min(4, buf.readUInt16BE(172));
  const net = buf.readUInt8(18) & 0x7f;
  const sub = buf.readUInt8(19) & 0x0f;
  const universes = [];
  for (let i = 0; i < numPorts; i++) universes.push((net << 8) | (sub << 4) | (buf.readUInt8(190 + i) & 0x0f));
  const mac = Array.from(buf.subarray(201, 207)).map((b) => b.toString(16).padStart(2, '0')).join(':');
  const esta = buf.readUInt16LE(24);
  return {
    ip: ip === '0.0.0.0' ? rinfo.address : ip,
    mac: mac === '00:00:00:00:00:00' ? '' : mac,
    shortName, longName, nodeReport, numPorts, universes, estaManufacturer: esta,
  };
}

function buildArtPoll() {
  const b = Buffer.alloc(14);
  b.write(ARTNET_ID, 0, 'latin1');
  b.writeUInt16LE(0x2000, 8); // OpPoll
  b.writeUInt8(0, 10);        // ProtVerHi
  b.writeUInt8(14, 11);       // ProtVerLo
  b.writeUInt8(0, 12);        // TalkToMe
  b.writeUInt8(0, 13);        // Priority
  return b;
}

function hexDump(buf, max = 128) {
  const n = Math.min(buf.length, max);
  const lines = [];
  for (let i = 0; i < n; i += 16) {
    const chunk = buf.subarray(i, Math.min(i + 16, n));
    const hex = Array.from(chunk).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(chunk).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${i.toString(16).padStart(4, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (buf.length > max) lines.push(`… ${buf.length - max} more bytes`);
  return lines.join('\n');
}

// A short, offline table of lighting/AV manufacturer MAC prefixes (OUI).
// Enough to label common gear; unknown prefixes just show blank.
const OUI = {
  '00:1a:c5': 'ETC', '00:50:c2': 'IEEE-registered', '00:60:fb': 'Pathway/ETC',
  '00:17:88': 'Philips/Signify', '00:26:5a': 'MA Lighting', '00:0d:5e': 'MA Lighting',
  'd0:69:d0': 'Robe', '00:1d:4f': 'Chauvet', '00:04:a3': 'Microchip',
  '00:0e:8f': 'Avolites', '00:1b:c5': 'OUI-registered', 'b8:27:eb': 'Raspberry Pi',
  'dc:a6:32': 'Raspberry Pi', 'e4:5f:01': 'Raspberry Pi', '00:11:32': 'Synology',
  'f0:0d:ac': 'ELC Lighting', '00:a0:de': 'Yamaha', '00:1c:f0': 'D-Link',
};
function ouiName(mac) {
  return mac ? (OUI[mac.slice(0, 8).toLowerCase()] || '') : '';
}

function sacnMulticast(universe) {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

// ---------- the live engine ----------

class NetScan {
  constructor() {
    this.sacn = new Map();       // universe -> { universe, sources: Map(cid -> {...}), levels, ... }
    this.artnet = new Map();     // universe -> { universe, sources, levels, ... }
    this.devices = new Map();    // key (ip or mac) -> device record
    this.packets = [];           // rolling log, newest first
    this.maxPackets = 200;
    this.counts = { sacn: 0, artnet: 0, artpoll: 0, total: 0 };
    this.running = false;
    this.capture = false;        // when true, record packet log + hex
    this.joined = new Set();
    this.universeTop = 64;       // join sACN multicast for universes 1..this
    this.sockets = [];
    this.pollTimer = null;
    this.reapTimer = null;
    this.error = '';
  }

  localAddresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni);
    }
    return out;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.error = '';
    this._startSacn();
    this._startArtnet();
    this.refreshArp();
    this.pollTimer = setInterval(() => { this.sendArtPoll(); this.refreshArp(); }, 5000);
    this.reapTimer = setInterval(() => this._reap(), 1000);
    setTimeout(() => this.sendArtPoll(), 300);
  }

  stop() {
    this.running = false;
    clearInterval(this.pollTimer);
    clearInterval(this.reapTimer);
    for (const s of this.sockets) { try { s.close(); } catch (_) {} }
    this.sockets = [];
    this.joined.clear();
  }

  reset() {
    this.sacn.clear();
    this.artnet.clear();
    this.devices.clear();
    this.packets = [];
    this.counts = { sacn: 0, artnet: 0, artpoll: 0, total: 0 };
    if (this.running) { this.refreshArp(); this.sendArtPoll(); }
  }

  _bind(port, onMessage, onReady) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (err) => { this.error = `Port ${port}: ${err.message}`; try { sock.close(); } catch (_) {} });
    sock.on('message', (msg, rinfo) => { try { onMessage(msg, rinfo); } catch (_) {} });
    sock.bind(port, () => { try { sock.setBroadcast(true); } catch (_) {} if (onReady) onReady(sock); });
    this.sockets.push(sock);
    return sock;
  }

  _startSacn() {
    this._bind(SACN_PORT, (msg, rinfo) => this._onSacn(msg, rinfo), (sock) => {
      try { sock.setMulticastTTL(16); } catch (_) {}
      this.joinUniverses(1, this.universeTop);
    });
  }

  joinUniverses(from, to) {
    this.sacnSock = this.sockets[0];
    const sock = this.sockets[0];
    if (!sock) return;
    for (let u = from; u <= to; u++) {
      const group = sacnMulticast(u);
      if (this.joined.has(group)) continue;
      try { sock.addMembership(group); this.joined.add(group); } catch (_) {}
    }
  }

  _startArtnet() {
    this._bind(ARTNET_PORT, (msg, rinfo) => this._onArtnet(msg, rinfo));
  }

  sendArtPoll() {
    const sock = this.sockets[1];
    if (!sock) return;
    const poll = buildArtPoll();
    const targets = new Set(['255.255.255.255']);
    for (const ni of this.localAddresses()) {
      // directed broadcast for this interface's subnet
      const ip = ni.address.split('.').map(Number);
      const mask = ni.netmask.split('.').map(Number);
      targets.add(ip.map((o, i) => o | (~mask[i] & 0xff)).join('.'));
    }
    for (const t of targets) { try { sock.send(poll, ARTNET_PORT, t); } catch (_) {} }
  }

  _logPacket(proto, rinfo, extra, buf) {
    this.counts.total++;
    if (!this.capture) return;
    this.packets.unshift({
      at: Date.now(), proto, from: rinfo.address, port: rinfo.port, len: buf.length,
      summary: extra, hex: hexDump(buf),
    });
    if (this.packets.length > this.maxPackets) this.packets.length = this.maxPackets;
  }

  _touchDevice(ip, patch) {
    if (!ip) return;
    const key = ip;
    const now = Date.now();
    const d = this.devices.get(key) || { ip, mac: '', names: new Set(), roles: new Set(), universes: new Set(), firstSeen: now };
    d.lastSeen = now;
    if (patch.mac) d.mac = patch.mac;
    if (patch.name) d.names.add(patch.name);
    if (patch.role) d.roles.add(patch.role);
    if (patch.universe !== undefined) d.universes.add(patch.universe);
    if (patch.universes) for (const u of patch.universes) d.universes.add(u);
    if (patch.nodeReport) d.nodeReport = patch.nodeReport;
    this.devices.set(key, d);
  }

  _onSacn(msg, rinfo) {
    const p = parseSacn(msg);
    if (!p) return;
    this.counts.sacn++;
    this._logPacket('sACN', rinfo, `U${p.universe} "${p.sourceName}" pri ${p.priority}`, msg);
    const now = Date.now();
    let u = this.sacn.get(p.universe);
    if (!u) { u = { universe: p.universe, sources: new Map(), levels: null, lastSeq: -1, packets: 0, rateWindow: [] }; this.sacn.set(p.universe, u); }
    u.levels = Array.from(p.slots);
    u.priority = p.priority;
    u.lastSeen = now;
    u.packets++;
    u.rateWindow.push(now);
    u.sources.set(p.cid, { cid: p.cid, name: p.sourceName, ip: rinfo.address, priority: p.priority, lastSeen: now });
    this._touchDevice(rinfo.address, { role: 'sACN source', name: p.sourceName, universe: p.universe });
  }

  _onArtnet(msg, rinfo) {
    const reply = parseArtPollReply(msg, rinfo);
    if (reply) {
      this.counts.artpoll++;
      this._logPacket('Art-Net', rinfo, `ArtPollReply "${reply.shortName}"`, msg);
      this._touchDevice(reply.ip, {
        mac: reply.mac, role: 'Art-Net node', name: reply.longName || reply.shortName,
        universes: reply.universes, nodeReport: reply.nodeReport,
      });
      return;
    }
    const dmx = parseArtDmx(msg);
    if (!dmx) { this._logPacket('Art-Net', rinfo, 'other', msg); return; }
    this.counts.artnet++;
    this._logPacket('Art-Net', rinfo, `ArtDmx U${dmx.universe}`, msg);
    const now = Date.now();
    let u = this.artnet.get(dmx.universe);
    if (!u) { u = { universe: dmx.universe, sources: new Map(), levels: null, packets: 0, rateWindow: [] }; this.artnet.set(dmx.universe, u); }
    u.levels = Array.from(dmx.slots);
    u.lastSeen = now;
    u.packets++;
    u.rateWindow.push(now);
    u.sources.set(rinfo.address, { ip: rinfo.address, lastSeen: now });
    this._touchDevice(rinfo.address, { role: 'Art-Net source', universe: dmx.universe });
  }

  // Read the OS ARP table for IP<->MAC of everything the machine has talked to.
  refreshArp() {
    const done = (out) => {
      for (const [ip, mac] of parseArpTable(out)) this._touchDevice(ip, { mac });
    };
    const cmd = process.platform === 'win32' ? ['arp', ['-a']] : ['arp', ['-an']];
    execFile(cmd[0], cmd[1], { timeout: 4000 }, (err, stdout) => { if (!err && stdout) done(stdout); });
  }

  // Populate the ARP table by pinging every host in the local /24 (optional).
  pingSweep(onDone) {
    const nets = this.localAddresses();
    if (!nets.length) { if (onDone) onDone(0); return; }
    const base = nets[0].address.split('.').slice(0, 3).join('.');
    let pending = 0, launched = 0;
    const isWin = process.platform === 'win32';
    for (let i = 1; i < 255; i++) {
      const ip = `${base}.${i}`;
      pending++; launched++;
      const args = isWin ? ['-n', '1', '-w', '400', ip] : ['-c', '1', '-W', '1', ip];
      execFile('ping', args, { timeout: 2000 }, () => { if (--pending === 0) { this.refreshArp(); if (onDone) onDone(launched); } });
    }
  }

  _rate(win, now) {
    while (win.length && now - win[0] > 1000) win.shift();
    return win.length;
  }

  // Drop universes/sources that have gone silent for a few seconds.
  _reap() {
    const now = Date.now();
    for (const map of [this.sacn, this.artnet]) {
      for (const [uni, u] of map) {
        for (const [k, s] of u.sources) if (now - s.lastSeen > 5000) u.sources.delete(k);
        if (now - u.lastSeen > 5000 && u.sources.size === 0) map.delete(uni);
      }
    }
  }

  universeList(map, now) {
    return [...map.values()].map((u) => ({
      universe: u.universe,
      priority: u.priority,
      pps: this._rate(u.rateWindow, now),
      packets: u.packets,
      sources: [...u.sources.values()].map((s) => ({ name: s.name || s.ip, ip: s.ip, cid: s.cid, priority: s.priority })),
      active: u.levels ? u.levels.filter((v) => v > 0).length : 0,
      lastSeen: u.lastSeen,
    })).sort((a, b) => a.universe - b.universe);
  }

  // One universe's 512 levels, for the level grid.
  universeLevels(proto, universe) {
    const map = proto === 'artnet' ? this.artnet : this.sacn;
    const u = map.get(Number(universe));
    return u && u.levels ? u.levels : null;
  }

  deviceList() {
    return [...this.devices.values()].map((d) => ({
      ip: d.ip,
      mac: d.mac,
      vendor: ouiName(d.mac),
      names: [...d.names],
      roles: [...d.roles],
      universes: [...d.universes].sort((a, b) => a - b),
      nodeReport: d.nodeReport || '',
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
    })).sort((a, b) => cmpIp(a.ip, b.ip));
  }

  snapshot() {
    const now = Date.now();
    return {
      running: this.running,
      capturing: this.capture,
      error: this.error,
      interfaces: this.localAddresses().map((ni) => ({ name: ni.address, netmask: ni.netmask, mac: ni.mac })),
      universeTop: this.universeTop,
      counts: this.counts,
      sacn: this.universeList(this.sacn, now),
      artnet: this.universeList(this.artnet, now),
      devices: this.deviceList(),
      packets: this.capture ? this.packets.slice(0, 80) : [],
    };
  }
}

function parseArpTable(text) {
  const out = [];
  const ipRe = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;
  const macRe = /([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5}|[0-9a-f]{1,2}(?:-[0-9a-f]{1,2}){5})/i;
  for (const line of text.split(/\r?\n/)) {
    const ip = line.match(ipRe);
    const mac = line.match(macRe);
    if (!ip || !mac) continue;
    const norm = mac[1].replace(/-/g, ':').split(':').map((x) => x.padStart(2, '0')).join(':').toLowerCase();
    if (norm !== 'ff:ff:ff:ff:ff:ff' && norm !== '00:00:00:00:00:00') out.push([ip[1], norm]);
  }
  return out;
}

function cmpIp(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

module.exports = {
  NetScan, parseSacn, parseArtDmx, parseArtPollReply, buildArtPoll, parseArpTable,
  hexDump, ouiName, sacnMulticast, cmpIp,
};
