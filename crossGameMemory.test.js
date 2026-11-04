// crossGameMemory.test.js — nov4 (Andy: "they need more combo variations"): a room's NEXT game skips what its last game showed —
// Word Bomb combos (applyRecentCombos), Category Blitz categories (applyRecentCategories), MINER prompts (seeded `used`).
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

// ---- Category Blitz + MINER (nov4 probe: a single-pack Blitz rematch replayed up to 50% of its categories) ----
const B = require('./categoryBlitzLogic.js');
const M = require('./miner.js');

function blitzCats(game) {
  const out = [game.currentCategory];
  for (let r = 1; r < game.rounds; r++) {
    const c = B.pickRandomCategory(game.usedCategories, game.selectedPacks, game.rounds, game.recentCategories || null);
    game.usedCategories.add(c);
    out.push(c);
  }
  return out;
}

test('Blitz applyRecentCategories: a rematch on a small pack plays none of the last game\'s categories', () => {
  for (const pack of B.PACK_IDS) {
    for (let trial = 0; trial < 20; trial++) {
      const g1 = B.createGame(players, 'medium', false, [pack]);
      const a = blitzCats(g1);
      const g2 = B.applyRecentCategories(B.createGame(players, 'medium', false, [pack]), g1.usedCategories);
      const b = blitzCats(g2);
      const packSize = Object.values(B.CATEGORY_PACK).filter((p) => p === pack).length;
      if (packSize >= 2 * g1.rounds) assert.deepStrictEqual(b.filter((c) => a.includes(c)), [], `${pack}: repeated`);
      for (const c of b) assert.strictEqual(B.CATEGORY_PACK[c] === pack || packSize < 2 * g1.rounds, true, `${pack}: spilled to ${c}`);
    }
  }
});

test('Blitz applyRecentCategories is a no-op for the Daily Challenge (its board is fixed)', () => {
  const daily = { dayNumber: 1, dateKey: '2026-11-04' };
  const g = B.createGame(players, 'medium', true, null, daily);
  const first = g.currentCategory;
  B.applyRecentCategories(g, [first]);
  assert.strictEqual(g.currentCategory, first);
  assert.strictEqual(g.recentCategories, undefined);
});

test('MINER: seeding the new game\'s used set with the last game\'s prompts means no repeats for 10 rounds', () => {
  for (let trial = 0; trial < 30; trial++) {
    const used1 = new Set();
    const a = [];
    for (let r = 0; r < 10; r++) { const p = M.pickPrompt(used1); used1.add(p); a.push(p); }
    const g2 = M.createGame(players);
    for (const p of used1) g2.used.add(p);
    for (let r = 0; r < 10; r++) { const p = M.pickPrompt(g2.used); g2.used.add(p); assert.ok(!a.includes(p), `repeated ${p}`); }
  }
});
