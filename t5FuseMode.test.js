// t5FuseMode.test.js
// Run with: npm test (node --test auto-discovers this file).
// Pure-logic tests for the FUSE mode (hot-potato Word Bomb) plus a couple of
// integration passes through roomManager's generic T5 routing. Zero network:
// the injectable dictionary is swapped for dictionary.mock.js, same as the
// gameLogic suite.

const test = require('node:test');
const assert = require('node:assert/strict');

const fuse = require('./t5FuseMode');
const mockDictionary = require('./dictionary.mock');
const { COMBOS } = require('./gameLogic');

fuse._setDictionaryForTesting(mockDictionary);

function makeGame(names = ['p1', 'p2', 'p3'], difficulty = 'medium') {
  return fuse.createGame(
    names.map((id) => ({ id, name: id.toUpperCase() })),
    difficulty
  );
}

/* ============================== createGame ============================== */

test('fuse: createGame sets up holder order, lives, and an opening combo', () => {
  const game = makeGame();
  assert.equal(game.status, 'in_progress');
  assert.equal(game.players.length, 3);
  assert.ok(game.players.every((p) => p.lives === fuse.STARTING_LIVES && !p.eliminated));
  assert.equal(fuse.getHolderId(game), 'p1', 'first joiner starts holding the bomb');
  assert.ok(COMBOS.includes(game.currentCombo));
  assert.equal(game.passCount, 0);
  assert.equal(game.bombIndex, 0);
  assert.equal(game.usedWords.size, 0);
});

test('fuse: invalid difficulty falls back to medium fuse range', () => {
  const game = makeGame(['a', 'b'], 'nonsense');
  assert.equal(game.difficultyKey, 'medium');
  assert.deepEqual(game.fuseRange, fuse.FUSE_RANGE_BY_DIFFICULTY.medium);
});

/* ============================== submitWord ============================== */

test('fuse: an accepted word passes the bomb and rolls a fresh combo', async () => {
  const game = makeGame();
  game.currentCombo = 'en';

  const result = await fuse.submitWord(game, 'enter');
  assert.equal(result.accepted, true);
  assert.equal(result.word, 'enter');
  assert.ok(game.usedWords.has('enter'));
  assert.equal(game.passCount, 1);
  assert.equal(fuse.getHolderId(game), 'p2', 'bomb moved to the next player');
  assert.notEqual(game.currentCombo, 'en', 'a fresh combo rolled');
});

test('fuse: rejects missing combo / too short / reused / fake words', async () => {
  const game = makeGame();
  game.currentCombo = 'en';

  assert.equal((await fuse.submitWord(game, 'castle')).reason, 'missing_combo');
  assert.equal((await fuse.submitWord(game, 'en')).reason, 'too_short');
  assert.equal((await fuse.submitWord(game, 'zzenqx')).reason, 'not_a_word');

  await fuse.submitWord(game, 'enter'); // accepted; holder now p2
  game.currentCombo = 'en';
  const reuse = await fuse.submitWord(game, 'enter');
  assert.equal(reuse.accepted, false);
  assert.equal(reuse.reason, 'already_used');

  assert.equal(fuse.getHolderId(game), 'p2', 'rejects never move the bomb');
  assert.equal(game.passCount, 1);
});

test('fuse: a rejected word does not touch state at all', async () => {
  const game = makeGame();
  game.currentCombo = 'en';
  const before = { pass: game.passCount, holder: fuse.getHolderId(game) };

  await fuse.submitWord(game, 'zzenqx');
  assert.equal(game.passCount, before.pass);
  assert.equal(fuse.getHolderId(game), before.holder);
  assert.equal(game.usedWords.size, 0);
});

test('fuse: race guard discards a word whose bomb exploded during the await', async () => {
  const game = makeGame();
  game.currentCombo = 'en';

  // A dictionary that "takes long enough" for the fuse to blow mid-lookup.
  fuse._setDictionaryForTesting({
    isValidWord: async () => {
      fuse.handleExplosion(game); // bombIndex moves while we're away
      return true;
    },
  });

  const result = await fuse.submitWord(game, 'enter');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'turn_over');
  assert.ok(!game.usedWords.has('enter'), 'discarded submission must not record the word');

  fuse._setDictionaryForTesting(mockDictionary); // restore for later tests
});

test('fuse: submissions are rejected once the game is finished', async () => {
  const game = makeGame(['a', 'b']);
  game.currentCombo = 'en';
  game.status = 'finished';
  const result = await fuse.submitWord(game, 'enter');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'turn_over');
});

/* ============================= explosions ============================== */

test('fuse: an explosion costs the holder a life and moves the bomb on', () => {
  const game = makeGame();
  const result = fuse.handleExplosion(game);

  assert.equal(result.explodedPlayerId, 'p1');
  assert.equal(result.eliminated, false, `still has ${fuse.STARTING_LIVES - 1} life`);
  assert.equal(result.finished, false);
  assert.equal(game.players[0].lives, fuse.STARTING_LIVES - 1);
  assert.equal(game.bombIndex, 1);
  assert.equal(fuse.getHolderId(game), 'p2');
});

test('fuse: a holder at zero lives is eliminated and skipped afterwards', () => {
  const game = makeGame();
  game.players[0].lives = 1;

  const result = fuse.handleExplosion(game);
  assert.equal(result.eliminated, true);
  assert.equal(game.players[0].eliminated, true);
  assert.equal(fuse.getHolderId(game), 'p2');

  // p3 explodes out too; the bomb must skip the dead p1 back to p2.
  fuse.advanceHolder(game); // p2 -> p3
  game.players[2].lives = 1;
  fuse.handleExplosion(game);
  assert.equal(game.status, 'finished', 'only p2 remains');
  assert.equal(game.winnerId, 'p2');
});

test('fuse: the last explosion finishes the game with a winner', () => {
  const game = makeGame(['a', 'b']);
  game.players[0].lives = 1;
  const result = fuse.handleExplosion(game);
  assert.equal(result.finished, true);
  assert.equal(game.status, 'finished');
  assert.equal(game.winnerId, 'b');
});

/* =============================== fuses ================================ */

test('fuse: rollFuseMs stays inside the difficulty range and shrinks per bomb', () => {
  const game = makeGame(['a', 'b'], 'medium');
  const { minMs, maxMs } = fuse.FUSE_RANGE_BY_DIFFICULTY.medium;

  for (let i = 0; i < 200; i += 1) {
    const ms = fuse.rollFuseMs(game);
    assert.ok(ms >= minMs && ms <= maxMs, `fresh-game fuse ${ms} within [${minMs}, ${maxMs}]`);
  }

  game.bombIndex = 3; // 3 explosions -> 24% shorter range
  const scale = 1 - 3 * fuse.FUSE_SHRINK_PER_BOMB;
  for (let i = 0; i < 200; i += 1) {
    const ms = fuse.rollFuseMs(game);
    assert.ok(
      ms >= Math.floor(minMs * scale) && ms <= Math.ceil(maxMs * scale),
      `shrunk fuse ${ms} within scaled range`
    );
  }

  game.bombIndex = 1000; // deep late game -> clamped at the floor scale
  const floor = fuse.FUSE_SHRINK_FLOOR;
  for (let i = 0; i < 200; i += 1) {
    const ms = fuse.rollFuseMs(game);
    assert.ok(
      ms >= Math.floor(minMs * floor) && ms <= Math.ceil(maxMs * floor),
      `floored fuse ${ms} never shrinks past the clamp`
    );
  }
});

/* ===================== polish: ranking, stats, juice ==================== */

test('fuse: eliminations are recorded and the final ranking reads winner-first', () => {
  const game = makeGame(); // p1, p2, p3
  game.players.forEach((p) => {
    p.lives = 1; // every explosion is fatal
  });

  fuse.handleExplosion(game); // p1 out
  fuse.handleExplosion(game); // p2 out -> p3 wins
  assert.deepEqual(game.eliminationOrder, ['p1', 'p2']);
  assert.equal(game.winnerId, 'p3');
  assert.deepEqual(
    fuse.buildFinalRanking(game),
    ['p3', 'p2', 'p1'],
    'winner, then reverse knockout order'
  );
});

test('fuse: a double elimination never double-records (leave after explosion)', () => {
  const game = makeGame();
  game.players[0].lives = 1;
  fuse.handleExplosion(game); // p1 eliminated
  fuse.eliminatePlayer(game, 'p1'); // then their socket also closes
  assert.deepEqual(game.eliminationOrder, ['p1']);
});

test('fuse: recordHold tracks pass volume, the fastest pass, and the longest hold', () => {
  const game = makeGame();
  fuse.recordHold(game, 'p1', 4200, 'pass');
  fuse.recordHold(game, 'p2', 900, 'pass');
  fuse.recordHold(game, 'p3', 2000, 'pass');
  fuse.recordHold(game, 'p1', 9000, 'explosion');

  assert.equal(game.stats.totalPasses, 3);
  assert.equal(game.stats.explosions, 1);
  assert.equal(game.stats.fastestPassMs, 900);
  assert.equal(game.stats.fastestPassBy, 'p2');
  assert.equal(game.stats.longestHoldMs, 9000);
  assert.equal(game.stats.longestHoldBy, 'p1');

  fuse.recordHold(game, 'p2', -5, 'pass');
  assert.equal(game.stats.totalPasses, 3, 'garbage hold times are ignored');
});

test('fuse: burnedFraction is 0 before a fuse is lit and tracks the stamps', () => {
  const room = {};
  assert.equal(fuse.burnedFraction(room), 0);
  room.fuseLitAt = Date.now() - 500;
  room.fuseMs = 1000;
  const burned = fuse.burnedFraction(room);
  assert.ok(burned > 0.4 && burned < 0.7, `~half burned, got ${burned}`);
});

/* ============================ leaves/quits ============================= */

test('fuse: a leaving non-holder is eliminated without moving the bomb', () => {
  const game = makeGame();
  const { wasHolder, finished } = fuse.eliminatePlayer(game, 'p3');
  assert.equal(wasHolder, false);
  assert.equal(finished, false);
  assert.equal(game.players[2].eliminated, true);
  assert.equal(fuse.getHolderId(game), 'p1');
});

test('fuse: a leaving holder hands the bomb to the next active player', () => {
  const game = makeGame();
  const { wasHolder, finished } = fuse.eliminatePlayer(game, 'p1');
  assert.equal(wasHolder, true);
  assert.equal(finished, false);
  assert.equal(fuse.getHolderId(game), 'p2');
});

test('fuse: a leave that empties the table finishes the game', () => {
  const game = makeGame(['a', 'b']);
  const { finished } = fuse.eliminatePlayer(game, 'a');
  assert.equal(finished, true);
  assert.equal(game.winnerId, 'b');
});

/* ==================== integration via roomManager ===================== */
// Exercises the generic T5 routing end to end with sink connections: create
// room -> set gameType -> startGame -> submit through handleWordSubmission.

const roomManager = require('./roomManager');

function makeConnection(id) {
  const messages = [];
  return {
    id,
    readyState: 1,
    send(raw) {
      messages.push(JSON.parse(raw));
    },
    messages,
  };
}

test('fuse: startGame broadcasts game_started + bomb_update through the T5 hook', () => {
  const host = makeConnection('host');
  const guest = makeConnection('guest');
  const { room } = roomManager.createRoom(host, 'HOST');
  roomManager.joinRoom(room.code, guest, 'GUEST');
  room.gameType = 'fuse';

  const result = roomManager.startGame(room);
  assert.ok(!result.error);
  assert.equal(room.game.gameType, 'fuse');

  const types = host.messages.map((m) => m.type);
  assert.ok(types.includes('game_started'));
  assert.ok(types.includes('bomb_update'));
  const bomb = host.messages.find((m) => m.type === 'bomb_update');
  assert.equal(bomb.payload.holderId, 'host');
  assert.ok(bomb.payload.combo);
  assert.equal(bomb.payload.players.length, 2);

  roomManager._resetRoomsForTesting();
});

test('fuse: a solo fuse room cannot start (needs 2 players)', () => {
  const host = makeConnection('solo');
  const { room } = roomManager.createRoom(host, 'SOLO');
  room.gameType = 'fuse';
  const result = roomManager.startGame(room);
  assert.equal(result.error, 'not_enough_players');
  roomManager._resetRoomsForTesting();
});

test('fuse: submissions route through handleWordSubmission with holder checks', async () => {
  const host = makeConnection('host');
  const guest = makeConnection('guest');
  const { room } = roomManager.createRoom(host, 'HOST');
  roomManager.joinRoom(room.code, guest, 'GUEST');
  room.gameType = 'fuse';
  roomManager.startGame(room);

  // Not the holder -> turn error, no state change.
  const notYours = await roomManager.handleWordSubmission(room, 'guest', 'enter');
  assert.equal(notYours.error, 'not_your_turn');

  // Holder submits a valid word -> accepted, bomb passes, broadcast to all.
  room.game.currentCombo = 'en';
  const accepted = await roomManager.handleWordSubmission(room, 'host', 'enter');
  assert.equal(accepted.result.accepted, true);
  assert.equal(fuse.getHolderId(room.game), 'guest');
  const guestTypes = guest.messages.map((m) => m.type);
  assert.ok(guestTypes.includes('word_result'), 'accepts are broadcast');
  assert.ok(guestTypes.filter((t) => t === 'bomb_update').length >= 2);

  // Holder submits garbage -> private reject to the submitter only.
  const guestMsgCountBefore = guest.messages.length;
  room.game.currentCombo = 'en';
  const rejected = await roomManager.handleWordSubmission(room, 'guest', 'zzenqx');
  assert.equal(rejected.result.accepted, false);
  assert.equal(guest.messages.length, guestMsgCountBefore + 1, 'reject goes to submitter');
  assert.equal(
    host.messages.filter((m) => m.type === 'word_result' && !m.payload.accepted).length,
    0,
    'rejects are not broadcast'
  );

  roomManager._resetRoomsForTesting();
});

test('fuse: a leaving holder is eliminated and the bomb moves on (removePlayer)', () => {
  const a = makeConnection('a');
  const b = makeConnection('b');
  const c = makeConnection('c');
  const { room } = roomManager.createRoom(a, 'A');
  roomManager.joinRoom(room.code, b, 'B');
  roomManager.joinRoom(room.code, c, 'C');
  room.gameType = 'fuse';
  roomManager.startGame(room);

  roomManager.removePlayer(room, 'a'); // the holder leaves
  assert.equal(room.game.players.find((p) => p.id === 'a').eliminated, true);
  assert.equal(fuse.getHolderId(room.game), 'b');
  assert.equal(room.game.status, 'in_progress');

  roomManager.removePlayer(room, 'b'); // now one player remains -> game over
  assert.equal(room.game.status, 'finished');
  assert.equal(room.game.winnerId, 'c');
  const over = c.messages.find((m) => m.type === 'game_over');
  assert.ok(over && over.payload.winnerId === 'c');
  assert.deepEqual(over.payload.finalRanking, ['c', 'b', 'a']);
  assert.ok(over.payload.stats, 'game_over carries the stats block');

  roomManager._resetRoomsForTesting();
});

test('fuse: an accepted pass records hold stats and flags close calls', async () => {
  const host = makeConnection('host');
  const guest = makeConnection('guest');
  const { room } = roomManager.createRoom(host, 'HOST');
  roomManager.joinRoom(room.code, guest, 'GUEST');
  room.gameType = 'fuse';
  roomManager.startGame(room);

  // Simulate a lit fuse at 95% burned, held for ~2s.
  room.fuseMs = 20000;
  room.fuseLitAt = Date.now() - 19000;
  room.fuseHolderSince = Date.now() - 2000;

  room.game.currentCombo = 'en';
  await roomManager.handleWordSubmission(room, 'host', 'enter');

  const result = guest.messages.find((m) => m.type === 'word_result');
  assert.equal(result.payload.accepted, true);
  assert.equal(result.payload.closeCall, true, '95% burned = close call');
  assert.equal(room.game.stats.totalPasses, 1);
  assert.ok(room.game.stats.fastestPassMs >= 1900, 'held ~2s before passing');
  assert.equal(room.game.stats.fastestPassBy, 'host');

  roomManager._resetRoomsForTesting();
});
