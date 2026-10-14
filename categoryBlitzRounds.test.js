'use strict';
// Host-picked Blitz length (set_rounds): 3 / 5 / 10 rounds, never a repeated category.
const test = require('node:test');
const assert = require('node:assert');
const logic = require('./categoryBlitzLogic');

const players = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];

function playOut(game, rerollEveryRound = false) {
  const seen = [game.currentCategory];
  for (;;) {
    if (rerollEveryRound && game.rerollsRemaining > 0) {
      seen.push(logic.rerollCategory(game).category);
    }
    logic.endRound(game);
    const next = logic.startNextRound(game);
    if (!next || next.gameOver || game.status === 'finished') break;
    seen.push(next.category);
  }
  return seen;
}

test('default stays 3 rounds; off-menu values fall back to 3', () => {
  assert.strictEqual(logic.createGame(players, 'medium').rounds, 3);
  assert.strictEqual(logic.createGame(players, 'medium', false, null, null, 7).rounds, 3);
  assert.deepStrictEqual(logic.ROUND_OPTIONS, [3, 5, 10]);
});

test('daily ignores the host choice (one shared 3-round board)', () => {
  const g = logic.createGame(players, 'medium', true, null, { dayNumber: 1, dateKey: '2026-10-14' }, 10);
  assert.strictEqual(g.rounds, 3);
});

for (const n of [3, 5, 10]) {
  test(`${n} rounds: plays exactly ${n} distinct categories`, () => {
    for (let i = 0; i < 40; i++) {
      const g = logic.createGame(players, 'medium', false, null, null, n);
      const seen = playOut(g);
      assert.strictEqual(seen.length, n);
      assert.strictEqual(new Set(seen).size, n);
    }
  });
}

test('10 rounds on every single pack + max rerolls: never repeats', () => {
  for (const pack of logic.PACK_IDS) {
    for (let i = 0; i < 10; i++) {
      const g = logic.createGame(players, 'easy', false, [pack], null, 10);
      const seen = playOut(g, true);
      assert.strictEqual(new Set(seen).size, seen.length, `${pack}: ${seen.join(', ')}`);
    }
  }
});
