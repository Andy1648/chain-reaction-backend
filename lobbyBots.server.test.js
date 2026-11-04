// lobbyBots.server.test.js — LOBBY BOTS over real WebSockets (the real server, two real clients): a public room opted in
// with create_room { lobbyBots: true } fills with persona bots that still read isBot + lobbyBot on the wire; a second
// human's join, the game start (bots dealt in), and the rematch back to the lobby all behave. LOBBY_BOT_MS keeps it fast.
process.env.PORT = '0'; // ephemeral port - never collides with a dev server
process.env.LOBBY_BOT_MS = '60'; // every lobby-bot step 60 ms apart (read when lobbyBots loads)

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

/** The newest room_update this client holds once `pred(players)` is true (polls the stream, consuming as it goes). */
async function rosterUntil(c, pred, ms = 4000) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    const msg = await c.waitFor('room_update', Math.max(50, until - Date.now())).catch(() => null);
    if (!msg) break;
    last = msg.payload.players;
    if (pred(last)) return last;
  }
  throw new Error(`roster never matched; last: ${JSON.stringify(last)}`);
}

test('an opted-in public room fills with persona bots (isBot + lobbyBot + hero on the wire); an old client gets none', async () => {
  const host = await client();
  host.send('create_room', { name: 'ANNA', isPublic: true, lobbyBots: true });
  await host.waitFor('room_created');
  const players = await rosterUntil(host, (ps) => ps.filter((p) => p.lobbyBot).length >= 2);
  for (const p of players.filter((x) => x.lobbyBot)) {
    assert.equal(p.isBot, true);
    assert.ok(p.hero && typeof p.hero === 'string');
    assert.ok(!/BOT|ROBO|CPU/.test(p.name), `persona name, not a robot name: ${p.name}`);
  }

  const old = await client();
  old.send('create_room', { name: 'BO', isPublic: true }); // no opt-in
  await old.waitFor('room_created');
  await new Promise((r) => setTimeout(r, 400));
  const updates = old.received.filter((m) => m.type === 'room_update');
  assert.ok(updates.every((m) => m.payload.players.every((p) => !p.isBot)), 'an old client never sees lobby bots');
});

test('a second human joins by code; the host starts with the bots dealt in; a rematch returns everyone to the lobby', async () => {
  const host = await client();
  host.send('create_room', { name: 'ANNA', isPublic: true, lobbyBots: true });
  const { payload: { code } } = await host.waitFor('room_created');
  await rosterUntil(host, (ps) => ps.some((p) => p.lobbyBot));

  const guest = await client();
  guest.send('join_room', { code, name: 'BO' });
  const seen = await rosterUntil(guest, (ps) => ps.some((p) => p.id === guest.id));
  assert.ok(seen.some((p) => p.lobbyBot), 'the guest sees the bots as seated players');

  host.send('start_game', {});
  await host.waitFor('game_started', 6000); // (that the seated bots are dealt in is pinned in lobbyBots.test.js)
  await guest.waitFor('game_started', 6000);

  // nothing joins or leaves a live game
  host.received.length = 0;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(host.received.filter((m) => m.type === 'room_update').length, 0, 'no lobby-bot churn mid-game');

  host.send('rematch', {});
  await host.waitFor('game_reset', 6000);
  await guest.waitFor('game_reset', 6000);
});
