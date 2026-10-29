import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keyboard } from '../js/keyboard.js';
import { PressDetector } from '../js/detector.js';
import { makeHand } from './helpers.js';

// 2 octaves, 15 white keys of 60px from x=50, keyboard from y=400 (back) to y=700 (front).
// Black keys cover the back 62% (y < 586).
const kb = () => new Keyboard({ startNote: 60, octaves: 2 }).place({ cx: 500, fy: 700, width: 900, depth: 300, tilt: 0 });
const FRAME = 1 / 30;

/** Runs frames of hands; returns note events (and the ignored ones separately). */
function run(det, frames, keyboard = kb()) {
  const events = [];
  frames.forEach((hands, i) => events.push(...det.update(hands, keyboard, i * FRAME)));
  const notes = events.filter((e) => e.type !== 'ignored');
  notes.ignored = events.filter((e) => e.type === 'ignored');
  return notes;
}

// Hand of size 100 (hand scale 80px). Fingertips rest around y = 540, inside
// the keyboard. `bend` moves a fingertip down by bend * 80px (= bend hand sizes).
// Fingertip x positions: index x-30, middle x, ring x+25, pinky x+48.
function hand({ x = 300, y = 600, bend = [0, 0, 0, 0, 0], id = 1 } = {}) {
  return { id, points: makeHand({ x, y, bend }) };
}
const indexBend = (b, opts) => hand({ ...opts, bend: [0, b, 0, 0, 0] });
const types = (events) => events.map((e) => e.type);

test('fingers resting on the keys do not play', () => {
  const frames = Array.from({ length: 60 }, () => [hand()]);
  assert.equal(run(new PressDetector(), frames).length, 0);
});

test('a quick keystroke plays the key under the finger; lifting releases it', () => {
  const bends = [0, 0, 0, 0.1, 0.2, 0.24, 0.24, 0.24, 0.15, 0.05, 0];
  const events = run(new PressDetector(), bends.map((b) => [indexBend(b)]));
  assert.deepEqual(types(events), ['on', 'off']);
  assert.equal(events[0].finger, 1);
  assert.equal(events[0].note, 65, 'x=270 is the 4th white key (F4)');
  assert.ok(events[0].velocity >= 0.3 && events[0].velocity <= 1);
});

test('the note plays when the finger lands, not while it is still moving down', () => {
  const det = new PressDetector();
  const keyboard = kb();
  const bends = [0, 0, 0.05, 0.1, 0.15];
  bends.forEach((b, i) => assert.equal(det.update([indexBend(b)], keyboard, i * FRAME).length, 0, `frame ${i}`));
  const landed = det.update([indexBend(0.155)], keyboard, bends.length * FRAME);
  assert.deepEqual(types(landed), ['on']);
});

test('holding the finger down keeps the note on', () => {
  const bends = [0, 0, 0.15, 0.25, ...Array(40).fill(0.25)];
  assert.deepEqual(types(run(new PressDetector(), bends.map((b) => [indexBend(b)]))), ['on']);
});

test('moving the whole hand down or sideways does not play', () => {
  const frames = [];
  for (let i = 0; i < 20; i++) frames.push([hand({ x: 300 + i * 6, y: 560 + i * 4 })]);
  assert.equal(run(new PressDetector(), frames).length, 0);
});

test('tilting the whole hand (all fingers drop together) does not play', () => {
  const bends = [0, 0, 0.1, 0.2, 0.3, 0.35, 0.35];
  const frames = bends.map((b) => [hand({ bend: [b, b, b, b, b] })]);
  assert.equal(run(new PressDetector(), frames).length, 0);
});

test('slowly curling a finger does not play', () => {
  const frames = Array.from({ length: 90 }, (_, i) => [indexBend(i / 250)]);
  assert.equal(run(new PressDetector(), frames).length, 0);
});

test('a neighbour finger dragged along by a press does not play', () => {
  const index = [0, 0, 0.1, 0.22, 0.25, 0.25];
  const middle = [0, 0, 0.05, 0.1, 0.11, 0.11];
  const frames = index.map((b, i) => [hand({ bend: [0, b, middle[i], 0, 0] })]);
  const events = run(new PressDetector(), frames);
  assert.deepEqual(events.map((e) => [e.type, e.finger]), [['on', 1]]);
});

test('a neighbour that moves a little just after a press does not play', () => {
  const index = [0, 0, 0.1, 0.22, 0.25, 0.25, 0.25, 0.25, 0.25];
  const middle = [0, 0, 0, 0, 0, 0.06, 0.12, 0.13, 0.13];
  const frames = index.map((b, i) => [hand({ bend: [0, b, middle[i], 0, 0] })]);
  const events = run(new PressDetector(), frames);
  assert.deepEqual(events.map((e) => [e.type, e.finger]), [['on', 1]]);
  assert.ok(events.ignored.some((e) => e.reason === 'neighbour' && e.finger === 2));
});

test('two fingers pressed together with similar strength play a chord', () => {
  const bends = [0, 0, 0.12, 0.22, 0.25, 0.25];
  const frames = bends.map((b) => [hand({ bend: [0, b, 0, b * 0.9, 0] })]);
  const events = run(new PressDetector(), frames);
  assert.deepEqual(types(events), ['on', 'on']);
  assert.notEqual(events[0].note, events[1].note);
});

test('the key aimed at before the stroke plays, not the one the tip ends on', () => {
  // Index tip at x=110, on the C#4 black key (back part). The stroke moves the
  // tip down on screen into the white-key area (front part), which is D4.
  const bends = [0, 0, 0, 0.2, 0.5, 0.6, 0.6];
  const events = run(new PressDetector(), bends.map((b) => [indexBend(b, { x: 140 })]));
  assert.deepEqual(events.map((e) => [e.type, e.note]), [['on', 61]]);
});

test('a fingertip wobbling on a key border keeps its key', () => {
  // Index tip around x=230, the E4/F4 border; it starts slightly on E4.
  const xs = [258, 262, 257, 263, 259, 262];
  const frames = xs.map((x) => [indexBend(0, { x })]);
  frames.push(...[0.1, 0.22, 0.25, 0.25].map((b) => [indexBend(b, { x: 261 })]));
  const events = run(new PressDetector(), frames);
  assert.deepEqual(events.map((e) => [e.type, e.note]), [['on', 64]]);
});

test('a finger sliding sideways across the keys does not play', () => {
  const steps = [[0, 0], [0, 0], [0.1, 30], [0.2, 60], [0.25, 90], [0.25, 90]];
  const frames = steps.map(([b, dx]) => {
    const h = indexBend(b);
    h.points[8] = { ...h.points[8], x: h.points[8].x + dx }; // only the fingertip slides
    return [h];
  });
  const events = run(new PressDetector(), frames);
  assert.equal(events.length, 0);
  assert.ok(events.ignored.some((e) => e.reason === 'slid'));
});

test('a small bounce after releasing does not retrigger, a new stroke does', () => {
  const press = [0, 0, 0.15, 0.25, 0.25];
  const release = [0.18, 0.1, 0.05];
  const bounce = [0.06, 0.08, 0.05, 0.03, 0.01, 0, 0, 0];
  const again = [0, 0.15, 0.25, 0.25];
  const bends = [...press, ...release, ...bounce, ...again];
  const events = run(new PressDetector(), bends.map((b) => [indexBend(b)]));
  assert.deepEqual(types(events), ['on', 'off', 'on']);
});

test('repeated notes with the same finger all play', () => {
  const one = [0, 0.12, 0.22, 0.24, 0.24, 0.12, 0.02, 0, 0];
  const bends = [0, 0, ...one, ...one, ...one];
  const events = run(new PressDetector(), bends.map((b) => [indexBend(b)]));
  assert.deepEqual(types(events), ['on', 'off', 'on', 'off', 'on', 'off']);
});

test('presses are ignored while the hand swings fast', () => {
  const bends = [0, 0, 0.15, 0.25, 0.25];
  const frames = bends.map((b, i) => [indexBend(b, { x: 150 + i * 40 })]);
  assert.equal(run(new PressDetector(), frames).length, 0);
});

test('no note when the finger is not over the keyboard', () => {
  const bends = [0, 0, 0.15, 0.25, 0.25];
  assert.equal(run(new PressDetector(), bends.map((b) => [indexBend(b, { y: 150 })])).length, 0);
});

test('lower sensitivity needs a bigger stroke', () => {
  const bends = [0, 0, 0.06, 0.12, 0.12];
  const strict = run(new PressDetector({ sensitivity: 1 }), bends.map((b) => [indexBend(b)]));
  const loose = run(new PressDetector({ sensitivity: 8 }), bends.map((b) => [indexBend(b)]));
  assert.equal(strict.length, 0);
  assert.equal(loose.length, 1);
});

test('losing the hand releases its notes after a grace period', () => {
  const det = new PressDetector({ lostGrace: 0.1 });
  const keyboard = kb();
  const events = [];
  [0, 0, 0.15, 0.25, 0.25].forEach((b, i) => events.push(...det.update([indexBend(b)], keyboard, i * FRAME)));
  events.push(...det.update([], keyboard, 0.2));
  assert.deepEqual(types(events), ['on'], 'a short dropout keeps the note');
  events.push(...det.update([], keyboard, 0.35));
  assert.deepEqual(types(events), ['on', 'off']);
});

test('releaseAll turns off every held note', () => {
  const det = new PressDetector();
  run(det, [0, 0, 0.15, 0.25, 0.25].map((b) => [indexBend(b)]));
  assert.deepEqual(types(det.releaseAll()), ['off']);
});
