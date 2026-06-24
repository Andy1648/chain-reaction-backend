// roomManager.test.js
// Run with: node --test roomManager.test.js
// Covers the public-rooms data layer added for the lobby browser / quick play:
// the isPublic flag, listPublicRooms filtering, and quickPlay ranking +
// retry-on-race + create-fallback. Uses Node's built-in test runner only (no
// npm deps) and a fake WebSocket connection - none of this touches the network
// or starts a game, so no timers run.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRoom,
  joinRoom,
  startGame,
  resetGame,
  syncSoloBot,
  removePlayer,
  getRoom,
  listPublicRooms,
  quickPlay,
  MAX_PLAYERS_PER_ROOM,
  _resetRoomsForTesting,
} = require('./roomManager');

// Minimal stand-in for a ws connection: an id + an OPEN readyState + a no-op
// send (broadcasts call .send on every player). Each call gets a unique id.
let nextId = 0;
function conn() {
  return { id: `c${nextId++}`, readyState: 1, send() {} };
}

// Fill a room up to `n` players total (the host counts as 1) via real joinRoom.
function fillTo(code, n) {
  for (let i = 1; i < n; i++) {
    const res = joinRoom(code, conn(), `P${i}`);
    assert.ok(!res.error, `expected join to succeed, got ${res.error}`);
  }
}

test.beforeEach(() => _resetRoomsForTesting());
// Also clear after the final test: startGame schedules a countdown timeout, and
// a trailing one left by the last test would keep the process alive.
test.after(() => _resetRoomsForTesting());

// ---- isPublic flag --------------------------------------------------------

test('createRoom defaults to private (isPublic false)', () => {
  const { room } = createRoom(conn(), 'Host');
  assert.equal(room.isPublic, false);
});

test('createRoom with isPublic=true marks the room public', () => {
  const { room } = createRoom(conn(), 'Host', true);
  assert.equal(room.isPublic, true);
});

test('createRoom coerces a truthy non-bool isPublic to a real boolean', () => {
  const { room } = createRoom(conn(), 'Host', 'yes');
  assert.strictEqual(room.isPublic, true);
});

// ---- listPublicRooms filtering -------------------------------------------

test('listPublicRooms returns only public, waiting, not-full rooms', () => {
  // public + waiting + room (should appear)
  const pub = createRoom(conn(), 'Host', true).room;

  // private waiting room (excluded - not public)
  createRoom(conn(), 'Host', false);

  // public but full (excluded - not joinable)
  const full = createRoom(conn(), 'Host', true).room;
  fillTo(full.code, MAX_PLAYERS_PER_ROOM);

  // public but in-progress (excluded - game !== null)
  const playing = createRoom(conn(), 'Host', true).room;
  joinRoom(playing.code, conn(), 'P1'); // need 2 to start word-bomb
  startGame(playing);

  // public but finished (excluded - game !== null)
  const finished = createRoom(conn(), 'Host', true).room;
  joinRoom(finished.code, conn(), 'P1');
  startGame(finished);
  finished.game.status = 'finished';

  const list = listPublicRooms();
  assert.equal(list.length, 1);
  assert.equal(list[0].code, pub.code);
});

test('listPublicRooms entries expose only the display-safe summary', () => {
  const pub = createRoom(conn(), 'Host', true).room;
  joinRoom(pub.code, conn(), 'P1');

  const [entry] = listPublicRooms();
  assert.deepEqual(Object.keys(entry).sort(), [
    'code', 'gameType', 'maxPlayers', 'playerCount', 'status',
  ]);
  assert.equal(entry.code, pub.code);
  assert.equal(entry.playerCount, 2);
  assert.equal(entry.maxPlayers, MAX_PLAYERS_PER_ROOM);
  assert.equal(entry.gameType, 'word-bomb');
  assert.equal(entry.status, 'waiting');
});

// ---- quickPlay ------------------------------------------------------------

test('quickPlay joins the existing public waiting room', () => {
  const pub = createRoom(conn(), 'Host', true).room;

  const res = quickPlay(conn(), 'Newcomer');
  assert.equal(res.error, undefined);
  assert.equal(res.created, false);
  assert.equal(res.room.code, pub.code);
  assert.equal(pub.players.length, 2);
});

test('quickPlay ranks fullest-not-full first', () => {
  const big = createRoom(conn(), 'Host', true).room;
  fillTo(big.code, 5); // 5 players
  const small = createRoom(conn(), 'Host', true).room; // 1 player

  const res = quickPlay(conn(), 'Newcomer');
  assert.equal(res.created, false);
  assert.equal(res.room.code, big.code); // the fuller room wins
  assert.equal(big.players.length, 6);
  assert.equal(small.players.length, 1);
});

test('quickPlay skips a full room and retries the next candidate', () => {
  // The fullest candidate is actually AT capacity (race: it filled between a
  // would-be snapshot and the join). joinRoom must reject it and quickPlay must
  // fall through to the next-fullest joinable room.
  const full = createRoom(conn(), 'Host', true).room;
  fillTo(full.code, MAX_PLAYERS_PER_ROOM); // 8/8 - join will be rejected
  const open = createRoom(conn(), 'Host', true).room;
  joinRoom(open.code, conn(), 'P1'); // 2 players - the real target

  const res = quickPlay(conn(), 'Newcomer');
  assert.equal(res.created, false);
  assert.equal(res.room.code, open.code);
  assert.equal(full.players.length, MAX_PLAYERS_PER_ROOM); // untouched
  assert.equal(open.players.length, 3);
});

test('quickPlay ignores private and in-progress rooms when choosing', () => {
  createRoom(conn(), 'Host', false); // private - never a candidate
  const playing = createRoom(conn(), 'Host', true).room;
  joinRoom(playing.code, conn(), 'P1');
  startGame(playing); // in-progress - excluded

  // No joinable public room exists -> quickPlay creates a fresh public one.
  const res = quickPlay(conn(), 'Newcomer', () => true);
  assert.equal(res.created, true);
  assert.equal(res.room.isPublic, true);
  assert.notEqual(res.room.code, playing.code);
});

test('quickPlay creates a new public room when none are joinable', () => {
  const res = quickPlay(conn(), 'Solo', () => true);
  assert.equal(res.error, undefined);
  assert.equal(res.created, true);
  assert.equal(res.room.isPublic, true);
  assert.equal(res.room.players.length, 1);
});

test('quickPlay respects the create throttle on the create path', () => {
  // No joinable rooms AND the throttle says no -> rate_limited, no room made.
  const res = quickPlay(conn(), 'Solo', () => false);
  assert.equal(res.error, 'rate_limited');
  assert.equal(res.room, undefined);
  assert.equal(listPublicRooms().length, 0);
});

// ---- solo Word Bomb bot opponent -----------------------------------------

test('syncSoloBot adds one bot to a private solo Word Bomb room', () => {
  const { room } = createRoom(conn(), 'Solo'); // private, word-bomb, 1 human
  const changed = syncSoloBot(room);
  assert.equal(changed, true);
  assert.equal(room.players.length, 2);
  const bots = room.players.filter((p) => p.isBot);
  assert.equal(bots.length, 1);
  assert.equal(bots[0].connection.readyState, 1);
  // Idempotent: a second sync doesn't add a second bot.
  assert.equal(syncSoloBot(room), false);
  assert.equal(room.players.filter((p) => p.isBot).length, 1);
});

test('syncSoloBot does NOT add a bot to a public room', () => {
  const { room } = createRoom(conn(), 'Solo', true); // public
  assert.equal(syncSoloBot(room), false);
  assert.equal(room.players.some((p) => p.isBot), false);
});

test('syncSoloBot does NOT add a bot for non Word Bomb modes', () => {
  const { room } = createRoom(conn(), 'Solo');
  room.gameType = 'category-blitz';
  assert.equal(syncSoloBot(room), false);
  assert.equal(room.players.some((p) => p.isBot), false);
});

test('syncSoloBot removes the bot when a second human joins', () => {
  const { room } = createRoom(conn(), 'Host'); // private word-bomb
  syncSoloBot(room); // bot added
  assert.equal(room.players.filter((p) => p.isBot).length, 1);
  joinRoom(room.code, conn(), 'Friend'); // now 2 humans + 1 bot
  const changed = syncSoloBot(room);
  assert.equal(changed, true);
  assert.equal(room.players.some((p) => p.isBot), false);
  assert.equal(room.players.length, 2); // two humans
});

test('a solo private Word Bomb room can start a real 2-player game', () => {
  const { room } = createRoom(conn(), 'Solo');
  syncSoloBot(room); // mirrors what the server does in the lobby
  const res = startGame(room);
  assert.equal(res.error, undefined);
  assert.equal(room.game.players.length, 2);
  // The roster has exactly one bot alongside the human.
  assert.equal(room.players.filter((p) => p.isBot).length, 1);
});

test('removePlayer destroys the room when only the bot remains', () => {
  const host = conn();
  const { room } = createRoom(host, 'Solo');
  syncSoloBot(room); // [human, bot]
  removePlayer(room, host.id); // human leaves -> only the bot is left
  assert.equal(getRoom(room.code), undefined); // room torn down, no lone bot
});

test('resetGame keeps the solo bot present for a rematch', () => {
  const { room } = createRoom(conn(), 'Solo');
  syncSoloBot(room);
  startGame(room);
  resetGame(room); // back to lobby
  assert.equal(room.game, null);
  assert.equal(room.players.filter((p) => p.isBot).length, 1);
});
