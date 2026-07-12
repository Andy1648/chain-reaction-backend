// tests/roomManager.gating.test.js
// Run with: npm test   (node --test discovers this file)
//
// Unit tests for roomManager.js orchestration that had no coverage:
//   - handleWordSubmission gating (no game / wrong turn) and its message
//     privacy: accepted results broadcast, rejections go ONLY to the submitter
//   - handleCategoryAnswer privacy: opponents see a count, never the answer
//   - handleRerollCategory's guard chain (host-only, ticking round, opening
//     window, allowance) and its authoritative round-restart broadcast
//   - imposter vote orchestration: vote_count broadcasts and the early phase
//     end once everyone has voted
//   - removePlayer: host reassignment and mid-game elimination of the
//     current player advancing the turn
//   - reapIdleRooms TTL behavior and the createRoom global cap
//
// Deliberately NOT covered here (owned elsewhere): join/start gating during
// live phases and AI-await races (t2-*.test.js), bot lifecycle
// (roomManager.test.js), full multi-round flows (tests/integration.*).
//
// Connections are recording fakes; each test starts from a wiped registry.
// startGame schedules a real 3s countdown timeout - the beforeEach/after
// reset tears those down so nothing leaks across tests.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRoom,
  joinRoom,
  getRoom,
  startGame,
  handleWordSubmission,
  handleRerollCategory,
  handleImposterVote,
  removePlayer,
  startRoundTimer,
  reapIdleRooms,
  _resetRoomsForTesting,
} = require('../roomManager');

const gameLogic = require('../gameLogic');
const CATEGORY_ANSWERS = require('../categoryAnswers');

// Word Bomb tests need deterministic word validity without the network.
gameLogic._setDictionaryForTesting({ isValidWord: async (w) => /^[a-z]{3,}$/.test(w.trim().toLowerCase()) });

// A recording fake connection: every message sent to it is parsed and kept.
let nextId = 0;
function conn() {
  const messages = [];
  return {
    id: `t1c${nextId++}`,
    readyState: 1,
    messages,
    send(raw) {
      messages.push(JSON.parse(raw));
    },
  };
}

function messagesOfType(connection, type) {
  return connection.messages.filter((m) => m.type === type);
}

test.beforeEach(() => _resetRoomsForTesting());
test.after(() => _resetRoomsForTesting());

/* ==================== handleWordSubmission gating ======================= */

test('a submission with no game in the room errors no_active_game', async () => {
  const host = conn();
  const { room } = createRoom(host, 'Host');
  const res = await handleWordSubmission(room, host.id, 'garden');
  assert.equal(res.error, 'no_active_game');
});

test('a submission from the wrong player errors not_your_turn and changes nothing', async () => {
  const host = conn();
  const p2 = conn();
  const { room } = createRoom(host, 'Host');
  joinRoom(room.code, p2, 'Two');
  startGame(room);
  room.game.currentCombo = 'ar';
  // turnOrder[0] is the host - p2 tries to jump the queue.
  const res = await handleWordSubmission(room, p2.id, 'garden');
  assert.equal(res.error, 'not_your_turn');
  assert.equal(room.game.usedWords.size, 0);
  assert.equal(room.game.completedTurnCount, 0);
});

test('an ACCEPTED word broadcasts word_result + turn_update to every player', async () => {
  const host = conn();
  const p2 = conn();
  const { room } = createRoom(host, 'Host');
  joinRoom(room.code, p2, 'Two');
  startGame(room);
  room.game.currentCombo = 'ar';

  const { result } = await handleWordSubmission(room, host.id, 'garden');
  assert.equal(result.accepted, true);

  for (const c of [host, p2]) {
    const results = messagesOfType(c, 'word_result');
    assert.equal(results.length, 1, 'everyone sees the accepted word');
    assert.equal(results[0].payload.word, 'garden');
    assert.ok(messagesOfType(c, 'turn_update').length >= 2, 'a fresh turn_update follows');
  }
});

test('a REJECTED word goes only to the submitter - opponents see nothing', async () => {
  const host = conn();
  const p2 = conn();
  const { room } = createRoom(host, 'Host');
  joinRoom(room.code, p2, 'Two');
  startGame(room);
  room.game.currentCombo = 'ar';

  const { result } = await handleWordSubmission(room, host.id, 'zzz'); // no combo
  assert.equal(result.accepted, false);

  assert.equal(messagesOfType(host, 'word_result').length, 1, 'the submitter is told');
  assert.equal(messagesOfType(p2, 'word_result').length, 0, 'the rival is not spammed');
  assert.equal(room.game.completedTurnCount, 0, 'a rejection does not consume the turn');
});

/* ==================== Category Blitz answer privacy ====================== */

test('a blitz answer result is private; rivals get only a count', async () => {
  const host = conn();
  const p2 = conn();
  const { room } = createRoom(host, 'Host');
  room.gameType = 'category-blitz';
  joinRoom(room.code, p2, 'Two');
  startGame(room);
  room.game.currentCategory = 'Pizza toppings';
  const answer = [...CATEGORY_ANSWERS['Pizza toppings']][0];

  await handleWordSubmission(room, host.id, answer);

  assert.equal(messagesOfType(host, 'answer_result').length, 1);
  assert.equal(messagesOfType(p2, 'answer_result').length, 0, 'answers stay hidden mid-round');

  const progress = messagesOfType(p2, 'player_progress');
  assert.equal(progress.length, 1);
  assert.deepEqual(progress[0].payload, { playerId: host.id, answerCount: 1 });
  const leaked = JSON.stringify(p2.messages).toLowerCase().includes(answer.toLowerCase());
  assert.equal(leaked, false, `the rival's messages must never contain "${answer}"`);
});

test('a REJECTED blitz answer produces no progress broadcast at all', async () => {
  const host = conn();
  const p2 = conn();
  const { room } = createRoom(host, 'Host');
  room.gameType = 'category-blitz';
  joinRoom(room.code, p2, 'Two');
  startGame(room);

  await handleWordSubmission(room, host.id, 'x'); // too_short
  assert.equal(messagesOfType(host, 'answer_result').length, 1);
  assert.equal(messagesOfType(p2, 'player_progress').length, 0);
});

/* ======================== reroll guard chain ============================= */

function blitzRoomMidRound() {
  const host = conn();
  const p2 = conn();
  const { room } = createRoom(host, 'Host');
  room.gameType = 'category-blitz';
  joinRoom(room.code, p2, 'Two');
  startGame(room);
  startRoundTimer(room); // the round is now actively ticking
  return { room, host, p2 };
}

test('handleRerollCategory rejects non-hosts in multiplayer but allows the solo player', () => {
  const { room, p2 } = blitzRoomMidRound();
  assert.equal(handleRerollCategory(room, p2.id).error, 'host_only_reroll');

  // Solo: the lone player needs no host privilege.
  const solo = conn();
  const soloRoom = createRoom(solo, 'Solo').room;
  soloRoom.gameType = 'category-blitz';
  startGame(soloRoom);
  startRoundTimer(soloRoom);
  assert.equal(handleRerollCategory(soloRoom, solo.id).error, undefined);
});

test('a reroll is rejected while the round clock is NOT ticking (countdown / intermission)', () => {
  const host = conn();
  const p2 = conn();
  const { room } = createRoom(host, 'Host');
  room.gameType = 'category-blitz';
  joinRoom(room.code, p2, 'Two');
  startGame(room); // round announced, but the timer is still in the 3s countdown
  assert.equal(handleRerollCategory(room, host.id).error, 'round_not_active');
});

test('a reroll is rejected once the opening window has passed', () => {
  const { room, host } = blitzRoomMidRound();
  room.roundStartedAt = Date.now() - 6000; // window is 5s
  assert.equal(handleRerollCategory(room, host.id).error, 'reroll_window_closed');
});

test('a reroll is rejected once the allowance is spent', () => {
  const { room, host } = blitzRoomMidRound();
  room.game.rerollsRemaining = 0;
  assert.equal(handleRerollCategory(room, host.id).error, 'no_rerolls_left');
});

test('a valid reroll broadcasts an authoritative round_start restart to everyone', () => {
  const { room, host, p2 } = blitzRoomMidRound();
  const before = room.game.currentCategory;

  const res = handleRerollCategory(room, host.id);
  assert.equal(res.error, undefined);

  for (const c of [host, p2]) {
    const restarts = messagesOfType(c, 'round_start').filter((m) => m.payload.reroll === true);
    assert.equal(restarts.length, 1);
    assert.equal(restarts[0].payload.byId, host.id);
    assert.notEqual(restarts[0].payload.category, before);
    assert.equal(restarts[0].payload.round, room.game.currentRound, 'same round number - a redo, not an advance');
  }
  assert.ok(room.roundTimerInterval, 'a fresh full-length round timer is running');
});

/* ==================== imposter vote orchestration ======================== */

function imposterRoomInVoting() {
  const players = [conn(), conn(), conn()];
  const { room } = createRoom(players[0], 'P0');
  room.gameType = 'imposter-word';
  joinRoom(room.code, players[1], 'P1');
  joinRoom(room.code, players[2], 'P2');
  startGame(room);
  room.game.status = 'voting'; // jump straight to the phase under test
  return { room, players };
}

test('each accepted vote broadcasts a privacy-safe vote_count (who-voted-for-whom stays secret)', () => {
  const { room, players } = imposterRoomInVoting();
  const [a, b] = players;

  handleImposterVote(room, a.id, b.id);

  for (const c of players) {
    const counts = messagesOfType(c, 'vote_count');
    assert.equal(counts.length, 1);
    assert.deepEqual(counts[0].payload, { voted: 1, total: 3 });
    assert.ok(!JSON.stringify(counts[0].payload).includes(b.id), 'no suspect id in the broadcast');
  }
});

test('the vote phase ends early with a vote_results broadcast once everyone has voted', () => {
  const { room, players } = imposterRoomInVoting();
  const [a, b, c] = players;

  handleImposterVote(room, a.id, b.id);
  handleImposterVote(room, b.id, a.id);
  assert.equal(room.game.status, 'voting', 'still waiting on the last voter');
  assert.equal(messagesOfType(a, 'vote_results').length, 0);

  handleImposterVote(room, c.id, a.id);

  assert.equal(room.game.status, 'reveal');
  for (const p of players) {
    const results = messagesOfType(p, 'vote_results');
    assert.equal(results.length, 1);
    assert.equal(results[0].payload.phase, 'reveal');
    assert.equal(typeof results[0].payload.imposterCaught, 'boolean');
  }
});

test('a vote outside the voting phase errors round_not_active', () => {
  const { room, players } = imposterRoomInVoting();
  room.game.status = 'answering';
  assert.equal(handleImposterVote(room, players[0].id, players[1].id).error, 'round_not_active');
});

/* ==================== removePlayer mid-game behavior ===================== */

test('when the host leaves, the next player inherits the host seat', () => {
  const host = conn();
  const p2 = conn();
  const { room } = createRoom(host, 'Host');
  joinRoom(room.code, p2, 'Two');

  removePlayer(room, host.id);
  assert.equal(room.hostId, p2.id);
  assert.ok(getRoom(room.code), 'the room lives on under the new host');
});

test('the CURRENT player disconnecting mid-Word-Bomb is eliminated and the turn advances', async () => {
  const players = [conn(), conn(), conn()];
  const { room } = createRoom(players[0], 'P0');
  joinRoom(room.code, players[1], 'P1');
  joinRoom(room.code, players[2], 'P2');
  startGame(room);

  const leaverId = room.game.turnOrder[room.game.currentPlayerIndex];
  assert.equal(leaverId, players[0].id);

  removePlayer(room, leaverId);

  const gonePlayer = room.game.players.find((p) => p.id === leaverId);
  assert.equal(gonePlayer.eliminated, true);
  assert.equal(gonePlayer.lives, 0);
  assert.equal(room.game.status, 'in_progress', '2 players remain - game continues');
  assert.notEqual(room.game.turnOrder[room.game.currentPlayerIndex], leaverId);
  // The survivors were told about the new turn.
  assert.ok(messagesOfType(players[1], 'turn_update').length >= 2);
});

test('removePlayer destroys an empty room entirely', () => {
  const host = conn();
  const { room } = createRoom(host, 'OnlyOne');
  removePlayer(room, host.id);
  assert.equal(getRoom(room.code), undefined);
});

/* ============================ idle reaper ================================ */

test('reapIdleRooms removes only stale lobbies, warns their players, and spares live games', () => {
  const now = Date.now();
  const TTL = 20 * 60 * 1000;

  // Stale waiting lobby - reaped.
  const idleHost = conn();
  const idle = createRoom(idleHost, 'Idle').room;
  idle.lastActivity = now - TTL - 1;

  // Fresh lobby - kept.
  const fresh = createRoom(conn(), 'Fresh').room;

  // Stale but MID-GAME - never reaped.
  const busyHost = conn();
  const busy = createRoom(busyHost, 'Busy').room;
  joinRoom(busy.code, conn(), 'B2');
  startGame(busy);
  busy.lastActivity = now - TTL - 1;

  // Stale with a FINISHED game - fair game for the reaper.
  const doneHost = conn();
  const done = createRoom(doneHost, 'Done').room;
  joinRoom(done.code, conn(), 'D2');
  startGame(done);
  done.game.status = 'finished';
  done.lastActivity = now - TTL - 1;

  const reaped = reapIdleRooms(now);

  assert.deepEqual(reaped.sort(), [idle.code, done.code].sort());
  assert.equal(getRoom(idle.code), undefined);
  assert.equal(getRoom(done.code), undefined);
  assert.ok(getRoom(fresh.code), 'fresh lobby survives');
  assert.ok(getRoom(busy.code), 'in-progress game survives no matter how idle');

  const closed = messagesOfType(idleHost, 'room_closed');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].payload.reason, 'idle');
});

/* ============================ room cap =================================== */

test('createRoom refuses with server_busy at the global cap instead of crashing', () => {
  // Fill the registry to the 500-room ceiling.
  for (let i = 0; i < 500; i += 1) {
    const res = createRoom(conn(), `H${i}`);
    assert.equal(res.error, undefined, `room ${i} under the cap must succeed`);
  }
  const overflow = createRoom(conn(), 'TooMany');
  assert.deepEqual(overflow, { error: 'server_busy' });
});
