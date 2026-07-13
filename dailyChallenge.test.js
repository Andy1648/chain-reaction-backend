// dailyChallenge.test.js
// Daily Challenge determinism + wiring. Run with: node --test (auto-discovered).
// Pure-logic tests against categoryBlitzLogic's daily helpers, plus the
// roomManager startGame gate (solo-only) using fake ws connections.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CATEGORIES,
  TOTAL_ROUNDS,
  createGame,
  startNextRound,
  endRound,
  rerollCategory,
  dailyInfo,
  dailyCategories,
  DAILY_EPOCH_UTC,
} = require('./categoryBlitzLogic');

const {
  createRoom,
  joinRoom,
  startGame,
  clearRoundTimer,
  _resetRoomsForTesting,
} = require('./roomManager');

let nextId = 0;
function conn() {
  return { id: `d${nextId++}`, readyState: 1, send() {} };
}

test.beforeEach(() => _resetRoomsForTesting());
test.after(() => _resetRoomsForTesting());

// ---- dailyInfo: UTC day math ----------------------------------------------

test('dailyInfo: epoch day is #1 and the dateKey is the UTC date', () => {
  const info = dailyInfo(DAILY_EPOCH_UTC);
  assert.equal(info.dayNumber, 1);
  assert.equal(info.dateKey, '2026-01-01');
});

test('dailyInfo: day flips exactly at UTC midnight (not local time)', () => {
  const justBefore = Date.UTC(2026, 6, 12, 23, 59, 59, 999);
  const justAfter = Date.UTC(2026, 6, 13, 0, 0, 0, 0);
  const before = dailyInfo(justBefore);
  const after = dailyInfo(justAfter);
  assert.equal(before.dateKey, '2026-07-12');
  assert.equal(after.dateKey, '2026-07-13');
  assert.equal(after.dayNumber, before.dayNumber + 1);
});

test('dailyInfo: DST transitions do not skip or repeat a day number', () => {
  // US DST ends 2026-11-01 (clocks back), starts 2026-03-08 (clocks forward).
  // Day numbers are pure UTC integer math, so consecutive UTC noons must yield
  // consecutive day numbers straight through both transitions.
  for (const [y, m, d] of [[2026, 2, 7], [2026, 10, 0]]) {
    let prev = null;
    for (let i = 0; i < 4; i++) {
      const { dayNumber } = dailyInfo(Date.UTC(y, m, d + i, 12, 0, 0));
      if (prev !== null) assert.equal(dayNumber, prev + 1);
      prev = dayNumber;
    }
  }
});

// ---- dailyCategories: determinism ------------------------------------------

test('dailyCategories: same date -> identical board, every time', () => {
  const a = dailyCategories('2026-07-12');
  const b = dailyCategories('2026-07-12');
  assert.deepEqual(a, b);
});

test('dailyCategories: exactly TOTAL_ROUNDS distinct real categories', () => {
  const picks = dailyCategories('2026-07-12');
  assert.equal(picks.length, TOTAL_ROUNDS);
  assert.equal(new Set(picks).size, TOTAL_ROUNDS);
  picks.forEach((c) => assert.ok(CATEGORIES.includes(c), `${c} not in pool`));
});

test('dailyCategories: different dates -> different boards (30-day sweep)', () => {
  const seen = new Set();
  for (let d = 1; d <= 30; d++) {
    const key = `2026-06-${String(d).padStart(2, '0')}`;
    seen.add(JSON.stringify(dailyCategories(key)));
  }
  // With a 400+ category pool, 30 consecutive days colliding would mean the
  // seeding is broken; allow at most one coincidental collision.
  assert.ok(seen.size >= 29, `only ${seen.size} unique boards in 30 days`);
});

// ---- createGame(daily): fixed plan, no rerolls, packs ignored ---------------

function players() {
  return [{ id: 'p1', name: 'SOLO' }];
}

test('daily game: plays the planned categories in order across all rounds', () => {
  const daily = { dayNumber: 193, dateKey: '2026-07-12' };
  const plan = dailyCategories(daily.dateKey);
  const game = createGame(players(), 'medium', true, null, daily);

  assert.equal(game.currentCategory, plan[0]);
  assert.deepEqual(game.daily, daily);

  const played = [game.currentCategory];
  for (;;) {
    endRound(game);
    const next = startNextRound(game);
    if (next === null) break;
    played.push(next.category);
    assert.deepEqual(next.daily, daily, 'round_start payload carries daily');
  }
  assert.deepEqual(played, plan);
});

test('daily game: rerolls are disabled regardless of difficulty', () => {
  const daily = { dayNumber: 193, dateKey: '2026-07-12' };
  const game = createGame(players(), 'easy', true, null, daily); // easy = 3 rerolls normally
  assert.equal(game.rerollsRemaining, 0);
  assert.deepEqual(rerollCategory(game), { error: 'no_rerolls_left' });
});

test('daily game: pack selection is ignored (everyone gets the same board)', () => {
  const daily = { dayNumber: 193, dateKey: '2026-07-12' };
  const withPacks = createGame(players(), 'medium', true, ['food'], daily);
  const withoutPacks = createGame(players(), 'medium', true, null, daily);
  assert.equal(withPacks.currentCategory, withoutPacks.currentCategory);
  assert.deepEqual(withPacks.dailyPlan, withoutPacks.dailyPlan);
  assert.equal(withPacks.selectedPacks, null);
});

test('normal game: unaffected — random category, difficulty rerolls, no daily', () => {
  const game = createGame(players(), 'easy', true, null);
  assert.equal(game.daily, null);
  assert.equal(game.dailyPlan, null);
  assert.equal(game.rerollsRemaining, 3);
});

// ---- startGame gate: solo Category Blitz only -------------------------------

test('startGame daily: solo blitz room starts with the day board and no rerolls', () => {
  const { room } = createRoom(conn(), 'SOLO');
  room.gameType = 'category-blitz';
  const result = startGame(room, { daily: true });
  assert.ok(!result.error, `unexpected error ${result.error}`);
  assert.ok(room.game.daily);
  assert.equal(room.game.rerollsRemaining, 0);
  assert.equal(room.game.currentCategory, dailyCategories(room.game.daily.dateKey)[0]);
  clearRoundTimer(room); // don't leak the scheduled countdown/round timer
});

test('startGame daily: rejected for multiplayer rooms', () => {
  const { room } = createRoom(conn(), 'HOST');
  room.gameType = 'category-blitz';
  joinRoom(room.code, conn(), 'P2');
  const result = startGame(room, { daily: true });
  assert.equal(result.error, 'daily_solo_only');
  assert.equal(room.game, null);
});

test('startGame daily: rejected for non-blitz modes', () => {
  const { room } = createRoom(conn(), 'HOST'); // gameType defaults to word-bomb
  const result = startGame(room, { daily: true });
  assert.equal(result.error, 'daily_solo_only');
});

test('startGame without daily flag: behaves exactly as before', () => {
  const { room } = createRoom(conn(), 'SOLO');
  room.gameType = 'category-blitz';
  const result = startGame(room);
  assert.ok(!result.error);
  assert.equal(room.game.daily, null);
  clearRoundTimer(room);
});
