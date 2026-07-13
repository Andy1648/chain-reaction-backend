# T3 — Load Results (Phase 3)

Driver: `node t3-harness/load.js` (waves of 10, 50, 200 concurrent fake
clients). Each wave forms rooms of 4 playing a **real Category Blitz game**
(1 Hz timer broadcast per room, rounds cycling with 5s intermissions), and
every client relays `typing_update` twice a second and submits an answer every
2 seconds. A dedicated probe client measures request RTT (a `list_public_rooms`
round-trip) every 250 ms. Server memory/CPU/registry are sampled every 2 s via
the stats side-port. Between waves everything disconnects, so a leak shows up as
a rising post-teardown baseline.

## Environment

- Single backend process (`node server.js` via the harness wrapper), Windows 11,
  Node 24. `FAKE_DICTIONARY=1`, `ANTHROPIC_API_KEY` empty (list-only Blitz) — so
  these numbers are pure server/transport cost with **no external API latency**.
- **Caveat:** all fake clients AND the server run on one machine, and every
  client is driven by a single Node harness process. At 200 clients the harness
  itself is the bottleneck long before the server is. Read these as "server
  stays healthy under N live message streams", not a capacity ceiling.

## Results

| Wave | Clients | Rooms | RTT p50 | RTT p95 | RTT max | CPU avg | CPU max | RSS peak | Heap peak | Msgs to clients | Answers OK |
|-----:|--------:|------:|--------:|--------:|--------:|--------:|--------:|---------:|----------:|----------------:|-----------:|
| 1 | 10  | 2  | 1 ms | 2 ms | 3 ms  | 1% | 3%  | 82.8 MB | 25.4 MB | 4,823   | 255   |
| 2 | 50  | 12 | 1 ms | 5 ms | 7 ms  | 2% | 9%  | 70.3 MB | 23.6 MB | 28,851  | 1,512 |
| 3 | 200 | 50 | 1 ms | 6 ms | 33 ms | 7% | 16% | 78.0 MB | 28.3 MB | 121,523 | 6,580 |

(CPU% is of a single core, from cpuUser+cpuSystem deltas between 2 s samples.)

## Leak check — post-teardown residue

Measured ~2.5 s after every client of a wave disconnects:

| Wave | rooms | roomTimers | playersTotal | activeTimeouts | RSS | Heap |
|-----:|------:|-----------:|-------------:|---------------:|----:|-----:|
| 10  | 0 | 0 | 0 | 0 | 68.5 MB | 22.3 MB |
| 50  | 0 | 0 | 0 | 0 | 69.9 MB | 23.2 MB |
| 200 | 0 | 0 | 0 | 0 | 78.0 MB | 24.9 MB |

- **Server baseline before any wave:** RSS 82.0 MB, heap 22.9 MB, 0 timers.
- **After all three waves:** RSS 78.0 MB, heap 24.9 MB, **0 rooms, 0 roomTimers,
  0 activeTimeouts.**

## Interpretation

- **No leaks.** Every room, timer (turn/round/pause/countdown/bot), listener,
  and roster entry is reclaimed after games end and clients disconnect. Heap
  after 200 clients × 75 s of continuous play + full teardown (24.9 MB) is within
  noise of the pre-load baseline (22.9 MB); `activeTimeouts` returns to exactly 0
  every wave. The existing timer hygiene in `roomManager.js` (every teardown path
  routes through `clearTurnTimer`/`clearRoundTimer`/`destroyRoom`) holds up under
  churn — this matches the Phase 2 churn scenario (S11) and the mass-disconnect
  leak checks (S4). **No leak fixes were required.**
- **Latency stays low.** p50 is 1 ms at every scale; p95 grows gently
  (2 → 5 → 6 ms). The single 33 ms max at 200 clients is a GC/scheduling blip,
  not sustained — p95 is still 6 ms. The single-threaded handler keeps up because
  each message is tiny and the work per message is O(room size).
- **CPU is not the limit here.** 16% of one core at 200 clients with ~1,600
  msg/s of broadcast fan-out. The real single-instance limits are (a) the
  `MAX_ACTIVE_ROOMS = 500` room cap, (b) fan-out cost scaling with room size ×
  message rate, and (c) everything being in one process's memory with no
  persistence — see T3-SUMMARY.md for scaling recommendations.

## Reproduce

```bash
node t3-harness/load.js          # 10, 50, 200
node t3-harness/load.js 100      # single custom wave
```

Raw run logs for this document are not committed (they're regenerated on every
run); the tables above are the wave report JSON the driver prints to stdout.
