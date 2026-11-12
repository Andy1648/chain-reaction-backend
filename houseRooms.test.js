// houseRooms.test.js — HOUSE ROOMS make the list a LIVING SERVER (Andy nov12: "more games playing (spectatable) then open
// lobbies just waiting... (number)/8 changing as if it's real") without tells, and stay cheap. + SPECTATE EVERY LIVE MODE.
// The room manager, no sockets: fake connections record what they are sent. HOUSE_TIME_SCALE compresses every HOUSE
// delay (x0.005: a 6-30 s drift is 30-150 ms); the bot GAMES themselves run at real speed.
process.env.HOUSE_TIME_SCALE = '0.005';
// the public auto-start clock (roomManager syncAutoStart), shrunk the same way: 20 s → 100 ms, +5 s → 25 ms, cap → 225 ms
process.env.AUTO_START_BASE_MS = '100';
process.env.AUTO_START_STEP_MS = '25';
process.env.AUTO_START_MAX_MS = '225';

const test = require('node:test');
const assert = require('node:assert/strict');

const rm = require('./roomManager');
const H = require('./houseRooms');
const { MODES: T5 } = require('./t5Modes');

let n = 0;
const conn = () => {
  n += 1;
  return { id: `h${n}`, readyState: 1, sent: [], send(m) { const msg = JSON.parse(m); msg.at = Date.now(); this.sent.push(msg); } };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// a registry read that is NOT a visitor looking at the list (note: false)
const all = () => rm.listPublicRooms({ withLive: true, watchAll: true, note: false }).map((r) => rm.getRoom(r.code)).filter(Boolean);
const house = () => all().filter((r) => r.house);
const liveHouse = () => house().filter((r) => r.game && r.game.status !== 'finished');
const openHouse = () => house().filter((r) => !r.game);
/** sweep (and keep "looking at the list") for up to `ms` or until `done()` */
async function sweep(ms, done = () => false) {
  const until = Date.now() + ms;
  while (Date.now() < until && !done()) { rm.listPublicRooms({ withLive: true }); rm.tickHouseRooms(); await wait(10); }
}
async function openOne() {
  await sweep(3000, () => openHouse().length >= 1);
  assert.ok(openHouse().length >= 1, 'a house lobby opened');
  return openHouse()[0];
}

test.afterEach(() => {
  rm._resetRoomsForTesting();
  const st = rm._houseStateForTesting();
  for (const k of Object.keys(st)) delete st[k];
});

test('A LIVING LIST: while people look, the house runs more LIVE games (3-5) than OPEN lobbies (1-2)', async () => {
  await sweep(12000, () => liveHouse().length >= 3);
  const st = rm._houseStateForTesting();
  const live = liveHouse().length;
  assert.ok(live >= 3 && live <= Math.min(5, H.HOUSE_LIVE_MAX), `live ${live}`);
  assert.ok(live >= Math.min(st.liveTarget, 3), 'reaches its live target');
  await sweep(1500);
  const open = openHouse().length;
  assert.ok(open >= 1 && open <= 2 + Math.max(0, st.liveTarget - liveHouse().length), `open ${open}`);
  assert.ok(liveHouse().length > openHouse().length || liveHouse().length >= 3, 'more playing than waiting');
  for (const r of liveHouse()) assert.ok(H.MODES.includes(r.game.gameType), 'Word Bomb / Blitz games');
  // every live house game is listed as PLAYING and watchable
  for (const row of rm.listPublicRooms({ withLive: true, watchAll: true, note: false }).filter((x) => rm.getRoom(x.code).house && x.status === 'playing')) {
    assert.equal(row.watch, 'open');
  }
});

test('a LIVE house game is a real game: bots play words, a watcher gets the frames', async () => {
  await sweep(12000, () => liveHouse().some((r) => r.game.gameType === 'word-bomb'));
  const room = liveHouse().find((r) => r.game.gameType === 'word-bomb');
  assert.ok(room, 'a Word Bomb house game is running');
  const w = conn();
  assert.ok(!rm.spectateRoom(room.code, w, 'WATCHER', { watchAll: true }).error);
  const usedAt = () => (room.game ? room.game.usedWords.size : 0);
  const lives = () => (room.game ? room.game.players.reduce((s, p) => s + p.lives, 0) : 0);
  const u0 = usedAt(); const l0 = lives();
  for (let i = 0; i < 300 && room.game && usedAt() === u0 && lives() === l0; i += 1) await wait(100);
  assert.ok(usedAt() > u0 || lives() < l0 || !room.game || room.game.status === 'finished', 'the game moves: a word lands or a life is lost');
  assert.ok(w.sent.some((m) => m.type === 'turn_update' || m.type === 'word_result' || m.type === 'timer_tick'), 'the watcher sees it');
});

test('an OPEN lobby DRIFTS: its count changes on its own clock, a step of 1-2, never below its host or above the cap', async () => {
  const room = await openOne();
  const st = rm._houseStateForTesting();
  st.liveTarget = 0; st.retargetAt = Date.now() + 1e9; // no game wanted: watch the lobby itself drift
  const seen = [];
  let last = room.players.length;
  for (let i = 0; i < 300 && rm.getRoom(room.code) === room && !room.game; i += 1) {
    if (room.players.length !== last) { seen.push(room.players.length - last); last = room.players.length; }
    assert.ok(room.players.length >= 1 && room.players.length <= H.LOBBY_MAX, `count ${room.players.length}`);
    assert.ok(room.players.some((p) => p.id === room.hostId), 'the host stays');
    await wait(10);
  }
  assert.ok(seen.length >= 2, `it moved (${seen.join(',')})`);
  for (const d of seen) assert.ok(Math.abs(d) <= 2, `a step of 1-2 (${d})`);
});

test('NOBODY LOOKING: nothing new starts, running house games are not replaced; one cheap lobby at most', async () => {
  await sweep(12000, () => liveHouse().length >= 2);
  const st = rm._houseStateForTesting();
  st.lastListAt = Date.now() - H.LIST_IDLE_MS - 1000; // the list was last asked for long ago
  const before = liveHouse().length;
  for (let i = 0; i < 100; i += 1) { rm.tickHouseRooms(); await wait(10); }
  assert.ok(liveHouse().length <= before, 'no new house game starts');
  assert.equal(H.wanted({ ...depsShim(), state: st }, Date.now()).live, 0);
  assert.ok(openHouse().length <= 1 + 1, 'the lobbies wind down');
});

function depsShim() {
  return { rooms: () => all(), isGameLive: (r) => !!r.game && r.game.status !== 'finished', maxPlayers: rm.MAX_PLAYERS_PER_ROOM };
}

test('BUSY with real rooms: the house starts no games', async () => {
  for (let i = 0; i < 26; i += 1) rm.createRoom(conn(), `REAL${i}`, false);
  const st = rm._houseStateForTesting();
  st.lastListAt = Date.now();
  // through the real registry: 26 real rooms = busy
  let started = 0;
  for (let i = 0; i < 200; i += 1) { rm.listPublicRooms(); rm.tickHouseRooms(); started = Math.max(started, liveHouse().length); await wait(10); }
  assert.equal(started, 0, 'no house game while the server is busy');
});

test('a HUMAN sits down in a house lobby: drift stops, players join one at a time, it starts on the SAME visible clock as any public room', async () => {
  const room = await openOne();
  const me = conn();
  assert.ok(!rm.joinRoom(room.code, me, 'ANDY').error);
  for (let i = 0; i < 100 && room.players.length < 2; i += 1) await wait(5);
  assert.ok(rm.buildRoomUpdatePayload(room).payload.autoStartInMs > 0, 'a visible STARTS IN, like a real room');
  for (let i = 0; i < 300 && !room.game; i += 1) await wait(5);
  assert.ok(room.game, 'it started on its own');
  assert.ok(room.game.players.some((p) => p.id === me.id), 'with the human in it');
  const counts = me.sent.filter((x) => x.type === 'room_update').map((m) => m.payload.players.length);
  for (let i = 1; i < counts.length; i += 1) assert.ok(counts[i] - counts[i - 1] <= 1, `one at a time (${counts})`);
});

test('a human leaving before the start: the clock cancels if they were the only human; the room stays', async () => {
  const room = await openOne();
  const me = conn();
  rm.joinRoom(room.code, me, 'ANDY');
  await wait(5);
  rm.removePlayer(room, me.id);
  assert.equal(rm.getRoom(room.code), room, 'still listed');
  assert.equal(room.autoStartAt, null, 'no clock without a human');
});

test('a FINISHED house game with a WATCHER goes back to its lobby (the watcher is not dropped)', async () => {
  await sweep(12000, () => liveHouse().length >= 1);
  const room = liveHouse()[0];
  rm.spectateRoom(room.code, conn(), 'WATCHER', { watchAll: true });
  room.game.status = 'finished';
  for (let i = 0; i < 300 && room.game; i += 1) { rm.listPublicRooms(); rm.tickHouseRooms(); await wait(5); }
  assert.equal(rm.getRoom(room.code), room, 'kept');
  assert.equal(room.game, null, 'back in its lobby');
});

test('NO TELLS: a persona is never seated in two rooms at once', async () => {
  await sweep(12000, () => house().length >= 4);
  const names = [];
  for (const r of all()) for (const p of r.players) if (p.isBot) names.push(p.name.toLowerCase());
  assert.equal(new Set(names).size, names.length, `unique: ${names.join(', ')}`);
});

test('a SERVER RESTART: the sweep reopens the mix one room at a time', async () => {
  await sweep(3000, () => house().length >= 2);
  rm._resetRoomsForTesting();
  rm.listPublicRooms();
  rm.tickHouseRooms();
  assert.ok(house().length <= 1, 'never two in one sweep');
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
