// houseRooms.js — HOUSE ROOMS: the server's own public rooms, so the list reads like a living server (Andy nov9: "i
// oftentimes wait so long for someone to start room"; "don't make it seem like bots"; nov12: "more games playing
// (spectatable) then open lobbies just waiting - for open lobbies maybe make the (number)/8 changing as if it's real";
// nov21: "make bots (who create lobbies) even more believable and realistic").
//
// THE RULE
//   * THE MIX: while people are looking at the list, the house keeps a few LIVE games (3-5) and a few OPEN lobbies (1-2),
//     each target re-rolled every few minutes, so two refreshes never look the same. Real public rooms count against
//     the targets (a real waiting room is one fewer house lobby; a real live game, one fewer house game).
//   * A HOUSE LOBBY LIVES BY THE SAME CLOCK AS A REAL ONE (nov21). A real public lobby with 2+ players always shows
//     STARTS IN (roomManager syncAutoStart: 20 s, +5 s per arrival, cap 45 s) and starts when it runs out, so a house
//     lobby with 2+ players runs that very clock too (it is on room_update and the list) and starts when it fires. So:
//       - IDLE: a lobby the house does not need yet sits with its host alone (1/8), the way a fresh room does. Now and
//         then someone drops in and leaves again before the clock runs out. After its own lifetime (1.5-8 min) the host
//         gives up: the host leaves and the room closes.
//       - GATHERING: when the house wants another live game, players arrive ONE AT A TIME at irregular, human gaps toward
//         the room's own GAME SIZE (2-5 typical, 6-8 rarer); the clock fires and the game starts with whoever is there.
//         A player sometimes leaves before the start, like people do.
//       - A clock that fires when the house cannot start a game (busy, cap reached, nobody looking): the lobby breaks up
//         (players leave one at a time; sometimes the host leaves and the room dies).
//   * A HUMAN SITS DOWN in a house lobby: drift stops, players join one at a time (3-12 s apart) up to the room's size,
//     now and then one leaves, and the start is the ordinary visible auto-start every public room has (no hidden start).
//   * A FINISHED HOUSE GAME is listed as FINISHED while its results show (8-20 s), then the room either REMATCHES with
//     slightly different players (0-2 leave, sometimes the host - the room passes to another player - and new ones may
//     join) or DISBANDS. Every room has its own rematch limit (0-3) and age limit (12-35 min), so codes never live forever.
//   * MODES follow real traffic: Word Bomb more often than Category Blitz, never all one mode.
//   * NO TELLS: a persona is never seated in two rooms at once, nor reused in another room within the hour (roomManager);
//     every room picks its own size, lifetime, patience and pace; gaps are skewed and bursty, never uniform; bot churn is
//     not room activity.
//   * A COLD LIST (a server restart, or the first look after nobody listed for LIST_IDLE_MS): nobody saw those games
//     start, so for a short window the house opens its missing live games already under way - one per sweep.
//   * COST: bot games are list-only (Word Bomb's local dictionary; Blitz bots answer from the canon lists, never the AI
//     judge) and broadcast only to watchers. At most HOUSE_LIVE_MAX house games run at once; nothing new starts while
//     the server is busy with real rooms (HOUSE_BUSY_ROOMS) or when nobody has asked for the list for LIST_IDLE_MS -
//     running games finish and close, and one cheap lobby stays.
//
// HONEST ECONOMY: every seated bot is `isBot` + `lobbyBot` on the wire, exactly like lobby bots (no payout / gem / win
// rule treats it as a person). Timers are unref'd and cleared on start / destroy; every decision reads the live room.
'use strict';

const MODES = ['word-bomb', 'category-blitz'];
const MODE_WEIGHT = { 'word-bomb': 0.62, 'category-blitz': 0.38 }; // real traffic leans Word Bomb
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
const COLD_MS = 45000; // after a cold look: missing live games open already under way, this long

// pacing (ms, before SCALE)
const OPEN_WAIT = [2000, 15000]; // a sweep that may open a room waits this long first
const IDLE_LIFETIME = [90000, 480000]; // an idle lobby's host gives up after this long alone
const VISIT_GAP = [20000, 110000]; // an idle lobby: someone drops in about this often…
const VISIT_STAY = [0.2, 0.6]; // …and leaves after this share of the clock (before it fires)
const FIRST_ARRIVAL = [2500, 14000]; // a gathering lobby: its first arrival after the host
const LINGER_GAP = [5000, 20000]; // a gathering lobby at its size: someone may still leave
const PRESTART_LEAVE = 0.12; // a gathering step that is a leave instead (a new player comes later)
const BREAKUP_GAP = [1500, 7000]; // a lobby breaking up: one leaves this often
const PATIENCE = [8000, 60000]; // an idle lobby starts gathering no sooner than this after it opened
const RESULTS_HOLD = [8000, 20000]; // a finished bot game shows its results this long
const MAX_REMATCHES = [0, 3]; // each room's own rematch limit…
const MAX_AGE = [12 * 60000, 35 * 60000]; // …and age limit: a room disbands past either
const JOIN_GAP = [3000, 12000]; // after a human sits down: the next player arrives this long after the last arrival
const START_AFTER = [6000, 16000]; // (legacy export; the visible auto-start owns the start)
const START_MIN_AFTER_HUMAN = 5000; // a planned start never fires sooner than this after the latest human sat down
const AGAIN_AFTER = [10000, 25000]; // a finished game with a human: back to the lobby this long after the result
const MIN_TO_START = 2;
const SIZE = [3, 5]; // with a human: the room fills to its own size
const LOBBY_MAX = 8; // a gathering lobby may fill to 8 (a full lobby drops off the waiting list, then starts)
const HUMAN_LEAVE = 0.12; // with a human: a join step is a bot leaving instead, this often
// the game size a gathering lobby aims for: [players, weight] - 2-5 typical, 6-8 rarer
const GAME_SIZES = [[2, 20], [3, 27], [4, 23], [5, 15], [6, 8], [7, 5], [8, 2]];

const humansIn = (room) => room.players.filter((p) => !p.isBot).length;
const watchersIn = (room) => (room.spectators || []).length;
const botsIn = (room) => room.players.filter((p) => p.isBot && p.lobbyBot);
const between = ([lo, hi], rnd) => lo + Math.floor(rnd() * (hi - lo + 1));
/** A human-feeling gap: skewed toward the short end, with the odd long lull (never uniform, never round). */
function humanGap([lo, hi], rnd) {
  let ms = lo + (hi - lo) * Math.pow(rnd(), 1.7);
  if (rnd() < 0.1) ms *= 1.4 + rnd();
  return Math.round(ms + rnd() * 997);
}
function weighted(pairs, rnd) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) { r -= w; if (r < 0) return v; }
  return pairs[pairs.length - 1][0];
}
const gameSize = (rnd) => weighted(GAME_SIZES, rnd);

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
/** House lobbies already on their way to a game (gathering, or back from a rematch). */
const gatheringHouse = (deps, except = null) => openHouse(deps).filter((r) => r !== except && r.houseMode === 'gather').length;

/** The next thing this room does, as { at, kind }: 'join' | 'drift' | null. */
function nextStep(room, now, deps) {
  if (!room.house || room.game) return null; // live, or a finished game (the sweep handles it)
  const rnd = deps.random || Math.random;
  const humans = humansIn(room);
  const n = room.players.length;
  if (humans === 0) {
    room.houseStartAt = null;
    room.houseJoinAt = null;
    if (!room.houseDriftAt) room.houseDriftAt = now + driftGap(room, now, deps);
    return { at: room.houseDriftAt, kind: 'drift' };
  }
  // a human is here: players trickle in up to the room's size (now and then one leaves); the start is the same VISIBLE
  // auto-start every public room has (roomManager syncAutoStart - a deadline on room_update, +5 s per arrival)
  room.houseDriftAt = null;
  room.houseStartAt = null;
  if (n < (room.houseSize || 3) && n < deps.maxPlayers - 1) {
    if (!room.houseJoinAt) room.houseJoinAt = (room.houseLastArrival || now) + S(humanGap(JOIN_GAP, rnd));
    return { at: Math.max(now, room.houseJoinAt), kind: 'join' };
  }
  room.houseJoinAt = null;
  return null;
}

/** How long until an unvisited lobby's next step, from what it is doing. */
function driftGap(room, now, deps) {
  const rnd = deps.random || Math.random;
  const n = room.players.length;
  const mode = room.houseMode || 'idle';
  if (mode === 'die' || mode === 'drain') return S(humanGap(BREAKUP_GAP, rnd));
  if (mode === 'gather') {
    if (n <= 1) return S(humanGap(FIRST_ARRIVAL, rnd));
    const goal = room.houseGoal || 2;
    if (n >= goal) return S(humanGap(LINGER_GAP, rnd));
    // spread the remaining arrivals over what is left of the visible clock (which every arrival also stretches)
    const left = room.autoStartAt ? room.autoStartAt - now : 0;
    if (left > 0) return Math.max(S(1200), Math.round((left / (goal - n + 0.6)) * (0.45 + 0.6 * rnd())));
    return S(humanGap(FIRST_ARRIVAL, rnd));
  }
  // idle: a visitor who dropped in leaves before the clock runs out; else the next visitor
  if (n > 1 && room.houseVisitorOutAt) return Math.max(1, room.houseVisitorOutAt - now);
  return S(humanGap(VISIT_GAP, rnd));
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
  // the last seat stays free for a person - except the final arrival of a gathering lobby whose game is a full 8
  const lastSeat = humansIn(room) === 0 && room.houseMode === 'gather' && (room.houseGoal || 0) >= deps.maxPlayers;
  if (room.players.length >= deps.maxPlayers - (lastSeat ? 0 : 1)) return false;
  const bot = deps.makeBot(room);
  if (!bot) return false;
  room.players.push(bot);
  room.houseLastArrival = now;
  return true;
}
function dropBot(room, rnd, { host = false } = {}) {
  const leavers = botsIn(room).filter((p) => host || p.id !== room.hostId);
  if (!leavers.length) return false;
  const out = leavers[Math.floor(rnd() * leavers.length)];
  room.players = room.players.filter((p) => p !== out);
  // the host left a room of bots: it passes to someone still there (like a real room's host leaving)
  if (out.id === room.hostId && room.players.length) room.hostId = room.players[Math.floor(rnd() * room.players.length)].id;
  return true;
}

/** An unvisited lobby's step: by its mode (idle / gather / drain / die). */
function drift(room, deps, now) {
  const rnd = deps.random || Math.random;
  room.houseDriftAt = null;
  const n = room.players.length;
  let mode = room.houseMode || 'idle';
  // DIE: players leave one at a time; the host is last, and the room closes with them
  if (mode === 'die') {
    if (n <= 1) { deps.destroy(room); return; }
    if (dropBot(room, rnd)) deps.broadcast(room);
    return;
  }
  // DRAIN: a broken-up lobby empties back to its host, then idles
  if (mode === 'drain') {
    if (n > 1 && dropBot(room, rnd)) { deps.broadcast(room); return; }
    mode = room.houseMode = 'idle';
  }
  const want = wanted(deps, now);
  if (mode === 'idle') {
    // a visitor who dropped in leaves again (before the clock could start a game nobody asked for)
    if (n > 1) {
      room.houseVisitorOutAt = null;
      if (dropBot(room, rnd)) deps.broadcast(room);
      return;
    }
    const age = now - (room.houseOpenedAt || room.createdAt || now);
    // the house wants another game and this lobby has waited its own patience: it starts gathering
    if (want.active && !want.busy && age >= (room.housePatience || S(PATIENCE[0]))
      && liveHouse(deps) + gatheringHouse(deps, room) < want.live) {
      room.houseMode = 'gather';
      room.houseGoal = room.houseGoal || gameSize(rnd);
      room.houseDriftAt = now + driftGap(room, now, deps);
      return;
    }
    // alone too long: the host gives up (leaves; the room closes)
    if (age >= (room.houseLifetime || S(IDLE_LIFETIME[1]))) { deps.destroy(room); return; }
    // someone drops in (the clock starts, as in any room) and will leave before it runs out
    if (addBot(room, deps, now)) {
      deps.broadcast(room); // → syncAutoStart: the visible clock
      const left = room.autoStartAt ? room.autoStartAt - now : S(14000);
      room.houseVisitorOutAt = now + Math.max(1, Math.round(left * (VISIT_STAY[0] + (VISIT_STAY[1] - VISIT_STAY[0]) * rnd())));
    }
    return;
  }
  // GATHER: one arrival at a time toward the game size; now and then someone leaves instead (another comes later)
  const goal = Math.min(LOBBY_MAX, Math.max(MIN_TO_START, room.houseGoal || 2));
  if (n >= 3 && rnd() < PRESTART_LEAVE) { if (dropBot(room, rnd)) deps.broadcast(room); return; }
  if (n < goal && addBot(room, deps, now)) deps.broadcast(room);
}

function act(room, kind, deps) {
  if (!room.house || room.game) return;
  const now = deps.now ? deps.now() : Date.now();
  const rnd = deps.random || Math.random;
  if (kind === 'drift') { if (humansIn(room) === 0) drift(room, deps, now); return; }
  if (kind === 'join') {
    room.houseJoinAt = null;
    // people come and go: sometimes the step is a player leaving before the start (another may come later)
    if (room.players.length >= 3 && rnd() < HUMAN_LEAVE) { if (dropBot(room, rnd)) deps.broadcast(room); return; }
    if (addBot(room, deps, now)) deps.broadcast(room);
  }
}

/**
 * A house room's visible auto-start clock ran out with no human in the room (roomManager syncAutoStart). True: start the
 * game, exactly as a real room would. False: the house cannot run another game right now - the lobby breaks up instead.
 */
function autoStartDue(room, deps) {
  if (!room || !room.house || room.game) return false;
  const now = deps.now ? deps.now() : Date.now();
  const rnd = deps.random || Math.random;
  const want = wanted(deps, now);
  const live = liveHouse(deps);
  const ok = want.active && !want.busy && live < HOUSE_LIVE_MAX && (live < want.live || room.houseMode === 'gather');
  if (ok) return true;
  room.houseMode = rnd() < 0.35 ? 'die' : 'drain';
  room.houseDriftAt = null;
  plan(room, deps);
  return false;
}

/** The roster changed (a human joined / left, back to the lobby): note who arrived and re-plan. */
function onRosterChange(room, deps) {
  if (!room || !room.house) return;
  const now = deps.now ? deps.now() : Date.now();
  const humans = humansIn(room);
  if (humans > (room.houseHumans || 0)) {
    room.houseHumanAt = now; // a new human: the host gives them a moment before starting
    room.houseLastArrival = now;
    if (room.houseStartAt) room.houseStartAt = Math.max(room.houseStartAt, now + S(START_MIN_AFTER_HUMAN));
  }
  if (humans === 0) {
    room.houseStartAt = null;
    room.houseJoinAt = null;
    // the last human left (or a game ended): the bots still there carry on toward a game, or the host waits alone
    if (!room.game && (room.houseHumans || 0) > 0) {
      room.houseMode = room.players.length >= 2 ? 'gather' : 'idle';
      room.houseGoal = Math.max(room.players.length, room.houseGoal || 2);
      room.houseDriftAt = null;
    }
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
  if (woke) {
    st.openAt = null; // open the first rooms promptly
    st.coldUntil = now + S(COLD_MS); // …and the missing games already under way (nobody saw them start)
  }
  return woke;
}

/** The next room's mode: real traffic leans Word Bomb, but never three of one mode ahead of the other. */
function pickMode(deps, rnd) {
  const house = [...deps.rooms()].filter((r) => r.house);
  const count = (m) => house.filter((r) => r.gameType === m).length;
  const [a, b] = MODES;
  if (count(a) - count(b) >= 2) return b;
  if (count(b) - count(a) >= 2) return a;
  return weighted(MODES.map((m) => [m, MODE_WEIGHT[m]]), rnd);
}

function openRoom(deps, now, { warm = false, instant = false } = {}) {
  const rnd = deps.random || Math.random;
  const room = deps.create(pickMode(deps, rnd));
  if (!room) return null;
  room.houseSize = between(SIZE, rnd);
  room.houseGoal = gameSize(rnd);
  room.houseOpenedAt = now;
  room.houseBornAt = now;
  room.houseRematches = 0;
  room.houseMaxRematches = between(MAX_REMATCHES, rnd);
  room.houseMaxAge = S(between(MAX_AGE, rnd));
  room.houseLifetime = S(between(IDLE_LIFETIME, rnd));
  room.housePatience = S(between(PATIENCE, rnd));
  if (instant) {
    // a cold list: this game was "already going" before anyone looked
    room.houseMode = 'gather';
    while (room.players.length < room.houseGoal && addBot(room, deps, now));
    if (room.players.length >= MIN_TO_START) { deps.start(room); return room; }
  }
  // a lobby the house needs now gathers straight away (sometimes with a friend already in); else its host waits alone
  room.houseMode = warm ? 'gather' : 'idle';
  if (warm && rnd() < 0.35) { addBot(room, deps, now); deps.broadcast(room); }
  room.houseDriftAt = now + driftGap(room, now, deps);
  plan(room, deps);
  return room;
}

/** Lobbies to keep open: the open target plus ONE that is about to become a missing live game (never one per missing
 * game: when several games end together that stacked up open rooms and the list read 2 live / 5 open). */
function lobbiesFor(want, live) {
  return want.open + Math.min(1, Math.max(0, want.live - live));
}

/** A finished unvisited game going again: 0-2 players leave (sometimes the host), the rest stay for the rematch. */
function shuffleForRematch(room, rnd) {
  const leaves = Math.min(between([0, 2], rnd), Math.max(0, room.players.length - 2));
  for (let i = 0; i < leaves; i += 1) dropBot(room, rnd, { host: rnd() < 0.2 });
}

/** One sweep: keep the mix; send finished house games back to the lobby or close them. Returns a summary. */
function tick(deps) {
  const now = deps.now ? deps.now() : Date.now();
  const rnd = deps.random || Math.random;
  const want = wanted(deps, now);
  const st = deps.state;
  // FINISHED games: results (listed FINISHED), then a rematch or the room disbands
  let reset = 0;
  let closed = 0;
  for (const r of [...deps.rooms()].filter((x) => x.house && x.game && !deps.isGameLive(x))) {
    if (!r.houseAgainAt) r.houseAgainAt = now + S(humansIn(r) ? between(AGAIN_AFTER, rnd) : between(RESULTS_HOLD, rnd));
    if (now < r.houseAgainAt) continue;
    r.houseAgainAt = null;
    const people = humansIn(r) > 0 || watchersIn(r) > 0;
    const young = (r.houseRematches || 0) < (r.houseMaxRematches ?? MAX_REMATCHES[1])
      && now - (r.houseBornAt || r.createdAt || now) < (r.houseMaxAge || S(MAX_AGE[1]));
    const needed = want.active && !want.busy && liveHouse(deps) + gatheringHouse(deps) < want.live;
    const keep = people || (young && needed && rnd() < 0.7);
    if (!keep) { deps.destroy(r); closed += 1; continue; }
    r.houseRematches = (r.houseRematches || 0) + 1;
    r.houseOpenedAt = now;
    r.housePatience = S(between(PATIENCE, rnd));
    r.houseDriftAt = null;
    if (!people) {
      shuffleForRematch(r, rnd);
      r.houseMode = r.players.length >= 2 ? 'gather' : 'idle';
      r.houseGoal = Math.max(r.players.length, gameSize(rnd));
    }
    deps.reset(r);
    reset += 1;
  }
  // OPEN LOBBIES: as many as the open target, plus the one that will become the next live game still missing
  const live = liveHouse(deps);
  const lobbiesWanted = lobbiesFor(want, live);
  let open = openHouse(deps);
  let dropped = 0;
  for (const r of open.sort((a, b) => (a.houseOpenedAt || 0) - (b.houseOpenedAt || 0))) {
    if (open.length - dropped <= lobbiesWanted) break;
    if (r.houseMode === 'die') { dropped += 1; continue; } // already breaking up
    if (humansIn(r) || watchersIn(r)) continue;
    // a surplus lobby: a lone host just leaves (the room closes); a lobby with players in it breaks up one at a time
    if (r.players.length <= 1) deps.destroy(r);
    else { r.houseMode = 'die'; r.houseDriftAt = null; plan(r, deps); }
    dropped += 1;
  }
  open = openHouse(deps).filter((r) => r.houseMode !== 'die');
  const houseCount = [...deps.rooms()].filter((r) => r.house).length;
  let created = null;
  const cold = want.active && st.coldUntil && now < st.coldUntil;
  if (cold && live < want.live && houseCount < HOUSE_CAP) {
    // a cold list: one missing game per sweep, already under way
    created = openRoom(deps, now, { instant: true });
  } else if (open.length < lobbiesWanted && houseCount < HOUSE_CAP) {
    if (!st.openAt) st.openAt = now + S(between(OPEN_WAIT, rnd)) * (live === 0 && want.live > 0 ? 0.3 : 1);
    if (now >= st.openAt) {
      st.openAt = null;
      created = openRoom(deps, now, { warm: live + gatheringHouse(deps) < want.live });
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
  tick, onRosterChange, clearHouseTimer, startHouseRooms, isRealWaiting, nextStep, noteListed, wanted, autoStartDue,
  MODES, MIN_TO_START, SIZE, LOBBY_MAX, HOUSE_LIVE_MAX, JOIN_GAP, START_AFTER, START_MIN_AFTER_HUMAN, AGAIN_AFTER,
  LIST_IDLE_MS, GAME_SIZES, lobbiesFor, gameSize, humanGap, pickMode,
};
