// claude/blitz-niche/score.cjs — score blind-probe guesses against the built lists.
//   node claude/blitz-niche/score.cjs probe/round1.json [--json out.json]
// Probe file: { "<category>": [ { "player": "...", "guesses": [...] } ] }. Prints per-list accept rate and every miss.
const fs = require('fs');
const path = require('path');
const B = require(path.join(__dirname, '..', '..', 'blitzLists'));
const file = path.resolve(__dirname, process.argv[2]);
const probe = JSON.parse(fs.readFileSync(file, 'utf8'));
let tot = 0;
let miss = 0;
const out = {};
const rows = [];
for (const [cat, players] of Object.entries(probe)) {
  if (!B.listFor(cat)) { console.log(`?? ${cat} has no list`); continue; }
  let t = 0;
  const m = [];
  const perPlayer = [];
  for (const p of players) {
    let pm = 0;
    for (const g of p.guesses) {
      t += 1;
      if (!B.onList(cat, g)) { m.push(g); pm += 1; }
    }
    perPlayer.push(pm);
  }
  tot += t;
  miss += m.length;
  out[cat] = [...new Set(m.map((x) => x.toLowerCase().trim()))];
  rows.push({ cat, t, m: m.length, worst: Math.max(...perPlayer), avg: perPlayer.reduce((a, b) => a + b, 0) / perPlayer.length });
}
for (const r of rows.sort((a, b) => b.m / b.t - a.m / a.t)) {
  console.log(`${(100 * (1 - r.m / r.t)).toFixed(0).padStart(3)}% accepted  ${r.cat} (${r.t} guesses, misses/player avg ${r.avg.toFixed(1)} max ${r.worst})`);
  if (out[r.cat].length) console.log(`      misses: ${out[r.cat].join(' | ')}`);
}
console.log(`\nTOTAL ${tot} guesses, ${miss} misses — ${(100 * (1 - miss / tot)).toFixed(1)}% accepted`);
const j = process.argv.indexOf('--json');
if (j > 0) fs.writeFileSync(path.resolve(__dirname, process.argv[j + 1]), JSON.stringify(out, null, 1));
