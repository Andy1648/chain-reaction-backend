// claude/blitz-more/build.cjs — merge the niche replacement lists (data/*.json + data/adds/*.json probe fixes) into
// blitzLists.json + blitzCanon.json, replacing any entry of the same name, so it is re-runnable.
//   node claude/blitz-more/build.cjs
// Each data file: [{ name, pack, answers (most-common first), good, junk }]. adds/<anything>.json: { "<list name>": [answers] }
// appended to the END of that list's canon (probe misses are tail answers, never what the bot plays first).
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const LISTS_PATH = path.join(ROOT, 'blitzLists.json');
const CANON_PATH = path.join(ROOT, 'blitzCanon.json');
const raw = fs.readFileSync(LISTS_PATH, 'utf8');
const lists = JSON.parse(raw);
const canon = JSON.parse(fs.readFileSync(CANON_PATH, 'utf8'));
const { answerKey, foldKey } = require(path.join(ROOT, 'blitzLists'));
const { isBlockedForDisplay } = require(path.join(ROOT, 'blockedTerms'));

const DATA = path.join(__dirname, 'data');
const NEW = [];
for (const f of fs.readdirSync(DATA).filter((f) => f.endsWith('.cjs')).sort()) NEW.push(...require(path.join(DATA, f)));
const ADDS = {};
const ADDS_DIR = path.join(DATA, 'adds');
if (fs.existsSync(ADDS_DIR)) {
  for (const f of fs.readdirSync(ADDS_DIR).filter((f) => f.endsWith('.json')).sort()) {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(ADDS_DIR, f), 'utf8')))) (ADDS[k] = ADDS[k] || []).push(...v);
  }
}
const DROPS = {}; // data/drops.json: { "<list name>": [answers judged wrong in review] }
if (fs.existsSync(path.join(__dirname, 'drops.json'))) Object.assign(DROPS, JSON.parse(fs.readFileSync(path.join(__dirname, 'drops.json'), 'utf8')));

for (const n of NEW) {
  const drop = new Set((DROPS[n.name] || []).map(answerKey));
  const junkKeys = new Set(n.junk.map(answerKey));
  const seen = new Set();
  const answers = [];
  const skipped = [];
  for (const a of [...n.answers, ...(ADDS[n.name] || [])]) {
    const s = String(a).trim().toLowerCase();
    const k = answerKey(s);
    if (!k || k.length < 2 || seen.has(k)) continue;
    if (drop.has(k) || junkKeys.has(k)) { skipped.push(s); continue; }
    if (isBlockedForDisplay(s)) { skipped.push(`${s} (blocked)`); continue; }
    seen.add(k);
    answers.push(s);
  }
  const good = n.good.slice(0, 8);
  for (const g of good) if (!seen.has(answerKey(g)) && ![...seen].some((k) => foldKey(k) === foldKey(answerKey(g)))) throw new Error(`${n.name}: good "${g}" not on list`);
  const junk = [...n.junk.filter((j) => answerKey(j) !== 'zzzzzzzz').slice(0, 7), 'zzzzzzzz'];
  if (good.length < 8 || junk.length < 8) throw new Error(`${n.name}: ${good.length} good / ${junk.length} junk`);
  console.log(`${n.name} [${n.pack}]: ${answers.length} answers${skipped.length ? ` — skipped ${skipped.join(', ')}` : ''}`);
  const entry = { name: n.name, pack: n.pack, size: answers.length, answers: [...answers].sort(), good, junk, botKnown: Math.min(120, answers.length) };
  const i = lists.findIndex((l) => l.name === n.name);
  if (i >= 0) lists[i] = entry; else lists.push(entry);
  canon[n.name] = answers.map((a) => ({ canon: a, aliases: [] }));
}

fs.writeFileSync(LISTS_PATH, JSON.stringify(lists, null, 1) + (raw.endsWith('\n') ? '\n' : ''));
const craw = fs.readFileSync(CANON_PATH, 'utf8');
fs.writeFileSync(CANON_PATH, JSON.stringify(canon, null, 1) + (craw.endsWith('\n') ? '\n' : ''));
