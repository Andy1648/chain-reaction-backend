# ADMIN — Operating the Chain Reaction Backend

How to check the server's health, read its logs, and diagnose the most likely
production problems. Deployed on Render; logs are in the Render dashboard
(Logs tab), errors also land in Sentry when `SENTRY_DSN` is set.

## Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness: `{"status":"ok"}`. Used by uptime checks. |
| `GET /version` | none | The deployed commit (`RENDER_GIT_COMMIT`). First question in any incident: *what's actually running?* |
| `GET /admin/status` | `ADMIN_TOKEN` | Operational snapshot: uptime, connections, rooms, players/bots, games in progress, per-mode room counts, memory. |

`/admin/status` is disabled (plain 404) until the `ADMIN_TOKEN` env var is set.
Call it with either form:

```
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/admin/status
https://<host>/admin/status?token=<token>        # quick browser check
```

Example response:

```json
{
  "status": "ok", "commit": "abc123", "uptimeSeconds": 86400,
  "connections": 14, "rooms": 5, "publicRooms": 2, "gamesInProgress": 3,
  "players": 11, "bots": 2, "roomsByGameType": { "word-bomb": 3, "category-blitz": 2 },
  "memory": { "rssMb": 92, "heapUsedMb": 41 }
}
```

## Reading the logs

Operational events are one **JSON object per line** (from `logger.js`):

```json
{"ts":"2026-07-12T04:10:00.000Z","level":"error","event":"round_timer_error","roomCode":"ABX42","error":"...","stack":"..."}
```

- `level` — `info` (lifecycle), `warn` (survivable oddity), `error` (something broke).
- `event` — grep-able snake_case name. The important ones:
  - Lifecycle: `server_listening`, `room_created`, `game_started`, `room_destroyed`, `room_reaped`
  - Handler failures (survived, player got an error reply): `ws_message_error`
  - Timer failures (survived, **that room was closed**): `turn_timer_error`,
    `round_timer_error`, `round_intermission_error`, `countdown_start_error`,
    `imposter_answer_timer_error`, `imposter_vote_timer_error`, `imposter_reveal_pause_error`
  - Disconnect-cleanup failure (room closed): `player_disconnect_error`
  - Socket noise (harmless, ws cleans up): `ws_socket_error`, `ws_send_failed`, `broadcast_send_failed`
  - Bot hiccups (bot just misses its beat): `bot_move_failed`, `blitz_bot_answer_failed`
- `roomCode` / `playerId` — filter a whole incident with `grep ABX42`.

Design intent: **nothing that happens inside one room can kill the process.**
An unexpected error on a room's timer path closes *that room* (players get a
`room_closed` with reason `server_error` and the frontend routes them home)
and logs one `error` line. If the process ever exits, that's `uncaughtException`
(logged as `Uncaught exception:` + Sentry) and Render restarts it.

## The three most likely production issues

### 1. "Everyone got disconnected at once"

The process restarted. Check, in order:
1. `GET /admin/status` → `uptimeSeconds` small = recent restart. `GET /version` → did a deploy just land? Render deploys restart the process; every seat is dropped by design (no session resume) and clients show CONNECTION LOST.
2. If it wasn't a deploy: Render logs around the gap for `Uncaught exception:` (the one thing that still exits on purpose) — the stack is in the log line and in Sentry. Also check Render's own OOM/restart notices; compare `memory.rssMb` history.

### 2. "Our room froze / suddenly closed"

One room, not the server. Get the room code from the player and grep the logs for it:
- `*_timer_error` / `player_disconnect_error` with that `roomCode` → the server hit an internal error and deliberately closed the room (`reason: server_error`). The stack in that line is the bug to fix; Sentry has it too, tagged with the room and event.
- `room_reaped` → the lobby idled past 20 minutes (in-progress games are never reaped) and was swept; players saw ROOM CLOSED. Not a bug.
- Nothing in the logs → the freeze is client-side or network; check whether other players in the same room kept playing (if yes: that one player's connection dropped — they get the CONNECTION LOST overlay, their seat is forfeited by design).

### 3. "Valid words / answers keep getting rejected" (or accepted garbage)

Two different validators:
- **Word Bomb** uses dictionaryapi.dev and **fails open** — an API outage never blocks play, it just lets more words through. Grep `Dictionary API` warns; a burst of them explains "garbage got accepted", not rejections. Rejections here are genuinely-not-in-dictionary words (or not matching the combo).
- **Category Blitz** list-misses go to Claude Haiku, which **fails closed** — over the 3s timeout / per-player rate limit (10/min) / API errors / missing `ANTHROPIC_API_KEY`, the answer is rejected. Boot log says whether AI validation is `ENABLED` or `DISABLED (list-only)`. Set `VALIDATOR_DEBUG=1` (temporarily) to log each rejection's cause. A player spamming answers will hit the rate limit and see rejections for a minute — expected.

## Env vars that matter here

See `.env.example` for the full annotated list: `ADMIN_TOKEN` (this endpoint),
`SENTRY_DSN` (error reporting), `ANTHROPIC_API_KEY` (Blitz AI validation),
`VALIDATOR_DEBUG` / `FAKE_DICTIONARY` (debug only — never in production).
