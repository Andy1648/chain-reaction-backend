# Frontend QA handoff — 2026-07-29 live-QA fixes (uncommitted)

The backend half of the two race bugs is done on branch `fix/qa-2026-07-29`
(see below). Everything in this file is **wordarcade-frontend** work. Ordered to
match the original QA list.

## Backend protocol changes you can now rely on

`submit_answer` / `submit_word` now accept **optional** submit-time context
(backward-compatible — omitting them = old behavior):

| Field | Mode | Meaning |
|-------|------|---------|
| `category` | Category Blitz | the category string the client is currently showing |
| `roundId`  | Category Blitz | the round number the client is showing (`currentRound`) |
| `combo`    | Word Bomb | the fragment the word was typed against (`currentCombo`) |

New rejection **reason codes** in `answer_result` / `word_result` payloads
(`{ accepted:false, reason }`):
- `stale_round` (Category Blitz) — the tagged category/round no longer matches the
  live round. Treat as "resync", NOT as a wrong-answer. Re-render the current round;
  do not flash "doesn't fit".
- `turn_over` (Word Bomb) — the word was for a fragment that has since rotated.
  Treat as a silent no-op / clear input, NOT "MUST CONTAIN …".
- `round_over` (Category Blitz) already existed for the AI-latency boundary; same
  treatment as `stale_round`.

Server round timer is authoritative and already correct: `round_start` carries
`timerSeconds: 20`; `timer_tick` fires once per second with `secondsRemaining`.

---

## P0 #1 — Category Blitz: judge against the shown round (client half)
**Do:** include `category` (the shown category) and `roundId` (the shown round
number) on every `submit_answer`. This makes the server judge against exactly what
the player saw, so a valid answer can't be scored against a drifted category.
Handle `stale_round` / `round_over` by resyncing to the latest `round_start`, not by
showing an off-category error.

## P0 #2 — Category Blitz: per-answer feedback (optimistic UI)
The backend already emits the full lifecycle — wire the UI to it:
1. On submit, immediately add the answer to YOUR ANSWERS in a **pending** state
   (spinner/gray).
2. `answer_checking` `{ answer }` — keep it pending (judge is running).
3. `answer_result` `{ accepted, answer, reason }` — resolve: accepted → green, +1;
   rejected → red with a reason string (map `already_said`, `too_short`,
   `not_in_category`, `stale_round`, `round_over`, …).
4. `player_progress` `{ playerId, answerCount }` — opponents' counts only.

## P1 — Category Blitz: stale error banner
Clear the feedback/error banner on `round_start` **and** `round_end`, and
auto-dismiss any rejection banner after ~2s so it can't bleed into the next round.

## P1 — Category Blitz: timer display
Display **real seconds** from `timer_tick.secondsRemaining` (0–20), or a numberless
progress bar. The current "125 counting down ~5/sec" is a pure client render bug —
the server never sends 125. If you later add wrong-answer time penalties, show the
deduction explicitly (e.g. "-5s").

## P1 — Word Bomb: submission race (client half)
- Include `combo` (the current fragment) on every `submit_word`. The server then
  returns `turn_over` for a word typed against a now-past fragment instead of
  "MUST CONTAIN <new fragment>".
- On `turn_update` / `turn_timeout` / `word_result`, **clear the input field** and
  suppress any in-flight submit so a stale word never posts against the new fragment.
- Render `turn_over` as a silent clear, not an error toast.

## P2 — Quick Play difficulty default
Quick Play vs Bot currently launches CRAZY. Default to CHILL (20s/3 lives) — or the
player's **last-used difficulty from localStorage**. Persist the choice on each game
start.

## P2 — Results screen: 1v1 highlight badges
When a single player sweeps all three highlights (Wordsmith / Speed Demon /
Survivor) — the normal case in a 1v1 bot game — collapse to one combined badge (or
show only the most interesting stat). Keep all three for 3+ player games.

## P2 — Category Blitz solo onboarding
Add a direct "Play solo" action on the game card that skips room creation + invite-
code UI entirely. Collapse pack selection behind an optional "Customize packs"
toggle (default = all packs, which is already the server default when `set_packs`
is never sent).

---

## Optional backend follow-up (NOT done — needs your call)

A server-side **grace window** (accept a submission for ~300–500 ms after the timer
hits 0 and credit it to that round/turn) was part of the approved plan, but the
Word Bomb version delays `handleTimeout` and therefore requires reworking the
hard-won TOCTOU turn-race regression tests (`turnRace*.test.js`, which tick exactly
`currentTimerSeconds*1000` and expect an immediate timeout). Since regression
checklist item 3 is already satisfied by the `turn_over` protocol fix **plus** the
client input-clear above, I left the grace window out to avoid destabilizing the
core turn timer. Say the word and I'll add it with the test updates.
