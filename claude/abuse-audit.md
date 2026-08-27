# Abuse & rate-limiting audit — audit/abuse — 2026-08-27 (JOB 23)

REPORT ONLY. No code changed. The WS server is public and unauthenticated (by design — no accounts).
Each vector: severity, how bad, how likely, cheapest fix.

## TL;DR
The classic flood/payload/brute-force surface is **already well defended** (per-socket sliding-window
message + join + create caps, a 64 KiB frame cap, and thorough name XSS sanitization). Three real gaps
remain: **(1) display names aren't moderated** (a slur can be broadcast to every player), **(2) the AI
judge is a latent cost/DoS bomb the day an API key is added** (only a global throttle, no per-socket
budget), and **(3) the dictionary cache grows unbounded under invalid-word spam** (see JOB 22 F1).

## Findings

### A1 — [MEDIUM] Slurs / hate in display names  `server.js:304/343/377`, `security.js:sanitizeName`
`sanitizeName` normalizes (NFKC) and strips control/bidi/zero-width/angle-bracket chars and caps length
— XSS and name-spoofing are handled well. But it does **not** moderate content, so a player can set
their name to a slur, which is rebroadcast to every player via `room_update` / `turn_update` /
spectator payloads (`roomManager.js:296/322/726`). For a PEGI-12 school audience that is visible hate
content.
**Fix:** run the sanitized name through the moderation list added in `fix/dict-safety`
(`blockedTerms.isBlockedForDisplay` / a name policy) — reject with an error, or replace the offending
token with the fallback `Player`. Cheap; reuses existing code.
Likelihood: HIGH (trivial). Impact: MEDIUM.

### A2 — [MEDIUM, conditional] AI-judge cost / budget-exhaustion  `categoryBlitzLogic.js:796`, `haikuValidator.js:51`
When `ANTHROPIC_API_KEY` is set, every Category Blitz answer that misses the offline accept-list is sent
to the Haiku judge. Client submissions are bounded only by the generic 50 msg/s cap, so a socket
streaming distinct non-answers drives up to ~50 model calls/s. There IS a global throttle
(`haikuValidator.js:51 callTimes = new Map()`), which caps total spend — but it is **global, not
per-socket**, so one abuser can exhaust the shared judge budget and deny legit players (a DoS on the
judge, plus cost until the cap bites). **Today this is DISABLED** (no key → list-only, `server.js:754`),
so there is no live cost, but it becomes real the moment JOB 25's key lands.
**Fix:** add a per-socket AND per-round judge budget (e.g. ≤ N judged misses per round, ≤ M per minute
per socket) on top of the global throttle; cache verdicts per (category, answer) so repeats are free.
Likelihood: MEDIUM (once a key exists). Impact: MEDIUM–HIGH (real money + judge DoS).

### A3 — [MEDIUM] Unbounded dictionary cache under invalid-word spam  `dictionary.js:11/56`  (see JOB 22 F1)
The Word Bomb validation cache stores every distinct alphabetic submission, valid or not, with no
eviction. The 50 msg/s cap still permits ~50 new cache entries/s/socket; measured **+20.8 MB per 50k**
distinct invalids → sustained memory growth toward OOM on a long-lived Render instance.
**Fix:** cap the cache (LRU/FIFO, ~100k) or only cache positive results. Full detail in the JOB 22 report.
Likelihood: MEDIUM. Impact: MEDIUM (memory exhaustion).

## Verified well-defended (no action)
- **Message flooding** (R1/R2): per-socket sliding window, 50 msgs / rolling second (`security.js`
  MESSAGE_LIMIT, wired `server.js:190`). ~4× a fast typer's peak; a flood script is capped hard.
- **Oversized payloads** (R3): `WebSocketServer({ maxPayload: 64 KiB })` (`server.js:163`) drops
  giant frames before `JSON.parse` allocates — stops the ws-default ~100 MiB frame.
- **Unbounded room creation** (R1): per-socket `create_room` throttle = 5 / 60 s (`server.js:175`,
  enforced `:298`) + global `MAX_ACTIVE_ROOMS = 500` backstop (`roomManager.js:105/136`) + 20-min idle
  reaper. Exhausting 500 rooms needs ~100 sustained sockets and self-heals on reap.
- **Room-code brute-force / joining arbitrary rooms**: `join_room` throttled to 30 / 60 s per socket
  (`server.js:197`); the code space is 32^5 ≈ 33.5M, so guessing a live 5-char code at 30/min is
  infeasible. Public rooms are listed intentionally; private rooms are code-gated.
- **XSS via usernames** (R4): NFKC + control/format/bidi/angle-bracket stripping + length cap
  (`security.js sanitizeName`); the frontend also HTML-escapes at render. Solid.

## Inherent (by-design) note
No authentication is deliberate (no accounts, instant play). Consequence: anyone who knows a room code
can join it, and there is no durable identity, so a griefer can rejoin under new names. This is inherent
to anonymous multiplayer; the throttles above bound its blast radius. Moderating names (A1) removes the
worst of it. A per-IP connection cap (not present) would further limit sock-puppet floods — optional.
