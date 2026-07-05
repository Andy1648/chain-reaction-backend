// gen9-convert.js
// PROPAGATION STEP (the missing "converter" gen9-generate.js's header describes).
// Reads the VERIFIED gen9.clean.json and overwrites categoryAnswers/gen9.js so the
// live accept-lists reflect the cleaned answers instead of the raw/unverified pool.
//
// It changes ONLY the answer contents. Structure, key names, casing, quoting, and
// key ORDER are taken verbatim from the CURRENT categoryAnswers/gen9.js, so the diff
// is answers-only.
//
// SAFETY GATE: the category key set of the new output MUST exactly match the current
// gen9.js (same 283 keys). If ANY key would change, go missing, or appear extra, the
// script prints the diff and EXITS WITHOUT WRITING — keys must stay in lockstep with
// categoryBlitzLogic.js / categoryAnswers.js.
//
// Run from the backend repo root:  node gen9-convert.js

const fs = require('fs');

const CLEAN_FILE = './gen9.clean.json';
const OUT_FILE = './categoryAnswers/gen9.js';

// The exact 6-line header the current gen9.js carries — preserved verbatim.
const HEADER = `// gen9.js
// Accept-lists for the gen9 Category Blitz pack rework (6 packs merged: movies,
// gaming, food, animals, sports, world). Same format as the other categoryAnswers/*
// files: one Set of lowercase answers per category. Seed lists; the Haiku judge
// covers the long tail. Keys MUST match the entries added to CATEGORIES in
// categoryBlitzLogic.js exactly.`;

function die(msg) {
  console.error(msg);
  process.exit(1);
}

// 1) Authoritative key order + current key set from the CURRENT gen9.js.
const current = require(OUT_FILE);
const currentKeys = Object.keys(current); // insertion order = file order

// 2) Build category -> verified answers map from clean.json, guarding collisions.
const clean = JSON.parse(fs.readFileSync(CLEAN_FILE, 'utf8'));
const answersByCat = new Map();
for (const pack of Object.keys(clean)) {
  for (const entry of clean[pack]) {
    if (answersByCat.has(entry.category)) {
      die(`FATAL: duplicate category name across packs in clean.json: "${entry.category}" — cannot map 1:1. Aborting, nothing written.`);
    }
    answersByCat.set(entry.category, entry.answers);
  }
}

// 3) SAFETY GATE — key sets must be identical.
const currentSet = new Set(currentKeys);
const cleanSet = new Set(answersByCat.keys());
const missing = [...currentSet].filter((k) => !cleanSet.has(k)); // in gen9.js, absent from clean
const extra = [...cleanSet].filter((k) => !currentSet.has(k)); // in clean, absent from gen9.js

if (missing.length || extra.length) {
  console.error('KEY MISMATCH — refusing to overwrite gen9.js.');
  console.error(`  current gen9.js keys: ${currentSet.size}`);
  console.error(`  clean.json keys:      ${cleanSet.size}`);
  if (missing.length) {
    console.error(`  MISSING from clean.json (${missing.length}):`);
    missing.forEach((k) => console.error(`    - ${k}`));
  }
  if (extra.length) {
    console.error(`  EXTRA in clean.json (${extra.length}):`);
    extra.forEach((k) => console.error(`    + ${k}`));
  }
  process.exit(2);
}

console.log(`Key gate PASSED: ${currentSet.size} keys identical in both. Writing verified answers...`);

// 4) Emit in the CURRENT gen9.js key order, answers from clean.json.
// Matches the existing format exactly: 2-space indent, JSON-quoted key, `: new Set(`,
// array with ", " separators, trailing "),".
const lines = currentKeys.map((key) => {
  const answers = answersByCat.get(key);
  const arr = '[' + answers.map((a) => JSON.stringify(a)).join(', ') + ']';
  return `  ${JSON.stringify(key)}: new Set(${arr}),`;
});

const output = `${HEADER}\nmodule.exports = {\n${lines.join('\n')}\n};\n`;
fs.writeFileSync(OUT_FILE, output);

const newTotal = currentKeys.reduce((n, k) => n + answersByCat.get(k).length, 0);
console.log(`Wrote ${OUT_FILE}: ${currentKeys.length} categories, ${newTotal} answers.`);
