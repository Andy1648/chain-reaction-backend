// graceReconnect.test.js
// Run with: node --test graceReconnect.test.js
//
// feat/mp-grace — the disconnect GRACE WINDOW. A socket dropping mid-game must HOLD
// the seat ("RECONNECTING…") for RECONNECT_GRACE_MS instead of the old instant
// eliminate=true/lives=0. A rejoin_room with the seat's persistent token inside the
// window restores the player with score, lives and turn order intact; past the window
// the seat is eliminated exactly as before, and the remaining players are told why.
//
// These tests drive the REAL timer path (test.mock.timers over the grace setTimeout +
// turn intervals), drop a player mid-turn, and assert both outcomes: return at 5s and
// no-return by 25s.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRoom,
  joinRoom,
  startGame,
  removePlayer,
  rejoinRoom,
  RECONNECT_GRACE_MS,
  _resetRoomsForTesting,
} = require('./roomManager');
const { getCurrentPlayerId } = require('./gameLogic');

let nextId = 0;
function conn() {
  return { id: `c${nextId++}`, readyState: 1, send() {} };
}
const tokenOf = (room, id) => room.players.find((p) => p.id === id).token;
const seatByToken = (room, token) => room.players.find((p) => p.token === token);
const gamePlayer = (room, id) => room.game.players.find((p) => p.id === id);

// Word Bomb room with `host` + `p2`, chill tier (3 lives, 20s turns), game started.
function startedRoom() {
  const host = conn();
  const { room } = createRoom(host, 'Host');
  const p2 = conn();
  joinRoom(room.code, p2, 'P2');
  room.difficultyKey = 'chill';
  startGame(room);
  return { room, host, p2 };
}

test.beforeEach(() => _resetRoomsForTesting());
test.after(() => _resetRoomsForTesting());

test('RECONNECT_GRACE_MS is a real positive window', () => {
  assert.ok(RECONNECT_GRACE_MS > 0);
});

test('a drop HOLDS the seat: still in the roster, lives intact, not eliminated', () => {
  test.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const { room, p2 } = startedRoom();
    const token = tokenOf(room, p2.id);
    const livesBefore = gamePlayer(room, p2.id).lives;

    removePlayer(room, p2.id, { graceful: true }); // socket dropped mid-game

    const seat = seatByToken(room, token);
    assert.ok(seat, 'seat must remain in the roster during grace (not filtered out)');
    assert.equal(seat.disconnected, true, 'seat is flagged disconnected/RECONNECTING');
    const gp = gamePlayer(room, p2.id);
    assert.equal(gp.eliminated, false, 'held seat is NOT eliminated during grace');
    assert.equal(gp.lives, livesBefore, 'held seat keeps its lives during grace');
    assert.equal(room.graceTimers.size, 1, 'a grace timer is armed for the held seat');
  } finally {
    test.mock.timers.reset();
  }
});

test('return within grace (5s): rejoin_room restores the SAME seat, lives + turn order intact, grace timer cancelled', () => {
  test.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const { room, p2 } = startedRoom();
    const code = room.code;
    const token = tokenOf(room, p2.id);
    const livesBefore = gamePlayer(room, p2.id).lives;

    removePlayer(room, p2.id, { graceful: true });
    const oldId = p2.id;

    // 5 seconds pass — well inside the 20s window; grace timer has NOT fired.
    test.mock.timers.tick(5000);
    assert.equal(gamePlayer(room, oldId).eliminated, false, 'still held at 5s, not eliminated');

    // Reconnect: a NEW socket presents the stored token.
    const p2New = conn();
    const res = rejoinRoom(code, p2New, token);
    assert.ok(!res.error, `rejoin should succeed, got ${res.error}`);

    const seat = seatByToken(room, token);
    assert.equal(seat.id, p2New.id, 'seat re-pointed to the new connection id');
    assert.ok(!seat.disconnected, 'disconnected flag cleared on rejoin');
    assert.equal(room.graceTimers.size, 0, 'grace timer cancelled on rejoin (no pending elimination)');

    const gp = gamePlayer(room, p2New.id);
    assert.ok(gp, 'game player re-keyed to the new id');
    assert.equal(gp.eliminated, false, 'resumed player is alive');
    assert.equal(gp.lives, livesBefore, 'lives preserved across the reconnect');
    assert.ok(room.game.turnOrder.includes(p2New.id), 'turn order carries the new id');
    assert.ok(!room.game.turnOrder.includes(oldId), 'stale id purged from turn order');
    assert.equal(room.game.status, 'in_progress', 'the game is still live, same game');
  } finally {
    test.mock.timers.reset();
  }
});

test('no return by 25s: the grace window expires and the seat is eliminated (game resolves)', () => {
  test.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const { room, p2 } = startedRoom();
    const token = tokenOf(room, p2.id);
    const oldId = p2.id;

    removePlayer(room, p2.id, { graceful: true });
    assert.equal(gamePlayer(room, oldId).eliminated, false, 'held immediately after the drop');

    // 25 seconds pass — past the 20s window with no rejoin. Grace fires at 20s.
    test.mock.timers.tick(25000);

    assert.equal(seatByToken(room, token), undefined, 'the seat is removed from the roster after grace');
    assert.equal(room.graceTimers.size, 0, 'no dangling grace timer after expiry');
    // Two-player game: eliminating the dropped seat leaves one — the game finishes.
    assert.equal(room.game.status, 'finished', 'the game resolves once the held seat is eliminated');
    assert.notEqual(room.game.winnerId, oldId, 'the player who never returned did not win');
  } finally {
    test.mock.timers.reset();
  }
});

test('dropping the CURRENT player advances the turn (no hang) and holds their seat', () => {
  test.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const { room, host, p2 } = startedRoom();
    // At kickoff the host is the current player. Drop the CURRENT player mid-turn.
    assert.equal(getCurrentPlayerId(room.game), host.id, 'host is current at kickoff');
    const hostToken = tokenOf(room, host.id);

    removePlayer(room, host.id, { graceful: true });

    // Turn must move OFF the dropped player so the game doesn't hang on someone gone,
    // but their seat is held (lives intact, not eliminated) for the grace window.
    assert.equal(getCurrentPlayerId(room.game), p2.id, 'turn advanced to the connected player');
    const heldSeat = seatByToken(room, hostToken);
    assert.ok(heldSeat && heldSeat.disconnected, 'dropped current player is held, not gone');
    assert.equal(gamePlayer(room, host.id).eliminated, false, 'held current player not eliminated');
    assert.equal(room.game.status, 'in_progress', 'game keeps running through the hold');
  } finally {
    test.mock.timers.reset();
  }
});
