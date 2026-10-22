// roomHeroes.test.js — HEROES IN EVERY SEAT (oct21, Andy: "no one is addicted to getting rare heroes yet"): a player's
// equipped hero rides room_update so every client draws it. Real server, real WebSocket clients (the t2-server harness).
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

const seat = (msg, id) => msg.payload.players.find((p) => p.id === id);
// settle: let in-flight frames land, then take the newest buffered room_update (drops older ones)
async function lastRoomUpdate(c, ms = 200) {
  await new Promise((r) => setTimeout(r, ms));
  const ups = c.received.filter((m) => m.type === 'room_update');
  c.received = c.received.filter((m) => m.type !== 'room_update');
  return ups[ups.length - 1];
}
const none = async (c, type, ms = 300) => {
  await new Promise((r) => setTimeout(r, ms));
  return c.received.filter((m) => m.type === type);
};

test('set_hero: the hero rides room_update to everyone in the room', async () => {
  const a = await client();
  const b = await client();
  a.send('create_room', { name: 'Host' });
  const created = await a.waitFor('room_created');
  b.send('join_room', { code: created.payload.code, name: 'P2' });
  await b.waitFor('room_joined');
  await lastRoomUpdate(a);
  await lastRoomUpdate(b);

  a.send('set_hero', { hero: 'mecha' });
  const ua = await a.waitFor('room_update');
  const ub = await b.waitFor('room_update');
  assert.equal(seat(ua, a.id).hero, 'mecha');
  assert.equal(seat(ub, a.id).hero, 'mecha', 'the other player sees it too');
  assert.equal(seat(ub, b.id).hero, undefined, 'a player who never set one has no hero field');
});

test('set_hero: variants pass, junk is refused with a clean error, a repeat is a no-op', async () => {
  const a = await client();
  a.send('create_room', { name: 'Solo' });
  await a.waitFor('room_created');
  await lastRoomUpdate(a);

  a.send('set_hero', { hero: 'riot-elite' });
  assert.equal(seat(await a.waitFor('room_update'), a.id).hero, 'riot-elite');

  for (const bad of ['<script>', 'MECHA', 'a', 'x'.repeat(40), 42, null]) {
    a.send('set_hero', { hero: bad });
    const err = await a.waitFor('error');
    assert.equal(err.payload.context, 'set_hero', String(bad));
  }

  await new Promise((r) => setTimeout(r, 450)); // past the per-player throttle
  a.send('set_hero', { hero: 'riot-elite' }); // unchanged → no broadcast
  assert.deepEqual(await none(a, 'room_update'), []);
});

test('set_hero outside a room changes nothing (the usual not-in-a-room error)', async () => {
  const a = await client();
  a.send('set_hero', { hero: 'mecha' });
  assert.deepEqual(await none(a, 'room_update'), []);
  const errs = await none(a, 'error', 0);
  assert.equal(errs.length, 1);
  assert.match(errs[0].payload.message, /not currently in a room/);
});
