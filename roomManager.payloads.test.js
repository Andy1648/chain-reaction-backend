// roomManager.payloads.test.js
// Run with: node --test roomManager.payloads.test.js
//
// Additive coverage for two under-tested pure areas of roomManager:
//   1. joinRoom's validation error paths (room_not_found, room_full) and its
//      happy-path roster mutation - the room-lifecycle "join" step.
//   2. The wire-payload builders (buildTurnUpdatePayload, buildGameOverPayload,
//      buildRoomUpdatePayload). buildTurnUpdatePayload runs on EVERY Word Bomb
//      turn, yet no test asserted its exact shape; the others had no direct
//      coverage at all. These are pure functions of (room, game) state, so they
//      are exercised here with plain data - no sockets, no timers.
//
// The builders are called with synthetic room objects built from
// gameLogic.createGame so no turn/round timer is ever started.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRoom,
  joinRoom,
  buildTurnUpdatePayload,
  buildGameOverPayload,
  buildRoomUpdatePayload,
  MAX_PLAYERS_PER_ROOM,
  _resetRoomsForTesting,
} = require('./roomManager');
const gameLogic = require('./gameLogic');

let nextId = 0;
function conn() {
  return { id: `c${nextId++}`, readyState: 1, send() {} };
}

test.beforeEach(() => _resetRoomsForTesting());
test.after(() => _resetRoomsForTesting());

// ---- joinRoom validation (room lifecycle: join) ---------------------------

test('joinRoom returns room_not_found for an unknown code and mutates nothing', () => {
  const res = joinRoom('NOPE5', conn(), 'Late');
  assert.equal(res.error, 'room_not_found');
  assert.equal(res.room, undefined);
});

test('joinRoom adds a correctly-shaped player to a waiting room and returns it', () => {
  const { room } = createRoom(conn(), 'Host');
  const before = room.players.length;

  const joiner = conn();
  const res = joinRoom(room.code, joiner, 'Joiner');

  assert.ok(!res.error, `expected success, got ${res.error}`);
  assert.equal(res.room.code, room.code);
  assert.equal(room.players.length, before + 1);
  const added = room.players[room.players.length - 1];
  assert.equal(added.id, joiner.id);
  assert.equal(added.name, 'Joiner');
  assert.equal(added.connection, joiner); // the connection is retained for broadcasts
});

test('joinRoom rejects with room_full at the player cap and leaves the roster untouched', () => {
  const { room } = createRoom(conn(), 'Host');
  // Fill the remaining seats up to the cap via real joins.
  for (let i = room.players.length; i < MAX_PLAYERS_PER_ROOM; i++) {
    const res = joinRoom(room.code, conn(), `P${i}`);
    assert.ok(!res.error, `fill join ${i} should succeed, got ${res.error}`);
  }
  assert.equal(room.players.length, MAX_PLAYERS_PER_ROOM);

  const overflow = joinRoom(room.code, conn(), 'Overflow');
  assert.equal(overflow.error, 'room_full');
  assert.equal(room.players.length, MAX_PLAYERS_PER_ROOM, 'a rejected join must not grow the roster');
});

// ---- buildTurnUpdatePayload (runs every turn) -----------------------------

// A synthetic room: just the fields the builders read (players + game). Built
// from the real createGame so the game shape is authentic.
function wordBombRoom(players, difficultyKey = 'chill') {
  const game = gameLogic.createGame(players, difficultyKey);
  game.gameType = 'word-bomb';
  return { code: 'ROOM1', hostId: players[0].id, difficultyKey, gameType: 'word-bomb', players, game };
}

test('buildTurnUpdatePayload carries the full per-turn contract', () => {
  const players = [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }];
  const room = wordBombRoom(players, 'chill');
  const game = room.game;

  const frame = buildTurnUpdatePayload(room);
  assert.equal(frame.type, 'turn_update');
  const p = frame.payload;

  assert.equal(p.currentPlayerId, 'a'); // turnOrder[0]
  assert.equal(p.timerSeconds, game.currentTimerSeconds);
  assert.equal(p.timerSeconds, gameLogic.DIFFICULTY_PRESETS.chill.startSeconds);
  assert.equal(p.maxLives, game.maxLives);
  assert.equal(p.maxLives, gameLogic.DIFFICULTY_PRESETS.chill.lives);
  assert.equal(p.combo, game.currentCombo);
  assert.ok(Array.isArray(p.usedWords), 'usedWords is serialized from the Set to an array');
  assert.deepEqual(
    p.players.map((pl) => ({ id: pl.id, name: pl.name, lives: pl.lives, eliminated: pl.eliminated })),
    [
      { id: 'a', name: 'Alice', lives: game.maxLives, eliminated: false },
      { id: 'b', name: 'Bob', lives: game.maxLives, eliminated: false },
    ]
  );
});

test('buildTurnUpdatePayload serializes the usedWords Set to a plain array', () => {
  const players = [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }];
  const room = wordBombRoom(players);
  room.game.usedWords.add('garden');
  room.game.usedWords.add('target');

  const { payload } = buildTurnUpdatePayload(room);
  assert.ok(Array.isArray(payload.usedWords));
  assert.deepEqual([...payload.usedWords].sort(), ['garden', 'target']);
});

test("buildTurnUpdatePayload falls back to name 'Unknown' for a game player missing from the room roster", () => {
  // A game whose player id isn't present in room.players (a torn-down connection
  // that still has a live game seat) must still render a name, not undefined.
  const game = gameLogic.createGame([{ id: 'ghost', name: 'Ghost' }], 'chill');
  game.gameType = 'word-bomb';
  const room = { players: [], game }; // roster empty -> no name to look up

  const { payload } = buildTurnUpdatePayload(room);
  assert.equal(payload.players[0].id, 'ghost');
  assert.equal(payload.players[0].name, 'Unknown');
});

// ---- buildGameOverPayload -------------------------------------------------

test('buildGameOverPayload reports the winner, used words, and split skip/timeout stats', () => {
  const players = [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }];
  const room = wordBombRoom(players);
  const game = room.game;
  game.winnerId = 'a';
  game.usedWords.add('garden');
  game.timeoutCount = 3;
  game.skipCount = 2;

  const frame = buildGameOverPayload(room);
  assert.equal(frame.type, 'game_over');
  assert.equal(frame.payload.winnerId, 'a');
  assert.deepEqual([...frame.payload.usedWords], ['garden']);
  assert.deepEqual(frame.payload.stats, { timeouts: 3, skips: 2 });
});

test('buildGameOverPayload defaults missing tally counters to 0', () => {
  const players = [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }];
  const room = wordBombRoom(players);
  // Simulate a game object that never recorded a timeout/skip counter.
  delete room.game.timeoutCount;
  delete room.game.skipCount;

  const { payload } = buildGameOverPayload(room);
  assert.deepEqual(payload.stats, { timeouts: 0, skips: 0 });
});

// ---- buildRoomUpdatePayload -----------------------------------------------

test('buildRoomUpdatePayload exposes lobby state and omits bot fields for humans', () => {
  const room = {
    code: 'ABCDE',
    hostId: 'h',
    difficultyKey: 'medium',
    gameType: 'word-bomb',
    selectedPacks: undefined, // should normalize to null
    players: [{ id: 'h', name: 'Host' }, { id: 'g', name: 'Guest' }],
  };

  const frame = buildRoomUpdatePayload(room);
  assert.equal(frame.type, 'room_update');
  const p = frame.payload;
  assert.equal(p.code, 'ABCDE');
  assert.equal(p.hostId, 'h');
  assert.equal(p.difficultyKey, 'medium');
  assert.equal(p.gameType, 'word-bomb');
  assert.equal(p.selectedPacks, null);
  assert.deepEqual(p.players, [
    { id: 'h', name: 'Host' },
    { id: 'g', name: 'Guest' },
  ]);
  assert.equal('isBot' in p.players[0], false, 'humans carry no isBot field');
});

test('buildRoomUpdatePayload surfaces isBot and botDifficulty for a bot seat', () => {
  const room = {
    code: 'ABCDE',
    hostId: 'h',
    difficultyKey: 'medium',
    gameType: 'word-bomb',
    selectedPacks: ['Animals'],
    players: [
      { id: 'h', name: 'Host' },
      { id: 'bot', name: 'Botty', isBot: true, botDifficulty: 'hard' },
    ],
  };

  const { payload } = buildRoomUpdatePayload(room);
  assert.deepEqual(payload.selectedPacks, ['Animals']);
  const bot = payload.players.find((pl) => pl.id === 'bot');
  assert.equal(bot.isBot, true);
  assert.equal(bot.botDifficulty, 'hard');
  const human = payload.players.find((pl) => pl.id === 'h');
  assert.equal('isBot' in human, false);
});
