// Cue Clock: wires the show, clock, timecode I/O, Avolites link and UI together.
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- example show for the very first open ----------
  function exampleShow() {
    const s = newShow();
    s.name = 'Example show';
    const add = (time, category, name, titan) => s.cues.push({ id: uid(), time, category, name, notes: '', titan: titan || null });
    add(2, 'audio', 'Walk-in music fades');
    add(4, 'lighting', 'House to half', { userNumber: 1, cue: 2, legend: 'Preshow' });
    add(8, 'lighting', 'Blackout', { userNumber: 1, cue: 3, legend: 'Preshow' });
    add(9, 'video', 'Logo sting');
    add(12, 'stage', 'Haze on');
    add(14, 'lighting', 'Song 1 intro', { userNumber: 2, cue: 1, legend: 'Song 1 Looks' });
    add(22.5, 'lighting', 'First chorus hit', { userNumber: 2, cue: 2, legend: 'Song 1 Looks' });
    add(23, 'stage', 'CO2 burst');
    add(30, 'audio', 'Click track stops');
    return s;
  }

  // ---------- state ----------
  const app = {
    show: loadShow() || exampleShow(),
    settings: loadSettings(),
    history: new History(),
    clock: new Clock(),
    selection: { type: null, id: null },
    firedAt: new Map(),   // cue id -> performance.now() when fired
    firedLog: [],         // most recent first: { id, at }
    sorted: [],
    players: new Map(),   // track id -> { audio, url }
    audioChecked: new Set(),
    selectedCues: new Set(), // ids in the current multi-selection
  };
  window.cueClock = app; // handy from the browser console
  app.esc = esc;
  app.bridgeBase = () => (app.settings.bridgeUrl || '').replace(/\/+$/, '') || (location.protocol.startsWith('http') ? location.origin : 'http://localhost:8080');

  let saveTimer = 0, settingsTimer = 0;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { if (!saveShowNow(app.show)) toast('Could not save in this browser. Use Show → Save show to keep a copy.'); }, 400);
  }
  app.saveSettingsSoon = () => { clearTimeout(settingsTimer); settingsTimer = setTimeout(() => saveSettings(app.settings), 300); };

  const fps = () => fpsInfo(app.show.fps);
  const catById = id => app.show.categories.find(c => c.id === id);
  app.catById = catById;

  function resort() { app.sorted = app.show.cues.slice().sort((a, b) => a.time - b.time); }

  app.changed = (what = {}) => {
    resort();
    saveSoon();
    if (what.list !== false) renderCueList();
    if (what.inspector) renderInspector();
    if (what.categories) { renderCategoryControls(); renderCatList(); }
    if (what.titan) renderTitan();
    if (app.features) { if (app.features.manual) app.features.renderStandby(); if (!$('toolsBody').hidden) app.features.renderToolsTab(); }
  };

  // ---------- toast ----------
  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  // ---------- timeline ----------
  const timeline = new Timeline($('timeline'), app);
  const network = new NetworkView(app);

  // ---------- selection ----------
  app.select = (type, id, keepMulti) => {
    app.selection = { type, id: id || null };
    if (type === 'cue' && id) { if (!keepMulti) app.selectedCues = new Set([id]); }
    else if (!type) app.selectedCues.clear();
    renderInspector();
    highlightRows();
    if (type) showTab('inspector');
  };

  app.selectAllVisible = () => {
    app.selectedCues = new Set(app.sorted.map(c => c.id));
    if (app.sorted.length) app.selection = { type: 'cue', id: app.sorted[app.sorted.length - 1].id };
    renderInspector();
    highlightRows();
    toast(`Selected ${app.sorted.length} cues.`);
  };

  function selectedCue() { return app.selection.type === 'cue' ? app.show.cues.find(c => c.id === app.selection.id) : null; }
  function selectedTrack() { return app.selection.type === 'track' ? app.show.tracks.find(t => t.id === app.selection.id) : null; }

  // ---------- transport ----------
  let needChase = true, jumpAt = 0;
  function markJump() { needChase = true; jumpAt = performance.now(); }

  app.locate = t => {
    if (app.clock.source !== 'internal') {
      toast('The playhead is following incoming timecode. Switch the clock to Internal to move it.');
      return;
    }
    app.clock.locate(t);
    markJump();
  };

  function togglePlay() {
    if (app.clock.source !== 'internal') {
      toast(`The clock is following ${app.clock.source.toUpperCase()} in. Start playback on the timecode source, or switch to Internal.`);
      return;
    }
    if (app.clock.running) app.clock.pause(); else app.clock.play();
  }

  function toStart() {
    const starts = app.show.tracks.map(t => t.start);
    app.locate(starts.length ? Math.min(...starts) : 0);
  }

  // ---------- cues ----------
  function nextCueName() { return `Cue ${app.show.cues.length + 1}`; }

  app.addCue = (opts = {}) => {
    app.history.push(app.show);
    const cue = {
      id: uid(),
      time: opts.time ?? snapToFrame(app.clock.time(), fps()),
      name: opts.name || nextCueName(),
      category: opts.category || (catById(app.settings.newCueCategory) ? app.settings.newCueCategory : app.show.categories[0].id),
      notes: '',
      titan: opts.titan || null,
    };
    app.show.cues.push(cue);
    app.changed();
    app.select('cue', cue.id);
    return cue;
  };

  function deleteSelected() {
    const cue = selectedCue(), tr = selectedTrack();
    if (cue && app.selectedCues.size > 1) {
      const ids = new Set(app.selectedCues);
      const n = ids.size;
      app.history.push(app.show);
      app.show.cues = app.show.cues.filter(c => !ids.has(c.id));
      app.selectedCues.clear();
      app.select(null);
      app.changed();
      toast(`Deleted ${n} cues. Ctrl/⌘ Z brings them back.`);
    } else if (cue) {
      app.history.push(app.show);
      app.show.cues = app.show.cues.filter(c => c !== cue);
      app.select(null);
      app.changed();
      toast(`Deleted "${cue.name}". Ctrl/⌘ Z brings it back.`);
    } else if (tr) {
      app.history.push(app.show);
      app.show.tracks = app.show.tracks.filter(t => t !== tr);
      dropPlayer(tr.id);
      AudioStore.remove(tr.id);
      app.select(null);
      app.changed();
      toast(`Deleted track "${tr.name}".`);
    }
  }

  function nudge(seconds) {
    const cue = selectedCue(), tr = selectedTrack();
    if (!cue && !tr) return;
    app.history.push(app.show);
    if (cue) cue.time = snapToFrame(Math.max(0, cue.time + seconds), fps());
    if (tr) tr.start = Math.max(0, tr.start + seconds);
    app.changed({ inspector: true });
  }

  function undo(redo) {
    const restored = redo ? app.history.redo(app.show) : app.history.undo(app.show);
    if (!restored) { toast(redo ? 'Nothing to redo.' : 'Nothing to undo.'); return; }
    app.show = restored;
    syncPlayersToTracks();
    if (app.selection.id && !app.show.cues.some(c => c.id === app.selection.id) && !app.show.tracks.some(t => t.id === app.selection.id)) app.selection = { type: null, id: null };
    $('showName').value = app.show.name;
    app.changed({ inspector: true, categories: true, titan: true });
  }

  // ---------- firing ----------
  let bridgeWarnedAt = 0;
  function fireCue(cue, reason) {
    app.firedAt.set(cue.id, performance.now());
    app.firedLog.unshift({ id: cue.id, at: Date.now() });
    if (app.firedLog.length > 30) app.firedLog.pop();
    if (cue.titan && cue.titan.userNumber) sendTitan(cue, reason);
  }

  function sendTitan(cue) {
    if (!titan.reachable) {
      if (performance.now() - bridgeWarnedAt > 5000) {
        toast(`"${cue.name}" wasn't sent to the console: the Avolites bridge isn't running.`);
        bridgeWarnedAt = performance.now();
      }
      return;
    }
    titan.go(cue.titan.userNumber, cue.titan.cue).catch(err => toast(`Console didn't take "${cue.name}": ${err.message}`));
  }

  // After a jump, put each linked cue list on the cue that should be live at this point.
  function chase(t) {
    if (!app.settings.chaseTitan || !titan.reachable) return;
    const latest = new Map();
    for (const cue of app.sorted) {
      if (cue.time > t + 1e-6) break;
      if (cue.titan && cue.titan.userNumber && cue.titan.cue) latest.set(cue.titan.userNumber, cue);
    }
    for (const cue of latest.values()) sendTitan(cue);
  }

  // ---------- engine (runs on a worker-driven tick so it keeps time in the background) ----------
  const midi = new MidiIO(() => renderMidi());
  const mtcSender = new MtcSender(midi);
  const ltc = new LtcIO();
  const mtcDecoder = new MtcDecoder((t, offsetFrames) => {
    if (app.clock.source !== 'mtc') return;
    const f = fpsInfo(t.rateKey);
    app.clock.external(framesToSeconds(partsToFrames(t, f) + offsetFrames, f), performance.now(), t.rateKey);
  });
  midi.onMessage = data => mtcDecoder.handle(data);
  ltc.onFrame = fr => {
    if (app.clock.source !== 'ltc') return;
    const key = fr.drop ? '29.97df' : [24, 25, 30].reduce((a, b) => (Math.abs(b - fr.fps) < Math.abs(a - fr.fps) ? b : a)).toString();
    const f = fpsInfo(key);
    if (fr.f >= f.nominal) return;
    app.clock.external(framesToSeconds(partsToFrames(fr, f) + 1, f), performance.now(), key);
  };

  let lastT = app.clock.time(), lastRunning = false, lastLtcSync = 0;
  function engineTick() {
    const now = performance.now();
    const clock = app.clock;
    const t = clock.time(now);
    const running = clock.isRunning(now);
    const f = fps();

    if (running && lastRunning && t >= lastT && t - lastT < 0.5) {
      for (const cue of app.sorted) {
        if (cue.time > t) break;
        if (cue.time > lastT) fireCue(cue, 'time');
      }
    } else if (Math.abs(t - lastT) > 0.5 / f.rate) {
      markJump();
    }
    if (needChase && running && now - jumpAt > 300) { needChase = false; chase(t); }
    lastT = t; lastRunning = running;

    mtcSender.tick(clock, f, now);
    if (now - lastLtcSync > 40) { lastLtcSync = now; ltc.sync(clock, f, app.settings.ltcGain, now); }
    syncTracks(t, running);
  }

  try {
    const w = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 10);'], { type: 'text/javascript' })));
    w.onmessage = engineTick;
  } catch (_) {
    setInterval(engineTick, 10);
  }

  // ---------- audio tracks ----------
  function dropPlayer(id) {
    const p = app.players.get(id);
    if (p) { p.audio.pause(); URL.revokeObjectURL(p.url); app.players.delete(id); }
  }

  function attachPlayer(id, blob) {
    dropPlayer(id);
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    audio.preload = 'auto';
    audio.src = url;
    if (app.settings.trackOutDevice && audio.setSinkId) audio.setSinkId(app.settings.trackOutDevice).catch(() => {});
    app.players.set(id, { audio, url });
  }

  async function syncPlayersToTracks() {
    const ids = new Set(app.show.tracks.map(t => t.id));
    for (const id of [...app.players.keys()]) if (!ids.has(id)) dropPlayer(id);
    for (const tr of app.show.tracks) {
      if (app.players.has(tr.id)) continue;
      const blob = await AudioStore.get(tr.id);
      if (blob) attachPlayer(tr.id, blob);
      app.audioChecked.add(tr.id);
    }
    renderInspector();
  }

  app.trackMissing = tr => app.audioChecked.has(tr.id) && !app.players.has(tr.id);

  function syncTracks(t, running) {
    const play = running && (app.clock.source === 'internal' || app.settings.playWhenChasing);
    for (const tr of app.show.tracks) {
      const p = app.players.get(tr.id);
      if (!p) continue;
      const a = p.audio;
      const inside = t >= tr.start && t < tr.start + tr.duration;
      if (play && inside) {
        const pos = t - tr.start;
        if (a.paused) {
          a.currentTime = pos;
          a.play().catch(() => {});
        } else if (Math.abs(a.currentTime - pos) > 0.15) {
          a.currentTime = pos;
        }
      } else if (!a.paused) {
        a.pause();
      }
    }
  }

  let pendingTrackStart = null;
  app.pickTrackFile = at => { pendingTrackStart = at ?? null; $('trackFile').click(); };

  async function addTrackFromFile(file) {
    toast(`Reading "${file.name}"…`);
    let info;
    try { info = await analyseAudio(file); } catch (err) {
      toast(`Couldn't read "${file.name}". Try a WAV, MP3, AAC or FLAC file.`);
      return;
    }
    const lastEnd = app.show.tracks.reduce((m, t) => Math.max(m, t.start + t.duration), 0);
    const tr = {
      id: uid(),
      name: file.name.replace(/\.[^.]+$/, ''),
      start: snapToFrame(pendingTrackStart ?? lastEnd, fps()),
      duration: info.duration,
      peaks: info.peaks,
    };
    pendingTrackStart = null;
    app.history.push(app.show);
    app.show.tracks.push(tr);
    attachPlayer(tr.id, file);
    app.audioChecked.add(tr.id);
    if (!(await AudioStore.put(tr.id, file))) toast('The audio is loaded, but this browser could not store it. You may need to relink it next time.');
    if (app.show.tracks.length === 1) timeline.fit();
    app.changed();
    app.select('track', tr.id);
  }

  async function relinkTrack(tr, file) {
    let info;
    try { info = await analyseAudio(file); } catch (_) { toast(`Couldn't read "${file.name}".`); return; }
    app.history.push(app.show);
    tr.duration = info.duration;
    tr.peaks = info.peaks;
    attachPlayer(tr.id, file);
    await AudioStore.put(tr.id, file);
    app.changed({ inspector: true });
    toast(`Relinked "${tr.name}".`);
  }

  // ---------- cue list ----------
  let rowRefs = [];
  function renderCueList() {
    const body = $('cueBody');
    const f = fps();
    body.innerHTML = '';
    rowRefs = [];
    app.sorted.forEach((cue, i) => {
      const cat = catById(cue.category);
      const tr = document.createElement('tr');
      tr.dataset.id = cue.id;
      const titanText = cue.titan && cue.titan.userNumber
        ? `List ${cue.titan.userNumber} · ${cue.titan.cue ? 'cue ' + cue.titan.cue : 'Go'}` : '';
      tr.innerHTML = `<td class="muted">${i + 1}</td><td class="time">${formatTC(cue.time, f)}</td>
        <td><span class="cat-chip"><i style="background:${esc(cat ? cat.color : '#888')}"></i>${esc(cat ? cat.name : 'Uncategorised')}</span></td>
        <td class="name">${esc(cue.name)}</td><td class="muted">${esc(titanText)}</td><td class="cd"></td>`;
      body.appendChild(tr);
      rowRefs.push({ tr, cd: tr.lastElementChild, cue, state: '' });
    });
    $('cueEmpty').hidden = app.sorted.length > 0;
    $('cueTable').hidden = app.sorted.length === 0;
    $('cueCount').textContent = app.sorted.length ? `${app.sorted.length} cue${app.sorted.length === 1 ? '' : 's'}` : '';
    highlightRows();
    updateCountdowns(app.clock.time());
  }

  function highlightRows() {
    for (const r of rowRefs) {
      r.tr.classList.toggle('sel', app.selection.type === 'cue' && r.cue.id === app.selection.id);
      r.tr.classList.toggle('multi', app.selectedCues.has(r.cue.id));
    }
  }

  function updateCountdowns(t) {
    let nextFound = false;
    for (const r of rowRefs) {
      const dt = r.cue.time - t;
      let state;
      if (dt < -1e-6) state = 'past';
      else if (!nextFound) { state = 'next'; nextFound = true; }
      else state = '';
      if (state !== r.state) {
        r.tr.classList.toggle('past', state === 'past');
        r.tr.classList.toggle('next', state === 'next');
        r.state = state;
      }
      const text = dt < -1e-6 ? '' : formatCountdown(dt);
      if (r.cd.textContent !== text) r.cd.textContent = text;
    }
  }

  let lastClickedCue = null;
  $('cueBody').addEventListener('click', e => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;
    if (e.shiftKey && lastClickedCue) {
      // range select in time order
      const ids = app.sorted.map(c => c.id);
      const a = ids.indexOf(lastClickedCue), b = ids.indexOf(id);
      if (a >= 0 && b >= 0) { for (let i = Math.min(a, b); i <= Math.max(a, b); i++) app.selectedCues.add(ids[i]); }
      app.select('cue', id, true);
    } else if (e.ctrlKey || e.metaKey) {
      if (app.selectedCues.has(id)) app.selectedCues.delete(id); else app.selectedCues.add(id);
      app.select('cue', id, true);
      lastClickedCue = id;
    } else {
      app.select('cue', id);
      lastClickedCue = id;
    }
  });
  $('cueBody').addEventListener('dblclick', e => {
    const tr = e.target.closest('tr');
    const cue = tr && app.show.cues.find(c => c.id === tr.dataset.id);
    if (cue) app.locate(cue.time);
  });

  // ---------- inspector ----------
  function setVal(el, v) { if (document.activeElement !== el) el.value = v; }

  function renderInspector() {
    const cue = selectedCue(), tr = selectedTrack();
    $('inspNone').hidden = !!(cue || tr);
    $('inspCue').hidden = !cue;
    $('inspTrack').hidden = !tr;
    const f = fps();
    if (cue) {
      setVal($('cueName'), cue.name);
      setVal($('cueTc'), formatTC(cue.time, f));
      $('cueTcError').hidden = true;
      const sel = $('cueCategory');
      sel.innerHTML = app.show.categories.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
      sel.value = cue.category;
      setVal($('cueFade'), cue.fade != null ? cue.fade : '');
      setVal($('cueNotes'), cue.notes);
      const n = app.selectedCues.size;
      $('multiNote').hidden = n <= 1;
      if (n > 1) $('multiNote').textContent = `${n} cues selected — Copy, Duplicate, Delete and Shift act on all of them (Tools tab).`;
      renderCueTitan(cue);
    }
    if (tr) {
      setVal($('trackName'), tr.name);
      setVal($('trackStart'), formatTC(tr.start, f));
      $('trackStartError').hidden = true;
      $('trackLen').textContent = formatCountdown(tr.duration);
      $('trackEnd').textContent = formatTC(tr.start + tr.duration, f);
      $('trackMissing').hidden = !app.trackMissing(tr);
    }
  }

  function renderCueTitan(cue) {
    const sel = $('cueTitanList');
    const lists = titan.cueLists();
    const un = cue.titan ? cue.titan.userNumber : '';
    let opts = '<option value="">Not linked</option>';
    let found = false;
    for (const l of lists) {
      if (Number(l.userNumber) === Number(un)) found = true;
      opts += `<option value="${esc(l.userNumber)}">${esc(l.userNumber)} · ${esc(l.legend || 'Cue list')}</option>`;
    }
    if (un && !found) opts += `<option value="${esc(un)}">${esc(un)} · ${esc(cue.titan.legend || 'Cue list')} (not seen on console)</option>`;
    if (document.activeElement !== sel) { sel.innerHTML = opts; sel.value = un ? String(un) : ''; }
    const cueInput = $('cueTitanCue');
    cueInput.disabled = !un;
    setVal(cueInput, cue.titan && cue.titan.cue ? cue.titan.cue : '');
  }

  // Push one undo step per editing session of a field.
  function bindEdit(el, evt, apply) {
    let pending = true;
    el.addEventListener('focus', () => { pending = true; });
    el.addEventListener(evt, () => {
      if (pending) { app.history.push(app.show); pending = false; }
      apply();
    });
  }

  bindEdit($('cueName'), 'input', () => { const c = selectedCue(); if (c) { c.name = $('cueName').value; app.changed(); } });
  bindEdit($('cueNotes'), 'input', () => { const c = selectedCue(); if (c) { c.notes = $('cueNotes').value; app.changed({ list: false }); } });
  bindEdit($('cueFade'), 'input', () => {
    const c = selectedCue();
    if (!c) return;
    const v = parseFloat($('cueFade').value);
    c.fade = Number.isFinite(v) && v > 0 ? v : undefined;
    app.changed({ list: false });
  });
  $('cueTc').addEventListener('change', () => {
    const c = selectedCue();
    if (!c) return;
    const t = parseTC($('cueTc').value, fps());
    if (t === null) {
      $('cueTcError').textContent = `Use HH:MM:SS:FF, for example 00:01:30:00. Frames go up to ${fps().nominal - 1}.`;
      $('cueTcError').hidden = false;
      return;
    }
    app.history.push(app.show);
    c.time = t;
    $('cueTc').value = formatTC(t, fps());
    $('cueTcError').hidden = true;
    app.changed();
  });
  $('cueToPlayhead').addEventListener('click', () => {
    const c = selectedCue();
    if (!c) return;
    app.history.push(app.show);
    c.time = snapToFrame(app.clock.time(), fps());
    app.changed({ inspector: true });
  });
  $('cueCategory').addEventListener('change', () => {
    const c = selectedCue();
    if (!c) return;
    app.history.push(app.show);
    c.category = $('cueCategory').value;
    app.changed();
  });
  $('cueTitanList').addEventListener('change', () => {
    const c = selectedCue();
    if (!c) return;
    app.history.push(app.show);
    const un = Number($('cueTitanList').value);
    if (!un) c.titan = null;
    else {
      const l = titan.cueLists().find(x => Number(x.userNumber) === un);
      c.titan = { userNumber: un, cue: c.titan ? c.titan.cue : nextTitanCue(un), legend: l ? l.legend : (c.titan ? c.titan.legend : '') };
    }
    app.changed({ inspector: true, titan: true });
  });
  bindEdit($('cueTitanCue'), 'input', () => {
    const c = selectedCue();
    if (!c || !c.titan) return;
    const v = Number($('cueTitanCue').value);
    c.titan.cue = v > 0 ? v : null;
    app.changed({ titan: true });
  });
  $('cueGoto').addEventListener('click', () => { const c = selectedCue(); if (c) app.locate(c.time); });
  $('cueFire').addEventListener('click', () => {
    const c = selectedCue();
    if (!c) return;
    fireCue(c, 'manual');
    toast(c.titan ? `Fired "${c.name}" (cue list ${c.titan.userNumber}${c.titan.cue ? ', cue ' + c.titan.cue : ''}).` : `Fired "${c.name}".`);
  });
  $('cueDelete').addEventListener('click', deleteSelected);
  $('inspCue').addEventListener('submit', e => e.preventDefault());
  $('inspTrack').addEventListener('submit', e => e.preventDefault());

  bindEdit($('trackName'), 'input', () => { const t = selectedTrack(); if (t) { t.name = $('trackName').value; app.changed({ list: false }); } });
  $('trackStart').addEventListener('change', () => {
    const tr = selectedTrack();
    if (!tr) return;
    const t = parseTC($('trackStart').value, fps());
    if (t === null) { $('trackStartError').textContent = 'Use HH:MM:SS:FF.'; $('trackStartError').hidden = false; return; }
    app.history.push(app.show);
    tr.start = t;
    app.changed({ inspector: true, list: false });
  });
  $('trackRelink').addEventListener('click', () => $('relinkFile').click());
  $('relinkFile').addEventListener('change', e => {
    const file = e.target.files[0], tr = selectedTrack();
    if (file && tr) relinkTrack(tr, file);
    e.target.value = '';
  });
  $('trackGoto').addEventListener('click', () => { const t = selectedTrack(); if (t) app.locate(t.start); });
  $('trackDelete').addEventListener('click', deleteSelected);
  $('trackFile').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) addTrackFromFile(file);
    e.target.value = '';
  });

  // ---------- tabs ----------
  function showTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === name));
    document.querySelectorAll('.tab-body').forEach(b => { b.hidden = b.dataset.body !== name; });
    if (name === 'tools' && app.features) app.features.renderToolsTab();
  }
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));

  // ---------- categories ----------
  function renderCategoryControls() {
    const sel = $('newCueCategory');
    sel.innerHTML = app.show.categories.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    if (!catById(app.settings.newCueCategory)) app.settings.newCueCategory = app.show.categories[0].id;
    sel.value = app.settings.newCueCategory;
  }
  $('newCueCategory').addEventListener('change', e => { app.settings.newCueCategory = e.target.value; app.saveSettingsSoon(); });

  function renderCatList() {
    const ul = $('catList');
    ul.innerHTML = '';
    for (const c of app.show.categories) {
      const li = document.createElement('li');
      li.innerHTML = `<input type="color" aria-label="Colour"><input type="text" maxlength="40" aria-label="Category name"><button class="btn small danger">Remove</button>`;
      const [color, name, del] = li.children;
      color.value = c.color;
      name.value = c.name;
      color.addEventListener('input', () => { c.color = color.value; app.changed(); });
      color.addEventListener('focus', () => app.history.push(app.show));
      bindEdit(name, 'input', () => { c.name = name.value || 'Category'; app.changed(); renderCategoryControls(); });
      del.addEventListener('click', () => {
        const count = app.show.cues.filter(q => q.category === c.id).length;
        if (count) { toast(`Move or delete the ${count} cue${count === 1 ? '' : 's'} in ${c.name} first.`); return; }
        if (app.show.categories.length === 1) { toast('A show needs at least one category.'); return; }
        app.history.push(app.show);
        app.show.categories = app.show.categories.filter(x => x !== c);
        app.changed({ categories: true });
      });
      ul.appendChild(li);
    }
  }
  $('addCatBtn').addEventListener('click', () => {
    app.history.push(app.show);
    const color = CATEGORY_COLORS[app.show.categories.length % CATEGORY_COLORS.length];
    app.show.categories.push({ id: uid(), name: 'New category', color });
    app.changed({ categories: true });
    const inputs = $('catList').querySelectorAll('input[type=text]');
    const last = inputs[inputs.length - 1];
    if (last) { last.focus(); last.select(); }
  });

  // ---------- show tab ----------
  $('showFps').innerHTML = Object.values(FPS_OPTIONS).map(o => `<option value="${o.key}">${o.label}</option>`).join('');
  $('showFps').addEventListener('change', e => {
    app.history.push(app.show);
    app.show.fps = e.target.value;
    app.changed({ inspector: true });
  });
  $('showName').addEventListener('input', e => { app.show.name = e.target.value; saveSoon(); });

  function slug(s) { return (String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'show'); }
  function download(name, text, type) {
    if (window.__previewDownload) return window.__previewDownload(name, text);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // Open a generated HTML page (sheet) so the user can read/print it.
  function openPrintable(html, name) {
    if (window.__previewDownload) { window.__previewDownload(name + '.html', html); return; }
    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); toast('Sheet opened in a new tab. Print it with Ctrl/⌘ P.'); }
    else { download(name + '.html', html, 'text/html'); toast('Saved the sheet as HTML. Open it and print with Ctrl/⌘ P.'); }
  }

  function stopAllTracks() {
    for (const p of app.players.values()) { try { p.audio.pause(); } catch (_) {} }
    if (app.clock.source === 'internal') app.clock.pause();
  }
  $('exportPyBtn').addEventListener('click', () => {
    download(`${slug(app.show.name)}_cues.py`, exportPython(app.show), 'text/x-python');
    toast('Exported the cue list as Python.');
  });
  $('exportCsvBtn').addEventListener('click', () => download(`${slug(app.show.name)}_cues.csv`, exportCsv(app.show), 'text/csv'));
  $('saveShowBtn').addEventListener('click', () => download(`${slug(app.show.name)}.cueclock.json`, JSON.stringify(app.show, null, 1), 'application/json'));
  $('openShowBtn').addEventListener('click', () => $('openShowFile').click());
  $('openShowFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      app.history.push(app.show);
      replaceShow(normalizeShow(data));
      toast(`Opened "${app.show.name}".`);
    } catch (_) {
      toast(`"${file.name}" isn't a Cue Clock show file.`);
    }
  });
  $('newShowBtn').addEventListener('click', () => { $('newShowConfirm').hidden = false; });
  $('newShowNo').addEventListener('click', () => { $('newShowConfirm').hidden = true; });
  $('newShowYes').addEventListener('click', () => {
    $('newShowConfirm').hidden = true;
    app.history.push(app.show);
    replaceShow(newShow());
    toast('Started a new show. Ctrl/⌘ Z brings the old one back.');
  });

  function replaceShow(show) {
    app.show = show;
    app.selection = { type: null, id: null };
    $('showName').value = show.name;
    $('showFps').value = show.fps;
    syncPlayersToTracks();
    timeline.fit();
    app.changed({ inspector: true, categories: true, titan: true });
  }

  // ---------- timecode tab ----------
  const SOURCE_HELP = {
    internal: 'Press play here. Tracks play and cues fire from this clock, and it can be sent out as MTC or LTC.',
    mtc: 'The playhead follows MIDI timecode from the input below. Start QLab\'s Timecode cue to roll.',
    ltc: 'The playhead follows audio timecode from the LTC input below.',
  };

  async function setSource(src, quiet) {
    app.settings.source = src;
    app.saveSettingsSoon();
    app.clock.setSource(src);
    document.querySelectorAll('input[name=source]').forEach(r => { r.checked = r.value === src; });
    $('sourceHelp').textContent = SOURCE_HELP[src];
    markJump();
    if (src === 'ltc') {
      const ok = await ltc.startInput(app.settings.ltcIn);
      showError('ltcError', ok ? '' : ltc.error);
      if (ok) refreshDevices();
    } else {
      await ltc.stopInput();
    }
    if (src === 'mtc' && !midi.access && !quiet) await enableMidi();
  }
  document.querySelectorAll('input[name=source]').forEach(r => r.addEventListener('change', () => setSource(r.value)));

  function showError(id, msg) { $(id).textContent = msg; $(id).hidden = !msg; }

  async function enableMidi() {
    const ok = await midi.enable();
    showError('midiError', ok ? '' : midi.error);
    if (ok) { app.settings.midiEnabled = true; app.saveSettingsSoon(); }
    renderMidi();
  }
  $('midiEnableBtn').addEventListener('click', enableMidi);

  function fillSelect(sel, items, current, noneLabel) {
    const html = `<option value="">${esc(noneLabel)}</option>` + items.map(i => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('');
    if (sel.innerHTML !== html) sel.innerHTML = html;
    sel.value = items.some(i => i.id === current) ? current : '';
  }

  function renderMidi() {
    const on = !!midi.access;
    $('midiOff').hidden = on;
    $('midiOn').hidden = !on;
    if (!on) return;
    fillSelect($('midiIn'), midi.inputs().map(p => ({ id: p.id, name: p.name })), app.settings.midiIn, 'None');
    fillSelect($('midiOut'), midi.outputs().map(p => ({ id: p.id, name: p.name })), app.settings.midiOut, 'None');
    midi.selectInput($('midiIn').value);
    midi.selectOutput($('midiOut').value);
    $('mtcOutChk').checked = app.settings.mtcOut;
    mtcSender.enabled = app.settings.mtcOut;
    $('midiNote').textContent = midi.sysex ? '' : 'Full-frame position messages are off because SysEx was not allowed. Running timecode still works.';
  }
  $('midiIn').addEventListener('change', e => { app.settings.midiIn = e.target.value; midi.selectInput(e.target.value); app.saveSettingsSoon(); });
  $('midiOut').addEventListener('change', e => { app.settings.midiOut = e.target.value; midi.selectOutput(e.target.value); app.saveSettingsSoon(); });
  $('mtcOutChk').addEventListener('change', e => {
    app.settings.mtcOut = e.target.checked; mtcSender.enabled = e.target.checked; app.saveSettingsSoon();
    if (e.target.checked && !midi.output) toast('Pick an MTC output to send to.');
  });

  async function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (_) { return; }
    const ins = devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const outs = devices.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const named = (list, word) => list.map((d, i) => ({ id: d.deviceId, name: d.label || `${word} ${i + 1}` }));
    fillSelect($('ltcIn'), named(ins, 'Input'), app.settings.ltcIn, 'Default input');
    fillSelect($('ltcOutDev'), named(outs, 'Output'), app.settings.ltcOutDevice, 'Default output');
    fillSelect($('trackOut'), named(outs, 'Output'), app.settings.trackOutDevice, 'Default output');
  }
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

  $('ltcIn').addEventListener('change', e => {
    app.settings.ltcIn = e.target.value; app.saveSettingsSoon();
    if (app.settings.source === 'ltc') setSource('ltc');
  });
  async function startLtcOut() {
    const ok = await ltc.startOutput(app.settings.ltcOutDevice, fps(), app.settings.ltcGain);
    showError('ltcError', ok ? '' : ltc.error);
    if (!ok) { app.settings.ltcOut = false; $('ltcOutChk').checked = false; }
  }
  $('ltcOutChk').addEventListener('change', async e => {
    app.settings.ltcOut = e.target.checked; app.saveSettingsSoon();
    if (e.target.checked) await startLtcOut(); else await ltc.stopOutput();
  });
  $('ltcOutDev').addEventListener('change', async e => {
    app.settings.ltcOutDevice = e.target.value; app.saveSettingsSoon();
    if (app.settings.ltcOut) await startLtcOut();
  });
  $('ltcGain').addEventListener('input', e => { app.settings.ltcGain = Number(e.target.value); app.saveSettingsSoon(); });
  $('trackOut').addEventListener('change', e => {
    app.settings.trackOutDevice = e.target.value; app.saveSettingsSoon();
    for (const p of app.players.values()) if (p.audio.setSinkId) p.audio.setSinkId(e.target.value).catch(() => toast('That output could not be selected.'));
  });
  $('playChaseChk').addEventListener('change', e => { app.settings.playWhenChasing = e.target.checked; app.saveSettingsSoon(); });
  $('chaseTitanChk').addEventListener('change', e => { app.settings.chaseTitan = e.target.checked; app.saveSettingsSoon(); });

  // ---------- Avolites ----------
  const titan = new TitanLink(() => { renderTitan(); if (selectedCue()) renderCueTitan(selectedCue()); });
  let knownLists = null;
  const freshLists = new Set();

  function nextTitanCue(un) {
    let max = 0;
    for (const c of app.show.cues) if (c.titan && Number(c.titan.userNumber) === Number(un) && c.titan.cue > max) max = c.titan.cue;
    return Math.floor(max) + 1;
  }

  function renderTitan() {
    const st = titan.state;
    const up = titan.reachable && st;
    $('bridgeDown').hidden = !!up;
    $('bridgeUp').hidden = !up;
    const dot = $('titanDot');
    dot.className = 'dot ' + (!up ? 'bad' : st.connected ? 'ok' : 'warn');
    if (!up) { setVal($('bridgeUrl'), app.settings.bridgeUrl || TitanLink.defaultBase()); return; }

    setVal($('titanHost'), st.host || '');
    setVal($('titanPort'), st.titanPort || 4430);
    $('titanDemo').checked = !!st.demo;
    const status = $('titanStatus');
    if (st.connected) {
      status.innerHTML = `<span class="badge ok">CONNECTED</span> ${esc(st.demo ? 'Demo console' : `Titan ${st.version} at ${st.host}`)}`;
    } else if (st.error) {
      status.innerHTML = `<span class="badge bad">NOT CONNECTED</span> ${esc(st.error)}`;
    } else {
      status.innerHTML = `<span class="badge">NO CONSOLE</span> Enter the console's IP address and press Connect.`;
    }

    // Spot cue lists that are new since the last update.
    const ids = new Set(st.cueLists.map(l => l.titanId));
    if (knownLists) {
      for (const l of st.cueLists) if (!knownLists.has(l.titanId)) {
        freshLists.add(l.titanId);
        toast(`New on the console: ${l.legend || 'cue list'} (${l.userNumber}).`);
      }
    }
    if (st.connected) knownLists = ids;

    const ul = $('titanLists');
    ul.innerHTML = '';
    const lists = st.cueLists.filter(l => /cue ?list/i.test(l.type) || !l.type);
    const others = st.cueLists.filter(l => !lists.includes(l));
    for (const l of lists.concat(others)) {
      const count = app.show.cues.filter(c => c.titan && Number(c.titan.userNumber) === Number(l.userNumber)).length;
      const li = document.createElement('li');
      if (freshLists.has(l.titanId)) li.className = 'fresh';
      const kind = /cue ?list/i.test(l.type) ? 'Cue list' : (l.type || 'Handle').replace(/Handle$/, '');
      li.innerHTML = `<span class="un">${esc(l.userNumber)}</span>
        <span class="legend">${esc(l.legend || 'Untitled')}<span class="sub">${esc(kind)} · ${count} cue${count === 1 ? '' : 's'} in this show</span></span>
        <button class="btn small">Add cue</button>`;
      li.querySelector('button').addEventListener('click', () => {
        freshLists.delete(l.titanId);
        const n = nextTitanCue(l.userNumber);
        const light = app.show.categories.find(c => /light/i.test(c.name));
        app.addCue({
          name: `${l.legend || 'List ' + l.userNumber} Q${n}`,
          category: light ? light.id : undefined,
          titan: { userNumber: Number(l.userNumber), cue: n, legend: l.legend || '' },
        });
        renderTitan();
        toast(`Added cue ${n} of "${l.legend || l.userNumber}" at the playhead. Set its timecode in the Cue tab.`);
        setTimeout(() => { const el = $('cueTc'); el.focus(); el.select(); }, 0);
      });
      ul.appendChild(li);
    }
    $('titanListsEmpty').hidden = st.cueLists.length > 0;
    const last = st.lastAction;
    $('titanLast').innerHTML = last
      ? `${last.ok ? '' : '<span class="badge bad">FAILED</span> '}${esc(last.text)} <span class="muted">· ${new Date(last.at).toLocaleTimeString()}</span>`
      : 'None yet.';
  }

  $('titanForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await titan.configure({ host: $('titanHost').value.trim(), titanPort: Number($('titanPort').value) || 4430, demo: $('titanDemo').checked });
      knownLists = null;
      toast('Connecting to the console…');
    } catch (err) { toast('The bridge did not accept that: ' + err.message); }
  });
  $('bridgeRetry').addEventListener('click', () => {
    app.settings.bridgeUrl = $('bridgeUrl').value.trim();
    app.saveSettingsSoon();
    titan.connect(app.settings.bridgeUrl);
  });

  // ---------- countdown view ----------
  let svKey = '';
  function toggleShowView(force) {
    const el = $('showView');
    el.hidden = force === undefined ? !el.hidden : !force;
    svKey = '';
    if (!el.hidden) renderShowView(app.clock.time());
  }
  $('showViewBtn').addEventListener('click', () => toggleShowView(true));
  $('svClose').addEventListener('click', () => toggleShowView(false));
  $('svPlay').addEventListener('click', togglePlay);

  function renderShowView(t) {
    const f = fps();
    $('svTc').textContent = formatTC(t, f);
    $('svPlay').textContent = app.clock.isRunning() ? 'Pause' : 'Play';

    const cur = app.show.tracks.find(tr => t >= tr.start && t < tr.start + tr.duration);
    let trackText = '';
    if (cur) trackText = `${cur.name} · ${formatCountdown(cur.start + cur.duration - t)} left`;
    else {
      const nxt = app.show.tracks.filter(tr => tr.start > t).sort((a, b) => a.start - b.start)[0];
      if (nxt) trackText = `Next track: ${nxt.name} in ${formatCountdown(nxt.start - t)}`;
    }
    $('svTrack').textContent = trackText;

    // Next cue for each category
    const nextByCat = app.show.categories.map(c => ({ cat: c, cue: app.sorted.find(q => q.category === c.id && q.time > t - 1e-6) }));
    const upcoming = app.sorted.filter(q => q.time > t - 1e-6).slice(0, 12);
    const fired = app.firedLog.slice(0, 8).map(x => ({ ...x, cue: app.show.cues.find(c => c.id === x.id) })).filter(x => x.cue);
    const key = nextByCat.map(x => x.cat.id + (x.cue ? x.cue.id + x.cue.name : '-')).join() + '|' +
      upcoming.map(q => q.id + q.name + q.category).join() + '|' + fired.map(x => x.id + x.at).join() + '|' +
      app.show.categories.map(c => c.color + c.name).join();
    if (key !== svKey) {
      svKey = key;
      $('svNext').innerHTML = nextByCat.map(({ cat, cue }) => `
        <div class="sv-card${cue ? '' : ' none'}" data-cue="${cue ? esc(cue.id) : ''}">
          <div class="cat"><i style="background:${esc(cat.color)}"></i>${esc(cat.name)}</div>
          <div class="cname">${cue ? esc(cue.name) : 'No more cues'}</div>
          <div class="count">${cue ? '' : '—'}</div>
          <div class="when">${cue ? esc(formatTC(cue.time, f)) + (cue.titan && cue.titan.userNumber ? ` · list ${esc(cue.titan.userNumber)}${cue.titan.cue ? ' cue ' + esc(cue.titan.cue) : ''}` : '') : ''}</div>
          <div class="bar" style="background:${esc(cat.color)}"></div>
        </div>`).join('');
      $('svUpcoming').innerHTML = upcoming.map(q => {
        const c = catById(q.category);
        return `<li data-cue="${esc(q.id)}"><i style="background:${esc(c ? c.color : '#888')}"></i><span class="t">${esc(formatTC(q.time, f))}</span><span class="n">${esc(q.name)}</span><span class="c"></span></li>`;
      }).join('') || '<li class="muted">Nothing left in the cue list.</li>';
      $('svFired').innerHTML = fired.map(x => {
        const c = catById(x.cue.category);
        return `<li><i style="background:${esc(c ? c.color : '#888')}"></i><span class="t">${esc(formatTC(x.cue.time, f))}</span><span class="n">${esc(x.cue.name)}</span><span class="c muted">${new Date(x.at).toLocaleTimeString()}</span></li>`;
      }).join('') || '<li class="muted">Nothing fired yet.</li>';
    }
    // Countdowns update every frame without rebuilding.
    document.querySelectorAll('#svNext .sv-card').forEach(card => {
      const cue = app.show.cues.find(c => c.id === card.dataset.cue);
      if (!cue) return;
      const dt = cue.time - t;
      card.querySelector('.count').textContent = formatCountdown(Math.max(0, dt));
      card.classList.toggle('soon', dt <= 10 && dt > 3);
      card.classList.toggle('now', dt <= 3);
      card.querySelector('.bar').style.width = dt <= 10 ? `${(1 - dt / 10) * 100}%` : '0';
    });
    document.querySelectorAll('#svUpcoming li[data-cue]').forEach(li => {
      const cue = app.show.cues.find(c => c.id === li.dataset.cue);
      if (cue) li.querySelector('.c').textContent = formatCountdown(Math.max(0, cue.time - t));
    });
  }

  // ---------- header ----------
  $('playBtn').addEventListener('click', togglePlay);
  $('toStartBtn').addEventListener('click', toStart);
  $('addCueBtn').addEventListener('click', () => app.addCue());
  $('addTrackBtn').addEventListener('click', () => app.pickTrackFile(null));
  $('zoomInBtn').addEventListener('click', () => timeline.setZoom(timeline.pps * 1.5));
  $('zoomOutBtn').addEventListener('click', () => timeline.setZoom(timeline.pps / 1.5));
  $('zoomFitBtn').addEventListener('click', () => timeline.fit());
  $('followChk').addEventListener('change', e => { app.settings.follow = e.target.checked; app.saveSettingsSoon(); });

  let lastWall = '';
  function renderWallClock() {
    const el = $('wallClock');
    if (!el) return;
    const s = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (s !== lastWall) { el.textContent = s; lastWall = s; }
  }

  function renderClockHeader(now, t) {
    const f = fps();
    $('tcDisplay').textContent = formatTC(t, f);
    const running = app.clock.isRunning(now);
    const pb = $('playBtn');
    pb.classList.toggle('on', running);
    pb.setAttribute('aria-label', running ? 'Pause' : 'Play');
    pb.disabled = app.clock.source !== 'internal';
    const badge = $('sourceBadge'), state = $('clockState');
    if (app.clock.source === 'internal') {
      badge.textContent = 'INTERNAL'; badge.className = 'badge';
      state.textContent = running ? 'Playing' : 'Stopped';
    } else {
      const st = app.clock.extStatus(now);
      const label = app.clock.source.toUpperCase();
      const inKey = app.clock.ext.rateKey;
      badge.textContent = label + (inKey && st !== 'none' ? ' ' + fpsInfo(inKey).label.replace(' fps', '').toUpperCase() : '');
      badge.className = 'badge ' + (st === 'running' ? 'ok' : st === 'none' ? 'bad' : 'warn');
      let text = st === 'running' ? 'Locked' : st === 'none' ? 'No timecode yet' : 'Timecode stopped';
      if (inKey && inKey !== app.show.fps && st !== 'none') text += ` · incoming ${fpsInfo(inKey).label}, show is ${f.label}`;
      state.textContent = text;
    }
  }

  // ---------- keyboard ----------
  document.addEventListener('keydown', e => {
    const tag = e.target.tagName;
    const typing = (tag === 'INPUT' && !['checkbox', 'radio', 'range', 'color'].includes(e.target.type)) || tag === 'TEXTAREA' || tag === 'SELECT';
    if (e.key === 'Escape') {
      if (!$('networkView').hidden) network.show(false);
      else if (!$('showView').hidden) toggleShowView(false);
      else if (typing) e.target.blur();
      else app.select(null);
      return;
    }
    if (typing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(e.shiftKey); return; }
    if (mod && e.key === 'y') { e.preventDefault(); undo(true); return; }
    if (mod) return;
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'c': case 'C': app.addCue(); break;
      case 'v': case 'V': toggleShowView(); break;
      case 'n': case 'N': network.show($('networkView').hidden); break;
      case 'Delete': case 'Backspace': e.preventDefault(); deleteSelected(); break;
      case '[': nudge(e.shiftKey ? -1 : -1 / fps().rate); break;
      case ']': nudge(e.shiftKey ? 1 : 1 / fps().rate); break;
      case 'Home': toStart(); break;
      case '+': case '=': timeline.setZoom(timeline.pps * 1.5); break;
      case '-': timeline.setZoom(timeline.pps / 1.5); break;
      case '0': timeline.fit(); break;
      default: return;
    }
  });

  // ---------- draw loop ----------
  let lastUi = 0;
  function draw() {
    const now = performance.now();
    const t = app.clock.time(now);
    if (app.clock.isRunning(now)) timeline.follow(t);
    timeline.draw(now);
    renderClockHeader(now, t);
    if (now - lastUi > 80) {
      lastUi = now;
      updateCountdowns(t);
      if (!$('showView').hidden) renderShowView(t);
      $('ltcMeter').style.width = Math.min(100, ltc.level * 100) + '%';
      if (features.manual) features.renderStandby();
      renderWallClock();
    }
    requestAnimationFrame(draw);
  }

  // ---------- extra features (copy/paste, live op, exports, palette, themes) ----------
  app.timeline = timeline;
  app.fireCue = fireCue;
  const features = new Features(app, {
    toast,
    fps,
    download,
    slug: () => slug(app.show.name),
    fireCue,
    titan,
    timeline,
    locate: app.locate,
    catName: id => { const c = catById(id); return c ? c.name : 'Uncategorised'; },
    stopAllTracks,
    openPrintable,
    restoreShow: show => { replaceShow(show); },
  });
  app.features = features;

  // ---------- start up ----------
  $('showName').value = app.show.name;
  $('showFps').value = app.show.fps;
  $('followChk').checked = app.settings.follow;
  $('ltcGain').value = app.settings.ltcGain;
  $('playChaseChk').checked = app.settings.playWhenChasing;
  $('chaseTitanChk').checked = app.settings.chaseTitan;
  resort();
  renderCategoryControls();
  renderCatList();
  renderCueList();
  renderInspector();
  renderMidi();
  timeline.resize();
  if (!loadShow()) timeline.fit(); else timeline.pps = app.settings.pps || 40;
  saveShowNow(app.show);
  titan.connect(app.settings.bridgeUrl);
  renderTitan();
  refreshDevices();
  syncPlayersToTracks();
  setSource(app.settings.source, true);
  if (app.settings.midiEnabled) enableMidi();
  if (app.settings.ltcOut) startLtcOut();
  window.addEventListener('resize', () => timeline.resize());
  requestAnimationFrame(draw);
})();
