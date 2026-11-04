// lobbyBots.test.js — LOBBY BOTS (Andy nov4: bots in public lobbies that imitate real players). Drives lobbyBots.tick
// directly on real rooms (roomManager), so no wall-clock waits: who is eligible, how many seats the bots take, that they
// never block a human, that they stay honest bots on the wire, and that start / reset / leave / mode switch behave.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRoom,
  joinRoom,
  startGame,
  resetGame,
  removePlayer,
  addBot,
  removeBot,
  buildRoomUpdatePayload,
  listPublicRooms,
  onLobbyGameTypeChange,
  MAX_PLAYERS_PER_ROOM,
  _resetRoomsForTesting,
} = require('./roomManager');
const lobbyBots = require('./lobbyBots');

let nextId = 0;
const conn = () => { nextId += 1; return { id: `c${nextId}`, readyState: 1, send() {} }; };
// leaveChance 0: no random wander-off, so a count after fill() is exact (the churn itself has its own test below)
const deps = (extra = {}) => ({ broadcast() {}, maxPlayers: MAX_PLAYERS_PER_ROOM, isGameLive: (r) => !!r.game && r.game.status !== 'finished', random: Math.random, leaveChance: 0, ...extra });
const lobby = (r) => r.players.filter((p) => p.isBot && p.lobbyBot);
const fill = (room, n = 20) => { for (let i = 0; i < n; i += 1) lobbyBots.tick(room, deps()); };

test.beforeEach(() => _resetRoomsForTesting());
test.after(() => _resetRoomsForTesting());

test('only an opted-in PUBLIC room with a human gets lobby bots', () => {
  const priv = createRoom(conn(), 'ANNA', false, { lobbyBots: true }).room;
  const old = createRoom(conn(), 'BO', true).room; // an old client never asks
  const pub = createRoom(conn(), 'CY', true, { lobbyBots: true }).room;
  assert.equal(lobbyBots.tick(priv, deps()), 'idle');
  assert.equal(lobbyBots.tick(old, deps()), 'idle');
  assert.equal(lobbyBots.tick(pub, deps()), 'join');
  assert.equal(lobby(pub).length, 1);
});

test('bots fill toward the room target (3-5 seats in all) and never take the last seat', () => {
  for (let k = 0; k < 30; k += 1) {
    _resetRoomsForTesting();
    const room = createRoom(conn(), 'ANNA', true, { lobbyBots: true }).room;
    fill(room);
    const n = room.players.length;
    assert.ok(n >= 2 && n <= 5, `room holds ${n}`);
    assert.ok(n < MAX_PLAYERS_PER_ROOM);
  }
});

test('a lobby bot is a seeded persona with a hero, unique in its room, and stays isBot (+ lobbyBot) on the wire', () => {
  const room = createRoom(conn(), 'ANNA', true, { lobbyBots: true }).room;
  room.lobbyBotSeats = 5;
  fill(room);
  const names = new Set(lobby(room).map((b) => b.name.toLowerCase()));
  assert.equal(names.size, lobby(room).length, 'no duplicate names');
  const personaNames = new Set(lobbyBots.PERSONAS.map((p) => p[0]));
  for (const b of lobby(room)) {
    assert.ok(personaNames.has(b.name), `${b.name} is a seeded persona`);
    assert.ok(b.hero, 'wears a hero');
    assert.ok(['easy', 'medium', 'hard'].includes(b.botDifficulty));
  }
  const wire = buildRoomUpdatePayload(room).payload.players.filter((p) => p.lobbyBot);
  assert.equal(wire.length, lobby(room).length);
  for (const p of wire) {
    assert.equal(p.isBot, true, 'still a bot for the economy');
    assert.ok(p.hero);
    assert.equal(p.frame, undefined, 'no frame: a human seat carries none either');
  }
});

test('a FULL lobby gives a joining human a lobby bot\'s seat - a bot never blocks a real player', () => {
  const room = createRoom(conn(), 'ANNA', true, { lobbyBots: true }).room;
  for (let i = 0; i < MAX_PLAYERS_PER_ROOM - 2; i += 1) joinRoom(room.code, conn(), `P${i}`);
  room.lobbyBotSeats = MAX_PLAYERS_PER_ROOM;
  room.players.push(lobbyBots.makeLobbyBot(room)); // a bot in the last seat (only possible by a race)
  assert.equal(room.players.length, MAX_PLAYERS_PER_ROOM);
  const res = joinRoom(room.code, conn(), 'LATE');
  assert.equal(res.error, undefined);
  assert.equal(room.players.length, MAX_PLAYERS_PER_ROOM);
  assert.equal(lobby(room).length, 0);
});

test('as humans arrive the bots thin out toward the target', () => {
  const room = createRoom(conn(), 'ANNA', true, { lobbyBots: true }).room;
  room.lobbyBotSeats = 4;
  fill(room);
  assert.equal(lobby(room).length, 3);
  joinRoom(room.code, conn(), 'BO');
  joinRoom(room.code, conn(), 'CY');
  fill(room);
  assert.equal(lobby(room).length, 1);
  joinRoom(room.code, conn(), 'DEE');
  fill(room);
  assert.equal(lobby(room).length, 0);
});

test('the last human leaving closes a room of only bots', () => {
  const host = conn();
  const room = createRoom(host, 'ANNA', true, { lobbyBots: true }).room;
  fill(room);
  assert.ok(lobby(room).length > 0);
  removePlayer(room, host.id);
  assert.equal(listPublicRooms().some((r) => r.code === room.code), false);
});

test('bots seated at START play the game; no bot joins or leaves a live game; back in the lobby they resume', () => {
  const room = createRoom(conn(), 'ANNA', true, { lobbyBots: true }).room;
  room.lobbyBotSeats = 4;
  fill(room);
  const seated = lobby(room).map((b) => b.id);
  const res = startGame(room);
  assert.equal(res.error, undefined);
  assert.equal(room.lobbyBotTimer, null, 'a live game holds no lobby-bot timer');
  assert.deepEqual(room.game.players.filter((p) => seated.includes(p.id)).length, seated.length, 'every seated bot is dealt in');
  assert.equal(lobbyBots.tick(room, deps()), 'idle');
  resetGame(room);
  assert.ok(room.lobbyBotTimer, 'back in the lobby the timer is armed again');
  resetGame(room); // idempotent: one timer, not two
});

test('the host switching modes: lobby bots keep their persona and take the new brain, or leave a mode without one', () => {
  const room = createRoom(conn(), 'ANNA', true, { lobbyBots: true }).room;
  room.lobbyBotSeats = 4;
  fill(room);
  const names = lobby(room).map((b) => b.name);
  room.gameType = 'category-blitz';
  onLobbyGameTypeChange(room);
  assert.deepEqual(lobby(room).map((b) => b.name), names);
  assert.ok(lobby(room).every((b) => b.botGameType === 'category-blitz'));
  room.gameType = 'word-race'; // no bot brain
  onLobbyGameTypeChange(room);
  assert.equal(lobby(room).length, 0);
});

test('the solo bot controls ignore lobby bots (add allowed beside them, remove leaves them)', () => {
  const room = createRoom(conn(), 'ANNA', true, { lobbyBots: true }).room;
  room.lobbyBotSeats = 3;
  fill(room);
  const n = lobby(room).length;
  assert.ok(n > 0);
  assert.equal(addBot(room, 'easy').ok, true);
  assert.equal(removeBot(room).ok, true);
  assert.equal(lobby(room).length, n);
});

test('a settled lobby still sees a bot wander off now and then (replaced on a later step)', () => {
  const room = createRoom(conn(), 'ANNA', true, { lobbyBots: true }).room;
  room.lobbyBotSeats = 4;
  fill(room);
  assert.equal(lobby(room).length, 3);
  assert.equal(lobbyBots.tick(room, deps({ leaveChance: 1 })), 'leave');
  assert.equal(lobby(room).length, 2);
  assert.equal(lobbyBots.tick(room, deps()), 'join');
  assert.equal(lobby(room).length, 3);
});

test('skill follows the persona: veterans lean hard, newcomers easy', () => {
  let hard = 0; let easy = 0;
  for (let i = 0; i < 400; i += 1) {
    if (lobbyBots.difficultyFor(30) === 'hard') hard += 1;
    if (lobbyBots.difficultyFor(1) === 'easy') easy += 1;
  }
  assert.ok(hard > 120 && hard < 280, `veteran hard ${hard}/400`);
  assert.ok(easy > 120 && easy < 240, `newcomer easy ${easy}/400`);
  assert.equal(lobbyBots.difficultyFor(1, () => 0.99), 'medium');
});
