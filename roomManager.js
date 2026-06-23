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
const imposterWordLogic = require('./imposterWordLogic');

/**
 * Returns the logic module (createGame/submit*) for a given game type.
 * Defaults to Word Bomb for anything unrecognized so an old/missing
 * gameType can never leave a room without a logic module.
 */
function logicForGameType(gameType) {
  if (gameType === 'category-blitz') return categoryBlitzLogic;
  if (gameType === 'imposter-word') return imposterWordLogic;
  return wordBombLogic;
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

/* ============================================================= */
/* ===============  IMPOSTER WORD ORCHESTRATION  =============== */
/* ============================================================= */
// Imposter Word reuses the room's roundTimer / roundPause / countdown slots
// (a room only ever runs one game at a time), so clearRoundTimer already tears
// it all down on reset / disconnect. Each round has two timed phases:
// answering -> voting, then a reveal pause that starts the next round (or ends).

// Reveal sits a touch longer than the spec's 5s so the frontend can play the
// ~2s "THE IMPOSTER WAS..." suspense AND its 5s countdown to the next round.
const IMPOSTER_REVEAL_PAUSE_MS = 7000;

/**
 * Starts a round: sends each player their OWN round_start (the imposter sees a
 * different category from everyone else, so these can't be one broadcast), then
 * starts the answer-phase timer once the 3-2-1 countdown has played.
 */
function startImposterRound(room) {
  const { game } = room;
  const roster = game.players.map((gp) => ({ id: gp.id, name: gp.name }));
  room.players.forEach((p) => {
    if (p.connection.readyState !== 1) return;
    const isImposter = p.id === game.imposterId;
    p.connection.send(
      JSON.stringify({
        type: 'round_start',
        payload: {
          round: game.currentRound,
          totalRounds: game.rounds,
          category: isImposter ? game.imposterCategory : game.currentCategory,
          isImposter,
          phase: 'answering',
          timerSeconds: game.answerPhaseSeconds,
          players: roster,
        },
      })
    );
  });
  scheduleTimerAfterCountdown(room, startImposterAnswerTimer);
}

/** Answer phase countdown: broadcasts a tick a second, ends the phase at 0. */
function startImposterAnswerTimer(room) {
  clearRoundTimer(room);
  const { game } = room;
  let remaining = game.answerPhaseSeconds;
  room.roundDeadline = Date.now() + remaining * 1000;
  room.roundTimerInterval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearRoundTimer(room);
      endImposterAnswerPhase(room);
      return;
    }
    broadcastToRoom(room, { type: 'timer_tick', payload: { secondsRemaining: remaining } });
  }, 1000);
}

/** Closes answering, reveals everyone's answers, and opens voting. */
function endImposterAnswerPhase(room) {
  const { game } = room;
  const result = imposterWordLogic.endAnswerPhase(game);
  broadcastToRoom(room, {
    type: 'vote_phase_start',
    payload: {
      answers: result.answers,
      timerSeconds: result.timerSeconds,
      phase: 'voting',
      players: game.players.map((p) => ({ id: p.id, name: p.name })),
    },
  });
  startImposterVoteTimer(room);
}

/** Vote phase countdown: ends at 0 (handleImposterVote ends it early if all in). */
function startImposterVoteTimer(room) {
  clearRoundTimer(room);
  const { game } = room;
  let remaining = game.votePhaseSeconds;
  room.roundDeadline = Date.now() + remaining * 1000;
  room.roundTimerInterval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearRoundTimer(room);
      endImposterVotePhase(room);
      return;
    }
    broadcastToRoom(room, { type: 'timer_tick', payload: { secondsRemaining: remaining } });
  }, 1000);
}

/** Tallies votes, broadcasts the reveal, then schedules the next round / game over. */
function endImposterVotePhase(room) {
  clearRoundTimer(room);
  const { game } = room;
  const reveal = imposterWordLogic.endVotePhase(game);
  broadcastToRoom(room, { type: 'vote_results', payload: { ...reveal, phase: 'reveal' } });

  room.roundPauseTimeout = setTimeout(() => {
    room.roundPauseTimeout = null;
    const next = imposterWordLogic.startNextRound(game);
    if (next === null) {
      broadcastToRoom(room, {
        type: 'game_over',
        payload: { gameType: 'imposter-word', ...imposterWordLogic.getResults(game) },
      });
    } else {
      startImposterRound(room);
    }
  }, IMPOSTER_REVEAL_PAUSE_MS);
}

/**
 * Handles an Imposter Word answer. Unlike the other modes, answers are PUBLIC:
 * the accept/reject goes back to the submitter, and on acceptance the answer is
 * broadcast to everyone in real time (that's how the imposter reverse-engineers
 * the category). No turn check, no algorithmic validation - players judge.
 */
function handleImposterAnswer(room, connectionId, answer) {
  const { game } = room;
  if (!game || game.gameType !== 'imposter-word') {
    return { error: 'no_active_game' };
  }
  if (game.status !== 'answering') {
    return { error: 'round_not_active' };
  }
  const result = imposterWordLogic.submitAnswer(game, connectionId, answer);

  const connection = room.players.find((p) => p.id === connectionId)?.connection;
  if (connection && connection.readyState === 1) {
    connection.send(JSON.stringify({ type: 'answer_result', payload: result }));
  }

  if (result.accepted) {
    const player = game.players.find((p) => p.id === connectionId);
    broadcastToRoom(room, {
      type: 'imposter_answer',
      payload: {
        playerId: connectionId,
        playerName: player ? player.name : 'Someone',
        answer: result.answer,
      },
    });
  }

  return { result };
}

/**
 * Handles an Imposter Word vote. The accept/reject goes back to the voter, and
 * a privacy-safe vote_count (how many have voted, not who for whom) is broadcast
 * so the UI can show progress. When everyone has voted the phase ends early.
 */
function handleImposterVote(room, connectionId, suspectId) {
  const { game } = room;
  if (!game || game.gameType !== 'imposter-word') {
    return { error: 'no_active_game' };
  }
  if (game.status !== 'voting') {
    return { error: 'round_not_active' };
  }
  const result = imposterWordLogic.submitVote(game, connectionId, suspectId);

  const connection = room.players.find((p) => p.id === connectionId)?.connection;
  if (connection && connection.readyState === 1) {
    connection.send(JSON.stringify({ type: 'vote_result', payload: result }));
  }

  if (result.accepted) {
    const tally = imposterWordLogic.countVotes(game);
    broadcastToRoom(room, { type: 'vote_count', payload: tally });
    if (tally.voted >= tally.total) {
      endImposterVotePhase(room); // everyone's in - don't wait out the clock
    }
  }

  return { result };
}

function startGame(room) {
  // Solo Category Blitz: one player racing the clock alone. Auto-detected when
  // a category-blitz room has exactly one player - no separate flag needed from
  // the frontend - and it bypasses the usual 2-player minimum.
  const isSoloCategoryBlitz =
    room.gameType === 'category-blitz' && room.players.length === 1;

  if (!isSoloCategoryBlitz) {
    // Imposter Word needs at least 3 (a 2-player imposter round is pointless);
    // the other modes start at the shared 2-player minimum.
    const minPlayers =
      room.gameType === 'imposter-word'
        ? imposterWordLogic.MIN_PLAYERS_TO_START
        : MIN_PLAYERS_TO_START;
    if (room.players.length < minPlayers) {
      return { error: 'not_enough_players' };
    }
  }

  // Tear down any timers left over from a previous game before starting a fresh
  // one. This matters for the solo "PLAY AGAIN" loop: a player can fire
  // start_game again while the just-finished game's between-rounds pause is
  // still pending, and a stale timeout firing onto the new game would corrupt
  // it. clearRoundTimer/clearTurnTimer also clear the pending countdown.
  clearTurnTimer(room);
  clearRoundTimer(room);

  const logic = logicForGameType(room.gameType);
  room.game = logic.createGame(
    room.players.map((p) => ({ id: p.id, name: p.name })),
    room.difficultyKey,
    isSoloCategoryBlitz
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
  } else if (room.gameType === 'imposter-word') {
    // Social deduction: each player gets their OWN round_start (the imposter
    // sees a different prompt), then the answer-phase timer after the countdown.
    startImposterRound(room);
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

  // Imposter Word answers are public and judged by players - its own handler.
  if (game.gameType === 'imposter-word') {
    return handleImposterAnswer(room, connectionId, word);
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
  } else if (game && game.gameType === 'imposter-word') {
    // Also simultaneous-ish: drop the leaver from the roster and the imposter
    // rotation order. The current phase timer keeps running for everyone else.
    if (Array.isArray(game.players)) {
      game.players = game.players.filter((p) => p.id !== connectionId);
    }
    if (Array.isArray(game.order)) {
      game.order = game.order.filter((id) => id !== connectionId);
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
  handleImposterVote,
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
