// _botFeelSim.mjs — JOB 8 (feat/bot-feel). Simulate 1,000 human-vs-bot Word Bomb
// games per difficulty and report the HUMAN win rate, then AUTO-TUNE the bot's
// lognormal median per difficulty until every difficulty lands in its target band:
//   chill 75-85%, easy 55-65%, medium 40-50%, hard 20-30%.
//
// The game model mirrors gameLogic.js: a 1v1 bomb game, alternating turns, the turn
// clock starts at startSeconds and drops by 1 every decreaseEveryNTurns down to
// floorSeconds; a player who can't answer within the clock (or "chokes") loses a
// life; last one standing wins.
//
// Run: node _botFeelSim.mjs
'use strict';

// ---- room presets (verbatim from gameLogic.js DIFFICULTY_PRESETS) ----
const PRESETS = {
  chill: { startSeconds: 20, decreaseEveryNTurns: 4, floorSeconds: 8, lives: 3 },
  easy: { startSeconds: 15, decreaseEveryNTurns: 3, floorSeconds: 6, lives: 2 },
  medium: { startSeconds: 10, decreaseEveryNTurns: 2, floorSeconds: 4, lives: 2 },
  hard: { startSeconds: 7, decreaseEveryNTurns: 1, floorSeconds: 3, lives: 2 },
};
const BANDS = { chill: [75, 85], easy: [55, 65], medium: [40, 50], hard: [20, 30] };

// ---- the FIXED human model (the same person across difficulties; only the clock
// and the bot change) — a lognormal answer time + a base "can't find a word" rate.
const HUMAN = { median: 2.6, sigma: 0.5, choke: 0.05 };

function clock(preset, completedTurns) {
  return Math.max(preset.floorSeconds, preset.startSeconds - Math.floor(completedTurns / preset.decreaseEveryNTurns));
}

// mulberry32 for reproducibility
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// standard normal via Box-Muller
function randn(rnd) { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
// lognormal answer time (seconds): median * exp(sigma * Z)
function answerTime(median, sigma, rnd) { return median * Math.exp(sigma * randn(rnd)); }

// One actor's turn → does it survive? (true = answered in time, false = lost a life)
// A "thinking pause" (rare) inflates the time; a "near-miss" pulls a slow answer to
// just under the wire (answers with <1s left) instead of timing out.
function survivesTurn(actor, turnClock, rnd) {
  if (rnd() < actor.choke) return false; // couldn't find a word at all
  let t = answerTime(actor.median, actor.sigma, rnd);
  if (actor.thinkPause && rnd() < actor.thinkPause) t *= 1.6; // occasional deliberation
  if (t > turnClock) {
    // near-miss recovery: a slightly-slow answer sometimes lands with <1s to spare
    if (actor.nearMiss && rnd() < actor.nearMiss && t < turnClock * 1.5) return true;
    return false;
  }
  return true;
}

function playGame(preset, human, bot, rnd, humanFirst) {
  const p = [{ ...human, lives: preset.lives }, { ...bot, lives: preset.lives }];
  let turnIdx = humanFirst ? 0 : 1;
  let completed = 0;
  for (let guard = 0; guard < 2000; guard++) {
    const actor = p[turnIdx];
    const tc = clock(preset, completed);
    if (!survivesTurn(actor, tc, rnd)) {
      actor.lives -= 1;
      if (actor.lives <= 0) return turnIdx === 0 ? 'bot' : 'human'; // the OTHER wins
    }
    completed += 1;
    turnIdx = 1 - turnIdx;
  }
  return 'draw';
}

function humanWinRate(diff, botMedian, botCfg, games = 1000, seed = 42) {
  const preset = PRESETS[diff];
  const rnd = mulberry32(seed + diff.length * 7);
  const human = { ...HUMAN };
  const bot = { median: botMedian, sigma: botCfg.sigma, choke: botCfg.choke, thinkPause: botCfg.thinkPause, nearMiss: botCfg.nearMiss };
  let wins = 0, draws = 0;
  for (let g = 0; g < games; g++) {
    const r = playGame(preset, human, bot, rnd, g % 2 === 0);
    if (r === 'human') wins++; else if (r === 'draw') draws++;
  }
  return (100 * wins) / (games - draws);
}

// Per-difficulty bot shape. MEDIAN is fixed human-like and DESCENDING (the feel:
// a chill bot mulls ~4.5s, a hard bot fires ~1.6s). sigma/pauses/near-miss fixed.
// Only CHOKE (the "couldn't find a word / sometimes loses" rate) is auto-tuned —
// it is the effective win-rate lever on the generous clocks and a natural knob.
const BOT_CFG = {
  chill: { median: 4.5, sigma: 0.55, thinkPause: 0.14, nearMiss: 0.25 },
  easy: { median: 3.4, sigma: 0.5, thinkPause: 0.11, nearMiss: 0.3 },
  medium: { median: 2.4, sigma: 0.45, thinkPause: 0.09, nearMiss: 0.35 },
  hard: { median: 1.6, sigma: 0.4, thinkPause: 0.06, nearMiss: 0.45 },
};

// Bisection on the bot CHOKE rate. A choke-ier bot loses more → the human wins MORE,
// so the human win-rate increases monotonically with bot choke.
function tuneChoke(diff) {
  const [lo, hi] = BANDS[diff];
  const target = (lo + hi) / 2;
  let a = 0.0, b = 0.6; // choke-rate search range
  let choke = 0.1, rate = 0;
  for (let i = 0; i < 40; i++) {
    choke = (a + b) / 2;
    rate = humanWinRate(diff, BOT_CFG[diff].median, { ...BOT_CFG[diff], choke });
    if (rate < target) a = choke; // human winning too little → make the bot choke more
    else b = choke;
  }
  return { choke, rate };
}

console.log('JOB 8 — bot pacing: human win rate over 1,000 games/difficulty (lognormal bot, fixed human)\n');
console.log('human model: lognormal median ' + HUMAN.median + 's, sigma ' + HUMAN.sigma + ', choke ' + (HUMAN.choke * 100) + '%\n');
const tuned = {};
for (const diff of ['chill', 'easy', 'medium', 'hard']) {
  const { choke, rate } = tuneChoke(diff);
  tuned[diff] = { median: BOT_CFG[diff].median, sigma: BOT_CFG[diff].sigma, choke: +choke.toFixed(3), thinkPause: BOT_CFG[diff].thinkPause, nearMiss: BOT_CFG[diff].nearMiss };
  const [lo, hi] = BANDS[diff];
  const inBand = rate >= lo && rate <= hi;
  console.log(
    diff.padEnd(7) + ' | median ' + BOT_CFG[diff].median + 's, choke ' + (choke * 100).toFixed(1) + '% | ' +
    'human win ' + rate.toFixed(1) + '% | target ' + lo + '-' + hi + '% | ' + (inBand ? 'IN BAND ✓' : 'OUT ✗'),
  );
}
console.log('\nTUNED bot params to bake into wordBombBot.js BOT_DIFFICULTY:');
console.log(JSON.stringify(tuned, null, 0));
