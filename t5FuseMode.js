// t5FuseMode.js
// FUSE - hot-potato Word Bomb. [T5 experimental mode]
//
// A bomb with a HIDDEN fuse passes around the table. The current holder must
// type a real word containing the on-screen combo; an accepted word shoves the
// bomb to the next player - but the fuse KEEPS BURNING across passes. Whoever
// is holding the bomb when it blows loses a life (eliminated at 0). When a
// bomb explodes a fresh one spawns - with a slightly shorter fuse range each
// time - on the next player's hands. Last player standing wins.
//
// Nobody ever sees the clock: the server drips escalating "crackle" hints
// (fuse_hint level 1/2/3 at 50/75/90% burned) so dread ramps without the
// truth ever leaking. Speed always helps you, but it can't always save you.
//
// Layout follows the T5 plugin shape: PURE LOGIC first (no timers, no
// sockets - unit-testable exactly like gameLogic.js, including the injectable
// dictionary), then the ORCHESTRATOR (owns the fuse interval via the room's
// standard turnTimer slot, so resetGame/destroyRoom teardown works unchanged).
// All roomManager facilities arrive via an injected `helpers` object - this
// module never requires roomManager (no cycles). Registered in t5Modes.js.

const { pickRandomCombo } = require('./gameLogic');

/* ============================== PURE LOGIC ============================== */

// Same injection hook pattern as gameLogic.js so the test suite can swap in
// dictionary.mock.js and run with zero network.
let { isValidWord } = require('./dictionary');
function _setDictionaryForTesting(mockModule) {
  isValidWord = mockModule.isValidWord;
}

const STARTING_LIVES = 2; // explosions are rarer than Word Bomb timeouts, so 2 is plenty
const MIN_PLAYERS_TO_START = 2;

// Hidden fuse ranges (ms) per difficulty. Rolled fresh for every bomb,
// uniformly inside [min, max] - then scaled down as bombs pile up (below).
const FUSE_RANGE_BY_DIFFICULTY = {
  easy: { minMs: 22000, maxMs: 40000 },
  medium: { minMs: 18000, maxMs: 32000 },
  hard: { minMs: 12000, maxMs: 24000 },
};

// Each successive bomb burns faster: the range shrinks 8% per exploded bomb,
// clamped so the late game stays brutal but never impossible.
const FUSE_SHRINK_PER_BOMB = 0.08;
const FUSE_SHRINK_FLOOR = 0.45;

// Crackle hints: fraction of the fuse burned at which each escalating hint
// level is broadcast. Clients render smoke -> sparks -> violent shaking.
const FUSE_HINT_THRESHOLDS = [0.5, 0.75, 0.9];

/**
 * Creates a fresh FUSE game. Players is [{ id, name }]. The first player in
 * join order starts holding the bomb. Combo selection reuses Word Bomb's
 * progress-weighted picker: passCount is the progress signal, so combos get
 * harder the longer a game runs (passes, not turns, measure progress here).
 */
function createGame(players, difficultyKey) {
  const range = FUSE_RANGE_BY_DIFFICULTY[difficultyKey] || FUSE_RANGE_BY_DIFFICULTY.medium;
  return {
    status: 'in_progress', // 'in_progress' | 'finished'
    difficultyKey: FUSE_RANGE_BY_DIFFICULTY[difficultyKey] ? difficultyKey : 'medium',
    fuseRange: range,
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      lives: STARTING_LIVES,
      eliminated: false,
    })),
    holderOrder: players.map((p) => p.id),
    holderIndex: 0,
    currentCombo: pickRandomCombo(),
    usedWords: new Set(),
    passCount: 0, // accepted words this game - drives combo difficulty ramp
    bombIndex: 0, // how many bombs have exploded - drives fuse shrink
    winnerId: null,
  };
}

function getHolderId(game) {
  return game.holderOrder[game.holderIndex];
}

function getActivePlayers(game) {
  return game.players.filter((p) => !p.eliminated);
}

/**
 * Rolls the hidden fuse duration (ms) for the CURRENT bomb. Uniform inside the
 * difficulty range, scaled down by how many bombs have already gone off.
 */
function rollFuseMs(game) {
  const { minMs, maxMs } = game.fuseRange;
  const scale = Math.max(FUSE_SHRINK_FLOOR, 1 - game.bombIndex * FUSE_SHRINK_PER_BOMB);
  return Math.round((minMs + Math.random() * (maxMs - minMs)) * scale);
}

/**
 * Moves the bomb to the next non-eliminated player. If one or zero players
 * remain active the game ends instead (winnerId = the survivor, if any).
 */
function advanceHolder(game) {
  const active = getActivePlayers(game);
  if (active.length <= 1) {
    game.status = 'finished';
    game.winnerId = active.length === 1 ? active[0].id : null;
    return;
  }
  let next = (game.holderIndex + 1) % game.holderOrder.length;
  let safety = 0;
  while (
    game.players.find((p) => p.id === game.holderOrder[next])?.eliminated &&
    safety < game.holderOrder.length
  ) {
    next = (next + 1) % game.holderOrder.length;
    safety += 1;
  }
  game.holderIndex = next;
}

/**
 * Validates and applies a word from the current holder. Same acceptance rules
 * as Word Bomb (>=3 letters, contains the combo, unused, real word) - but an
 * accepted word PASSES THE BOMB instead of resetting any clock. The caller
 * checks whose submission this is; this function assumes it's the holder's.
 *
 * Race guard (same TOCTOU shape as gameLogic.submitWord): the dictionary
 * lookup is awaited, and the fuse can blow during that await. If the bomb
 * exploded (bombIndex moved), any word landed (passCount moved), or the game
 * ended while we were away, the submission is discarded without mutating.
 */
async function submitWord(game, rawWord) {
  const word = String(rawWord).trim().toLowerCase();
  const combo = game.currentCombo;

  if (game.status !== 'in_progress') {
    return { accepted: false, reason: 'turn_over' };
  }
  if (word.length < 3) {
    return { accepted: false, reason: 'too_short' };
  }
  if (!word.includes(combo)) {
    return { accepted: false, reason: 'missing_combo', combo };
  }
  if (game.usedWords.has(word)) {
    return { accepted: false, reason: 'already_used' };
  }

  const passAtSubmit = game.passCount;
  const bombAtSubmit = game.bombIndex;

  const valid = await isValidWord(word);
  if (!valid) {
    return { accepted: false, reason: 'not_a_word' };
  }

  if (
    game.status !== 'in_progress' ||
    game.passCount !== passAtSubmit ||
    game.bombIndex !== bombAtSubmit
  ) {
    return { accepted: false, reason: 'turn_over' };
  }

  game.usedWords.add(word);
  game.passCount += 1;
  game.currentCombo = pickRandomCombo(combo, game.passCount);
  advanceHolder(game);

  return { accepted: true, word, combo: game.currentCombo };
}

/**
 * The fuse ran out on the current holder. Costs a life (eliminated at 0),
 * retires the bomb (bombIndex++, so the next fuse rolls shorter), spawns a
 * fresh combo, and hands the new bomb to the next active player - or ends
 * the game if the explosion left one player standing.
 */
function handleExplosion(game) {
  const holderId = getHolderId(game);
  const player = game.players.find((p) => p.id === holderId);
  if (player) {
    player.lives -= 1;
    if (player.lives <= 0) player.eliminated = true;
  }

  game.bombIndex += 1;
  game.currentCombo = pickRandomCombo(game.currentCombo, game.passCount);
  advanceHolder(game); // also finishes the game if <=1 player remains

  return {
    explodedPlayerId: holderId,
    eliminated: !!(player && player.eliminated),
    finished: game.status === 'finished',
  };
}

/**
 * Removes a player from the live game (disconnect). Treated as an immediate
 * elimination so the bomb never waits on a ghost. If the leaver was holding
 * the bomb, it moves on (the caller restarts the fuse - a fresh fuse, so the
 * next player doesn't inherit a nearly-burned one they never chose to hold).
 * Returns { wasHolder, finished }.
 */
function eliminatePlayer(game, playerId) {
  const wasHolder = getHolderId(game) === playerId && game.status === 'in_progress';
  const player = game.players.find((p) => p.id === playerId);
  if (player) {
    player.lives = 0;
    player.eliminated = true;
  }
  if (game.status === 'in_progress') {
    const active = getActivePlayers(game);
    if (active.length <= 1) {
      game.status = 'finished';
      game.winnerId = active.length === 1 ? active[0].id : null;
    } else if (wasHolder) {
      advanceHolder(game);
    }
  }
  return { wasHolder, finished: game.status === 'finished' };
}

/* ============================== ORCHESTRATOR ============================== */
// Owns the wall-clock fuse. Uses the room's standard turn-timer slot
// (turnTimerInterval / turnDeadline) so every existing cleanup path -
// resetGame, destroyRoom, _resetRoomsForTesting - tears it down unchanged.
// `helpers` is injected by roomManager: { broadcastToRoom,
// scheduleTimerAfterCountdown, clearTurnTimer, clearRoundTimer, touchRoom }.

const FUSE_TICK_MS = 250; // fine-grained so hints and the explosion land close to true

function buildBombUpdatePayload(game) {
  return {
    type: 'bomb_update',
    payload: {
      holderId: getHolderId(game),
      combo: game.currentCombo,
      passCount: game.passCount,
      bombIndex: game.bombIndex,
      players: game.players.map((p) => ({
        id: p.id,
        name: p.name,
        lives: p.lives,
        eliminated: p.eliminated,
      })),
    },
  };
}

function buildGameOverPayload(game) {
  return {
    type: 'game_over',
    payload: {
      gameType: 'fuse',
      winnerId: game.winnerId,
      usedWords: Array.from(game.usedWords),
    },
  };
}

/**
 * Kicks off a just-created game: announces the opening bomb immediately (so
 * the 3-2-1 countdown can play over it) and lights the first fuse only after
 * the countdown delay.
 */
function start(room, helpers) {
  helpers.broadcastToRoom(room, buildBombUpdatePayload(room.game));
  helpers.scheduleTimerAfterCountdown(room, (r) => startFuse(r, helpers));
}

/**
 * Lights a fresh hidden fuse for the current bomb. A single interval both
 * drips the escalating crackle hints and fires the explosion; hint state
 * lives in this closure, so every new fuse naturally resets it.
 */
function startFuse(room, helpers) {
  helpers.clearTurnTimer(room);

  const { game } = room;
  const fuseMs = rollFuseMs(game);
  const litAt = Date.now();
  room.turnDeadline = litAt + fuseMs;
  let hintLevel = 0;

  room.turnTimerInterval = setInterval(() => {
    if (!room.game || room.game.status !== 'in_progress') {
      helpers.clearTurnTimer(room);
      return;
    }
    const burned = (Date.now() - litAt) / fuseMs;

    while (hintLevel < FUSE_HINT_THRESHOLDS.length && burned >= FUSE_HINT_THRESHOLDS[hintLevel]) {
      hintLevel += 1;
      helpers.broadcastToRoom(room, { type: 'fuse_hint', payload: { level: hintLevel } });
    }

    if (burned >= 1) {
      helpers.clearTurnTimer(room);
      const result = handleExplosion(game);
      helpers.broadcastToRoom(room, {
        type: 'bomb_exploded',
        payload: {
          playerId: result.explodedPlayerId,
          eliminated: result.eliminated,
          nextHolderId: result.finished ? null : getHolderId(game),
        },
      });
      if (result.finished) {
        helpers.broadcastToRoom(room, buildGameOverPayload(game));
      } else {
        helpers.broadcastToRoom(room, buildBombUpdatePayload(game));
        startFuse(room, helpers); // fresh (shorter-range) fuse on the next holder
      }
    }
  }, FUSE_TICK_MS);
}

/**
 * A word submission routed here by roomManager. Holder-only; an accepted word
 * broadcasts the result plus the new bomb position - and deliberately does NOT
 * touch the fuse. Rejections go back privately, same as Word Bomb.
 */
async function handleSubmit(room, connectionId, word, helpers) {
  const { game } = room;
  if (!game || game.gameType !== 'fuse' || game.status !== 'in_progress') {
    return { error: 'no_active_game' };
  }
  if (getHolderId(game) !== connectionId) {
    return { error: 'not_your_turn' };
  }

  const result = await submitWord(game, word);

  if (result.accepted) {
    helpers.touchRoom(room);
    helpers.broadcastToRoom(room, { type: 'word_result', payload: result });
    helpers.broadcastToRoom(room, buildBombUpdatePayload(game));
  } else {
    const connection = room.players.find((p) => p.id === connectionId)?.connection;
    if (connection && connection.readyState === 1) {
      connection.send(JSON.stringify({ type: 'word_result', payload: result }));
    }
  }

  return { result };
}

/**
 * A player left mid-game. Immediate elimination; if they were holding the
 * bomb the next player gets it with a FRESH fuse (they never chose to hold a
 * nearly-burned one). Ends the game if one player remains.
 */
function handleLeave(room, connectionId, helpers) {
  const { game } = room;
  if (!game || game.status !== 'in_progress') return;

  const { wasHolder, finished } = eliminatePlayer(game, connectionId);

  if (finished) {
    helpers.clearTurnTimer(room);
    helpers.broadcastToRoom(room, buildGameOverPayload(game));
  } else if (wasHolder) {
    helpers.broadcastToRoom(room, buildBombUpdatePayload(game));
    startFuse(room, helpers);
  }
}

module.exports = {
  // plugin surface (consumed via t5Modes.js)
  gameType: 'fuse',
  minPlayers: MIN_PLAYERS_TO_START,
  logic: { createGame },
  start,
  handleSubmit,
  handleLeave,
  // pure logic (unit tests)
  STARTING_LIVES,
  FUSE_RANGE_BY_DIFFICULTY,
  FUSE_SHRINK_PER_BOMB,
  FUSE_SHRINK_FLOOR,
  FUSE_HINT_THRESHOLDS,
  createGame,
  getHolderId,
  getActivePlayers,
  rollFuseMs,
  advanceHolder,
  submitWord,
  handleExplosion,
  eliminatePlayer,
  buildBombUpdatePayload,
  _setDictionaryForTesting,
};
