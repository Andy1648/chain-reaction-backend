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

const realValidate = haikuValidator.validate;
const realIsEnabled = haikuValidator.isEnabled;
function restore() {
  haikuValidator.validate = realValidate;
  haikuValidator.isEnabled = realIsEnabled;
}

const TOOLS = 'Tools in a toolbox'; // accept-list includes "wrench", "hammer", "saw"

test('compound answer with a listed HEAD noun is accepted without the AI judge', async () => {
  const game = createGame([{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], 'medium');
  game.currentCategory = TOOLS;

  // AI enabled but always REJECTS + counts calls, so anything reaching it fails
  // and we can prove the compound was accepted BEFORE the judge.
  let aiCalls = 0;
  haikuValidator.isEnabled = () => true;
  haikuValidator.validate = async () => {
    aiCalls += 1;
    return false;
  };

  try {
    // "socket wrench": head = "wrench" is on the list -> accepted, no AI call.
    const r1 = await submitAnswer(game, 'p1', 'socket wrench');
    assert.equal(r1.accepted, true, 'socket wrench should be accepted (head=wrench)');
    assert.equal(aiCalls, 0, 'the AI judge must not be consulted for a listed-head compound');

    // "wrench holder": head = "holder" is NOT on the list -> falls to the AI,
    // which rejects. Proves it is the HEAD word that matters, not any word.
    const r2 = await submitAnswer(game, 'p1', 'wrench holder');
    assert.equal(r2.accepted, false, 'wrench holder should NOT auto-pass (head=holder)');
    assert.equal(r2.reason, 'not_in_category');
    assert.equal(aiCalls, 1, 'the AI judge should have been consulted for the non-head compound');
  } finally {
    restore();
  }
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
