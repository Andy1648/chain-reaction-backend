// commonProper.test.js — STEP 55: Word Bomb accepts the curated common proper nouns (months,
// days, countries, cities, nationalities, mild insults) for human submissions; the open-ended
// proper-noun long tail and slurs are still refused, and the bot pool is unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidWord } = require('./dictionary');
const { filterWords } = require('./wordFilter');

test('months, days, countries, cities and mild insults are accepted', async () => {
  for (const w of ['october', 'monday', 'france', 'london', 'tokyo', 'canadian', 'idiot', 'moron', 'loser']) {
    assert.equal(await isValidWord(w), true, w);
  }
});

test('the long tail of proper nouns is still refused', async () => {
  for (const w of ['saddam', 'hitler', 'putin']) assert.equal(await isValidWord(w), false, w);
});

test('the bot pool does not gain them', () => {
  assert.deepEqual(filterWords(['london', 'october', 'table']), ['table']);
});

// THE UNLISTED (frontend oct20, Andy "ensure 'newgrounds' has an opportunity"): two words a gear riddle points at are on
// the list ON PURPOSE so a human can play them — NEWGROUNDS (the O.G. gear) and RACECAR (the MIRROR gear's example) —
// and, like every word here, the bot never plays them.
test('the UNLISTED riddle words are accepted for humans, never played by the bot', async () => {
  for (const w of ['newgrounds', 'racecar']) assert.equal(await isValidWord(w), true, w);
  assert.deepEqual(filterWords(['newgrounds', 'racecar', 'table']), ['table']);
});
