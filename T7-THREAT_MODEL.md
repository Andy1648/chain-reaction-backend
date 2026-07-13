# T7 — Threat Model (Phase 0)

Chain Reaction is an in-memory, single-instance multiplayer word game. All real
gameplay traffic is a WebSocket JSON protocol; a tiny Express app serves only
two read-only health/version routes. This document maps **every way untrusted
data enters the system** and ranks the abuse vectors. Phase 1 audits each
against the actual code; fixes and severities are logged in
`T7-SECURITY_FINDINGS.md`.

## 1. Data ingress map

### HTTP (Express — `server.js`)
| Surface | Input | Notes |
|---|---|---|
| `GET /health` | none | static `{status:'ok'}` |
| `GET /version` | none | echoes `RENDER_GIT_COMMIT` env, not user input |
| `express.json()` | request body | mounted globally, but **no route reads a body** — no POST/PUT handlers exist |
| `cors()` | Origin | **wide open** (`app.use(cors())`), all origins allowed |

The HTTP surface is nearly inert: no route consumes user input, so classic HTTP
injection/SSRF/body-abuse has almost no reach. CORS being open only matters for
the two read-only GETs.

### WebSocket (`wss.on('connection')` → `ws.on('message')`)
One socket handler multiplexes every message via `switch (type)`. The client
controls `type` and `payload`. Server-assigned identity: `ws.id =
crypto.randomUUID()` — the player id is **always** server-derived, never taken
from the payload.

Client-supplied fields across all message types:

| Field | Message types | Constraints today |
|---|---|---|
| `name` (username) | create_room, quick_play, join_room | `.slice(0,20)`, **no sanitization** |
| `code` (room code) | join_room | `.toUpperCase().trim()` |
| `word` / `answer` | submit_word, submit_answer | `.toString()`, validated by game logic |
| `text` (live typing) | typing_update | `.slice(0,50)`, relayed to others, **no validation** |
| `emoji` | spectator_reaction | allow-listed to 4 emojis |
| `suspectId` | submit_vote | who you vote *for* (not an actor spoof) |
| `difficultyKey` | set_difficulty | enum-checked |
| `packs` | set_packs | validated vs `VALID_PACK_IDS` |
| `gameType` | set_game_type | enum-checked |
| `difficulty` | add_bot | enum-checked (defaults medium) |
| `isPublic` | create_room | coerced to bool |

## 2. Ranked abuse vectors

Ranked by realistic impact × ease on this codebase. Detailed audit + fix status
in `T7-SECURITY_FINDINGS.md`.

### R1 — Per-socket message flooding (no global rate limit) — **HIGH**
Only `create_room` is throttled (5/min). Every other message type is unbounded.
Two amplifiers make this sharp:
- `typing_update` **rebroadcasts** the sender's text to every other player in the
  room — one attacker message fans out to N−1 sends.
- `submit_answer` in Category Blitz is **simultaneous, no turn gate** — a script
  can fire accept-list answers as fast as the socket allows.
No cap on inbound message frequency ⇒ CPU/bandwidth exhaustion + broadcast
amplification against a whole room. This is the single most impactful gap.

### R2 — Category Blitz answer flooding = "impossibly fast" cheat — **MEDIUM**
Category Blitz has no per-turn check and no per-round answer cap (by design —
race to type as many as you can). Accept-list hits are free and instant. A
scripted client can submit the entire accept-list in milliseconds for a perfect
score. Overlaps with R1; the same per-socket cap is the primary mitigation.

### R3 — Oversized-message DoS (`ws` default `maxPayload`) — **MEDIUM**
`WebSocketServer` is constructed with no `maxPayload`, so it defaults to ~100 MiB
per frame. `JSON.parse(raw.toString())` then allocates the whole thing. A few
large frames can exhaust memory/CPU. Game messages are tiny — a small cap is safe.

### R4 — XSS via usernames — **MEDIUM** (severity depends on frontend render)
`name` is length-capped but **not sanitized**: control chars, bidi/zero-width
formatting, and `<`/`>` pass straight through. The name is stored and rebroadcast
in `room_update`, `turn_update`, `spectator_reaction.playerName`, and imposter
answer broadcasts — a persistent, cross-player display string. If the frontend
ever renders a name as HTML, this is stored XSS. The backend can't control
rendering, but server-side stripping is cheap defense-in-depth. (No free-text
chat feature exists; usernames are the only free-text display field.)

### R5 — Room-code guessing / join spam — **LOW–MEDIUM**
Room codes are 5 chars over a 32-char alphabet (~33.5M combos). `join_room` has
**no throttle**, so a client can brute-force codes to discover private rooms, and
join-spam adds load. The keyspace is large, but an unthrottled join loop is still
worth blunting with a per-socket join cap.

### R6 — spectator_reaction sender not verified — **LOW**
The handler comments describe "an eliminated player" firing a reaction but does
**not** check the sender is actually a spectator/eliminated — any in-room socket
can send. Impact is limited to allow-listed emoji spam; folded under the R1 cap.

### R7 — Event forgery (acting for another player) — **CHECKED: SAFE**
Every state-changing handler derives the actor from `ws.id` (server-assigned
UUID), never from the payload. Host-only actions check `room.hostId === ws.id`.
There is no path to submit/vote/act as a different player. Verified, no fix
needed.

### R8 — Replay of valid events — **CHECKED: SAFE (state-authoritative)**
Messages aren't signed/nonce'd, but the server is authoritative: turn checks
(`getCurrentPlayerId`), phase checks (`status`), the TOCTOU race guard in
`submitWord`, and per-player/per-round dedup mean a replayed submit is rejected
out-of-turn/out-of-phase, and a replayed vote just overwrites the same vote.
No meaningful replay exploit.

### R9 — Hidden-info leak (imposter word) — **CHECKED: SAFE**
`startImposterRound` sends each player their *own* `round_start`: the imposter
receives only the "You are the IMPOSTER. Blend in." notice and **never** the real
category. `imposterId`/`realCategory` are only broadcast at the reveal phase.
No payload leaks the imposter identity or word early. Verified.

### R10 — Bot / scripted players — **LOW (inherent), mitigated by R1**
Any client is just a socket; nothing distinguishes a script from a human, which
is inherent to an open game. The `MAX_ACTIVE_ROOMS` cap (500), the create
throttle, and the idle-room reaper bound registry abuse; the R1 per-socket cap
bounds in-room abuse. Full bot-proofing (CAPTCHA/auth) is out of scope for a
casual party game — documented as a recommendation.

## 3. Fix plan (Phases 1–2)
- **R1/R2/R6** → add a generous per-socket inbound message rate limit (tuned so a
  fast speed-typer is never affected), in `server.js`, backed by a pure,
  unit-tested `security.js` helper.
- **R3** → set `maxPayload` on the `WebSocketServer` to a small cap.
- **R4** → `sanitizeName()` in `security.js`, applied at every name intake.
- **R5** → per-socket `join_room` throttle.
- **R7/R8/R9** → verified safe; documented, no code change.
