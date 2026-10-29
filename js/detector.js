// Turns fingertip movement into note on / note off events.
//
// A note plays only when a finger makes a quick downward "keystroke", not
// because a fingertip happens to be over a key. For every finger we track how
// far its tip is below its own knuckle (in hand-size units), and look for a
// fast drop of that value within a short time window:
//
//  - Moving or lowering the whole hand changes tip and knuckle together, so it
//    never plays.
//  - Tilting the hand at the wrist moves all fingers together. That shared
//    movement ("common mode") is subtracted, so only a finger moving on its
//    own counts. Chords of up to three fingers still work.
//  - Slow curling is ignored: the drop must happen quickly.
//  - Presses are ignored while the whole hand is moving fast (tracking is
//    unreliable then and nobody plays while swinging their hand).
//  - After a press the finger has to lift again before it can play again.
//
// Pure logic: points are in screen pixels, time in seconds.

export const FINGERTIPS = [4, 8, 12, 16, 20];
export const FINGER_BASES = [2, 5, 9, 13, 17];
export const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky'];

const WRIST = 0;
const INDEX_MCP = 5;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, k) => a + (b - a) * k;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Second smallest value (or 0 when there are fewer than 3 values). */
function commonMode(values) {
  if (values.length < 3) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.max(0, sorted[1]);
}

/**
 * Hand size in pixels that stays stable when the hand is foreshortened:
 * palm width when fingers point at the camera, palm length when the hand is
 * seen from the side.
 */
export function handScale(points) {
  return Math.max(dist(points[INDEX_MCP], points[PINKY_MCP]), 0.8 * dist(points[WRIST], points[MIDDLE_MCP]), 1e-6);
}

export class PressDetector {
  /**
   * @param {object} opts
   * @param {number} opts.sensitivity 1 (needs big, fast strokes) .. 10 (very light strokes)
   * @param {boolean} opts.useThumbs
   * @param {number} opts.lostGrace seconds a finger may disappear before its note is released
   * @param {number} opts.window seconds within which the downward stroke has to happen
   */
  constructor({ sensitivity = 5, useThumbs = true, lostGrace = 0.15, window = 0.3 } = {}) {
    this.sensitivity = sensitivity;
    this.useThumbs = useThumbs;
    this.lostGrace = lostGrace;
    this.window = window;
    this.fingers = new Map();
    this.hands = new Map();
  }

  /** Threshold multiplier: 1 at sensitivity 5, larger (stricter) below, smaller above. */
  get strictness() {
    return Math.pow(2, (5 - this.sensitivity) / 4);
  }

  /** Downward stroke (hand-size units) needed to press. */
  get depthThreshold() {
    return 0.16 * this.strictness;
  }

  /** Downward speed (hand-size units per second) needed to press. */
  get speedThreshold() {
    return 0.8 * this.strictness;
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
    const seenHands = new Set();

    for (const hand of hands) {
      seenHands.add(hand.id);
      const scale = handScale(hand.points);
      const handSpeed = this.#handSpeed(hand, scale, t);

      // 1. Update each finger's signal and history.
      const states = [];
      for (let f = 0; f < FINGERTIPS.length; f++) {
        if (f === 0 && !this.useThumbs) continue;
        const id = `${hand.id}:${f}`;
        seen.add(id);
        const tip = hand.points[FINGERTIPS[f]];
        const base = hand.points[FINGER_BASES[f]];
        // How far the tip is below its knuckle; grows when the finger presses down.
        const rel = (tip.y - base.y) / scale;
        let s = this.fingers.get(id);
        if (!s) {
          s = { id, finger: f, note: null, history: [], vel: 0, rel, progress: 0 };
          this.fingers.set(id, s);
        }
        const dt = t - (s.t ?? t);
        if (dt > 0) s.vel = lerp(s.vel, (rel - s.rel) / dt, 0.6);
        s.rel = rel;
        s.t = t;
        s.lastSeen = t;
        s.x = tip.x;
        s.y = tip.y;
        s.history.push({ t, rel });
        while (s.history.length > 1 && t - s.history[0].t > this.window) s.history.shift();
        // Drop since the finger's highest point within the window.
        s.drop = rel - Math.min(...s.history.map((h) => h.rel));
        states.push(s);
      }

      // 2. Remove what all fingers do together (hand tilting, tracking wobble).
      const commonDrop = commonMode(states.map((s) => s.drop));
      const commonVel = commonMode(states.map((s) => s.vel));

      // 3. Decide presses and releases.
      const depthOn = this.depthThreshold;
      const speedOn = this.speedThreshold;
      for (const s of states) {
        const thumb = s.finger === 0 ? 1.3 : 1; // thumbs are noisier
        const drop = s.drop - commonDrop;
        const vel = s.vel - commonVel;
        s.progress = clamp(drop / (depthOn * thumb), 0, 1);

        if (s.note === null) {
          if (drop > depthOn * thumb && vel > speedOn * thumb && handSpeed < 2.5) {
            const key = keyboard.hitTest(s.x, s.y, 0.35);
            if (key) {
              s.peak = s.rel;
              const loud = clamp(0.35 + 0.65 * ((vel / (speedOn * thumb)) - 1) / 3, 0.3, 1);
              events.push(this.#on(s, key.note, loud));
            }
          }
        } else {
          s.peak = Math.max(s.peak, s.rel);
          // Released once the finger lifts a bit from its lowest point.
          if (s.peak - s.rel > depthOn * 0.4) {
            events.push(this.#off(s));
            // Start a fresh stroke from here so a small bounce can't retrigger.
            s.history = [{ t, rel: s.rel }];
            s.drop = 0;
          }
        }
      }
    }

    for (const [id, s] of this.fingers) {
      if (seen.has(id)) continue;
      if (t - s.lastSeen > this.lostGrace) {
        if (s.note !== null) events.push(this.#off(s));
        this.fingers.delete(id);
      }
    }
    for (const id of this.hands.keys()) if (!seenHands.has(id)) this.hands.delete(id);
    return events;
  }

  releaseAll() {
    const events = [];
    for (const s of this.fingers.values()) {
      if (s.note !== null) events.push(this.#off(s));
    }
    this.fingers.clear();
    this.hands.clear();
    return events;
  }

  /** Per-finger state for drawing: progress 0..1 towards a press, and the held note. */
  finger(id) {
    return this.fingers.get(id) ?? null;
  }

  /** Palm speed in hand sizes per second (smoothed). */
  #handSpeed(hand, scale, t) {
    const c = hand.points[MIDDLE_MCP];
    let h = this.hands.get(hand.id);
    if (!h) {
      h = { x: c.x, y: c.y, t, speed: 0 };
      this.hands.set(hand.id, h);
    }
    const dt = t - h.t;
    if (dt > 0) h.speed = lerp(h.speed, Math.hypot(c.x - h.x, c.y - h.y) / scale / dt, 0.5);
    h.x = c.x;
    h.y = c.y;
    h.t = t;
    return h.speed;
  }

  #on(s, note, velocity) {
    s.note = note;
    return { type: 'on', id: s.id, note, velocity, finger: s.finger, x: s.x, y: s.y };
  }

  #off(s) {
    const note = s.note;
    s.note = null;
    return { type: 'off', id: s.id, note, finger: s.finger, x: s.x, y: s.y };
  }
}
