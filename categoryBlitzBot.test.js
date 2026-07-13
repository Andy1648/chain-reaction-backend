// categoryBlitzBot.test.js
// Run with: node --test categoryBlitzBot.test.js
// Covers the pure Blitz bot helpers: answer picking (accept-list containment,
// already-given exclusion, empty pool), bot-player shape, and difficulty
// pacing bounds (answers-per-round, spacing jitter, round-deadline safety).
// No network, no timers - the timer-driven integration lives in
// roomManager.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const bot = require('./categoryBlitzBot');
const CATEGORY_ANSWERS = require('./categoryAnswers');

// A stable, accept-listed category to test against (gen6 rapid-fire batch).
const CATEGORY = 'Pizza toppings';

test('the test category has a real accept-list', () => {
  const set = CATEGORY_ANSWERS[CATEGORY];
  assert.ok(set instanceof Set && set.size > 10, 'expected a sizable accept-list');
});

// ---- pickAnswer -------------------------------------------------------------

test('pickAnswer returns an accept-list member for the category', () => {
  const set = CATEGORY_ANSWERS[CATEGORY];
  for (let i = 0; i < 20; i++) {
    const answer = bot.pickAnswer(CATEGORY, []);
    assert.ok(typeof answer === 'string' && answer.length >= 2, `got ${answer}`);
    assert.ok(set.has(answer.toLowerCase()), `"${answer}" should be on the accept-list`);
  }
});

test('pickAnswer never repeats an already-given answer (case-insensitive)', () => {
  const given = [];
  for (let i = 0; i < 30; i++) {
    const answer = bot.pickAnswer(CATEGORY, given);
    if (answer === null) break;
    assert.ok(
      !given.some((g) => g.toLowerCase() === answer.toLowerCase()),
      `"${answer}" was already given`
    );
    // Store uppercased to prove the exclusion is case-insensitive both ways.
    given.push(answer.toUpperCase());
  }
  assert.ok(given.length > 0, 'expected at least one pick');
});

test('pickAnswer returns null for a category with no accept-list', () => {
  assert.equal(bot.pickAnswer('Definitely not a real category', []), null);
});

test('pickAnswer returns null when every answer was already given', () => {
  const everything = [...CATEGORY_ANSWERS[CATEGORY]];
  assert.equal(bot.pickAnswer(CATEGORY, everything), null);
});

// ---- createBotPlayer --------------------------------------------------------

test('createBotPlayer has a sink connection, blitz tag, and unique ids', () => {
  const a = bot.createBotPlayer('hard');
  const b = bot.createBotPlayer('hard');
  assert.equal(a.isBot, true);
  assert.equal(a.botGameType, 'category-blitz');
  assert.equal(a.botDifficulty, 'hard');
  assert.ok(bot.BOT_NAMES.includes(a.name));
  assert.equal(a.connection.readyState, 1);
  assert.equal(typeof a.connection.send, 'function');
  assert.doesNotThrow(() => a.connection.send('{}')); // no-op, never throws
  assert.equal(a.connection.id, a.id);
  assert.notEqual(a.id, b.id);
});

test('createBotPlayer defaults an invalid difficulty to medium', () => {
  assert.equal(bot.createBotPlayer('banana').botDifficulty, 'medium');
  assert.equal(bot.createBotPlayer().botDifficulty, 'medium');
});

// ---- difficulty pacing ------------------------------------------------------

test('buildAnswerSchedule respects count, spacing, and the round deadline', () => {
  const roundSeconds = 20;
  for (const key of ['easy', 'medium', 'hard']) {
    const { answers, firstDelayMs, intervalMs } = bot.BOT_DIFFICULTY[key];
    for (let i = 0; i < 100; i++) {
      const offsets = bot.buildAnswerSchedule(key, roundSeconds);
      // Count: within the difficulty's range (or fewer if the deadline cap bit).
      assert.ok(offsets.length <= answers[1], `${key}: too many answers`);
      assert.ok(offsets.length >= 1, `${key}: expected at least one answer in a 20s round`);
      // First answer within the thinking-time window.
      assert.ok(offsets[0] >= firstDelayMs[0] - 1 && offsets[0] <= firstDelayMs[1] + 1,
        `${key}: first offset ${offsets[0]} outside [${firstDelayMs}]`);
      for (let j = 0; j < offsets.length; j++) {
        // Every submission lands safely before the round ends.
        assert.ok(offsets[j] <= roundSeconds * 1000 - bot.SAFETY_MARGIN_MS + 1,
          `${key}: offset ${offsets[j]} past the safety margin`);
        if (j > 0) {
          const gap = offsets[j] - offsets[j - 1];
          assert.ok(gap >= intervalMs[0] - 1 && gap <= intervalMs[1] + 1,
            `${key}: gap ${gap} outside [${intervalMs}]`);
        }
      }
    }
  }
});

test('buildAnswerSchedule drops answers that would land past a short round', () => {
  for (let i = 0; i < 100; i++) {
    // 3s round: ceiling is 2100ms - easy's first delay alone can exceed it.
    const offsets = bot.buildAnswerSchedule('easy', 3);
    assert.ok(offsets.every((ms) => ms <= 3000 - bot.SAFETY_MARGIN_MS + 1));
  }
});

test('buildAnswerSchedule falls back to medium pacing for unknown difficulty', () => {
  const offsets = bot.buildAnswerSchedule('nonsense', 20);
  const { answers } = bot.BOT_DIFFICULTY.medium;
  assert.ok(offsets.length >= 1 && offsets.length <= answers[1]);
});
