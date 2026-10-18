// claude/blitz-not2/probe.cjs — run blind-probe guesses through the real submitAnswer and tally the outcome per list.
//   node claude/blitz-not2/probe.cjs probeA.json [probeB.json …]
const fs = require('fs');
const path = require('path');
const L = require(path.join(__dirname, '..', '..', 'categoryBlitzLogic'));

async function main() {
  const merged = {};
  for (const f of process.argv.slice(2)) {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')))) merged[k] = [...(merged[k] || []), ...v];
  }
  for (const [name, guesses] of Object.entries(merged)) {
    if (!L.CATEGORIES.includes(name)) { console.log(`?? not in play: ${name}`); continue; }
    const by = {};
    for (const a of guesses) {
      const g = L.createGame([{ id: 'p1', name: 'P1' }], 'easy', true);
      g.currentCategory = name;
      const r = await L.submitAnswer(g, 'p1', a);
      const why = r.accepted ? 'ok' : r.reason;
      (by[why] = by[why] || []).push(a);
    }
    const n = guesses.length;
    console.log(`\n${name} — ${n} guesses: ` + Object.entries(by).map(([k, v]) => `${k} ${v.length}`).join(', '));
    for (const [k, v] of Object.entries(by)) if (k !== 'ok') console.log(`  ${k}: ${v.join(' | ')}`);
  }
}
main();
