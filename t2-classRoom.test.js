// t2-classRoom.test.js
// Run with: node --test t2-classRoom.test.js
//
// FRENCH RUSH CLASS ROOM against the REAL server (server.js on an ephemeral port, real WebSocket
// clients): the class_* routing, the close hook (a dropped socket keeps its seat) and that a class
// socket and the arcade rooms do not interfere.

process.env.PORT = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');

const { server, wss, classHub } = require('./server');
const { stopRoomReaper, _resetRoomsForTesting } = require('./roomManager');

let port;

class Client {
  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.received = [];
    this.waiters = [];
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const i = this.waiters.findIndex((w) => w.type === msg.type);
      if (i !== -1) {
        const [w] = this.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        this.received.push(msg);
      }
    });
  }
  async hello() {
    await this.waitFor('connected');
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
  // Wait for a class_state matching `pred` (skipping earlier snapshots).
  async state(pred = () => true) {
    for (;;) {
      const m = await this.waitFor('class_state');
      if (pred(m.payload)) return m.payload;
    }
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

const ROWS = [{ word: 'famille', gloss: 'family' }, { word: 'ami', gloss: 'friend' }];

test.before(async () => {
  if (!server.listening) await once(server, 'listening');
  port = server.address().port;
});

test.beforeEach(() => {
  _resetRoomsForTesting();
  classHub._reset();
});

test.after(async () => {
  clients.forEach((c) => c.close());
  wss.clients.forEach((c) => c.terminate());
  _resetRoomsForTesting();
  classHub._reset();
  classHub.stopSweeper();
  stopRoomReaper();
  wss.close();
  await new Promise((resolve) => server.close(resolve));
});

test('a class runs end to end over real sockets, and a dropped student rejoins', async () => {
  const host = await client();
  host.send('class_create', { name: 'Prof', set: { theme: 'familles', level: 'easy', mode: 'briefing' }, rows: ROWS });
  const { payload: created } = await host.waitFor('class_created');
  await host.state((s) => s.phase === 'lobby');

  const stu = await client();
  stu.send('class_join', { code: created.code, name: 'Ana', token: 'tab-ana-0001' });
  const { payload: joined } = await stu.waitFor('class_joined');
  const first = await stu.state();
  assert.equal(first.rows.length, 2);
  await host.state((s) => s.roster.length === 1);

  host.send('class_start', {});
  await stu.state((s) => s.phase === 'word' && s.index === 0);

  // the phone locks: socket gone, seat kept
  stu.close();
  await host.state((s) => s.roster.length === 1 && s.roster[0].away === true);

  const stu2 = await client();
  stu2.send('class_rejoin', { code: created.code, token: 'tab-ana-0001' });
  const back = await stu2.state();
  assert.equal(back.you, joined.studentId);
  assert.equal(back.phase, 'word');
  await host.state((s) => s.roster[0].away === false);

  stu2.send('class_result', { index: 0, outcome: 'clean', hints: 0 });
  const review = await host.state((s) => s.phase === 'review');
  assert.equal(review.tally.clean, 1);

  host.send('class_next', {});
  await stu2.state((s) => s.phase === 'word' && s.index === 1);
  host.send('class_next', {});
  host.send('class_next', {});
  const done = await host.state((s) => s.phase === 'done');
  assert.deepEqual(done.summary.map((s) => s.miss), [0, 1]);
});

test('class messages do not touch arcade rooms, and arcade rooms still work beside a class', async () => {
  const host = await client();
  host.send('class_create', { rows: ROWS });
  await host.waitFor('class_created');

  const p = await client();
  p.send('create_room', { name: 'Arcade' });
  const { payload } = await p.waitFor('room_created');
  assert.match(payload.code, /^[A-Z2-9]{5}$/);

  // an arcade code is not a class code
  const s = await client();
  s.send('class_join', { code: payload.code, token: 'tab-xyz-0001' });
  assert.equal((await s.waitFor('class_error')).payload.code, 'class_not_found');

  // and leaving the arcade room does not disturb the class
  p.send('leave_room', {});
  host.send('class_start', {});
  assert.equal((await host.state((st) => st.phase === 'word')).index, 0);
});
