// turnRaceHandler.test.js
// Run with: node --test turnRaceHandler.test.js   (or `node --test` for the suite)
//
// HANDLER-LEVEL regression test for the handleWordSubmission / handleTimeout
// TOCTOU turn race (branch fix/turn-race).
//
// The existing turnRace.test.js exercises the race guard on the pure-logic
// submitWord() in isolation. This file covers the layer the bug actually bit in
// production: roomManager.handleWordSubmission driving the REAL turn timer.
// handleWordSubmission awaits submitWord, which awaits the dictionary lookup. In
// the last second of a turn the room's turn-timer interval (startTurnTimer) can
// fire DURING that await: handleTimeout costs the current player a life, advances
// the turn, broadcasts, and starts the NEXT player's timer. If the in-flight
// submission then applied, we'd double-advance the turn, skip a player, clear the
// next player's freshly-started timer, and double-count a life. The fix: submitWord
// snapshots completedTurnCount before the await and discards the submission
// (reason 'turn_over') if the turn moved on; handleWordSubmission treats a
// non-accepted result as an ordinary reject that touches no turns/lives/timers.
//
// We reproduce the race deterministically with fake timers: inside the awaited
// dictionary lookup we advance the fake clock by exactly the current turn's
// duration, firing the real turn-timeout path mid-await, then resolve the word
// "valid". Exactly one outcome must win (the timeout), and the raced submission
// must be cleanly rejected without mutating any further state.
//
// New file (additive) so it touches no source or existing test file.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRoom,
  joinRoom,
  startGame,
  handleWordSubmission,
  _resetRoomsForTesting,
} = require('./roomManager');
const gameLogic = require('./gameLogic');
const mockDictionary = require('./dictionary.mock');
const { getCurrentPlayerId } = gameLogic;

// Mirrors the countdown delay in roomManager (COUNTDOWN_DELAY_MS, not exported):
// startGame sends the first turn immediately but delays the turn timer by this
// long so the client's 3-2-1 countdown can play. We tick exactly this to hand
// control to a live, full-length turn timer.
const COUNTDOWN_DELAY_MS = 3000;

// A recording ws stand-in: id + OPEN readyState + a send() that captures every
// frame this connection receives, so a test can inspect the exact wire sequence.
function recordingConn(id) {
  const received = [];
  return {
    id,
    readyState: 1,
    received,
    send(raw) {
      try {
        received.push(JSON.parse(raw));
      } catch {
        /* ignore non-JSON */
      }
    },
  };
}

// Build a 2-player Word Bomb room and advance past the opening countdown so the
// real turn timer is live and holding a full turn's worth of seconds. 'chill'
// gives 3 lives / 20s turns, so a single life-loss reads unambiguously.
function startedWordBombRoom() {
  const host = recordingConn('host');
  const { room } = createRoom(host, 'Host');
  const p2 = recordingConn('p2');
  joinRoom(room.code, p2, 'P2');
  room.difficultyKey = 'chill';
  startGame(room);
  test.mock.timers.tick(COUNTDOWN_DELAY_MS); // countdown fires -> startTurnTimer
  return { room, host, p2 };
}

// The race: a turn-timeout that fires DURING the dictionary await must win, and
// the in-flight submission must be discarded with no further state change. Run
// 50x in a loop to shake out any nondeterminism in the interleaving.
test('race: a turn timer firing DURING the dict await is cleanly rejected by handleWordSubmission (x50)', async () => {
  test.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    for (let i = 0; i < 50; i++) {
      _resetRoomsForTesting();
      const { room, host, p2 } = startedWordBombRoom();
      const game = room.game;

      const currentId = getCurrentPlayerId(game); // host holds turn 1
      game.currentCombo = 'gar'; // 'garden' contains 'gar' -> otherwise valid
      const currentPlayer = game.players.find((p) => p.id === currentId);
      const livesBefore = currentPlayer.lives;
      const turnCountBefore = game.completedTurnCount;

      // Inject a dictionary whose lookup, while being awaited, expires the current
      // turn's real timer exactly once - firing handleTimeout + its broadcasts +
      // the next player's timer - then returns the word "valid". This is the exact
      // "timeout fires mid-lookup" interleaving.
      let timerFiredDuringAwait = 0;
      gameLogic._setDictionaryForTesting({
        isValidWord: async () => {
          if (timerFiredDuringAwait === 0) {
            const secs = game.currentTimerSeconds; // full remaining turn length
            test.mock.timers.tick(secs * 1000); // expire THIS turn once, not the next
          }
          timerFiredDuringAwait += 1;
          return true;
        },
      });

      const { result } = await handleWordSubmission(room, currentId, 'garden');

      // --- The submission LOST and was cleanly rejected -----------------------
      assert.equal(result.accepted, false, `iter ${i}: raced submit must not be accepted`);
      assert.equal(result.reason, 'turn_over', `iter ${i}: rejection reason is turn_over`);
      assert.equal(timerFiredDuringAwait, 1, `iter ${i}: the timeout fired exactly once mid-await`);

      // --- Exactly ONE outcome won: the timeout, not a double-advance ---------
      assert.equal(
        game.completedTurnCount,
        turnCountBefore + 1,
        `iter ${i}: turn advanced ONCE (the timeout), not twice`
      );
      assert.notEqual(getCurrentPlayerId(game), currentId, `iter ${i}: turn passed off the timed-out player`);
      assert.equal(getCurrentPlayerId(game), p2.id, `iter ${i}: turn advanced exactly one seat, not skipped past`);

      // --- No side effects leaked from the discarded submission ---------------
      assert.equal(game.usedWords.has('garden'), false, `iter ${i}: discarded word must not be recorded`);
      assert.equal(
        currentPlayer.lives,
        livesBefore - 1,
        `iter ${i}: current player lost exactly one life (the timeout), not two`
      );

      // --- The wire reflects one winner: a turn_timeout broadcast to the room,
      // a private turn_over word_result to the submitter, and NO accepted
      // word_result broadcast and none seen by the other player. --------------
      assert.ok(
        host.received.some((m) => m.type === 'turn_timeout'),
        `iter ${i}: the room saw the turn_timeout (the timeout is the winner)`
      );
      const hostWordResults = host.received.filter((m) => m.type === 'word_result');
      assert.ok(
        hostWordResults.some((m) => m.payload.accepted === false && m.payload.reason === 'turn_over'),
        `iter ${i}: submitter got a private turn_over word_result`
      );
      assert.ok(
        !hostWordResults.some((m) => m.payload.accepted === true),
        `iter ${i}: no accepted word_result was produced by the raced submit`
      );
      assert.ok(
        !p2.received.some((m) => m.type === 'word_result'),
        `iter ${i}: the raced reject was private - the other player saw no word_result`
      );
    }
  } finally {
    gameLogic._setDictionaryForTesting(mockDictionary);
    test.mock.timers.reset();
    _resetRoomsForTesting();
  }
});

// The "immediately after" ordering: the timer fully expires and advances the turn,
// THEN the previous player's submission lands. handleWordSubmission's turn check
// rejects it as not_your_turn before it can reach submitWord - a distinct clean
// rejection path that must also mutate nothing.
test('immediately after: a submission landing after the timer advanced the turn is rejected not_your_turn', async () => {
  test.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    _resetRoomsForTesting();
    const { room } = startedWordBombRoom();
    const game = room.game;

    const prevPlayer = getCurrentPlayerId(game); // host, turn 1
    game.currentCombo = 'gar';

    // Turn timer fully expires first (no in-flight submission): turn advances.
    test.mock.timers.tick(game.currentTimerSeconds * 1000);
    assert.notEqual(getCurrentPlayerId(game), prevPlayer, 'the timeout advanced the turn');
    const turnCountAfterTimeout = game.completedTurnCount;

    // The previous player's word now arrives late.
    gameLogic._setDictionaryForTesting({ isValidWord: async () => true });
    const ret = await handleWordSubmission(room, prevPlayer, 'garden');

    assert.equal(ret.error, 'not_your_turn', 'a late submission from the timed-out player is rejected');
    assert.equal(game.completedTurnCount, turnCountAfterTimeout, 'the late submission caused no extra advance');
    assert.equal(game.usedWords.has('garden'), false, 'the late submission recorded no word');
  } finally {
    gameLogic._setDictionaryForTesting(mockDictionary);
    test.mock.timers.reset();
    _resetRoomsForTesting();
  }
});

// Control: with no timer interference, an uncontested valid submission is
// accepted and advances the turn exactly once - proving the assertions above key
// on the race, not on submissions being broken in general.
test('control: an uncontested valid submission is accepted and advances the turn exactly once', async () => {
  test.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    _resetRoomsForTesting();
    const { room, host, p2 } = startedWordBombRoom();
    const game = room.game;

    const currentId = getCurrentPlayerId(game);
    game.currentCombo = 'gar';
    const currentPlayer = game.players.find((p) => p.id === currentId);
    const livesBefore = currentPlayer.lives;
    const turnCountBefore = game.completedTurnCount;

    gameLogic._setDictionaryForTesting({ isValidWord: async () => true });
    const { result } = await handleWordSubmission(room, currentId, 'garden');

    assert.equal(result.accepted, true, 'a valid word on your turn is accepted');
    assert.equal(game.completedTurnCount, turnCountBefore + 1, 'turn advanced exactly once');
    assert.equal(getCurrentPlayerId(game), p2.id, 'turn passed to the next player');
    assert.equal(game.usedWords.has('garden'), true, 'the accepted word is recorded');
    assert.equal(currentPlayer.lives, livesBefore, 'an accepted word costs no life');
    // An accepted word is broadcast to the whole room (both players see it).
    assert.ok(host.received.some((m) => m.type === 'word_result' && m.payload.accepted === true));
    assert.ok(p2.received.some((m) => m.type === 'word_result' && m.payload.accepted === true));
  } finally {
    gameLogic._setDictionaryForTesting(mockDictionary);
    test.mock.timers.reset();
    _resetRoomsForTesting();
  }
});
