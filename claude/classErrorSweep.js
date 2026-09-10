// claude/classErrorSweep.js — REPORT ONLY, deletes nothing.
//
// The "stuffed crust" class of error: an accept that is a CATEGORY of the thing rather than an
// INSTANCE of it — a style, a format, a container, or a brand's product line instead of a member
// of the list. Those make a category feel broken to a stranger, so this sweeps TIER 1 (broad)
// only: the categories a first-time player meets.
//
// Run: node claude/classErrorSweep.js          the actionable (high-confidence) list
//      node claude/classErrorSweep.js --all    plus contextual hits, for eyeballing
//      node claude/classErrorSweep.js --csv    machine-readable
//
// WHAT THIS CAN AND CANNOT DO. Keyword rules cannot tell "ground beef" (a real pizza topping)
// from "stuffed crust" (not one) — both are just a preparation word plus a noun. Two earlier
// versions of this script tried and produced ~90% false positives: one flagged all 25 "X seed"
// entries under Nuts and seeds, "small intestine" under Human organs and "large fries" under
// McDonald's menu items. So the signals here are deliberately narrow and split in two:
//   HIGH  — structural: the answer names a KIND, restates the category (every word in it is a
//           category word, so it distinguishes no member), or hedges.
//   LOW   — a container/size/preparation word appears. NOT evidence on its own; listed under
//           --all for a human to skim, never counted in the actionable total.
// Anything subtler than that needs a human or a model reading the category, not a word list.
const blitz = require('../categoryBlitzLogic');
const CATEGORY_ANSWERS = require('../categoryAnswers');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const singular = (w) => {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && /(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
};
// Leading articles carry no meaning here ("a juice box" === "juice box").
const words = (s) =>
  norm(s).split(' ').filter(Boolean).filter((w, i) => !(i === 0 && (w === 'a' || w === 'an' || w === 'the')));

// HIGH — words that name a KIND rather than a thing. Kept deliberately tight: 'range', 'series',
// 'collection', 'edition' and 'class' were dropped after they flagged "range rover" (Car brands)
// and "home on the range" (Disney movies).
const CLASSIFIER = new Set([
  // 'kind' was dropped: KIND is a real snack brand ("kind bar"), and "any kind of" is already
  // covered by the hedge regex below.
  'type', 'style', 'variety', 'sort', 'assorted', 'mixed', 'misc', 'miscellaneous',
  'other', 'various', 'generic', 'category', 'unspecified',
]);
// LOW — contextual only.
const CONTAINER = new Set(['bottle', 'can', 'jar', 'box', 'bag', 'carton', 'cup', 'tub', 'tin', 'packet', 'pack', 'tray', 'plate', 'bowl', 'pouch', 'container', 'cone']);
const SIZE = new Set(['small', 'medium', 'large', 'jumbo', 'mini', 'regular', 'king', 'family', 'double', 'triple', 'size', 'sized', 'portion', 'serving', 'slice', 'scoop']);
const MENU = new Set(['combo', 'meal', 'menu', 'special', 'deal', 'platter', 'sampler', 'entree', 'appetizer', 'starter', 'course', 'buffet']);
const PREP = new Set(['crust', 'baked', 'fried', 'grilled', 'roasted', 'toasted', 'steamed', 'boiled', 'frozen', 'canned', 'dried', 'smoked', 'crispy', 'stuffed', 'thin', 'thick', 'tossed', 'ground', 'chopped', 'sliced', 'diced']);

// Categories whose SUBJECT is a style/method/format — a classifier word is the right answer there.
const STYLE_IS_THE_POINT = new Set([
  'Cooking methods', 'Martial arts', 'Art movements', 'Shapes', 'States of matter',
  'Units of measurement', 'Musical notes', 'Types of eggs', 'Weather phenomena',
  'Types of Natural Disasters', 'Colors', 'Sports', 'Olympic sports', 'Winter Olympic sports',
  'Water sports', 'Human body systems', 'International cuisines', 'Types of sports balls',
]);

const STOP = new Set(['of', 'the', 'a', 'an', 'in', 'and', 'type', 'thing', 'that', 'with', 'come', 'popular', 'famous', 'major', 'us', 'world', 'from', 'your']);

// The category's content words: its HEAD noun (the last one) plus any MODIFIERS before it.
// "Pizza toppings" -> head "topping", modifier "pizza". A conjunction ("Nuts and seeds") is a
// LIST of heads with no modifier — which is why "pine nut" is correctly not flagged.
function categoryParts(category) {
  const ws = words(category).map(singular).filter((w) => w.length > 2 && !STOP.has(w));
  if (ws.length < 2 || /\band\b|&/.test(norm(category))) return { heads: new Set(ws), modifiers: new Set() };
  return { heads: new Set([ws[ws.length - 1]]), modifiers: new Set(ws.slice(0, -1)) };
}

function signalsFor(category, answer) {
  const ws = words(answer).map(singular);
  if (!ws.length) return { high: [], low: [] };
  const raw = norm(answer);
  const high = [];
  const low = [];
  const styleOk = STYLE_IS_THE_POINT.has(category);
  const { heads, modifiers } = categoryParts(category);

  if (!styleOk && ws.some((w) => CLASSIFIER.has(w))) high.push('classifier');
  // Only genuine hedges. A bare "all " matched real names — All-Bran, All Stars, All Might.
  if (/\betc\b|\band more\b|\bany kind\b|\ball kinds?\b|\bor similar\b|\bor whatever\b/.test(raw)) high.push('hedged');
  // RESTATES THE CATEGORY: every content word in the answer is a word from the category name, so
  // the answer carries nothing that distinguishes a member — "candy bar" under Candy bars, "the
  // talk" under Talk shows, "pizza" under Pizza toppings.
  //
  // It is a SUBSET test on purpose. Merely CONTAINING a category word is normal and fine:
  // "breakfast burrito" is a breakfast food, "water polo" is a water sport, "apple watch" is an
  // Apple product. An earlier version flagged all three (114 hits, nearly all wrong) by treating
  // any occurrence of the modifier as the error.
  const categoryWords = new Set([...heads, ...modifiers]);
  if (ws.every((w) => categoryWords.has(w))) high.push('restates-category');

  if (ws.some((w) => CONTAINER.has(w))) low.push('container');
  if (ws.some((w) => SIZE.has(w))) low.push('size');
  if (ws.some((w) => MENU.has(w))) low.push('menu-item');
  if (!styleOk && ws.some((w) => PREP.has(w))) low.push('prep/style');

  return { high: [...new Set(high)], low: [...new Set(low)] };
}

const args = process.argv.slice(2);
const showAll = args.includes('--all');
const asCsv = args.includes('--csv');

const tier1 = blitz.CATEGORIES.filter((c) => blitz.CATEGORY_TIER[c] === 1).sort();
const rows = [];
for (const category of tier1) {
  const set = CATEGORY_ANSWERS[category];
  if (!set) continue;
  const high = [];
  const low = [];
  for (const answer of set) {
    const sig = signalsFor(category, answer);
    if (sig.high.length) high.push({ answer, signals: sig.high });
    else if (sig.low.length) low.push({ answer, signals: sig.low });
  }
  high.sort((a, b) => a.answer.localeCompare(b.answer));
  low.sort((a, b) => a.answer.localeCompare(b.answer));
  if (high.length || (showAll && low.length)) rows.push({ category, size: set.size, high, low });
}
rows.sort((a, b) => b.high.length - a.high.length || b.low.length - a.low.length || a.category.localeCompare(b.category));

if (asCsv) {
  console.log('category,answer,confidence,signals');
  for (const r of rows) {
    for (const h of r.high) console.log(`"${r.category}","${h.answer}",high,"${h.signals.join('|')}"`);
    if (showAll) for (const l of r.low) console.log(`"${r.category}","${l.answer}",low,"${l.signals.join('|')}"`);
  }
} else {
  const totalHigh = rows.reduce((n, r) => n + r.high.length, 0);
  const totalLow = rows.reduce((n, r) => n + r.low.length, 0);
  console.log('CLASS-ERROR SWEEP — tier 1 (broad) only. REPORT ONLY, nothing deleted.');
  console.log(`${tier1.length} tier-1 categories scanned · ${rows.filter((r) => r.high.length).length} with actionable hits · ${totalHigh} answers`);
  if (showAll) console.log(`plus ${totalLow} contextual hits (container/size/prep words — usually fine)`);
  console.log('');
  for (const r of rows) {
    if (!r.high.length && !showAll) continue;
    console.log(`${String(r.high.length).padStart(3)}  ${r.category}  (${r.size} accepts)`);
    for (const h of r.high) console.log(`      ${h.answer}   [${h.signals.join(', ')}]`);
    if (showAll && r.low.length) {
      console.log('      -- contextual, probably fine --');
      for (const l of r.low) console.log(`      ~ ${l.answer}   [${l.signals.join(', ')}]`);
    }
  }
  console.log('');
  console.log('HIGH (actionable): classifier = names a KIND; restates-category = every content');
  console.log('word in the answer is a category word, so it distinguishes no member;');
  console.log('hedged = "etc"/"and more". Style-subject categories are exempt from classifier.');
  console.log('CONTEXTUAL (--all): container/size/menu/prep words — not evidence on their own.');
}
