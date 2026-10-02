// blitzLists.js — Category Blitz is LIST-ONLY (STEP 9, Andy oct2): an answer scores only if it is on
// the category's list. No AI judge in scoring. So only categories whose membership is CLOSED and whose
// list is COMPLETE ship (blitzLists.json, curated + verified Oct 2 from BLITZ-ENUMERABILITY.tsv's
// enumerable set; the ~270 open-ended categories are gone — list-only on an open category rejects
// correct answers, e.g. dinosaurs 8/8). Every category carries 8 known-good and 8 known-junk answers,
// asserted by blitzLists.test.js.
//
// MATCHING KEY (answerKey): lowercase, accents stripped, "&" → "and", a leading "the" dropped, every
// non-alphanumeric removed — so "Spider-Man", "spiderman" and "spider man" are one answer and the lists
// never need punctuation/spacing variants. NUMBERED NAMES collapse too: "Henry VIII", "henry 8",
// "Henry the Eighth" and "henry 8th" are one key (so typing all four scores once). Roman numerals
// convert only AFTER the first word, so a name that starts with "I"/"V" is untouched. Nothing fuzzier:
// a near-miss is a miss.
const RAW = require('./blitzLists.json');

const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth',
  'nineteenth', 'twentieth'];
const ROMAN = /^(x{0,3})(ix|iv|v?i{0,3})$/;

function romanToInt(t) {
  if (!t || !ROMAN.test(t)) return null;
  const v = { i: 1, v: 5, x: 10 };
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    const a = v[t[i]];
    const b = v[t[i + 1]] || 0;
    n += a < b ? -a : a;
  }
  return n > 0 ? n : null;
}

function canonToken(tok, i) {
  const ord = ORDINAL.indexOf(tok);
  if (ord >= 0) return String(ord + 1);
  const m = /^(\d+)(st|nd|rd|th)$/.exec(tok);
  if (m) return m[1];
  if (i > 0) {
    const r = romanToInt(tok);
    if (r) return String(r);
  }
  return tok;
}

function answerKey(s) {
  const words = String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (words[0] === 'the') words.shift();
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1];
    // "henry the 8th" / "george the fifth": the ordinal's "the" is noise
    if (words[i] === 'the' && i > 0 && next && (ORDINAL.includes(next) || /^\d/.test(next))) continue;
    out.push(canonToken(words[i], out.length));
  }
  return out.join('');
}

const LISTS = new Map(); // category name -> { name, pack, answers: string[], keys: Set, good, junk }
for (const c of RAW) {
  const keys = new Set(c.answers.map(answerKey).filter(Boolean));
  LISTS.set(c.name, { ...c, keys });
}

const NAMES = [...LISTS.keys()].sort();

/** The curated list for a category (exact name), or null. */
function listFor(name) {
  return LISTS.get(name) || null;
}

/** Is `answer` on `category`'s list? */
function onList(category, answer) {
  const l = LISTS.get(category);
  if (!l) return false;
  const k = answerKey(answer);
  return k.length > 0 && l.keys.has(k);
}

module.exports = { answerKey, listFor, onList, NAMES, LISTS };
