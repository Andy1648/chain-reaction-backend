// categoryBlitzLogic.js
// Pure game-state logic for Category Blitz - a SIMULTANEOUS, round-based
// party mode. There are no turns, no lives, and no elimination: every player
// races to type as many valid answers to the same category as they can
// during a timed round. After a fixed number of rounds, the highest
// cumulative score wins.
//
// This module is completely standalone - it deliberately does NOT import
// turn/timer/lives helpers from gameLogic.js, because none of that applies
// here. The room manager owns the wall-clock round timer; this file is just
// the pure rules operating on a plain game object.

// Answers are validated in TWO stages (hybrid validation):
//   1. Pre-generated accept-lists (a Set of valid lowercase answers per
//      category) - a fast, free, deterministic, offline Set lookup that
//      resolves the common answers instantly with no API call.
//   2. AI fallback (haikuValidator.js, Claude Haiku) - only consulted when an
//      answer ISN'T on the list, so creative/uncommon-but-valid answers still
//      get judged. It FAILS OPEN: the only reject is a genuine model "no"; every
//      infra failure (dead key, spent quota, timeout, rate cap) ACCEPTS, so a
//      broken judge never wrongly rejects valid answers. When no ANTHROPIC_API_KEY
//      is set the fallback is disabled and list-misses are accepted (list-only).
// The former Groq/Gemini fallback (aiValidator.js + gemini.js) was removed in
// chore/backend-cleanup - haikuValidator.js owns the AI fallback now.
const CATEGORY_ANSWERS = require('./categoryAnswers');
const haikuValidator = require('./haikuValidator');

const TOTAL_ROUNDS = 3;
const MIN_PLAYERS_TO_START = 2;

// Every round is a flat 30 seconds, for every difficulty and for both solo and
// multiplayer. Difficulty no longer changes the clock - it only sets how many
// category rerolls a game gets (below). (Was 20s — the leeway pass gives players
// more time to think of answers.)
const ROUND_TIME_SECONDS = 30;

const VALID_DIFFICULTIES = ['easy', 'medium', 'hard'];

// Hard cap on submitted answer length (input hardening). Valid answers are
// <=3 short words by THE CATEGORY RULE below, so 60 chars is generous.
const MAX_ANSWER_LENGTH = 60;

// Category rerolls allowed PER GAME, by difficulty tier. The tiers are shown to
// players as HARD / CRAZY / HELL (see the frontend): easy -> HARD (5 rerolls),
// medium -> CRAZY (4), hard -> HELL (3). Fewer rerolls = harder. (Was 3/2/1 — the
// leeway pass gives more rerolls so a bad category is easier to escape.)
const REROLLS_BY_DIFFICULTY = { easy: 5, medium: 4, hard: 3 };

// ---- Daily Challenge -------------------------------------------------------
// A once-per-day solo Blitz where EVERYONE on the planet gets the same three
// categories: the picks are a pure function of the UTC date, so any two
// server instances (or a restart mid-day) agree. Day boundaries are UTC —
// integer day math, immune to DST/timezone weirdness. Day #1 = 2026-01-01 UTC.
const DAILY_EPOCH_UTC = Date.UTC(2026, 0, 1);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** { dayNumber, dateKey } for a wall-clock ms timestamp (defaults to now). */
function dailyInfo(nowMs = Date.now()) {
  const dayNumber = Math.floor((nowMs - DAILY_EPOCH_UTC) / MS_PER_DAY) + 1;
  const dateKey = new Date(nowMs).toISOString().slice(0, 10); // 'YYYY-MM-DD' (UTC)
  return { dayNumber, dateKey };
}

// Tiny deterministic PRNG (xmur3 string hash seeding mulberry32) so the day's
// category picks depend only on the dateKey — no Math.random anywhere here.
function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The day's TOTAL_ROUNDS categories as an ESCALATING RAMP: round 1 = a broad
 * (tier 1) category, round 2 = medium (tier 2), round 3 = niche (tier 3) — so
 * every player scores in round 1 and niche knowledge is an edge, not a wall.
 *
 * Fully deterministic: seeded only by dateKey (a fixed mulberry32 PRNG, no
 * Math.random), drawn over ALPHABETICALLY SORTED tier pools, so every player
 * worldwide gets the same three categories in the same order and the result
 * never depends on declaration/deploy order. Pack selections don't apply to the
 * daily (everyone plays the same board). Backfills from the full sorted pool in
 * the impossible case a tier is empty.
 */
function dailyCategories(dateKey) {
  const rng = mulberry32(hashString(`typeaword-daily:${dateKey}`));
  const picks = [];
  const drawFrom = (arr) => {
    const pool = arr.filter((c) => !picks.includes(c));
    if (pool.length === 0) return;
    picks.push(pool[Math.floor(rng() * pool.length)]);
  };
  for (const tier of [1, 2, 3]) drawFrom(TIER_POOLS[tier]);
  // Safety net: if any tier was empty, top up from the full sorted pool.
  const full = [...CATEGORIES].sort();
  while (picks.length < TOTAL_ROUNDS) {
    const before = picks.length;
    drawFrom(full);
    if (picks.length === before) break; // nothing left to draw
  }
  return picks;
}

// Categories with PERSONALITY - every one should make a player smirk, argue, or
// say "oh this is a good one". No boring trivia ("things that are green"). The
// prompt itself is the fun. Keys here MUST match categoryAnswers.js exactly.
//
// ============================  THE CATEGORY RULE  ============================
// A valid Category Blitz category MUST have a BOUNDED, finite-ish answer space
// where almost every valid answer is <=3 words (rare outliers ok). The answer is
// a NAMED THING (object, brand, character, food, place) — not a quote, excuse,
// reason, headline, or an open-ended action.
//   GOOD: "European capitals", "Marvel superheroes", "Pizza toppings", "NBA teams",
//         "Dog breeds", "SpongeBob characters" — bounded set, short noun answers.
//   BAD (never add): sentence/phrase answers ("Things teachers always say",
//        "Excuses for not texting back", "Florida man headlines"), open-ended /
//        effectively-infinite prompts ("Things you google at 3am", "What the dog
//        ate"), or anything where valid answers are routinely 4+ words.
// New categories (added by hand or generated by an AI step — see the generation
// prompt note below) MUST follow this rule. It is also enforced programmatically
// by the accept-list word-count filter just below the list, which DROPS any
// category whose answers routinely exceed the length cap — so a bad one can't
// silently slip back in.
// ============================================================================
const RAW_CATEGORIES = [
  // Oddly specific (junk-drawer objects, short nouns)
  'Things in your junk drawer', 'Gas station purchases at 2am',
  'Things on a CVS receipt', 'Things your mom has in her purse',
  'Things in a college dorm room', 'Smells in a middle school',
  "Things in a teacher's desk", 'Things you find between couch cushions',
  'Things in a hotel minibar', 'Things taped to a fridge',
  // Food but make it specific (food names, short)
  "McDonald's menu items", 'Things you dip in ranch',
  'Foods that are better cold the next day', "Gas station food you'd actually eat",
  'Things you put on toast', 'School cafeteria foods',
  "Foods that shouldn't exist but do", 'Things at a buffet nobody touches',
  'Midnight snack choices', "Foods you eat with your hands but probably shouldn't",
  // Pop culture (named, bounded sets)
  'SpongeBob characters', 'Minecraft mobs', 'Pokemon from Gen 1',
  'Fortnite skins', 'Mario power-ups and items',
  'Disney villains', 'Pixar movies', 'Things in Hogwarts', 'Roblox games',
  // Debatable / funny — kept ONLY where answers are short named things
  "Things you shouldn't microwave", "Things that shouldn't be a sport but are",
  // Brands & specific knowledge (named, bounded)
  'Shoe brands', 'Car brands', 'Fast food chains', 'Apps on your phone right now',
  'Things in an Amazon package', 'Things in a Costco', 'YouTube video categories',
  'Things with a drive-through', 'Subscription services',
  'Things that come in a vending machine',
  // Curated expansion batch (accept-lists in categoryAnswers/gen1-gen5.js).
  "Things in a divorced dad's apartment", 'Ways to die in Minecraft',
  'Things confiscated by a teacher', "Things in a 2010 kid's bedroom",
  'Things at a middle school dance', "Things in an emo kid's room (2008)",
  // Clean rapid-fire batch (accept-lists in categoryAnswers/gen6.js).
  'Pizza toppings', 'Dog breeds', 'Candy bars', 'Ice cream flavors',
  'Cereal brands', 'Soda brands', 'Superheroes', 'Halloween costumes',
  'Sports', 'Musical instruments', 'Starbucks drinks', 'NBA teams',
  'Disney movies', 'Anime shows', 'Chip & snack brands', 'Video games',
  'Zoo animals', 'Breakfast foods', 'Board games', 'Types of pasta',
  // gen7 batch (night/categories-generate): 103 machine-filtered bounded
  // categories — answers <=3 words, named things. Accept-lists in
  // categoryAnswers/gen7.js; generated + filtered by gen7-generate.js.
  "European capitals",
  "African countries",
  "Asian countries",
  "US states",
  "Famous landmarks",
  "Jungle animals",
  "Ocean animals",
  "Birds",
  "Insects",
  "Cat breeds",
  "Dinosaurs",
  "Farm animals",
  "Trees",
  "Flowers",
  "Fruits",
  "Vegetables",
  "Types of cheese",
  "Cocktails",
  "Coffee drinks",
  "Sushi types",
  "Italian dishes",
  "Cooking methods",
  "Disney princesses",
  "Simpsons characters",
  "Horror movies",
  "Pixar characters",
  "Action movie stars",
  "Famous wizards",
  "Mario characters",
  "Street Fighter characters",
  "Pokemon types",
  "Naruto characters",
  "Dragon Ball characters",
  "One Piece characters",
  "Among Us colors",
  "Chess pieces",
  "Card games",
  "Music genres",
  "String instruments",
  "Beatles songs",
  "Famous DJs",
  "Rappers",
  "Olympic sports",
  "NFL teams",
  "Soccer clubs",
  "Tennis terms",
  "Martial arts",
  "Things on a golf course",
  "Baseball positions",
  "Water sports",
  "Body parts",
  "Weather phenomena",
  "Gemstones",
  "Shapes",
  "Greek gods",
  "Norse gods",
  "Egyptian gods",
  "Mythical creatures",
  "US presidents",
  "Famous painters",
  "Kitchen utensils",
  "Tools in a toolbox",
  "Office supplies",
  "Musical genres of dance",
  "Things with wheels",
  "Camping gear",
  "Phone brands",
  "Clothing brands",
  "Airlines",
  "Social media apps",
  "Colors",
  "Languages",
  "Zodiac signs",
  "Months of the year",
  // gen8 batch (cb-category-refine): 12 hand-curated bounded categories added to
  // replace the weak/redundant/open-ended ones cut below. Accept-lists in
  // categoryAnswers/gen8.js.
  "Pokémon starters",
  "Video game consoles",
  "Minecraft blocks",
  "Video game villains",
  "Battle royale games",
  "Taylor Swift albums",
  "Stranger Things characters",
  "Continents",
  "Wonders of the World",
  "Donut types",
];

// gen9 pack rework: append every pack-mapped category NOT already in the pool
// above (dedupe, exact case-sensitive match), so no name is added twice. The
// pack id for each lives in categoryPacks.js; their accept-lists are
// union-merged in categoryAnswers.js. The bounded/quarantine filters below
// still apply to these just like every other category.
//
// 2026-07 pool review: ~73 too-obscure pack categories were cut (removed from
// categoryPacks.js), ~44 near-duplicates were merged into one keeper each
// (losers removed here + from categoryPacks.js; their accept-lists are folded
// into the keeper's by the FOLDS step in categoryAnswers.js), 5 categories were
// renamed, and every surviving legacy category got a pack tag - so ALL live
// categories are now pack-mapped and appear in pack-filtered pools.
const CATEGORY_PACKS = require('./categoryPacks');
for (const name of Object.keys(CATEGORY_PACKS)) {
  if (!RAW_CATEGORIES.includes(name)) RAW_CATEGORIES.push(name);
}

// The distinct pack ids — the contract shared with the frontend (set_packs). Derived
// from CATEGORY_PACKS so it can never drift from the actual pack assignments.
const PACK_IDS = [...new Set(Object.values(CATEGORY_PACKS))];

// ---- Post-generation guardrail (enforces THE CATEGORY RULE) ----
// Drop any category whose pre-generated accept-list shows it's NOT bounded/short:
// if more than MAX_LONG_ANSWER_RATIO of its answers exceed MAX_ANSWER_WORDS words,
// the category's answer space is phrase/sentence-shaped and it's removed from play.
// (Categories with no accept-list are trusted — the AI judge covers them.) This is
// a SELECTION/curation filter only; it never touches how a player's answer is
// judged during a round.
const MAX_ANSWER_WORDS = 3;
const MAX_LONG_ANSWER_RATIO = 0.3; // >30% long = routinely long = not bounded
function isBoundedCategory(category) {
  const set = CATEGORY_ANSWERS[category];
  if (!set || set.size === 0) return true; // no list to measure; trust it
  let longCount = 0;
  for (const answer of set) {
    if (String(answer).trim().split(/\s+/).length > MAX_ANSWER_WORDS) longCount += 1;
  }
  return longCount / set.size <= MAX_LONG_ANSWER_RATIO;
}
// QUARANTINED — un-enumerable, re-enable after judge fix.
// These categories have an OPEN-ENDED / subjective answer space (no finite set of
// NAMED things), so almost every reasonable answer misses the Stage-1 accept-list
// and falls through to the Haiku judge — which currently FAILS CLOSED (rejects on
// timeout / rate-limit / error), killing valid answers. They are pulled from the
// active pool (filtered out below) but NOT deleted: the category names stay right
// here and their accept-lists stay on disk in categoryAnswers/*, so re-enabling one
// is just deleting its line from this set.
//
// NOTE: the quarantine is applied HERE, at the play pool, NOT by dropping the
// expansion/expansion2 accept-list imports in categoryAnswers.js. Those files are
// union-merged SUPPLEMENTS to the KEPT categories' lists (and a set of orphan names
// that were never in the pool); removing them would only shrink good categories'
// accept-lists — causing MORE judge hits — and would pull nothing from rotation,
// because the pool is RAW_CATEGORIES, not the accept-list keys.
const QUARANTINED_CATEGORIES = new Set([
  // "Things in / at / on <place or container>" — the place holds arbitrary objects,
  // so the answer space is effectively infinite (not a finite set of named things).
  'Things in your junk drawer',
  'Gas station purchases at 2am',
  'Things on a CVS receipt',
  'Things your mom has in her purse',
  'Things in a college dorm room',
  'Smells in a middle school',
  "Things in a teacher's desk",
  'Things you find between couch cushions',
  'Things in a hotel minibar',
  'Things taped to a fridge',
  'Things in an Amazon package',
  'Things in a Costco',
  "Things in a divorced dad's apartment",
  'Things confiscated by a teacher',
  "Things in a 2010 kid's bedroom",
  'Things at a middle school dance',
  "Things in an emo kid's room (2008)",
  // Subjective / opinion-shaped food + "things" prompts — answers are judgments,
  // not a bounded list of named items.
  'Things you dip in ranch',
  'Foods that are better cold the next day',
  "Gas station food you'd actually eat",
  'Things you put on toast',
  "Foods that shouldn't exist but do",
  'Things at a buffet nobody touches',
  'Midnight snack choices',
  "Foods you eat with your hands but probably shouldn't",
  "Things you shouldn't microwave",
  "Things that shouldn't be a sport but are",
  // QUARANTINED — too broad/personal, floods judge
  'Apps on your phone right now',
  'Things in Hogwarts',
  'YouTube video categories',
  // CUT — weak/redundant/open-ended. Pulled from the active pool via the same
  // reversible quarantine mechanism; accept-list data is kept on disk.
  'Action movie stars',
  'Rappers',
  'Famous DJs',
  'Music genres',
  'Musical genres of dance',
  'Famous wizards',
  'Famous landmarks',
  'Famous painters',
  'Things with wheels',
  'Social media apps',

  // ---- AUTO-QUARANTINED: bottom 25% by accept-list size (leeway pass) ----
  // The 147 smallest playable categories by pre-generated accept-list size (0..16
  // entries). A tiny accept-list means almost every reasonable answer misses Stage 1
  // and falls to the AI judge — the exact path that fails closed when the key/billing
  // is down — so these read as "the judge rejects everything" and/or run dry fast in a
  // 30s race. Pulled from rotation (reversible: their accept-lists stay on disk; delete
  // a line here to re-enable). Several 0-size entries are KEY-CASE MISMATCHES with
  // categoryAnswers/* (e.g. "Pixar Movies" vs "Pixar movies"), which also read as empty.
  "Active volcanoes", // 0
  "Ancient wonders", // 0
  "Breakfast cereal brands", // 0
  "Citrus fruits", // 0
  "Classic dystopian novels", // 0
  "Disney Villains", // 0
  "Edible berries", // 0
  "Major League Soccer teams", // 0
  "Minecraft Mobs", // 0
  "Mortal Kombat fighters", // 0
  "Mushrooms and fungi", // 0
  "Oceans", // 0
  "Pixar Movies", // 0
  "Pokemon Gen 1", // 0
  "Popular spices and herbs", // 0
  "Rock and Roll Hall of Fame Inductees", // 0
  "Rolling Stone's 500 Greatest Albums", // 0
  "Seven Wonders of the Ancient World", // 0
  "SI units", // 0
  "SpongeBob SquarePants Characters", // 0
  "Super Mario power-ups", // 0
  "The Great Lakes", // 0
  "Types of mushrooms", // 0
  "Types of nuts", // 0
  "Types of rocks", // 0
  "US state abbreviations", // 0
  "US states by name", // 0
  "Video game hardware manufacturers", // 0
  "Zodiac constellations", // 0
  "Scandinavian countries", // 3
  "Dwarf planets", // 5
  "Pac-Man ghosts", // 5
  "Scandinavian and Nordic countries", // 5
  "Types of simple machines", // 6
  "Among Us maps", // 7
  "Central American countries", // 7
  "Harry Potter books", // 7
  "Layers of the atmosphere", // 7
  "Beatles songs", // 8
  "Continents", // 8
  "Grand Slam tennis tournaments", // 8
  "Soccer clubs", // 8
  "Swimming strokes", // 8
  "Taxonomic kingdoms", // 8
  "Tour de France Jerseys", // 8
  "Types of sports rackets", // 8
  "Volleyball positions", // 8
  "Airlines", // 9
  "Camping gear", // 9
  "Clothing brands", // 9
  "Cooking methods", // 9
  "Dragon Ball characters", // 9
  "Italian dishes", // 9
  "Jane Austen novels", // 9
  "Languages", // 9
  "Major League Baseball awards", // 9
  "Months of the year", // 9
  "Naruto characters", // 9
  "Office supplies", // 9
  "One Piece characters", // 9
  "Planets in our solar system", // 9
  "Team Fortress 2 classes", // 9
  "Tools in a toolbox", // 9
  "Baseball positions", // 10
  "Body parts", // 10
  "Card games", // 10
  "Colors", // 10
  "Disney princesses", // 10
  "Events in a decathlon", // 10
  "Great Lakes of North America", // 10
  "Greek playwrights", // 10
  "Horror movies", // 10
  "Inca deities", // 10
  "Jungle animals", // 10
  "Kitchen utensils", // 10
  "Pac-Man maze fruits", // 10
  "Pixar characters", // 10
  "Pokemon types", // 10
  "Professional tennis surface types", // 10
  "Professional wrestling promotions", // 10
  "Shapes", // 10
  "Simpsons characters", // 10
  "Tennis terms", // 10
  "Things on a golf course", // 10
  "US states bordering the Pacific Ocean", // 10
  "Beatles albums", // 11
  "C.S. Lewis books", // 11
  "Caribbean countries", // 11
  "Mortal Kombat games", // 11
  "Norse mythological realms", // 11
  "Roald Dahl books", // 11
  "Types of chemical bonds", // 11
  "World oceans", // 11
  "Agatha Christie detectives", // 12
  "Art elements", // 12
  "Chess pieces", // 12
  "Gothic novels", // 12
  "South American countries", // 12
  "The Sims games", // 12
  "Types of electromagnetic radiation", // 12
  "Zodiac signs", // 12
  "Canadian provinces and territories", // 13
  "Charles Dickens novels", // 13
  "Cycling disciplines", // 13
  "Major world peninsulas", // 13
  "Music streaming services", // 13
  "Music tempo markings", // 13
  "Pottery types", // 13
  "Programming paradigms", // 13
  "South American capitals", // 13
  "States of matter", // 13
  "Street Fighter games", // 13
  "Types of BBQ sauce", // 13
  "US states bordering the Atlantic Ocean", // 13
  "Ancient Persian Kings", // 14
  "Bears", // 14
  "Big cats", // 14
  "Greek epics", // 14
  "Human endocrine glands", // 14
  "Noble gases", // 14
  "Oceanian countries", // 14
  "Soccer positions", // 14
  "Table tennis equipment", // 14
  "Types of dried meat", // 14
  "Winter Olympic sports", // 14
  "Electronic music genres", // 15
  "Famous music festivals", // 15
  "Greek tragedies", // 15
  "James Bond Movies", // 15
  "Milk alternatives", // 15
  "Mongol Khans", // 15
  "Music production software", // 15
  "Pink Floyd albums", // 15
  "Printmaking techniques", // 15
  "Taxonomic ranks", // 15
  "Taylor Swift albums", // 15
  "Tennis strokes", // 15
  "TV animation networks", // 15
  "Types of fossils", // 15
  "Ancient Mesopotamian Civilizations", // 16
  "Ancient Mesopotamian Rulers", // 16
  "Australian states and territories", // 16
  "Battle royale games", // 16
  "Electric guitar models", // 16
  "Gymnastics events", // 16
  "Half-human half-animal creatures", // 16
  "Major professional sports leagues", // 16
]);

const CATEGORIES = RAW_CATEGORIES.filter((category) => {
  // Pulled from rotation until the judge fail-closed path is fixed (see above).
  if (QUARANTINED_CATEGORIES.has(category)) return false;
  if (isBoundedCategory(category)) return true;
  console.warn(
    `[categoryBlitz] dropped category (answers routinely > ${MAX_ANSWER_WORDS} words, not bounded): "${category}"`
  );
  return false;
});

/* ============================ CATEGORY TIERS ============================ */
// Every category is tiered by BREADTH so the Daily can escalate (round 1 broad ->
// round 2 medium -> round 3 niche) and regular rooms can weight toward broad.
//   Tier 1 BROAD  - nearly anyone names 5+ (Fruits, Animals, Tools in a toolbox)
//   Tier 2 MEDIUM - most name 2-3 (Apple products, Sushi types, European capitals)
//   Tier 3 NICHE  - enthusiasts only (Half-Life enemies, MLS teams, Roman emperors)
// Answer-list SIZE is a weak proxy (a tiny list like "States of matter" is broad; a
// small list like "Pac-Man ghosts" is niche), so tiers are assigned by TOPIC: an
// explicit broad set, a mainstream-franchise medium override, then niche
// franchise/specialist patterns + explicit niche, defaulting to medium.
const TIER_BROAD = new Set([
  // food
  'Fruits', 'Vegetables', 'Pizza toppings', 'Ice cream flavors', 'Candy bars', 'Cereal brands',
  'Soda brands', 'Fast food chains', 'Breakfast foods', 'Types of bread', 'Types of cheese',
  'Types of pasta', 'Coffee drinks', 'Types of tea', 'Types of cake', 'Types of pie', 'Types of cookies',
  'Cooking methods', 'Kitchen utensils', 'Sandwich types', 'Types of soup', 'Types of berries',
  "McDonald's menu items", 'Starbucks drinks', 'Cocktails', 'International cuisines', 'Types of seafood',
  'Types of eggs', 'Popular condiments', 'Chip & snack brands', 'Frozen treats',
  'School cafeteria foods', 'Things that come in a vending machine', 'Things with a drive-through',
  // animals / nature
  'Farm animals', 'Zoo animals', 'Jungle animals', 'Ocean animals', 'Big cats', 'Bears', 'Cat breeds',
  'Dog breeds', 'Birds', 'Insects', 'Flowers', 'Trees', 'Dinosaurs', 'Fish', 'Reptiles and amphibians',
  'Primates', 'Marine mammals', 'Rodents', 'Houseplants', 'Herbs and spices', 'Root vegetables',
  'Nuts and seeds', 'Weather phenomena', 'Types of Natural Disasters', 'Gemstones', 'Horses and ponies',
  'Wild animals of the desert', 'Wild animals of the savanna',
  // world / geography basics
  'Continents', 'Months of the year', 'Planets in our solar system', 'Zodiac signs', 'World oceans',
  'US states', 'Wonders of the World',
  // science basics
  'Body parts', 'Shapes', 'States of matter', 'Human organs', 'Units of measurement', 'Human body systems',
  // sports basics
  'Sports', 'Types of sports balls', 'Olympic sports', 'Martial arts', 'Chess pieces', 'Water sports',
  'Winter Olympic sports',
  // tech / brands everyone uses
  'Tools in a toolbox', 'Office supplies', 'Phone brands', 'Apple products', 'Social media platforms',
  'Web browsers', 'Car brands', 'Video streaming services', 'Subscription services', 'Shoe brands',
  // movies / everyday pop culture
  'Disney movies', 'Disney princesses', 'Superheroes', 'Halloween costumes', 'Horror movies',
  'Pixar movies', 'Animated Movies',
  // music basics
  'Musical instruments', 'String instruments', 'Percussion instruments', 'Musical notes',
  // art basics
  'Colors', 'Drawing tools', 'Painting tools',
  // tv basics
  'TV networks', 'Reality TV shows', 'Game shows', 'Talk shows', 'Cooking shows',
]);
// Mainstream franchises where naming a few is EASY (not enthusiasts-only): they
// match a niche franchise pattern below but belong in MEDIUM, not NICHE.
const TIER_MEDIUM_OVERRIDE = new Set([
  'Marvel Superheroes', 'Star Wars Characters', 'Star Wars Ships', 'Star Wars Planets',
  'Mario characters', 'Friends Characters', 'The Office characters', 'Breaking Bad characters',
  'Lord of the Rings characters', 'Batman Characters', 'Batman villains', 'Stranger Things characters',
  'James Bond Movies', 'Harry Potter Characters', 'Harry Potter Spells', 'Pokemon from Gen 1',
  'Marvel Cinematic Universe Villains', 'Anime Villains', 'Greek gods', 'Studio Ghibli Movies',
]);
// Explicit niche (specialist/deep-cut) not always caught by the franchise patterns.
const TIER_NICHE = new Set([
  'Video game villains', 'Video Game Genres', 'Nintendo consoles and handhelds', 'Video game hardware',
  'Video game consoles', 'TV animation networks', 'TV award shows', 'Music awards', 'Major record labels',
  'Iconic albums', 'Classical composers', 'Boy bands', 'Classic rock artists', 'Guitar brands',
  'Famous paintings', 'Famous museums', 'Art movements', 'Roman gods', 'Egyptian gods', 'Norse gods',
  'Greek heroes', 'Greek monsters and beasts', 'Greek Titans', 'Trojan War figures',
  'Japanese yokai', 'US First Ladies', 'US Founding Fathers', 'Roman emperors', 'Egyptian pharaohs',
  'Renaissance figures', 'World War II battles', 'Medieval titles', 'Ancient Empires', 'Famous explorers',
  'British monarchs', 'US presidents', 'Subatomic particles', 'Types of electromagnetic radiation',
  'Programming languages', 'Computer ports and connectors', 'Cryptocurrencies',
  'File sharing and cloud storage services', 'Formula 1 constructors', 'Active Formula 1 tracks',
  'MLS teams', 'NFL teams', 'NBA teams', 'NHL teams', 'WNBA teams', 'English Premier League clubs',
  'Major League Baseball teams', 'Major League Baseball awards', 'Active NBA Arenas', 'Active NFL stadiums',
  'Grand Slam tennis tournaments', 'Soccer clubs', 'Professional tennis tournaments',
  'Scandinavian and Nordic countries', 'Central American countries', 'Caribbean countries',
  'Oceanian countries', 'Famous volcanoes', 'US states bordering the Pacific Ocean',
  'Great Lakes of North America', 'Harry Potter books', 'Roald Dahl books', 'Dystopian novels',
  'Literary devices', 'Shakespeare plays', 'Taylor Swift albums', 'Beatles songs',
  'Naruto characters', 'Dragon Ball characters', 'One Piece characters',
  'Elden Ring bosses', 'Half-Life enemies', 'Half-Life weapons', 'Team Fortress 2 classes', 'Pac-Man ghosts',
  'Genshin Impact playable characters', 'League of Legends Champions',
]);
// Niche franchise/specialist keyword patterns (case-insensitive).
const TIER_NICHE_PATTERNS = [
  /pac-?man|among us|team fortress|mortal kombat|the sims|street fighter|battle royale|minecraft|elden ring|fallout|grand theft auto|resident evil|skyrim|metroid|valorant|call of duty|pok[eé]mon|half-?life|fall guys|final fantasy|\bportal\b|apex legends|donkey kong|dark souls|fortnite|sonic|stardew|angry birds|zelda|\bmario\b|\bhalo\b|overwatch|kingdom hearts|tekken|genshin|league of legends|smash bros|animal crossing|roblox|kombat|playstation|nintendo switch|fighting game/i,
  /naruto|dragon ball|one piece|stranger things|breaking bad|the office|\bfriends\b|lord of the rings|studio ghibli|james bond|star wars|\bmarvel\b|\bbatman\b|percy jackson|hbo series|anime villain/i,
  /beatles|taylor swift|roald dahl|shakespeare|dystopian|record label|electronic music/i,
  /\bmls\b|\bnfl\b|\bnba\b|\bnhl\b|\bwnba\b|major league baseball|\bmlb\b|premier league|formula 1|\bf1\b|soccer club|grand slam|arenas|stadiums|constructors|\btracks\b|professional tennis tournament/i,
  /roman emperor|egyptian pharaoh|renaissance|founding father|first ladies|world war|medieval title|ancient empire|greek titan|norse god|hindu deit|egyptian god|greek god|greek hero|greek monster|trojan|yokai|arthurian|knights of the round|subatomic|electromagnetic|programming language|computer ports|cryptocurrenc|scandinavian|central american|caribbean countr|oceanian|famous volcano|prehistoric|constellations|titans/i,
];
/** Breadth tier (1 broad / 2 medium / 3 niche) for a category name. */
function tierForCategory(name) {
  if (TIER_BROAD.has(name)) return 1;
  if (TIER_MEDIUM_OVERRIDE.has(name)) return 2;
  if (TIER_NICHE.has(name)) return 3;
  if (TIER_NICHE_PATTERNS.some((re) => re.test(name))) return 3;
  return 2;
}
// The stored tier for every ACTIVE category (name -> 1|2|3), computed once.
const CATEGORY_TIER = {};
for (const c of CATEGORIES) CATEGORY_TIER[c] = tierForCategory(c);
// Tier -> sorted category pool (sorted so the seeded daily picks are stable across
// deploys regardless of declaration order).
const TIER_POOLS = { 1: [], 2: [], 3: [] };
for (const c of CATEGORIES) TIER_POOLS[CATEGORY_TIER[c]].push(c);
for (const t of [1, 2, 3]) TIER_POOLS[t].sort();
// Regular-room draw weights across tiers (the Daily uses the escalating ramp, not
// these). ~half broad, a third medium, a sixth niche.
const TIER_WEIGHTS = { 1: 0.5, 2: 0.35, 3: 0.15 };

/**
 * The category pool restricted to the selected packs. A category belongs to a
 * pack via CATEGORY_PACKS (name -> pack id); categories with no pack assignment
 * are never in a pack-filtered pool. If nothing is selected (null / empty) the
 * full pool is used. GUARD: a too-small selection (e.g. geography's 2 categories)
 * falls back to the full pool so TOTAL_ROUNDS non-repeating rounds always fill.
 */
function categoriesForPacks(selectedPacks) {
  if (!Array.isArray(selectedPacks) || selectedPacks.length === 0) return CATEGORIES;
  const set = new Set(selectedPacks);
  const pool = CATEGORIES.filter((c) => set.has(CATEGORY_PACKS[c]));
  return pool.length >= TOTAL_ROUNDS ? pool : CATEGORIES;
}

/**
 * Weighted pick over a pool by breadth tier: chooses a tier by TIER_WEIGHTS
 * (~50/35/15 broad/medium/niche), then a uniform category within it. Weight from
 * any tier absent in `pool` (e.g. a pack selection with no broad categories)
 * redistributes across the tiers that ARE present, so the pack filter always
 * wins. `rng` is injectable for deterministic tests. Returns null on an empty pool.
 */
function pickWeightedByTier(pool, rng = Math.random) {
  if (!pool || pool.length === 0) return null;
  const byTier = { 1: [], 2: [], 3: [] };
  for (const c of pool) byTier[CATEGORY_TIER[c] || 2].push(c);
  const avail = [1, 2, 3].filter((t) => byTier[t].length > 0);
  const totalW = avail.reduce((s, t) => s + TIER_WEIGHTS[t], 0);
  let r = rng() * totalW;
  let tier = avail[avail.length - 1];
  for (const t of avail) {
    if (r < TIER_WEIGHTS[t]) { tier = t; break; }
    r -= TIER_WEIGHTS[t];
  }
  const bucket = byTier[tier];
  return bucket[Math.floor(rng() * bucket.length)];
}

/**
 * Picks a category from the (optionally pack-filtered) pool, WEIGHTED toward
 * broader tiers (see pickWeightedByTier) instead of uniform. If `excludeSet` (a
 * Set of already-played categories) is given, the result is guaranteed not to be
 * one of them, so categories never repeat across rounds. `selectedPacks`
 * (optional) restricts the pool to those packs. Falls back to the (filtered) base
 * list in the impossible case that every option is excluded.
 */
function pickRandomCategory(excludeSet, selectedPacks) {
  const base = categoriesForPacks(selectedPacks);
  const pool = excludeSet ? base.filter((c) => !excludeSet.has(c)) : base;
  const choices = pool.length ? pool : base;
  return pickWeightedByTier(choices) || choices[Math.floor(Math.random() * choices.length)];
}

/**
 * Highest cumulative score wins. On a tie, the first player reaching that
 * score (by player order) is the winner. Returns null only if there are no
 * players at all.
 */
function determineWinner(game) {
  let winnerId = null;
  let best = -1;
  game.players.forEach((p) => {
    if (p.score > best) {
      best = p.score;
      winnerId = p.id;
    }
  });
  return winnerId;
}

/**
 * Creates a fresh Category Blitz game. Each player tracks their OWN answers
 * (for the current round) and a cumulative score across all rounds.
 *
 * Always TOTAL_ROUNDS (3) rounds, a different category each round, for BOTH
 * solo and multiplayer. `solo` is kept only so the room manager can flag the
 * single-player variant (it bypasses the minimum-player gate); it no longer
 * changes the round count. Every round is ROUND_TIME_SECONDS (20s); difficulty
 * only sets the per-game reroll allowance.
 */
function createGame(players, difficultyKey, solo = false, selectedPacks = null, daily = null) {
  const difficulty = VALID_DIFFICULTIES.includes(difficultyKey) ? difficultyKey : 'medium';
  // Daily Challenge: the whole game's categories are predetermined by the UTC
  // date (same board for everyone), packs are ignored, and rerolls are off —
  // a reroll would fork the board away from everyone else's.
  const dailyPlan = daily ? dailyCategories(daily.dateKey) : null;
  const firstCategory = dailyPlan ? dailyPlan[0] : pickRandomCategory(null, selectedPacks);

  return {
    status: 'in_progress', // 'in_progress' | 'between_rounds' | 'finished'
    difficultyKey: difficulty,
    solo: !!solo,
    // Host-selected category packs (null = all packs). Filters every category pick
    // for this game (first pick, round advance, reroll). Optional / backwards-compat.
    selectedPacks: dailyPlan ? null : selectedPacks || null,
    // Daily Challenge bookkeeping: { dayNumber, dateKey } + the fixed category
    // plan for all rounds. Both null for a normal game.
    daily: daily ? { dayNumber: daily.dayNumber, dateKey: daily.dateKey } : null,
    dailyPlan,
    rounds: TOTAL_ROUNDS,
    currentRound: 1,
    currentCategory: firstCategory,
    roundTimeSeconds: ROUND_TIME_SECONDS,
    // How many category rerolls remain for the whole game (host-controlled in
    // multiplayer, free for the solo player), set by the difficulty tier.
    // Daily: none — the day's board is fixed.
    rerollsRemaining: daily ? 0 : REROLLS_BY_DIFFICULTY[difficulty],
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      answers: [], // answers for the CURRENT round only (cleared each round)
      score: 0, // cumulative across all rounds
    })),
    usedCategories: new Set([firstCategory]), // so categories never repeat
    winnerId: null,
  };
}

/**
 * Applies an answer from ANY player at any time during an active round -
 * there is no turn checking. Validates length, per-player-per-round
 * uniqueness, then validates the answer in two stages: the category's
 * pre-generated accept-list first (instant, free), falling back to the Haiku
 * AI judge only when the answer isn't on the list. On success the answer is
 * recorded and the player's score goes up by 1.
 *
 * `opts.onAiCheck` (optional) is invoked synchronously right before the AI call
 * is awaited, so the caller can tell the client "checking..." while the ~0.5-1.5s
 * judge runs. It fires ONLY when the answer missed the list AND AI validation is
 * enabled (a key is set) - i.e. exactly when there's real latency to cover.
 *
 * Returns { accepted: true, answer, playerId } or
 *         { accepted: false, reason, playerId }.
 */
async function submitAnswer(game, playerId, rawAnswer, opts = {}) {
  // Normalize for lookup: trim, then lowercase. Accept-list entries are all
  // stored lowercase, so this is a case-insensitive match.
  const answer = rawAnswer.trim();
  const normalized = answer.toLowerCase();
  const player = game.players.find((p) => p.id === playerId);

  if (!player) {
    return { accepted: false, reason: 'not_in_game', playerId };
  }

  // Category answers can legitimately be short ("ox", "pie"), so the floor
  // is just 2 characters.
  if (answer.length < 2) {
    return { accepted: false, reason: 'too_short', playerId };
  }

  // ...and capped (input hardening): a multi-KB blob must never reach the AI
  // judge (burning credits) nor - in list-only mode, which accepts any
  // list-miss - get stored and rebroadcast to the whole room at round end.
  if (answer.length > MAX_ANSWER_LENGTH) {
    return { accepted: false, reason: 'too_long', playerId };
  }

  // Only THIS player's answers for THIS round block a resubmission - two
  // different players naming the same thing both score (they're racing
  // independently), and the same word is fair game again next round.
  if (player.answers.some((a) => a.toLowerCase() === normalized)) {
    return { accepted: false, reason: 'already_said', playerId };
  }

  // SUBMIT-TIME ROUND CONTEXT (protocol): the client may tag a submission with the
  // round/category it was DISPLAYING when the player typed (opts.expectedCategory,
  // opts.expectedRound). Judge against THAT, not against whatever game.currentCategory
  // happens to be now - otherwise an answer typed against category X can get judged
  // against a category the game has since moved to (drift / boundary rotation),
  // scoring 0 and showing a misleading "doesn't fit". If the tagged context no longer
  // matches the live round we return a distinct `stale_round` (the caller/client can
  // resync and re-show), rather than silently judging it against the wrong list.
  // Legacy clients that send no context fall back to the live category unchanged.
  const liveCategory = game.currentCategory;
  const liveRound = game.currentRound;
  let judgeCategory = liveCategory;
  if (opts.expectedCategory != null) {
    const roundMatches = opts.expectedRound == null || opts.expectedRound === liveRound;
    if (opts.expectedCategory !== liveCategory || !roundMatches) {
      return { accepted: false, reason: 'stale_round', playerId };
    }
    judgeCategory = opts.expectedCategory;
  }

  // Stage 1: the pre-generated accept-list for the round's category (the one the
  // player was shown - see judgeCategory above). A hit here is instant and free -
  // no API call. A miss does NOT reject; it just means the answer wasn't
  // pre-generated, so we ask the AI judge next.
  const validAnswers = CATEGORY_ANSWERS[judgeCategory];
  const onAcceptList = !!validAnswers && validAnswers.has(normalized);

  // Stage 1.5: compound leniency. The head noun of an English compound is its
  // LAST word - "socket wrench" IS a wrench, "ball-peen hammer" IS a hammer - so
  // a multi-word answer whose head word is itself a listed answer is clearly
  // in-category. Accept it without troubling the AI judge, which was wrongly
  // rejecting these valid compounds with "doesn't fit the category". Using the
  // head word (not any word) keeps "apple pie" out of a Fruits round.
  let compoundHeadHit = false;
  if (!onAcceptList && validAnswers) {
    const tokens = normalized.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
      const head = tokens[tokens.length - 1];
      compoundHeadHit = head.length >= 3 && validAnswers.has(head);
    }
  }

  if (!onAcceptList && !compoundHeadHit) {
    // Stage 2: Haiku AI fallback. Judges creative/uncommon answers that aren't
    // on the list. Only runs when an API key is configured; otherwise we stay in
    // list-only mode and ACCEPT the miss (no judge available to fairly reject it).
    if (haikuValidator.isEnabled()) {
      // RACE GUARD snapshot: the validate() await below takes 0.5-3s, and the
      // room's timers keep running while we wait - the round can end, the next
      // round can start, the category can be rerolled, the game can finish, or
      // the player can leave. Snapshot which round/category this answer was FOR
      // so we can tell whether the world moved on during the await.
      const roundAtSubmit = liveRound;
      const categoryAtSubmit = judgeCategory;

      // Tell the client we're checking, THEN await the judge (fail-OPEN,
      // 3s-timeout, rate-limited - all handled inside validate()).
      if (typeof opts.onAiCheck === 'function') opts.onAiCheck();
      const aiAccepted = await haikuValidator.validate(categoryAtSubmit, answer, playerId);
      if (!aiAccepted) {
        return { accepted: false, reason: 'not_in_category', playerId };
      }

      // RACE GUARD check: if the round this answer belonged to is no longer the
      // live one (ended / advanced / rerolled / finished), or the player left
      // mid-await, DISCARD the answer without mutating anything - otherwise a
      // round-N answer would land (and score) in round N+1, on a rerolled
      // category, or on a finished game's final scoreboard.
      if (
        game.status !== 'in_progress' ||
        game.currentRound !== roundAtSubmit ||
        game.currentCategory !== categoryAtSubmit ||
        !game.players.includes(player)
      ) {
        return { accepted: false, reason: 'round_over', playerId };
      }
      // Duplicate-in-flight guard: a second submission of the same answer can
      // pass the already_said check above while this one is still awaiting the
      // judge. Re-check so one word can never score twice.
      if (player.answers.some((a) => a.toLowerCase() === normalized)) {
        return { accepted: false, reason: 'already_said', playerId };
      }
    }
  }

  player.answers.push(answer);
  player.score += 1;

  return { accepted: true, answer, playerId };
}

// How many sample acceptable answers to reveal at round end, so players who
// blanked learn what would have counted.
const SAMPLE_ANSWERS_COUNT = 12;

/**
 * Up to SAMPLE_ANSWERS_COUNT answers from the current category's accept-list
 * that NOBODY gave this round (case-insensitive), in random order. Finite
 * domains can have fewer left over than the cap - whatever remains is
 * returned. Always an array; [] when the category has no accept-list.
 */
function buildSampleAnswers(game) {
  const validAnswers = CATEGORY_ANSWERS[game.currentCategory];
  if (!validAnswers || validAnswers.size === 0) return [];

  const given = new Set();
  game.players.forEach((p) => p.answers.forEach((a) => given.add(a.toLowerCase())));

  const remaining = [...validAnswers].filter((a) => !given.has(String(a).toLowerCase()));
  // Fisher-Yates shuffle so the reveal isn't always the list's first entries.
  for (let i = remaining.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
  }
  return remaining.slice(0, SAMPLE_ANSWERS_COUNT);
}

/**
 * Closes the current round. Flips status to 'between_rounds' and returns a
 * snapshot of what everyone scored this round (with their actual answers
 * revealed, now that the round is over), plus sample acceptable answers
 * nobody gave.
 */
function endRound(game) {
  game.status = 'between_rounds';
  return {
    round: game.currentRound,
    category: game.currentCategory,
    playerResults: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      answers: [...p.answers],
      roundScore: p.answers.length,
    })),
    sampleAnswers: buildSampleAnswers(game),
  };
}

/**
 * Advances to the next round, or ends the game if the last round just
 * finished. When advancing: bumps the round counter, picks a fresh
 * (non-repeating) category, clears everyone's per-round answers, and flips
 * status back to 'in_progress'. Returns the new round info, or null when the
 * game is over (status set to 'finished' and winnerId resolved).
 */
function startNextRound(game) {
  if (game.currentRound >= game.rounds) {
    game.status = 'finished';
    game.winnerId = determineWinner(game);
    return null;
  }

  game.currentRound += 1;
  // Daily games follow the fixed per-day plan; normal games roll a fresh
  // non-repeating category.
  const category = game.dailyPlan
    ? game.dailyPlan[game.currentRound - 1]
    : pickRandomCategory(game.usedCategories, game.selectedPacks);
  game.currentCategory = category;
  game.usedCategories.add(category);
  game.players.forEach((p) => {
    p.answers = [];
  });
  game.status = 'in_progress';

  return {
    round: game.currentRound,
    category,
    timerSeconds: game.roundTimeSeconds,
    rerollsRemaining: game.rerollsRemaining,
    ...(game.daily ? { daily: game.daily } : {}),
  };
}

/**
 * Rerolls the CURRENT round's category for a different one (same flat category
 * pool - there are no per-difficulty category lists, so "same tier" just means
 * another category that hasn't come up this game). It restarts the round on the
 * fresh category: this round's answers are cleared and the points earned on the
 * old category are reverted, so a reroll is a clean redo and can't be used to
 * farm an easy category before swapping away. Decrements the per-game allowance.
 *
 * Returns { round, category, timerSeconds, rerollsRemaining } or { error }.
 */
function rerollCategory(game) {
  if (!game || game.rerollsRemaining <= 0) {
    return { error: 'no_rerolls_left' };
  }
  game.players.forEach((p) => {
    p.score -= p.answers.length;
    if (p.score < 0) p.score = 0;
    p.answers = [];
  });
  const category = pickRandomCategory(game.usedCategories, game.selectedPacks);
  game.currentCategory = category;
  game.usedCategories.add(category);
  game.rerollsRemaining -= 1;
  return {
    round: game.currentRound,
    category,
    timerSeconds: game.roundTimeSeconds,
    rerollsRemaining: game.rerollsRemaining,
  };
}

/**
 * Returns the scoreboard sorted by cumulative score, highest first.
 */
function getScoreboard(game) {
  return game.players
    .map((p) => ({ id: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

module.exports = {
  CATEGORIES,
  PACK_IDS,
  TOTAL_ROUNDS,
  MIN_PLAYERS_TO_START,
  ROUND_TIME_SECONDS,
  REROLLS_BY_DIFFICULTY,
  createGame,
  submitAnswer,
  endRound,
  startNextRound,
  rerollCategory,
  getScoreboard,
  pickRandomCategory,
  dailyInfo,
  dailyCategories,
  DAILY_EPOCH_UTC,
  // Category tiering (breadth) — exposed for tests + tooling.
  tierForCategory,
  CATEGORY_TIER,
  TIER_POOLS,
  TIER_WEIGHTS,
};
