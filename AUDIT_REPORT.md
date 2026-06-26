# AUDIT REPORT — chain-reaction-backend (READ-ONLY)
_Branch: `night/audit` · 2026-06-26 · reconnaissance only — NOTHING was changed, fixed, or deleted_

> ⚠️ Branch-only scratch. This branch holds **only** this report; no code was modified. Triage with Claude tomorrow. Delete before any merge. A separate `AUDIT_REPORT.md` exists on `night/audit` in the frontend repo.

**No process-crashing defects found** — the global handlers (`server.js:24-39`) + the per-handler `try/catch` (`server.js:144-443`) + null-checks on every `getRoomForConnection` keep a thrown handler from taking down the process. **`npm audit`: 0 vulnerabilities.** Findings below are correctness/robustness improvements, not fires.

---

## TOP 5 TO FIX FIRST
1. **`roomManager.js:790-820` — TOCTOU race in `handleWordSubmission`** (Medium, live state corruption). The "is it your turn" check runs BEFORE `await logic.submitWord` (which awaits the real dictionary fetch). In the last ~1s of a turn with an uncached lookup in flight, the turn-timer's `handleTimeout` can fire mid-await → on resolve the word is applied to a turn that already advanced: double `advanceTurn`, a wrongly-lost life, a player skipped, and `clearTurnTimer` kills the next player's timer. Fix: after the await, re-validate `game.status==='in_progress' && getCurrentPlayerId(game)===connectionId` before applying — else return `{accepted:false, reason:'turn_over'}`. (Or clear the timer before awaiting, restart only on reject.)
2. **`server.js:349` — `submit_word`/`submit_answer` text not length-capped** (Medium, DoS-ish). Every other relay caps input (typing_update→50, reaction→4, names→20) but submissions go full-length into `.includes`, the dictionary regex, and answer arrays — a client can send megabyte strings per submit. Fix: `.slice(0, 100)` on the extracted text, matching the other relays.
3. **`dictionary.js:7` — validity `cache` Map grows unbounded** (Medium, slow leak). Every distinct alphabetic guess (true AND false) is cached forever. Fix: cap with FIFO/LRU eviction, or only cache positives.
4. **Dead validator files `aiValidator.js` + `gemini.js`** (Dead code). Both superseded by `haikuValidator.js`; never `require`d by app code (`aiValidator` header even says "kept for reference"). Fix: delete (after confirming nothing external references them).
5. **`roomManager.js:998-1006` — imposter leaver not reconciled** (Low). If the leaver WAS the imposter, `game.imposterId` is left dangling; `endVotePhase` finds no imposter and the round resolves degenerate (`imposterName:null`, "imposter survived"). Fix: if `connectionId===game.imposterId`, end/skip the round or pick a replacement.

---

## MEDIUM
- **`roomManager.js:790-820` — [RACE] `handleWordSubmission` TOCTOU** — see Top-5 #1. Only triggers in the last ~second of a turn while a real (uncached) dictionary lookup is in flight, but it's genuine live game-state corruption (double advance / wrong life loss / next-player timer killed).
- **`server.js:349` — [DOS-ish] submission text not length-capped** — see Top-5 #2.
- **`dictionary.js:7` — [RESOURCE] unbounded validity cache** — see Top-5 #3.

## LOW
- **`dictionary.js:45-48,54-57` — [BUG/quality] lookups fail OPEN** — any non-404 error or thrown fetch returns `true`, so during a Dictionary API outage every combo-containing guess is accepted, silently degrading Word Bomb (invisible except an ungated `console.warn`). This is a documented deliberate choice; flagged as a risk. Optional fix: fall back to the bundled `botWords.txt` corpus as a local check before failing open.
- **`roomManager.js:998-1006` — [BUG] imposter leaver `imposterId` not reconciled** — see Top-5 #5.
- **Category-Blitz / Imposter — [BUG] no game-end when roster drops below minimum mid-game** — if all but one player leave, `removePlayer` just filters and phase timers run solo to the natural finish (wasted rounds, not a crash). Fix: in `removePlayer`, if a simultaneous-mode game falls below `MIN_PLAYERS_TO_START`, broadcast `game_over`/teardown.
- **`roomManager.js:286-320` — [LIFECYCLE] `startTurnTimer` counts a local `remaining`, not the `room.turnDeadline` it writes** — `turnDeadline` is set but never read, so an event-loop stall drifts the timer instead of catching up (minor for casual play). Fix: drop the unused `turnDeadline`/`roundDeadline` writes, or compute `remaining` from the deadline each tick.
- **`haikuValidator.js:40,56-67` — [RESOURCE] `callTimes` Map keyed by per-connection `playerId`, pruned to empty arrays but entries never deleted** — slow leak over a long-lived process with many connections (small per entry). Fix: `callTimes.delete(playerId)` when the pruned array is empty.

## LIFECYCLE / RACE — verified OK (noting because they're the obvious suspects)
- **`roomManager.js:674-693` — bot-move `setTimeout` correctly re-checks `room.game.status` + `getCurrentPlayerId` after its delay**, and `clearBotMove` is reached via `clearTurnTimer` on every teardown (`destroyRoom`). No use-after-free.
- **Timer cleanup is solid:** `destroyRoom`, `resetGame`, `removePlayer`, empty/all-bot paths, and `_resetRoomsForTesting` all clear turn/round/countdown/bot timers; the idle-room reaper is `unref`'d + idempotent. No leaked intervals spotted.
- **Backstops present:** `MAX_ACTIVE_ROOMS` (500), per-connection create throttle, `MAX_PLAYERS_PER_ROOM`, idle-room reaper, Haiku per-player rate limit (10/min, 3s abort).

## DEAD CODE (candidates — described, NOT removed)
- **`aiValidator.js` (whole file)** — retired Groq/Gemini validator; not `require`d anywhere in app code (header says "kept for reference"). Delete candidate.
- **`gemini.js` (whole file)** — superseded by `haikuValidator`; never required. Delete candidate.
- **`monitoring.js:70 posthogTrack`, `:79 shutdownAnalytics`** — neither called in app code; `shutdownAnalytics` is never wired to SIGTERM. With posthog `flushAt:1/flushInterval:0` the missing flush is harmless. Fix: wire `shutdownAnalytics` into `process.on('SIGTERM')`, or drop the exports.
- **`gameLogic.js:251 turnDeadline` / roomManager `roundDeadline`** — written, never read (see Lifecycle).
- *(Not dead — intentional dev tooling: `comboExpand.js`, `imposterPairsExpand.js` are `node`-run generators, not runtime code. `gameLogic.test.js` ignored per scope.)*

## CONSOLE HYGIENE — clean
- No `debugger` statements; no TODO/FIXME/HACK in app code (grep hits were category data like "hacky sack" + node_modules).
- `console.log` is all intentional: `server.js:492,497` (startup banner), the generator scripts (CLI output). Validator/dictionary logs are `console.warn`/`console.error` on failure paths.
- **`dictionary.js:46,55` warns are ungated** — fire on every API failure; if the Dictionary API flaps these get noisy in prod logs (Low). (`gemini.js` warns are moot — dead file.)

## DEPENDENCY / SECURITY
- **`npm audit`: found 0 vulnerabilities.** No action.
- No obviously-unused runtime deps flagged; the dead code above is first-party files.

---

### One-line bottom line
Solid, defensively-written backend. The one finding with real gameplay impact is the `handleWordSubmission` await race (#1); the rest are hardening (input cap, cache eviction) + housekeeping (delete two dead validator files).
