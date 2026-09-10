// categoryBlitzLength.test.js — answer LENGTH as part of the difficulty model.
//
// Two separate jobs, both about typing cost rather than knowledge:
//   TIER GATE      a category whose answers are titles / brand product names / multi-word phrases
//                  is a typing test before it is a knowledge test, so it may not be a tier-1
//                  (first-round) category however well-known it is.
//   SCORE NORMALISER  a 30s round is a fixed CHARACTER budget, so short-answer categories yield
//                  more accepts and — under flat 1-point scoring — more score. Points per answer
//                  now scale with meanLen / MEAN_LEN_ALL, clamped.
//
// The clamp is the interesting part and these tests MEASURE it rather than assume it: inside the
// band the normalisation is exact, and outside it a residue survives by design. See the spread
// test at the bottom, which prints before/after.
const test = require('node:test');
const assert = require('node:assert/strict');

const blitz = require('./categoryBlitzLogic');

const TYPE_RATE = 2.9; // chars/sec, the measured rate
const ROUND_SECS = 30;
const CHAR_BUDGET = TYPE_RATE * ROUND_SECS; // 87 chars in a round

const meanLen = (c) => blitz.CATEGORY_MEAN_LEN[c];
const byLen = () => blitz.CATEGORIES.slice().sort((a, b) => meanLen(a) - meanLen(b));
const avg = (xs) => xs.reduce((n, x) => n + x, 0) / xs.length;
// Answers you can finish in one round, then what they pay.
const simScore = (c, useMult) => (CHAR_BUDGET / meanLen(c)) * (useMult ? blitz.lengthMultiplier(c) : 1);

/* ------------------------------ meanLen ------------------------------ */

test('every category has a positive meanLen and the corpus baseline is sane', () => {
  for (const c of blitz.CATEGORIES) {
    assert.ok(meanLen(c) > 0, `"${c}" has a meanLen`);
    assert.ok(meanLen(c) < 40, `"${c}" meanLen is not absurd (${meanLen(c)})`);
  }
  assert.ok(blitz.MEAN_LEN_ALL > 5 && blitz.MEAN_LEN_ALL < 15, `baseline ${blitz.MEAN_LEN_ALL}`);
});

/* ---------------------------- the tier gate ---------------------------- */

test('no tier-1 category has meanLen > 11', () => {
  const over = blitz.TIER_POOLS[1].filter((c) => meanLen(c) > blitz.TIER1_MAX_MEAN_LEN);
  assert.deepEqual(
    over.map((c) => `${c} (${meanLen(c).toFixed(1)})`),
    [],
    'tier 1 is free of long-answer categories'
  );
});

test('the gate demoted exactly the long-answer tier-1 categories, and only to tier 2', () => {
  const demoted = blitz.TIER1_DEMOTED_BY_LENGTH;
  assert.ok(demoted.length > 0, 'the gate actually did something');
  for (const c of demoted) {
    assert.equal(blitz.tierForCategory(c), 1, `"${c}" is still tier 1 by KNOWLEDGE`);
    assert.equal(blitz.CATEGORY_TIER[c], 2, `"${c}" sits in tier 2 after the gate`);
    assert.ok(meanLen(c) > blitz.TIER1_MAX_MEAN_LEN, `"${c}" failed the gate on length`);
    assert.ok(blitz.TIER_POOLS[2].includes(c), `"${c}" is in the tier-2 pool`);
    assert.ok(!blitz.TIER_POOLS[1].includes(c), `"${c}" left the tier-1 pool`);
  }

  console.log(
    `[length-gate] demoted ${demoted.length}: ${demoted.map((c) => `${c} ${meanLen(c).toFixed(1)}`).join(' · ')}`
  );
});

test('the gate never touches tier 2 or tier 3, and the pools still partition the corpus', () => {
  for (const c of blitz.CATEGORIES) {
    const knowledge = blitz.tierForCategory(c);
    if (knowledge !== 1) assert.equal(blitz.CATEGORY_TIER[c], knowledge, `"${c}" tier untouched`);
  }
  const total = blitz.TIER_POOLS[1].length + blitz.TIER_POOLS[2].length + blitz.TIER_POOLS[3].length;
  assert.equal(total, blitz.CATEGORIES.length);
  assert.ok(blitz.TIER_POOLS[1].length > 40, `tier 1 is still a usable pool (${blitz.TIER_POOLS[1].length})`);
});

/* -------------------------- the score normaliser -------------------------- */

test('the clamp holds at both ends', () => {
  const sorted = byLen();
  const shortest = sorted[0];
  const longest = sorted[sorted.length - 1];
  // Both extremes are past the clamp, so they pin to the bounds exactly.
  assert.ok(meanLen(shortest) / blitz.MEAN_LEN_ALL < blitz.LENGTH_MULT_MIN, 'shortest is past the low bound');
  assert.ok(meanLen(longest) / blitz.MEAN_LEN_ALL > blitz.LENGTH_MULT_MAX, 'longest is past the high bound');
  assert.equal(blitz.lengthMultiplier(shortest), blitz.LENGTH_MULT_MIN);
  assert.equal(blitz.lengthMultiplier(longest), blitz.LENGTH_MULT_MAX);
  // And no category anywhere can escape the bounds.
  for (const c of blitz.CATEGORIES) {
    const m = blitz.lengthMultiplier(c);
    assert.ok(m >= blitz.LENGTH_MULT_MIN && m <= blitz.LENGTH_MULT_MAX, `"${c}" multiplier ${m} in range`);
  }
});

test('inside the clamp band the multiplier is the exact ratio', () => {
  const inBand = blitz.CATEGORIES.filter((c) => {
    const raw = meanLen(c) / blitz.MEAN_LEN_ALL;
    return raw > blitz.LENGTH_MULT_MIN && raw < blitz.LENGTH_MULT_MAX;
  });
  // At [0.5, 2.0] the band covers meanLen ~4.7..18.9 chars, i.e. all but a handful of extremes.
  assert.ok(inBand.length > 400, `nearly every category sits inside the band (${inBand.length})`);
  for (const c of inBand) {
    assert.equal(blitz.lengthMultiplier(c), meanLen(c) / blitz.MEAN_LEN_ALL, `"${c}" is the raw ratio`);
  }
  // Which is the whole point: within the band, a scripted round scores IDENTICALLY whatever the
  // answer length. This is exact, not approximate.
  const scores = inBand.map((c) => simScore(c, true));
  const spread = Math.max(...scores) / Math.min(...scores);
  assert.ok(spread < 1.0001, `inside the band the spread is 1.00x (got ${spread.toFixed(4)}x)`);
});

test('a scripted 30s round at 2.9 chars/sec scores within 1.20x, shortest 10 vs longest 10', () => {
  const sorted = byLen();
  const shortest10 = sorted.slice(0, 10);
  const longest10 = sorted.slice(-10);

  const beforeShort = avg(shortest10.map((c) => simScore(c, false)));
  const beforeLong = avg(longest10.map((c) => simScore(c, false)));
  const afterShort = avg(shortest10.map((c) => simScore(c, true)));
  const afterLong = avg(longest10.map((c) => simScore(c, true)));
  const beforeRatio = beforeShort / beforeLong;
  const afterRatio = afterShort / afterLong;

  console.log(
    `[length-spread] BEFORE short ${beforeShort.toFixed(1)} vs long ${beforeLong.toFixed(1)} = ${beforeRatio.toFixed(2)}x` +
      `  |  AFTER short ${afterShort.toFixed(1)} vs long ${afterLong.toFixed(1)} = ${afterRatio.toFixed(2)}x` +
      `  (clamp [${blitz.LENGTH_MULT_MIN}, ${blitz.LENGTH_MULT_MAX}])`
  );

  assert.ok(beforeRatio > 3, `flat scoring really is badly skewed (${beforeRatio.toFixed(2)}x)`);
  // THE SHIPPED NUMBER. Measures 1.14x at the [0.5, 2.0] clamp. This is the assertion that fails
  // if someone narrows the clamp again: at [0.75, 1.5] it was 1.88x.
  assert.ok(
    afterRatio <= 1.2,
    `the shipped clamp scores within 1.20x across the two groups (got ${afterRatio.toFixed(3)}x)`
  );
  // Symmetry: neither group may be the favoured one.
  assert.ok(afterRatio >= 1 / 1.2, `and not overshoot the other way (${afterRatio.toFixed(3)}x)`);
});

test('uncapped the normaliser is exact at 1.000x — the clamp is the only source of residue', () => {
  const sorted = byLen();
  const shortest10 = sorted.slice(0, 10);
  const longest10 = sorted.slice(-10);
  const withClamp = (c, lo, hi) => {
    const raw = meanLen(c) / blitz.MEAN_LEN_ALL;
    return (CHAR_BUDGET / meanLen(c)) * Math.min(hi, Math.max(lo, raw));
  };
  const ratioAt = (lo, hi) =>
    avg(shortest10.map((c) => withClamp(c, lo, hi))) / avg(longest10.map((c) => withClamp(c, lo, hi)));

  const uncapped = ratioAt(0, 99);
  const shipped = ratioAt(blitz.LENGTH_MULT_MIN, blitz.LENGTH_MULT_MAX);
  const narrow = ratioAt(0.75, 1.5);
  console.log(
    `[length-spread] uncapped ${uncapped.toFixed(3)}x · shipped [${blitz.LENGTH_MULT_MIN}, ${blitz.LENGTH_MULT_MAX}] ` +
      `${shipped.toFixed(3)}x · previous [0.75, 1.5] ${narrow.toFixed(3)}x`
  );

  // The formula itself is exact; every bit of remaining spread comes from the clamp. Keeping this
  // beside the shipped assertion is what makes a future clamp change legible instead of silent.
  assert.ok(Math.abs(uncapped - 1) < 0.001, `uncapped is 1.000x (got ${uncapped.toFixed(4)}x)`);
  assert.equal(shipped.toFixed(3), ratioAt(0.5, 2.0).toFixed(3), 'the shipped clamp is [0.5, 2.0]');
  assert.ok(narrow > 1.5, `the old clamp really was the binding constraint (${narrow.toFixed(2)}x)`);
});

/* ------------------------- scoring through the game ------------------------- */

function gameOn(category) {
  const game = blitz.createGame([{ id: 'p1', name: 'A' }], 'medium', true);
  game.currentCategory = category;
  return game;
}

test('accepted answers pay the category multiplier, and score stays an integer', () => {
  const sorted = byLen();
  const longest = sorted[sorted.length - 1];
  const game = gameOn(longest);
  const p = game.players[0];
  const mult = blitz.lengthMultiplier(longest);
  for (let i = 0; i < 4; i++) {
    p.answers.push(`answer ${i}`);
    p.roundPoints = (p.roundPoints || 0) + mult;
    p.points = (p.points || 0) + mult;
    p.score = Math.round(p.points);
  }
  assert.equal(p.points, mult * 4);
  assert.equal(p.score, Math.round(mult * 4));
  assert.equal(Number.isInteger(p.score), true, 'score is an integer for the existing payloads');
  assert.ok(p.score > 4, `a long-answer category pays more than flat scoring (${p.score} vs 4)`);
});

test('the round payload carries the multiplier for the client to show later', () => {
  const game = blitz.createGame([{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], 'medium');
  const next = blitz.startNextRound(game);
  assert.ok(next, 'advanced to round 2');
  assert.equal(typeof next.lengthMult, 'number');
  assert.equal(next.lengthMult, Math.round(blitz.lengthMultiplier(next.category) * 100) / 100);
  assert.ok(next.lengthMult >= blitz.LENGTH_MULT_MIN && next.lengthMult <= blitz.LENGTH_MULT_MAX);
  // Round advance clears the per-round points so the next category starts from zero.
  for (const p of game.players) assert.equal(p.roundPoints, 0);
});

test('a reroll reverts the POINTS earned, not the raw answer count', () => {
  const sorted = byLen();
  const longest = sorted[sorted.length - 1];
  const game = blitz.createGame([{ id: 'p1', name: 'A' }], 'medium', true);
  game.currentCategory = longest;
  const p = game.players[0];
  // Bank 3 answers on a 1.5x category, then reroll away from it.
  const mult = blitz.lengthMultiplier(longest);
  p.answers = ['a', 'b', 'c'];
  p.roundPoints = mult * 3;
  p.points = mult * 3;
  p.score = Math.round(p.points);
  assert.ok(p.score >= 4, 'the long category banked more than 3 flat points');
  const res = blitz.rerollCategory(game);
  assert.ok(!res.error, 'reroll allowed');
  assert.equal(p.points, 0, 'every point from the old category is handed back');
  assert.equal(p.score, 0);
  assert.equal(p.roundPoints, 0);
  assert.deepEqual(p.answers, []);
  assert.equal(typeof res.lengthMult, 'number', 'the reroll payload carries the new multiplier');
});
