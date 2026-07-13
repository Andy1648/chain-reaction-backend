# T1-ARCHITECTURE.md — Chain Reaction backend map

*Written by session T1 (test-coverage mission), 2026-07-12. Doubles as repo documentation.*

## Stack

- **Runtime:** Node.js >= 18 (verified on v24.17.0), plain CommonJS, no build step, no TypeScript.
- **Package manager:** npm (`package-lock.json` present).
- **Frameworks:** Express 4 (only `/health`, `/version` + error middleware) and `ws` 8 (all real traffic). Sentry + PostHog for monitoring (graceful no-ops without env keys).
- **Test runner:** Node's built-in `node:test` + `node:assert/strict` — zero test dependencies. `npm test` runs an explicit file list.
- **Layout:** flat — every module lives at the repo root; accept-list content data lives in `categoryAnswers/*.js` (~4k lines of Sets).
- **State:** entirely in-memory, single instance. No DB, no persistence. A `Map` of rooms in `roomManager.js` is the whole world.

## How the system fits together

```
client (WordArcade frontend, WebSocket JSON {type, payload})
   │
server.js ───── message router / auth-ish guards (host-only checks, throttles)
   │                 humanizeError() maps error codes -> user strings
   ▼
roomManager.js ─ owns ALL timers (turn, round, phase, countdown, bot moves,
   │             reaper) + room registry + broadcasting. The ONLY stateful
   │             orchestration layer.
   ▼
game logic modules (pure, no timers/network):
   ├─ gameLogic.js          Word Bomb (turn-based: combos, lives, elimination)
   ├─ categoryBlitzLogic.js Category Blitz (simultaneous rounds, scores)
   └─ imposterWordLogic.js  Imposter Word (social deduction: phases, votes)

validators:
   ├─ dictionary.js      Word Bomb word check (dictionaryapi.dev, FAILS OPEN,
   │                     in-memory cache, markAsValid pre-warm)
   └─ haikuValidator.js  Category Blitz Stage-2 AI judge (Claude Haiku,
                         FAILS CLOSED, 3s timeout, 10 calls/min/player)

bots (pure helpers; roomManager owns their setTimeouts):
   ├─ wordBombBot.js       picks real words from botWords.txt (~18k words)
   └─ categoryBlitzBot.js  picks answers from the category accept-lists

content data:
   ├─ categoryAnswers.js   merges categoryAnswers/* into {category -> Set},
   │                       with union-merge supplements + FOLDS renames
   ├─ categoryPacks.js     {category -> pack id} (drives set_packs filtering)
   └─ botWords.txt         frequency-ranked common-word corpus
```

### Player / room / game flow

1. On WS connect, the server assigns `ws.id = randomUUID()` — this **is** the player id for the room's lifetime. The client learns it via the `connected` message.
2. `create_room` / `join_room` / `quick_play` put the connection into a room (`connectionToRoomCode` map tracks membership). Room codes: 5 chars from a 32-char set excluding `0/O/1/I`.
3. Host picks `set_game_type` (`word-bomb` | `category-blitz` | `imposter-word`), `set_difficulty`, optionally `set_packs` (Blitz) or `add_bot` (Word Bomb / Blitz solo only).
4. `start_game` → `roomManager.startGame` → `logicForGameType().createGame(...)`, stamps `game.gameType`, broadcasts `game_started`, then per mode:
   - **Word Bomb:** `turn_update` immediately, turn timer starts after a 3s countdown delay. Timer ticks broadcast each second; timeout costs a life and chains into the next turn's timer.
   - **Category Blitz:** `round_start` immediately, round timer after the countdown. Round end → `round_end` (+ sample answers) → 5s intermission → next round or `game_over`.
   - **Imposter Word:** per-player `round_start` (the imposter sees a different prompt), answer-phase timer → `vote_phase_start` → vote timer (ends early when all vote) → `vote_results` → 7s reveal → next round or `game_over`.
5. `submit_word` / `submit_answer` both route through `handleWordSubmission`, which dispatches on `game.gameType`.
6. Disconnect → `removePlayer`: empty room (or bots-only) is destroyed; host is reassigned; a mid-game Word Bomb leaver is force-eliminated and the turn advanced; Blitz/Imposter leavers are just dropped from rosters.
7. A once-a-minute reaper deletes rooms idle > 20 min unless a game is `in_progress`. `MAX_ACTIVE_ROOMS = 500` caps creation; a per-connection throttle (5 creates/min) sits in server.js.

## Top 10 critical pieces of logic (ranked by "how bad if it silently breaks")

1. **`gameLogic.submitWord` validation + TOCTOU race guard** (`gameLogic.js:392`) — the core Word Bomb rule set AND the mid-await turn-race discard. A silent break means wrong words accepted, double turn-advances, skipped players, corrupted timers. (Race has a dedicated regression suite: `turnRace.test.js` — which was **missing from `npm test`** until Phase 1.)
2. **`advanceTurn` / `handleTimeout` / elimination & win detection** (`gameLogic.js:320-381`) — lives, eliminated-player skipping, `status='finished'` + `winnerId`. A break here hangs games or crowns the wrong winner.
3. **`roomManager.startTurnTimer` / `startRoundTimer` chains** — the only wall-clock authority. Every path must `clear*` before `start*`; a leak = two racing timers = double timeouts, double round-ends (state corruption that only shows under real concurrency).
4. **`handleWordSubmission` / `handleCategoryAnswer` routing + turn/phase gating** (`roomManager.js:856-959`) — "is it your turn / is the round active" enforcement, private-vs-broadcast result delivery (Blitz answers must NOT leak to opponents mid-round).
5. **`categoryBlitzLogic.submitAnswer` two-stage validation** — accept-list hit → instant accept; miss → Haiku judge only if enabled, else accept (list-only mode). Getting the enabled/disabled branch wrong either rejects every creative answer or waves garbage through. Per-player-per-round dedup guards scoring.
6. **`imposterWordLogic.endVotePhase` plurality + scoring** — imposter caught only on a *strict* plurality; ties favor the imposter (+3), catchers score +1 each. Wrong tally logic silently misawards every round.
7. **`haikuValidator.validate` fail-closed contract** — 3s timeout, per-player sliding-window rate limit (10/min), any failure → reject. If it accidentally failed open, garbage floods scores; if the rate limiter breaks, one player burns the API budget.
8. **`dictionary.isValidWord` fail-open contract + input hygiene** — non-alphabetic input always rejected (blocks injection into chain logic); network failure treated as valid (availability over strictness); cache prevents API hammering. The **opposite** failure policy from haikuValidator, deliberately.
9. **`removePlayer` disconnect handling** (`roomManager.js:1054`) — room destruction, host reassignment, mid-game force-elimination + turn advance. A break strands games on a departed player's turn forever.
10. **`categoryBlitzLogic.rerollCategory` + roomManager's reroll guards** — score revert (can't farm points then swap), host-only in multiplayer, 5s opening window, per-game allowance by difficulty. Also `startNextRound` non-repeat category picking.

Honorable mentions: `quickPlay` race-safe retry, `reapIdleRooms` (never reap in-progress games), bot scheduling stale-world guards (`scheduleBlitzBotAnswers` / `maybeScheduleBotMove` re-check everything after their setTimeout fires), `pickRandomCombo` weighting.

## Pre-existing test coverage (before T1)

| File | Tests | Covers |
|---|---|---|
| `gameLogic.test.js` | 24 | Word Bomb rules, timer curve, combo pressure, Blitz `endRound` samples |
| `roomManager.test.js` | 25 | public rooms, quickPlay, bot add/remove lifecycle, live Blitz bot round |
| `wordBombBot.test.js` | 8 | word picking, timing bounds |
| `categoryBlitzBot.test.js` | 11 | answer picking, schedule pacing |
| `turnRace.test.js` | 3 | TOCTOU regression — **was not in `npm test`** |

**Untested before T1:** `imposterWordLogic.js` (entirely), `haikuValidator.js`, `dictionary.js`, `categoryBlitzLogic.submitAnswer`/`rerollCategory`/`startNextRound`/pack filtering, roomManager's word-submission gating / reroll guards / imposter orchestration / `removePlayer` / reaper / room-cap, `monitoring.js`, `server.js` message routing.
