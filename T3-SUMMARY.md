# T3 — Multiplayer Resilience & Load: Night Summary

Session T3's deliverable was a reusable multi-client test harness for the Chain
Reaction WebSocket backend, plus resilience + load testing driven by it and any
fixes those turned up. All committed to `feat/blitz-bot` with the `[T3]` prefix.

## What shipped

| Deliverable | Where |
|---|---|
| Architecture map (transport, rooms, state, disconnect model) | `T3-MULTIPLAYER_MAP.md` |
| **Reusable test harness** (the key deliverable) | `t3-harness/` |
| 14-scenario resilience suite + findings | `t3-harness/scenarios.js`, `T3-FINDINGS.md` |
| Load driver + results | `t3-harness/load.js`, `T3-LOAD_RESULTS.md` |
| Fixes (see below) | `server.js` |

## Using the harness

Fully offline, no external setup — each script boots its own server on a private
port and tears it down.

```bash
node t3-harness/smoke.js          # harness self-check (full WB game + Blitz + stats)
node t3-harness/scenarios.js      # 14 resilience scenarios
node t3-harness/load.js           # load waves 10 / 50 / 200 (or pass one N)
```

`t3-harness/README.md` has the full `FakeClient` API. The three load-bearing
pieces: `FakeClient` (a scriptable client with a race-free typed inbox —
`waitFor` / `waitForAny` / `expectSilence`), `spawnServer` (boots the real
`server.js` as a child process with `FAKE_DICTIONARY=1` for deterministic
offline word acceptance), and a stats side-port (`_getStatsForTesting` in
roomManager) exposing live room/timer/memory counts for leak detection. Two
env-gated test hooks were the only touch to shared production files; both are
inert unless the harness sets them.

## Findings (detail in T3-FINDINGS.md)

- **F1 — Ghost roster entries on room hop (fixed, T3).** create/join/quick_play
  never detached the socket from its previous room — it kept a live-connection
  roster entry forever (held a slot, kept getting broadcasts, pinned the room in
  memory). Fixed with `leaveCurrentRoom`, then **hardened after a concurrency
  review**: it now drops the connection→room mapping *before* `removePlayer` and
  wraps that call in `failRoom`, so a throw while leaving the old room can't
  strand a ghost in the new one; and `join_room`'s same-room ack now checks real
  roster membership, not just the (potentially stale) mapping.
- **F2/F3/F4 — bot-host inheritance, lone-survivor hang, Blitz scoring race.**
  All three I flagged in recon; each was fixed *concurrently by another night
  session* (T2/others) in this shared checkout. My scenarios (S3, S9, S5) now
  pin all of them so they can't regress.
- **F5 — no reconnect support (design limitation, documented).** A dropped
  socket is a lost identity; the returning player can't rejoin an in-progress
  game. This is the single biggest resilience gap and is an architecture change,
  not a night fix — see the recommendation below.
- **F6 — imposter quitting mid-round** is a game-design oddity but engine-safe.

## Load ceilings observed (T3-LOAD_RESULTS.md)

On one dev machine, single process, with all fake clients driven by one harness
process (the harness saturates before the server does):

| Clients | RTT p50 / p95 / max | CPU (1 core) | Heap peak | Residue after teardown |
|--:|--|--|--|--|
| 10 | 1 / 2 / 3 ms | 3% | 25.4 MB | 0 rooms, 0 timers, 0 timeouts |
| 50 | 1 / 5 / 7 ms | 9% | 23.6 MB | 0 / 0 / 0 |
| 200 | 1 / 6 / 33 ms | 16% | 28.3 MB | 0 / 0 / 0 |

**No leaks.** Every room, timer, listener, and roster entry is reclaimed after
games end; `activeTimeouts` returns to exactly 0 after each wave. The existing
timer hygiene in `roomManager.js` holds up under churn — no leak fixes needed.
Latency and CPU are comfortable; the binding constraints are the
`MAX_ACTIVE_ROOMS = 500` cap, broadcast fan-out (room size × message rate), and
the all-in-one-process / no-persistence model.

## Verification (Phase 4)

- Resilience suite rerun fresh: **14/14 pass** (incl. new S7d, which exercises
  the hardened room-hop path by hopping out of a live Word Bomb game).
- Project suite: **301/301 pass**, lint clean on all files I touched. (One
  earlier run showed 2 transient failures from timing-sensitive tests while the
  suite was growing under a concurrent session; stable across repeated runs.)
- The `leaveCurrentRoom` fix was reviewed by a dedicated concurrency subagent;
  both gaps it found were fixed and are covered by tests.

## Top recommendation for scaling

**Add reconnect support before horizontal scaling — it's both the biggest
player-facing resilience win and the prerequisite for everything else.** Give
each client a durable session token (decoupled from `ws.id`) and let a returning
socket reclaim its player slot within a grace window; hold a disconnected
player's game seat for ~15–30 s instead of eliminating them instantly. Today a
single dropped packet ends someone's game (F5).

Then, to go beyond one instance: the entire state model is one process's memory
with live `ws` connection objects stored *inside* the room — this is the wall.
Moving to multiple instances requires (1) externalizing room/game state (Redis),
(2) a pub/sub broadcast layer so any instance can reach a room's members, and
(3) sticky or token-based routing. That's a substantial rework; until it's
needed, a single instance with the 500-room cap comfortably handles the load
measured here. **Priority order: reconnect tokens → observability on the
existing `/admin/status` + stats → Redis-backed state only when one instance is
genuinely saturated.**
