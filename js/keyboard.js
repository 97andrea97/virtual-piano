// Piano keyboard model: key layout in keyboard space plus a simple 3D
// perspective projection, so the keyboard can be drawn as if it were lying on
// a table in front of the player, tilted away from the camera.
// Pure logic (no DOM) so it can be unit tested in Node.
//
// Keyboard space:
//   u: 0 (left edge) .. 1 (right edge)
//   v: 0 (front edge, nearest to the player) .. 1 (back edge)
//   h: height above the key tops, in units of the key length

const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const BLACK_KEY_WIDTH = 0.58; // fraction of a white key width
export const BLACK_KEY_LENGTH = 0.62; // fraction of the white key length
export const BLACK_KEY_HEIGHT = 0.06; // how far black keys stand above white keys
export const KEY_THICKNESS = 0.07; // visible front face of the white keys
export const KEY_TRAVEL = 0.035; // how far a pressed key goes down

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
   * @param {number} opts.startNote MIDI note of the lowest key (should be a C, e.g. 60 = C4)
   * @param {number} opts.octaves number of octaves; one extra C is added on top
   */
  constructor({ startNote = 60, octaves = 2 } = {}) {
    this.startNote = startNote;
    this.octaves = octaves;

    const whiteNotes = [];
    for (let n = startNote; n <= this.endNote; n++) if (!isBlack(n)) whiteNotes.push(n);
    const ww = 1 / whiteNotes.length;
    this.whiteKeys = whiteNotes.map((note, i) => ({ note, black: false, u0: i * ww, u1: (i + 1) * ww, v0: 0, v1: 1 }));
    this.blackKeys = [];
    let whiteIndex = 0;
    for (let n = startNote; n <= this.endNote; n++) {
      if (!isBlack(n)) {
        whiteIndex++;
        continue;
      }
      // A black key sits centered on the boundary between two white keys.
      const c = whiteIndex * ww;
      const bw = ww * BLACK_KEY_WIDTH;
      this.blackKeys.push({ note: n, black: true, u0: c - bw / 2, u1: c + bw / 2, v0: 1 - BLACK_KEY_LENGTH, v1: 1 });
    }
    this.keys = [...this.whiteKeys, ...this.blackKeys];
    this.byNote = new Map(this.keys.map((k) => [k.note, k]));
    this.place({ cx: 0.5, fy: 1, width: 1, depth: 0.4, tilt: 0 });
  }

  get endNote() {
    return this.startNote + this.octaves * 12;
  }

  get whiteKeyU() {
    return 1 / this.whiteKeys.length;
  }

  /**
   * Places the keyboard on screen.
   * @param {object} p
   * @param {number} p.cx screen x of the center of the front edge
   * @param {number} p.fy screen y of the front edge
   * @param {number} p.width width of the front edge (screen units)
   * @param {number} p.depth length of the keys before tilting (screen units)
   * @param {number} p.tilt radians; 0 = facing the camera, larger = lying flatter on the table
   */
  place({ cx, fy, width, depth, tilt }) {
    this.placement = { cx, fy, width, depth, tilt };
    // Virtual camera distance: sets how strong the perspective is.
    this.cameraDistance = 1.6 * Math.max(width, depth);
    this.sin = Math.sin(tilt);
    this.cos = Math.cos(tilt);
    return this;
  }

  /** Keyboard space (u, v, h) to screen coordinates. */
  project(u, v, h = 0) {
    const { cx, fy, width, depth } = this.placement;
    const up = (v * this.cos + h * this.sin) * depth; // height on screen before perspective
    const away = (v * this.sin - h * this.cos) * depth; // distance from the viewer
    const s = this.cameraDistance / (this.cameraDistance + away);
    return { x: cx + (u - 0.5) * width * s, y: fy - up * s, s };
  }

  /** Screen point to keyboard space on the plane at height h, or null. */
  unproject(x, y, h = 0) {
    const { cx, fy, width, depth } = this.placement;
    const Z = this.cameraDistance;
    const a = fy - y;
    const denom = depth * (a * this.sin - Z * this.cos);
    if (Math.abs(denom) < 1e-9) return null;
    const v = (Z * h * depth * this.sin - a * Z + a * h * depth * this.cos) / denom;
    const away = (v * this.sin - h * this.cos) * depth;
    if (Z + away <= 0) return null;
    const s = Z / (Z + away);
    return { u: (x - cx) / (width * s) + 0.5, v };
  }

  /** The key at keyboard-space position (u, v), black keys first, or null. */
  keyAtUV(u, v) {
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    for (const k of this.blackKeys) {
      if (u >= k.u0 && u <= k.u1 && v >= k.v0) return k;
    }
    return this.whiteKeys[Math.min(this.whiteKeys.length - 1, Math.floor(u * this.whiteKeys.length))];
  }

  /**
   * The key under a screen point. `slack` (in key lengths) also accepts points
   * slightly in front of / behind the keyboard and maps them onto its edge, so
   * a fingertip hovering just above the keys still finds one.
   */
  hitTest(x, y, slack = 0) {
    const p = this.unproject(x, y);
    if (!p) return null;
    if (p.u < 0 || p.u > 1 || p.v < -slack || p.v > 1 + slack) return null;
    return this.keyAtUV(p.u, Math.min(0.999, Math.max(0.001, p.v)));
  }

  /** Screen corners of the key-top surface: front-left, front-right, back-right, back-left. */
  outline() {
    return [this.project(0, 0), this.project(1, 0), this.project(1, 1), this.project(0, 1)];
  }

  contains(x, y) {
    const p = this.unproject(x, y);
    return !!p && p.u >= 0 && p.u <= 1 && p.v >= 0 && p.v <= 1;
  }

  key(note) {
    return this.byNote.get(note) ?? null;
  }
}
