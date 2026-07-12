# t3-harness — multi-client WebSocket test harness

A scriptable harness that spins up the real backend and drives N fake game
clients against it: connect, create/join rooms, play all three game modes,
inject latency, kill sockets, and measure server health. Built by session T3;
no production code paths are altered (two env-gated test hooks only).

## Files

| File | Purpose |
|---|---|
| `client.js` | `FakeClient` — one scriptable WebSocket game client |
| `runner.js` | `spawnServer` (boots the backend as a child process), `getStats`, sequential `scenario()` runner + asserts |
| `server-wrapper.js` | Boots the real `server.js` plus a JSON stats side-port (`T3_STATS_PORT`) for leak checks |
| `smoke.js` | Harness self-check: full Word Bomb game + Blitz round + stats endpoint |
| `scenarios.js` | Phase 2 resilience scenario suite |
| `load.js` | Phase 3 load driver (N clients, M rooms, latency/memory/CPU sampling) |

## Quick start

```bash
node t3-harness/smoke.js        # verify the harness itself
node t3-harness/scenarios.js    # full resilience suite
node t3-harness/load.js 50      # load test with 50 concurrent clients
```

Each script boots its own server on `T3_PORT` (default 4310; stats on port+1)
and kills it at the end — no external setup needed, fully offline.

## Environment knobs (set by `spawnServer` automatically)

- `FAKE_DICTIONARY=1` — `dictionary.js` accepts any alphabetic word without
  hitting dictionaryapi.dev, so Word Bomb submissions are deterministic offline.
- `ANTHROPIC_API_KEY=` (empty) — forces Category Blitz list-only mode (any
  ≥2-char answer accepted; no AI calls).
- `T3_STATS_PORT` — enables the stats side-port served by `server-wrapper.js`:
  `{ rooms, roomTimers, playersTotal, rssBytes, heapUsedBytes, activeTimeouts, cpuUser, ... }`.
  `roomTimers` counts non-null timer slots across all rooms; `activeTimeouts`
  counts live libuv Timeout handles — both should return to baseline after
  games end (leak signal).

## FakeClient API

```js
const { FakeClient } = require('./client');
const c = new FakeClient('ws://127.0.0.1:4310', { name: 'Alice', latencyMs: 0 });

await c.connect();                 // resolves once the server assigns c.id
c.send(type, payload);             // raw message
await c.waitFor('turn_update', { timeoutMs, where: (m) => ... });
await c.waitForAny(['turn_update', 'game_over']);  // ONE waiter, many types
await c.expectSilence('game_over', 1500);          // asserts nothing arrives
c.drainInbox();                    // discard unconsumed messages
const code = await c.createRoom({ isPublic: true });
const res  = await c.joinRoom(code);   // 'ok' | server error message
c.close();                         // graceful close frame
c.terminate();                     // hard TCP kill (crash simulation)
c.log                              // every message ever received
```

**Gotchas**

- Never `Promise.race` two `waitFor`s — the losing waiter stays registered and
  eats the next matching message. Use `waitForAny`.
- Broadcasts go to *every* client in the room; consume them (or `drainInbox()`)
  on the clients you're not asserting on, or later `waitFor`s may match stale
  inbox entries.
- `latencyMs` delays outbound sends and inbound dispatch each by that amount
  (RTT ≈ 2×latencyMs).

## Playing the modes deterministically

- **Word Bomb**: the current combo is in `turn_update.payload.combo`; submit
  `combo + 'abc'` — always accepted under `FAKE_DICTIONARY`. Or `skip_turn`
  as the current player for an instant timeout (fastest way to end games:
  2 players ≈ 4–6 skips).
- **Category Blitz**: in list-only mode any ≥2-char answer not already given
  by that player is accepted. Rounds are 20s + 3s countdown + 5s intermission.
- **Imposter Word**: needs 3+ players; each gets a private `round_start`
  (`isImposter` flag), then `vote_phase_start` → `submit_vote` → `vote_results`.
