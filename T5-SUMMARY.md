# T5 Summary — three new game modes, ranked

Session **T5**, overnight run on branch `feat/blitz-bot` (shared checkout — no
branch switching; every commit is `[T5]`-prefixed). Full context and the
6-concept brainstorm live in `T5-DESIGN_NOTES.md`.

## What was built

Three fully playable backend modes, each a self-contained plugin
(`t5FuseMode.js`, `t5LetterStormMode.js`, `t5HerdMindMode.js`) registered in
`t5Modes.js`, wired through four generic hooks in `roomManager.js` and two in
`server.js`. Deleting a mode = delete its two files + one registry line.
60 mode tests (repo suite 301/301 green, lint clean). Each mode was
play-reviewed by an adversarial subagent for degenerate strategies; the
cheap top-ranked fixes were applied and committed, the rest are documented
below. All three modes were verified end-to-end over real WebSockets against
a booted server (create → join → set_game_type → start → play → reveal).

## Ranking

| # | Mode | Fun (reviewer, post-fix est.) | Effort to ship | Virality | One-liner |
|---|------|------------------------------|----------------|----------|-----------|
| 1 | **FUSE** (`fuse`) | 7/10 → ~8.5 | Low — reuses Word Bomb's UI shape (combo, typing, lives) | High — explosions are inherently clip-able | Hot-potato Word Bomb with a hidden shared fuse |
| 2 | **HERD MIND** (`herd-mind`) | 6.5/10 → ~8 | Low-medium — needs a great reveal screen; no timer-pressure UI | Highest — zero knowledge barrier, Black Sheep is a screenshot machine | Secretly match the crowd; originality scores zero |
| 3 | **LETTER STORM** (`letter-storm`) | 6/10 → ~8 | Low — Category Blitz's UI shape with a letter rack | Solid — "same letters, I got destroyed" | Simultaneous 7-letter anagram rush |

**Recommendation: ship FUSE first.** Its core loop is genre-proven (hidden-fuse
hot potato), the reviewer called the hint escalation + close-call framing
"better than genre," it's the most on-brand ("type fast die slow"), and it
reuses the most existing frontend. HERD MIND second — it's the best *party*
game of the three and the cheapest to run (zero validation dependencies), but
it lives or dies on reveal presentation, which is frontend work. LETTER STORM
third — mechanically the soundest after the scoring rebalance, but it's the
most heads-down/least social, and the skill gap gives weaker players the least
reason to rematch (the one reviewer concern deliberately not fixed yet — see
Future work).

## The modes in 30 seconds each

**FUSE** — 2–8 players (best 4–6), 2 lives. A bomb with a hidden 12–40s fuse
(difficulty-ranged, shrinking 8% per explosion) passes on each accepted word
containing the shown combo; the fuse keeps burning across passes. Holder at
zero loses a life; last standing wins. Crackle hints at 50/75/90% burned;
close-call flags; knockout ranking + pass/hold stats on game over.

**HERD MIND** — 3–8 players, 5 rounds. Convergent prompt, everyone secretly
locks ONE answer, reveal groups them (aggressive normalization). Score =
group size − 1, +1 for the biggest herd, final round double. Lone unique
answer among herds = BLACK SHEEP. No-repeat rule per game; ties are shared
wins. No dictionary, no AI, no accept-lists.

**LETTER STORM** — 2–8 players, 3 rounds of 40/30/20s. Same 7-letter rack for
everyone (scrambled real word, ≥25-solution quality floor). Words score
1/2/4/7 by length; a full-rack STORM pays 12 and is announced live. Offline
deterministic validation (botWords.txt + letter multiset). Round-end reveal
shows everyone's words + the longest misses + the source word.

## Play-review findings (subagent, adversarial)

**FUSE (7/10).** Dominant strategy is "shortest word, instantly" — acceptable
(it's Bomb Party's loop) but flattens skill to recall latency. Two real
defects found and **fixed**: dictionary-latency deaths (a word typed in time
could die to network jitter — now a 3s in-flight grace holds the explosion,
and a buzzer-beater save relights a fresh fuse) and submission shotgunning
(parallel guesses raced the dictionary — now one in-flight submission per
holder). Bomb-cooking (holding to slam a hot bomb on your neighbor) was
judged fun-positive spice that self-polices. Weakest at 2 players (drama
needs a table); dead players at 8p need verbs (future work).

**HERD MIND (6.5/10).** #1 fun-killer was matching fragility — herds that
should form, not forming ("hot dog"/"hotdog", "dishes"/"dish"). **Fixed**
(space-strip + es-plural fold), along with: the no-repeat rule (kills
poop-sheep farming, sheep suppression, and static two-player pacts), the
biggest-herd bonus + double final round (gives flat scoring a spine and a
comeback lever), and shared-win ties (the old tie-break silently crowned the
earliest joiner). Remaining known gaps: no alias table ("coke"/"coca cola"
are still different keys), no typo merging, no profanity filter, and ~8
phrase-shaped prompts fracture herds (future work).

**LETTER STORM (6/10).** The review's Monte Carlo over 200 real racks proved
3/4-letter spam strictly dominant (~0.55 pts/s vs ~0.33 for hunting fives)
and the STORM both EV-negative and socially invisible. **Fixed**: nonlinear
scoring (1/2/4/7, storm 12), live STORM broadcast (name only), and a
25-solution rack quality floor (the corpus's worst rack had 11 solutions vs
199 for the best). Remaining known gaps: corpus misses real words (~15% of
everyday 3-letter words — reject copy should say "not in our word list"),
and no catch-up mechanism for weaker players (future work).

## How to try each mode

The backend speaks the existing WS protocol — no new client→server message
types. Any client (the WordArcade frontend once it adds the UIs, or a raw
WebSocket tool) plays a mode like this:

1. `npm install && npm start` (port 3001; `GET /health` to confirm).
2. Connect N WebSockets to `ws://localhost:3001` (N = 2 for fuse/letter-storm,
   3 for herd-mind). Each receives `connected {id}`.
3. Socket 1: `{"type":"create_room","payload":{"name":"HOST"}}` → `room_created {code}`.
4. Others: `{"type":"join_room","payload":{"code":"<CODE>","name":"P2"}}`.
5. Host: `{"type":"set_game_type","payload":{"gameType":"fuse"}}` (or
   `"letter-storm"` / `"herd-mind"`), then `{"type":"start_game"}`.
6. Play (all submissions via `{"type":"submit_word","payload":{"word":"..."}}`
   — `submit_answer`/`{answer}` works identically):
   - **fuse**: watch `bomb_update {holderId, combo}`; the holder submits a
     word containing the combo → the bomb moves. `fuse_hint {level, holderId}`
     escalates 1→3; `bomb_exploded`, then `game_over {winnerId, finalRanking,
     stats}`.
   - **letter-storm**: `round_start {letters[]}`; submit words buildable from
     the letters. Private `answer_result {points}`, public `player_progress`
     and `storm` events; `round_end {playerResults, missedWords, rackSource}`
     ×3 → `game_over {finalScores}`.
   - **herd-mind**: `round_start {prompt}`; each player submits ONE answer
     (locked; `answer_count` broadcasts progress; the phase ends early when
     all are in) → `round_reveal {groups, blackSheepId, doublePoints, scores}`
     ×5 → `game_over {winnerId, winnerIds, finalScores}`.

Quickest sanity check without a client: the test suites drive all of this
through `roomManager` (`node --test t5FuseMode.test.js t5LetterStormMode.test.js
t5HerdMindMode.test.js`).

## Frontend work needed (per mode, rough)

- **fuse**: Word Bomb screen minus the visible timer, plus bomb-holder
  highlight, crackle animation tiers (levels 1–3), explosion moment,
  close-call flash, knockout-ranking game-over screen. The existing
  `typing_update` relay already works in fuse (status is `in_progress`).
- **herd-mind**: prompt card + one locked input + "N/M locked" meter, and a
  reveal screen that milks the grouping (herds stack up, sheep gets branded).
  Note: `typing_update` does NOT relay in herd-mind (status is `answering`) —
  correct, answers are secret.
- **letter-storm**: letter-tile rack + word list + progress meters + storm
  flash + reveal of missed words. Disable autocorrect/autocapitalize on the
  input (mobile).

## Future work (documented, deliberately not built tonight)

- **fuse**: long-word power (8+ letters skips the next player — reviewer's
  #1 fun-ceiling pick), ghost predictions for eliminated players, direction
  reverse after explosions.
- **herd-mind**: alias table for known splits (coke/coca-cola, NYC/New York),
  edit-distance-1 typo merging, profanity filter, cull the ~8 phrase-shaped
  prompts, prediction side-bet, an announced inverted "BLACK SHEEP ROUND".
- **letter-storm**: round multipliers (×1/×2/×3) as a catch-up lever,
  unique-word bonus at reveal, "not in our word list" reject copy, per-second
  submission cap.

## Commit trail ([T5], newest last)

- `docs: design notes` — engine recon + 7 concepts, 3 picked
- `[fuse] feat` — mode + registry + 18 tests
- `[letter-storm] feat` — mode + 15 tests
- `[herd-mind] feat` — mode + 16 tests
- `feat: wire the T5 mode registry into roomManager` (server.js hooks landed
  alongside another session's commit)
- `[fuse] polish` — ranking, stats, close calls, juice
- `[fuse] fix` — latency-death grace + shotgun gate (review)
- `[letter-storm] fix` — nonlinear scoring, live STORM, rack floor (review)
- `[herd-mind] fix` — matching, no-repeat, herd bonus, shared ties (review)
