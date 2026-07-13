# T3 — Resilience Findings (Phase 2)

Scenario suite: `node t3-harness/scenarios.js` (13 scenarios, all passing as of
this commit). Each finding below was demonstrated by a failing scenario first,
then fixed minimally. Several overlapped with bugs other night-shift sessions
(T1/T2/T7) found and fixed concurrently in this shared checkout — noted per
finding.

## Findings

### F1 — Ghost roster entries on room hop (FIXED — T3, `leaveCurrentRoom` in server.js)
**Scenarios:** S7, S7b (failed before fix), S7c.
`create_room` / `join_room` / `quick_play` never detached the connection from
its previous room; they just overwrote `connectionToRoomCode`. The old room
kept a roster entry with a live socket **forever**: it consumed a player slot,
kept receiving that room's broadcasts (client saw two rooms' traffic
interleaved), inflated the public-rooms player count, and pinned the room in
memory — disconnect cleanup only consults `connectionToRoomCode`, which the hop
overwrote, so no code path ever removed the ghost.
**Fix:** `leaveCurrentRoom(ws)` runs before the socket lands in a new room —
after a successful create/join (so a failed attempt doesn't evict you), before
the search for quick_play (which could otherwise pick your own room). Re-joining
the room you're already in is now an idempotent ack instead of a duplicate
roster push (S7c: `joinRoom` happily pushed the same player id twice).
*(Note: this fix rode into history inside `8ee58c7` — a whole-file commit from
the concurrent T7 session; authorship is T3's, tests live in this suite.)*

### F2 — Host role could pass to a bot (FIXED concurrently by another session)
**Scenario:** S3.
Solo player adds a bot, second human joins (allowed — the roster cap is the
only join guard), original host leaves → `hostId = players[0].id` = the bot.
Nobody left in the room can start, reroll, or rematch: the room is bricked.
Fixed in the shared tree while this suite was being written (host reassignment
now skips bots); S3 pins the behavior.

### F3 — Lone survivor had to play out a turn against nobody (FIXED concurrently)
**Scenario:** S9.
Word Bomb: when a NON-current player disconnected leaving one active player,
the finish check only ran on the next turn event — the survivor kept playing
against the timer. Fixed in the shared tree (`removePlayer` now finishes the
game when ≤1 active remain); S9 pins it.

### F4 — Category Blitz scoring race after the awaited AI validation (FIXED by T2, `063b74f`)
Identified independently in Phase 0 recon (see T3-MULTIPLAYER_MAP.md §risk 3):
`submitAnswer` awaited the Haiku judge with no round-guard, so a buzzer-beater
answer resolving after `endRound` still scored (`score += 1`) into a round that
had already been broadcast. T2 shipped the TOCTOU guard first; not duplicated.

### F5 — No reconnect support (DESIGN LIMITATION, documented, not fixed)
**Scenario:** S1 (pins current behavior).
Identity = connection id; a dropped socket mid-game is force-elimination
(Word Bomb) or silent roster removal (Blitz/Imposter), and the returning player
is politely refused (`game_already_started`). A real fix (session tokens +
grace-period rejoin) is an architecture change — recommended in T3-SUMMARY.md,
not attempted as a night-shift "minimal fix".

### F6 — Imposter leaving mid-round (VERIFIED SAFE / acceptable)
**Scenario:** S10.
The imposter hard-killing their socket mid-answer-phase does NOT hang or crash
the round: answering closes into voting on time, votes resolve, `vote_results`
reveals the (departed) imposter. Game-design oddity (players vote on a ghost
round) but no engine defect. T2 separately fixed the last-voter-disconnect hang
(`7894078`).

## Verified-robust behaviors (no defect found)

- **S2** Host leave in lobby → host passes to a remaining human who can start.
- **S4** Mass disconnect mid-game (both modes) → room destroyed, **0 timers, 0
  roster entries** left (stats side-port `roomTimers`/`activeTimeouts`).
- **S5** ~3s-RTT client: Blitz answers land and score exactly once; an answer
  arriving in the intermission is cleanly refused, never scored.
- **S6** Events from a room-less client (all 8 mutating types + malformed JSON)
  → clean per-type errors, connection and server stay healthy.
- **S8** Two clients racing for the last (8th) slot: single-threaded message
  handling admits exactly one; the other gets `room_full`.
- **S11** 10 rounds of 5-client join/leave churn (half clean leaves, half TCP
  kills): registry returns exactly to baseline (rooms/players/timers), and
  `create_room` still responds <1s after.

## Flakiness notes (harness, not server)

- This machine runs several concurrent CI/test sessions; event-loop stretch can
  make 1s server ticks arrive late. Phase timers are wall-clock-ish
  (`remaining -= 1` per interval fire), so scenario timeouts carry big margins
  (S10 waits up to 120s for a nominal 33s phase).
- Two harness self-bugs fixed along the way (stale-inbox matches, racing
  `waitFor`s) — see "Gotchas" in t3-harness/README.md.
