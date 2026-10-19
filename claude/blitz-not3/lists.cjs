// claude/blitz-not3/lists.cjs — the third batch of Category Blitz NOT lists (Andy oct19 "need more of these genius
// ones"). Same shape build.cjs (copied from blitz-not2) expects: answers curated, funniest/most-typed first (bots play
// from the top), safe = the POSITIVE prompt (refused as safe_item with safeMsg), good = 8 curated, junk = 7 safe.
// One JSON per list in ./data (written by list agents, reviewed + blind-probed oct19).
const fs = require('fs');
const path = require('path');

// lists whose positive side is "everyday food" / "normal first names" borrow those whole lists as extra safe answers
const SAFE_FROM = {
  "Things you shouldn't put in your mouth": ['Fruits', 'Vegetables', 'Breakfast foods', 'Desserts', 'Snack foods',
    'Types of pasta', 'Types of bread', 'Types of cheese', 'Sandwiches', 'Pizza toppings', 'School cafeteria foods',
    'Breakfast cereals', 'Candy brands', 'Drinks (no alcohol)'],
  "Things you shouldn't name your baby": ['Popular baby names'],
};

const dir = path.join(__dirname, 'data');
module.exports = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
  const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const n = { name: c.name, safeMsg: c.safeMsg, answers: c.answers, safe: c.safe, good: c.good, junk: c.junk };
  if (SAFE_FROM[c.name]) n.safeFrom = SAFE_FROM[c.name];
  return n;
});
