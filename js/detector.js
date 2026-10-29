// Turns fingertip movement into note on / note off events.
//
// A note plays when a finger makes a deliberate keystroke, like on a real
// piano: it moves down quickly and then *lands* (stops abruptly). Where the
// fingertip happens to be, or what it passes over, never plays anything.
//
// For every finger we track how far its tip is below its own knuckle, in
// hand-size units ("rel"). A keystroke is a fast increase of rel that then
// stops. On top of that:
//
//  - Aim: the key that plays is the key the fingertip was hovering over just
//    before the stroke started, with hysteresis at key borders, not the key it
//    passes over while moving.
//  - Moving, lowering or swinging the whole hand never plays (tip and knuckle
//    move together, and strokes are ignored while the hand moves fast).
//  - Tilting the hand moves all fingers together; that shared movement
//    ("common mode") is subtracted.
//  - Sympathetic movement: when one finger presses, its neighbours often move
//    a bit too. A finger only plays if its stroke is about as strong as the
//    strongest stroke in that hand, so weaker "dragged along" movements are
//    ignored while real chords (similar strokes) still play.
//  - A finger that slides sideways across keys during the stroke is passing
//    over the keys, not pressing one.
//  - Slow curls, and small bounces right after a release, are ignored.
//  - The speed threshold adapts to how jittery each finger's tracking is.
//
// Pure logic: points are in screen pixels, time in seconds.

export const FINGERTIPS = [4, 8, 12, 16, 20];
export const FINGER_BASES = [2, 5, 9, 13, 17];
export const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky'];

const WRIST = 0;
const INDEX_MCP = 5;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;

const IDLE = 'idle';
const STROKE = 'stroke';
const DOWN = 'down';

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
   */
  constructor({ sensitivity = 5, useThumbs = true, lostGrace = 0.15 } = {}) {
    this.sensitivity = sensitivity;
    this.useThumbs = useThumbs;
    this.lostGrace = lostGrace;
    this.window = 0.4; // seconds of history used to find the finger's rest position
    this.maxStrokeTime = 0.35; // a keystroke must land within this time
    this.maxHandSpeed = 2.5; // hand sizes per second
    this.fingers = new Map();
    this.hands = new Map();
  }

  /** Threshold multiplier: 1 at sensitivity 5, larger (stricter) below, smaller above. */
  get strictness() {
    return Math.pow(2, (5 - this.sensitivity) / 4);
  }

  /** Downward stroke (hand-size units) needed to press. */
  get depthThreshold() {
    return 0.09 * this.strictness;
  }

  /** Peak downward speed (hand-size units per second) needed to press. */
  get speedThreshold() {
    return 0.5 * this.strictness;
  }

  /**
   * @param {{id:number, points:{x:number,y:number}[]}[]} hands
   * @param {import('./keyboard.js').Keyboard} keyboard
   * @param {number} t seconds
   * @returns {{type:'on'|'off'|'ignored', id:string, note?:number, velocity?:number, reason?:string, finger:number, x:number, y:number}[]}
   */
  update(hands, keyboard, t) {
    const events = [];
    const seen = new Set();

    for (const hand of hands) {
      const h = this.#handState(hand, t);
      const states = [];
      for (let f = 0; f < FINGERTIPS.length; f++) {
        if (f === 0 && !this.useThumbs) continue;
        const id = `${hand.id}:${f}`;
        seen.add(id);
        states.push(this.#updateSignal(id, f, hand.points[FINGERTIPS[f]], hand.points[FINGER_BASES[f]], h.scale, t));
      }

      // Remove what all fingers do together (hand tilting, tracking wobble).
      const commonDrop = commonMode(states.map((s) => s.rawDrop));
      const commonVel = commonMode(states.map((s) => s.rawVel));
      for (const s of states) {
        s.drop = s.rawDrop - commonDrop;
        s.vel = s.rawVel - commonVel;
      }

      for (const s of states) this.#step(s, h, states, keyboard, t, events);
    }

    for (const [id, s] of this.fingers) {
      if (seen.has(id)) continue;
      if (t - s.lastSeen > this.lostGrace) {
        if (s.note !== null) events.push(this.#off(s));
        this.fingers.delete(id);
      }
    }
    for (const [id, h] of this.hands) if (t - h.t > this.lostGrace) this.hands.delete(id);
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

  /** Per-finger state for drawing: progress 0..1 towards a press, aimed key, held note. */
  finger(id) {
    return this.fingers.get(id) ?? null;
  }

  // ---------------------------------------------------------------- signals

  #handState(hand, t) {
    const scale = handScale(hand.points);
    const c = hand.points[MIDDLE_MCP];
    let h = this.hands.get(hand.id);
    if (!h) {
      h = { x: c.x, y: c.y, t, speed: 0, fires: [] };
      this.hands.set(hand.id, h);
    }
    const dt = t - h.t;
    if (dt > 0) h.speed = lerp(h.speed, Math.hypot(c.x - h.x, c.y - h.y) / scale / dt, 0.5);
    h.x = c.x;
    h.y = c.y;
    h.t = t;
    h.scale = scale;
    h.fires = h.fires.filter((fire) => t - fire.t < 0.3);
    return h;
  }

  #updateSignal(id, f, tip, base, scale, t) {
    // How far the tip is below its knuckle; grows when the finger presses down.
    const rel = (tip.y - base.y) / scale;
    let s = this.fingers.get(id);
    if (!s) {
      s = { id, finger: f, note: null, phase: IDLE, history: [], rawVel: 0, rel, noise: 0, aim: null, progress: 0 };
      this.fingers.set(id, s);
    }
    const dt = t - (s.t ?? t);
    s.rawVel = dt > 0 ? lerp(s.rawVel, (rel - s.rel) / dt, 0.75) : 0;
    s.rel = rel;
    s.t = t;
    s.dt = dt;
    s.lastSeen = t;
    s.prevX = s.x ?? tip.x;
    s.x = tip.x;
    s.y = tip.y;
    s.history.push({ t, rel });
    while (s.history.length > 1 && t - s.history[0].t > this.window) s.history.shift();
    // Drop since the finger's highest point within the window.
    s.rawDrop = rel - Math.min(...s.history.map((p) => p.rel));
    return s;
  }

  // ---------------------------------------------------------------- state machine

  #step(s, h, states, kb, t, events) {
    const thumb = s.finger === 0 ? 1.3 : 1; // thumbs are noisier
    const depthOn = this.depthThreshold * thumb;
    const baseSpeed = this.speedThreshold * thumb;
    // Jittery tracking (poor light, far away) needs a clearer stroke. Jitter is
    // measured only while the finger is at rest, so fast playing doesn't count.
    const speedOn = Math.max(baseSpeed, 3 * s.noise);
    s.progress = s.phase === DOWN ? 1 : clamp(s.drop / depthOn, 0, 1);

    if (s.phase === IDLE) {
      if (s.dt > 0 && s.drop < depthOn * 0.5 && Math.abs(s.vel) < baseSpeed) {
        s.noise = lerp(s.noise, Math.abs(s.vel), Math.min(1, s.dt / 1.5));
      }
      if (s.vel > speedOn * 0.5 && h.speed < this.maxHandSpeed) {
        // Keep the aim from before the movement started.
        if (!s.aim) this.#updateAim(s, kb);
        s.phase = STROKE;
        s.stroke = { t0: t, x0: s.prevX, aim: s.aim, peakVel: s.vel };
      } else {
        this.#updateAim(s, kb);
      }
      return;
    }

    if (s.phase === STROKE) {
      const st = s.stroke;
      st.peakVel = Math.max(st.peakVel, s.vel);
      if (t - st.t0 > this.maxStrokeTime || s.vel < -speedOn * 0.5 || h.speed >= this.maxHandSpeed) {
        // Too slow, reversed before landing, or the whole hand moved.
        s.phase = IDLE;
        return;
      }
      const deepEnough = s.drop >= depthOn;
      const fastEnough = st.peakVel >= speedOn;
      const landed = s.vel <= st.peakVel * 0.35;
      if (!(deepEnough && fastEnough && (landed || s.drop >= depthOn * 2.2))) return;

      const reason = this.#rejectReason(s, h, states, kb, depthOn);
      if (reason) {
        s.phase = IDLE;
        s.history = [{ t, rel: s.rel }];
        events.push({ type: 'ignored', reason, id: s.id, finger: s.finger, x: s.x, y: s.y });
        return;
      }
      const key = st.aim ?? kb.hitTest(s.x, s.y, 0.35);
      if (!key) {
        s.phase = IDLE;
        return;
      }
      s.phase = DOWN;
      s.peak = s.rel;
      s.depth = s.drop;
      h.fires.push({ finger: s.finger, t, depth: s.drop });
      const loud = clamp(0.35 + 0.65 * (st.peakVel / speedOn - 1) / 3, 0.3, 1);
      events.push(this.#on(s, key.note, loud));
      return;
    }

    // DOWN: held until the finger lifts a bit from its lowest point.
    s.peak = Math.max(s.peak, s.rel);
    if (s.peak - s.rel > Math.max(depthOn * 0.4, s.depth * 0.3)) {
      events.push(this.#off(s));
      s.phase = IDLE;
      // Start a fresh stroke from here so a small bounce can't retrigger.
      s.history = [{ t, rel: s.rel }];
      s.drop = 0;
      s.aim = null;
    }
  }

  /** Why a landed stroke should not play, or null if it should. */
  #rejectReason(s, h, states, kb, depthOn) {
    // Slid sideways across the keys during the stroke: passing over, not pressing.
    const whiteKeyPx = kb.whiteKeyU * kb.placement.width;
    if (Math.abs(s.x - s.stroke.x0) > Math.max(0.8 * whiteKeyPx, s.drop * h.scale * 1.2)) return 'slid';

    // Much weaker than another finger of the same hand moving at the same time:
    // most likely dragged along by it (stronger rule for direct neighbours).
    for (const o of states) {
      if (o === s || o.phase === IDLE) continue;
      const ratio = Math.abs(o.finger - s.finger) === 1 ? 1.4 : 1.8;
      const other = o.phase === DOWN ? Math.max(o.drop, o.depth ?? 0) : o.drop;
      if (other > s.drop * ratio) return 'neighbour';
    }
    // A neighbour just played with a clearly bigger stroke.
    for (const fire of h.fires) {
      if (Math.abs(fire.finger - s.finger) === 1 && s.drop < fire.depth * 0.6) return 'neighbour';
    }
    return null;
  }

  /**
   * The key the fingertip is aiming at. It only changes when the tip is
   * clearly inside another key, so a finger resting on a border keeps its key.
   */
  #updateAim(s, kb) {
    const p = kb.unproject(s.x, s.y);
    if (!p || p.u < 0 || p.u > 1 || p.v < -0.35 || p.v > 1.35) {
      s.aim = null;
      return;
    }
    const v = clamp(p.v, 0.001, 0.999);
    const key = kb.keyAtUV(p.u, v);
    if (!key || key === s.aim) return;
    if (!s.aim) {
      s.aim = key;
      return;
    }
    const mu = kb.whiteKeyU * 0.18;
    const mv = 0.07;
    const probes = [[p.u - mu, v], [p.u + mu, v], [p.u, clamp(v - mv, 0.001, 0.999)], [p.u, clamp(v + mv, 0.001, 0.999)]];
    const clearlyInside = probes.every(([u, vv]) => kb.keyAtUV(clamp(u, 0, 1), vv) === key);
    const stillTouchesOld = probes.some(([u, vv]) => kb.keyAtUV(clamp(u, 0, 1), vv) === s.aim);
    if (clearlyInside || !stillTouchesOld) s.aim = key;
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
