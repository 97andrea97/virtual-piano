// Turns fingertip movement into note on / note off events.
//
// Two modes:
//  - "touch": the keyboard behaves like a surface. A fingertip that crosses the
//    top edge of the keyboard presses the key under it; lifting it back above
//    the edge releases it. Sliding sideways inside the keyboard moves to the
//    neighbouring key (glissando). Works best with the camera looking at a
//    table from the front, or with hands hovering above the drawn keyboard.
//  - "tap": the finger has to make a quick downward "press" movement relative
//    to its own knuckle, like playing a real piano in the air. Moving the whole
//    hand around never plays anything, only bending a finger does. The key is
//    the one under (or right below) the fingertip.
//
// Pure logic: points are in screen pixels, time in seconds.

export const FINGERTIPS = [4, 8, 12, 16, 20];
export const FINGER_BASES = [2, 5, 9, 13, 17];
export const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky'];

const WRIST = 0;
const MIDDLE_MCP = 9;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, k) => a + (b - a) * k;

export class PressDetector {
  /**
   * @param {object} opts
   * @param {'touch'|'tap'} opts.mode
   * @param {number} opts.sensitivity 1 (needs big, fast movements) .. 10 (very sensitive)
   * @param {boolean} opts.useThumbs
   * @param {number} opts.lostGrace seconds a finger may disappear before its note is released
   */
  constructor({ mode = 'touch', sensitivity = 5, useThumbs = true, lostGrace = 0.15 } = {}) {
    this.mode = mode;
    this.sensitivity = sensitivity;
    this.useThumbs = useThumbs;
    this.lostGrace = lostGrace;
    this.fingers = new Map();
  }

  /** Threshold multiplier: 1 at sensitivity 5, larger (stricter) below, smaller above. */
  get strictness() {
    return Math.pow(2, (5 - this.sensitivity) / 4);
  }

  setMode(mode) {
    if (mode === this.mode) return [];
    const events = this.releaseAll();
    this.mode = mode;
    return events;
  }

  /**
   * @param {{id:number, points:{x:number,y:number}[]}[]} hands
   * @param {import('./keyboard.js').Keyboard} keyboard
   * @param {number} t seconds
   * @returns {{type:'on'|'off', id:string, note:number, velocity?:number, finger:number, x:number, y:number}[]}
   */
  update(hands, keyboard, t) {
    const events = [];
    const seen = new Set();

    for (const hand of hands) {
      const scale = Math.max(1e-6, Math.hypot(
        hand.points[MIDDLE_MCP].x - hand.points[WRIST].x,
        hand.points[MIDDLE_MCP].y - hand.points[WRIST].y,
      ));
      for (let f = 0; f < FINGERTIPS.length; f++) {
        if (f === 0 && !this.useThumbs) continue;
        const id = `${hand.id}:${f}`;
        seen.add(id);
        const tip = hand.points[FINGERTIPS[f]];
        const base = hand.points[FINGER_BASES[f]];
        let s = this.fingers.get(id);
        const fresh = !s;
        if (fresh) {
          s = { id, finger: f, note: null, x: tip.x, y: tip.y, t, vy: 0, armed: false };
          this.fingers.set(id, s);
        }
        const dt = t - s.t;
        if (dt > 0) {
          s.vy = lerp(s.vy, (tip.y - s.y) / dt, 0.6);
        }
        s.x = tip.x;
        s.y = tip.y;
        s.t = t;
        s.lastSeen = t;

        if (this.mode === 'tap') this.#updateTap(s, tip, base, scale, keyboard, dt, fresh, events);
        else this.#updateTouch(s, tip, keyboard, fresh, events);
      }
    }

    for (const [id, s] of this.fingers) {
      if (seen.has(id)) continue;
      if (t - s.lastSeen > this.lostGrace) {
        if (s.note !== null) events.push(this.#off(s));
        this.fingers.delete(id);
      }
    }
    return events;
  }

  releaseAll() {
    const events = [];
    for (const s of this.fingers.values()) {
      if (s.note !== null) events.push(this.#off(s));
    }
    this.fingers.clear();
    return events;
  }

  /** Currently held notes, keyed by finger id. */
  get activeFingers() {
    return [...this.fingers.values()].filter((s) => s.note !== null);
  }

  #on(s, note, velocity) {
    s.note = note;
    s.velocity = velocity;
    return { type: 'on', id: s.id, note, velocity, finger: s.finger, x: s.x, y: s.y };
  }

  #off(s) {
    const note = s.note;
    s.note = null;
    return { type: 'off', id: s.id, note, finger: s.finger, x: s.x, y: s.y };
  }

  // ---- touch mode ---------------------------------------------------------

  #updateTouch(s, tip, kb, fresh, events) {
    const r = kb.rect;
    const margin = r.h * 0.05 * this.strictness; // hysteresis around the top edge
    const inside = tip.x >= r.x && tip.x <= r.x + r.w && tip.y > r.y + margin && tip.y <= r.y + r.h;

    // A finger that appears already inside the keyboard (e.g. tracking was lost
    // for a moment) must lift above the keyboard once before it can play.
    if (fresh) s.armed = !inside;
    if (tip.y < r.y + margin) s.armed = true;

    if (s.note === null) {
      if (inside && s.armed) {
        const key = kb.hitTest(tip.x, tip.y);
        if (key) events.push(this.#on(s, key.note, this.#touchVelocity(s.vy / r.h)));
      }
      return;
    }

    const lifted = tip.y < r.y - margin;
    const left = tip.x < r.x - margin || tip.x > r.x + r.w + margin || tip.y > r.y + r.h * 1.5;
    if (lifted || left) {
      events.push(this.#off(s));
      return;
    }

    // Slide to a neighbouring key only when the fingertip is clearly inside it,
    // so a finger resting on a key boundary does not retrigger repeatedly.
    const y = Math.min(tip.y, r.y + r.h - 1);
    const x = clamp(tip.x, r.x, r.x + r.w);
    const key = kb.hitTest(x, Math.max(y, r.y));
    if (key && key.note !== s.note) {
      const hx = kb.whiteKeyWidth * 0.15;
      const hy = r.h * 0.06;
      const probes = [kb.hitTest(x - hx, y), kb.hitTest(x + hx, y), kb.hitTest(x, y - hy), kb.hitTest(x, y + hy)];
      if (probes.every((p) => p && p.note === key.note)) {
        events.push(this.#off(s));
        events.push(this.#on(s, key.note, s.velocity));
      }
    }
  }

  #touchVelocity(speed) {
    // speed in keyboard heights per second; a firm press is around 3-4.
    return clamp(0.3 + (speed - 0.3) * 0.2, 0.3, 1);
  }

  // ---- tap mode -----------------------------------------------------------

  #updateTap(s, tip, base, scale, kb, dt, fresh, events) {
    // How far the fingertip is below its knuckle, in hand-size units. Pressing
    // a key (bending the finger down) makes this grow quickly.
    const rel = (tip.y - base.y) / scale;
    if (fresh || dt <= 0) {
      s.rel = rel;
      s.baseline = rel;
      s.relVel = 0;
      return;
    }
    s.relVel = lerp(s.relVel, (rel - s.rel) / dt, 0.6);
    s.rel = rel;

    const k = this.strictness;
    const depthOn = 0.12 * k;
    const velOn = 0.9 * k;

    if (s.note === null) {
      // Baseline = the finger's lifted "rest" position. It follows upward
      // movement quickly and downward drift slowly.
      s.baseline = rel < s.baseline ? lerp(s.baseline, rel, 0.5) : lerp(s.baseline, rel, Math.min(1, dt / 1.0));
      const depth = rel - s.baseline;
      if (depth > depthOn && s.relVel > velOn) {
        const key = this.#tapKey(tip, kb);
        if (key) {
          s.peak = rel;
          events.push(this.#on(s, key.note, clamp(0.3 + (s.relVel - velOn) * 0.15, 0.3, 1)));
        }
      }
      return;
    }

    s.peak = Math.max(s.peak, rel);
    const depth = rel - s.baseline;
    const risen = s.peak - rel;
    if (depth < depthOn * 0.5 || risen > depthOn * 0.6) {
      events.push(this.#off(s));
      // The finger is now coming back up; re-anchor the rest position here.
      s.baseline = Math.min(s.baseline, rel);
    }
  }

  #tapKey(tip, kb) {
    const r = kb.rect;
    if (tip.x < r.x || tip.x > r.x + r.w) return null;
    // Fingers may hover above the drawn keyboard: anything up to one keyboard
    // height above it maps to the upper (black key) part of the keys.
    if (tip.y < r.y - r.h || tip.y > r.y + r.h * 1.2) return null;
    const y = clamp(tip.y, r.y + 1, r.y + r.h - 1);
    return kb.hitTest(tip.x, y);
  }
}
