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
  WORDS = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length >= 3 && /^[a-z]+$/.test(w));
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
// How fast and how reliably the bot plays, keyed by the room's difficultyKey
// (the SAME keys the timer presets use; the frontend shows them as
// HARD / CRAZY / HELL). delayFrac is the [min,max] fraction of the CURRENT
// turn's timer the bot waits before submitting (lower = faster); miss is the
// chance it freezes and lets the turn time out, dropping a life.
const BOT_DIFFICULTY = {
  easy:   { delayFrac: [0.40, 0.70], miss: 0.15 }, // shown as HARD  - slow, beatable
  medium: { delayFrac: [0.25, 0.50], miss: 0.08 }, // shown as CRAZY - challenging
  hard:   { delayFrac: [0.15, 0.35], miss: 0.03 }, // shown as HELL  - brutal, fast
};

function tuningFor(difficultyKey) {
  return BOT_DIFFICULTY[difficultyKey] || BOT_DIFFICULTY.medium;
}

/** True if the bot should "choke" this turn (do nothing and time out). */
function rollMiss(difficultyKey) {
  return Math.random() < tuningFor(difficultyKey).miss;
}

// Never submit later than (timer - this) so the async submission (and its
// dictionary check) always lands comfortably before the turn would time out,
// even on the shortest floor timer.
const SAFETY_MARGIN_MS = 900;

/**
 * Milliseconds the bot should wait before submitting on its turn: a random
 * fraction of the turn's timer scaled by difficulty, hard-capped a safe margin
 * below the deadline.
 */
function computeDelayMs(difficultyKey, timerSeconds) {
  const totalMs = Math.max(0, timerSeconds || 0) * 1000;
  const [lo, hi] = tuningFor(difficultyKey).delayFrac;
  const frac = lo + Math.random() * (hi - lo);
  const ceiling = Math.max(0, totalMs - SAFETY_MARGIN_MS);
  return Math.min(totalMs * frac, ceiling);
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
  _loadWords: loadWords, // exposed for tests
};
