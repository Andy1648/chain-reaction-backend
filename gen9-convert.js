// gen9-convert.js
// PROPAGATION STEP (the missing "converter" gen9-generate.js's header describes).
// Reads the VERIFIED gen9.clean.json and regenerates BOTH live wiring files from it:
//   - categoryAnswers/gen9.js  (one Set of verified answers per category)
//   - categoryPacks.js         (flat { "Category": "packId" } map)
// gen9.js supplies each category's accept-list; categoryPacks.js is what actually
// puts a category into rotation (categoryBlitzLogic.js pushes its keys into the play
// pool). BOTH are required for a new category to appear in-game — that's why this
// script writes them together, from the same source of truth.
//
// APPEND MODE: the output key set is the FULL clean.json (existing + any new batch).
// New categories are added; nothing is silently dropped. To keep re-runs a clean
// no-op on unchanged data, EXISTING keys keep their current file order and NEW keys
// are appended at the end of their pack (in clean.json order) — so a batch add is a
// pure append diff, not a whole-file reshuffle. Pack assignment and answers always
// come from clean.json.
//
// SAFETY: a key present in a CURRENT file but MISSING from clean.json would be data
// loss (a category silently removed from the game). If that happens the script prints
// the offending keys and EXITS WITHOUT WRITING. New keys (in clean, not yet in the
// files) are reported and WRITTEN — that is the whole point of append mode.
//
// Run from the backend repo root:  node gen9-convert.js

const fs = require('fs');

const CLEAN_FILE = './gen9.clean.json';
const GEN9_FILE = './categoryAnswers/gen9.js';
const PACKS_FILE = './categoryPacks.js';

// The exact 6-line header the current gen9.js carries — preserved verbatim.
const GEN9_HEADER = `// gen9.js
// Accept-lists for the gen9 Category Blitz pack rework (6 packs merged: movies,
// gaming, food, animals, sports, world). Same format as the other categoryAnswers/*
// files: one Set of lowercase answers per category. Seed lists; the Haiku judge
// covers the long tail. Keys MUST match the entries added to CATEGORIES in
// categoryBlitzLogic.js exactly.`;

// The exact 5-line header the current categoryPacks.js carries — preserved verbatim.
const PACKS_HEADER = `// categoryPacks.js
// Maps every gen9 Category Blitz category name to its pack id, built from the
// gen9.raw.json pack groupings. Used to tag gen9 categories with their pack when
// they are appended to RAW_CATEGORIES in categoryBlitzLogic.js. Keys match the
// gen9 accept-list keys (categoryAnswers/gen9.js) exactly.`;

function die(msg, code) {
  console.error(msg);
  process.exit(code || 1);
}

function tryRequire(relPath) {
  try {
    return require(relPath);
  } catch (err) {
    return null; // file doesn't exist yet (fresh checkout) — fall back to clean order
  }
}

// 1) clean.json — the single source of truth for key set, pack grouping, answers.
const clean = JSON.parse(fs.readFileSync(CLEAN_FILE, 'utf8'));
const PACK_ORDER = Object.keys(clean); // e.g. movies, gaming, food, animals, sports, world
const cleanOrder = []; // categories flattened in pack order, then within-pack order
const packOf = new Map(); // category -> packId
const answersOf = new Map(); // category -> [answers]
for (const pack of PACK_ORDER) {
  for (const entry of clean[pack]) {
    if (packOf.has(entry.category)) {
      die(`FATAL: duplicate category name across packs in clean.json: "${entry.category}" — cannot map 1:1. Nothing written.`);
    }
    packOf.set(entry.category, pack);
    answersOf.set(entry.category, entry.answers);
    cleanOrder.push(entry.category);
  }
}
const cleanSet = new Set(cleanOrder);

// 2) Current file key orders (for stable, no-op-preserving output). Missing -> [].
const curGen9 = tryRequire(GEN9_FILE);
const curPacks = tryRequire(PACKS_FILE);
const curGen9Keys = curGen9 ? Object.keys(curGen9) : [];
const curPacksKeys = curPacks ? Object.keys(curPacks) : [];

// 3) DATA-LOSS GUARD — a key in a current file but absent from clean.json means a
// category would be silently removed. Refuse to write.
const lostGen9 = curGen9Keys.filter((k) => !cleanSet.has(k));
const lostPacks = curPacksKeys.filter((k) => !cleanSet.has(k));
if (lostGen9.length || lostPacks.length) {
  console.error('DATA-LOSS GUARD — refusing to write. Keys present in a current file but MISSING from clean.json:');
  lostGen9.forEach((k) => console.error(`  gen9.js would lose:        ${k}`));
  lostPacks.forEach((k) => console.error(`  categoryPacks.js would lose: ${k}`));
  process.exit(2);
}

// 4) Key-diff REPORT (not a stop): what's new in clean vs the current gen9.js.
const curGen9Set = new Set(curGen9Keys);
const added = cleanOrder.filter((k) => !curGen9Set.has(k));
console.log(`Key diff: existing ${curGen9Keys.length}, added ${added.length} new key(s).`);
added.forEach((k) => console.log(`  + ${k}  [${packOf.get(k)}]`));

// 5a) gen9.js — flat module.exports of Sets. Existing keys keep current order; new
// keys append in clean order. Format: 2-space indent, JSON-quoted key, `: new Set(`,
// array with ", " separators, trailing "),".
const gen9Order = [
  ...curGen9Keys.filter((k) => cleanSet.has(k)),
  ...cleanOrder.filter((k) => !curGen9Set.has(k)),
];
const gen9Lines = gen9Order.map((k) => {
  const arr = '[' + answersOf.get(k).map((a) => JSON.stringify(a)).join(', ') + ']';
  return `  ${JSON.stringify(k)}: new Set(${arr}),`;
});
const gen9Out = `${GEN9_HEADER}\nmodule.exports = {\n${gen9Lines.join('\n')}\n};\n`;

// 5b) categoryPacks.js — grouped by pack with `  // <pack>` section comments, in
// PACK_ORDER. Within each pack: existing keys in current file order, then new keys
// in clean order.
const curPacksSet = new Set(curPacksKeys);
const packsLines = [];
for (const pack of PACK_ORDER) {
  packsLines.push(`  // ${pack}`);
  const existing = curPacksKeys.filter((k) => cleanSet.has(k) && packOf.get(k) === pack);
  const fresh = cleanOrder.filter((k) => !curPacksSet.has(k) && packOf.get(k) === pack);
  for (const k of [...existing, ...fresh]) {
    packsLines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(pack)},`);
  }
}
const packsOut = `${PACKS_HEADER}\nconst CATEGORY_PACKS = {\n${packsLines.join('\n')}\n};\n\nmodule.exports = CATEGORY_PACKS;\n`;

// 6) Write both.
fs.writeFileSync(GEN9_FILE, gen9Out);
fs.writeFileSync(PACKS_FILE, packsOut);

const totalAnswers = gen9Order.reduce((n, k) => n + answersOf.get(k).length, 0);
const packEntryCount = packsLines.filter((l) => !l.trimStart().startsWith('//')).length;
console.log(`Wrote ${GEN9_FILE}: ${gen9Order.length} categories, ${totalAnswers} answers.`);
console.log(`Wrote ${PACKS_FILE}: ${packEntryCount} entries across ${PACK_ORDER.length} packs.`);
