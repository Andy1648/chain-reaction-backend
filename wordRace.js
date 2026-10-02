// wordRace.js
// WORD RACE - pure race state machine. NO timers, NO sockets, NO dictionary.
//
// RULES. 2-5 racers share ONE seeded sequence of fragments. Each racer types any
// valid dictionary word (>= 3 letters) containing THEIR current fragment that THEY
// haven't used; an accepted word advances only that racer to the next fragment.
// First to TARGET_WORDS wins. No lives, no per-word timer - a single race cap
// (CAP_MS); at the cap, most words wins (tie -> whoever reached that count first).
//
// WHOLE-WORD VARIANT (Andy oct2 A6, `variant: 'words'`): like monkeytype / TypeRacer. Every racer
// gets the SAME seeded sequence of WHOLE common words and must type each one exactly to advance; no
// dictionary, no fragments. First to WORDS_TARGET wins; at WORDS_CAP_MS most words wins. Opt-in per
// room (race_quick_match { variant: 'words' }), so the fragment race above is untouched.
//
// Words are per-racer: a word racer A played is still legal for racer B. The
// dictionary check is async and lives in the orchestrator (wordRaceMode.js); this
// module owns every rule that can be decided from state alone, so the whole state
// machine is unit-testable with an injected clock.

const RAW_POOLS = require('./wordRaceFragments.json');
const { isBlockedForDisplay } = require('./blockedTerms');

const TARGET_WORDS = 12;
const WORDS_TARGET = 25; // whole-word variant: 25 words (~35 s at 45 WPM)
const WORDS_CAP_MS = 60 * 1000;
const WORDS_MIN_LEN = 3;
const WORDS_MAX_LEN = 8;
const WORDS_RANK = 2500; // drawn from the 2,500 most common bot words — everyday words only
const CAP_MS = 90 * 1000;
const MIN_WORD_LEN = 3;
const MAX_RACERS = 5;
const MIN_HUMANS = 2; // below this at launch, bots fill seats...
const BOT_FILL_TO = 3; // ...up to this many racers total

// FUSE tiers, easy -> hard. The race uses e/m/h only (FUSE's brutal 'b' tier is
// tuned for a 30+ word run and has no place in a 12-word sprint).
const TIERS = ['e', 'm', 'h'];

// Fragment FLOORS. A fragment only enters the race pool if at least `minSolutions`
// of the MIN_RANK most common bot words contain it - so every fragment has plenty
// of everyday answers (and the bots can always answer it). Per tier because easy
// fragments should be wide open and hard ones merely fair.
const MIN_RANK = 6000;
const FLOORS = { e: 30, m: 12, h: 10 };

// Deterministic RNG (mulberry32) - the same seed always yields the same race.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds the playable pools: FUSE's e/m/h fragments minus anything on the display
 * blocklist, minus anything under its tier floor. `words` is a frequency-ordered
 * word list (most common first); defaults to the bot word list.
 */
function buildPools(words) {
  const list = (words || require('./wordBombBot')._loadWords()).slice(0, MIN_RANK);
  const pools = {};
  for (const tier of TIERS) {
    pools[tier] = String(RAW_POOLS[tier])
      .trim()
      .split(/\s+/)
      .filter((f) => /^[a-z]{2,3}$/.test(f))
      .filter((f) => !isBlockedForDisplay(f))
      .filter((f) => {
        let n = 0;
        for (const w of list) {
          if (w.includes(f) && ++n >= FLOORS[tier]) return true;
        }
        return false;
      });
  }
  return pools;
}

let _pools = null;
function getPools() {
  if (!_pools) _pools = buildPools();
  return _pools;
}

/**
 * Tier for sequence slot i of `count`: a probabilistic crossfade e -> m -> h (the
 * FUSE selectTier shape, compressed to a 12-word race). x ramps 0 -> 2 across the
 * race; its fractional part is the chance of bumping up a tier on that slot.
 */
function tierForSlot(i, count, rng) {
  const x = count <= 1 ? 0 : Math.min(2, (2 * i) / (count - 1));
  const lo = Math.floor(x);
  return TIERS[rng() < x - lo ? Math.min(lo + 1, 2) : lo];
}

/**
 * The race's fragment sequence. Same seed -> identical sequence (every racer gets
 * the same one). Draws without replacement per tier, so no fragment repeats.
 */
function buildSequence(seed, count = TARGET_WORDS, pools = getPools()) {
  const rng = mulberry32(seed);
  const bags = {};
  for (const tier of TIERS) {
    const bag = pools[tier].slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    bags[tier] = bag;
  }
  const fragments = [];
  const tiers = [];
  for (let i = 0; i < count; i++) {
    const tier = tierForSlot(i, count, rng);
    tiers.push(tier);
    fragments.push(bags[tier].pop());
  }
  return { fragments, tiers };
}

// The bot list is WEB-frequency ordered, so its top words include things no typing race should ever
// show: adult terms the display blocklist doesn't cover, first names / places / brands (proper
// nouns typed lowercase), and web jargon. Reviewed by hand against the whole pool (Oct 2).
const RACE_STOP = new Set(`
nude gay lesbian anal milf hardcore bondage voyeur lingerie breast breasts sexual sex ass naked teen teens
adult adults mature girls porn xxx dating escort erotic penis kinky fetish horny strip cum boobs tits slut
abuse violence suicide kill drugs drug rape nazi
john james michael paul peter mary mike tom jack bob joe dan lee ann frank harry henry william williams
joseph johnson jones smith kelly martin louis david richard robert george steve chris kevin
york china french jersey vegas hong wales texas london paris america american europe san los las del les
cape turkey canada india japan german english florida california washington
yahoo linux amazon cisco dell canon ford google ebay java dvd sony nokia intel microsoft
mon tue wed thu fri sat sun jan feb mar apr jun jul aug sep sept oct nov dec pst est tel fax vol dev devel
doc var null ave bin sub pre pro info pics pic zip logo login username homepage website websites email
online forum forums blog blogs thread posted posts url html http www faq php rss usr pdf jpg gif ups ads
gratis non inc ltd misc enlarge bookmark keyword keywords spam bytes del est inn
`.split(/\s+/).filter(Boolean));

let _wordPool = null;
/** The whole-word pool: common, lowercase a-z, 3-8 letters, nothing on the display blocklist. */
function getWordPool(words) {
  if (!words && _wordPool) return _wordPool;
  const list = (words || require('./wordBombBot')._loadWords()).slice(0, WORDS_RANK);
  const seen = new Set();
  const pool = [];
  for (const w of list) {
    if (!/^[a-z]+$/.test(w) || w.length < WORDS_MIN_LEN || w.length > WORDS_MAX_LEN) continue;
    if (seen.has(w) || isBlockedForDisplay(w) || RACE_STOP.has(w)) continue;
    seen.add(w);
    pool.push(w);
  }
  if (!words) _wordPool = pool;
  return pool;
}

/** A word's tier, by length (drives bot pacing + the client's tier colour). */
function wordTier(w) {
  return w.length <= 4 ? 'e' : w.length <= 6 ? 'm' : 'h';
}

/**
 * The whole-word sequence: same seed -> identical words, no repeats within a race.
 */
function buildWordSequence(seed, count = WORDS_TARGET, pool = getWordPool()) {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const bag = pool.slice();
  const words = [];
  for (let i = 0; i < count && bag.length; i++) {
    const j = Math.floor(rng() * bag.length);
    words.push(bag[j]);
    bag[j] = bag[bag.length - 1];
    bag.pop();
  }
  return { words, tiers: words.map(wordTier) };
}

/**
 * Turns a freshly created race into the WHOLE-WORD variant (before it goes live). `fragments`
 * carries the same words so any reader of `fragments[index]` shows the word to type.
 */
function useWordsVariant(race, { pool, target = WORDS_TARGET, capMs = WORDS_CAP_MS } = {}) {
  if (race.status !== 'countdown') return false;
  const { words, tiers } = buildWordSequence(race.seed, target, pool);
  race.variant = 'words';
  race.words = words;
  race.fragments = words.slice();
  race.tiers = tiers;
  race.target = words.length;
  race.capMs = capMs;
  return true;
}

function newSeed() {
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

/**
 * Creates a race. `racers` is [{ id, name, isBot }]; only the first MAX_RACERS
 * race (anyone past that is a spectator). Status starts at 'countdown'.
 */
function createRace(racers, { seed = newSeed(), target = TARGET_WORDS, capMs = CAP_MS, pools } = {}) {
  const { fragments, tiers } = buildSequence(seed, target, pools);
  return {
    status: 'countdown', // 'countdown' | 'in_progress' | 'finished'
    variant: 'fragments', // 'fragments' | 'words' (useWordsVariant)
    seed,
    target,
    capMs,
    fragments,
    tiers,
    racers: racers.slice(0, MAX_RACERS).map((r) => makeRacer(r)),
    goAt: null, // wall-clock ms the race went live
    endedAt: null,
    winnerId: null,
    endReason: null, // 'finish' | 'cap' | 'forfeit'
  };
}

function makeRacer({ id, name, isBot }) {
  return {
    id,
    name,
    isBot: !!isBot,
    index: 0, // == words accepted == position in the fragment sequence
    words: [],
    used: new Set(),
    reachedAt: 0, // ms after go when `index` was last reached (tiebreak)
    left: false,
  };
}

function addRacer(race, racer) {
  if (race.racers.length >= MAX_RACERS) return false;
  if (race.racers.some((r) => r.id === racer.id)) return false;
  race.racers.push(makeRacer(racer));
  return true;
}

function getRacer(race, id) {
  return race.racers.find((r) => r.id === id) || null;
}

function currentFragment(race, racer) {
  return race.fragments[racer.index] || null;
}

function goLive(race, now) {
  if (race.status !== 'countdown') return false;
  race.status = 'in_progress';
  race.goAt = now;
  return true;
}

function normalize(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase();
}

/**
 * Every check that doesn't need the dictionary. Returns { word, reason } where
 * reason is null (passes; dictionary still to check) or one of:
 *   race_not_live | not_a_racer | too_short | missing_combo | already_used
 * The per-racer `used` set is the ONLY used-word memory: another racer's words
 * never block you.
 */
function checkWord(race, racerId, raw) {
  const word = normalize(raw);
  const racer = getRacer(race, racerId);
  if (race.status !== 'in_progress') return { word, reason: 'race_not_live' };
  if (!racer || racer.left) return { word, reason: 'not_a_racer' };
  const fragment = currentFragment(race, racer);
  if (!fragment) return { word, reason: 'race_not_live' };
  // WHOLE WORDS: the only legal word is the current one, exactly.
  if (race.variant === 'words') return { word, reason: word === fragment ? null : 'wrong_word' };
  if (word.length < MIN_WORD_LEN) return { word, reason: 'too_short' };
  if (!word.includes(fragment)) return { word, reason: 'missing_combo' };
  if (racer.used.has(word)) return { word, reason: 'already_used' };
  return { word, reason: null };
}

/**
 * Records an accepted word (the caller has already passed checkWord AND the
 * dictionary). Advances the racer; reaching the target finishes the race with
 * that racer as winner. Returns { racer, fragment, finished }.
 */
function applyAccept(race, racerId, word, now) {
  const racer = getRacer(race, racerId);
  const fragment = currentFragment(race, racer);
  racer.used.add(word);
  racer.words.push(word);
  racer.index += 1;
  racer.reachedAt = Math.max(0, now - (race.goAt || now));
  let finished = false;
  if (racer.index >= race.target) {
    finish(race, 'finish', now, racer.id);
    finished = true;
  }
  return { racer, fragment, finished };
}

/**
 * Final order: most words first; ties go to whoever reached that count first;
 * a racer who left sorts below everyone still in.
 */
function standings(race) {
  return race.racers
    .slice()
    .sort((a, b) => (a.left - b.left) || (b.index - a.index) || (a.reachedAt - b.reachedAt))
    .map((r, i) => ({
      id: r.id,
      name: r.name,
      isBot: r.isBot,
      place: i + 1,
      words: r.index,
      wordList: r.words.slice(),
      reachedAt: r.reachedAt,
      left: r.left,
    }));
}

/**
 * Ends the race. `forcedWinnerId` is set when someone crossed the line; otherwise
 * (cap / forfeit) the leader wins - unless nobody scored at all, then no winner.
 */
function finish(race, reason, now, forcedWinnerId = null) {
  if (race.status === 'finished') return false;
  race.status = 'finished';
  race.endReason = reason;
  race.endedAt = now;
  if (forcedWinnerId) {
    race.winnerId = forcedWinnerId;
  } else {
    const top = standings(race)[0];
    race.winnerId = top && top.words > 0 && !top.left ? top.id : null;
  }
  return true;
}

/** Marks a racer as gone. Returns how many racers are still in. */
function markLeft(race, racerId) {
  const racer = getRacer(race, racerId);
  if (racer) racer.left = true;
  return race.racers.filter((r) => !r.left).length;
}

/* ------------------------------ bots ------------------------------ */

const DEFAULT_PACE_MS = 5000; // ms/word for a player we know nothing about
const PACE_MIN_MS = 1500;
const PACE_MAX_MS = 15000;

function clampPace(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(PACE_MIN_MS, Math.min(PACE_MAX_MS, Math.round(n)));
}

/** Median of the humans' reported paces (ms/word), or the default. */
function seedPace(paces) {
  const ok = (paces || []).map(clampPace).filter((n) => n !== null).sort((a, b) => a - b);
  if (ok.length === 0) return DEFAULT_PACE_MS;
  const mid = ok.length >> 1;
  return ok.length % 2 ? ok[mid] : Math.round((ok[mid - 1] + ok[mid]) / 2);
}

// Each bot runs a touch faster or slower than the human's pace, so a solo racer
// gets one bot to chase and one to beat rather than two clones.
const BOT_SPREAD = [0.88, 1.12, 1.0, 0.95];
const BOT_TIER_MULT = { e: 0.85, m: 1.0, h: 1.25 };

function botFactor(botIndex) {
  return BOT_SPREAD[botIndex % BOT_SPREAD.length];
}

/** How long a bot thinks before its next word: pace x spread x tier x jitter. */
function botWordDelayMs(paceMs, factor, tier, rng = Math.random) {
  const jitter = 0.75 + rng() * 0.55; // 0.75 .. 1.30
  return Math.max(900, Math.round(paceMs * factor * (BOT_TIER_MULT[tier] || 1) * jitter));
}

// WHOLE-WORD bots type, they don't search: a reaction beat, then per-letter time. MEDIUM ~ 45 WPM
// (5 letters + a space at ~220 ms/char), spread per bot by botFactor() like the fragment race.
const BOT_REACT_MS = 260;
const BOT_MS_PER_CHAR = 210;
function botTypeDelayMs(word, factor, rng = Math.random) {
  const jitter = 0.8 + rng() * 0.45; // 0.80 .. 1.25
  const n = String(word || '').length + 1; // + the space / enter
  return Math.max(450, Math.round((BOT_REACT_MS + n * BOT_MS_PER_CHAR) * factor * jitter));
}

/** Bots needed to launch: fill to BOT_FILL_TO when fewer than MIN_HUMANS humans. */
function botsNeeded(humanCount) {
  if (humanCount >= MIN_HUMANS) return 0;
  return Math.max(0, Math.min(MAX_RACERS, BOT_FILL_TO) - humanCount);
}

module.exports = {
  TARGET_WORDS,
  WORDS_TARGET,
  WORDS_CAP_MS,
  getWordPool,
  RACE_STOP,
  buildWordSequence,
  useWordsVariant,
  wordTier,
  botTypeDelayMs,
  CAP_MS,
  MIN_WORD_LEN,
  MAX_RACERS,
  MIN_HUMANS,
  BOT_FILL_TO,
  MIN_RANK,
  FLOORS,
  TIERS,
  DEFAULT_PACE_MS,
  mulberry32,
  buildPools,
  getPools,
  buildSequence,
  tierForSlot,
  createRace,
  addRacer,
  getRacer,
  currentFragment,
  goLive,
  checkWord,
  applyAccept,
  standings,
  finish,
  markLeft,
  clampPace,
  seedPace,
  botFactor,
  botWordDelayMs,
  botsNeeded,
};
