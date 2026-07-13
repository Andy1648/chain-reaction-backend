# T10 — Server Hardening & Error Handling: Summary

Mission: make the backend crash-proof, diagnosable, and honest with players when
things break. All phases complete; full suite green (294 tests) and lint clean.

## What shipped

| Phase | Deliverable | Commit |
|---|---|---|
| 0 | `T10-ERROR_AUDIT.md` — mapped every error path, found the gaps | `25056dc` |
| 1 | `logger.js` + crash-proof room timers (server hardening) | `23466fc` (+ swept into `a1f9a4a`/`3bb3dc6`) |
| 2 | Frontend `room_closed` overlay (separate repo, `eb040a6`) | frontend |
| 3 | `GET /admin/status` + `ADMIN.md` runbook | `c6be930` (endpoint swept into concurrent commits) |
| 4 | `errorHandling.test.js` — failure-injection coverage | `e661b73` |

## The core problem, and the fix

**Before:** any throw inside a room's `setInterval`/`setTimeout` body (turn
timer, round timer, imposter phase timers, countdown, bot moves) reached
`uncaughtException` → `process.exit(1)` → **every room on the instance died at
once.** A single corrupt game object took down every live game. The WS *message*
handler was already try/caught; the *timer* paths were not.

**After:** every timer body runs through `guardRoom(room, event, fn)`. On an
unexpected throw it:
1. logs one structured `error` line with `roomCode` (+ forwards to Sentry),
2. broadcasts `room_closed` reason `server_error` to that room's players,
3. tears down **only that room** (`failRoom` → `destroyRoom`, all timers cleared,
   registry entry removed even if teardown itself throws).

Blast radius went from "the whole server" to "one room." Players in the broken
room get routed home with a friendly notice instead of a frozen screen.

## Everything else hardened

- **`broadcastToRoom`** — per-recipient try/catch. One socket dying mid-send
  (the readyState-flips-after-the-check race) no longer aborts the broadcast or,
  from a timer, crashes the process. Same treatment on the imposter per-player
  `round_start` sends and the low-level `send()` helper.
- **Sockets** — added `ws.on('error')` per connection and `wss.on('error')`.
  Without these, an `ECONNRESET` (phone drops off Wi-Fi mid-frame) or an invalid
  close frame is an unhandled `'error'` event → process exit. (server.js part.)
- **`ws.on('close')`** — rewritten to look the room up directly (not via the
  error-sending `getRoomForConnection`), drop the connection→room mapping first,
  and wrap `removePlayer` so a throw during disconnect cleanup fails the room
  cleanly instead of crashing.
- **Bot timers** — whole body in try/catch (not just the `await`), so a throw in
  the pre-flight guards can't escape a timer. A bot failure is just a missed beat.

## Structured logging (`logger.js`)

Zero dependencies. One JSON object per line: `{ ts, level, event, roomCode,
playerId, ... }`. `logError` also forwards to Sentry via the existing
`monitoring.captureError`, so structured logs and Sentry stay in sync from one
call site. Happy path stays silent; lifecycle events log at `info`
(`room_created`, `game_started`, `room_destroyed`, `room_reaped`,
`server_listening`), survivable oddities at `warn`, breakage at `error`. Every
line carries the room/player context needed to reconstruct an incident with a
single `grep <roomCode>`.

## Observability (`GET /admin/status` + `ADMIN.md`)

Protected status endpoint (disabled entirely — plain 404 — until `ADMIN_TOKEN`
is set; timing-safe token compare via `Authorization: Bearer` or `?token=`).
Reports uptime, live connections, room/player/bot counts, games in progress,
per-mode room breakdown, and memory. `ADMIN.md` is the ops runbook: how to read
the structured logs and step-by-step diagnosis for the three most likely
production issues (mass disconnect / one room froze / validator rejecting words).

## Player-facing failures (frontend)

The backend already had a good CONNECTION LOST overlay for mid-game socket
drops. The gap was `room_closed`: the frame was ignored, leaving players in a
dead lobby. Now a blocking **ROOM CLOSED** overlay (reusing the connlost styles)
shows a reason-specific message (idle sweep vs. contained server error) with a
BACK TO MENU exit.

## Tests (`errorHandling.test.js`, 9 tests)

Failure injection, all passing: guardRoom contains a throw to one room while a
bystander room survives; failRoom clears every timer slot; a throwing socket
doesn't abort a broadcast; a real turn-timer tick on corrupted game state fails
the room cleanly; the reaper notifies players; `getRoomStats` counts correctly.
Two integration tests spawn the **real** server as a child process: `/admin/status`
auth gating + payload shape, malformed/unknown WS messages get graceful replies,
and an abrupt RST-style socket death mid-room leaves the process answering and
the room cleaned up. Full repo suite: **294 pass, 0 fail**; `npm run lint` clean.

## Working in the shared checkout

This repo was edited live by several parallel sessions (T1/T2/T3/T5/T7). I
stayed within the error-handling surface, made minimal edits to the shared
`server.js`/`roomManager.js`, and committed with explicit pathspecs so I never
swept another session's uncommitted work into a T10 commit. Some of my edits to
the shared files landed inside concurrent sessions' commits (`a1f9a4a` [T7],
`3bb3dc6` [T5]) — expected and harmless; the code is present and verified in
`HEAD`. No branch switches, resets, or reverts of others' work.

## Follow-ups (not done, low priority)

- A review subagent was spawned but hit the session limit before returning
  findings. Worth re-running `/code-review` on the T10 diff when convenient.
- `getActivePlayers` was added to the gameLogic imports by another session but
  isn't used by T10 code — no action needed, just noting it's theirs, not mine.
- Consider adding a `room_closed` reason to the `/admin/status` payload history
  (currently the endpoint is a live snapshot only).
