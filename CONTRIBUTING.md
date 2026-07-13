# Contributing

Conventions in this repo, as observed from the existing code — match them.

## Getting set up

```bash
npm install
npm test        # 100% must pass before and after your change
npm run lint    # must be clean (0 errors)
npm run dev     # local server with auto-restart, port 3001 or $PORT
```

Copy `.env.example` to `.env` if you need AI answer validation locally; the
server runs fine without any env vars (features degrade gracefully).

## Code style

- **CommonJS** (`require`/`module.exports`) — do not introduce ESM.
- 2-space indent, single quotes, semicolons. `.editorconfig` enforces the
  basics; ESLint enforces correctness rules only (no style nagging).
- Prettier is available but **opt-in per file** (`npm run format -- file.js`).
  Never bulk-reformat: the diff noise isn't worth it, and several parallel
  sessions/PRs often have this codebase open at once.
- Comment style: block comments at the top of files/functions explaining
  *why* and design intent, not line-by-line *what*. See `server.js` and
  `roomManager.js` for the house voice.
- Defensive posture: user-facing paths never throw to the top level.
  Third-party calls (dictionary API, AI validators, Sentry/PostHog) are
  wrapped and **fail open** so gameplay never blocks on a vendor.

## Tests

- Node's built-in runner, zero test dependencies. `npm test` runs
  `node --test`, which auto-discovers every `*.test.js` in the repo —
  name new test files `<module>.test.js` and they're picked up
  automatically.
- Pure logic (game rules, scoring, timers) gets the real test budget.
  Use the `_setDictionaryForTesting()` -style injection hooks rather than
  network calls; `dictionary.mock.js` exists for exactly this.
- Timer-driven behavior is tested with real (short) timers; keep any new
  sleep-based test under a few seconds.

## Commits

- Imperative, prefixed by area when useful: `feat:`, `fix:`, `chore:`,
  `content:` (word/category data), `ci:`, `docs:`. Parallel overnight
  Claude sessions additionally prefix a codename like `[T6]`.
- Content changes (packs, word lists) are committed separately from logic.
- Lint/format fixes go in their own commit, separate from config changes.

## CI

Every push and PR runs install → lint → test via GitHub Actions
(`.github/workflows/ci.yml`). There is no build step — this deploys as-is
to Render, which runs `npm install && npm start` from the pushed branch.

## Architecture pointers

- `T1-ARCHITECTURE.md` — module map + critical-logic ranking.
- `T3-MULTIPLAYER_MAP.md` — room/socket lifecycle deep-dive.
- `README.md` — message protocol reference and design decisions.
