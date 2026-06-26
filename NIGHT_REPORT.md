# NIGHT REPORT — backend, branch scratch (DO NOT MERGE)

> ⚠️ Branch-only scratch for Andy's review. **Delete before any merge to main.** Lives only on `night/*` branches.

---

## Combos + Imposter expansion
_Branch: `night/content-expand` (chain-reaction-backend) · 2026-06-26 · content · NOT merged_

Both data sets live server-side, so this is a backend-only change → **no Vercel preview** (frontend untouched). **No game logic, WS, timers, or runtime validation changed** — only the two content arrays were appended to, each with a verifier script that bakes the rule in. The stray `gameLogic.test.js` change is left untouched.

### 1. Word Bomb COMBOS  (`gameLogic.js` → `const COMBOS`)
- **Existed before:** 171 combos
- **Generated:** all 18,252 two- and three-letter a–z sequences scanned (machine generation, not hand-picked)
- **Auto-rejected:** 17,502 total — **17,336 below the solvability floor** + **166 already shipping** (deduped)
- **Added:** 70 (capped balanced batch: 22 two-letter + 48 three-letter, ranked by frequency)
- **Final total:** **241** (verified 241 unique, 0 duplicates)
- **Data file:** `gameLogic.js` (the `COMBOS` array; new entries under the `night/content-expand batch` comment)
- **Generator/filter:** `comboExpand.js` (NEW)

**The machine filter (the rule, enforced):** a combo must appear in **≥40** words of `botWords.txt` — the bot's own ~18k common-word corpus, so "solvable for the bot" = "solvable for a human." That floor is **~5× stricter** than the easiest combo already shipping (`kle`, 8 words), so every added combo is comfortably solvable, never a dead end. Re-run `node comboExpand.js` to extend under the same rule.

**Example rejects (just under the floor, filter working):** `by` (39 words), `yo` (39), `xc` (39), `adv` (39), `blo` (39) — all fell below 40 and were dropped.

**10-combo sample added** (combo → #corpus words → example): `ng`→1342 (using) · `nt`→1124 (contact) · `ri`→1055 (price) · `tio`→693 (nation) · `ati`→554 (ratio) · `com`→233 (company) · `ive`→220 (active) · `for`→155 (forest) · `che`→153 (check) · `the`→142 (other)

### 2. Imposter Word PAIRS  (`imposterWordLogic.js` → `const CATEGORY_PAIRS`)
- **Existed before:** 152 pairs
- **Generated:** 51 curated candidates (close-but-distinguishable overlaps across the 5 established themes)
- **Auto-rejected:** 4 — all duplicates of existing pairs (see reasons below)
- **Added:** 47
- **Final total:** **199**
- **Data file:** `imposterWordLogic.js` (the `CATEGORY_PAIRS` array; new entries under the `night/content-expand batch` comment)
- **Generator/filter:** `imposterPairsExpand.js` (NEW)

**The machine filter (the rule, enforced):** each pair must be well-formed (both `real` + `fake` present), `real !== fake` (there must be daylight for the table to catch the imposter), and not a duplicate of an existing pair (normalized compare on the pair AND on the `real` half). The "close but distinguishable" calibration is curated into the candidates, mirroring the existing good pairs. Answers are human-voted, so phrase-style categories are fine here (unlike Category Blitz). School-appropriate, recognizable.

**The 4 rejects (filter working):**
- `Things you do during a fire drill / …power outage` — `real` reused by an existing pair
- `Marvel villains / DC villains` — duplicate pair (already shipping)
- `Mario Kart items / Smash Bros items` — `real` reused by an existing pair
- `Things at a farmers' market / …flea market` — duplicate pair (already shipping)

**10-pair sample added:**
1. `Pixar movies` / `DreamWorks movies`
2. `Taylor Swift songs` / `Olivia Rodrigo songs`
3. `Greek gods` / `Roman gods`
4. `Planets in the solar system` / `Moons in the solar system`
5. `Dog breeds` / `Cat breeds`
6. `Things at a wedding` / `Things at a prom`
7. `Things you see at the beach` / `Things you see at a pool`
8. `Things at an airport` / `Things at a train station`
9. `Worst superpowers` / `Useless inventions`
10. `Things in a dragon's hoard` / `Things in a pirate's treasure`

### Verification
- `node comboExpand.js` and `node imposterPairsExpand.js` both run clean and re-derive the same counts.
- `require('./gameLogic.js')` and `require('./imposterWordLogic.js')` both load with no error.
- COMBOS: 241 entries, 0 duplicates (comment-stripped check). PAIRS: 199 entries.

### Untouched
Runtime answer-validation (`haikuValidator.js`, `aiValidator.js`), all game/WS/timer logic, the combo difficulty-weighting + selection logic, and the stray `gameLogic.test.js` change.

### For Andy
- Both verifier scripts are the place to add the next batch under the same enforced rules.
- A handful of the new 3-letter combos lean "web-corpus common" (`tio`, `ati`, `ons`) — all solvable, but if you want them swapped for chunkier phonetic ones, raise the floor or curate from the kept list in `comboExpand.js` output.
