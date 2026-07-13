# T2 — Bugs Found & Fixed

Session: overnight autonomous hunt on `feat/blitz-bot` (shared checkout with 9
other sessions — T1/T3–T10 were fixing/adding in parallel; overlaps noted).
Method: Phase 0 recon map in `T2-ATTACK_SURFACE.md`, then for each suspect a
failing test FIRST, then the minimal fix, then full-suite verification.

## Fixed by T2 (test + fix committed together)

### 1. MAJOR — Category Blitz `submitAnswer` TOCTOU across the Haiku AI await
Commit `063b74f` · tests `t2-blitzRace.test.js` (7)
`categoryBlitzLogic.submitAnswer` awaits the AI judge 0.5–3s on any accept-list
miss; timers keep running during the await. The post-await code pushed +
scored unconditionally, so: a round-N answer landed and scored in round N+1
(different category); a rerolled-away answer still scored even though
`rerollCategory` had just reverted that round's points; a finished game's
scoreboard changed AFTER `winnerId` was decided; the same answer submitted
twice in-flight passed `already_said` twice and double-scored; a player who
left mid-await still got an accepted result.
**Repro**: submit an off-list answer in the round's final second (or twice in
one second). **Fix**: snapshot round/category before the await; after it,
discard (`round_over`) on any status/round/category/membership change and
re-check `already_said`. Same pattern as the existing Word Bomb `turn_over`
guard. List-hit and list-only paths have no await — untouched.

### 2. MAJOR — every "is a game running" guard keyed off `status === 'in_progress'`
Commit `bad59b6` (see note) · tests `t2-lifecycle.test.js` (11)
Word Bomb is the only mode whose live game is `'in_progress'`. Blitz also
lives in `'between_rounds'`; Imposter NEVER uses `'in_progress'`
(answering/voting/reveal/between_rounds). Consequences, each reproduced:
- `joinRoom`: join an Imposter game at ANY point, or a Blitz intermission →
  ghost roster entry (gets broadcasts, can't play or score).
- `startGame`: NO already-running guard at all — a double-fired `start_game`
  silently discarded the live game and re-inited, wiping all progress.
- `addBot`/`removeBot`: roster mutation mid-game during any non-`in_progress`
  live phase (reachable via `set_game_type`'s stale-bot swap).
- `reapIdleRooms`: a live Imposter game was reapable.
**Fix**: one `isGameLive(room)` helper (`game && status !== 'finished'`) used
at all four sites. Finished-game joins and the solo PLAY-AGAIN restart loop
(refires only after `'finished'`) preserved.
*Note: committed inside T6's `bad59b6` — T6's commit swept up T2's staged
index entries (shared-checkout hazard). Content is T2's; tests carry the
rationale.*

### 3. MAJOR (DoS) — no length cap on submissions in any mode
Commit `96e4bbd` · tests `t2-inputLimits.test.js` (7)
- Word Bomb: a multi-KB all-letters "word" passes `^[a-z]+$`, the Dictionary
  API call for it fails (over-long URL) and FAILS OPEN → blob accepted into
  `usedWords` and rebroadcast to every player in EVERY later `turn_update`.
- Blitz: any list-miss reached the paid judge; in list-only mode (no API key)
  a blob of any size was accepted, stored, rebroadcast at round end.
- Imposter: no algorithmic validation at all; 3 × blob per player broadcast
  at reveal.
**Fix**: caps before any network/AI call — 45 (Word Bomb), 60 (Blitz),
80 (Imposter), rejected with new reason `too_long` (rejections travel in
`word_result`/`answer_result.reason`, not `humanizeError`, so no client
string regression).

### 4. MINOR — `skip_turn` on a round-based game threw a TypeError
Commit `dde9cd2` · tests `t2-server.test.js` (3, real server + real WS clients)
The handler checked `status === 'in_progress'` then read
`game.turnOrder[...]` — Blitz games are `in_progress` but have no `turnOrder`
→ TypeError (caught, but the player got the generic "Server error…" and every
occurrence was Sentry noise). **Fix**: capability guard
`Array.isArray(game.turnOrder)` (future turn-based modes keep working; all
round-based modes get the clean "No active game."). Red-green verified by
temporarily reverting the guard.

### 5. MINOR — host role could pass to a BOT
Commit `bad59b6` (same note as #2) · test in `t2-lifecycle.test.js`
A room holding a solo player's bot is still joinable by a second human; if
the original host then left, `players[0]` (the bot) inherited `hostId` —
nobody could start/reroll/rematch; room bricked until the reaper. **Fix**:
first non-bot player inherits.

### 6. MINOR — Word Bomb game stranded when a NON-current player disconnects
Commit `bad59b6` (same note) · test in `t2-lifecycle.test.js`
The end-of-game check only ran when the CURRENT player left. A 2-player game
losing the non-current player stayed `in_progress`, forcing the survivor to
play one more turn against nobody. **Fix**: after eliminating the leaver, if
≤1 active players remain, finish immediately (same `advanceTurn` path) and
broadcast `game_over`.

### 7. MINOR — Imposter vote phase hung after the last hold-out disconnected
Commit `7894078` · tests `t2-imposterLeave.test.js` (2)
The everyone-has-voted early-end only ran when a VOTE arrived. If the last
non-voter disconnected, the total shrank so all remaining players HAD voted,
but the phase sat on a dead clock up to `votePhaseSeconds`. **Fix**:
`removePlayer`'s imposter branch re-runs the `countVotes` check and resolves
via the same `endImposterVotePhase` path.

## Found by T2, fixed first by parallel sessions (no double work)

- **CRITICAL — no per-socket `ws.on('error')` listener + 100 MiB default
  `maxPayload`**: one bad frame → unhandled `'error'` event →
  `uncaughtException` handler → `process.exit(1)` → every live game dies.
  Ranked #1 in `T2-ATTACK_SURFACE.md`; T7 landed the listener, the 64 KiB
  frame cap, per-socket rate limits, and name sanitization (`a1f9a4a`) while
  T2 was mid-queue. Verified present.
- **MAJOR — cross-room ghost membership** (create/join/quick_play never left
  the previous room; ghost held a seat, got broadcasts, could keep the host
  role): ranked #5 in the map; fixed in parallel via `leaveCurrentRoom` in
  server.js with the same design T2 had planned (plus a same-room join ack).

## Triage — investigated, not fixed (recommendations)

- `haikuValidator.callTimes` map: keys for departed players are pruned on
  access but never deleted → slow unbounded growth over process lifetime
  (bounded by unique players ever seen). Recommend deleting empty entries or
  a size-triggered sweep. Severity: minor (single-instance, restarts on
  deploy).
- `dictionary.js` cache is unbounded (every unique word ever checked,
  including misses). Bounded in practice by gameplay volume + new length cap.
  Recommend an LRU cap if the instance is long-lived.
- Imposter: votes already cast FOR a player who then disconnects still count
  in the tally (can shield the imposter via `maxOtherVotes`). Accepted quirk;
  a fix would need vote reconciliation on leave.
- Imposter: if the IMPOSTER disconnects mid-round the round resolves as a dud
  (no scores). Acceptable; a nicer UX would end the round with a notice.
- `typing_update` / `spectator_reaction` require `status === 'in_progress'`,
  so they never relay during Imposter games (which never have that status).
  Flagged for the frontend team — intended or not, it's invisible today.
- `payload.code` of non-string type (e.g. number) throws inside the handler
  (caught → generic error). Harmless; a `String()` coercion would quiet it.

## TODO/FIXME/HACK sweep (Phase 4)

`T1-BUGS_FOR_T2.md` confirmed absent from this worktree. Zero TODO / FIXME /
HACK / XXX markers exist in any non-test root `*.js` (node_modules and
t3-harness excluded) — nothing to triage.
