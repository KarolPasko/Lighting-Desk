#!/usr/bin/env node
// Cue Clock bridge: serves the app and links it to an Avolites Titan console.
//
//   node bridge/server.js                     then open http://localhost:8080
//   node bridge/server.js --titan 192.168.1.50
//   node bridge/server.js --demo              pretend console, for trying it out
//
// Browsers can't talk to the console's WebAPI directly (it has no CORS headers),
// so the app sends its requests here and this program forwards them.
// Needs Node.js 18 or newer. No packages to install.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { NetScan } = require('./netscan.js');

// Network monitor (sACN / Art-Net / device discovery). Idle until the app's
// Network tab turns it on, so its UDP ports aren't bound unless wanted.
const net = new NetScan();

const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const POLL_MS = 3000;

// ---------- settings ----------
function readArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--demo') out.demo = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--titan') out.host = argv[++i];
    else if (a === '--titan-port') out.titanPort = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = readArgs(process.argv.slice(2));
if (args.help) {
  console.log('Usage: node bridge/server.js [--port 8080] [--titan <console ip>] [--titan-port 4430] [--demo]');
  process.exit(0);
}

let saved = {};
try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}

const config = {
  host: args.host ?? saved.host ?? '',
  titanPort: args.titanPort ?? saved.titanPort ?? 4430,
  demo: args.demo ?? saved.demo ?? false,
};
const PORT = args.port || 8080;

function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (_) {}
}

// ---------- console state ----------
const titan = {
  connected: false,
  version: '',
  error: '',
  cueLists: [],     // { titanId, userNumber, legend, type }
  lastAction: null, // { text, ok, at }
};

// ---------- demo console ----------
const demo = {
  started: Date.now(),
  handles: [
    { type: 'cueListHandle', legend: 'Preshow', titanId: 101, userNumber: { hashCode: '1', userNumbers: [1] } },
    { type: 'cueListHandle', legend: 'Song 1 Looks', titanId: 102, userNumber: { hashCode: '2', userNumbers: [2] } },
    { type: 'cueListHandle', legend: 'Song 2 Looks', titanId: 103, userNumber: { hashCode: '3', userNumbers: [3] } },
    { type: 'playbackHandle', legend: 'Haze', titanId: 104, userNumber: { hashCode: '10', userNumbers: [10] } },
  ],
};

function demoRequest(p) {
  // A new cue list "appears" on the demo console after 20 seconds,
  // so you can see lists added on the desk turn up in the app.
  if (Date.now() - demo.started > 20000 && !demo.handles.some(h => h.titanId === 105)) {
    demo.handles.push({ type: 'cueListHandle', legend: 'Encore', titanId: 105, userNumber: { hashCode: '4', userNumbers: [4] } });
  }
  if (p === 'get/2/System/SoftwareVersion') return '"Demo console"';
  if (p === 'handles') return JSON.stringify(demo.handles);
  return '';
}

// ---------- talking to the console ----------
async function titanRequest(p) {
  if (config.demo) return demoRequest(p);
  if (!config.host) throw new Error('No console IP address set');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`http://${config.host}:${config.titanPort}/titan/${p}`, { signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`Console replied HTTP ${res.status}`);
    return text;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`No reply from ${config.host}:${config.titanPort}`);
    throw new Error(err.cause?.code === 'ECONNREFUSED'
      ? `Console at ${config.host}:${config.titanPort} refused the connection. Is the WebAPI running?`
      : err.message);
  } finally {
    clearTimeout(timer);
  }
}

// Commands run one at a time and are never retried, so a cue can't fire twice.
let queue = Promise.resolve();
function titanCommands(paths) {
  const run = queue.then(async () => { for (const p of paths) await titanRequest(p); });
  queue = run.catch(() => {});
  return run;
}

function script(member, params = {}) {
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  return `script/2/${member}${q ? '?' + q : ''}`;
}

let pollTimer = null;
async function poll() {
  clearTimeout(pollTimer);
  const before = JSON.stringify(publicState());
  if (!config.host && !config.demo) {
    Object.assign(titan, { connected: false, version: '', error: '', cueLists: [] });
  } else {
    try {
      const version = await titanRequest('get/2/System/SoftwareVersion');
      const handles = JSON.parse(await titanRequest('handles'));
      if (!Array.isArray(handles)) throw new Error('Unexpected reply to the handles request');
      titan.cueLists = handles
        .filter(h => h && typeof h.titanId === 'number' && h.userNumber && Array.isArray(h.userNumber.userNumbers))
        .map(h => ({ titanId: h.titanId, userNumber: h.userNumber.userNumbers[0], legend: String(h.legend || ''), type: String(h.type || '') }))
        .filter(h => h.userNumber !== undefined)
        .sort((a, b) => a.userNumber - b.userNumber);
      titan.version = String(version).replace(/^"|"$/g, '');
      titan.connected = true;
      titan.error = '';
    } catch (err) {
      titan.connected = false;
      titan.error = err.message;
    }
  }
  if (JSON.stringify(publicState()) !== before) broadcast();
  pollTimer = setTimeout(poll, POLL_MS);
}

function publicState() {
  return {
    host: config.host, titanPort: config.titanPort, demo: config.demo,
    connected: titan.connected, version: titan.version, error: titan.error,
    cueLists: titan.cueLists, lastAction: titan.lastAction,
  };
}

// ---------- live updates to the app (server-sent events) ----------
const clients = new Set();
function broadcast() {
  const msg = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000);

// ---------- HTTP ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8',
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function positiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 100000 ? n : null;
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') return sendJson(res, 200, publicState());

  if (req.method === 'GET' && url.pathname === '/api/net/status') {
    const snap = net.snapshot();
    const focus = url.searchParams.get('levels'); // e.g. "sacn:3"
    if (focus) {
      const [proto, uni] = focus.split(':');
      snap.focusLevels = net.universeLevels(proto, uni);
      snap.focus = focus;
    }
    return sendJson(res, 200, snap);
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method !== 'POST') return sendJson(res, 404, { error: 'Not found' });
  let body;
  try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }

  if (url.pathname === '/api/titan/config') {
    if (typeof body.host === 'string') config.host = body.host.trim();
    if (positiveNumber(body.titanPort)) config.titanPort = Number(body.titanPort);
    if (typeof body.demo === 'boolean') config.demo = body.demo;
    if (config.demo) demo.started = Date.now();
    saveConfig();
    titan.cueLists = [];
    poll();
    return sendJson(res, 200, publicState());
  }

  if (url.pathname === '/api/titan/blackout') {
    const stateOn = body.on ? 1 : 0;
    try {
      await titanCommands([script('Masters/BlackOutDesk', { deskBlackOutState: stateOn })]);
      titan.lastAction = { text: `Desk ${stateOn ? 'blackout on' : 'blackout off'}`, ok: true, at: Date.now() };
      broadcast();
      return sendJson(res, 200, { ok: true });
    } catch (err) { return sendJson(res, 502, { error: err.message }); }
  }

  if (url.pathname === '/api/titan/release-all') {
    try {
      await titanCommands([script('Playbacks/ReleaseAllPlaybacks', { fadeTime: 0, useMasterReleaseTime: false })]);
      titan.lastAction = { text: 'Released all playbacks', ok: true, at: Date.now() };
      console.log(`${new Date().toLocaleTimeString()}  Released all playbacks${config.demo ? ' (demo)' : ''}`);
      broadcast();
      return sendJson(res, 200, { ok: true });
    } catch (err) { return sendJson(res, 502, { error: err.message }); }
  }

  if (url.pathname === '/api/titan/go' || url.pathname === '/api/titan/release') {
    const userNumber = positiveNumber(body.userNumber);
    if (!userNumber) return sendJson(res, 400, { error: 'A cue list user number is required' });
    const cue = body.cue === null || body.cue === undefined || body.cue === '' ? null : positiveNumber(body.cue);
    let paths, text;
    if (url.pathname === '/api/titan/release') {
      paths = [script('Playbacks/ReleasePlayback', { handle_userNumber: userNumber })];
      text = `Release cue list ${userNumber}`;
    } else if (cue) {
      paths = [
        script('CueLists/SetNextCue', { handle_userNumber: userNumber, stepNumber: cue }),
        script('CueLists/Play', { handle_userNumber: userNumber }),
      ];
      text = `Cue list ${userNumber}: go to cue ${cue}`;
    } else {
      paths = [script('CueLists/Play', { handle_userNumber: userNumber })];
      text = `Cue list ${userNumber}: go`;
    }
    try {
      await titanCommands(paths);
      titan.lastAction = { text, ok: true, at: Date.now() };
      console.log(`${new Date().toLocaleTimeString()}  ${text}${config.demo ? '  (demo)' : ''}`);
      broadcast();
      return sendJson(res, 200, { ok: true, text });
    } catch (err) {
      titan.lastAction = { text: `${text} failed: ${err.message}`, ok: false, at: Date.now() };
      console.log(`${new Date().toLocaleTimeString()}  ${text} FAILED: ${err.message}`);
      broadcast();
      return sendJson(res, 502, { error: err.message });
    }
  }

  // ---------- network monitor ----------
  if (url.pathname === '/api/net/control') {
    if (body.action === 'start') net.start();
    else if (body.action === 'stop') net.stop();
    else if (body.action === 'reset') net.reset();
    else if (body.action === 'capture') net.capture = !!body.on;
    else if (body.action === 'artpoll') { if (!net.running) net.start(); net.sendArtPoll(); }
    else if (body.action === 'universeTop') {
      const top = positiveNumber(body.value);
      if (top) { net.universeTop = Math.min(512, Math.max(1, Math.round(top))); if (net.running) net.joinUniverses(1, net.universeTop); }
    } else if (body.action === 'pingsweep') {
      if (!net.running) net.start();
      net.pingSweep((n) => console.log(`${new Date().toLocaleTimeString()}  Ping sweep sent to ${n} addresses`));
      return sendJson(res, 200, { ok: true, sweeping: true });
    } else {
      return sendJson(res, 400, { error: 'Unknown action' });
    }
    return sendJson(res, 200, { ok: true, running: net.running, capturing: net.capture });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

function serveFile(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(ROOT, '.' + rel);
  if (!file.startsWith(ROOT + path.sep) || rel.includes('/.') || file.startsWith(path.join(ROOT, 'bridge'))) {
    res.writeHead(404); return res.end('Not found');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    handleApi(req, res, url).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveFile(req, res, url);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Try: node bridge/server.js --port 8081`);
  else console.error(err.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Cue Clock is running.  Open http://localhost:${PORT} in Chrome or Edge.`);
  if (config.demo) console.log('Demo console: no real desk is contacted.');
  else if (config.host) console.log(`Avolites console: ${config.host}:${config.titanPort}`);
  else console.log('No console set yet. Enter its IP address in the app (Avolites tab), or start with --titan <ip>.');
  poll();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { net.stop(); } catch (_) {} process.exit(0); });
}
