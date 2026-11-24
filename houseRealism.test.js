// houseRealism.test.js — HOUSE ROOMS that read like real students' rooms (Andy nov21: "make bots (who create lobbies) even
// more believable and realistic"): the same visible auto-start clock as a real lobby, one-at-a-time human arrivals, game
// sizes that look like real traffic, rematches with slightly different players or a disband, no persona reused across
// rooms, and the list reporting a just-finished game as FINISHED. HOUSE delays x0.005; the auto-start clock shrunk below.
process.env.HOUSE_TIME_SCALE = '0.005';
process.env.AUTO_START_BASE_MS = '400';
process.env.AUTO_START_STEP_MS = '100';
process.env.AUTO_START_MAX_MS = '900';

const test = require('node:test');
const assert = require('node:assert/strict');

const rm = require('./roomManager');
const H = require('./houseRooms');
const { MODES: T5 } = require('./t5Modes');

let n = 0;
const conn = () => {
  n += 1;
  return { id: `r${n}`, readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); } };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const all = () => rm.listPublicRooms({ withLive: true, watchAll: true, note: false }).map((r) => rm.getRoom(r.code)).filter(Boolean);
const house = () => all().filter((r) => r.house);
const openHouse = () => house().filter((r) => !r.game);
const row = (room) => rm.listPublicRooms({ withLive: true, watchAll: true, note: false }).find((r) => r.code === room.code);
const seeded = (seed) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
async function sweep(ms, done = () => false) {
  const until = Date.now() + ms;
  while (Date.now() < until && !done()) { rm.listPublicRooms({ withLive: true }); rm.tickHouseRooms(); await wait(10); }
}
/** no games wanted: lobbies idle (host alone, the odd visitor) */
/** a list people have been looking at for a while: no cold-start games, every game gathers in a lobby first */
function warmList() {
  const st = rm._houseStateForTesting();
  st.lastListAt = Date.now(); st.coldUntil = 0;
}
function noGamesWanted() {
  const st = rm._houseStateForTesting();
  st.lastListAt = Date.now(); st.liveTarget = 0; st.openTarget = 1; st.retargetAt = Date.now() + 1e9; st.coldUntil = 0;
}

test.afterEach(() => {
  rm._resetRoomsForTesting();
  const st = rm._houseStateForTesting();
  for (const k of Object.keys(st)) delete st[k];
});

// ---- the list status ----

test('LIST STATUS: finished → resetGame → waiting → start → playing', () => {
  const { room } = rm.createRoom(conn(), 'HOST', true);
  rm.joinRoom(room.code, conn(), 'TWO');
  assert.equal(row(room).status, 'waiting');
  assert.ok(!rm.startGame(room).error);
  assert.equal(row(room).status, 'playing');
  room.game.status = 'finished';
  rm.clearTurnTimer(room);
  const fin = row(room);
  assert.equal(fin.status, 'finished', 'a just-ended game is FINISHED, not waiting');
  assert.equal(fin.canSpectate, undefined, 'not a watchable live game');
  rm.resetGame(room);
  assert.equal(row(room).status, 'waiting');
  assert.ok(!rm.startGame(room).error, 'a finished room still starts again');
  assert.equal(row(room).status, 'playing');
  rm.clearTurnTimer(room);
});

test('LIST STATUS: a FINISHED room is still joinable (it joins like a lobby)', () => {
  const { room } = rm.createRoom(conn(), 'HOST', true);
  rm.joinRoom(room.code, conn(), 'TWO');
  rm.startGame(room);
  room.game.status = 'finished';
  rm.clearTurnTimer(room);
  assert.ok(!rm.joinRoom(room.code, conn(), 'THREE').error);
  assert.equal(row(room).status, 'finished');
});

test('LIST STATUS: Category Blitz between_rounds and MINER reveal are PLAYING', () => {
  const { room } = rm.createRoom(conn(), 'BLITZ', true);
  room.gameType = 'category-blitz';
  rm.joinRoom(room.code, conn(), 'TWO');
  assert.ok(!rm.startGame(room).error);
  room.game.status = 'between_rounds';
  assert.equal(row(room).status, 'playing');
  rm.clearRoundTimer(room);
  if (room.roundPauseTimeout) clearTimeout(room.roundPauseTimeout);

  const { room: dig } = rm.createRoom(conn(), 'DIGGER', true);
  dig.gameType = 'miner';
  rm.joinRoom(dig.code, conn(), 'RIVAL');
  assert.ok(!rm.startGame(dig).error);
  const helpers = { broadcastToRoom: rm.broadcastToRoom, touchRoom: rm.touchRoom, clearRoundTimer: rm.clearRoundTimer };
  T5.miner._openRound(dig, helpers);
  T5.miner._closeRound(dig, helpers);
  dig.game.status = 'reveal';
  assert.equal(row(dig).status, 'playing');
  rm.clearRoundTimer(dig);
  if (dig.roundPauseTimeout) clearTimeout(dig.roundPauseTimeout);
});

// ---- the lobby lifecycle ----

test('SAME CLOCK AS A REAL LOBBY: a house lobby of 2+ bots shows STARTS IN (room_update + list) and starts when it fires', async () => {
  warmList();
  await sweep(4000, () => openHouse().some((r) => r.houseMode === 'gather' && r.players.length >= 2 && r.autoStartAt));
  const room = openHouse().find((r) => r.houseMode === 'gather' && r.players.length >= 2 && r.autoStartAt);
  assert.ok(room, 'a gathering house lobby');
  assert.ok(row(room).startsInMs > 0, 'the list row says STARTS IN');
  assert.ok(rm.buildRoomUpdatePayload(room).payload.autoStartInMs > 0, 'room_update carries the clock');
  assert.ok(room.autoStartAt - Date.now() <= 900 + 5, 'never past the cap');
  await sweep(2500, () => !!room.game);
  assert.ok(room.game, 'it started when its clock ran out');
});

test('IDLE: the host waits alone; a visitor who drops in leaves before the clock fires - nothing starts unasked', async () => {
  noGamesWanted();
  const room = rm.createHouseRoom('word-bomb');
  Object.assign(room, { houseMode: 'idle', houseOpenedAt: Date.now(), houseLifetime: 1e9, houseBornAt: Date.now() });
  H.onRosterChange(room, rm._houseDepsForTesting());
  const counts = new Set();
  let sawClock = false;
  const until = Date.now() + 2500;
  while (Date.now() < until) {
    noGamesWanted();
    counts.add(room.players.length);
    if (room.autoStartAt) sawClock = true;
    assert.equal(room.game, null, 'no game nobody asked for');
    await wait(3);
  }
  assert.equal(rm.getRoom(room.code), room);
  assert.ok([...counts].every((c) => c === 1 || c === 2), `alone or one visitor (${[...counts]})`);
  assert.ok(counts.has(2) && sawClock, 'someone dropped in (and the clock showed, like any room)');
});

test('IDLE TOO LONG: the host gives up - the room closes', async () => {
  noGamesWanted();
  const room = rm.createHouseRoom('category-blitz');
  Object.assign(room, { houseMode: 'idle', houseOpenedAt: Date.now() - 1e6, houseLifetime: 1 });
  H.onRosterChange(room, rm._houseDepsForTesting());
  for (let i = 0; i < 200 && rm.getRoom(room.code) === room; i += 1) await wait(5);
  assert.equal(rm.getRoom(room.code), undefined, 'gone');
});

test('A CLOCK THE HOUSE CANNOT HONOUR (nobody wants a game): the lobby breaks up instead of starting', async () => {
  noGamesWanted();
  const room = rm.createHouseRoom('word-bomb');
  Object.assign(room, { houseMode: 'idle', houseOpenedAt: Date.now(), houseLifetime: 1e9 });
  const deps = rm._houseDepsForTesting();
  for (let i = 0; i < 3; i += 1) room.players.push(deps.makeBot(room));
  rm.broadcastToRoom(room, rm.buildRoomUpdatePayload(room)); // 4 players: the clock runs
  assert.ok(room.autoStartAt, 'STARTS IN shows');
  assert.equal(H.autoStartDue(room, deps), false);
  assert.ok(['drain', 'die'].includes(room.houseMode), room.houseMode);
  for (let i = 0; i < 300 && rm.getRoom(room.code) === room && room.players.length > 1; i += 1) { noGamesWanted(); await wait(3); }
  assert.equal(room.game, null, 'never started');
  assert.ok(rm.getRoom(room.code) !== room || room.players.length === 1, 'emptied back to its host (or died)');
});

test('GATHERING: arrivals come ONE AT A TIME at uneven gaps; the games that start have varied sizes', async () => {
  warmList();
  const sizes = [];
  const gaps = [];
  const watch = new Map(); // code -> { n, at }
  const until = Date.now() + 9000;
  while (Date.now() < until && sizes.length < 6) {
    rm.listPublicRooms({ withLive: true }); rm.tickHouseRooms();
    for (const r of house()) {
      const w = watch.get(r.code);
      if (!r.game) {
        if (w && r.players.length !== w.n) {
          assert.ok(Math.abs(r.players.length - w.n) <= 1 || w.n === 0, `one at a time (${w.n}→${r.players.length})`);
          if (r.players.length > w.n) gaps.push(Date.now() - w.at);
        }
        watch.set(r.code, { n: r.players.length, at: w && r.players.length === w.n ? w.at : Date.now() });
      } else if (w && w.n !== -1) { sizes.push(r.game.players.length); watch.set(r.code, { n: -1, at: 0 }); }
      else if (r.game.status === 'finished') watch.set(r.code, { n: 0, at: Date.now() });
    }
    await wait(3);
  }
  assert.ok(sizes.length >= 2, `games started (${sizes})`);
  for (const s of sizes) assert.ok(s >= 2 && s <= 8, `size ${s}`);
  assert.ok(new Set(gaps.map((g) => Math.round(g / 5))).size > 1 || gaps.length < 2, `gaps vary (${gaps})`);
});

test('GAME SIZES follow real traffic: 2-5 typical, 6-8 rarer, never 1 or 9+', () => {
  const rnd = seeded(7);
  const c = {};
  for (let i = 0; i < 20000; i += 1) { const s = H.gameSize(rnd); c[s] = (c[s] || 0) + 1; }
  const share = (lo, hi) => Object.entries(c).filter(([k]) => +k >= lo && +k <= hi).reduce((s, [, v]) => s + v, 0) / 20000;
  assert.ok(share(2, 5) > 0.8, `2-5: ${share(2, 5)}`);
  assert.ok(share(6, 8) > 0.08 && share(6, 8) < 0.2, `6-8: ${share(6, 8)}`);
  assert.equal(share(0, 1) + share(9, 99), 0);
  assert.ok(c[3] > c[6] && c[6] > c[8], 'tapering');
});

test('GAPS are human: skewed short, the odd long lull, never uniform or round', () => {
  const rnd = seeded(11);
  const xs = Array.from({ length: 4000 }, () => H.humanGap([6000, 30000], rnd));
  const sorted = [...xs].sort((a, b) => a - b);
  const median = sorted[2000];
  assert.ok(median < 18000, `skewed short (median ${median})`);
  assert.ok(sorted[3990] > 30000, 'the odd lull runs long');
  assert.ok(sorted[0] >= 6000);
  assert.ok(xs.filter((x) => x % 1000 === 0).length < 20, 'no round numbers');
  assert.ok(new Set(xs).size > 3500, 'no repeated timing');
});

test('MODES lean Word Bomb like real traffic, but never three ahead of the other', () => {
  const rnd = seeded(3);
  const none = { rooms: () => [] };
  let wb = 0;
  for (let i = 0; i < 10000; i += 1) if (H.pickMode(none, rnd) === 'word-bomb') wb += 1;
  assert.ok(wb > 5500 && wb < 6900, `word bomb ${wb / 100}%`);
  const lopsided = { rooms: () => [{ house: true, gameType: 'word-bomb' }, { house: true, gameType: 'word-bomb' }] };
  for (let i = 0; i < 50; i += 1) assert.equal(H.pickMode(lopsided, rnd), 'category-blitz');
});

// ---- the game lifecycle ----

test('A FINISHED unvisited game: listed FINISHED while results show, then a rematch with slightly different players, or it disbands', async () => {
  await sweep(6000, () => house().some((r) => r.game && r.game.status !== 'finished'));
  const room = house().find((r) => r.game && r.game.status !== 'finished');
  assert.ok(room);
  const before = room.players.map((p) => p.name);
  room.game.status = 'finished';
  rm.clearTurnTimer(room); rm.clearRoundTimer(room);
  assert.equal(row(room).status, 'finished');
  room.houseMaxRematches = 3; room.houseBornAt = Date.now();
  for (let i = 0; i < 400 && rm.getRoom(room.code) === room && room.game && room.game.status === 'finished'; i += 1) {
    rm.listPublicRooms({ withLive: true }); rm.tickHouseRooms(); await wait(5);
  }
  if (rm.getRoom(room.code) !== room) return; // it disbanded: fine
  const after = room.players.map((p) => p.name);
  const stayed = after.filter((x) => before.includes(x)).length;
  assert.ok(before.length - stayed <= 2, `at most two left (${before} → ${after})`);
  assert.equal(room.houseRematches, 1);
});

test('NO ROOM LIVES FOREVER: past its rematch limit an unvisited room disbands', async () => {
  await sweep(6000, () => house().some((r) => r.game && r.game.status !== 'finished'));
  const room = house().find((r) => r.game && r.game.status !== 'finished');
  room.houseMaxRematches = 0;
  room.game.status = 'finished';
  rm.clearTurnTimer(room); rm.clearRoundTimer(room);
  for (let i = 0; i < 400 && rm.getRoom(room.code) === room; i += 1) { rm.listPublicRooms({ withLive: true }); rm.tickHouseRooms(); await wait(5); }
  assert.equal(rm.getRoom(room.code), undefined, 'disbanded');
});

// ---- a human inside ----

test('A HUMAN JOINS a house lobby: the exact real-room clock (base, +step per arrival, cap)', async () => {
  noGamesWanted();
  const room = rm.createHouseRoom('word-bomb');
  Object.assign(room, { houseMode: 'idle', houseOpenedAt: Date.now(), houseLifetime: 1e9, houseSize: 5 });
  const me = conn();
  const t0 = Date.now();
  assert.ok(!rm.joinRoom(room.code, me, 'ANDY').error);
  assert.ok(room.autoStartAt - t0 >= 395 && room.autoStartAt - t0 <= 405, `20 s base (scaled): ${room.autoStartAt - t0}`);
  const at2 = room.autoStartAt;
  for (let i = 0; i < 200 && room.players.length < 3; i += 1) await wait(2);
  assert.equal(room.players.length, 3, 'a player arrived');
  assert.equal(room.autoStartAt - at2, 100, '+5 s (scaled) for the arrival');
  for (let i = 0; i < 400 && !room.game; i += 1) await wait(5);
  assert.ok(room.game && room.game.players.some((p) => p.id === me.id), 'it started with the human in it');
  rm.clearTurnTimer(room);
});

test('BEFORE THE START with a human there, a bot now and then leaves (never the host, never the human)', async () => {
  const room = { code: 'TESTX', house: true, game: null, hostId: 'h', spectators: [], houseSize: 5, players: [
    { id: 'h', name: 'host', isBot: true, lobbyBot: true },
    { id: 'b', name: 'b', isBot: true, lobbyBot: true },
    { id: 'me', name: 'me' },
  ] };
  let broadcasts = 0;
  const deps = { ...rm._houseDepsForTesting(), hasRoom: () => true, rooms: () => [room], random: () => 0.01, state: {},
    broadcast: () => { broadcasts += 1; }, makeBot: () => ({ id: 'n', name: 'n', isBot: true, lobbyBot: true }) };
  room.houseJoinAt = Date.now(); // the next step is due now
  H.onRosterChange(room, deps);
  await wait(20);
  H.clearHouseTimer(room);
  assert.deepEqual(room.players.map((p) => p.id), ['h', 'me'], 'the other bot left');
  assert.ok(broadcasts >= 1);
});

// ---- no tells ----

test('NO REUSED FACES: a persona never shows up in two different rooms (not even after leaving one)', async () => {
  const seen = new Map(); // name -> room code
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    rm.listPublicRooms({ withLive: true }); rm.tickHouseRooms();
    for (const r of house()) for (const p of r.players) {
      if (!p.isBot) continue;
      const k = p.name.toLowerCase();
      if (seen.has(k)) assert.equal(seen.get(k), r.code, `${p.name} in ${seen.get(k)} and ${r.code}`);
      else seen.set(k, r.code);
    }
    await wait(5);
  }
  assert.ok(seen.size >= 8, `plenty of faces (${seen.size})`);
});

test('NO TWO ROOMS ALIKE: distinct hosts across the list, each wearing a hero', async () => {
  await sweep(6000, () => house().length >= 4);
  const hs = house();
  assert.ok(hs.length >= 3);
  assert.equal(new Set(hs.map((r) => r.players.find((p) => p.id === r.hostId)?.name)).size, hs.length, 'distinct hosts');
  for (const r of hs) {
    const host = r.players.find((p) => p.id === r.hostId);
    assert.ok(host && host.hero, 'every host wears a hero, like every real player');
  }
});
