// judgeEvalFixture.js — labeled ground truth for the AI-judge eval (JOB 25).
// Each case: { category, answer, expected } where expected=true means "a generous party-game host
// SHOULD accept this" and expected=false means "should reject (clear non-member / gibberish)".
// These are COMMON-KNOWLEDGE judgements (soccer is a sport; a hammer is not a fruit), NOT invented
// game content — the fixture is the yardstick, not an accept-list. Grow it as real misjudgements show
// up in play. The ACCEPT cases deliberately mirror the prompt's stated must-accepts (regional/slang,
// misspellings, partial/abbreviated, plural) so a prompt regression that gets strict is caught.
module.exports = [
  // ---- SHOULD ACCEPT — regional / slang / brand-nickname synonyms ----
  { category: 'sports', answer: 'soccer', expected: true, note: 'US name for football' },
  { category: 'sports', answer: 'footy', expected: true, note: 'slang for football' },
  { category: 'sports', answer: 'ping pong', expected: true, note: 'common name for table tennis' },
  { category: 'car brands', answer: 'chevy', expected: true, note: 'nickname for Chevrolet' },
  { category: 'car brands', answer: 'beemer', expected: true, note: 'nickname for BMW' },
  { category: 'car brands', answer: 'vw', expected: true, note: 'abbreviation for Volkswagen' },
  { category: 'car brands', answer: 'merc', expected: true, note: 'nickname for Mercedes' },
  { category: 'vegetables', answer: 'aubergine', expected: true, note: 'UK name for eggplant' },
  { category: 'vegetables', answer: 'courgette', expected: true, note: 'UK name for zucchini' },
  { category: 'herbs', answer: 'cilantro', expected: true, note: 'US name for coriander' },

  // ---- SHOULD ACCEPT — misspellings / typos / missing accents ----
  { category: 'fruits', answer: 'bananna', expected: true, note: 'misspelling of banana' },
  { category: 'fruits', answer: 'strawbery', expected: true, note: 'misspelling of strawberry' },
  { category: 'foods', answer: 'spagetti', expected: true, note: 'misspelling of spaghetti' },
  { category: 'peppers', answer: 'jalapeno', expected: true, note: 'jalapeño without the tilde' },

  // ---- SHOULD ACCEPT — partial / abbreviated / plural / first-or-last-name ----
  { category: 'countries', answer: 'USA', expected: true, note: 'abbreviation' },
  { category: 'countries', answer: 'UK', expected: true, note: 'abbreviation' },
  { category: 'soccer players', answer: 'Ronaldo', expected: true, note: 'last-name-only, clear' },
  { category: 'soccer players', answer: 'Messi', expected: true, note: 'last-name-only, clear' },
  { category: 'soccer players', answer: 'Pele', expected: true, note: 'Pelé without the accent' },
  { category: 'animals', answer: 'cats', expected: true, note: 'plural form' },
  { category: 'animals', answer: 'doggo', expected: true, note: 'slang for dog' },

  // ---- SHOULD ACCEPT — straightforward valid members (sanity floor) ----
  { category: 'fruits', answer: 'apple', expected: true, note: 'obvious member' },
  { category: 'fruits', answer: 'kiwi', expected: true, note: 'obvious member' },
  { category: 'colors', answer: 'turquoise', expected: true, note: 'less-common but real color' },

  // ---- SHOULD REJECT — clear non-members (an obvious different kind of thing) ----
  { category: 'fruits', answer: 'hammer', expected: false, note: 'a tool, not a fruit' },
  { category: 'fruits', answer: 'running', expected: false, note: 'a verb, not a fruit' },
  { category: 'sports', answer: 'banana', expected: false, note: 'a fruit, not a sport' },
  { category: 'sports', answer: 'keyboard', expected: false, note: 'an object, not a sport' },
  { category: 'countries', answer: 'elephant', expected: false, note: 'an animal, not a country' },
  { category: 'countries', answer: 'pizza', expected: false, note: 'a food, not a country' },
  { category: 'car brands', answer: 'cucumber', expected: false, note: 'a vegetable, not a car brand' },
  { category: 'car brands', answer: 'trombone', expected: false, note: 'an instrument, not a car brand' },
  { category: 'animals', answer: 'screwdriver', expected: false, note: 'a tool, not an animal' },
  { category: 'animals', answer: 'helicopter', expected: false, note: 'a machine, not an animal' },
  { category: 'colors', answer: 'spaghetti', expected: false, note: 'a food, not a color' },
  { category: 'vegetables', answer: 'granite', expected: false, note: 'a rock, not a vegetable' },

  // ---- SHOULD REJECT — pure gibberish ----
  { category: 'fruits', answer: 'xqzptv', expected: false, note: 'gibberish' },
  { category: 'sports', answer: 'asdfgh', expected: false, note: 'gibberish' },
  { category: 'countries', answer: 'qwertyzzz', expected: false, note: 'gibberish' },
  { category: 'animals', answer: 'zzzzzz', expected: false, note: 'gibberish' },
];
