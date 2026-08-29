// dictionaryCache.test.js — the dictionary cache must stay BOUNDED (fix/backend-safety).
// The old unbounded Map leaked memory: every distinct invalid token (typos/gibberish, an effectively
// infinite space) was cached forever (+20.8 MB / 50k invalids). The cache now caps at CACHE_MAX and
// evicts FIFO. This test floods it well past the cap and asserts it never exceeds it.
// Own file so the FAKE_DICTIONARY env toggle is isolated from the real-validation tests (node --test
// runs each file in its own process).
const test = require('node:test');
const assert = require('node:assert/strict');

test('cache stays bounded under a flood of distinct words', async () => {
  process.env.FAKE_DICTIONARY = '1'; // accept any alphabetic word → every distinct one gets cached
  try {
    const dict = require('./dictionary');
    const { max } = dict._cacheStats();
    // Flood past the cap with distinct alphabetic tokens (base-26 of i, 'zz' prefix keeps them clean).
    for (let i = 0; i < max + 2000; i += 1) {
      let n = i;
      let s = '';
      do {
        s = String.fromCharCode(97 + (n % 26)) + s;
        n = Math.floor(n / 26);
      } while (n > 0);
      await dict.isValidWord('zz' + s);
    }
    const { size, max: cap } = dict._cacheStats();
    assert.ok(size <= cap, `cache size ${size} exceeded the cap ${cap}`);
    // And it actually FILLED to the cap (proving eviction kept it there, not that the flood was small).
    assert.equal(size, cap, `expected the cache to sit exactly at the cap after the flood`);
  } finally {
    delete process.env.FAKE_DICTIONARY;
  }
});
