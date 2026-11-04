// scripts/varietyProbe.js — how often do MINER prompts and Category Blitz categories REPEAT between back-to-back games
// in the same room (nov4, Andy: "they need more combo variations")? Plays N rematch pairs through each mode's REAL
// picker and prints the share of the second game's prompts the first game already showed.
//   node scripts/varietyProbe.js [pairs=1000] [minerRounds=10]
const miner = require('../miner.js');
const blitz = require('../categoryBlitzLogic.js');

const PAIRS = Number(process.argv[2]) || 1000;
const MINER_ROUNDS = Number(process.argv[3]) || 10;
const pct = (a, b) => `${((100 * a) / Math.max(1, b)).toFixed(2)}%`;

function minerRun(rounds, seed = null) {
  const used = new Set(seed || []);
  const out = [];
  for (let r = 0; r < rounds; r++) {
    const p = miner.pickPrompt(used);
    used.add(p);
    out.push(p);
  }
  return out;
}
function blitzRun(packs, rounds = 3, recent = null) {
  const used = new Set();
  const out = [];
  for (let r = 0; r < rounds; r++) {
    const c = blitz.pickRandomCategory(used, packs, rounds, recent);
    used.add(c);
    out.push(c);
  }
  return out;
}
// play(prev) plays one game; prev = the last game's list (null for the first) — the room's cross-game memory
function pairs(play, memory) {
  let shared = 0;
  let total = 0;
  for (let i = 0; i < PAIRS; i++) {
    const first = play(null);
    const a = new Set(first);
    const b = play(memory ? first : null);
    shared += b.filter((x) => a.has(x)).length;
    total += b.length;
  }
  return pct(shared, total);
}

const both = (play) => `${pairs(play, false)} → ${pairs(play, true)}`;
console.log("shared with the room's last game: before → with cross-game memory");
console.log('MINER prompts', miner.PROMPTS.length, `· ${MINER_ROUNDS} rounds/game:`, both((prev) => minerRun(MINER_ROUNDS, prev)));
console.log('BLITZ categories', blitz.CATEGORIES.length, '· 3 rounds · all packs:', both((prev) => blitzRun(null, 3, prev && new Set(prev))));
const byPack = {};
for (const [, p] of Object.entries(blitz.CATEGORY_PACK || {})) byPack[p] = (byPack[p] || 0) + 1;
for (const p of blitz.PACK_IDS || []) console.log(`  pack ${p} (${byPack[p] || 0} cats) only:`, both((prev) => blitzRun([p], 3, prev && new Set(prev))));
