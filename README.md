# Cue Clock

A timecode cue timeline for shows. Load your tracks, drop cues onto lanes for lighting, audio,
video, stage and anything else, and run it all from timecode: chase QLab, or be the clock yourself.

- **Receive timecode** from QLab or anything else: MIDI timecode (MTC) or audio timecode (LTC).
- **Send timecode** as MTC and/or LTC, so consoles and media servers can follow this app.
- **Tracks and lanes**: add audio tracks with waveforms, and cues in one lane per category.
- **Countdown view** (`V`): a big clock with a live countdown to the next cue in every category,
  what's coming up, and what just fired.
- **Avolites Titan link**: cue lists on the console show up in the app. Add a cue for a list, type a
  timecode, and at that time the console jumps to that cue.
- **Export** the cue list to a Python file (or CSV) with timecode, seconds and frame numbers.

## Running it

You need **Chrome or Edge** on a computer, plus **Node.js 18 or newer** for the Avolites link.

```
node bridge/server.js            # then open http://localhost:8080
node bridge/server.js --demo     # same, with a pretend Avolites console to try things out
```

(`npm start` and `npm run demo` do the same thing.) No packages need installing.

Without the Avolites link you can also just double-click `index.html`; timecode in/out, tracks,
cues and export all work from the file. Firefox and Safari don't support Web MIDI, so MTC won't
work there.

## Getting timecode from QLab

**MTC (simplest on one Mac)**
1. Open *Audio MIDI Setup* → *MIDI Studio*, double-click **IAC Driver** and tick *Device is online*.
2. In QLab, add a **Timecode cue** set to MTC, sending to the IAC bus, at the same frame rate as your
   show (Cue Clock's *Show* tab).
3. In Cue Clock: **Timecode** tab → *Turn on MIDI* → pick the IAC bus as **MTC input** → choose
   **MTC in** as the clock source.

**LTC (between computers)**: send QLab's LTC out of an audio interface into an input on this computer,
choose it as the **LTC input**, and set the clock source to **LTC in**. The level meter shows when
signal is arriving.

The header shows the source and whether it's locked. It also warns you if the incoming frame rate
doesn't match the show's.

## Sending timecode

On the **Timecode** tab, tick *Send MTC* and pick a MIDI output, and/or tick *Send LTC* and pick an
audio output. Whatever the clock is doing goes out: your own transport when the source is Internal,
or the incoming timecode when chasing. That also makes the app an LTC↔MTC converter.

## Avolites Titan

The browser can't talk to the console directly, so `bridge/server.js` sits in between. It uses the
same WebAPI as Titan Remote and touch panels, on port 4430.

1. Start the bridge and open the app from it (`http://localhost:8080`).
2. **Avolites** tab → enter the console's IP address → *Connect*.
3. Every cue list on the console is listed, and new ones appear within a few seconds of being made.
4. Press **Add cue** next to a list. That creates a cue in the Lighting lane linked to that list, with
   the next cue number. Type its timecode in the **Cue** tab (or drag it on the timeline).
5. When the timecode reaches the cue, the bridge sends `CueLists/SetNextCue` and `CueLists/Play`,
   so the console goes straight to that cue. Leave the cue number empty to just press Go.

If you jump around the timeline (or QLab locates), the app re-sends the cue that should be live in
each linked list. You can turn that off on the **Timecode** tab.

**Good to know:** the Titan WebAPI lists a console's cue lists but doesn't give the cues inside them,
so you type the cue numbers yourself; the app suggests the next number for you. If you'd rather the
console run the cues itself, send MTC or LTC from this app into Titan's own timecode-triggered cue lists.

## Python export

**Show** tab → **Python (.py)**. The file contains `CUES`, `TRACKS` and `CATEGORIES` as plain Python
data, plus helpers (`tc_to_seconds`, `seconds_to_tc`, `cues_in_category`, `fire_titan`). You can also run it:

```
python3 my_show_cues.py --list                  # print the cue list
python3 my_show_cues.py                         # count down and print each cue as it fires
python3 my_show_cues.py --start 00:01:00:00     # start part-way through
python3 my_show_cues.py --titan 192.168.1.50    # also fire the Titan cues
```

## Keys

| Key | Does |
| --- | --- |
| Space | Play / pause (internal clock) |
| C | Add a cue at the playhead |
| V | Countdown view |
| Delete | Remove the selected cue or track |
| [ and ] | Nudge the selection one frame (Shift: one second) |
| Home | Back to the start |
| + / − / 0 | Zoom in, out, fit |
| Ctrl/⌘ Z, Shift+Ctrl/⌘ Z | Undo, redo |

Double-click a lane to add a cue there. Drag cues to move them, or into another lane to change category.

## Things to know on show day

- Keep Cue Clock in its own visible window during the show. Its timing runs on a background worker,
  but browsers can slow down tabs that are hidden or minimised, which could make cues fire late.
- Opening the app from the bridge (`http://localhost:8080`) is the most reliable way to run it.
- Your show saves itself in the browser. Use **Show → Save show** to keep a file you can move to
  another machine. Audio files stay in the browser they were added in; on a new machine,
  select each track and use **Relink audio file**.

## Files

```
index.html          the app
css/app.css
js/timecode.js      frame rates, drop-frame, HH:MM:SS:FF parsing
js/ltc.js           LTC encoder/decoder (runs in an AudioWorklet)
js/mtc.js           MTC message building and parsing
js/io.js            clock, MIDI, LTC audio, bridge client
js/timeline.js      timeline canvas
js/export.js        Python and CSV export
js/show.js          show data, saving, undo
js/app.js           the UI
bridge/server.js    serves the app and talks to the Titan WebAPI
test/core.test.js   node test/core.test.js
```
