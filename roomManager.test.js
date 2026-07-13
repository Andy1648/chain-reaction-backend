// roomManager.test.js
// Run with: node --test roomManager.test.js
// Covers the public-rooms data layer added for the lobby browser / quick play
// (the isPublic flag, listPublicRooms filtering, quickPlay ranking +
// retry-on-race + create-fallback) plus the solo bot add/remove lifecycle for
// Word Bomb and Category Blitz. Uses Node's built-in test runner only (no npm
// deps) and a fake WebSocket connection. Most tests are timer-free; the Blitz
// bot live-round test runs real (short) timers and cleans them up via the
// beforeEach/after room reset.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRoom,
  joinRoom,
  startGame,
  resetGame,
  addBot,
  removeBot,
  removePlayer,
  getRoom,
  listPublicRooms,
  quickPlay,
  handleWordSubmission,
  handleCategoryAnswer,
  startRoundTimer,
  clearRoundTimer,
  MAX_PLAYERS_PER_ROOM,
  _resetRoomsForTesting,
} = require('./roomManager');

const CATEGORY_ANSWERS = require('./categoryAnswers');

// A stable accept-listed category the Blitz bot tests pin the round to, so bot
// picks are deterministic regardless of which category the game rolled.
const BLITZ_CATEGORY = 'Pizza toppings';

// Minimal stand-in for a ws connection: an id + an OPEN readyState + a no-op
// send (broadcasts call .send on every player). Each call gets a unique id.
let nextId = 0;
function conn() {
  return { id: `c${nextId++}`, readyState: 1, send() {} };
}

// Fill a room up to `n` players total (the host counts as 1) via real joinRoom.
function fillTo(code, n) {
  for (let i = 1; i < n; i++) {
    const res = joinRoom(code, conn(), `P${i}`);
    assert.ok(!res.error, `expected join to succeed, got ${res.error}`);
  }
}

test.beforeEach(() => _resetRoomsForTesting());
// Also clear after the final test: startGame schedules a countdown timeout, and
// a trailing one left by the last test would keep the process alive.
test.after(() => _resetRoomsForTesting());

// ---- isPublic flag --------------------------------------------------------

test('createRoom defaults to private (isPublic false)', () => {
  const { room } = createRoom(conn(), 'Host');
  assert.equal(room.isPublic, false);
});

test('createRoom with isPublic=true marks the room public', () => {
  const { room } = createRoom(conn(), 'Host', true);
  assert.equal(room.isPublic, true);
});

test('createRoom coerces a truthy non-bool isPublic to a real boolean', () => {
  const { room } = createRoom(conn(), 'Host', 'yes');
  assert.strictEqual(room.isPublic, true);
});

// ---- listPublicRooms filtering -------------------------------------------

test('listPublicRooms returns only public, waiting, not-full rooms', () => {
  // public + waiting + room (should appear)
  const pub = createRoom(conn(), 'Host', true).room;

  // private waiting room (excluded - not public)
  createRoom(conn(), 'Host', false);

  // public but full (excluded - not joinable)
  const full = createRoom(conn(), 'Host', true).room;
  fillTo(full.code, MAX_PLAYERS_PER_ROOM);

  // public but in-progress (excluded - game !== null)
  const playing = createRoom(conn(), 'Host', true).room;
  joinRoom(playing.code, conn(), 'P1'); // need 2 to start word-bomb
  startGame(playing);

  // public but finished (excluded - game !== null)
  const finished = createRoom(conn(), 'Host', true).room;
  joinRoom(finished.code, conn(), 'P1');
  startGame(finished);
  finished.game.status = 'finished';

  const list = listPublicRooms();
  assert.equal(list.length, 1);
  assert.equal(list[0].code, pub.code);
});

test('listPublicRooms entries expose only the display-safe summary', () => {
  const pub = createRoom(conn(), 'Host', true).room;
  joinRoom(pub.code, conn(), 'P1');

  const [entry] = listPublicRooms();
  assert.deepEqual(Object.keys(entry).sort(), [
    'code', 'gameType', 'maxPlayers', 'playerCount', 'status',
  ]);
  assert.equal(entry.code, pub.code);
  assert.equal(entry.playerCount, 2);
  assert.equal(entry.maxPlayers, MAX_PLAYERS_PER_ROOM);
  assert.equal(entry.gameType, 'word-bomb');
  assert.equal(entry.status, 'waiting');
});

// ---- quickPlay ------------------------------------------------------------

test('quickPlay joins the existing public waiting room', () => {
  const pub = createRoom(conn(), 'Host', true).room;

  const res = quickPlay(conn(), 'Newcomer');
  assert.equal(res.error, undefined);
  assert.equal(res.created, false);
  assert.equal(res.room.code, pub.code);
  assert.equal(pub.players.length, 2);
});

test('quickPlay ranks fullest-not-full first', () => {
  const big = createRoom(conn(), 'Host', true).room;
  fillTo(big.code, 5); // 5 players
  const small = createRoom(conn(), 'Host', true).room; // 1 player

  const res = quickPlay(conn(), 'Newcomer');
  assert.equal(res.created, false);
  assert.equal(res.room.code, big.code); // the fuller room wins
  assert.equal(big.players.length, 6);
  assert.equal(small.players.length, 1);
});

test('quickPlay skips a full room and retries the next candidate', () => {
  // The fullest candidate is actually AT capacity (race: it filled between a
  // would-be snapshot and the join). joinRoom must reject it and quickPlay must
  // fall through to the next-fullest joinable room.
  const full = createRoom(conn(), 'Host', true).room;
  fillTo(full.code, MAX_PLAYERS_PER_ROOM); // 8/8 - join will be rejected
  const open = createRoom(conn(), 'Host', true).room;
  joinRoom(open.code, conn(), 'P1'); // 2 players - the real target

  const res = quickPlay(conn(), 'Newcomer');
  assert.equal(res.created, false);
  assert.equal(res.room.code, open.code);
  assert.equal(full.players.length, MAX_PLAYERS_PER_ROOM); // untouched
  assert.equal(open.players.length, 3);
});

test('quickPlay ignores private and in-progress rooms when choosing', () => {
  createRoom(conn(), 'Host', false); // private - never a candidate
  const playing = createRoom(conn(), 'Host', true).room;
  joinRoom(playing.code, conn(), 'P1');
  startGame(playing); // in-progress - excluded

  // No joinable public room exists -> quickPlay creates a fresh public one.
  const res = quickPlay(conn(), 'Newcomer', () => true);
  assert.equal(res.created, true);
  assert.equal(res.room.isPublic, true);
  assert.notEqual(res.room.code, playing.code);
});

test('quickPlay creates a new public room when none are joinable', () => {
  const res = quickPlay(conn(), 'Solo', () => true);
  assert.equal(res.error, undefined);
  assert.equal(res.created, true);
  assert.equal(res.room.isPublic, true);
  assert.equal(res.room.players.length, 1);
});

test('quickPlay respects the create throttle on the create path', () => {
  // No joinable rooms AND the throttle says no -> rate_limited, no room made.
  const res = quickPlay(conn(), 'Solo', () => false);
  assert.equal(res.error, 'rate_limited');
  assert.equal(res.room, undefined);
  assert.equal(listPublicRooms().length, 0);
});

// ---- solo Word Bomb bot opponent (explicit add/remove) -------------------

test('addBot adds one bot at the chosen difficulty to a solo Word Bomb room', () => {
  const { room } = createRoom(conn(), 'Solo'); // private, word-bomb, 1 human
  const res = addBot(room, 'hard');
  assert.equal(res.ok, true);
  assert.equal(room.players.length, 2);
  const bots = room.players.filter((p) => p.isBot);
  assert.equal(bots.length, 1);
  assert.equal(bots[0].connection.readyState, 1);
  assert.equal(bots[0].botDifficulty, 'hard'); // independent of room timer difficulty
});

test('addBot defaults an invalid difficulty to medium', () => {
  const { room } = createRoom(conn(), 'Solo');
  addBot(room, 'banana');
  assert.equal(room.players.find((p) => p.isBot).botDifficulty, 'medium');
});

test('addBot refuses a second bot', () => {
  const { room } = createRoom(conn(), 'Solo');
  addBot(room, 'easy');
  const res = addBot(room, 'easy');
  assert.equal(res.error, 'bot_already_added');
  assert.equal(room.players.filter((p) => p.isBot).length, 1);
});

test('addBot refuses modes without bot support (imposter-word)', () => {
  const { room } = createRoom(conn(), 'Solo');
  room.gameType = 'imposter-word';
  assert.equal(addBot(room, 'easy').error, 'bot_mode_unsupported');
  assert.equal(room.players.some((p) => p.isBot), false);
});

test('addBot refuses when more than one human is present', () => {
  const { room } = createRoom(conn(), 'Host');
  joinRoom(room.code, conn(), 'Friend'); // 2 humans
  assert.equal(addBot(room, 'easy').error, 'bot_solo_only');
  assert.equal(room.players.some((p) => p.isBot), false);
});

test('removeBot drops the bot from the lobby', () => {
  const { room } = createRoom(conn(), 'Solo');
  addBot(room, 'medium');
  assert.equal(removeBot(room).ok, true);
  assert.equal(room.players.some((p) => p.isBot), false);
  assert.equal(room.players.length, 1);
});

test('a Word Bomb room with an added bot can start a real 2-player game', () => {
  const { room } = createRoom(conn(), 'Solo');
  addBot(room, 'medium');
  const res = startGame(room);
  assert.equal(res.error, undefined);
  assert.equal(room.game.players.length, 2);
  assert.equal(room.players.filter((p) => p.isBot).length, 1);
});

test('a solo Word Bomb room with NO bot cannot start', () => {
  const { room } = createRoom(conn(), 'Solo'); // 1 human, no bot
  const res = startGame(room);
  assert.equal(res.error, 'not_enough_players');
});

test('removePlayer destroys the room when only the bot remains', () => {
  const host = conn();
  const { room } = createRoom(host, 'Solo');
  addBot(room, 'easy'); // [human, bot]
  removePlayer(room, host.id); // human leaves -> only the bot is left
  assert.equal(getRoom(room.code), undefined); // room torn down, no lone bot
});

test('resetGame keeps the added bot present for a rematch', () => {
  const { room } = createRoom(conn(), 'Solo');
  addBot(room, 'hard');
  startGame(room);
  resetGame(room); // back to lobby
  assert.equal(room.game, null);
  assert.equal(room.players.filter((p) => p.isBot).length, 1);
});

// ---- solo Category Blitz bot opponent -------------------------------------

// A solo Category Blitz room with a bot already added, game not yet started.
function blitzRoomWithBot(difficulty = 'medium') {
  const host = conn();
  const { room } = createRoom(host, 'Solo');
  room.gameType = 'category-blitz';
  const res = addBot(room, difficulty);
  assert.equal(res.ok, true);
  return { room, host };
}

test('addBot adds a blitz-flavored bot to a solo Category Blitz room', () => {
  const { room } = blitzRoomWithBot('hard');
  const bots = room.players.filter((p) => p.isBot);
  assert.equal(bots.length, 1);
  assert.equal(bots[0].botGameType, 'category-blitz');
  assert.equal(bots[0].botDifficulty, 'hard');
  assert.equal(bots[0].connection.readyState, 1);
});

test('removeBot drops the blitz bot from the lobby', () => {
  const { room } = blitzRoomWithBot();
  assert.equal(removeBot(room).ok, true);
  assert.equal(room.players.some((p) => p.isBot), false);
});

test('a Category Blitz room with an added bot starts a real 2-player game', () => {
  const { room } = blitzRoomWithBot();
  const res = startGame(room);
  assert.equal(res.error, undefined);
  assert.equal(room.game.gameType, 'category-blitz');
  assert.equal(room.game.players.length, 2); // human + bot both in the game roster
  assert.equal(room.game.solo, false); // 2 players -> the normal multiplayer path
});

test('removePlayer destroys a blitz room when only the bot remains', () => {
  const { room, host } = blitzRoomWithBot();
  removePlayer(room, host.id);
  assert.equal(getRoom(room.code), undefined); // no bot left playing alone
});

test('a blitz bot answer goes through the human submit path and scores', async () => {
  const { room } = blitzRoomWithBot();
  startGame(room);
  room.game.currentCategory = BLITZ_CATEGORY; // pin to a known accept-list
  const botId = room.players.find((p) => p.isBot).id;

  // First entry of the accept-list - guaranteed to pass Stage-1 validation.
  const answer = [...CATEGORY_ANSWERS[BLITZ_CATEGORY]][0];
  const { result } = await handleWordSubmission(room, botId, answer);

  assert.equal(result.accepted, true);
  const gameBot = room.game.players.find((p) => p.id === botId);
  assert.deepEqual(gameBot.answers, [answer]);
  assert.equal(gameBot.score, 1);
});

test('a blitz bot answer is rejected outside an active round', async () => {
  const { room } = blitzRoomWithBot();
  startGame(room);
  room.game.status = 'between_rounds'; // intermission - no submissions allowed
  const botId = room.players.find((p) => p.isBot).id;

  const res = await handleCategoryAnswer(room, botId, 'pepperoni');
  assert.equal(res.error, 'round_not_active');
  assert.equal(room.game.players.find((p) => p.id === botId).score, 0);
});

test('blitz bot submits scored accept-list answers during a live round and stops at round end', async () => {
  const { room } = blitzRoomWithBot('hard'); // hard: first answer within 2000ms
  startGame(room);
  room.game.currentCategory = BLITZ_CATEGORY;
  // Start the round clock now (also cancels the pending 3s countdown delay) -
  // this is what schedules the bot's answers for the round.
  startRoundTimer(room);
  const botId = room.players.find((p) => p.isBot).id;
  const gameBot = room.game.players.find((p) => p.id === botId);

  // hard's first answer is guaranteed within its 2000ms thinking window.
  await new Promise((r) => setTimeout(r, 2600));
  assert.ok(gameBot.answers.length >= 1, 'bot should have answered by now');
  assert.equal(gameBot.score, gameBot.answers.length); // accepted + scored via the human path
  const accept = CATEGORY_ANSWERS[BLITZ_CATEGORY];
  gameBot.answers.forEach((a) => {
    assert.ok(accept.has(a.toLowerCase()), `"${a}" should be from the accept-list`);
  });

  // End the round the way the round timer does: clear timers (cancels every
  // pending bot answer), flip to the intermission.
  clearRoundTimer(room);
  room.game.status = 'between_rounds';
  const scoreAtRoundEnd = gameBot.answers.length;

  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(gameBot.answers.length, scoreAtRoundEnd, 'no submissions after round end');
});
