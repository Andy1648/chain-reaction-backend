// dictionary.js
// Wraps the free Dictionary API (https://dictionaryapi.dev) to validate
// whether a word is real. Caches results in memory since the same words
// get checked repeatedly across games, and the API has no auth/rate-limit
// info published, so we want to be a good citizen.

const cache = new Map(); // word (lowercase) -> boolean

const DICTIONARY_API_BASE = 'https://api.dictionaryapi.dev/api/v2/entries/en/';

/**
 * Checks whether a word exists in the dictionary.
 * Returns true/false. Never throws - on network failure, we fail OPEN
 * (treat the word as valid) rather than blocking gameplay on an API outage.
 * This is a deliberate design choice: a flaky third-party API should never
 * make our game unplayable. We log the failure so we can monitor it.
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

  if (cache.has(normalized)) {
    return cache.get(normalized);
  }

  try {
    const response = await fetch(`${DICTIONARY_API_BASE}${encodeURIComponent(normalized)}`);

    // The API returns 404 for words it doesn't recognize - that's a valid
    // "not found" response, not an error, so we handle it explicitly.
    if (response.status === 404) {
      cache.set(normalized, false);
      return false;
    }

    if (!response.ok) {
      console.warn(`Dictionary API returned unexpected status ${response.status} for "${normalized}". Failing open.`);
      return true;
    }

    const data = await response.json();
    const isValid = Array.isArray(data) && data.length > 0;
    cache.set(normalized, isValid);
    return isValid;
  } catch (error) {
    console.warn(`Dictionary API request failed for "${normalized}": ${error.message}. Failing open.`);
    return true;
  }
}

/**
 * Pre-warms the cache with a word, useful for words we already know are
 * valid (e.g. the word that started a chain, chosen from a known word list).
 */
function markAsValid(word) {
  cache.set(word.trim().toLowerCase(), true);
}

module.exports = { isValidWord, markAsValid };
