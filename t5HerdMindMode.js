// t5HerdMindMode.js
// HERD MIND - majority rules. [T5 experimental mode]
//
// A prompt drops ("Name a pizza topping"). Everyone secretly locks in ONE
// answer before the clock dies (the phase ends early once everyone's in).
// Then the reveal: answers are grouped, and you score (size of your group - 1)
// - matching the crowd is everything, being original scores zero. The lone
// player with a unique answer while everyone else matched gets branded the
// BLACK SHEEP. Five rounds, highest cumulative score wins.
//
// There is NO correctness judging anywhere - no dictionary, no AI, no
// accept-lists. An answer only scores if other humans typed the same thing,
// so the players themselves are the validator (same trust model as Imposter
// Word, inverted: you win by converging instead of blending).
//
// Layout follows the T5 plugin shape: PURE LOGIC first (no timers/sockets),
// then the ORCHESTRATOR (owns the answer clock via the room's standard
// round-timer slots, so resetGame / destroyRoom teardown works unchanged).
// All roomManager facilities arrive via the injected `helpers` object.
// Registered in t5Modes.js.

/* ============================== PURE LOGIC ============================== */

const TOTAL_ROUNDS = 5;
const MIN_PLAYERS_TO_START = 3; // with 2 players it's a coin flip, not a herd

// Difficulty sets only how long the answer phase runs.
const TIME_BY_DIFFICULTY = { easy: 30, medium: 25, hard: 15 };

// Prompts are deliberately CONVERGENT: each has a handful of obvious answers
// most people reach for, so herds actually form. Divergent/creative prompts
// (great in Imposter Word) are poison here - if everyone's answer is unique,
// nobody scores and the mode falls flat. Short named things only.
const PROMPTS = [
  // Food & drink
  'Name a pizza topping',
  'Name a breakfast food',
  'Name an ice cream flavor',
  'Name a fast food chain',
  'Name a fruit',
  'Name something you put on a hot dog',
  'Name a soda brand',
  'Name a candy bar',
  'Name a food that goes with cheese',
  'Name something you dip fries in',
  'Name a pasta dish',
  'Name a taco filling',
  // Animals
  'Name a farm animal',
  'Name a zoo animal',
  'Name a scary animal',
  'Name a pet',
  'Name the fastest animal you can think of',
  'Name an animal that lives in the ocean',
  // Everyday life
  'Name something in a kitchen',
  'Name something you lose all the time',
  'Name something in a school backpack',
  'Name a chore everyone hates',
  'Name something people are afraid of',
  'Name an excuse for being late',
  'Name something you do right before bed',
  'Name something that wakes you up',
  'Name something you take on vacation',
  'Name something in a wallet',
  // Places
  'Name a country in Europe',
  'Name a big city in the USA',
  'Name a place people go on a first date',
  'Name a place you have to be quiet',
  'Name a place with long lines',
  'Name a dream vacation spot',
  // Pop culture & games
  'Name a superhero',
  'Name a Disney movie',
  'Name a video game everyone has played',
  'Name a board game',
  'Name a famous wizard',
  'Name a cartoon character',
  'Name a movie villain',
  'Name a sport played with a ball',
  'Name a famous band',
  'Name an app everyone has on their phone',
  // People & jobs
  'Name a job kids dream about',
  'Name a job where you wear a uniform',
  'Name something a teacher says every day',
  'Name a famous scientist',
  // Things & stuff
  'Name a color of the rainbow',
  'Name a school subject',
  'Name a musical instrument',
  'Name something round',
  'Name something that flies',
  'Name something cold',
  'Name something sticky',
  'Name a holiday',
  'Name a month when it snows',
  'Name a super power',
  'Name something in the sky',
  'Name a thing with buttons',
];

/**
 * Normalizes an answer into its herd-matching key: lowercase, trimmed,
 * punctuation stripped, whitespace collapsed, leading article dropped, and a
 * naive plural fold (trailing 's' when longer than 3 chars) so "dogs" herds
 * with "dog". The fold is applied consistently to every answer, so grouping
 * stays correct even when the folded form isn't itself a word.
 */
function normalizeKey(rawAnswer) {
  let key = String(rawAnswer)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  key = key.replace(/^(the|a|an) /, '');
  if (key.length > 3 && key.endsWith('s')) key = key.slice(0, -1);
  return key;
}

/** Picks a random prompt not already used this game. */
function pickRandomPrompt(excludeSet) {
  const pool = excludeSet ? PROMPTS.filter((p) => !excludeSet.has(p)) : PROMPTS;
  const choices = pool.length ? pool : PROMPTS;
  return choices[Math.floor(Math.random() * choices.length)];
}

/**
 * Creates a fresh Herd Mind game. Each player holds one locked answer per
 * round (raw form for display, normalized key for matching) plus cumulative
 * score and a black-sheep tally for the final screen.
 */
function createGame(players, difficultyKey) {
  const answerPhaseSeconds = TIME_BY_DIFFICULTY[difficultyKey] || TIME_BY_DIFFICULTY.medium;
  const firstPrompt = pickRandomPrompt();
  return {
    status: 'answering', // 'answering' | 'reveal' | 'finished'
    difficultyKey: TIME_BY_DIFFICULTY[difficultyKey] ? difficultyKey : 'medium',
    rounds: TOTAL_ROUNDS,
    currentRound: 1,
    currentPrompt: firstPrompt,
    usedPrompts: new Set([firstPrompt]),
    answerPhaseSeconds,
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      answer: null, // { raw, key } once locked this round
      score: 0, // cumulative
      sheepCount: 0, // times branded the black sheep
    })),
    winnerId: null,
  };
}

/**
 * Locks in a player's ONE answer for the round. First submission wins - no
 * edits (the lock is what makes the early phase end safe and the reveal
 * honest). Returns { accepted: true, answer, playerId } or
 * { accepted: false, reason, playerId } with reason one of
 * 'wrong_phase' | 'not_in_game' | 'too_short' | 'already_answered'.
 */
function submitAnswer(game, playerId, rawAnswer) {
  if (game.status !== 'answering') {
    return { accepted: false, reason: 'wrong_phase', playerId };
  }
  const player = game.players.find((p) => p.id === playerId);
  if (!player) {
    return { accepted: false, reason: 'not_in_game', playerId };
  }
  const raw = String(rawAnswer).trim();
  const key = normalizeKey(raw);
  if (key.length < 2) {
    return { accepted: false, reason: 'too_short', playerId };
  }
  if (player.answer !== null) {
    return { accepted: false, reason: 'already_answered', playerId };
  }

  player.answer = { raw, key };
  return { accepted: true, answer: raw, playerId };
}

/** How many players have locked an answer, out of the total still in. */
function countAnswers(game) {
  const answered = game.players.filter((p) => p.answer !== null).length;
  return { answered, total: game.players.length };
}

/** True once every remaining player has locked an answer. */
function allAnswered(game) {
  const { answered, total } = countAnswers(game);
  return total > 0 && answered >= total;
}

/**
 * Closes the round and resolves the herd. Answers are grouped by normalized
 * key; every player scores (their group size - 1), so a 4-strong herd pays
 * +3 each and a unique answer pays nothing. If EXACTLY ONE player ended up
 * alone while every other answerer found a group, they're the BLACK SHEEP
 * (flavor + tally; no extra penalty - zero points already hurts). Players
 * who never answered score zero and can't be the sheep (blanking isn't
 * bleating). Flips status to 'reveal' and returns the full reveal snapshot.
 */
function endRound(game) {
  // key -> { displayAnswer, playerIds }; display is the first-submitted raw form.
  const groups = new Map();
  game.players.forEach((p) => {
    if (p.answer === null) return;
    if (!groups.has(p.answer.key)) {
      groups.set(p.answer.key, { answer: p.answer.raw, playerIds: [] });
    }
    groups.get(p.answer.key).playerIds.push(p.id);
  });

  // Score: group size - 1 per member.
  const roundScoreById = new Map();
  for (const group of groups.values()) {
    const points = group.playerIds.length - 1;
    group.playerIds.forEach((id) => roundScoreById.set(id, points));
  }
  game.players.forEach((p) => {
    p.score += roundScoreById.get(p.id) || 0;
  });

  // Black sheep: exactly one singleton group while at least one herd formed.
  const groupList = [...groups.values()];
  const singletons = groupList.filter((g) => g.playerIds.length === 1);
  const herds = groupList.filter((g) => g.playerIds.length >= 2);
  let blackSheepId = null;
  if (singletons.length === 1 && herds.length >= 1) {
    blackSheepId = singletons[0].playerIds[0];
    const sheep = game.players.find((p) => p.id === blackSheepId);
    if (sheep) sheep.sheepCount += 1;
  }

  game.status = 'reveal';

  return {
    round: game.currentRound,
    prompt: game.currentPrompt,
    groups: groupList
      .map((g) => ({
        answer: g.answer,
        playerIds: g.playerIds,
        points: g.playerIds.length - 1,
      }))
      .sort((a, b) => b.playerIds.length - a.playerIds.length),
    noAnswerIds: game.players.filter((p) => p.answer === null).map((p) => p.id),
    blackSheepId,
    scores: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      roundScore: roundScoreById.get(p.id) || 0,
      score: p.score,
    })),
  };
}

/** Highest cumulative score wins; ties break to the earlier-joined player. */
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
 * Advances to the next round (fresh non-repeating prompt, answers cleared) or
 * finishes the game after the last one. Returns the new round info, or null
 * when the game is over (status 'finished', winnerId resolved).
 */
function startNextRound(game) {
  if (game.currentRound >= game.rounds) {
    game.status = 'finished';
    game.winnerId = determineWinner(game);
    return null;
  }

  game.currentRound += 1;
  const prompt = pickRandomPrompt(game.usedPrompts);
  game.currentPrompt = prompt;
  game.usedPrompts.add(prompt);
  game.players.forEach((p) => {
    p.answer = null;
  });
  game.status = 'answering';

  return {
    round: game.currentRound,
    totalRounds: game.rounds,
    prompt,
    timerSeconds: game.answerPhaseSeconds,
  };
}

/** Final results: winner + scoreboard (score desc, join order on ties). */
function getResults(game) {
  const finalScores = game.players
    .map((p, index) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      sheepCount: p.sheepCount,
      _order: index,
    }))
    .sort((a, b) => b.score - a.score || a._order - b._order)
    .map(({ _order, ...rest }) => rest);
  return { winnerId: game.winnerId, finalScores };
}

/* ============================== ORCHESTRATOR ============================== */
// Answer clock on the room's standard round-timer slots; the reveal pause on
// roundPauseTimeout - so every existing cleanup path tears it down unchanged.

const REVEAL_PAUSE_MS = 8000; // room for the sheep-brand animation + scoreboard

function buildRoundStartPayload(game) {
  return {
    type: 'round_start',
    payload: {
      round: game.currentRound,
      totalRounds: game.rounds,
      prompt: game.currentPrompt,
      timerSeconds: game.answerPhaseSeconds,
    },
  };
}

/** Opening broadcast + first answer clock (delayed past the 3-2-1 countdown). */
function start(room, helpers) {
  helpers.broadcastToRoom(room, buildRoundStartPayload(room.game));
  helpers.scheduleTimerAfterCountdown(room, (r) => startAnswerTimer(r, helpers));
}

/** The answer-phase countdown; at zero the round resolves. */
function startAnswerTimer(room, helpers) {
  helpers.clearRoundTimer(room);

  const { game } = room;
  let remaining = game.answerPhaseSeconds;
  room.roundDeadline = Date.now() + remaining * 1000;

  room.roundTimerInterval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      endAnswerPhase(room, helpers);
      return;
    }
    helpers.broadcastToRoom(room, {
      type: 'timer_tick',
      payload: { secondsRemaining: remaining },
    });
  }, 1000);
}

/**
 * Resolves the round: kills the clock (and any pending countdown - the early
 * "everyone's in" path can fire before the timer even started), broadcasts
 * the reveal, then after the pause either starts the next round or ends the
 * game. Safe to call from both the timer and the early-end path; the status
 * flip inside endRound makes a second call impossible (submits are rejected
 * outside 'answering', and the timer was just cleared).
 */
function endAnswerPhase(room, helpers) {
  helpers.clearRoundTimer(room);
  const { game } = room;
  if (game.status !== 'answering') return;

  helpers.broadcastToRoom(room, { type: 'round_reveal', payload: endRound(game) });

  room.roundPauseTimeout = setTimeout(() => {
    room.roundPauseTimeout = null;
    const next = startNextRound(game);
    if (next === null) {
      helpers.broadcastToRoom(room, {
        type: 'game_over',
        payload: { gameType: 'herd-mind', ...getResults(game) },
      });
    } else {
      helpers.broadcastToRoom(room, buildRoundStartPayload(game));
      helpers.scheduleTimerAfterCountdown(room, (r) => startAnswerTimer(r, helpers));
    }
  }, REVEAL_PAUSE_MS);
}

/**
 * An answer routed here by roomManager. The accept/reject goes ONLY to the
 * submitter (answers stay secret until the reveal - that's the whole game);
 * a count-only answer_count is broadcast so the room can watch the locks
 * land. Once everyone's in, the phase ends immediately.
 */
function handleSubmit(room, connectionId, text, helpers) {
  const { game } = room;
  if (!game || game.gameType !== 'herd-mind') {
    return { error: 'no_active_game' };
  }
  if (game.status !== 'answering') {
    return { error: 'round_not_active' };
  }

  const result = submitAnswer(game, connectionId, text);

  const connection = room.players.find((p) => p.id === connectionId)?.connection;
  if (connection && connection.readyState === 1) {
    connection.send(JSON.stringify({ type: 'answer_result', payload: result }));
  }

  if (result.accepted) {
    helpers.touchRoom(room);
    helpers.broadcastToRoom(room, { type: 'answer_count', payload: countAnswers(game) });
    if (allAnswered(game)) {
      endAnswerPhase(room, helpers); // everyone's locked - don't wait out the clock
    }
  }

  return { result };
}

/**
 * A player left mid-game: drop them from the live roster. If that leaves
 * fewer than two players, the game can't continue - finish it on current
 * scores. If everyone remaining had already locked in, resolve the round now
 * rather than waiting on a ghost's clock.
 */
function handleLeave(room, connectionId, helpers) {
  const { game } = room;
  if (!game || game.status === 'finished') return;

  if (Array.isArray(game.players)) {
    game.players = game.players.filter((p) => p.id !== connectionId);
  }

  if (game.players.length < 2) {
    helpers.clearRoundTimer(room);
    game.status = 'finished';
    game.winnerId = determineWinner(game);
    helpers.broadcastToRoom(room, {
      type: 'game_over',
      payload: { gameType: 'herd-mind', ...getResults(game) },
    });
    return;
  }

  if (game.status === 'answering' && allAnswered(game)) {
    endAnswerPhase(room, helpers);
  }
}

module.exports = {
  // plugin surface (consumed via t5Modes.js)
  gameType: 'herd-mind',
  minPlayers: MIN_PLAYERS_TO_START,
  logic: { createGame },
  start,
  handleSubmit,
  handleLeave,
  // pure logic (unit tests)
  TOTAL_ROUNDS,
  TIME_BY_DIFFICULTY,
  PROMPTS,
  normalizeKey,
  pickRandomPrompt,
  createGame,
  submitAnswer,
  countAnswers,
  allAnswered,
  endRound,
  startNextRound,
  determineWinner,
  getResults,
};
