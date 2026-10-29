import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keyboard, isBlack, noteName, midiToFrequency } from '../js/keyboard.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('note helpers', () => {
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(61), 'C#4');
  assert.equal(noteName(21), 'A0');
  assert.ok(isBlack(61) && isBlack(70) && !isBlack(64) && !isBlack(65));
  assert.equal(midiToFrequency(69), 440);
});

test('two octaves have 15 white keys and 10 black keys', () => {
  const kb = new Keyboard({ startNote: 60, octaves: 2 });
  assert.equal(kb.whiteKeys.length, 15);
  assert.equal(kb.blackKeys.length, 10);
  assert.equal(kb.endNote, 84);
});

test('without tilt the keyboard is a flat rectangle', () => {
  const kb = new Keyboard({ startNote: 60, octaves: 2 }).place({ cx: 500, fy: 700, width: 900, depth: 300, tilt: 0 });
  const [fl, fr, br, bl] = kb.outline();
  assert.deepEqual([fl.x, fl.y, fr.x, fr.y, br.x, br.y, bl.x, bl.y], [50, 700, 950, 700, 950, 400, 50, 400]);
});

test('tilted keyboard is a trapezoid: the back edge is narrower and lower on screen', () => {
  const kb = new Keyboard({ startNote: 60, octaves: 2 }).place({ cx: 500, fy: 700, width: 900, depth: 300, tilt: 1 });
  const [fl, fr, br, bl] = kb.outline();
  assert.ok(br.x - bl.x < fr.x - fl.x);
  assert.ok(fl.y - bl.y < 300 * Math.cos(1) + 1, 'apparent depth shrinks with tilt');
  // Raised things (positive h) appear higher on screen.
  assert.ok(kb.project(0.5, 0.5, 0.1).y < kb.project(0.5, 0.5, 0).y);
});

test('unproject inverts project', () => {
  for (const tilt of [0, 0.6, 1.1]) {
    const kb = new Keyboard({ startNote: 48, octaves: 3 }).place({ cx: 400, fy: 650, width: 700, depth: 320, tilt });
    for (const [u, v, h] of [[0.1, 0.2, 0], [0.7, 0.9, 0], [0.5, 0.5, 0.06], [0.95, 0.05, -0.03]]) {
      const p = kb.project(u, v, h);
      const q = kb.unproject(p.x, p.y, h);
      near(q.u, u);
      near(q.v, v);
    }
  }
});

test('hit test picks black keys at the back and white keys at the front', () => {
  // 1 octave = 8 white keys of 100px; front edge y=700, back edge y=400.
  const kb = new Keyboard({ startNote: 60, octaves: 1 }).place({ cx: 500, fy: 700, width: 800, depth: 300, tilt: 0 });
  assert.equal(kb.hitTest(200, 430).note, 61, 'C#4 sits on the C/D boundary at the back');
  assert.equal(kb.hitTest(199, 680).note, 60, 'in front of the black key, left of the boundary is C');
  assert.equal(kb.hitTest(250, 680).note, 62);
  assert.equal(kb.hitTest(399, 430).note, 64, 'E/F boundary has no black key');
  assert.equal(kb.hitTest(401, 430).note, 65);
  assert.equal(kb.hitTest(899, 600).note, 72, 'last key is the top C');
  assert.equal(kb.hitTest(50, 600), null, 'left of the keyboard');
  assert.equal(kb.hitTest(500, 380), null, 'behind the keyboard');
  assert.equal(kb.hitTest(550, 380, 0.35).note, 67, 'hovering just behind still finds the key with slack');
});
