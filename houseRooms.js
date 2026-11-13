// houseRooms.js — HOUSE ROOMS: the server's own public rooms, so the list reads like a living server (Andy nov9: "i
// oftentimes wait so long for someone to start room"; "don't make it seem like bots"; nov12: "more games playing
// (spectatable) then open lobbies just waiting - for open lobbies maybe make the (number)/8 changing as if it's real").
//
// THE RULE
//   * THE MIX: while people are looking at the list, the house keeps a few LIVE games (3-5) and a few OPEN lobbies (1-2),
//     each target re-rolled every few minutes, so two refreshes never look the same. Real public rooms count against
//     the targets (a real waiting room is one fewer house lobby; a real live game, one fewer house game).
//   * AN OPEN LOBBY WITH NOBODY IN IT drifts like people: players come and go one or two at a time, 6-30 s apart, toward
//     the room's own wandering "mood" size (1-6), never below its host. Each room runs on its own clock (nothing moves in
//     sync), and it avoids sitting at the same count as another open house lobby.
//   * IT STARTS ON ITS OWN when the house wants another live game: once it has 3+ players and has been open for its own
//     patience (20-120 s), the host starts a REAL game - Word Bomb or Category Blitz, bots playing at their usual human
//     pace with real words, real lives lost and a real winner - listed as PLAYING, watchable like any other.
//   * A FINISHED HOUSE GAME holds its results 8-20 s, then either goes back to its lobby (always, if a human or a watcher
//     is there - the watcher's seat follows the usual rematch rule) or closes, and the house opens a fresh room elsewhere.
//   * A HUMAN SITS DOWN in a house lobby: the rules shipped in #48 hold - more players drift in one at a time (3-12 s
//     apart) up to the room's size, and the host starts 6-16 s after it is startable (a human + 3 players), never sooner
//     than 5 s after the latest human sat down; re-checked when it fires. No countdown on the wire.
//   * NO TELLS: a persona is never seated in two rooms at once (house or lobby bot); every room picks its own size,
//     mood, patience and pace; bot churn is not room activity.
//   * COST: bot games are list-only (Word Bomb's local dictionary; Blitz bots answer from the canon lists, never the AI
//     judge) and broadcast only to watchers. At most HOUSE_LIVE_MAX house games run at once; nothing new starts while
//     the server is busy with real rooms (HOUSE_BUSY_ROOMS) or when nobody has asked for the list for LIST_IDLE_MS -
//     running games finish and close, and one cheap lobby stays.
//   * A SERVER RESTART loses every room; the sweep reopens the mix one room at a time.
//
// HONEST ECONOMY: every seated bot is `isBot` + `lobbyBot` on the wire, exactly like lobby bots (no payout / gem / win
// rule treats it as a person). Timers are unref'd and cleared on start / destroy; every decision reads the live room.
'use strict';

const MODES = ['word-bomb', 'category-blitz'];
const SCALE = Number(process.env.HOUSE_TIME_SCALE) || 1; // tests / local runs compress every delay
const TICK_MS = Number(process.env.HOUSE_TICK_MS) || 5000;
const S = (ms) => Math.max(1, Math.round(ms * SCALE));

// the mix
const LIVE_TARGET = [3, 5];
const OPEN_TARGET = [1, 2];
const RETARGET = [180000, 480000]; // the targets re-roll this often
const HOUSE_LIVE_MAX = Number(process.env.HOUSE_LIVE_MAX) || 5; // hard cap on concurrent house games
const HOUSE_CAP = 8; // hard cap on house rooms
const HOUSE_BUSY_ROOMS = Number(process.env.HOUSE_BUSY_ROOMS) || 25; // this many real rooms: no new house games
const LIST_IDLE_MS = Number(process.env.HOUSE_LIST_IDLE_MS) || 10 * 60 * 1000; // nobody listed for this long: wind down

// pacing (ms, before SCALE)
const OPEN_WAIT = [2000, 15000]; // a sweep that may open a room waits this long first
const DRIFT_GAP = [6000, 30000]; // an unvisited lobby: someone comes or goes this often
const MOOD = [1, 6]; // the size an unvisited lobby wanders toward
const MOOD_EVERY = [40000, 150000]; // …which itself wanders this often
const PATIENCE = [20000, 120000]; // an unvisited lobby starts a game no sooner than this after it opened
const RESULTS_HOLD = [8000, 20000]; // a finished bot game shows its results this long
const WARM_PATIENCE = [4000, 20000]; // a lobby that is the next live game waits only this long
const JOIN_GAP = [3000, 12000]; // after a human sits down: the next player arrives this long after the last arrival
const START_AFTER = [6000, 16000]; // the host starts this long after the room becomes startable…
const START_MIN_AFTER_HUMAN = 5000; // …and never sooner than this after the latest human sat down
const AGAIN_AFTER = [10000, 25000]; // a finished game with a human: back to the lobby this long after the result
const MIN_TO_START = 3;
const SIZE = [3, 5]; // with a human: the room fills to its own size
const LOBBY_MAX = 6; // an unvisited lobby never holds more than this

const humansIn = (room) => room.players.filter((p) => !p.isBot).length;
const watchersIn = (room) => (room.spectators || []).length;
const botsIn = (room) => room.players.filter((p) => p.isBot && p.lobbyBot);
const between = ([lo, hi], rnd) => lo + Math.floor(rnd() * (hi - lo + 1));

function clearHouseTimer(room) {
  if (room && room.houseTimer) {
    clearTimeout(room.houseTimer);
    room.houseTimer = null;
  }
  if (room) room.houseNextAt = null;
}

/** A real (not house) public room in its lobby, with a human waiting and a seat free. */
function isRealWaiting(room, deps) {
  return !!(room.isPublic && !room.house && !deps.isGameLive(room) && humansIn(room) >= 1 && room.players.length < deps.maxPlayers);
}
const isRealLive = (room, deps) => !!(room.isPublic && !room.house && deps.isGameLive(room));

/** What the house wants right now: { live, open, active, busy }. Reads the registry + deps.state. */
function wanted(deps, now) {
  const st = deps.state;
  const rnd = deps.random || Math.random;
  if (!st.retargetAt || now >= st.retargetAt) {
    st.liveTarget = between(LIVE_TARGET, rnd);
    st.openTarget = between(OPEN_TARGET, rnd);
    st.retargetAt = now + S(between(RETARGET, rnd));
  }
  const all = [...deps.rooms()];
  const realRooms = all.filter((r) => !r.house && humansIn(r) >= 1).length;
  const active = !!st.lastListAt && now - st.lastListAt < LIST_IDLE_MS;
  const busy = realRooms >= HOUSE_BUSY_ROOMS;
  const realLive = all.filter((r) => isRealLive(r, deps)).length;
  const realWaiting = all.filter((r) => isRealWaiting(r, deps)).length;
  const live = active && !busy ? Math.min(HOUSE_LIVE_MAX, Math.max(0, st.liveTarget - realLive)) : 0;
  const open = active ? Math.max(0, st.openTarget - realWaiting) : (realWaiting ? 0 : 1);
  return { live, open, active, busy };
}

const liveHouse = (deps) => [...deps.rooms()].filter((r) => r.house && deps.isGameLive(r)).length;
const openHouse = (deps) => [...deps.rooms()].filter((r) => r.house && !r.game);

/** The next thing this room does, as { at, kind }: 'join' | 'leave' | 'drift' | 'start' | null. */
function nextStep(room, now, deps) {
  if (!room.house || room.game) return null; // live, or a finished game (the sweep handles it)
  const rnd = deps.random || Math.random;
  const humans = humansIn(room);
  const n = room.players.length;
  if (humans === 0) {
    room.houseStartAt = null;
    room.houseJoinAt = null;
    if (!room.houseDriftAt) room.houseDriftAt = now + S(between(DRIFT_GAP, rnd));
    return { at: room.houseDriftAt, kind: 'drift' };
  }
  // a human is here: players trickle in up to the room's size; the host starts once it is startable
  room.houseDriftAt = null;
  const steps = [];
  if (n < (room.houseSize || 3) && n < deps.maxPlayers - 1) {
    if (!room.houseJoinAt) room.houseJoinAt = (room.houseLastArrival || now) + S(between(JOIN_GAP, rnd));
    steps.push({ at: Math.max(now, room.houseJoinAt), kind: 'join' });
  } else {
    room.houseJoinAt = null;
  }
  // (nov12) no hidden start: a house room with a human starts by the same VISIBLE auto-start every public room has
  // (roomManager syncAutoStart - a deadline on room_update, +5 s per arrival), so it never looks different from a real one
  room.houseStartAt = null;
  if (!steps.length) return null;
  return steps.reduce((a, b) => (b.at < a.at ? b : a));
}

/** (Re)arm the room's one timer for its next step. */
function plan(room, deps) {
  clearHouseTimer(room);
  const now = deps.now ? deps.now() : Date.now();
  const step = nextStep(room, now, deps);
  if (!step) return;
  room.houseNextAt = step.at;
  room.houseTimer = setTimeout(() => {
    room.houseTimer = null;
    room.houseNextAt = null;
    try {
      if (deps.hasRoom(room)) act(room, step.kind, deps);
    } catch (err) {
      if (deps.onError) deps.onError(err);
    }
    if (deps.hasRoom(room)) plan(room, deps);
  }, Math.max(0, step.at - now));
  if (room.houseTimer.unref) room.houseTimer.unref();
}

function addBot(room, deps, now) {
  if (room.players.length >= deps.maxPlayers - 1) return false; // the last seat always stays free for a person
  const bot = deps.makeBot(room);
  if (!bot) return false;
  room.players.push(bot);
  room.houseLastArrival = now;
  return true;
}
function dropBot(room, rnd) {
  const leavers = botsIn(room).filter((p) => p.id !== room.hostId); // the host never wanders off
  if (!leavers.length) return false;
  const out = leavers[Math.floor(rnd() * leavers.length)];
  room.players = room.players.filter((p) => p !== out);
  return true;
}

/** An unvisited lobby's step: come / go toward its mood, or start a game when the house wants one. */
function drift(room, deps, now) {
  const rnd = deps.random || Math.random;
  room.houseDriftAt = null;
  // its own wandering mood
  if (!room.houseMoodAt || now >= room.houseMoodAt) {
    room.houseMood = between(MOOD, rnd);
    room.houseMoodAt = now + S(between(MOOD_EVERY, rnd));
  }
  // START? the house wants another game, this lobby has the players and has waited its own patience
  const want = wanted(deps, now);
  const patient = now - (room.houseOpenedAt || room.createdAt || now) >= (room.housePatience || S(PATIENCE[0]));
  if (room.players.length >= MIN_TO_START && patient && liveHouse(deps) < want.live) {
    deps.start(room);
    return;
  }
  // DRIFT toward the mood, one or two at a time; avoid landing on another open house lobby's count
  const n = room.players.length;
  const mood = Math.min(LOBBY_MAX, Math.max(1, room.houseMood || 2));
  const step = rnd() < 0.3 ? 2 : 1;
  let target = n === mood ? n + (rnd() < 0.5 ? -1 : 1) : n < mood ? n + step : n - step;
  target = Math.max(1, Math.min(LOBBY_MAX, deps.maxPlayers - 1, target));
  const others = new Set(openHouse(deps).filter((r) => r !== room).map((r) => r.players.length));
  if (others.has(target) && !others.has(target + 1) && target + 1 <= LOBBY_MAX) target += 1;
  else if (others.has(target) && !others.has(target - 1) && target - 1 >= 1) target -= 1;
  let changed = false;
  while (room.players.length < target && addBot(room, deps, now)) changed = true;
  while (room.players.length > target && dropBot(room, rnd)) changed = true;
  if (changed) deps.broadcast(room);
}

function act(room, kind, deps) {
  if (!room.house || room.game) return;
  const now = deps.now ? deps.now() : Date.now();
  if (kind === 'drift') { if (humansIn(room) === 0) drift(room, deps, now); return; }
  if (kind === 'start') {
    room.houseStartAt = null;
    // re-checked at the moment it fires: never with fewer than MIN_TO_START, never a human room without its human
    if (humansIn(room) >= 1 && room.players.length >= MIN_TO_START) deps.start(room);
    return;
  }
  if (kind === 'join') {
    room.houseJoinAt = null;
    if (addBot(room, deps, now)) deps.broadcast(room);
  }
}

/** The roster changed (a human joined / left, back to the lobby): note who arrived and re-plan. */
function onRosterChange(room, deps) {
  if (!room || !room.house) return;
  const now = deps.now ? deps.now() : Date.now();
  const humans = humansIn(room);
  if (humans > (room.houseHumans || 0)) {
    room.houseHumanAt = now; // a new human: the host gives them a moment before starting
    room.houseLastArrival = now;
    // …even if a start was already planned: someone who sits down inside the window is never started on instantly
    if (room.houseStartAt) room.houseStartAt = Math.max(room.houseStartAt, now + S(START_MIN_AFTER_HUMAN));
  }
  if (humans === 0) {
    room.houseStartAt = null;
    room.houseJoinAt = null;
  }
  room.houseHumans = humans;
  if (!room.game) room.houseOpenedAt = room.houseOpenedAt || now;
  plan(room, deps);
}

/** A list was asked for (someone is looking): the house stays (or wakes up) lively. */
function noteListed(deps, now = Date.now()) {
  const st = deps.state;
  const woke = !st.lastListAt || now - st.lastListAt >= LIST_IDLE_MS;
  st.lastListAt = now;
  if (woke) st.openAt = null; // open the first rooms promptly
  return woke;
}

function openRoom(deps, now, { warm = false } = {}) {
  const rnd = deps.random || Math.random;
  const house = [...deps.rooms()].filter((r) => r.house);
  const count = (m) => house.filter((r) => r.gameType === m).length;
  const least = Math.min(...MODES.map(count));
  const pool = MODES.filter((m) => count(m) === least);
  const mode = pool[Math.floor(rnd() * pool.length)];
  const room = deps.create(mode);
  if (!room) return null;
  room.houseSize = between(SIZE, rnd);
  room.houseOpenedAt = now;
  room.housePatience = S(warm ? between(WARM_PATIENCE, rnd) : between(PATIENCE, rnd));
  // it opens with its host and maybe a friend or two, then drifts on its own clock
  const extra = between([0, 2], rnd);
  for (let i = 0; i < extra; i += 1) addBot(room, deps, now);
  room.houseDriftAt = now + S(between([3000, 20000], rnd));
  plan(room, deps);
  return room;
}

/** Lobbies to keep open: the open target plus ONE that is about to become a missing live game (never one per missing
 * game: when several games end together that stacked up open rooms and the list read 2 live / 5 open). */
function lobbiesFor(want, live) {
  return want.open + Math.min(1, Math.max(0, want.live - live));
}

/** One sweep: keep the mix; send finished house games back to the lobby or close them. Returns a summary. */
function tick(deps) {
  const now = deps.now ? deps.now() : Date.now();
  const rnd = deps.random || Math.random;
  const want = wanted(deps, now);
  const st = deps.state;
  // FINISHED games: results, then back to the lobby (a human / a watcher there, or the house still wants the room) or close
  let reset = 0;
  let closed = 0;
  for (const r of [...deps.rooms()].filter((x) => x.house && x.game && !deps.isGameLive(x))) {
    if (!r.houseAgainAt) r.houseAgainAt = now + S(humansIn(r) ? between(AGAIN_AFTER, rnd) : between(RESULTS_HOLD, rnd));
    if (now < r.houseAgainAt) continue;
    r.houseAgainAt = null;
    const keep = humansIn(r) > 0 || watchersIn(r) > 0
      || (want.active && !want.busy && openHouse(deps).length < lobbiesFor(want, liveHouse(deps)) && rnd() < 0.5);
    // short of live games: this one is the next to start, so it does not sit out a full patience
    const short = liveHouse(deps) < want.live;
    if (keep) { r.houseOpenedAt = now; r.housePatience = S(short ? between(WARM_PATIENCE, rnd) : between(PATIENCE, rnd)); deps.reset(r); reset += 1; }
    else { deps.destroy(r); closed += 1; }
  }
  // OPEN LOBBIES: as many as the open target, plus the ones that will become the live games still missing
  const live = liveHouse(deps);
  const lobbiesWanted = lobbiesFor(want, live);
  let open = openHouse(deps);
  let dropped = 0;
  for (const r of open.sort((a, b) => (a.houseOpenedAt || 0) - (b.houseOpenedAt || 0))) {
    if (open.length - dropped <= lobbiesWanted) break;
    if (humansIn(r) === 0 && watchersIn(r) === 0) { deps.destroy(r); dropped += 1; }
  }
  open = openHouse(deps);
  const houseCount = [...deps.rooms()].filter((r) => r.house).length;
  let created = null;
  if (open.length < lobbiesWanted && houseCount < HOUSE_CAP) {
    if (!st.openAt) st.openAt = now + S(between(OPEN_WAIT, rnd)) * (live === 0 && want.live > 0 ? 0.3 : 1);
    if (now >= st.openAt) {
      st.openAt = null;
      created = openRoom(deps, now, { warm: live < want.live });
    }
  } else {
    st.openAt = null;
  }
  return { want, live, open: openHouse(deps).length, dropped, created: created ? created.code : null, reset, closed };
}

function startHouseRooms(deps) {
  const run = () => { try { tick(deps); } catch (err) { if (deps.onError) deps.onError(err); } };
  run();
  const handle = setInterval(run, Math.max(50, Math.round(TICK_MS * Math.min(1, SCALE * 10))));
  if (handle.unref) handle.unref();
  return handle;
}

module.exports = {
  tick, onRosterChange, clearHouseTimer, startHouseRooms, isRealWaiting, nextStep, noteListed, wanted,
  MODES, MIN_TO_START, SIZE, LOBBY_MAX, HOUSE_LIVE_MAX, JOIN_GAP, START_AFTER, START_MIN_AFTER_HUMAN, AGAIN_AFTER,
  LIST_IDLE_MS, lobbiesFor,
};
