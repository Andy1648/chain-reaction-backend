// categoryBlitzTiers.test.js
// Run with: node --test categoryBlitzTiers.test.js  (or npm test)
//
// Covers the Daily escalating tier ramp + regular-room tier weighting:
//   - every active category has a breadth tier (1 broad / 2 medium / 3 niche)
//   - the Daily is deterministic per day AND an escalating 1->2->3 ramp
//   - regular-room draws are weighted ~50/35/15 across tiers
//   - pack filtering (and no-repeat) still holds under the weighting

const test = require('node:test');
const assert = require('node:assert/strict');

const blitz = require('./categoryBlitzLogic');
const CATEGORY_PACKS = require('./categoryPacks');

test('every active category has a tier 1/2/3 and all tiers are populated', () => {
  for (const c of blitz.CATEGORIES) {
    assert.ok([1, 2, 3].includes(blitz.CATEGORY_TIER[c]), `"${c}" has no valid tier`);
  }
  assert.ok(blitz.TIER_POOLS[1].length > 0, 'tier 1 (broad) pool non-empty');
  assert.ok(blitz.TIER_POOLS[2].length > 0, 'tier 2 (medium) pool non-empty');
  assert.ok(blitz.TIER_POOLS[3].length > 0, 'tier 3 (niche) pool non-empty');
  // Pools partition the active set exactly.
  const total = blitz.TIER_POOLS[1].length + blitz.TIER_POOLS[2].length + blitz.TIER_POOLS[3].length;
  assert.equal(total, blitz.CATEGORIES.length);
});

test('the Daily is deterministic per day AND an escalating 1->2->3 tier ramp', () => {
  const key = '2026-07-25';
  const a = blitz.dailyCategories(key);
  const b = blitz.dailyCategories(key);
  assert.deepEqual(a, b, 'same day number -> identical categories in identical order');
  assert.equal(a.length, blitz.TOTAL_ROUNDS);
  assert.deepEqual(
    a.map((c) => blitz.CATEGORY_TIER[c]),
    [1, 2, 3],
    'rounds escalate broad -> medium -> niche'
  );
  assert.equal(new Set(a).size, a.length, 'no repeated category within a day');

  // A different day yields a different board, still in 1/2/3 order.
  const c = blitz.dailyCategories('2026-07-26');
  assert.notDeepEqual(c, a, 'a different day gives a different board');
  assert.deepEqual(c.map((x) => blitz.CATEGORY_TIER[x]), [1, 2, 3]);

  // Deterministic across arbitrary days (re-running is identical, always 1/2/3).
  for (const day of ['2026-01-01', '2026-06-15', '2027-03-09', '2030-12-31']) {
    assert.deepEqual(blitz.dailyCategories(day), blitz.dailyCategories(day), `${day} deterministic`);
    assert.deepEqual(blitz.dailyCategories(day).map((x) => blitz.CATEGORY_TIER[x]), [1, 2, 3], `${day} ramp`);
  }
});

test('regular-room draws are weighted ~50/35/15 across tiers (within tolerance)', () => {
  const N = 4000;
  const cnt = { 1: 0, 2: 0, 3: 0 };
  for (let i = 0; i < N; i++) cnt[blitz.CATEGORY_TIER[blitz.pickRandomCategory()]] += 1;
  const p = (t) => cnt[t] / N;
  // Weights are 0.50/0.35/0.15; over 4000 draws the sampling error is ~0.008, so
  // a ±0.05/±0.04 band is many sigma of slack (never flaky) while still catching
  // a broken (e.g. uniform ~0.33 each) distribution.
  assert.ok(Math.abs(p(1) - 0.5) < 0.05, `tier1 ${p(1).toFixed(3)} ~ 0.50`);
  assert.ok(Math.abs(p(2) - 0.35) < 0.05, `tier2 ${p(2).toFixed(3)} ~ 0.35`);
  assert.ok(Math.abs(p(3) - 0.15) < 0.04, `tier3 ${p(3).toFixed(3)} ~ 0.15`);
  // Broad must clearly dominate niche (the whole point).
  assert.ok(cnt[1] > cnt[3] * 2, 'broad draws far outnumber niche');
});

test('pack filtering (and no-repeat) still holds under tier weighting', () => {
  const allowed = new Set(['food', 'animals']);
  for (let i = 0; i < 1500; i++) {
    const c = blitz.pickRandomCategory(null, ['food', 'animals']);
    assert.ok(allowed.has(CATEGORY_PACKS[c]), `"${c}" (${CATEGORY_PACKS[c]}) leaked past the pack filter`);
  }
  // A full game's worth of picks never repeats a category, even pack-filtered.
  const played = new Set();
  for (let r = 0; r < blitz.TOTAL_ROUNDS; r++) {
    const c = blitz.pickRandomCategory(played, ['food', 'animals']);
    assert.ok(!played.has(c), 'no repeated category across rounds');
    assert.ok(allowed.has(CATEGORY_PACKS[c]));
    played.add(c);
  }
});

// ---- fix/blitz-tiers ----------------------------------------------------------

// Play-tested as enthusiast-only: these read as "medium" on paper but most players
// stall after one or two answers, so they are niche (tier 3), never round 1/2 material.
const RETIERED_TO_NICHE = [
  'Taxonomic domains and phyla', 'Cell organelles', 'Human endocrine hormones',
  'Historical peace treaties', 'Ancient Greek city-states', 'Greek City-States', 'Famous poets',
  'Greek and Roman mythology figures', 'Greek gods', 'Operating systems', 'TV soap operas',
  'Latin American countries',
];

test('the play-tested medium→niche moves are tier 3 (and still active)', () => {
  for (const c of RETIERED_TO_NICHE) {
    assert.ok(blitz.CATEGORIES.includes(c), `"${c}" is an active category`);
    assert.equal(blitz.tierForCategory(c), 3, `"${c}" is niche`);
    assert.equal(blitz.CATEGORY_TIER[c], 3, `"${c}" stored tier is niche`);
    assert.ok(blitz.TIER_POOLS[3].includes(c), `"${c}" is in the niche pool`);
    assert.ok(!blitz.TIER_POOLS[2].includes(c), `"${c}" left the medium pool`);
  }
});

const PLAYERS = [{ id: 'h', name: 'Host' }];
const firstTier = (opts, packs = null) =>
  blitz.CATEGORY_TIER[blitz.createGame(PLAYERS, 'medium', true, packs, null, opts).currentCategory];

test('a host with NO prior Blitz record gets a tier-1 (broad) first round, every time', () => {
  for (let i = 0; i < 500; i++) {
    assert.equal(firstTier({ hostHasBlitzRecord: false }), 1);
  }
  // Under a pack filter that HAS broad categories, the first round is broad AND in-pack.
  for (let i = 0; i < 300; i++) {
    const g = blitz.createGame(PLAYERS, 'medium', true, ['food'], null, { hostHasBlitzRecord: false });
    assert.equal(blitz.CATEGORY_TIER[g.currentCategory], 1);
    assert.equal(CATEGORY_PACKS[g.currentCategory], 'food');
  }
});

test('a fresh host + a pack with no broad category keeps the pack (the filter wins over the tier)', () => {
  // history has zero tier-1 categories: the tier restriction is dropped, the pack is not.
  assert.equal(blitz.TIER_POOLS[1].filter((c) => CATEGORY_PACKS[c] === 'history').length, 0);
  for (let i = 0; i < 200; i++) {
    const g = blitz.createGame(PLAYERS, 'medium', true, ['history'], null, { hostHasBlitzRecord: false });
    assert.equal(CATEGORY_PACKS[g.currentCategory], 'history');
  }
});

test('a host WITH a record (or an unknown/older client) keeps the weighted first-round draw', () => {
  for (const opts of [{ hostHasBlitzRecord: true }, {}, undefined]) {
    const tiers = new Set();
    for (let i = 0; i < 600; i++) tiers.add(firstTier(opts));
    // ~50/35/15 over 600 draws: medium AND niche both appear (P(miss) ≈ 0.85^600 / 0.65^600).
    assert.ok(tiers.has(2) && tiers.has(3), `weighted draw reaches tier 2 and 3 (${[...tiers]})`);
  }
});

test('the Daily is untouched by the fresh-host rule (its plan already opens broad)', () => {
  const daily = { dayNumber: 1, dateKey: '2026-07-25' };
  const plan = blitz.dailyCategories(daily.dateKey);
  const g = blitz.createGame(PLAYERS, 'medium', true, null, daily, { hostHasBlitzRecord: false });
  assert.equal(g.currentCategory, plan[0]);
});

test('pickRandomCategory(…, onlyTier) draws that tier only, and no-repeat still holds', () => {
  const played = new Set();
  for (let i = 0; i < 40; i++) {
    const c = blitz.pickRandomCategory(played, null, 1);
    assert.equal(blitz.CATEGORY_TIER[c], 1);
    assert.ok(!played.has(c));
    played.add(c);
  }
});
