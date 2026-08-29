// haikuValidator.cache.test.js — the AI-judge VERDICT CACHE (JOB 23 A2).
// Run with: node --test haikuValidator.cache.test.js  (node runs each test file in its own process,
// so mutating process.env + globalThis.fetch here can't leak into other suites).
// Proves: identical (category, answer) judgements hit the API once; genuine yes AND no are cached;
// fail-opens are NEVER cached; cache hits don't spend the per-player rate-limit budget.
const test = require('node:test');
const assert = require('node:assert/strict');

// Must be set BEFORE validate() runs (validate reads process.env.ANTHROPIC_API_KEY at call time).
process.env.ANTHROPIC_API_KEY = 'test-key-cache-suite';
const { validate, __clearVerdictCache } = require('./haikuValidator');

// Stub the Anthropic call: every fetch returns `replyText` as the model's reply and counts calls.
function stubFetch(replyText, ok = true, status = 200) {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok, status, json: async () => ({ content: [{ text: replyText }] }) };
  };
  return () => calls;
}

test('an identical (category, answer) is judged by the API only ONCE, across players', async () => {
  __clearVerdictCache();
  const calls = stubFetch('yes');
  const a = await validate('fruits', 'apple', 'player-1');
  const b = await validate('fruits', 'apple', 'player-2'); // different player, same answer
  const c = await validate('FRUITS', '  Apple ', 'player-3'); // case/space folds to the same key
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(c, true);
  assert.equal(calls(), 1, 'repeats of the same judgement must hit the cache, not the API');
});

test('a genuine "no" verdict is cached too', async () => {
  __clearVerdictCache();
  const calls = stubFetch('no');
  assert.equal(await validate('fruits', 'granite', 'p1'), false);
  assert.equal(await validate('fruits', 'granite', 'p1'), false);
  assert.equal(calls(), 1, 'the "no" was cached — no second API call');
});

test('a FAIL-OPEN (HTTP error) is NOT cached — a later call still reaches the API', async () => {
  __clearVerdictCache();
  let mode = 'err';
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (mode === 'err') return { ok: false, status: 429, json: async () => ({}) }; // quota error
    return { ok: true, status: 200, json: async () => ({ content: [{ text: 'no' }] }) };
  };
  assert.equal(await validate('fruits', 'qwertyx', 'p1'), true, 'fail-open accepts on a 429');
  mode = 'ok'; // API recovers and would now say "no"
  assert.equal(await validate('fruits', 'qwertyx', 'p1'), false, 'the real verdict applies (fail-open was not cached)');
  assert.equal(calls, 2, 'both calls reached the API — a fail-open must never poison the cache');
});

test('cache hits do NOT consume the per-player rate-limit budget', async () => {
  __clearVerdictCache();
  const calls = stubFetch('yes');
  await validate('cat', 'answerA', 'p-rl'); // 1 real call → caches (cat, answerA)
  // 100 repeats of the SAME answer — all cache hits. If these spent rate budget, the 10/min cap
  // would be exhausted and a fresh answer would fail-open WITHOUT an API call.
  for (let i = 0; i < 100; i += 1) assert.equal(await validate('cat', 'answerA', 'p-rl'), true);
  const fresh = await validate('cat', 'answerB', 'p-rl'); // NEW answer — budget must be intact
  assert.equal(fresh, true);
  assert.equal(calls(), 2, 'the 100 repeats were free; only answerA + answerB touched the API');
});
