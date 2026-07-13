# T6 Developer Experience Audit — chain-reaction-backend

Audited 2026-07-12 (overnight autonomous session T6, branch `feat/blitz-bot`).

## Stack snapshot

- **Runtime:** Node.js (engines `>=18`; dev machine runs v24.17.0). Plain CommonJS, no transpiler, no bundler, **no build step**.
- **Framework:** Express 4 (health/version routes) + `ws` 8 (all game traffic on the same HTTP server).
- **Observability:** Sentry (`@sentry/node`) + PostHog (`posthog-node`), both graceful no-ops without env keys (`monitoring.js`).
- **Tests:** Node's built-in test runner (`node --test`), zero test dependencies. 71 tests passing at audit time across `gameLogic`, `roomManager`, `wordBombBot`, `categoryBlitzBot`.
- **Deploy:** Render (inferred from `/version` route echoing `RENDER_GIT_COMMIT`). GitHub remote: `Andy1648/chain-reaction-backend`.
- **Content pipeline:** `gen9-generate.js` / `gen9-convert.js` / `gen9-verify.js` + `categoryAnswers/` per-generation answer files. Per project memory, `gen9-convert.js` is broken since the pool review.

## Scorecard

| Area | Score | Notes |
|---|---|---|
| Tests | 8/10 | Real, fast-ish suite on the built-in runner. But the test script hand-lists files and **misses `turnRace.test.js`** (3 passing tests that never run in `npm test`). One bot test takes ~4.6s of wall-clock sleep. |
| Lint/format | 0/10 | No ESLint, no Prettier, no `.editorconfig`. Style is consistent by discipline only (2-space, single quotes, semicolons, CommonJS). |
| Type safety | 0/10 | Plain JS, no `checkJs`, no JSDoc typing discipline. |
| CI | 0/10 | No `.github/` at all. Nothing runs on push/PR; a broken commit reaches Render as fast as a good one. |
| Docs | 6/10 | README is thoughtful but **stale**: says deps were never installed and the server never started (both long since false), lists 3 deps (there are 5), omits Category Blitz / Imposter / bots entirely, and omits the newer message types. `.env.example` exists and is good. |
| Onboarding | 7/10 | `npm install && npm start` genuinely works; no hidden global tooling. |
| Guardrails | 2/10 | No CONTRIBUTING.md, no PR checks, no branch protection (can't verify from here, but nothing would run anyway). CLAUDE.md exists but only covers the two-session working setup, not the codebase. |

## What's manual today

- **All quality gates.** Nothing verifies a push: tests, syntax errors, unused vars — all caught only if someone remembers to run `npm test` locally.
- **Test file registration.** `package.json` hand-lists test files; new `*.test.js` files are silently skipped (this already happened: `turnRace.test.js`).
- **Deploy verification.** The `/version` route exists precisely because deploy freshness had to be checked by hand.
- **Content pipeline runs** (gen9 scripts) — expected to be manual, but have no smoke check.

## What's fragile

- Six parallel Claude sessions share this checkout (per session instructions); no lockfile-level or CI-level protection against a bad commit on the shared branch.
- `dictionary.js` fails open on network errors by design — fine, but nothing lints for accidental unhandled promises elsewhere.
- README's protocol table has drifted from `server.js` reality; a frontend dev trusting it would miss whole message families.

## Plan (this session)

1. **Phase 1:** ESLint 9 flat config (correctness rules only, matching existing style; no reformat) + Prettier config for opt-in use + `.editorconfig`. Fix genuine lint errors in separate commit. Evaluate light type checking via `tsc --checkJs` — adopt only if signal/noise is sane.
2. **Phase 2:** GitHub Actions: install (cached) → lint → test on push/PR. Glob-based test script so new test files can't be orphaned again.
3. **Phase 3:** CONTRIBUTING.md, README refresh of the setup section, CLAUDE.md expansion (keeping the existing working-setup note intact).
4. **Phase 4:** Fresh-clone simulation + subagent review of the workflow.
