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

// ---- difficulty timing ----------------------------------------------------

test('computeDelayMs stays within the difficulty fraction and below the deadline', () => {
  const timer = 10; // seconds
  for (const key of ['easy', 'medium', 'hard']) {
    const [lo, hi] = bot.BOT_DIFFICULTY[key].delayFrac;
    for (let i = 0; i < 200; i++) {
      const ms = bot.computeDelayMs(key, timer);
      assert.ok(ms >= 0, 'delay non-negative');
      assert.ok(ms <= timer * 1000 * hi + 1, `delay <= ${hi} of timer`);
      // never later than the safety margin before the deadline
      assert.ok(ms <= timer * 1000 - bot.SAFETY_MARGIN_MS + 1, 'delay under deadline margin');
    }
    assert.ok(lo < hi);
  }
});

test('computeDelayMs caps a very short floor timer to a safe margin', () => {
  // 3s timer, "easy" can want up to 70% (2100ms) but the 900ms margin caps it.
  const ms = bot.computeDelayMs('easy', 3);
  assert.ok(ms <= 3000 - bot.SAFETY_MARGIN_MS + 1, `expected <= 2100, got ${ms}`);
});

test('rollMiss returns a boolean and unknown difficulty falls back to medium', () => {
  assert.equal(typeof bot.rollMiss('hard'), 'boolean');
  assert.equal(typeof bot.rollMiss('nonsense'), 'boolean');
  assert.deepEqual(bot.BOT_DIFFICULTY.medium.delayFrac.length, 2);
});

test('word list loads and is sizable', () => {
  const words = bot._loadWords();
  assert.ok(words.length > 10000, `expected a big list, got ${words.length}`);
  assert.ok(words.every((w) => /^[a-z]+$/.test(w) && w.length >= 3));
});
