// dictionary.js
// Validates whether a submitted word is a real, playable English word. Backed by
// a curated ~275k common-English wordlist (see wordFilter.js) rather than the
// public dictionary API: the API happily returned proper nouns like SADDAM and
// MOROCCO, which then leaked into gameplay. The wordlist is local, deterministic,
// and network-free, so validation can't be broken by a vendor outage either.
// Results are cached since the same words get checked repeatedly across games.

const { isDisallowedWord, isCommonEnglishWord } = require('./wordFilter');
const { isSlur } = require('./blockedTerms');

// Bounded cache (fix/backend-safety). The same words get checked repeatedly, so a cache pays off —
// but an UNbounded Map leaked memory: every distinct INVALID token (typos, gibberish — an effectively
// infinite space) was cached forever (measured +20.8 MB / 50k invalids). Cap it and evict FIFO (Map
// preserves insertion order, so the first key is the oldest). 50k entries ≈ the measured ~20 MB, but
// now as a hard ceiling instead of unbounded growth.
const CACHE_MAX = 50000;
const cache = new Map(); // word (lowercase) -> boolean
function cacheSet(word, valid) {
  if (cache.size >= CACHE_MAX && !cache.has(word)) {
    cache.delete(cache.keys().next().value); // drop the oldest entry
  }
  cache.set(word, valid);
}

/**
 * Checks whether a word is valid to play. Returns true/false, never throws.
 * A word is valid iff it is purely alphabetic, NOT on the proper-noun/place-name
 * blocklist, AND present in the curated common-English wordlist. Proper nouns
 * (SADDAM, HITLER, ...) are absent from that lowercase-only list, so they fail;
 * place names that are also ordinary English words (MOROCCO, PARIS) are caught by
 * the blocklist supplement.
 */
async function isValidWord(word) {
  const normalized = word.trim().toLowerCase();

  if (normalized.length === 0) {
    return false;
  }

  // Words must be alphabetic only - no numbers, spaces, or punctuation.
  // This also blocks people trying to break the chain logic with weird input.
  if (!/^[a-z]+$/.test(normalized)) {
    return false;
  }

  // Blocklist supplement: place names / foreign words that ARE valid English
  // words and so appear in the wordlist below (MOROCCO, PARIS, PAGINA).
  if (isDisallowedWord(normalized)) {
    cacheSet(normalized, false);
    return false;
  }

  // SAFETY GATE (fix/dict-safety): slurs/hate terms are present in the underlying
  // ~275k common-English wordlist, so they'd otherwise validate. They must NEVER be
  // accepted or scored. Checked BEFORE the cache so a bot's markAsValid() can never
  // pre-warm a slur as valid. Mild profanity is intentionally NOT gated here — a
  // player TYPING a rude word is allowed; only DISPLAY/generation assets strip it.
  if (isSlur(normalized)) {
    cacheSet(normalized, false);
    return false;
  }

  if (cache.has(normalized)) {
    return cache.get(normalized);
  }

  // Test hook: FAKE_DICTIONARY=1 accepts any alphabetic word without consulting
  // the wordlist, so multi-client test harnesses (t3-harness/) get deterministic
  // word acceptance for arbitrary tokens. Never set in production.
  if (process.env.FAKE_DICTIONARY === '1') {
    cacheSet(normalized, true);
    return true;
  }

  // The authoritative check: is this a real common-English word? Local lookup,
  // no network. Proper nouns / non-English tokens are not in the list -> false.
  const valid = isCommonEnglishWord(normalized);
  cacheSet(normalized, valid);
  return valid;
}

/**
 * Pre-warms the cache with a word we already know is valid (e.g. a word the bot
 * is about to play, drawn from the already-filtered bot pool). Keeps the hot
 * path off the wordlist lookup for known-good words.
 */
function markAsValid(word) {
  cacheSet(word.trim().toLowerCase(), true);
}

// Test-only introspection: lets dictSafety.test.js assert the cache stays bounded under a flood of
// distinct invalids. Not used in production.
function _cacheStats() {
  return { size: cache.size, max: CACHE_MAX };
}

module.exports = { isValidWord, markAsValid, _cacheStats };
