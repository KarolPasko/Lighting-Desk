// Network monitor view: sACN / Art-Net universes, device list and packet capture.
// Talks to the bridge's /api/net endpoints. The heavy data (per-universe levels)
// is only requested for the one universe whose grid is open.

class NetworkView {
  constructor(app) {
    this.app = app;
    this.open = false;
    this.tab = 'universes';
    this.focus = null;        // "sacn:3" while a level grid is showing
    this.timer = 0;
    this.selectedPacket = null;
    this.lastHex = '';
    this.bind();
  }

  $(id) { return document.getElementById(id); }
  base() { return this.app.bridgeBase(); }

  // The preview artifact injects window.__netDemo to run without a bridge.
  async getStatus() {
    if (window.__netDemo) return window.__netDemo.status(this.focus);
    const url = this.base() + '/api/net/status' + (this.focus ? '?levels=' + encodeURIComponent(this.focus) : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  async control(body) {
    if (window.__netDemo) return window.__netDemo.control(body);
    const res = await fetch(this.base() + '/api/net/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  bind() {
    this.$('networkBtn').addEventListener('click', () => this.show(true));
    this.$('netClose').addEventListener('click', () => this.show(false));
    this.$('netToggle').addEventListener('click', () => this.toggleRun());
    this.$('artPollBtn').addEventListener('click', () => this.safeControl({ action: 'artpoll' }));
    this.$('pingSweepBtn').addEventListener('click', () => this.pingSweep());
    this.$('captureChk').addEventListener('change', e => this.safeControl({ action: 'capture', on: e.target.checked }));
    this.$('uniDetailClose').addEventListener('click', () => { this.focus = null; this.$('uniDetail').hidden = true; });
    this.$('netUniTop').addEventListener('change', e => {
      const v = Math.max(1, Math.min(512, Math.round(Number(e.target.value)) || 64));
      e.target.value = v;
      this.safeControl({ action: 'universeTop', value: v });
    });
    document.querySelectorAll('.net-tab').forEach(t => t.addEventListener('click', () => this.showTab(t.dataset.net)));
  }

  safeControl(body) { this.control(body).then(() => this.pollNow()).catch(err => this.showError(err.message)); }

  show(on) {
    this.open = on;
    this.$('networkView').hidden = !on;
    if (on) {
      this.pollNow();
      clearInterval(this.timer);
      this.timer = setInterval(() => this.pollNow(), 300);
    } else {
      clearInterval(this.timer);
    }
  }

  showTab(name) {
    this.tab = name;
    document.querySelectorAll('.net-tab').forEach(t => t.classList.toggle('on', t.dataset.net === name));
    document.querySelectorAll('.net-pane').forEach(p => { p.hidden = p.dataset.netbody !== name; });
  }

  async toggleRun() {
    const running = this.$('netToggle').dataset.running === '1';
    await this.safeControl({ action: running ? 'stop' : 'start' });
  }

  async pingSweep() {
    this.$('sweepNote').textContent = 'Pinging every address on the subnet…';
    try { await this.control({ action: 'pingsweep' }); setTimeout(() => { this.$('sweepNote').textContent = 'Done. New devices appear as they answer.'; }, 4000); }
    catch (err) { this.$('sweepNote').textContent = 'Could not start: ' + err.message; }
  }

  async pollNow() {
    if (!this.open) return;
    let s;
    try { s = await this.getStatus(); }
    catch (_) {
      this.$('netOffline').hidden = false;
      this.$('netBody').hidden = true;
      return;
    }
    this.$('netOffline').hidden = true;
    this.$('netBody').hidden = false;
    this.render(s);
  }

  showError(msg) { const e = this.$('netError'); e.textContent = msg; e.hidden = !msg; }

  render(s) {
    const esc = this.app.esc;
    const btn = this.$('netToggle');
    btn.dataset.running = s.running ? '1' : '0';
    btn.textContent = s.running ? 'Stop monitoring' : 'Start monitoring';
    btn.classList.toggle('primary', !s.running);
    this.$('netIfaces').textContent = s.interfaces && s.interfaces.length
      ? 'This computer: ' + s.interfaces.map(i => i.name).join(', ') : '';
    this.showError(s.error || '');

    this.$('statSacn').textContent = s.sacn.length;
    this.$('statArt').textContent = s.artnet.length;
    this.$('statDevices').textContent = s.devices.length;
    this.$('statPackets').textContent = s.counts.total.toLocaleString();
    if (document.activeElement !== this.$('netUniTop')) this.$('netUniTop').value = s.universeTop;
    this.$('captureChk').checked = s.capturing;

    this.renderUniverses('sacnList', 'sacnEmpty', s.sacn, 'sacn');
    this.renderUniverses('artList', 'artEmpty', s.artnet, 'artnet');
    if (this.focus && s.focusLevels) this.renderGrid(s.focusLevels);
    this.renderDevices(s.devices);
    this.renderPackets(s.packets);
  }

  renderUniverses(listId, emptyId, list, proto) {
    const esc = this.app.esc;
    const ul = this.$(listId);
    this.$(emptyId).hidden = list.length > 0;
    const sig = proto + list.map(u => `${u.universe}:${u.pps}:${u.priority}:${u.active}:${u.sources.map(x => x.name).join(',')}`).join('|') + (this.focus || '');
    if (ul.dataset.sig === sig) return;
    ul.dataset.sig = sig;
    ul.innerHTML = '';
    for (const u of list) {
      const li = document.createElement('li');
      const key = proto + ':' + u.universe;
      li.className = 'uni' + (this.focus === key ? ' open' : '');
      const srcs = u.sources.map(x => esc(x.name)).join(', ') || '—';
      li.innerHTML = `<span class="uni-num">U${u.universe}</span>
        <span class="uni-info"><span class="uni-src">${srcs}</span>
          <span class="uni-sub">${u.pps} pkt/s · ${u.active} active${proto === 'sacn' ? ' · pri ' + (u.priority ?? '—') : ''}</span></span>
        <span class="uni-bars" aria-hidden="true"></span>`;
      li.addEventListener('click', () => {
        this.focus = this.focus === key ? null : key;
        this.$('uniDetail').hidden = !this.focus;
        this.$('uniDetailTitle').textContent = this.focus ? `${proto === 'sacn' ? 'sACN' : 'Art-Net'} universe ${u.universe} — 512 channels` : '';
        this.pollNow();
      });
      ul.appendChild(li);
    }
  }

  renderGrid(levels) {
    const grid = this.$('uniGrid');
    if (!grid.childElementCount) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 512; i++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.innerHTML = `<span class="ch">${i + 1}</span><span class="lv"></span>`;
        frag.appendChild(cell);
      }
      grid.appendChild(frag);
    }
    const cells = grid.children;
    for (let i = 0; i < 512; i++) {
      const v = levels[i] || 0;
      const cell = cells[i];
      const lv = cell.lastElementChild;
      const pct = Math.round((v / 255) * 100);
      const text = v ? pct + '%' : '';
      if (lv.textContent !== text) lv.textContent = text;
      cell.style.background = v ? `rgba(242,177,52,${0.12 + (v / 255) * 0.88})` : 'transparent';
      cell.classList.toggle('on', v > 0);
    }
  }

  renderDevices(devices) {
    const esc = this.app.esc;
    this.$('devEmpty').hidden = devices.length > 0;
    const sig = devices.map(d => `${d.ip}:${d.mac}:${d.roles.join(',')}:${d.universes.join(',')}:${d.names.join(',')}`).join('|');
    const body = this.$('devBody');
    if (body.dataset.sig === sig) return;
    body.dataset.sig = sig;
    const now = Date.now();
    body.innerHTML = devices.map(d => {
      const ago = d.lastSeen ? Math.round((now - d.lastSeen) / 1000) : null;
      const seen = ago === null ? '' : ago < 2 ? 'now' : ago + 's ago';
      return `<tr>
        <td class="mono">${esc(d.ip)}</td>
        <td class="mono">${esc(d.mac || '—')}</td>
        <td>${esc(d.vendor || '')}</td>
        <td>${esc(d.names.join(', '))}</td>
        <td>${esc(d.roles.join(', '))}</td>
        <td class="mono">${d.universes.length ? esc(d.universes.join(', ')) : ''}</td>
        <td class="muted">${esc(seen)}</td>
      </tr>` + (d.nodeReport ? `<tr class="subrow"><td></td><td colspan="6" class="muted small">${esc(d.nodeReport)}</td></tr>` : '');
    }).join('');
  }

  renderPackets(packets) {
    const esc = this.app.esc;
    const list = this.$('pktList');
    const sig = packets.map(p => p.at + ':' + p.summary).join('|');
    if (list.dataset.sig !== sig) {
      list.dataset.sig = sig;
      list.innerHTML = packets.map((p, i) => `<li data-i="${i}" class="${this.selectedPacket === p.at ? 'sel' : ''}">
        <span class="pkt-proto ${p.proto === 'sACN' ? 'a' : 'b'}">${esc(p.proto)}</span>
        <span class="pkt-sum">${esc(p.summary)}</span>
        <span class="pkt-meta mono">${esc(p.from)} · ${p.len}B</span></li>`).join('')
        || '<li class="muted">No packets yet. Tick “Capture packets”, with traffic on the network.</li>';
      list.querySelectorAll('li[data-i]').forEach(li => li.addEventListener('click', () => {
        const p = packets[Number(li.dataset.i)];
        this.selectedPacket = p.at;
        this.$('pktHex').textContent = `${p.proto}  from ${p.from}:${p.port}  ${p.len} bytes\n${new Date(p.at).toLocaleTimeString()}\n\n${p.hex}`;
        list.querySelectorAll('li').forEach(x => x.classList.remove('sel'));
        li.classList.add('sel');
      }));
    }
    // keep the open hex dump fresh if its packet is still at the top
    const sel = packets.find(p => p.at === this.selectedPacket);
    if (sel) {
      const text = `${sel.proto}  from ${sel.from}:${sel.port}  ${sel.len} bytes\n${new Date(sel.at).toLocaleTimeString()}\n\n${sel.hex}`;
      if (text !== this.lastHex) { this.$('pktHex').textContent = text; this.lastHex = text; }
    }
  }
}
