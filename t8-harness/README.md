# t8-harness — the trust run

A load, soak, fuzz and adversarial-state harness for the Chain Reaction
backend. Everything here boots the **real** `server.js` as a child process and
drives it over real WebSockets; no production code path is altered. The findings
live in [`claude/TRUST.md`](../claude/TRUST.md).

It builds on `t3-harness` rather than replacing it — `FakeClient` and `getStats`
come from there. What t8 adds is **scale**, **duration** and **hostility**.

## Why a second harness

`t3-harness/load.js` carried an honest caveat: one Node process drove every fake
client, so past ~200 clients the *harness* was the bottleneck and its numbers
read as "the server survived N message streams", not as a capacity ceiling. A
ceiling quoted in players needs the load side sharded, and it needs a way to
tell a saturated server from a saturated laptop. So:

- **rooms, not clients** — a room is the unit that costs the server something
  (a registry entry, 1-5 live timers, a broadcast fan-out per tick).
- **child-process workers** — each owns its own event loop.
- **`lagMs`** — the worst drift of a worker's own 500 ms send loop, reported at
  every step. Latency that climbs while `lagMs` climbs is the harness running
  out of CPU. Any number quoted as a server result comes from a step where
  `lagMs` stayed flat.

## Files

| File | Purpose |
|---|---|
| `server-wrapper.js` | Boots the real server plus a stats side-port (`T8_STATS_PORT`) that also exposes `wss.clients`, live socket/timeout handle counts, and prototype-pollution canaries |
| `spawn.js` | `spawnServer()` — the backend as a child process, behind that wrapper |
| `roomWorker.js` | One child process driving a share of the rooms, with optional churn |
| `fleet.js` | `Fleet` (worker pool + aggregated metrics), `Probe` (request RTT), `makeSampler` (server stats + CPU%) |
| `ramp.js` | 1 → N concurrent rooms in steps; finds the ceiling |
| `soak.js` | Long run with churn; leak and trend verdict |
| `fuzz.js` | Protocol fuzzing across every message type |
| `adversarial.js` | Illegal state transitions during a live game |
| `coldstart.js` | Warm latency, this app's boot cost, and the keepalive cron's real cadence |

## Running

```bash
node t8-harness/ramp.js 200 6              # 1->200 rooms over 6 workers
T8_STEPS=250,300,350,400 node t8-harness/ramp.js 400 8   # keep climbing
node t8-harness/soak.js 150 60 6           # 150 rooms, 60 minutes, 6 workers
node t8-harness/fuzz.js                    # every message type, every bad shape
node t8-harness/adversarial.js             # illegal transitions mid-game
node t8-harness/coldstart.js               # prod /healthz + boot cost + cron cadence
```

Each script boots its own server on its own port and kills it at the end. Every
one exits non-zero on a failure, so they work as gates.

Env knobs: `T8_HOLD_MS` (ramp step hold, default 20 s), `T8_STEPS` (ramp ladder),
`T8_HEALTH_SAMPLES` / `T8_HEALTH_GAP_MS` (cold-start sampling).

## What each run asserts

- **ramp / soak** — after teardown: `rooms`, `roomTimers`, `playersTotal` and
  `wsClients` are 0, and libuv timeout/socket handles are back to the pre-load
  baseline. The soak additionally fails on an RSS or heap **trend** while
  loaded (least-squares slope, MB/min) — a process can end at a clean baseline
  and still have grown all the way through the run.
- **fuzz** — the process survives, a *control* client connected before the
  fuzzing can still round-trip (one bad socket cannot deny service), the
  registry drains, the prototype canaries stay clean, and a real game still
  plays afterwards.
- **adversarial** — an illegal message must not move a live game. Measured by
  anchoring to the START of a turn and asserting silence for a window far
  shorter than the turn, never by comparing two turn owners (see the comment in
  `adversarial.js`: the naive version fails whatever the server does).

## Gotchas inherited from t3

- Never `Promise.race` two `waitFor`s — the loser stays registered and eats the
  next matching message. Use `waitForAny`.
- Broadcasts go to every client in the room; drain the inboxes of clients you
  are not asserting on.
- A long run must clear `client.log` / `client.inbox` periodically or the
  *harness* is the thing that leaks. `roomWorker.js` does this every 5 s.
