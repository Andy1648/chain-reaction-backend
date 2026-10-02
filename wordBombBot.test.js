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
  // The bot must never be able to play a filtered proper noun - blocklisted place
  // names (morocco/london/...) AND the wordlist-excluded long tail (saddam/...).
  const wordSet = new Set(words);
  for (const banned of ['morocco', 'london', 'paris', 'canada', 'google', 'saddam', 'hitler', 'putin']) {
    assert.ok(!wordSet.has(banned), `bot pool still contains "${banned}"`);
  }
});

// ---- visible choke (fumble) ------------------------------------------------------------------
{
  const { test: t } = require('node:test');
  const assert = require('node:assert/strict');
  const bot = require('./wordBombBot');
  const { fumblePlan, deadEndAttempt, isAnswerPrefix, FUMBLE_GAP_MS, FUMBLE_MAX_TRIES, FUMBLE_TYPE_MS, SAFETY_MARGIN_MS } = bot;
  // Each attempt's full text = the step right before the first backspace.
  const attemptsOf = (plan) => plan.filter((s, i) => plan[i + 1] && plan[i + 1].text.length < s.text.length && s.text.length > 0 && (i === 0 || plan[i - 1].text.length < s.text.length)).map((s) => s.text);
  const startsOf = (plan) => plan.filter((s, i) => s.text.length === 1 && (i === 0 || plan[i - 1].text === ''));

  t('fumblePlan: letters type in one at a time, hold, backspace out; attempts span the whole turn', () => {
    const plan = fumblePlan(['ANX', 'DIZ', 'PEQ'], 3000, 20);
    assert.deepEqual(plan.slice(0, 6).map((s) => s.text), ['A', 'AN', 'ANX', 'AN', 'A', '']);
    assert.equal(plan[1].at - plan[0].at, FUMBLE_TYPE_MS);
    const starts = startsOf(plan);
    assert.equal(starts.length, 5); // 3000..15000; an 18000 start would finish at 19190 > 19100
    starts.forEach((s, k) => assert.equal(s.at, 3000 + k * FUMBLE_GAP_MS));
    for (const s of plan) assert.ok(s.at <= 20000 - SAFETY_MARGIN_MS);
    assert.ok(starts.length <= FUMBLE_MAX_TRIES);
  });

  t('fumblePlan: consecutive attempts differ; short turns get fewer tries', () => {
    const a = attemptsOf(fumblePlan(['ABC', 'ABC', 'XYZ'], 2000, 20));
    assert.ok(a.length >= 2);
    for (let k = 1; k < a.length; k++) assert.notEqual(a[k], a[k - 1]);
    const tight = fumblePlan(['ANX', 'DIZ'], 5000, 7);
    for (const s of tight) assert.ok(s.at <= 7000 - SAFETY_MARGIN_MS, JSON.stringify(s));
    assert.equal(startsOf(tight).length, 0); // 5000 + 3*140 + 500 + 3*90 = 6190 > 6100
    assert.deepEqual(fumblePlan([null, undefined], 1000, 20), []);
  });

  t('isAnswerPrefix is fast: 1,000 checks well under 50 ms once warm', () => {
    bot.warmFumbleIndex();
    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) isAnswerPrefix(['inx', 'sta', 'qu', 'zz', 'ing'][i % 5], ['in', 'ing', 're', 'er', 'st'][i % 5]);
    assert.ok(Date.now() - t0 < 50, `${Date.now() - t0} ms`);
    assert.equal(isAnswerPrefix('st', 'ing'), true); // string, sting...
    assert.equal(isAnswerPrefix('zq', 'ing'), false);
  });

  t('NO FREE ANSWERS: no dead-end attempt is the start of any valid word containing the fragment', () => {
    const combos = ['nc', 'ing', 'ou', 'et', 'com', 'ri', 'tion', 'ab', 'pl', 'st', 'ea', 'ght', 'qu', 'ss', 'er', 'an', 'ive', 'ly'];
    let checked = 0;
    for (const c of combos) {
      for (let i = 0; i < 20; i++) {
        const seed = bot.pickWord(c, []);
        if (!seed) continue;
        const attempt = deadEndAttempt(seed, c);
        assert.ok(attempt, `no dead end for ${c}/${seed}`);
        assert.ok(attempt.length >= 2 && attempt.length <= 4, attempt);
        assert.equal(isAnswerPrefix(attempt, c), false, `${attempt} is a prefix of a valid ${c} word`);
        checked++;
      }
    }
    assert.ok(checked > 200);
  });
}

// Batch A (Andy oct2): the bot feels the fuse — median human vs MEDIUM lands at ~51% (was 18.6%).
test('missChance: MEDIUM is 5% on a full 20 s fuse, 13% at 8 s and below, linear between', () => {
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(bot.missChance('medium', 20), 0.05));
  assert.ok(near(bot.missChance('medium', 25), 0.05));
  assert.ok(near(bot.missChance('medium', 8), 0.13));
  assert.ok(near(bot.missChance('medium', 4), 0.13));
  assert.ok(near(bot.missChance('medium', 14), 0.09));
  assert.ok(near(bot.missChance('medium'), 0.05), 'no timer → the preset rate');
  assert.ok(bot.missChance('easy', 8) > bot.missChance('medium', 8) && bot.missChance('medium', 8) > bot.missChance('hard', 8));
});
