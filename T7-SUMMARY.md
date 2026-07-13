# T7 — Security Mission Summary

Overnight security pass on the Chain Reaction backend (multiplayer word game:
one WS protocol + two read-only HTTP routes, in-memory single instance). Mapped
every data-ingress path, audited each abuse vector against the real code, fixed
the real holes with minimal additive changes + proof tests, then red-teamed my
own fixes and hardened what that surfaced.

Full details: `T7-THREAT_MODEL.md` (Phase 0 map + ranking) and
`T7-SECURITY_FINDINGS.md` (per-vector audit, fixes, proofs).

## What changed
- **New `security.js`** — pure, dependency-free, unit-tested: `sanitizeName`
  (NFKC-normalize → strip control / bidi-isolate / zero-width / angle-bracket
  chars → collapse → cap 20 → fallback) and `slidingWindowAllow` (rolling-window
  rate primitive), plus tuned limits.
- **`server.js` wiring** — a global per-socket message cap (checked *before*
  JSON.parse), a `join_room`/`quick_play` throttle, `maxPayload` on the socket
  server, and `sanitizeName` at every username intake.
- **`security.test.js`** — 16 proof tests; verified end-to-end against a live
  server too.

## Holes found & fixed — 8

| # | Vector | Severity | Fix |
|---|---|---|---|
| F1 | No per-socket message rate limit (flood + broadcast amplification) | **HIGH** | Global 50-msg/rolling-sec cap per socket |
| F5 | Malformed-JSON frames bypassed the cap (found in Phase 4 self-review) | **HIGH** | Moved throttle above `JSON.parse` |
| F2 | Oversized-frame DoS (ws default ~100 MiB) | MEDIUM | `maxPayload` = 64 KiB |
| F3 | Username XSS (no sanitization) | MEDIUM | `sanitizeName` at all intakes |
| F6 | Sanitizer missed bidi isolates / U+061C / U+180E | MEDIUM | Extended strip set |
| F7 | Sanitizer missed fullwidth/small-form `<>` (re-expand under NFKC) | MEDIUM | NFKC-normalize before strip |
| F4 | Room-code guessing / join spam (no throttle) | LOW–MED | 30 joins/min per socket |
| F8 | `quick_play` not under the join throttle | LOW | Shares `allowJoin` |

**Severity counts:** HIGH 2 · MEDIUM 4 · LOW(–MED) 2.

## Verified already-safe (no change needed) — 3
- **Event forgery** — the actor is always the server-assigned `ws.id`; no handler
  trusts a client-supplied player id, and host actions check `hostId === ws.id`.
- **Event replay** — server is state-authoritative (turn/phase/dedup checks + the
  `submitWord` TOCTOU race guard); replays are rejected or idempotent.
- **Imposter hidden-info leak** — the imposter never receives the real category;
  identity/secret are broadcast only at the reveal phase. This was the
  highest-value cheat to check and the code already handles it correctly.

## Verification
- `npm test` (node --test, auto-discovered): **278/278 pass** (16 new).
- `npm run lint`: clean for all T7 files.
- Live end-to-end: XSS name → `scriptevil/script` in the broadcast; 120-msg flood
  → 1 throttle reply; 200 malformed frames → 51 replies (was 200); 70 KiB frame →
  socket closed 1009.

## Top remaining risk
**Scripted / bot clients.** With no accounts or human-verification, an automated
client can still play — most concretely, dump Category Blitz accept-list answers
up to the 50-msg/sec cap, out-pacing a human within that budget. The cheap
mitigations are in (throughput is now bounded, registry abuse is capped by
`MAX_ACTIVE_ROOMS` + create throttle + reaper), but eliminating optimal botting
would need either a per-answer minimum interval (~150–250 ms — deferred to avoid
nicking genuine fast typers) or an account/CAPTCHA layer (out of scope for a
casual party game). Secondary residuals: the WS upgrade accepts any `Origin`
(left open to not break native/dev clients), and combining-mark "Zalgo" names
remain a render-layer nuisance. All documented as recommendations in
`T7-SECURITY_FINDINGS.md`.
