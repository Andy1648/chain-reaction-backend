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
    turnTimerInterval: null,
    turnDeadline: null,
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

function buildTurnUpdatePayload(room) {
  const { game } = room;
  const payload = {
    currentPlayerId: getCurrentPlayerId(game),
    timerSeconds: game.currentTimerSeconds,
    players: game.players.map((p) => ({
      id: p.id,
      name: room.players.find((rp) => rp.id === p.id)?.name || 'Unknown',
      lives: p.lives,
      eliminated: p.eliminated,
    })),
  };

  // Each mode advertises its own prompt + history fields.
  if (game.gameType === 'category-blitz') {
    payload.category = game.currentCategory;
    payload.usedAnswers = Array.from(game.usedAnswers);
  } else {
    payload.combo = game.currentCombo;
    payload.usedWords = Array.from(game.usedWords);
  }

  return { type: 'turn_update', payload };
}

function buildGameOverPayload(room) {
  const { game } = room;
  const payload = { winnerId: game.winnerId };

  // Surface the right "everything that was played" list for the mode, so
  // building game_over never touches a field the other mode doesn't have.
  if (game.gameType === 'category-blitz') {
    payload.usedAnswers = Array.from(game.usedAnswers);
  } else {
    payload.usedWords = Array.from(game.usedWords);
  }

  return { type: 'game_over', payload };
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
  broadcastToRoom(room, buildTurnUpdatePayload(room));
  startTurnTimer(room);
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
  if (!game || game.status !== 'in_progress') {
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

function removePlayer(room, connectionId) {
  room.players = room.players.filter((p) => p.id !== connectionId);

  if (room.players.length === 0) {
    clearTurnTimer(room);
    rooms.delete(room.code);
    return;
  }

  // Reassign host if the host left.
  if (room.hostId === connectionId) {
    room.hostId = room.players[0].id;
  }

  // If a game is in progress, treat the disconnect like the player
  // timing out repeatedly until eliminated, so the game doesn't hang
  // waiting forever on someone who left.
  if (room.game && room.game.status === 'in_progress') {
    const player = room.game.players.find((p) => p.id === connectionId);
    if (player) {
      player.eliminated = true;
      player.lives = 0;
    }
    if (getCurrentPlayerId(room.game) === connectionId) {
      clearTurnTimer(room);
      advanceTurn(room.game);
      if (room.game.status === 'finished') {
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
  handleWordSubmission,
  removePlayer,
  broadcastToRoom,
  buildRoomUpdatePayload,
  buildTurnUpdatePayload,
  buildGameOverPayload,
  clearTurnTimer,
  startTurnTimer,
};
