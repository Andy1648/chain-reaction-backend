// imposterPairsExpand.js  [night/content-expand]
// Generator + machine-filter for NEW Imposter Word category PAIRS.
//
// THE PAIR RULE (matches the established CATEGORY_PAIRS in imposterWordLogic.js):
//   Each pair is { real, fake } where the two halves are CLOSE but
//   DISTINGUISHABLE — two categories whose answer-vibes overlap hard, so the
//   imposter (who only knows "blend in") can hide in the shared overlap, but a
//   sharp table can still catch a wrong-side answer. Pairs that are too IDENTICAL
//   (no daylight to catch the imposter) or too OBVIOUS (no overlap to hide in)
//   are bad. Answers are human-voted, so phrase-style categories are fine here
//   (unlike Category Blitz). School-appropriate; recognizable, not obscure.
//
// The "close but distinguishable" calibration is curated into the CANDIDATES
// below (mirroring the existing good pairs). This script enforces the MECHANICAL
// rules: well-formed, real != fake, and not a duplicate of an existing pair.
//
// Run: `node imposterPairsExpand.js`  (reports kept + rejects; prints to paste)

const fs = require('fs');
const path = require('path');

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Pull existing pairs straight from the source so dedupe is always current.
const src = fs.readFileSync(path.join(__dirname, 'imposterWordLogic.js'), 'utf8');
const seg = src.match(/const CATEGORY_PAIRS = \[([\s\S]*?)\n\];/)[1];
const existing = [...seg.matchAll(/\{\s*real:\s*(['"])(.*?)\1,\s*fake:\s*(['"])(.*?)\3\s*\}/g)]
  .map((m) => ({ real: m[2], fake: m[4] }));
const existingReal = new Set(existing.map((p) => norm(p.real)));
const existingPairKey = new Set(existing.map((p) => [norm(p.real), norm(p.fake)].sort().join(' || ')));

// Curated candidates — tight, reactable overlaps across the established themes.
const CANDIDATES = [
  // Oddly specific / relatable
  { real: "Things you do when you can't sleep", fake: "Things you do when you're bored in class" },
  { real: 'Things in your school backpack', fake: 'Things in your gym bag' },
  { real: 'Things you say when you lose a game', fake: 'Things you say when you win a game' },
  { real: 'Things you forget to pack for a trip', fake: 'Things you forget at school' },
  { real: 'Things you do during a fire drill', fake: 'Things you do during a power outage' },
  { real: 'Things you hide from your parents', fake: 'Things you hide from your roommate' },
  { real: 'Things you say to get out of chores', fake: 'Things you say to skip the gym' },
  { real: 'Things you keep in your car', fake: 'Things you keep in your locker' },
  { real: 'Things you do in a waiting room', fake: 'Things you do in a long line' },
  { real: 'Things people do at a red light', fake: 'Things people do in an elevator' },
  // Specific pop culture
  { real: 'Pixar movies', fake: 'DreamWorks movies' },
  { real: 'Marvel villains', fake: 'DC villains' },
  { real: 'Things in a Zelda game', fake: 'Things in a Mario game' },
  { real: 'Taylor Swift songs', fake: 'Olivia Rodrigo songs' },
  { real: 'Things in Stranger Things', fake: 'Things in a horror movie' },
  { real: 'SpongeBob locations', fake: 'Simpsons locations' },
  { real: 'Disney sidekicks', fake: 'Disney villains' },
  { real: 'Mario Kart items', fake: 'Smash Bros items' },
  // Absurd but answerable
  { real: 'Worst superpowers', fake: 'Useless inventions' },
  { real: 'Things a villain monologues about', fake: 'Things a coach yells at halftime' },
  { real: "Things in a dragon's hoard", fake: "Things in a pirate's treasure" },
  { real: 'Things a robot would misunderstand', fake: 'Things an alien would misunderstand' },
  { real: 'Reasons the wifi is down', fake: 'Reasons the bus is late' },
  { real: "Things you'd ban as president", fake: "Things you'd ban as a teacher" },
  // Niche knowledge that's still fun
  { real: 'Greek gods', fake: 'Roman gods' },
  { real: 'Things on a Monopoly board', fake: 'Things in the game of Life' },
  { real: 'Planets in the solar system', fake: 'Moons in the solar system' },
  { real: 'Constellations', fake: 'Zodiac signs' },
  { real: 'Countries in Africa', fake: 'Countries in South America' },
  { real: 'Dog breeds', fake: 'Cat breeds' },
  { real: 'Types of clouds', fake: 'Types of storms' },
  { real: 'Famous paintings', fake: 'Famous sculptures' },
  // Scenario / vibe overlaps
  { real: 'Sounds at a carnival', fake: 'Sounds at an arcade' },
  { real: 'Smells at a campsite', fake: 'Smells at a barbecue' },
  { real: 'Things at a wedding', fake: 'Things at a prom' },
  { real: 'Things at a birthday party', fake: "Things at a New Year's party" },
  { real: 'Things you see at the beach', fake: 'Things you see at a pool' },
  { real: "Things at a farmers' market", fake: 'Things at a flea market' },
  { real: 'Things at a concert', fake: 'Things at a festival' },
  { real: 'Things on a road trip', fake: 'Things on a camping trip' },
  { real: 'Things in a hospital', fake: "Things in a dentist's office" },
  { real: 'Things at an airport', fake: 'Things at a train station' },
  { real: 'Things in a haunted house', fake: 'Things in a graveyard' },
  { real: 'Things at a sleepover', fake: 'Things at summer camp' },
  { real: 'Things in a science classroom', fake: 'Things in an art classroom' },
  { real: 'Things at a football game', fake: 'Things at a basketball game' },
  { real: 'Things in a movie theater', fake: 'Things at a bowling alley' },
  { real: 'Things in a kitchen', fake: 'Things in a garage' },
  { real: 'Things at a zoo', fake: 'Things at an aquarium' },
  { real: 'Things in a barbershop', fake: 'Things in a nail salon' },
  { real: 'Things in a gym', fake: 'Things in a locker room' },
];

const kept = [];
const rejects = [];
const keptKeys = new Set();
for (const p of CANDIDATES) {
  const reasons = [];
  if (!p.real || !p.fake) reasons.push('missing real/fake');
  if (norm(p.real) === norm(p.fake)) reasons.push('real == fake (no daylight)');
  const key = [norm(p.real), norm(p.fake)].sort().join(' || ');
  if (existingPairKey.has(key) || keptKeys.has(key)) reasons.push('duplicate pair');
  if (existingReal.has(norm(p.real)) && !reasons.includes('duplicate pair'))
    reasons.push(`'real' reused by an existing pair`);
  if (reasons.length) { rejects.push({ p, reasons }); continue; }
  kept.push(p);
  keptKeys.add(key);
}

console.log('=== imposter pairs expansion report ===');
console.log('existing pairs:', existing.length);
console.log('candidates:', CANDIDATES.length, '| kept:', kept.length, '| rejected:', rejects.length);
console.log('new total:', existing.length + kept.length);
console.log('\n--- REJECTS ---');
for (const r of rejects) console.log(`  REJECT: ${r.p.real} / ${r.p.fake} — ${r.reasons.join('; ')}`);

// Emit lines matching the file style: double-quote a string only if it contains
// a single quote, else single-quote it.
const q = (s) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);
console.log('\n--- PASTE into CATEGORY_PAIRS ---');
for (const p of kept) console.log(`  { real: ${q(p.real)}, fake: ${q(p.fake)} },`);

module.exports = { kept };
