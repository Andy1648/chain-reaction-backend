// joinMidgame.test.js — STEP 54: joining a Word Bomb round in progress by code makes you a
// SPECTATOR who is dealt in at the next turn. Additive: Word Bomb rules for everyone already
// playing are untouched, and every other mode still refuses a live join.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGame, advanceTurn, dealInPending, getCurrentPlayerId, getActivePlayers } = require('./gameLogic');
const roomManager = require('./roomManager');

function fakeConn(id) {
  return { id, readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); } };
}

test('dealInPending appends late joiners to the turn order with full lives', () => {
  const g = createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 'chill');
  g.pendingPlayers = [{ id: 'c', name: 'C' }];
  const before = g.players.map((p) => ({ ...p }));
  advanceTurn(g); // a → b, and C is dealt in
  assert.deepEqual(g.turnOrder, ['a', 'b', 'c']);
  assert.equal(g.players[2].lives, g.maxLives);
  assert.equal(g.players[2].eliminated, false);
  assert.deepEqual(g.players.slice(0, 2), before, 'existing players are untouched');
  assert.equal(getCurrentPlayerId(g), 'b');
  advanceTurn(g);
  assert.equal(getCurrentPlayerId(g), 'c', 'the newcomer gets their turn in rotation');
  assert.deepEqual(g.pendingPlayers, []);
});

test('a lone survivor plus a waiting joiner keeps the game alive (dealt in before the win check)', () => {
  const g = createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 'chill');
  g.players[1].eliminated = true;
  g.players[1].lives = 0;
  g.pendingPlayers = [{ id: 'c', name: 'C' }];
  advanceTurn(g);
  assert.equal(g.status, 'in_progress');
  assert.equal(getActivePlayers(g).length, 2);
});

test('no pending joiners: advanceTurn behaves exactly as before', () => {
  const g = createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 'chill');
  assert.deepEqual(dealInPending(g), []);
  advanceTurn(g);
  assert.equal(getCurrentPlayerId(g), 'b');
  assert.deepEqual(g.turnOrder, ['a', 'b']);
});

test('joinRoom: Word Bomb in progress → spectator (code-join only); other modes and quick play still refuse', () => {
  const host = fakeConn('h1');
  const { room } = roomManager.createRoom(host, 'Host');
  roomManager.joinRoom(room.code, fakeConn('p2'), 'Two');
  room.gameType = 'word-bomb';
  room.game = createGame(room.players.map((p) => ({ id: p.id, name: p.name })), 'chill');
  room.game.gameType = 'word-bomb';
  // quick-play style join (no opt-in) is refused
  assert.equal(roomManager.joinRoom(room.code, fakeConn('qp'), 'QP').error, 'game_already_started');
  const r = roomManager.joinRoom(room.code, fakeConn('late'), 'Late', { allowSpectate: true });
  assert.equal(r.spectator, true);
  assert.deepEqual(room.game.pendingPlayers, [{ id: 'late', name: 'Late' }]);
  assert.ok(room.players.some((p) => p.id === 'late'));
  const turn = roomManager.buildTurnUpdatePayload(room);
  assert.deepEqual(turn.payload.spectators, [{ id: 'late', name: 'Late' }]);
  // leaving while still a spectator unwinds cleanly
  roomManager.removePlayer(room, 'late');
  assert.deepEqual(room.game.pendingPlayers, []);
  // another mode: still refused
  room.game.gameType = 'category-blitz';
  assert.equal(roomManager.joinRoom(room.code, fakeConn('x'), 'X', { allowSpectate: true }).error, 'game_already_started');
});
