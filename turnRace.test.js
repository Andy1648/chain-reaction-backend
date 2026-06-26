// turnRace.test.js
// Run with: node --test turnRace.test.js   (or `node --test` for the whole suite)
//
// Regression test for the handleWordSubmission / submitWord TOCTOU turn race
// (branch fix/turn-race). submitWord awaits the dictionary lookup; in the last
// second of a turn the turn timer's handleTimeout can fire DURING that await and
// advance the turn. Before the fix, submitWord would then still record the word
// and advance again - a double-advance that skips a player and (via the caller)
// clears the next player's timer.
//
// We reproduce the race deterministically by injecting a dictionary whose
// isValidWord calls handleTimeout(game) WHILE it is being awaited - i.e. exactly
// the "timeout fires mid-lookup" interleaving - then resolves true. The fix must
// detect that the turn advanced during the await and discard the submission
// without mutating any further state.
//
// Kept in its own file (not gameLogic.test.js) so it doesn't touch that file.

const test = require('node:test');
const assert = require('node:assert/strict');

const gameLogic = require('./gameLogic');
const mockDictionary = require('./dictionary.mock');
const { createGame, submitWord, handleTimeout } = gameLogic;

// Restore the standard mock after a test that swaps in a custom dictionary, so
// state doesn't bleed into other test files sharing this process.
function restoreDict() {
  gameLogic._setDictionaryForTesting(mockDictionary);
}

test('race: a timeout firing DURING the dictionary await discards the submission (no double-advance)', async () => {
  const game = createGame([{ id: 'p1' }, { id: 'p2' }], 'easy');
  game.currentCombo = 'gar'; // 'garden' contains 'gar', so the word is otherwise valid
  const p1 = game.players.find((p) => p.id === 'p1');

  // Inject a dictionary whose lookup, while being awaited, simulates the turn
  // timer firing: handleTimeout costs p1 a life and advances the turn to p2.
  let timeoutFired = 0;
  gameLogic._setDictionaryForTesting({
    isValidWord: async () => {
      timeoutFired += 1;
      handleTimeout(game); // the race: turn advances mid-await
      return true; // ...and only THEN does the word come back "valid"
    },
  });

  try {
    const res = await submitWord(game, 'garden');

    // The submission must be discarded, not applied.
    assert.equal(res.accepted, false, 'raced submission must not be accepted');
    assert.equal(res.reason, 'turn_over', 'should report turn_over');

    // The timeout ran exactly once; submitWord must NOT have advanced again.
    assert.equal(timeoutFired, 1, 'the simulated timeout fired once');
    assert.equal(game.completedTurnCount, 1, 'turn advanced ONCE (by the timeout), not twice');
    assert.equal(game.currentPlayerIndex, 1, 'current player is p2 (advanced once), not skipped past');

    // No side effects from the discarded word.
    assert.equal(game.usedWords.has('garden'), false, 'the discarded word must not be recorded');
    assert.equal(game.currentCombo, 'gar', 'the combo must not be re-rolled by a discarded submit');
    assert.equal(p1.lives, 2, 'p1 lost exactly one life (the timeout), not penalised twice');
  } finally {
    restoreDict();
  }
});

test('no race: a normal submission still accepts and advances the turn exactly once', async () => {
  const game = createGame([{ id: 'p1' }, { id: 'p2' }], 'easy');
  game.currentCombo = 'gar';
  const p1 = game.players.find((p) => p.id === 'p1');

  // Plain dictionary: the word is valid and NOTHING advances the turn mid-await.
  gameLogic._setDictionaryForTesting({ isValidWord: async () => true });

  try {
    const res = await submitWord(game, 'garden');

    assert.equal(res.accepted, true, 'a valid word on your turn is accepted');
    assert.equal(res.word, 'garden');
    assert.equal(game.completedTurnCount, 1, 'turn advanced exactly once');
    assert.equal(game.currentPlayerIndex, 1, 'turn passed to p2');
    assert.equal(game.usedWords.has('garden'), true, 'accepted word is recorded');
    assert.notEqual(game.currentCombo, 'gar', 'a fresh combo is rolled for the next player');
    assert.equal(p1.lives, 3, 'an accepted word costs no life');
  } finally {
    restoreDict();
  }
});

test('guard also discards if the game FINISHES during the await', async () => {
  const game = createGame([{ id: 'p1' }, { id: 'p2' }], 'easy');
  game.currentCombo = 'gar';

  // Simulate the game ending mid-lookup (e.g. the other player was eliminated
  // by a timeout and only one remains): status flips to 'finished'.
  gameLogic._setDictionaryForTesting({
    isValidWord: async () => {
      game.status = 'finished';
      return true;
    },
  });

  try {
    const res = await submitWord(game, 'garden');
    assert.equal(res.accepted, false, 'no submission applies after the game finished');
    assert.equal(res.reason, 'turn_over');
    assert.equal(game.usedWords.has('garden'), false, 'no word recorded after finish');
  } finally {
    restoreDict();
  }
});
