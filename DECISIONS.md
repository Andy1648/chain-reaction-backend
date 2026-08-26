# DECISIONS — chain-reaction-backend

## data/accept-lists — broad category expansion (autonomous, 2026-08-25)
- Job: "~66 broad categories remain under-expanded. Keep going in batches of ~20…real answers
  only, <=3 words, dedupe case-insensitively, never pad with inventions."
- SCOPE DECISION (conservative): shipped ONE verified batch of 17 genuinely under-expanded broad
  categories (`categoryAnswers/expand-broad-1.js`) rather than rushing all ~66. Rationale: the
  bar is "real answers only, never pad with inventions" — a full 66-category sweep to ~150 each
  in the time-box would force low-confidence padding, which the instructions forbid. Better to
  ship correct, hand-verified data and report the remainder honestly.
- MECHANISM: added as a `supplements` entry — union-merged into the existing Set
  (`answers[cat].add(entry)`), so every curated list is PRESERVED, never overwritten. Verified
  0 orphan categories created (total categories unchanged at 638) and all keys matched existing
  categories exactly before wiring.
- DROPPED from the batch after verification: "Board games" (already 195), "Musical instruments"
  (already 196) — not under-expanded. "Types of dance" had no matching key; replaced with the
  real under-expanded "Musical genres of dance" (dance-MUSIC genres: house/techno/…).
- RESULT: 17 categories grown from 7–10 entries each to 38–67 each. `node --test` 320/320 green.
- REMAINING (not done, honest): ~49 other broad under-expanded categories still at single/low
  double digits (e.g. Cocktails, Superheroes, Car brands, Dog breeds variants, etc. — see a
  `node` count scan of Sets under ~15). Next batch should follow the same union-merge pattern.

## data/accept-lists-2 — broad category expansion batch 2 (JOB 6, autonomous 2026-08-26)
- Shipped expand-broad-2.js: 16 broad categories grown from 9-26 to 46-69 each (jungle animals,
  horror movies, Simpsons characters, body parts, kitchen utensils, tools, things with wheels,
  insects, cookies, coffee drinks, sandwiches, venomous animals, mythical monsters, pies, frozen
  desserts, tacos). Union-merged (never overwrites); 0 orphan categories (total stayed 638).
- Dropped "Coffee brands" from the batch after verification: no matching existing category (would
  have created an orphan). Real answers only, <=3 words, deduped by the Set (case-insensitive
  within-batch since all lowercase). node --test 320/320 green.
- SCOPE: this is one batch of ~16 of the ~49 remaining broad categories. The other ~33 are still
  under-expanded (many "under-40" entries are FINITE domains — Continents=7, Months=12, Chess
  pieces=6, Planets=8 — which CANNOT be expanded without inventing/padding, forbidden; only the
  genuinely open-ended ones are eligible). Next batch continues the same union-merge pattern.
