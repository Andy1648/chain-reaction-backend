// wordRace.js
// WORD RACE - pure race state machine. NO timers, NO sockets, NO dictionary.
//
// RULES. 2-5 racers share ONE seeded sequence of fragments. Each racer types any
// valid dictionary word (>= 3 letters) containing THEIR current fragment that THEY
// haven't used; an accepted word advances only that racer to the next fragment.
// First to TARGET_WORDS wins. No lives, no per-word timer - a single race cap
// (CAP_MS); at the cap, most words wins (tie -> whoever reached that count first).
//
// Words are per-racer: a word racer A played is still legal for racer B. The
// dictionary check is async and lives in the orchestrator (wordRaceMode.js); this
// module owns every rule that can be decided from state alone, so the whole state
// machine is unit-testable with an injected clock.

const RAW_POOLS = require('./wordRaceFragments.json');
const { isBlockedForDisplay } = require('./blockedTerms');

const TARGET_WORDS = 12;
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

/** Bots needed to launch: fill to BOT_FILL_TO when fewer than MIN_HUMANS humans. */
function botsNeeded(humanCount) {
  if (humanCount >= MIN_HUMANS) return 0;
  return Math.max(0, Math.min(MAX_RACERS, BOT_FILL_TO) - humanCount);
}

module.exports = {
  TARGET_WORDS,
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
