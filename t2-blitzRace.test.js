// t2-blitzRace.test.js
// Run with: node --test t2-blitzRace.test.js   (or `npm test` for the whole suite)
//
// [T2] Regression tests for the Category Blitz submitAnswer TOCTOU race across
// the Haiku AI await (categoryBlitzLogic.js). submitAnswer awaits
// haikuValidator.validate() for 0.5-3s on any list-miss; during that await the
// room manager's timers keep running, so the round can END, the category can be
// REROLLED, the game can FINISH, the player can LEAVE, or the SAME answer can be
// submitted a second time. Before the fix, the post-await code unconditionally
// pushed the answer and bumped the score, so:
//   - an answer to round N's category landed (and scored) in round N+1,
//   - a rerolled-away category still got scored,
//   - a finished game's final score changed after winnerId was decided,
//   - the same answer submitted twice in-flight double-scored.
//
// The race is reproduced deterministically by monkey-patching the
// haikuValidator module's exports (categoryBlitzLogic calls
// haikuValidator.validate at call time, so swapping the property works without
// any refactor): the injected validate() mutates the game EXACTLY as the round
// timer would, mid-await, then resolves true ("the AI said yes").

const test = require('node:test');
const assert = require('node:assert/strict');

const blitz = require('./categoryBlitzLogic');
const haikuValidator = require('./haikuValidator');

const { createGame, endRound, startNextRound, rerollCategory } = blitz;

const realValidate = haikuValidator.validate;
const realIsEnabled = haikuValidator.isEnabled;

function patchValidator(validateImpl) {
  haikuValidator.isEnabled = () => true;
  haikuValidator.validate = validateImpl;
}

function restoreValidator() {
  haikuValidator.validate = realValidate;
  haikuValidator.isEnabled = realIsEnabled;
}

function twoPlayerGame() {
  const game = createGame(
    [{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }],
    'medium'
  );
  return game;
}

// An answer that is on NO accept-list, so submitAnswer always takes the AI path.
const OFF_LIST_ANSWER = 'zzqx flurble';

test('race: round ends during the AI await -> answer discarded, not scored', async () => {
  const game = twoPlayerGame();
  const p1 = game.players.find((p) => p.id === 'p1');

  patchValidator(async () => {
    endRound(game); // the round timer fires mid-await
    return true; // ...and only then does the AI say yes
  });

  try {
    const res = await blitz.submitAnswer(game, 'p1', OFF_LIST_ANSWER);
    assert.equal(res.accepted, false, 'answer landing after round end must be discarded');
    assert.deepEqual(p1.answers, [], 'no answer recorded after the round closed');
    assert.equal(p1.score, 0, 'no score after the round closed');
  } finally {
    restoreValidator();
  }
});

test('race: next round starts during the AI await -> old answer must not leak into the new round', async () => {
  const game = twoPlayerGame();
  const p1 = game.players.find((p) => p.id === 'p1');

  patchValidator(async () => {
    endRound(game);
    startNextRound(game); // intermission elapsed mid-await; round 2 is live
    return true;
  });

  try {
    const res = await blitz.submitAnswer(game, 'p1', OFF_LIST_ANSWER);
    assert.equal(res.accepted, false, 'round-1 answer must not apply to round 2');
    assert.deepEqual(p1.answers, [], "round 2's answer list must not contain the round-1 answer");
    assert.equal(p1.score, 0, 'no cross-round score');
    assert.equal(game.currentRound, 2, 'sanity: the game did advance to round 2');
  } finally {
    restoreValidator();
  }
});

test('race: category rerolled during the AI await -> answer to the old category discarded', async () => {
  const game = twoPlayerGame();
  const p1 = game.players.find((p) => p.id === 'p1');
  const oldCategory = game.currentCategory;

  patchValidator(async () => {
    rerollCategory(game); // host rerolled mid-await; same round, new category
    return true;
  });

  try {
    const res = await blitz.submitAnswer(game, 'p1', OFF_LIST_ANSWER);
    assert.equal(res.accepted, false, 'answer to the rerolled-away category must be discarded');
    assert.deepEqual(p1.answers, [], 'no answer recorded on the fresh category');
    assert.equal(p1.score, 0);
    assert.notEqual(game.currentCategory, oldCategory, 'sanity: the category did change');
  } finally {
    restoreValidator();
  }
});

test('race: game finishes during the AI await -> final scores must not change', async () => {
  const game = twoPlayerGame();
  const p1 = game.players.find((p) => p.id === 'p1');

  patchValidator(async () => {
    game.status = 'finished';
    game.winnerId = 'p2';
    return true;
  });

  try {
    const res = await blitz.submitAnswer(game, 'p1', OFF_LIST_ANSWER);
    assert.equal(res.accepted, false, 'no answer applies after the game finished');
    assert.equal(p1.score, 0, 'final scoreboard must not move after winnerId is decided');
  } finally {
    restoreValidator();
  }
});

test('race: player leaves during the AI await -> answer discarded, no ghost accept', async () => {
  const game = twoPlayerGame();

  patchValidator(async () => {
    // removePlayer's blitz branch: drop the leaver from the live roster.
    game.players = game.players.filter((p) => p.id !== 'p1');
    return true;
  });

  try {
    const res = await blitz.submitAnswer(game, 'p1', OFF_LIST_ANSWER);
    assert.equal(res.accepted, false, 'a departed player must not get an accepted result');
  } finally {
    restoreValidator();
  }
});

test('race: the same answer submitted twice in-flight scores exactly once', async () => {
  const game = twoPlayerGame();
  const p1 = game.players.find((p) => p.id === 'p1');

  // Both submissions pass the pre-await already_said check (nothing recorded
  // yet), then both resolve true. Only one may land.
  let release;
  const gate = new Promise((r) => { release = r; });
  patchValidator(async () => {
    await gate; // hold both calls in-flight simultaneously
    return true;
  });

  try {
    const first = blitz.submitAnswer(game, 'p1', OFF_LIST_ANSWER);
    const second = blitz.submitAnswer(game, 'p1', OFF_LIST_ANSWER);
    release();
    const [r1, r2] = await Promise.all([first, second]);

    const acceptedCount = [r1, r2].filter((r) => r.accepted).length;
    assert.equal(acceptedCount, 1, 'exactly one of the two duplicate in-flight submissions may land');
    assert.equal(p1.answers.length, 1, 'the answer must be recorded once, not twice');
    assert.equal(p1.score, 1, 'one point, not two, for one word');
  } finally {
    restoreValidator();
  }
});

test('no race: an AI-accepted answer during a quiet round still lands normally', async () => {
  const game = twoPlayerGame();
  const p1 = game.players.find((p) => p.id === 'p1');

  patchValidator(async () => true);

  try {
    const res = await blitz.submitAnswer(game, 'p1', OFF_LIST_ANSWER);
    assert.equal(res.accepted, true, 'the happy path is unchanged');
    assert.deepEqual(p1.answers, [OFF_LIST_ANSWER]);
    assert.equal(p1.score, 1);
  } finally {
    restoreValidator();
  }
});
