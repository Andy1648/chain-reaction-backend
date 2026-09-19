# TRUST.md — what this backend has actually been shown to do

**Run date:** 2026-09-18 · **Commit under test:** `1d64a48` (`fix/blitz-data`) ·
**Harness:** [`t8-harness/`](../t8-harness/README.md) · **Nothing was deployed.**

This is not a description of what the code looks like. Every number below came
from the real `server.js` running as a child process with real WebSocket clients
attached, and every claim names the thing that would have falsified it. Where a
result is an estimate rather than a measurement, it says so in the same sentence.

---

## 0. The short version

| Question | Answer |
|---|---|
| **Concurrent players, measured** | **~800 safe / ~1,200 best case** — it depends on room size (§2), which is the player's choice, so quote **800** |
| Where it stops being healthy | 300 rooms × 4 (p95 31 ms); broken at 400 × 4 and at 150 × 8 |
| What binds first | **CPU**, not memory, and not the 500-room product cap |
| Leaks over an hour of churn | **No.** 1,080 churn cycles (~6,480 room rebuilds); every countable resource back to exact baseline; RSS flat (−0.09 MB/min) across the final 30 minutes |
| Protocol fuzzing, every message type | **48/48.** No crash, no prototype pollution, no residue, no loss of service to other clients |
| Illegal mid-game transitions | **15/15.** No illegal message moved a live game |
| Cold start in production | **Not measurable — and the keepalive cron is not doing what the repo thinks it is.** See §6. This is the one finding that needs action. |

---

## 1. Capacity

### 1.1 The rig

AMD Ryzen 7 5700U (8C/16T), 15.3 GB RAM, Windows 11, Node v24.17.0. Server and
load generator on the same machine, load sharded across 6–8 child processes.
`FAKE_DICTIONARY=1` and an empty `ANTHROPIC_API_KEY`, so Word Bomb validation and
Blitz judging are local — these are pure server and transport costs with no
vendor latency in them.

Every room is a **real Category Blitz game**: a 1 Hz timer broadcast, rounds
cycling with intermissions, every client relaying `typing_update` twice a second
and submitting an answer every two seconds. 200 rooms of 4 is ~1,600 inbound
messages a second plus the fan-out.

### 1.2 The ramp, 1 → 200 rooms

Each step *adds* rooms to those already playing and holds 20 s at full traffic
before sampling, so no row measures a connect storm.

| Rooms | Players | Timers | RSS | Heap | CPU (1 core) | p50 | p95 | p99 | Harness drift |
|------:|--------:|-------:|----:|-----:|-------------:|----:|----:|----:|--------------:|
| 1 | 4 | 1 | 77.0 MB | 26.0 MB | 1.9% | 1 ms | 1 ms | 2 ms | 13 ms |
| 5 | 20 | 5 | 77.8 MB | 26.8 MB | 3.0% | 1 ms | 2 ms | 2 ms | 16 ms |
| 10 | 40 | 10 | 77.8 MB | 26.9 MB | 4.5% | 1 ms | 1 ms | 2 ms | 16 ms |
| 25 | 100 | 25 | 80.3 MB | 27.1 MB | 8.2% | 1 ms | 2 ms | 3 ms | 16 ms |
| 50 | 200 | 50 | 84.9 MB | 28.7 MB | 15.5% | 1 ms | 2 ms | 3 ms | 16 ms |
| 100 | 400 | 99 | 93.1 MB | 29.7 MB | 24.0% | 2 ms | 4 ms | 5 ms | 16 ms |
| 150 | 600 | 145 | 102.1 MB | 37.0 MB | 34.6% | 2 ms | 3 ms | 6 ms | 16 ms |
| 200 | 800 | 190 | 108.3 MB | 39.0 MB | 37.2% | 2 ms | 3 ms | 6 ms | 16 ms |

Zero failed setups, zero dropped sockets, zero lost probes at every step. After
teardown: rooms 0, timers 0, roster 0, sockets back to baseline.

`timers` sitting just under `rooms` (190 of 200) is not a leak — it is the rooms
that happen to be in a Blitz intermission at the sampling instant.

### 1.3 The ceiling, and why it is not 200

200 rooms was the end of the configured ladder, not a limit — the server was at
37% of one core. The ladder was re-run from 250 with a 2,000 ms p95 health bar:

| Rooms | Players | RSS | Heap | CPU | p50 | p95 | p99 | **Harness drift** | Verdict |
|------:|--------:|----:|-----:|----:|----:|----:|----:|------------------:|---------|
| 250 | 1,000 | 137.7 MB | 41.9 MB | 59.8% | 3 ms | 10 ms | 17 ms | 20 ms | healthy |
| 300 | 1,200 | 143.2 MB | 48.8 MB | 61.1% | 2 ms | 31 ms | 96 ms | 20 ms | **healthy — last trustworthy step** |
| 350 | 1,400 | 157.7 MB | 59.2 MB | 78.9% | 6 ms | 44 ms | 9,979 ms | **731 ms** | degraded, not cleanly attributable |
| 400 | 1,600 | 230.9 MB | 77.4 MB | 87.3% | 9 ms | 4,400 ms | 7,602 ms | **855 ms** | broken |

**The ceiling is quoted at 300 rooms because of the last column.** "Harness
drift" is the worst lag in a load worker's own 500 ms send loop. At and below
300 rooms it is 20 ms — the generator is keeping near-perfect time, so the
latency figures belong to the server. At 350 it is 731 ms: the laptop is now
struggling to *generate* the load, and any server number taken there is
contaminated. Rows 350 and 400 record the shape of the collapse; they are not
measurements of the server alone.

This is exactly the caveat T3's load run flagged and could not remove (one
process drove every client). t8 removes it below 300 rooms and says plainly
where it comes back.

Three things follow:

- **CPU binds first.** At 400 rooms RSS is 231 MB — under half a 512 MB
  instance — while CPU is at 87% of the single thread Node has. Memory is not
  the constraint anywhere on this ladder.
- **The product cap is not the constraint either.** `roomManager.MAX_ACTIVE_ROOMS`
  is 500; latency dies around 350. The cap sits ~1.4× *above* the point where the
  server stops being pleasant to play on, which is right for a DoS backstop and
  wrong to read as a capacity setting.
- **The `error` frames at scale are the harness, not the server.** The load run
  counts thousands of `error` frames at 300+ rooms. They were identified rather
  than assumed: a 45-second probe on one room reproduced them and every one reads
  *"The round is not currently active."* — the harness submits an answer every
  2 s including during Blitz intermissions. A real client does not.

---

## 2. The ceiling depends on ROOM SIZE, not player count

Rooms hold up to 8. Running the same ladder at 8 players per room, and comparing
at **equal player counts**:

| Players | 4/room | CPU | p95 | 8/room | CPU | p95 |
|--------:|-------:|----:|----:|-------:|----:|----:|
| 200 | 50 rooms | 15.5% | 2 ms | 25 rooms | 22.0% | 4 ms |
| 400 | 100 rooms | 24.0% | 4 ms | 50 rooms | 35.6% | 4 ms |
| 800 | 200 rooms | 37.2% | 3 ms | 100 rooms | 70.6% | 24 ms |
| 1,200 | 300 rooms | 61.1% | 31 ms | 150 rooms | **95.1%** | **678 ms** |

Harness drift stayed at 16–17 ms through all four 8-player steps, so these are
clean server numbers.

**The same 1,200 people cost 61% of a core in fours and 95% in eights.** The
cost is not per player and not per room — it is per **broadcast edge**. Each
inbound message fans out to every member of its room, so the work scales with
`players × room size`. Doubling room size doubles the fan-out at identical
player count, and the measurements track that (2× edges → ~1.56× CPU).

Consequences:

- **Quote the ceiling as ~800 concurrent players, not 1,200.** Room size is the
  players' choice, not a setting, so the safe number is the one that holds when
  they choose the biggest rooms: 100 full rooms of 8 = 800 players at 70.6% CPU,
  p95 24 ms. 1,200 is only reachable if the population self-organises into fours.
- If capacity ever becomes the binding problem, **the cheapest lever is
  `MAX_PLAYERS_PER_ROOM`**, not a bigger instance. It is a quadratic-ish term.

---

## 3. The one-hour soak

150 rooms × 4 = **600 concurrent players for 60 minutes**, with continuous churn:
every 20 s each of the 6 workers recycles 2 rooms — half leaving with a close
frame (the player tapped MENU), half hard-killed with a TCP reset and no close
frame at all (the phone went into a tunnel), because those take different
cleanup paths and only one is the polite one.

**1,080 churn cycles ≈ 6,480 room teardowns and rebuilds. Zero setup failures,
zero unexpected socket drops, zero lost probes, 239 samples.**

### 3.1 Return to baseline

| | Baseline | End of run (after 30 s settle) |
|---|---|---|
| rooms | 0 | **0** |
| roomTimers | 0 | **0** |
| roster entries | 0 | **0** |
| `wss.clients` | 0 | **0** |
| live socket handles | 3 | **3** |
| live timeout handles | 0 | **0** |

Every countable resource returned to exactly where it started. Across all 239
samples, `rooms` was 150 in 238 of them (the one exception, 138, is a churn burst
caught mid-flight) and `activeTimeouts` was 0 in every single one.

### 3.2 Latency

Median sample p95 **2 ms**; p90 of sample-p95s **3 ms**. Only 7 of 239 samples
exceeded 100 ms, **and all 7 fall in the first 15 minutes** — during which this
machine was also running lint, git and a separate probe. From minute 15 to
minute 60: not one sample over 100 ms. CPU median 17.7% of one core.

### 3.3 Memory — and a gate that was wrong

Raw result: RSS 96.4 MB → 206.8 MB, whole-run trend **+1.44 MB/min**. The
harness's original gate failed the run on that number. **The gate was wrong, not
the server.** Segmenting the same data:

| Window | RSS slope | Heap slope |
|---|---:|---:|
| min 2–15 | +5.98 MB/min | +1.08 MB/min |
| min 15–30 | +1.89 MB/min | +0.70 MB/min |
| min 30–45 | **−0.17 MB/min** | −0.14 MB/min |
| min 45–60 | **+0.02 MB/min** | −0.12 MB/min |
| **min 30–60** | **−0.09 MB/min** | −0.14 MB/min |

RSS rises for ~25 minutes, reaches ~205 MB, and is then **flat for the final 30
minutes while 540 more churn cycles (~3,240 room rebuilds) run through it.** A
leak's slope stays positive once the process is warm; a working set's goes to
zero. This one goes to zero. Supporting evidence, all pointing the same way:

- `external` memory (Buffers / ArrayBuffers — where a WebSocket leak would show)
  stayed between **2.7 and 3.7 MB for the whole hour**.
- `heapUsed` oscillates 28–76 MB on the GC sawtooth with no trend.
- Every registry counter is flat and returns to zero.

**Verdict: no leak.** A bounded working set that settles near 205 MB under 600
players — comfortably inside a 512 MB instance, with the caveat that it is ~40%
of one.

The harness gate has been fixed to judge the **final third**, not a least-squares
line through the warm-up, with the whole-run slope kept alongside for the record.
A linear fit through a rise-then-plateau curve will call any warm-up a leak, and
did. `heapTotal` capture was also added, so a future run can *show* committed
arena growth rather than infer it from RSS minus heapUsed.

---

## 4. Protocol fuzzing — 48/48

Every one of the 18 message types `server.js` dispatches (`create_room`,
`list_public_rooms`, `quick_play`, `join_room`, `set_difficulty`, `set_packs`,
`set_game_type`, `add_bot`, `remove_bot`, `start_game`, `rematch`, `skip_turn`,
`submit_word`, `submit_answer`, `reroll_category`, `typing_update`,
`spectator_reaction`, `leave_room`) × **24 hostile payload shapes**: absent,
null, array, string, number, boolean, wrong types per field, 5 KB strings,
NUL/ESC/control characters, lone surrogates and ZWJ emoji, HTML injection,
`__proto__` and `constructor.prototype` pollution, 2,000-deep nesting, 50,000
element arrays, negative and fractional indices, SQL-ish and path-ish strings.

Plus 19 malformed frames (not JSON, bare `{`, `null`, `[1,2,3]`, `42`, missing
`type`, `type` as null/object/array, `type` of `__proto__` / `constructor` /
`toString`, duplicate keys, a 70 KB over-cap payload, BOM-prefixed, NUL-embedded),
binary frames where text is expected, a 500-frame unpaced flood, and a
200-socket connect-and-abort storm.

Judged on four things, none of them the reply:

1. **The process survived** — no exit, and stderr clean of unhandled rejections.
2. **A control client connected before the fuzzing never lost service** — zero
   reconnects across the whole run. One hostile socket cannot deny service.
3. **Nothing was left behind** — rooms 0, timers 0, roster 0 afterwards.
4. **Nothing was polluted** — canaries (`polluted`, `t8pwn`, `isAdmin`,
   `isHost`, `toString2`) absent from a plain object, and `Object.prototype` own
   keys 12 → 12.

And a real two-player Word Bomb game started and reached a live turn *after* all
of it.

---

## 5. Adversarial game states — 15/15

The fuzzer asks whether a malformed frame can break the process. This asks the
harder question: can a **well-formed** frame, sent at a moment the UI would never
send it, corrupt a live game for everybody else in the room. Every message here
is individually legal; only the order and the sender are wrong. (T3's S1–S11
already cover disconnect, host migration and churn, so none of that is repeated.)

| | Case | Result |
|---|---|---|
| A1 | `start_game` alone in the room | refused; no turn timer armed |
| A2 | `start_game` × 10 on a live game | one game; timers did not grow |
| A3 | `submit_word` out of turn × 5 | no turn movement |
| A4 | `skip_turn` by a non-current player | no turn movement |
| A5 | `set_game_type` mid-game | live board unchanged; no stray `round_start` |
| A6 | `rematch` × 20 mid-game | room intact; timers bounded |
| A7 | join into an in-progress game | turn order untouched |
| A8 | `add_bot`/`remove_bot` × 15 mid-game | roster and timers stayed sane |
| A9 | host TCP-reset during the countdown | no orphan countdown timer |
| A10 | every human leaves a bot game | room destroyed, bot timers cleared |
| A11 | submits after `game_over` | inert; zero timers on a finished game |
| A12 | `reroll_category` × 25 on a live round | coherent; timers bounded |
| A13 | `leave_room` × 20 while in no room | clean; still served |
| A14 | `create_room` × 60 from one socket | throttled; ≤2 rooms left standing |
| A15 | duplicate submits in one tick | no double turn advance |

Every case additionally asserts the room drains to zero when its clients leave.

**A note on how this was measured, because the obvious method is wrong.** The
first version of A3/A4/A5/A7 read the turn owner, sent the illegal message, and
read the owner again — and reported four failures. Those were false. `turn_update`
is only broadcast *when the turn changes*, so `waitFor` returns the next change
whatever the server does, and both reads land on different turns for the ordinary
reason: the 10 s clock. The sound version anchors at the **start** of a turn and
asserts **silence** for 1,500 ms — a window with 8.5 s of margin against the turn
timer, so a `turn_update` inside it was caused by the message and not the clock.
Re-measured that way: 15/15. The wrong method is documented in
`adversarial.js` so it does not get reintroduced.

---

## 6. Cold start — ⚠️ THE KEEPALIVE CRON IS NOT RUNNING EVERY 5 MINUTES

### 6.1 What the repo believes

`.github/workflows/keepalive.yml` is scheduled `*/5 * * * *` and its comment
reasons carefully about the cost: *"Runs 24/7 … 24/7 at one instance is ~730
instance-hours/month, under Render's 750 free-tier cap with ~20h headroom."*
That reasoning assumes the schedule fires 288 times a day.

### 6.2 What it actually does

From the GitHub REST API (public repo, no token needed), the last 100 **scheduled**
runs of that workflow:

| | |
|---|---|
| Workflow state | **active** (not disabled) |
| Conclusions | **100/100 success** — it never fails |
| Runs in the last 24 hours | **7** |
| Runs in the last 6 hours | **3** |
| 100 runs span | **334.6 hours (14 days)** |
| Gap between runs, p50 | **202 minutes** |
| Gap between runs, p95 | **312 minutes** |
| Gap between runs, max | **412 minutes (6.9 h)** |
| Gaps ≥ the 15-minute spin-down window | **99 of 99** |

The eight most recent runs were 30, 140, 274, 418, 633, 897, 1,170 and 1,440
minutes ago — gaps of roughly 1.8 to 4.5 hours.

**The workflow is healthy and never fails. It simply does not fire at the rate it
asks for** — GitHub throttles and skips scheduled workflows heavily, and this one
lands about 7 times a day instead of 288. Every single observed gap exceeds the
spin-down window it exists to stay inside.

Two things follow, and the second matters more:

1. **The keepalive cannot be what keeps production warm.** With 2–4 hour gaps
   against a 15-minute idle timeout, it wins the race a few minutes a day.
2. **Yet production was warm.** `/healthz` answered in 129 ms on the *first*
   request of this run — 30 minutes after the last cron run, i.e. well past the
   spin-down window — and 12/12 samples came back at p50 123 ms / p95 171 ms with
   nothing resembling a container wake (no response over 10 s, none over 200 ms).

So **something keeps that instance warm and it is not the mechanism the repo
credits** — most likely real user traffic, or the service not actually being
subject to free-tier spin-down. Worth knowing before anyone relies on the cron,
and worth knowing before anyone *removes* it on cost grounds: the instance-hours
argument in the comment is also based on the 288/day figure and is equally wrong.

**A true cold start could not be measured.** The instance was warm at every
probe, and forcing it cold would mean deliberately idling production, which this
run did not do.

### 6.3 What a cold start would cost, in the part the code controls

Booting this app locally, three times, from spawn to first request served:

| Run | Listening | First request | Total |
|---|---:|---:|---:|
| 1 | 1,441 ms | 9 ms | 1,450 ms |
| 2 | 807 ms | 8 ms | 815 ms |
| 3 | 779 ms | 8 ms | 787 ms |

**~1.0 s average**, dominated by loading `an-array-of-english-words` (~275k
entries) at require time. Render's container start sits *on top* of that, and is
the larger share of any real wake. The app's own boot is not the problem worth
optimising.

### 6.4 Recommended

- Do not trust the cron for warmth. If warmth matters, move the ping to something
  that actually runs on time (an external uptime pinger, or a cron on any
  always-on host) — or accept cold starts and make the client's waking state good,
  which the frontend already has.
- Correct the comment in `keepalive.yml`: both its cadence claim and the
  instance-hours arithmetic that follows from it are wrong by ~40×.

---

## 7. What this run does NOT establish

Stated so the green above is not read as more than it is:

- **Nothing was measured on Render.** Every capacity number is from one Windows
  laptop with a full modern core available to a single-threaded process.
  Production runs on a much smaller CPU share, so the real ceiling is lower —
  how much lower is not known, because it was not measured and this run never
  deployed. Scaling by CPU share alone would suggest a band in the low hundreds
  of players, but that is arithmetic, not evidence.
- **No AI validator was in the path.** `ANTHROPIC_API_KEY` was empty and
  `FAKE_DICTIONARY=1`, so Blitz ran list-only and Word Bomb never called
  dictionaryapi.dev. Real deployments add vendor latency and a failure mode this
  run did not exercise.
- **One game mode carried the load.** The ramps and the soak are Category Blitz.
  Word Bomb, the t5 modes and the bots appear only in the adversarial suite, at
  small scale.
- **Latency is loopback.** p50 of 1–2 ms contains no internet. Real players add
  tens to hundreds of milliseconds; these numbers are the server's share only.
- **The first 15 minutes of the soak shared the machine** with other work, which
  is where all 7 slow samples land. The final 45 minutes are clean.
- **Multi-hour and multi-day behaviour is untested.** One hour was the brief.

---

## 8. Reproducing

```bash
node t8-harness/ramp.js 200 6                              # §1.2
T8_STEPS=250,300,350,400 node t8-harness/ramp.js 400 8     # §1.3
T8_ROOM_SIZE=8 T8_STEPS=25,50,100,150 node t8-harness/ramp.js 150 8   # §2
node t8-harness/soak.js 150 60 6                           # §3
node t8-harness/fuzz.js                                    # §4
node t8-harness/adversarial.js                             # §5
node t8-harness/coldstart.js                               # §6
```

Raw logs from this run: `claude/t8-ramp.log`, `claude/t8-ceiling.log`,
`claude/t8-roomsize8.log`, `claude/t8-soak.log`, `claude/t8-soak-samples.json`,
`claude/t8-fuzz.log`, `claude/t8-adversarial.log`.

Each script exits non-zero on failure, so any of them works as a gate.
