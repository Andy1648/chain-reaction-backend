// dictSafety.test.js — BUILD-TIME SAFETY GATE (fix/dict-safety).
// (1) botWords.txt (a DISPLAY asset — the bot plays these) must contain no slur
//     or profanity. (2) the acceptance gate must reject slurs while still
//     accepting ordinary words. (3) the offline Category Blitz accept-lists must
//     contain no slur (the bot can surface them).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isBlockedForDisplay, isSlur, isBlockedAnswer } = require('./blockedTerms');

test('botWords.txt (bot DISPLAY pool) contains no slur or profanity', () => {
  const words = fs
    .readFileSync(path.join(__dirname, 'botWords.txt'), 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = words.filter(isBlockedForDisplay);
  assert.equal(bad.length, 0, `bot would display blocked terms: ${bad.slice(0, 8).join(', ')}`);
});

test('acceptance gate rejects slurs but accepts ordinary words', async () => {
  const { isValidWord } = require('./dictionary');
  // a real word from the wordlist that is ALSO a slur → must be rejected
  assert.equal(await isValidWord('faggot'), false, 'slur must never validate');
  assert.equal(await isValidWord('nigger'), false, 'slur must never validate');
  // ordinary words still accept
  assert.equal(await isValidWord('planet'), true, 'ordinary word must accept');
  assert.equal(await isValidWord('bridge'), true, 'ordinary word must accept');
});

test('markAsValid cannot bypass the slur gate', async () => {
  const { isValidWord, markAsValid } = require('./dictionary');
  markAsValid('kike'); // simulate a bot pre-warming the cache
  assert.equal(await isValidWord('kike'), false, 'cached slur must still be rejected');
});

test('Category Blitz offline accept-lists contain no slur', () => {
  const answers = require('./categoryAnswers');
  const bad = [];
  for (const set of Object.values(answers)) {
    const arr = set instanceof Set ? [...set] : Array.isArray(set) ? set : [];
    for (const a of arr) if (isBlockedAnswer(a, 'accept')) bad.push(a);
  }
  assert.equal(bad.length, 0, `category answers would score slurs: ${bad.slice(0, 8).join(', ')}`);
});
