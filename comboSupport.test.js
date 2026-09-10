// comboSupport.test.js — Word Bomb combo selection must track ANSWERABILITY, not length.
//
// The old model weighted combos by length (plus a pool-size bonus against the ~18k botWords
// corpus). Length is uncorrelated with whether a player can think of anything: "kle" is three
// letters and appears in ZERO of the 3,000 commonest English words; "ion" is three letters and
// appears in dozens. Measured on the old model, turn 32 served a combo with under 10 common words
// 49.7% of the time.
//
// SUPPORT = how many of the top 3,000 common words contain the combo (comboSupport.json, built by
// scripts/build-combo-support.js from data/top3k.txt). These tests check the shipped pool and the
// SERVED distribution — what actually reaches a player — rather than the table in isolation.
const test = require('node:test');
const assert = require('node:assert/strict');

const gameLogic = require('./gameLogic');
const TABLE = require('./comboSupport.json');

const {
  COMBOS,
  ALL_COMBOS,
  comboSupport,
  comboTargetSupport,
  comboDifficultyPressure,
  pickRandomCombo,
  COMBO_MIN_SERVE_SUPPORT,
  COMBO_MIN_POOL_SUPPORT,
} = gameLogic;

// The EXACT weighting pickRandomCombo uses, as a distribution rather than a sample: every combo's
// probability of being served at a given turn. Sampling is checked separately; this gives exact
// medians and tail shares without 100k draws per assertion.
function servedDistribution(turn) {
  const pressure = comboDifficultyPressure(turn);
  const target = Math.log(comboTargetSupport(pressure));
  const weights = COMBOS.map((c) => {
    const sup = comboSupport(c);
    if (sup < COMBO_MIN_SERVE_SUPPORT) return 0;
    return Math.exp(-2.0 * Math.abs(Math.log(sup) - target));
  });
  const total = weights.reduce((a, b) => a + b, 0);
  const pairs = COMBOS.map((c, i) => ({ support: comboSupport(c), p: weights[i] / total })).sort(
    (a, b) => a.support - b.support
  );
  let cum = 0;
  let median = null;
  let belowTen = 0;
  let belowFloor = 0;
  let mean = 0;
  for (const row of pairs) {
    cum += row.p;
    if (median === null && cum >= 0.5) median = row.support;
    if (row.support < 10) belowTen += row.p;
    if (row.support < COMBO_MIN_SERVE_SUPPORT) belowFloor += row.p;
    mean += row.support * row.p;
  }
  return { median, mean, belowTenPct: 100 * belowTen, belowFloorPct: 100 * belowFloor };
}

/* ----------------------------- the shipped pool ----------------------------- */

test('no shipped combo has support < 5, and the drop is recorded', () => {
  assert.equal(COMBO_MIN_POOL_SUPPORT, 5);
  for (const c of COMBOS) {
    assert.ok(comboSupport(c) >= 5, `"${c}" has support ${comboSupport(c)}`);
  }
  // The pool really is the source list minus the dead ends — not a hand-edited list that could
  // drift from the table.
  assert.equal(COMBOS.length, ALL_COMBOS.length - TABLE.dropped.length);
  console.log(
    `[combo] pool ${ALL_COMBOS.length} -> ${COMBOS.length} (dropped ${TABLE.dropped.length} with support < 5)`
  );
  const worst = TABLE.dropped.slice().sort((a, b) => a.support - b.support).slice(0, 8);
  console.log(`[combo] worst dropped: ${worst.map((d) => `${d.combo}=${d.support}`).join(' ')}`);
  // The specific dead ends the audit named must be gone.
  for (const dead of ['kle', 'zz', 'ung', 'ump', 'uck', 'squ', 'oat']) {
    assert.ok(!COMBOS.includes(dead), `"${dead}" is no longer shipped`);
  }
  assert.equal(TABLE.dropped.find((d) => d.combo === 'kle').support, 0, 'kle appears in none of the 3000');
});

test('every shipped combo is in the support table and the table has no strays', () => {
  for (const c of COMBOS) assert.ok(TABLE.support[c] !== undefined, `"${c}" is in the table`);
  for (const c of Object.keys(TABLE.support)) {
    assert.ok(ALL_COMBOS.includes(c), `table entry "${c}" is a real combo`);
  }
});

/* --------------------------- the served distribution --------------------------- */

test('served support by turn — the report', () => {
  console.log('[combo] turn | median | mean  | share <10 | share <8');
  for (const turn of [0, 8, 16, 32]) {
    const d = servedDistribution(turn);
    console.log(
      `[combo] ${String(turn).padStart(4)} | ${String(d.median).padStart(6)} | ${d.mean.toFixed(1).padStart(5)} | ` +
        `${`${d.belowTenPct.toFixed(1)}%`.padStart(9)} | ${`${d.belowFloorPct.toFixed(1)}%`.padStart(8)}`
    );
  }
});

test('turn 0: median served support >= 35 and under-10 share < 2%', () => {
  const d = servedDistribution(0);
  assert.ok(d.median >= 35, `median served support at turn 0 is ${d.median}`);
  assert.ok(d.belowTenPct < 2, `share below 10 at turn 0 is ${d.belowTenPct.toFixed(2)}%`);
});

test('turn 32: median served support 12-25 and NOTHING below 8', () => {
  const d = servedDistribution(32);
  assert.ok(d.median >= 12 && d.median <= 25, `median served support at turn 32 is ${d.median}`);
  assert.equal(d.belowFloorPct, 0, `share below 8 at turn 32 is ${d.belowFloorPct}%`);
});

test('the floor holds at EVERY turn, not just the two the brief names', () => {
  for (let turn = 0; turn <= 60; turn += 4) {
    const d = servedDistribution(turn);
    assert.equal(d.belowFloorPct, 0, `turn ${turn} serves nothing below ${COMBO_MIN_SERVE_SUPPORT}`);
  }
});

test('the ramp still slides one way: median support falls monotonically with turns', () => {
  const medians = [0, 8, 16, 24, 32].map((t) => servedDistribution(t).median);
  for (let i = 1; i < medians.length; i += 1) {
    assert.ok(medians[i] <= medians[i - 1], `median does not rise (${medians.join(' -> ')})`);
  }
  assert.ok(medians[0] > medians[medians.length - 1], 'turn 0 is easier than turn 32');
});

/* ------------------------------- real draws ------------------------------- */

test('20,000 draws never serve a combo outside COMBOS, or below the floor', () => {
  const pool = new Set(COMBOS);
  const seen = new Set();
  let lowest = Infinity;
  for (let i = 0; i < 20000; i += 1) {
    const turn = i % 40; // sweep the whole ramp, not one turn
    const c = pickRandomCombo(null, turn);
    assert.ok(pool.has(c), `draw ${i} (turn ${turn}) served "${c}", which is not in COMBOS`);
    lowest = Math.min(lowest, comboSupport(c));
    seen.add(c);
  }
  console.log(`[combo] 20,000 draws: ${seen.size} distinct combos, lowest support served ${lowest}`);
  assert.ok(lowest >= COMBO_MIN_SERVE_SUPPORT, `lowest support served was ${lowest}`);
  assert.ok(seen.size > 200, `the draw is not collapsing onto a handful of combos (${seen.size})`);
});

test('excludeCombo is still honoured, and never returns a dropped combo', () => {
  const dropped = new Set(TABLE.dropped.map((d) => d.combo));
  for (let i = 0; i < 2000; i += 1) {
    const prev = COMBOS[i % COMBOS.length];
    const next = pickRandomCombo(prev, i % 40);
    assert.notEqual(next, prev, 'the combo visibly changes from one turn to the next');
    assert.ok(!dropped.has(next), `"${next}" was dropped and must never be served`);
  }
});
