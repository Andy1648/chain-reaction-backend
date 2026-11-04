// lobbyBots.js — LOBBY BOTS (Andy nov4: "i want bots in lobbies too (to imitate real players)"). While a PUBLIC Word Bomb /
// Category Blitz room waits with at least one human in it, bots drift in over time and now and then one drifts out, so a
// lone host never sits in an empty room. Each is one of the leaderboard's SEEDED personas (lobbyBotPersonas.json: the
// 077 / 081 seed rows' name + hero + rebirths), plays at a skill that fits its rebirths, and never starts a game.
//
// Rules (each enforced here, pinned by lobbyBots.test.js):
//   * OPT-IN per room: only a room created by a client that sent create_room { lobbyBots: true } gets them (a client
//     that can't render them as players never sees them).
//   * NEVER BLOCK A HUMAN: a full room frees a seat by dropping a lobby bot (freeSeatForHuman), and the bots never fill the
//     last seat. As humans arrive the bots thin out toward the room's target.
//   * HONEST ECONOMY: a lobby bot is still `isBot` on the wire (+ `lobbyBot`): the client draws it as a player but every
//     payout / gem / match-win rule that treats bot rivals differently still applies. Bots never touch the leaderboard.
//   * Timers are cleared on start / destroy; a reset (back to lobby) schedules again. All decisions read the live room.
'use strict';

const wordBombBot = require('./wordBombBot');
const categoryBlitzBot = require('./categoryBlitzBot');
const PERSONAS = require('./lobbyBotPersonas.json'); // [[name, hero, frame, rebirths], ...]

const FACTORY = { 'word-bomb': wordBombBot, 'category-blitz': categoryBlitzBot };

// Pacing (ms). LOBBY_BOT_MS (tests / local runs) sets every delay to one fixed value.
const FIXED = Number(process.env.LOBBY_BOT_MS) || 0;
const FIRST_MS = [6000, 14000]; // the first bot after a human sits down
const EVERY_MS = [10000, 30000]; // then one change at a time
const LEAVE_CHANCE = 0.12; // a settled lobby still sees a bot wander off now and then (it is replaced later)
const SEATS_MIN = 3; // a room aims for 3–5 seats in all (humans + bots)
const SEATS_MAX = 5;

const randInt = (lo, hi, rnd) => lo + Math.floor(rnd() * (hi - lo + 1));
const humansIn = (room) => room.players.filter((p) => !p.isBot).length;
const lobbyBotsIn = (room) => room.players.filter((p) => p.isBot && p.lobbyBot);

/** Bot skill from the persona's rebirths: a veteran plays hard more often, a newcomer easy. */
function difficultyFor(rebirths, rnd = Math.random) {
  const r = rnd();
  if (rebirths >= 25) return r < 0.5 ? 'hard' : 'medium';
  if (rebirths >= 8) return r < 0.15 ? 'hard' : r < 0.85 ? 'medium' : 'easy';
  return r < 0.45 ? 'easy' : 'medium';
}

/** A persona nobody in the room already wears (case-insensitive), or null. */
function pickPersona(room, rnd = Math.random) {
  const taken = new Set(room.players.map((p) => String(p.name || '').toLowerCase()));
  for (let i = 0; i < 40; i += 1) {
    const p = PERSONAS[Math.floor(rnd() * PERSONAS.length)];
    if (p && !taken.has(String(p[0]).toLowerCase())) return p;
  }
  return null;
}

/** A lobby bot for this room's mode, wearing a seeded persona. Null when the mode has no bot brain or no name is free. */
function makeLobbyBot(room, rnd = Math.random) {
  const factory = FACTORY[room.gameType];
  const persona = factory && pickPersona(room, rnd);
  if (!persona) return null;
  const [name, hero, , rebirths] = persona;
  const bot = factory.createBotPlayer(difficultyFor(rebirths, rnd));
  bot.name = name;
  bot.lobbyBot = true;
  if (hero) bot.hero = hero;
  return bot;
}

function isEligible(room, deps) {
  return !!(room && room.lobbyBots && room.isPublic && !deps.isGameLive(room) && FACTORY[room.gameType] && humansIn(room) >= 1);
}

/** How many lobby bots this room should hold right now. */
function desiredBots(room, deps) {
  if (!room.lobbyBotSeats) room.lobbyBotSeats = randInt(SEATS_MIN, SEATS_MAX, deps.random || Math.random);
  const humans = humansIn(room);
  const nonLobbyBots = room.players.filter((p) => p.isBot && !p.lobbyBot).length;
  const cap = deps.maxPlayers - 1 - humans - nonLobbyBots; // the last seat always stays free for a human
  return Math.max(0, Math.min(room.lobbyBotSeats - humans - nonLobbyBots, cap));
}

function clearLobbyBotTimer(room) {
  if (room && room.lobbyBotTimer) {
    clearTimeout(room.lobbyBotTimer);
    room.lobbyBotTimer = null;
  }
}

/** One step: add, drop or (rarely) swap a single bot, then broadcast the roster. Returns what happened. */
function tick(room, deps) {
  if (!isEligible(room, deps)) return 'idle';
  const rnd = deps.random || Math.random;
  const bots = lobbyBotsIn(room);
  const want = desiredBots(room, deps);
  let did = 'none';
  if (bots.length < want) {
    const bot = makeLobbyBot(room, rnd);
    if (bot) {
      room.players.push(bot);
      did = 'join';
    }
  } else if (bots.length > want || (bots.length > 0 && rnd() < LEAVE_CHANCE)) {
    const out = bots[Math.floor(rnd() * bots.length)];
    room.players = room.players.filter((p) => p !== out);
    did = 'leave';
  }
  if (did !== 'none') deps.broadcast(room);
  return did;
}

/** (Re)arm the room's one lobby-bot timer if it should have bots; clear it if not. Idempotent. */
function scheduleLobbyBots(room, deps) {
  if (!isEligible(room, deps)) {
    clearLobbyBotTimer(room);
    return;
  }
  if (room.lobbyBotTimer) return;
  const rnd = deps.random || Math.random;
  const [lo, hi] = room.lobbyBotStarted ? EVERY_MS : FIRST_MS;
  room.lobbyBotStarted = true;
  room.lobbyBotTimer = setTimeout(() => {
    room.lobbyBotTimer = null;
    try {
      tick(room, deps);
    } catch (err) {
      if (deps.onError) deps.onError(err);
    }
    scheduleLobbyBots(room, deps);
  }, FIXED || randInt(lo, hi, rnd));
  // never what keeps the process alive (the server's own socket does that; a test run must be able to exit)
  if (room.lobbyBotTimer && room.lobbyBotTimer.unref) room.lobbyBotTimer.unref();
}

/** A human wants into a FULL lobby: drop one lobby bot so they get the seat. True when a seat was freed. */
function freeSeatForHuman(room) {
  const bots = lobbyBotsIn(room);
  if (!bots.length) return false;
  room.players = room.players.filter((p) => p !== bots[bots.length - 1]);
  return true;
}

/** The host switched modes: lobby bots take the new mode's brain (same persona), or leave if it has none. */
function onGameTypeChange(room) {
  const factory = FACTORY[room.gameType];
  room.players = room.players.flatMap((p) => {
    if (!p.isBot || !p.lobbyBot) return [p];
    if (!factory) return [];
    if (p.botGameType === room.gameType) return [p];
    const fresh = factory.createBotPlayer(p.botDifficulty);
    return [{ ...fresh, name: p.name, hero: p.hero, lobbyBot: true }];
  });
}

module.exports = {
  scheduleLobbyBots,
  clearLobbyBotTimer,
  freeSeatForHuman,
  onGameTypeChange,
  // exposed for tests
  tick,
  desiredBots,
  makeLobbyBot,
  difficultyFor,
  PERSONAS,
};
