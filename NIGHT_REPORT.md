# NIGHT REPORT — backend, branch scratch (DO NOT MERGE)

> ⚠️ Branch-only scratch for Andy's review. **Delete before any merge to main.** Lives only on `night/*` branches.

---

## Category generation
_Branch: `night/categories-generate` (chain-reaction-backend) · 2026-06-26 · content · NOT merged_

### Counts
- **Existed before:** 99 categories (with accept-lists)
- **Generated:** 112 candidates (spread across geography, animals, food/drink, screen pop-culture, games/anime, music, sports, science/space, history/myth, everyday objects, brands)
- **Auto-rejected by the machine filter:** 9
- **Added:** 103
- **Final total:** **202**

### 15-category sample of what was added
`European capitals` (paris, london) · `World rivers` (nile, amazon) · `Birds` (eagle, robin) · `Trees` (oak, pine) · `Cocktails` (margarita, mojito) · `Mexican foods` (taco, burrito) · `Disney princesses` (cinderella, ariel) · `Pixar characters` (woody, buzz) · `Street Fighter characters` (ryu, ken) · `Among Us colors` (red, blue) · `Famous DJs` (calvin harris, david guetta) · `Martial arts` (karate, judo) · `Body parts` (elbow, knee) · `Shapes` (circle, square) · `US presidents` (lincoln, washington)

### Rejected (with reasons) — the filter working
- `Sitcoms` — answer >3 words ("how i met your mother")
- `Boy bands` — answer >3 words ("new kids on the block")
- `Things in a bathroom` — phrase/open-ended name pattern
- `Things in a first aid kit` — phrase/open-ended name pattern
- `Things at a beach` — phrase/open-ended name pattern
- `Board games` — duplicate of existing
- `Car brands` — duplicate of existing
- `Things you say when you stub your toe` — **intentional rule-violator** (phrase name + <6 examples + 4+ word answers) → correctly killed
- `Excuses for being late to work` — **intentional rule-violator** (phrase name + sentence answers) → correctly killed

### The machine filter (in `categoryAnswers/gen7-generate.js`)
Each candidate must pass ALL of:
1. Name is not a phrase/open-ended pattern (`/^things (you|your|that…)/`, `/reasons|excuses|headlines|quotes|things … say/`, `/google/`).
2. ≥6 seed example answers.
3. **Every** example answer ≤3 words (the core rule).
4. Not a dup of an existing category or an earlier candidate (normalized name compare).
Survivors are written to `gen7.js` as `{ name: new Set([...]) }`. Each kept category stores 6–12 verified short example answers (proves the answer space is real + bounded); the Haiku judge covers the long tail, same as the existing gen* batches.

### Cross-check against the runtime guardrail
Loaded `categoryBlitzLogic.js` after wiring gen7 in — its `isBoundedCategory` filter dropped **zero** of the new categories (no `[categoryBlitz] dropped category` warnings), confirming all 103 are bounded/short by the runtime's own measure too.

### Files
- `categoryAnswers/gen7.js` — **NEW** data file, 103 categories with seed accept-lists.
- `categoryAnswers/gen7-generate.js` — **NEW** generator+filter script (the rule is baked into its header + filter so future generation can't violate it).
- `categoryAnswers.js` — wired `require('./categoryAnswers/gen7')` into the merge.
- `categoryBlitzLogic.js` — appended the 103 names to `RAW_CATEGORIES`.
- **Untouched:** runtime answer-validation (`haikuValidator.js`, `submitAnswer`), all game/WS logic, and the stray `gameLogic.test.js` change.

### Preview
Backend repo — not frontend-affecting, so no Vercel preview. Pushed to `origin/night/categories-generate` for review. Runs/serves via Render on merge (not done — no merge).

### Generator hardened (idempotency fix)
The generator is wired into `categoryAnswers.js`, so after the first run the merged pool already contains gen7's names. A naive re-run saw every candidate as a "duplicate of existing", kept 0, and **emitted an empty `gen7.js` — wiping the batch** (hit during verification). Fixed two ways in `gen7-generate.js`: (1) the dedup set now EXCLUDES gen7's own names, so a re-run reproduces the same 103 instead of self-colliding; (2) a write-guard REFUSES to overwrite `gen7.js` when the kept set is empty. Verified: re-running now keeps 103 / rejects 9 / total 202 and leaves the file intact.

### For Andy
- Skim `gen7.js` for taste — a few categories lean general-knowledge (capitals, elements); if you want them punchier/funnier to match the existing "personality" categories, easy to swap.
- The generator is rerunnable + idempotent now (`node categoryAnswers/gen7-generate.js`) and is the place to add the next batch under the same enforced rule.
