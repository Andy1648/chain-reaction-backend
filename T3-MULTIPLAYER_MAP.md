# T3 — Multiplayer Architecture Map

*Written by session T3 (resilience/load night shift). Recon snapshot as of branch `feat/blitz-bot`, commit `dfd6ce7`.*

## Transport

- **Raw `ws` WebSocketServer** (v8) mounted on the same Node `http` server as an Express app (`server.js:101-102`). Express serves only `/health`, `/version`, and error middleware — **all game traffic is WebSocket**.
- Wire protocol: JSON text frames, `{ type: string, payload: object }` in both directions. Malformed JSON gets an `error` reply.
- No socket.io, no rooms/namespaces at the transport level — room routing is entirely application-level.
- Single process, single instance. Port from `PORT` env (default 3001). Deployed on Render (`RENDER_GIT_COMMIT` in `/version`).

## Identity model

- Each connection gets `ws.id = crypto.randomUUID()` at connect (`server.js:134`) and is immediately told it via a `connected` message. **The connection id IS the player id** for the room's lifetime.
- **There is no session/auth token and no reconnect support.** If a socket drops, that identity is gone forever — a "reconnect" is a brand-new player. Mid-game (Word Bomb) a disconnect is treated as elimination; in a lobby it's simply leaving.

## State storage

- **Everything is in-memory** in a single `Map` (`rooms` in `roomManager.js:74`), `roomCode -> room`. No Redis, no DB, no persistence. A restart drops all rooms/games.
- `connectionToRoomCode: Map<ws.id, roomCode>` in `server.js:106` tracks which room each live socket belongs to (used by `getRoomForConnection`).
- The room object holds: `code`, `hostId`, `players[]` (each with a **live `connection` reference**), `game` (null until started), `isPublic`, `difficultyKey`, `gameType`, activity timestamps, and **six timer slots**: `turnTimerInterval`, `roundTimerInterval`, `roundPauseTimeout`, `countdownTimeout`, `botMoveTimeout`, `blitzBotTimeouts[]`.

## Room lifecycle

1. **Create**: `create_room` → 5-char code (no 0/O/1/I). Per-connection throttle: 5 creates/60s (`server.js:113-121`). Global cap: 500 active rooms → `server_busy`.
2. **Join**: `join_room` by code. Guards: room exists, game not `in_progress`, < 8 players. **Joining a finished-game room is allowed** (`room.game` stays set after game over until rematch, so finished rooms are join-able mid-scoreboard — but excluded from the public list, which requires `game === null`).
3. **Discovery**: `list_public_rooms` (public + `game === null` + not full) and `quick_play` (join fullest candidate, retry down the list on races, else create a public room under the same create-throttle).
4. **Start**: host-only `start_game`. Min players: 2 (Word Bomb / Blitz), 3 (Imposter), 1 (solo Blitz auto-detect). Tears down leftover timers first (rematch-spam safety).
5. **Rematch**: host-only `rematch` → `resetGame` clears all timers, `game = null`, broadcasts `room_update` + `game_reset`.
6. **Leave/disconnect**: `leave_room` or socket `close` → `removePlayer`:
   - Empty room → `destroyRoom` (clears all timers, deletes from Map).
   - Only bots left → `destroyRoom`.
   - Host left → `hostId = players[0].id` (⚠ `players[0]` can be a bot — see findings).
   - Word Bomb in-progress: leaver is force-eliminated (lives=0); if it was their turn, turn advances and timer restarts.
   - Blitz / Imposter: leaver filtered out of `game.players` (and `game.order` for Imposter); round timers keep running.
7. **Reaper**: one global unref'd interval, 60s sweep, deletes non-empty rooms idle > 20 min **unless a game is `in_progress`** (never reaped mid-game). Reaped players get `room_closed`. `lastActivity` is bumped by `touchRoom()` on join/leave/start/accepted-submission/rematch.

## Game modes & state sync

All three modes are **server-authoritative broadcast**: clients send intents, server mutates the single game object and broadcasts full/partial snapshots. No client-side state is trusted.

### Word Bomb (turn-based)
- `gameLogic.js` is pure state; `roomManager.js` owns timers.
- Per-turn `setInterval` at 1s broadcasting `timer_tick`; timeout costs a life, advances turn, chains next timer. First timer of a game/round is delayed 3s (`countdownTimeout`) for the client 3-2-1 animation.
- `submit_word` → turn check in `handleWordSubmission` → `submitWord` awaits **dictionaryapi.dev** (in-memory cache, fails OPEN on network error). Has a **TOCTOU race guard** (`turn_over`) for turn-advance-during-await — fixed previously in `turnRace.test.js`.
- Sync messages: `turn_update` (full snapshot: current player, timer, combo, usedWords, lives), `word_result`, `turn_timeout`, `game_over`.

### Category Blitz (simultaneous rounds)
- 3 rounds × 20s round timer + 5s intermission (`roundPauseTimeout`). Any player submits anytime; answers validated against pre-generated accept-lists, falling back to a **Claude Haiku judge** (only if `ANTHROPIC_API_KEY` set; otherwise list-miss = accept).
- Private `answer_result` to submitter; public `player_progress` (count only). `round_end` reveals all answers + samples. Host can `reroll_category` in the first 5s (restarts round).
- ⚠ `submitAnswer` awaits the Haiku judge with **no round-end race guard** (unlike Word Bomb's) — an answer resolving after `endRound` still does `score += 1` (see findings).

### Imposter Word (social deduction, phases)
- 5 rounds, phases: answering → voting → reveal (7s pause). Per-player `round_start` (imposter sees a different category — the only non-broadcast send). Votes end the phase early when everyone's in.
- Reuses the same `roundTimer`/`roundPause`/`countdown` slots as Blitz.

### Bots
- Solo-only (1 human), host-added, per-mode factories (`wordBombBot`, `categoryBlitzBot`). Fake roster entries with mock sink connections; submit through the same handler paths as humans via `setTimeout`s (`botMoveTimeout`, `blitzBotTimeouts[]`), all cleared with their mode's timer-clear.

## Disconnect / reconnect summary

| Scenario | Behavior |
|---|---|
| Disconnect in lobby | Removed from roster; room destroyed if empty; host reassigned |
| Disconnect mid-Word-Bomb | Force-eliminated (lives=0); turn advances if it was theirs |
| Disconnect mid-Blitz/Imposter | Filtered from game roster; round continues |
| Reconnect | **Not supported.** New socket = new identity; can only rejoin lobbies (not in-progress games) as a new player |
| Server restart | All state lost |

## External dependencies in the hot path

- `dictionaryapi.dev` (Word Bomb word validation) — cached, fails open, **awaited mid-turn**.
- Anthropic Haiku (Blitz answer judging) — only with API key; 3s timeout, fail-closed, rate-limited internally.
- Sentry / PostHog — no-ops without env keys.

## Pre-identified risk areas (input to Phase 2 testing)

1. **Ghost membership**: `create_room`/`join_room`/`quick_play` never check whether the connection is *already* in a room. `connectionToRoomCode` is overwritten, so the old room keeps a live-connection roster entry that no code path will ever remove (disconnect cleans only the *current* room). Also allows joining the *same* room twice → duplicate player id in roster.
2. **Bot host inheritance**: bot added while solo, second human joins, original host leaves → `players[0]` is the bot → `hostId` = bot id → nobody can start/rematch.
3. **Blitz scoring race**: no `turn_over`-style guard after the awaited AI validation (`categoryBlitzLogic.js:442-449`).
4. **Word Bomb non-current-player disconnect**: leaver is eliminated but the "1 active player left → finish" check only runs on the next `advanceTurn` — the survivor keeps playing against the timer until the next turn event.
5. **Imposter leaves mid-Imposter-game**: `game.imposterId` can point at a removed player; round plays out with no imposter present. Also no min-player re-check after leavers (game can continue with 2).
6. Timer hygiene overall looks careful (every path calls the clear helpers), but load testing should verify no interval leaks after `destroyRoom` under churn.
