// claude/blitz-not3/build.cjs — merge lists.cjs (batch 3) into blitzLists.json + blitzCanon.json (replacing any entry of the same
// name, so it is re-runnable). Prints, per list, the curated answers that ALSO sit in its safe set (curated wins — check
// each is meant to) and any curated answer the blocked-terms filter would hide.
//   node claude/blitz-not3/build.cjs
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const LISTS_PATH = path.join(ROOT, 'blitzLists.json');
const CANON_PATH = path.join(ROOT, 'blitzCanon.json');
const raw = fs.readFileSync(LISTS_PATH, 'utf8');
const lists = JSON.parse(raw);
const canon = JSON.parse(fs.readFileSync(CANON_PATH, 'utf8'));
const { isBlockedForDisplay } = require(path.join(ROOT, 'blockedTerms'));
// answerKey without requiring blitzLists.js (that would load the json we are rewriting — fine, but keep it pure)
const { answerKey } = require(path.join(ROOT, 'blitzLists'));
const NEW = require('./lists.cjs');

const uniq = (xs) => {
  const seen = new Set();
  return xs.filter((x) => { const k = answerKey(x); if (!k || seen.has(k)) return false; seen.add(k); return true; });
};
const byName = new Map(lists.map((l) => [l.name, l]));

for (const n of NEW) {
  const fromKeys = new Set();
  for (const src of n.safeFrom || []) {
    const l = byName.get(src);
    if (!l) throw new Error(`${n.name}: safeFrom "${src}" missing`);
    for (const a of l.answers) fromKeys.add(answerKey(a));
  }
  // yieldTo: curated answers give way to the safeFrom lists, except the ones named
  const keep = new Set((n.yieldTo || []).map(answerKey));
  const answers = uniq(n.answers).filter((a) => !n.yieldTo || keep.has(answerKey(a)) || !fromKeys.has(answerKey(a)));
  const keys = new Set(answers.map(answerKey));
  const safe = uniq(n.safe).filter((a) => !keys.has(answerKey(a)));
  const safeKeys = new Set([...safe.map(answerKey), ...fromKeys]);
  const overlap = answers.filter((a) => safeKeys.has(answerKey(a)));
  const blocked = answers.filter((a) => isBlockedForDisplay(a));
  for (const g of n.good) if (!keys.has(answerKey(g))) throw new Error(`${n.name}: good "${g}" not curated`);
  for (const j of n.junk) if (keys.has(answerKey(j)) || !safe.some((a) => answerKey(a) === answerKey(j))) throw new Error(`${n.name}: junk "${j}" not safe-only`);
  console.log(`${n.name}: ${answers.length} answers, ${safe.length} safe (+${(n.safeFrom || []).join(', ') || 'no safeFrom'})`);
  if (overlap.length) console.log(`  curated ∩ safe (curated wins): ${overlap.join(', ')}`);
  if (blocked.length) console.log(`  BLOCKED curated: ${blocked.join(', ')}`);

  const entry = {
    name: n.name,
    pack: 'unhinged',
    size: answers.length,
    answers: [...answers].sort(),
    good: n.good,
    junk: [...n.junk, 'zzzzzzzz'],
    botKnown: Math.min(120, answers.length),
    mode: 'not',
    safeMsg: n.safeMsg,
    safe,
  };
  if (n.safeFrom) entry.safeFrom = n.safeFrom;
  const i = lists.findIndex((l) => l.name === n.name);
  if (i >= 0) lists[i] = entry; else lists.push(entry);
  canon[n.name] = answers.map((a) => ({ canon: a, aliases: [] }));
}

const trail = raw.endsWith('\n') ? '\n' : '';
fs.writeFileSync(LISTS_PATH, JSON.stringify(lists, null, 1) + trail);
const craw = fs.readFileSync(CANON_PATH, 'utf8');
fs.writeFileSync(CANON_PATH, JSON.stringify(canon, null, 1) + (craw.endsWith('\n') ? '\n' : ''));
