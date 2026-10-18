// blitzNot.test.js — Category Blitz NOT categories (Andy oct17): any real noun or person joke scores, an answer that
// fits the POSITIVE prompt is refused as safe_item with the list's own toast, non-nouns and gibberish stay out — and
// every other list is untouched. Exercised through the real submitAnswer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const L = require('./categoryBlitzLogic');
const BLITZ = require('./blitzLists');
const NOT = require('./blitzNot');

const MICRO = "Things you shouldn't microwave";
const NOT_LISTS = [MICRO, "Things you shouldn't bring to a funeral", "Things you don't want to find in your bed",
  "Things you don't want to find in your food", "Things you shouldn't flush down the toilet"];

function freshGame(category) {
  const g = L.createGame([{ id: 'p1', name: 'P1' }], 'easy', true);
  g.currentCategory = category;
  return g;
}
const submit = (category, a) => L.submitAnswer(freshGame(category), 'p1', a);

test('the five NOT lists are in play, each with a safe set and its own toast', () => {
  for (const n of NOT_LISTS) {
    assert.ok(L.CATEGORIES.includes(n), `${n} in play`);
    assert.ok(NOT.isNotList(n), `${n} is a NOT list`);
    assert.ok(BLITZ.listFor(n).safeMsg, `${n} has a safe_item toast`);
    assert.ok(NOT.SAFE.get(n).size >= 8, `${n} safe set`);
  }
  assert.equal(NOT.isNotList('Fruits'), false);
});

// batch 2 (oct18): every NOT list — not just the first five — carries a toast, a real safe set, and blind-probe coverage
test('every NOT list in play has a toast, a safe set of 30+ and a blind-probe fixture', () => {
  const probe = JSON.parse(fs.readFileSync(path.join(__dirname, 'tests', 'fixtures', 'blitzNotProbe.json'), 'utf8'));
  const all = L.CATEGORIES.filter((c) => NOT.isNotList(c));
  assert.ok(all.length >= 19, `${all.length} NOT lists`);
  for (const n of all) {
    assert.ok(BLITZ.listFor(n).safeMsg, `${n} has a safe_item toast`);
    assert.ok(NOT.SAFE.get(n).size >= (NOT_LISTS.includes(n) ? 8 : 30), `${n} safe set`);
    assert.ok((probe[n] || []).length >= 40, `${n} blind-probed`);
  }
});

test('batch 2: the obvious "that\'s actually fine" answers are refused with the list toast', async () => {
  const cases = {
    "Things you shouldn't put in a washing machine": ['socks', 'towels', 'dirty laundry', 'a hoodie'],
    "Things you shouldn't bring on a plane": ['passport', 'a neck pillow', 'headphones', 'snacks'],
    "Things you shouldn't feed a dog": ['dog food', 'kibble', 'a bone', 'peanut butter'],
    "Things you shouldn't put in a fish tank": ['fish', 'gravel', 'a castle', 'fish food'],
    "Things you shouldn't wear to a job interview": ['a suit', 'a tie', 'dress shoes', 'blazer'],
    "Things you shouldn't bring to the beach": ['sunscreen', 'a towel', 'an umbrella', 'a cooler'],
    "Things you shouldn't put on a pizza": ['cheese', 'pepperoni', 'mushrooms', 'extra cheese'],
    "Things you don't want to step on barefoot": ['grass', 'carpet', 'a rug', 'sand'],
    "Things you shouldn't bring to a sleepover": ['pillow', 'a sleeping bag', 'pajamas', 'snacks'],
    "Things you shouldn't put in your pocket": ['phone', 'my keys', 'wallet', 'coins'],
    "Things you don't want to find in your shoe": ['foot', 'a sock', 'insoles', 'shoelace'],
    "Things you shouldn't bring on a first date": ['flowers', 'chocolates', 'wallet', 'cologne'],
    "Things you shouldn't pet": ['dog', 'a puppy', 'kitten', 'a golden retriever'],
    "Things you shouldn't put in a blender": ['banana', 'ice', 'strawberries', 'protein powder'],
  };
  for (const [n, xs] of Object.entries(cases)) {
    for (const a of xs) {
      const r = await submit(n, a);
      assert.equal(r.reason, 'safe_item', `${n}: "${a}" -> ${r.accepted ? 'scored' : r.reason}`);
      assert.equal(r.message, BLITZ.listFor(n).safeMsg);
    }
  }
  // and the joke lands: the curated meme beats the safe set, and a clause no longer hides the head noun
  assert.equal((await submit("Things you shouldn't put on a pizza", 'pineapple')).accepted, true);
  assert.equal((await submit("Things you shouldn't wear to a job interview", 'a shirt that says lol')).accepted, true);
});

test('any real noun scores — off the curated list too — and so do people and "me"', async () => {
  const offList = ['trombone', 'my homework', 'a giraffe', 'me', 'myself', 'my little brother', 'grandma', 'the principal',
    'a bowling ball', 'a snowman', 'kazoo', 'theremin', 'nunchucks', 'my report card'];
  for (const n of NOT_LISTS) {
    for (const a of offList) {
      const r = await submit(n, a);
      assert.equal(r.accepted, true, `${n}: "${a}" refused (${r.reason})`);
    }
  }
});

test('an answer that fits the positive prompt is refused as safe_item with the list toast', async () => {
  const cases = {
    [MICRO]: ['popcorn', 'leftovers', 'soup', 'a mug', 'water', 'coffee', 'oatmeal', 'pizza'],
    "Things you shouldn't bring to a funeral": ['flowers', 'tissues', 'a black suit', 'sympathy card'],
    "Things you don't want to find in your bed": ['pillow', 'a blanket', 'sheets', 'teddy bear'],
    "Things you don't want to find in your food": ['cheese', 'sprinkles', 'bacon', 'salt'],
    "Things you shouldn't flush down the toilet": ['toilet paper', 'poop', 'pee', 'vomit'],
  };
  for (const [n, xs] of Object.entries(cases)) {
    for (const a of xs) {
      const r = await submit(n, a);
      assert.equal(r.accepted, false, `${n}: "${a}" scored`);
      assert.equal(r.reason, 'safe_item', `${n}: "${a}" -> ${r.reason}`);
      assert.equal(r.message, BLITZ.listFor(n).safeMsg);
    }
  }
  assert.equal((await submit(MICRO, 'soup')).message, 'YOU CAN MICROWAVE THAT 🙄');
});

test('curated answers always win over the safe set (eggs and grapes DO explode)', async () => {
  for (const a of ['eggs', 'grapes', 'metal', 'fork', 'a hot dog']) assert.equal((await submit(MICRO, a)).accepted, true, a);
  for (const n of NOT_LISTS) for (const k of BLITZ.listFor(n).keys) assert.ok(!NOT.SAFE.get(n).has(k), `${n}: "${k}" curated AND safe`);
});

test('non-nouns, chat-speak and gibberish stay out', async () => {
  for (const a of ['quickly', 'happy', 'lol', 'idk', 'bruh', 'yes', 'never', 'hello', 'asdfgh', 'zzzzzzzz', 'qwerty uiop', 'bleeblorp']) {
    const r = await submit(MICRO, a);
    assert.equal(r.accepted, false, `"${a}" scored`);
    assert.equal(r.reason, 'not_on_list', `"${a}" -> ${r.reason}`);
  }
});

test('a blocked word sinks the whole answer, even riding on a real noun', async () => {
  for (const a of ['shit phone', 'my damn dog', 'porn mag']) {
    const r = await submit(MICRO, a);
    assert.equal(r.accepted, false, `"${a}" scored`);
    assert.equal(r.reason, 'family_friendly', `"${a}" -> ${r.reason}`); // TOP ∞ = family-friendly answers
  }
});

test('one meaning scores once: "dog" then "my dog" is already said', async () => {
  const g = freshGame(MICRO);
  assert.equal((await L.submitAnswer(g, 'p1', 'trombone')).accepted, true);
  assert.equal((await L.submitAnswer(g, 'p1', 'a trombone')).reason, 'already_said');
});

test('every other list is unchanged: off-list nouns still miss', async () => {
  for (const [c, a] of [['Fruits', 'trombone'], ['NFL teams', 'zzzz cowboys'], ['Things that break easily', 'anvil']]) {
    const r = await submit(c, a);
    assert.equal(r.accepted, false, `${c}: "${a}"`);
    assert.equal(r.reason, 'not_on_list');
  }
});

// The fixture is every guess blind-probe "players" typed for these prompts (oct17, never shown the lists). A guess that
// fits the POSITIVE prompt (kids do type "water" for "shouldn't microwave") is a designed safe_item reject; what must
// not happen is a real noun bouncing as NOT ON THE LIST.
test('blind-probe regression: under 3% of real players\' guesses miss as NOT ON THE LIST on any NOT list', async () => {
  const probe = JSON.parse(fs.readFileSync(path.join(__dirname, 'tests', 'fixtures', 'blitzNotProbe.json'), 'utf8'));
  for (const [n, guesses] of Object.entries(probe)) {
    const missed = [];
    for (const a of guesses) {
      const r = await submit(n, a);
      if (!r.accepted && r.reason === 'not_on_list') missed.push(a);
    }
    assert.ok(missed.length / guesses.length < 0.03, `${n}: ${missed.length}/${guesses.length} missed — ${missed.join(', ')}`);
  }
});
