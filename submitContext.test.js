// submitContext.test.js
// Run with: node --test submitContext.test.js   (or `node --test` for the suite)
//
// Regression tests for the SUBMIT-TIME ROUND/TURN CONTEXT protocol added for the
// 2026-07-29 live-QA fixes:
//   - P0 Category Blitz: an answer is judged against the category the client was
//     SHOWING when the player typed (opts.expectedCategory / expectedRound), not
//     against whatever game.currentCategory drifted to. A tagged submission whose
//     context no longer matches the live round is a clean `stale_round`, never a
//     misleading wrong-category rejection.
//   - P1 Word Bomb: a word tagged with the fragment it was typed against
//     (opts.expectedCombo) that no longer matches the live combo is a clean
//     `turn_over`, never "MUST CONTAIN <new fragment>" (missing_combo on the new one).
//
// Both fields are OPTIONAL: with no context, behavior is exactly as before
// (backward-compatible for legacy clients). These are pure-logic tests — no room,
// no network — so they never touch the AI judge or the dictionary await.
//
// New file (additive); it modifies no source or existing test file.

const test = require('node:test');
const assert = require('node:assert/strict');

const cb = require('./categoryBlitzLogic');
const wb = require('./gameLogic');
const CATEGORY_ANSWERS = require('./categoryAnswers');

// A Category Blitz category with a known accept-list entry, pinned so the tests
// don't depend on which random category createGame happened to pick.
const CB_CATEGORY = 'Types of cheese';
const CB_LIST_HIT = 'cheddar';

function makeBlitzGame() {
  const game = cb.createGame([{ id: 'p1', name: 'P1' }], 'medium', true);
  game.currentCategory = CB_CATEGORY;
  game.currentRound = 1;
  game.status = 'in_progress';
  return game;
}

// Guard: the fixture is only meaningful if the accept-list really contains the hit.
test('fixture sanity: the pinned category list contains the pinned answer', () => {
  const set = CATEGORY_ANSWERS[CB_CATEGORY];
  assert.ok(set && set.has(CB_LIST_HIT), `${CB_CATEGORY} should list ${CB_LIST_HIT}`);
});

// ---------------------------------------------------------------------------
// Category Blitz — expectedCategory / expectedRound
// ---------------------------------------------------------------------------

test('CB: matching context → judged against that category, list hit scores', async () => {
  const game = makeBlitzGame();
  const res = await cb.submitAnswer(game, 'p1', CB_LIST_HIT, {
    expectedCategory: CB_CATEGORY,
    expectedRound: 1,
  });
  assert.equal(res.accepted, true);
  assert.equal(game.players[0].score, 1);
  assert.deepEqual(game.players[0].answers, [CB_LIST_HIT]);
});

test('CB: mismatched expectedCategory → stale_round, nothing mutated', async () => {
  const game = makeBlitzGame(); // live category is CB_CATEGORY
  const res = await cb.submitAnswer(game, 'p1', CB_LIST_HIT, {
    expectedCategory: 'NBA teams', // the client thinks it is on a different round
    expectedRound: 1,
  });
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'stale_round');
  assert.equal(game.players[0].score, 0);
  assert.deepEqual(game.players[0].answers, []);
});

test('CB: mismatched expectedRound → stale_round even if category matches', async () => {
  const game = makeBlitzGame(); // live round is 1
  const res = await cb.submitAnswer(game, 'p1', CB_LIST_HIT, {
    expectedCategory: CB_CATEGORY,
    expectedRound: 2,
  });
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'stale_round');
  assert.equal(game.players[0].score, 0);
});

test('CB: legacy client (no context) still judged against the live category', async () => {
  const game = makeBlitzGame();
  const res = await cb.submitAnswer(game, 'p1', CB_LIST_HIT);
  assert.equal(res.accepted, true);
  assert.equal(game.players[0].score, 1);
});

test('CB: a valid answer for the DISPLAYED category is never rejected as off-category due to drift', async () => {
  // The player typed a valid "Types of cheese" answer. Even though we simulate the
  // server having a stale/other value, tagging the submission with the shown category
  // means it is judged against that list (accepted) — the pre-fix path would have
  // judged "cheddar" against the wrong category and rejected it.
  const game = makeBlitzGame();
  const res = await cb.submitAnswer(game, 'p1', CB_LIST_HIT, { expectedCategory: CB_CATEGORY });
  assert.equal(res.accepted, true);
  assert.notEqual(res.reason, 'not_in_category');
});

// ---------------------------------------------------------------------------
// Word Bomb — expectedCombo
// ---------------------------------------------------------------------------

function makeBombGame(combo) {
  const game = wb.createGame([{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }], 'medium');
  game.currentCombo = combo;
  game.status = 'in_progress';
  return game;
}

test('WB: stale expectedCombo → turn_over (NOT "MUST CONTAIN <new fragment>")', async () => {
  // Player typed "seed" for fragment EE; by the time it lands the live combo is IR.
  const game = makeBombGame('ir');
  const res = await wb.submitWord(game, 'seed', { expectedCombo: 'ee' });
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'turn_over');
  // Crucially, it did NOT surface the new fragment as a containment failure.
  assert.notEqual(res.reason, 'missing_combo');
  assert.equal(res.combo, undefined);
});

test('WB: legacy path (no expectedCombo) unchanged — stale word fails containment on live combo', async () => {
  const game = makeBombGame('ir');
  const res = await wb.submitWord(game, 'seed'); // "seed" has no "ir"
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'missing_combo');
  assert.equal(res.combo, 'ir');
});

test('WB: matching expectedCombo passes the context gate (falls through to normal checks)', async () => {
  const game = makeBombGame('ir');
  // expectedCombo matches the live combo, so the context gate is a no-op and the
  // word proceeds to the ordinary rules (here it is too short → not turn_over).
  const res = await wb.submitWord(game, 'xy', { expectedCombo: 'ir' });
  assert.equal(res.accepted, false);
  assert.notEqual(res.reason, 'turn_over');
  assert.equal(res.reason, 'too_short');
});
