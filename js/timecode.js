// Timecode maths. Times are stored everywhere as seconds of real time;
// these helpers turn them into SMPTE labels and frame numbers and back.

const FPS_OPTIONS = {
  '24':      { key: '24',      label: '24 fps',       rate: 24,         nominal: 24, drop: false, mtc: 0 },
  '25':      { key: '25',      label: '25 fps',       rate: 25,         nominal: 25, drop: false, mtc: 1 },
  '29.97df': { key: '29.97df', label: '29.97 drop',   rate: 30000 / 1001, nominal: 30, drop: true,  mtc: 2 },
  '30':      { key: '30',      label: '30 fps',       rate: 30,         nominal: 30, drop: false, mtc: 3 },
};
const MTC_RATE_KEYS = ['24', '25', '29.97df', '30'];

function fpsInfo(key) { return FPS_OPTIONS[key] || FPS_OPTIONS['25']; }

function framesPerDay(fps) {
  return fps.drop ? 2589408 : fps.nominal * 86400;
}

function secondsToFrames(seconds, fps) {
  if (!(seconds > 0)) return 0;
  return Math.floor(seconds * fps.rate + 1e-6) % framesPerDay(fps);
}

function framesToSeconds(frames, fps) { return frames / fps.rate; }

// Frame count -> { h, m, s, f } label, handling 29.97 drop-frame numbering.
function framesToParts(frames, fps) {
  let fn = ((Math.floor(frames) % framesPerDay(fps)) + framesPerDay(fps)) % framesPerDay(fps);
  const n = fps.nominal;
  if (fps.drop) {
    const d = Math.floor(fn / 17982);
    const m = fn % 17982;
    fn += 18 * d + (m > 2 ? 2 * Math.floor((m - 2) / 1798) : 0);
  }
  return {
    h: Math.floor(fn / (n * 3600)) % 24,
    m: Math.floor(fn / (n * 60)) % 60,
    s: Math.floor(fn / n) % 60,
    f: fn % n,
  };
}

function partsToFrames(p, fps) {
  const n = fps.nominal;
  let fn = ((p.h * 60 + p.m) * 60 + p.s) * n + p.f;
  if (fps.drop) {
    const totalMinutes = p.h * 60 + p.m;
    fn -= 2 * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return fn;
}

const pad2 = v => String(v).padStart(2, '0');

function formatParts(p, fps) {
  return `${pad2(p.h)}:${pad2(p.m)}:${pad2(p.s)}${fps.drop ? ';' : ':'}${pad2(p.f)}`;
}

function formatTC(seconds, fps) {
  return formatParts(framesToParts(secondsToFrames(seconds, fps), fps), fps);
}

// Accepts "HH:MM:SS:FF" (also ; or . before frames). Shorter entries fill from
// the right, the way consoles do: "1:00" is one second, "2:00:00" two minutes.
// A plain number with no separators, like "62.5", is read as seconds.
function parseTC(text, fps) {
  const s = String(text).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s) && !s.includes(':')) return Number(s);
  const parts = s.split(/[:;.]/);
  if (parts.length > 4 || parts.some(x => !/^\d{1,2}$/.test(x))) return null;
  const nums = parts.map(Number);
  while (nums.length < 4) nums.unshift(0);
  const [h, m, sec, f] = nums;
  if (h > 23 || m > 59 || sec > 59 || f >= fps.nominal) return null;
  return framesToSeconds(partsToFrames({ h, m, s: sec, f }, fps), fps);
}

// Snap a time to the start of the frame it falls in.
function snapToFrame(seconds, fps) {
  return framesToSeconds(secondsToFrames(seconds, fps), fps);
}

// "1:05.3" style countdown text.
function formatCountdown(seconds) {
  const neg = seconds < 0;
  let t = Math.abs(seconds);
  const h = Math.floor(t / 3600); t -= h * 3600;
  const m = Math.floor(t / 60); t -= m * 60;
  const s = t.toFixed(1).padStart(4, '0');
  const body = h ? `${h}:${pad2(m)}:${s}` : `${m}:${s}`;
  return (neg ? '-' : '') + body;
}

if (typeof module !== 'undefined') {
  module.exports = {
    FPS_OPTIONS, MTC_RATE_KEYS, fpsInfo, secondsToFrames, framesToSeconds, framesToParts,
    partsToFrames, formatParts, formatTC, parseTC, snapToFrame, formatCountdown, framesPerDay,
  };
}
