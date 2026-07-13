# T5 Design Notes — new game modes for the WordArcade backend

Session codename: **T5**. Branch at time of work: `feat/blitz-bot` (shared folder,
no branch switching allowed — all T5 commits land here, prefixed `[T5]`).

---

## Phase 0 — How the engine actually works

### The three shipped modes, from their implementations

**Word Bomb** (`gameLogic.js`) — turn-based elimination.
- Each turn the server shows a 2–4 letter "combo"; the current player must type a
  real dictionary word *containing* it that hasn't been used this game.
- Time pressure ramps two ways: the per-turn timer decays with completed turns
  (difficulty presets, clamped at a floor), and combo selection is weighted by
  *effective length* (length + a pool-rarity bonus) with pressure that ramps from
  short/easy to long/hard as turns pile up.
- 3 lives, timeout costs a life, last player standing wins. Rejected words are
  free retries (only the clock punishes). Dead-combo rescue: if a whole round of
  active players whiffs one combo, it's swapped for an easier one.
- Validation: external Dictionary API, cached, **fails open** on network errors.

**Category Blitz** (`categoryBlitzLogic.js`) — simultaneous round-based race.
- 3 rounds × flat 20s. Everyone types as many valid answers to the same category
  as they can; +1 per accepted answer; highest cumulative score wins.
- No turns, no lives, no elimination. Privacy model: accept/reject is private to
  the submitter; only a count (`player_progress`) is broadcast mid-round; full
  answers are revealed at `round_end`, along with `sampleAnswers` nobody gave.
- Two-stage validation: offline accept-list Set (instant, free) → Haiku AI judge
  fallback (fail-closed, rate-limited, disabled without an API key).
- Extras: host-only category reroll inside a 5s opening window (a full round
  restart, points reverted — can't farm), host-selected category packs.

**Imposter Word** (`imposterWordLogic.js`) — social deduction.
- 5 rounds. Everyone sees the same category except the imposter (who sees only
  "blend in"); imposter rotates one seat per round. Answer phase (public answers,
  broadcast live — that's how the imposter reverse-engineers the prompt) → vote
  phase (early-ends when all votes are in) → reveal.
- **No algorithmic validation at all** — the human vote is the judge.
- Scoring deliberately favors the imposter (+3 survive vs +1 per correct voter;
  ties/no-votes = survival) for drama.

### What makes them work (the brand)

1. **A hard clock is the antagonist.** Every mode's core loop is "think of words
   while a timer eats you." Timers are server-owned; clients only render ticks.
2. **Escalation.** Word Bomb ramps both the clock and the prompt difficulty.
   Flat modes (Blitz) keep rounds short instead (20s).
3. **Chaos with a fairness floor.** Randomness (combos, categories) is filtered
   for solvability (pool-size vetting, bounded-category rule, dead-combo rescue).
4. **Social texture.** Live typing relay, spectator emoji, public answers in
   Imposter, privacy-then-reveal in Blitz. The reveal moments *are* the fun.
5. **Forgiveness on input, punishment on time.** Rejects never cost lives.

### Shared engine architecture (what a new mode must plug into)

- **Pure logic module** per mode: `createGame(players, difficultyKey, solo,
  selectedPacks)` returning a plain game object, plus submit/phase-end/scoreboard
  functions. No timers, no sockets, no `Date.now`-dependent hidden state. This is
  what gets unit-tested (node:test, zero deps, mock dictionary via a
  `_setDictionaryForTesting` injection hook where needed).
- **roomManager.js** owns *all* wall-clock state, keyed on well-known room slots:
  `turnTimerInterval`/`turnDeadline` (turn modes), `roundTimerInterval` /
  `roundPauseTimeout` / `roundDeadline` (round modes), `countdownTimeout` (the
  3s gap so the frontend's 3-2-1-GO plays before any timer ticks). Cleanup paths
  (`resetGame`, `destroyRoom`, `_resetRoomsForTesting`) clear those slots — **a
  mode that reuses the existing slots gets teardown for free.**
- **Routing:** `logicForGameType()` maps gameType → logic module;
  `handleWordSubmission` dispatches per `game.gameType` (Blitz and Imposter each
  branch to their own handler); `startGame` branches per mode to kick off the
  first turn/round; `removePlayer` branches per mode (turn modes eliminate +
  advance, simultaneous modes just drop from the roster).
- **server.js** is a thin WS router: `submit_word`/`submit_answer` both funnel
  into `handleWordSubmission`; `set_game_type` validates against an allowlist;
  errors go through `humanizeError(code)`.
- **Message idioms:** `timer_tick {secondsRemaining}` every second; per-mode
  `round_start`/`round_end`/`game_over` payloads; private results to the
  submitter vs privacy-safe broadcast counts; `game_reset` for rematch.

### Plug-in checklist for a new mode

1. Self-contained module: pure rules + (new for T5) its own orchestrator
   functions that receive `{ broadcastToRoom, scheduleTimerAfterCountdown,
   clearTurnTimer, clearRoundTimer, touchRoom }` as injected helpers (no
   circular requires).
2. Registry entry (`t5Modes.js`) so roomManager/server each need only tiny,
   generic hooks (this folder is shared by six sessions — shared-file diffs must
   stay minimal, and deleting a mode = delete its files + one registry line).
3. Reuse the existing timer slots so reset/teardown Just Works.
4. Reuse `submit_word`/`submit_answer` messages (no new client→server types).
5. Tests file added to the `npm test` list in package.json.

---

## Phase 1 — Mode concepts (7 brainstormed, 3 picked)

Scoring axes: **Fun ceiling** / **Implementation cost** on this engine /
**Virality** (clip-ability, "you have to try this") / **Differentiation** from
the three shipped modes.

### 1. FUSE (Hot Potato Word Bomb) — ✅ PICKED
Turn-based. A bomb with a **hidden** fuse (random 15–35s, shrinking as the game
goes) passes around the table. Type a valid word containing the combo to shove
the bomb to the next player — the fuse **keeps burning across passes**. Whoever
holds it when it blows loses a life. Last alive wins.
- Fun: extreme. Word Bomb's tension but the clock is *shared and invisible* —
  every pass is a jump-scare lottery. Server drips escalating "crackle" hints
  (50/75/90% burned) so dread ramps without revealing the truth.
- Cost: **low**. Reuses combo picking + difficulty ramp from gameLogic, the
  dictionary, and the turn-timer slot. New logic ≈ pass/explode/fuse-roll.
- Virality: high — explosion moments are inherently clip-able.
- Differentiation: vs Word Bomb it flips "my timer, my problem" into "our bomb,
  someone's funeral". Speed helps you even when it can't save you.

### 2. LETTER STORM (anagram rush) — ✅ PICKED
Simultaneous rounds. Each round everyone gets the **same 7-letter rack**
(scrambled from a real 7-letter word, so a full-rack answer always exists).
Type as many words buildable from those letters as you can in 30s. Longer =
more points; using all 7 letters = big bonus. 3 rounds, top score wins.
- Fun: high skill ceiling, zero luck asymmetry (identical rack for all). The
  round-end reveal of the 7-letter word nobody found is a great "OHHH" moment.
- Cost: **low-medium**. Validation is fully offline against botWords.txt (~18k
  common words) — deterministic, free, no AI, no external API. Round plumbing
  mirrors Category Blitz.
- Virality: solid — "we all had the same letters and I got destroyed."
- Differentiation: first mode where the *prompt is a resource* (finite letters)
  rather than a constraint; first with per-answer variable scoring.

### 3. HERD MIND (majority rules) — ✅ PICKED
Social party rounds. A prompt drops ("Name a pizza topping"). Everyone secretly
locks in ONE answer (25s, phase ends early when all are in). Reveal: answers are
grouped; you score **(size of your group − 1)** — matching the crowd is
everything, being original scores zero. The lone unique answer when everyone
else matched gets branded the **Black Sheep** 🐑. 5 rounds, top score wins.
- Fun: pure social comedy — the reveal is the game. Great with 4–8 players.
- Cost: **lowest**. No validation at all (matching, not correctness), no AI, no
  dictionary. Phase engine mirrors Imposter's answer→reveal shape.
- Virality: highest of the seven — family-friendly, zero knowledge barrier, the
  Black Sheep reveal is a screenshot machine.
- Differentiation: first mode where you're rewarded for *predicting people*
  instead of producing words fast. Complements Imposter (read the room to blend)
  with an inverted skill (read the room to converge).

### 4. WORD AUCTION (bid & blitz) — not picked
"I can name 7 European capitals in 10 seconds." Players bid, highest bidder
must deliver or lose the pot. Reuses the existing category accept-lists.
- Fun ceiling high (bluffing + pressure), but turn-taking with an auction phase
  makes rounds slow for 6+ players, and it needs the same fail-closed AI-judge
  problem Blitz already quarantined half its pool over. Cost: medium-high.
  Best revisited after the judge fix.

### 5. ACRONYM BATTLE — not picked
Random 3 letters ("B.T.S."), everyone writes a phrase, table votes for the
funniest. Great humor ceiling, but it's a *writing* game (slow), judging is
pure vote (already Imposter's trick), and rounds are long. Virality good, fit
with "type fast die slow" weak.

### 6. WORD LADDER ROYALE (morph one letter) — not picked
Turn-based: each word must be the previous word ± one letter change. Elegant
and cheap (edit-distance + dictionary), but ladders dead-end constantly —
would need a rescue mechanism doing most of the work, and mid-round it's
quiet/thinky rather than chaotic. Fun ceiling medium.

### 7. WORD THIEF — not picked
Simultaneous category race where duplicate answers get *stolen* by whoever
typed them first (you see claims land in real time). Spicy, but it inverts
Blitz's privacy model for a mechanic that punishes slower typers twice, and
grief/duplicate-race edge cases make the netcode the hard part. Cost high for
a variation on an existing mode.

### The pick, in one line each
- **FUSE** = adrenaline (elimination + hidden shared clock) — cheap, loud.
- **LETTER STORM** = skill (same rack, fair race, offline validation).
- **HERD MIND** = comedy (social convergence, zero knowledge barrier).

Three different emotional registers, three different engine shapes (turn/round/
phase), all buildable on existing plumbing with minimal shared-file edits.

---

## Phase 2 build plan

- `t5Modes.js` — registry: gameType → plugin `{ logic, minPlayers, start,
  handleSubmit, handleLeave }` + `ERROR_MESSAGES` for humanizeError.
- `t5FuseMode.js` / `t5LetterStormMode.js` / `t5HerdMindMode.js` — one file per
  mode: pure logic on top, orchestrator (helper-injected) below. Each has a
  `.test.js` covering the core rules.
- Shared-file touches (kept minimal, all guarded behind the registry):
  - `roomManager.js`: registry require + 4 dispatch hooks (logicForGameType,
    startGame min-players/start, handleWordSubmission, removePlayer) + helper
    object.
  - `server.js`: allow registry gameTypes in `set_game_type`, registry lookup in
    `humanizeError`.
  - `package.json`: 3 test files appended to the test script.

Protocol per mode (client-facing):

**fuse**: `game_started` → `bomb_update {holderId, combo, passCount, players}` →
(3-2-1) → hidden fuse burns; `fuse_hint {level:1|2|3}` at 50/75/90%;
`word_result` (accept broadcast / reject private) + `bomb_update` per pass;
`bomb_exploded {playerId, eliminated, nextHolderId}`; `game_over {winnerId}`.
Client sends the usual `submit_word {word}`.

**letter-storm**: `round_start {round, letters[], timerSeconds}` → `timer_tick`;
`submit_word/answer` → private `answer_result {accepted, word, points|reason}` +
broadcast `player_progress {playerId, wordCount}`; `round_end {playerResults
(words+points), bestMissed[]}`; 5s pause; ×3 rounds → `game_over {winnerId,
finalScores}`.

**herd-mind**: `round_start {round, totalRounds, prompt, timerSeconds}`;
`submit_answer` (one, locked) → private `answer_result` + broadcast
`answer_count {answered, total}` (early phase end when all in);
`round_reveal {groups[{answer, playerIds, points}], blackSheepId, scores}`;
8s pause; ×5 rounds → `game_over {winnerId, finalScores}`.
