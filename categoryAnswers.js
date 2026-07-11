// categoryAnswers.js
// Pre-generated accept-lists for Category Blitz - one Set of valid lowercase
// answers per category. These back the fast, free, offline Stage-1 lookup in
// categoryBlitzLogic.js (the AI judge in aiValidator.js is the Stage-2 fallback
// for creative answers that aren't on a list).
//
// The categories now have PERSONALITY (junk drawers, 2am gas-station runs,
// SpongeBob characters, things you google at 3am...) instead of generic trivia.
// Their answer sets are large, so they're split across categoryAnswers/*.js by
// theme purely to keep each file manageable; they're merged back into one object
// here so consumers still `require('./categoryAnswers')` and index by the exact
// category string. Keys MUST match the CATEGORIES array in categoryBlitzLogic.js
// exactly.
//
// All entries are lowercase; singular/plural and common alternate spellings are
// included on purpose so reasonable answers get accepted. Multi-word answers are
// allowed. (One finite domain - "Pixar movies" - has fewer than 150 entries
// because only ~30 Pixar films exist; the AI fallback covers the long tail.)

const answers = Object.assign(
  {},
  require('./categoryAnswers/oddly-specific'),
  require('./categoryAnswers/food'),
  require('./categoryAnswers/pop-culture'),
  require('./categoryAnswers/debatable'),
  require('./categoryAnswers/brands'),
  require('./categoryAnswers/social'),
  // Curated expansion batch (gen1-gen5): 19 new categories from the content
  // review pile, each with a ~150-entry accept-list. Keys must match the new
  // entries appended to CATEGORIES in categoryBlitzLogic.js exactly.
  require('./categoryAnswers/gen1'),
  require('./categoryAnswers/gen2'),
  require('./categoryAnswers/gen3'),
  require('./categoryAnswers/gen4'),
  require('./categoryAnswers/gen5'),
  // Clean rapid-fire batch (gen6): 20 noun-list categories, each with a 150+
  // entry accept-list. Keys match the new entries appended to CATEGORIES.
  require('./categoryAnswers/gen6'),
  // gen7 (night/categories-generate): 103 machine-filtered bounded categories
  // (answers <=3 words), generated + filtered by categoryAnswers/gen7-generate.js.
  // Seed accept-lists; the Haiku judge covers the long tail. Keys match the
  // entries appended to CATEGORIES.
  require('./categoryAnswers/gen7'),
  // gen8 (cb-category-refine): 12 hand-curated bounded categories added to
  // replace the weak/redundant/open-ended ones cut from the active pool. Keys
  // match the entries appended to CATEGORIES.
  require('./categoryAnswers/gen8')
);

// Supplemental answers (expansion.js) are UNION-MERGED into the sets above so
// every existing category clears 200+ accepted answers. We can't Object.assign
// these in (that would REPLACE a category's set with the supplement); instead we
// add each supplemental entry into the existing Set, creating the set only if
// the category somehow isn't present yet.
const supplements = [
  require('./categoryAnswers/expansion'),
  require('./categoryAnswers/expansion2'),
];
for (const supplement of supplements) {
  for (const [category, extras] of Object.entries(supplement)) {
    if (answers[category]) {
      for (const entry of extras) answers[category].add(entry);
    } else {
      answers[category] = new Set(extras);
    }
  }
}

// gen9 (pack rework): union-merged like the supplements above rather than
// Object.assign'd, so it ADDS to any existing curated list instead of replacing
// it. Shared keys (e.g. "NBA teams", "Dog breeds") keep their existing Set and
// just gain gen9's extra answers; gen9-only categories are created fresh. This
// preserves every existing accept-list. (gen9 exports Sets, not arrays.)
const gen9 = require('./categoryAnswers/gen9');
for (const [category, set] of Object.entries(gen9)) {
  if (answers[category]) {
    for (const entry of set) answers[category].add(entry);
  } else {
    answers[category] = set;
  }
}

// 2026-07 pool review FOLDS: near-duplicate categories are merged into one
// KEEPER (union the loser's accept-list into the keeper's, then drop the loser
// key) and a few salvageable categories are renamed (same op - the target key
// just doesn't exist yet). The on-disk categoryAnswers/* files stay append-only:
// the loser/old-name lists remain there as the DATA SOURCE for this fold, so
// nothing here deletes answers - it only re-homes them under the surviving
// category name. Keys must match RAW_CATEGORIES / categoryPacks.js exactly.
const FOLDS = {
  // renames (salvageable categories, broader/easier phrasing)
  'SI units': 'Units of measurement',
  "Rolling Stone's 500 Greatest Albums": 'Iconic albums',
  'Rock and Roll Hall of Fame Inductees': 'Classic rock artists',
  'Constellations from myth': 'Constellations',
  'Active volcanoes': 'Famous volcanoes',
  // franchise near-dupes (keeper = larger list, keeps the pack tag)
  'Minecraft Mobs': 'Minecraft mobs',
  'Pokemon Gen 1': 'Pokemon from Gen 1',
  'Super Mario power-ups': 'Mario power-ups and items',
  'Mario Kart items': 'Mario Kart Items',
  'Zelda characters': 'Legend of Zelda characters',
  'Sonic characters': 'Sonic the Hedgehog characters',
  'Marvel superheroes': 'Marvel Superheroes',
  'DC superheroes': 'DC Comics Superheroes',
  'Star Wars characters': 'Star Wars Characters',
  'Harry Potter characters': 'Harry Potter Characters',
  'Disney Villains': 'Disney villains',
  'Pixar Movies': 'Pixar movies',
  'Studio Ghibli movies': 'Studio Ghibli Movies',
  'SpongeBob SquarePants Characters': 'SpongeBob characters',
  'Mortal Kombat fighters': 'Mortal Kombat characters',
  'Fighting games': 'Fighting game franchises',
  // food/nature near-dupes
  'Popular spices and herbs': 'Herbs and spices',
  'Spices and herbs': 'Herbs and spices',
  'Mushrooms and fungi': 'Types of mushrooms and fungi',
  'Types of mushrooms': 'Types of mushrooms and fungi',
  'Citrus fruits': 'Types of citrus fruit',
  'Edible berries': 'Types of berries',
  'Types of nuts': 'Nuts and seeds',
  'Breakfast cereal brands': 'Cereal brands',
  'Breakfast cereals': 'Cereal brands',
  'Cake types': 'Types of cake',
  'Mexican foods': 'Mexican food dishes',
  'Tea types': 'Types of tea',
  'Sandwiches': 'Sandwich types',
  'Reptiles': 'Reptiles and amphibians',
  // geography/misc near-dupes
  'US states by name': 'US states',
  'US state abbreviations': 'US states',
  'The Great Lakes': 'Great Lakes of North America',
  'Oceans': 'World oceans',
  'Seven Wonders of the Ancient World': 'Wonders of the World',
  'Ancient wonders': 'Wonders of the World',
  'Planets': 'Planets in our solar system',
  'World rivers': 'Major world rivers',
  'Zodiac constellations': 'Zodiac signs',
  'Types of rocks': 'Types of rock',
  'Classic dystopian novels': 'Dystopian novels',
  'Major League Soccer teams': 'MLS teams',
  'Video game hardware manufacturers': 'Video game hardware',
  'Streaming services': 'Video streaming services',
};
for (const [from, to] of Object.entries(FOLDS)) {
  if (!answers[from]) continue;
  if (answers[to]) {
    for (const entry of answers[from]) answers[to].add(entry);
  } else {
    answers[to] = answers[from];
  }
  delete answers[from];
}

module.exports = answers;
