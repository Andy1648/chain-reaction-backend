// learnPause.test.js — PAUSE TO LEARN (frontend P9c): when a Word Bomb turn blows up, the bomb holds LEARN_PAUSE_MS
// before the next turn's timer starts, announced on the post-timeout turn_update as `learnPauseMs`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { _setDictionaryForTesting } = require('./gameLogic');
const {
  createRoom,
  joinRoom,
  startGame,
  handleWordSubmission,
  LEARN_PAUSE_MS,
  _resetRoomsForTesting,
} = require('./roomManager');

function rec(id) {
  const received = [];
  return { id, readyState: 1, received, send(raw) { try { received.push(JSON.parse(raw)); } catch { /* not JSON */ } } };
}

function setup() {
  const host = rec('host');
  const { room } = createRoom(host, 'Host');
  const p2 = rec('p2');
  joinRoom(room.code, p2, 'P2');
  room.difficultyKey = 'chill';
  startGame(room);
  return { host, p2, room };
}

test.beforeEach(() => _resetRoomsForTesting());
test.after(() => _resetRoomsForTesting());

test('a blown-up turn holds the bomb LEARN_PAUSE_MS, says so on the turn_update, then the timer runs', () => {
  test.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const { host, room } = setup();
    assert.equal(LEARN_PAUSE_MS, 2000);
    const ticks = () => host.received.filter((m) => m.type === 'timer_tick').length;
    // run the opening countdown + the whole first turn out
    let guard = 0;
    while (!host.received.some((m) => m.type === 'turn_timeout') && guard++ < 100) test.mock.timers.tick(1000);
    const iTo = host.received.findIndex((m) => m.type === 'turn_timeout');
    const after = host.received[iTo + 1];
    assert.equal(after.type, 'turn_update');
    assert.equal(after.payload.learnPauseMs, LEARN_PAUSE_MS, 'the post-timeout turn_update announces the hold');
    assert.equal(after.payload.players.find((p) => p.id === 'host').lives, 2);
    // during the hold: no ticks, no timer, and the clock on the wire is the next turn's full time
    const t0 = ticks();
    test.mock.timers.tick(LEARN_PAUSE_MS - 100);
    assert.equal(ticks(), t0, 'no timer_tick while the bomb holds');
    assert.equal(room.turnTimerInterval, null);
    // after the hold the next turn's timer runs
    test.mock.timers.tick(100);
    assert.ok(room.turnTimerInterval, 'the timer starts once the hold ends');
    test.mock.timers.tick(1000);
    assert.equal(ticks(), t0 + 1);
    // an ordinary (non-timeout) turn_update never carries the field
    assert.ok(host.received.filter((m) => m.type === 'turn_update' && m !== after).every((m) => m.payload.learnPauseMs === undefined));
  } finally {
    test.mock.timers.reset();
    _resetRoomsForTesting();
  }
});

test('a word submitted DURING the hold is accepted and the next timer starts normally (the hold is cleared)', async () => {
  test.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  _setDictionaryForTesting({ isValidWord: async () => true });
  try {
    const { host, room } = setup();
    let guard = 0;
    while (!host.received.some((m) => m.type === 'turn_timeout') && guard++ < 100) test.mock.timers.tick(1000);
    const combo = room.game.currentCombo;
    const next = room.game.players.find((p) => p.id !== 'host').id;
    await handleWordSubmission(room, next, `zz${combo}zz`, { expectedCombo: combo });
    const res = host.received.filter((m) => m.type === 'word_result').pop();
    assert.equal(res && res.payload.accepted, true, 'the next player may answer during the hold');
    assert.equal(room.countdownTimeout, null, 'the hold is cleared by the new turn');
    assert.ok(room.turnTimerInterval, 'the next turn timer is running');
    test.mock.timers.tick(LEARN_PAUSE_MS + 50); // the stale hold must not restart anything
    assert.ok(room.turnTimerInterval);
  } finally {
    _setDictionaryForTesting(require('./dictionary'));
    test.mock.timers.reset();
    _resetRoomsForTesting();
  }
});

test('the eliminating timeout still sends turn_update then game_over with no hold', () => {
  test.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const { host } = setup();
    let guard = 0;
    while (!host.received.some((m) => m.type === 'game_over') && guard++ < 500) test.mock.timers.tick(1000);
    const types = host.received.map((m) => m.type);
    const go = types.lastIndexOf('game_over');
    assert.equal(types[go - 1], 'turn_update');
    assert.equal(host.received[go - 1].payload.learnPauseMs, undefined, 'no hold on the final frame');
  } finally {
    test.mock.timers.reset();
    _resetRoomsForTesting();
  }
});
