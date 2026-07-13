# T2 — Overnight Summary

Mission: hunt concurrency / double-fire / stale-state bugs in the Chain Reaction
WebSocket backend, prove each with a failing test, fix minimally, keep the suite
green. Shared checkout with 9 parallel sessions (T1, T3–T10).

## Bug count by severity

| Severity | Fixed by T2 | Also found by T2, fixed by a parallel session |
|----------|-------------|-----------------------------------------------|
| CRITICAL | 0           | 1 (missing per-socket `ws.on('error')` → one bad frame kills the process) |
| MAJOR    | 3           | 1 (cross-room ghost membership) |
| MINOR    | 4           | — |
| **Total**| **7 fixed** | **2 found & flagged (no double work)** |

T2-fixed, each with a regression test written FIRST:
1. MAJOR — Category Blitz `submitAnswer` TOCTOU across the Haiku AI await
   (cross-round leakage, double-scoring, post-finish scoreboard mutation).
2. MAJOR — liveness guards keyed off `status === 'in_progress'` missed Blitz
   `between_rounds` and every Imposter phase (mid-game joins, `start_game`
   double-fire wiping progress, mid-game bot mutation, reaper killing live
   Imposter games).
3. MAJOR (DoS) — no submission length cap in any mode (fail-open dictionary
   accepted multi-KB "words"; blobs stored and rebroadcast every tick).
4. MINOR — `skip_turn` on a round-based game threw a TypeError.
5. MINOR — host role could pass to a bot, bricking the room.
6. MINOR — Word Bomb game stranded when a non-current player disconnected.
7. MINOR — Imposter vote phase hung on a dead clock after the last hold-out left.

Details, repros, and rationale in `T2-BUGS_FOUND.md`; ranked hunt map in
`T2-ATTACK_SURFACE.md`.

## The single scariest thing I found

**The `status === 'in_progress'` liveness assumption, systemically wrong across
the whole room manager.** It reads as obviously correct — "is a game running?"
— and was copy-pasted into five independent guards (`joinRoom`, `startGame`,
`addBot`, `removeBot`, `reapIdleRooms`). But it is only true for Word Bomb.
Category Blitz spends 5 seconds of every round in `between_rounds`, and Imposter
Word is NEVER `in_progress` for even one tick (its statuses are
`answering`/`voting`/`reveal`/`between_rounds`). So an entire game mode was
effectively unguarded: you could join an Imposter game in progress and become a
ghost, and — worst of all — `startGame` had no already-running check at all, so
a stray second `start_game` (a double-click, a reconnect replay) silently threw
away the live game and re-initialized it under everyone. It is scary because
each call site looks locally fine; the bug only exists in the gap between one
mode's state machine and another's, which is exactly the kind of thing a
single-mode mental model never surfaces. One `isGameLive()` helper now owns the
definition in one place.

## What I'd audit next

1. **A formal state-machine contract per mode.** The root cause of half my
   findings is that `game.status` means different things in different modes and
   nothing enforces the union. I'd define the legal statuses + transitions per
   mode in one table and assert against it, so a guard can ask "is this game
   live?" without knowing the mode.
2. **Every remaining `await` inside a message/timer handler.** I fixed the two
   TOCTOU windows I could prove (Word Bomb dictionary, Blitz Haiku), but the
   pattern "snapshot state → await → mutate without re-checking" is the whole
   ballgame for this server. A sweep for `await` between a read and a write is
   the highest-value next pass.
3. **Unbounded in-memory growth.** `haikuValidator.callTimes` and the
   `dictionary` cache both grow without a ceiling over a process lifetime. Not
   urgent on a restart-on-deploy single instance, but a real leak on a
   long-lived one.
4. **The T5 plugin-mode surface.** New experimental modes
   (`t5FuseMode`/`t5LetterStormMode`/…) plug into the same timer slots and
   leave/submit hooks; they need the same TOCTOU and liveness scrutiny the
   three core modes just got. (Note: `t5LetterStormMode.js` was mid-edit and
   throwing `ReferenceError: STORM_BONUS is not defined` in the working tree at
   the end of my run — a parallel session's incomplete edit, not a T2 change.
   It transitively breaks any suite run that loads `roomManager`; my own
   commits were verified green (285/285) before that file broke, and my
   pure-logic tests, 38/38, stay green independent of it.)

## Verification

- Full suite last seen green at **285/285** (before the unrelated T5 working-tree
  breakage above); `npm run lint` clean.
- 21 new T2 tests across `t2-blitzRace`, `t2-lifecycle`, `t2-inputLimits`,
  `t2-server` (real server + real WS clients), `t2-imposterLeave`.
- Every fix is red-green: the test fails on the pre-fix code and passes after.
- 7 commits, all prefixed `[T2]`, test + fix paired per commit. Never pushed.
- Phase-4 adversarial-review subagent was launched but terminated on a session
  limit before reporting; each fix was reviewed inline as written, and the
  green suite + clean lint stand.
