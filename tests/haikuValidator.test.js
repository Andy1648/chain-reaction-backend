// tests/haikuValidator.test.js
// Run with: npm test   (node --test discovers this file)
//
// Unit tests for haikuValidator.js - the Stage-2 AI judge for Category
// Blitz. The contract under test is FAIL CLOSED: the ONLY way an answer is
// accepted is a healthy API reply that starts with "yes". Every failure
// mode - no key, HTTP error, thrown fetch, timeout, garbled reply, rate
// limit - must reject, and the rate limiter must stop calls from reaching
// the API at all.
//
// The Anthropic API is stubbed by replacing global.fetch (the module uses
// the bare global, so this is the real seam). The 3s timeout path is driven
// by node:test's mock timers instead of real waiting. The API key is set
// via process.env inside each test and restored after; node --test gives
// this file its own process, so no other suite sees these mutations.

const test = require('node:test');
const assert = require('node:assert/strict');

const validator = require('../haikuValidator');

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

// Every test runs against a fresh key + fetch and restores both.
// Pass key: null to run with NO key set (a bare undefined would just
// trigger the destructuring default).
function withEnv(t, { key = 'test-key-t1', fetchImpl } = {}) {
  if (key === null) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = key;
  if (fetchImpl) global.fetch = fetchImpl;
  t.after(() => {
    global.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  });
}

// A healthy API reply whose model text is `text`.
function okReply(text) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ text }] }),
  });
}

// Unique player id per test so the module-level rate limiter never couples tests.
let playerSeq = 0;
function freshPlayer() {
  return `t1-player-${playerSeq++}`;
}

/* ============================== isEnabled =============================== */

test('isEnabled tracks the presence of ANTHROPIC_API_KEY', (t) => {
  withEnv(t, { key: 'some-key' });
  assert.equal(validator.isEnabled(), true);
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(validator.isEnabled(), false);
});

/* ========================== verdict parsing ============================= */

test('a reply starting with "yes" accepts, "no" rejects (case/punctuation tolerant)', async (t) => {
  withEnv(t, { fetchImpl: okReply('Yes') });
  assert.equal(await validator.validate('Pizza toppings', 'pepperoni', freshPlayer()), true);

  global.fetch = okReply('  YES, definitely ');
  assert.equal(await validator.validate('Pizza toppings', 'pepperoni', freshPlayer()), true);

  global.fetch = okReply('No');
  assert.equal(await validator.validate('Pizza toppings', 'skateboard', freshPlayer()), false);

  global.fetch = okReply('no way');
  assert.equal(await validator.validate('Pizza toppings', 'skateboard', freshPlayer()), false);
});

test('a garbled / empty / off-script reply fails closed', async (t) => {
  withEnv(t, { fetchImpl: okReply('maybe? it depends') });
  assert.equal(await validator.validate('c', 'a', freshPlayer()), false);

  global.fetch = okReply('');
  assert.equal(await validator.validate('c', 'a', freshPlayer()), false);

  // Missing content array entirely.
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  assert.equal(await validator.validate('c', 'a', freshPlayer()), false);
});

/* =========================== failure modes ============================== */

test('validate without a key rejects WITHOUT calling the API (defensive gate)', async (t) => {
  let called = false;
  withEnv(t, { key: null, fetchImpl: async () => { called = true; } });
  assert.equal(await validator.validate('c', 'a', freshPlayer()), false);
  assert.equal(called, false);
});

test('an HTTP error status fails closed', async (t) => {
  withEnv(t, {
    fetchImpl: async () => ({ ok: false, status: 529, json: async () => ({}) }),
  });
  assert.equal(await validator.validate('c', 'a', freshPlayer()), false);
});

test('a thrown fetch (network down) fails closed', async (t) => {
  withEnv(t, { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(await validator.validate('c', 'a', freshPlayer()), false);
});

test('a reply slower than the 3s cap is aborted and fails closed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // A fetch that never resolves on its own - only the abort signal settles it,
  // exactly like a hung API connection.
  withEnv(t, {
    fetchImpl: (url, opts) =>
      new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  });

  const pending = validator.validate('c', 'a', freshPlayer());
  t.mock.timers.tick(validator.TIMEOUT_MS); // the 3s watchdog fires -> abort
  assert.equal(await pending, false);
});

/* ============================ rate limiting ============================= */

test('the 11th call inside a minute is rejected without touching the API', async (t) => {
  let apiCalls = 0;
  withEnv(t, {
    fetchImpl: async () => {
      apiCalls += 1;
      return { ok: true, status: 200, json: async () => ({ content: [{ text: 'yes' }] }) };
    },
  });

  const player = freshPlayer();
  for (let i = 0; i < validator.RATE_LIMIT_PER_MIN; i += 1) {
    assert.equal(await validator.validate('c', `answer${i}`, player), true);
  }
  assert.equal(apiCalls, validator.RATE_LIMIT_PER_MIN);

  // Over the cap: rejected AND no extra API call burned.
  assert.equal(await validator.validate('c', 'one more', player), false);
  assert.equal(apiCalls, validator.RATE_LIMIT_PER_MIN);
});

test('the rate limit is per player - another player is unaffected', async (t) => {
  let apiCalls = 0;
  withEnv(t, {
    fetchImpl: async () => {
      apiCalls += 1;
      return { ok: true, status: 200, json: async () => ({ content: [{ text: 'yes' }] }) };
    },
  });

  const spammer = freshPlayer();
  for (let i = 0; i < validator.RATE_LIMIT_PER_MIN + 3; i += 1) {
    await validator.validate('c', `spam${i}`, spammer);
  }
  const callsAfterSpammer = apiCalls;
  assert.equal(callsAfterSpammer, validator.RATE_LIMIT_PER_MIN, 'spammer capped');

  assert.equal(await validator.validate('c', 'legit', freshPlayer()), true);
  assert.equal(apiCalls, callsAfterSpammer + 1, 'the innocent player still reaches the API');
});

/* ======================== request construction ========================== */

test('the API request carries the key, the model prompt mentions category and answer', async (t) => {
  let captured = null;
  withEnv(t, {
    key: 'k-abc',
    fetchImpl: async (url, opts) => {
      captured = { url, opts };
      return { ok: true, status: 200, json: async () => ({ content: [{ text: 'yes' }] }) };
    },
  });

  await validator.validate('Dog breeds', 'xoloitzcuintli', freshPlayer());
  assert.ok(captured.url.includes('api.anthropic.com'));
  assert.equal(captured.opts.headers['x-api-key'], 'k-abc');
  const body = JSON.parse(captured.opts.body);
  assert.ok(body.messages[0].content.includes('Dog breeds'));
  assert.ok(body.messages[0].content.includes('xoloitzcuintli'));
  assert.ok(body.max_tokens <= 20, 'a yes/no needs only a tiny completion');
});
