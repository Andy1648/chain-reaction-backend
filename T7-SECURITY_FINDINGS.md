# T7 — Security Findings (Phases 1–3)

Audit of every abuse vector from `T7-THREAT_MODEL.md` against the actual code,
with the fix, its proof test, and severity. All fixes are minimal and additive:
a new pure `security.js` module plus wiring in `server.js`. Tests live in
`security.test.js` (pure-function proofs) and were also verified end-to-end
against a live server (flood → single throttle error; XSS name → sanitized
broadcast; 70 KiB frame → socket closed 1009).

Severity scale: **HIGH** (remotely exploitable, real impact) · **MEDIUM**
(exploitable but bounded / conditional) · **LOW** (nuisance / defense-in-depth).

---

## FIXED

### F1 — No per-socket message rate limit — **HIGH** (vectors R1, R2, R6)
**Hole.** Only `create_room` was throttled. Every other WS message type —
`typing_update`, `submit_answer`, `spectator_reaction`, votes, everything — was
unbounded. `typing_update` and `spectator_reaction` **rebroadcast to the whole
room**, so one socket's flood fans out to N−1 sends (amplification). Category
Blitz `submit_answer` has no turn gate, so a script could also machine-gun
accept-list answers.

**Proof.** `security.test.js` → "a flood script is capped at MESSAGE_LIMIT per
window" (500 attempts, only 50 pass) and the live test (120 messages → exactly 1
`rate_limited` reply). "a realistic fast-typer burst stays under the message cap"
proves 15 msg/s legit play is untouched.

**Fix.** `security.js#slidingWindowAllow` + `server.js#allowMessage`: a global
per-socket sliding-window cap (`MESSAGE_LIMIT=50` / rolling second) checked right
after JSON parse, before the `switch`. Over the cap the message is dropped and the
client is notified **once per burst** (`_throttleNotified`) so our own error
replies can't become an amplification channel. Tuned ~4× a very fast typer's peak
(~15 msg/s), so legit speed-typing never trips it.

### F2 — Oversized-message DoS — **MEDIUM** (vector R3)
**Hole.** `new WebSocketServer({ server })` used the ws default `maxPayload`
(~100 MiB). `JSON.parse(raw.toString())` would allocate the whole frame; a few
large frames exhaust memory/CPU.

**Proof.** Live test: a 70 KiB frame closes the socket with code **1009**
(message too big) before the handler runs. `security.test.js` asserts the
constant is 64 KiB.

**Fix.** `new WebSocketServer({ server, maxPayload: MAX_WS_PAYLOAD_BYTES })`
(64 KiB). Game messages are a few hundred bytes, so the cap is generous; ws
rejects an over-cap frame itself, and the existing `close` handler cleans up.

### F3 — XSS via usernames — **MEDIUM** (vector R4)
**Hole.** `name` was length-capped (`.slice(0,20)`) but **not sanitized**:
control chars, zero-width/bidi formatting, and raw `<`/`>` passed through into the
name that is rebroadcast in `room_update` / `turn_update` /
`spectator_reaction.playerName` / imposter answer broadcasts — a persistent
cross-player display string. If any client renders a name as HTML, that's stored
XSS; bidi/zero-width chars also enable invisible name-spoofing.

**Proof.** `security.test.js` → the `sanitizeName` block (angle brackets stripped,
control chars removed, zero-width/bidi removed, whitespace collapsed, length
capped, empty/non-string → fallback). Live test: `<script>evil</script>` →
`scriptevil/script` in the actual `room_update` broadcast.

**Fix.** `security.js#sanitizeName`, applied at all three name intakes
(`create_room`, `quick_play`, `join_room`). Strips C0/C1/DEL control chars,
zero-width + bidi-override formatting chars, and `<`/`>`; collapses whitespace;
caps at 20; falls back to `Player`. Server-side defense-in-depth — the frontend
still owns HTML-escaping at render.

### F4 — Room-code guessing / join spam — **LOW–MEDIUM** (vector R5)
**Hole.** `join_room` had no throttle. Codes are 5 chars over a 32-char alphabet
(~33.5M combos); an unthrottled join loop could brute-force private-room codes
and add load.

**Proof.** `security.test.js` `slidingWindowAllow` tests cover the limiter; the
join path uses the same primitive with `JOIN_LIMIT=30`/min.

**Fix.** `server.js#allowJoin`: a per-socket `join_room` sliding-window cap
(30/min) checked before `joinRoom`, below the far-higher global message cap. A
legit player joins a handful of rooms per session, so the cap is invisible to
real use but turns code-guessing into a non-starter.

---

## VERIFIED SAFE — no code change

### V1 — Event forgery (acting for another player) — **SAFE** (vector R7)
Every state-changing handler derives the actor from the server-assigned `ws.id`
(`crypto.randomUUID()`), never from the payload. Host-only actions check
`room.hostId === ws.id`. `submit_vote`'s `suspectId` is only *who you vote for*,
and `submitVote` rejects self-votes and unknown suspects. There is no path to
submit, vote, reroll, or configure as another player. No fix needed.

### V2 — Replay of valid events — **SAFE** (vector R8)
The server is authoritative: Word Bomb checks `getCurrentPlayerId`; Category
Blitz/Imposter check `status`/phase; `submitWord` has an explicit TOCTOU race
guard around the dictionary await; per-player/per-round dedup blocks duplicate
answers. A replayed submit is rejected out-of-turn/out-of-phase and a replayed
vote just overwrites the same value. No meaningful replay exploit.

### V3 — Hidden-info leak, Imposter Word — **SAFE** (vector R9)
`startImposterRound` sends each player their *own* `round_start`: the imposter
receives only "You are the IMPOSTER. Blend in." and **never** the real category.
`imposterId` / `realCategory` / `imposterCategory` are only broadcast at the
`reveal` phase (`endVotePhase`), after voting closes. No payload leaks the
imposter's identity or the secret category early. No fix needed.

---

## PHASE 3 — Anti-cheat reasoning

**Can a client submit words impossibly fast?**
- *Word Bomb / Imposter*: turn/phase-gated and server-validated, so out-of-turn
  spam is rejected — no advantage.
- *Category Blitz*: simultaneous with no per-answer interval and no per-round
  answer cap (by design — the mode is "type as many as you can"). A script could
  out-submit a human. **Mitigated** by F1's global per-socket cap (50 msg/s),
  which bounds submission throughput to roughly a very fast human's ceiling. See
  *Recommendations* for a tighter per-answer option if cheating is observed.

**Can a client replay valid events?** No — see V2 (state-authoritative).

**Can a client see hidden info (the imposter word) in network payloads?** No —
see V3. This was the highest-value cheat to check and the code already gets it
right: the secret is never sent to the wrong client before reveal.

**Bot players.** Any socket can be scripted; this is inherent to an open,
account-less party game. Registry abuse is bounded by `MAX_ACTIVE_ROOMS` (500),
the create throttle (5/min), and the idle-room reaper; in-room abuse is now
bounded by F1. Full bot-proofing (accounts/CAPTCHA) is out of scope.

---

## PHASE 4 — Adversarial self-review (red-team pass)

A subagent was tasked with attacking the fixes above. It confirmed the rate
limiter's memory is hard-bounded (no unbounded `_msgTimes` growth), the
window math has no off-by-one, `_throttleNotified` doesn't amplify, backward
clock jumps only tighten (never bypass) the limiter, and non-string/array/object
names all hit the fallback. It found five real gaps; the top three are now fixed:

### F5 — Malformed-JSON frames bypassed the flood cap — **HIGH** (was live)
The throttle ran *after* `JSON.parse`, so a stream of non-JSON frames (e.g. `{`)
never counted against the cap: each drew an uncounted error reply (a reflected
~40× amplification channel) and an uncapped parse attempt. **Fixed** by moving
`allowMessage(ws)` to the very top of the handler, before parse. Live proof: 200
malformed frames now yield exactly 51 replies (50 parse-errors + 1 throttle
notice), vs 200 before.

### F6 — sanitizeName missed newer bidi/format chars — **MEDIUM**
`FORMAT_CHARS` omitted the bidi isolates U+2066–2069 (LRI/RLI/FSI/PDI), the
Arabic letter mark U+061C, and U+180E — all as effective for name-spoofing as the
overrides that were stripped. **Fixed** by extending the class. Proof:
`security.test.js` → "strips bidi isolates and the Arabic letter mark".

### F7 — sanitizeName didn't normalize; compat angle brackets survived — **MEDIUM**
Only literal `<`/`>` were stripped, so fullwidth (U+FF1C/FF1E) and small-form
(U+FE64/FE65) angle brackets passed through — and a client that NFKC-normalizes a
name at render time would reconstitute real `<`/`>`. **Fixed** by `normalize('NFKC')`
*before* stripping, so look-alikes fold to `<`/`>` and are then removed. Proof:
`security.test.js` → "NFKC-folds compatibility angle brackets, then strips them".

### F8 — quick_play wasn't under the join throttle — **LOW**
`quick_play` also joins a public room but only hit the global message cap. It
can't target a code (so it's not an R5 brute-force path), but for symmetry it now
shares `allowJoin` (bounds join/leave churn). **Fixed** (wiring in `server.js`).

**Residual (accepted, not fixed):** combining-mark "Zalgo" names (a base char +
stacked U+0300-range marks) remain possible within the 20-char cap. It's a
rendering nuisance, not injection; blanket-stripping combining marks would break
legitimate names in Arabic/Indic and other scripts, so it's left to the
frontend's render layer. See also the Origin / per-answer-floor recommendations.

## Recommendations (not fixed — documented)
- **Per-answer floor for Category Blitz** (cheap, optional): a ~150–250 ms
  minimum interval between accepted answers per player would make scripted
  accept-list dumping impossible while staying under any human's typing rate.
  Not added now because F1 already bounds the throughput and a too-tight floor
  risks nicking a genuinely fast typer — tune only if abuse is seen.
- **WebSocket Origin allow-listing**: the WS upgrade accepts any Origin. If the
  game is only ever embedded on known domains, checking `Origin` on upgrade would
  block casual cross-site socket use. Left open to avoid breaking legit clients
  (native apps, local dev) without knowing the deployment's allowed origins.
- **Spectator-reaction sender check**: `spectator_reaction` doesn't verify the
  sender is actually eliminated. Impact is limited to allow-listed emoji, now
  rate-capped by F1; a `game.players.find(...).eliminated` check would tighten it
  if reactions should be spectator-only.
