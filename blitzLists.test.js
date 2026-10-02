// blitzLists.test.js — STEP 9 (Andy oct2): Category Blitz is LIST-ONLY. For EVERY category in play:
// its 8 known-good answers score and its 8 known-junk answers are refused as 'not_on_list' — through
// the real submitAnswer, not a helper — and "zzzzzzzz" never scores anywhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./categoryBlitzLogic');
const { LISTS, NAMES, answerKey } = require('./blitzLists');

function freshGame(category) {
  const g = L.createGame([{ id: 'p1', name: 'P1' }], 'easy', true);
  g.currentCategory = category;
  return g;
}

test('every category in play is a curated list (no judge, no open categories)', () => {
  assert.deepEqual([...L.CATEGORIES].sort(), [...NAMES].sort());
  assert.ok(NAMES.length >= 60, `${NAMES.length} categories`);
});

test('no empty packs: every offered pack fills a 3-round game', () => {
  for (const p of L.PACK_IDS) {
    const n = NAMES.filter((c) => LISTS.get(c).pack === p).length;
    assert.ok(n >= L.TOTAL_ROUNDS, `${p}: ${n}`);
  }
});

for (const name of NAMES) {
  const list = LISTS.get(name);
  test(`${name}: 8 good score, 8 junk are NOT ON THE LIST`, async () => {
    assert.ok(list.good.length >= 8 && list.junk.length >= 8);
    for (const a of list.good) {
      const g = freshGame(name);
      const r = await L.submitAnswer(g, 'p1', a);
      assert.equal(r.accepted, true, `good "${a}" refused (${r.reason})`);
    }
    for (const a of list.junk) {
      const g = freshGame(name);
      const r = await L.submitAnswer(g, 'p1', a);
      assert.equal(r.accepted, false, `junk "${a}" scored`);
      assert.equal(r.reason, 'not_on_list', `junk "${a}" -> ${r.reason}`);
    }
    const z = await L.submitAnswer(freshGame(name), 'p1', 'zzzzzzzz');
    assert.equal(z.accepted, false);
  });
}

test('matching ignores case, accents, punctuation, spacing and a leading "the"', async () => {
  assert.equal(answerKey('The Spy-Who Loved  Me'), answerKey('spy who loved me'));
  const g = freshGame('NFL teams');
  assert.equal((await L.submitAnswer(g, 'p1', 'Dallas Cowboys')).accepted, true);
  assert.equal((await L.submitAnswer(g, 'p1', 'dallas-cowboys')).reason, 'already_said');
});

test('no head-word leniency: "zzzz cowboys" is not an NFL team', async () => {
  const r = await L.submitAnswer(freshGame('NFL teams'), 'p1', 'zzzz cowboys');
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'not_on_list');
});
