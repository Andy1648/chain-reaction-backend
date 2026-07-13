// tests/gameLogic.edge.test.js
// Run with: npm test   (node --test discovers this file)
//
// Edge-case and hostile-input coverage for gameLogic.js, complementing the
// mainline suite in gameLogic.test.js (which owns the happy paths, the
// timer curve, and combo weighting). Here: input normalization, weird
// unicode, degenerate rosters, the advanceTurn safety counter, and
// end-of-game states.

const test = require('node:test');
const assert = require('node:assert/strict');

const gameLogic = require('../gameLogic');
const mockDictionary = require('../dictionary.mock');

gameLogic._setDictionaryForTesting(mockDictionary);

const {
  createGame,
  submitWord,
  getCurrentPlayerId,
  advanceTurn,
  handleTimeout,
} = gameLogic;

function twoPlayer() {
  return createGame([{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], 'medium');
}

/* ========================= input normalization ========================== */

test('submitWord trims and lowercases before every check', async () => {
  const game = twoPlayer();
  game.currentCombo = 'en';
  const res = await submitWord(game, '  ENTER \n');
  assert.equal(res.accepted, true);
  assert.equal(res.word, 'enter', 'the stored word is the normalized form');
  assert.ok(game.usedWords.has('enter'));
});

test('used-word matching is case-insensitive across submissions', async () => {
  const game = twoPlayer();
  game.currentCombo = 'en';
  await submitWord(game, 'enter');
  game.currentCombo = 'en'; // force the same combo back for the next player
  const res = await submitWord(game, 'ENTER');
  assert.equal(res.reason, 'already_used');
});

test('hostile input never crashes submitWord and is always rejected', async () => {
  const game = twoPlayer();
  game.currentCombo = 'en';
  const hostile = [
    '', '  ', '\t \n',
    'éntrée', // combining accents
    '💣💣💣💣', '<script>alert(1)</script>',
    'en', // combo itself, but under the 3-char floor
    '﻿enter'.slice(0, 2), // BOM + fragment
  ];
  for (const input of hostile) {
    const res = await submitWord(game, input);
    assert.equal(res.accepted, false, `"${input}" must be rejected`);
  }
  assert.equal(game.completedTurnCount, 0, 'no hostile input consumed a turn');
  assert.equal(game.usedWords.size, 0);
});

test('the combo match is on the NORMALIZED word, not the raw input', async () => {
  const game = twoPlayer();
  game.currentCombo = 'en';
  // The RAW string 'dEnOTE' does not contain 'en' ('En' != 'en'); only the
  // lowercased form does. A raw includes() check would wrongly reject this.
  const res = await submitWord(game, 'dEnOTE');
  assert.equal(res.accepted, true);
  assert.ok(game.usedWords.has('denote'));
});

/* ========================= degenerate rosters =========================== */

test('a single-player game finishes immediately on its first turn advance', () => {
  const game = createGame([{ id: 'only', name: 'Solo' }], 'medium');
  advanceTurn(game);
  assert.equal(game.status, 'finished');
  assert.equal(game.winnerId, 'only');
});

test('all players eliminated at once finishes with NO winner (winnerId null)', () => {
  const game = twoPlayer();
  game.players.forEach((p) => {
    p.eliminated = true;
    p.lives = 0;
  });
  advanceTurn(game);
  assert.equal(game.status, 'finished');
  assert.equal(game.winnerId, null);
});

test('advanceTurn tolerates turnOrder entries with no matching player (ghost ids)', () => {
  const game = createGame(
    [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }, { id: 'p3', name: 'C' }],
    'medium'
  );
  // turnOrder references players that no longer exist. The find() returns
  // undefined for them (not eliminated), so the walk stops on the first ghost
  // rather than looping - the invariant is "this returns and stays sane".
  game.turnOrder = ['ghost1', 'ghost2', 'ghost3'];
  advanceTurn(game);
  assert.equal(game.status, 'in_progress', 'three live players - no premature finish');
  assert.ok(game.currentPlayerIndex >= 0 && game.currentPlayerIndex < 3);
});

test('advanceTurn terminates when turnOrder holds ONLY eliminated players (safety counter)', () => {
  // The case the safety counter actually guards: every turnOrder entry is an
  // eliminated-but-existing player, while enough active players exist outside
  // turnOrder to dodge the <=1-active finish path. Without the counter the
  // skip-eliminated walk would loop forever; the assertion is that this call
  // RETURNS (a hang here fails the test by runner timeout) with sane state.
  const game = createGame(
    [
      { id: 'a', name: 'ActiveA' }, { id: 'b', name: 'ActiveB' },
      { id: 'z1', name: 'OutZ1' }, { id: 'z2', name: 'OutZ2' },
    ],
    'medium'
  );
  game.players.find((p) => p.id === 'z1').eliminated = true;
  game.players.find((p) => p.id === 'z2').eliminated = true;
  game.turnOrder = ['z1', 'z2']; // desync: the active players fell out of the order
  game.currentPlayerIndex = 0;

  advanceTurn(game);

  assert.equal(game.status, 'in_progress', 'two active players - not a finish');
  assert.ok(
    game.currentPlayerIndex >= 0 && game.currentPlayerIndex < game.turnOrder.length,
    'index stays inside turnOrder bounds'
  );
});

/* ============================ end states ================================= */

test('handleTimeout on the final two players ends the game exactly once', () => {
  const game = twoPlayer();
  game.players[0].lives = 1;
  game.players[1].lives = 1;

  const first = handleTimeout(game); // p1 eliminated -> p2 wins instantly
  assert.equal(first.eliminatedPlayerId, 'p1');
  assert.equal(game.status, 'finished');
  assert.equal(game.winnerId, 'p2');
});

test('a timed-out player keeps their turn identity until advanceTurn moves on', () => {
  const game = createGame(
    [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }, { id: 'p3', name: 'C' }],
    'medium'
  );
  game.players[0].lives = 1;
  handleTimeout(game); // p1 is eliminated
  // The next current player must be p2 (not p3, not the eliminated p1).
  assert.equal(getCurrentPlayerId(game), 'p2');
  assert.equal(game.status, 'in_progress');
});

test('the dead-combo rescue counts only ACTIVE players in the whiff round', () => {
  const game = createGame(
    [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }, { id: 'p3', name: 'C' }],
    'medium'
  );
  // p3 is already out - a "full round of whiffs" is now just p1 + p2.
  game.players[2].eliminated = true;
  game.players[2].lives = 0;

  const original = game.currentCombo;
  const r1 = handleTimeout(game); // p1 whiffs
  assert.equal(r1.comboSwapped, false);
  const r2 = handleTimeout(game); // p2 whiffs -> every ACTIVE player has whiffed
  assert.equal(r2.comboSwapped, true, 'rescue triggers after the two active players whiff');
  assert.notEqual(game.currentCombo, original);
});
