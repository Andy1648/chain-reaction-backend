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
  startGame,
  handleWordSubmission,
  removePlayer,
  broadcastToRoom,
  buildRoomUpdatePayload,
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
          const name = (payload?.name || 'Player').slice(0, 20);
          const room = createRoom(ws, name);
          connectionToRoomCode.set(ws.id, room.code);
          send(ws, 'room_created', { code: room.code });
          send(ws, ...Object.values(buildRoomUpdatePayload(room)));
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

        case 'submit_word': {
          const room = getRoomForConnection(ws);
          if (!room) return;
          const word = (payload?.word || '').toString();
          const result = await handleWordSubmission(room, ws.id, word);
          if (result.error) {
            sendError(ws, humanizeError(result.error), 'submit_word');
          }
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
  };
  return messages[code] || 'Something went wrong.';
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Chain Reaction server listening on port ${PORT}`);
});
