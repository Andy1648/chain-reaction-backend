# Backend memory & lifecycle audit — audit/backend-lifecycle — 2026-08-27 (JOB 22)

REPORT ONLY. No code changed. Findings with `file:line` + a recommended fix, ranked by severity.
Simulation numbers from `node --expose-gc` against the real `roomManager` / `dictionary` modules.

## TL;DR
The room lifecycle is **healthy** — abandoned rooms are torn down, timers are cleared transitively,
and 1,000 create/abandon cycles leak **0.08 KB/room** (effectively nothing). The one real leak is the
**dictionary validation cache**, which caches every distinct submission (valid *and* invalid) with no
cap — on a public, unauthenticated socket that is a memory-exhaustion vector (**+20.8 MB per 50k
distinct invalid words**, unbounded).

## Simulation
| Scenario | Heap growth | Per unit |
|---|---|---|
| 1,000 room create → abandon (removePlayer → destroyRoom) | 0.08 MB | 0.08 KB / room |
| 50,000 distinct INVALID word submissions | 20.76 MB | ~425 B / entry, **no eviction** |

## Findings

### F1 — [MEDIUM] Unbounded dictionary validation cache  `dictionary.js:11`, `dictionary.js:56`
`const cache = new Map()` and `cache.set(normalized, valid)` cache the result of **every** distinct
alphabetic submission — including invalids. There is no size cap, TTL, or eviction. The WS server is
public and unauthenticated (see JOB 23), so a client streaming distinct alphabetic non-words grows the
map monotonically. Measured **+20.8 MB / 50k** distinct invalids; sustained → OOM on a long-lived Render
instance (this is the "no documented cleanup" concern, realised).
**Fix:** bound it — an LRU/FIFO Map capped at e.g. 100k entries (evict oldest), OR only cache positive
(wordlist-member) results so the key space is bounded by real vocabulary (~275k), OR add a periodic
`cache.clear()` on a low-water interval. Cheapest correct fix: cap + FIFO eviction.

### F2 — [LOW] `generateRoomCode` has no max-attempts guard  `roomManager.js:117-124`
`do { code = random(5 chars from 32) } while (rooms.has(code))` regenerates on collision — collision
handling is **correct**. It is only safe from an infinite spin because `MAX_ACTIVE_ROOMS` (the
`createRoom` cap, `roomManager.js:134`) is far below the 32^5 ≈ 33.5M code space. If that cap were ever
raised near the code space, this loop could hang.
**Fix:** cap attempts (e.g. 50) and return `{ error: 'server_busy' }` on exhaustion — defensive, no
behaviour change today.

## Verified healthy (no action)
- **Rooms Map** (`roomManager.js:107`): abandoned/empty rooms destroyed on the last leave
  (`removePlayer` → `destroyRoom`, `roomManager.js:1035/1043`); all-bots-remaining also tears down.
- **Idle reaper** (`roomManager.js:1112 reapIdleRooms`, `:1134 startRoomReaper`): sweeps every 60s
  (`REAPER_SWEEP_MS`), reaps rooms idle > 20 min (`ROOM_IDLE_TTL_MS`) that are **not** mid-game; the
  interval is `unref()`'d. `touchRoom` bumps `lastActivity` on every meaningful event.
- **Timer teardown is complete.** `destroyRoom` (`:981`) calls `clearTurnTimer` → which calls
  `clearBotMove` (`:404`), and `clearRoundTimer` → which calls `clearBlitzBotTimers` (`:508`), plus
  `clearCountdownTimeout`. So turn/round/countdown/bot-move/blitz-bot timers are ALL cleared on teardown
  — including a room destroyed mid-bot-move. (I initially suspected dangling bot timers here; verified
  false.)
- **connectionToRoomCode Map** (`server.js:167`): deleted on every disconnect path
  (`server.js:219/672/697`).
- **Per-game caches** (`gameLogic.js:208/219/306` poolByCombo / cache / usedWords, and the t5* mode
  Sets): game-scoped closures, released when the game ends / room is destroyed — no cross-game leak.
- **Reaper + failRoom** contain a per-room throw to one room (`failRoom`/`guardRoom`), not the process.

## Disconnected-player reaping
Handled: a socket close removes the player (`removePlayer`) which destroys the room if it empties;
non-empty rooms keep going and are caught by the idle reaper if fully abandoned. No "ghost player"
accumulation observed.
