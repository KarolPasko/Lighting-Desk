// Timeline canvas: ruler, track lane with waveforms, one lane per category with
// cue markers, and the playhead. The app passes callbacks for edits.

const TL = { LABEL_W: 132, RULER_H: 28, TRACK_H: 64, LANE_H: 44 };

class Timeline {
  constructor(canvas, app) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.app = app;
    this.viewStart = 0;      // seconds at the left edge of the lanes
    this.pps = app.settings.pps || 40; // pixels per second
    this.hits = [];          // cue marker hit boxes from the last draw
    this.trackHits = [];
    this.drag = null;
    this.hover = null;
    this.userScrolledAt = 0;
    this.css = {};
    this.readColors();
    this.bind();
  }

  readColors() {
    const s = getComputedStyle(document.documentElement);
    const v = n => s.getPropertyValue(n).trim();
    this.css = {
      bg: v('--tl-bg'), lane: v('--tl-lane'), laneAlt: v('--tl-lane-alt'), line: v('--line'),
      text: v('--text'), muted: v('--muted'), playhead: v('--playhead'), label: v('--panel'),
      track: v('--tl-track'), wave: v('--tl-wave'), select: v('--text'),
    };
  }

  get lanes() {
    return [{ kind: 'track' }, ...this.app.show.categories.map(c => ({ kind: 'cat', cat: c }))];
  }

  laneTop(i) { return TL.RULER_H + (i === 0 ? 0 : TL.TRACK_H + (i - 1) * TL.LANE_H); }
  laneHeight(i) { return i === 0 ? TL.TRACK_H : TL.LANE_H; }
  totalHeight() { return TL.RULER_H + TL.TRACK_H + this.app.show.categories.length * TL.LANE_H; }

  laneAt(y) {
    if (y < TL.RULER_H) return -1;
    if (y < TL.RULER_H + TL.TRACK_H) return 0;
    const i = 1 + Math.floor((y - TL.RULER_H - TL.TRACK_H) / TL.LANE_H);
    return i <= this.app.show.categories.length ? i : -2;
  }

  x(t) { return TL.LABEL_W + (t - this.viewStart) * this.pps; }
  t(x) { return this.viewStart + (x - TL.LABEL_W) / this.pps; }
  visibleSeconds() { return (this.width - TL.LABEL_W) / this.pps; }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.parentElement.clientWidth;
    const h = this.totalHeight();
    if (w === this.width && h === this.height && dpr === this.dpr) return;
    this.width = w; this.height = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
  }

  setZoom(pps, anchorX) {
    pps = Math.max(0.5, Math.min(800, pps));
    const ax = anchorX ?? (TL.LABEL_W + (this.width - TL.LABEL_W) / 2);
    const at = this.t(ax);
    this.pps = pps;
    this.viewStart = Math.max(0, at - (ax - TL.LABEL_W) / pps);
    this.app.settings.pps = pps;
    this.app.saveSettingsSoon();
  }

  fit() {
    const show = this.app.show;
    let end = 30;
    for (const t of show.tracks) end = Math.max(end, t.start + t.duration);
    for (const c of show.cues) end = Math.max(end, c.time + 5);
    let start = Infinity;
    for (const t of show.tracks) start = Math.min(start, t.start);
    for (const c of show.cues) start = Math.min(start, c.time);
    if (!Number.isFinite(start)) start = 0;
    start = Math.max(0, start - 2);
    this.pps = Math.max(0.5, Math.min(800, (this.width - TL.LABEL_W - 20) / Math.max(1, end - start)));
    this.viewStart = start;
    this.app.settings.pps = this.pps;
  }

  // Keep the playhead on screen while playing, unless the user just scrolled.
  follow(t) {
    if (!this.app.settings.follow || performance.now() - this.userScrolledAt < 3000) return;
    const span = this.visibleSeconds();
    if (t < this.viewStart || t > this.viewStart + span * 0.85) this.viewStart = Math.max(0, t - span * 0.15);
  }

  // ---------- drawing ----------
  draw(now) {
    this.resize();
    const { ctx, css } = this;
    const app = this.app;
    const show = app.show;
    const fps = fpsInfo(show.fps);
    const W = this.width, H = this.height;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = css.bg;
    ctx.fillRect(0, 0, W, H);

    // lanes
    this.lanes.forEach((lane, i) => {
      const y = this.laneTop(i), h = this.laneHeight(i);
      ctx.fillStyle = i % 2 ? css.lane : css.laneAlt;
      ctx.fillRect(TL.LABEL_W, y, W - TL.LABEL_W, h);
      ctx.fillStyle = css.line;
      ctx.fillRect(0, y + h - 1, W, 1);
    });

    // grid + ruler
    const step = this.tickStep();
    const first = Math.floor(this.viewStart / step) * step;
    ctx.font = '11px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';
    for (let t = first; this.x(t) < W; t += step) {
      const x = Math.round(this.x(t)) + 0.5;
      if (x < TL.LABEL_W) continue;
      ctx.fillStyle = css.line;
      ctx.fillRect(x, TL.RULER_H, 1, H - TL.RULER_H);
      ctx.fillRect(x, TL.RULER_H - 8, 1, 8);
      ctx.fillStyle = css.muted;
      const label = step < 1 ? formatTC(t, fps) : formatTC(t, fps).slice(0, 8);
      ctx.fillText(label, x + 4, TL.RULER_H / 2 - 1);
    }
    ctx.fillStyle = css.line;
    ctx.fillRect(0, TL.RULER_H - 1, W, 1);

    // tracks
    this.trackHits = [];
    const ty = this.laneTop(0);
    for (const tr of show.tracks) {
      const x0 = this.x(tr.start), x1 = this.x(tr.start + Math.max(tr.duration, 0.5));
      if (x1 < TL.LABEL_W || x0 > W) continue;
      const selected = app.selection.type === 'track' && app.selection.id === tr.id;
      const cx0 = Math.max(x0, TL.LABEL_W), cx1 = Math.min(x1, W);
      ctx.fillStyle = css.track;
      ctx.fillRect(cx0, ty + 4, cx1 - cx0, TL.TRACK_H - 8);
      // waveform
      if (tr.peaks && tr.peaks.length) {
        ctx.fillStyle = css.wave;
        const mid = ty + TL.TRACK_H / 2 + 6;
        const amp = (TL.TRACK_H - 26) / 2;
        const n = tr.peaks.length;
        for (let px = Math.floor(cx0); px < cx1; px++) {
          const a = Math.floor(((px - x0) / (x1 - x0)) * n);
          const b = Math.max(a + 1, Math.floor(((px + 1 - x0) / (x1 - x0)) * n));
          let m = 0;
          for (let k = a; k < b && k < n; k++) if (tr.peaks[k] > m) m = tr.peaks[k];
          const hgt = Math.max(1, (m / 100) * amp);
          ctx.fillRect(px, mid - hgt, 1, hgt * 2);
        }
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx0, ty, cx1 - cx0, TL.TRACK_H);
      ctx.clip();
      ctx.fillStyle = css.text;
      ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillText(tr.name + (app.trackMissing(tr) ? '  (audio file missing)' : ''), Math.max(x0, TL.LABEL_W) + 8, ty + 14);
      ctx.restore();
      if (selected) {
        ctx.strokeStyle = css.select; ctx.lineWidth = 2;
        ctx.strokeRect(cx0 + 1, ty + 5, cx1 - cx0 - 2, TL.TRACK_H - 10);
      }
      this.trackHits.push({ track: tr, x0, x1, y0: ty + 4, y1: ty + TL.TRACK_H - 4 });
    }

    // cues
    this.hits = [];
    const catIndex = new Map(show.categories.map((c, i) => [c.id, i + 1]));
    const cues = show.cues.slice().sort((a, b) => a.time - b.time);
    // Each label stops where the next cue in the same lane starts.
    const nextX = new Map(), seen = new Map();
    for (let i = cues.length - 1; i >= 0; i--) {
      const c = cues[i];
      nextX.set(c.id, seen.has(c.category) ? seen.get(c.category) : Infinity);
      seen.set(c.category, this.x(c.time));
    }
    for (const cue of cues) {
      const lane = catIndex.get(cue.category);
      if (!lane) continue;
      const x = Math.round(this.x(cue.time)) + 0.5;
      if (x < TL.LABEL_W - 200 || x > W + 4) continue;
      const y = this.laneTop(lane), h = this.laneHeight(lane);
      const color = show.categories[lane - 1].color;
      const selected = app.selection.type === 'cue' && app.selection.id === cue.id;
      const fired = now - (app.firedAt.get(cue.id) || -1e9) < 700;
      ctx.save();
      ctx.beginPath();
      ctx.rect(TL.LABEL_W, y, W - TL.LABEL_W, h);
      ctx.clip();
      ctx.fillStyle = color;
      ctx.fillRect(x - (selected ? 1 : 0.5), y + 2, selected ? 2 : 1, h - 4);
      const label = (cue.titan && cue.titan.userNumber ? `L${cue.titan.userNumber}${cue.titan.cue ? 'Q' + cue.titan.cue : ''} ` : '') + (cue.name || 'Cue');
      ctx.font = `${selected ? 600 : 500} 11px system-ui, -apple-system, "Segoe UI", sans-serif`;
      const tw = Math.max(6, Math.min(170, ctx.measureText(label).width + 10, nextX.get(cue.id) - x - 2));
      ctx.globalAlpha = fired ? 1 : selected ? 0.95 : 0.8;
      ctx.fillRect(x, y + 5, tw, 18);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#111';
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y + 5, tw - 3, 18); ctx.clip();
      ctx.fillText(label, x + 5, y + 14.5);
      ctx.restore();
      if (selected) { ctx.strokeStyle = css.select; ctx.lineWidth = 1.5; ctx.strokeRect(x + 0.5, y + 5.5, tw - 1, 17); }
      if (fired) { ctx.fillStyle = color; ctx.globalAlpha = 0.25; ctx.fillRect(x - 6, y, 12, h); ctx.globalAlpha = 1; }
      ctx.restore();
      this.hits.push({ cue, x, x1: x + tw, y0: y + 2, y1: y + h - 2 });
    }

    // label column (drawn last so lanes scroll under it)
    ctx.fillStyle = css.label;
    ctx.fillRect(0, 0, TL.LABEL_W, H);
    ctx.fillStyle = css.line;
    ctx.fillRect(TL.LABEL_W - 1, 0, 1, H);
    ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillStyle = css.muted;
    ctx.fillText(fps.label.toUpperCase(), 10, TL.RULER_H / 2);
    this.lanes.forEach((lane, i) => {
      const y = this.laneTop(i), h = this.laneHeight(i);
      ctx.fillStyle = css.line;
      ctx.fillRect(0, y + h - 1, TL.LABEL_W, 1);
      if (lane.kind === 'track') {
        ctx.fillStyle = css.text;
        ctx.fillText('Tracks', 12, y + h / 2);
      } else {
        ctx.fillStyle = lane.cat.color;
        ctx.fillRect(10, y + h / 2 - 5, 10, 10);
        ctx.fillStyle = css.text;
        ctx.save(); ctx.beginPath(); ctx.rect(0, y, TL.LABEL_W - 8, h); ctx.clip();
        ctx.fillText(lane.cat.name, 28, y + h / 2);
        ctx.restore();
      }
    });

    // markers (section flags on the ruler, faint line down the lanes)
    for (const m of (show.markers || [])) {
      const mx = Math.round(this.x(m.time)) + 0.5;
      if (mx < TL.LABEL_W || mx > W) continue;
      ctx.fillStyle = m.color;
      ctx.globalAlpha = 0.22;
      ctx.fillRect(mx, TL.RULER_H, 1, H - TL.RULER_H);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(mx, TL.RULER_H - 9); ctx.lineTo(mx + 9, TL.RULER_H - 9); ctx.lineTo(mx, TL.RULER_H - 1); ctx.closePath();
      ctx.fill();
      ctx.save();
      ctx.beginPath(); ctx.rect(mx, TL.RULER_H - 1, 160, 13); ctx.clip();
      ctx.fillStyle = m.color;
      ctx.font = '600 10px system-ui, -apple-system, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(m.name, mx + 4, TL.RULER_H + 1);
      ctx.restore();
      ctx.textBaseline = 'middle';
    }

    // playhead
    const ph = app.clock.time(now);
    const px = Math.round(this.x(ph)) + 0.5;
    if (px >= TL.LABEL_W && px <= W) {
      ctx.fillStyle = css.playhead;
      ctx.fillRect(px - 1, 0, 2, H);
      ctx.beginPath();
      ctx.moveTo(px - 6, 0); ctx.lineTo(px + 6, 0); ctx.lineTo(px, 8); ctx.closePath();
      ctx.fill();
    }

    // drop hint while dragging a cue between lanes
    if (this.drag && this.drag.kind === 'cue' && this.drag.moved) {
      ctx.fillStyle = css.text;
      ctx.font = '11px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
      const c = this.drag.cue;
      const text = formatTC(c.time, fps);
      const lx = Math.min(W - 100, Math.max(TL.LABEL_W + 4, this.x(c.time) + 6));
      ctx.fillText(text, lx, TL.RULER_H + 8);
    }
  }

  tickStep() {
    const steps = [1 / 25, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    for (const s of steps) if (s * this.pps >= 90) return s;
    return 3600;
  }

  // ---------- interaction ----------
  bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => this.down(e));
    c.addEventListener('pointermove', e => this.move(e));
    c.addEventListener('pointerup', e => this.up(e));
    c.addEventListener('pointercancel', () => { this.drag = null; });
    c.addEventListener('dblclick', e => this.dbl(e));
    c.addEventListener('wheel', e => this.wheel(e), { passive: false });
  }

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  hitCue(x, y) {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (y >= h.y0 && y <= h.y1 && x >= h.x - 4 && x <= h.x1) return h.cue;
    }
    return null;
  }

  hitTrack(x, y) {
    for (let i = this.trackHits.length - 1; i >= 0; i--) {
      const h = this.trackHits[i];
      if (y >= h.y0 && y <= h.y1 && x >= h.x0 && x <= h.x1) return h.track;
    }
    return null;
  }

  snap(t, rawX) {
    const fps = fpsInfo(this.app.show.fps);
    // Snap to the playhead when close to it.
    const ph = this.app.clock.time();
    if (Math.abs(this.x(ph) - rawX) < 6) return ph;
    return snapToFrame(Math.max(0, t), fps);
  }

  down(e) {
    if (e.button !== 0) return;
    const { x, y } = this.pos(e);
    if (x < TL.LABEL_W) return;
    this.canvas.setPointerCapture(e.pointerId);
    if (y < TL.RULER_H) {
      this.app.locate(Math.max(0, this.t(x)));
      this.drag = this.app.clock.source === 'internal' ? { kind: 'scrub' } : null;
      return;
    }
    const cue = this.hitCue(x, y);
    if (cue) {
      this.app.select('cue', cue.id);
      this.drag = { kind: 'cue', cue, startX: x, startTime: cue.time, moved: false, pushed: false, offset: this.t(x) - cue.time };
      return;
    }
    const tr = this.hitTrack(x, y);
    if (tr) {
      this.app.select('track', tr.id);
      this.drag = { kind: 'track', track: tr, startX: x, startTime: tr.start, moved: false, pushed: false };
      return;
    }
    this.app.select(null);
    this.drag = { kind: 'pan', startX: x, startView: this.viewStart, moved: false };
  }

  move(e) {
    const { x, y } = this.pos(e);
    const d = this.drag;
    if (!d) {
      const over = x >= TL.LABEL_W && (y < TL.RULER_H || this.hitCue(x, y) || this.hitTrack(x, y));
      this.canvas.style.cursor = !over ? 'default' : y < TL.RULER_H ? 'col-resize' : 'grab';
      return;
    }
    if (d.kind === 'scrub') { this.app.locate(Math.max(0, this.t(x))); return; }
    if (Math.abs(x - d.startX) > 3) d.moved = true;
    if (!d.moved) return;
    if (d.kind === 'pan') {
      this.viewStart = Math.max(0, d.startView - (x - d.startX) / this.pps);
      this.userScrolledAt = performance.now();
      return;
    }
    if (!d.pushed) { this.app.history.push(this.app.show); d.pushed = true; }
    if (d.kind === 'cue') {
      d.cue.time = this.snap(this.t(x) - d.offset, x);
      const lane = this.laneAt(y);
      if (lane >= 1) d.cue.category = this.app.show.categories[lane - 1].id;
      this.app.changed({ list: true });
    } else if (d.kind === 'track') {
      d.track.start = this.snap(d.startTime + (x - d.startX) / this.pps, this.x(d.startTime) + (x - d.startX));
      this.app.changed({ list: false });
    }
  }

  up() {
    const d = this.drag;
    this.drag = null;
    if (d && d.pushed) this.app.changed({ list: true, inspector: true });
  }

  dbl(e) {
    const { x, y } = this.pos(e);
    if (x < TL.LABEL_W) return;
    const lane = this.laneAt(y);
    if (lane >= 1 && !this.hitCue(x, y)) {
      this.app.addCue({ time: snapToFrame(Math.max(0, this.t(x)), fpsInfo(this.app.show.fps)), category: this.app.show.categories[lane - 1].id });
    } else if (lane === 0 && !this.hitTrack(x, y)) {
      this.app.pickTrackFile(Math.max(0, this.t(x)));
    }
  }

  wheel(e) {
    e.preventDefault();
    const { x } = this.pos(e);
    if (e.ctrlKey || e.metaKey) {
      this.setZoom(this.pps * Math.exp(-e.deltaY * 0.002), Math.max(TL.LABEL_W, x));
    } else {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      this.viewStart = Math.max(0, this.viewStart + delta / this.pps);
    }
    this.userScrolledAt = performance.now();
  }
}
