// categoryBlitzLogic.js
// Pure game-state logic for Category Blitz - a SIMULTANEOUS, round-based
// party mode. There are no turns, no lives, and no elimination: every player
// races to type as many valid answers to the same category as they can
// during a timed round. After a fixed number of rounds, the highest
// cumulative score wins.
//
// This module is completely standalone - it deliberately does NOT import
// turn/timer/lives helpers from gameLogic.js, because none of that applies
// here. The room manager owns the wall-clock round timer; this file is just
// the pure rules operating on a plain game object.

// The category judge is injected (like gameLogic injects the dictionary) so
// a test suite can substitute a stub and run offline without hitting Gemini.
let { validateCategoryAnswer } = require('./gemini');

function _setValidatorForTesting(mockModule) {
  validateCategoryAnswer = mockModule.validateCategoryAnswer;
}

const TOTAL_ROUNDS = 3;
const DEFAULT_ROUND_TIME = 45;
const MIN_PLAYERS_TO_START = 2;

// Round length per difficulty (seconds): harder difficulties give less time
// to think. Falls back to DEFAULT_ROUND_TIME for an unknown key.
const ROUND_TIME_BY_DIFFICULTY = {
  easy: 60,
  medium: 45,
  hard: 30,
};

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
 * Picks a random category. If `excludeSet` (a Set of already-played
 * categories) is given, the result is guaranteed not to be one of them, so
 * categories never repeat across rounds. Falls back to the full list in the
 * impossible case that every category has been used.
 */
function pickRandomCategory(excludeSet) {
  const pool = excludeSet
    ? CATEGORIES.filter((c) => !excludeSet.has(c))
    : CATEGORIES;
  const choices = pool.length ? pool : CATEGORIES;
  return choices[Math.floor(Math.random() * choices.length)];
}

/**
 * Highest cumulative score wins. On a tie, the first player reaching that
 * score (by player order) is the winner. Returns null only if there are no
 * players at all.
 */
function determineWinner(game) {
  let winnerId = null;
  let best = -1;
  game.players.forEach((p) => {
    if (p.score > best) {
      best = p.score;
      winnerId = p.id;
    }
  });
  return winnerId;
}

/**
 * Creates a fresh Category Blitz game. Each player tracks their OWN answers
 * (for the current round) and a cumulative score across all rounds.
 */
function createGame(players, difficultyKey) {
  const roundTimeSeconds = ROUND_TIME_BY_DIFFICULTY[difficultyKey] || DEFAULT_ROUND_TIME;
  const firstCategory = pickRandomCategory();

  return {
    status: 'in_progress', // 'in_progress' | 'between_rounds' | 'finished'
    difficultyKey: ROUND_TIME_BY_DIFFICULTY[difficultyKey] ? difficultyKey : 'medium',
    rounds: TOTAL_ROUNDS,
    currentRound: 1,
    currentCategory: firstCategory,
    roundTimeSeconds,
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      answers: [], // answers for the CURRENT round only (cleared each round)
      score: 0, // cumulative across all rounds
    })),
    usedCategories: new Set([firstCategory]), // so categories never repeat
    winnerId: null,
  };
}

/**
 * Applies an answer from ANY player at any time during an active round -
 * there is no turn checking. Validates length, per-player-per-round
 * uniqueness, then defers to the AI judge. On success the answer is recorded
 * and the player's score goes up by 1.
 *
 * Returns { accepted: true, answer, playerId } or
 *         { accepted: false, reason, playerId }.
 */
async function submitAnswer(game, playerId, rawAnswer) {
  const answer = rawAnswer.trim();
  const normalized = answer.toLowerCase();
  const player = game.players.find((p) => p.id === playerId);

  if (!player) {
    return { accepted: false, reason: 'not_in_game', playerId };
  }

  // Category answers can legitimately be short ("ox", "pie"), so the floor
  // is just 2 characters.
  if (answer.length < 2) {
    return { accepted: false, reason: 'too_short', playerId };
  }

  // Only THIS player's answers for THIS round block a resubmission - two
  // different players naming the same thing both score (they're racing
  // independently), and the same word is fair game again next round.
  if (player.answers.some((a) => a.toLowerCase() === normalized)) {
    return { accepted: false, reason: 'already_said', playerId };
  }

  const fits = await validateCategoryAnswer(game.currentCategory, answer);
  if (!fits) {
    return { accepted: false, reason: 'not_in_category', playerId };
  }

  player.answers.push(answer);
  player.score += 1;

  return { accepted: true, answer, playerId };
}

/**
 * Closes the current round. Flips status to 'between_rounds' and returns a
 * snapshot of what everyone scored this round (with their actual answers
 * revealed, now that the round is over).
 */
function endRound(game) {
  game.status = 'between_rounds';
  return {
    round: game.currentRound,
    category: game.currentCategory,
    playerResults: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      answers: [...p.answers],
      roundScore: p.answers.length,
    })),
  };
}

/**
 * Advances to the next round, or ends the game if the last round just
 * finished. When advancing: bumps the round counter, picks a fresh
 * (non-repeating) category, clears everyone's per-round answers, and flips
 * status back to 'in_progress'. Returns the new round info, or null when the
 * game is over (status set to 'finished' and winnerId resolved).
 */
function startNextRound(game) {
  if (game.currentRound >= game.rounds) {
    game.status = 'finished';
    game.winnerId = determineWinner(game);
    return null;
  }

  game.currentRound += 1;
  const category = pickRandomCategory(game.usedCategories);
  game.currentCategory = category;
  game.usedCategories.add(category);
  game.players.forEach((p) => {
    p.answers = [];
  });
  game.status = 'in_progress';

  return {
    round: game.currentRound,
    category,
    timerSeconds: game.roundTimeSeconds,
  };
}

/**
 * Returns the scoreboard sorted by cumulative score, highest first.
 */
function getScoreboard(game) {
  return game.players
    .map((p) => ({ id: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

module.exports = {
  CATEGORIES,
  TOTAL_ROUNDS,
  MIN_PLAYERS_TO_START,
  ROUND_TIME_BY_DIFFICULTY,
  createGame,
  submitAnswer,
  endRound,
  startNextRound,
  getScoreboard,
  pickRandomCategory,
  _setValidatorForTesting,
};
