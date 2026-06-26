// comboExpand.js  [night/content-expand]
// Generator + machine-filter for NEW Word Bomb letter combos.
//
// THE COMBO RULE (matches the established COMBOS in gameLogic.js):
//   A combo is a 2- or 3-letter sequence that appears in LOTS of common words,
//   so a turn is "almost always solvable" but still makes you think. A dead-end
//   combo (few/no common words) is a FAIL.
//
// This script enforces the rule mechanically against botWords.txt (~18k common,
// frequency-ranked English words — the SAME corpus the Word Bomb bot draws from,
// so "solvable for the bot" == "solvable for a human"):
//   1. Candidate generation: every 2- and 3-letter a–z sequence.
//   2. FLOOR: a candidate must appear in >= FLOOR common words. The floor is
//      calibrated from the EXISTING combos — we measure how many botWords each
//      shipped combo sits in and take a safe fraction of that minimum, so new
//      combos are at least as solvable as the easiest one already shipping.
//   3. DEDUPE: drop anything already in COMBOS.
//   4. Emit a balanced batch (cap per length) ranked by frequency, each with its
//      most-common example word as a sanity check the pool is real.
//
// Run: `node comboExpand.js`  (reports kept + rejects; prints the array to paste)

const fs = require('fs');
const path = require('path');

// The combos already shipping in gameLogic.js (keep in sync — used for dedupe +
// floor calibration). Mirrored here so this script is self-contained.
const EXISTING = [
  'an','er','in','th','ou','en','re','on','at','es','or','ti','al','ar','te','ne','de',
  'st','ed','nd','le','se','it','ch','sh','ck','ll','ss','ee','oo','ot','et','am','ad',
  'ow','ew','ay','ly','ge','nk','mb','kn','wr','ph','zz',
  'ion','ing','tion','ent','ant','all','igh','ous','ard','age','ack','ain','ast','and',
  'ill','ore','ine','ate','ide','ung','ump','ock','est','ess','ear','eat','ead','een',
  'our','out','own','end','ick','uck','eck','ash','ish','ush','ight','able','tch','ter',
  'der','ver','con','pre','pro','ink','ank','ake','ame','ome','one','ound',
  'ice','ure','str','scr','thr','squ','dge',
  'be','co','me','pe','ra','ro','li','lo','ma','mo','na','pa','sa','ta','un','up','ur',
  'um','ug','ub','ig','ip','ag','ol','el',
  'ble','tle','cle','kle','ple','ful','ment','ust','ost','ist','old','ild','und','orn',
  'ern','oat','oad','oot','ool','oom','oon','eep','eed','eel','eet','ail','air','oin',
  'oil','unk','unt','orm','ort','ord','ark','arm','art','amp','ang','ong',
];
const existingSet = new Set(EXISTING);

// Load the bot's common-word corpus (one word per line, lowercase, len>=3).
const WORDS = fs
  .readFileSync(path.join(__dirname, 'botWords.txt'), 'utf8')
  .split(/\r?\n/)
  .map((w) => w.trim().toLowerCase())
  .filter((w) => /^[a-z]+$/.test(w));

// Count how many corpus words contain `seq`, and grab the most common example
// (the corpus is frequency-ordered, so the first hit is the most common word).
function stats(seq) {
  let count = 0;
  let example = null;
  for (const w of WORDS) {
    if (w.includes(seq)) {
      count++;
      if (!example) example = w;
    }
  }
  return { count, example };
}

// --- Calibrate the floor from the existing combos -------------------------
// The easiest-shipping combo's word-count is our reference; require new combos
// to clear a comfortable fraction of it (and never below an absolute minimum).
const existingCounts = EXISTING.map((c) => ({ c, n: stats(c).count })).sort((a, b) => a.n - b.n);
const minExisting = existingCounts[0].n;
const FLOOR = Math.max(40, Math.round(minExisting * 0.9));

// --- Generate candidates: all 2- and 3-letter sequences -------------------
const A = 'abcdefghijklmnopqrstuvwxyz'.split('');
const candidates = [];
for (const x of A) for (const y of A) candidates.push(x + y);
for (const x of A) for (const y of A) for (const z of A) candidates.push(x + y + z);

const kept = [];
let dupes = 0;
let belowFloor = 0;
for (const seq of candidates) {
  if (existingSet.has(seq)) { dupes++; continue; }
  const { count, example } = stats(seq);
  if (count < FLOOR) { belowFloor++; continue; }
  kept.push({ seq, count, example, len: seq.length });
}

// Rank by frequency within each length; cap per length for a balanced batch.
const CAP_2 = 22;
const CAP_3 = 48;
const two = kept.filter((k) => k.len === 2).sort((a, b) => b.count - a.count).slice(0, CAP_2);
const three = kept.filter((k) => k.len === 3).sort((a, b) => b.count - a.count).slice(0, CAP_3);
const final = [...two, ...three];

console.log('=== combo expansion report ===');
console.log('corpus words:', WORDS.length);
console.log('easiest existing combo:', existingCounts[0].c, '→', minExisting, 'words');
console.log('FLOOR (>= words to keep):', FLOOR);
console.log('candidates scanned:', candidates.length, '| already-shipping (deduped):', dupes,
  '| rejected below floor:', belowFloor);
console.log('kept above floor:', kept.length, '→ batched (caps):', final.length,
  `(${two.length} two-letter, ${three.length} three-letter)`);
console.log('\n--- KEPT (seq : #words : example) ---');
for (const k of final) console.log(`  ${k.seq}\t${k.count}\t${k.example}`);

// A few illustrative REJECTS just above/at the boundary, to show the filter bit.
const rejectsSample = candidates
  .filter((s) => !existingSet.has(s))
  .map((s) => ({ s, ...stats(s) }))
  .filter((r) => r.count > 0 && r.count < FLOOR)
  .sort((a, b) => b.count - a.count)
  .slice(0, 8);
console.log('\n--- sample REJECTS (just under floor) ---');
for (const r of rejectsSample) console.log(`  ${r.s}\t${r.count}\t${r.example || '—'}`);

// Emit the array lines to paste into gameLogic.js (2- and 3-letter sub-batches).
const fmt = (arr) => arr.map((k) => `'${k.seq}'`).join(', ');
console.log('\n--- PASTE: 2-letter ---\n' + fmt(two));
console.log('\n--- PASTE: 3-letter ---\n' + fmt(three));

module.exports = { final };
