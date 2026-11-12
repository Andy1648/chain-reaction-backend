// autoStart.test.js — PUBLIC ROOMS AUTO-START (Andy nov12: "they must start after like + 5 sec (for every player joining)
// after the first"). The server owns the clock: 2+ players (a human among them) → a deadline; each later arrival adds a
// step, capped; under 2 players cancels; private rooms never; the host can still start first. Delays shrunk via env.
process.env.AUTO_START_BASE_MS = '200';
process.env.AUTO_START_STEP_MS = '50';
process.env.AUTO_START_MAX_MS = '450';
process.env.HOUSE_TIME_SCALE = '0.005';

const test = require('node:test');
const assert = require('node:assert/strict');
const rm = require('./roomManager');

let n = 0;
const conn = () => {
  n += 1;
  return { id: `a${n}`, readyState: 1, sent: [], send(m) { const msg = JSON.parse(m); msg.at = Date.now(); this.sent.push(msg); } };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const upd = (room) => rm.buildRoomUpdatePayload(room).payload;
const row = (room) => rm.listPublicRooms({ withLive: true, note: false }).find((r) => r.code === room.code);

test.afterEach(() => rm._resetRoomsForTesting());

test('one player: no clock; a second player starts it (room_update autoStartInMs + list STARTS IN); it starts on its own', async () => {
  const host = conn();
  const { room } = rm.createRoom(host, 'HOST', true);
  assert.equal(upd(room).autoStartInMs, undefined, 'alone: no clock');
  rm.joinRoom(room.code, conn(), 'TWO');
  const ms = upd(room).autoStartInMs;
  assert.ok(ms > 150 && ms <= 200, `20 s base (scaled): ${ms}`);
  assert.ok(row(room).startsInMs > 0, 'the list row says STARTS IN');
  await wait(260);
  assert.ok(room.game, 'started with nobody pressing START');
  assert.ok(host.sent.some((m) => m.type === 'game_started'));
});

test('each later arrival adds the step (+5 s), never past the cap (45 s) from now', async () => {
  const { room } = rm.createRoom(conn(), 'HOST', true);
  rm.joinRoom(room.code, conn(), 'TWO');
  const t0 = room.autoStartAt;
  rm.joinRoom(room.code, conn(), 'THREE');
  assert.equal(room.autoStartAt - t0, 50, '+1 step for the third');
  for (let i = 0; i < 8 && room.players.length < 8; i += 1) rm.joinRoom(room.code, conn(), `P${i}`);
  assert.ok(room.autoStartAt - Date.now() <= 450 + 2, 'capped');
});

test('dropping back to one player cancels the clock; nothing starts', async () => {
  const { room } = rm.createRoom(conn(), 'HOST', true);
  const two = conn();
  rm.joinRoom(room.code, two, 'TWO');
  assert.ok(room.autoStartAt);
  rm.removePlayer(room, two.id);
  assert.equal(room.autoStartAt, null);
  assert.equal(upd(room).autoStartInMs, undefined);
  await wait(260);
  assert.equal(room.game, null);
});

test('a PRIVATE (code) room never auto-starts', async () => {
  const { room } = rm.createRoom(conn(), 'HOST', false);
  rm.joinRoom(room.code, conn(), 'TWO');
  assert.equal(upd(room).autoStartInMs, undefined);
  await wait(260);
  assert.equal(room.game, null);
});

test('the HOST can still start first: the clock clears, no second start', async () => {
  const host = conn();
  const { room } = rm.createRoom(host, 'HOST', true);
  rm.joinRoom(room.code, conn(), 'TWO');
  assert.ok(!rm.startGame(room).error);
  assert.equal(room.autoStartAt, null);
  await wait(260);
  assert.equal(host.sent.filter((m) => m.type === 'game_started').length, 1, 'exactly one start');
});

test('back in the lobby after a game: the clock runs again for the players there', async () => {
  const { room } = rm.createRoom(conn(), 'HOST', true);
  rm.joinRoom(room.code, conn(), 'TWO');
  await wait(260);
  assert.ok(room.game);
  room.game.status = 'finished';
  rm.resetGame(room);
  assert.ok(upd(room).autoStartInMs > 0, 'counting again');
});

test('never without a human: a public room of bots only has no clock', () => {
  const { room } = rm.createRoom(conn(), 'HOST', true);
  room.players = room.players.map((p) => ({ ...p, isBot: true, lobbyBot: true }));
  room.players.push({ id: 'b2', name: 'B2', isBot: true, lobbyBot: true, connection: { readyState: 1, send() {} } });
  assert.equal(upd(room).autoStartInMs, undefined);
});

test('a HOUSE room with a human follows the SAME visible rule (it never looks different from a real room)', async () => {
  for (let i = 0; i < 300 && !rm.listPublicRooms({ note: false }).some((r) => rm.getRoom(r.code).house); i += 1) { rm.listPublicRooms(); rm.tickHouseRooms(); await wait(5); }
  const room = rm.listPublicRooms({ note: false }).map((r) => rm.getRoom(r.code)).find((r) => r.house);
  assert.ok(room, 'a house lobby');
  rm.joinRoom(room.code, conn(), 'ANDY');
  for (let i = 0; i < 100 && room.players.length < 2; i += 1) await wait(5);
  assert.ok(upd(room).autoStartInMs > 0, 'a visible countdown, like any public room');
});
