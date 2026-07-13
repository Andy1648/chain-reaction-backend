// t5LetterStormMode.js
// LETTER STORM - simultaneous anagram rush. [T5 experimental mode]
//
// Each round every player gets the SAME 7-letter rack (the scrambled letters
// of a real 7-letter word, so a full-rack answer always exists) and races to
// type as many words buildable from those letters as they can before the
// clock dies. Longer words score more; spending all 7 letters at once is a
// STORM and scores a fat bonus. Three rounds, highest cumulative score wins.
//
// Validation is fully OFFLINE and deterministic: a word counts iff it's in
// botWords.txt (the ~18k common-word corpus the Word Bomb bot already ships)
// AND buildable from the rack's letter multiset. No dictionary API, no AI -
// identical racks + identical rules means a pure fairness race.
//
// Layout follows the T5 plugin shape: PURE LOGIC first (no timers/sockets;
// the word corpus is injectable for tests), then the ORCHESTRATOR (owns the
// round clock via the room's standard round-timer slots, so resetGame /
// destroyRoom teardown works unchanged). All roomManager facilities arrive
// via the injected `helpers` object. Registered in t5Modes.js.

const fs = require('fs');
const path = require('path');

/* ============================== PURE LOGIC ============================== */

const TOTAL_ROUNDS = 3;
const MIN_PLAYERS_TO_START = 2;
const RACK_SIZE = 7;
const MIN_WORD_LENGTH = 3;

// Difficulty sets only the round clock - the rack and scoring never change.
const TIME_BY_DIFFICULTY = { easy: 40, medium: 30, hard: 20 };

// Points by word length - deliberately NONLINEAR. A linear len-2 curve made
// 3/4-letter spam the dominant strategy on points-per-second (find-time grows
// superlinearly with length while linear points don't): review math put
// 4-letter spam at ~0.55 pts/s vs ~0.33 for hunting fives. This curve makes a
// 5 worth four 3s and a full-rack STORM a genuine jackpot, so hunting long
// words beats hoovering short ones.
const POINTS_BY_LENGTH = { 3: 1, 4: 2, 5: 4, 6: 7, 7: 12 };
function scoreForWord(word) {
  return POINTS_BY_LENGTH[word.length] || Math.max(1, word.length - 2);
}

// How many unfound words to reveal at round end (longest first) so players
// learn what the rack was hiding.
const MISSED_REVEAL_COUNT = 8;

// ---- Word corpus (lazy, injectable) ----
// WORDS: every corpus word of length MIN_WORD_LENGTH..RACK_SIZE (racks can't
// build anything longer - word validity checks go through each round's
// precomputed rackSolutions set). RACK_SOURCES: the 7-letter words racks are
// scrambled from.
let WORDS = null;
let RACK_SOURCES = null;

function loadCorpus() {
  if (WORDS) return;
  const raw = fs
    .readFileSync(path.join(__dirname, 'botWords.txt'), 'utf8')
    .split('\n')
    .map((w) => w.trim().toLowerCase())
    .filter((w) => /^[a-z]+$/.test(w));
  _setWordsForTesting(raw);
}

// Test hook (and the tail of loadCorpus): swap the whole corpus for a small
// deterministic list so rack/solve/score rules can be tested exactly.
function _setWordsForTesting(wordList) {
  WORDS = wordList.filter((w) => w.length >= MIN_WORD_LENGTH && w.length <= RACK_SIZE);
  RACK_SOURCES = WORDS.filter((w) => w.length === RACK_SIZE);
}

/** Letter multiset of a word, e.g. 'gaga' -> { g: 2, a: 2 }. */
function letterCounts(word) {
  const counts = {};
  for (const ch of word) counts[ch] = (counts[ch] || 0) + 1;
  return counts;
}

/** True iff `word` can be spelled using the rack's letters (with multiplicity). */
function canBuildFromRack(word, rackCounts) {
  const need = letterCounts(word);
  for (const ch of Object.keys(need)) {
    if (!rackCounts[ch] || rackCounts[ch] < need[ch]) return false;
  }
  return true;
}

/** Every corpus word buildable from the rack - the round's full answer space. */
function solveRack(rackLetters) {
  loadCorpus();
  // Rack letters are displayed uppercase; the corpus is lowercase.
  const rackCounts = letterCounts(rackLetters.join('').toLowerCase());
  return WORDS.filter((w) => canBuildFromRack(w, rackCounts));
}

/** Fisher-Yates shuffle (copy). */
function shuffled(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Builds a round rack from a random unused 7-letter source word: scrambled
 * uppercase letters plus the precomputed solution set. `excludeSet` holds the
 * source words already played this game so racks never repeat.
 */
// A rack below this many total solutions is a dead round for everyone (the
// corpus's worst sources yield ~11 words vs ~199 for the richest). buildRack
// rerolls a few times for a rack over the floor, keeping the best fallback.
const RACK_MIN_SOLUTIONS = 25;
const RACK_BUILD_ATTEMPTS = 6;

function buildRack(excludeSet) {
  loadCorpus();
  const pool = excludeSet ? RACK_SOURCES.filter((w) => !excludeSet.has(w)) : RACK_SOURCES;
  const choices = pool.length ? pool : RACK_SOURCES;
  let best = null;
  for (let i = 0; i < RACK_BUILD_ATTEMPTS; i += 1) {
    const source = choices[Math.floor(Math.random() * choices.length)];
    const rack = buildRackFromSource(source);
    if (!best || rack.solutions.size > best.solutions.size) best = rack;
    if (best.solutions.size >= RACK_MIN_SOLUTIONS) break;
  }
  return best;
}

/** Deterministic rack construction from a given source word (also the test hook). */
function buildRackFromSource(source) {
  const letters = shuffled(source.split('')).map((ch) => ch.toUpperCase());
  return { source, letters, solutions: new Set(solveRack(letters)) };
}

/**
 * Creates a fresh Letter Storm game. Every player races the same rack; scores
 * accumulate across TOTAL_ROUNDS rounds.
 */
function createGame(players, difficultyKey) {
  const roundTimeSeconds = TIME_BY_DIFFICULTY[difficultyKey] || TIME_BY_DIFFICULTY.medium;
  const rack = buildRack();
  return {
    status: 'in_progress', // 'in_progress' | 'between_rounds' | 'finished'
    difficultyKey: TIME_BY_DIFFICULTY[difficultyKey] ? difficultyKey : 'medium',
    rounds: TOTAL_ROUNDS,
    currentRound: 1,
    roundTimeSeconds,
    rack: rack.letters,
    rackSource: rack.source,
    rackSolutions: rack.solutions,
    usedRackSources: new Set([rack.source]),
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      answers: [], // this round only: [{ word, points }]
      score: 0, // cumulative
    })),
    winnerId: null,
  };
}

/**
 * Applies a word from ANY player during an active round (no turns). Validates
 * shape, per-player-per-round uniqueness, rack buildability, and corpus
 * membership; on success records the word and adds its points.
 *
 * Returns { accepted: true, word, points, playerId }
 *      or { accepted: false, reason, playerId } with reason one of
 *         'not_in_game' | 'too_short' | 'invalid_chars' | 'already_said'
 *         | 'not_in_rack' | 'not_a_word'.
 */
function submitAnswer(game, playerId, rawAnswer) {
  const word = String(rawAnswer).trim().toLowerCase();
  const player = game.players.find((p) => p.id === playerId);

  if (!player) {
    return { accepted: false, reason: 'not_in_game', playerId };
  }
  if (word.length < MIN_WORD_LENGTH) {
    return { accepted: false, reason: 'too_short', playerId };
  }
  if (!/^[a-z]+$/.test(word)) {
    return { accepted: false, reason: 'invalid_chars', playerId };
  }
  if (player.answers.some((a) => a.word === word)) {
    return { accepted: false, reason: 'already_said', playerId };
  }
  // Buildability first: "those letters aren't in the rack" is the more useful
  // reject than "not a word" when both are true.
  const rackCounts = letterCounts(game.rack.join('').toLowerCase());
  if (!canBuildFromRack(word, rackCounts)) {
    return { accepted: false, reason: 'not_in_rack', playerId };
  }
  if (!game.rackSolutions.has(word)) {
    return { accepted: false, reason: 'not_a_word', playerId };
  }

  const points = scoreForWord(word);
  player.answers.push({ word, points });
  player.score += points;

  return { accepted: true, word, points, playerId };
}

/**
 * The longest words nobody found this round (up to MISSED_REVEAL_COUNT,
 * longest first, ties alphabetical) - the round-end "look what you missed".
 */
function buildMissedWords(game) {
  const found = new Set();
  game.players.forEach((p) => p.answers.forEach((a) => found.add(a.word)));
  return [...game.rackSolutions]
    .filter((w) => !found.has(w))
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, MISSED_REVEAL_COUNT);
}

/**
 * Closes the round: flips to 'between_rounds' and returns the reveal snapshot
 * (everyone's words + points, the rack's source word, and the best misses).
 */
function endRound(game) {
  game.status = 'between_rounds';
  return {
    round: game.currentRound,
    letters: [...game.rack],
    rackSource: game.rackSource,
    playerResults: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      words: [...p.answers],
      roundScore: p.answers.reduce((sum, a) => sum + a.points, 0),
    })),
    missedWords: buildMissedWords(game),
  };
}

/**
 * Highest cumulative score wins; ties break to the earlier-joined player.
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
 * Advances to the next round (fresh non-repeating rack, answers cleared) or
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
  const rack = buildRack(game.usedRackSources);
  game.rack = rack.letters;
  game.rackSource = rack.source;
  game.rackSolutions = rack.solutions;
  game.usedRackSources.add(rack.source);
  game.players.forEach((p) => {
    p.answers = [];
  });
  game.status = 'in_progress';

  return {
    round: game.currentRound,
    letters: [...game.rack],
    timerSeconds: game.roundTimeSeconds,
  };
}

/** Scoreboard sorted by cumulative score, highest first. */
function getScoreboard(game) {
  return game.players
    .map((p) => ({ id: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

/* ============================== ORCHESTRATOR ============================== */
// Mirrors Category Blitz's round plumbing on the room's standard round-timer
// slots (roundTimerInterval / roundPauseTimeout / countdownTimeout), so every
// existing cleanup path tears it down unchanged.

const ROUND_INTERMISSION_MS = 5000;

function buildRoundStartPayload(game) {
  return {
    type: 'round_start',
    payload: {
      round: game.currentRound,
      totalRounds: game.rounds,
      letters: [...game.rack],
      timerSeconds: game.roundTimeSeconds,
    },
  };
}

/** Opening broadcast + first round clock (delayed past the 3-2-1 countdown). */
function start(room, helpers) {
  helpers.broadcastToRoom(room, buildRoundStartPayload(room.game));
  helpers.scheduleTimerAfterCountdown(room, (r) => startRoundTimer(r, helpers));
}

/**
 * The round clock: timer_tick every second; at zero, reveal the round
 * (round_end), pause, then either the next round or game_over.
 */
function startRoundTimer(room, helpers) {
  helpers.clearRoundTimer(room);

  const { game } = room;
  let remaining = game.roundTimeSeconds;
  room.roundDeadline = Date.now() + remaining * 1000;

  room.roundTimerInterval = setInterval(() => {
    remaining -= 1;

    if (remaining <= 0) {
      helpers.clearRoundTimer(room);

      helpers.broadcastToRoom(room, { type: 'round_end', payload: endRound(game) });

      room.roundPauseTimeout = setTimeout(() => {
        room.roundPauseTimeout = null;
        const next = startNextRound(game);
        if (next === null) {
          helpers.broadcastToRoom(room, {
            type: 'game_over',
            payload: {
              gameType: 'letter-storm',
              winnerId: game.winnerId,
              finalScores: getScoreboard(game),
            },
          });
        } else {
          helpers.broadcastToRoom(room, buildRoundStartPayload(game));
          helpers.scheduleTimerAfterCountdown(room, (r) => startRoundTimer(r, helpers));
        }
      }, ROUND_INTERMISSION_MS);

      return;
    }

    helpers.broadcastToRoom(room, {
      type: 'timer_tick',
      payload: { secondsRemaining: remaining },
    });
  }, 1000);
}

/**
 * A word submission routed here by roomManager. No turn check - everyone
 * races at once. The accept/reject goes ONLY to the submitter (your finds
 * stay secret until the reveal); a count-only player_progress is broadcast
 * so the UI can show the race without leaking words.
 */
function handleSubmit(room, connectionId, word, helpers) {
  const { game } = room;
  if (!game || game.gameType !== 'letter-storm') {
    return { error: 'no_active_game' };
  }
  if (game.status !== 'in_progress') {
    return { error: 'round_not_active' };
  }

  const result = submitAnswer(game, connectionId, word);

  const connection = room.players.find((p) => p.id === connectionId)?.connection;
  if (connection && connection.readyState === 1) {
    connection.send(JSON.stringify({ type: 'answer_result', payload: result }));
  }

  if (result.accepted) {
    helpers.touchRoom(room);
    const player = game.players.find((p) => p.id === connectionId);
    helpers.broadcastToRoom(room, {
      type: 'player_progress',
      payload: {
        playerId: connectionId,
        wordCount: player ? player.answers.length : 0,
      },
    });
    // A full-rack STORM is the mode's signature moment - announce it the
    // instant it lands (name only; the word itself stays secret until the
    // reveal) so the room erupts in real time instead of at round end.
    if (result.word.length === RACK_SIZE) {
      helpers.broadcastToRoom(room, {
        type: 'storm',
        payload: { playerId: connectionId, playerName: player ? player.name : 'Someone' },
      });
    }
  }

  return { result };
}

/**
 * A player left mid-game: drop them from the live roster (the round clock
 * keeps running for everyone else, same as Category Blitz).
 */
function handleLeave(room, connectionId) {
  const { game } = room;
  if (!game) return;
  if (Array.isArray(game.players)) {
    game.players = game.players.filter((p) => p.id !== connectionId);
  }
}

module.exports = {
  // plugin surface (consumed via t5Modes.js)
  gameType: 'letter-storm',
  minPlayers: MIN_PLAYERS_TO_START,
  logic: { createGame },
  start,
  handleSubmit,
  handleLeave,
  // pure logic (unit tests)
  TOTAL_ROUNDS,
  RACK_SIZE,
  MIN_WORD_LENGTH,
  POINTS_BY_LENGTH,
  RACK_MIN_SOLUTIONS,
  TIME_BY_DIFFICULTY,
  MISSED_REVEAL_COUNT,
  scoreForWord,
  letterCounts,
  canBuildFromRack,
  solveRack,
  buildRack,
  buildRackFromSource,
  createGame,
  submitAnswer,
  endRound,
  startNextRound,
  buildMissedWords,
  getScoreboard,
  _setWordsForTesting,
};
