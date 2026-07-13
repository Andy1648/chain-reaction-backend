// t2-server.test.js
// Run with: node --test t2-server.test.js   (or `npm test` for the suite)
//
// [T2] Integration tests against the REAL server (server.js booted on an
// ephemeral port, driven by real WebSocket clients). Covers the skip_turn
// message-handler bug: its "is a game running" guard only checked
// status === 'in_progress', then unconditionally called getCurrentPlayerId,
// which reads game.turnOrder - a field only turn-based Word Bomb games have.
// skip_turn against a live Category Blitz game therefore threw a TypeError
// (caught by the handler's try/catch, but surfaced to the player as the
// generic 'Server error processing your request.' plus Sentry noise).
//
// No external network is touched: room/lobby messages are all in-memory, and
// the Word Bomb turn skip goes through handleTimeout (no dictionary call).

process.env.PORT = '0'; // ephemeral port - never collides with a dev server

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');

const { server, wss } = require('./server');
const { stopRoomReaper, _resetRoomsForTesting } = require('./roomManager');

let port;

// Minimal test client: connects, records every message, and lets a test await
// the next message of a given type (scanning messages already received first,
// each consumable once).
class Client {
  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.received = [];
    this.waiters = [];
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const waiterIdx = this.waiters.findIndex((w) => w.type === msg.type);
      if (waiterIdx !== -1) {
        const [waiter] = this.waiters.splice(waiterIdx, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      } else {
        this.received.push(msg);
      }
    });
  }

  async hello() {
    const msg = await this.waitFor('connected');
    this.id = msg.payload.id;
    return this;
  }

  send(type, payload) {
    this.ws.send(JSON.stringify({ type, payload }));
  }

  waitFor(type, ms = 4000) {
    const idx = this.received.findIndex((m) => m.type === type);
    if (idx !== -1) return Promise.resolve(this.received.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for "${type}"`)),
        ms
      );
      this.waiters.push({ type, resolve, timer });
    });
  }

  close() {
    this.ws.terminate();
  }
}

const clients = [];
async function client() {
  const c = new Client();
  clients.push(c);
  return c.hello();
}

test.before(async () => {
  if (!server.listening) await once(server, 'listening');
  port = server.address().port;
});

test.beforeEach(() => _resetRoomsForTesting());

test.after(async () => {
  clients.forEach((c) => c.close());
  wss.clients.forEach((c) => c.terminate());
  _resetRoomsForTesting();
  stopRoomReaper();
  wss.close();
  await new Promise((resolve) => server.close(resolve));
});

test('skip_turn on a live Category Blitz game gets a clean error, not a server error', async () => {
  const c1 = await client();
  c1.send('create_room', { name: 'Solo' });
  await c1.waitFor('room_created');
  c1.send('set_game_type', { gameType: 'category-blitz' });
  await c1.waitFor('room_update');
  c1.send('start_game', {}); // solo blitz starts with one player
  await c1.waitFor('game_started');

  c1.send('skip_turn', {});
  const err = await c1.waitFor('error');
  assert.equal(err.payload.context, 'skip_turn');
  assert.notEqual(
    err.payload.message,
    'Server error processing your request.',
    'skip_turn on a round-based mode must not take the TypeError path'
  );
  assert.equal(err.payload.message, 'No active game.');
});

test('skip_turn still works for the current player of a Word Bomb game', async () => {
  const c1 = await client();
  const c2 = await client();

  c1.send('create_room', { name: 'Host' });
  const created = await c1.waitFor('room_created');
  c2.send('join_room', { code: created.payload.code, name: 'P2' });
  await c2.waitFor('room_joined');

  c1.send('start_game', {});
  await c1.waitFor('game_started');
  const turn = await c1.waitFor('turn_update');
  assert.equal(turn.payload.currentPlayerId, c1.id, 'host has the first turn');

  c1.send('skip_turn', {});
  const skipped = await c1.waitFor('turn_skipped');
  assert.equal(skipped.payload.eliminatedPlayerId, null, 'one skip costs a life, not elimination');
  const nextTurn = await c1.waitFor('turn_update');
  assert.equal(nextTurn.payload.currentPlayerId, c2.id, 'turn passed to the other player');
});

test('skip_turn from the NON-current player is rejected', async () => {
  const c1 = await client();
  const c2 = await client();

  c1.send('create_room', { name: 'Host' });
  const created = await c1.waitFor('room_created');
  c2.send('join_room', { code: created.payload.code, name: 'P2' });
  await c2.waitFor('room_joined');
  c1.send('start_game', {});
  await c2.waitFor('game_started');

  c2.send('skip_turn', {});
  const err = await c2.waitFor('error');
  assert.equal(err.payload.message, "It's not your turn.");
});
