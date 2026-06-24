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
  require('./categoryAnswers/gen6')
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

module.exports = answers;
