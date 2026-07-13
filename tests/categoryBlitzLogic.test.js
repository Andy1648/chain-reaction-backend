// tests/categoryBlitzLogic.test.js
// Run with: npm test   (node --test discovers this file)
//
// Unit tests for categoryBlitzLogic.js: game setup (reroll allowance by
// difficulty, pack filtering), the two-stage answer validation (accept-list
// hit, list-miss in list-only mode, list-miss judged by a stubbed AI),
// reroll semantics (score revert, allowance), round advancement, and the
// scoreboard/winner rules.
//
// The Haiku judge is stubbed by patching the shared haikuValidator module
// object (categoryBlitzLogic calls haikuValidator.isEnabled()/validate() via
// the module reference, so property patching is a clean seam - no network,
// no env keys). Every patch is restored in a finally block. node --test runs
// each file in its own process, so the injected test category can't leak
// into other suites.

const test = require('node:test');
const assert = require('node:assert/strict');

const logic = require('../categoryBlitzLogic');
const haikuValidator = require('../haikuValidator');
const CATEGORY_ANSWERS = require('../categoryAnswers');
const CATEGORY_PACKS = require('../categoryPacks');

const {
  createGame,
  submitAnswer,
  endRound,
  startNextRound,
  rerollCategory,
  getScoreboard,
  pickRandomCategory,
  CATEGORIES,
  PACK_IDS,
  TOTAL_ROUNDS,
  REROLLS_BY_DIFFICULTY,
  ROUND_TIME_SECONDS,
} = logic;

const PLAYERS = [
  { id: 'p1', name: 'Alice' },
  { id: 'p2', name: 'Bob' },
];

// A deterministic accept-list under our control.
const TEST_CATEGORY = '__t1_blitz_test__';
CATEGORY_ANSWERS[TEST_CATEGORY] = new Set(['pepperoni', 'mushroom', 'olive', 'ham']);

function makeGame(difficulty = 'medium') {
  const game = createGame(PLAYERS, difficulty);
  game.currentCategory = TEST_CATEGORY; // pin away from the random pick
  return game;
}

// Temporarily stub the AI judge; returns a restore function.
function stubJudge({ enabled, verdict }) {
  const orig = { isEnabled: haikuValidator.isEnabled, validate: haikuValidator.validate };
  haikuValidator.isEnabled = () => enabled;
  haikuValidator.validate = async () => verdict;
  return () => {
    haikuValidator.isEnabled = orig.isEnabled;
    haikuValidator.validate = orig.validate;
  };
}

/* =============================== createGame ============================= */

test('createGame builds the roster, picks a real category, and seeds non-repeat tracking', () => {
  const game = createGame(PLAYERS, 'medium');
  assert.equal(game.status, 'in_progress');
  assert.equal(game.rounds, TOTAL_ROUNDS);
  assert.equal(game.currentRound, 1);
  assert.equal(game.roundTimeSeconds, ROUND_TIME_SECONDS);
  assert.ok(CATEGORIES.includes(game.currentCategory), 'category comes from the active pool');
  assert.ok(game.usedCategories.has(game.currentCategory));
  for (const p of game.players) {
    assert.deepEqual(p.answers, []);
    assert.equal(p.score, 0);
  }
});

test('reroll allowance follows the difficulty tier, with invalid keys falling back to medium', () => {
  for (const key of ['easy', 'medium', 'hard']) {
    assert.equal(createGame(PLAYERS, key).rerollsRemaining, REROLLS_BY_DIFFICULTY[key]);
  }
  const bogus = createGame(PLAYERS, 'impossible');
  assert.equal(bogus.difficultyKey, 'medium');
  assert.equal(bogus.rerollsRemaining, REROLLS_BY_DIFFICULTY.medium);
});

/* ========================= pack-filtered category picks ================= */

test('every pick with a selected pack stays inside that pack', () => {
  // Find a pack with enough categories to satisfy the TOTAL_ROUNDS guard.
  const countByPack = {};
  for (const c of CATEGORIES) {
    const pack = CATEGORY_PACKS[c];
    if (pack) countByPack[pack] = (countByPack[pack] || 0) + 1;
  }
  const bigPack = Object.keys(countByPack).find((p) => countByPack[p] >= TOTAL_ROUNDS + 2);
  assert.ok(bigPack, 'expected at least one pack with a usable pool');

  for (let i = 0; i < 50; i += 1) {
    const category = pickRandomCategory(null, [bigPack]);
    assert.equal(CATEGORY_PACKS[category], bigPack, `"${category}" is outside pack ${bigPack}`);
  }
});

test('a pack selection too small to fill all rounds falls back to the full pool', () => {
  // A pack id that matches nothing produces an empty filtered pool.
  const category = pickRandomCategory(null, ['__no_such_pack__']);
  assert.ok(CATEGORIES.includes(category), 'falls back to the full active pool');
});

test('pickRandomCategory never returns an excluded category', () => {
  // Exclude everything except one - that survivor must be picked.
  const exclude = new Set(CATEGORIES);
  const keep = CATEGORIES[3];
  exclude.delete(keep);
  assert.equal(pickRandomCategory(exclude), keep);
});

test('pack ids are well-formed and quarantined categories are really out of rotation', () => {
  // PACK_IDS is the frontend contract for set_packs - every id must be a
  // usable, non-empty string (a stray null/empty pack tag would silently
  // break the server-side set_packs validation).
  assert.ok(PACK_IDS.length > 0);
  for (const pack of PACK_IDS) {
    assert.ok(typeof pack === 'string' && pack.trim().length > 0, `bad pack id: ${JSON.stringify(pack)}`);
  }
  // Quarantine spot-checks: open-ended categories must be out of rotation
  // even though their names/accept-lists remain on disk.
  assert.ok(!CATEGORIES.includes('Things in your junk drawer'));
  assert.ok(!CATEGORIES.includes('Apps on your phone right now'));
});

/* ========================== submitAnswer: basics ======================== */

test('an accept-list hit is accepted as typed (trimmed) and scores +1, with no AI involved', async () => {
  const game = makeGame();
  let judgeCalled = false;
  const restore = stubJudge({ enabled: true, verdict: false });
  haikuValidator.validate = async () => { judgeCalled = true; return false; };
  try {
    const res = await submitAnswer(game, 'p1', '  Pepperoni ');
    assert.deepEqual(res, { accepted: true, answer: 'Pepperoni', playerId: 'p1' });
    assert.equal(game.players[0].score, 1);
    assert.deepEqual(game.players[0].answers, ['Pepperoni']);
    assert.equal(judgeCalled, false, 'a list hit must never reach the judge');
  } finally {
    restore();
  }
});

test('submitAnswer rejects unknown players and sub-2-char answers', async () => {
  const game = makeGame();
  assert.equal((await submitAnswer(game, 'ghost', 'olive')).reason, 'not_in_game');
  assert.equal((await submitAnswer(game, 'p1', 'x')).reason, 'too_short');
  assert.equal((await submitAnswer(game, 'p1', '   ')).reason, 'too_short');
  assert.equal(game.players[0].score, 0);
});

test('a duplicate blocks only the SAME player, case-insensitively; rivals still score', async () => {
  const game = makeGame();
  await submitAnswer(game, 'p1', 'olive');
  assert.equal((await submitAnswer(game, 'p1', 'OLIVE')).reason, 'already_said');
  assert.equal((await submitAnswer(game, 'p1', ' olive  ')).reason, 'already_said');
  assert.equal(game.players[0].score, 1, 'rejections do not score');

  const rival = await submitAnswer(game, 'p2', 'Olive');
  assert.equal(rival.accepted, true, 'both players naming the same thing both score');
  assert.equal(game.players[1].score, 1);
});

/* ==================== submitAnswer: two-stage validation ================ */

test('a list-miss with the AI DISABLED is accepted (list-only mode fails open)', async () => {
  const game = makeGame();
  const restore = stubJudge({ enabled: false, verdict: false });
  try {
    const res = await submitAnswer(game, 'p1', 'anchovy');
    assert.equal(res.accepted, true);
    assert.equal(game.players[0].score, 1);
  } finally {
    restore();
  }
});

test('a list-miss with the AI ENABLED is judged: yes accepts, no rejects with not_in_category', async () => {
  const game = makeGame();
  let restore = stubJudge({ enabled: true, verdict: true });
  try {
    assert.equal((await submitAnswer(game, 'p1', 'anchovy')).accepted, true);
  } finally {
    restore();
  }

  restore = stubJudge({ enabled: true, verdict: false });
  try {
    const res = await submitAnswer(game, 'p2', 'skateboard');
    assert.deepEqual(res, { accepted: false, reason: 'not_in_category', playerId: 'p2' });
    assert.equal(game.players[1].score, 0);
    assert.deepEqual(game.players[1].answers, []);
  } finally {
    restore();
  }
});

test('onAiCheck fires exactly when there is judge latency to cover (list-miss + AI on)', async () => {
  const game = makeGame();
  const calls = [];
  const onAiCheck = () => calls.push('checking');

  let restore = stubJudge({ enabled: true, verdict: true });
  try {
    await submitAnswer(game, 'p1', 'olive', { onAiCheck }); // list hit
    assert.equal(calls.length, 0, 'no AI call, no checking notice');
    await submitAnswer(game, 'p1', 'anchovy', { onAiCheck }); // list miss -> judge
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }

  restore = stubJudge({ enabled: false, verdict: true });
  try {
    await submitAnswer(game, 'p1', 'capers', { onAiCheck }); // miss, but AI off
    assert.equal(calls.length, 1, 'AI disabled means no checking notice');
  } finally {
    restore();
  }
});

/* ============================ reroll semantics =========================== */

test('rerollCategory reverts this-round points, clears answers, and burns one reroll', async () => {
  const game = makeGame('easy'); // 3 rerolls
  game.players[0].score = 4; // 4 points banked from earlier rounds
  await submitAnswer(game, 'p1', 'olive');
  await submitAnswer(game, 'p1', 'ham');
  assert.equal(game.players[0].score, 6);

  const before = game.currentCategory;
  const res = rerollCategory(game);

  assert.equal(res.error, undefined);
  assert.notEqual(game.currentCategory, before, 'a fresh category is picked');
  assert.equal(res.category, game.currentCategory);
  assert.equal(res.rerollsRemaining, 2);
  assert.equal(game.players[0].score, 4, 'only THIS round\'s points are reverted');
  assert.deepEqual(game.players[0].answers, []);
  assert.ok(game.usedCategories.has(game.currentCategory), 'the new category cannot repeat later');
});

test('rerollCategory clamps a reverted score at zero and errors when the allowance is spent', () => {
  const game = makeGame('hard'); // 1 reroll
  // Pathological state: more answers than score. The clamp keeps score >= 0.
  game.players[0].answers = ['a1', 'a2', 'a3'];
  game.players[0].score = 1;
  assert.equal(rerollCategory(game).error, undefined);
  assert.equal(game.players[0].score, 0);

  assert.equal(game.rerollsRemaining, 0);
  assert.deepEqual(rerollCategory(game), { error: 'no_rerolls_left' });
});

/* ====================== round advancement & winner ======================= */

test('endRound flips to between_rounds and snapshots per-player round results', async () => {
  const game = makeGame();
  await submitAnswer(game, 'p1', 'olive');
  const snapshot = endRound(game);

  assert.equal(game.status, 'between_rounds');
  assert.equal(snapshot.category, TEST_CATEGORY);
  const p1 = snapshot.playerResults.find((r) => r.id === 'p1');
  assert.deepEqual(p1.answers, ['olive']);
  assert.equal(p1.roundScore, 1);
  // Snapshot answers are copies - mutating them must not corrupt the game.
  p1.answers.push('injected');
  assert.deepEqual(game.players[0].answers, ['olive']);
});

test('startNextRound advances with a fresh non-repeating category and cleared answers', async () => {
  const game = makeGame();
  await submitAnswer(game, 'p1', 'olive');
  endRound(game);

  const info = startNextRound(game);
  assert.equal(info.round, 2);
  assert.equal(game.status, 'in_progress');
  assert.equal(game.usedCategories.size, 2, 'both played categories are tracked');
  assert.notEqual(game.currentCategory, TEST_CATEGORY);
  assert.deepEqual(game.players[0].answers, [], 'per-round answers reset');
  assert.equal(game.players[0].score, 1, 'cumulative score is kept');
});

test('a full game runs exactly TOTAL_ROUNDS rounds then finishes with the top scorer as winner', () => {
  const game = createGame(PLAYERS, 'medium');
  game.players[1].score = 9;
  let rounds = 1;
  const seen = new Set([game.currentCategory]);
  let info;
  while ((info = startNextRound(game)) !== null) {
    rounds += 1;
    assert.ok(!seen.has(info.category), `category "${info.category}" repeated`);
    seen.add(info.category);
  }
  assert.equal(rounds, TOTAL_ROUNDS);
  assert.equal(game.status, 'finished');
  assert.equal(game.winnerId, 'p2');
});

test('a tied final score goes to the earlier-seated player', () => {
  const game = createGame(PLAYERS, 'medium');
  game.currentRound = game.rounds;
  game.players[0].score = 5;
  game.players[1].score = 5;
  startNextRound(game);
  assert.equal(game.winnerId, 'p1', 'first player to reach the score wins ties');
});

test('getScoreboard sorts by score descending', () => {
  const game = createGame(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    'medium'
  );
  game.players[0].score = 2;
  game.players[1].score = 7;
  game.players[2].score = 4;
  assert.deepEqual(getScoreboard(game).map((p) => p.id), ['b', 'c', 'a']);
});

/* ====================== active-pool content invariants =================== */

test('EVERY advertised pack id yields a playable full game (own pool or documented fallback)', () => {
  // The contract behind set_packs: whatever single pack a host selects, a
  // full TOTAL_ROUNDS game must complete with valid, non-repeating
  // categories (small packs fall back to the full pool by design).
  for (const pack of PACK_IDS) {
    const game = createGame(PLAYERS, 'medium', false, [pack]);
    const seen = new Set([game.currentCategory]);
    assert.ok(CATEGORIES.includes(game.currentCategory), `pack ${pack}: bad first category`);
    while (startNextRound(game) !== null) {
      assert.ok(CATEGORIES.includes(game.currentCategory), `pack ${pack}: bad category mid-game`);
      assert.ok(!seen.has(game.currentCategory), `pack ${pack}: repeated "${game.currentCategory}"`);
      seen.add(game.currentCategory);
    }
    assert.equal(seen.size, TOTAL_ROUNDS, `pack ${pack}: game did not fill all rounds`);
  }
});

test('every active category with an accept-list stores lowercase entries (Stage-1 contract)', () => {
  // submitAnswer lowercases the player's input before the Set lookup; a
  // mixed-case accept-list entry would be silently unreachable.
  for (const category of CATEGORIES) {
    const set = CATEGORY_ANSWERS[category];
    if (!set) continue;
    for (const entry of set) {
      if (entry !== String(entry).toLowerCase()) {
        assert.fail(`"${category}" has non-lowercase accept-list entry "${entry}"`);
      }
    }
  }
});
