// blitzRoundBreak.test.js — the break between Category Blitz rounds scales with the room. Oct22 (Andy, with the round-break
// showcase): "S1 — 8s + 1.5s per player, max 18s". Solo stays 5 s.
const test = require('node:test');
const assert = require('node:assert/strict');
const { intermissionMs } = require('./categoryBlitzLogic');

test('solo keeps 5 s', () => {
  assert.equal(intermissionMs(1), 5000);
  assert.equal(intermissionMs(0), 5000);
  assert.equal(intermissionMs(undefined), 5000);
});

test('8 s + 1.5 s per player', () => {
  assert.equal(intermissionMs(2), 11000);
  assert.equal(intermissionMs(3), 12500);
  assert.equal(intermissionMs(4), 14000);
  assert.equal(intermissionMs(6), 17000);
});

test('capped at 18 s for a big room', () => {
  assert.equal(intermissionMs(7), 18000);
  assert.equal(intermissionMs(8), 18000);
  assert.equal(intermissionMs(50), 18000);
});
