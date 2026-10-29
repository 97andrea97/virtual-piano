import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HandTracker } from '../js/hands.js';
import { makeHand } from './helpers.js';

test('hands keep their ids when the detector swaps their order', () => {
  const tr = new HandTracker();
  const a = makeHand({ x: 200, y: 300 });
  const b = makeHand({ x: 700, y: 300 });
  const first = tr.update([{ points: a }, { points: b }], 0);
  const second = tr.update([{ points: makeHand({ x: 705, y: 302 }) }, { points: makeHand({ x: 198, y: 301 }) }], 0.033);
  assert.equal(second[0].id, first[1].id);
  assert.equal(second[1].id, first[0].id);
});

test('a hand that disappears for too long gets a new id', () => {
  const tr = new HandTracker({ timeout: 0.2 });
  const [h1] = tr.update([{ points: makeHand({ x: 200, y: 300 }) }], 0);
  tr.update([], 0.1);
  tr.update([], 0.5);
  const [h2] = tr.update([{ points: makeHand({ x: 200, y: 300 }) }], 0.6);
  assert.notEqual(h1.id, h2.id);
});
