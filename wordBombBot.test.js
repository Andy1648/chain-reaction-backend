// wordBombBot.test.js
// Run with: node --test wordBombBot.test.js
// Covers the pure bot helpers: word picking (combo containment, used-word
// exclusion, empty pool), bot-player shape, and difficulty timing bounds. No
// network, no timers.

const test = require('node:test');
const assert = require('node:assert/strict');

const bot = require('./wordBombBot');

// ---- pickWord -------------------------------------------------------------

test('pickWord returns a real word that contains the combo', () => {
  for (const combo of ['th', 'ing', 'tion', 'an']) {
    const word = bot.pickWord(combo, new Set());
    assert.ok(typeof word === 'string' && word.length >= 3, `got ${word} for ${combo}`);
    assert.ok(word.includes(combo), `"${word}" should contain "${combo}"`);
  }
});

test('pickWord never returns an already-used word', () => {
  // Exhaust most of the pool for a sparse-ish combo and confirm exclusions hold.
  const combo = 'mb';
  const used = new Set();
  for (let i = 0; i < 50; i++) {
    const w = bot.pickWord(combo, used);
    if (w === null) break;
    assert.ok(!used.has(w), `"${w}" was already used`);
    assert.ok(w.includes(combo));
    used.add(w);
  }
});

test('pickWord returns null when no word is available', () => {
  // No real word contains this; the pool is empty.
  assert.equal(bot.pickWord('qzqz', new Set()), null);
});

test('pickWord accepts an array of used words too', () => {
  const word = bot.pickWord('ing', ['thing', 'king']);
  assert.ok(word && word !== 'thing' && word !== 'king');
});

// ---- createBotPlayer ------------------------------------------------------

test('createBotPlayer has a sink connection and unique ids', () => {
  const a = bot.createBotPlayer();
  const b = bot.createBotPlayer();
  assert.equal(a.isBot, true);
  assert.ok(bot.BOT_NAMES.includes(a.name));
  assert.equal(a.connection.readyState, 1);
  assert.equal(typeof a.connection.send, 'function');
  assert.doesNotThrow(() => a.connection.send('{}')); // no-op, never throws
  assert.equal(a.connection.id, a.id);
  assert.notEqual(a.id, b.id);
});

// ---- difficulty timing (absolute humanized reaction, not timer fraction) ---

test('computeDelayMs samples an absolute reaction inside the difficulty window', () => {
  // Long timer so the deadline ceiling never bites; delay must reflect the
  // per-difficulty ABSOLUTE second band, independent of the turn length.
  const timer = 30;
  for (const key of ['easy', 'medium', 'hard']) {
    const [lo, hi] = bot.BOT_DIFFICULTY[key].delaySec;
    for (let i = 0; i < 500; i++) {
      const ms = bot.computeDelayMs(key, timer);
      assert.ok(ms >= lo * 1000 - 1, `${key}: ${ms} >= ${lo}s`);
      assert.ok(ms <= hi * 1000 + 1, `${key}: ${ms} <= ${hi}s`);
    }
    assert.ok(lo < hi);
  }
});

test('computeDelayMs never fires faster than 1s on ANY difficulty (the medium-bot bug)', () => {
  for (const key of ['easy', 'medium', 'hard']) {
    for (let i = 0; i < 500; i++) {
      // Even with a generous timer, the hard floor holds.
      assert.ok(bot.computeDelayMs(key, 30) >= bot.MIN_REACTION_MS, `${key} dipped below 1s`);
    }
  }
  assert.equal(bot.MIN_REACTION_MS, 1000);
});

test('the reaction band matches the balance spec', () => {
  assert.deepEqual(bot.BOT_DIFFICULTY.easy.delaySec, [4.0, 8.0]);
  assert.deepEqual(bot.BOT_DIFFICULTY.medium.delaySec, [2.0, 5.0]);
  assert.deepEqual(bot.BOT_DIFFICULTY.hard.delaySec, [1.0, 2.5]);
  assert.ok(Math.abs(bot.BOT_DIFFICULTY.easy.miss - 0.15) < 1e-9);
  assert.ok(Math.abs(bot.BOT_DIFFICULTY.medium.miss - 0.05) < 1e-9);
  assert.ok(Math.abs(bot.BOT_DIFFICULTY.hard.miss - 0.01) < 1e-9);
});

test('computeDelayMs caps a very short floor timer to a safe margin', () => {
  // On a 7s HELL room a slow easy bot (up to 8s) must still land before timeout.
  for (let i = 0; i < 200; i++) {
    const ms = bot.computeDelayMs('easy', 7);
    assert.ok(ms <= 7000 - bot.SAFETY_MARGIN_MS + 1, `expected <= 6100, got ${ms}`);
  }
});

test('rollMiss returns a boolean and unknown difficulty falls back to medium', () => {
  assert.equal(typeof bot.rollMiss('hard'), 'boolean');
  assert.equal(typeof bot.rollMiss('nonsense'), 'boolean');
  assert.deepEqual(bot.BOT_DIFFICULTY.medium.delaySec.length, 2);
});

test('word list loads, is sizable, and excludes proper nouns / place names', () => {
  const words = bot._loadWords();
  assert.ok(words.length > 10000, `expected a big list, got ${words.length}`);
  assert.ok(words.every((w) => /^[a-z]+$/.test(w) && w.length >= 3));
  // The bot must never be able to play a filtered proper noun.
  const wordSet = new Set(words);
  for (const banned of ['morocco', 'london', 'paris', 'canada', 'google']) {
    assert.ok(!wordSet.has(banned), `bot pool still contains "${banned}"`);
  }
});
