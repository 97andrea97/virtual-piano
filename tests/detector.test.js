import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keyboard } from '../js/keyboard.js';
import { PressDetector } from '../js/detector.js';
import { makeHand } from './helpers.js';

// 2 octaves, 15 white keys of 60px, keyboard from y=500 to y=700.
const kb = () => new Keyboard({ startNote: 60, octaves: 2 }).layout({ x: 50, y: 500, w: 900, h: 200 });
const FRAME = 1 / 30;

function run(det, keyboard, frames) {
  const events = [];
  frames.forEach((hands, i) => events.push(...det.update(hands, keyboard, i * FRAME)));
  return events;
}

// The index fingertip is at x = handX - 30.
function indexAt(tipY, handX = 300) {
  return { id: 1, points: makeHand({ x: handX, y: 300, tipY: [100, tipY, 100, 100, 100] }) };
}

test('touch: lowering a fingertip into the keyboard plays the key under it', () => {
  const det = new PressDetector({ mode: 'touch' });
  const keyboard = kb();
  const events = run(det, keyboard, [400, 450, 520, 560, 470].map((y) => [indexAt(y)]));
  assert.deepEqual(events.map((e) => e.type), ['on', 'off']);
  assert.equal(events[0].note, keyboard.hitTest(270, 560).note);
  assert.equal(events[0].note, 65, 'x=270 is the 4th white key (F4)');
  assert.ok(events[0].velocity > 0.3);
});

test('touch: a finger hovering just at the edge does not flicker', () => {
  const det = new PressDetector({ mode: 'touch' });
  const ys = [400, 505, 498, 506, 499, 504, 497];
  const events = run(det, kb(), ys.map((y) => [indexAt(y)]));
  assert.equal(events.length, 0);
});

test('touch: sliding sideways moves to the next key once clearly inside it', () => {
  const det = new PressDetector({ mode: 'touch' });
  const keyboard = kb();
  // Index tip x = handX - 30. White key F4 spans 230..290, G4 290..350.
  const frames = [[indexAt(400, 300)], [indexAt(650, 300)], [indexAt(650, 322)], [indexAt(650, 345)]];
  const events = run(det, keyboard, frames);
  assert.deepEqual(events.map((e) => [e.type, e.note]), [['on', 65], ['off', 65], ['on', 67]]);
});

test('touch: a hand that appears already inside the keyboard does not play until lifted', () => {
  const det = new PressDetector({ mode: 'touch' });
  const events = run(det, kb(), [600, 600, 450, 600].map((y) => [indexAt(y)]));
  assert.deepEqual(events.map((e) => e.type), ['on']);
});

test('touch: losing the hand releases its notes after a grace period', () => {
  const det = new PressDetector({ mode: 'touch', lostGrace: 0.1 });
  const keyboard = kb();
  const events = [];
  events.push(...det.update([indexAt(400)], keyboard, 0));
  events.push(...det.update([indexAt(600)], keyboard, 0.03));
  events.push(...det.update([], keyboard, 0.06));
  assert.deepEqual(events.map((e) => e.type), ['on'], 'a short dropout keeps the note');
  events.push(...det.update([], keyboard, 0.2));
  assert.deepEqual(events.map((e) => e.type), ['on', 'off']);
});

function tapHand(handY, bendIndex = 0, handX = 300) {
  return { id: 1, points: makeHand({ x: handX, y: handY, bend: [0, bendIndex, 0, 0, 0] }) };
}

test('tap: bending a finger quickly plays a note, straightening releases it', () => {
  const det = new PressDetector({ mode: 'tap' });
  const keyboard = kb();
  // Hand above the keyboard: fingertips around y = 520 (inside the top of the keyboard).
  const bends = [0, 0, 0, 0.15, 0.35, 0.45, 0.45, 0.2, 0, 0];
  const events = run(det, keyboard, bends.map((b) => [tapHand(600, b)]));
  assert.deepEqual(events.map((e) => e.type), ['on', 'off']);
  assert.equal(events[0].finger, 1);
});

test('tap: moving the whole hand down does not play', () => {
  const det = new PressDetector({ mode: 'tap' });
  const ys = [560, 580, 610, 640, 670, 690, 700];
  const events = run(det, kb(), ys.map((y) => [tapHand(y, 0)]));
  assert.equal(events.length, 0);
});

test('tap: slowly curling a finger does not play', () => {
  const det = new PressDetector({ mode: 'tap' });
  const frames = [];
  for (let i = 0; i < 90; i++) frames.push([tapHand(600, i / 200)]);
  const events = run(det, kb(), frames);
  assert.equal(events.length, 0);
});

test('lower sensitivity needs a bigger movement', () => {
  const bends = [0, 0, 0, 0.12, 0.2, 0.2, 0];
  const strict = run(new PressDetector({ mode: 'tap', sensitivity: 1 }), kb(), bends.map((b) => [tapHand(600, b)]));
  const loose = run(new PressDetector({ mode: 'tap', sensitivity: 9 }), kb(), bends.map((b) => [tapHand(600, b)]));
  assert.equal(strict.length, 0);
  assert.ok(loose.length >= 1);
});

test('releaseAll turns off every held note', () => {
  const det = new PressDetector({ mode: 'touch' });
  run(det, kb(), [[indexAt(400)], [indexAt(600)]]);
  const off = det.releaseAll();
  assert.deepEqual(off.map((e) => e.type), ['off']);
});
