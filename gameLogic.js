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
  // ---- 3-letter (the ones that make you think) ----
  'ion', 'ing', 'tion', 'ent', 'ant', 'all', 'igh', 'ous', 'ard',
  'age', 'ack', 'ain', 'ast', 'and', 'ill', 'ore', 'ine', 'ate',
  'ide', 'ung', 'ump', 'ock',
  'est', 'ess', 'ear', 'eat', 'ead', 'een', 'our', 'out', 'own',
  'end', 'ick', 'uck', 'eck', 'ash', 'ish', 'ush', 'ight', 'able',
  'tch', 'ter', 'der', 'ver', 'con', 'pre', 'pro', 'ink', 'ank',
  'ake', 'ame', 'ome', 'one', 'ound',
];

/**
 * Picks a random combo from the list. If `excludeCombo` is given, the
 * result is guaranteed to differ from it, so the prompt visibly changes
 * from one turn to the next rather than (rarely) repeating.
 */
function pickRandomCombo(excludeCombo) {
  const pool = excludeCombo ? COMBOS.filter((c) => c !== excludeCombo) : COMBOS;
  return pool[Math.floor(Math.random() * pool.length)];
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
    currentCombo: pickRandomCombo(), // the letter sequence this turn's word must contain
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

  // All checks passed - record the word and roll a fresh combo for the
  // next player (guaranteed different from the one just solved).
  game.usedWords.add(word);
  game.completedTurnCount += 1;
  game.currentCombo = pickRandomCombo(combo);
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
  _setDictionaryForTesting,
};
