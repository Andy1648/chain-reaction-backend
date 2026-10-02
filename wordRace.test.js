// wordRace.test.js - the pure WORD RACE state machine (no timers, no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const race = require('./wordRace');
const { isBlockedForDisplay } = require('./blockedTerms');

const RACERS = [
  { id: 'a', name: 'ANNA' },
  { id: 'b', name: 'BO' },
];

// Word that contains the fragment: fragment itself padded to >= 3 letters.
const wordFor = (frag, salt = '') => `${frag}${salt}xyz`.slice(0, Math.max(3, frag.length + salt.length + 1));

function liveRace(opts) {
  const r = race.createRace(RACERS, { seed: 42, ...opts });
  race.goLive(r, 1000);
  return r;
}

test('pools: e/m/h only, 2-3 lowercase letters, no blocked fragment, all above floor', () => {
  const pools = race.getPools();
  assert.deepEqual(Object.keys(pools), ['e', 'm', 'h']);
  const top = require('./wordBombBot')._loadWords().slice(0, race.MIN_RANK);
  for (const tier of race.TIERS) {
    assert.ok(pools[tier].length >= 60, `${tier} pool too small: ${pools[tier].length}`);
    for (const f of pools[tier]) {
      assert.match(f, /^[a-z]{2,3}$/);
      assert.equal(isBlockedForDisplay(f), false, f);
      const n = top.filter((w) => w.includes(f)).length;
      assert.ok(n >= race.FLOORS[tier], `${tier} "${f}" has only ${n} solutions`);
    }
  }
});

test('floors drop a fragment that is under its tier floor', () => {
  const pools = race.buildPools(['cat', 'car', 'cart']);
  assert.equal(pools.e.length, 0, 'three words cannot satisfy a 30-solution floor');
});

test('same seed -> identical sequence; different seed -> different', () => {
  const a = race.buildSequence(7);
  const b = race.buildSequence(7);
  const c = race.buildSequence(8);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.fragments, c.fragments);
  assert.equal(a.fragments.length, race.TARGET_WORDS);
});

test('sequence has no repeated fragment and ramps easy -> hard', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const { fragments, tiers } = race.buildSequence(seed);
    assert.equal(new Set(fragments).size, fragments.length, `seed ${seed} repeats`);
    assert.equal(tiers[0], 'e', 'slot 0 is always easy');
    assert.equal(tiers[tiers.length - 1], 'h', 'last slot is always hard');
    for (let i = 1; i < tiers.length; i++) {
      assert.ok(race.TIERS.indexOf(tiers[i]) >= race.TIERS.indexOf(tiers[i - 1]) - 1);
    }
  }
});

test('race starts in countdown; words are rejected until go', () => {
  const r = race.createRace(RACERS, { seed: 1 });
  assert.equal(r.status, 'countdown');
  assert.equal(race.checkWord(r, 'a', 'anything').reason, 'race_not_live');
  assert.equal(race.goLive(r, 500), true);
  assert.equal(race.goLive(r, 600), false, 'go is one-shot');
  assert.equal(r.goAt, 500);
});

test('checkWord names each local reject reason', () => {
  const r = liveRace();
  const frag = r.fragments[0];
  assert.equal(race.checkWord(r, 'zz', 'whatever').reason, 'not_a_racer');
  assert.equal(race.checkWord(r, 'a', 'ab').reason, 'too_short');
  const miss = 'qqq';
  assert.ok(!miss.includes(frag));
  assert.equal(race.checkWord(r, 'a', miss).reason, 'missing_combo');
  const w = wordFor(frag);
  assert.deepEqual(race.checkWord(r, 'a', `  ${w.toUpperCase()} `), { word: w, reason: null });
});

test('accept advances only that racer; the same word stays legal for the other racer', () => {
  const r = liveRace();
  const frag = r.fragments[0];
  const w = wordFor(frag);
  race.applyAccept(r, 'a', w, 2500);
  assert.equal(race.getRacer(r, 'a').index, 1);
  assert.equal(race.getRacer(r, 'a').reachedAt, 1500);
  assert.equal(race.getRacer(r, 'b').index, 0);
  // B is still on fragment 0 and may play A's word.
  assert.equal(race.checkWord(r, 'b', w).reason, null);
  race.applyAccept(r, 'b', w, 3000);
  assert.equal(race.getRacer(r, 'b').index, 1);
});

test('already_used is per racer', () => {
  const r = liveRace({ pools: { e: ['ab'], m: ['ab'], h: ['ab'] }, target: 3 });
  // Every slot is "ab" only if pools repeat - use a hand-built race instead.
  r.fragments = ['ab', 'ab', 'ab'];
  race.applyAccept(r, 'a', 'cab', 2000);
  assert.equal(race.checkWord(r, 'a', 'cab').reason, 'already_used');
  assert.equal(race.checkWord(r, 'b', 'cab').reason, null);
});

test('first to the target wins and finishes the race', () => {
  const r = liveRace({ target: 3 });
  for (let i = 0; i < 2; i++) race.applyAccept(r, 'b', wordFor(r.fragments[i], String.fromCharCode(97 + i)), 2000 + i);
  for (let i = 0; i < 3; i++) {
    const res = race.applyAccept(r, 'a', wordFor(r.fragments[i], String.fromCharCode(100 + i)), 3000 + i);
    assert.equal(res.finished, i === 2);
  }
  assert.equal(r.status, 'finished');
  assert.equal(r.winnerId, 'a');
  assert.equal(r.endReason, 'finish');
  assert.equal(race.checkWord(r, 'b', 'anything').reason, 'race_not_live');
  const s = race.standings(r);
  assert.deepEqual(s.map((x) => [x.id, x.place, x.words]), [['a', 1, 3], ['b', 2, 2]]);
});

test('at the cap, most words wins; a tie goes to whoever reached it first', () => {
  const r = liveRace();
  race.applyAccept(r, 'b', wordFor(r.fragments[0], 'q'), 5000);
  race.applyAccept(r, 'a', wordFor(r.fragments[0], 'r'), 4000);
  race.finish(r, 'cap', 91000);
  assert.equal(r.winnerId, 'a', 'a reached 1 word at 3000ms, b at 4000ms');
  assert.equal(r.endReason, 'cap');
});

test('cap with nobody scoring has no winner', () => {
  const r = liveRace();
  race.finish(r, 'cap', 91000);
  assert.equal(r.winnerId, null);
  assert.equal(race.finish(r, 'cap', 92000), false, 'finish is one-shot');
});

test('a racer who left ranks last and cannot win at the cap', () => {
  const r = liveRace();
  race.applyAccept(r, 'a', wordFor(r.fragments[0], 's'), 2000);
  assert.equal(race.markLeft(r, 'a'), 1);
  assert.equal(race.checkWord(r, 'a', 'whatever').reason, 'not_a_racer');
  race.finish(r, 'forfeit', 3000);
  assert.equal(race.standings(r)[1].id, 'a');
  assert.equal(r.winnerId, null, 'b has 0 words');
});

test('only MAX_RACERS race; addRacer refuses a 6th and duplicates', () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  const r = race.createRace(many, { seed: 3 });
  assert.equal(r.racers.length, race.MAX_RACERS);
  assert.equal(race.addRacer(r, { id: 'x', name: 'X' }), false);
  const r2 = race.createRace(RACERS, { seed: 3 });
  assert.equal(race.addRacer(r2, { id: 'a', name: 'A' }), false);
  assert.equal(race.addRacer(r2, { id: 'c', name: 'C', isBot: true }), true);
  assert.equal(race.getRacer(r2, 'c').isBot, true);
});

test('bot fill: fewer than 2 humans -> fill to 3 racers', () => {
  assert.equal(race.botsNeeded(0), 3);
  assert.equal(race.botsNeeded(1), 2);
  assert.equal(race.botsNeeded(2), 0);
  assert.equal(race.botsNeeded(5), 0);
});

test('bot pace seeds from the humans and is clamped', () => {
  assert.equal(race.seedPace([]), race.DEFAULT_PACE_MS);
  assert.equal(race.seedPace([undefined, 'junk']), race.DEFAULT_PACE_MS);
  assert.equal(race.seedPace([3000]), 3000);
  assert.equal(race.seedPace([2000, 4000]), 3000);
  assert.equal(race.seedPace([10]), 1500);
  assert.equal(race.seedPace([1e9]), 15000);
  const fast = race.botWordDelayMs(2000, 1, 'e', () => 0);
  const slow = race.botWordDelayMs(8000, 1, 'e', () => 0);
  assert.ok(slow > fast * 3);
  assert.ok(race.botWordDelayMs(2000, 1, 'h', () => 0.5) > race.botWordDelayMs(2000, 1, 'e', () => 0.5));
});

// ---- WHOLE-WORD variant (Andy oct2 A6) ----
test('words variant: deterministic sequence of common whole words, no repeats', () => {
  const a = race.buildWordSequence(123);
  const b = race.buildWordSequence(123);
  assert.deepEqual(a, b);
  assert.notDeepEqual(race.buildWordSequence(124).words, a.words);
  assert.equal(a.words.length, race.WORDS_TARGET);
  assert.equal(new Set(a.words).size, a.words.length);
  for (const w of a.words) assert.match(w, /^[a-z]{3,8}$/);
  for (const w of race.getWordPool()) assert.match(w, /^[a-z]{3,8}$/);
});

test('words variant: exact word only; finishing at the target wins; at the cap most words wins', () => {
  const g = race.createRace([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { seed: 9 });
  assert.equal(race.useWordsVariant(g), true);
  race.goLive(g, 1000);
  assert.equal(race.useWordsVariant(g), false, 'not once it is live');
  assert.equal(race.checkWord(g, 'a', g.words[1]).reason, 'wrong_word');
  assert.equal(race.checkWord(g, 'a', ` ${g.words[0].toUpperCase()}`).reason, null);
  race.applyAccept(g, 'a', g.words[0], 2000);
  race.applyAccept(g, 'b', g.words[0], 2500);
  race.applyAccept(g, 'b', g.words[1], 2600);
  race.finish(g, 'cap', 61000);
  assert.equal(g.winnerId, 'b');
  const h = race.createRace([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { seed: 9 });
  race.useWordsVariant(h);
  race.goLive(h, 0);
  let done = null;
  for (const w of h.words) done = race.applyAccept(h, 'a', w, 10);
  assert.equal(done.finished, true);
  assert.equal(h.winnerId, 'a');
});

test('words variant: bot typing time grows with word length and spreads by bot', () => {
  const fixed = () => 0.5;
  assert.ok(race.botTypeDelayMs('elephant', 1, fixed) > race.botTypeDelayMs('cat', 1, fixed));
  assert.ok(race.botTypeDelayMs('house', 0.88, fixed) < race.botTypeDelayMs('house', 1.12, fixed));
  const fiveLetter = race.botTypeDelayMs('house', 1, fixed); // ~45 WPM medium
  assert.ok(fiveLetter > 1000 && fiveLetter < 2000, String(fiveLetter));
});
