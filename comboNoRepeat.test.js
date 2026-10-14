'use strict';
// Andy oct14: a Word Bomb game never shows the same combo twice (it was 44% of 30-turn games).
const test = require('node:test');
const assert = require('node:assert');
const logic = require('./gameLogic');

test('300-combo game: every combo is new', () => {
  for (let g = 0; g < 50; g++) {
    const game = logic.createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 'medium');
    const seen = [game.currentCombo];
    for (let t = 1; t < 300; t++) {
      game.currentCombo = logic.nextCombo(game, t);
      seen.push(game.currentCombo);
    }
    assert.strictEqual(new Set(seen).size, seen.length);
  }
});

test('pool exhausted: falls back to "not the current one" instead of failing', () => {
  const used = new Set(logic.COMBOS || []);
  if (!used.size) return;
  const c = logic.pickRandomCombo('ing', 0, used);
  assert.ok(c && c !== 'ing');
});

test('pickRandomCombo without a used set behaves as before', () => {
  for (let i = 0; i < 200; i++) assert.notStrictEqual(logic.pickRandomCombo('ing', 5), 'ing');
});
