// t2-inputLimits.test.js
// Run with: node --test t2-inputLimits.test.js   (or `npm test` for the suite)
//
// [T2] Regression tests for unbounded submission length (Phase 3 input
// hardening). None of the three game modes capped the LENGTH of a submission,
// so a multi-kilobyte string sailed through every guard:
//   - Word Bomb: a 60KB all-letters "word" passes the ^[a-z]+$ check, the
//     Dictionary API call for it fails (URL too long / network error) and the
//     dictionary FAILS OPEN -> the garbage is ACCEPTED, stored in usedWords,
//     and rebroadcast to every player in EVERY subsequent turn_update.
//   - Category Blitz: in list-only mode (no ANTHROPIC_API_KEY) any list-miss
//     is accepted -> a 60KB "answer" is stored and rebroadcast at round end.
//   - Imposter Word: answers are never validated algorithmically, only capped
//     at 3 per round -> 3 x 60KB per player broadcast to the whole room.
// The fix adds a per-mode max length, rejected with reason 'too_long' before
// any network/AI call is made.

const test = require('node:test');
const assert = require('node:assert/strict');

const gameLogic = require('./gameLogic');
const blitz = require('./categoryBlitzLogic');
const imposter = require('./imposterWordLogic');
const mockDictionary = require('./dictionary.mock');
const haikuValidator = require('./haikuValidator');

// ---- Word Bomb -------------------------------------------------------------

test('Word Bomb rejects an absurdly long "word" before hitting the dictionary', async () => {
  const game = gameLogic.createGame([{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], 'medium');
  game.currentCombo = 'aa';

  // A dictionary that FAILS OPEN like the real one does on network errors -
  // and records whether it was even consulted.
  let dictionaryCalled = false;
  gameLogic._setDictionaryForTesting({
    isValidWord: async () => {
      dictionaryCalled = true;
      return true; // fail-open behavior
    },
  });

  try {
    const monster = 'a'.repeat(60 * 1024); // contains 'aa', all-alphabetic
    const res = await gameLogic.submitWord(game, monster);
    assert.equal(res.accepted, false, 'a 60KB word must be rejected');
    assert.equal(res.reason, 'too_long');
    assert.equal(dictionaryCalled, false, 'the dictionary must not be consulted for it');
    assert.equal(game.usedWords.size, 0, 'nothing that big may enter usedWords');
  } finally {
    gameLogic._setDictionaryForTesting(mockDictionary);
  }
});

test('Word Bomb still accepts a legitimately long real word', async () => {
  const game = gameLogic.createGame([{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], 'medium');
  game.currentCombo = 'en';
  gameLogic._setDictionaryForTesting(mockDictionary);
  const res = await gameLogic.submitWord(game, 'enter');
  assert.equal(res.accepted, true, 'normal words are unaffected');
});

// ---- Category Blitz ----------------------------------------------------------

test('Blitz rejects an oversized answer without consulting the AI judge', async () => {
  const game = blitz.createGame([{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], 'medium');
  const p1 = game.players.find((p) => p.id === 'p1');

  const realValidate = haikuValidator.validate;
  const realIsEnabled = haikuValidator.isEnabled;
  let aiCalled = false;
  haikuValidator.isEnabled = () => true;
  haikuValidator.validate = async () => {
    aiCalled = true;
    return true;
  };

  try {
    const res = await blitz.submitAnswer(game, 'p1', 'x'.repeat(60 * 1024));
    assert.equal(res.accepted, false, 'a 60KB answer must be rejected');
    assert.equal(res.reason, 'too_long');
    assert.equal(aiCalled, false, 'no API credits may be burned judging it');
    assert.deepEqual(p1.answers, []);
    assert.equal(p1.score, 0);
  } finally {
    haikuValidator.validate = realValidate;
    haikuValidator.isEnabled = realIsEnabled;
  }
});

test('Blitz rejects an oversized answer in list-only mode too (no key set)', async () => {
  const game = blitz.createGame([{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], 'medium');
  const realIsEnabled = haikuValidator.isEnabled;
  haikuValidator.isEnabled = () => false; // list-only mode accepts any miss...

  try {
    const res = await blitz.submitAnswer(game, 'p1', 'x'.repeat(60 * 1024));
    assert.equal(res.accepted, false, '...but never one this big');
    assert.equal(res.reason, 'too_long');
  } finally {
    haikuValidator.isEnabled = realIsEnabled;
  }
});

test('Blitz still accepts a normal multi-word answer', async () => {
  const game = blitz.createGame([{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], 'medium');
  const realIsEnabled = haikuValidator.isEnabled;
  haikuValidator.isEnabled = () => false; // list-only: any reasonable miss lands

  try {
    const res = await blitz.submitAnswer(game, 'p1', 'deep dish pepperoni');
    assert.equal(res.accepted, true, 'normal answers are unaffected');
  } finally {
    haikuValidator.isEnabled = realIsEnabled;
  }
});

// ---- Imposter Word ------------------------------------------------------------

test('Imposter rejects an oversized answer', () => {
  const players = [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }, { id: 'p3', name: 'C' }];
  const game = imposter.createGame(players, 'medium');

  const res = imposter.submitAnswer(game, 'p1', 'x'.repeat(60 * 1024));
  assert.equal(res.accepted, false, 'a 60KB imposter answer must be rejected');
  assert.equal(res.reason, 'too_long');
  assert.deepEqual(game.players.find((p) => p.id === 'p1').answers, []);
});

test('Imposter still accepts a normal sentence-ish answer', () => {
  const players = [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }, { id: 'p3', name: 'C' }];
  const game = imposter.createGame(players, 'medium');

  const res = imposter.submitAnswer(game, 'p1', 'the weird humming noise');
  assert.equal(res.accepted, true, 'normal answers are unaffected');
});
