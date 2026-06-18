# Chain Reaction backend

WebSocket server for the Chain Reaction multiplayer word game (part of WordArcade).

## Status: what's verified vs. what isn't

This was built in a sandboxed environment with **no internet access**, which
means two things could not be done here and need to happen wherever you
deploy this:

- `npm install` has not actually been run against the real npm registry.
  `package.json` lists the three dependencies (`express`, `cors`, `ws`) but
  `node_modules` does not exist in this bundle.
- The server has never been started and no real WebSocket connection has
  ever been made to it. The networking layer (`server.js`, the WebSocket
  parts of `roomManager.js`) is untested against a live socket.

**What HAS been verified:** `gameLogic.js` - the actual game rules (chain
validation, turn order, lives, elimination, the difficulty timer curve) -
has a full automated test suite (`gameLogic.test.js`, 16 tests, all
passing) that runs with zero external dependencies using Node's built-in
test runner. This is deliberately the part most likely to contain logic
bugs, so it's the part that got the real testing budget.

## Setup

```bash
npm install
npm start          # starts the server on port 3001 (or $PORT)
npm test           # runs the gameLogic test suite
npm run dev        # starts with auto-restart on file changes
```

Once running, `GET /health` should return `{"status":"ok"}` - check that
first if anything seems wrong.

## Architecture

- `dictionary.js` - wraps the free Dictionary API for word validation, with
  an in-memory cache. **Fails open** (treats words as valid) on network
  errors so a flaky third-party API never blocks gameplay.
- `dictionary.mock.js` - test-only replacement, not used in production.
- `gameLogic.js` - pure game rules: chain validation, turn order, lives,
  the difficulty-based timer curve. Has the dependency-injection hook
  `_setDictionaryForTesting()` so tests can swap in the mock.
- `gameLogic.test.js` - the verified test suite. Run it after any change
  to `gameLogic.js`.
- `roomManager.js` - owns rooms, the live turn-countdown timer, and
  broadcasting to all connected players in a room.
- `server.js` - Express health-check route + WebSocket message router.

## Message protocol

Client -> Server (`{ type, payload }`):
- `create_room` - `{ name }` -> creates a room, sender becomes host
- `join_room` - `{ code, name }`
- `set_difficulty` - `{ difficultyKey }` (host only) - `'easy' | 'medium' | 'hard'`
- `start_game` - host only, requires >= 2 players
- `submit_word` - `{ word }`
- `leave_room`

Server -> Client:
- `room_created` - `{ code }`
- `room_joined` - `{ code }`
- `room_update` - `{ code, hostId, difficultyKey, players }`
- `game_started` - `{ difficultyKey }`
- `turn_update` - `{ currentPlayerId, timerSeconds, chain, players }`
- `timer_tick` - `{ secondsRemaining }` (broadcast every second)
- `word_result` - `{ accepted, word? , reason? , requiredPrefix? }`
- `turn_timeout` - `{ eliminatedPlayerId }`
- `game_over` - `{ winnerId, chain }`
- `error` - `{ message, context }`

## Difficulty curve

| Difficulty | Starting time | Decreases by 1s every | Floor |
|---|---|---|---|
| Easy | 20s | 3 turns | 8s |
| Medium | 15s | 2 turns | 5s |
| Hard | 10s | 1 turn | 3s |

Turns = total completed turns across all players, not per-player. Lives
are fixed at 3 for all difficulties.

## Known design choices worth knowing about

- Rejected word submissions do NOT cost a life or reset the timer - the
  player can just keep trying until time runs out. This is deliberately
  more forgiving than punishing typos as a wasted life.
- Room codes are 5 characters from a set that excludes `0/O/1/I` to avoid
  ambiguity when read aloud or typed on mobile.
- If the host disconnects, host privileges transfer to the next player
  in the room automatically.
- If a player disconnects mid-game, they're treated as immediately
  eliminated (rather than the game hanging on their turn forever).

## Next steps

1. Deploy somewhere with real network access (Railway, Render, etc.) and
   run `npm install && npm start` there - that's the actual first real
   test of the networking layer.
2. Build the frontend (this server has zero opinions about UI - it just
   speaks the JSON protocol above over a WebSocket).
3. Report back anything that breaks once it's live - the most likely
   first issues are probably WebSocket-library API differences if `ws`
   resolves to a slightly different version than assumed here.
