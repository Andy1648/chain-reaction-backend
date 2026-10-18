// blitzTopN.test.js — TOP-N rebrand (Andy oct17): every round_start payload carries the category's TOP N (its list's
// canonical size, aliases folded) or `openList` for a NOT list (TOP ∞). Display-only: scoring is untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./categoryBlitzLogic');
const BLITZ_LISTS = require('./blitzLists');

test('topN is the canonical list size, not the alias count', () => {
  assert.deepEqual(L.topNFor('NFL teams'), { topN: 32 });
  assert.ok(BLITZ_LISTS.listFor('NFL teams').answers.length > 32);
});

test('NOT lists are open (TOP ∞) and carry no number', () => {
  assert.deepEqual(L.topNFor("Things you shouldn't microwave"), { openList: true });
});

test('unknown category adds nothing', () => {
  assert.deepEqual(L.topNFor('no such category'), {});
});

test('every curated list yields a positive topN or openList', () => {
  for (const name of BLITZ_LISTS.NAMES) {
    const t = L.topNFor(name);
    assert.ok(t.openList === true || (Number.isInteger(t.topN) && t.topN > 0), name);
  }
});

test('startNextRound and rerollCategory payloads carry it', () => {
  const g = L.createGame([{ id: 'a', name: 'A' }], 'easy', true);
  const next = L.startNextRound(g);
  assert.deepEqual({ topN: next.topN, openList: next.openList }, { ...{ topN: undefined, openList: undefined }, ...L.topNFor(next.category) });
  const rr = L.rerollCategory(g);
  assert.deepEqual({ topN: rr.topN, openList: rr.openList }, { ...{ topN: undefined, openList: undefined }, ...L.topNFor(rr.category) });
});

test('no superlative category names (TOP already ranks them)', () => {
  for (const name of BLITZ_LISTS.NAMES) assert.ok(!/^(worst|best)\b/i.test(name), name);
});
