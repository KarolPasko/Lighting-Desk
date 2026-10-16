// Export a show as a Python module (data + optional runner) or as CSV.

function sortedCues(show) {
  return show.cues.slice().sort((a, b) => a.time - b.time);
}

function categoryName(show, id) {
  const c = show.categories.find(c => c.id === id);
  return c ? c.name : 'Uncategorised';
}

function pyStr(v) { return JSON.stringify(String(v ?? '')); }
function pyNum(v) { return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '0'; }
function pyComment(v) { return String(v ?? '').replace(/[\r\n]+/g, ' '); }

function exportPython(show) {
  const fps = fpsInfo(show.fps);
  const cues = sortedCues(show);
  const lines = [];
  const L = s => lines.push(s);

  L('#!/usr/bin/env python3');
  L(`# Cue list exported from Cue Clock`);
  L(`# Show: ${pyComment(show.name)}`);
  L(`# Frame rate: ${fps.label}`);
  L(`# Exported: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
  L('"""');
  L('Cue list with timecode timings.');
  L('');
  L('Use it as data:');
  L('    from show_cues import CUES');
  L('    for cue in CUES:');
  L('        print(cue["tc"], cue["category"], cue["name"])');
  L('');
  L('Or run it from a terminal:');
  L('    python3 show_cues.py --list                 print the cue list');
  L('    python3 show_cues.py                        count down and print each cue as it fires');
  L('    python3 show_cues.py --start 00:01:00:00    start part-way through the show');
  L('    python3 show_cues.py --titan 192.168.1.50   also fire the Avolites Titan cues');
  L('"""');
  L('');
  L('import argparse');
  L('import sys');
  L('import time');
  L('import urllib.parse');
  L('import urllib.request');
  L('');
  L(`SHOW_NAME = ${pyStr(show.name)}`);
  L(`FPS = ${fps.nominal}  # frames per second in the timecode label`);
  L(`FPS_RATE = ${fps.drop ? '30000 / 1001' : fps.rate}  # real frames per second`);
  L(`DROP_FRAME = ${fps.drop ? 'True' : 'False'}`);
  L('');
  L('CATEGORIES = [');
  for (const c of show.categories) L(`    ${pyStr(c.name)},`);
  L(']');
  L('');
  L('TRACKS = [');
  for (const t of show.tracks.slice().sort((a, b) => a.start - b.start)) {
    L(`    {"name": ${pyStr(t.name)}, "start_tc": ${pyStr(formatTC(t.start, fps))}, "start": ${pyNum(t.start)}, "duration": ${pyNum(t.duration || 0)}},`);
  }
  L(']');
  L('');
  L('CUES = [');
  cues.forEach((c, i) => {
    const titan = c.titan && c.titan.userNumber
      ? `{"cue_list": ${pyNum(Number(c.titan.userNumber))}, "cue": ${c.titan.cue ? pyNum(Number(c.titan.cue)) : 'None'}, "legend": ${pyStr(c.titan.legend || '')}}`
      : 'None';
    L('    {');
    L(`        "number": ${i + 1},`);
    L(`        "tc": ${pyStr(formatTC(c.time, fps))},`);
    L(`        "seconds": ${pyNum(c.time)},`);
    L(`        "frame": ${secondsToFrames(c.time, fps)},`);
    L(`        "category": ${pyStr(categoryName(show, c.category))},`);
    L(`        "name": ${pyStr(c.name)},`);
    L(`        "notes": ${pyStr(c.notes)},`);
    L(`        "titan": ${titan},`);
    L('    },');
  });
  L(']');
  L(PY_HELPERS);
  return lines.join('\n') + '\n';
}

const PY_HELPERS = `

def tc_to_seconds(tc):
    """Convert "HH:MM:SS:FF" (or ; before frames) to seconds."""
    h, m, s, f = (int(x) for x in tc.replace(";", ":").replace(".", ":").split(":"))
    frames = ((h * 60 + m) * 60 + s) * FPS + f
    if DROP_FRAME:
        minutes = h * 60 + m
        frames -= 2 * (minutes - minutes // 10)
    return frames / FPS_RATE


def seconds_to_tc(seconds):
    """Convert seconds to an "HH:MM:SS:FF" label."""
    fn = int(max(seconds, 0) * FPS_RATE + 1e-6)
    if DROP_FRAME:
        d, m = divmod(fn, 17982)
        fn += 18 * d + (2 * ((m - 2) // 1798) if m > 2 else 0)
    f = fn % FPS
    s = fn // FPS % 60
    m = fn // (FPS * 60) % 60
    h = fn // (FPS * 3600) % 24
    return "%02d:%02d:%02d%s%02d" % (h, m, s, ";" if DROP_FRAME else ":", f)


def cues_in_category(name):
    """All cues in one category, in time order."""
    return [c for c in CUES if c["category"].lower() == name.lower()]


def fire_titan(host, cue, port=4430):
    """Send an Avolites Titan cue list to the cue's cue number and play it."""
    titan = cue.get("titan")
    if not titan:
        return
    base = "http://%s:%d/titan/script/2/CueLists/" % (host, port)
    user_number = titan["cue_list"]
    if titan.get("cue") is not None:
        query = urllib.parse.urlencode({"handle_userNumber": user_number, "stepNumber": titan["cue"]})
        urllib.request.urlopen(base + "SetNextCue?" + query, timeout=2).read()
    query = urllib.parse.urlencode({"handle_userNumber": user_number})
    urllib.request.urlopen(base + "Play?" + query, timeout=2).read()


def print_list():
    print("%s  (%d cues, %s)" % (SHOW_NAME, len(CUES), "29.97 drop" if DROP_FRAME else "%d fps" % FPS))
    for c in CUES:
        titan = ""
        if c["titan"]:
            titan = "  [Titan list %s cue %s]" % (c["titan"]["cue_list"], c["titan"]["cue"] or "next")
        print("%3d  %s  %-12s %s%s" % (c["number"], c["tc"], c["category"], c["name"], titan))


def run(start=0.0, titan_host=None):
    """Count down to each cue in real time, starting from 'start' seconds."""
    pending = [c for c in CUES if c["seconds"] >= start]
    t0 = time.monotonic() - start
    try:
        while pending:
            now = time.monotonic() - t0
            cue = pending[0]
            if now >= cue["seconds"]:
                pending.pop(0)
                sys.stdout.write("\\r%s  GO  %-12s %s%s\\n" % (cue["tc"], cue["category"], cue["name"], " " * 20))
                if titan_host and cue["titan"]:
                    try:
                        fire_titan(titan_host, cue)
                    except OSError as err:
                        print("    Titan did not answer: %s" % err)
                continue
            sys.stdout.write("\\r%s  next: %s in %.1f s   " % (seconds_to_tc(now), cue["name"], cue["seconds"] - now))
            sys.stdout.flush()
            time.sleep(0.05)
        print("\\nEnd of cue list.")
    except KeyboardInterrupt:
        print("\\nStopped.")


def main():
    parser = argparse.ArgumentParser(description="Run or list the cues for " + SHOW_NAME)
    parser.add_argument("--list", action="store_true", help="print the cue list and exit")
    parser.add_argument("--start", default="0", help="start time as HH:MM:SS:FF or seconds")
    parser.add_argument("--titan", metavar="HOST", help="IP address of an Avolites Titan console to fire")
    args = parser.parse_args()
    if args.list:
        print_list()
        return
    start = tc_to_seconds(args.start) if ":" in args.start else float(args.start)
    run(start, args.titan)


if __name__ == "__main__":
    main()`;

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportCsv(show) {
  const fps = fpsInfo(show.fps);
  const rows = [['Number', 'Timecode', 'Seconds', 'Category', 'Name', 'Titan cue list', 'Titan cue', 'Notes']];
  sortedCues(show).forEach((c, i) => rows.push([
    i + 1, formatTC(c.time, fps), (Math.round(c.time * 1000) / 1000).toString(), categoryName(show, c.category), c.name,
    c.titan && c.titan.userNumber ? c.titan.userNumber : '', c.titan && c.titan.cue ? c.titan.cue : '', c.notes,
  ]));
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ---------- Avolites timecode sheet ----------
// The Titan WebAPI can't write cue timecodes directly, so this produces the
// reference a programmer types into Titan's "Edit Times", grouped by cue list.

function titanGroups(show) {
  const fps = fpsInfo(show.fps);
  const groups = new Map(); // userNumber -> { userNumber, legend, rows }
  const loose = [];
  for (const c of sortedCues(show)) {
    const row = {
      tc: formatTC(c.time, fps), seconds: c.time, name: c.name,
      fade: Number.isFinite(c.fade) && c.fade > 0 ? c.fade : null, category: categoryName(show, c.category),
    };
    if (c.titan && c.titan.userNumber) {
      const key = c.titan.userNumber;
      if (!groups.has(key)) groups.set(key, { userNumber: key, legend: c.titan.legend || '', rows: [] });
      groups.get(key).rows.push({ ...row, cue: c.titan.cue || null });
    } else {
      loose.push(row);
    }
  }
  return { groups: [...groups.values()].sort((a, b) => a.userNumber - b.userNumber), loose, fps };
}

function exportAvolitesCsv(show) {
  const { groups, loose } = titanGroups(show);
  const rows = [['Cue List', 'Cue List Legend', 'Cue', 'Timecode', 'Fade (s)', 'Category', 'Name']];
  for (const g of groups)
    for (const r of g.rows)
      rows.push([g.userNumber, g.legend, r.cue ?? '', r.tc, r.fade ?? '', r.category, r.name]);
  for (const r of loose)
    rows.push(['', '(not linked to a cue list)', '', r.tc, r.fade ?? '', r.category, r.name]);
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// A printable sheet, one block per cue list. Works from the browser's print.
function exportAvolitesSheet(show) {
  const { groups, loose, fps } = titanGroups(show);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const block = (title, rows, withCue) => `
    <section>
      <h2>${esc(title)}</h2>
      <table>
        <thead><tr>${withCue ? '<th>Cue</th>' : ''}<th>Timecode</th><th>Fade</th><th>Category</th><th>Name</th></tr></thead>
        <tbody>${rows.map(r => `<tr>${withCue ? `<td class="n">${esc(r.cue ?? '')}</td>` : ''}<td class="tc">${esc(r.tc)}</td><td class="n">${r.fade ? esc(r.fade) + 's' : ''}</td><td>${esc(r.category)}</td><td>${esc(r.name)}</td></tr>`).join('')}</tbody>
      </table>
    </section>`;
  const body = groups.map(g => block(`Cue list ${g.userNumber}${g.legend ? ' — ' + g.legend : ''}`, g.rows, true)).join('')
    + (loose.length ? block('Not linked to a cue list', loose, false) : '');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(show.name)} — Avolites timecode sheet</title>
<style>
  body { font: 13px -apple-system, system-ui, sans-serif; color: #111; margin: 24px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .sub { color: #666; margin: 0 0 18px; }
  section { margin: 0 0 20px; break-inside: avoid; }
  h2 { font-size: 14px; margin: 0 0 6px; padding-bottom: 4px; border-bottom: 2px solid #111; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #ddd; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #555; }
  .tc, .n { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  @media print { body { margin: 10mm; } @page { margin: 12mm; } }
</style></head><body>
  <h1>${esc(show.name)}</h1>
  <p class="sub">Avolites timecode sheet · ${esc(fps.label)} · generated ${new Date().toLocaleString()}</p>
  ${body || '<p>No cues yet.</p>'}
</body></html>`;
}

// QLab-friendly: a CSV you can turn into timecode markers (Timecode, Name, Notes).
function exportQlabCsv(show) {
  const fps = fpsInfo(show.fps);
  const rows = [['Timecode', 'Name', 'Category', 'Notes']];
  for (const c of sortedCues(show)) rows.push([formatTC(c.time, fps), c.name, categoryName(show, c.category), c.notes || '']);
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// A clean printable cue sheet for the whole show.
function exportCueSheet(show) {
  const fps = fpsInfo(show.fps);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rows = sortedCues(show).map((c, i) => {
    const titan = c.titan && c.titan.userNumber ? `List ${c.titan.userNumber}${c.titan.cue ? ' Q' + c.titan.cue : ''}` : '';
    return `<tr><td class="n">${i + 1}</td><td class="tc">${esc(formatTC(c.time, fps))}</td><td>${esc(categoryName(show, c.category))}</td><td>${esc(c.name)}</td><td class="n">${esc(titan)}</td><td>${esc(c.notes || '')}</td></tr>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(show.name)} — cue sheet</title>
<style>
  body { font: 13px -apple-system, system-ui, sans-serif; color: #111; margin: 24px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .sub { color: #666; margin: 0 0 16px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #ddd; vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #555; }
  .tc, .n { font-family: ui-monospace, "SF Mono", Menlo, monospace; white-space: nowrap; }
  tr:nth-child(even) td { background: #fafafa; }
  @media print { @page { margin: 12mm; } }
</style></head><body>
  <h1>${esc(show.name)}</h1>
  <p class="sub">Cue sheet · ${esc(fps.label)} · ${show.cues.length} cues · generated ${new Date().toLocaleString()}</p>
  <table><thead><tr><th>#</th><th>Timecode</th><th>Category</th><th>Name</th><th>Avolites</th><th>Notes</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6">No cues.</td></tr>'}</tbody></table>
</body></html>`;
}

// ---------- CSV import ----------
// Lenient: finds columns by header name. Returns { cues, error, count }.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some(x => x !== '')) rows.push(row); }
  return rows;
}

function importCsv(text, show) {
  const fps = fpsInfo(show.fps);
  const rows = parseCsv(text);
  if (rows.length < 2) return { cues: [], error: 'The file has no data rows.', count: 0 };
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = (...names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
  const iTime = col('timecode', 'time', 'tc', 'seconds');
  const iName = col('name', 'cue', 'label', 'description');
  const iCat = col('category', 'cat', 'department', 'type');
  const iList = col('cue list', 'cuelist', 'titan', 'list', 'playback');
  const iCueNo = col('cue number', 'cue no', 'cue', 'step');
  const iNotes = col('notes', 'note', 'comment');
  const iFade = col('fade', 'fade (s)', 'fade time');
  if (iTime < 0) return { cues: [], error: 'No "Timecode" or "Time" column found.', count: 0 };
  const catByName = n => { const c = show.categories.find(x => x.name.toLowerCase() === String(n).trim().toLowerCase()); return c ? c.id : null; };
  const cues = [];
  let skipped = 0;
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const t = parseTC(cells[iTime], fps);
    if (t === null) { skipped++; continue; }
    const listNo = iList >= 0 ? Number(String(cells[iList]).replace(/[^0-9.]/g, '')) : 0;
    const cueNo = iCueNo >= 0 && iCueNo !== iName ? Number(String(cells[iCueNo]).replace(/[^0-9.]/g, '')) : 0;
    const fade = iFade >= 0 ? Number(cells[iFade]) : NaN;
    cues.push({
      time: Math.max(0, t),
      name: (iName >= 0 ? cells[iName] : '') || `Cue ${cues.length + 1}`,
      category: (iCat >= 0 && catByName(cells[iCat])) || show.categories[0].id,
      notes: iNotes >= 0 ? cells[iNotes] : '',
      fade: Number.isFinite(fade) && fade > 0 ? fade : undefined,
      titan: listNo > 0 ? { userNumber: listNo, cue: cueNo > 0 ? cueNo : null, legend: '' } : null,
    });
  }
  return { cues, error: cues.length ? '' : 'No rows had a readable timecode.', count: cues.length, skipped };
}

if (typeof module !== 'undefined') module.exports = {
  exportPython, exportCsv, exportAvolitesCsv, exportAvolitesSheet, exportQlabCsv, exportCueSheet,
  importCsv, parseCsv, titanGroups,
};
