// wordRaceMode.js
// WORD RACE orchestrator - the T5 plugin wrapper around the pure wordRace.js state
// machine. Owns the clocks (countdown -> go, the 90s cap, bot thinking time) and
// the async dictionary check. Registered in t5Modes.js, so room lifecycle (create /
// join / start_game / submit_word / leave / rematch) runs through roomManager's
// generic T5 hooks and never touches the Word Bomb or Blitz handlers.
//
// TIMER SLOTS: only the room's standard slots, so every existing teardown path
// (resetGame / destroyRoom / failRoom / _resetRoomsForTesting) clears them:
//   countdownTimeout  - the 3-2-1 before go (via helpers.scheduleTimerAfterCountdown)
//   roundTimerInterval - the race cap (a one-shot timeout; clearInterval clears it)
//   blitzBotTimeouts  - each bot's next-word timeout (cleared by clearRoundTimer)
//
// WIRE (all additive message types):
//   race_start       -> room  { seed, fragments, tiers, target, capMs, racers, serverNow, goAt }
//   race_go          -> room  { goAt, endsAt, serverNow }
//   race_progress    -> room  { racerId, index, word, fragment, t, serverNow }
//   race_word_result -> submitter only { accepted, word, reason, fragment, index }
//   race_racer_left  -> room  { racerId }
//   race_over        -> room  { winnerId, reason, standings, target, capMs, fragments, serverNow }

const race = require('./wordRace');
const wordBombBot = require('./wordBombBot');
const { logError } = require('./logger');

// Same injection hook as gameLogic.js / t5FuseMode.js so tests run with the mock
// dictionary and zero network.
let { isValidWord, markAsValid } = require('./dictionary');
function _setDictionaryForTesting(mockModule) {
  isValidWord = mockModule.isValidWord;
  if (mockModule.markAsValid) markAsValid = mockModule.markAsValid;
}

const GAME_TYPE = 'word-race';
// Mirrors roomManager's COUNTDOWN_DELAY_MS (the frontend's 3-2-1-GO); only used
// to PREDICT goAt in race_start - race_go carries the authoritative value.
const COUNTDOWN_MS = 3000;

let raceBotCounter = 0;
function createRaceBot(takenNames) {
  raceBotCounter += 1;
  const id = `racebot-${raceBotCounter}-${Math.random().toString(36).slice(2, 8)}`;
  const free = wordBombBot.BOT_NAMES.filter((n) => !takenNames.has(n));
  const name = free.length
    ? free[Math.floor(Math.random() * free.length)]
    : `${wordBombBot.randomBotName()} ${raceBotCounter}`;
  takenNames.add(name);
  return {
    id,
    name,
    isBot: true,
    botGameType: GAME_TYPE,
    botDifficulty: 'medium',
    // Same mock-connection shape as wordBombBot: OPEN + no-op send, so every
    // broadcast path treats it like a connected player.
    connection: { id, readyState: 1, send() {} },
  };
}

function sendTo(room, playerId, type, payload) {
  const p = room.players.find((pl) => pl.id === playerId);
  try {
    if (p && p.connection && p.connection.readyState === 1) {
      p.connection.send(JSON.stringify({ type, payload }));
    }
  } catch {
    /* socket teardown race - the client simply misses this private result */
  }
}

function overPayload(room) {
  const g = room.game;
  return {
    winnerId: g.winnerId,
    reason: g.endReason,
    standings: race.standings(g),
    target: g.target,
    capMs: g.capMs,
    fragments: g.fragments,
    serverNow: Date.now(),
  };
}

function endRace(room, reason, helpers) {
  const g = room.game;
  if (!g || g.gameType !== GAME_TYPE) return;
  // applyAccept already finished the race on a crossing; the cap/forfeit paths
  // finish it here. Either way: stop every clock, then announce once.
  if (g.status !== 'finished') race.finish(g, reason, Date.now());
  if (g._overSent) return;
  g._overSent = true;
  helpers.clearRoundTimer(room); // cap + bot timeouts (+ any pending countdown)
  helpers.broadcastToRoom(room, { type: 'race_over', payload: overPayload(room) });
}

/* ------------------------------ plugin ------------------------------ */

const logic = {
  // Pure create; bots are seated in start() because they must also join the room
  // roster (they need a mock connection there for broadcasts).
  createGame(players) {
    return race.createRace(players.map((p) => ({ id: p.id, name: p.name })));
  },
};

function start(room, helpers) {
  const g = room.game;
  // Mark roster bots (a rematch keeps the bots from the previous race).
  for (const r of g.racers) {
    const rp = room.players.find((p) => p.id === r.id);
    r.isBot = !!(rp && rp.isBot);
  }
  const humans = g.racers.filter((r) => !r.isBot).length;
  const bots = g.racers.filter((r) => r.isBot).length;
  const need = Math.max(0, race.botsNeeded(humans) - bots);
  const taken = new Set(room.players.map((p) => p.name));
  for (let i = 0; i < need && g.racers.length < race.MAX_RACERS; i++) {
    const bot = createRaceBot(taken);
    room.players.push(bot);
    race.addRacer(g, { id: bot.id, name: bot.name, isBot: true });
  }
  // Bot speed: seeded from the humans' reported recent pace (race_pace).
  const paces = g.racers
    .filter((r) => !r.isBot)
    .map((r) => room.racePace && room.racePace[r.id]);
  g.botPaceMs = race.seedPace(paces);

  const now = Date.now();
  helpers.broadcastToRoom(room, {
    type: 'race_start',
    payload: {
      seed: g.seed,
      fragments: g.fragments,
      tiers: g.tiers,
      target: g.target,
      capMs: g.capMs,
      racers: g.racers.map((r) => ({ id: r.id, name: r.name, isBot: r.isBot })),
      serverNow: now,
      goAt: now + COUNTDOWN_MS,
    },
  });

  helpers.scheduleTimerAfterCountdown(room, () => goRace(room, helpers));
}

function goRace(room, helpers) {
  const g = room.game;
  if (!g || g.gameType !== GAME_TYPE) return;
  const now = Date.now();
  if (!race.goLive(g, now)) return;
  helpers.touchRoom(room);
  helpers.broadcastToRoom(room, {
    type: 'race_go',
    payload: { goAt: now, endsAt: now + g.capMs, serverNow: now },
  });
  // The cap: a one-shot in the round-timer slot (clearRoundTimer's clearInterval
  // cancels a Timeout too), so reset/destroy tear it down.
  room.roundTimerInterval = setTimeout(() => {
    try {
      room.roundTimerInterval = null;
      endRace(room, 'cap', helpers);
    } catch (err) {
      logError('race_cap_failed', { roomCode: room.code }, err);
    }
  }, g.capMs);
  g.racers.filter((r) => r.isBot).forEach((r, k) => scheduleBot(room, r.id, k, helpers));
}

function scheduleBot(room, botId, botIndex, helpers) {
  const g = room.game;
  if (!g || g.status !== 'in_progress') return;
  const racer = race.getRacer(g, botId);
  if (!racer || racer.left) return;
  const tier = g.tiers[racer.index] || 'h';
  const delay = race.botWordDelayMs(g.botPaceMs, race.botFactor(botIndex), tier);
  if (!Array.isArray(room.blitzBotTimeouts)) room.blitzBotTimeouts = [];
  const handle = setTimeout(async () => {
    try {
      if (room.game !== g || g.status !== 'in_progress') return;
      const fragment = race.currentFragment(g, racer);
      if (!fragment) return;
      const word = wordBombBot.pickWord(fragment, racer.used);
      if (word) {
        markAsValid(word); // curated real word: skip the lookup, guaranteed accept
        await handleSubmit(room, botId, word, helpers);
      }
      scheduleBot(room, botId, botIndex, helpers);
    } catch (err) {
      logError('race_bot_failed', { roomCode: room.code, playerId: botId }, err);
    }
  }, delay);
  room.blitzBotTimeouts.push(handle);
}

/**
 * A racer's word. Local rules first (same frame, no await), then the dictionary.
 * The racer is locked while their word is being checked so a double-submit can't
 * advance them twice. The result goes to the submitter; progress goes to all.
 */
async function handleSubmit(room, connectionId, text, helpers) {
  const g = room.game;
  if (!g || g.gameType !== GAME_TYPE) return { error: 'no_active_game' };
  const racer = race.getRacer(g, connectionId);
  if (!racer) return { error: 'not_a_racer' };
  if (!g._pending) g._pending = new Set();
  if (g._pending.has(connectionId)) return { error: 'submission_pending' };

  const reject = (word, reason, fragment) => {
    sendTo(room, connectionId, 'race_word_result', {
      accepted: false,
      word,
      reason,
      fragment,
      index: racer.index,
    });
    return { result: { accepted: false, reason } };
  };

  const { word, reason } = race.checkWord(g, connectionId, text);
  const fragment = race.currentFragment(g, racer);
  if (reason) return reject(word, reason, fragment);

  const index = racer.index;
  g._pending.add(connectionId);
  let valid;
  try {
    valid = await isValidWord(word);
  } finally {
    g._pending.delete(connectionId);
  }
  // The world may have moved while we awaited (race ended, room reset).
  if (room.game !== g || g.status !== 'in_progress' || racer.index !== index) {
    return reject(word, 'race_not_live', fragment);
  }
  if (!valid) return reject(word, 'not_a_word', fragment);

  const now = Date.now();
  const { finished } = race.applyAccept(g, connectionId, word, now);
  helpers.touchRoom(room);
  sendTo(room, connectionId, 'race_word_result', {
    accepted: true,
    word,
    reason: null,
    fragment,
    index: racer.index,
  });
  helpers.broadcastToRoom(room, {
    type: 'race_progress',
    payload: {
      racerId: connectionId,
      index: racer.index,
      word,
      fragment,
      t: racer.reachedAt,
      serverNow: now,
    },
  });
  if (finished) endRace(room, 'finish', helpers);
  return { result: { accepted: true } };
}

function handleLeave(room, connectionId, helpers) {
  const g = room.game;
  if (!g || g.gameType !== GAME_TYPE) return;
  if (!race.getRacer(g, connectionId)) return;
  const stillIn = race.markLeft(g, connectionId);
  if (g.status === 'finished') return;
  helpers.broadcastToRoom(room, { type: 'race_racer_left', payload: { racerId: connectionId } });
  // Nobody left to race against: end it now (the survivor takes it if they scored).
  if (stillIn <= 1) endRace(room, 'forfeit', helpers);
}

/**
 * race_add_bot: the host seats a bot in the lobby (on top of the automatic fill).
 * Lobby-only, capped at MAX_RACERS seats.
 */
function addLobbyBot(room) {
  if (room.gameType !== GAME_TYPE) return { error: 'not_a_race_room' };
  if (room.game && room.game.status !== 'finished') return { error: 'game_already_started' };
  if (room.players.length >= race.MAX_RACERS) return { error: 'room_full' };
  const bot = createRaceBot(new Set(room.players.map((p) => p.name)));
  room.players.push(bot);
  return { ok: true, bot };
}

/** race_pace: a racer reports their recent ms/word so bots can match them. */
function setPace(room, playerId, msPerWord) {
  const pace = race.clampPace(msPerWord);
  if (pace === null) return false;
  if (!room.racePace) room.racePace = {};
  room.racePace[playerId] = pace;
  return true;
}

module.exports = {
  gameType: GAME_TYPE,
  minPlayers: 1, // a lone racer is fine: bots fill the grid at launch
  logic,
  start,
  handleSubmit,
  handleLeave,
  setPace,
  addLobbyBot,
  _setDictionaryForTesting,
  _goRace: goRace,
  _endRace: endRace,
};
