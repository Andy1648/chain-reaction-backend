// tests/imposterWordLogic.test.js
// Run with: npm test   (node --test discovers this file)
//
// Unit tests for imposterWordLogic.js - the social-deduction mode's pure
// rules: game setup, answer/vote validation, the strict-plurality catch
// resolution and its scoring, imposter rotation across rounds, and final
// results ordering. The module is pure (no timers/network), so every test
// operates on plain game objects; where createGame randomizes (imposter
// seat, category pair) tests either assert invariants or pin the fields
// directly afterward.

const test = require('node:test');
const assert = require('node:assert/strict');

const logic = require('../imposterWordLogic');
const {
  createGame,
  submitAnswer,
  submitVote,
  countVotes,
  endAnswerPhase,
  endVotePhase,
  startNextRound,
  getResults,
  pickRandomPair,
  CATEGORY_PAIRS,
  TOTAL_ROUNDS,
  TIME_BY_DIFFICULTY,
} = logic;

const PLAYERS = [
  { id: 'p1', name: 'Alice' },
  { id: 'p2', name: 'Bob' },
  { id: 'p3', name: 'Cara' },
  { id: 'p4', name: 'Dan' },
];

function makeGame(difficulty = 'medium', players = PLAYERS) {
  return createGame(players, difficulty);
}

// Pin the imposter to a known seat so vote-resolution tests are deterministic.
function pinImposter(game, id) {
  game.imposterIndex = game.order.indexOf(id);
  game.imposterId = id;
  game.players.forEach((p) => {
    p.wasImposter = p.id === id;
  });
}

/* ============================== createGame ============================== */

test('createGame sets up a full roster with zeroed scores and an imposter from the table', () => {
  const game = makeGame();
  assert.equal(game.status, 'answering');
  assert.equal(game.currentRound, 1);
  assert.equal(game.rounds, TOTAL_ROUNDS);
  assert.equal(game.players.length, 4);
  for (const p of game.players) {
    assert.equal(p.score, 0);
    assert.deepEqual(p.answers, []);
    assert.equal(p.vote, null);
    assert.equal(p.caughtCount, 0);
    assert.equal(p.survivedCount, 0);
  }
  // The imposter is one of the actual players, and exactly one player is
  // stamped wasImposter.
  assert.ok(game.order.includes(game.imposterId));
  assert.equal(game.players.filter((p) => p.wasImposter).length, 1);
  assert.equal(game.players.find((p) => p.wasImposter).id, game.imposterId);
});

test('createGame shows non-imposters the real category and never leaks the fake', () => {
  const game = makeGame();
  assert.equal(game.currentCategory, game.currentPair.real);
  assert.equal(game.imposterCategory, 'You are the IMPOSTER. Blend in.');
  assert.ok(game.usedCategoryPairs.has(game.currentPair.real), 'first pair marked used');
});

test('createGame applies difficulty phase timings and falls back to medium', () => {
  const hard = makeGame('hard');
  assert.equal(hard.answerPhaseSeconds, TIME_BY_DIFFICULTY.hard.answer);
  assert.equal(hard.votePhaseSeconds, TIME_BY_DIFFICULTY.hard.vote);

  const bogus = makeGame('ultra-nightmare');
  assert.equal(bogus.difficultyKey, 'medium');
  assert.equal(bogus.answerPhaseSeconds, TIME_BY_DIFFICULTY.medium.answer);
});

/* ============================== submitAnswer ============================ */

test('submitAnswer accepts a trimmed answer and reports the running count', () => {
  const game = makeGame();
  const res = submitAnswer(game, 'p1', '  pizza rolls  ');
  assert.deepEqual(res, { accepted: true, answer: 'pizza rolls', playerId: 'p1', answerCount: 1 });
  assert.deepEqual(game.players[0].answers, ['pizza rolls']);
});

test('submitAnswer rejects outside the answering phase', () => {
  const game = makeGame();
  game.status = 'voting';
  assert.equal(submitAnswer(game, 'p1', 'anything').reason, 'wrong_phase');
  game.status = 'reveal';
  assert.equal(submitAnswer(game, 'p1', 'anything').reason, 'wrong_phase');
});

test('submitAnswer rejects a player not in the game', () => {
  const game = makeGame();
  const res = submitAnswer(game, 'ghost', 'hello');
  assert.deepEqual(res, { accepted: false, reason: 'not_in_game', playerId: 'ghost' });
});

test('submitAnswer rejects answers under 2 chars AFTER trimming (whitespace padding does not count)', () => {
  const game = makeGame();
  assert.equal(submitAnswer(game, 'p1', 'x').reason, 'too_short');
  assert.equal(submitAnswer(game, 'p1', '   a   ').reason, 'too_short');
  assert.equal(submitAnswer(game, 'p1', '        ').reason, 'too_short');
  assert.equal(submitAnswer(game, 'p1', '').reason, 'too_short');
  assert.deepEqual(game.players[0].answers, [], 'nothing recorded');
});

test('submitAnswer caps a player at 3 answers per round', () => {
  const game = makeGame();
  assert.equal(submitAnswer(game, 'p1', 'one').accepted, true);
  assert.equal(submitAnswer(game, 'p1', 'two').accepted, true);
  assert.equal(submitAnswer(game, 'p1', 'three').accepted, true);
  const res = submitAnswer(game, 'p1', 'four');
  assert.equal(res.reason, 'max_answers');
  assert.equal(game.players[0].answers.length, 3);
  // The cap is per-player: another player can still answer.
  assert.equal(submitAnswer(game, 'p2', 'four').accepted, true);
});

test('submitAnswer blocks a case-insensitive duplicate from the SAME player only', () => {
  const game = makeGame();
  submitAnswer(game, 'p1', 'Homework');
  assert.equal(submitAnswer(game, 'p1', 'HOMEWORK').reason, 'already_said');
  assert.equal(submitAnswer(game, 'p1', '  homework ').reason, 'already_said');
  // A different player saying the same thing is the point of the game.
  assert.equal(submitAnswer(game, 'p2', 'homework').accepted, true);
});

/* ============================== submitVote ============================== */

test('submitVote records a vote and a later vote overwrites it', () => {
  const game = makeGame();
  game.status = 'voting';
  assert.deepEqual(submitVote(game, 'p1', 'p2'), { accepted: true, voterId: 'p1' });
  assert.equal(game.players[0].vote, 'p2');
  submitVote(game, 'p1', 'p3'); // changed their mind
  assert.equal(game.players[0].vote, 'p3');
  assert.equal(countVotes(game).voted, 1, 'an overwrite is still one voter');
});

test('submitVote validates phase, membership, self-votes, and the suspect', () => {
  const game = makeGame();
  assert.equal(submitVote(game, 'p1', 'p2').reason, 'wrong_phase');

  game.status = 'voting';
  assert.equal(submitVote(game, 'ghost', 'p2').reason, 'not_in_game');
  assert.equal(submitVote(game, 'p1', 'p1').reason, 'cannot_vote_self');
  assert.equal(submitVote(game, 'p1', 'nobody').reason, 'invalid_suspect');
  assert.equal(game.players[0].vote, null, 'no rejected vote is recorded');
});

test('countVotes reports voted/total as votes come in', () => {
  const game = makeGame();
  game.status = 'voting';
  assert.deepEqual(countVotes(game), { voted: 0, total: 4 });
  submitVote(game, 'p1', 'p2');
  submitVote(game, 'p2', 'p1');
  assert.deepEqual(countVotes(game), { voted: 2, total: 4 });
});

/* ============================ endAnswerPhase ============================ */

test('endAnswerPhase flips to voting and reveals everyone, including blankers', () => {
  const game = makeGame();
  submitAnswer(game, 'p1', 'alpha');
  submitAnswer(game, 'p2', 'beta');

  const result = endAnswerPhase(game);
  assert.equal(game.status, 'voting');
  assert.equal(result.timerSeconds, game.votePhaseSeconds);
  assert.equal(result.answers.length, 4, 'players with no answers still appear');
  const p3Entry = result.answers.find((a) => a.playerId === 'p3');
  assert.deepEqual(p3Entry.answers, []);

  // The reveal is a snapshot - mutating it must not corrupt game state.
  result.answers[0].answers.push('injected');
  assert.ok(!game.players[0].answers.includes('injected'));
});

/* ============================ endVotePhase ============================== */

test('a strict plurality on the imposter catches them; each catcher scores +1', () => {
  const game = makeGame();
  pinImposter(game, 'p4');
  game.status = 'voting';
  submitVote(game, 'p1', 'p4');
  submitVote(game, 'p2', 'p4');
  submitVote(game, 'p3', 'p1'); // wrong guess
  submitVote(game, 'p4', 'p2'); // imposter deflects elsewhere (tally: p4=2, p1=1, p2=1)

  const reveal = endVotePhase(game);

  assert.equal(reveal.imposterCaught, true);
  assert.equal(reveal.imposterId, 'p4');
  assert.equal(reveal.imposterName, 'Dan');
  assert.equal(game.status, 'reveal');
  // p1 and p2 caught them; p3/p4 get nothing; the imposter gets nothing.
  const score = (id) => game.players.find((p) => p.id === id).score;
  assert.equal(score('p1'), 1);
  assert.equal(score('p2'), 1);
  assert.equal(score('p3'), 0);
  assert.equal(score('p4'), 0);
  assert.equal(game.players.find((p) => p.id === 'p1').caughtCount, 1);
  assert.equal(game.players.find((p) => p.id === 'p4').survivedCount, 0);
});

test('a tie lets the imposter survive and score +3 (ties favor the imposter)', () => {
  const game = makeGame();
  pinImposter(game, 'p4');
  game.status = 'voting';
  submitVote(game, 'p1', 'p4');
  submitVote(game, 'p2', 'p3'); // 1-1 tie between p4 and p3
  const reveal = endVotePhase(game);

  assert.equal(reveal.imposterCaught, false);
  const imposter = game.players.find((p) => p.id === 'p4');
  assert.equal(imposter.score, 3);
  assert.equal(imposter.survivedCount, 1);
  // The wrong-tie voter and the right-but-tied voter score nothing.
  assert.equal(game.players.find((p) => p.id === 'p1').score, 0);
});

test('zero votes means the imposter survives', () => {
  const game = makeGame();
  pinImposter(game, 'p2');
  game.status = 'voting';
  const reveal = endVotePhase(game);
  assert.equal(reveal.imposterCaught, false);
  assert.equal(game.players.find((p) => p.id === 'p2').score, 3);
  assert.deepEqual(reveal.votes, [], 'no phantom votes in the reveal');
});

test('a mob voting one INNOCENT still lets the imposter survive even with one correct vote', () => {
  const game = makeGame();
  pinImposter(game, 'p4');
  game.status = 'voting';
  submitVote(game, 'p1', 'p3');
  submitVote(game, 'p2', 'p3');
  submitVote(game, 'p4', 'p3'); // imposter piles on
  submitVote(game, 'p3', 'p4'); // the lone correct voter (1 < 3)
  const reveal = endVotePhase(game);

  assert.equal(reveal.imposterCaught, false, 'plurality was on an innocent');
  assert.equal(game.players.find((p) => p.id === 'p4').score, 3);
  assert.equal(game.players.find((p) => p.id === 'p3').score, 0, 'a correct vote in a losing tally scores nothing');
});

test('endVotePhase reveals the real category, the votes cast, and full scores', () => {
  const game = makeGame();
  pinImposter(game, 'p1');
  game.status = 'voting';
  submitVote(game, 'p2', 'p1');
  const reveal = endVotePhase(game);

  assert.equal(reveal.realCategory, game.currentCategory);
  assert.equal(reveal.imposterCategory, game.imposterCategory);
  assert.deepEqual(reveal.votes, [{ voterId: 'p2', suspectId: 'p1' }]);
  assert.equal(reveal.scores.length, 4);
});

/* ============================ startNextRound ============================ */

test('startNextRound rotates the imposter one seat and resets per-round state', () => {
  const game = makeGame();
  pinImposter(game, 'p2');
  submitAnswer(game, 'p1', 'stale answer');
  game.status = 'voting';
  submitVote(game, 'p1', 'p2');
  endVotePhase(game);

  const info = startNextRound(game);

  assert.equal(info.round, 2);
  assert.equal(game.currentRound, 2);
  assert.equal(game.status, 'answering');
  assert.equal(game.imposterId, 'p3', 'imposter moved one seat forward from p2');
  assert.equal(game.players.find((p) => p.id === 'p3').wasImposter, true);
  assert.equal(game.players.find((p) => p.id === 'p2').wasImposter, false);
  for (const p of game.players) {
    assert.deepEqual(p.answers, []);
    assert.equal(p.vote, null);
  }
});

test('the imposter rotation wraps around the end of the order', () => {
  const game = makeGame();
  pinImposter(game, 'p4'); // last seat
  startNextRound(game);
  assert.equal(game.imposterId, 'p1', 'wraps back to the first seat');
});

test('startNextRound never repeats a category pair within a game', () => {
  const game = makeGame();
  const seen = new Set([game.currentPair.real]);
  for (let round = 2; round <= game.rounds; round += 1) {
    const info = startNextRound(game);
    assert.notEqual(info, null);
    assert.ok(!seen.has(game.currentPair.real), `pair "${game.currentPair.real}" repeated`);
    seen.add(game.currentPair.real);
  }
});

test('startNextRound after the final round finishes the game and resolves the winner', () => {
  const game = makeGame();
  game.currentRound = game.rounds; // on the last round
  game.players.find((p) => p.id === 'p3').score = 7;

  const info = startNextRound(game);
  assert.equal(info, null);
  assert.equal(game.status, 'finished');
  assert.equal(game.winnerId, 'p3');
});

test('a full game is exactly TOTAL_ROUNDS rounds', () => {
  const game = makeGame();
  let rounds = 1;
  while (startNextRound(game) !== null) rounds += 1;
  assert.equal(rounds, TOTAL_ROUNDS);
  assert.equal(game.status, 'finished');
});

/* ============================== getResults ============================== */

test('getResults sorts by score descending with ties broken by seat order', () => {
  const game = makeGame();
  game.players[0].score = 3; // Alice
  game.players[1].score = 5; // Bob
  game.players[2].score = 3; // Cara - ties Alice, sits later
  game.winnerId = 'p2';

  const { winnerId, finalScores } = getResults(game);
  assert.equal(winnerId, 'p2');
  assert.deepEqual(finalScores.map((p) => p.id), ['p2', 'p1', 'p3', 'p4']);
  // The internal _order tiebreaker must not leak into the payload.
  assert.equal(finalScores[0]._order, undefined);
  assert.deepEqual(Object.keys(finalScores[0]).sort(), [
    'caughtCount', 'id', 'name', 'score', 'survivedCount',
  ]);
});

/* ============================ pickRandomPair ============================ */

test('pickRandomPair honors the exclude set and every pair is well-formed', () => {
  // Exclude all but one pair - the survivor must be picked.
  const all = new Set(CATEGORY_PAIRS.map((p) => p.real));
  const keep = CATEGORY_PAIRS[7].real;
  all.delete(keep);
  assert.equal(pickRandomPair(all).real, keep);

  // Excluding EVERYTHING falls back to the full list instead of crashing.
  all.add(keep);
  assert.ok(CATEGORY_PAIRS.includes(pickRandomPair(all)));

  for (const pair of CATEGORY_PAIRS) {
    assert.ok(pair.real && typeof pair.real === 'string');
    assert.ok(pair.fake && typeof pair.fake === 'string');
    assert.notEqual(pair.real, pair.fake, `pair "${pair.real}" duplicates real/fake`);
  }
});

test('CATEGORY_PAIRS has no duplicate real categories (non-repeat guarantee depends on it)', () => {
  const reals = CATEGORY_PAIRS.map((p) => p.real);
  assert.equal(new Set(reals).size, reals.length);
});
