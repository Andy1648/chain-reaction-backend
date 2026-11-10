// houseRooms.js — HOUSE ROOMS (Andy nov9: "i oftentimes wait so long for someone to start room"; then: "make sure the logic
// is on point - don't make it seem like bots"). While the public list is thin the server keeps up to HOUSE_MAX public
// Word Bomb / Category Blitz rooms of its own. Each must read as a room some person opened:
//
// THE RULE
//   * OPENING: a house room opens with ONE player in it - its host, a lobby-bot persona (lobbyBots.js: the leaderboard's
//     seeded names + heroes). Rooms open at different moments (one per sweep, after a random wait), so a restart never
//     pops two identical rooms in the same second.
//   * WAITING WITH NOBODY: it stays small - the host plus at most one more, and now and then someone drifts in or out
//     (minutes apart). It never sits full of bots waiting for you.
//   * A HUMAN SITS DOWN: more players drift in, one at a time, 3-12 s apart (never two in the same second), up to the
//     room's own size (3-5 seats in all, picked per room).
//   * THE HOST STARTS IT - no countdown on screen, just like a person pressing START: once there is a human and at
//     least 3 players, the host starts 6-16 s later (random), and never sooner than 5 s after the latest human sat down.
//     A human who joins inside that window plays in that game.
//   * NEVER WITHOUT A HUMAN: the start re-checks at the moment it fires; if the last human left, nothing starts and the
//     room goes back to waiting (it is not torn down - a real host would still be sitting there).
//   * AFTER A GAME: the host goes back to the lobby 10-25 s after the result (a person reading the scores first), and
//     the same rule runs again for whoever stayed.
//   * NO TELLS: a persona is never in two rooms at once (host or seat, house or not); names / heroes / levels come from
//     the persona pool; each room picks its own size and pace; bot-only churn never counts as room activity, so an
//     unvisited house room is eventually reaped and a fresh one (new code, new host) replaces it.
//   * THE LIST: idle house rooms (no human in them) are dropped, oldest first, as real public rooms waiting with a human
//     appear - down to zero once HOUSE_MAX of them are waiting. A house room with a human in it is never dropped.
//   * A SERVER RESTART loses every room (in memory), house rooms included; the sweep reopens them one at a time.
//
// HONEST ECONOMY: every seated bot is `isBot` + `lobbyBot` on the wire, exactly like lobby bots (no payout / gem / win
// rule treats it as a person). Timers are unref'd and cleared on start / destroy; every decision reads the live room.
'use strict';

const HOUSE_MAX = 2;
const MODES = ['word-bomb', 'category-blitz'];
const SCALE = Number(process.env.HOUSE_TIME_SCALE) || 1; // tests / local runs compress every delay
const TICK_MS = Number(process.env.HOUSE_TICK_MS) || 5000;
const S = (ms) => Math.max(1, Math.round(ms * SCALE));

// pacing (ms, before SCALE)
const OPEN_WAIT = [2000, 20000]; // a sweep that may open a room waits this long first
const IDLE_CHURN = [60000, 180000]; // an unvisited room: someone drifts in / out this often
const JOIN_GAP = [3000, 12000]; // after a human sits down: the next player arrives this long after the last arrival
const START_AFTER = [6000, 16000]; // the host starts this long after the room becomes startable…
const START_MIN_AFTER_HUMAN = 5000; // …and never sooner than this after the latest human sat down
const AGAIN_AFTER = [10000, 25000]; // a finished game: back to the lobby this long after the result
const MIN_TO_START = 3; // a human + the host + at least one more
const SIZE = [3, 5]; // each room's own size (all players, humans included)
const IDLE_MAX = 2; // players an unvisited room holds at most (the host + one)

const humansIn = (room) => room.players.filter((p) => !p.isBot).length;
const botsIn = (room) => room.players.filter((p) => p.isBot && p.lobbyBot);
const between = ([lo, hi], rnd) => lo + Math.floor(rnd() * (hi - lo + 1));

function clearHouseTimer(room) {
  if (room && room.houseTimer) {
    clearTimeout(room.houseTimer);
    room.houseTimer = null;
  }
  if (room) room.houseNextAt = null;
}

/** A real (not house) public room in its lobby, with a human waiting and a seat free: what makes the list not thin. */
function isRealWaiting(room, deps) {
  return !!(room.isPublic && !room.house && !deps.isGameLive(room) && humansIn(room) >= 1 && room.players.length < deps.maxPlayers);
}

/** The next thing this room does, as { at, kind }: 'join' | 'leave' | 'start' | null. Pure on (room, now). */
function nextStep(room, now, deps) {
  if (!room.house || room.game) return null; // live, or a finished game (the sweep takes it back to the lobby)
  const rnd = deps.random || Math.random;
  const humans = humansIn(room);
  const n = room.players.length;
  if (humans === 0) {
    room.houseStartAt = null;
    // unvisited: stay small, drift slowly
    if (!room.houseChurnAt) room.houseChurnAt = now + S(between(IDLE_CHURN, rnd));
    const bots = botsIn(room);
    const kind = bots.length > IDLE_MAX ? 'leave' : bots.length < IDLE_MAX && rnd() < 0.6 ? 'join' : bots.length > 1 ? 'leave' : 'join';
    return { at: bots.length > IDLE_MAX ? now : room.houseChurnAt, kind };
  }
  // a human is here: players trickle in up to the room's size; the host starts once it is startable
  room.houseChurnAt = null;
  const steps = [];
  if (n < (room.houseSize || 3) && n < deps.maxPlayers - 1) {
    if (!room.houseJoinAt) room.houseJoinAt = (room.houseLastArrival || now) + S(between(JOIN_GAP, rnd));
    steps.push({ at: Math.max(now, room.houseJoinAt), kind: 'join' });
  } else {
    room.houseJoinAt = null;
  }
  if (n >= MIN_TO_START) {
    if (!room.houseStartAt) {
      room.houseStartAt = Math.max(now + S(between(START_AFTER, rnd)), (room.houseHumanAt || now) + S(START_MIN_AFTER_HUMAN));
    }
    steps.push({ at: room.houseStartAt, kind: 'start' });
  } else {
    room.houseStartAt = null;
  }
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

function act(room, kind, deps) {
  if (!room.house || room.game) return;
  const now = deps.now ? deps.now() : Date.now();
  const rnd = deps.random || Math.random;
  if (kind === 'start') {
    room.houseStartAt = null;
    // re-checked at the moment it fires: never a game without a human, never with fewer than MIN_TO_START
    if (humansIn(room) >= 1 && room.players.length >= MIN_TO_START) deps.start(room);
    return;
  }
  if (kind === 'join') {
    room.houseJoinAt = null;
    room.houseChurnAt = null;
    if (room.players.length >= deps.maxPlayers - 1) return; // the last seat always stays free for a person
    const bot = deps.makeBot(room);
    if (!bot) return;
    room.players.push(bot);
    room.houseLastArrival = now;
    deps.broadcast(room);
    return;
  }
  if (kind === 'leave') {
    room.houseChurnAt = null;
    const leavers = botsIn(room).filter((p) => p.id !== room.hostId); // the host never wanders off
    if (!leavers.length) return;
    const out = leavers[Math.floor(rnd() * leavers.length)];
    room.players = room.players.filter((p) => p !== out);
    deps.broadcast(room);
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
  plan(room, deps);
}

/** One sweep: keep the right number of house rooms; take finished house games back to the lobby. Returns a summary. */
function tick(deps) {
  const now = deps.now ? deps.now() : Date.now();
  const rnd = deps.random || Math.random;
  const all = [...deps.rooms()];
  const house = all.filter((r) => r.house).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const want = Math.max(0, HOUSE_MAX - all.filter((r) => isRealWaiting(r, deps)).length);
  let dropped = 0;
  for (const r of house) {
    if (house.length - dropped <= want) break;
    if (humansIn(r) === 0 && !deps.isGameLive(r)) {
      deps.destroy(r);
      dropped += 1;
    }
  }
  const alive = house.filter((r) => deps.hasRoom(r));
  let created = null;
  if (alive.length < want) {
    // one room per sweep, after its own random wait (deps.openAt keeps the pending open across sweeps)
    if (!deps.state.openAt) deps.state.openAt = now + S(between(OPEN_WAIT, rnd));
    if (now >= deps.state.openAt) {
      deps.state.openAt = null;
      const used = new Set(alive.map((r) => r.gameType));
      const mode = MODES.find((m) => !used.has(m)) || MODES[Math.floor(rnd() * MODES.length)];
      created = deps.create(mode);
      if (created) {
        created.houseSize = between(SIZE, rnd);
        plan(created, deps);
      }
    }
  } else {
    deps.state.openAt = null;
  }
  let reset = 0;
  for (const r of alive) {
    if (!r.game || deps.isGameLive(r)) { r.houseAgainAt = null; continue; }
    // a FINISHED house game: the host reads the result, then goes back to the lobby
    if (!r.houseAgainAt) r.houseAgainAt = now + (humansIn(r) ? S(between(AGAIN_AFTER, rnd)) : 0);
    if (now >= r.houseAgainAt) {
      r.houseAgainAt = null;
      deps.reset(r);
      reset += 1;
    }
  }
  return { want, dropped, created: created ? created.code : null, reset };
}

function startHouseRooms(deps) {
  const run = () => { try { tick(deps); } catch (err) { if (deps.onError) deps.onError(err); } };
  run();
  const handle = setInterval(run, Math.max(50, Math.round(TICK_MS * Math.min(1, SCALE * 10))));
  if (handle.unref) handle.unref();
  return handle;
}

module.exports = {
  tick, onRosterChange, clearHouseTimer, startHouseRooms, isRealWaiting, nextStep,
  HOUSE_MAX, MODES, MIN_TO_START, SIZE, IDLE_MAX, JOIN_GAP, START_AFTER, START_MIN_AFTER_HUMAN, AGAIN_AFTER,
};
