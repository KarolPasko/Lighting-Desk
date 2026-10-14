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

if (typeof module !== 'undefined') module.exports = { exportPython, exportCsv };
