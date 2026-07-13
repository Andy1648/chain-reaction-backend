# T1-SUMMARY.md — test-coverage mission report

*Session T1, night of 2026-07-12. Companion doc: `T1-ARCHITECTURE.md` (repo map + critical-logic ranking).*

## What T1 added

All new tests live in `tests/` (existing flat `*.test.js` suites were left untouched); everything runs under Node's built-in runner via `npm test`.

| File | Tests | What it proves |
|---|---|---|
| `tests/imposterWordLogic.test.js` | 26 | The entire social-deduction rule set, previously **0% covered**: setup, answer/vote validation, the strict-plurality catch rule (catch / tie / zero votes / mob-on-innocent), scoring, imposter rotation + wraparound, non-repeating pairs, results ordering. |
| `tests/categoryBlitzLogic.test.js` | 21 | Two-stage answer validation with a stubbed AI judge (list hit never calls AI; miss accepted when AI off, judged when on; `onAiCheck` timing), reroll semantics (score revert, clamp, allowance), pack filtering incl. a full game played per advertised pack id, round advancement, tie-breaks, content invariants (lowercase accept-lists). |
| `tests/haikuValidator.test.js` | 10 | The FAIL-CLOSED contract end to end: only a healthy "yes" accepts; HTTP errors, thrown fetches, the 3s abort (driven by mock timers), garbled replies, and a missing key all reject; the per-player sliding-window rate limit blocks the 11th call *without* burning an API call and never throttles other players. |
| `tests/dictionary.test.js` | 8 | The FAIL-OPEN contract: garbage input (unicode, injection strings, NUL bytes) rejected before any network I/O; 404/entries/empty-array verdicts cached; outages fail open *without* caching the courtesy verdict; `markAsValid` pre-warm. |
| `tests/roomManager.gating.test.js` | 19 | Submission gating (no game / wrong turn), message privacy (rejections go only to the submitter; Blitz rivals see a count, never the answer text), the full reroll guard chain + authoritative restart broadcast, imposter vote orchestration (privacy-safe counts, early phase end), host reassignment, mid-game disconnect elimination, idle-reaper TTL rules, the 500-room cap. |
| `tests/gameLogic.edge.test.js` | 11 | Input normalization (combo match on the normalized word, case-insensitive dedup), hostile input never crashing or consuming turns, degenerate rosters (solo, all-eliminated → null winner, ghost-id desync, and a turnOrder of only-eliminated players that terminates solely thanks to the safety counter), dead-combo rescue counting only active players. |
| `tests/integration.flows.test.js` | 3 | Full in-process flows with real timers: a complete Word Bomb game (join → live turns → real timeout elimination → game_over), a complete 3-round Category Blitz game on 1s clocks (round_end reveals → intermission → next round → final scoreboard), and a full Imposter round (private prompts, public answers, real phase expiry, early vote end, reveal scoring). |

**98 new tests.** Suite state at time of writing: **294+ tests, 0 failures** repo-wide (other sessions are adding their own suites in parallel — T2 lifecycle/races, T3 harness, T5 new modes; totals keep growing).

## Review pass (Phase 4)

A subagent reviewed all seven T1 suites for restated implementations, weak assertions, flakiness, and isolation problems. Acted on: the tautological PACK_IDS check and the all-packs-instead-of-each-pack test (replaced during self-review with a per-pack full-game loop), a redundant normalization test (now covers combo-match-only-after-lowercasing), and the HIGH finding that the safety-counter test never actually entered the skip loop (a real counter-exercising case was added). Remaining LOW-priority reviewer suggestions worth picking up later: pin the blitz `makeGame` test category into `usedCategories` so reroll-exclusion assertions can genuinely fail, restore-on-exit for module-level dictionary/CATEGORY_ANSWERS patches (only matters if tests ever share a process), a mocked-clock test that the haiku rate window actually slides, a not-cached assertion for the dictionary thrown-fetch path, and an integration assertion that the imposter pair's `fake` category never appears in any payload.

## Infrastructure changes

- `npm test` now runs `node --test` auto-discovery instead of a hand-maintained file list. This fixed a real gap: `turnRace.test.js` (the TOCTOU regression suite) existed but was **silently excluded** from `npm test`.
- Added `npm run test:coverage` (Node's built-in coverage reporter).

## Production code changes

**None.** The only non-test file T1 touched is `package.json` (the two script lines above). No production module was modified, even trivially.

## Coverage (node --experimental-test-coverage, full repo suite)

| Module | Line % | Branch % | Notes |
|---|---|---|---|
| `imposterWordLogic.js` | 100 | 100 | was 0% before tonight |
| `categoryBlitzLogic.js` | 99.4 | 97.0 | uncovered: an unreachable defensive branch |
| `gameLogic.js` | 98.7 | 93.2 | uncovered: corpus-unreadable fallback |
| `haikuValidator.js` | 98.6 | 82.4 | uncovered: DEBUG-only log lines |
| `dictionary.js` | 96.1 | 94.1 | uncovered: FAKE_DICTIONARY harness hook |
| `roomManager.js` | 92.1 | 84.1 | uncovered: mostly bot-timing internals + reaper interval body |
| `wordBombBot.js` / `categoryBlitzBot.js` | 100 | ~90+ | |
| `server.js` | 59.4 | 34.8 | see "next" below |
| `monitoring.js` | 58.5 | 50.0 | Sentry/PostHog no-op wiring |

## Observations for other sessions (not bugs my tests could fail on)

- Imposter/Blitz answers have no per-answer length cap (only the new 64 KiB frame cap from `security.js` bounds them); a multi-KB "answer" is accepted and rebroadcast/revealed. The security session's caps mostly mitigate this — flagging in case they want a ~100-char answer cap like the 50-char typing relay and 20-char names.

## The 3 areas most in need of tests next

1. **`server.js` message routing (59% line / 35% branch)** — the switch itself: host-only guard rejections per message type, malformed-JSON handling, the create_room throttle, `set_packs` validation, the `typing_update`/`spectator_reaction` relays, and disconnect cleanup via `ws.on('close')`. Needs either a live `ws` client pair or extracting the router; T3's harness is the natural home.
2. **Bot scheduling stale-world guards in `roomManager.js`** — the re-check blocks inside `maybeScheduleBotMove` / `scheduleBlitzBotAnswers` (turn advanced, category rerolled, bot removed, game reset mid-timeout) are the biggest uncovered chunk of the room manager and exactly the kind of code that breaks silently.
3. **`monitoring.js` + the global error handlers in `server.js`** — verify Sentry/PostHog stay no-ops without keys and that `captureError` never throws (the handlers wrap it, but nothing proves it).
