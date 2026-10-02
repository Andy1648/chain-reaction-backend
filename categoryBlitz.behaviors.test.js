// categoryBlitz.behaviors.test.js
// Run with: node --test categoryBlitz.behaviors.test.js  (or npm test)
//
// Covers two playtest fixes:
//  - Compound leniency: a multi-word answer whose HEAD noun is a listed answer
//    (e.g. "socket wrench" when "wrench" is on the Tools list) is accepted
//    without the AI judge, which had been rejecting valid compounds.
//  - Score invariant: getScoreboard() (the final headline source) equals the sum
//    of the per-round endRound() roundScores (the breakdown), so the two can
//    never disagree the way "YOUR SCORE 0 / breakdown 3" did.

const test = require('node:test');
const assert = require('node:assert/strict');

const blitz = require('./categoryBlitzLogic');
const haikuValidator = require('./haikuValidator');

const { createGame, submitAnswer, endRound, startNextRound, getScoreboard } = blitz;

// The seam is judge(), not validate(): submitAnswer consults judge() so it can tell a
// model "no" apart from "the judge never ran" (fix/blitz-failopen-honesty).
const realJudge = haikuValidator.judge;
const realIsEnabled = haikuValidator.isEnabled;
function restore() {
  haikuValidator.judge = realJudge;
  haikuValidator.isEnabled = realIsEnabled;
}

const TOOLS = 'Tools in a toolbox'; // accept-list includes "wrench", "hammer", "saw"

test('STEP 9 list-only: a compound whose HEAD noun is listed is NOT on the list (no head-word leniency)', async () => {
  const game = createGame([{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], 'medium');
  game.currentCategory = 'NFL teams';
  // the head word "cowboys" is listed; the compound is not — it used to score without a verdict
  const r = await submitAnswer(game, 'p1', 'zzzz cowboys');
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'not_on_list');
});
test('final headline (getScoreboard) equals the sum of per-round scores (endRound)', async () => {
  // List-only mode (no AI) so accept-list answers score deterministically offline.
  haikuValidator.isEnabled = () => false;
  try {
    const game = createGame([{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], 'medium');
    const roundSum = { p1: 0, p2: 0 };

    // Play every round on the Tools category with known accept-list answers.
    const TOOL_WORDS = ['wrench', 'hammer', 'saw', 'drill', 'pliers'];
    for (let round = 0; round < blitz.TOTAL_ROUNDS; round++) {
      game.currentCategory = TOOLS;
      // p1 answers 3 tools, p2 answers 1 - distinct per round so nothing is a repeat.
      await submitAnswer(game, 'p1', TOOL_WORDS[0]);
      await submitAnswer(game, 'p1', TOOL_WORDS[1]);
      await submitAnswer(game, 'p1', TOOL_WORDS[2]);
      await submitAnswer(game, 'p2', TOOL_WORDS[3]);

      const result = endRound(game);
      for (const pr of result.playerResults) roundSum[pr.id] += pr.roundScore;

      if (round < blitz.TOTAL_ROUNDS - 1) startNextRound(game);
    }

    const board = getScoreboard(game);
    for (const entry of board) {
      assert.equal(
        entry.score,
        roundSum[entry.id],
        `${entry.id}: headline ${entry.score} must equal sum of round scores ${roundSum[entry.id]}`
      );
    }
    // Sanity: p1 scored 3 per round across all rounds.
    assert.equal(roundSum.p1, 3 * blitz.TOTAL_ROUNDS);
  } finally {
    restore();
  }
});
