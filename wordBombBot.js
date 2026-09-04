// wordBombBot.js
// Server-side AI opponent for Word Bomb, so a solo visitor gets a real game
// instead of staring at "waiting for players". The bot is just a normal player
// entry in room.players / game.players carrying a mock "sink" connection
// (readyState OPEN + a no-op send), so every existing broadcast path treats it
// like any connected player and never has to special-case it (approach A). On
// its turn the room manager has it submit a real word through the SAME
// handleWordSubmission path a human uses - there is no separate turn codepath.
//
// This module is pure data + helpers (word lookup, identity, difficulty timing).
// The room manager owns the actual setTimeout that fires the bot's move.

const fs = require('fs');
const path = require('path');
const { filterWords } = require('./wordFilter');

/* ============================ WORD SOURCE ============================ */
// A bundled list of ~18k common, frequency-ranked English words lives in
// botWords.txt (one per line, already lowercase / alphabetic / length >= 3).
// It's kept as a separate data file (not inlined here) so it can be regenerated
// or expanded without touching logic. Loaded once, lazily, on first bot move so
// startup stays cheap for rooms that never spawn a bot.
let WORDS = null; // string[] in frequency order (most common first)
const comboIndex = new Map(); // combo -> string[] of words containing it (freq order)

function loadWords() {
  if (WORDS) return WORDS;
  const file = path.join(__dirname, 'botWords.txt');
  const raw = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length >= 3 && /^[a-z]+$/.test(w));
  // Drop proper nouns / place names / foreign entries so the bot never plays a
  // word a human wouldn't be allowed to submit (same filter dictionary.js uses).
  WORDS = filterWords(raw);
  return WORDS;
}

// All words containing `combo`, in frequency order, built once per combo and
// cached so repeated turns on the same combo are instant.
function wordsForCombo(combo) {
  if (comboIndex.has(combo)) return comboIndex.get(combo);
  const list = loadWords().filter((w) => w.includes(combo));
  comboIndex.set(combo, list);
  return list;
}

/**
 * Picks a real word containing `combo` that hasn't been used yet. The match list
 * is frequency-ordered (common words first); selection is biased toward the
 * front (Math.random() squared) so the bot mostly plays words a human would
 * recognise, only occasionally reaching for a rarer one. Returns null if nothing
 * is available (e.g. every word for this combo is already used) - extremely
 * rare, and the caller treats it as a missed turn.
 */
function pickWord(combo, usedWords) {
  const used = usedWords instanceof Set ? usedWords : new Set(usedWords || []);
  const pool = wordsForCombo(combo).filter((w) => !used.has(w));
  if (pool.length === 0) return null;
  const r = Math.random();
  const idx = Math.floor(r * r * pool.length); // r^2 skews toward 0 = common end
  return pool[idx];
}

/* ============================== IDENTITY ============================== */
// Fun, on-brand opponent names (Newgrounds/FNF energy). Kept short so they sit
// nicely inside the player cards.
const BOT_NAMES = [
  'ROBO-RICK', 'BOTIMUS PRIME', 'CPU-CHAD', 'LEXIBOT 3000', 'WORDTRON',
  'SPELLZILLA', 'MEGA-MIND', 'BYTE-BRAIN', 'AUTO-ANNIE', 'QWERTY-BOT',
  'GIGA-GUESSER', 'SYNTAX-SAM', 'VOCAB-VADER', 'DICTIONATOR', 'BOOLEAN-BOB',
  'CTRL-DEFEAT', 'NEON-NANCY', 'PIXEL-PETE', 'TURBO-TYPER', 'GLITCH-GORDON',
  'MAINFRAME-MABEL', 'BUZZWORD-BAX', 'CACHE-MONEY', 'RAM-RANDY',
];

function randomBotName() {
  return BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
}

let botCounter = 0;

/**
 * Builds a bot player entry for room.players at the given difficulty
 * (easy|medium|hard, defaulting to medium). The mock connection has readyState 1
 * (OPEN) and a no-op send, so broadcastToRoom / the typing relay / every other
 * p.connection.send site treats it like a connected player with zero changes.
 * `isBot` lets the room manager find or skip it where it matters (disconnect
 * cleanup, listings); `botDifficulty` drives the bot's speed/miss rate,
 * independent of the room's timer difficulty. The connection id mirrors the
 * player id, matching how real players are shaped.
 */
function createBotPlayer(difficulty) {
  botCounter += 1;
  const id = `bot-${botCounter}-${Math.random().toString(36).slice(2, 8)}`;
  const botDifficulty = BOT_DIFFICULTY[difficulty] ? difficulty : 'medium';
  return {
    id,
    name: randomBotName(),
    isBot: true,
    botGameType: 'word-bomb', // which mode this bot was built for (see set_game_type)
    botDifficulty,
    connection: { id, readyState: 1, send() {} },
  };
}

/* ========================= DIFFICULTY TIMING ========================= */
// HUMAN-LIKE reaction, keyed by difficulty (chill|easy|medium|hard — now aligned
// with the room presets so the opponent's skill scales with the room). The old
// uniform [min,max] window read as a metronome; this samples a LOGNORMAL reaction
// time (most answers near the median, a long right tail of the occasional slow
// one) and adds occasional THINKING PAUSES, so no two turns look the same.
//   median      s   the typical reaction (descending: a chill bot mulls, a hard
//                   bot fires) — the FEEL knob.
//   sigma           lognormal spread (log-space); bigger = more variance.
//   choke           per-turn chance it can't find a word and times out (a life) —
//                   the "bots sometimes lose" knob, TUNED so the human win rate
//                   lands in band (see _botFeelSim.mjs).
//   thinkPause      chance a turn carries an extra deliberation (×1.6 time).
//   nearMiss        chance a slow (would-time-out) answer still lands with <1s
//                   left instead of choking — a human clutch, not a freeze.
//
// TUNED to the target human win rates (1,000-game sim, _botFeelSim.mjs):
//   chill  median 4.5s, choke  4.5%  -> human ~80% (target 75-85)
//   easy   median 3.4s, choke  3.2%  -> human ~60% (target 55-65)
//   medium median 2.4s, choke  7.8%  -> human ~45% (target 40-50)
//   hard   median 1.6s, choke 14.5%  -> human ~25% (target 20-30)
const BOT_DIFFICULTY = {
  chill:  { median: 4.5, sigma: 0.55, choke: 0.045, thinkPause: 0.14, nearMiss: 0.25 },
  easy:   { median: 3.4, sigma: 0.5,  choke: 0.032, thinkPause: 0.11, nearMiss: 0.3 },
  medium: { median: 2.4, sigma: 0.45, choke: 0.078, thinkPause: 0.09, nearMiss: 0.35 },
  hard:   { median: 1.6, sigma: 0.4,  choke: 0.145, thinkPause: 0.06, nearMiss: 0.45 },
};

// No difficulty ever reacts faster than this — a sub-second bot feels robotic
// and denies the human any chance to type. Absolute floor applied after jitter.
const MIN_REACTION_MS = 1000;

// Never submit later than (timer - this) so the async submission (and its
// dictionary check) always lands comfortably before the turn would time out,
// even on the shortest floor timer. Only bites when the sampled reaction time
// would otherwise exceed the turn clock (e.g. an 8s easy bot on a 7s HELL room).
const SAFETY_MARGIN_MS = 900;

function tuningFor(difficultyKey) {
  return BOT_DIFFICULTY[difficultyKey] || BOT_DIFFICULTY.medium;
}

/** True if the bot should "choke" this turn (do nothing and time out) — the
 *  per-difficulty choke rate, tuned so the human win rate lands in band. */
function rollMiss(difficultyKey) {
  return Math.random() < tuningFor(difficultyKey).choke;
}

// A standard normal (Box-Muller), CLAMPED to [-2.5, 2.5] so the lognormal reaction
// never produces an absurd multi-tens-of-seconds tail. Mean 0, unit variance.
function standardNormal() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(-2.5, Math.min(2.5, z));
}

/**
 * Milliseconds the bot should wait before submitting on its turn: an ABSOLUTE
 * humanized reaction time sampled per turn from the difficulty's [min,max]
 * second window, biased toward the middle with gaussian-ish jitter so it feels
 * organic rather than uniform. Clamped to never fire below MIN_REACTION_MS and
 * (when a turn clock is given) never later than a safe margin before timeout.
 *
 * `timerSeconds` is optional and now only acts as a ceiling: the reaction time
 * is independent of the turn length, but on very short rooms we still guarantee
 * the submission lands before the deadline.
 */
function computeDelayMs(difficultyKey, timerSeconds) {
  const cfg = tuningFor(difficultyKey);
  // LOGNORMAL reaction: median * exp(sigma * Z). Most turns cluster near the
  // median with a natural long right tail (the occasional slow one) — organic,
  // never the old uniform metronome.
  let sec = cfg.median * Math.exp(cfg.sigma * standardNormal());
  // Occasional THINKING PAUSE — a longer deliberation on this particular turn.
  if (Math.random() < (cfg.thinkPause || 0)) sec *= 1.6;
  let ms = Math.max(MIN_REACTION_MS, sec * 1000);

  // On very short rooms (e.g. a slow easy bot on a 7s HELL timer) cap the
  // reaction so the submission still lands before the turn times out. Deliberate
  // timeouts are governed by rollMiss, not by overrunning the clock here.
  const totalMs = Math.max(0, timerSeconds || 0) * 1000;
  if (totalMs > 0) {
    const ceiling = Math.max(0, totalMs - SAFETY_MARGIN_MS);
    ms = Math.min(ms, ceiling);
  }
  return ms;
}

module.exports = {
  pickWord,
  createBotPlayer,
  rollMiss,
  computeDelayMs,
  randomBotName,
  BOT_NAMES,
  BOT_DIFFICULTY,
  SAFETY_MARGIN_MS,
  MIN_REACTION_MS,
  _loadWords: loadWords, // exposed for tests
};
