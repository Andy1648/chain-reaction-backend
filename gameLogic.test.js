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

const {
  createGame,
  submitWord,
  getCurrentPlayerId,
  computeTimerForTurn,
  handleTimeout,
  pickRandomCombo,
  comboDifficultyPressure,
  COMBOS,
  DIFFICULTY_PRESETS,
} = gameLogic;

function makeTwoPlayerGame(difficulty = 'medium') {
  return createGame([{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }], difficulty);
}

test('createGame sets up correct initial state', () => {
  const game = makeTwoPlayerGame();
  assert.equal(game.status, 'in_progress');
  assert.equal(game.players.length, 2);
  assert.equal(game.players[0].lives, 3);
  assert.equal(game.players[1].lives, 3);
  assert.equal(game.usedWords.size, 0, 'should start with no used words');
  assert.ok(COMBOS.includes(game.currentCombo), 'should start with a combo from the list');
  assert.equal(game.chain, undefined, 'Word Bomb has no chain');
  assert.equal(game.currentPlayerIndex, 0);
});

test('submitWord accepts a valid word that contains the combo', async () => {
  const game = makeTwoPlayerGame();
  game.currentCombo = 'en';

  const result = await submitWord(game, 'enter'); // 'enter' contains 'en'
  assert.equal(result.accepted, true);
  assert.equal(result.word, 'enter');
  assert.ok(game.usedWords.has('enter'), 'accepted word should be recorded as used');
});

test('submitWord accepts when the combo is in the middle of the word', async () => {
  const game = makeTwoPlayerGame();
  game.currentCombo = 'er'; // 'render' -> r-E-R-d... contains 'er'

  const result = await submitWord(game, 'render');
  assert.equal(result.accepted, true);
  assert.equal(result.word, 'render');
});

test('submitWord rejects a word that does NOT contain the combo', async () => {
  const game = makeTwoPlayerGame();
  game.currentCombo = 'en';

  const result = await submitWord(game, 'castle'); // valid word, but no 'en'
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'missing_combo');
  assert.equal(result.combo, 'en');
});

test('submitWord rejects a word that is too short', async () => {
  const game = makeTwoPlayerGame();
  game.currentCombo = 'en';

  const result = await submitWord(game, 'en'); // contains the combo but only 2 letters
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'too_short');
});

test('submitWord rejects a word already used in this game', async () => {
  const game = makeTwoPlayerGame();
  // 'enter' contains the combo 'en' and is already used, so it should be
  // caught by the used-words check specifically (not the combo check).
  game.currentCombo = 'en';
  game.usedWords = new Set(['enter']);

  const result = await submitWord(game, 'enter');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'already_used');
});

test('submitWord rejects a word not in the dictionary', async () => {
  const game = makeTwoPlayerGame();
  game.currentCombo = 'en';

  const result = await submitWord(game, 'enzzqq'); // contains 'en', not a real word
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'not_a_word');
});

test('submitWord rolls a new (different) combo after a successful submission', async () => {
  const game = makeTwoPlayerGame();
  game.currentCombo = 'en';

  const result = await submitWord(game, 'enter');
  assert.equal(result.accepted, true);
  assert.notEqual(game.currentCombo, 'en', 'combo should change after a success');
  assert.ok(COMBOS.includes(game.currentCombo), 'new combo should come from the list');
  assert.equal(result.combo, game.currentCombo, 'result should report the new combo');
});

test('submitWord advances turn to the next player on success', async () => {
  const game = makeTwoPlayerGame();
  game.currentCombo = 'en';

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

test('a full round of whiffs swaps the combo (dead-combo rescue)', () => {
  const game = createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 'medium');
  const original = game.currentCombo;
  const r1 = handleTimeout(game);        // A whiffs
  assert.equal(r1.comboSwapped, false, 'no swap after a single whiff');
  const r2 = handleTimeout(game);        // B whiffs -> full round, nobody answered
  assert.equal(r2.comboSwapped, true, 'combo swaps after a full dead round');
  assert.notEqual(game.currentCombo, original, 'a fresh combo is rolled');
  assert.equal(game.comboFailStreak, 0, 'the streak resets after the swap');
});

test('turn order skips eliminated players in a 3-player game', async () => {
  const game = createGame(
    [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }, { id: 'p3', name: 'C' }],
    'medium'
  );
  game.currentCombo = 'en';

  // Eliminate p2 directly to test that turn order skips over them.
  game.players[1].eliminated = true;
  game.players[1].lives = 0;

  assert.equal(getCurrentPlayerId(game), 'p1');
  await submitWord(game, 'enter'); // p1's valid move
  assert.equal(getCurrentPlayerId(game), 'p3', 'should skip eliminated p2 and go straight to p3');
});

test('difficulty timer curve: easy starts at 15s and decreases every 3 turns down to floor of 6s', () => {
  const game = createGame([{ id: 'p1' }, { id: 'p2' }], 'easy');
  assert.equal(DIFFICULTY_PRESETS.easy.startSeconds, 15);

  game.completedTurnCount = 0;
  assert.equal(computeTimerForTurn(game), 15);

  game.completedTurnCount = 3;
  assert.equal(computeTimerForTurn(game), 14);

  game.completedTurnCount = 6;
  assert.equal(computeTimerForTurn(game), 13);

  // Jump far ahead - should be clamped at the floor, never go below it or negative
  game.completedTurnCount = 500;
  assert.equal(computeTimerForTurn(game), 6, 'should never drop below the configured floor');
});

test('difficulty timer curve: hard starts at 7s and decreases every single turn down to floor of 3s', () => {
  const game = createGame([{ id: 'p1' }, { id: 'p2' }], 'hard');

  game.completedTurnCount = 0;
  assert.equal(computeTimerForTurn(game), 7);

  game.completedTurnCount = 1;
  assert.equal(computeTimerForTurn(game), 6);

  game.completedTurnCount = 4;
  assert.equal(computeTimerForTurn(game), 3, 'should hit the floor at turn 4 (7 - 4)');

  game.completedTurnCount = 100;
  assert.equal(computeTimerForTurn(game), 3, 'should stay clamped at the floor');
});

test('combo difficulty pressure ramps up with completedTurnCount and clamps', () => {
  // Mirrors the computeTimerForTurn tests: a deterministic curve read off the
  // same completedTurnCount signal. Negative early (favours short combos),
  // crosses 0 at the neutral point, clamps positive late (favours long combos).
  assert.equal(comboDifficultyPressure(0), -1.0, 'turn 0 starts fully short-favoured');
  assert.equal(comboDifficultyPressure(8), -0.5, 'ramps linearly toward neutral');
  assert.equal(comboDifficultyPressure(16), 0, 'neutral at ~turn 16');
  assert.equal(comboDifficultyPressure(24), 0.5, 'keeps ramping toward hard');
  assert.equal(comboDifficultyPressure(32), 1.0, 'reaches the max around turn 32');

  // Strictly monotonic non-decreasing, and clamped at the max far ahead.
  assert.ok(
    comboDifficultyPressure(5) < comboDifficultyPressure(20),
    'pressure should increase with progress'
  );
  assert.equal(comboDifficultyPressure(500), 1.0, 'should stay clamped at the max');
  assert.equal(comboDifficultyPressure(-5), -1.0, 'guards against negative turn counts');
});

test('pickRandomCombo skews to longer combos as completedTurnCount rises', () => {
  // Statistical: late game should pick noticeably longer combos on average than
  // early game. The gap is large (early ~70% length-2, late ~20%), so a big
  // sample makes this safe from flakiness without seeding.
  const avgLength = (turns) => {
    const N = 5000;
    let sum = 0;
    for (let i = 0; i < N; i += 1) sum += pickRandomCombo(undefined, turns).length;
    return sum / N;
  };

  const early = avgLength(0);
  const late = avgLength(40);

  // Every pick is always a real combo from the list (no weighting can break that).
  assert.ok(COMBOS.includes(pickRandomCombo(undefined, 0)));
  assert.ok(COMBOS.includes(pickRandomCombo(undefined, 40)));
  // And the exclude-the-just-solved behaviour still holds at any progress.
  assert.notEqual(pickRandomCombo('en', 40), 'en', 'still excludes the prior combo');

  assert.ok(
    late > early + 0.2,
    `late-game combos should average clearly longer (early=${early.toFixed(2)}, late=${late.toFixed(2)})`
  );
});

test('invalid difficulty key falls back to medium rather than crashing', () => {
  const game = createGame([{ id: 'p1' }, { id: 'p2' }], 'nonsense_difficulty');
  assert.equal(game.difficultyKey, 'medium');
  assert.equal(game.difficulty.startSeconds, DIFFICULTY_PRESETS.medium.startSeconds);
});

test('rejected word submissions do not advance the turn or record a used word', async () => {
  const game = makeTwoPlayerGame();
  game.currentCombo = 'en';

  const usedBefore = game.usedWords.size;
  const playerBefore = getCurrentPlayerId(game);

  await submitWord(game, 'castle'); // missing the combo, should be rejected

  assert.equal(game.usedWords.size, usedBefore, 'used words should be unchanged on rejection');
  assert.equal(getCurrentPlayerId(game), playerBefore, 'turn should not advance on rejection');
});

/* ======================================================================= */
/* ==================  CATEGORY BLITZ: endRound reveal  ================== */
/* ======================================================================= */
// endRound's sampleAnswers field: up to 12 accept-list answers nobody gave
// this round, revealed so players who blanked learn what would have counted.

const categoryBlitzLogic = require('./categoryBlitzLogic');
const CATEGORY_ANSWERS = require('./categoryAnswers');

// Minimal game object shaped like categoryBlitzLogic.createGame's output -
// built by hand so tests control the category instead of getting a random one.
function makeBlitzGame(category, answersByPlayer = { p1: [] }) {
  return {
    status: 'in_progress',
    currentRound: 1,
    currentCategory: category,
    players: Object.entries(answersByPlayer).map(([id, answers]) => ({
      id,
      name: id,
      answers: [...answers],
      score: answers.length,
    })),
  };
}

// Test-only accept-lists injected into the shared CATEGORY_ANSWERS object so
// these tests are deterministic and independent of real content data.
CATEGORY_ANSWERS['__test_tiny__'] = new Set(['blinky', 'pinky', 'inky', 'clyde', 'sue']);
CATEGORY_ANSWERS['__test_big__'] = new Set(
  Array.from({ length: 40 }, (_, i) => `answer${i}`)
);

test('endRound sampleAnswers excludes answers any player gave, case-insensitively', () => {
  const game = makeBlitzGame('__test_big__', {
    p1: ['Answer0', 'ANSWER1'], // stored as typed; list entries are lowercase
    p2: ['answer2'],
  });
  const snapshot = categoryBlitzLogic.endRound(game);

  assert.ok(Array.isArray(snapshot.sampleAnswers));
  for (const given of ['answer0', 'answer1', 'answer2']) {
    assert.ok(
      !snapshot.sampleAnswers.includes(given),
      `sampleAnswers should not contain the given answer "${given}"`
    );
  }
  // Everything revealed really is from the category's accept-list.
  for (const sample of snapshot.sampleAnswers) {
    assert.ok(CATEGORY_ANSWERS['__test_big__'].has(sample));
  }
});

test('endRound sampleAnswers caps at 12', () => {
  const game = makeBlitzGame('__test_big__'); // 40 available, none given
  const snapshot = categoryBlitzLogic.endRound(game);
  assert.equal(snapshot.sampleAnswers.length, 12);
  // No duplicates in the reveal.
  assert.equal(new Set(snapshot.sampleAnswers).size, 12);
});

test('endRound sampleAnswers returns whatever is left on tiny lists', () => {
  const game = makeBlitzGame('__test_tiny__', { p1: ['Blinky', 'PINKY'] });
  const snapshot = categoryBlitzLogic.endRound(game);
  assert.deepEqual(
    [...snapshot.sampleAnswers].sort(),
    ['clyde', 'inky', 'sue'],
    'the 3 un-given ghosts should all be revealed, and nothing else'
  );
});

test('endRound sampleAnswers is [] when the category has no accept-list', () => {
  const game = makeBlitzGame('__test_no_such_category__');
  const snapshot = categoryBlitzLogic.endRound(game);
  assert.deepEqual(snapshot.sampleAnswers, []);
});
