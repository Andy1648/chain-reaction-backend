// blitzRoundBreak.test.js — the break between Category Blitz rounds scales with the room (Andy oct19: "maybe add a second
// for every person … so people can read each others"). 4 s + 1 s per player, max 10 s; solo stays 5 s.
const test = require('node:test');
const assert = require('node:assert/strict');
const { intermissionMs } = require('./categoryBlitzLogic');

test('solo keeps the old 5 s', () => {
  assert.equal(intermissionMs(1), 5000);
  assert.equal(intermissionMs(0), 5000);
  assert.equal(intermissionMs(undefined), 5000);
});

test('4 s + 1 s per player', () => {
  assert.equal(intermissionMs(2), 6000);
  assert.equal(intermissionMs(4), 8000);
  assert.equal(intermissionMs(6), 10000);
});

test('capped at 10 s for a big room', () => {
  assert.equal(intermissionMs(8), 10000);
  assert.equal(intermissionMs(50), 10000);
});
