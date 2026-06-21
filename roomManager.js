// roomManager.js
// Owns the in-memory map of rooms, and is the only place that runs actual
// setInterval/setTimeout timers - gameLogic.js stays pure/synchronous-ish
// (submitWord is async only because of the dictionary fetch) so the turn
// rules can be reasoned about without thinking about real time.

// The turn/timer/lives/elimination helpers are identical across both game
// modes (they only touch fields common to both game shapes), so we pull
// them once from gameLogic. The mode-specific pieces - createGame and
// submitWord - are resolved per room via logicForGameType().
const {
  getCurrentPlayerId,
  handleTimeout,
  advanceTurn,
  MIN_PLAYERS_TO_START,
} = require('./gameLogic');

const wordBombLogic = require('./gameLogic');
const categoryBlitzLogic = require('./categoryBlitzLogic');

/**
 * Returns the logic module (createGame/submitWord) for a given game type.
 * Defaults to Word Bomb for anything unrecognized so an old/missing
 * gameType can never leave a room without a logic module.
 */
function logicForGameType(gameType) {
  return gameType === 'category-blitz' ? categoryBlitzLogic : wordBombLogic;
}

const ROOM_CODE_LENGTH = 5;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid ambiguity

// Delay before a game/round timer actually starts ticking, so the frontend's
// 3-2-1-GO countdown (~2.8s) can finish first. Slightly longer than the
// countdown to be safe. The round_start / turn_update message is still sent
// immediately so the countdown can play; only the timer waits.
const COUNTDOWN_DELAY_MS = 3000;

const rooms = new Map(); // roomCode -> room object

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: ROOM_CODE_LENGTH }, () =>
      ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

/**
 * A room holds: the list of connected players (with their live WebSocket
 * connections), the host id, the current game state (or null if not
 * started), and a reference to the active turn-timer interval so it can
 * be cleared on cleanup.
 */
function createRoom(hostConnection, hostName) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId: hostConnection.id,
    players: [{ id: hostConnection.id, name: hostName, connection: hostConnection }],
    game: null,
    difficultyKey: 'medium',
    gameType: 'word-bomb', // 'word-bomb' | 'category-blitz'
    // Word Bomb uses a per-turn timer; Category Blitz uses a per-round timer
    // plus a between-rounds pause. They are mutually exclusive per game, but
    // both slots live on the room so cleanup is uniform.
    turnTimerInterval: null,
    turnDeadline: null,
    roundTimerInterval: null,
    roundPauseTimeout: null,
    roundDeadline: null,
    // Pending "start the timer after the countdown" setTimeout, if any.
    countdownTimeout: null,
  };
  rooms.set(code, room);
  return room;
}

function joinRoom(code, connection, playerName) {
  const room = rooms.get(code);
  if (!room) {
    return { error: 'room_not_found' };
  }
  if (room.game && room.game.status === 'in_progress') {
    return { error: 'game_already_started' };
  }
  if (room.players.length >= 8) {
    return { error: 'room_full' };
  }
  room.players.push({ id: connection.id, name: playerName, connection });
  return { room };
}

function getRoom(code) {
  return rooms.get(code);
}

function broadcastToRoom(room, message) {
  const payload = JSON.stringify(message);
  room.players.forEach((p) => {
    if (p.connection.readyState === 1 /* WebSocket.OPEN */) {
      p.connection.send(payload);
    }
  });
}

function buildRoomUpdatePayload(room) {
  return {
    type: 'room_update',
    payload: {
      code: room.code,
      hostId: room.hostId,
      difficultyKey: room.difficultyKey,
      gameType: room.gameType,
      players: room.players.map((p) => ({ id: p.id, name: p.name })),
    },
  };
}

// These two builders are Word Bomb-only. Category Blitz is round-based and
// simultaneous, so it broadcasts its own round_start / round_end / game_over
// payloads (built inline in startRoundTimer) rather than turn updates.
function buildTurnUpdatePayload(room) {
  const { game } = room;
  return {
    type: 'turn_update',
    payload: {
      currentPlayerId: getCurrentPlayerId(game),
      timerSeconds: game.currentTimerSeconds,
      combo: game.currentCombo,
      usedWords: Array.from(game.usedWords),
      players: game.players.map((p) => ({
        id: p.id,
        name: room.players.find((rp) => rp.id === p.id)?.name || 'Unknown',
        lives: p.lives,
        eliminated: p.eliminated,
      })),
    },
  };
}

function buildGameOverPayload(room) {
  return {
    type: 'game_over',
    payload: {
      winnerId: room.game.winnerId,
      usedWords: Array.from(room.game.usedWords),
    },
  };
}

/**
 * Starts (or restarts) the wall-clock countdown for the current turn.
 * Broadcasts a tick every second so all clients stay in sync, and fires
 * a timeout if the deadline passes with no submission. Always clears any
 * pre-existing interval first so we never end up with two timers racing.
 */
function startTurnTimer(room) {
  clearTurnTimer(room);

  const { game } = room;
  let remaining = game.currentTimerSeconds;
  room.turnDeadline = Date.now() + remaining * 1000;

  room.turnTimerInterval = setInterval(() => {
    remaining -= 1;

    if (remaining <= 0) {
      clearTurnTimer(room);
      const { eliminatedPlayerId } = handleTimeout(game);

      broadcastToRoom(room, {
        type: 'turn_timeout',
        payload: { eliminatedPlayerId },
      });

      if (game.status === 'finished') {
        broadcastToRoom(room, buildGameOverPayload(room));
      } else {
        broadcastToRoom(room, buildTurnUpdatePayload(room));
        startTurnTimer(room); // chain into the next turn's timer
      }
      return;
    }

    broadcastToRoom(room, { type: 'timer_tick', payload: { secondsRemaining: remaining } });
  }, 1000);
}

function clearTurnTimer(room) {
  if (room.turnTimerInterval) {
    clearInterval(room.turnTimerInterval);
    room.turnTimerInterval = null;
  }
  clearCountdownTimeout(room);
}

/**
 * Clears a pending countdown-delay timeout (the gap between sending
 * round_start / turn_update and actually starting the timer).
 */
function clearCountdownTimeout(room) {
  if (room.countdownTimeout) {
    clearTimeout(room.countdownTimeout);
    room.countdownTimeout = null;
  }
}

/**
 * Schedules a timer-start function to run after the countdown delay, so the
 * timer doesn't begin until the frontend's 3-2-1-GO countdown has finished.
 * Any previously pending countdown is cleared first.
 */
function scheduleTimerAfterCountdown(room, startFn) {
  clearCountdownTimeout(room);
  room.countdownTimeout = setTimeout(() => {
    room.countdownTimeout = null;
    startFn(room);
  }, COUNTDOWN_DELAY_MS);
}

/**
 * Category Blitz round timer. Counts down game.roundTimeSeconds, broadcasting
 * a timer_tick every second (same shape as the Word Bomb turn timer). When
 * time runs out it ends the round, broadcasts round_end with everyone's
 * results, then after a 5-second intermission either advances to the next
 * round (round_start + a fresh round timer) or, if all rounds are done,
 * broadcasts game_over with the final scoreboard.
 */
function startRoundTimer(room) {
  clearRoundTimer(room);

  const { game } = room;
  let remaining = game.roundTimeSeconds;
  room.roundDeadline = Date.now() + remaining * 1000;

  room.roundTimerInterval = setInterval(() => {
    remaining -= 1;

    if (remaining <= 0) {
      clearRoundTimer(room);

      const results = categoryBlitzLogic.endRound(game);
      broadcastToRoom(room, { type: 'round_end', payload: results });

      // Intermission so players can read the round results before the next
      // category drops (or the game ends).
      room.roundPauseTimeout = setTimeout(() => {
        room.roundPauseTimeout = null;

        const next = categoryBlitzLogic.startNextRound(game);
        if (next === null) {
          broadcastToRoom(room, {
            type: 'game_over',
            payload: {
              winnerId: game.winnerId,
              finalScores: categoryBlitzLogic.getScoreboard(game),
            },
          });
        } else {
          // Announce the next round immediately so its countdown can play,
          // then delay the round timer until the countdown finishes.
          broadcastToRoom(room, { type: 'round_start', payload: next });
          scheduleTimerAfterCountdown(room, startRoundTimer);
        }
      }, 5000);

      return;
    }

    broadcastToRoom(room, { type: 'timer_tick', payload: { secondsRemaining: remaining } });
  }, 1000);
}

function clearRoundTimer(room) {
  if (room.roundTimerInterval) {
    clearInterval(room.roundTimerInterval);
    room.roundTimerInterval = null;
  }
  if (room.roundPauseTimeout) {
    clearTimeout(room.roundPauseTimeout);
    room.roundPauseTimeout = null;
  }
  clearCountdownTimeout(room);
}

function startGame(room) {
  if (room.players.length < MIN_PLAYERS_TO_START) {
    return { error: 'not_enough_players' };
  }
  const logic = logicForGameType(room.gameType);
  room.game = logic.createGame(
    room.players.map((p) => ({ id: p.id, name: p.name })),
    room.difficultyKey
  );
  // Stamp the type onto the game so payload builders and submission routing
  // know which mode this in-progress game is, independent of the room.
  room.game.gameType = room.gameType;
  broadcastToRoom(room, {
    type: 'game_started',
    payload: { difficultyKey: room.difficultyKey, gameType: room.gameType },
  });

  if (room.gameType === 'category-blitz') {
    // Simultaneous, round-based: announce round 1 immediately (so the
    // countdown can play), but delay the round timer until it finishes.
    broadcastToRoom(room, {
      type: 'round_start',
      payload: {
        round: room.game.currentRound,
        category: room.game.currentCategory,
        timerSeconds: room.game.roundTimeSeconds,
      },
    });
    scheduleTimerAfterCountdown(room, startRoundTimer);
  } else {
    // Turn-based Word Bomb: send the first turn immediately, delay its timer.
    broadcastToRoom(room, buildTurnUpdatePayload(room));
    scheduleTimerAfterCountdown(room, startTurnTimer);
  }

  return { room };
}

/**
 * Handles a word submission from a connection. Validates that it's
 * actually that player's turn before delegating to gameLogic - this
 * check has to live here because only the networking layer knows which
 * connection sent the message.
 */
async function handleWordSubmission(room, connectionId, word) {
  const { game } = room;
  if (!game) {
    return { error: 'no_active_game' };
  }

  // Category Blitz is simultaneous - no turns - so it routes to its own
  // handler instead of the turn-validated Word Bomb path below.
  if (game.gameType === 'category-blitz') {
    return handleCategoryAnswer(room, connectionId, word);
  }

  if (game.status !== 'in_progress') {
    return { error: 'no_active_game' };
  }
  if (getCurrentPlayerId(game) !== connectionId) {
    return { error: 'not_your_turn' };
  }

  const logic = logicForGameType(game.gameType);
  const result = await logic.submitWord(game, word);

  if (result.accepted) {
    clearTurnTimer(room);
    broadcastToRoom(room, { type: 'word_result', payload: result });

    if (game.status === 'finished') {
      broadcastToRoom(room, buildGameOverPayload(room));
    } else {
      broadcastToRoom(room, buildTurnUpdatePayload(room));
      startTurnTimer(room);
    }
  } else {
    // Rejected submissions don't consume the turn or reset the timer -
    // the player can just try again until time runs out. This matches
    // how Word Bomb / similar games typically behave and is much less
    // punishing than burning a life on a typo.
    const connection = room.players.find((p) => p.id === connectionId)?.connection;
    if (connection && connection.readyState === 1) {
      connection.send(JSON.stringify({ type: 'word_result', payload: result }));
    }
  }

  return { result };
}

/**
 * Handles a Category Blitz answer. Unlike Word Bomb there's no turn check -
 * any player can submit any time the round is active. The accept/reject
 * result goes ONLY to the submitter (opponents must not see your answers
 * mid-round), while a privacy-safe player_progress (just a count) is
 * broadcast to everyone so the UI can show how each player is doing.
 */
async function handleCategoryAnswer(room, connectionId, answer) {
  const { game } = room;
  if (!game || game.gameType !== 'category-blitz') {
    return { error: 'no_active_game' };
  }
  // Answers are only accepted while a round is actively running (not during
  // the between-rounds intermission or after the game ends).
  if (game.status !== 'in_progress') {
    return { error: 'round_not_active' };
  }

  const result = await categoryBlitzLogic.submitAnswer(game, connectionId, answer);

  // Private result back to the submitter only.
  const connection = room.players.find((p) => p.id === connectionId)?.connection;
  if (connection && connection.readyState === 1) {
    connection.send(JSON.stringify({ type: 'answer_result', payload: result }));
  }

  // Public progress (count only) when the answer actually landed - the count
  // is the only thing that changes, and it reveals nothing about the answer.
  if (result.accepted) {
    const player = game.players.find((p) => p.id === connectionId);
    broadcastToRoom(room, {
      type: 'player_progress',
      payload: { playerId: connectionId, answerCount: player ? player.answers.length : 0 },
    });
  }

  return { result };
}

/**
 * Tears the current game down so the room returns to its pre-game lobby
 * state: kills every active timer, drops the game object, and broadcasts a
 * room_update so all clients fall back to the room view (where the host can
 * tweak difficulty/game type and start again). Backs the host-only rematch.
 *
 * The trailing game_reset is an explicit "this room_update is a rematch, leave
 * the game view" signal: clients ignore plain room_updates while in a game (so
 * a late room_update can't yank a player out of a just-started match), and rely
 * on game_reset to drive the game -> room transition.
 */
function resetGame(room) {
  clearTurnTimer(room);
  clearRoundTimer(room);
  clearCountdownTimeout(room);
  room.game = null;
  broadcastToRoom(room, buildRoomUpdatePayload(room));
  broadcastToRoom(room, { type: 'game_reset', payload: {} });
}

function removePlayer(room, connectionId) {
  room.players = room.players.filter((p) => p.id !== connectionId);

  if (room.players.length === 0) {
    clearTurnTimer(room);
    clearRoundTimer(room);
    clearCountdownTimeout(room);
    rooms.delete(room.code);
    return;
  }

  // Reassign host if the host left.
  if (room.hostId === connectionId) {
    room.hostId = room.players[0].id;
  }

  const game = room.game;
  if (game && game.gameType === 'category-blitz') {
    // Simultaneous mode has no turns to advance - the round timer keeps
    // running for everyone else. Just drop the leaver from the live roster
    // so progress broadcasts and the final scoreboard reflect who's still in.
    if (Array.isArray(game.players)) {
      game.players = game.players.filter((p) => p.id !== connectionId);
    }
  } else if (game && game.status === 'in_progress') {
    // Word Bomb: treat the disconnect like the player timing out until
    // eliminated, so the game doesn't hang waiting on someone who left.
    const player = game.players.find((p) => p.id === connectionId);
    if (player) {
      player.eliminated = true;
      player.lives = 0;
    }
    if (getCurrentPlayerId(game) === connectionId) {
      clearTurnTimer(room);
      advanceTurn(game);
      if (game.status === 'finished') {
        broadcastToRoom(room, buildGameOverPayload(room));
      } else {
        broadcastToRoom(room, buildTurnUpdatePayload(room));
        startTurnTimer(room);
      }
    }
  }

  broadcastToRoom(room, buildRoomUpdatePayload(room));
}

module.exports = {
  createRoom,
  joinRoom,
  getRoom,
  startGame,
  resetGame,
  handleWordSubmission,
  handleCategoryAnswer,
  removePlayer,
  broadcastToRoom,
  buildRoomUpdatePayload,
  buildTurnUpdatePayload,
  buildGameOverPayload,
  clearTurnTimer,
  startTurnTimer,
  startRoundTimer,
  clearRoundTimer,
};
