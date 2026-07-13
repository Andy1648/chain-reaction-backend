# T4 — Sharing / Retention Loop: what shipped + demo script

Three features that make typeaword spread Wordle-style. All built end-to-end,
tested, self-reviewed, and committed. Nothing pushed (per your rules).

## Where the commits are

**Backend** (`chain-reaction-backend`, branch `feat/blitz-bot`):
- `9380bc3` docs: recon notes
- `dc4b00f` feat: Daily Challenge — date-seeded solo Category Blitz

**Frontend** (`wordarcade-frontend`, branch `feat/blitz-bot-ui`):
- `8eb67ea` feat: emoji-grid share text + invite links on every result screen
- `3ddbaae` feat: Daily Challenge UI — one-tap daily, streaks, branded results
- `1eda4bd` feat: frictionless invite — ?join deep links, no dead ends
- `ae49264` polish: share-text edge cases from self-review

## Tests (all green)
- Frontend: `npm test` → 34 pass (`src/share/shareText.test.js`,
  `src/share/links.test.js`, `src/daily/streak.test.js`).
- Backend: `npm test` → full suite incl. `dailyChallenge.test.js` (14 daily cases:
  UTC-midnight/DST day math, board determinism, solo-only gate).

---

## One-time local setup (needed for the demo)

Two terminals.

**1. Backend** — from `chain-reaction-backend`:
```
npm install        # first time only
npm run dev        # listens on ws://localhost:3001  (GET /health to check)
```
Optional: set `ANTHROPIC_API_KEY` to enable the Blitz AI answer-judge. Without it
the game still runs fine (accept-list only), so it's not required for the demo.

**2. Frontend** — from `wordarcade-frontend`:
- Point the client at your local backend for the demo. In `src/config.js`, change:
  ```
  export const BACKEND_WS_URL = 'ws://localhost:3001';
  ```
  (It normally points at the Render URL. This is a shared file — **don't commit
  the change**; revert it when done, or use `git stash` on just that file.)
- Then:
  ```
  npm install      # first time only
  npm run dev      # Vite, usually http://localhost:5173
  ```

Open `http://localhost:5173`. Click through the splash once to unlock audio.

---

## FEATURE 1 — Shareable results (emoji-grid share text)

**See it:**
1. On the menu, open **AI CATEGORY BLITZ → CREATE ROOM**. You're a solo room.
2. Click **ADD BOT** (so the game has an opponent) OR just start solo — either works.
   Hit **START GAME**.
3. Play the 3 rounds (type answers; even typing nothing is fine for the demo).
4. On the results screen, find the **SHARE / IMAGE / COPY** bar. Click **⧉ COPY**.
5. Paste anywhere (a chat, a notes app). You'll get something like:
   ```
   TYPE A WORD · CATEGORY BLITZ 🔥
   R1 🟧🟧🟧🟧 4
   R2 🟥 0
   R3 🟧🟧 2
   6 PTS
   type fast. die slow.
   https://typeaword.com/?ref=share
   ```

**What to notice:**
- Distinct per-mode emoji grid (Word Bomb = a `⚡🔥💥☠️👑` event timeline; Blitz =
  per-round `🟧` rows; Imposter = `caught ✅ / fooled 🎭`, spoiler-free).
- The `🟥` is a whiffed round — renders on light *and* dark chat backgrounds.
- Brand sign-off `type fast. die slow.` on every share.
- **Multiplayer** results embed a real `?join=<code>` link instead of the plain
  ref URL — so a group-chat paste doubles as a "rematch me" invite (see Feature 3).
- 0-point games still read like a brag, not an error ("0 PTS. brain fully buffered").

**Bonus:** **⬇ IMAGE** downloads the 1080px result card; **📣 SHARE** opens the
native share sheet on mobile.

---

## FEATURE 2 — Daily Challenge (once-a-day, same board for everyone)

**See it:**
1. On the menu there's a yellow **⚡ DAILY #194** banner (today's number). Click it.
   → One tap: it creates a room, locks Blitz, and starts today's board. No name
   prompt, no lobby.
2. Play the 3 daily rounds. On results you'll see **⚡ DAILY CHALLENGE #194** and
   **🔥 1-DAY STREAK**.
3. Click **⧉ COPY** on the share bar — the text is daily-branded:
   ```
   TYPE A WORD · DAILY #194 ⚡
   R1 🟧🟧🟧 3
   R2 🟧🟧🟧🟧🟧 5
   R3 🟧 1
   9 PTS · 🔥 1-day streak
   type fast. die slow.
   https://typeaword.com/?daily=1&ref=share
   ```
4. Go back to the menu → the DAILY banner now shows **🔥 1** and **✓ PLAYED**.

**Prove determinism (the key property):**
- Open a **second browser / incognito window** to `localhost:5173`, play the daily
  there too — **same three categories, same order**. Everyone on a given UTC day
  gets the identical board (server picks them from a seeded PRNG on the date).
- Rerolls are disabled in the daily (the board can't fork).

**Prove the streak logic (no waiting a day):** it's unit-tested, but if you want to
eyeball it, the streak is keyed on the **server's** UTC day number, using integer
day math — so it's immune to timezone/DST and to a client clock change. See
`src/daily/streak.test.js` (consecutive days extend; a gap resets to 1; same-day
replay doesn't double-count; DST days still increment by exactly 1).

---

## FEATURE 3 — Frictionless invite (a link lands a friend IN the room)

**See it:**
1. Create any room (e.g. **WORD BOMB → CREATE ROOM**). In the room, under the room
   code, click **⧉ COPY INVITE LINK**. You get `http://localhost:5173/?join=<CODE>&ref=share`.
   (On the deployed site it's `https://typeaword.com/?join=<CODE>&ref=share`.)
2. Open that link in a **second browser / incognito window**.
   → It **skips the whole intro** (no splash/knife-split), auto-joins with a
   generated arcade name, and lands directly in the room. Zero prompts, zero typing.
   You'll briefly see a **JOINING ROOM <CODE>…** banner while it connects.
3. Back in window 1, the second player appears in the roster instantly.

**Prove the dead-ends are gone:**
- **Bad/expired link:** open `localhost:5173/?join=ZZZZZ` (a room that doesn't
  exist). Instead of dead-ending on the menu, it drops you on the **JOIN ROOM**
  screen with the error shown *and* the live public-rooms list to hop into.
- **Full/mid-game room:** try to `?join=` a room whose game has already started —
  same graceful bounce to the JOIN screen with a clear message (the server blocks
  joins during *any* live phase, including Blitz's between-rounds, so a link can't
  corrupt a running game).
- **Daily deep link:** `localhost:5173/?daily=1` drops straight into today's Daily
  Challenge the same frictionless way.

---

## Self-review (Phase 4)

A subagent audited UX copy + edge cases against the real code. Verdict: the
load-bearing logic was already correct — mid-game join is blocked by `isGameLive`
(not just `in_progress`), the deep-link auto-fire is reconnect-safe, rerolls don't
double-count the round log, and the streak is consistent across DST/midnight and
across replays after midnight. The findings were all low-severity polish and are
fixed in `ae49264`: the invisible 0-round square, singular grammar (1 player /
1 round), the card's LONGEST chip now shows *your* word, and a dead copy branch
removed.

## After the demo
- Revert the `src/config.js` WS-URL change so it points back at Render.
- To ship: these live on `feat/blitz-bot` (backend) and `feat/blitz-bot-ui`
  (frontend). Merge/deploy when you're ready — I never pushed.
