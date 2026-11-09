// houseRooms.js — HOUSE ROOMS (Andy nov9: "i oftentimes wait so long for someone to start room"). While the public list is
// thin, the server keeps up to HOUSE_MAX public Word Bomb / Category Blitz rooms of its own, each hosted by lobby-bot
// personas (lobbyBots.js: the leaderboard's seeded names + heroes). They never need a host to press START: the moment a
// human sits down a short countdown runs (autoStartInMs on room_update / startsInMs on the public list) and the game
// starts on its own; after a finished game the room goes back to its lobby and counts down again.
//
// Rules (each enforced here, pinned by houseRooms.test.js):
//   * THIN LIST ONLY: as real public rooms waiting with a human appear, idle house rooms (no human in them) are dropped,
//     down to zero once HOUSE_MAX real rooms wait. A house room with a human in it is never dropped.
//   * NEVER A BOT-ONLY GAME: a game starts only with a human seated; the last human leaving destroys the room (the
//     standard every-bot rule in removePlayer) and a fresh one replaces it later.
//   * HONEST ECONOMY: the seated bots are `isBot` + `lobbyBot` on the wire, exactly like lobby bots.
//   * Timers are unref'd, cleared on start / destroy; decisions read the live room.
'use strict';

const HOUSE_MAX = 2;
const MODES = ['word-bomb', 'category-blitz'];
const START_MS = Number(process.env.HOUSE_START_MS) || 15000; // a human sits down → the game starts this long after
const AGAIN_MS = Number(process.env.HOUSE_AGAIN_MS) || 20000; // a finished game → back to the lobby this long after
const TICK_MS = Number(process.env.HOUSE_TICK_MS) || 5000;
const BOTS = [2, 3]; // bots seated in a house room (the host is one of them)

const humansIn = (room) => room.players.filter((p) => !p.isBot).length;

function clearHouseTimer(room) {
  if (room && room.houseTimer) {
    clearTimeout(room.houseTimer);
    room.houseTimer = null;
  }
  if (room) room.houseStartAt = null;
}

/** A real (not house) public room in its lobby, with a human waiting and a seat free: what makes the list not thin. */
function isRealWaiting(room, deps) {
  return !!(room.isPublic && !room.house && !deps.isGameLive(room) && humansIn(room) >= 1 && room.players.length < deps.maxPlayers);
}

/** The roster changed (join / leave / back to the lobby): arm the start countdown when a human sits in a house lobby. */
function onRosterChange(room, deps) {
  if (!room || !room.house) return;
  if (deps.isGameLive(room) || room.game) { clearHouseTimer(room); return; } // live, or a finished game the tick resets
  if (humansIn(room) < 1) { clearHouseTimer(room); return; }
  if (room.houseTimer) return; // already counting down: a second human doesn't restart it
  const now = deps.now ? deps.now() : Date.now();
  room.houseStartAt = now + START_MS;
  room.houseTimer = setTimeout(() => {
    room.houseTimer = null;
    room.houseStartAt = null;
    try {
      if (room.house && !room.game && humansIn(room) >= 1) deps.start(room);
    } catch (err) {
      if (deps.onError) deps.onError(err);
    }
  }, START_MS);
  if (room.houseTimer.unref) room.houseTimer.unref();
}

/** One sweep: keep the right number of house rooms, and send finished house games back to their lobby. Returns a summary. */
function tick(deps) {
  const now = deps.now ? deps.now() : Date.now();
  const all = [...deps.rooms()];
  const house = all.filter((r) => r.house);
  const want = Math.max(0, HOUSE_MAX - all.filter((r) => isRealWaiting(r, deps)).length);
  let dropped = 0;
  for (const r of house) {
    if (house.length - dropped <= want) break;
    if (humansIn(r) === 0 && !deps.isGameLive(r)) {
      deps.destroy(r);
      dropped += 1;
    }
  }
  let created = null;
  if (house.length - dropped < want) {
    const used = new Set(house.filter((r) => deps.hasRoom(r)).map((r) => r.gameType));
    const mode = MODES.find((m) => !used.has(m)) || MODES[house.length % MODES.length];
    created = deps.create(mode, BOTS[Math.floor((deps.random || Math.random)() * BOTS.length)]);
  }
  let reset = 0;
  for (const r of house) {
    if (!deps.hasRoom(r) || !r.game || deps.isGameLive(r)) { if (r) r.houseAgainAt = null; continue; }
    // a FINISHED house game: give the result screen a moment, then back to the lobby (which counts down again)
    if (!r.houseAgainAt) r.houseAgainAt = now + AGAIN_MS;
    else if (now >= r.houseAgainAt) {
      r.houseAgainAt = null;
      deps.reset(r);
      reset += 1;
    }
  }
  return { want, dropped, created: created ? created.code : null, reset };
}

function startHouseRooms(deps) {
  if (deps.interval) return deps.interval;
  const run = () => { try { tick(deps); } catch (err) { if (deps.onError) deps.onError(err); } };
  run();
  const handle = setInterval(run, TICK_MS);
  if (handle.unref) handle.unref();
  return handle;
}

module.exports = { tick, onRosterChange, clearHouseTimer, startHouseRooms, isRealWaiting, HOUSE_MAX, START_MS, AGAIN_MS, MODES };
