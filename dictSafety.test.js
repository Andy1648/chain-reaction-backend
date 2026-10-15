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

test('isSlur flags slurs only — not mild profanity, not innocent homographs', () => {
  // slurs → true (removed from EVERYTHING)
  assert.equal(isSlur('faggot'), true);
  assert.equal(isSlur('KIKE'), true, 'case-insensitive');
  // mild profanity → NOT a slur (it stays typeable; only display assets strip it)
  assert.equal(isSlur('damn'), false);
  assert.equal(isSlur('crap'), false);
  // innocent homographs deliberately omitted from the slur list
  assert.equal(isSlur('cracker'), false);
  assert.equal(isSlur('buckwheat'), false);
  assert.equal(isSlur('sabo'), false, 'One Piece character, not "abo"');
  // non-string / empty input never throws and is not a slur
  assert.equal(isSlur(''), false);
  assert.equal(isSlur(null), false);
  assert.equal(isSlur(42), false);
});

test('NO WORD CENSORSHIP (Andy oct15): every real word a player types is accepted — rude ones included', async () => {
  const { isValidWord, markAsValid } = require('./dictionary');
  for (const w of ['faggot', 'nigger', 'kike', 'fuck', 'shit']) assert.equal(await isValidWord(w), true, w);
  markAsValid('kike');
  assert.equal(await isValidWord('kike'), true);
  assert.equal(await isValidWord('planet'), true, 'ordinary word must accept');
  assert.equal(await isValidWord('xqzvb'), false, 'a non-word still fails');
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
