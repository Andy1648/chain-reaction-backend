// tests/haikuValidator.test.js
// Run with: npm test   (node --test discovers this file)
//
// Unit tests for haikuValidator.js - the Stage-2 AI judge for Category
// Blitz. The contract under test is FAIL OPEN: the ONLY way an answer is
// REJECTED is a healthy API reply that starts with "no". Every infra failure
// mode - no key, HTTP error, thrown fetch, timeout, garbled reply, rate
// limit - ACCEPTS, and the rate limiter must still stop over-cap calls from
// reaching the API at all (accepting without burning credits).
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
  // The verdict cache is module-level; a ruling cached by one test would otherwise
  // satisfy the next one without an API call and quietly break its call counting.
  validator._resetVerdictCache();
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

test('a garbled / empty / off-script reply fails OPEN (accepts)', async (t) => {
  withEnv(t, { fetchImpl: okReply('maybe? it depends') });
  assert.equal(await validator.validate('c', 'a', freshPlayer()), true);

  global.fetch = okReply('');
  assert.equal(await validator.validate('c', 'a', freshPlayer()), true);

  // Missing content array entirely.
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  assert.equal(await validator.validate('c', 'a', freshPlayer()), true);
});

/* =========================== failure modes ============================== */

test('validate without a key accepts WITHOUT calling the API (fail open, defensive gate)', async (t) => {
  let called = false;
  withEnv(t, { key: null, fetchImpl: async () => { called = true; } });
  assert.equal(await validator.validate('c', 'a', freshPlayer()), true);
  assert.equal(called, false);
});

test('an HTTP error status (429 quota / 401 billing / 5xx) fails OPEN (accepts)', async (t) => {
  for (const status of [429, 401, 403, 529]) {
    withEnv(t, { fetchImpl: async () => ({ ok: false, status, json: async () => ({}) }) });
    assert.equal(await validator.validate('c', 'a', freshPlayer()), true, `status ${status} should accept`);
  }
});

test('a thrown fetch (network down) fails OPEN (accepts)', async (t) => {
  withEnv(t, { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(await validator.validate('c', 'a', freshPlayer()), true);
});

test('a reply slower than the 3s cap is aborted and fails OPEN (accepts)', async (t) => {
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
  assert.equal(await pending, true); // fail open on timeout
});

/* ============================ rate limiting ============================= */

test('the 11th call inside a minute is ACCEPTED without touching the API (fail open, credits protected)', async (t) => {
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

  // Over the cap: still no API call burned, and validate()'s boolean view is still
  // fail-open (true) - that policy is unchanged on this branch. What changed is that
  // judge() no longer CLAIMS a verdict it never got.
  assert.equal(await validator.validate('c', 'one more', player), true);
  assert.equal(apiCalls, validator.RATE_LIMIT_PER_MIN);

  const over = await validator.judge('c', 'another', player);
  assert.equal(over.verdict, null, 'over the cap there is NO VERDICT, not a yes');
  assert.equal(over.code, 'rate_limited');
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

/* =============== the cap must never launder a "no" into a "yes" ========== */

// THE BUG THIS BRANCH EXISTS FOR. The old cap returned a bare `true` once a player
// ran past 10 calls/minute, while the model was answering "no" to every one of them:
// type fast enough and junk started scoring. Two things stop that now - the cap is
// above human range, and a verdict the model already gave is REUSED rather than
// re-asked, so a known "no" keeps rejecting even with every slot spent.
test('a cached "no" still rejects after the player is over the rate cap', async (t) => {
  let apiCalls = 0;
  withEnv(t, {
    fetchImpl: async () => {
      apiCalls += 1;
      return { ok: true, status: 200, json: async () => ({ content: [{ text: 'no' }] }) };
    },
  });

  const player = freshPlayer();
  // One real "no" for this exact (category, answer) - now cached.
  const first = await validator.judge('Fruits', 'afdsaada', player);
  assert.equal(first.verdict, false);
  assert.equal(first.code, 'judge_no');
  assert.equal(apiCalls, 1);

  // Burn the whole cap on OTHER answers.
  for (let i = 0; i < validator.RATE_LIMIT_PER_MIN; i += 1) {
    await validator.judge('Fruits', `filler${i}`, player);
  }
  const callsAfterBurn = apiCalls;

  // Over the cap, the SAME junk is still rejected - from the cached real verdict,
  // with no API call and no slot. This is the exact path that used to return true.
  const repeat = await validator.judge('Fruits', 'afdsaada', player);
  assert.equal(repeat.verdict, false, 'a known "no" must stay a "no" past the cap');
  assert.equal(repeat.code, 'judge_no');
  assert.equal(repeat.cached, true);
  assert.equal(apiCalls, callsAfterBurn, 'a cached verdict costs no API call');
  assert.equal(await validator.validate('Fruits', 'afdsaada', player), false);
});

test('the cap is above human range so honest fast play never reaches it', () => {
  // A 30s Blitz round; even a very fast player submitting every ~2s produces ~15
  // answers, and only the list-MISSES reach the judge at all.
  assert.ok(
    validator.RATE_LIMIT_PER_MIN >= 25,
    `cap ${validator.RATE_LIMIT_PER_MIN}/min must sit above a human's list-miss rate in a 30s round`
  );
});

/* ===================== judge() codes and http status ==================== */

test('judge() reports WHY there is no verdict, and carries the HTTP status', async (t) => {
  withEnv(t, { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  const r = await validator.judge('c', 'a', freshPlayer());
  assert.equal(r.verdict, null, '401 is not a verdict');
  assert.equal(r.code, 'judge_unavailable');
  assert.equal(r.httpStatus, 401, 'the status is what tells billing apart from quota');
  assert.equal(r.detail, 'http_401');
});

test('judge() distinguishes a model "no" from a judge that never ran', async (t) => {
  withEnv(t, { fetchImpl: okReply('no') });
  const said = await validator.judge('c', 'a', freshPlayer());
  assert.equal(said.verdict, false);
  assert.equal(said.code, 'judge_no');

  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const never = await validator.judge('c', 'b', freshPlayer());
  assert.equal(never.verdict, null);
  assert.equal(never.code, 'judge_unavailable');
  assert.equal(never.httpStatus, 429);

  // The whole point: these two are no longer the same observable.
  assert.notEqual(said.code, never.code);
});

test('no key reports judge_unavailable/no_key rather than a silent accept', async (t) => {
  withEnv(t, { key: null });
  const r = await validator.judge('c', 'a', freshPlayer());
  assert.equal(r.verdict, null);
  assert.equal(r.code, 'judge_unavailable');
  assert.equal(r.detail, 'no_key');
  assert.equal(r.httpStatus, null);
});

test('an outage is never cached - the judge is re-asked once it recovers', async (t) => {
  let status = 429;
  withEnv(t, {
    fetchImpl: async () => (status === 200
      ? { ok: true, status: 200, json: async () => ({ content: [{ text: 'no' }] }) }
      : { ok: false, status, json: async () => ({}) }),
  });
  const player = freshPlayer();
  assert.equal((await validator.judge('c', 'x', player)).code, 'judge_unavailable');
  status = 200;
  const after = await validator.judge('c', 'x', player);
  assert.equal(after.verdict, false, 'the recovered judge gets to rule');
  assert.equal(after.code, 'judge_no');
  assert.notEqual(after.cached, true);
});
