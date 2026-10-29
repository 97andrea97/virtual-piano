// Piano keyboard geometry: key layout, hit testing and note naming.
// Pure logic (no DOM) so it can be unit tested in Node.

const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Black keys are narrower and shorter than white keys, like on a real piano.
export const BLACK_KEY_WIDTH = 0.6; // fraction of a white key width
export const BLACK_KEY_HEIGHT = 0.6; // fraction of the keyboard height

export function isBlack(midi) {
  return BLACK_PITCH_CLASSES.has(((midi % 12) + 12) % 12);
}

export function noteName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

export function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export class Keyboard {
  /**
   * @param {object} opts
   * @param {number} opts.startNote MIDI note of the lowest key (should be a white key, e.g. 60 = C4)
   * @param {number} opts.octaves number of octaves; one extra C is added on top
   */
  constructor({ startNote = 60, octaves = 2 } = {}) {
    this.startNote = startNote;
    this.octaves = octaves;
    this.rect = { x: 0, y: 0, w: 1, h: 1 };
    this.keys = [];
    this.whiteKeys = [];
    this.blackKeys = [];
    this.layout(this.rect);
  }

  get endNote() {
    return this.startNote + this.octaves * 12;
  }

  /** Lay out the keys inside a rectangle (any unit, typically CSS pixels). */
  layout(rect) {
    this.rect = { ...rect };
    const notes = [];
    for (let n = this.startNote; n <= this.endNote; n++) notes.push(n);
    const whiteNotes = notes.filter((n) => !isBlack(n));
    const ww = rect.w / whiteNotes.length;

    this.whiteKeys = whiteNotes.map((note, i) => ({
      note,
      black: false,
      x: rect.x + i * ww,
      y: rect.y,
      w: ww,
      h: rect.h,
    }));

    this.blackKeys = [];
    let whiteIndex = 0;
    for (const note of notes) {
      if (!isBlack(note)) {
        whiteIndex++;
        continue;
      }
      // A black key sits centered on the boundary between two white keys.
      const bw = ww * BLACK_KEY_WIDTH;
      this.blackKeys.push({
        note,
        black: true,
        x: rect.x + whiteIndex * ww - bw / 2,
        y: rect.y,
        w: bw,
        h: rect.h * BLACK_KEY_HEIGHT,
      });
    }
    this.keys = [...this.whiteKeys, ...this.blackKeys];
    this.byNote = new Map(this.keys.map((k) => [k.note, k]));
    return this;
  }

  contains(x, y) {
    const r = this.rect;
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  /** Returns the key under (x, y), black keys taking precedence, or null. */
  hitTest(x, y) {
    if (!this.contains(x, y)) return null;
    for (const k of this.blackKeys) {
      if (x >= k.x && x <= k.x + k.w && y >= k.y && y <= k.y + k.h) return k;
    }
    const r = this.rect;
    const i = Math.min(this.whiteKeys.length - 1, Math.floor(((x - r.x) / r.w) * this.whiteKeys.length));
    return this.whiteKeys[i] ?? null;
  }

  key(note) {
    return this.byNote.get(note) ?? null;
  }

  get whiteKeyWidth() {
    return this.rect.w / this.whiteKeys.length;
  }
}
