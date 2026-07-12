# T10 — Error Flow Audit (Phase 0)

How errors currently move through the backend (and what the player sees), as of
branch `feat/blitz-bot`, 2026-07-12. This is the recon that drives the T10
hardening phases; gaps found here are fixed in later T10 commits.

## 1. What is already caught (solid ground)

| Layer | Mechanism | Outcome |
|---|---|---|
| WS message handler (`server.js`) | whole `switch` wrapped in `try/catch` (incl. `await`ed submissions) | Sentry capture + `error` message to the sender; connection and room survive |
| Malformed client JSON | explicit `try/catch` around `JSON.parse` | `"Malformed message - expected JSON."` to sender |
| Dictionary API (`dictionary.js`) | never throws; **fails open** on network errors | flaky API can't block Word Bomb |
| Haiku validator (`haikuValidator.js`) | never throws; **fails closed**, 3s hard timeout, per-player rate limit | flaky AI judge can't stall Category Blitz |
| Monitoring (`monitoring.js`) | every Sentry/PostHog call wrapped; no-op without env keys | reporting can never break gameplay |
| Bot moves (`roomManager.js`) | `await handleWordSubmission/...` inside `try/catch` in the timeout body | a bot failure is logged, game continues |
| Idle-room reaper | sweep body in `try/catch` | a bad sweep is logged, next sweep runs |
| Express routes | error middleware captures to Sentry, then default handler | HTTP 500, process survives |
| Global: `uncaughtException` | report → flush → `process.exit(1)` (platform restarts) | deliberate: process state is undefined |
| Global: `unhandledRejection` | report + log, **no exit** | a stray rejection can't drop every game |

## 2. What can crash the whole process (gaps — the bad ones)

An `uncaughtException` exits the process → **every room and every connection on
the instance dies at once**. These paths reach it:

1. **Timer callbacks in `roomManager.js` are unprotected.** Any throw inside
   these lands directly on `uncaughtException`:
   - `startTurnTimer` interval body (`handleTimeout`, payload builders, broadcasts)
   - `startRoundTimer` interval body + the `roundPauseTimeout` intermission body
     (`endRound`, `startNextRound`, scoreboard build)
   - `startImposterAnswerTimer` / `startImposterVoteTimer` bodies and
     `endImposterAnswerPhase` / `endImposterVotePhase` (when invoked from timers)
   - `scheduleTimerAfterCountdown`'s `startFn` call
   - the synchronous prelude of bot timeouts (before the guarded `await`)

   This is the single most dangerous surface: one corrupt game object in one
   room = the entire server dies. The message handler equivalent was already
   fixed; the timer equivalent was not.

2. **No `error` listener on accepted sockets or on the `WebSocketServer`.**
   `ws` sockets are EventEmitters: an `error` event with no listener (e.g.
   `ECONNRESET` from a phone dropping off Wi-Fi mid-frame, or an invalid
   close frame) throws → process exits.

3. **The `ws.on('close')` handler body is unprotected.** `removePlayer` does a
   lot (eliminates the leaver, advances the turn, broadcasts, restarts timers) —
   a throw here is an `uncaughtException`.

4. **`broadcastToRoom` / direct `connection.send` calls.** `readyState === 1`
   is checked, but `send()` can still throw on a socket in a torn-down state
   (race between check and call). One bad connection in a room aborts the whole
   broadcast loop mid-way (some players updated, some not) and, if reached from
   a timer, crashes the process.

## 3. What can corrupt/freeze a single room (without crashing)

- If a timer body throws **after** `clearRoundTimer`/`clearTurnTimer` but before
  the next timer is armed, the room is left with a live game and **no clock** —
  a permanently frozen game for everyone in it. There is no "close the room on
  internal error" fallback.
- A mid-loop `broadcastToRoom` failure leaves clients with divergent views of
  the same state (some got `turn_update`, some didn't).

## 4. Logging today

- Plain `console.error/warn` with prose strings. No level convention, no room
  code, no player id, no event name — a production log line like
  `Error handling message submit_word TypeError: ...` can't be tied to a room.
- Sentry captures carry only `wsMessageType`; no room/player tags.
- Happy-path is silent (good). Boot logs the Haiku-validator mode (good).

## 5. What the player sees today (frontend: `wordarcade-frontend`)

| Failure | Player experience | Verdict |
|---|---|---|
| Server rejects an action | `error` message → `friendlyError.js` maps to an on-brand banner | good |
| Socket drops outside a room/game | transparent auto-reconnect w/ backoff ("connecting") | good |
| Socket drops mid room/game | blocking **CONNECTION LOST** overlay, BACK TO MENU button (seat can't be resumed) | good |
| Server process crashes | same as socket drop → CONNECTION LOST overlay | acceptable |
| Room reaped for idleness (`room_closed`) | **nothing — frame is ignored; player sits in a dead lobby forever** (server also tears the room down, so their next action yields "That room no longer exists") | **gap** |
| Message for a room that no longer exists | `error`: "That room no longer exists." → banner via friendlyError | ok, but the player is left *in* the dead view; no route home |
| Server error mid-handler | "Server error processing your request." banner | ok |

## 6. Observability / ops

- `/health` returns `{status:'ok'}` only — no uptime, room count, player count,
  or memory. Fine as a liveness probe, useless for diagnosis.
- `/version` returns the deploy commit (good).
- The t3-harness side-port stats server exists but is test-only.
- No admin/status endpoint, no ADMIN.md runbook.

## 7. Hardening plan (what T10 does about it)

1. **Phase 1** — `logger.js`: tiny structured logger (level, event, roomCode,
   playerId, extra fields; JSON lines; zero deps; forwards errors to Sentry via
   the existing `captureError`). Wrap every timer body in a per-room guard: on
   an unexpected throw, log with full context and **fail the room cleanly**
   (broadcast `room_closed` reason `server_error`, then `destroyRoom`) instead
   of killing the process. Add `error` listeners per socket + on the WSS, wrap
   the close handler, make `broadcastToRoom` per-recipient-safe.
2. **Phase 2** — frontend: handle `room_closed` (idle or error) with a friendly
   overlay + route home; keep everything else (it's already decent).
3. **Phase 3** — protected `/admin/status` endpoint (uptime, rooms, players,
   memory, per-mode counts) + `ADMIN.md` runbook.
4. **Phase 4** — failure-injection tests: throwing timer bodies, throwing
   sends, close-handler throws; assert the process survives and rooms either
   recover or close cleanly.
