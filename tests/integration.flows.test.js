// tests/integration.flows.test.js
// Run with: npm test   (node --test discovers this file)
//
// Integration tests: full game flows driven through roomManager's public
// surface exactly as server.js drives it, with multiple simulated players
// (recording fake connections) and REAL timers. These are deliberately
// slower than the unit suites (~20s total): they let the actual
// setInterval/setTimeout chains fire - round end, intermission, next
// round, turn timeout - rather than invoking the logic functions directly.
//
// Flow 1: Word Bomb - create/join -> start -> alternating word submissions
//         (words picked from the real bot corpus so they always fit the
//         rolled combo) -> a REAL turn timeout eliminating a player ->
//         game_over broadcast with the right winner.
// Flow 2: Category Blitz - two players race through ALL THREE rounds on
//         1-second round clocks: answers scored mid-round, round_end with
//         revealed answers + samples, intermission, next round, and the
//         final game_over scoreboard.
//
// The dictionary is mocked (any 3+ letter alphabetic word is valid) so no
// network is touched; everything else is the production code path.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRoom,
  joinRoom,
  startGame,
  handleWordSubmission,
  startTurnTimer,
  startRoundTimer,
  clearTurnTimer,
  _resetRoomsForTesting,
} = require('../roomManager');

const gameLogic = require('../gameLogic');
const { getCurrentPlayerId } = gameLogic;
const wordBombBot = require('../wordBombBot');
const CATEGORY_ANSWERS = require('../categoryAnswers');

gameLogic._setDictionaryForTesting({
  isValidWord: async (w) => /^[a-z]{3,}$/.test(w.trim().toLowerCase()),
});

// Force list-only Blitz validation: with a key set, any accept-list miss
// would call the real Anthropic API from inside a test run.
const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
test.after(() => {
  if (ORIGINAL_KEY !== undefined) process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
});

let nextId = 0;
function conn(name) {
  const messages = [];
  return {
    id: `int${nextId++}`,
    name,
    readyState: 1,
    messages,
    send(raw) {
      messages.push(JSON.parse(raw));
    },
  };
}

const ofType = (c, type) => c.messages.filter((m) => m.type === type);
const lastOfType = (c, type) => ofType(c, type).at(-1);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Polls until `predicate()` is truthy or the deadline passes.
async function waitFor(predicate, { timeoutMs = 10000, stepMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(stepMs);
  }
  assert.fail(`timed out waiting for ${label}`);
}

test.beforeEach(() => _resetRoomsForTesting());
test.after(() => _resetRoomsForTesting());

/* ======================================================================== */
/* Flow 1: a complete Word Bomb game, join to game-over                     */
/* ======================================================================== */

test('Word Bomb: full flow from join to game_over with a real timeout elimination', async () => {
  const alice = conn('Alice');
  const bob = conn('Bob');

  // --- lobby ---
  const { room } = createRoom(alice, 'Alice');
  const joinRes = joinRoom(room.code, bob, 'Bob');
  assert.equal(joinRes.error, undefined);

  // --- start ---
  const startRes = startGame(room);
  assert.equal(startRes.error, undefined);
  for (const c of [alice, bob]) {
    assert.equal(ofType(c, 'game_started').length, 1);
    const firstTurn = lastOfType(c, 'turn_update');
    assert.equal(firstTurn.payload.currentPlayerId, alice.id, 'host moves first');
    assert.equal(firstTurn.payload.players.length, 2);
    assert.ok(firstTurn.payload.players.every((p) => p.lives === 3));
  }

  // --- several real turns: each current player answers the LIVE combo ---
  // Words come from the bot corpus, so they genuinely contain the rolled
  // combo; the mocked dictionary then accepts them like the real API would.
  const played = [];
  for (let turn = 0; turn < 4; turn += 1) {
    const currentId = getCurrentPlayerId(room.game);
    const word = wordBombBot.pickWord(room.game.currentCombo, room.game.usedWords);
    assert.ok(word, `corpus has a word for combo "${room.game.currentCombo}"`);
    const { result } = await handleWordSubmission(room, currentId, word);
    assert.equal(result.accepted, true, `turn ${turn}: "${word}" accepted`);
    played.push(word);
  }
  assert.equal(room.game.completedTurnCount, 4);
  assert.equal(room.game.usedWords.size, 4);
  // Turn alternated Alice -> Bob -> Alice -> Bob, so it's Alice again.
  assert.equal(getCurrentPlayerId(room.game), alice.id);
  // Everyone saw every accepted word, in order.
  for (const c of [alice, bob]) {
    assert.deepEqual(ofType(c, 'word_result').map((m) => m.payload.word), played);
  }

  // --- a real timer expiry: Alice (1 life left) stalls and is eliminated ---
  clearTurnTimer(room); // detach the long timer startGame chained
  room.game.players.find((p) => p.id === alice.id).lives = 1;
  room.game.currentTimerSeconds = 1; // make the real countdown short
  startTurnTimer(room);

  await waitFor(() => room.game.status === 'finished', {
    timeoutMs: 5000,
    label: 'the timeout to end the game',
  });

  // The timeout, the elimination, and the game-over all reached both players.
  for (const c of [alice, bob]) {
    const timeout = lastOfType(c, 'turn_timeout');
    assert.equal(timeout.payload.eliminatedPlayerId, alice.id);
    const over = lastOfType(c, 'game_over');
    assert.equal(over.payload.winnerId, bob.id, 'the survivor wins');
    assert.deepEqual(over.payload.usedWords.sort(), [...played].sort());
  }
  assert.equal(room.turnTimerInterval, null, 'no timer left running after game over');
});

/* ======================================================================== */
/* Flow 2: a complete 3-round Category Blitz game                           */
/* ======================================================================== */

test('Category Blitz: two players race through all 3 rounds to the final scoreboard', async () => {
  const alice = conn('Alice');
  const bob = conn('Bob');

  const { room } = createRoom(alice, 'Alice');
  room.gameType = 'category-blitz';
  joinRoom(room.code, bob, 'Bob');

  startGame(room);
  assert.equal(room.game.gameType, 'category-blitz');
  room.game.roundTimeSeconds = 1; // every round runs on a real 1s clock

  // Pin each round to a known big accept-list so scoring is deterministic:
  // a randomly rolled category can have a tiny or absent accept-list.
  const PINNED = ['Pizza toppings', 'Dog breeds', 'Cereal brands'];
  for (const category of PINNED) {
    assert.ok(
      CATEGORY_ANSWERS[category] && CATEGORY_ANSWERS[category].size >= 3,
      `pinned category "${category}" needs a real accept-list`
    );
  }

  const categoriesPlayed = [];
  // Answer counts per round: Alice outraces Bob 2:1 every round.
  const submitRound = async () => {
    const category = room.game.currentCategory;
    categoriesPlayed.push(category);
    const list = [...CATEGORY_ANSWERS[category]];
    await handleWordSubmission(room, alice.id, list[0]);
    await handleWordSubmission(room, alice.id, list[1]);
    await handleWordSubmission(room, bob.id, list[2]);
  };

  for (let round = 1; round <= 3; round += 1) {
    assert.equal(room.game.currentRound, round);
    assert.equal(room.game.status, 'in_progress');
    room.game.currentCategory = PINNED[round - 1];
    await submitRound();
    // Start (or restart) the real 1s round clock now that answers are in;
    // this also skips the 3s countdown delay, like the reroll path does.
    startRoundTimer(room);

    if (round < 3) {
      // Real flow: 1s round -> round_end -> 5s intermission -> round_start.
      await waitFor(
        () => room.game.currentRound === round + 1 && room.game.status === 'in_progress',
        { timeoutMs: 9000, label: `round ${round + 1} to start` }
      );
    } else {
      await waitFor(() => room.game.status === 'finished', {
        timeoutMs: 9000,
        label: 'the game to finish',
      });
    }
  }

  // --- per-round broadcasts ---
  for (const c of [alice, bob]) {
    const ends = ofType(c, 'round_end');
    assert.equal(ends.length, 3, 'every round produced a round_end');
    ends.forEach((end, i) => {
      assert.equal(end.payload.round, i + 1);
      assert.equal(end.payload.category, categoriesPlayed[i]);
      const aliceResult = end.payload.playerResults.find((p) => p.id === alice.id);
      const bobResult = end.payload.playerResults.find((p) => p.id === bob.id);
      assert.equal(aliceResult.roundScore, 2, `round ${i + 1}: Alice scored her 2 answers`);
      assert.equal(bobResult.roundScore, 1);
      assert.ok(Array.isArray(end.payload.sampleAnswers), 'samples revealed at round end');
      // The reveal never includes an answer someone actually gave.
      for (const given of [...aliceResult.answers, ...bobResult.answers]) {
        assert.ok(!end.payload.sampleAnswers.includes(given.toLowerCase()));
      }
    });
    const starts = ofType(c, 'round_start');
    assert.equal(starts.length, 3, 'round 1 start + two advances');
  }

  // Each round ran on its pinned category.
  assert.deepEqual(categoriesPlayed, PINNED);

  // --- final scoreboard ---
  for (const c of [alice, bob]) {
    const over = lastOfType(c, 'game_over');
    assert.ok(over, 'game_over reached every player');
    assert.equal(over.payload.winnerId, alice.id, 'Alice won 6-3');
    assert.deepEqual(
      over.payload.finalScores.map((p) => ({ id: p.id, score: p.score })),
      [{ id: alice.id, score: 6 }, { id: bob.id, score: 3 }],
      'scoreboard sorted highest first with cumulative scores'
    );
  }
  assert.equal(room.roundTimerInterval, null, 'no round timer left after game over');
  assert.equal(room.roundPauseTimeout, null, 'no intermission timer left after game over');
});

/* ======================================================================== */
/* Flow 3: one full Imposter Word round (answer -> vote -> reveal)          */
/* ======================================================================== */

test('Imposter Word: a full round - private prompts, public answers, early vote end, reveal', async () => {
  const players = [conn('P0'), conn('P1'), conn('P2')];
  const [a, b, c] = players;

  const { room } = createRoom(a, 'P0');
  room.gameType = 'imposter-word';
  joinRoom(room.code, b, 'P1');
  joinRoom(room.code, c, 'P2');

  startGame(room);
  const game = room.game;
  assert.equal(game.status, 'answering');

  // --- each player got a PERSONALIZED round_start ---
  const imposterConn = players.find((p) => p.id === game.imposterId);
  const tableConns = players.filter((p) => p.id !== game.imposterId);
  const imposterStart = lastOfType(imposterConn, 'round_start');
  assert.equal(imposterStart.payload.isImposter, true);
  assert.equal(imposterStart.payload.category, 'You are the IMPOSTER. Blend in.');
  for (const t of tableConns) {
    const start = lastOfType(t, 'round_start');
    assert.equal(start.payload.isImposter, false);
    assert.equal(start.payload.category, game.currentCategory);
    assert.ok(!JSON.stringify(start.payload).includes('IMPOSTER. Blend in'), 'the bluff notice stays private');
  }

  // --- answers are broadcast to EVERYONE as they land ---
  await handleWordSubmission(room, a.id, 'first answer');
  await handleWordSubmission(room, b.id, 'second answer');
  for (const p of players) {
    const seen = ofType(p, 'imposter_answer').map((m) => m.payload.answer);
    assert.deepEqual(seen, ['first answer', 'second answer'], 'answers are public in this mode');
  }

  // --- answer phase ends on a real (shortened) clock -> voting opens ---
  game.answerPhaseSeconds = 1;
  // The answer timer was scheduled behind the 3s countdown; let the real
  // countdown + 1s clock elapse so the phase closes through the room's own
  // vote-phase machinery.
  await waitFor(() => game.status === 'voting', {
    timeoutMs: 8000,
    label: 'the answer phase to close',
  });
  for (const p of players) {
    const votePhase = lastOfType(p, 'vote_phase_start');
    assert.equal(votePhase.payload.answers.length, 3, 'every player appears in the reveal');
  }

  // --- everyone votes for the imposter; the phase ends EARLY, no timer wait ---
  const { handleImposterVote } = require('../roomManager');
  const suspects = players.filter((p) => p.id !== game.imposterId);
  for (const voter of players) {
    const target = voter.id === game.imposterId ? suspects[0] : imposterConn;
    handleImposterVote(room, voter.id, target.id);
  }

  assert.equal(game.status, 'reveal');
  for (const p of players) {
    const results = lastOfType(p, 'vote_results');
    assert.equal(results.payload.imposterCaught, true, '2 votes vs 1 is a strict plurality');
    assert.equal(results.payload.imposterId, game.imposterId);
    assert.equal(results.payload.realCategory, game.currentCategory);
  }
  // The two correct voters each scored; the imposter got nothing.
  for (const t of suspects) {
    assert.equal(game.players.find((p) => p.id === t.id).score, 1);
  }
  assert.equal(game.players.find((p) => p.id === game.imposterId).score, 0);
});
