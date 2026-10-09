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
const { stopRoomReaper, _resetRoomsForTesting, getRoom } = require('./roomManager');
const { _resetQueueForTesting } = require('./wordRaceMatch');
const wordBombBot = require('./wordBombBot');

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

// A real word for a fragment that this racer hasn't used.
const realWord = (frag, used = []) => wordBombBot.pickWord(frag, new Set(used));

// Private rooms default to the whole-word race; these tests pin the fragment race unless told
// otherwise (variant: null leaves the room's default alone).
async function privateRace({ bot = false, variant = 'fragments' } = {}) {
  const a = await client();
  const b = await client();
  a.send('create_room', { name: 'ANNA' });
  const { payload } = await a.waitFor('room_created');
  b.send('join_room', { code: payload.code, name: 'BO' });
  await b.waitFor('room_joined');
  a.send('set_game_type', { gameType: 'word-race' });
  if (bot) a.send('race_add_bot', {});
  await a.waitFor('room_update', 6000, (m) => m.payload.gameType === 'word-race' && (!bot || m.payload.players.length === 3));
  if (variant) getRoom(payload.code).raceVariant = variant;
  a.send('start_game', {});
  const [sa, sb] = await Promise.all([a.waitFor('race_start'), b.waitFor('race_start')]);
  await Promise.all([a.waitFor('race_go'), b.waitFor('race_go')]);
  return { a, b, code: payload.code, sa, sb };
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

test('a private room plays the whole-word race by default', async () => {
  const { sa, sb } = await privateRace({ variant: null });
  assert.equal(sa.payload.variant, 'words');
  assert.ok(sa.payload.words.length > 0);
  assert.deepEqual(sa.payload.words, sb.payload.words);
});

test('both racers get the identical fragment sequence; two humans get no auto bots', async () => {
  const { sa, sb } = await privateRace();
  assert.deepEqual(sa.payload.fragments, sb.payload.fragments);
  assert.equal(sa.payload.fragments.length, 12);
  assert.equal(sa.payload.seed, sb.payload.seed);
  assert.equal(sa.payload.racers.length, 2, '2 humans launch without bots');
});

test('accepted word advances the racer and is broadcast; same word stays legal for the rival', async () => {
  const { a, b, sa } = await privateRace();
  const w = realWord(sa.payload.fragments[0]);
  a.send('submit_word', { word: w });
  const res = await a.waitFor('race_word_result');
  assert.equal(res.payload.accepted, true);
  assert.equal(res.payload.index, 1);
  const [pa, pb] = await Promise.all([a.waitFor('race_progress'), b.waitFor('race_progress')]);
  assert.deepEqual(pa.payload, pb.payload, 'both clients see the same progress frame');
  assert.equal(pa.payload.racerId, a.id);

  b.send('submit_word', { word: w });
  const rb = await b.waitFor('race_word_result');
  assert.equal(rb.payload.accepted, true, "a word racer A used is still allowed for racer B");
});

test('rejects name their reason', async () => {
  const { a, sa } = await privateRace();
  const frag = sa.payload.fragments[0];
  const cases = [
    ['ab', 'too_short'],
    ['qqqq', 'missing_combo'],
    [`zq${frag}zq`, 'not_a_word'],
  ];
  for (const [word, reason] of cases) {
    a.send('submit_word', { word });
    const r = await a.waitFor('race_word_result');
    assert.equal(r.payload.accepted, false, word);
    assert.equal(r.payload.reason, reason, word);
  }
});

test('already_used names its reason (per-racer memory)', async () => {
  const { a, code } = await privateRace();
  const g = getRoom(code).game;
  // Force a sequence where the same fragment repeats so a reuse is reachable.
  g.fragments = g.fragments.map(() => 'ing');
  a.send('submit_word', { word: 'singing' });
  await a.waitFor('race_word_result', 6000, (m) => m.payload.accepted);
  a.send('submit_word', { word: 'singing' });
  const r = await a.waitFor('race_word_result');
  assert.equal(r.payload.reason, 'already_used');
});

test('first to 12 wins; both clients get the same race_over', async () => {
  const { a, b, sa } = await privateRace();
  const used = [];
  for (const frag of sa.payload.fragments) {
    const w = realWord(frag, used);
    used.push(w);
    a.send('submit_word', { word: w });
    await a.waitFor('race_word_result', 6000, (m) => m.payload.accepted);
  }
  const [oa, ob] = await Promise.all([a.waitFor('race_over'), b.waitFor('race_over')]);
  assert.equal(oa.payload.winnerId, a.id);
  assert.equal(ob.payload.winnerId, a.id);
  assert.equal(oa.payload.reason, 'finish');
  assert.equal(oa.payload.standings[0].words, 12);
  assert.deepEqual(oa.payload.standings[0].wordList, used);
});

test('the cap ends the race: most words wins', async () => {
  const { a, b, sa, code } = await privateRace();
  b.send('submit_word', { word: realWord(sa.payload.fragments[0]) });
  await b.waitFor('race_word_result', 6000, (m) => m.payload.accepted);
  // Fire the cap now instead of waiting 90s.
  const room = getRoom(code);
  const mode = require('./wordRaceMode');
  clearTimeout(room.roundTimerInterval);
  mode._endRace(room, 'cap', {
    clearRoundTimer: () => {},
    broadcastToRoom: require('./roomManager').broadcastToRoom,
  });
  const [oa, ob] = await Promise.all([a.waitFor('race_over'), b.waitFor('race_over')]);
  assert.equal(oa.payload.reason, 'cap');
  assert.equal(oa.payload.winnerId, b.id);
  assert.equal(ob.payload.winnerId, b.id);
});

test('host-added bot races and scores through the real submit path', async () => {
  const { a, sa, code } = await privateRace({ bot: true });
  assert.equal(sa.payload.racers.length, 3);
  const bot = sa.payload.racers.find((r) => r.isBot);
  assert.ok(bot, 'one bot racer');
  getRoom(code).game.botPaceMs = 1500; // hurry the bot for the test
  const p = await a.waitFor('race_progress', 15000, (m) => m.payload.racerId === bot.id);
  assert.equal(p.payload.index, 1);
});

test('quick-match: a lone human is topped up with bots to 3 racers', async () => {
  const a = await client();
  a.send('race_quick_match', { name: 'SOLO', pace: 3000 });
  await a.waitFor('room_created');
  const q = await a.waitFor('race_queue');
  assert.equal(q.payload.humans, 1);
  const start = await a.waitFor('race_start');
  assert.equal(start.payload.racers.length, 3);
  assert.equal(start.payload.racers.filter((r) => r.isBot).length, 2);
});

test('quick-match: a second human joins the waiting room; no bots at launch', async () => {
  const a = await client();
  const b = await client();
  a.send('race_quick_match', { name: 'A' });
  const created = await a.waitFor('room_created');
  b.send('race_quick_match', { name: 'B' });
  const joined = await b.waitFor('room_joined');
  assert.equal(joined.payload.code, created.payload.code);
  const [sa, sb] = await Promise.all([a.waitFor('race_start'), b.waitFor('race_start')]);
  assert.equal(sa.payload.racers.length, 2);
  assert.deepEqual(sa.payload.fragments, sb.payload.fragments);
});

test('quick-match rooms never appear in the public Word Bomb list', async () => {
  const a = await client();
  a.send('race_quick_match', { name: 'A' });
  await a.waitFor('room_created');
  a.send('list_public_rooms', {});
  const list = await a.waitFor('public_rooms');
  assert.equal(list.payload.rooms.length, 0);
});

test('a rival leaving mid-race forfeits it to the survivor', async () => {
  const { a, b, sa } = await privateRace();
  a.send('submit_word', { word: realWord(sa.payload.fragments[0]) });
  await a.waitFor('race_word_result', 6000, (m) => m.payload.accepted);
  b.close();
  const over = await a.waitFor('race_over');
  assert.equal(over.payload.reason, 'forfeit');
  assert.equal(over.payload.winnerId, a.id);
});

test('rematch after a race resets to the lobby', async () => {
  const { a, b, code } = await privateRace();
  b.close();
  await a.waitFor('race_over');
  a.send('rematch', {});
  await a.waitFor('game_reset');
  assert.equal(getRoom(code).game, null);
});
