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
// How fast and how reliably the bot plays, keyed by the bot's OWN difficulty
// (easy|medium|hard; the frontend surfaces these as the opponent's skill, not
// the room's timer preset). `delaySec` is the [min,max] ABSOLUTE seconds the
// bot "thinks" before submitting — humanized reaction time, NOT a fraction of
// the turn clock, so a medium bot can no longer answer in ~0.2s and win by
// pure speed. `miss` is the chance it freezes and lets the turn time out,
// dropping a life, which makes attrition wins possible.
//
// Reaction windows (per the balance spec):
//   easy   4.0-8.0s, ~15% timeout   -> slow, very beatable
//   medium 2.0-5.0s, ~5%  timeout   -> challenging but attrition-vulnerable
//   hard   1.0-2.5s, ~1%  timeout   -> fast, near-relentless
const BOT_DIFFICULTY = {
  easy:   { delaySec: [4.0, 8.0], miss: 0.15 },
  medium: { delaySec: [2.0, 5.0], miss: 0.05 },
  hard:   { delaySec: [1.0, 2.5], miss: 0.01 },
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

// THE BOT FEELS THE FUSE (Batch A, Andy oct2: "median human vs MEDIUM wins 45-60%"). A human's
// misses climb as the fuse shortens; the bot's never did (its delay is clamped under the timer, so
// only the flat miss roll could cost it a life) — median human vs MEDIUM measured 18.6%. Now the miss
// chance climbs linearly from the preset rate at a full 20 s fuse to PRESSURE_MULT× it at 8 s and
// below: MEDIUM 5% → 13%. Median-human model (3.5 s think + typing, frontend
// claude/batch-a/wb-winrate-sim.mjs): 51.3% (slower player 34%, faster 77%).
const PRESSURE_MULT = 2.6;
const PRESSURE_FULL_S = 20;
const PRESSURE_FLOOR_S = 8;
function missChance(difficultyKey, timerSeconds) {
  const base = tuningFor(difficultyKey).miss;
  const t = Number(timerSeconds);
  if (!Number.isFinite(t) || t <= 0) return base;
  const k = Math.min(1, Math.max(0, (PRESSURE_FULL_S - t) / (PRESSURE_FULL_S - PRESSURE_FLOOR_S)));
  return base * (1 + (PRESSURE_MULT - 1) * k);
}

/** True if the bot should "choke" this turn (do nothing and time out). */
function rollMiss(difficultyKey, timerSeconds) {
  return Math.random() < missChance(difficultyKey, timerSeconds);
}

// Approximate a standard normal via the sum-of-uniforms (Bates) method — cheap,
// no dependency, and bounded to [-1, 1] here so we never produce absurd tails.
// Returns a value in roughly [-1, 1] clustered around 0.
function gaussianJitter() {
  const n = (Math.random() + Math.random() + Math.random()) / 3; // ~[0,1], bell-ish
  return n * 2 - 1; // shift to ~[-1, 1] centered on 0
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
  const [lo, hi] = tuningFor(difficultyKey).delaySec;
  const mid = (lo + hi) / 2;
  const halfSpan = (hi - lo) / 2;
  // Center on the midpoint, spread out by jitter across (roughly) the full band.
  let sec = mid + gaussianJitter() * halfSpan;
  sec = Math.max(lo, Math.min(hi, sec)); // keep within the difficulty window
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

/* ========================= VISIBLE CHOKE (FUMBLE) ========================= */
// A miss used to be a silent return: the bot's slot sat frozen for the WHOLE turn timer while the
// fuse burned, the longest dead stretch in a newcomer's first solo round (measured 14.5 s,
// frontend claude/step35/report.md). The miss RATE is unchanged; a choking bot now visibly TRIES
// over the existing typing_update relay: it types a few letters one at a time, stalls, backspaces
// them, tries again, and times out exactly as before. Pure plan here (testable); roomManager runs
// the timers.
//
// NO FREE ANSWERS. After a bot times out the fragment usually stays the same for the human's next
// turn, so a fumble must never show the start of a playable word. Every attempt is a DEAD END:
// a real candidate's first 1-3 letters plus a wrong letter, chosen so that NO English word
// containing the fragment starts with it (checked against the same an-array-of-english-words list
// the dictionary accepts from). deadEndAttempt() builds it; the fumble tests pin it.
const FUMBLE_TYPE_MS = 140; // per letter typed
const FUMBLE_HOLD_MS = 500; // the stall with the letters up
const FUMBLE_BACK_MS = 90; // per letter deleted
const FUMBLE_GAP_MS = 3000; // attempt start to next attempt start
const FUMBLE_MAX_TRIES = 6;
const FUMBLE_SHOW_MS = FUMBLE_HOLD_MS; // the hold with the letters up

// PREFIX INDEX, built once: every English word bucketed by its first two letters. Checking "does any
// valid word containing the fragment start with P" is then a scan of ONE bucket (~700 words on
// average) instead of the 275k-word list — this runs inside a turn-timer callback on the one shared
// process, so it must stay sub-millisecond (measured: the per-fragment scan it replaced cost up to
// 100 ms warm and 300-700 ms cold, stalling every room's timer_tick).
let byPrefix2 = null;
function prefixIndex() {
  if (byPrefix2) return byPrefix2;
  byPrefix2 = new Map();
  let list = [];
  try { list = require('an-array-of-english-words'); } catch { list = []; }
  for (const w of list) {
    if (w.length < 2) continue;
    const k = w.slice(0, 2);
    let b = byPrefix2.get(k);
    if (!b) { b = []; byPrefix2.set(k, b); }
    b.push(w);
  }
  return byPrefix2;
}

/** True if some valid word containing `combo` starts with `prefix` (i.e. the prefix is a hint). */
function isAnswerPrefix(prefix, combo) {
  const p = String(prefix || '').toLowerCase();
  const c = String(combo || '').toLowerCase();
  if (p.length < 2) return true; // too short to judge: treat as unsafe
  const bucket = prefixIndex().get(p.slice(0, 2)) || [];
  for (const w of bucket) if (w.startsWith(p) && w.includes(c)) return true;
  return false;
}

/** Build the index ahead of the first fumble (server boot calls this off the hot path). */
function warmFumbleIndex() { prefixIndex(); }

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
/** A dead-end attempt for `combo`, seeded from a real candidate word. Upper-case, 2-4 letters. */
function deadEndAttempt(word, combo, rand = Math.random) {
  const w = String(word || '').toLowerCase();
  const keeps = [2, 3, 1].filter((k) => k < w.length);
  for (const k of keeps) {
    const base = w.slice(0, k);
    const start = Math.floor(rand() * 26);
    for (let i = 0; i < 26; i++) {
      const s = base + ALPHABET[(start + i) % 26];
      if (!isAnswerPrefix(s, combo)) return s.toUpperCase();
    }
  }
  return null;
}

/**
 * The timeline for a choking bot's turn. `attempts` are dead-end strings (deadEndAttempt). Each
 * attempt types its letters one by one, holds, then backspaces them one by one; attempts start
 * every FUMBLE_GAP_MS from the bot's normal reaction delay for the WHOLE turn (up to
 * FUMBLE_MAX_TRIES). Consecutive attempts never show the same letters. Anything that would end
 * inside the safety margin before the turn times out is dropped. Returns [{ at, text }].
 */
function fumblePlan(attempts, firstAtMs, timerSeconds) {
  const plan = [];
  const limit = Math.max(0, (timerSeconds || 0) * 1000 - SAFETY_MARGIN_MS);
  const pool = (attempts || []).filter((x) => typeof x === 'string' && x.length >= 1);
  if (!pool.length) return plan;
  let prev = '';
  let used = 0;
  for (let i = 0; used < FUMBLE_MAX_TRIES && i < FUMBLE_MAX_TRIES * 3; i++) {
    const at = firstAtMs + used * FUMBLE_GAP_MS;
    const text = pool[i % pool.length].toUpperCase();
    if (text === prev) continue;
    const holdEnd = at + text.length * FUMBLE_TYPE_MS + FUMBLE_HOLD_MS;
    const end = holdEnd + text.length * FUMBLE_BACK_MS;
    if (end > limit) break;
    for (let k = 1; k <= text.length; k++) plan.push({ at: at + (k - 1) * FUMBLE_TYPE_MS, text: text.slice(0, k) });
    for (let k = text.length - 1; k >= 0; k--) plan.push({ at: holdEnd + (text.length - 1 - k) * FUMBLE_BACK_MS, text: text.slice(0, k) });
    prev = text;
    used += 1;
  }
  return plan;
}

module.exports = {
  fumblePlan,
  deadEndAttempt,
  isAnswerPrefix,
  warmFumbleIndex,
  FUMBLE_SHOW_MS,
  FUMBLE_GAP_MS,
  FUMBLE_MAX_TRIES,
  FUMBLE_TYPE_MS,
  FUMBLE_HOLD_MS,
  FUMBLE_BACK_MS,
  pickWord,
  createBotPlayer,
  rollMiss,
  missChance,
  computeDelayMs,
  randomBotName,
  BOT_NAMES,
  BOT_DIFFICULTY,
  SAFETY_MARGIN_MS,
  MIN_REACTION_MS,
  _loadWords: loadWords, // exposed for tests
};
