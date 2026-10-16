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

// PLURAL FOLD (proposal, oct15 night — Andy to decide): "cows"/"cow", "daisies"/"daisy", "foxes"/"fox"
// share one key, so a plural scores on a singular list and saying both forms scores ONCE. Measured on
// the 334 lists in play: 97% of single-word answers rejected their plural, and 79 lists counted both
// forms as two separate points. NOT folded: wordplay lists (every spelling is its own word there), any
// list whose own junk would fold onto an answer, model suffixes after a digit (iPhone 4 vs 4S), and
// NO_FOLD — real names that only look plural (Chaos, Xbox One S, GTA VCS).
const NO_FOLD = new Set(['chaos', 'xboxones', 'gtavcs']);
function foldKey(k) {
  if (NO_FOLD.has(k) || /\ds$/.test(k)) return k;
  if (k.length > 4 && k.endsWith('ies')) return k.slice(0, -3) + 'y';
  if (k.length > 4 && /(sses|xes|zes|ches|shes|oes)$/.test(k)) return k.slice(0, -2);
  if (k.length > 3 && k.endsWith('s') && !k.endsWith('ss')) return k.slice(0, -1);
  return k;
}

// PHRASE KEY (oct16, measured: blind "typical player" answers on the phrase lists — Household chores 40% accepted,
// "making the bed" vs "make bed"): little words dropped (the, a, your, my …) and each word stemmed the same crude way
// on both sides (making/make → mak, cleaning → clean, chores → chor), so a phrase scores however it is worded. Only an
// extra ACCEPT path on non-wordplay lists, never on a list whose own junk would match; dedupe uses it on those lists so
// "make bed" + "making the bed" score once.
const STOP = new Set(['the', 'a', 'an', 'your', 'my', 'his', 'her', 'their', 'our', 'some', 'someone', 'someones', 'ur', 'yo']);
// each word → its candidate stems. A plain word is only plural-folded; an -ing / -ed word also offers its "+e" and
// un-doubled forms (making → mak | make, running → runn | run), so "make" ↔ "making" match but "cap" ↔ "cape" and
// "ice" ↔ "icee" never do.
function wordForms(w) {
  if (NO_FOLD.has(w)) return [w];
  // -ies / -oes / -ves offer every singular they can come from: cookies → cooky | cookie, shoes → sho | shoe,
  // wolves → wolf | wolfe | wolve (knives → knif | knife)
  if (w.length > 4 && w.endsWith('ies')) return [w.slice(0, -3) + 'y', w.slice(0, -1)];
  if (w.length > 4 && w.endsWith('oes')) return [w.slice(0, -2), w.slice(0, -1)];
  if (w.length > 4 && w.endsWith('ves')) return [w.slice(0, -3) + 'f', w.slice(0, -3) + 'fe', w.slice(0, -1)];
  const m = (w.length > 5 && /ing$/.test(w)) ? w.slice(0, -3) : (w.length > 4 && /ed$/.test(w)) ? w.slice(0, -2) : null;
  if (m) {
    const out = [m, m + 'e'];
    if (/([b-df-hj-np-tv-z])\1$/.test(m)) out.push(m.slice(0, -1));
    return out;
  }
  if (w.length > 4 && /(sses|xes|zes|ches|shes|oes)$/.test(w)) return [w.slice(0, -2)];
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return [w.slice(0, -1)];
  return [w];
}
/** Every phrase key an answer can match on (≤ 9: at most two -ing/-ed words branch). */
function phraseKeys(s) {
  const words = String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !STOP.has(w));
  let keys = [''];
  let branched = 0;
  for (const w of words) {
    let f = wordForms(w);
    if (f.length > 1 && ++branched > 2) f = f.slice(0, 1);
    keys = keys.flatMap((k) => f.map((x) => k + x));
  }
  return keys.filter(Boolean);
}
const phraseKey = (s) => phraseKeys(s)[0] || '';

const LISTS = new Map(); // category name -> { name, pack, answers: string[], keys: Set, folded: Set|null, good, junk }
for (const c of RAW) {
  const keys = new Set(c.answers.map(answerKey).filter(Boolean));
  let folded = null;
  if (c.pack !== 'wordplay') {
    folded = new Set([...keys].map(foldKey));
  }
  let phrased = null; // phrase key → the dedupe id of the answer it belongs to
  if (c.pack !== 'wordplay') {
    phrased = new Map();
    for (const a of c.answers) {
      const ks = phraseKeys(a);
      const id = ks.map((k) => phrased.get(k)).find(Boolean) || ks[0];
      for (const k of ks) if (!phrased.has(k)) phrased.set(k, id);
    }
  }
  // a list's own JUNK never scores — refused by its exact key, so one junk word that folds onto a real answer ("glass"
  // vs "glasses") no longer switches plural / phrase matching off for the whole list (oct16: "Things you can fold"
  // refused "towels" for that reason)
  const junkKeys = new Set((c.junk || []).map(answerKey).filter((k) => k && !keys.has(k)));
  LISTS.set(c.name, { ...c, keys, folded, phrased, junkKeys });
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
  if (k.length === 0) return false;
  if (l.keys.has(k)) return true;
  if (l.junkKeys.has(k)) return false;
  return (l.folded != null && l.folded.has(foldKey(k))) || (l.phrased != null && phraseKeys(answer).some((pk) => l.phrased.has(pk)));
}

/** The key two answers must share to count as the SAME answer on `category` (the dedupe key). */
function sameAnswerKey(category, answer) {
  const k = answerKey(answer);
  const l = LISTS.get(category);
  if (l && l.phrased) {
    const ks = phraseKeys(answer);
    return 'p:' + (ks.map((pk) => l.phrased.get(pk)).find(Boolean) || ks[0] || k);
  }
  return l && l.folded ? foldKey(k) : k;
}

module.exports = { answerKey, foldKey, phraseKey, phraseKeys, sameAnswerKey, listFor, onList, NAMES, LISTS };
