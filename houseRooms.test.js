// houseRooms.test.js — HOUSE ROOMS read as REAL ROOMS (Andy nov9: "make sure the logic is on point - don't make it seem
// like bots") + SPECTATE EVERY LIVE MODE. The room manager, no sockets: fake connections record what they are sent.
// HOUSE_TIME_SCALE compresses every house delay (x0.005: a 3-12 s join gap is 15-60 ms).
process.env.HOUSE_TIME_SCALE = '0.005';

const test = require('node:test');
const assert = require('node:assert/strict');

const rm = require('./roomManager');
const H = require('./houseRooms');
const { MODES: T5 } = require('./t5Modes');

const K = 0.005;
let n = 0;
const conn = () => {
  n += 1;
  return { id: `h${n}`, readyState: 1, sent: [], send(m) { const msg = JSON.parse(m); msg.at = Date.now(); this.sent.push(msg); } };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const houseRooms = () => rm.listPublicRooms({ withLive: true }).map((r) => rm.getRoom(r.code)).filter((r) => r && r.house);
/** sweep until a house room opens (the open waits a random 2-20 s, scaled) */
async function openHouse(count = 1) {
  for (let i = 0; i < 200 && houseRooms().length < count; i += 1) { rm.tickHouseRooms(); await wait(5); }
  assert.ok(houseRooms().length >= count, `opened ${count}`);
  return houseRooms();
}

test.afterEach(() => rm._resetRoomsForTesting());

test('a house room OPENS with one player - its host persona - and rooms open at different moments', async () => {
  const [a] = await openHouse(1);
  assert.equal(a.players.length, 1, 'just the host');
  assert.ok(a.players[0].isBot && a.players[0].lobbyBot);
  assert.equal(a.hostId, a.players[0].id);
  const [, b] = await openHouse(2);
  assert.notEqual(a.gameType, b.gameType, 'one of each mode');
  assert.ok(b.createdAt > a.createdAt, 'not the same instant');
  const row = rm.listPublicRooms().find((r) => r.code === a.code);
  assert.equal(row.hostName, a.players[0].name);
  assert.equal(row.startsInMs, undefined, 'no countdown on the list');
});

test('UNVISITED it stays small: never more than the host + one, drifting slowly', async () => {
  const [room] = await openHouse(1);
  let max = 0;
  for (let i = 0; i < 60; i += 1) { max = Math.max(max, room.players.length); await wait(25); }
  assert.ok(max <= H.IDLE_MAX, `max ${max}`);
  assert.equal(room.players[0].id, room.hostId, 'the host never wanders off');
  assert.equal(rm.getRoom(room.code), room);
});

test('a HUMAN sits down: players drift in ONE AT A TIME, then the HOST starts it - no countdown anywhere', async () => {
  const [room] = await openHouse(1);
  while (room.players.length > 1) room.players.pop(); // just the host, to watch the whole fill
  const me = conn();
  const joinedAt = Date.now();
  assert.ok(!rm.joinRoom(room.code, me, 'ANDY').error);
  for (let i = 0; i < 200 && !room.game; i += 1) await wait(5);
  assert.ok(room.game, 'the host started it');
  const started = me.sent.find((m) => m.type === 'game_started');
  assert.ok(started);
  // never with fewer than 3, never sooner than 5 s (scaled) after the human sat down
  assert.ok(room.game.players.length >= H.MIN_TO_START, `${room.game.players.length} players`);
  assert.ok(started.at - joinedAt >= H.START_MIN_AFTER_HUMAN * K - 2, `started ${started.at - joinedAt}ms after the join`);
  // arrivals: one player per roster change, never two in the same moment
  const counts = [];
  for (const m of me.sent.filter((x) => x.type === 'room_update')) {
    assert.equal(m.payload.autoStartInMs, undefined, 'no countdown on room_update');
    counts.push({ n: m.payload.players.length, at: m.at });
  }
  const arrivals = counts.filter((c, i) => i > 0 && c.n > counts[i - 1].n);
  for (let i = 0; i < arrivals.length; i += 1) {
    assert.equal(arrivals[i].n - counts[counts.indexOf(arrivals[i]) - 1].n, 1, 'one at a time');
    if (i > 0) assert.ok(arrivals[i].at - arrivals[i - 1].at >= H.JOIN_GAP[0] * K - 2, 'spaced out');
  }
});

test('a human LEAVES before the start: nothing starts, the room (and its host) stays, waiting again', async () => {
  const [room] = await openHouse(1);
  const me = conn();
  rm.joinRoom(room.code, me, 'ANDY');
  await wait(10);
  rm.removePlayer(room, me.id);
  await wait(250);
  assert.equal(room.game, null, 'never a game without a human');
  assert.equal(rm.getRoom(room.code), room, 'the room is still listed');
  assert.ok(room.players.length >= 1 && room.players.some((p) => p.id === room.hostId));
  assert.equal(room.houseStartAt, null);
});

test('TWO humans in one house room play the same game; a human joining inside the start window still makes it', async () => {
  const [room] = await openHouse(1);
  const a = conn();
  rm.joinRoom(room.code, a, 'ANDY');
  for (let i = 0; i < 100 && !room.houseStartAt; i += 1) await wait(3);
  assert.ok(room.houseStartAt, 'startable');
  const b = conn();
  rm.joinRoom(room.code, b, 'BEA'); // inside the window: the host gives the newcomer a moment
  assert.ok(room.houseStartAt >= Date.now() + H.START_MIN_AFTER_HUMAN * K - 3, 'never sooner than the minimum after the newcomer');
  for (let i = 0; i < 200 && !room.game; i += 1) await wait(5);
  const ids = room.game.players.map((p) => p.id);
  assert.ok(ids.includes(a.id) && ids.includes(b.id), 'both in the game');
});

test('the last human leaving MID-GAME: no bot-only game - back to the lobby, room kept', async () => {
  const [room] = await openHouse(1);
  const me = conn();
  rm.joinRoom(room.code, me, 'ANDY');
  for (let i = 0; i < 200 && !room.game; i += 1) await wait(5);
  assert.ok(room.game);
  rm.removePlayer(room, me.id);
  assert.equal(room.game, null);
  assert.equal(rm.getRoom(room.code), room);
});

test('a finished house game goes back to the lobby after a human-ish pause, and the rule runs again', async () => {
  const [room] = await openHouse(1);
  const me = conn();
  rm.joinRoom(room.code, me, 'ANDY');
  for (let i = 0; i < 200 && !room.game; i += 1) await wait(5);
  room.game.status = 'finished';
  rm.tickHouseRooms();
  assert.ok(room.game, 'not instantly');
  for (let i = 0; i < 200 && room.game && room.game.status === 'finished'; i += 1) { await wait(5); rm.tickHouseRooms(); }
  assert.ok(me.sent.some((m) => m.type === 'game_reset'));
  for (let i = 0; i < 300 && !(room.game && room.game.status !== 'finished'); i += 1) await wait(5);
  assert.ok(room.game && room.game.status !== 'finished', 'the host started the next one');
});

test('NO TELLS: a persona is never seated in two rooms at once (house hosts, house seats, lobby bots)', async () => {
  const rooms = await openHouse(2);
  for (const r of rooms) rm.joinRoom(r.code, conn(), `P${r.code}`);
  await wait(200);
  const names = [];
  for (const r of rm.listPublicRooms({ withLive: true })) for (const p of rm.getRoom(r.code).players) if (p.isBot) names.push(p.name.toLowerCase());
  assert.equal(new Set(names).size, names.length, `unique: ${names.join(', ')}`);
});

test('real rooms appearing push IDLE house rooms out (oldest first); a house room with a human stays', async () => {
  const [kept] = await openHouse(1);
  rm.joinRoom(kept.code, conn(), 'ANDY');
  await openHouse(2);
  rm.createRoom(conn(), 'REAL1', true);
  rm.createRoom(conn(), 'REAL2', true);
  rm.tickHouseRooms();
  const house = houseRooms();
  assert.deepEqual(house, [kept]);
});

test('a SERVER RESTART: every room is gone; the sweep reopens house rooms one at a time', async () => {
  await openHouse(2);
  rm._resetRoomsForTesting(); // what a restart leaves: an empty registry
  assert.equal(houseRooms().length, 0);
  rm.tickHouseRooms();
  assert.ok(houseRooms().length <= 1, 'never both in one sweep');
  await openHouse(2);
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
  // an older client (no watchAll) is never offered a race it can't draw
  assert.equal(rm.listPublicRooms({ withLive: true }).find((x) => x.code === room.code).watch, 'unsupported');
  assert.equal(rm.spectateRoom(room.code, watch, 'WATCHER').error, 'spectate_unsupported');
  assert.equal(rm.listPublicRooms({ withLive: true, watchAll: true }).find((x) => x.code === room.code).watch, 'open');
  assert.ok(!rm.spectateRoom(room.code, watch, 'WATCHER', { watchAll: true }).error);
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
