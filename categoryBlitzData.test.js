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
  ['Empires and dynasties', 'ottoman'],
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
  assert.ok(CATEGORY_ANSWERS['Empires and dynasties'].has('rome'), 'empires kept rome');
});

/* -------------------- 4b. near-variants of the wrong accepts -------------------- */
// Removing "ottoman" while "ottomans", "ottoman empire" and "ottaman empire" stayed accepted
// left the wrong answer one plural away. The removal step now matches NORMALISED (case,
// punctuation, spacing, plurals) and deletes every variant, whichever source file contributed it.
// These tests assert the whole merge → gen9 → FOLDS → REMOVALS chain ends with none surviving.

// Every concrete answer the step deleted, as { category, answer, seed }.
const REMOVED = CATEGORY_ANSWERS.__removed;
const normalizeAnswer = CATEGORY_ANSWERS.__normalizeAnswer;
const REMOVAL_SEEDS = CATEGORY_ANSWERS.__removalSeeds;

// Variants that MUST be gone even though the audit only named the base answer.
const KNOWN_VARIANTS = [
  ['Empires and dynasties', 'ottomans'],
  ['Empires and dynasties', 'ottoman empire'],
  ['Empires and dynasties', 'ottaman empire'],
];

const keysFor = (category) =>
  Object.keys(CATEGORY_ANSWERS).filter(
    (k) => blitz.normalizeCategoryKey(k) === blitz.normalizeCategoryKey(category)
  );

test('the removal step reports what it deleted, and it deleted more than the four seeds', () => {
  assert.ok(Array.isArray(REMOVED), 'the step exposes a removal log');
  assert.ok(REMOVED.length >= WRONG_ACCEPTS.length, `removed ${REMOVED.length} answers`);
  // The log is exposed non-enumerably so `answers` still maps category -> Set for every consumer
  // that iterates it (categoryBlitzLogic.js builds its index with Object.entries).
  assert.ok(!Object.keys(CATEGORY_ANSWERS).includes('__removed'), 'the log is not an enumerable category');
  for (const row of REMOVED) {
    assert.equal(typeof row.answer, 'string');
    assert.equal(typeof row.seed, 'string');
  }
});

test('no removed answer survives the merge/fold chain — exact form', () => {
  for (const { category, answer } of REMOVED) {
    for (const key of keysFor(category)) {
      assert.ok(!CATEGORY_ANSWERS[key].has(answer), `"${key}" still accepts the removed "${answer}"`);
    }
  }
});

test('no NORMALISED variant of a removed answer survives — plural, spacing, punctuation, case', () => {
  for (const [category, seeds] of Object.entries(REMOVAL_SEEDS)) {
    const banned = new Set(seeds.map(normalizeAnswer));
    for (const key of keysFor(category)) {
      for (const entry of CATEGORY_ANSWERS[key]) {
        assert.ok(
          !banned.has(normalizeAnswer(entry)),
          `"${key}" still accepts "${entry}", which normalises onto a removed answer`
        );
      }
    }
  }
});

test('the specific named variants are gone (the plural/misspelling that made this a bug)', () => {
  for (const [category, variant] of KNOWN_VARIANTS) {
    for (const key of keysFor(category)) {
      assert.ok(!CATEGORY_ANSWERS[key].has(variant), `"${key}" no longer accepts "${variant}"`);
    }
    // It really was in the data — otherwise this test would pass vacuously forever.
    assert.ok(
      REMOVED.some((r) => r.answer === variant),
      `"${variant}" appears in the removal log (it was present before the step ran)`
    );
  }
});

test('the normaliser folds only case/punctuation/spacing/plurals, never distinct answers', () => {
  assert.equal(normalizeAnswer('Ottomans'), normalizeAnswer('ottoman'));
  assert.equal(normalizeAnswer('  OTTOMAN   EMPIRE '), normalizeAnswer('ottoman empire'));
  assert.equal(normalizeAnswer("Wendy's"), normalizeAnswer('wendys'));
  assert.equal(normalizeAnswer('french-fries'), normalizeAnswer('french fries'));
  // Distinct answers must NOT collapse — the sweep would otherwise eat legitimate entries.
  assert.notEqual(normalizeAnswer('ottoman empire'), normalizeAnswer('ottaman empire'));
  assert.notEqual(normalizeAnswer('ottoman'), normalizeAnswer('ottoman empire'));
  assert.notEqual(normalizeAnswer('thin crust'), normalizeAnswer('stuffed crust'));
  assert.notEqual(normalizeAnswer('anna harrison'), normalizeAnswer('mary harrison'));
});

test('the variant sweep did not eat legitimate neighbours', () => {
  // Ancient empires that ARE ancient must survive the ottoman sweep.
  for (const keep of ['roman empire', 'persian empire', 'byzantine empire', 'mongol empire', 'aztec empire']) {
    assert.ok(CATEGORY_ANSWERS['Empires and dynasties'].has(keep), `empires kept "${keep}"`);
  }
  // Real First Ladies who share a first or last name with the removed one.
  for (const keep of ['anna harrison', 'caroline harrison', 'mary todd lincoln']) {
    assert.ok(CATEGORY_ANSWERS['US First Ladies'].has(keep), `first ladies kept "${keep}"`);
  }
  assert.ok(CATEGORY_ANSWERS['Pizza toppings'].size > 150, 'pizza toppings kept its list');
});

/* ------------------------- 5. the Empires rename ------------------------- */
// 'Ancient Empires' asked players to know where "ancient" stops, and its own list never agreed:
// the Ottoman/British/Holy Roman entries were cut as post-500, but Tang, Khmer, Mali, Songhai,
// Ming, Mongol, Aztec and Inca are post-500 too and are all fair answers. Renaming makes every
// one of them correct. The rename is a FOLD, so no accept is lost.
const OLD_NAME = 'Ancient Empires';
const NEW_NAME = 'Empires and dynasties';

test('the old category name is gone from every map', () => {
  assert.ok(!blitz.CATEGORIES.includes(OLD_NAME), 'not an active category');
  assert.ok(!(OLD_NAME in CATEGORY_PACKS), 'not in the pack map (which feeds RAW_CATEGORIES)');
  assert.ok(!CATEGORY_ANSWERS[OLD_NAME], 'no orphaned accept-list left under the old key');
  assert.notEqual(blitz.tierForCategory(OLD_NAME), undefined);
});

test('the new name is live, tier 3, packed, and carries all 25 accepts', () => {
  assert.ok(blitz.CATEGORIES.includes(NEW_NAME), 'active category');
  assert.equal(blitz.CATEGORY_TIER[NEW_NAME], 3, 'tier unchanged at 3 (niche)');
  assert.equal(blitz.tierForCategory(NEW_NAME), 3, 'tierForCategory agrees');
  assert.ok(blitz.TIER_POOLS[3].includes(NEW_NAME), 'sits in the tier-3 pool');
  assert.equal(CATEGORY_PACKS[NEW_NAME], 'history', 'kept the history pack');
  const answers = CATEGORY_ANSWERS[NEW_NAME];
  assert.ok(answers, 'has an accept-list');
  assert.equal(answers.size, 25, `kept all 25 accepts (got ${answers.size})`);
});

test('the rename lost nothing — the post-500 entries are deliberately kept', () => {
  const answers = CATEGORY_ANSWERS[NEW_NAME];
  // Ancient by any definition.
  for (const keep of ['rome', 'roman empire', 'persia', 'han dynasty', 'qin dynasty']) {
    assert.ok(answers.has(keep), `kept "${keep}"`);
  }
  // Post-500, and correct under the new name — this is the point of the rename.
  for (const keep of ['tang dynasty', 'khmer empire', 'mali empire', 'songhai empire', 'ming dynasty', 'mongol empire', 'aztec empire', 'inca empire']) {
    assert.ok(answers.has(keep), `kept the post-500 "${keep}"`);
  }
});

test('the rename introduced no duplicate normalised name', () => {
  const seen = new Map();
  for (const c of blitz.CATEGORIES) {
    const k = blitz.normalizeCategoryKey(c);
    seen.set(k, [...(seen.get(k) || []), c]);
  }
  assert.deepEqual([...seen.entries()].filter(([, v]) => v.length > 1), []);
  assert.equal(blitz.CATEGORIES.length, 442, 'the pool size is unchanged by a rename');
});

test('the sweep-driven removals landed: candy bar / mixed breed', () => {
  assert.ok(!CATEGORY_ANSWERS['Candy bars'].has('candy bar'), 'Candy bars no longer accepts "candy bar"');
  assert.ok(!CATEGORY_ANSWERS['Dog breeds'].has('mixed breed'), 'Dog breeds no longer accepts "mixed breed"');
  // and the categories are still usable
  assert.ok(CATEGORY_ANSWERS['Candy bars'].has('snickers'), 'Candy bars kept snickers');
  assert.ok(CATEGORY_ANSWERS['Dog breeds'].has('beagle'), 'Dog breeds kept beagle');
});
