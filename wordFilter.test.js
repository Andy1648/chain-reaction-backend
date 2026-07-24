// wordFilter.test.js
// Run with: node --test wordFilter.test.js
// Covers the proper-noun / place-name / foreign-word blocklist shared by the
// validation dictionary and the bot's word pool.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isDisallowedWord, isCommonEnglishWord, filterWords, BLOCKLIST } = require('./wordFilter');

test('blocks the observed offenders (proper noun + foreign word)', () => {
  assert.equal(isDisallowedWord('morocco'), true);
  assert.equal(isDisallowedWord('pagina'), true);
});

test('common-English wordlist rejects the proper-noun long tail (incl. SADDAM)', () => {
  // These proper nouns are absent from the lowercase wordlist, so they fail the
  // primary gate even though the blocklist never enumerates them.
  for (const w of ['saddam', 'hitler', 'putin', 'gandhi', 'obama', 'churchill', 'stalin']) {
    assert.equal(isCommonEnglishWord(w), false, `"${w}" should NOT be a common English word`);
  }
});

test('common-English wordlist keeps ordinary vocabulary', () => {
  for (const w of ['apple', 'garden', 'thunder', 'wizard', 'pizza', 'goblin', 'question']) {
    assert.equal(isCommonEnglishWord(w), true, `"${w}" should be a common English word`);
  }
});

test('blocks place names, nationalities, brands, and calendar names', () => {
  for (const w of ['london', 'canada', 'texas', 'german', 'google', 'monday']) {
    assert.equal(isDisallowedWord(w), true, `expected "${w}" blocked`);
  }
});

test('is case- and whitespace-insensitive', () => {
  assert.equal(isDisallowedWord('MOROCCO'), true);
  assert.equal(isDisallowedWord('  Paris  '), true);
});

test('does NOT block ordinary English words that double as place names', () => {
  // These have a dominant common-noun/verb sense — blocking them would break
  // legitimate gameplay, so they are deliberately kept.
  for (const w of ['china', 'turkey', 'polish', 'march', 'may', 'jersey', 'mobile', 'nice']) {
    assert.equal(isDisallowedWord(w), false, `"${w}" should stay playable`);
  }
});

test('does not block normal vocabulary', () => {
  for (const w of ['garden', 'thunder', 'apple', 'running', 'question']) {
    assert.equal(isDisallowedWord(w), false, `"${w}" should be allowed`);
  }
});

test('filterWords requires wordlist membership AND passes the blocklist', () => {
  // garden/apple/thunder: real words, kept. morocco/london: real words but
  // blocklisted, dropped. saddam/hitler: not in the wordlist at all, dropped.
  const input = ['garden', 'saddam', 'morocco', 'apple', 'london', 'hitler', 'thunder'];
  assert.deepEqual(filterWords(input), ['garden', 'apple', 'thunder']);
});

test('non-string input is safely not-disallowed', () => {
  assert.equal(isDisallowedWord(undefined), false);
  assert.equal(isDisallowedWord(null), false);
  assert.equal(isDisallowedWord(42), false);
});

test('the blocklist is non-trivially sized', () => {
  assert.ok(BLOCKLIST.size > 200, `expected a substantial list, got ${BLOCKLIST.size}`);
});
