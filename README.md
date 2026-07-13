# Chain Reaction backend

[![CI](https://github.com/Andy1648/chain-reaction-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/Andy1648/chain-reaction-backend/actions/workflows/ci.yml)

WebSocket server for the WordArcade multiplayer word games: Chain Reaction,
Word Bomb, Category Blitz, and Imposter Word. Deployed on Render; every push
and PR runs install → lint → test in GitHub Actions.

## Local setup

Requires Node >= 18 (developed on 24). No build step, no global tooling.

```bash
npm install
npm start           # server on port 3001 (or $PORT)
npm run dev         # same, with auto-restart on file changes
npm test            # runs every *.test.js via Node's built-in test runner
npm run lint        # ESLint (correctness rules only)
```

No env vars are required to run: optional keys enable AI answer validation
and monitoring — see `.env.example`. Once running, `GET /health` should
return `{"status":"ok"}`; `GET /version` echoes the deployed git commit.

See `CONTRIBUTING.md` for conventions, `T1-ARCHITECTURE.md` and
`T3-MULTIPLAYER_MAP.md` for architecture maps.

> The protocol tables below cover the original Chain Reaction mode; the
> newer modes (Word Bomb, Category Blitz, Imposter Word) speak additional
> message types — `server.js` is the routing table of record.

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

## Deployment

Live on Render, which runs `npm install && npm start` on every push to the
deployed branch. `GET /version` echoes `RENDER_GIT_COMMIT` so you can verify
which commit is actually serving. The frontend lives in the separate
`wordarcade-frontend` repo and speaks the JSON protocol above over a
WebSocket.
