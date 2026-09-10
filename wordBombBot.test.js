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

// ---- COMBO SUPPORT SCALING (fix/wb-combo-support) --------------------------
// The bot draws from botWords.txt (14,477 words): median combo support 84, and no combo it
// cannot answer. A casual player draws from roughly the top 3,000 words — median support 15.
// So on the game's thinnest rolls the bot was exactly as sharp as on its fattest, and only the
// human felt the ramp. Miss chance and reaction window now both scale with the combo's
// PLAYER-FACING support (the comboSupport.json number gameLogic weights selection by).

const SUPPORT_POINTS = [8, 15, 30, 60, 120];
const DIFFS = ['easy', 'medium', 'hard'];

// Median of a real sample of computeDelayMs, so the delay claims are measured on what the bot
// actually does (jitter, floor and deadline clamp included), not on the formula alone.
function medianDelayMs(diff, support, timerSeconds = 60, n = 2001) {
  const xs = [];
  for (let i = 0; i < n; i += 1) xs.push(bot.computeDelayMs(diff, timerSeconds, support));
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)];
}

test('the miss / delay curve by support — the report', () => {
  console.log('[bot] support | ' + DIFFS.map((d) => `${d} miss`.padStart(10)).join(' |') + ' | delay x | ' + DIFFS.map((d) => `${d} med`.padStart(9)).join(' |'));
  for (const s of SUPPORT_POINTS) {
    const misses = DIFFS.map((d) => `${(100 * bot.missFor(d, s)).toFixed(2)}%`.padStart(10)).join(' |');
    const delays = DIFFS.map((d) => `${(medianDelayMs(d, s) / 1000).toFixed(2)}s`.padStart(9)).join(' |');
    console.log(`[bot] ${String(s).padStart(7)} | ${misses} | ${bot.delayScaleFor(s).toFixed(3).padStart(7)} | ${delays}`);
  }
});

test('the scalers are the specified formulas, and unknown support is neutral', () => {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  for (let s = 0; s <= 400; s += 1) {
    assert.ok(Math.abs(bot.missScaleFor(s) - clamp(2.2 - s / 25, 1.0, 2.2)) < 1e-12, `miss scale at ${s}`);
    assert.ok(Math.abs(bot.delayScaleFor(s) - clamp(1.8 - s / 40, 1.0, 1.8)) < 1e-12, `delay scale at ${s}`);
  }
  // A combo whose support we do not know must behave EXACTLY like the old flat constants — this
  // is what keeps every pre-existing call site and test unchanged.
  for (const bad of [undefined, null, NaN, 'sixty']) {
    assert.equal(bot.missScaleFor(bad), 1, `missScaleFor(${String(bad)})`);
    assert.equal(bot.delayScaleFor(bad), 1, `delayScaleFor(${String(bad)})`);
  }
  for (const d of DIFFS) assert.equal(bot.missFor(d, undefined), bot.BOT_DIFFICULTY[d].miss);
});

test('at the serve floor (support 8) medium misses 9.40% — NOT the 10-12% the brief predicted', () => {
  // DISCREPANCY, RECORDED. The brief specified missFor = base * clamp(2.2 - support/25, 1.0, 2.2)
  // and predicted ~11% at support 8, asking the test to gate on 10-12%. The formula cannot produce
  // that: clamp(2.2 - 8/25) = 1.88, and 5% * 1.88 = 9.40%. The 11% figure is what you get by
  // applying the 2.2 CEILING, which only binds at support <= 0 — unreachable, since the serve floor
  // is 8. The brief's other two checkpoints match the formula exactly (support 15 -> 8.00%,
  // support 60 -> 5.00%), so the formula is what shipped and 9.40% is asserted as the truth.
  // To actually land 11% at support 8 the intercept must be 2.52, which moves support 15 to 9.6%
  // rather than the specified 8% — a different curve, not a rounding difference.
  const at8 = bot.missFor('medium', 8);
  assert.ok(Math.abs(at8 - 0.094) < 1e-9, `medium miss at support 8 is ${(100 * at8).toFixed(2)}%`);
  assert.ok(Math.abs(bot.missFor('medium', 15) - 0.08) < 1e-9, 'support 15 -> 8.00%');
  assert.ok(Math.abs(bot.missFor('medium', 60) - 0.05) < 1e-9, 'support 60 -> 5.00%');
});

test("at support 8 medium's median delay is >= 1.5x its support-60 delay", () => {
  const thin = medianDelayMs('medium', 8);
  const fat = medianDelayMs('medium', 60);
  const ratio = thin / fat;
  console.log(`[bot] medium median delay: support 8 ${thin}ms vs support 60 ${fat}ms (${ratio.toFixed(2)}x)`);
  assert.ok(ratio >= 1.5, `expected >= 1.5x, got ${ratio.toFixed(3)}x`);
});

test('support 60+ is a no-op: miss and delay within 5% of the old flat constants', () => {
  for (const d of DIFFS) {
    for (const s of [60, 120, 353]) {
      // Miss is exactly the base — the scaler is pinned at 1.0 from support 30 up.
      assert.equal(bot.missFor(d, s), bot.BOT_DIFFICULTY[d].miss, `${d} miss at support ${s}`);
      const scaled = medianDelayMs(d, s);
      const flat = medianDelayMs(d, undefined);
      assert.ok(
        Math.abs(scaled - flat) / flat < 0.05,
        `${d} median delay at support ${s}: ${scaled}ms vs flat ${flat}ms`
      );
    }
  }
});

test('hard stays under 3% miss across the WHOLE support range', () => {
  let worst = 0;
  for (let s = 0; s <= 400; s += 1) worst = Math.max(worst, bot.missFor('hard', s));
  // s = 0 is below the serve floor and unreachable in play; included so the bound holds even if a
  // future table hands us a thinner combo than the floor allows.
  console.log(`[bot] hard worst-case miss across support 0-400: ${(100 * worst).toFixed(2)}%`);
  assert.ok(worst <= 0.03, `hard peaks at ${(100 * worst).toFixed(2)}%`);
  assert.ok(bot.missFor('hard', undefined) <= 0.03);
});

test('5,000 simulated turns: the bot never answers after the deadline, at any support', () => {
  let latest = 0;
  let tightest = Infinity;
  for (let i = 0; i < 5000; i += 1) {
    const diff = DIFFS[i % 3];
    // Sweep every timer preset the game ships, including the 7s HELL floor, against supports from
    // the serve floor up to the corpus maximum — the stretch must never outrun the safety clamp.
    const timerSeconds = [7, 10, 15, 20, 30][i % 5];
    const support = [8, 9, 12, 15, 22, 30, 45, 84, 200, 353][i % 10];
    const ms = bot.computeDelayMs(diff, timerSeconds, support);
    const deadline = timerSeconds * 1000;
    assert.ok(ms <= deadline - bot.SAFETY_MARGIN_MS + 1, `${diff} @${timerSeconds}s support ${support} fired at ${ms}ms`);
    assert.ok(ms >= 0, 'delay is never negative');
    latest = Math.max(latest, ms);
    tightest = Math.min(tightest, deadline - ms);
  }
  console.log(`[bot] 5,000 turns: latest submission ${latest}ms, smallest margin before deadline ${tightest}ms`);
  assert.ok(tightest >= bot.SAFETY_MARGIN_MS - 1, `smallest margin was ${tightest}ms`);
});

test('the stretch cannot outrun the deadline clamp even at an absurd support', () => {
  // The clamp is applied AFTER the stretch, and is the last word. Force the widest possible
  // window (an easy bot, support at the floor) onto the shortest timer.
  for (let i = 0; i < 500; i += 1) {
    const ms = bot.computeDelayMs('easy', 7, 8);
    assert.ok(ms <= 7000 - bot.SAFETY_MARGIN_MS + 1, `easy/support-8 on a 7s room fired at ${ms}ms`);
  }
});
