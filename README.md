# Lighting Desk

A browser-based lighting console that controls lights through an Arduino over USB.

- `index.html`: the console. It's a single file with no install or server needed.
- `arduino/LightingDesk/LightingDesk.ino`: the Arduino sketch that receives the levels.

## How it talks to the Arduino

The page uses the **Web Serial API**, which lets a web page open a USB serial port directly.

| Browser | Works? |
| --- | --- |
| Chrome / Edge / Opera on Windows, macOS, Linux, ChromeOS | Yes |
| Chrome on Android | Yes (USB-OTG, Chrome 138+) |
| Firefox, Safari, any iPhone/iPad browser | No (the desk opens in preview mode and can't send) |

## Quick start

1. Open `arduino/LightingDesk/LightingDesk.ino` in the Arduino IDE and upload it.
   - **PWM mode** (default): LEDs or MOSFET dimmers on pins 3, 5, 6, 9, 10, 11 become channels 1-6.
   - **DMX mode**: set `#define OUTPUT_MODE MODE_DMX`, install the **DmxSimple** library,
     and wire an RS-485/DMX shield to pin 3. Channels 1-512 then go out as real DMX.
2. **Close the Arduino IDE's Serial Monitor.** Only one program can use the port at a time.
3. Double-click `index.html` to open it in Chrome or Edge.
   If the Connect button does nothing, serve it locally instead:
   `python3 -m http.server` and then open <http://localhost:8000>.
4. Click **Connect Arduino**, pick the board's port, and move the faders.

## Features

- Channel faders (1-48, adjustable), each with a renamable label and a **Flash** button
- Grand master and **Blackout** (`B` key)
- 8 scene memories with timed crossfades (`1`-`8` keys, `Esc` stops a fade)
- Save and load the show as a JSON file. Faders, names and scenes also auto-save in the browser.
- Serial log showing the Arduino's replies

## Serial protocol

The protocol is plain text at 115200 baud, one command per line:

```
3,128      set channel 3 to 128 (channels 1-512, values 0-255)
?          Arduino replies: LD READY PWM 6   (or LD READY DMX 512)
```

The page sends only the channels that changed, about 40 times a second, and refreshes every channel every 2 seconds.
Because the protocol is this simple, you can also test it by typing these lines into the Arduino Serial Monitor.
