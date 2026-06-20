// categoryBlitzLogic.js
// Pure game-state logic for Category Blitz - the second game mode. It shares
// the exact same turn/timer/lives/elimination machinery as Word Bomb (those
// functions operate only on fields common to both game shapes), so rather
// than duplicate them we import them from gameLogic.js and re-export them.
// Only the two mode-specific pieces differ:
//
//   createGame    - seeds a random CATEGORY and an empty usedAnswers set
//                   (instead of a combo + usedWords)
//   submitWord    - accepts any answer the Gemini judge says fits the
//                   current category (instead of a dictionary word match)
//
// gameLogic.js is intentionally NOT modified - it stays pure Word Bomb.

const {
  DIFFICULTY_PRESETS,
  MIN_PLAYERS_TO_START,
  getCurrentPlayerId,
  getActivePlayers,
  computeTimerForTurn,
  advanceTurn,
  handleTimeout,
} = require('./gameLogic');

// The category judge is injected (like gameLogic injects the dictionary) so
// a test suite can substitute a stub and run offline without hitting Gemini.
let { validateCategoryAnswer } = require('./gemini');

function _setValidatorForTesting(mockModule) {
  validateCategoryAnswer = mockModule.validateCategoryAnswer;
}

// Lives mirrors Word Bomb. Defined locally rather than imported because
// gameLogic doesn't export it; the value is intentionally the same.
const STARTING_LIVES = 3;

// Fun, broad categories that most players can answer quickly. Kept broad on
// purpose so the AI judge has an easy yes/no call and the game stays fast.
const CATEGORIES = [
  'Things in a kitchen', 'Countries in Europe', 'Animals that can swim',
  'Things that are red', 'Musical instruments', 'Things that are round',
  'Sports played with a ball', 'Things you find at a beach', 'Fruits',
  'Things that fly', 'Board games', 'Desserts',
  'Things you find in a classroom', 'Car brands', 'Things that are cold',
  'Things you wear on your head', 'Video games', 'Things made of wood',
  'Pizza toppings', 'Things in a bathroom', 'Superheroes',
  'Things that are green', 'Drinks', 'Things at a zoo', 'Jobs',
  'Things in space', 'Cartoon characters', 'Things that are loud',
  'Shoes brands', 'Things at a party',
];

/**
 * Picks a random category from the list. If `excludeCategory` is given, the
 * result is guaranteed to differ from it, so the prompt visibly changes
 * from one turn to the next rather than (rarely) repeating.
 */
function pickRandomCategory(excludeCategory) {
  const pool = excludeCategory
    ? CATEGORIES.filter((c) => c !== excludeCategory)
    : CATEGORIES;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Creates a fresh Category Blitz game object. Same shape as a Word Bomb game
 * except for the prompt fields: currentCategory + usedAnswers instead of
 * currentCombo + usedWords.
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
    currentCategory: pickRandomCategory(), // the category this turn's answer must fit
    usedAnswers: new Set(), // every answer accepted so far, so none can be reused
    completedTurnCount: 0,
    currentTimerSeconds: difficulty.startSeconds,
    winnerId: null,
  };
}

/**
 * Validates and applies an answer submission for the current player. Named
 * submitWord (not submitAnswer) so it's a drop-in match for gameLogic's
 * interface - the room manager calls the same function name for both modes.
 *
 * Does NOT check whose turn it is; that's the caller's job (it needs the
 * connection id, which lives in the networking layer).
 */
async function submitWord(game, rawAnswer) {
  const answer = rawAnswer.trim();
  const normalized = answer.toLowerCase();
  const category = game.currentCategory;

  // Category answers can legitimately be short ("pie", "ox"), so the floor
  // is 2 characters rather than Word Bomb's 3.
  if (answer.length < 2) {
    return { accepted: false, reason: 'too_short' };
  }

  if (game.usedAnswers.has(normalized)) {
    return { accepted: false, reason: 'already_used' };
  }

  const fits = await validateCategoryAnswer(category, answer);
  if (!fits) {
    return { accepted: false, reason: 'not_in_category', category };
  }

  // Accepted - record the answer and roll a fresh category for the next
  // player (guaranteed different from the one just solved).
  game.usedAnswers.add(normalized);
  game.completedTurnCount += 1;
  game.currentCategory = pickRandomCategory(category);
  advanceTurn(game);

  return { accepted: true, word: answer, category: game.currentCategory };
}

module.exports = {
  DIFFICULTY_PRESETS,
  MIN_PLAYERS_TO_START,
  CATEGORIES,
  createGame,
  getCurrentPlayerId,
  getActivePlayers,
  computeTimerForTurn,
  advanceTurn,
  handleTimeout,
  submitWord,
  pickRandomCategory,
  _setValidatorForTesting,
};
