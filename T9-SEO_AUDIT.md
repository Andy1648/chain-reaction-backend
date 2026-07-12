# T9 — SEO Audit of typeaword.com (Phase 0)

Audited 2026-07-12. The public-facing surface lives in the **frontend repo**
(`wordarcade-frontend`, React + Vite SPA, deployed on Vercel). This backend repo
serves WebSocket traffic only and has no SEO surface — the numbers in game
content (timers, lives, rounds) were sourced from this repo's logic files.

## Current state

### What exists (the good news)

| Item | State |
|---|---|
| `robots.txt` | ✅ Exists, `Allow: /`, points at sitemap |
| `sitemap.xml` | ⚠️ Exists but lists **only** `https://typeaword.com/` |
| `<title>` | ⚠️ `TYPE A WORD` — brand only, no keywords |
| Meta description | ✅ Present, decent copy ("Fast, chaotic multiplayer word games…") |
| Canonical | ✅ `https://typeaword.com/` on the one page |
| Open Graph / Twitter cards | ✅ Complete set incl. 1200×630 og-image |
| Analytics | ✅ GA4 + Umami + Vercel Analytics + PostHog |

### The problems (in order of impact)

1. **One URL for the entire site.** The app is a no-router SPA — game modes are
   reachable only through client-side `view` state, never via URL. There is no
   page that can rank for "word bomb game", "category blitz", "games like
   jklm.fun", etc. This is the single biggest gap: you cannot rank for a query
   with no URL targeting it.
2. **Empty JS shell.** `index.html` body is `<div id="root"></div>` — zero
   server-rendered text. Google renders JS (delayed, second-wave), but Bing and
   most other crawlers/scrapers/LLM crawlers effectively see a blank page with
   meta tags.
3. **No structured data.** No JSON-LD anywhere — no `VideoGame`, `WebSite`, or
   `Organization` schema.
4. **No crawlable heading hierarchy.** Even in the rendered SPA, the wordmark is
   a `<div role="img">`, not an `<h1>`. No `<h1>` exists anywhere.
5. **Sitemap is a stub** — one URL, no `lastmod`.
6. **No internal links.** With no `<a href>` anywhere (all navigation is JS
   `onClick`), a crawler has no link graph to walk, even after JS rendering.

## The framework answer (Phase 3 question, answered up front)

No SSR framework is needed. Vite copies `public/` verbatim into `dist/`, and
Vercel serves those files as plain static HTML that takes precedence over the
SPA (there is no `vercel.json` rewrite that would shadow them). So
`public/word-bomb/index.html` → `typeaword.com/word-bomb/` = a fully
prerendered, crawlable page with **zero build/framework changes and zero risk
to the app**. Migrating the whole app to Next/SSR for SEO would be a large
restructure with no additional ranking benefit over static landing pages +
the (JS-rendered) app shell — not worth it.

## Plan

- **Phase 1 — content**: 3 static landing pages in `public/` — `/word-bomb/`,
  `/category-blitz/`, `/imposter-word/` — each with genuine how-to-play, rules,
  scoring, and strategy content sourced from the actual game logic
  (`gameLogic.js`, `categoryBlitzLogic.js`, `imposterWordLogic.js`), styled to
  match the site (flat colors, colored outlines, hard shadows, Bungee/Space
  Mono, dark bg).
- **Phase 2 — technical**: unique title/description/OG/canonical per page,
  `VideoGame` JSON-LD per game + `WebSite` JSON-LD on the root, proper
  h1→h2→h3 hierarchy, sitemap.xml with all 4 URLs, richer root `<title>`,
  real `<a>` cross-links between pages and a small footer link row in the SPA
  homepage so the link graph exists.
- **Phase 3**: satisfied by construction (static HTML is prerendered).
- **Phase 4**: `vite build`, verify pages land in `dist/`, subagent copy review.

## Facts sourced from backend logic (used in page copy)

- **Word Bomb**: 2–3 letter combo per turn, word must *contain* the combo, no
  reuse, 3 lives, 2+ players (solo vs. bot exists). Difficulty: easy 15s start
  / floor 6s, medium 10s/4s, hard 7s/3s; timer shrinks as turns complete.
- **Category Blitz**: simultaneous rounds, no elimination; 3 rounds ×
  20 seconds; hybrid validation = accept-lists + Claude AI fallback for
  creative answers; 1 point per accepted answer; rerolls by difficulty
  (HARD 3 / CRAZY 2 / HELL 1); ties broken by player order.
- **Imposter Word**: social deduction, 3+ players, 5 rounds; everyone gets the
  same category except the imposter (told only "blend in"); answer then vote
  phases (easy 40s/30s, medium 30s/20s, hard 20s/15s); imposter scores by
  surviving the vote, the table scores by catching them.
