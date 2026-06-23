// server.js
// Entry point. An Express app handles a basic health-check route, and a
// WebSocket server (mounted on the same HTTP server) handles all real
// game traffic. Every connected socket gets a random id that doubles as
// its "player id" throughout a room's lifetime.

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const { markAsValid } = require('./dictionary');
const {
  createRoom,
  joinRoom,
  getRoom,
  listPublicRooms,
  quickPlay,
  startGame,
  resetGame,
  handleWordSubmission,
  handleRerollCategory,
  handleImposterVote,
  removePlayer,
  broadcastToRoom,
  buildRoomUpdatePayload,
  buildTurnUpdatePayload,
  buildGameOverPayload,
  clearTurnTimer,
  startTurnTimer,
  startRoomReaper,
} = require('./roomManager');

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

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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

function send(ws, type, payload) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function sendError(ws, message, context) {
  send(ws, 'error', { message, context });
}

wss.on('connection', (ws) => {
  ws.id = crypto.randomUUID();

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

    try {
      switch (type) {
        case 'create_room': {
          // Throttle create-spam from a single connection first.
          if (!allowCreateRoom(ws)) {
            sendError(ws, humanizeError('rate_limited'), 'create_room');
            return;
          }
          const name = (payload?.name || 'Player').slice(0, 20);
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
          const name = (payload?.name || 'Player').slice(0, 20);
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
          const code = (payload?.code || '').toUpperCase().trim();
          const name = (payload?.name || 'Player').slice(0, 20);
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

        case 'set_game_type': {
          const room = getRoomForConnection(ws);
          if (!room) return;
          if (room.hostId !== ws.id) {
            sendError(ws, 'Only the host can change the game type.', 'set_game_type');
            return;
          }
          const gameType = payload?.gameType;
          if (!['word-bomb', 'category-blitz', 'imposter-word'].includes(gameType)) {
            sendError(ws, 'Invalid game type.', 'set_game_type');
            return;
          }
          room.gameType = gameType;
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
          const result = startGame(room);
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
          if (!room.game || room.game.status !== 'in_progress') {
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
      console.error('Error handling message', type, err);
      sendError(ws, 'Server error processing your request.', type);
    }
  });

  ws.on('close', () => {
    const room = getRoomForConnection(ws);
    if (room) {
      removePlayer(room, ws.id);
    }
    connectionToRoomCode.delete(ws.id);
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
  };
  return messages[code] || 'Something went wrong.';
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Chain Reaction server listening on port ${PORT}`);
  // Start the single idle-room reaper sweep (deletes dead non-empty lobbies).
  startRoomReaper();
});
