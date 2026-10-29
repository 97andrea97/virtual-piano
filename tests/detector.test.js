import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keyboard } from '../js/keyboard.js';
import { PressDetector } from '../js/detector.js';
import { makeHand } from './helpers.js';

// 2 octaves, 15 white keys of 60px, keyboard from y=400 (back) to y=700 (front).
const kb = () => new Keyboard({ startNote: 60, octaves: 2 }).place({ cx: 500, fy: 700, width: 900, depth: 300, tilt: 0 });
const FRAME = 1 / 30;

function run(det, frames, keyboard = kb()) {
  const events = [];
  frames.forEach((hands, i) => events.push(...det.update(hands, keyboard, i * FRAME)));
  return events;
}

// Hand of size 100 (hand scale 80px). Fingertips rest around y = 540, inside
// the keyboard. `bend` moves a fingertip down by bend * 80px (= bend hand sizes).
// The index fingertip is at x = handX - 30.
function hand({ x = 300, y = 600, bend = [0, 0, 0, 0, 0], id = 1 } = {}) {
  return { id, points: makeHand({ x, y, bend }) };
}
const indexBend = (b, opts) => hand({ ...opts, bend: [0, b, 0, 0, 0] });

test('fingers resting on the keys do not play', () => {
  const frames = Array.from({ length: 60 }, () => [hand()]);
  assert.equal(run(new PressDetector(), frames).length, 0);
});

test('a quick downward stroke of one finger plays the key under it; lifting releases it', () => {
  const bends = [0, 0, 0, 0.1, 0.22, 0.3, 0.3, 0.3, 0.2, 0.05, 0];
  const events = run(new PressDetector(), bends.map((b) => [indexBend(b)]));
  assert.deepEqual(events.map((e) => e.type), ['on', 'off']);
  assert.equal(events[0].finger, 1);
  assert.equal(events[0].note, 65, 'x=270 is the 4th white key (F4)');
  assert.ok(events[0].velocity >= 0.3 && events[0].velocity <= 1);
});

test('holding the finger down keeps the note on', () => {
  const bends = [0, 0, 0.15, 0.3, ...Array(40).fill(0.3)];
  const events = run(new PressDetector(), bends.map((b) => [indexBend(b)]));
  assert.deepEqual(events.map((e) => e.type), ['on']);
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
  const frames = Array.from({ length: 90 }, (_, i) => [indexBend(i / 200)]);
  assert.equal(run(new PressDetector(), frames).length, 0);
});

test('two fingers pressed together play a chord', () => {
  const bends = [0, 0, 0.12, 0.25, 0.3];
  const frames = bends.map((b) => [hand({ bend: [0, b, 0, b, 0] })]);
  const events = run(new PressDetector(), frames);
  assert.deepEqual(events.map((e) => e.type), ['on', 'on']);
  assert.notEqual(events[0].note, events[1].note);
});

test('a small bounce after releasing does not retrigger, a new stroke does', () => {
  const press = [0, 0, 0.15, 0.3, 0.3];
  const release = [0.22, 0.1, 0.05];
  const bounce = [0.1, 0.13, 0.08, 0.05, 0.03, 0];
  const again = [0, 0.15, 0.3];
  const bends = [...press, ...release, ...bounce, ...again];
  const events = run(new PressDetector(), bends.map((b) => [indexBend(b)]));
  assert.deepEqual(events.map((e) => e.type), ['on', 'off', 'on']);
});

test('presses are ignored while the hand swings fast', () => {
  const bends = [0, 0, 0.15, 0.3, 0.3];
  const frames = bends.map((b, i) => [indexBend(b, { x: 150 + i * 40 })]);
  assert.equal(run(new PressDetector(), frames).length, 0);
});

test('no note when the finger is not over the keyboard', () => {
  const bends = [0, 0, 0.15, 0.3];
  const events = run(new PressDetector(), bends.map((b) => [indexBend(b, { y: 150 })]));
  assert.equal(events.length, 0);
});

test('lower sensitivity needs a bigger stroke', () => {
  const bends = [0, 0, 0.1, 0.17, 0.17];
  const strict = run(new PressDetector({ sensitivity: 2 }), bends.map((b) => [indexBend(b)]));
  const loose = run(new PressDetector({ sensitivity: 8 }), bends.map((b) => [indexBend(b)]));
  assert.equal(strict.length, 0);
  assert.equal(loose.length, 1);
});

test('losing the hand releases its notes after a grace period', () => {
  const det = new PressDetector({ lostGrace: 0.1 });
  const keyboard = kb();
  const events = [];
  [0, 0, 0.15, 0.3].forEach((b, i) => events.push(...det.update([indexBend(b)], keyboard, i * FRAME)));
  events.push(...det.update([], keyboard, 0.15));
  assert.deepEqual(events.map((e) => e.type), ['on'], 'a short dropout keeps the note');
  events.push(...det.update([], keyboard, 0.3));
  assert.deepEqual(events.map((e) => e.type), ['on', 'off']);
});

test('releaseAll turns off every held note', () => {
  const det = new PressDetector();
  run(det, [0, 0, 0.15, 0.3].map((b) => [indexBend(b)]));
  assert.deepEqual(det.releaseAll().map((e) => e.type), ['off']);
});
