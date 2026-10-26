// minerMode.test.js - MINER end to end against the REAL server (server.js on an ephemeral port, real
// WebSocket clients): quick match + bot fill, private rounds, ore results, the reveal, cave-ins, leave.

process.env.PORT = '0';
process.env.MINER_FILL_WAIT_MS = '300';
process.env.MINER_ROUND_MS = '900';
process.env.MINER_REVEAL_MS = '200';
process.env.MINER_OVER_MS = '100';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');

const { server, wss } = require('./server');
const { stopRoomReaper, _resetRoomsForTesting, listPublicRooms } = require('./roomManager');
const { _resetQueueForTesting } = require('./minerMatch');
const miner = require('./miner');

let port;

class Client {
  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.received = [];
    this.waiters = [];
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const i = this.waiters.findIndex((w) => w.type === msg.type && w.match(msg));
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
    this.id = (await this.waitFor('connected')).payload.id;
    return this;
  }
  send(type, payload) {
    this.ws.send(JSON.stringify({ type, payload }));
  }
  waitFor(type, ms = 6000, match = () => true) {
    const idx = this.received.findIndex((m) => m.type === type && match(m));
    if (idx !== -1) return Promise.resolve(this.received.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for "${type}"`)), ms);
      this.waiters.push({ type, resolve, timer, match });
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

// The head of a list's canon: always on the list, always DIRT.
const obvious = (prompt) => require('./blitzCanon.json')[prompt][0].canon;

async function privateMine() {
  const a = await client();
  const b = await client();
  a.send('create_room', { name: 'ANNA' });
  const { payload } = await a.waitFor('room_created');
  b.send('join_room', { code: payload.code, name: 'BO' });
  await b.waitFor('room_joined');
  a.send('set_game_type', { gameType: 'miner' });
  await a.waitFor('room_update', 6000, (m) => m.payload.gameType === 'miner' && m.payload.players.length === 2);
  a.send('start_game', {});
  const [sa] = await Promise.all([a.waitFor('miner_start'), b.waitFor('miner_start')]);
  const [ra, rb] = await Promise.all([a.waitFor('miner_round'), b.waitFor('miner_round')]);
  return { a, b, code: payload.code, sa, ra, rb };
}

test.before(async () => {
  if (!server.listening) await once(server, 'listening');
  port = server.address().port;
});
test.beforeEach(() => {
  _resetRoomsForTesting();
  _resetQueueForTesting();
});
test.after(async () => {
  clients.forEach((c) => c.close());
  wss.clients.forEach((c) => c.terminate());
  _resetRoomsForTesting();
  stopRoomReaper();
  wss.close();
  await new Promise((resolve) => server.close(resolve));
});

test('two humans in a private mine get the same prompt and no bots', async () => {
  const { sa, ra, rb } = await privateMine();
  assert.equal(sa.payload.miners.length, 2);
  assert.equal(sa.payload.target, miner.TARGET_DEPTH);
  assert.equal(ra.payload.prompt, rb.payload.prompt);
  assert.ok(miner.PROMPTS.includes(ra.payload.prompt));
  assert.ok(ra.payload.endsAt > ra.payload.serverNow);
});

test('an answer is judged privately, the room sees only who locked, and both locking ends the round early', async () => {
  const { a, b, ra } = await privateMine();
  const prompt = ra.payload.prompt;
  a.send('submit_word', { word: 'zzqqxx' });
  const bad = await a.waitFor('miner_result');
  assert.deepEqual([bad.payload.accepted, bad.payload.reason], [false, 'not_on_list']);

  a.send('submit_word', { word: obvious(prompt) });
  const ok = await a.waitFor('miner_result', 6000, (m) => m.payload.accepted);
  assert.equal(ok.payload.ore, 'dirt');
  const lockB = await b.waitFor('miner_locked');
  assert.deepEqual(lockB.payload.ids, [a.id]);
  assert.equal(b.received.some((m) => m.type === 'miner_result'), false, 'B never sees A\'s answer before the reveal');

  const t0 = Date.now();
  b.send('submit_word', { word: obvious(prompt) });
  const [rev] = await Promise.all([a.waitFor('miner_reveal'), b.waitFor('miner_reveal')]);
  assert.ok(Date.now() - t0 < 600, 'the round closes as soon as everyone locks');
  const picks = Object.fromEntries(rev.payload.picks.map((p) => [p.id, p]));
  assert.equal(picks[a.id].shared, true, 'the same answer splits the vein');
  assert.equal(picks[a.id].gained, 5);
  assert.equal(rev.payload.miners.find((m) => m.id === a.id).depth, 5);
  const next = await a.waitFor('miner_round', 3000);
  assert.equal(next.payload.round, 2);
  assert.notEqual(next.payload.prompt, prompt);
});

test('a blank at the bell is a cave-in', async () => {
  const { a, ra } = await privateMine();
  a.send('submit_word', { word: obvious(ra.payload.prompt) });
  const rev = await a.waitFor('miner_reveal', 4000);
  const bPick = rev.payload.picks.find((p) => p.id !== a.id);
  assert.equal(bPick.caveIn, true);
  assert.equal(rev.payload.miners.find((m) => m.id !== a.id).lives, miner.START_LIVES - 1);
});

test('three cave-ins knock a miner out and the last one standing wins', async () => {
  const { a, ra } = await privateMine();
  let prompt = ra.payload.prompt;
  for (let i = 0; i < miner.START_LIVES; i++) {
    if (i > 0) prompt = (await a.waitFor('miner_round', 4000)).payload.prompt;
    a.send('submit_word', { word: obvious(prompt) });
    await a.waitFor('miner_reveal', 4000);
  }
  const over = await a.waitFor('miner_over', 4000);
  assert.equal(over.payload.reason, 'last_standing');
  assert.deepEqual(over.payload.winnerIds, [a.id]);
});

test('quick match: a lone miner is topped up with bots, and the bots dig through the real path', async () => {
  const a = await client();
  a.send('miner_quick_match', { name: 'SOLO' });
  await a.waitFor('room_created');
  const q = await a.waitFor('miner_queue');
  assert.equal(q.payload.humans, 1);
  const start = await a.waitFor('miner_start', 4000);
  assert.equal(start.payload.miners.length, 3);
  assert.equal(start.payload.miners.filter((m) => m.isBot).length, 2);
  const rev = await a.waitFor('miner_reveal', 6000);
  const botPicks = rev.payload.picks.filter((p) => p.id !== a.id && p.answer);
  for (const p of botPicks) assert.ok(miner.judgeAnswer(rev.payload.prompt, p.answer).ok);
});

test('quick match: a second miner joins the waiting mine; quick-match mines stay out of the public list', async () => {
  const a = await client();
  const b = await client();
  a.send('miner_quick_match', { name: 'A' });
  const { payload } = await a.waitFor('room_created');
  assert.equal(listPublicRooms().some((r) => r.code === payload.code), false);
  b.send('miner_quick_match', { name: 'B' });
  const joined = await b.waitFor('room_joined');
  assert.equal(joined.payload.code, payload.code);
  const start = await a.waitFor('miner_start', 4000);
  assert.equal(start.payload.miners.length, 2, 'two humans launch without bots');
});

test('the last human leaving ends the dig', async () => {
  const { a, b } = await privateMine();
  b.close();
  const over = await a.waitFor('miner_over', 4000);
  assert.equal(over.payload.reason, 'forfeit');
  assert.deepEqual(over.payload.winnerIds, [a.id]);
});
