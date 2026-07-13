// categoryBlitzBot.js
// Server-side bot opponent for Category Blitz, mirroring wordBombBot.js: the
// bot is a normal player entry in room.players / game.players carrying a mock
// "sink" connection (readyState OPEN + a no-op send), so every broadcast path
// treats it like a connected player. Each round it submits answers through the
// SAME handleCategoryAnswer path a human uses - no separate scoring codepath.
//
// Unlike Word Bomb there's no AI here at all: every answer is drawn straight
// from the category's pre-generated accept-list (CATEGORY_ANSWERS), so Stage-1
// validation always hits and the Haiku judge is never consulted for a bot
// answer - by construction, not by special-casing.
//
// This module is pure data + helpers (answer lookup, identity, difficulty
// pacing). The room manager owns the actual setTimeouts that fire the bot's
// answers during a round.

const CATEGORY_ANSWERS = require('./categoryAnswers');

/* ============================== IDENTITY ============================== */
// Fun, on-brand opponent names (same Newgrounds/FNF energy as the Word Bomb
// roster, but trivia/list flavored). Kept short so they sit in player cards.
const BOT_NAMES = [
  'LISTZILLA', 'TRIVIA-TRON', 'CATEGORINATOR', 'QUIZ-KHALIFA', 'FACTOID-FRED',
  'NOUN-MACHINE', 'RAPID-RANDY', 'SIR-LISTS-A-LOT', 'ENCYCLO-PETE',
  'BRAINSTORM-BETTY', 'TOPIC-TERMINATOR', 'ANSWER-ANNIE', 'SPEEDY-SPECS',
  'THE-ENUMERATOR', 'BUZZER-BEATER', 'KILOBYTE-KATE', 'BLITZ-KRIEG-BOB',
  'GIGA-GENIUS', 'CATEGORY-CARL', 'ZAPPY-ZOE',
];

function randomBotName() {
  return BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
}

let botCounter = 0;

/**
 * Builds a bot player entry for room.players at the given difficulty
 * (easy|medium|hard, defaulting to medium). Shaped exactly like
 * wordBombBot.createBotPlayer's output - mock OPEN connection with a no-op
 * send, connection id mirroring the player id - plus `botGameType` so the
 * lobby can drop a stale-flavor bot when the host switches game modes.
 * `botDifficulty` drives only this bot's answers-per-round and pacing.
 */
function createBotPlayer(difficulty) {
  botCounter += 1;
  const id = `blitzbot-${botCounter}-${Math.random().toString(36).slice(2, 8)}`;
  const botDifficulty = BOT_DIFFICULTY[difficulty] ? difficulty : 'medium';
  return {
    id,
    name: randomBotName(),
    isBot: true,
    botGameType: 'category-blitz',
    botDifficulty,
    connection: { id, readyState: 1, send() {} },
  };
}

/* ========================= DIFFICULTY PACING ========================= */
// How many answers the bot lands per round and how briskly it types them.
// `answers` is the [min,max] answers it attempts per round; `firstDelayMs` is
// the [min,max] wait before its first answer (thinking time); `intervalMs` is
// the [min,max] gap between consecutive answers (jitter, so it doesn't tick
// like a metronome). Tiers map to the same easy/medium/hard keys as Word Bomb.
const BOT_DIFFICULTY = {
  easy:   { answers: [2, 3], firstDelayMs: [2500, 5000], intervalMs: [4000, 7000] }, // slow, beatable
  medium: { answers: [4, 5], firstDelayMs: [1500, 3500], intervalMs: [2500, 4500] }, // challenging
  hard:   { answers: [6, 8], firstDelayMs: [800, 2000],  intervalMs: [1600, 2600] }, // brisk, brutal
};

function tuningFor(difficultyKey) {
  return BOT_DIFFICULTY[difficultyKey] || BOT_DIFFICULTY.medium;
}

function randBetween([lo, hi]) {
  return lo + Math.random() * (hi - lo);
}

// Never submit later than (round end - this), so the answer lands comfortably
// inside the round even if the event loop is momentarily busy.
const SAFETY_MARGIN_MS = 900;

/**
 * Plans this round's submissions: an ascending array of millisecond offsets
 * (from round start) at which the bot should submit an answer. The count comes
 * from the difficulty's answers range; the first offset and each gap are
 * jittered within the difficulty's bounds. Offsets that would land past
 * (round length - SAFETY_MARGIN_MS) are dropped, so a short round simply gets
 * fewer answers - the bot can never submit at/after the round deadline.
 */
function buildAnswerSchedule(difficultyKey, roundSeconds) {
  const t = tuningFor(difficultyKey);
  const roundMs = Math.max(0, roundSeconds || 0) * 1000;
  const ceiling = roundMs - SAFETY_MARGIN_MS;
  const [lo, hi] = t.answers;
  const count = lo + Math.floor(Math.random() * (hi - lo + 1));

  const offsets = [];
  let at = randBetween(t.firstDelayMs);
  for (let i = 0; i < count && at <= ceiling; i += 1) {
    offsets.push(Math.round(at));
    at += randBetween(t.intervalMs);
  }
  return offsets;
}

/**
 * Picks a random answer from `category`'s accept-list that the bot hasn't
 * already given this round (case-insensitive, matching submitAnswer's own
 * duplicate check). Returns null when the category has no accept-list or
 * everything usable was already given - the caller just skips that beat, the
 * bot "blanks". Entries under submitAnswer's 2-char floor are skipped so a
 * picked answer is accepted by construction.
 */
function pickAnswer(category, alreadyGiven) {
  const set = CATEGORY_ANSWERS[category];
  if (!set || set.size === 0) return null;
  const given = new Set((alreadyGiven || []).map((a) => String(a).toLowerCase()));
  const pool = [];
  for (const answer of set) {
    const a = String(answer).trim();
    if (a.length < 2) continue;
    if (given.has(a.toLowerCase())) continue;
    pool.push(a);
  }
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = {
  createBotPlayer,
  randomBotName,
  buildAnswerSchedule,
  pickAnswer,
  BOT_NAMES,
  BOT_DIFFICULTY,
  SAFETY_MARGIN_MS,
};
