import { Keyboard, noteName } from './keyboard.js';
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
const DEFAULT_RECTS = {
  landscape: { x: 0.06, y: 0.6, w: 0.88, h: 0.3 },
  portrait: { x: 0.03, y: 0.64, w: 0.94, h: 0.2 },
};
const STORAGE_KEY = 'air-piano-settings-v1';

// ---------------------------------------------------------------- settings

const defaults = {
  mode: 'touch',
  instrument: 'synth',
  octaves: matchMedia('(orientation: portrait)').matches ? 1 : 2,
  startNote: 60,
  sensitivity: 5,
  volume: 0.8,
  useThumbs: true,
  skeleton: false,
  labels: true,
  mirror: true,
  facingMode: 'user',
  rects: { ...DEFAULT_RECTS },
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...defaults, ...saved, rects: { ...DEFAULT_RECTS, ...saved.rects } };
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
const video = $('#video');

const audio = new PianoAudio();
const camera = new Camera(video);
const handDetector = new HandDetector();
const tracker = new HandTracker({ filter: { minCutoff: 2.0, beta: 0.015 } });
const detector = new PressDetector({
  mode: settings.mode,
  sensitivity: settings.sensitivity,
  useThumbs: settings.useThumbs,
});
let keyboard = new Keyboard({ startNote: settings.startNote, octaves: settings.octaves });

const view = { w: 0, h: 0, dpr: 1, orientation: 'landscape' };
let hands = [];
let cameraOn = false;
let trackingOn = false;
let editing = false;
let lastVideoTime = -1;
let lastHandsSeen = 0;
let fps = 0;
let statusOverride = '';
const ripples = []; // visual feedback for note-ons
const pointerNotes = new Map(); // pointerId -> note (playing by touching the screen)
const sourceNotes = new Map(); // source id -> { note, color }

// ---------------------------------------------------------------- geometry

function resize() {
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.w = window.innerWidth;
  view.h = window.innerHeight;
  view.orientation = view.w >= view.h ? 'landscape' : 'portrait';
  canvas.width = Math.round(view.w * view.dpr);
  canvas.height = Math.round(view.h * view.dpr);
  layoutKeyboard();
}

function currentRect() {
  return settings.rects[view.orientation] ?? DEFAULT_RECTS[view.orientation];
}

function layoutKeyboard() {
  const r = currentRect();
  keyboard.layout({ x: r.x * view.w, y: r.y * view.h, w: r.w * view.w, h: r.h * view.h });
}

function rebuildKeyboard() {
  applyEvents(detector.releaseAll());
  keyboard = new Keyboard({ startNote: settings.startNote, octaves: settings.octaves });
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
  applyEvents(detector.update(hands, keyboard, now / 1000));
}

let lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = now - lastFrame;
  lastFrame = now;
  if (dt > 0) fps += (1000 / dt - fps) * 0.05;
  processVideoFrame(now);
  draw(now);
  updateStatus(now);
}

function updateStatus(now) {
  let text = statusOverride;
  if (!text && editing) text = 'Drag to move the keyboard, drag the corner to resize';
  else if (!text && trackingOn && now - lastHandsSeen > 1500) text = 'Show your hands to the camera';
  if ($('#status').textContent !== text) $('#status').textContent = text;
}

// ---------------------------------------------------------------- drawing

function draw(now) {
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
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0, w, h);
  }

  drawKeyboard(now);
  drawHands();
  drawRipples(now);
  if (editing) drawEditHandles();
}

function roundRectPath(x, y, rw, rh, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, rw, rh, r);
  else ctx.rect(x, y, rw, rh);
}

function drawKeyboard() {
  const pressed = pressedKeys();
  const r = keyboard.rect;
  const radius = Math.min(8, keyboard.whiteKeyWidth * 0.15);

  // Hover zone for tap mode: fingers above the keys can still play them.
  if (settings.mode === 'tap') {
    const g = ctx.createLinearGradient(0, r.y - r.h, 0, r.y);
    g.addColorStop(0, 'rgba(255,179,71,0)');
    g.addColorStop(1, 'rgba(255,179,71,0.12)');
    ctx.fillStyle = g;
    ctx.fillRect(r.x, r.y - r.h, r.w, r.h);
  }

  for (const k of keyboard.whiteKeys) {
    const color = pressed.get(k.note);
    roundRectPath(k.x + 1, k.y, k.w - 2, k.h, [0, 0, radius, radius]);
    ctx.fillStyle = color ? withAlpha(color, 0.85) : 'rgba(255,255,255,0.42)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  for (const k of keyboard.blackKeys) {
    const color = pressed.get(k.note);
    roundRectPath(k.x, k.y, k.w, k.h, [0, 0, radius * 0.6, radius * 0.6]);
    ctx.fillStyle = color ? withAlpha(color, 0.95) : 'rgba(15,15,18,0.78)';
    ctx.fill();
  }

  if (settings.labels) {
    const fontSize = Math.max(9, Math.min(15, keyboard.whiteKeyWidth * 0.32));
    ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const k of keyboard.whiteKeys) {
      const name = noteName(k.note);
      ctx.fillStyle = pressed.has(k.note) ? 'rgba(0,0,0,0.85)' : 'rgba(0,0,0,0.6)';
      ctx.fillText(k.note % 12 === 0 ? name : name.replace(/\d+$/, ''), k.x + k.w / 2, k.y + k.h - 6);
    }
  }

  // The "surface" line: crossing it presses keys in touch mode.
  ctx.strokeStyle = settings.mode === 'touch' ? 'rgba(255,179,71,0.95)' : 'rgba(255,255,255,0.5)';
  ctx.lineWidth = settings.mode === 'touch' ? 3 : 1.5;
  ctx.beginPath();
  ctx.moveTo(r.x, r.y);
  ctx.lineTo(r.x + r.w, r.y);
  ctx.stroke();
}

function drawHands() {
  const active = new Set(detector.activeFingers.map((s) => s.id));
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
      const on = active.has(`${hand.id}:${f}`);
      const radius = on ? 11 : 7;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = on ? FINGER_COLORS[f] : withAlpha(FINGER_COLORS[f], 0.35);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = on ? '#fff' : FINGER_COLORS[f];
      ctx.stroke();
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
    ctx.arc(rp.x, rp.y, 10 + age * 30, 0, Math.PI * 2);
    ctx.strokeStyle = withAlpha(rp.color, 1 - age);
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.font = '700 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = withAlpha('#ffffff', 1 - age);
    ctx.fillText(noteName(rp.note), rp.x, rp.y - 16 - age * 20);
  }
}

const HANDLE = 26;
function handleRect() {
  const r = keyboard.rect;
  return { x: r.x + r.w - HANDLE / 2, y: r.y + r.h - HANDLE / 2, w: HANDLE, h: HANDLE };
}

function drawEditHandles() {
  const r = keyboard.rect;
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = '#ffb347';
  ctx.lineWidth = 2;
  ctx.strokeRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8);
  ctx.setLineDash([]);
  const hr = handleRect();
  ctx.beginPath();
  ctx.arc(hr.x + HANDLE / 2, hr.y + HANDLE / 2, HANDLE / 2, 0, Math.PI * 2);
  ctx.fillStyle = '#ffb347';
  ctx.fill();
  ctx.strokeStyle = '#1d1406';
  ctx.stroke();
}

function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------------------------------------------------------------- pointer input

let drag = null;

canvas.addEventListener('pointerdown', (e) => {
  const x = e.clientX;
  const y = e.clientY;
  if (editing) {
    const hr = handleRect();
    const onHandle = x >= hr.x - 10 && x <= hr.x + hr.w + 10 && y >= hr.y - 10 && y <= hr.y + hr.h + 10;
    if (onHandle || keyboard.contains(x, y)) {
      drag = { id: e.pointerId, kind: onHandle ? 'resize' : 'move', x, y, rect: { ...currentRect() } };
      canvas.setPointerCapture(e.pointerId);
    }
    return;
  }
  const key = keyboard.hitTest(x, y);
  if (!key) return;
  canvas.setPointerCapture(e.pointerId);
  audio.start().catch(() => {});
  pointerNotes.set(e.pointerId, key.note);
  applyEvents([{ type: 'on', id: `p${e.pointerId}`, note: key.note, velocity: 0.7, finger: -1, x, y }]);
});

canvas.addEventListener('pointermove', (e) => {
  const x = e.clientX;
  const y = e.clientY;
  if (drag && drag.id === e.pointerId) {
    const dx = (x - drag.x) / view.w;
    const dy = (y - drag.y) / view.h;
    const r = { ...drag.rect };
    if (drag.kind === 'move') {
      r.x = Math.min(1 - r.w, Math.max(0, r.x + dx));
      r.y = Math.min(1 - r.h, Math.max(0, r.y + dy));
    } else {
      r.w = Math.min(1 - r.x, Math.max(0.15, r.w + dx));
      r.h = Math.min(1 - r.y, Math.max(0.08, r.h + dy));
    }
    settings.rects = { ...settings.rects, [view.orientation]: r };
    layoutKeyboard();
    return;
  }
  if (!pointerNotes.has(e.pointerId)) return;
  const key = keyboard.hitTest(x, y);
  const current = pointerNotes.get(e.pointerId);
  if (key && key.note !== current) {
    const id = `p${e.pointerId}`;
    applyEvents([
      { type: 'off', id, note: current, finger: -1, x, y },
      { type: 'on', id, note: key.note, velocity: 0.7, finger: -1, x, y },
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

function setPressed(btn, on) {
  btn.setAttribute('aria-pressed', String(on));
}

$('#btn-sustain').addEventListener('click', (e) => {
  audio.setSustain(!audio.sustain);
  setPressed(e.currentTarget, audio.sustain);
});

$('#btn-edit').addEventListener('click', (e) => {
  editing = !editing;
  setPressed(e.currentTarget, editing);
  if (editing) applyEvents(detector.releaseAll());
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
$('#btn-settings').addEventListener('click', () => toggleSettings($('#settings').hidden));
$('#btn-close-settings').addEventListener('click', () => toggleSettings(false));

function syncForm() {
  document.querySelectorAll('input[name="mode"]').forEach((el) => { el.checked = el.value === settings.mode; });
  document.querySelectorAll('[data-mode-hint]').forEach((el) => { el.hidden = el.dataset.modeHint !== settings.mode; });
  $('#set-instrument').value = settings.instrument;
  $('#set-octaves').value = String(settings.octaves);
  $('#set-start').value = String(settings.startNote);
  $('#set-sensitivity').value = String(settings.sensitivity);
  $('#out-sensitivity').textContent = settings.sensitivity;
  $('#set-volume').value = String(settings.volume);
  $('#set-thumbs').checked = settings.useThumbs;
  $('#set-skeleton').checked = settings.skeleton;
  $('#set-labels').checked = settings.labels;
  $('#set-mirror').checked = settings.mirror;
}

document.querySelectorAll('input[name="mode"]').forEach((el) => el.addEventListener('change', () => {
  settings.mode = el.value;
  applyEvents(detector.setMode(settings.mode));
  syncForm();
  saveSettings();
}));

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

$('#btn-reset-keyboard').addEventListener('click', () => {
  settings.rects = { ...settings.rects, [view.orientation]: { ...DEFAULT_RECTS[view.orientation] } };
  layoutKeyboard();
  saveSettings();
});

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

// ---------------------------------------------------------------- startup

let wakeLock = null;
async function keepScreenOn() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
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
