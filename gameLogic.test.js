// gameLogic.test.js
// Run with: node --test gameLogic.test.js
// Uses only Node's built-in test runner (node:test, node:assert) so this
// suite runs with zero npm dependencies - relevant since this sandbox has
// no network access to install packages. Uses dictionary.mock.js instead
// of the real Dictionary API.

const test = require('node:test');
const assert = require('node:assert/strict');

const gameLogic = require('./gameLogic');
const mockDictionary = require('./dictionary.mock');

// Swap in the mock dictionary for the entire test run. This is a module-
// level side effect, which is acceptable here since this file's only job
// is testing gameLogic in isolation.
gameLogic._setDictionaryForTesting(mockDictionary);

const { createGame, submitWord, getCurrentPlayerId, lastTwoLetters, computeTimerForTurn, handleTimeout, DIFFICULTY_PRESETS } = gameLogic;

function makeTwoPlayerGame(difficulty = 'medium') {
  return createGame([{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }], difficulty);
}

test('createGame sets up correct initial state', () => {
  const game = makeTwoPlayerGame();
  assert.equal(game.status, 'in_progress');
  assert.equal(game.players.length, 2);
  assert.equal(game.players[0].lives, 3);
  assert.equal(game.players[1].lives, 3);
  assert.equal(game.chain.length, 1, 'should start with exactly one seed word');
  assert.equal(game.currentPlayerIndex, 0);
});

test('lastTwoLetters extracts correctly, including short edge cases', () => {
  assert.equal(lastTwoLetters('garden'), 'en');
  assert.equal(lastTwoLetters('it'), 'it');
  assert.equal(lastTwoLetters('GARDEN'), 'en', 'should lowercase');
});

test('submitWord accepts a valid word matching the prefix rule', async () => {
  const game = makeTwoPlayerGame();
  game.chain = ['garden'];
  game.usedWords = new Set(['garden']);

  const result = await submitWord(game, 'enter'); // 'garden' -> 'en' -> 'enter'
  assert.equal(result.accepted, true);
  assert.equal(result.word, 'enter');
  assert.equal(game.chain[game.chain.length - 1], 'enter');
});

test('submitWord rejects a word with the wrong prefix', async () => {
  const game = makeTwoPlayerGame();
  game.chain = ['garden'];
  game.usedWords = new Set(['garden']);

  const result = await submitWord(game, 'castle'); // does not start with 'en'
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'wrong_prefix');
  assert.equal(result.requiredPrefix, 'en');
});

test('submitWord rejects a word that is too short', async () => {
  const game = makeTwoPlayerGame();
  game.chain = ['garden'];
  const result = await submitWord(game, 'en'); // only 2 letters
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'too_short');
});

test('submitWord rejects a word already used in this game', async () => {
  const game = makeTwoPlayerGame();
  // Chain ends in 'garden' -> required prefix is 'en'. 'enter' satisfies
  // that prefix and is already marked used, so resubmitting it should be
  // caught by the used-words check specifically (not the prefix check).
  game.chain = ['garden'];
  game.usedWords = new Set(['garden', 'enter']);

  const result = await submitWord(game, 'enter');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'already_used');
});

test('submitWord rejects a word not in the dictionary', async () => {
  const game = makeTwoPlayerGame();
  game.chain = ['garden'];
  game.usedWords = new Set(['garden']);

  const result = await submitWord(game, 'enxyzqqq'); // valid prefix, not a real word
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'not_a_word');
});

test('submitWord advances turn to the next player on success', async () => {
  const game = makeTwoPlayerGame();
  game.chain = ['garden'];
  game.usedWords = new Set(['garden']);

  assert.equal(getCurrentPlayerId(game), 'p1');
  await submitWord(game, 'enter');
  assert.equal(getCurrentPlayerId(game), 'p2', 'turn should pass to the other player');
});

test('handleTimeout costs a life and does not eliminate above zero', () => {
  const game = makeTwoPlayerGame();
  const startingLives = game.players[0].lives;

  handleTimeout(game);

  assert.equal(game.players[0].lives, startingLives - 1);
  assert.equal(game.players[0].eliminated, false, 'should not be eliminated with lives remaining');
});

test('handleTimeout eliminates a player when lives reach zero', () => {
  const game = makeTwoPlayerGame();
  game.players[0].lives = 1; // one hit from elimination

  const { eliminatedPlayerId } = handleTimeout(game);

  assert.equal(game.players[0].lives, 0);
  assert.equal(game.players[0].eliminated, true);
  assert.equal(eliminatedPlayerId, 'p1');
});

test('game ends and declares a winner when only one player remains', () => {
  const game = makeTwoPlayerGame();
  game.players[0].lives = 1;

  handleTimeout(game); // eliminates p1 (it's p1's turn first)

  assert.equal(game.status, 'finished');
  assert.equal(game.winnerId, 'p2');
});

test('turn order skips eliminated players in a 3-player game', async () => {
  const game = createGame(
    [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }, { id: 'p3', name: 'C' }],
    'medium'
  );
  game.chain = ['garden'];
  game.usedWords = new Set(['garden']);

  // Eliminate p2 directly to test that turn order skips over them.
  game.players[1].eliminated = true;
  game.players[1].lives = 0;

  assert.equal(getCurrentPlayerId(game), 'p1');
  await submitWord(game, 'enter'); // p1's valid move
  assert.equal(getCurrentPlayerId(game), 'p3', 'should skip eliminated p2 and go straight to p3');
});

test('difficulty timer curve: easy starts at 20s and decreases every 3 turns down to floor of 8s', () => {
  const game = createGame([{ id: 'p1' }, { id: 'p2' }], 'easy');
  assert.equal(DIFFICULTY_PRESETS.easy.startSeconds, 20);

  game.completedTurnCount = 0;
  assert.equal(computeTimerForTurn(game), 20);

  game.completedTurnCount = 3;
  assert.equal(computeTimerForTurn(game), 19);

  game.completedTurnCount = 6;
  assert.equal(computeTimerForTurn(game), 18);

  // Jump far ahead - should be clamped at the floor, never go below it or negative
  game.completedTurnCount = 500;
  assert.equal(computeTimerForTurn(game), 8, 'should never drop below the configured floor');
});

test('difficulty timer curve: hard starts at 10s and decreases every single turn down to floor of 3s', () => {
  const game = createGame([{ id: 'p1' }, { id: 'p2' }], 'hard');

  game.completedTurnCount = 0;
  assert.equal(computeTimerForTurn(game), 10);

  game.completedTurnCount = 1;
  assert.equal(computeTimerForTurn(game), 9);

  game.completedTurnCount = 7;
  assert.equal(computeTimerForTurn(game), 3, 'should hit the floor exactly at turn 7');

  game.completedTurnCount = 100;
  assert.equal(computeTimerForTurn(game), 3, 'should stay clamped at the floor');
});

test('invalid difficulty key falls back to medium rather than crashing', () => {
  const game = createGame([{ id: 'p1' }, { id: 'p2' }], 'nonsense_difficulty');
  assert.equal(game.difficultyKey, 'medium');
  assert.equal(game.difficulty.startSeconds, DIFFICULTY_PRESETS.medium.startSeconds);
});

test('rejected word submissions do not advance the turn or mutate the chain', async () => {
  const game = makeTwoPlayerGame();
  game.chain = ['garden'];
  game.usedWords = new Set(['garden']);

  const chainLengthBefore = game.chain.length;
  const playerBefore = getCurrentPlayerId(game);

  await submitWord(game, 'castle'); // wrong prefix, should be rejected

  assert.equal(game.chain.length, chainLengthBefore, 'chain should be unchanged on rejection');
  assert.equal(getCurrentPlayerId(game), playerBefore, 'turn should not advance on rejection');
});
