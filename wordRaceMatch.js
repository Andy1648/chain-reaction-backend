// wordRaceMatch.js
// WORD RACE quick-match. A small race queue on top of roomManager's normal rooms:
// quick-matching joins the fullest waiting race room, or opens a new one. A race
// room launches when it fills (MAX_RACERS) or FILL_WAIT_MS after it opened -
// whichever comes first. At launch, a room with fewer than 2 humans is topped up
// with bots to 3 racers (wordRaceMode.start does the seating).
//
// Queue rooms are created PRIVATE (isPublic=false) on purpose: they must never show
// up in the Word Bomb/Blitz public list or be picked by the generic quick_play.
// The fill timer lives in the room's countdownTimeout slot, so destroyRoom (empty
// room / idle reaper / failRoom) cancels it with no new teardown path.

const {
  createRoom,
  joinRoom,
  getRoom,
  startGame,
  broadcastToRoom,
  guardRoom,
} = require('./roomManager');
const race = require('./wordRace');
const raceMode = require('./wordRaceMode');

// Test hook: RACE_FILL_WAIT_MS shortens the wait for harnesses. Never set in production.
const FILL_WAIT_MS = Number(process.env.RACE_FILL_WAIT_MS) || 10 * 1000;
const queue = new Set(); // codes of waiting quick-match race rooms

function humansIn(room) {
  return room.players.filter((p) => !p.isBot).length;
}

function queuePayload(room) {
  return {
    code: room.code,
    humans: humansIn(room),
    maxRacers: race.MAX_RACERS,
    fillInMs: Math.max(0, (room.raceFillAt || 0) - Date.now()),
    serverNow: Date.now(),
  };
}

function launch(room) {
  queue.delete(room.code);
  if (room.countdownTimeout) {
    clearTimeout(room.countdownTimeout);
    room.countdownTimeout = null;
  }
  if (getRoom(room.code) !== room || room.game) return; // torn down / already racing
  startGame(room);
}

/**
 * Drops the connection into a race room. Returns { room, created } or { error }.
 * `allowCreate` is the caller's per-connection create throttle.
 */
function quickMatch(connection, playerName, allowCreate) {
  const candidates = [];
  for (const code of queue) {
    const room = getRoom(code);
    if (!room || room.game || room.gameType !== raceMode.gameType) {
      queue.delete(code);
      continue;
    }
    if (room.players.length >= race.MAX_RACERS) continue;
    candidates.push(room);
  }
  candidates.sort((a, b) => b.players.length - a.players.length);
  for (const room of candidates) {
    const res = joinRoom(room.code, connection, playerName);
    if (res.error) continue;
    return { room, created: false };
  }

  if (typeof allowCreate === 'function' && !allowCreate()) return { error: 'rate_limited' };
  const res = createRoom(connection, playerName, false);
  if (res.error) return { error: res.error };
  const room = res.room;
  room.gameType = raceMode.gameType;
  room.raceQueue = true;
  room.raceFillAt = Date.now() + FILL_WAIT_MS;
  queue.add(room.code);
  room.countdownTimeout = setTimeout(
    () => guardRoom(room, 'race_fill_error', () => launch(room)),
    FILL_WAIT_MS
  );
  return { room, created: true };
}

/** After a join: tell the room the queue state, and launch at once if full. */
function afterJoin(room) {
  broadcastToRoom(room, { type: 'race_queue', payload: queuePayload(room) });
  if (room.players.length >= race.MAX_RACERS) launch(room);
}

function _resetQueueForTesting() {
  queue.clear();
}

module.exports = { quickMatch, afterJoin, launch, FILL_WAIT_MS, _resetQueueForTesting };
