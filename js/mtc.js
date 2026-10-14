// MIDI Timecode (MTC). Pure message building and parsing; Web MIDI wiring is in app.js.

class MtcDecoder {
  // onTime({ h, m, s, f, rateKey, full }) is called with the timecode of "now".
  constructor(onTime) {
    this.onTime = onTime;
    this.pieces = new Array(8).fill(-1);
    this.lastPiece = -1;
  }

  handle(data) {
    if (data[0] === 0xF1 && data.length >= 2) {
      const piece = (data[1] >> 4) & 7;
      const value = data[1] & 0x0F;
      // A gap in the sequence (or reverse play) restarts collection.
      if (piece !== (this.lastPiece + 1) % 8) this.pieces.fill(-1);
      this.lastPiece = piece;
      this.pieces[piece] = value;
      if (piece === 7 && this.pieces.every(v => v >= 0)) {
        const p = this.pieces;
        const rateKey = MTC_RATE_KEYS[(p[7] >> 1) & 3];
        const t = {
          f: p[0] | ((p[1] & 1) << 4),
          s: p[2] | ((p[3] & 3) << 4),
          m: p[4] | ((p[5] & 3) << 4),
          h: p[6] | ((p[7] & 1) << 4),
          rateKey, full: false,
        };
        // The pieces describe the frame when piece 0 was sent, two frames ago.
        this.onTime(t, 2);
      }
      return;
    }
    // Full frame: F0 7F <dev> 01 01 hr mn sc fr F7
    if (data[0] === 0xF0 && data.length >= 10 && data[1] === 0x7F && data[3] === 0x01 && data[4] === 0x01) {
      const hr = data[5];
      this.pieces.fill(-1);
      this.lastPiece = -1;
      this.onTime({ h: hr & 0x1F, m: data[6], s: data[7], f: data[8], rateKey: MTC_RATE_KEYS[(hr >> 5) & 3], full: true }, 0);
    }
  }
}

// Quarter-frame byte for piece 0-7 of a timecode label.
function mtcQuarterFrame(piece, p, rateCode) {
  let v;
  switch (piece) {
    case 0: v = p.f & 0x0F; break;
    case 1: v = (p.f >> 4) & 0x01; break;
    case 2: v = p.s & 0x0F; break;
    case 3: v = (p.s >> 4) & 0x03; break;
    case 4: v = p.m & 0x0F; break;
    case 5: v = (p.m >> 4) & 0x03; break;
    case 6: v = p.h & 0x0F; break;
    default: v = ((p.h >> 4) & 0x01) | (rateCode << 1);
  }
  return [0xF1, (piece << 4) | v];
}

function mtcFullFrame(p, rateCode) {
  return [0xF0, 0x7F, 0x7F, 0x01, 0x01, (rateCode << 5) | p.h, p.m, p.s, p.f, 0xF7];
}

if (typeof module !== 'undefined') module.exports = { MtcDecoder, mtcQuarterFrame, mtcFullFrame };
