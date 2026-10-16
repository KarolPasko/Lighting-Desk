// Extra workflow features: multi-select, copy/paste & groups, markers, live
// operation (GO/panic/blackout), command palette, help, themes, autosave.
// Pure helpers are at the top and unit-tested; the Features class wires the UI.

// ---------- pure helpers ----------

// Shift a set of cues in time, snapped to frames, never below zero.
function offsetCues(cues, delta, fps) {
  return cues.map(c => ({ ...cloneCue(c), time: snapToFrame(Math.max(0, c.time + delta), fps) }));
}

function cloneCue(c) {
  return { time: c.time, name: c.name, category: c.category, notes: c.notes || '', fade: c.fade, titan: c.titan ? { ...c.titan } : null };
}

// Paste copied cues so the earliest lands at targetStart, keeping their spacing.
function pasteCues(copied, targetStart, fps) {
  if (!copied.length) return [];
  const earliest = Math.min(...copied.map(c => c.time));
  return copied.map(c => ({ ...cloneCue(c), time: snapToFrame(Math.max(0, targetStart + (c.time - earliest)), fps) }));
}

// Repeat a copied block `times` times, each `interval` seconds after the last.
// The first copy lands at `start`. Great for "same look every chorus".
function repeatCues(copied, start, interval, times, fps) {
  const out = [];
  for (let n = 0; n < times; n++) out.push(...pasteCues(copied, start + n * interval, fps));
  return out;
}

// Paste a copied block once at each marker time.
function repeatAtMarkers(copied, markerTimes, fps) {
  const out = [];
  for (const t of markerTimes) out.push(...pasteCues(copied, t, fps));
  return out;
}

// For pasted cues, give each a free Titan cue number within its list so pastes
// don't collide with existing cues on the same cue list.
function renumberTitan(pastedCues, show) {
  const maxByList = new Map();
  for (const c of show.cues) if (c.titan && c.titan.userNumber && c.titan.cue)
    maxByList.set(c.titan.userNumber, Math.max(maxByList.get(c.titan.userNumber) || 0, c.titan.cue));
  for (const c of pastedCues) {
    if (!c.titan || !c.titan.userNumber || !c.titan.cue) continue;
    const next = Math.floor(maxByList.get(c.titan.userNumber) || 0) + 1;
    c.titan = { ...c.titan, cue: next };
    maxByList.set(c.titan.userNumber, next);
  }
  return pastedCues;
}

// ---------- interactive controller ----------
if (typeof window !== 'undefined') {
class Features {
  constructor(app, fx) {
    this.app = app;
    this.fx = fx;                 // { toast, fps, download, slug, fireCue, titan, timeline, locate, play, pause, catById }
    this.clipboard = [];          // copied cue objects
    this.standby = 0;             // index into app.sorted for manual GO
    this.manual = !!app.settings.manualGo;
    this.autosaves = [];
    this.loadAutosaves();
    this.bind();
    this.applyTheme(app.settings.accent || 'amber');
    this.renderToolsTab();
    this.startAutosave();
  }

  $(id) { return document.getElementById(id); }
  get sel() { return this.app.selectedCues; }

  // ----- selection helpers -----
  selectedList() {
    const ids = this.app.selectedCues;
    return this.app.show.cues.filter(c => ids.has(c.id)).sort((a, b) => a.time - b.time);
  }

  // ----- clipboard & group ops -----
  copy(cut) {
    const list = this.selectedList();
    if (!list.length) { this.fx.toast('Select one or more cues first (Shift-click to add).'); return; }
    this.clipboard = list.map(cloneCue);
    try { navigator.clipboard.writeText(JSON.stringify({ cueclock: 'cues', cues: this.clipboard }, null, 0)); } catch (_) {}
    if (cut) {
      this.app.history.push(this.app.show);
      const ids = new Set(list.map(c => c.id));
      this.app.show.cues = this.app.show.cues.filter(c => !ids.has(c.id));
      this.app.selectedCues.clear();
      this.app.select(null);
      this.app.changed();
    }
    this.fx.toast(`${cut ? 'Cut' : 'Copied'} ${list.length} cue${list.length === 1 ? '' : 's'}.`);
  }

  async pasteFromSystem() {
    try {
      const text = await navigator.clipboard.readText();
      const data = JSON.parse(text);
      if (data && data.cueclock === 'cues' && Array.isArray(data.cues)) this.clipboard = data.cues.map(cloneCue);
    } catch (_) {}
  }

  paste(at) {
    if (!this.clipboard.length) { this.fx.toast('Nothing copied yet. Select cues and press Ctrl/⌘ C.'); return; }
    const start = at ?? snapToFrame(this.app.clock.time(), this.fx.fps());
    const fresh = renumberTitan(pasteCues(this.clipboard, start, this.fx.fps()), this.app.show);
    this.addCues(fresh, `Pasted ${fresh.length} cue${fresh.length === 1 ? '' : 's'} at the playhead.`);
  }

  duplicate() {
    const list = this.selectedList();
    if (!list.length) return;
    const fps = this.fx.fps();
    const after = Math.max(...list.map(c => c.time)) + 1;
    this.clipboard = list.map(cloneCue);
    const fresh = renumberTitan(pasteCues(this.clipboard, after, fps), this.app.show);
    this.addCues(fresh, `Duplicated ${fresh.length} cue${fresh.length === 1 ? '' : 's'}.`);
  }

  addCues(list, msg, selectThem = true) {
    this.app.history.push(this.app.show);
    const ids = [];
    for (const c of list) { const id = uid(); c.id = id; ids.push(id); this.app.show.cues.push(c); }
    if (selectThem) { this.app.selectedCues = new Set(ids); this.app.select('cue', ids[ids.length - 1]); }
    this.app.changed();
    if (msg) this.fx.toast(msg);
    return ids;
  }

  shiftSelected(delta) {
    const list = this.selectedList();
    if (!list.length) return;
    this.app.history.push(this.app.show);
    const fps = this.fx.fps();
    for (const c of list) c.time = snapToFrame(Math.max(0, c.time + delta), fps);
    this.app.changed({ inspector: true });
    this.fx.toast(`Shifted ${list.length} cue${list.length === 1 ? '' : 's'} by ${delta > 0 ? '+' : ''}${delta.toFixed(2)}s.`);
  }

  // ----- markers -----
  addMarker() {
    const t = snapToFrame(this.app.clock.time(), this.fx.fps());
    this.app.history.push(this.app.show);
    const m = { id: uid(), time: t, name: `Marker ${this.app.show.markers.length + 1}`, color: '#6fb6f2' };
    this.app.show.markers.push(m);
    this.app.changed();
    this.renderMarkers();
    this.fx.toast('Marker added at the playhead. Rename it in the Tools tab.');
  }

  markerTimes() { return this.app.show.markers.map(m => m.time).sort((a, b) => a - b); }

  pasteAtMarkers() {
    if (!this.clipboard.length) { this.fx.toast('Copy some cues first, then paste them at every marker.'); return; }
    const times = this.markerTimes();
    if (!times.length) { this.fx.toast('Add markers first (e.g. at each chorus), then paste.'); return; }
    const fresh = renumberTitan(repeatAtMarkers(this.clipboard, times, this.fx.fps()), this.app.show);
    this.addCues(fresh, `Pasted at ${times.length} marker${times.length === 1 ? '' : 's'} (${fresh.length} cues).`);
  }

  // ----- live operation -----
  setManual(on) {
    this.manual = on;
    this.app.settings.manualGo = on;
    this.app.saveSettingsSoon();
    this.$('goBar').hidden = !on;
    this.$('manualChk').checked = on;
    if (on) { this.standby = this.nextIndex(this.app.clock.time()); this.renderStandby(); }
  }

  nextIndex(t) {
    const i = this.app.sorted.findIndex(c => c.time > t - 1e-6);
    return i < 0 ? this.app.sorted.length : i;
  }

  go() {
    const cue = this.app.sorted[this.standby];
    if (!cue) { this.fx.toast('End of cue list.'); return; }
    this.fx.fireCue(cue, 'manual-go');
    this.fx.toast(`GO — ${cue.name}`);
    this.standby = Math.min(this.app.sorted.length, this.standby + 1);
    this.renderStandby();
  }

  step(d) { this.standby = Math.max(0, Math.min(this.app.sorted.length, this.standby + d)); this.renderStandby(); }

  renderStandby() {
    if (!this.manual) return;
    const cue = this.app.sorted[this.standby];
    const prev = this.app.sorted[this.standby - 1];
    const f = this.fx.fps();
    this.$('goNext').textContent = cue ? cue.name : 'End of list';
    this.$('goNextTc').textContent = cue ? formatTC(cue.time, f) : '';
    this.$('goPrev').textContent = prev ? '⟵ ' + prev.name : '';
  }

  async panic() {
    this.fx.stopAllTracks();
    if (this.fx.titan.reachable) {
      try { await this.fx.titan.releaseAll(); await this.fx.titan.blackout(true); this.fx.toast('PANIC: tracks stopped, console released and blacked out.'); }
      catch (err) { this.fx.toast('PANIC: tracks stopped. Console: ' + err.message); }
    } else {
      this.fx.toast('PANIC: tracks stopped. (No console connected.)');
    }
  }

  async blackout() {
    this.blackedOut = !this.blackedOut;
    this.$('blackoutBtn').classList.toggle('on', this.blackedOut);
    if (this.fx.titan.reachable) {
      try { await this.fx.titan.blackout(this.blackedOut); } catch (err) { this.fx.toast('Blackout: ' + err.message); }
    } else this.fx.toast('No console connected to black out.');
  }

  // ----- fire log -----
  renderLog() {
    const box = this.$('fireLog');
    if (!box || this.$('toolsBody').hidden) return;
    const f = this.fx.fps();
    const rows = this.app.firedLog.slice(0, 40).map(x => {
      const cue = this.app.show.cues.find(c => c.id === x.id);
      if (!cue) return '';
      const titan = cue.titan && cue.titan.userNumber ? ` · L${cue.titan.userNumber}${cue.titan.cue ? 'Q' + cue.titan.cue : ''}` : '';
      return `<li><span class="mono">${new Date(x.at).toLocaleTimeString()}</span><span class="n">${this.app.esc(cue.name)}</span><span class="mono muted">${formatTC(cue.time, f)}${titan}</span></li>`;
    }).join('');
    box.innerHTML = rows || '<li class="muted">No cues fired yet.</li>';
  }

  exportLog() {
    const f = this.fx.fps();
    const rows = [['Fired at', 'Timecode', 'Category', 'Name', 'Titan']];
    for (const x of [...this.app.firedLog].reverse()) {
      const cue = this.app.show.cues.find(c => c.id === x.id);
      if (!cue) continue;
      rows.push([new Date(x.at).toISOString(), formatTC(cue.time, f), this.fx.catName(cue.category), cue.name,
        cue.titan && cue.titan.userNumber ? `List ${cue.titan.userNumber}${cue.titan.cue ? ' Q' + cue.titan.cue : ''}` : '']);
    }
    const csv = rows.map(r => r.map(c => /[",\n]/.test(String(c)) ? '"' + String(c).replace(/"/g, '""') + '"' : c).join(',')).join('\r\n');
    this.fx.download(`${this.fx.slug()}_firelog.csv`, csv, 'text/csv');
  }

  // ----- autosave snapshots -----
  loadAutosaves() { try { this.autosaves = JSON.parse(localStorage.getItem('cueclock-autosaves') || '[]'); } catch (_) { this.autosaves = []; } }
  startAutosave() {
    setInterval(() => {
      if (!this.app.show.cues.length && !this.app.show.tracks.length) return;
      const snap = { at: Date.now(), name: this.app.show.name, json: History.snap(this.app.show) };
      const last = this.autosaves[0];
      if (last && last.json === snap.json) return;
      this.autosaves.unshift(snap);
      if (this.autosaves.length > 10) this.autosaves.length = 10;
      try { localStorage.setItem('cueclock-autosaves', JSON.stringify(this.autosaves)); } catch (_) {}
      if (!this.$('toolsBody').hidden) this.renderAutosaves();
    }, 60000);
  }
  renderAutosaves() {
    const box = this.$('autosaveList');
    if (!box) return;
    box.innerHTML = this.autosaves.map((s, i) =>
      `<li><span class="n">${this.app.esc(s.name)}</span><span class="muted mono">${new Date(s.at).toLocaleString()}</span><button class="btn small" data-restore="${i}">Restore</button></li>`
    ).join('') || '<li class="muted">No snapshots yet. One is kept each minute while you work.</li>';
    box.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', () => this.restore(Number(b.dataset.restore))));
  }
  restore(i) {
    const s = this.autosaves[i];
    if (!s) return;
    this.app.history.push(this.app.show);
    this.fx.restoreShow(this.app.history.restore(this.app.show, s.json));
    this.fx.toast(`Restored the snapshot from ${new Date(s.at).toLocaleTimeString()}. Ctrl/⌘ Z undoes it.`);
  }

  // ----- themes -----
  applyTheme(accent) {
    const map = {
      amber: ['#f2b134', '#ffce6a', '#1a1305'],
      teal: ['#2fd4c4', '#7af0e4', '#042420'],
      blue: ['#4c8dff', '#8fb6ff', '#04132e'],
      green: ['#45d17a', '#8bf0ac', '#06260f'],
      pink: ['#ff6fae', '#ffa6cd', '#2c0518'],
    };
    const [a, a2, ink] = map[accent] || map.amber;
    const r = document.documentElement.style;
    r.setProperty('--accent', a); r.setProperty('--accent-2', a2); r.setProperty('--accent-ink', ink);
    r.setProperty('--warn', accent === 'amber' ? '#ffc24b' : a2);
    this.app.settings.accent = accent;
    this.app.saveSettingsSoon();
    this.app.timeline && this.app.timeline.readColors && this.app.timeline.readColors();
    document.querySelectorAll('[data-accent]').forEach(b => b.classList.toggle('on', b.dataset.accent === accent));
  }

  // ----- command palette -----
  openPalette() {
    this.$('palette').hidden = false;
    const inp = this.$('paletteInput');
    inp.value = '';
    this.paletteList('');
    inp.focus();
  }
  closePalette() { this.$('palette').hidden = true; }
  paletteList(q) {
    const f = this.fx.fps();
    q = q.toLowerCase();
    const items = this.app.sorted
      .map((c, i) => ({ c, i, label: `${formatTC(c.time, f)}  ${c.name}`, sub: this.fx.catName(c.category) }))
      .filter(x => !q || x.label.toLowerCase().includes(q) || x.sub.toLowerCase().includes(q))
      .slice(0, 40);
    this.paletteItems = items;
    this.paletteSel = 0;
    this.$('paletteResults').innerHTML = items.map((x, n) =>
      `<li data-n="${n}" class="${n === 0 ? 'sel' : ''}"><span class="mono">${this.app.esc(formatTC(x.c.time, f))}</span><span class="n">${this.app.esc(x.c.name)}</span><span class="muted">${this.app.esc(x.sub)}</span></li>`
    ).join('') || '<li class="muted">No matching cue.</li>';
    this.$('paletteResults').querySelectorAll('li[data-n]').forEach(li =>
      li.addEventListener('click', () => this.paletteGo(Number(li.dataset.n))));
  }
  paletteMove(d) {
    if (!this.paletteItems || !this.paletteItems.length) return;
    this.paletteSel = (this.paletteSel + d + this.paletteItems.length) % this.paletteItems.length;
    this.$('paletteResults').querySelectorAll('li[data-n]').forEach((li, n) => li.classList.toggle('sel', n === this.paletteSel));
    const el = this.$('paletteResults').querySelector('li.sel');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
  paletteGo(n) {
    const x = this.paletteItems[n ?? this.paletteSel];
    if (!x) return;
    this.closePalette();
    this.app.selectedCues = new Set([x.c.id]);
    this.app.select('cue', x.c.id);
    this.app.locate(x.c.time);
  }

  // ----- help overlay -----
  toggleHelp(force) { this.$('helpOverlay').hidden = force === undefined ? !this.$('helpOverlay').hidden : !force; }

  // ----- import -----
  importText(text) {
    const res = importCsv(text, this.app.show);
    if (res.error && !res.count) { this.fx.toast(res.error); return; }
    const cues = res.cues.map(c => ({ ...c, id: uid() }));
    this.app.history.push(this.app.show);
    this.app.show.cues.push(...cues);
    this.app.changed();
    this.fx.toast(`Imported ${res.count} cue${res.count === 1 ? '' : 's'}${res.skipped ? `, skipped ${res.skipped}` : ''}.`);
    this.$('importBox').hidden = true;
  }

  // ----- exports -----
  exportAvolites() { this.fx.download(`${this.fx.slug()}_avolites.csv`, exportAvolitesCsv(this.app.show), 'text/csv'); this.fx.toast('Exported the Avolites timecode sheet (CSV).'); }
  exportAvolitesSheet() { this.fx.openPrintable(exportAvolitesSheet(this.app.show), `${this.fx.slug()}_avolites_sheet`); }
  exportQlab() { this.fx.download(`${this.fx.slug()}_qlab.csv`, exportQlabCsv(this.app.show), 'text/csv'); }
  exportSheet() { this.fx.openPrintable(exportCueSheet(this.app.show), `${this.fx.slug()}_cue_sheet`); }

  // ----- render the Tools tab -----
  renderMarkers() {
    const box = this.$('markerList');
    if (!box) return;
    const f = this.fx.fps();
    const ms = this.app.show.markers.slice().sort((a, b) => a.time - b.time);
    box.innerHTML = ms.map(m =>
      `<li data-id="${m.id}"><input type="color" value="${m.color}" aria-label="colour"><input type="text" value="${this.app.esc(m.name)}" maxlength="40"><span class="mono muted">${formatTC(m.time, f)}</span><button class="btn small" data-jump>Go</button><button class="btn small danger" data-del>✕</button></li>`
    ).join('') || '<li class="muted">No markers. Add one at the playhead to mark a chorus or section.</li>';
    box.querySelectorAll('li[data-id]').forEach(li => {
      const m = this.app.show.markers.find(x => x.id === li.dataset.id);
      const [color, name] = li.querySelectorAll('input');
      color.addEventListener('input', () => { m.color = color.value; this.app.changed({ list: false }); });
      name.addEventListener('change', () => { m.name = name.value; this.app.changed({ list: false }); });
      li.querySelector('[data-jump]').addEventListener('click', () => this.app.locate(m.time));
      li.querySelector('[data-del]').addEventListener('click', () => {
        this.app.history.push(this.app.show);
        this.app.show.markers = this.app.show.markers.filter(x => x.id !== m.id);
        this.app.changed(); this.renderMarkers();
      });
    });
  }

  renderToolsTab() {
    this.renderMarkers();
    this.renderAutosaves();
    this.renderLog();
  }

  // ----- bindings -----
  bind() {
    const click = (id, fn) => { const el = this.$(id); if (el) el.addEventListener('click', fn); };
    click('addMarkerBtn', () => this.addMarker());
    click('pasteMarkersBtn', () => this.pasteAtMarkers());
    click('copyCuesBtn', () => this.copy(false));
    click('pasteCuesBtn', () => this.paste());
    click('dupCuesBtn', () => this.duplicate());
    click('shiftBtn', () => {
      const v = parseFloat(this.$('shiftAmount').value);
      if (Number.isFinite(v)) this.shiftSelected(this.$('shiftDir').value === '-' ? -v : v);
    });
    this.$('manualChk') && this.$('manualChk').addEventListener('change', e => this.setManual(e.target.checked));
    click('goBtn', () => this.go());
    click('goNextBtn', () => this.step(1));
    click('goPrevBtn', () => this.step(-1));
    click('panicBtn', () => this.panic());
    click('blackoutBtn', () => this.blackout());
    click('exportLogBtn', () => this.exportLog());
    click('exportAvoBtn', () => this.exportAvolites());
    click('exportAvoSheetBtn', () => this.exportAvolitesSheet());
    click('exportQlabBtn', () => this.exportQlab());
    click('exportSheetBtn', () => this.exportSheet());
    click('importBtn', () => { this.$('importBox').hidden = false; this.$('importText').value = ''; this.$('importText').focus(); });
    click('importFileBtn', () => this.$('importFile').click());
    this.$('importFile') && this.$('importFile').addEventListener('change', async e => {
      const file = e.target.files[0]; e.target.value = '';
      if (file) this.importText(await file.text());
    });
    click('importGoBtn', () => this.importText(this.$('importText').value));
    click('importCancelBtn', () => { this.$('importBox').hidden = true; });
    document.querySelectorAll('[data-accent]').forEach(b => b.addEventListener('click', () => this.applyTheme(b.dataset.accent)));

    // command palette
    click('paletteClose', () => this.closePalette());
    const inp = this.$('paletteInput');
    if (inp) {
      inp.addEventListener('input', () => this.paletteList(inp.value));
      inp.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); this.paletteMove(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); this.paletteMove(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); this.paletteGo(); }
      });
    }
    this.$('palette') && this.$('palette').addEventListener('click', e => { if (e.target.id === 'palette') this.closePalette(); });
    click('helpClose', () => this.toggleHelp(false));
    this.$('helpBtn') && this.$('helpBtn').addEventListener('click', () => this.toggleHelp(true));

    // global keys (runs after app's own handler; app returns early for mod keys)
    document.addEventListener('keydown', e => {
      const tag = e.target.tagName;
      const typing = (tag === 'INPUT' && !['checkbox', 'radio', 'range', 'color'].includes(e.target.type)) || tag === 'TEXTAREA';
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') {
        if (!this.$('palette').hidden) this.closePalette();
        else if (!this.$('helpOverlay').hidden) this.toggleHelp(false);
        else if (!this.$('importBox').hidden) this.$('importBox').hidden = true;
        return;
      }
      if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); this.openPalette(); return; }
      if (typing) return;
      if (mod && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); this.copy(false); }
      else if (mod && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); this.copy(true); }
      else if (mod && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); this.pasteFromSystem().then(() => this.paste()); }
      else if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); this.duplicate(); }
      else if (mod && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); this.app.selectAllVisible(); }
      else if (!mod && e.key === '?') { this.toggleHelp(); }
      else if (!mod && (e.key === 'm' || e.key === 'M')) { this.addMarker(); }
      else if (!mod && (e.key === 'g' || e.key === 'G') && this.manual) { e.preventDefault(); this.go(); }
    });
  }
}
window.Features = Features;
}

if (typeof module !== 'undefined') module.exports = {
  offsetCues, cloneCue, pasteCues, repeatCues, repeatAtMarkers, renumberTitan,
};