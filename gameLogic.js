// gameLogic.js
// Pure game-state logic for Word Bomb, kept separate from networking so it
// can be unit-tested and reasoned about without a WebSocket in the loop. A
// "game" object here is plain data - the room manager owns the timers and
// broadcasting.
//
// Word Bomb rules: each turn the server picks a random 2-3 letter "combo"
// (a common English letter sequence). The current player must type any real
// word that *contains* that combo, isn't too short, and hasn't been used
// yet. A fresh combo is rolled after every accepted word.

// The dictionary dependency is injected rather than hard-required so the
// test suite can substitute dictionary.mock.js (no network needed) while
// production code (server.js) continues to wire up the real dictionary.js
// unchanged. Defaults to the real module so existing callers don't need
// to change anything.
let { isValidWord } = require('./dictionary');

function _setDictionaryForTesting(mockModule) {
  isValidWord = mockModule.isValidWord;
}

// Difficulty presets. "decreaseEveryNTurns" means the timer drops by 1
// second every N completed turns (across all players, not per-player),
// down to "floorSeconds" as a hard minimum so the game never becomes
// literally impossible.
const DIFFICULTY_PRESETS = {
  easy: { startSeconds: 15, decreaseEveryNTurns: 3, floorSeconds: 6 },
  medium: { startSeconds: 10, decreaseEveryNTurns: 2, floorSeconds: 4 },
  hard: { startSeconds: 7, decreaseEveryNTurns: 1, floorSeconds: 3 },
};

const STARTING_LIVES = 3;
const MIN_PLAYERS_TO_START = 2;

// Curated list of common English letter sequences. A good combo appears in
// lots of words so it's almost always solvable, but still forces the player
// to think. Deliberately a mix of 2- and 3-letter sequences to vary the
// difficulty turn to turn - the shorter ones are gimmes, the 3-letter ones
// bite. Every entry below is a high-frequency sequence with plenty of common
// words containing it; nothing here should ever be a dead end.
const COMBOS = [
  // ---- 2-letter (the easier rolls) ----
  'an', 'er', 'in', 'th', 'ou', 'en', 're', 'on', 'at', 'es',
  'or', 'ti', 'al', 'ar', 'te', 'ne', 'de',
  'st', 'ed', 'nd', 'le', 'se', 'it', 'ch', 'sh', 'ck', 'll',
  'ss', 'ee', 'oo', 'ot', 'et', 'am', 'ad', 'ow', 'ew', 'ay',
  'ly', 'ge',
  // curated batch (2-letter digraphs not already listed; still common)
  'nk', 'mb', 'kn', 'wr', 'ph', 'zz',
  // ---- 3-letter (the ones that make you think) ----
  'ion', 'ing', 'tion', 'ent', 'ant', 'all', 'igh', 'ous', 'ard',
  'age', 'ack', 'ain', 'ast', 'and', 'ill', 'ore', 'ine', 'ate',
  'ide', 'ung', 'ump', 'ock',
  'est', 'ess', 'ear', 'eat', 'ead', 'een', 'our', 'out', 'own',
  'end', 'ick', 'uck', 'eck', 'ash', 'ish', 'ush', 'ight', 'able',
  'tch', 'ter', 'der', 'ver', 'con', 'pre', 'pro', 'ink', 'ank',
  'ake', 'ame', 'ome', 'one', 'ound',
  // curated batch (3-letter; deep word pools, incl. harder clusters for late game)
  'ice', 'ure', 'str', 'scr', 'thr', 'squ', 'dge',
  // ---- expansion batch (each verified to sit in 5+ common high-school words) ----
  // 2-letter (easier rolls): be(before) co(color) me(memory) pe(person) ra(rather)
  // ro(robot) li(little) lo(long) ma(make) mo(money) na(nature) pa(paper) sa(salt)
  // ta(table) un(under) up(super) ur(purple) um(number) ug(sugar) ub(trouble)
  // ig(tiger) ip(slipper) ag(magic) ol(golf) el(elephant)
  'be', 'co', 'me', 'pe', 'ra', 'ro', 'li', 'lo', 'ma', 'mo', 'na', 'pa', 'sa',
  'ta', 'un', 'up', 'ur', 'um', 'ug', 'ub', 'ig', 'ip', 'ag', 'ol', 'el',
  // 3-letter (think harder): ble(trouble) tle(turtle) cle(vehicle) kle(sparkle)
  // ple(simple) ful(beautiful) ment(government) ust(trust) ost(ghost) ist(artist)
  // old(told) ild(building) und(ground) orn(popcorn) ern(pattern) oat(throat)
  // oad(upload) oot(tooth) ool(school) oom(mushroom) oon(balloon) eep(sheep)
  // eed(indeed) eel(wheel) eet(street) ail(email) air(chair) oin(appoint)
  // oil(toilet) unk(chunk) unt(count) orm(uniform) ort(report) ord(record)
  // ark(shark) arm(charm) art(heart) amp(champ) ang(change) ong(strong)
  'ble', 'tle', 'cle', 'kle', 'ple', 'ful', 'ment', 'ust', 'ost', 'ist',
  'old', 'ild', 'und', 'orn', 'ern', 'oat', 'oad', 'oot', 'ool', 'oom', 'oon',
  'eep', 'eed', 'eel', 'eet', 'ail', 'air', 'oin', 'oil', 'unk', 'unt', 'orm',
  'ort', 'ord', 'ark', 'arm', 'art', 'amp', 'ang', 'ong',
];

// ---- Escalating combo difficulty ----
// Difficulty is proxied by combo LENGTH: a 2-letter combo matches far more words
// than a 3- or 4-letter one. Selection is weighted by length, and the weighting
// RAMPS with completedTurnCount - the same progress signal the timer uses (see
// computeTimerForTurn). Early game leans toward short/easy combos; as turns pile
// up it leans toward longer/harder ones. The per-combo weight is
// exp(pressure * (length - PIVOT)), which is always > 0, so every combo keeps a
// non-zero chance at every stage - a hard combo early or an easy one late is
// RARE, never impossible (a smooth ramp, not a hard cutoff).
//
// `pressure(turns) = min(BASE + turns * PER_TURN, MAX)` is a straight ramp
// clamped at the top, mirroring how computeTimerForTurn's linear decay is clamped
// at a floor. With the constants below:
//   turn 0   -> -1.00  short combos weighted ~e per length step BELOW the pivot
//   turn 16  ->  0.00  neutral - length stops biasing selection
//   turn 32+ -> +1.00  long combos weighted ~e per length step ABOVE the pivot
// So the first few turns are clearly-but-not-brutally easy (a length-4 combo is
// ~e^2 ~7x rarer than a length-2 one), it's roughly even around the mid-game, and
// late game leans hard. Tune the four constants to taste.
const COMBO_DIFFICULTY_PIVOT_LEN = 3; // length kept weight-neutral (exp(0) = 1)
const COMBO_PRESSURE_BASE = -1.0; // pressure at turn 0 (favours short)
const COMBO_PRESSURE_PER_TURN = 0.0625; // +1.0 over 16 turns -> neutral at ~turn 16
const COMBO_PRESSURE_MAX = 1.0; // clamp (reached ~turn 32; favours long)

/**
 * The length-weighting "pressure" for a given number of completed turns. Pure and
 * exported so it can be unit-tested the same way as computeTimerForTurn. Negative
 * favours shorter combos, positive favours longer; it ramps up with progress and
 * clamps at COMBO_PRESSURE_MAX.
 */
function comboDifficultyPressure(completedTurnCount) {
  const turns = Math.max(0, completedTurnCount || 0);
  return Math.min(
    COMBO_PRESSURE_BASE + turns * COMBO_PRESSURE_PER_TURN,
    COMBO_PRESSURE_MAX
  );
}

/**
 * Picks a combo from the list, weighted by LENGTH and scaled by game progress
 * (completedTurnCount): early game leans short/easy, later it leans long/hard,
 * but every combo always keeps a non-zero weight so any of them can still come up
 * at any stage. If `excludeCombo` is given, the result is guaranteed to differ
 * from it, so the prompt visibly changes from one turn to the next rather than
 * (rarely) repeating. `completedTurnCount` defaults to 0 (easiest weighting) so
 * the game-start call needs no progress argument.
 */
function pickRandomCombo(excludeCombo, completedTurnCount = 0) {
  const pool = excludeCombo ? COMBOS.filter((c) => c !== excludeCombo) : COMBOS;
  const pressure = comboDifficultyPressure(completedTurnCount);

  // Weight each combo by exp(pressure * (length - pivot)) - always positive.
  let total = 0;
  const weights = pool.map((c) => {
    const w = Math.exp(pressure * (c.length - COMBO_DIFFICULTY_PIVOT_LEN));
    total += w;
    return w;
  });

  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i += 1) {
    r -= weights[i];
    if (r < 0) return pool[i];
  }
  return pool[pool.length - 1]; // float-rounding safety net (r ~= total)
}

/**
 * Creates a fresh game object for a room. Players is an array of
 * { id, name } - the room manager is responsible for knowing which
 * players are connected; this function just sets up turn order and state.
 */
function createGame(players, difficultyKey) {
  const difficulty = DIFFICULTY_PRESETS[difficultyKey] || DIFFICULTY_PRESETS.medium;

  return {
    status: 'in_progress', // 'in_progress' | 'finished'
    difficultyKey: DIFFICULTY_PRESETS[difficultyKey] ? difficultyKey : 'medium',
    difficulty,
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      lives: STARTING_LIVES,
      eliminated: false,
    })),
    turnOrder: players.map((p) => p.id),
    currentPlayerIndex: 0,
    // The opening combo. No turns completed yet, so pickRandomCombo defaults to
    // the easiest (shortest-favouring) weighting.
    currentCombo: pickRandomCombo(),
    usedWords: new Set(), // every word accepted so far, so none can be reused
    completedTurnCount: 0,
    currentTimerSeconds: difficulty.startSeconds,
    winnerId: null,
  };
}

function getCurrentPlayerId(game) {
  return game.turnOrder[game.currentPlayerIndex];
}

function getActivePlayers(game) {
  return game.players.filter((p) => !p.eliminated);
}

/**
 * Computes what the timer should be for the NEXT turn, based on how many
 * turns have completed so far. This is recalculated each turn rather than
 * decremented in place, so it's always consistent even if turns get
 * skipped (e.g. a player disconnects).
 */
function computeTimerForTurn(game) {
  const { startSeconds, decreaseEveryNTurns, floorSeconds } = game.difficulty;
  const decreaseSteps = Math.floor(game.completedTurnCount / decreaseEveryNTurns);
  const seconds = startSeconds - decreaseSteps;
  return Math.max(seconds, floorSeconds);
}

/**
 * Advances turn order to the next non-eliminated player. If only one
 * player remains, the game ends and that player wins.
 */
function advanceTurn(game) {
  const active = getActivePlayers(game);

  if (active.length <= 1) {
    game.status = 'finished';
    game.winnerId = active.length === 1 ? active[0].id : null;
    return;
  }

  let nextIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
  let safetyCounter = 0;

  // Skip eliminated players. The safety counter prevents an infinite loop
  // in the pathological case where turnOrder and players get out of sync.
  while (
    game.players.find((p) => p.id === game.turnOrder[nextIndex])?.eliminated &&
    safetyCounter < game.turnOrder.length
  ) {
    nextIndex = (nextIndex + 1) % game.turnOrder.length;
    safetyCounter += 1;
  }

  game.currentPlayerIndex = nextIndex;
  game.currentTimerSeconds = computeTimerForTurn(game);
}

/**
 * Called when the current player's turn timer expires with no valid
 * submission. Costs a life and moves to the next player.
 */
function handleTimeout(game) {
  const currentPlayerId = getCurrentPlayerId(game);
  const player = game.players.find((p) => p.id === currentPlayerId);

  if (player) {
    player.lives -= 1;
    if (player.lives <= 0) {
      player.eliminated = true;
    }
  }

  game.completedTurnCount += 1;
  advanceTurn(game);

  return { eliminatedPlayerId: player && player.eliminated ? player.id : null };
}

/**
 * Validates and applies a word submission for the current player.
 * Returns a result object describing what happened - the caller
 * (room manager) is responsible for broadcasting it and managing timers.
 *
 * This function does NOT check whether it's actually this player's turn -
 * that's the caller's job, since it requires knowing the connection's
 * player id, which lives in the networking layer.
 */
async function submitWord(game, rawWord) {
  const word = rawWord.trim().toLowerCase();
  const combo = game.currentCombo;

  if (word.length < 3) {
    return { accepted: false, reason: 'too_short' };
  }

  // The core Word Bomb rule: the word must contain the combo anywhere.
  // Both are already lowercased, so this is a case-insensitive match.
  if (!word.includes(combo)) {
    return { accepted: false, reason: 'missing_combo', combo };
  }

  if (game.usedWords.has(word)) {
    return { accepted: false, reason: 'already_used' };
  }

  const valid = await isValidWord(word);
  if (!valid) {
    return { accepted: false, reason: 'not_a_word' };
  }

  // All checks passed - record the word and roll a fresh combo for the next
  // player (guaranteed different from the one just solved). completedTurnCount was
  // just bumped, so the new combo's difficulty reflects progress so far.
  game.usedWords.add(word);
  game.completedTurnCount += 1;
  game.currentCombo = pickRandomCombo(combo, game.completedTurnCount);
  advanceTurn(game);

  return { accepted: true, word, combo: game.currentCombo };
}

module.exports = {
  DIFFICULTY_PRESETS,
  MIN_PLAYERS_TO_START,
  COMBOS,
  createGame,
  getCurrentPlayerId,
  getActivePlayers,
  computeTimerForTurn,
  advanceTurn,
  handleTimeout,
  submitWord,
  pickRandomCombo,
  comboDifficultyPressure,
  _setDictionaryForTesting,
};
