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

// Answers are validated in TWO stages (hybrid validation):
//   1. Pre-generated accept-lists (a Set of valid lowercase answers per
//      category) - a fast, free, deterministic, offline Set lookup that
//      resolves the common answers instantly with no API call.
//   2. AI fallback (haikuValidator.js, Claude Haiku) - only consulted when an
//      answer ISN'T on the list, so creative/uncommon-but-valid answers still
//      get judged. Unlike the old Groq/Gemini path this FAILS CLOSED (any
//      timeout/error/rate-limit rejects) and is rate-limited per player. When
//      no ANTHROPIC_API_KEY is set the fallback is disabled and list-misses are
//      accepted (list-only mode) rather than rejected by a judge that isn't there.
// aiValidator.js (Groq/Gemini) and gemini.js stay in the repo but are no longer
// wired in here - haikuValidator.js owns the AI fallback now.
const CATEGORY_ANSWERS = require('./categoryAnswers');
const haikuValidator = require('./haikuValidator');

const TOTAL_ROUNDS = 3;
const MIN_PLAYERS_TO_START = 2;

// Every round is a flat 20 seconds, for every difficulty and for both solo and
// multiplayer. Difficulty no longer changes the clock - it only sets how many
// category rerolls a game gets (below).
const ROUND_TIME_SECONDS = 20;

const VALID_DIFFICULTIES = ['easy', 'medium', 'hard'];

// Category rerolls allowed PER GAME, by difficulty tier. The tiers are shown to
// players as HARD / CRAZY / HELL (see the frontend): easy -> HARD (3 rerolls),
// medium -> CRAZY (2), hard -> HELL (1). Fewer rerolls = harder.
const REROLLS_BY_DIFFICULTY = { easy: 3, medium: 2, hard: 1 };

// Categories with PERSONALITY - every one should make a player smirk, argue, or
// say "oh this is a good one". No boring trivia ("things that are green"). They
// stay answerable (the AI judge still needs an easy-ish yes/no), but the prompt
// itself is the fun. Keys here MUST match categoryAnswers.js exactly.
const CATEGORIES = [
  // Oddly specific
  'Things in your junk drawer', 'Gas station purchases at 2am',
  'Things on a CVS receipt', 'Things your mom has in her purse',
  'Things in a college dorm room', 'Smells in a middle school',
  "Things in a teacher's desk", 'Things you find between couch cushions',
  'Things in a hotel minibar', 'Things taped to a fridge',
  // Food but make it specific
  "McDonald's menu items", 'Things you dip in ranch',
  'Foods that are better cold the next day', "Gas station food you'd actually eat",
  'Things you put on toast', 'School cafeteria foods',
  "Foods that shouldn't exist but do", 'Things at a buffet nobody touches',
  'Midnight snack choices', "Foods you eat with your hands but probably shouldn't",
  // Pop culture (specific)
  'SpongeBob characters', 'Minecraft mobs', 'Pokemon from Gen 1',
  'Things you can do in GTA', 'Fortnite skins', 'Mario power-ups and items',
  'Disney villains', 'Pixar movies', 'Things in Hogwarts', 'Roblox games',
  // Debatable / funny
  'Valid excuses for being late', "Things you shouldn't microwave",
  'Worst superpowers', 'Things that are technically legal but feel illegal',
  'Reasons to call in sick', 'Things you pretend to understand',
  'Things you google at 3am', 'Lies on a dating profile',
  'Things the weird kid did in class', "Things that shouldn't be a sport but are",
  // Brands & specific knowledge
  'Shoe brands', 'Car brands', 'Fast food chains', 'Apps on your phone right now',
  'Things in an Amazon package', 'Things in a Costco', 'YouTube video categories',
  'Things with a drive-through', 'Subscription services',
  'Things that come in a vending machine',
  // Social / relatable
  'Things teachers always say', 'Things your parents text you',
  'Things a gym bro says', 'Things you say when you stub your toe',
  'Things you whisper in a library', 'Things you yell at a sports game',
  'First things you do when you wake up', 'Things you do when the WiFi goes out',
  'Things that hit different at night', 'Excuses for not texting back',
  // Curated expansion batch (accept-lists in categoryAnswers/gen1-gen5.js).
  // These 19 keys MUST match the gen*.js keys exactly.
  "Things in a divorced dad's apartment", 'Florida man headlines',
  'Things a mom yells from another room', 'Ways to die in Minecraft',
  'Things confiscated by a teacher', 'Red flags in a dating profile',
  "Things in a 2010 kid's bedroom", 'What the dog ate',
  'Things at a gas station bathroom', 'Cryptids in the woods at night',
  'Things a substitute teacher says', "Ways to get sent to the principal's office",
  'Things in a final boss arena', 'Things at a middle school dance',
  'Things your weird aunt posts on Facebook', 'The DMV experience',
  'Things found in a frat house', "Things in an emo kid's room (2008)",
  'Excuses for not doing your homework',
  // Clean rapid-fire batch (accept-lists in categoryAnswers/gen6.js). These 20
  // keys MUST match the gen6.js keys exactly.
  'Pizza toppings', 'Dog breeds', 'Candy bars', 'Ice cream flavors',
  'Cereal brands', 'Soda brands', 'Superheroes', 'Halloween costumes',
  'Sports', 'Musical instruments', 'Starbucks drinks', 'NBA teams',
  'Disney movies', 'Anime shows', 'Chip & snack brands', 'Video games',
  'Zoo animals', 'Breakfast foods', 'Board games', 'Types of pasta',
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
 *
 * Always TOTAL_ROUNDS (3) rounds, a different category each round, for BOTH
 * solo and multiplayer. `solo` is kept only so the room manager can flag the
 * single-player variant (it bypasses the minimum-player gate); it no longer
 * changes the round count. Every round is ROUND_TIME_SECONDS (20s); difficulty
 * only sets the per-game reroll allowance.
 */
function createGame(players, difficultyKey, solo = false) {
  const difficulty = VALID_DIFFICULTIES.includes(difficultyKey) ? difficultyKey : 'medium';
  const firstCategory = pickRandomCategory();

  return {
    status: 'in_progress', // 'in_progress' | 'between_rounds' | 'finished'
    difficultyKey: difficulty,
    solo: !!solo,
    rounds: TOTAL_ROUNDS,
    currentRound: 1,
    currentCategory: firstCategory,
    roundTimeSeconds: ROUND_TIME_SECONDS,
    // How many category rerolls remain for the whole game (host-controlled in
    // multiplayer, free for the solo player), set by the difficulty tier.
    rerollsRemaining: REROLLS_BY_DIFFICULTY[difficulty],
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
 * uniqueness, then validates the answer in two stages: the category's
 * pre-generated accept-list first (instant, free), falling back to the Haiku
 * AI judge only when the answer isn't on the list. On success the answer is
 * recorded and the player's score goes up by 1.
 *
 * `opts.onAiCheck` (optional) is invoked synchronously right before the AI call
 * is awaited, so the caller can tell the client "checking..." while the ~0.5-1.5s
 * judge runs. It fires ONLY when the answer missed the list AND AI validation is
 * enabled (a key is set) - i.e. exactly when there's real latency to cover.
 *
 * Returns { accepted: true, answer, playerId } or
 *         { accepted: false, reason, playerId }.
 */
async function submitAnswer(game, playerId, rawAnswer, opts = {}) {
  // Normalize for lookup: trim, then lowercase. Accept-list entries are all
  // stored lowercase, so this is a case-insensitive match.
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

  // Stage 1: the pre-generated accept-list for the current category. A hit
  // here is instant and free - no API call. A miss does NOT reject; it just
  // means the answer wasn't pre-generated, so we ask the AI judge next.
  const validAnswers = CATEGORY_ANSWERS[game.currentCategory];
  const onAcceptList = !!validAnswers && validAnswers.has(normalized);

  if (!onAcceptList) {
    // Stage 2: Haiku AI fallback. Judges creative/uncommon answers that aren't
    // on the list. Only runs when an API key is configured; otherwise we stay in
    // list-only mode and ACCEPT the miss (no judge available to fairly reject it).
    if (haikuValidator.isEnabled()) {
      // Tell the client we're checking, THEN await the judge (fail-closed,
      // 3s-timeout, rate-limited - all handled inside validate()).
      if (typeof opts.onAiCheck === 'function') opts.onAiCheck();
      const aiAccepted = await haikuValidator.validate(game.currentCategory, answer, playerId);
      if (!aiAccepted) {
        return { accepted: false, reason: 'not_in_category', playerId };
      }
    }
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
    rerollsRemaining: game.rerollsRemaining,
  };
}

/**
 * Rerolls the CURRENT round's category for a different one (same flat category
 * pool - there are no per-difficulty category lists, so "same tier" just means
 * another category that hasn't come up this game). It restarts the round on the
 * fresh category: this round's answers are cleared and the points earned on the
 * old category are reverted, so a reroll is a clean redo and can't be used to
 * farm an easy category before swapping away. Decrements the per-game allowance.
 *
 * Returns { round, category, timerSeconds, rerollsRemaining } or { error }.
 */
function rerollCategory(game) {
  if (!game || game.rerollsRemaining <= 0) {
    return { error: 'no_rerolls_left' };
  }
  game.players.forEach((p) => {
    p.score -= p.answers.length;
    if (p.score < 0) p.score = 0;
    p.answers = [];
  });
  const category = pickRandomCategory(game.usedCategories);
  game.currentCategory = category;
  game.usedCategories.add(category);
  game.rerollsRemaining -= 1;
  return {
    round: game.currentRound,
    category,
    timerSeconds: game.roundTimeSeconds,
    rerollsRemaining: game.rerollsRemaining,
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
  ROUND_TIME_SECONDS,
  REROLLS_BY_DIFFICULTY,
  createGame,
  submitAnswer,
  endRound,
  startNextRound,
  rerollCategory,
  getScoreboard,
  pickRandomCategory,
};
