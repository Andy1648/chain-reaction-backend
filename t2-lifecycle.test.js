// t2-lifecycle.test.js
// Run with: node --test t2-lifecycle.test.js   (or `npm test` for the suite)
//
// [T2] Regression tests for the "in_progress means live" family of lifecycle
// bugs in roomManager.js. Word Bomb is the only mode whose live game has
// status 'in_progress': Category Blitz also lives in 'between_rounds', and
// Imposter Word NEVER uses 'in_progress' at all (answering / voting / reveal /
// between_rounds). Every guard that keyed "is a game running" off
// status === 'in_progress' therefore had holes:
//   - joinRoom let players join an Imposter game at ANY point, and a Blitz
//     game during the 5s intermission -> ghost roster entry (in room.players
//     but not game.players) that receives broadcasts but can't play or score.
//   - startGame had no already-running guard at all: a double-fired
//     start_game (or a mid-game click) silently discarded the live game and
//     re-initialized, wiping everyone's progress.
//   - addBot/removeBot allowed roster mutation mid-game during any
//     non-in_progress live phase.
//   - reapIdleRooms could reap a live Imposter game (its midGame check only
//     recognized 'in_progress').
// Plus two adjacent disconnect bugs:
//   - host reassignment picked players[0], which can be a BOT (join a room
//     that already has a solo bot, then the host leaves) -> bot host, nobody
//     can start/reroll/rematch, room bricked.
//   - a NON-current player disconnecting from a 2-player Word Bomb game left
//     the survivor alone in a still-in_progress game (the finish check only
//     ran when the CURRENT player left).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRoom,
  joinRoom,
  startGame,
  addBot,
  removeBot,
  removePlayer,
  getRoom,
  reapIdleRooms,
  _resetRoomsForTesting,
} = require('./roomManager');

let nextId = 0;
function conn() {
  return { id: `t2c${nextId++}`, readyState: 1, send() {} };
}

test.beforeEach(() => _resetRoomsForTesting());
test.after(() => _resetRoomsForTesting());

// ---- joinRoom vs live non-in_progress games --------------------------------

test('joinRoom rejects joining an Imposter Word game mid-round (status answering)', () => {
  const { room } = createRoom(conn(), 'Host');
  room.gameType = 'imposter-word';
  joinRoom(room.code, conn(), 'P1');
  joinRoom(room.code, conn(), 'P2');
  assert.equal(startGame(room).error, undefined);
  assert.equal(room.game.status, 'answering'); // imposter never uses in_progress

  const res = joinRoom(room.code, conn(), 'Latecomer');
  assert.equal(res.error, 'game_already_started', 'no joining a live imposter round');
  assert.equal(room.players.length, 3, 'no ghost roster entry');
});

test('joinRoom rejects joining a Blitz game during the between-rounds intermission', () => {
  const { room } = createRoom(conn(), 'Host');
  room.gameType = 'category-blitz';
  joinRoom(room.code, conn(), 'P1');
  assert.equal(startGame(room).error, undefined);
  room.game.status = 'between_rounds'; // the 5s intermission

  const res = joinRoom(room.code, conn(), 'Latecomer');
  assert.equal(res.error, 'game_already_started');
  assert.equal(room.players.length, 2, 'no ghost roster entry');
});

test('joinRoom still allows joining after a game FINISHED (post-game lobby)', () => {
  const { room } = createRoom(conn(), 'Host');
  joinRoom(room.code, conn(), 'P1');
  startGame(room);
  room.game.status = 'finished';

  const res = joinRoom(room.code, conn(), 'Newcomer');
  assert.equal(res.error, undefined, 'finished games behave like a lobby for joins');
  assert.equal(room.players.length, 3);
});

// ---- startGame double-fire ---------------------------------------------------

test('startGame refuses to restart a live Word Bomb game (double-fired start_game)', () => {
  const { room } = createRoom(conn(), 'Host');
  joinRoom(room.code, conn(), 'P1');
  assert.equal(startGame(room).error, undefined);
  const liveGame = room.game;
  liveGame.usedWords.add('garden'); // some progress

  const res = startGame(room); // the double-fire
  assert.equal(res.error, 'game_already_started', 'second start must be rejected');
  assert.equal(room.game, liveGame, 'the live game object must be untouched');
  assert.ok(room.game.usedWords.has('garden'), 'progress must not be wiped');
});

test('startGame refuses during a Blitz intermission but allows a re-start after finish', () => {
  const host = conn();
  const { room } = createRoom(host, 'Solo');
  room.gameType = 'category-blitz';
  assert.equal(startGame(room).error, undefined); // solo blitz

  room.game.status = 'between_rounds';
  assert.equal(startGame(room).error, 'game_already_started');

  room.game.status = 'finished'; // the solo PLAY AGAIN loop
  const res = startGame(room);
  assert.equal(res.error, undefined, 'restart after finish must keep working');
  assert.equal(room.game.status, 'in_progress');
});

test('startGame refuses during a live Imposter phase', () => {
  const { room } = createRoom(conn(), 'Host');
  room.gameType = 'imposter-word';
  joinRoom(room.code, conn(), 'P1');
  joinRoom(room.code, conn(), 'P2');
  startGame(room);
  assert.equal(room.game.status, 'answering');
  assert.equal(startGame(room).error, 'game_already_started');
});

// ---- addBot / removeBot mid-game ---------------------------------------------

test('addBot refuses during a Blitz intermission (live game, not in_progress)', () => {
  const { room } = createRoom(conn(), 'Solo');
  room.gameType = 'category-blitz';
  startGame(room); // solo blitz, no bot
  room.game.status = 'between_rounds';

  const res = addBot(room, 'medium');
  assert.equal(res.error, 'game_already_started', 'no roster mutation mid-game');
  assert.equal(room.players.some((p) => p.isBot), false);
});

test('removeBot refuses during a Blitz intermission', () => {
  const { room } = createRoom(conn(), 'Solo');
  room.gameType = 'category-blitz';
  addBot(room, 'medium');
  startGame(room);
  room.game.status = 'between_rounds';

  const res = removeBot(room);
  assert.equal(res.error, 'game_already_started');
  assert.equal(room.players.some((p) => p.isBot), true, 'the bot stays in the live game');
});

// ---- idle reaper vs live Imposter game ----------------------------------------

test('reapIdleRooms never reaps a live Imposter game (no in_progress status exists)', () => {
  const { room } = createRoom(conn(), 'Host');
  room.gameType = 'imposter-word';
  joinRoom(room.code, conn(), 'P1');
  joinRoom(room.code, conn(), 'P2');
  startGame(room);
  assert.equal(room.game.status, 'answering');

  // Simulate 21 minutes of wall-clock with no touched activity.
  const future = Date.now() + 21 * 60 * 1000;
  const reaped = reapIdleRooms(future);
  assert.deepEqual(reaped, [], 'a live imposter round must never be reaped');
  assert.ok(getRoom(room.code), 'room still exists');

  // Once the game is finished, the same idle room IS reapable again.
  room.game.status = 'finished';
  const reapedAfter = reapIdleRooms(future);
  assert.deepEqual(reapedAfter, [room.code]);
});

// ---- host reassignment must skip bots -----------------------------------------

test('when the host leaves, the new host is a human, never the bot', () => {
  const host = conn();
  const { room } = createRoom(host, 'Solo');
  addBot(room, 'easy'); // roster: [host, bot]
  const friend = conn();
  joinRoom(room.code, friend, 'Friend'); // roster: [host, bot, friend]

  removePlayer(room, host.id); // roster: [bot, friend] - players[0] is the bot

  assert.equal(room.hostId, friend.id, 'host must pass to the human, not the bot');
});

// ---- Word Bomb: non-current disconnect leaving one active player ---------------

test('a NON-current player disconnecting from a 2-player game ends it immediately', () => {
  const host = conn();
  const p2 = conn();
  const { room } = createRoom(host, 'Host');
  joinRoom(room.code, p2, 'P2');
  startGame(room);
  const game = room.game;

  // Host is current (index 0). The OTHER player disconnects.
  removePlayer(room, p2.id);

  assert.equal(game.status, 'finished', 'one player standing = game over, immediately');
  assert.equal(game.winnerId, host.id, 'the survivor wins');
  assert.equal(room.turnTimerInterval, null, 'no timer left running for a finished game');
  assert.equal(room.countdownTimeout, null, 'no pending countdown either');
});
