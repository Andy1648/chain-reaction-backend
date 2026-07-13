// server.js
// Entry point. An Express app handles a basic health-check route, and a
// WebSocket server (mounted on the same HTTP server) handles all real
// game traffic. Every connected socket gets a random id that doubles as
// its "player id" throughout a room's lifetime.

// Monitoring/analytics FIRST: initSentry() must run before the rest of the app is
// required so Sentry's auto-instrumentation + global uncaught-exception /
// unhandled-rejection handlers are installed. Both are graceful no-ops without
// their env keys and can never block startup or gameplay.
const { Sentry, initSentry, initAnalytics, captureError } = require('./monitoring');
initSentry();
initAnalytics();

// Explicit global error handlers (Sentry's auto ones are disabled in monitoring.js
// so these are the sole handlers). Each wraps the capture so a reporting failure
// can't itself throw, then preserves the prior behavior:
//  - uncaughtException: the process is in an undefined state -> report, log, and
//    exit so the platform restarts a clean instance (same as Node's default and
//    Sentry's default integration). Per-message WS throws never reach here; they're
//    caught in the message handler below, so this only fires for truly fatal errors.
//  - unhandledRejection: report + log, but DO NOT exit — a stray rejection must not
//    drop every live game connection.
process.on('uncaughtException', (err) => {
  try { captureError(err, { kind: 'uncaughtException' }); } catch { /* never throw from a handler */ }
  console.error('Uncaught exception:', err);
  try {
    Sentry.flush(2000).catch(() => {}).finally(() => process.exit(1));
  } catch {
    process.exit(1);
  }
});
process.on('unhandledRejection', (reason) => {
  try {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    captureError(err, { kind: 'unhandledRejection' });
  } catch { /* never throw from a handler */ }
  console.error('Unhandled rejection:', reason);
});

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const { markAsValid } = require('./dictionary');
// Structured logging (JSON lines with level/event/roomCode/playerId). logError
// also reports to Sentry, so the handler catch below needs only one call.
const { logInfo, logWarn, logError } = require('./logger');
const {
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
  handleRerollCategory,
  handleImposterVote,
  removePlayer,
  failRoom,
  broadcastToRoom,
  buildRoomUpdatePayload,
  buildTurnUpdatePayload,
  buildGameOverPayload,
  clearTurnTimer,
  startTurnTimer,
  startRoomReaper,
} = require('./roomManager');

// Category Blitz pack ids — the valid set the host's set_packs selection is checked
// against. Derived from CATEGORY_PACKS so it can't drift from the real assignments.
const { PACK_IDS } = require('./categoryBlitzLogic');
const VALID_PACK_IDS = new Set(PACK_IDS);

// Input hardening + abuse throttles (see security.js). sanitizeName strips
// control/formatting/angle-bracket chars from usernames; slidingWindowAllow
// backs the per-socket message + join caps; MAX_WS_PAYLOAD_BYTES caps frame size.
const {
  sanitizeName,
  slidingWindowAllow,
  MESSAGE_WINDOW_MS,
  MESSAGE_LIMIT,
  JOIN_WINDOW_MS,
  JOIN_LIMIT,
  MAX_WS_PAYLOAD_BYTES,
} = require('./security');

// [T5] Experimental mode registry: extra gameTypes accepted by set_game_type
// and extra error strings consulted by humanizeError. See t5Modes.js.
const { MODES: T5_MODES, ERROR_MESSAGES: T5_ERROR_MESSAGES } = require('./t5Modes');

// Pre-warm the dictionary cache with our starter words so the very first
// move of any game doesn't depend on the Dictionary API being reachable.
['garden', 'planet', 'window', 'castle', 'rocket', 'forest', 'bridge', 'pencil', 'guitar', 'mirror', 'jacket', 'turtle']
  .forEach(markAsValid);

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/version', (req, res) => {
  res.json({ commit: process.env.RENDER_GIT_COMMIT || 'unknown' });
});

// Explicit Express error middleware (after all routes): report the error to
// Sentry, wrapped so a capture failure can't throw, then pass it through to
// Express's default handler so the HTTP response behavior is unchanged.
app.use((err, req, res, next) => {
  try { captureError(err, { kind: 'express' }); } catch { /* never throw */ }
  next(err);
});

const server = http.createServer(app);
// maxPayload caps a single inbound frame (vector R3). The ws default is ~100 MiB;
// game messages are a few hundred bytes, so 64 KiB is generous. An over-cap frame
// makes ws close the socket with 1009 (message too big) before our handler runs.
const wss = new WebSocketServer({ server, maxPayload: MAX_WS_PAYLOAD_BYTES });

// Tracks which room each live connection currently belongs to, so we can
// clean up properly on disconnect without the client having to tell us.
const connectionToRoomCode = new Map();

// Per-connection create_room throttle: at most CREATE_LIMIT room creations per
// CREATE_WINDOW_MS from a single socket, so one client can't spam the registry.
// (The global MAX_ACTIVE_ROOMS cap in roomManager is the backstop for a client
// that opens many sockets.) Timestamps live on the ws object, so they're freed
// with the connection.
const CREATE_WINDOW_MS = 60 * 1000;
const CREATE_LIMIT = 5;
function allowCreateRoom(ws) {
  const now = Date.now();
  ws._createTimes = (ws._createTimes || []).filter((t) => now - t < CREATE_WINDOW_MS);
  if (ws._createTimes.length >= CREATE_LIMIT) return false;
  ws._createTimes.push(now);
  return true;
}

// Global per-socket inbound message throttle (vectors R1/R2/R6). Every message,
// whatever its type, counts against one generous sliding window so a single
// socket can't flood the handler or amplify via typing_update / spectator_reaction
// / Category Blitz answer spam. Tuned in security.js well above any human's peak
// typing rate. Timestamps live on the ws object, freed with the connection.
function allowMessage(ws) {
  ws._msgTimes = ws._msgTimes || [];
  return slidingWindowAllow(ws._msgTimes, Date.now(), MESSAGE_WINDOW_MS, MESSAGE_LIMIT);
}

// Per-socket join_room throttle (vector R5): blunts room-code brute-forcing and
// join spam without touching the far-higher global message cap.
function allowJoin(ws) {
  ws._joinTimes = ws._joinTimes || [];
  return slidingWindowAllow(ws._joinTimes, Date.now(), JOIN_WINDOW_MS, JOIN_LIMIT);
}

function send(ws, type, payload) {
  // try/catch: readyState can flip between the check and the send (teardown
  // race), and this helper also runs outside the message handler's try/catch
  // (e.g. the 'connected' hello) where a throw would otherwise be fatal.
  try {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type, payload }));
    }
  } catch (err) {
    logWarn('ws_send_failed', { playerId: ws.id, msgType: type }, err);
  }
}

function sendError(ws, message, context) {
  send(ws, 'error', { message, context });
}

// A server-level error (rare - e.g. the underlying HTTP server erroring) must
// be visible but must not bring the process down via an unhandled 'error' event.
wss.on('error', (err) => {
  logError('wss_error', {}, err);
});

wss.on('connection', (ws) => {
  ws.id = crypto.randomUUID();

  // Without an 'error' listener, a socket-level error (ECONNRESET from a phone
  // dropping off Wi-Fi mid-frame, an invalid close frame, an over-cap payload)
  // is an unhandled 'error' event -> uncaughtException -> the WHOLE process
  // dies. ws tears the broken socket down itself and 'close' still fires (so
  // the room is cleaned up below); we only need to record it.
  ws.on('error', (err) => {
    logWarn('ws_socket_error', { roomCode: connectionToRoomCode.get(ws.id), playerId: ws.id }, err);
  });

  // The client has no other way to learn its own connection id - room
  // broadcasts include every player's id but never single out "which one
  // is me". Sending this immediately means the frontend can determine
  // host status, whose turn it is, etc. by simple comparison.
  send(ws, 'connected', { id: ws.id });

  ws.on('message', async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      sendError(ws, 'Malformed message - expected JSON.');
      return;
    }

    const { type, payload } = message;

    // Global per-socket flood guard. Over the cap we drop the message and notify
    // ONCE per burst (tracked by _throttleNotified) so our own error replies
    // don't themselves become an amplification channel. The flag resets as soon
    // as the socket is back under the cap.
    if (!allowMessage(ws)) {
      if (!ws._throttleNotified) {
        ws._throttleNotified = true;
        sendError(ws, humanizeError('rate_limited'), type);
      }
      return;
    }
    ws._throttleNotified = false;

    try {
      switch (type) {
        case 'create_room': {
          // Throttle create-spam from a single connection first.
          if (!allowCreateRoom(ws)) {
            sendError(ws, humanizeError('rate_limited'), 'create_room');
            return;
          }
          const name = sanitizeName(payload?.name);
          // isPublic defaults to false: a plain create_room stays code-only/
          // private exactly as before. Only an explicit true opts into the
          // public list / quick-play.
          const result = createRoom(ws, name, payload?.isPublic === true);
          if (result.error) {
            // Global cap hit (server_busy) - graceful, no crash/silent drop.
            sendError(ws, humanizeError(result.error), 'create_room');
            return;
          }
          const room = result.room;
          connectionToRoomCode.set(ws.id, room.code);
          send(ws, 'room_created', { code: room.code });
          send(ws, ...Object.values(buildRoomUpdatePayload(room)));
          break;
        }

        // Lobby browser: return the list of joinable public rooms. Read-only -
        // no room membership required, so it doesn't go through
        // getRoomForConnection. Replies straight to the asking socket.
        case 'list_public_rooms': {
          send(ws, 'public_rooms', { rooms: listPublicRooms() });
          break;
        }

        // Quick Play: join the fullest joinable public room, or spin up a new
        // public one if none exist. Reuses joinRoom's guards (race-safe retry
        // inside quickPlay) and the same create throttle as create_room.
        case 'quick_play': {
          const name = sanitizeName(payload?.name);
          const result = quickPlay(ws, name, () => allowCreateRoom(ws));
          if (result.error) {
            sendError(ws, humanizeError(result.error), 'quick_play');
            return;
          }
          const room = result.room;
          connectionToRoomCode.set(ws.id, room.code);
          // Mirror create_room / join_room so the (future) client handles both
          // uniformly: a fresh room reports room_created, an existing one
          // room_joined; then everyone in the room gets the updated roster.
          if (result.created) {
            send(ws, 'room_created', { code: room.code });
          } else {
            send(ws, 'room_joined', { code: room.code });
          }
          broadcastToRoom(room, buildRoomUpdatePayload(room));
          break;
        }

        case 'join_room': {
          // Throttle join attempts first, so code-guessing / join-spam is capped
          // even below the global message limit.
          if (!allowJoin(ws)) {
            sendError(ws, humanizeError('rate_limited'), 'join_room');
            return;
          }
          const code = (payload?.code || '').toUpperCase().trim();
          const name = sanitizeName(payload?.name);
          const result = joinRoom(code, ws, name);

          if (result.error) {
            sendError(ws, humanizeError(result.error), 'join_room');
            return;
          }

          connectionToRoomCode.set(ws.id, code);
          send(ws, 'room_joined', { code });
          broadcastToRoom(result.room, buildRoomUpdatePayload(result.room));
          break;
        }

        case 'set_difficulty': {
          const room = getRoomForConnection(ws);
          if (!room) return;
          if (room.hostId !== ws.id) {
            sendError(ws, 'Only the host can change difficulty.', 'set_difficulty');
            return;
          }
          const key = payload?.difficultyKey;
          if (!['easy', 'medium', 'hard'].includes(key)) {
            sendError(ws, 'Invalid difficulty.', 'set_difficulty');
            return;
          }
          room.difficultyKey = key;
          broadcastToRoom(room, buildRoomUpdatePayload(room));
          break;
        }

        // Category Blitz: the host picks which category packs are in play. Mirrors
        // set_difficulty — host-only, validated against VALID_PACK_IDS, then broadcast.
        // The next createGame reads room.selectedPacks to filter category picks.
        case 'set_packs': {
          const room = getRoomForConnection(ws);
          if (!room) return;
          if (room.hostId !== ws.id) {
            sendError(ws, 'Only the host can change packs.', 'set_packs');
            return;
          }
          const packs = payload?.packs;
          if (!Array.isArray(packs) || packs.length === 0 || !packs.every((p) => VALID_PACK_IDS.has(p))) {
            sendError(ws, 'Invalid packs.', 'set_packs');
            return;
          }
          room.selectedPacks = packs;
          broadcastToRoom(room, buildRoomUpdatePayload(room));
          break;
        }

        case 'set_game_type': {
          const room = getRoomForConnection(ws);
          if (!room) return;
          if (room.hostId !== ws.id) {
            sendError(ws, 'Only the host can change the game type.', 'set_game_type');
            return;
          }
          const gameType = payload?.gameType;
          if (
            !['word-bomb', 'category-blitz', 'imposter-word'].includes(gameType) &&
            !T5_MODES[gameType] // [T5] experimental modes are also selectable
          ) {
            sendError(ws, 'Invalid game type.', 'set_game_type');
            return;
          }
          room.gameType = gameType;
          // Difficulty is a Word Bomb concept (its HARD/CRAZY/HELL timer tiers). If
          // the host set HARD then switched to Blitz/Imposter, drop the stale value
          // back to medium so it can't drag in — Blitz then gets its 2 rerolls and
          // Imposter's (inert) difficulty stays neutral. Word Bomb keeps its choice.
          if (gameType !== 'word-bomb') room.difficultyKey = 'medium';
          // Bots are mode-specific (their own name pool and behavior per mode);
          // if the host switches modes with a bot still in the lobby, drop it so
          // a stale-flavor bot never carries into a mode it wasn't built for.
          // Re-adding the right kind is one click.
          const lobbyBot = room.players.find((p) => p.isBot);
          if (lobbyBot && lobbyBot.botGameType !== gameType) removeBot(room);
          broadcastToRoom(room, buildRoomUpdatePayload(room));
          break;
        }

        // Solo Word Bomb / Category Blitz: the lone player explicitly adds a bot
        // opponent at a chosen difficulty (independent of the room's difficulty).
        // Host-only; addBot enforces the supported-mode / single-human /
        // no-existing-bot guards.
        case 'add_bot': {
          const room = getRoomForConnection(ws);
          if (!room) return;
          if (room.hostId !== ws.id) {
            sendError(ws, 'Only the host can add a bot.', 'add_bot');
            return;
          }
          const difficulty = ['easy', 'medium', 'hard'].includes(payload?.difficulty)
            ? payload.difficulty
            : 'medium';
          const result = addBot(room, difficulty);
          if (result.error) {
            sendError(ws, humanizeError(result.error), 'add_bot');
            return;
          }
          broadcastToRoom(room, buildRoomUpdatePayload(room));
          break;
        }

        // Remove the bot from the lobby before starting (host-only).
        case 'remove_bot': {
          const room = getRoomForConnection(ws);
          if (!room) return;
          if (room.hostId !== ws.id) {
            sendError(ws, 'Only the host can remove the bot.', 'remove_bot');
            return;
          }
          const result = removeBot(room);
          if (result.error) {
            sendError(ws, humanizeError(result.error), 'remove_bot');
            return;
          }
          broadcastToRoom(room, buildRoomUpdatePayload(room));
          break;
        }

        case 'start_game': {
          const room = getRoomForConnection(ws);
          if (!room) return;
          if (room.hostId !== ws.id) {
            sendError(ws, 'Only the host can start the game.', 'start_game');
            return;
          }
          // daily:true opts a solo Category Blitz start into the Daily
          // Challenge (date-seeded categories, no rerolls). Anything else
          // about the message is unchanged; startGame validates solo-only.
          const result = startGame(room, { daily: payload?.daily === true });
          if (result.error) {
            sendError(ws, humanizeError(result.error), 'start_game');
          }
          break;
        }

        case 'rematch': {
          const room = getRoomForConnection(ws);
          if (!room) return;
          if (room.hostId !== ws.id) {
            sendError(ws, 'Only the host can start a rematch.', 'rematch');
            return;
          }
          resetGame(room);
          break;
        }

        case 'skip_turn': {
          const room = getRoomForConnection(ws);
          if (!room) return;
          // Turn-based games only: getCurrentPlayerId below reads
          // game.turnOrder, which the round-based modes (Blitz / Imposter /
          // plugin modes) don't have - without the Array check, skip_turn on
          // one of those games threw a TypeError (caught, but surfaced to the
          // player as a generic server error, plus Sentry noise).
          if (!room.game || !Array.isArray(room.game.turnOrder) || room.game.status !== 'in_progress') {
            sendError(ws, 'No active game.', 'skip_turn');
            return;
          }
          const { getCurrentPlayerId, handleTimeout } = require('./gameLogic');
          if (getCurrentPlayerId(room.game) !== ws.id) {
            sendError(ws, "It's not your turn.", 'skip_turn');
            return;
          }
          clearTurnTimer(room);
          const { eliminatedPlayerId } = handleTimeout(room.game);
          broadcastToRoom(room, { type: 'turn_skipped', payload: { eliminatedPlayerId } });
          if (room.game.status === 'finished') {
            broadcastToRoom(room, buildGameOverPayload(room));
          } else {
            broadcastToRoom(room, buildTurnUpdatePayload(room));
            startTurnTimer(room);
          }
          break;
        }
        // submit_answer is an alias of submit_word so the frontend can use
        // either message type; both route through handleWordSubmission, which
        // dispatches to the right game mode internally. Word Bomb sends
        // { word }, Category Blitz sends { answer } - accept whichever.
        case 'submit_word':
        case 'submit_answer': {
          const room = getRoomForConnection(ws);
          if (!room) return;
          const text = (payload?.word ?? payload?.answer ?? '').toString();
          const result = await handleWordSubmission(room, ws.id, text);
          if (result.error) {
            sendError(ws, humanizeError(result.error), type);
          }
          break;
        }

        // Category Blitz: swap the current round's category for a different one
        // (host-only in multiplayer; free for the solo player, within the
        // per-game reroll allowance set by difficulty).
        case 'reroll_category': {
          const room = getRoomForConnection(ws);
          if (!room) return;
          const result = handleRerollCategory(room, ws.id);
          if (result.error) {
            sendError(ws, humanizeError(result.error), 'reroll_category');
          }
          break;
        }

        // Imposter Word: a vote for who the imposter is. Routed through the room
        // manager, which replies vote_result to the voter and broadcasts a
        // privacy-safe vote_count (and ends the phase early once everyone's in).
        case 'submit_vote': {
          const room = getRoomForConnection(ws);
          if (!room) return;
          const suspectId = (payload?.suspectId || '').toString();
          const result = handleImposterVote(room, ws.id, suspectId);
          if (result.error) {
            sendError(ws, humanizeError(result.error), 'submit_vote');
          }
          break;
        }

        // Real-time typing relay (BombParty style): rebroadcast the current
        // player's in-progress text to everyone else so they see it keystroke
        // by keystroke. Deliberately lightweight - no game-state mutation, no
        // validation - just a capped string relayed to the other players.
        case 'typing_update': {
          const room = getRoomForConnection(ws);
          if (!room) return;
          if (!room.game || room.game.status !== 'in_progress') return;
          const text = (payload?.text || '').toString().slice(0, 50);
          room.players.forEach((p) => {
            if (p.id !== ws.id && p.connection.readyState === 1) {
              p.connection.send(JSON.stringify({
                type: 'typing_update',
                payload: { playerId: ws.id, text },
              }));
            }
          });
          break;
        }

        // Spectator reactions: an eliminated player fires a quick emoji, which
        // we relay to EVERYONE in the room (active players + other spectators).
        // Allow-listed emojis only; no game-state mutation.
        case 'spectator_reaction': {
          const room = getRoomForConnection(ws);
          if (!room) return;
          if (!room.game || room.game.status !== 'in_progress') return;
          const emoji = (payload?.emoji || '').toString().slice(0, 4);
          const allowedEmojis = ['💀', '🔥', '😂', '👏'];
          if (!allowedEmojis.includes(emoji)) return;
          broadcastToRoom(room, {
            type: 'spectator_reaction',
            payload: {
              playerId: ws.id,
              playerName: room.players.find((p) => p.id === ws.id)?.name || 'Spectator',
              emoji,
            },
          });
          break;
        }

        case 'leave_room': {
          const room = getRoomForConnection(ws);
          if (!room) return;
          removePlayer(room, ws.id);
          connectionToRoomCode.delete(ws.id);
          break;
        }

        default:
          sendError(ws, `Unknown message type: ${type}`);
      }
    } catch (err) {
      // Structured log with the full blast-radius context (room, player, message
      // type); logError also reports to Sentry. The graceful sendError still
      // runs and the connection/game continues exactly as before.
      logError(
        'ws_message_error',
        { roomCode: connectionToRoomCode.get(ws.id), playerId: ws.id, wsMessageType: type },
        err
      );
      sendError(ws, 'Server error processing your request.', type);
    }
  });

  ws.on('close', () => {
    // Look the room up directly (not via getRoomForConnection, which would try
    // to send an error to a socket that's already gone). Drop the mapping FIRST
    // so it can't leak even if the cleanup below fails.
    const code = connectionToRoomCode.get(ws.id);
    connectionToRoomCode.delete(ws.id);
    const room = code ? getRoom(code) : null;
    if (!room) return;
    try {
      removePlayer(room, ws.id);
    } catch (err) {
      // removePlayer advances turns / restarts timers; if it threw, the room's
      // state can't be trusted. Close that one room cleanly (room_closed +
      // teardown) rather than crash the process or strand a frozen game.
      failRoom(room, 'player_disconnect_error', err);
    }
  });

  function getRoomForConnection(connection) {
    const code = connectionToRoomCode.get(connection.id);
    if (!code) {
      sendError(connection, 'You are not currently in a room.');
      return null;
    }
    const room = getRoom(code);
    if (!room) {
      sendError(connection, 'That room no longer exists.');
      return null;
    }
    return room;
  }
});

function humanizeError(code) {
  const messages = {
    room_not_found: 'No room found with that code.',
    game_already_started: 'That game has already started.',
    room_full: 'That room is full.',
    not_enough_players: 'You need at least 2 players to start.',
    no_active_game: 'There is no active game in this room.',
    not_your_turn: "It's not your turn.",
    round_not_active: 'The round is not currently active.',
    no_rerolls_left: 'No category rerolls left this game.',
    host_only_reroll: 'Only the host can reroll the category.',
    reroll_window_closed: 'Rerolls are only allowed in the first few seconds of a round.',
    rate_limited: "You're creating rooms too fast. Wait a moment and try again.",
    server_busy: 'The server is at capacity right now. Please try again shortly.',
    bot_mode_unsupported: 'Bots are only available in Word Bomb and Category Blitz.',
    bot_already_added: 'There is already a bot in this room.',
    bot_solo_only: 'You can only add a bot when you are the only player.',
    daily_solo_only: 'The Daily Challenge is solo Category Blitz only — no other players or bots.',
  };
  return messages[code] || T5_ERROR_MESSAGES[code] || 'Something went wrong.';
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Chain Reaction server listening on port ${server.address().port}`);
  logInfo('server_listening', { port: server.address().port });
  // Surface whether the Category Blitz AI fallback is active. With no key the
  // game still runs fine - list-only validation - but creative answers won't be
  // AI-judged, so make that explicit at boot.
  if (require('./haikuValidator').isEnabled()) {
    console.log('[haikuValidator] Category Blitz AI validation ENABLED (Claude Haiku fallback)');
  } else {
    console.warn(
      '[haikuValidator] ANTHROPIC_API_KEY not set - Category Blitz AI validation DISABLED (list-only)'
    );
  }
  // Start the single idle-room reaper sweep (deletes dead non-empty lobbies).
  startRoomReaper();
});

// Test hook: integration tests (t2-server.test.js) boot this real server on an
// ephemeral port (PORT=0) and drive it with real WebSocket clients. Production
// never reads these exports.
module.exports = { server, wss };
