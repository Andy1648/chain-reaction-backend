// gameLogic.validation.test.js
// Run with: node --test gameLogic.validation.test.js
//
// Additive coverage for Word Bomb word-validation and turn-order helpers that
// run on EVERY submission but were not directly asserted by gameLogic.test.js /
// tests/gameLogic.edge.test.js:
//   - submitWord's MAX_WORD_LENGTH ("too_long") guard, including the exact
//     accept/reject boundary. This guard exists to stop a multi-KB blob from
//     failing the dictionary call OPEN and lodging in usedWords, so the boundary
//     is worth pinning down.
//   - getCurrentPlayerId / getActivePlayers as pure helpers in isolation.
//
// Uses the injected-dictionary hook (no network) and restores the standard mock
// afterwards so state doesn't bleed into other files sharing this process.

const test = require('node:test');
const assert = require('node:assert/strict');

const gameLogic = require('./gameLogic');
const mockDictionary = require('./dictionary.mock');
const { createGame, submitWord, getCurrentPlayerId, getActivePlayers } = gameLogic;

// MAX_WORD_LENGTH is a private constant in gameLogic (45); mirror it here so the
// boundary assertions read clearly. If the source cap ever changes these tests
// fail loudly, which is the intent.
const MAX_WORD_LENGTH = 45;

function withDict(isValidWord, fn) {
  gameLogic._setDictionaryForTesting({ isValidWord });
  return Promise.resolve()
    .then(fn)
    .finally(() => gameLogic._setDictionaryForTesting(mockDictionary));
}

test('submitWord rejects a word longer than MAX_WORD_LENGTH as too_long, before the dictionary and with no side effects', async () => {
  const game = createGame([{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }], 'chill');
  game.currentCombo = 'gar';

  await withDict(
    // Would accept anything - proving the reject happens on length, BEFORE this.
    async () => {
      throw new Error('dictionary must not be consulted for an over-long word');
    },
    async () => {
      const tooLong = 'gar' + 'a'.repeat(MAX_WORD_LENGTH); // 48 chars, contains the combo
      const res = await submitWord(game, tooLong);

      assert.equal(res.accepted, false);
      assert.equal(res.reason, 'too_long');
      // Nothing mutated: no word recorded, turn not advanced, no life lost.
      assert.equal(game.usedWords.size, 0);
      assert.equal(game.completedTurnCount, 0);
      assert.equal(game.currentPlayerIndex, 0);
      assert.equal(game.players[0].lives, game.maxLives);
    }
  );
});

test('submitWord accepts a word of exactly MAX_WORD_LENGTH (the boundary is inclusive)', async () => {
  const game = createGame([{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }], 'chill');
  game.currentCombo = 'gar';

  await withDict(async () => true, async () => {
    const exact = 'gar' + 'a'.repeat(MAX_WORD_LENGTH - 3); // exactly 45 chars, contains combo
    assert.equal(exact.length, MAX_WORD_LENGTH);
    const res = await submitWord(game, exact);

    assert.equal(res.accepted, true, 'a 45-char word is at the limit, not over it');
    assert.equal(game.usedWords.has(exact), true);
    assert.equal(game.completedTurnCount, 1);
  });
});

test('getCurrentPlayerId maps currentPlayerIndex through turnOrder', () => {
  const game = createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], 'chill');
  assert.equal(getCurrentPlayerId(game), 'a'); // index 0
  game.currentPlayerIndex = 2;
  assert.equal(getCurrentPlayerId(game), 'c');
});

test('getActivePlayers excludes eliminated players and nothing else', () => {
  const game = createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], 'chill');
  assert.equal(getActivePlayers(game).length, 3);

  game.players.find((p) => p.id === 'b').eliminated = true;
  const active = getActivePlayers(game);
  assert.deepEqual(active.map((p) => p.id), ['a', 'c']);
});
