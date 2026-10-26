// miner.js
// MINER - the endless rare-answer dig (replaces DAILY BLITZ, Andy oct26). PURE state machine: no timers,
// no sockets - minerMode.js owns the clocks and the wire.
//
// THE GAME: every round drops ONE easy Category Blitz list ("Pizza toppings"). Each miner locks in ONE
// answer on the list. The RARER the answer, the deeper it digs:
//   DIRT 10m · COAL 25m · GOLD 50m · DIAMOND 100m
// Rarity is the answer's place in blitzCanon.json, whose members are ordered best-known first (the same
// order the Blitz bot leans on): the top 8% of a list is DIRT, then COAL to 25%, GOLD to 55%, DIAMOND
// past that. An answer on the list but missing from the canon is a deep cut by definition -> GOLD.
// Two miners who dig the SAME answer in a round split the vein: half depth each.
// No answer by the bell is a CAVE-IN: one of three lives gone; zero lives and you're out.
// First to the CORE (500m) wins - the deepest that round, ties share it - or the last miner standing.
// Prompts never repeat inside a game, so the game is endless in practice.

const BLITZ_LISTS = require('./blitzLists');
const CANON = require('./blitzCanon.json');

const TARGET_DEPTH = 500;
const START_LIVES = 3;
const MAX_MINERS = 6;

const ORES = [
  { id: 'dirt', depth: 10, maxPct: 0.08 },
  { id: 'coal', depth: 25, maxPct: 0.25 },
  { id: 'gold', depth: 50, maxPct: 0.55 },
  { id: 'diamond', depth: 100, maxPct: Infinity },
];
const ORE_BY_ID = Object.fromEntries(ORES.map((o) => [o.id, o]));

// EASY prompts only: everyday NOUN lists anyone can answer (Andy's Blitz rules - no phrase/excuse prompts,
// no unhinged pack, no wordplay), each big enough to have a deep end. Every name is asserted to exist in
// blitzLists.json + blitzCanon.json by miner.test.js.
const PROMPTS = [
  // food
  'Pizza toppings', 'Ice cream flavors', 'Sandwiches', 'Fruits', 'Vegetables', 'Desserts', 'Breakfast foods',
  'Things in a fridge', 'Snack foods', 'Candy brands', 'Soda brands', 'Fast food chains', 'Breakfast cereals',
  'Types of pasta', 'Types of cheese', 'Types of bread', 'Hot dog toppings', 'Things you dip fries in',
  'Ice cream toppings', 'Things you put on toast', 'Things you put on a burger', 'Things you can put in a taco',
  'Drinks (no alcohol)', 'Foods that are crunchy', 'Foods you eat with your hands', 'Foods that come on a stick',
  "Things you'd find in a soup", 'Movie theater snacks', 'Things you put in a smoothie', 'Berries',
  'Tropical fruits', 'Chip flavors', 'Foods you can deep fry', 'Thanksgiving dinner foods', 'Kitchen utensils',
  'Kitchen appliances', "McDonald's menu items", 'Things that taste sweet', 'Things that taste sour',
  // animals + nature
  'Farm animals', 'Sea creatures', 'Insects', 'Birds', 'Pets', 'Dog breeds', 'Big cats', 'Dinosaurs', 'Sharks',
  'Flowers', 'Animals with stripes', 'Animals with spots', 'Animals that live in trees', 'Things in a pond',
  'Things with wings', 'Things with a tail', 'Things that lay eggs', 'Things with a shell', 'Mythical creatures',
  // things
  'Things in space', 'Things that are round', 'Things that are cold', 'Things that are sticky',
  'Things that bounce', 'Things that melt', 'Things that glow', 'Things that spin', 'Rooms in a house',
  'Types of weather', 'Types of hats', 'Types of shoes', 'School supplies', 'Things in a bathroom',
  'Playground equipment', 'Amusement park rides', 'Things you find at the beach', 'Jobs', 'Clothing',
  'Things in a backpack', 'Things in a junk drawer', 'Things in a classroom', "Things you'd see at the zoo",
  'Things in a garage', 'Things at a hotel', 'Things at the gym', 'Camping gear', 'Things that come in pairs',
  'Things you lose all the time', "Things you'd find at an airport", "Things you'd find at Walmart",
  'Things in your pocket', "Things at grandma's house", 'Things in a castle', "Things you'd see in the jungle",
  'Things you can ride', 'Things that are loud', 'Things that are fluffy', 'Things that are squishy',
  'Things that are expensive', 'Things people collect', 'Things at a birthday party',
  'Things you see on Halloween', 'Things a pirate would have', 'Things a wizard would carry',
  // tech
  'Car brands', 'Things with wheels', 'Things with buttons', 'Things you plug in', 'Things with a screen',
  'Things that run on batteries', 'Apps on your phone', 'Social media apps', 'Streaming services', 'Car parts',
  // pop culture + play
  'Superheroes', 'Cartoon characters', 'Disney villains', 'Famous TV shows', 'Animated movies',
  'Video game characters', 'Popular video games', 'Disney Channel shows', 'Nickelodeon shows',
  'Cartoon Network shows', 'Movie villains', 'Famous cartoon dogs', 'Famous robots', 'Superpowers',
  'Halloween costumes', 'Musical instruments', 'Music genres', 'Famous singers', 'Famous athletes',
  'Sports with a ball', 'Sports equipment', 'Summer Olympic sports', 'Classic toys', 'Classic board games',
  'Card games', 'Stores at the mall', 'Clothing & shoe brands', 'Toy brands',
  // closed but easy (a well-known head and a real deep end)
  'US states', 'NBA teams', 'NFL teams', 'European countries', 'African countries', 'Asian countries',
  'Pokemon from Gen 1', 'Minecraft mobs', 'US presidents', 'Mario characters', 'Toy Story characters',
  'SpongeBob characters',
];

/* ---------------------------------- rarity ---------------------------------- */

const rankCache = new Map(); // category -> { byKey: Map(sameAnswerKey -> member index), size, members }
function rankIndex(category) {
  let idx = rankCache.get(category);
  if (idx) return idx;
  const members = CANON[category] || [];
  const byKey = new Map();
  const memberKeys = members.map((m) => BLITZ_LISTS.sameAnswerKey(category, m.canon));
  members.forEach((m, i) => {
    for (const form of [m.canon, ...(m.aliases || [])]) {
      const k = BLITZ_LISTS.sameAnswerKey(category, form);
      if (k && !byKey.has(k)) byKey.set(k, i);
    }
  });
  idx = { byKey, size: Math.max(1, members.length), members, memberKeys };
  rankCache.set(category, idx);
  return idx;
}

/** The ore for a canon position (0 = best-known). */
function oreForPct(pct) {
  return ORES.find((o) => pct < o.maxPct) || ORES[ORES.length - 1];
}

/**
 * Judges an answer for a category: { ok: true, key, ore, depth, pct } or { ok: false, reason }.
 * `key` is the dedupe key (two answers with one key are the SAME answer); pct is null when the
 * answer is on the list but not ranked in the canon (scored as GOLD).
 */
function judgeAnswer(category, raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (BLITZ_LISTS.answerKey(text).length < 2) return { ok: false, reason: 'too_short' };
  if (!BLITZ_LISTS.onList(category, text)) return { ok: false, reason: 'not_on_list' };
  const key = BLITZ_LISTS.sameAnswerKey(category, text);
  const { byKey, size } = rankIndex(category);
  const at = byKey.get(key);
  const pct = at === undefined ? null : at / size;
  const ore = pct === null ? ORE_BY_ID.gold : oreForPct(pct);
  return { ok: true, key, ore: ore.id, depth: ore.depth, pct };
}

/** A DIAMOND answer nobody dug this round, to show at the reveal (the deep end of the list). */
function diamondExample(category, takenKeys = new Set(), rng = Math.random) {
  const { members, memberKeys, size } = rankIndex(category);
  const start = Math.ceil(size * ORE_BY_ID.gold.maxPct);
  const pool = members.filter((m, i) => i >= start && m.canon.length >= 3 && !takenKeys.has(memberKeys[i]));
  // lean toward the shallow end of the diamond band: the recognisable deep cuts, not the oddities at the tail
  return pool.length ? pool[Math.floor(pool.length * rng() ** 2)].canon : null;
}

/* ---------------------------------- game ---------------------------------- */

function pickPrompt(used, rng = Math.random, prompts = PROMPTS) {
  let pool = prompts.filter((p) => !used.has(p));
  if (!pool.length) {
    used.clear(); // a marathon game cycled every prompt: start the deck again
    pool = prompts.slice();
  }
  return pool[Math.floor(rng() * pool.length)];
}

function createGame(players, rng = Math.random) {
  return {
    status: 'lobby', // 'lobby' | 'digging' | 'reveal' | 'finished'
    round: 0,
    prompt: null,
    used: new Set(),
    target: TARGET_DEPTH,
    miners: players.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: !!p.isBot,
      depth: 0,
      lives: START_LIVES,
      out: false,
      left: false,
      pick: null, // this round: { text, key, ore, depth }
      best: null, // the game's richest find: { text, ore, depth, prompt }
      ores: { dirt: 0, coal: 0, gold: 0, diamond: 0 },
    })),
    winnerIds: [],
    endReason: null,
    rng,
  };
}

function addMiner(game, p) {
  if (game.miners.some((m) => m.id === p.id)) return;
  game.miners.push({
    id: p.id, name: p.name, isBot: !!p.isBot, depth: 0, lives: START_LIVES, out: false, left: false,
    pick: null, best: null, ores: { dirt: 0, coal: 0, gold: 0, diamond: 0 },
  });
}

const getMiner = (game, id) => game.miners.find((m) => m.id === id) || null;
const activeMiners = (game) => game.miners.filter((m) => !m.out && !m.left);

/** Opens the next round. Returns the prompt. */
function startRound(game) {
  game.round += 1;
  game.prompt = pickPrompt(game.used, game.rng);
  game.used.add(game.prompt);
  for (const m of game.miners) m.pick = null;
  game.status = 'digging';
  return game.prompt;
}

/**
 * A miner's answer. -> { accepted: true, pick } | { accepted: false, reason }.
 * Off-list answers are rejected WITHOUT locking (the miner may try again before the bell).
 */
function submit(game, id, raw) {
  if (game.status !== 'digging') return { accepted: false, reason: 'round_over' };
  const m = getMiner(game, id);
  if (!m) return { accepted: false, reason: 'not_a_miner' };
  if (m.out || m.left) return { accepted: false, reason: 'caved_in' };
  if (m.pick) return { accepted: false, reason: 'already_locked' };
  const j = judgeAnswer(game.prompt, raw);
  if (!j.ok) return { accepted: false, reason: j.reason };
  m.pick = { text: String(raw).trim().slice(0, 40), key: j.key, ore: j.ore, depth: j.depth };
  return { accepted: true, pick: m.pick };
}

function lockedCount(game) {
  const live = activeMiners(game);
  return { locked: live.filter((m) => m.pick).length, total: live.length };
}

function allLocked(game) {
  const { locked, total } = lockedCount(game);
  return total > 0 && locked >= total;
}

/**
 * Closes the round: shared veins halve, blanks cave in, depth lands, and the game ends if someone hit the
 * core or one miner is left. -> the reveal snapshot.
 */
function endRound(game) {
  const live = activeMiners(game);
  const byKey = new Map();
  for (const m of live) if (m.pick) byKey.set(m.pick.key, (byKey.get(m.pick.key) || 0) + 1);

  const picks = [];
  for (const m of live) {
    if (m.pick) {
      const shared = byKey.get(m.pick.key) > 1;
      const gained = shared ? Math.round(m.pick.depth / 2) : m.pick.depth;
      m.depth += gained;
      m.ores[m.pick.ore] += 1;
      if (!m.best || m.pick.depth > m.best.depth) {
        m.best = { text: m.pick.text, ore: m.pick.ore, depth: m.pick.depth, prompt: game.prompt };
      }
      picks.push({ id: m.id, answer: m.pick.text, ore: m.pick.ore, gained, shared });
    } else {
      m.lives -= 1;
      if (m.lives <= 0) {
        m.lives = 0;
        m.out = true;
      }
      picks.push({ id: m.id, answer: null, ore: null, gained: 0, caveIn: true, out: m.out });
    }
  }

  const taken = new Set(live.filter((m) => m.pick).map((m) => m.pick.key));
  const reveal = {
    round: game.round,
    prompt: game.prompt,
    picks,
    diamond: diamondExample(game.prompt, taken, game.rng),
  };

  const standing = activeMiners(game);
  const hitCore = game.miners.filter((m) => !m.left && m.depth >= game.target);
  if (hitCore.length) {
    finish(game, 'core');
  } else if (standing.length <= 1 && game.miners.filter((m) => !m.left).length > 1) {
    finish(game, standing.length === 1 ? 'last_standing' : 'all_caved');
  } else if (standing.length === 0) {
    finish(game, 'all_caved');
  } else {
    game.status = 'reveal';
  }
  reveal.miners = minersSnapshot(game);
  reveal.over = game.status === 'finished';
  return reveal;
}

/** Ends the game: the deepest miner(s) still in the mine win (a left miner never does). */
function finish(game, reason) {
  game.status = 'finished';
  game.endReason = reason;
  const eligible = game.miners.filter((m) => !m.left);
  const standing = eligible.filter((m) => !m.out);
  // last standing wins outright even if a caved-in miner was deeper; otherwise deepest wins
  const pool = reason === 'last_standing' && standing.length === 1 ? standing : eligible;
  const best = Math.max(0, ...pool.map((m) => m.depth));
  game.winnerIds = pool.length ? pool.filter((m) => m.depth === best).map((m) => m.id) : [];
}

/** A miner left mid-game. Returns true when the game should end now. */
function markLeft(game, id) {
  const m = getMiner(game, id);
  if (!m) return false;
  m.left = true;
  m.pick = null;
  if (game.status === 'finished') return false;
  const live = activeMiners(game);
  // nobody human left digging, or one miner left in the mine: there's no race any more
  return live.length <= 1 || live.every((x) => x.isBot);
}

function minersSnapshot(game) {
  return game.miners.map((m) => ({
    id: m.id, name: m.name, isBot: m.isBot, depth: m.depth, lives: m.lives, out: m.out, left: m.left,
  }));
}

function standings(game) {
  return game.miners
    .map((m, i) => ({
      id: m.id, name: m.name, isBot: m.isBot, depth: m.depth, lives: m.lives, out: m.out, left: m.left,
      best: m.best, ores: m.ores, _i: i,
    }))
    .sort((a, b) => (a.left - b.left) || (b.depth - a.depth) || (a._i - b._i))
    .map(({ _i, ...rest }) => rest);
}

/* ---------------------------------- bots ---------------------------------- */

// A bot digs like a person: mostly the obvious head of the list, now and then a deep cut, and once in a
// while it blanks. `skill` (per bot, 0..1) shifts how deep it reaches.
function botAnswer(category, skill = 0.5, takenKeys = new Set(), rng = Math.random) {
  if (rng() < 0.07) return null; // blank -> cave-in
  const { members, memberKeys } = rankIndex(category);
  const usable = members.filter((m, i) => m.canon.length >= 2 && !takenKeys.has(memberKeys[i]));
  if (!usable.length) return null;
  const curve = 3.2 - 2 * Math.min(1, Math.max(0, skill)); // 3.2 (shallow) .. 1.2 (deep)
  return usable[Math.floor(usable.length * rng() ** curve)].canon;
}

module.exports = {
  TARGET_DEPTH,
  START_LIVES,
  MAX_MINERS,
  ORES,
  PROMPTS,
  judgeAnswer,
  oreForPct,
  diamondExample,
  pickPrompt,
  createGame,
  addMiner,
  getMiner,
  activeMiners,
  startRound,
  submit,
  lockedCount,
  allLocked,
  endRound,
  finish,
  markLeft,
  minersSnapshot,
  standings,
  botAnswer,
};
