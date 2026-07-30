// categoryLibrary.test.js
// Cleanup-sensitive guard tests (chore/backend-cleanup): the Category Blitz
// accept-list library must load ONCE at module load and stay a cached singleton
// (not rebuilt per request), and the live play pool must load populated and
// duplicate-free. These lock the "loads once at startup" invariant so a future
// refactor can't accidentally turn category loading into per-request work.

const test = require('node:test');
const assert = require('node:assert/strict');

test('the accept-list library is a cached singleton (built once, not per require)', () => {
  const a = require('./categoryAnswers');
  const b = require('./categoryAnswers');
  assert.equal(a, b, 'require(./categoryAnswers) must return the same cached object');
});

test('the accept-list library is populated at load, mapping each category to a Set', () => {
  const answers = require('./categoryAnswers');
  const keys = Object.keys(answers);
  // The union of every categoryAnswers/* pack. A big drop here means a pack
  // stopped loading — a real regression, not just a threshold tweak.
  assert.ok(keys.length >= 500, `expected the full library, got ${keys.length}`);
  for (const k of keys) {
    assert.ok(answers[k] instanceof Set, `category "${k}" must map to a Set of answers`);
  }
});

test('the live play pool loads once, is sizable, and never repeats a category', () => {
  const { CATEGORIES } = require('./categoryBlitzLogic');
  assert.ok(Array.isArray(CATEGORIES) && CATEGORIES.length >= 400, `pool too small: ${CATEGORIES.length}`);
  assert.equal(new Set(CATEGORIES).size, CATEGORIES.length, 'the live pool must not contain duplicate categories');
});
