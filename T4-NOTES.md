# T4 recon notes — sharing/retention loop (typeaword)

## Repos
- **Backend** (this repo): Node WS server (`server.js` + `roomManager.js` + per-mode logic).
  Deployed on Render (`wss://chain-reaction-backend-i6kx.onrender.com`). Tests: `npm test`
  (node --test, file list in package.json). Branch here: `feat/blitz-bot`.
- **Frontend**: `C:\Users\andyw_tnc0kix\Downloads\wordarcade-frontend_1\wordarcade-frontend`
  (React + Vite, "typeaword", deployed at typeaword.com). Branch: `feat/blitz-bot-ui`.
  No test infra yet (`"type": "module"`, so `node --test` works on pure modules).

## Play flow
- One WS per client (`useWebSocket`); server assigns a connection id = player id (no resume).
- Rooms: `create_room {name,isPublic}` → `room_created {code}` (4-char code);
  `join_room {code,name}`; errors: room_not_found / room_full / game_already_started.
- Modes: `word-bomb` (turn-based, lives), `category-blitz` (3 rounds × 20s, simultaneous,
  solo supported when 1 player), `imposter-word` (3+ players).
- Game end: `game_over` payload — word-bomb: `{winnerId}`; blitz: `{winnerId, finalScores}`;
  imposter: `{gameType, finalScores, ...}`. Frontend accumulates stats client-side
  (`gameStats`, `soloLogRef` per-round log for solo blitz).
- **URL structure: NONE.** App is pure view-state; only `?portal=1` (skip intro) and
  `?ref=share` (analytics) exist. No deep link into a room ⇒ Feature 3 adds `?join=CODE`.
- Existing share surface: `src/share/` — 1080px PNG card + `copySummary()` one-liner,
  ShareBar (SHARE/IMAGE/COPY) on all three game-over screens. No emoji grid, no room link.
- Solo blitz results screen keeps a localStorage personal best (`SOLO_PB_KEY`).
- Category picking is `Math.random()` (`pickRandomCategory`), pack-filterable via
  `room.selectedPacks`; rounds never repeat a category (`usedCategories`).

## Feature plan
1. **Shareable results** (frontend): new pure `src/share/shareText.js` — emoji-grid,
   per-mode, spoiler-free, "type fast, die slow" sign-off + link (join link for live
   multiplayer rooms, ref URL otherwise). Wire into cardModel/ShareBar COPY. Tests via
   `node --test`.
2. **Daily challenge**: backend — deterministic daily category set for solo Category
   Blitz. `start_game {daily:true}` (solo blitz only) → categories picked by seeded PRNG
   from UTC date key; rerolls disabled; full pool (packs ignored); `round_start`/`game_over`
   carry `daily {dayNumber, dateKey}`. Frontend — DAILY button on homepage (one tap:
   create_room + set_game_type + start_game daily), streak in localStorage keyed by UTC
   dayNumber (integer math ⇒ DST-proof), daily results screen variant + daily share text
   (day #, streak, per-round grid, categories NOT revealed).
3. **Frictionless invite**: frontend `?join=CODE` — skips intro chain, auto-joins with
   remembered/generated name (zero prompts), lands in room; on failure → JOIN screen with
   the error + public rooms. RoomScreen gets COPY INVITE LINK / native share. Share texts
   from live rooms embed the invite link.

## Constraints
- Shared backend folder (5 other sessions): never switch branches, commit only my files,
  prefix commits [T4], never push. Frontend package.json/App.jsx edits kept minimal.
