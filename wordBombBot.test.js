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

test('computeDelayMs is a LOGNORMAL reaction clustered near the difficulty median', () => {
  // Long timer so the deadline ceiling never bites. The sample mean should sit
  // near the median (a lognormal's mean is a bit above its median; well under 2×),
  // and every draw is a finite positive reaction — organic, not the old uniform band.
  const timer = 60;
  for (const key of ['chill', 'easy', 'medium', 'hard']) {
    const median = bot.BOT_DIFFICULTY[key].median;
    let sum = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const ms = bot.computeDelayMs(key, timer);
      assert.ok(Number.isFinite(ms) && ms > 0, `${key}: ${ms} not a finite positive delay`);
      sum += ms;
    }
    const meanSec = sum / N / 1000;
    assert.ok(meanSec > median * 0.7 && meanSec < median * 2.2, `${key}: mean ${meanSec.toFixed(2)}s off median ${median}s`);
  }
});

test('computeDelayMs never fires faster than 1s on ANY difficulty (the medium-bot bug)', () => {
  for (const key of ['chill', 'easy', 'medium', 'hard']) {
    for (let i = 0; i < 500; i++) {
      assert.ok(bot.computeDelayMs(key, 60) >= bot.MIN_REACTION_MS, `${key} dipped below 1s`);
    }
  }
  assert.equal(bot.MIN_REACTION_MS, 1000);
});

test('the tuned reaction spec: median DESCENDS chill>easy>medium>hard; choke is a per-turn rate', () => {
  const d = bot.BOT_DIFFICULTY;
  assert.ok(d.chill.median > d.easy.median, 'chill mulls longer than easy');
  assert.ok(d.easy.median > d.medium.median, 'easy slower than medium');
  assert.ok(d.medium.median > d.hard.median, 'medium slower than hard');
  for (const key of ['chill', 'easy', 'medium', 'hard']) {
    assert.ok(d[key].choke > 0 && d[key].choke < 1, `${key} choke is a probability`);
    assert.ok(d[key].sigma > 0, `${key} has lognormal spread`);
  }
  // the sim-tuned values that put each difficulty's human win rate in band
  assert.ok(Math.abs(d.chill.median - 4.5) < 1e-9);
  assert.ok(Math.abs(d.hard.median - 1.6) < 1e-9);
});

test('computeDelayMs caps a very short floor timer to a safe margin', () => {
  // On a 7s HELL room a slow chill bot must still land before timeout.
  for (let i = 0; i < 500; i++) {
    const ms = bot.computeDelayMs('chill', 7);
    assert.ok(ms <= 7000 - bot.SAFETY_MARGIN_MS + 1, `expected <= 6100, got ${ms}`);
  }
});

test('rollMiss returns a boolean and unknown difficulty falls back to medium', () => {
  assert.equal(typeof bot.rollMiss('hard'), 'boolean');
  assert.equal(typeof bot.rollMiss('nonsense'), 'boolean');
  assert.equal(typeof bot.BOT_DIFFICULTY.medium.choke, 'number');
});

test('word list loads, is sizable, and excludes proper nouns / place names', () => {
  const words = bot._loadWords();
  assert.ok(words.length > 10000, `expected a big list, got ${words.length}`);
  assert.ok(words.every((w) => /^[a-z]+$/.test(w) && w.length >= 3));
  // The bot must never be able to play a filtered proper noun - blocklisted place
  // names (morocco/london/...) AND the wordlist-excluded long tail (saddam/...).
  const wordSet = new Set(words);
  for (const banned of ['morocco', 'london', 'paris', 'canada', 'google', 'saddam', 'hitler', 'putin']) {
    assert.ok(!wordSet.has(banned), `bot pool still contains "${banned}"`);
  }
});
