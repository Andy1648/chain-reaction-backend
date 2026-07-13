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
    // Elimination order (first-out first) - reversed into the final ranking.
    eliminationOrder: [],
    // Game-over screen material. Hold times are measured by the orchestrator
    // (wall clock lives there) and recorded here via recordHold().
    stats: {
      totalPasses: 0,
      explosions: 0,
      fastestPassMs: null,
      fastestPassBy: null,
      longestHoldMs: 0,
      longestHoldBy: null,
    },
    winnerId: null,
  };
}

/**
 * Records how long a player held the bomb before passing it ('pass') or
 * eating it ('explosion'). Pure state-keeping - the orchestrator measures
 * heldMs, this just folds it into the stats the game-over screen shows.
 */
function recordHold(game, playerId, heldMs, kind) {
  const stats = game.stats;
  if (!stats || typeof heldMs !== 'number' || heldMs < 0) return;
  if (kind === 'pass') {
    stats.totalPasses += 1;
    if (stats.fastestPassMs === null || heldMs < stats.fastestPassMs) {
      stats.fastestPassMs = heldMs;
      stats.fastestPassBy = playerId;
    }
  } else if (kind === 'explosion') {
    stats.explosions += 1;
  }
  if (heldMs > stats.longestHoldMs) {
    stats.longestHoldMs = heldMs;
    stats.longestHoldBy = playerId;
  }
}

/**
 * Final ranking, winner first, then the eliminated in reverse knockout order
 * (last player standing beats the last one out, and so on). Players never
 * formally eliminated (e.g. the game ended with them alive) sort by survival.
 */
function buildFinalRanking(game) {
  const out = [];
  const eliminated = new Set(game.eliminationOrder);
  // Survivors first, in seat order with the winner up top.
  game.players
    .filter((p) => !eliminated.has(p.id))
    .sort((a, b) => (b.id === game.winnerId) - (a.id === game.winnerId))
    .forEach((p) => out.push(p.id));
  // Then the knocked-out, most recent first.
  [...game.eliminationOrder].reverse().forEach((id) => out.push(id));
  return out;
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
    if (player.lives <= 0) {
      player.eliminated = true;
      game.eliminationOrder.push(player.id);
    }
  }

  game.bombIndex += 1;
  game.currentCombo = pickRandomCombo(game.currentCombo, game.passCount);
  advanceHolder(game); // also finishes the game if <=1 player remains

  return {
    explodedPlayerId: holderId,
    eliminated: !!(player && player.eliminated),
    livesLeft: player ? player.lives : 0,
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
  if (player && !player.eliminated) {
    player.lives = 0;
    player.eliminated = true;
    game.eliminationOrder.push(player.id);
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

// In-flight submission grace: if the holder's word entered handleSubmit
// before the deadline, the explosion waits for the dictionary's verdict (up
// to this long past the deadline) instead of letting network latency decide
// a death. A reject (or a hung lookup outlasting the grace) still explodes.
const FUSE_PENDING_GRACE_MS = 3000;

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
      // Winner first, then the eliminated in reverse knockout order.
      finalRanking: buildFinalRanking(game),
      // Game-over screen bragging rights: pass volume, the twitchiest pass,
      // the longest (most reckless) hold, and how many bombs went off.
      stats: { ...game.stats },
      usedWords: Array.from(game.usedWords),
    },
  };
}

/**
 * How much of the current fuse has burned (0..1+), per the orchestrator's
 * stamps on the room. NaN-safe: returns 0 until a fuse has been lit.
 */
function burnedFraction(room) {
  if (!room.fuseLitAt || !room.fuseMs) return 0;
  return (Date.now() - room.fuseLitAt) / room.fuseMs;
}

/** Marks the moment the current holder received the bomb (for hold stats). */
function stampHolder(room) {
  room.fuseHolderSince = Date.now();
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
 * The current holder's hold time so far, measured from whichever came later:
 * receiving the bomb or the fuse being lit (the opening holder's clock only
 * starts once the countdown ends and the fuse is actually burning).
 */
function heldMsNow(room) {
  const since = Math.max(room.fuseHolderSince || 0, room.fuseLitAt || 0);
  return since ? Date.now() - since : 0;
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
  // Stamped on the room so handleSubmit can judge close calls and hold times
  // without ever leaking the fuse length to a client.
  room.fuseLitAt = litAt;
  room.fuseMs = fuseMs;
  stampHolder(room);
  let hintLevel = 0;

  room.turnTimerInterval = setInterval(() => {
    if (!room.game || room.game.status !== 'in_progress') {
      helpers.clearTurnTimer(room);
      return;
    }
    const burned = (Date.now() - litAt) / fuseMs;

    // A word typed in time deserves its verdict: while the holder's
    // submission is being dictionary-checked, hold the explosion (bounded by
    // the grace window so a hung lookup can't stall the game).
    if (burned >= 1 && room.fusePendingSubmit && Date.now() - (litAt + fuseMs) < FUSE_PENDING_GRACE_MS) {
      return;
    }

    while (hintLevel < FUSE_HINT_THRESHOLDS.length && burned >= FUSE_HINT_THRESHOLDS[hintLevel]) {
      hintLevel += 1;
      helpers.broadcastToRoom(room, {
        type: 'fuse_hint',
        // holderId lets the UI shake/smoke the right player card, and dead
        // players get the same escalating dread as everyone else.
        payload: { level: hintLevel, holderId: getHolderId(game) },
      });
    }

    if (burned >= 1) {
      helpers.clearTurnTimer(room);
      recordHold(game, getHolderId(game), heldMsNow(room), 'explosion');
      const result = handleExplosion(game);
      helpers.broadcastToRoom(room, {
        type: 'bomb_exploded',
        payload: {
          playerId: result.explodedPlayerId,
          eliminated: result.eliminated,
          livesLeft: result.livesLeft,
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

  // One submission in flight at a time: firing several candidates in
  // parallel and letting the first valid one win ("shotgunning") would beat
  // thinking. The next attempt is welcome as soon as this verdict lands.
  if (room.fusePendingSubmit) {
    return { error: 'submission_pending' };
  }

  // Judged BEFORE the await: a close call is about when you TYPED it, and the
  // fuse may blow (or the burn fraction move) during the dictionary lookup.
  const heldMs = heldMsNow(room);
  const closeCall = burnedFraction(room) >= FUSE_HINT_THRESHOLDS[FUSE_HINT_THRESHOLDS.length - 1];

  let result;
  room.fusePendingSubmit = true; // also holds the explosion (see startFuse)
  try {
    result = await submitWord(game, word);
  } finally {
    room.fusePendingSubmit = false;
  }

  if (result.accepted) {
    helpers.touchRoom(room);
    recordHold(game, connectionId, heldMs, 'pass');
    stampHolder(room); // the next holder's clock starts now
    // closeCall marks a pass that landed in the final 10% of the fuse - the
    // frontend's "CLOSE CALL!" flash. It reveals nothing not already public
    // (the level-3 crackle hint has fired by then).
    helpers.broadcastToRoom(room, { type: 'word_result', payload: { ...result, closeCall } });
    helpers.broadcastToRoom(room, buildBombUpdatePayload(game));
    // Buzzer-beater: if the fuse burned out while the word was being checked,
    // the pass still counts (it was typed in time) - but the next player must
    // not inherit a spent fuse. The save "defuses" it: light a fresh one.
    if (burnedFraction(room) >= 1) {
      startFuse(room, helpers);
    }
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
  recordHold,
  buildFinalRanking,
  buildBombUpdatePayload,
  burnedFraction,
  _setDictionaryForTesting,
};
