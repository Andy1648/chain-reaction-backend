// dictionary.mock.js
// A drop-in replacement for dictionary.js's isValidWord, used only in
// tests so gameLogic can be exercised without any network access. This
// sandbox has no internet egress, so we can't hit the real Dictionary
// API here - this mock is NOT used by the production server, only by
// the test suite.

const KNOWN_WORDS = new Set([
  'garden', 'planet', 'window', 'castle', 'rocket', 'forest',
  'bridge', 'pencil', 'guitar', 'mirror', 'jacket', 'turtle',
  'enter', 'erode', 'denote', 'tepid', 'idiom', 'ombre',
  'render', 'erupt', 'uptown', 'wnxyz', // wnxyz is intentionally fake, see below
]);

// Remove the deliberately-fake word - it exists in the set above only as
// documentation of what an "unknown word" test case looks like. Tests
// that need an unknown word should use a string NOT in this list, like
// 'zzqx' or 'notarealword'.
KNOWN_WORDS.delete('wnxyz');

async function isValidWord(word) {
  return KNOWN_WORDS.has(word.trim().toLowerCase());
}

function markAsValid(word) {
  KNOWN_WORDS.add(word.trim().toLowerCase());
}

module.exports = { isValidWord, markAsValid, KNOWN_WORDS };
