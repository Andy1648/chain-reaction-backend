// miner.test.js - MINER pure state machine: prompts, ore judging, shared veins, cave-ins, the core.
const test = require('node:test');
const assert = require('node:assert/strict');

const miner = require('./miner');
const BLITZ_LISTS = require('./blitzLists');
const CANON = require('./blitzCanon.json');

function seq(...vals) {
  let i = 0;
  return () => vals[i++ % vals.length];
}

test('every prompt is a real Blitz list with a canon order and a SINGULAR ask, no duplicates, no wordplay', () => {
  assert.equal(new Set(miner.PROMPTS).size, miner.PROMPTS.length);
  assert.ok(miner.PROMPTS.length >= 200, 'endless needs a deep deck (Andy oct27: many more categories)');
  for (const p of miner.PROMPTS) {
    const list = BLITZ_LISTS.listFor(p);
    assert.ok(list, `${p} is in blitzLists.json`);
    assert.ok(CANON[p] && CANON[p].length >= 30, `${p} has a canon deep enough to have a DIAMOND band`);
    assert.notEqual(list.pack, 'wordplay', `${p} is a noun list`);
    const ask = miner.askFor(p);
    assert.equal(ask, ask.toUpperCase(), `${p}: the ask is upper-case`);
    // Andy oct27: "pizza topping", not "pizza toppings" - one rare answer, asked in the singular
    assert.doesNotMatch(ask, /^(THINGS|FOODS|ANIMALS|TYPES|PLACES)\b|^(A|AN|THE) /, `${p}: "${ask}" is a bare singular`);
  }
});

test('ore follows the canon order: the obvious answer is DIRT, the deep cut is DIAMOND', () => {
  assert.equal(miner.judgeAnswer('Pizza toppings', 'Pepperoni').ore, 'dirt');
  assert.equal(miner.judgeAnswer('US states', 'texas').ore, 'dirt');
  assert.equal(miner.judgeAnswer('US states', 'Wyoming').ore, 'diamond');
  assert.equal(miner.judgeAnswer('US states', 'Wyoming').depth, 100);
  assert.deepEqual(miner.ORES.map((o) => o.depth), [10, 25, 50, 100]);
});

test('plural / spelling folds land on the same key; off-list and empty are named', () => {
  const a = miner.judgeAnswer('Fruits', 'apples');
  const b = miner.judgeAnswer('Fruits', 'Apple');
  assert.equal(a.key, b.key);
  assert.deepEqual(miner.judgeAnswer('Fruits', 'zzzzzz'), { ok: false, reason: 'not_on_list' });
  assert.deepEqual(miner.judgeAnswer('Fruits', ' '), { ok: false, reason: 'too_short' });
});

function twoMiners() {
  const g = miner.createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seq(0));
  miner.startRound(g);
  g.prompt = 'US states';
  return g;
}

test('one answer per round: an off-list try does not lock, a hit does', () => {
  const g = twoMiners();
  assert.equal(miner.submit(g, 'a', 'narnia').reason, 'not_on_list');
  assert.equal(miner.submit(g, 'a', 'Wyoming').accepted, true);
  assert.equal(miner.submit(g, 'a', 'Texas').reason, 'already_locked');
  assert.deepEqual(miner.lockedCount(g), { locked: 1, total: 2 });
});

test('a shared vein halves; a blank caves in', () => {
  const g = miner.createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], seq(0));
  miner.startRound(g);
  g.prompt = 'US states';
  miner.submit(g, 'a', 'Wyoming');
  miner.submit(g, 'b', 'wyoming');
  const r = miner.endRound(g);
  const byId = Object.fromEntries(r.picks.map((p) => [p.id, p]));
  assert.equal(byId.a.gained, 50);
  assert.equal(byId.a.shared, true);
  assert.equal(byId.c.caveIn, true);
  assert.equal(miner.getMiner(g, 'c').lives, miner.START_LIVES - 1);
  assert.equal(g.status, 'reveal');
  assert.ok(r.diamond && r.diamond.toLowerCase() !== 'wyoming', 'the reveal shows an UNDUG diamond');
});

test('first to the core wins; deepest that round takes it', () => {
  const g = twoMiners();
  miner.getMiner(g, 'a').depth = 480;
  miner.getMiner(g, 'b').depth = 450;
  miner.submit(g, 'a', 'Texas'); // +10 -> 490
  miner.submit(g, 'b', 'Wyoming'); // +100 -> 550
  const r = miner.endRound(g);
  assert.equal(r.over, true);
  assert.equal(g.endReason, 'core');
  assert.deepEqual(g.winnerIds, ['b']);
});

test('three cave-ins and you are out; the last miner standing wins', () => {
  const g = twoMiners();
  miner.getMiner(g, 'a').depth = 300;
  miner.getMiner(g, 'a').lives = 1;
  miner.submit(g, 'b', 'Texas');
  miner.endRound(g);
  assert.equal(miner.getMiner(g, 'a').out, true);
  assert.equal(g.endReason, 'last_standing');
  assert.deepEqual(g.winnerIds, ['b'], 'last standing beats a deeper caved-in miner');
});

test('a leaver never wins; the game ends when no human is left digging', () => {
  const g = miner.createGame([{ id: 'a', name: 'A' }, { id: 'bot', name: 'BOT', isBot: true }, { id: 'bot2', name: 'B2', isBot: true }]);
  miner.startRound(g);
  assert.equal(miner.markLeft(g, 'a'), true);
  miner.finish(g, 'forfeit');
  assert.ok(!g.winnerIds.includes('a'));
});

test('prompts never repeat until the deck runs out', () => {
  const g = miner.createGame([{ id: 'a', name: 'A' }]);
  const seen = new Set();
  for (let i = 0; i < miner.PROMPTS.length; i++) seen.add(miner.startRound(g));
  assert.equal(seen.size, miner.PROMPTS.length);
  miner.startRound(g); // the deck reshuffles instead of throwing
});

test('bot answers are always on the list and reach every ore over time', () => {
  const ores = new Set();
  for (const p of miner.PROMPTS) {
    for (let i = 0; i < 6; i++) {
      const a = miner.botAnswer(p, 0.6);
      if (!a) continue;
      const j = miner.judgeAnswer(p, a);
      assert.ok(j.ok, `bot answer "${a}" is on ${p}`);
      ores.add(j.ore);
    }
  }
  assert.deepEqual([...ores].sort(), ['coal', 'diamond', 'dirt', 'gold']);
});

test('a find carries TOP n% RAREST; the round crowns its deepest unshared find', () => {
  const g = miner.createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]);
  g.status = 'digging';
  g.prompt = 'US states';
  assert.equal(miner.submit(g, 'a', 'Wyoming').pick.ore, 'diamond');
  assert.equal(miner.submit(g, 'b', 'Texas').pick.ore, 'dirt');
  const top = g.miners[0].pick.top;
  assert.ok(top >= 1 && top <= 45, `Wyoming is a deep cut (top ${top}%)`);
  assert.ok(g.miners[1].pick.top > 90, 'Texas is the obvious answer');
  const r = miner.endRound(g);
  assert.equal(r.ask, 'US STATE');
  assert.deepEqual(r.picks.filter((p) => p.rarest).map((p) => p.id), ['a']);
  assert.equal(r.picks.find((p) => p.id === 'a').top, top);
});

test('a shared vein is never crowned', () => {
  const g = miner.createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  g.status = 'digging';
  g.prompt = 'US states';
  miner.submit(g, 'a', 'Wyoming');
  miner.submit(g, 'b', 'wyoming');
  assert.equal(miner.endRound(g).picks.some((p) => p.rarest), false);
});

test("a NOT list takes any real noun (COAL) like Blitz does, and refuses a safe one", () => {
  const lick = "Things you shouldn't lick";
  const knife = miner.judgeAnswer(lick, 'a rusty knife');
  assert.equal(knife.ok, true);
  assert.equal(knife.ore, 'coal');
  assert.deepEqual(miner.judgeAnswer(lick, 'lol'), { ok: false, reason: 'not_on_list' });
  const soup = miner.judgeAnswer("Things you shouldn't microwave", 'soup');
  assert.equal(soup.ok, false);
  assert.equal(soup.reason, 'safe_item');
});
