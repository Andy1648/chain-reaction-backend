## Working setup
- Default to two parallel Claude Code sessions: one on `wordarcade-frontend`, one on `chain-reaction-backend`. Frontend is the one I actively drive; backend runs more autonomously to soak up wait time.
- If only one of these sessions is running, remind me that the other repo's session should be up too.

## Stack & commands
- Plain Node.js (CommonJS, no build step). Express 4 for HTTP routes, `ws` 8 for all game traffic on the same server. Node >= 18 (dev on 24). Deployed on Render from pushed branch (`GET /version` echoes the live commit).
- `npm test` — Node's built-in runner, auto-discovers every `*.test.js` in the repo. Name test files `<module>.test.js` and they run automatically; never hand-list them in package.json.
- `npm run lint` — ESLint 9 flat config (`eslint.config.js`), correctness rules only. Must be clean.
- `npm run dev` — local server with `--watch`, port 3001 or `$PORT`. `GET /health` is the liveness check.
- Prettier is opt-in per file only (`npm run format -- <file>`); NEVER bulk-reformat.
- No type checking: `tsc --checkJs` was evaluated (2026-07) and rejected — ~1500 errors of pure noise on 3 core files.
- CI: `.github/workflows/ci.yml` runs install → lint → test on every push/PR.

## Architecture pointers
- `server.js` — entry point; Express health/version routes + WebSocket message router. Sentry/PostHog init FIRST (`monitoring.js`), both no-op without env keys.
- `roomManager.js` — rooms, turn timers, broadcasting; the shared multiplayer core for all game modes.
- Game modes: `gameLogic.js` (Chain Reaction), `categoryBlitzLogic.js`, `imposterWordLogic.js`; bots in `wordBombBot.js` / `categoryBlitzBot.js`.
- Content pipeline: `gen9-generate.js` / `gen9-convert.js` / `gen9-verify.js` + `categoryAnswers/` (per-generation answer packs) + `categoryPacks.js`. NOTE: `gen9-convert.js` broken since the pool review — see memory `gen9-pipeline-post-cull`.
- Deeper maps: `T1-ARCHITECTURE.md`, `T3-MULTIPLAYER_MAP.md`; conventions: `CONTRIBUTING.md`.

## Conventions
- CommonJS only; single quotes, semicolons, 2-space indent (`.editorconfig`).
- Fail open on third-party calls (dictionary API, AI validators): gameplay must never block on a vendor outage.
- Pure logic gets tests with injected mocks (`_setDictionaryForTesting()`, `dictionary.mock.js`), not network calls.
- Commit prefixes: `feat:` / `fix:` / `chore:` / `content:` / `ci:` / `docs:`; content data commits separate from logic commits.
