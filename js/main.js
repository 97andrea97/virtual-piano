import { Keyboard, noteName, BLACK_KEY_HEIGHT, KEY_THICKNESS, KEY_TRAVEL } from './keyboard.js';
import { HandTracker } from './hands.js';
import { PressDetector, FINGERTIPS } from './detector.js';
import { PianoAudio } from './audio.js';
import { Camera, HandDetector } from './vision.js';

const FINGER_COLORS = ['#ff6b6b', '#ffb347', '#ffe066', '#5ce1a5', '#5cb8ff'];
const POINTER_COLOR = '#c08cff';
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];
// Keyboard placement as fractions of the screen: cx/w of the width, fy/d of the height.
const DEFAULT_PLACEMENT = {
  landscape: { cx: 0.5, fy: 0.94, w: 0.84, d: 0.55 },
  portrait: { cx: 0.5, fy: 0.9, w: 0.94, d: 0.3 },
};
const DEFAULT_TILT = 55; // degrees
const HOVER_SLACK = 0.35; // fingertips this far (in key lengths) behind/in front of the keys still aim at them
const STORAGE_KEY = 'air-piano-settings-v2';

// ---------------------------------------------------------------- settings

const defaults = {
  instrument: 'synth',
  octaves: matchMedia('(orientation: portrait)').matches ? 1 : 2,
  startNote: 60,
  sensitivity: 5,
  volume: 0.8,
  opacity: 0.85,
  useThumbs: true,
  skeleton: false,
  labels: true,
  mirror: true,
  facingMode: 'user',
  tilt: DEFAULT_TILT,
  placement: { ...DEFAULT_PLACEMENT },
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...defaults, ...saved, placement: { ...DEFAULT_PLACEMENT, ...saved.placement } };
  } catch {
    return { ...defaults };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* storage unavailable (private mode) */ }
}

const settings = loadSettings();

// ---------------------------------------------------------------- state

const $ = (sel) => document.querySelector(sel);
const canvas = $('#stage');
const ctx = canvas.getContext('2d');
const layer = document.createElement('canvas');
const layerCtx = layer.getContext('2d');
const video = $('#video');

const audio = new PianoAudio();
const camera = new Camera(video);
const handDetector = new HandDetector();
const tracker = new HandTracker({ filter: { minCutoff: 2.0, beta: 0.015 } });
const detector = new PressDetector({ sensitivity: settings.sensitivity, useThumbs: settings.useThumbs });
let keyboard = new Keyboard({ startNote: settings.startNote, octaves: settings.octaves });

const view = { w: 0, h: 0, dpr: 1, orientation: 'landscape' };
let hands = [];
let cameraOn = false;
let trackingOn = false;
let editing = false;
let lastVideoTime = -1;
let lastHandsSeen = 0;
let notesPlayed = 0;
let fps = 0;
let statusOverride = '';
const ripples = []; // visual feedback for note-ons
const pointerNotes = new Map(); // pointerId -> note (playing by touching the screen)
const sourceNotes = new Map(); // source id -> { note, color }
const keyDepth = new Map(); // note -> 0..1 animated key press depth

// ---------------------------------------------------------------- geometry

function resize() {
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.w = window.innerWidth;
  view.h = window.innerHeight;
  view.orientation = view.w >= view.h ? 'landscape' : 'portrait';
  canvas.width = Math.round(view.w * view.dpr);
  canvas.height = Math.round(view.h * view.dpr);
  layer.width = canvas.width;
  layer.height = canvas.height;
  layoutKeyboard();
}

function currentPlacement() {
  return settings.placement[view.orientation] ?? DEFAULT_PLACEMENT[view.orientation];
}

function setPlacement(p) {
  settings.placement = { ...settings.placement, [view.orientation]: p };
  layoutKeyboard();
}

function layoutKeyboard() {
  const p = currentPlacement();
  keyboard.place({
    cx: p.cx * view.w,
    fy: p.fy * view.h,
    width: p.w * view.w,
    depth: p.d * view.h,
    tilt: (settings.tilt * Math.PI) / 180,
  });
}

function rebuildKeyboard() {
  applyEvents(detector.releaseAll());
  keyboard = new Keyboard({ startNote: settings.startNote, octaves: settings.octaves });
  keyDepth.clear();
  layoutKeyboard();
  if (settings.instrument === 'grand') loadInstrument();
}

/** Maps the video into the screen like CSS object-fit: cover. */
function videoTransform() {
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const scale = Math.max(view.w / vw, view.h / vh);
  return { vw, vh, scale, dx: (view.w - vw * scale) / 2, dy: (view.h - vh * scale) / 2 };
}

function toScreen(p, tf) {
  const x = settings.mirror ? (1 - p.x) * tf.vw : p.x * tf.vw;
  return { x: tf.dx + x * tf.scale, y: tf.dy + p.y * tf.vh * tf.scale };
}

// ---------------------------------------------------------------- notes

function applyEvents(events) {
  for (const e of events) {
    if (e.type === 'on') {
      const color = FINGER_COLORS[e.finger] ?? POINTER_COLOR;
      audio.noteOn(e.note, e.velocity, e.id);
      sourceNotes.set(e.id, { note: e.note, color });
      ripples.push({ x: e.x, y: e.y, t: performance.now(), color, note: e.note });
      notesPlayed++;
    } else {
      audio.noteOff(e.note, e.id);
      sourceNotes.delete(e.id);
    }
  }
}

function pressedKeys() {
  const pressed = new Map();
  for (const { note, color } of sourceNotes.values()) pressed.set(note, color);
  return pressed;
}

// ---------------------------------------------------------------- main loop

function processVideoFrame(now) {
  if (!trackingOn || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  let detections;
  try {
    detections = handDetector.detect(video, now);
  } catch (err) {
    console.error(err);
    return;
  }
  const tf = videoTransform();
  const screenHands = detections.map((d) => ({ ...d, points: d.points.map((p) => toScreen(p, tf)) }));
  hands = tracker.update(screenHands, now / 1000);
  if (hands.length) lastHandsSeen = now;
  if (!editing) applyEvents(detector.update(hands, keyboard, now / 1000));
}

let lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  processVideoFrame(now);
  draw(now, dt);
  updateStatus(now);
}

function updateStatus(now) {
  let text = statusOverride;
  if (!text && editing) text = 'Drag the keyboard to move it, use the handles to resize it';
  else if (!text && trackingOn && now - lastHandsSeen > 1500) text = 'Show your hands to the camera';
  else if (!text && trackingOn && notesPlayed === 0 && hands.length) text = 'Fingers over the keys, then tap down quickly with one finger';
  if ($('#status').textContent !== text) $('#status').textContent = text;
}

// ---------------------------------------------------------------- drawing

function draw(now, dt) {
  const { w, h, dpr } = view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#101418';
  ctx.fillRect(0, 0, w, h);

  if (cameraOn && video.readyState >= 2) {
    const tf = videoTransform();
    if (settings.mirror) {
      ctx.setTransform(-tf.scale * dpr, 0, 0, tf.scale * dpr, (tf.dx + tf.vw * tf.scale) * dpr, tf.dy * dpr);
    } else {
      ctx.setTransform(tf.scale * dpr, 0, 0, tf.scale * dpr, tf.dx * dpr, tf.dy * dpr);
    }
    ctx.drawImage(video, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Darken slightly so the keyboard and fingertips stand out.
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(0, 0, w, h);
  }

  const pressed = pressedKeys();
  animateKeys(pressed, dt);
  // Draw the keyboard opaque on its own layer, then blend the whole layer, so
  // overlapping key faces don't show through each other.
  layerCtx.setTransform(1, 0, 0, 1, 0, 0);
  layerCtx.clearRect(0, 0, layer.width, layer.height);
  layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawKeyboard(layerCtx, pressed, hoveredKeys());
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = settings.opacity;
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
  drawHands();
  drawRipples(now);
  if (editing) drawEditHandles();
}

function animateKeys(pressed, dt) {
  for (const k of keyboard.keys) {
    const target = pressed.has(k.note) ? 1 : 0;
    const cur = keyDepth.get(k.note) ?? 0;
    if (cur === target) continue;
    // Keys go down fast and come back up a little slower, like real keys.
    const speed = target > cur ? 40 : 18;
    const next = cur + (target - cur) * Math.min(1, dt * speed);
    keyDepth.set(k.note, Math.abs(next - target) < 0.01 ? target : next);
  }
}

/** The key each fingertip is aiming at (shown as a faint highlight). */
function hoveredKeys() {
  const hovered = new Map();
  if (editing) return hovered;
  for (const hand of hands) {
    FINGERTIPS.forEach((tipIndex, f) => {
      if (f === 0 && !settings.useThumbs) return;
      const p = hand.points[tipIndex];
      const key = keyboard.hitTest(p.x, p.y, HOVER_SLACK);
      if (key && !hovered.has(key.note)) hovered.set(key.note, FINGER_COLORS[f]);
    });
  }
  return hovered;
}

function quad(g, points) {
  g.beginPath();
  g.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
  g.closePath();
}

function drawKeyboard(g, pressed, hovered) {
  const kb = keyboard;
  const P = (u, v, h) => kb.project(u, v, h);
  const gap = kb.whiteKeyU * 0.05;
  const base = -KEY_THICKNESS;

  // Soft shadow on the "table" under the keyboard.
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.55)';
  g.shadowBlur = 24;
  g.shadowOffsetY = 10;
  quad(g, [P(-0.01, -0.01, base - 0.02), P(1.01, -0.01, base - 0.02), P(1.01, 1.05, base - 0.02), P(-0.01, 1.05, base - 0.02)]);
  g.fillStyle = 'rgba(20,20,24,0.9)';
  g.fill();
  g.restore();

  // Case: back panel standing behind the keys, and the body under them.
  const backTop = 0.16;
  quad(g, [P(-0.012, 1, base), P(1.012, 1, base), P(1.012, 1, backTop), P(-0.012, 1, backTop)]);
  const backGrad = g.createLinearGradient(0, P(0.5, 1, backTop).y, 0, P(0.5, 1, 0).y);
  backGrad.addColorStop(0, '#3a3540');
  backGrad.addColorStop(1, '#141218');
  g.fillStyle = backGrad;
  g.fill();
  quad(g, [P(-0.012, 1, backTop), P(1.012, 1, backTop), P(1.012, 1.06, backTop), P(-0.012, 1.06, backTop)]);
  g.fillStyle = '#4a4452';
  g.fill();
  // Felt strip where the keys meet the back panel.
  quad(g, [P(0, 0.985, 0.005), P(1, 0.985, 0.005), P(1, 1, 0.005), P(0, 1, 0.005)]);
  g.fillStyle = '#7a1e2c';
  g.fill();

  // White keys: front face, then top face.
  const front = P(0.5, 0, 0).y;
  const back = P(0.5, 1, 0).y;
  for (const k of kb.whiteKeys) {
    const depth = keyDepth.get(k.note) ?? 0;
    const top = -depth * KEY_TRAVEL;
    const u0 = k.u0 + gap / 2;
    const u1 = k.u1 - gap / 2;
    const color = pressed.get(k.note);

    quad(g, [P(u0, 0, top), P(u1, 0, top), P(u1, 0, base), P(u0, 0, base)]);
    g.fillStyle = color ? mix(color, '#000000', 0.35) : '#b9bec6';
    g.fill();

    quad(g, [P(u0, 0, top), P(u1, 0, top), P(u1, 1, top), P(u0, 1, top)]);
    const grad = g.createLinearGradient(0, front, 0, back);
    if (color) {
      grad.addColorStop(0, mix(color, '#ffffff', 0.35));
      grad.addColorStop(1, color);
    } else {
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(1, '#dfe3e8');
    }
    g.fillStyle = grad;
    g.fill();
    const hover = !color && hovered.get(k.note);
    if (hover) {
      g.fillStyle = withAlpha(hover, 0.28);
      g.fill();
    }
    g.strokeStyle = 'rgba(0,0,0,0.18)';
    g.lineWidth = 1;
    g.stroke();
  }

  if (settings.labels) drawLabels(g, pressed);

  // Black keys: raised boxes. Sides first, then the front face, then the top.
  for (const k of kb.blackKeys) {
    const depth = keyDepth.get(k.note) ?? 0;
    const top = BLACK_KEY_HEIGHT - depth * KEY_TRAVEL;
    const color = pressed.get(k.note);
    const hover = !color && hovered.get(k.note);
    const { u0, u1, v0 } = k;
    const inset = (u1 - u0) * 0.12; // tops are narrower than the base
    const tv0 = v0 + 0.03;

    g.fillStyle = '#050506';
    quad(g, [P(u0, v0, 0), P(u0, 1, 0), P(u0 + inset, 1, top), P(u0 + inset, tv0, top)]);
    g.fill();
    quad(g, [P(u1, v0, 0), P(u1, 1, 0), P(u1 - inset, 1, top), P(u1 - inset, tv0, top)]);
    g.fill();

    quad(g, [P(u0, v0, 0), P(u1, v0, 0), P(u1 - inset, tv0, top), P(u0 + inset, tv0, top)]);
    g.fillStyle = color ? mix(color, '#000000', 0.45) : '#2b2b31';
    g.fill();

    quad(g, [P(u0 + inset, tv0, top), P(u1 - inset, tv0, top), P(u1 - inset, 1, top), P(u0 + inset, 1, top)]);
    const grad = g.createLinearGradient(0, P(0.5, tv0, top).y, 0, P(0.5, 1, top).y);
    if (color) {
      grad.addColorStop(0, mix(color, '#ffffff', 0.2));
      grad.addColorStop(1, mix(color, '#000000', 0.3));
    } else {
      grad.addColorStop(0, '#4a4a52');
      grad.addColorStop(1, '#141417');
    }
    g.fillStyle = grad;
    g.fill();
    if (hover) {
      g.fillStyle = withAlpha(hover, 0.45);
      g.fill();
    }
  }
}

function drawLabels(g, pressed) {
  const kb = keyboard;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const k of kb.whiteKeys) {
    const depth = keyDepth.get(k.note) ?? 0;
    const p = kb.project((k.u0 + k.u1) / 2, 0.12, -depth * KEY_TRAVEL);
    const keyWidth = (k.u1 - k.u0) * kb.placement.width * p.s;
    const size = Math.max(8, Math.min(16, keyWidth * 0.34));
    g.font = `600 ${size}px system-ui, sans-serif`;
    const name = noteName(k.note);
    g.fillStyle = pressed.has(k.note) ? 'rgba(0,0,0,0.8)' : k.note % 12 === 0 ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.38)';
    // Squash the text vertically so it looks like it lies on the key.
    g.save();
    g.translate(p.x, p.y);
    g.scale(1, Math.max(0.45, Math.cos(kb.placement.tilt)));
    g.fillText(k.note % 12 === 0 ? name : name.replace(/\d+$/, ''), 0, 0);
    g.restore();
  }
}

function drawHands() {
  for (const hand of hands) {
    if (settings.skeleton) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.moveTo(hand.points[a].x, hand.points[a].y);
        ctx.lineTo(hand.points[b].x, hand.points[b].y);
      }
      ctx.stroke();
    }
    FINGERTIPS.forEach((tipIndex, f) => {
      if (f === 0 && !settings.useThumbs) return;
      const p = hand.points[tipIndex];
      const state = detector.finger(`${hand.id}:${f}`);
      const on = state?.note != null;
      const color = FINGER_COLORS[f];
      const radius = on ? 10 : 7;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = on ? color : withAlpha(color, 0.4);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = on ? '#fff' : color;
      ctx.stroke();
      // Ring that fills up as the finger gets closer to a press.
      const progress = on ? 1 : state?.progress ?? 0;
      if (progress > 0.05) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius + 5, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
        ctx.strokeStyle = on ? '#ffffff' : withAlpha(color, 0.9);
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    });
  }
}

function drawRipples(now) {
  for (let i = ripples.length - 1; i >= 0; i--) {
    const rp = ripples[i];
    const age = (now - rp.t) / 450;
    if (age >= 1) {
      ripples.splice(i, 1);
      continue;
    }
    ctx.beginPath();
    ctx.arc(rp.x, rp.y, 12 + age * 30, 0, Math.PI * 2);
    ctx.strokeStyle = withAlpha(rp.color, 1 - age);
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.font = '700 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = withAlpha('#ffffff', 1 - age);
    ctx.fillText(noteName(rp.note), rp.x, rp.y - 18 - age * 20);
  }
}

// ---------------------------------------------------------------- adjusting the keyboard

const HANDLE_RADIUS = 13;

function handles() {
  return {
    width: keyboard.project(1, 0, -KEY_THICKNESS),
    depth: keyboard.project(0.5, 1, 0.16),
  };
}

function drawEditHandles() {
  const outline = keyboard.outline();
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = '#ffb347';
  ctx.lineWidth = 2;
  quad(ctx, outline);
  ctx.stroke();
  ctx.setLineDash([]);
  const hs = handles();
  drawHandle(hs.width, '↔');
  drawHandle(hs.depth, '↕');
}

function drawHandle(p, glyph) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = '#ffb347';
  ctx.fill();
  ctx.strokeStyle = '#1d1406';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#1d1406';
  ctx.font = '700 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, p.x, p.y + 1);
}

/** Key length (as a fraction of the screen height) that puts the back edge at screen y. */
function depthForBackEdge(y) {
  const p = currentPlacement();
  let lo = 0.05;
  let hi = 2;
  const probe = new Keyboard({ startNote: 60, octaves: 1 });
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    probe.place({ cx: p.cx * view.w, fy: p.fy * view.h, width: p.w * view.w, depth: mid * view.h, tilt: keyboard.placement.tilt });
    if (probe.project(0.5, 1, 0.16).y > y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function startEditDrag(e) {
  const x = e.clientX;
  const y = e.clientY;
  const hs = handles();
  const near = (p) => Math.hypot(p.x - x, p.y - y) <= HANDLE_RADIUS + 14;
  let kind = null;
  if (near(hs.width)) kind = 'width';
  else if (near(hs.depth)) kind = 'depth';
  else if (keyboard.hitTest(x, y, 0.2)) kind = 'move';
  if (!kind) return null;
  return { id: e.pointerId, kind, x, y, start: { ...currentPlacement() } };
}

function moveEditDrag(drag, e) {
  const x = e.clientX;
  const y = e.clientY;
  const p = { ...drag.start };
  if (drag.kind === 'move') {
    p.cx = clamp(p.cx + (x - drag.x) / view.w, 0.1, 0.9);
    p.fy = clamp(p.fy + (y - drag.y) / view.h, 0.2, 1.05);
  } else if (drag.kind === 'width') {
    p.w = clamp((2 * Math.abs(x - p.cx * view.w)) / view.w, 0.2, 1.2);
  } else {
    p.d = clamp(depthForBackEdge(y), 0.08, 1.6);
  }
  setPlacement(p);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function setEditing(on) {
  editing = on;
  $('#btn-edit').setAttribute('aria-pressed', String(on));
  $('#editbar').hidden = !on;
  if (on) {
    applyEvents(detector.releaseAll());
    toggleSettings(false);
  }
}

// ---------------------------------------------------------------- pointer input

let drag = null;

canvas.addEventListener('pointerdown', (e) => {
  if (editing) {
    drag = startEditDrag(e);
    if (drag) canvas.setPointerCapture(e.pointerId);
    return;
  }
  const key = keyboard.hitTest(e.clientX, e.clientY);
  if (!key) return;
  canvas.setPointerCapture(e.pointerId);
  audio.start().catch(() => {});
  pointerNotes.set(e.pointerId, key.note);
  applyEvents([{ type: 'on', id: `p${e.pointerId}`, note: key.note, velocity: 0.7, finger: -1, x: e.clientX, y: e.clientY }]);
});

canvas.addEventListener('pointermove', (e) => {
  if (drag && drag.id === e.pointerId) {
    moveEditDrag(drag, e);
    return;
  }
  if (!pointerNotes.has(e.pointerId)) return;
  const key = keyboard.hitTest(e.clientX, e.clientY);
  const current = pointerNotes.get(e.pointerId);
  if (key && key.note !== current) {
    const id = `p${e.pointerId}`;
    applyEvents([
      { type: 'off', id, note: current, finger: -1, x: e.clientX, y: e.clientY },
      { type: 'on', id, note: key.note, velocity: 0.7, finger: -1, x: e.clientX, y: e.clientY },
    ]);
    pointerNotes.set(e.pointerId, key.note);
  }
});

function endPointer(e) {
  if (drag && drag.id === e.pointerId) {
    drag = null;
    saveSettings();
    return;
  }
  const note = pointerNotes.get(e.pointerId);
  if (note === undefined) return;
  pointerNotes.delete(e.pointerId);
  applyEvents([{ type: 'off', id: `p${e.pointerId}`, note, finger: -1, x: e.clientX, y: e.clientY }]);
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// ---------------------------------------------------------------- UI wiring

$('#btn-sustain').addEventListener('click', (e) => {
  audio.setSustain(!audio.sustain);
  e.currentTarget.setAttribute('aria-pressed', String(audio.sustain));
});

$('#btn-edit').addEventListener('click', () => setEditing(!editing));
$('#btn-edit-done').addEventListener('click', () => setEditing(false));

$('#set-tilt').addEventListener('input', (e) => {
  settings.tilt = Number(e.target.value);
  layoutKeyboard();
  saveSettings();
});

$('#btn-reset-keyboard').addEventListener('click', () => {
  settings.tilt = DEFAULT_TILT;
  $('#set-tilt').value = String(settings.tilt);
  setPlacement({ ...DEFAULT_PLACEMENT[view.orientation] });
  saveSettings();
});

$('#btn-flip').addEventListener('click', async () => {
  const next = camera.facingMode === 'user' ? 'environment' : 'user';
  try {
    applyEvents(detector.releaseAll());
    tracker.reset();
    await camera.start(next);
    settings.facingMode = next;
    settings.mirror = next === 'user';
    $('#set-mirror').checked = settings.mirror;
    saveSettings();
  } catch (err) {
    flashStatus(`Could not switch camera: ${err.message}`);
  }
});

function toggleSettings(open) {
  $('#settings').hidden = !open;
  $('#btn-settings').setAttribute('aria-expanded', String(open));
}
$('#btn-settings').addEventListener('click', () => {
  const open = $('#settings').hidden;
  if (open && editing) setEditing(false);
  toggleSettings(open);
});
$('#btn-close-settings').addEventListener('click', () => toggleSettings(false));

function syncForm() {
  $('#set-instrument').value = settings.instrument;
  $('#set-octaves').value = String(settings.octaves);
  $('#set-start').value = String(settings.startNote);
  $('#set-sensitivity').value = String(settings.sensitivity);
  $('#out-sensitivity').textContent = settings.sensitivity;
  $('#set-opacity').value = String(settings.opacity);
  $('#set-volume').value = String(settings.volume);
  $('#set-tilt').value = String(settings.tilt);
  $('#set-thumbs').checked = settings.useThumbs;
  $('#set-skeleton').checked = settings.skeleton;
  $('#set-labels').checked = settings.labels;
  $('#set-mirror').checked = settings.mirror;
}

$('#set-instrument').addEventListener('change', (e) => {
  settings.instrument = e.target.value;
  saveSettings();
  loadInstrument();
});

$('#set-octaves').addEventListener('change', (e) => {
  settings.octaves = Number(e.target.value);
  saveSettings();
  rebuildKeyboard();
});

$('#set-start').addEventListener('change', (e) => {
  settings.startNote = Number(e.target.value);
  saveSettings();
  rebuildKeyboard();
});

$('#set-sensitivity').addEventListener('input', (e) => {
  settings.sensitivity = Number(e.target.value);
  detector.sensitivity = settings.sensitivity;
  $('#out-sensitivity').textContent = settings.sensitivity;
  saveSettings();
});

$('#set-opacity').addEventListener('input', (e) => {
  settings.opacity = Number(e.target.value);
  saveSettings();
});

$('#set-volume').addEventListener('input', (e) => {
  settings.volume = Number(e.target.value);
  audio.setVolume(settings.volume);
  saveSettings();
});

$('#set-thumbs').addEventListener('change', (e) => {
  settings.useThumbs = e.target.checked;
  applyEvents(detector.releaseAll());
  detector.useThumbs = settings.useThumbs;
  saveSettings();
});

for (const [id, key] of [['#set-skeleton', 'skeleton'], ['#set-labels', 'labels'], ['#set-mirror', 'mirror']]) {
  $(id).addEventListener('change', (e) => {
    settings[key] = e.target.checked;
    if (key === 'mirror') {
      applyEvents(detector.releaseAll());
      tracker.reset();
    }
    saveSettings();
  });
}

let statusTimer = 0;
function flashStatus(text, ms = 3000) {
  statusOverride = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusOverride = ''; }, ms);
}

async function loadInstrument() {
  if (!audio.ctx) return;
  if (settings.instrument !== 'grand') {
    await audio.setInstrument('synth');
    return;
  }
  const notes = [];
  for (let n = keyboard.startNote; n <= keyboard.endNote; n++) notes.push(n);
  statusOverride = 'Loading piano samples…';
  const ok = await audio.setInstrument('grand', {
    notes,
    onProgress: (done, total) => { statusOverride = `Loading piano samples ${done}/${total}…`; },
  });
  statusOverride = '';
  if (!ok) {
    flashStatus('Could not load piano samples — using the synth');
    settings.instrument = 'synth';
    syncForm();
  }
}

function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Mixes two #rrggbb colors; k = 0 gives a, k = 1 gives b. */
function mix(a, b, k) {
  const na = parseInt(a.slice(1), 16);
  const nb = parseInt(b.slice(1), 16);
  const ch = (shift) => Math.round(((na >> shift) & 255) * (1 - k) + ((nb >> shift) & 255) * k);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

// ---------------------------------------------------------------- startup

async function keepScreenOn() {
  try {
    await navigator.wakeLock?.request('screen');
  } catch { /* not supported or denied */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    applyEvents(detector.releaseAll());
    audio.allNotesOff();
  } else if (cameraOn) {
    keepScreenOn();
  }
});

async function start() {
  const btn = $('#btn-start');
  const errorEl = $('#intro-error');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  errorEl.hidden = true;

  // Audio must be unlocked synchronously inside the click handler.
  const audioReady = audio.start();
  audio.setVolume(settings.volume);

  const cameraReady = camera.start(settings.facingMode).then(() => { cameraOn = true; });
  const trackingReady = handDetector.init({ onStatus: (s) => { statusOverride = s; } });
  trackingReady.catch(() => {}); // handled below; avoids an unhandled rejection if the camera fails first

  try {
    await audioReady;
  } catch (err) {
    console.warn('Audio could not start', err);
  }

  try {
    await cameraReady;
  } catch (err) {
    console.error(err);
    errorEl.textContent = `Camera unavailable (${err.name === 'NotAllowedError' ? 'permission denied' : err.message}). You can still play by tapping the keys.`;
    errorEl.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Play without camera';
    btn.onclick = enterApp;
    return;
  }

  enterApp();
  statusOverride = 'Loading hand tracking…';
  try {
    await trackingReady;
    trackingOn = true;
    statusOverride = '';
    lastHandsSeen = performance.now();
  } catch (err) {
    console.error(err);
    statusOverride = '';
    flashStatus('Hand tracking failed to load — check your connection. Tap the keys to play.', 8000);
  }
}

function enterApp() {
  $('#intro').hidden = true;
  $('#toolbar').hidden = false;
  keepScreenOn();
  loadInstrument();
}

$('#btn-start').addEventListener('click', start, { once: true });

window.addEventListener('resize', resize);
syncForm();
resize();
requestAnimationFrame(frame);

// Small debugging hook (handy from the browser console or automated tests).
window.airPiano = { settings, audio, detector, tracker, get keyboard() { return keyboard; }, get hands() { return hands; }, get fps() { return fps; } };
