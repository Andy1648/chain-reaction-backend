# T2 — Attack Surface Map (concurrency / double-fire / stale-state)

Stack: Node >= 18, Express (health only) + `ws` WebSocket server (`server.js`),
in-memory room registry (`roomManager.js` — owns ALL timers), three pure-ish
logic modules (`gameLogic.js` Word Bomb, `categoryBlitzLogic.js`,
`imposterWordLogic.js`), two bot modules, async validators (`dictionary.js`
fail-OPEN, `haikuValidator.js` fail-CLOSED with 3s timeout).

Concurrency model: single process, single event loop. Real interleavings come
from (a) `await` points inside handlers (dictionary fetch, Haiku call) letting
timers/messages run mid-submission, (b) `setInterval`/`setTimeout` timer chains
per room, (c) clients free to send any message type at any time, duplicated or
out of order.

## Systemic hazard

Several guards assume `game.status === 'in_progress'` means "live game". That is
only true for Word Bomb. Category Blitz also lives in `'between_rounds'`;
Imposter Word NEVER uses `'in_progress'` at all (`answering | voting | reveal |
between_rounds`). Every site keying "is a game running" off `in_progress` is
suspect: `joinRoom`, `startGame`, `addBot`, `removeBot`, `reapIdleRooms`.

## Ranked suspect list (likelihood × severity)

1. **No `ws.on('error')` per socket + default 100MiB maxPayload** (`server.js`).
   `ws` emits `'error'` on the socket (oversized frame, protocol violation,
   invalid UTF-8). With no listener, EventEmitter throws → `uncaughtException`
   handler → `process.exit(1)` → **every game on the server dies from one bad
   frame**. CRITICAL.
2. **Blitz `submitAnswer` TOCTOU across the Haiku await**
   (`categoryBlitzLogic.js:404`). During the 0.5–3s AI await the round can end,
   the category can be rerolled, the game can finish, the player can leave —
   yet after the await it unconditionally `push`es + `score += 1`. Also lets
   the SAME answer submitted twice in-flight both pass `already_said` → double
   score. MAJOR.
3. **`joinRoom` mid-game guard misses non-`in_progress` live states**
   (`roomManager.js:148`). Anyone can join an Imposter game at ANY point, or a
   Blitz game during the 5s intermission → ghost roster entry (in
   `room.players`, not `game.players`), receives all broadcasts, can't play.
   MAJOR.
4. **`startGame` has no "already running" guard** (`roomManager.js:781`).
   Double-fired `start_game` (or a mid-game click) silently discards the live
   game and re-inits — double `game_started`/`round_start` broadcasts, all
   progress wiped. The solo PLAY-AGAIN loop only needs re-start after
   `status === 'finished'`. MAJOR.
5. **Ghost membership across rooms** (`server.js`): `create_room` / `join_room`
   / `quick_play` never leave the previous room. The old roster entry stays
   forever (receives broadcasts, holds a lobby seat, can even keep hosting),
   and the close handler only cleans the LAST room. MAJOR (leak + grief).
6. **Word Bomb: non-current player disconnect can strand a 1-active-player
   game** (`roomManager.js:1093`). Elimination happens but `advanceTurn` (and
   its end-of-game check) only runs when the CURRENT player leaves — the
   survivor must play one more pointless turn before winning. MINOR.
7. **Host reassignment can pick a bot** (`roomManager.js:1072`). Join a room
   that has a solo bot, then original host leaves → `players[0]` may be the
   bot → bot becomes host → nobody can start/reroll/rematch. MINOR-MAJOR.
8. **`skip_turn` assumes Word Bomb** (`server.js:356`): on a Blitz game
   `getCurrentPlayerId` reads `game.turnOrder[undefined]` → TypeError (caught,
   but wrong error + Sentry noise). MINOR.
9. **`addBot`/`removeBot` in_progress-only guards** (`roomManager.js:702,718`):
   during Blitz intermission / any Imposter phase the roster can be mutated
   mid-game (`set_game_type` also removes the bot through this hole). MINOR.
10. **Reaper can reap a live Imposter/Blitz game** (`roomManager.js:1127`,
    `midGame` = `in_progress` only). Practically unreachable (games finish in
    minutes, TTL is 20), but one wrong-shaped condition. MINOR.
11. **Unbounded submission length**: `submit_word`/`submit_answer` text has no
    max. A multi-MB "word" passes `^[a-z]+$`, the dictionary call fails →
    fail-open → ACCEPTED → stored in `usedWords` and rebroadcast to everyone
    on EVERY turn_update. Blitz in list-only mode (no API key) accepts any
    miss, any size. Imposter caps count (3) but not size. MAJOR (DoS).
12. **Non-string payload fields throw** (`server.js`): `payload.name = 123` →
    `.slice` TypeError (caught → generic error, Sentry noise). Names keep
    control chars / zero-width chars / can be all-whitespace after slice.
    MINOR.
13. Word Bomb submit race across the dictionary await — ALREADY GUARDED
    (`turn_over` guard, `turnRace.test.js`)… but `turnRace.test.js` is NOT in
    the `npm test` file list, so the regression test never runs in CI. MINOR.
14. Imposter `endImposterVotePhase` double-fire (early all-voted end vs vote
    timer): safe today — both paths `clearRoundTimer` first and run
    synchronously; second vote hits `wrong_phase`. Watched, no fix needed.
15. Imposter leaver = imposter mid-round: round resolves as a dud (no crash);
    votes already cast for a leaver still count in the tally. Accepted quirk.
16. `haikuValidator.callTimes` map keys never deleted (slow leak, bounded by
    unique players per process lifetime); dictionary cache unbounded. MINOR.
17. `typing_update` / `spectator_reaction` require `status === 'in_progress'`
    → never relay during Imposter games. Possibly intended (frontend may not
    use them there) — flagged, not changed.
18. Flooding: no per-message rate limit beyond create_room; typing_update is an
    8x broadcast amplifier. Recommendation only (rate-limit framework would be
    a refactor).
