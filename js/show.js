// Show data, saving, audio file storage and undo.

const SHOW_KEY = 'cueclock-show-v1';
const SETTINGS_KEY = 'cueclock-settings-v1';

const DEFAULT_CATEGORIES = [
  { id: 'lighting', name: 'Lighting', color: '#f2b134' },
  { id: 'audio', name: 'Audio', color: '#3cc4b4' },
  { id: 'video', name: 'Video', color: '#9a86f7' },
  { id: 'stage', name: 'Stage & SFX', color: '#ef7a5e' },
];

const CATEGORY_COLORS = ['#f2b134', '#3cc4b4', '#9a86f7', '#ef7a5e', '#6fb6f2', '#d78ad8', '#9ccc65', '#e0c25a'];

function uid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
}

function newShow() {
  return {
    version: 1,
    name: 'Untitled show',
    fps: '25',
    categories: DEFAULT_CATEGORIES.map(c => ({ ...c })),
    tracks: [],
    cues: [],
  };
}

// Make any loaded object safe to use: right types, known fields only.
function normalizeShow(raw) {
  const show = newShow();
  if (!raw || typeof raw !== 'object') return show;
  if (typeof raw.name === 'string') show.name = raw.name.slice(0, 120);
  if (FPS_OPTIONS[raw.fps]) show.fps = raw.fps;
  if (Array.isArray(raw.categories) && raw.categories.length) {
    show.categories = raw.categories
      .filter(c => c && typeof c.id === 'string')
      .map((c, i) => ({
        id: c.id,
        name: String(c.name || 'Category').slice(0, 40),
        color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : CATEGORY_COLORS[i % CATEGORY_COLORS.length],
      }));
  }
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  if (Array.isArray(raw.tracks)) {
    show.tracks = raw.tracks.filter(t => t && typeof t.id === 'string').map(t => ({
      id: t.id,
      name: String(t.name || 'Track').slice(0, 120),
      start: Math.max(0, num(t.start)),
      duration: Math.max(0, num(t.duration)),
      peaks: Array.isArray(t.peaks) ? t.peaks.map(v => Math.max(0, Math.min(100, Math.round(num(v))))) : [],
    }));
  }
  if (Array.isArray(raw.cues)) {
    show.cues = raw.cues.filter(c => c && typeof c.id === 'string').map(c => ({
      id: c.id,
      time: Math.max(0, num(c.time)),
      name: String(c.name ?? '').slice(0, 200),
      category: typeof c.category === 'string' ? c.category : show.categories[0].id,
      notes: String(c.notes ?? '').slice(0, 2000),
      titan: c.titan && num(c.titan.userNumber) > 0
        ? { userNumber: num(c.titan.userNumber), cue: num(c.titan.cue) > 0 ? num(c.titan.cue) : null, legend: String(c.titan.legend || '') }
        : null,
    }));
  }
  return show;
}

function loadShow() {
  try {
    const raw = localStorage.getItem(SHOW_KEY);
    if (raw) return normalizeShow(JSON.parse(raw));
  } catch (_) {}
  return null;
}

function saveShowNow(show) {
  try { localStorage.setItem(SHOW_KEY, JSON.stringify(show)); return true; } catch (_) { return false; }
}

const DEFAULT_SETTINGS = {
  source: 'internal',        // internal | mtc | ltc
  midiEnabled: false,
  midiIn: '',
  midiOut: '',
  mtcOut: false,
  ltcIn: '',
  ltcOut: false,
  ltcOutDevice: '',
  ltcGain: 0.5,
  trackOutDevice: '',
  bridgeUrl: '',
  chaseTitan: true,
  playWhenChasing: false,
  follow: true,
  newCueCategory: 'lighting',
  pps: 40,
};

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (_) {}
  return { ...DEFAULT_SETTINGS, ...s };
}

function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
}

// ---------- audio files in IndexedDB ----------
const AudioStore = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise(resolve => {
      try {
        const req = indexedDB.open('cueclock', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('audio');
        req.onsuccess = () => { this.db = req.result; resolve(this.db); };
        req.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  },
  async put(id, blob) {
    const db = await this.open();
    if (!db) return false;
    return new Promise(resolve => {
      try {
        const tx = db.transaction('audio', 'readwrite');
        tx.objectStore('audio').put(blob, id);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (_) { resolve(false); }
    });
  },
  async get(id) {
    const db = await this.open();
    if (!db) return null;
    return new Promise(resolve => {
      try {
        const req = db.transaction('audio').objectStore('audio').get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  },
  async remove(id) {
    const db = await this.open();
    if (!db) return;
    try { db.transaction('audio', 'readwrite').objectStore('audio').delete(id); } catch (_) {}
  },
};

// Decode an audio file to get its length and a small waveform overview.
async function analyseAudio(file) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const buckets = Math.min(6000, Math.max(400, Math.round(buf.duration * 10)));
    const peaks = new Array(buckets).fill(0);
    const size = Math.max(1, Math.floor(buf.length / buckets));
    for (let ch = 0; ch < Math.min(2, buf.numberOfChannels); ch++) {
      const data = buf.getChannelData(ch);
      for (let b = 0; b < buckets; b++) {
        let max = 0;
        const end = Math.min(data.length, (b + 1) * size);
        for (let i = b * size; i < end; i += 4) { const a = Math.abs(data[i]); if (a > max) max = a; }
        if (max > peaks[b]) peaks[b] = max;
      }
    }
    const top = Math.max(0.01, ...peaks);
    return { duration: buf.duration, peaks: peaks.map(p => Math.round((p / top) * 100)) };
  } finally {
    ctx.close();
  }
}

// ---------- undo ----------
class History {
  constructor(limit = 100) { this.undoStack = []; this.redoStack = []; this.limit = limit; }
  static snap(show) {
    return JSON.stringify({ ...show, tracks: show.tracks.map(({ peaks, ...t }) => t) });
  }
  push(show) {
    this.undoStack.push(History.snap(show));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }
  restore(show, json) {
    const data = JSON.parse(json);
    const peaks = new Map(show.tracks.map(t => [t.id, t.peaks]));
    data.tracks.forEach(t => { t.peaks = peaks.get(t.id) || []; });
    return normalizeShow(data);
  }
  undo(show) {
    if (!this.undoStack.length) return null;
    this.redoStack.push(History.snap(show));
    return this.restore(show, this.undoStack.pop());
  }
  redo(show) {
    if (!this.redoStack.length) return null;
    this.undoStack.push(History.snap(show));
    return this.restore(show, this.redoStack.pop());
  }
}
