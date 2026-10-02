// wordRaceWords.test.js - the WHOLE-WORD race variant (Andy oct2 A6) end to end against the REAL server.
// (harness copied from wordRaceMode.test.js)
// wordRaceMode.test.js - WORD RACE end to end against the REAL server (server.js
// on an ephemeral port, real WebSocket clients, the real local dictionary - no
// network). Covers the orchestrator + wire: identical sequences, per-racer used
// words, named reject reasons, bots, the cap, quick-match, and leave.

process.env.PORT = '0';
process.env.RACE_FILL_WAIT_MS = '400'; // quick-match launches fast in tests

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');

const { server, wss } = require('./server');
const { stopRoomReaper, _resetRoomsForTesting } = require('./roomManager');
const { _resetQueueForTesting } = require('./wordRaceMatch');

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


async function wordsMatch(names = ['A', 'B']) {
  const cs = [];
  for (const n of names) {
    const c = await client();
    c.send('race_quick_match', { name: n, variant: 'words' });
    await c.waitFor(cs.length ? 'room_joined' : 'room_created');
    cs.push(c);
  }
  const starts = await Promise.all(cs.map((c) => c.waitFor('race_start')));
  await Promise.all(cs.map((c) => c.waitFor('race_go')));
  return { cs, starts };
}

test('words variant: every racer gets the SAME sequence of whole common words', async () => {
  const { starts } = await wordsMatch();
  const [sa, sb] = starts;
  assert.equal(sa.payload.variant, 'words');
  assert.equal(sa.payload.words.length, 25);
  assert.equal(sa.payload.target, 25);
  assert.equal(sa.payload.capMs, 60000);
  assert.deepEqual(sa.payload.words, sb.payload.words);
  assert.deepEqual(sa.payload.fragments, sa.payload.words, 'fragments mirror the words (old readers see the word)');
  for (const w of sa.payload.words) assert.match(w, /^[a-z]{3,8}$/);
  assert.equal(new Set(sa.payload.words).size, 25, 'no repeats');
});

test('words variant: only the exact current word advances; anything else is wrong_word (no dictionary)', async () => {
  const { cs, starts } = await wordsMatch();
  const [a, b] = cs;
  const words = starts[0].payload.words;
  for (const bad of [words[1], words[0] + 's', 'the', words[0].slice(0, -1)]) {
    if (bad === words[0]) continue;
    a.send('submit_word', { word: bad });
    const r = await a.waitFor('race_word_result');
    assert.equal(r.payload.accepted, false, bad);
    assert.equal(r.payload.reason, 'wrong_word', bad);
    assert.equal(r.payload.index, 0);
  }
  a.send('submit_word', { word: `  ${words[0].toUpperCase()} ` });
  const ok = await a.waitFor('race_word_result');
  assert.equal(ok.payload.accepted, true);
  assert.equal(ok.payload.index, 1);
  const [pa, pb] = await Promise.all([a.waitFor('race_progress'), b.waitFor('race_progress')]);
  assert.deepEqual(pa.payload, pb.payload, 'both racers see the same progress frame');
  assert.equal(pa.payload.word, words[0]);
  // the rival still types the same first word
  b.send('submit_word', { word: words[0] });
  assert.equal((await b.waitFor('race_word_result')).payload.accepted, true);
});

test('words variant: typing all 25 finishes the race with that racer as the winner', async () => {
  const { cs, starts } = await wordsMatch();
  const [a, b] = cs;
  const words = starts[0].payload.words;
  for (const w of words) {
    a.send('submit_word', { word: w });
    const r = await a.waitFor('race_word_result');
    assert.equal(r.payload.accepted, true, w);
  }
  const [oa, ob] = await Promise.all([a.waitFor('race_over'), b.waitFor('race_over')]);
  assert.equal(oa.payload.reason, 'finish');
  assert.equal(oa.payload.winnerId, a.id);
  assert.equal(ob.payload.winnerId, a.id, 'same winner on both clients');
  assert.equal(oa.payload.variant, 'words');
  assert.equal(oa.payload.standings[0].words, 25);
});

test('words variant: a lone racer gets bots, and the bots type the words', async () => {
  const a = await client();
  a.send('race_quick_match', { name: 'SOLO', variant: 'words' });
  await a.waitFor('room_created');
  const start = await a.waitFor('race_start', 8000);
  assert.equal(start.payload.racers.filter((r) => r.isBot).length, 2);
  await a.waitFor('race_go');
  const words = start.payload.words;
  const p = await a.waitFor('race_progress', 8000, (m) => m.payload.racerId !== a.id);
  assert.equal(p.payload.word, words[0], 'a bot typed the first word of the sequence');
});

test('quick-match never mixes variants', async () => {
  const a = await client();
  const b = await client();
  a.send('race_quick_match', { name: 'A', variant: 'words' });
  const ca = await a.waitFor('room_created');
  b.send('race_quick_match', { name: 'B' }); // the fragment race
  const cb = await b.waitFor('room_created');
  assert.notEqual(ca.payload.code, cb.payload.code);
  const sb = await b.waitFor('race_start');
  assert.equal(sb.payload.variant, 'fragments');
  assert.equal(sb.payload.words, undefined);
});
