// minerMode.js
// MINER orchestrator - the T5 plugin wrapper around the pure miner.js state machine. Owns the clocks
// (countdown -> dig -> reveal -> dig ...), bot thinking time and the wire. Registered in t5Modes.js, so
// room lifecycle (create / join / start_game / submit_word / leave) runs through roomManager's generic
// T5 hooks and never touches the Word Bomb or Blitz handlers.
//
// TIMER SLOTS: only the room's standard slots, so every teardown path (resetGame / destroyRoom /
// failRoom) clears them:
//   countdownTimeout   - the 3-2-1 before round 1 (helpers.scheduleTimerAfterCountdown)
//   roundTimerInterval - the dig bell (a one-shot timeout; clearInterval clears it)
//   roundPauseTimeout  - the reveal pause before the next round
//   blitzBotTimeouts   - each bot's answer timeout (cleared by clearRoundTimer)
//
// WIRE (all additive message types):
//   miner_start  -> room  { miners, target, lives, serverNow, goAt }
//   miner_round  -> room  { round, prompt, pack, size, endsAt, roundMs, serverNow }
//   miner_result -> submitter only { accepted, answer, reason, ore, depth }
//   miner_locked -> room  { ids, locked, total }   (WHO has an answer in - never what it is)
//   miner_reveal -> room  { round, prompt, picks, diamond, miners, over, nextInMs, serverNow }
//   miner_over   -> room  { winnerIds, reason, standings, target, rounds, serverNow }
//   miner_left   -> room  { id }

const miner = require('./miner');
const BLITZ_LISTS = require('./blitzLists');
const { logError } = require('./logger');

const GAME_TYPE = 'miner';
// Mirrors roomManager's COUNTDOWN_DELAY_MS; only used to PREDICT goAt in miner_start.
const COUNTDOWN_MS = 3000;
// Test hooks shorten the clocks for harnesses. Never set in production.
const ROUND_MS = Number(process.env.MINER_ROUND_MS) || 15000;
const REVEAL_MS = Number(process.env.MINER_REVEAL_MS) || 4500;
const OVER_HOLD_MS = Number(process.env.MINER_OVER_MS) || 3000; // the last reveal plays before the results
const BOT_SCALE = ROUND_MS / 15000;
const BOT_FILL_TO = 3; // a launch with < 2 humans is topped up to this many miners

const BOT_NAMES = ['DIGGS', 'ROCKY', 'PEBBLES', 'SHAFT', 'NUGGET', 'GRAVEL', 'DUSTY', 'CLAY', 'FLINT', 'SLATE'];
let botCounter = 0;
function createMinerBot(takenNames) {
  botCounter += 1;
  const id = `minerbot-${botCounter}-${Math.random().toString(36).slice(2, 8)}`;
  const free = BOT_NAMES.filter((n) => !takenNames.has(n));
  const name = free.length ? free[Math.floor(Math.random() * free.length)] : `DIGGER ${botCounter}`;
  takenNames.add(name);
  return {
    id,
    name,
    isBot: true,
    botGameType: GAME_TYPE,
    botDifficulty: 'medium',
    minerSkill: 0.25 + Math.random() * 0.35,
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

function overPayload(g) {
  return {
    winnerIds: g.winnerIds,
    reason: g.endReason,
    standings: miner.standings(g),
    target: g.target,
    rounds: g.round,
    serverNow: Date.now(),
  };
}

function announceOver(room, helpers) {
  const g = room.game;
  if (!g || g._overSent) return;
  g._overSent = true;
  helpers.clearRoundTimer(room);
  helpers.broadcastToRoom(room, { type: 'miner_over', payload: overPayload(g) });
}

/* ------------------------------ plugin ------------------------------ */

const logic = {
  // Pure create; bots are seated in start() because they must also join the room roster.
  createGame(players) {
    return miner.createGame(players.map((p) => ({ id: p.id, name: p.name })));
  },
};

function start(room, helpers) {
  const g = room.game;
  for (const m of g.miners) {
    const rp = room.players.find((p) => p.id === m.id);
    m.isBot = !!(rp && rp.isBot);
  }
  const humans = g.miners.filter((m) => !m.isBot).length;
  const bots = g.miners.filter((m) => m.isBot).length;
  const need = humans < 2 ? Math.max(0, BOT_FILL_TO - humans - bots) : 0;
  const taken = new Set(room.players.map((p) => p.name));
  for (let i = 0; i < need && g.miners.length < miner.MAX_MINERS; i++) {
    const bot = createMinerBot(taken);
    room.players.push(bot);
    miner.addMiner(g, { id: bot.id, name: bot.name, isBot: true });
  }
  const now = Date.now();
  helpers.broadcastToRoom(room, {
    type: 'miner_start',
    payload: {
      miners: miner.minersSnapshot(g),
      target: g.target,
      lives: miner.START_LIVES,
      serverNow: now,
      goAt: now + COUNTDOWN_MS,
    },
  });
  helpers.scheduleTimerAfterCountdown(room, () => openRound(room, helpers));
}

function openRound(room, helpers) {
  const g = room.game;
  if (!g || g.gameType !== GAME_TYPE || g.status === 'finished') return;
  const prompt = miner.startRound(g);
  const list = BLITZ_LISTS.listFor(prompt);
  const now = Date.now();
  helpers.touchRoom(room);
  helpers.broadcastToRoom(room, {
    type: 'miner_round',
    payload: {
      round: g.round,
      prompt,
      pack: list ? list.pack : null,
      endsAt: now + ROUND_MS,
      roundMs: ROUND_MS,
      serverNow: now,
    },
  });
  room.roundTimerInterval = setTimeout(() => {
    try {
      room.roundTimerInterval = null;
      closeRound(room, helpers);
    } catch (err) {
      logError('miner_bell_failed', { roomCode: room.code }, err);
    }
  }, ROUND_MS);
  scheduleBots(room, helpers);
}

function scheduleBots(room, helpers) {
  const g = room.game;
  if (!Array.isArray(room.blitzBotTimeouts)) room.blitzBotTimeouts = [];
  for (const m of miner.activeMiners(g).filter((x) => x.isBot)) {
    const rp = room.players.find((p) => p.id === m.id);
    const skill = rp && Number.isFinite(rp.minerSkill) ? rp.minerSkill : 0.4;
    const delay = Math.round((2500 + Math.random() * 8000) * BOT_SCALE);
    const round = g.round;
    room.blitzBotTimeouts.push(setTimeout(() => {
      try {
        if (room.game !== g || g.status !== 'digging' || g.round !== round) return;
        const taken = new Set(g.miners.filter((x) => x.pick).map((x) => x.pick.key));
        const answer = miner.botAnswer(g.prompt, skill, taken);
        if (answer) handleSubmit(room, m.id, answer, helpers);
      } catch (err) {
        logError('miner_bot_failed', { roomCode: room.code, playerId: m.id }, err);
      }
    }, delay));
  }
}

/** The bell (or everyone locked): reveal, then the next round or the results. Safe to call twice. */
function closeRound(room, helpers) {
  const g = room.game;
  if (!g || g.gameType !== GAME_TYPE || g.status !== 'digging') return;
  helpers.clearRoundTimer(room); // the bell + every pending bot answer
  const reveal = miner.endRound(g);
  const nextInMs = reveal.over ? OVER_HOLD_MS : REVEAL_MS;
  helpers.broadcastToRoom(room, {
    type: 'miner_reveal',
    payload: { ...reveal, nextInMs, serverNow: Date.now() },
  });
  room.roundPauseTimeout = setTimeout(() => {
    try {
      room.roundPauseTimeout = null;
      if (room.game !== g) return;
      if (g.status === 'finished') announceOver(room, helpers);
      else openRound(room, helpers);
    } catch (err) {
      logError('miner_next_failed', { roomCode: room.code }, err);
    }
  }, nextInMs);
}

function lockedPayload(g) {
  const live = miner.activeMiners(g);
  return { ids: live.filter((m) => m.pick).map((m) => m.id), ...miner.lockedCount(g) };
}

/** A miner's answer: judged at once (list-only, no network). Private result; the room sees only WHO locked. */
function handleSubmit(room, connectionId, text, helpers) {
  const g = room.game;
  if (!g || g.gameType !== GAME_TYPE) return { error: 'no_active_game' };
  if (!miner.getMiner(g, connectionId)) return { error: 'not_a_miner' };
  const res = miner.submit(g, connectionId, text);
  const answer = String(text == null ? '' : text).trim().slice(0, 40);
  if (!res.accepted) {
    sendTo(room, connectionId, 'miner_result', { accepted: false, answer, reason: res.reason });
    return { result: { accepted: false, reason: res.reason } };
  }
  helpers.touchRoom(room);
  sendTo(room, connectionId, 'miner_result', {
    accepted: true,
    answer: res.pick.text,
    reason: null,
    ore: res.pick.ore,
    depth: res.pick.depth,
  });
  helpers.broadcastToRoom(room, { type: 'miner_locked', payload: lockedPayload(g) });
  if (miner.allLocked(g)) closeRound(room, helpers);
  return { result: { accepted: true } };
}

function handleLeave(room, connectionId, helpers) {
  const g = room.game;
  if (!g || g.gameType !== GAME_TYPE || g.status === 'finished') return;
  if (!miner.getMiner(g, connectionId)) return;
  const endNow = miner.markLeft(g, connectionId);
  helpers.broadcastToRoom(room, { type: 'miner_left', payload: { id: connectionId } });
  if (endNow) {
    miner.finish(g, 'forfeit');
    announceOver(room, helpers);
    return;
  }
  if (g.status === 'digging') {
    if (miner.allLocked(g)) closeRound(room, helpers);
    else helpers.broadcastToRoom(room, { type: 'miner_locked', payload: lockedPayload(g) });
  }
}

/** miner_add_bot: the host seats a bot in the lobby (on top of the automatic fill). */
function addLobbyBot(room) {
  if (room.gameType !== GAME_TYPE) return { error: 'not_a_miner_room' };
  if (room.game && room.game.status !== 'finished') return { error: 'game_already_started' };
  if (room.players.length >= miner.MAX_MINERS) return { error: 'room_full' };
  const bot = createMinerBot(new Set(room.players.map((p) => p.name)));
  room.players.push(bot);
  return { ok: true, bot };
}

module.exports = {
  gameType: GAME_TYPE,
  minPlayers: 1, // a lone miner is fine: bots fill the mine at launch
  logic,
  start,
  handleSubmit,
  handleLeave,
  addLobbyBot,
  ROUND_MS,
  REVEAL_MS,
  _openRound: openRound,
  _closeRound: closeRound,
};
