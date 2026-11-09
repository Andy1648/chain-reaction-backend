// houseRooms.test.js — HOUSE ROOMS + SPECTATE EVERY LIVE MODE (Andy nov9: "some i can spectate some i cant... i oftentimes
// wait so long for someone to start room"). The room manager, no sockets: fake connections record what they are sent.
process.env.HOUSE_START_MS = '80';
process.env.HOUSE_AGAIN_MS = '1';

const test = require('node:test');
const assert = require('node:assert/strict');

const rm = require('./roomManager');
const { MODES: T5 } = require('./t5Modes');

let n = 0;
const conn = () => {
  n += 1;
  return { id: `h${n}`, readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); } };
};
const last = (c, type) => [...c.sent].reverse().find((m) => m.type === type);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const houseRooms = () => rm.listPublicRooms({ withLive: true }).map((r) => rm.getRoom(r.code)).filter((r) => r && r.house);

test.afterEach(() => rm._resetRoomsForTesting());

test('a thin list gets up to two house rooms (one Word Bomb, one Blitz), hosted and seated by lobby-bot personas', () => {
  rm.tickHouseRooms();
  rm.tickHouseRooms();
  rm.tickHouseRooms();
  const house = houseRooms();
  assert.equal(house.length, 2, 'capped at two');
  assert.deepEqual(house.map((r) => r.gameType).sort(), ['category-blitz', 'word-bomb']);
  for (const r of house) {
    assert.ok(r.players.length >= 2 && r.players.length <= 3);
    assert.ok(r.players.every((p) => p.isBot && p.lobbyBot && p.name), 'every seat is a persona');
    assert.equal(r.hostId, r.players[0].id);
    const row = rm.listPublicRooms().find((x) => x.code === r.code);
    assert.equal(row.status, 'waiting');
    assert.equal(row.hostName, r.players[0].name);
    assert.equal(row.startsInMs, undefined, 'no countdown with nobody seated');
  }
});

test('real rooms waiting with a human push idle house rooms out; a house room with a human in it stays', () => {
  rm.tickHouseRooms();
  rm.tickHouseRooms();
  const [kept] = houseRooms();
  rm.joinRoom(kept.code, conn(), 'ANDY');
  rm.createRoom(conn(), 'REAL1', true);
  rm.createRoom(conn(), 'REAL2', true);
  rm.tickHouseRooms();
  const house = houseRooms();
  assert.equal(house.length, 1, 'the idle one went');
  assert.equal(house[0], kept, 'the one with a human stays');
  // a PRIVATE room never counts as the list filling up
  rm._resetRoomsForTesting();
  rm.createRoom(conn(), 'PRIV', false);
  rm.tickHouseRooms();
  rm.tickHouseRooms();
  assert.equal(houseRooms().length, 2);
});

test('a human sitting down starts a countdown (room_update autoStartInMs, list startsInMs); the game starts on its own', async () => {
  rm.tickHouseRooms();
  const [room] = houseRooms();
  const me = conn();
  const res = rm.joinRoom(room.code, me, 'ANDY');
  assert.ok(!res.error);
  const upd = rm.buildRoomUpdatePayload(room).payload;
  assert.ok(upd.autoStartInMs > 0 && upd.autoStartInMs <= 80, `autoStartInMs ${upd.autoStartInMs}`);
  assert.ok(rm.listPublicRooms().find((x) => x.code === room.code).startsInMs > 0);
  // a second human does not restart it
  const at = room.houseStartAt;
  rm.joinRoom(room.code, conn(), 'BEA');
  assert.equal(room.houseStartAt, at);
  await wait(140);
  assert.ok(room.game && room.game.status !== 'finished', 'started without anyone pressing START');
  assert.ok(me.sent.some((m) => m.type === 'game_started'));
  assert.equal(rm.buildRoomUpdatePayload(room).payload.autoStartInMs, undefined, 'no countdown once live');
  // live: listed as playing and watchable
  const row = rm.listPublicRooms({ withLive: true }).find((x) => x.code === room.code);
  assert.equal(row.status, 'playing');
  assert.equal(row.watch, 'open');
});

test('the last human leaving a counting-down house lobby ends it (no bot-only game); the list refills later', async () => {
  rm.tickHouseRooms();
  const [room] = houseRooms();
  const me = conn();
  rm.joinRoom(room.code, me, 'ANDY');
  rm.removePlayer(room, me.id);
  await wait(140);
  assert.equal(rm.getRoom(room.code), undefined, 'a bot-only room is destroyed');
  assert.ok(!me.sent.some((m) => m.type === 'game_started'), 'never started');
  rm.tickHouseRooms();
  rm.tickHouseRooms(); // one new room per sweep
  assert.equal(houseRooms().length, 2);
});

test('a finished house game goes back to its lobby and counts down again', async () => {
  rm.tickHouseRooms();
  const [room] = houseRooms();
  const me = conn();
  rm.joinRoom(room.code, me, 'ANDY');
  await wait(140);
  assert.ok(room.game);
  room.game.status = 'finished'; // the game ended
  rm.tickHouseRooms(); // notes the result
  await wait(5);
  rm.tickHouseRooms(); // back to the lobby
  assert.equal(room.game, null);
  assert.ok(last(me, 'game_reset'));
  assert.ok(room.houseStartAt, 'counting down again');
});

test('filling a house room hands the seat (and the host) to humans when the host bot gives way', () => {
  rm.tickHouseRooms();
  const [room] = houseRooms();
  const people = [];
  for (let i = 0; i < rm.MAX_PLAYERS_PER_ROOM; i += 1) {
    const c = conn();
    people.push(c);
    assert.ok(!rm.joinRoom(room.code, c, `P${i}`).error, `seat ${i}`);
  }
  assert.ok(room.players.some((p) => p.id === room.hostId), 'the host is always someone in the room');
});

test('every live mode with a snapshot is watchable; any other is listed watch: unsupported (never a dead SPECTATE)', () => {
  assert.equal(rm.canWatchType('word-bomb'), true);
  assert.equal(rm.canWatchType('category-blitz'), true);
  assert.equal(rm.canWatchType('word-race'), true);
  assert.equal(rm.canWatchType('miner'), true);
  const other = Object.keys(T5).find((t) => typeof T5[t].spectateSnapshot !== 'function');
  assert.ok(other, 'a mode with no snapshot exists');
  const { room } = rm.createRoom(conn(), 'HOST', true);
  room.gameType = other;
  room.game = { gameType: other, status: 'in_progress' };
  const row = rm.listPublicRooms({ withLive: true }).find((x) => x.code === room.code);
  assert.equal(row.canSpectate, false);
  assert.equal(row.watch, 'unsupported');
  assert.equal(rm.spectateRoom(room.code, conn(), 'W').error, 'spectate_unsupported');
  room.game = null;
});

test('WORD RACE watch: the snapshot is the race_start, race_go once live, and where every racer stands', () => {
  const host = conn();
  const { room } = rm.createRoom(host, 'RACER', true);
  room.gameType = 'word-race';
  rm.joinRoom(room.code, conn(), 'RIVAL');
  assert.ok(!rm.startGame(room).error);
  let snap = rm.buildSpectateSnapshot(room);
  assert.equal(snap[0].type, 'race_start');
  assert.equal(snap[0].payload.spectate, true);
  assert.ok(snap[0].payload.goAt > Date.now() - 50, 'the countdown keeps its real go');
  assert.equal(snap.length, 1);
  T5['word-race']._goRace(room, { broadcastToRoom: rm.broadcastToRoom, touchRoom: rm.touchRoom });
  const racer = room.game.racers[0];
  racer.index = 2;
  racer.words = ['alpha', 'beta'];
  room.game.racers[1].left = true;
  snap = rm.buildSpectateSnapshot(room);
  assert.deepEqual(snap.map((m) => m.type).slice(0, 3), ['race_start', 'race_go', 'race_progress']);
  const prog = snap.find((m) => m.type === 'race_progress');
  assert.equal(prog.payload.racerId, racer.id);
  assert.equal(prog.payload.index, 2);
  assert.equal(prog.payload.word, 'beta');
  assert.ok(snap.some((m) => m.type === 'race_racer_left'));
  const watch = conn();
  assert.ok(!rm.spectateRoom(room.code, watch, 'WATCHER').error);
  assert.equal(rm.listPublicRooms({ withLive: true }).find((x) => x.code === room.code).spectators, 1);
  assert.equal(rm.buildRoomUpdatePayload(room).payload.watchers, 1);
});

test('MINER watch: miner_start, then the round being dug (real bell) + who locked, or the reveal on screen', () => {
  const { room } = rm.createRoom(conn(), 'DIGGER', true);
  room.gameType = 'miner';
  rm.joinRoom(room.code, conn(), 'RIVAL');
  assert.ok(!rm.startGame(room).error);
  let snap = rm.buildSpectateSnapshot(room);
  assert.deepEqual(snap.map((m) => m.type), ['miner_start'], 'the opening countdown');
  const helpers = { broadcastToRoom: rm.broadcastToRoom, touchRoom: rm.touchRoom, clearRoundTimer: rm.clearRoundTimer };
  T5.miner._openRound(room, helpers);
  snap = rm.buildSpectateSnapshot(room);
  assert.deepEqual(snap.map((m) => m.type), ['miner_start', 'miner_round', 'miner_locked']);
  assert.equal(snap[1].payload.prompt, room.game.prompt);
  assert.ok(snap[1].payload.endsAt > Date.now());
  T5.miner._closeRound(room, helpers);
  snap = rm.buildSpectateSnapshot(room);
  if (room.game.status === 'reveal') {
    assert.deepEqual(snap.map((m) => m.type), ['miner_start', 'miner_round', 'miner_reveal']);
    assert.ok(snap[2].payload.nextInMs >= 0);
  }
  rm.clearRoundTimer(room);
  if (room.roundPauseTimeout) clearTimeout(room.roundPauseTimeout);
});
