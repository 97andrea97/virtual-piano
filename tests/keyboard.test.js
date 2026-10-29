import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keyboard, isBlack, noteName, midiToFrequency } from '../js/keyboard.js';

test('note helpers', () => {
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(61), 'C#4');
  assert.equal(noteName(21), 'A0');
  assert.ok(isBlack(61) && isBlack(70) && !isBlack(64) && !isBlack(65));
  assert.equal(midiToFrequency(69), 440);
});

test('two octaves have 15 white keys and 10 black keys', () => {
  const kb = new Keyboard({ startNote: 60, octaves: 2 }).layout({ x: 0, y: 0, w: 1500, h: 300 });
  assert.equal(kb.whiteKeys.length, 15);
  assert.equal(kb.blackKeys.length, 10);
  assert.equal(kb.whiteKeyWidth, 100);
  assert.equal(kb.endNote, 84);
});

test('hit test picks black keys in the upper part and white keys below', () => {
  const kb = new Keyboard({ startNote: 60, octaves: 1 }).layout({ x: 100, y: 200, w: 800, h: 200 });
  // 8 white keys of 100px. C#4 is centered on x = 200 (boundary between C and D).
  assert.equal(kb.hitTest(200, 230).note, 61);
  assert.equal(kb.hitTest(199, 380).note, 60, 'below the black key, left of the boundary is C');
  assert.equal(kb.hitTest(150, 230).note, 60);
  assert.equal(kb.hitTest(250, 380).note, 62);
  // E-F boundary has no black key.
  assert.equal(kb.hitTest(399, 230).note, 64);
  assert.equal(kb.hitTest(401, 230).note, 65);
  // Last key is the top C.
  assert.equal(kb.hitTest(899, 300).note, 72);
  assert.equal(kb.hitTest(50, 300), null);
  assert.equal(kb.hitTest(500, 199), null);
});
