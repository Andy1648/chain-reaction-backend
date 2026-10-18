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

test('roundMeta adds the pack id', () => {
  assert.deepEqual(L.roundMeta('Pizza toppings'), { topN: 376, pack: 'food' });
});

test('startNextRound and rerollCategory payloads carry topN/openList + pack', () => {
  const pick = (p) => ({ topN: p.topN, openList: p.openList, pack: p.pack });
  const want = (c) => ({ topN: undefined, openList: undefined, pack: undefined, ...L.roundMeta(c) });
  const g = L.createGame([{ id: 'a', name: 'A' }], 'easy', true);
  const next = L.startNextRound(g);
  assert.deepEqual(pick(next), want(next.category));
  assert.ok(next.pack);
  const rr = L.rerollCategory(g);
  assert.deepEqual(pick(rr), want(rr.category));
});

test('Cartoon Network shows is benched (Andy knows 0 — fails EASY)', () => {
  assert.ok(!L.CATEGORIES.includes('Cartoon Network shows'));
});

test('no superlative category names (TOP already ranks them)', () => {
  for (const name of BLITZ_LISTS.NAMES) assert.ok(!/^(worst|best)\b/i.test(name), name);
});
