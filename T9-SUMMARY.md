# T9 — SEO Mission Summary

All work landed 2026-07-12. Audit: `T9-SEO_AUDIT.md` (this repo). Code changes
are in the **frontend repo** on `feat/blitz-bot-ui` (NOT pushed, per mission):

- `f7a9dd2` `[T9] feat: crawlable SEO landing pages per game mode + structured data`
- `32eef2a` `[T9] fix: landing page copy per review — accuracy + meta length`

## What was added (frontend repo)

### Landing pages — Phase 1 & 3
Three static, fully prerendered pages in `public/` (Vite copies them verbatim
into `dist/`, Vercel serves them ahead of the SPA — crawlers get complete HTML
with zero JS and zero framework changes):

- `/word-bomb/` — how to play, exact rules, difficulty table (15s/10s/7s starts,
  floors, shrink rates), 6 strategy tips, FAQ (incl. an honest JKLM.fun/BombParty
  comparison for that search intent)
- `/category-blitz/` — rules, scoring, HARD/CRAZY/HELL reroll table (incl. the
  host-only 5-second reroll window), 6 strategy tips, FAQ on the AI judging
- `/imposter-word/` — roles, phase timers by difficulty, real scoring
  (+3 survive / +1 catch, ties favor the imposter), crew + imposter strategy, FAQ

All copy was fact-checked against the backend logic files, styled to the site's
aesthetic (flat colors, colored outlines, hard shadows, Bungee/Space Mono) via a
shared `public/landing.css`, and reviewed by a copy-review subagent — its ~15
findings (a phantom "combo streaks" feature, a rules contradiction about answer
visibility in Imposter Word, over-length meta descriptions, one grammar break,
"lynched" → "voted out") were all verified against backend source and fixed.

### Technical SEO — Phase 2
- Unique `<title>` (48–60 chars), meta description (≤160), OG/Twitter tags, and
  canonical URL per page
- `VideoGame` JSON-LD on each landing page; `WebSite` + 3×`VideoGame` graph on
  the root `index.html` (all blocks machine-validated as parseable JSON)
- Root title upgraded: `TYPE A WORD` → `TYPE A WORD — Free Multiplayer Word
  Games Online`
- `sitemap.xml`: 1 URL → 4 URLs with `lastmod`
- Proper h1→h2→h3 hierarchy on every landing page (the SPA had no h1 at all)
- Internal link graph: landing pages cross-link each other + a quiet
  "guides" footer nav with real `<a href>` links added to the SPA homepage
  (`Homepage.jsx`/`Homepage.css`, minimal additive diff)
- Naming standardized: "Category Blitz" everywhere, "AI Category Blitz" kept as
  schema `alternateName`

### Verification — Phase 4
- `vite build` exits 0; all 3 pages + `landing.css` + `sitemap.xml` emitted to `dist/`
- Served `dist/` via `vite preview` and fetched every URL: all 200 with correct h1s
- JSON-LD parse-validated on all 4 pages
- ESLint: the frontend repo has no ESLint config on disk (pre-existing — `npm run
  lint` fails there today, unrelated to this work); the build is the gate per its
  CLAUDE.md

## Off-site checklist — things only you can do

1. **Merge + deploy** — the work sits on `feat/blitz-bot-ui`, unpushed. After
   deploy, spot-check `typeaword.com/word-bomb/` renders (it should serve the
   static page, not the SPA).
2. **Google Search Console** — verify the `typeaword.com` property (DNS TXT or
   the HTML-file method — the file can go in `public/`), then **submit
   `https://typeaword.com/sitemap.xml`**.
3. **Request indexing** of the 4 URLs individually in Search Console (URL
   Inspection → Request indexing) — days-faster than waiting for the crawl.
4. **Bing Webmaster Tools** — import the site from Search Console (one click)
   and submit the sitemap there too; these static pages are exactly what Bing
   needs since it doesn't render JS well.
5. **Rich results check** — run each landing page through
   https://search.google.com/test/rich-results once live to confirm the
   VideoGame schema is picked up.
6. **Backlinks** — the pages give link-worthy targets: submit typeaword.com to
   web-game directories/subreddits (r/WebGames), itch.io / Newgrounds portal
   profiles (the portal build already exists) linking back to the site,
   and any "games like jklm.fun" listicles that accept suggestions.
7. **Watch Search Console queries** in ~2–4 weeks: if "word bomb game" shows
   impressions but a low position, the next lever is content depth on that page
   (it's the featured game — consider a combos-cheat-sheet section).
8. **Optional og-images**: all pages currently share `/og-image.png`. Per-game
   1200×630 images would improve social CTR — needs your art pipeline.
