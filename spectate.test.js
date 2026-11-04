// spectate.test.js — SPECTATE (nov4, Andy: "public rooms stay listed once a game starts, with SPECTATE"). The real server,
// real WebSocket clients: two players in a live public game + a WATCHER. The watcher gets the roster, a watchOnly
// game_started and a snapshot, then the room's broadcasts; it can never act; the room stays listed as 'playing'; a
// rematch hands the watcher the lobby (where it may take a seat); a disconnect / the room closing are clean.
process.env.PORT = '0'; // ephemeral port - never collides with a dev server

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');

const { server, wss } = require('./server');
const { stopRoomReaper, _resetRoomsForTesting, getRoom, resetGame, spectateRoom } = require('./roomManager');

let port;

// Minimal test client (the roomHeroes.test.js harness): records every message, awaits the next of a type.
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
      const timer = setTimeout(() => reject(new Error(`timed out waiting for "${type}"`)), ms);
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

/** Two humans in a LIVE public game of `gameType`; returns { host, guest, code }. */
async function liveRoom(gameType = 'word-bomb') {
  const host = await client();
  host.send('create_room', { name: 'ANNA', isPublic: true });
  const { payload: { code } } = await host.waitFor('room_created');
  if (gameType !== 'word-bomb') host.send('set_game_type', { gameType });
  const guest = await client();
  guest.send('join_room', { code, name: 'BO' });
  await guest.waitFor('room_joined');
  host.send('start_game', {});
  await host.waitFor('game_started', 6000);
  await guest.waitFor('game_started', 6000);
  return { host, guest, code };
}

test('a live public game stays LISTED as playing (watchable) for a client that asks withLive; an older client never sees it', async () => {
  const { code } = await liveRoom();
  const w = await client();
  w.send('list_public_rooms', {}); // an older client: no live rooms
  assert.equal((await w.waitFor('public_rooms')).payload.rooms.some((r) => r.code === code), false);
  w.send('list_public_rooms', { withLive: true });
  const { payload: { rooms } } = await w.waitFor('public_rooms');
  const row = rooms.find((r) => r.code === code);
  assert.ok(row, 'the live room is listed');
  assert.equal(row.status, 'playing');
  assert.equal(row.canSpectate, true);
  assert.equal(row.spectators, 0);
});

test('WATCH a live Word Bomb game: roster + watchOnly game_started + the turn snapshot, then live broadcasts; inputs do nothing', async () => {
  const { host, code } = await liveRoom();
  const w = await client();
  w.send('spectate_room', { code, name: 'WATCHER' });
  assert.equal((await w.waitFor('room_spectating')).payload.code, code);
  const roster = await w.waitFor('room_update');
  assert.equal(roster.payload.players.some((p) => p.id === w.id), false, 'a watcher is never a player');
  const started = await w.waitFor('game_started');
  assert.equal(started.payload.watchOnly, true);
  assert.equal(started.payload.gameType, 'word-bomb');
  const turn = await w.waitFor('turn_update');
  assert.ok(turn.payload.combo && turn.payload.players.length === 2, 'the snapshot is the live turn');

  // live broadcasts reach the watcher (the turn timer ticks once the countdown is over)
  await w.waitFor('timer_tick', 6000);

  // a watcher can't act: its submit is refused and the game is unchanged
  const used = () => JSON.stringify([...(getRoom(code).game.usedWords || [])]);
  const before = used();
  w.send('submit_word', { word: 'testing' });
  const err = await w.waitFor('error', 3000);
  assert.match(err.payload.message, /not currently in a room/i);
  assert.equal(used(), before);

  // the listing counts the watcher
  host.send('list_public_rooms', { withLive: true });
  const { payload: { rooms } } = await host.waitFor('public_rooms');
  assert.equal(rooms.find((r) => r.code === code).spectators, 1);
});

test('WATCH a live Category Blitz game: the snapshot is the current round, marked spectate (no countdown replay)', async () => {
  const { code } = await liveRoom('category-blitz');
  const w = await client();
  w.send('spectate_room', { code, name: 'WATCHER' });
  await w.waitFor('room_spectating');
  const started = await w.waitFor('game_started');
  assert.equal(started.payload.gameType, 'category-blitz');
  const round = await w.waitFor('round_start');
  assert.equal(round.payload.spectate, true);
  assert.ok(round.payload.category);
  assert.equal(round.payload.round, 1);
});

test('a rematch hands the watcher the lobby; the watcher can then take a seat (and stops watching)', async () => {
  const { code } = await liveRoom();
  const w = await client();
  w.send('spectate_room', { code, name: 'WATCHER' });
  await w.waitFor('game_started');
  resetGame(getRoom(code));
  await w.waitFor('game_reset', 3000);
  w.send('join_room', { code, name: 'WATCHER' });
  await w.waitFor('room_joined', 3000);
  const room = getRoom(code);
  assert.ok(room.players.some((p) => p.id === w.id), 'seated');
  assert.equal(room.spectators.some((p) => p.id === w.id), false, 'no longer a watcher');
});

test('a watcher that disconnects is dropped; the room closing tells its watchers', async () => {
  const { host, guest, code } = await liveRoom();
  const w1 = await client();
  w1.send('spectate_room', { code, name: 'W1' });
  await w1.waitFor('game_started');
  w1.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(getRoom(code).spectators.length, 0);

  const w2 = await client();
  w2.send('spectate_room', { code, name: 'W2' });
  await w2.waitFor('game_started');
  host.send('leave_room', {});
  guest.send('leave_room', {});
  const closed = await w2.waitFor('room_closed', 3000);
  assert.equal(closed.payload.code, code);
});

test('refusals: a private room, a room not in a live game, someone already playing there, no such room', async () => {
  const fake = { id: 'x1', readyState: 1, send() {} };
  const priv = await client();
  priv.send('create_room', { name: 'P', isPublic: false });
  const { payload: { code: pc } } = await priv.waitFor('room_created');
  assert.equal(spectateRoom(pc, fake, 'W').error, 'room_not_public');

  const pub = await client();
  pub.send('create_room', { name: 'Q', isPublic: true });
  const { payload: { code: qc } } = await pub.waitFor('room_created');
  assert.equal(spectateRoom(qc, fake, 'W').error, 'not_live');

  const { host, code } = await liveRoom();
  assert.equal(spectateRoom(code, { id: host.id, readyState: 1, send() {} }, 'W').error, 'already_playing');
  assert.equal(spectateRoom('ZZZZZ', fake, 'W').error, 'room_not_found');
});
