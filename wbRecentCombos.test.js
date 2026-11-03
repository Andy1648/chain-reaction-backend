// wbRecentCombos.test.js — nov4 (Andy: "they need more combo variations"): a room's NEXT Word Bomb game skips the combos
// its last game showed (applyRecentCombos), while the within-game no-repeat rule is unchanged.
const test = require('node:test');
const assert = require('node:assert');
const L = require('./gameLogic.js');

const players = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];

function playCombos(game, n) {
  const seen = [game.currentCombo];
  for (let t = 1; t < n; t++) {
    game.currentCombo = L.nextCombo(game, t);
    seen.push(game.currentCombo);
  }
  return seen;
}

test('applyRecentCombos: the next game opens on, and never shows, a combo the last game showed', () => {
  for (let trial = 0; trial < 40; trial++) {
    const g1 = L.createGame(players, 'medium');
    const shown = playCombos(g1, 60);
    const g2 = L.applyRecentCombos(L.createGame(players, 'medium'), g1.usedCombos);
    const next = new Set(playCombos(g2, 60));
    const repeats = shown.filter((c) => next.has(c));
    assert.deepStrictEqual(repeats, [], `trial ${trial}: repeated ${repeats.join(',')}`);
    assert.ok(!g1.usedCombos.has(g2.currentCombo) || g2.usedCombos.size > 1);
  }
});

test('applyRecentCombos: within-game no-repeat still holds, and it is a no-op without a list', () => {
  const g = L.applyRecentCombos(L.createGame(players, 'medium'), null);
  assert.strictEqual(g.recentCombos, undefined);
  const s = playCombos(g, 80);
  assert.strictEqual(new Set(s).size, s.length);
});

test('applyRecentCombos keeps only the newest RECENT_COMBOS_CAP', () => {
  const all = L.COMBOS.slice(0, L.RECENT_COMBOS_CAP + 50);
  const g = L.applyRecentCombos(L.createGame(players, 'medium'), all);
  assert.strictEqual(g.recentCombos.size, L.RECENT_COMBOS_CAP);
  assert.ok(g.recentCombos.has(all[all.length - 1]));
});
