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
  getActivePlayers,
  handleTimeout,
  advanceTurn,
  MIN_PLAYERS_TO_START,
} = require('./gameLogic');

const wordBombLogic = require('./gameLogic');
const categoryBlitzLogic = require('./categoryBlitzLogic');
const imposterWordLogic = require('./imposterWordLogic');

// Solo Word Bomb bot opponent. wordBombBot supplies the fake player (with a
// mock sink connection), the valid-word lookup, and the difficulty timing; the
// dictionary's markAsValid lets us pre-warm the cache for a bot's chosen word so
// its submission resolves instantly and is guaranteed accepted.
const wordBombBot = require('./wordBombBot');
const { markAsValid } = require('./dictionary');

// Structured logging (level/event/roomCode/playerId JSON lines). logError also
// forwards to Sentry, so the guarded failure paths below report with context.
const { logInfo, logWarn, logError } = require('./logger');

// Category Blitz bot opponent. Same shape as the Word Bomb bot (mock sink
// connection, normal roster entry) but no AI anywhere: it draws answers from
// the category's pre-generated accept-list, so its submissions always resolve
// on the free Stage-1 lookup and never touch the Haiku judge.
const categoryBlitzBot = require('./categoryBlitzBot');

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

/**
 * True when the room has a LIVE (unfinished) game, in ANY mode's sense of
 * "live". Word Bomb's live game is always status 'in_progress', but Category
 * Blitz also lives in 'between_rounds', and Imposter Word never uses
 * 'in_progress' at all (answering/voting/reveal/between_rounds). Guards that
 * mean "is a game running right now" must use this, not a raw in_progress
 * check - keying off in_progress let players join/mutate/restart mid-game
 * during every non-in_progress live phase.
 */
function isGameLive(room) {
  return !!room.game && room.game.status !== 'finished';
}

const ROOM_CODE_LENGTH = 5;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid ambiguity

// Max players a single room holds. Was a bare literal in joinRoom; pulled out so
// the join guard and the public-rooms list/quick-play share one source of truth.
const MAX_PLAYERS_PER_ROOM = 8;

// Delay before a game/round timer actually starts ticking, so the frontend's
// 3-2-1-GO countdown (~2.8s) can finish first. Slightly longer than the
// countdown to be safe. The round_start / turn_update message is still sent
// immediately so the countdown can play; only the timer waits.
const COUNTDOWN_DELAY_MS = 3000;

// Category Blitz: a category reroll is only allowed in the opening window of an
// actively-running round (anti-grief - no yanking the category mid-round).
const REROLL_WINDOW_MS = 5000;

// ---- Room lifecycle safety (single-instance, in-memory) ----
// A non-empty room with no meaningful activity for this long is treated as a
// dead lobby and reaped - UNLESS it's mid-game (an in_progress game is never
// reaped). Empty rooms are still deleted immediately by removePlayer; this only
// catches the still-connected-but-idle ones. Tune ROOM_IDLE_TTL_MS to taste.
const ROOM_IDLE_TTL_MS = 20 * 60 * 1000; // 20 minutes idle
const REAPER_SWEEP_MS = 60 * 1000; // sweep once a minute
// Hard ceiling on concurrent rooms - a backstop against create-spam exhausting
// memory. createRoom refuses past this with a 'server_busy' error.
const MAX_ACTIVE_ROOMS = 500;

const rooms = new Map(); // roomCode -> room object

// Marks a room as alive. Call from the events that prove a room is in active use
// (see the call sites: join, leave, game start, an accepted submission, rematch)
// so the idle reaper only ever removes genuinely dead lobbies. One helper, one
// call per event site, so the "alive" set stays consistent and easy to audit.
function touchRoom(room) {
  if (room) room.lastActivity = Date.now();
}

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
function createRoom(hostConnection, hostName, isPublic = false) {
  // Global cap backstop (DoS guard). The caller surfaces 'server_busy' to the
  // client rather than crashing or silently dropping.
  if (rooms.size >= MAX_ACTIVE_ROOMS) {
    return { error: 'server_busy' };
  }
  const code = generateRoomCode();
  const now = Date.now();
  const room = {
    code,
    hostId: hostConnection.id,
    players: [{ id: hostConnection.id, name: hostName, connection: hostConnection }],
    game: null,
    // Discoverability: private rooms (default) are code-only and never appear in
    // the public list / quick-play; public rooms are joinable by anyone. Set once
    // at creation - nothing mutates it later.
    isPublic: !!isPublic,
    difficultyKey: 'medium',
    gameType: 'word-bomb', // 'word-bomb' | 'category-blitz'
    // Activity timestamps for the idle reaper. createdAt is fixed; lastActivity
    // is bumped via touchRoom() on every meaningful room event.
    createdAt: now,
    lastActivity: now,
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
    // Pending solo-bot "submit a word" setTimeout, if the current turn is a bot.
    botMoveTimeout: null,
    // Pending Category Blitz bot "submit an answer" setTimeouts for the current
    // round (one per planned answer). Cleared with the round timer.
    blitzBotTimeouts: [],
  };
  rooms.set(code, room);
  logInfo('room_created', { roomCode: code, playerId: hostConnection.id, isPublic: room.isPublic });
  return { room };
}

function joinRoom(code, connection, playerName) {
  const room = rooms.get(code);
  if (!room) {
    return { error: 'room_not_found' };
  }
  // Live in ANY phase (not just in_progress - see isGameLive): joining a
  // Blitz intermission or an Imposter round produced a ghost roster entry
  // (in room.players but not game.players) that got broadcasts but couldn't
  // play or score. A FINISHED game still joins like a lobby.
  if (isGameLive(room)) {
    return { error: 'game_already_started' };
  }
  if (room.players.length >= MAX_PLAYERS_PER_ROOM) {
    return { error: 'room_full' };
  }
  room.players.push({ id: connection.id, name: playerName, connection });
  touchRoom(room); // a join proves the room is alive
  return { room };
}

function getRoom(code) {
  return rooms.get(code);
}

/**
 * Returns the list of joinable PUBLIC rooms for the lobby browser. A room is
 * listed only if it's public AND waiting (no game object yet) AND not full.
 * In-progress, finished, and private rooms are all excluded - so every entry
 * here is something a player can actually join right now. `status` is always
 * 'waiting' by construction; it's included so the client doesn't have to infer
 * it. No connections/internal fields leak - just the display-safe summary.
 */
function listPublicRooms() {
  const out = [];
  for (const room of rooms.values()) {
    if (!room.isPublic) continue;
    if (room.game !== null) continue; // waiting only (excludes in-progress/finished)
    if (room.players.length >= MAX_PLAYERS_PER_ROOM) continue; // not full
    out.push({
      code: room.code,
      playerCount: room.players.length,
      maxPlayers: MAX_PLAYERS_PER_ROOM,
      gameType: room.gameType,
      status: 'waiting',
    });
  }
  return out;
}

/**
 * Quick Play: drop the player straight into a game. Ranks all public waiting
 * rooms fullest-first (fill rooms up rather than scatter players thin), then
 * tries to join each in turn. The actual not-full / not-started guard is
 * joinRoom's - so if the top candidate fills up or starts between our snapshot
 * and the join attempt, that join just errors and we fall through to the next
 * candidate (race-safe, no locking needed on a single instance).
 *
 * If nothing joinable exists, creates a fresh PUBLIC room so the player still
 * lands somewhere (and others can quick-play into it next). The create path is
 * gated by `allowCreate` (the caller's per-connection create throttle) so
 * quick-play can't be abused to spam the registry; createRoom's global cap is
 * the final backstop. Returns { room, created } on success, or { error }.
 */
function quickPlay(connection, playerName, allowCreate) {
  const candidates = [];
  for (const room of rooms.values()) {
    if (!room.isPublic) continue;
    if (room.game !== null) continue; // waiting only
    candidates.push(room);
  }
  // Fullest-not-full first. Full rooms may still be in here (snapshot race); we
  // let joinRoom reject them and move on rather than pre-filtering, so the
  // "retry next candidate on a full/started race" behavior is the same code
  // path whether the room filled a tick ago or mid-loop.
  candidates.sort((a, b) => b.players.length - a.players.length);
  for (const room of candidates) {
    const res = joinRoom(room.code, connection, playerName);
    if (!res.error) return { room: res.room, created: false };
    // room_full / game_already_started / room_not_found => try the next one.
  }

  // Nothing to join - make a new public room (subject to the create throttle).
  if (typeof allowCreate === 'function' && !allowCreate()) {
    return { error: 'rate_limited' };
  }
  const res = createRoom(connection, playerName, true);
  if (res.error) return { error: res.error };
  return { room: res.room, created: true };
}

function broadcastToRoom(room, message) {
  const payload = JSON.stringify(message);
  room.players.forEach((p) => {
    // Per-recipient try/catch: readyState can flip between the check and the
    // send (socket teardown race), and one bad socket must not abort the rest
    // of the room's broadcast — or, when called from a timer, crash the process.
    try {
      if (p.connection.readyState === 1 /* WebSocket.OPEN */) {
        p.connection.send(payload);
      }
    } catch (err) {
      logWarn('broadcast_send_failed', { roomCode: room.code, playerId: p.id, msgType: message.type }, err);
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
      // Category Blitz: host-selected packs (null = all). Lets every client mirror
      // the host's pack choice in the lobby. null until the host sends set_packs.
      selectedPacks: room.selectedPacks || null,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        // Surfaced so the lobby can mark the bot and offer a REMOVE BOT control;
        // botDifficulty (easy|medium|hard) is the bot's own skill, shown on its card.
        ...(p.isBot ? { isBot: true, botDifficulty: p.botDifficulty || 'medium' } : {}),
      })),
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

  // guardRoom: a throw in here (corrupt game state, a bad payload builder)
  // would otherwise hit uncaughtException and take down the whole process.
  room.turnTimerInterval = setInterval(() => guardRoom(room, 'turn_timer_error', () => {
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
  }), 1000);

  // If the player who just gained the turn is a bot, line up its move within
  // this timer window. No-op for human turns.
  maybeScheduleBotMove(room);
}

function clearTurnTimer(room) {
  if (room.turnTimerInterval) {
    clearInterval(room.turnTimerInterval);
    room.turnTimerInterval = null;
  }
  clearCountdownTimeout(room);
  clearBotMove(room);
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
    // Timer context: a throw in the start function must fail this room only.
    guardRoom(room, 'countdown_start_error', () => startFn(room));
  }, COUNTDOWN_DELAY_MS);
}

/**
 * Category Blitz round timer. Counts down game.roundTimeSeconds, broadcasting
 * a timer_tick every second (same shape as the Word Bomb turn timer). When
 * time runs out it ends the round, broadcasts round_end with everyone's
 * results (the endRound snapshot, including sampleAnswers - acceptable
 * answers nobody gave), then after a 5-second intermission either advances to the next
 * round (round_start + a fresh round timer) or, if all rounds are done,
 * broadcasts game_over with the final scoreboard.
 */
function startRoundTimer(room) {
  clearRoundTimer(room);

  const { game } = room;
  let remaining = game.roundTimeSeconds;
  room.roundDeadline = Date.now() + remaining * 1000;
  // Wall-clock moment this round actually started ticking - used to enforce the
  // reroll opening window (rerolls are only allowed in the first few seconds).
  room.roundStartedAt = Date.now();

  // guardRoom on the tick AND the intermission: both mutate game state from a
  // timer, so an unexpected throw must fail this room, not the process.
  room.roundTimerInterval = setInterval(() => guardRoom(room, 'round_timer_error', () => {
    remaining -= 1;

    if (remaining <= 0) {
      clearRoundTimer(room);

      const results = categoryBlitzLogic.endRound(game);
      broadcastToRoom(room, { type: 'round_end', payload: results });

      // Intermission so players can read the round results before the next
      // category drops (or the game ends).
      room.roundPauseTimeout = setTimeout(() => guardRoom(room, 'round_intermission_error', () => {
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
      }), 5000);

      return;
    }

    broadcastToRoom(room, { type: 'timer_tick', payload: { secondsRemaining: remaining } });
  }), 1000);

  // Line up this round's bot answers (if any bots are in the room) against the
  // clock that just started ticking. No-op for bot-less rooms.
  scheduleBlitzBotAnswers(room);
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
  clearBlitzBotTimers(room);
}

/** Cancels every pending Category Blitz bot answer for the current round. */
function clearBlitzBotTimers(room) {
  if (Array.isArray(room.blitzBotTimeouts)) {
    room.blitzBotTimeouts.forEach((handle) => clearTimeout(handle));
  }
  room.blitzBotTimeouts = [];
}

/**
 * Plans and schedules the round's bot answers for every bot in a Category
 * Blitz room. Called from startRoundTimer, so the schedule always tracks the
 * real clock: a new round, a reroll, or a rematch each re-plans from scratch,
 * and clearRoundTimer (round end, reroll, reset, room teardown) cancels every
 * pending answer - a bot can never submit after the round ends or during the
 * between-rounds intermission. Each answer goes through the SAME
 * handleCategoryAnswer path a human uses; because it's drawn from the
 * category's accept-list, Stage-1 validation accepts it with no AI call.
 */
function scheduleBlitzBotAnswers(room) {
  const { game } = room;
  if (!game || game.gameType !== 'category-blitz' || game.status !== 'in_progress') return;

  clearBlitzBotTimers(room);

  const roundCategory = game.currentCategory;
  room.players.filter((p) => p.isBot).forEach((bot) => {
    const offsets = categoryBlitzBot.buildAnswerSchedule(
      bot.botDifficulty || 'medium',
      game.roundTimeSeconds
    );
    offsets.forEach((delayMs) => {
      const handle = setTimeout(async () => {
        // Whole body in try/catch (not just the await): this runs on a timer,
        // so even a throw in the guards below would otherwise crash the
        // process. A bot hiccup only costs the bot its beat - the round and
        // the room carry on - so this logs rather than failing the room.
        try {
          // The world may have moved on while we waited (round ended, category
          // rerolled, game reset, bot removed) - re-check before touching anything.
          // clearBlitzBotTimers already cancels on those paths; these guards make
          // a stray timer harmless even if a new cleanup path forgets to.
          if (!room.game || room.game.gameType !== 'category-blitz') return;
          if (room.game.status !== 'in_progress') return;
          if (room.game.currentCategory !== roundCategory) return;
          if (!room.players.some((p) => p.id === bot.id)) return;

          const gamePlayer = room.game.players.find((p) => p.id === bot.id);
          if (!gamePlayer) return;

          const answer = categoryBlitzBot.pickAnswer(roundCategory, gamePlayer.answers);
          if (!answer) return; // no accept-list / nothing left -> the bot blanks this beat

          await handleCategoryAnswer(room, bot.id, answer);
        } catch (err) {
          logError('blitz_bot_answer_failed', { roomCode: room.code, playerId: bot.id }, err);
        }
      }, delayMs);
      room.blitzBotTimeouts.push(handle);
    });
  });
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
    // Per-recipient try/catch, same rationale as broadcastToRoom: one torn-down
    // socket must not stop the other players from receiving their round.
    try {
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
    } catch (err) {
      logWarn('round_start_send_failed', { roomCode: room.code, playerId: p.id }, err);
    }
  });
  scheduleTimerAfterCountdown(room, startImposterAnswerTimer);
}

/** Answer phase countdown: broadcasts a tick a second, ends the phase at 0. */
function startImposterAnswerTimer(room) {
  clearRoundTimer(room);
  const { game } = room;
  let remaining = game.answerPhaseSeconds;
  room.roundDeadline = Date.now() + remaining * 1000;
  room.roundTimerInterval = setInterval(() => guardRoom(room, 'imposter_answer_timer_error', () => {
    remaining -= 1;
    if (remaining <= 0) {
      clearRoundTimer(room);
      endImposterAnswerPhase(room);
      return;
    }
    broadcastToRoom(room, { type: 'timer_tick', payload: { secondsRemaining: remaining } });
  }), 1000);
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
  room.roundTimerInterval = setInterval(() => guardRoom(room, 'imposter_vote_timer_error', () => {
    remaining -= 1;
    if (remaining <= 0) {
      clearRoundTimer(room);
      endImposterVotePhase(room);
      return;
    }
    broadcastToRoom(room, { type: 'timer_tick', payload: { secondsRemaining: remaining } });
  }), 1000);
}

/** Tallies votes, broadcasts the reveal, then schedules the next round / game over. */
function endImposterVotePhase(room) {
  clearRoundTimer(room);
  const { game } = room;
  const reveal = imposterWordLogic.endVotePhase(game);
  broadcastToRoom(room, { type: 'vote_results', payload: { ...reveal, phase: 'reveal' } });

  room.roundPauseTimeout = setTimeout(() => guardRoom(room, 'imposter_reveal_pause_error', () => {
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
  }), IMPOSTER_REVEAL_PAUSE_MS);
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
    touchRoom(room); // an accepted answer proves the room is alive
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

/* ============================================================= */
/* ==================  SOLO BOT OPPONENT (ADD/REMOVE)  ========= */
/* ============================================================= */

// Which bot module builds the roster entry for each game mode. Modes absent
// here (imposter-word - a bot can't bluff or vote) don't support bots at all.
const BOT_FACTORY_BY_GAME_TYPE = {
  'word-bomb': wordBombBot,
  'category-blitz': categoryBlitzBot,
};

/**
 * Adds a single bot opponent to a solo Word Bomb or Category Blitz room at the
 * requested difficulty. Explicit (player-triggered via add_bot), NOT automatic -
 * a lone player chooses to play a bot rather than one being forced on them. The
 * bot is a normal roster entry with a mock connection, so it renders like any
 * player and submits through the same path humans use. Its `botDifficulty` is
 * independent of the room's difficulty setting and drives only the bot's own
 * behavior (Word Bomb: speed/miss rate; Blitz: answers-per-round and pacing).
 *
 * Guards: a bot-supporting mode only, no live game, exactly one human, and no
 * bot already present. Returns { ok } or { error }.
 */
function addBot(room, difficulty) {
  if (!room) return { error: 'no_room' };
  if (isGameLive(room)) return { error: 'game_already_started' };
  const botFactory = BOT_FACTORY_BY_GAME_TYPE[room.gameType];
  if (!botFactory) return { error: 'bot_mode_unsupported' };
  if (room.players.some((p) => p.isBot)) return { error: 'bot_already_added' };
  if (room.players.filter((p) => !p.isBot).length !== 1) return { error: 'bot_solo_only' };

  room.players.push(botFactory.createBotPlayer(difficulty));
  return { ok: true };
}

/**
 * Removes the bot from a room (the player kicked it before starting, or a game
 * teardown wants a clean roster). No-op if there's no bot. Returns { ok }.
 */
function removeBot(room) {
  if (!room) return { error: 'no_room' };
  if (isGameLive(room)) return { error: 'game_already_started' };
  room.players = room.players.filter((p) => !p.isBot);
  return { ok: true };
}

/** Clears a pending bot move so two can never race onto the same/next turn. */
function clearBotMove(room) {
  if (room.botMoveTimeout) {
    clearTimeout(room.botMoveTimeout);
    room.botMoveTimeout = null;
  }
}

/**
 * If it's a bot's turn, schedule its move. The bot waits a difficulty-scaled
 * fraction of the turn timer, then submits a real valid word through the SAME
 * handleWordSubmission path a human uses. A difficulty-scaled "miss" chance (or
 * the rare case of no available word) makes it do nothing instead, letting the
 * normal turn timeout fire and cost it a life. Any previously scheduled bot move
 * is cleared first. Word Bomb only; a no-op when the current player is human.
 */
function maybeScheduleBotMove(room) {
  const { game } = room;
  if (!game || game.gameType !== 'word-bomb' || game.status !== 'in_progress') return;

  clearBotMove(room);

  const currentId = getCurrentPlayerId(game);
  const rosterEntry = room.players.find((p) => p.id === currentId);
  if (!rosterEntry || !rosterEntry.isBot) return;

  // The bot's skill is its OWN difficulty (chosen when it was added), independent
  // of the room's timer difficulty. Fall back to medium if somehow unset.
  const botDifficulty = rosterEntry.botDifficulty || 'medium';

  // Choke this turn: do nothing, the running turn timer will time it out.
  if (wordBombBot.rollMiss(botDifficulty)) return;

  const delayMs = wordBombBot.computeDelayMs(botDifficulty, game.currentTimerSeconds);
  room.botMoveTimeout = setTimeout(async () => {
    // Whole body in try/catch (not just the await) - timer context, so a throw
    // anywhere in here must never reach uncaughtException. A failed bot move is
    // just a miss: the running turn timer times the bot out normally.
    try {
      room.botMoveTimeout = null;
      // The world may have moved on while we waited (turn advanced, game ended,
      // room torn down) - re-check before touching anything.
      if (!room.game || room.game.status !== 'in_progress') return;
      if (getCurrentPlayerId(room.game) !== currentId) return;

      const word = wordBombBot.pickWord(room.game.currentCombo, room.game.usedWords);
      if (!word) return; // nothing available -> treat as a miss

      // The bot only picks from a curated real-word list, so pre-warm the
      // dictionary cache: submitWord's validity check then resolves instantly with
      // no API round-trip, and the word is guaranteed to be accepted.
      markAsValid(word);
      await handleWordSubmission(room, currentId, word);
    } catch (err) {
      logError('bot_move_failed', { roomCode: room.code, playerId: currentId }, err);
    }
  }, delayMs);
}

function startGame(room) {
  // Double-fire / mid-game restart guard: a second start_game while a game is
  // LIVE (any unfinished status - see isGameLive) must not silently discard
  // the running game and re-init it, wiping everyone's progress and firing a
  // duplicate game_started. The solo PLAY-AGAIN loop is unaffected: it only
  // refires start_game after the previous game reached status 'finished'
  // (the leftover-timer teardown below still covers its pending intermission).
  if (isGameLive(room)) {
    return { error: 'game_already_started' };
  }

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
    isSoloCategoryBlitz,
    room.selectedPacks // Category Blitz only: host-selected packs (undefined until set_packs); other modes ignore it
  );
  // Stamp the type onto the game so payload builders and submission routing
  // know which mode this in-progress game is, independent of the room.
  room.game.gameType = room.gameType;
  touchRoom(room); // starting a game proves the room is alive
  logInfo('game_started', {
    roomCode: room.code,
    gameType: room.gameType,
    players: room.players.length,
  });
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
        rerollsRemaining: room.game.rerollsRemaining,
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
    touchRoom(room); // an accepted word proves the room is alive
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

  // The submitter's own connection - used both for the interim "checking..."
  // notice (when an answer goes to the AI judge) and the final result. Resolved
  // before the await so the onAiCheck callback can fire mid-validation.
  const connection = room.players.find((p) => p.id === connectionId)?.connection;

  const result = await categoryBlitzLogic.submitAnswer(game, connectionId, answer, {
    // Fires only on a list-miss with AI enabled, right before the ~0.5-1.5s Haiku
    // call. Tells the submitter to show a brief loading state; the authoritative
    // answer_result below always follows.
    onAiCheck: () => {
      if (connection && connection.readyState === 1) {
        connection.send(JSON.stringify({ type: 'answer_checking', payload: { answer } }));
      }
    },
  });

  // Private result back to the submitter only.
  if (connection && connection.readyState === 1) {
    connection.send(JSON.stringify({ type: 'answer_result', payload: result }));
  }

  // Public progress (count only) when the answer actually landed - the count
  // is the only thing that changes, and it reveals nothing about the answer.
  if (result.accepted) {
    touchRoom(room); // an accepted answer proves the room is alive
    const player = game.players.find((p) => p.id === connectionId);
    broadcastToRoom(room, {
      type: 'player_progress',
      payload: { playerId: connectionId, answerCount: player ? player.answers.length : 0 },
    });
  }

  return { result };
}

/**
 * Rerolls the current Category Blitz round's category - implemented as a fully
 * server-authoritative ROUND RESTART, not an in-place swap, so clients can never
 * drift. The server owns everything: it validates, mutates state, then tells
 * every client (host included) to start the round over via the SAME round_start
 * path they already handle. Clients change nothing locally on the click.
 *
 * Validates: sender is host (or the lone solo player), the round is actively
 * ticking, we're still inside the opening window (REROLL_WINDOW_MS), and rerolls
 * remain. On success the round restarts on a fresh category with a full clock
 * and everyone's answers/this-round points cleared (handled in rerollCategory).
 *
 * The broadcast carries `reroll: true` (drives the non-host notice) and keeps
 * the SAME round number, so clients don't replay the 3-2-1 countdown; and unlike
 * a normal next round it starts the timer immediately (no countdown delay).
 */
function handleRerollCategory(room, connectionId) {
  const { game } = room;
  if (!game || game.gameType !== 'category-blitz') {
    return { error: 'no_active_game' };
  }
  if (game.status !== 'in_progress') {
    return { error: 'round_not_active' };
  }
  const isSolo = room.players.length === 1;
  if (!isSolo && room.hostId !== connectionId) {
    return { error: 'host_only_reroll' };
  }
  // The round must be actively ticking (not mid-countdown or between rounds)...
  if (!room.roundTimerInterval || room.roundStartedAt == null) {
    return { error: 'round_not_active' };
  }
  // ...and we must still be inside the opening window.
  if (Date.now() - room.roundStartedAt >= REROLL_WINDOW_MS) {
    return { error: 'reroll_window_closed' };
  }
  if (game.rerollsRemaining <= 0) {
    return { error: 'no_rerolls_left' };
  }

  const result = categoryBlitzLogic.rerollCategory(game);
  if (result.error) {
    return { error: result.error };
  }

  // Stop the current round timer, broadcast the authoritative restart to ALL
  // clients over the round_start path, then start the new full-length timer.
  clearRoundTimer(room);
  const byName = room.players.find((p) => p.id === connectionId)?.name || 'Host';
  broadcastToRoom(room, {
    type: 'round_start',
    payload: { ...result, reroll: true, by: byName, byId: connectionId },
  });
  startRoundTimer(room);

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
  // The bot (if the player added one) stays in the roster across a rematch, so
  // they can start again straight away or remove it from the lobby.
  touchRoom(room); // a rematch proves the room is alive
  broadcastToRoom(room, buildRoomUpdatePayload(room));
  broadcastToRoom(room, { type: 'game_reset', payload: {} });
}

// Single source of truth for tearing a room down: clears every timer it might
// own and removes it from the registry. Used by the empty-room path below AND
// the idle reaper, so timer-clearing is never duplicated. (clearTurnTimer /
// clearRoundTimer each also clear the countdown timeout, but calling all three
// is explicit and idempotent.)
function destroyRoom(room) {
  clearTurnTimer(room);
  clearRoundTimer(room);
  clearCountdownTimeout(room);
  rooms.delete(room.code);
  logInfo('room_destroyed', { roomCode: room.code });
}

/**
 * Last-resort containment for an unexpected throw on a room's timer/async path
 * (anything NOT already covered by the WS message handler's try/catch). By the
 * time this runs the room's game state can't be trusted, so rather than letting
 * the error reach uncaughtException — which exits the process and kills EVERY
 * room on the instance — we log it with context, tell the players
 * (room_closed reason 'server_error'; the frontend routes home with a friendly
 * notice), and tear this one room down. Blast radius: one room, not the server.
 */
function failRoom(room, event, err) {
  logError(event, { roomCode: room && room.code }, err);
  if (!room) return;
  try {
    broadcastToRoom(room, {
      type: 'room_closed',
      payload: { code: room.code, reason: 'server_error' },
    });
  } catch {
    /* broadcast is per-socket safe already; belt and braces */
  }
  try {
    destroyRoom(room);
  } catch (teardownErr) {
    // Even if timer cleanup threw, the registry entry MUST go, or the broken
    // room would sit there failing forever.
    logError('room_teardown_failed', { roomCode: room.code }, teardownErr);
    rooms.delete(room.code);
  }
}

/**
 * Runs a timer-driven step for a room; an unexpected throw fails that room
 * cleanly (see failRoom) instead of crashing the process. Every setInterval /
 * setTimeout body that mutates game state goes through this.
 */
function guardRoom(room, event, fn) {
  try {
    fn();
  } catch (err) {
    failRoom(room, event, err);
  }
}

function removePlayer(room, connectionId) {
  room.players = room.players.filter((p) => p.id !== connectionId);

  if (room.players.length === 0) {
    destroyRoom(room);
    return;
  }

  // If only bot(s) remain, the lone human left their solo game - don't leave a
  // bot playing by itself. Tear the whole room (and its timers) down.
  if (room.players.every((p) => p.isBot)) {
    destroyRoom(room);
    return;
  }

  touchRoom(room); // a leave (with players remaining) proves the room is alive

  // Reassign host if the host left. Never hand the role to a bot (a bot host
  // can't start/reroll/rematch, bricking the room - reachable because a room
  // holding a solo player's bot is still joinable by a second human). A
  // non-bot always exists here: the every-bot case destroyed the room above.
  if (room.hostId === connectionId) {
    room.hostId = (room.players.find((p) => !p.isBot) || room.players[0]).id;
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
    } else if (getActivePlayers(game).length <= 1) {
      // The leaver wasn't the current player, but their elimination left at
      // most one player standing. Finish now - otherwise the game sat
      // in_progress with a lone survivor forced to play out one more turn
      // against nobody before the win fired.
      clearTurnTimer(room);
      advanceTurn(game); // <=1 active -> flips to finished + resolves winnerId
      broadcastToRoom(room, buildGameOverPayload(room));
    }
  }

  broadcastToRoom(room, buildRoomUpdatePayload(room));
}

/**
 * Idle-room reaper sweep. Deletes every room that has been idle longer than
 * ROOM_IDLE_TTL_MS AND is NOT mid-game (game === null, or a finished game) - a
 * live game (any unfinished status) is never reaped no matter how long it drags. Each reaped
 * room's still-connected players get a graceful `room_closed` before teardown so
 * a lingering client isn't left hanging. Collects candidates first, then deletes,
 * so we never mutate the Map mid-iteration. Returns the reaped room codes.
 */
function reapIdleRooms(now = Date.now()) {
  const stale = [];
  for (const room of rooms.values()) {
    // Any LIVE game protects the room (see isGameLive) - an in_progress-only
    // check would let a live Imposter game (which never has that status) or a
    // Blitz intermission be reaped mid-play.
    if (isGameLive(room)) continue;
    const idleFor = now - (room.lastActivity || room.createdAt || now);
    if (idleFor >= ROOM_IDLE_TTL_MS) stale.push(room);
  }
  stale.forEach((room) => {
    broadcastToRoom(room, {
      type: 'room_closed',
      payload: { code: room.code, reason: 'idle' },
    });
    destroyRoom(room); // same teardown as the empty-room path
    logInfo('room_reaped', { roomCode: room.code, players: room.players.length });
  });
  return stale.map((r) => r.code);
}

// The single server-level reaper interval (not per-room). unref'd so it never
// keeps the process alive on its own. Idempotent start/stop.
let reaperInterval = null;
function startRoomReaper() {
  if (reaperInterval) return reaperInterval;
  reaperInterval = setInterval(() => {
    try {
      reapIdleRooms();
    } catch (err) {
      logError('reaper_sweep_failed', {}, err);
    }
  }, REAPER_SWEEP_MS);
  if (typeof reaperInterval.unref === 'function') reaperInterval.unref();
  return reaperInterval;
}
function stopRoomReaper() {
  if (reaperInterval) {
    clearInterval(reaperInterval);
    reaperInterval = null;
  }
}

// Test-only: a snapshot of registry size and live timer handles, for the
// t3-harness leak checks (served by t3-harness/server-wrapper.js on a side
// port). Counts every non-null timer slot across all rooms so an uncleaned
// interval/timeout after room teardown shows up as a nonzero delta.
function _getStatsForTesting() {
  let timers = 0;
  let playersTotal = 0;
  for (const room of rooms.values()) {
    if (room.turnTimerInterval) timers += 1;
    if (room.roundTimerInterval) timers += 1;
    if (room.roundPauseTimeout) timers += 1;
    if (room.countdownTimeout) timers += 1;
    if (room.botMoveTimeout) timers += 1;
    if (Array.isArray(room.blitzBotTimeouts)) timers += room.blitzBotTimeouts.length;
    playersTotal += room.players.length;
  }
  return { rooms: rooms.size, roomTimers: timers, playersTotal };
}

// Test-only: wipe the room registry between tests so listPublicRooms/quickPlay
// see a clean slate. Tears down any timers first so nothing leaks across tests.
function _resetRoomsForTesting() {
  for (const room of rooms.values()) {
    clearTurnTimer(room);
    clearRoundTimer(room);
    clearCountdownTimeout(room);
  }
  rooms.clear();
}

module.exports = {
  createRoom,
  joinRoom,
  getRoom,
  listPublicRooms,
  quickPlay,
  startGame,
  resetGame,
  addBot,
  removeBot,
  handleWordSubmission,
  handleCategoryAnswer,
  handleRerollCategory,
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
  // Room lifecycle safety (foundation for public rooms):
  touchRoom,
  failRoom,
  guardRoom,
  reapIdleRooms,
  startRoomReaper,
  stopRoomReaper,
  MAX_PLAYERS_PER_ROOM,
  _resetRoomsForTesting,
  _getStatsForTesting,
};
