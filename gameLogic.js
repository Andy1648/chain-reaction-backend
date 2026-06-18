// gameLogic.js
// Pure game-state logic for Chain Reaction, kept separate from networking
// so it can be unit-tested and reasoned about without a WebSocket in the
// loop. A "game" object here is plain data - the room manager owns the
// timers and broadcasting.

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
  easy: { startSeconds: 20, decreaseEveryNTurns: 3, floorSeconds: 8 },
  medium: { startSeconds: 15, decreaseEveryNTurns: 2, floorSeconds: 5 },
  hard: { startSeconds: 10, decreaseEveryNTurns: 1, floorSeconds: 3 },
};

const STARTING_LIVES = 3;
const MIN_PLAYERS_TO_START = 2;

// A small seed list of starting words so the first word in a chain isn't
// chosen by a player (which could let them pick something obscure on
// purpose). All of these are pre-marked valid in dictionary.js's cache
// at server startup so we never waste an API call confirming our own
// seed list.
const STARTER_WORDS = [
  'garden', 'planet', 'window', 'castle', 'rocket', 'forest',
  'bridge', 'pencil', 'guitar', 'mirror', 'jacket', 'turtle',
];

function pickStarterWord() {
  return STARTER_WORDS[Math.floor(Math.random() * STARTER_WORDS.length)];
}

function lastTwoLetters(word) {
  return word.slice(-2).toLowerCase();
}

/**
 * Creates a fresh game object for a room. Players is an array of
 * { id, name } - the room manager is responsible for knowing which
 * players are connected; this function just sets up turn order and state.
 */
function createGame(players, difficultyKey) {
  const difficulty = DIFFICULTY_PRESETS[difficultyKey] || DIFFICULTY_PRESETS.medium;
  const starterWord = pickStarterWord();

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
    chain: [starterWord], // full history of accepted words
    usedWords: new Set([starterWord.toLowerCase()]),
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
  const lastWord = game.chain[game.chain.length - 1];
  const requiredPrefix = lastTwoLetters(lastWord);

  if (word.length < 3) {
    return { accepted: false, reason: 'too_short' };
  }

  if (!word.startsWith(requiredPrefix)) {
    return { accepted: false, reason: 'wrong_prefix', requiredPrefix };
  }

  if (game.usedWords.has(word)) {
    return { accepted: false, reason: 'already_used' };
  }

  const valid = await isValidWord(word);
  if (!valid) {
    return { accepted: false, reason: 'not_a_word' };
  }

  // All checks passed - commit the word to the chain.
  game.chain.push(word);
  game.usedWords.add(word);
  game.completedTurnCount += 1;
  advanceTurn(game);

  return { accepted: true, word };
}

module.exports = {
  DIFFICULTY_PRESETS,
  MIN_PLAYERS_TO_START,
  createGame,
  getCurrentPlayerId,
  getActivePlayers,
  computeTimerForTurn,
  advanceTurn,
  handleTimeout,
  submitWord,
  lastTwoLetters,
  _setDictionaryForTesting,
};
