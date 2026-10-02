// t2-blitzRace.test.js
// STEP 9 (list-only): submitAnswer no longer awaits a judge, so the four AI-await race tests are gone —
// there is no await for a round to move under. The remaining tests still hold.
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

const { createGame, endRound } = blitz;

const realJudge = haikuValidator.judge;
const realIsEnabled = haikuValidator.isEnabled;

// Tests here pass a validate-shaped impl (async -> boolean); adapt it to the judge()
// contract so the race scenarios keep reading the way they did.
function patchValidator(validateImpl) {
  haikuValidator.isEnabled = () => true;
  haikuValidator.judge = async (category, answer, playerId) => {
    const ok = await validateImpl(category, answer, playerId);
    return ok ? { verdict: true, code: 'judge_yes' } : { verdict: false, code: 'judge_no' };
  };
}

function restoreValidator() {
  haikuValidator.judge = realJudge;
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

