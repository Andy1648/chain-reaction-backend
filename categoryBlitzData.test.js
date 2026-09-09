// categoryBlitzData.test.js (fix/blitz-data)
// Run with: node --test categoryBlitzData.test.js  (or npm test)
//
// Guards the four fixes from the mechanical audit of all 446 categories / 29,369 answers:
//   1. no category appears twice under a different spelling/case (4 exact duplicates were merged)
//   2. 13 quiz-bowl subjects sit in tier 3 (niche), not tier 2 (casual)
//   3. round 1 of a game whose host has no prior Blitz record draws from tier 1 only
//   4. four answers that are not members of their category are no longer accepted

const test = require('node:test');
const assert = require('node:assert/strict');

const blitz = require('./categoryBlitzLogic');
const CATEGORY_ANSWERS = require('./categoryAnswers');
const CATEGORY_PACKS = require('./categoryPacks');

// The pairs that were merged: [keeper, deleted duplicate].
const MERGED_PAIRS = [
  ['Disney villains', 'Disney Villains'],
  ['Minecraft mobs', 'Minecraft Mobs'],
  ['Donut types', 'Types of donuts'],
  ['Major world deserts', 'World deserts'],
];

// Quiz-bowl subjects moved from tier 2 to tier 3.
const MOVED_TO_NICHE = [
  'Taxonomic domains and phyla',
  'Cell organelles',
  'Human endocrine hormones',
  'Historical peace treaties',
  'Ancient Greek city-states',
  'Greek City-States',
  'Famous poets',
  'Greek and Roman mythology figures',
  'Greek gods',
  'Operating systems',
  'TV soap operas',
  'Latin American countries',
  'Professional wrestling championships',
];

// Answers that are not members of their category.
const WRONG_ACCEPTS = [
  ['Ancient Empires', 'ottoman'],
  ['Pizza toppings', 'stuffed crust'],
  ['Fast food chains', 'village inn'],
  ['US First Ladies', 'mary harrison'],
];

/* ------------------------------ 1. duplicates ------------------------------ */

test('no two active categories share a normalised name', () => {
  const byNormalised = new Map();
  for (const category of blitz.CATEGORIES) {
    const key = blitz.normalizeCategoryKey(category);
    byNormalised.set(key, [...(byNormalised.get(key) || []), category]);
  }
  const duplicates = [...byNormalised.entries()].filter(([, names]) => names.length > 1);
  assert.deepEqual(duplicates, [], `duplicate categories: ${JSON.stringify(duplicates)}`);
});

test('each merged duplicate is gone from the pool and its answers live on the keeper', () => {
  for (const [keeper, removed] of MERGED_PAIRS) {
    assert.ok(blitz.CATEGORIES.includes(keeper), `keeper "${keeper}" is still an active category`);
    assert.ok(!blitz.CATEGORIES.includes(removed), `duplicate "${removed}" left the pool`);
    // It must also be gone from the pack map — every pack key is appended to the pool, so a
    // leftover entry there would silently put the duplicate straight back in.
    assert.ok(!(removed in CATEGORY_PACKS), `duplicate "${removed}" left categoryPacks.js`);
    // The merge is not allowed to lose answers: the keeper still resolves to a real accept-list.
    const answers = CATEGORY_ANSWERS[keeper];
    assert.ok(answers && answers.size > 0, `keeper "${keeper}" kept a non-empty accept-list`);
  }
});

test('a merged duplicate still ANSWERS as its keeper (no accept-list was orphaned)', () => {
  // 'World deserts' folded into 'Major world deserts'; a sahara answer must still be accepted
  // under the keeper, and the keeper must carry entries the loser contributed.
  const deserts = CATEGORY_ANSWERS['Major world deserts'];
  assert.ok(deserts.has('sahara'), 'the keeper accepts a core answer');
  const donuts = CATEGORY_ANSWERS['Donut types'];
  assert.ok(donuts.has('long john'), "the keeper gained 'long john' from the folded duplicate");
});

/* ------------------------------- 2. tiers --------------------------------- */

test('the 13 quiz-bowl categories are tier 3 (niche), not tier 2', () => {
  for (const category of MOVED_TO_NICHE) {
    assert.ok(blitz.CATEGORIES.includes(category), `"${category}" is still an active category`);
    assert.equal(blitz.CATEGORY_TIER[category], 3, `"${category}" is tier 3`);
    assert.ok(blitz.TIER_POOLS[3].includes(category), `"${category}" sits in the tier-3 pool`);
    assert.ok(!blitz.TIER_POOLS[2].includes(category), `"${category}" left the tier-2 pool`);
  }
});

test('tierForCategory agrees with the stored tier for the moved categories', () => {
  // CATEGORY_TIER is computed once at load from tierForCategory; a category forced to MEDIUM by
  // the override set (this is what 'Greek gods' was) would disagree here.
  for (const category of MOVED_TO_NICHE) {
    assert.equal(blitz.tierForCategory(category), 3, `tierForCategory("${category}") is 3`);
  }
});

/* --------------------------- 3. fresh-host round 1 ------------------------- */

// Deterministic RNG (mulberry32) so the 2,000 draws are reproducible.
function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('fresh-host round 1 draws tier 1 only — 2,000 seeded draws', () => {
  const rng = seededRng(20260909);
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const category = blitz.pickBroadCategory(null, rng);
    assert.equal(
      blitz.CATEGORY_TIER[category],
      1,
      `draw ${i} returned "${category}" (tier ${blitz.CATEGORY_TIER[category]})`
    );
    seen.add(category);
  }
  // Sanity: the draw is not pinned to one category.
  assert.ok(seen.size > 20, `2,000 draws covered ${seen.size} distinct broad categories`);
});

test('fresh-host round 1 goes through createGame — 2,000 seeded games', () => {
  // The real path: startGame passes { freshHost } into createGame, which must use the broad-only
  // draw for round 1. Math.random is stubbed so the run is reproducible.
  const realRandom = Math.random;
  Math.random = seededRng(77);
  try {
    for (let i = 0; i < 2000; i++) {
      const game = blitz.createGame([{ id: 'p1', name: 'HOST' }], 'medium', true, null, null, {
        freshHost: true,
      });
      assert.equal(
        blitz.CATEGORY_TIER[game.currentCategory],
        1,
        `game ${i} opened on "${game.currentCategory}" (tier ${blitz.CATEGORY_TIER[game.currentCategory]})`
      );
    }
  } finally {
    Math.random = realRandom;
  }
});

test('a host WITH a prior record still gets the normal weighted draw (all tiers reachable)', () => {
  const realRandom = Math.random;
  Math.random = seededRng(9001);
  try {
    const tiers = new Set();
    for (let i = 0; i < 2000; i++) {
      const game = blitz.createGame([{ id: 'p1', name: 'HOST' }], 'medium', true, null, null, {});
      tiers.add(blitz.CATEGORY_TIER[game.currentCategory]);
    }
    assert.deepEqual([...tiers].sort(), [1, 2, 3], 'the returning-host draw still reaches every tier');
  } finally {
    Math.random = realRandom;
  }
});

test('fresh-host round 1 respects the pack filter, and survives a pack with no broad category', () => {
  const rng = seededRng(5);
  // A pack that HAS broad categories: every draw is tier 1 AND inside the pack.
  const packWithBroad = [...new Set(Object.values(CATEGORY_PACKS))].find((pack) =>
    blitz.CATEGORIES.some((c) => CATEGORY_PACKS[c] === pack && blitz.CATEGORY_TIER[c] === 1)
  );
  assert.ok(packWithBroad, 'found a pack containing broad categories');
  for (let i = 0; i < 200; i++) {
    const category = blitz.pickBroadCategory([packWithBroad], rng);
    assert.equal(blitz.CATEGORY_TIER[category], 1, `"${category}" is broad`);
  }
  // An unknown pack selects nothing, so categoriesForPacks falls back to the full pool — the draw
  // must still return a real category rather than throwing or returning null.
  const fallback = blitz.pickBroadCategory(['no-such-pack'], rng);
  assert.ok(blitz.CATEGORIES.includes(fallback), 'unknown pack still yields an active category');
});

/* ---------------------------- 4. wrong accepts ---------------------------- */

test('the four audited wrong answers are no longer accepted', () => {
  for (const [category, answer] of WRONG_ACCEPTS) {
    const keys = Object.keys(CATEGORY_ANSWERS).filter(
      (k) => blitz.normalizeCategoryKey(k) === blitz.normalizeCategoryKey(category)
    );
    assert.ok(keys.length > 0, `"${category}" has an accept-list`);
    for (const key of keys) {
      assert.ok(!CATEGORY_ANSWERS[key].has(answer), `"${key}" no longer accepts "${answer}"`);
    }
  }
});

test('removing the wrong answers did not empty or gut those categories', () => {
  for (const [category] of WRONG_ACCEPTS) {
    const answers = CATEGORY_ANSWERS[category];
    assert.ok(answers && answers.size > 10, `"${category}" kept a usable accept-list (${answers.size})`);
  }
  // Spot-check that a correct neighbour answer survived each removal.
  assert.ok(CATEGORY_ANSWERS['Pizza toppings'].has('pepperoni'), 'pizza toppings kept pepperoni');
  assert.ok(CATEGORY_ANSWERS['Fast food chains'].has('mcdonalds'), 'fast food chains kept mcdonalds');
  assert.ok(CATEGORY_ANSWERS['US First Ladies'].has('michelle obama'), 'first ladies kept michelle obama');
  assert.ok(CATEGORY_ANSWERS['Ancient Empires'].has('rome'), 'ancient empires kept rome');
});
