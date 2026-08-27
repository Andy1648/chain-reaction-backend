// botWordIntegrity.test.js  (JOB 14 — fix/bot-words)
// PROVES the architectural risk is not exploitable: a bot can never play a word a
// human would be rejected for, and the global dictionary cache written by
// markAsValid() can never poison the human acceptance path.
//
// The risk (documented): markAsValid() writes the process-global dictionary cache,
// and bot words are pre-warmed rather than re-validated at submission time. IF the
// bot's word pool could contain a word outside the human-acceptance predicate, the
// bot would both (a) play a word a human can't, and (b) cache it as valid so a human
// who copied it would then be wrongly accepted.
//
// Why it holds today (and this test pins it): the bot's ONLY word source is
// wordBombBot.pickWord -> _loadWords() = wordFilter.filterWords(botWords.txt), and
// filterWords uses EXACTLY the predicate isValidWord uses (isCommonEnglishWord AND
// NOT isDisallowedWord). markAsValid() is called only on (a) those filtered words
// (roomManager.js) and (b) 12 hardcoded real starter words (server.js). And
// isValidWord checks isDisallowedWord BEFORE reading the cache, so a poisoned entry
// can never make a disallowed word validate. If any of these invariants breaks, the
// assertions below fail.

const test = require('node:test');
const assert = require('node:assert/strict');
const { _loadWords } = require('./wordBombBot');
const { isValidWord, markAsValid } = require('./dictionary');
const { isCommonEnglishWord, isDisallowedWord } = require('./wordFilter');

test('every playable bot word is accepted by the HUMAN validation path (bot ⊆ human)', async () => {
  const pool = _loadWords();
  assert.ok(pool.length > 1000, `bot pool implausibly small: ${pool.length}`);
  const rejected = [];
  for (const w of pool) {
    // isValidWord is the exact gate a human submission hits.
    if (!(await isValidWord(w))) rejected.push(w);
    if (rejected.length >= 20) break;
  }
  assert.equal(
    rejected.length,
    0,
    `bot can play words a human would be rejected for: ${rejected.slice(0, 20).join(', ')}`
  );
});

test('bot pool satisfies the same predicate isValidWord enforces (invariant pin)', () => {
  const pool = _loadWords();
  const bad = pool.filter((w) => !isCommonEnglishWord(w) || isDisallowedWord(w));
  assert.equal(bad.length, 0, `bot pool diverges from the acceptance predicate: ${bad.slice(0, 10).join(', ')}`);
});

test('markAsValid() cannot poison the human path — isDisallowedWord is checked before the cache', async () => {
  // Pre-warm a disallowed proper noun as if a bad bot word had been cached.
  markAsValid('france');
  assert.equal(await isValidWord('france'), false, 'a disallowed word must stay rejected even if cached true');
});

test('the hardcoded server starter words are all human-valid (no back-door words)', async () => {
  const starters = ['garden', 'planet', 'window', 'castle', 'rocket', 'forest',
    'bridge', 'pencil', 'guitar', 'mirror', 'jacket', 'turtle'];
  for (const w of starters) {
    assert.equal(await isValidWord(w), true, `starter word "${w}" should be human-valid`);
  }
});
