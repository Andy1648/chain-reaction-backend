// minerMatch.js
// MINER quick-match: the WORD RACE queue pattern (wordRaceMatch.js) for the mine. Quick-matching joins the
// fullest waiting MINER room, or opens a new one. A room launches when it fills (MAX_MINERS) or
// FILL_WAIT_MS after it opened - whichever comes first; minerMode.start tops a < 2-human mine up with bots.
//
// Queue rooms are PRIVATE (isPublic=false): never in the Word Bomb/Blitz public list, never picked by the
// generic quick_play - but joinable by code, so a friend can be pulled into the same mine. The fill timer
// lives in the room's countdownTimeout slot, so destroyRoom cancels it with no new teardown path.

const {
  createRoom,
  joinRoom,
  getRoom,
  startGame,
  broadcastToRoom,
  guardRoom,
} = require('./roomManager');
const miner = require('./miner');
const minerMode = require('./minerMode');

// Test hook: MINER_FILL_WAIT_MS shortens the wait for harnesses. Never set in production.
const FILL_WAIT_MS = Number(process.env.MINER_FILL_WAIT_MS) || 8 * 1000;
const queue = new Set(); // codes of waiting quick-match miner rooms

function queuePayload(room) {
  return {
    code: room.code,
    humans: room.players.filter((p) => !p.isBot).length,
    maxMiners: miner.MAX_MINERS,
    fillInMs: Math.max(0, (room.minerFillAt || 0) - Date.now()),
    serverNow: Date.now(),
  };
}

function launch(room) {
  queue.delete(room.code);
  if (room.countdownTimeout) {
    clearTimeout(room.countdownTimeout);
    room.countdownTimeout = null;
  }
  if (getRoom(room.code) !== room || (room.game && room.game.status !== 'finished')) return;
  startGame(room);
}

/** Drops the connection into a mine. Returns { room, created } or { error }. */
function quickMatch(connection, playerName, allowCreate) {
  const candidates = [];
  for (const code of queue) {
    const room = getRoom(code);
    if (!room || room.game || room.gameType !== minerMode.gameType) {
      queue.delete(code);
      continue;
    }
    if (room.players.length >= miner.MAX_MINERS) continue;
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
  room.gameType = minerMode.gameType;
  room.minerQueue = true;
  room.minerFillAt = Date.now() + FILL_WAIT_MS;
  queue.add(room.code);
  room.countdownTimeout = setTimeout(
    () => guardRoom(room, 'miner_fill_error', () => launch(room)),
    FILL_WAIT_MS
  );
  return { room, created: true };
}

/** After a join: tell the room the queue state, and launch at once if full. */
function afterJoin(room) {
  if (!room.minerQueue) return;
  broadcastToRoom(room, { type: 'miner_queue', payload: queuePayload(room) });
  if (room.players.length >= miner.MAX_MINERS) launch(room);
}

function _resetQueueForTesting() {
  queue.clear();
}

module.exports = { quickMatch, afterJoin, launch, FILL_WAIT_MS, _resetQueueForTesting };
