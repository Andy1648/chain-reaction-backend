// t5HerdMindMode.test.js
// Run with: npm test (node --test auto-discovers this file).
// Pure-logic tests for HERD MIND (majority rules) plus integration passes
// through roomManager's generic T5 routing. No validation dependencies at
// all - the mode has no dictionary, no AI, no accept-lists.

const test = require('node:test');
const assert = require('node:assert/strict');

const herd = require('./t5HerdMindMode');

function makeGame(names = ['p1', 'p2', 'p3', 'p4'], difficulty = 'medium') {
  return herd.createGame(
    names.map((id) => ({ id, name: id.toUpperCase() })),
    difficulty
  );
}

/* ============================ normalization ============================ */

test('herd-mind: normalizeKey folds case, punctuation, articles, plurals, and spaces', () => {
  assert.equal(herd.normalizeKey('  Pepperoni!  '), 'pepperoni');
  assert.equal(herd.normalizeKey('The Beatles'), herd.normalizeKey('beatle'));
  assert.equal(herd.normalizeKey('DOGS'), herd.normalizeKey('dog'));
  // Space-in-compound answers herd together.
  assert.equal(herd.normalizeKey('a   hot  dog'), herd.normalizeKey('hotdog'));
  assert.equal(herd.normalizeKey('ice cream'), herd.normalizeKey('icecream'));
  assert.equal(herd.normalizeKey('spider man'), herd.normalizeKey('Spider-Man'));
  // es-plurals converge with their stems.
  assert.equal(herd.normalizeKey('dishes'), herd.normalizeKey('dish'));
  assert.equal(herd.normalizeKey('glasses'), herd.normalizeKey('glass'));
  assert.equal(herd.normalizeKey('boxes'), herd.normalizeKey('box'));
  // Short words keep their trailing s (no false fold on 'gas'/'bus').
  assert.equal(herd.normalizeKey('gas'), 'gas');
});

/* ========================== createGame & answers ======================== */

test('herd-mind: createGame sets rounds, clock by difficulty, a prompt from the pool', () => {
  const game = makeGame(['a', 'b', 'c'], 'hard');
  assert.equal(game.status, 'answering');
  assert.equal(game.rounds, herd.TOTAL_ROUNDS);
  assert.equal(game.answerPhaseSeconds, herd.TIME_BY_DIFFICULTY.hard);
  assert.ok(herd.PROMPTS.includes(game.currentPrompt));
  assert.ok(game.players.every((p) => p.answer === null && p.score === 0));
});

test('herd-mind: submitAnswer locks exactly one answer per player per round', () => {
  const game = makeGame();

  const first = herd.submitAnswer(game, 'p1', 'Pepperoni');
  assert.equal(first.accepted, true);
  assert.equal(first.answer, 'Pepperoni');

  const second = herd.submitAnswer(game, 'p1', 'mushrooms');
  assert.equal(second.accepted, false);
  assert.equal(second.reason, 'already_answered');
  assert.equal(game.players[0].answer.raw, 'Pepperoni', 'the lock holds');
});

test('herd-mind: rejects wrong phase, ghosts, and too-short answers', () => {
  const game = makeGame();
  assert.equal(herd.submitAnswer(game, 'ghost', 'cheese').reason, 'not_in_game');
  assert.equal(herd.submitAnswer(game, 'p1', '!').reason, 'too_short');
  game.status = 'reveal';
  assert.equal(herd.submitAnswer(game, 'p1', 'cheese').reason, 'wrong_phase');
});

test('herd-mind: countAnswers / allAnswered track the lock progress', () => {
  const game = makeGame(['a', 'b', 'c']);
  assert.deepEqual(herd.countAnswers(game), { answered: 0, total: 3 });
  herd.submitAnswer(game, 'a', 'cheese');
  herd.submitAnswer(game, 'b', 'cheese');
  assert.deepEqual(herd.countAnswers(game), { answered: 2, total: 3 });
  assert.equal(herd.allAnswered(game), false);
  herd.submitAnswer(game, 'c', 'olives');
  assert.equal(herd.allAnswered(game), true);
});

/* ========================== grouping & scoring ========================= */

test('herd-mind: herds score (size - 1), the biggest herd gets +1, loners get zero', () => {
  const game = makeGame(['a', 'b', 'c', 'd', 'e']);
  herd.submitAnswer(game, 'a', 'pepperoni');
  herd.submitAnswer(game, 'b', 'Pepperoni!');
  herd.submitAnswer(game, 'c', 'PEPPERONIS'); // plural folds into the herd
  herd.submitAnswer(game, 'd', 'mushroom');
  herd.submitAnswer(game, 'e', 'mushrooms');

  const reveal = herd.endRound(game);
  assert.equal(game.status, 'reveal');
  assert.equal(reveal.groups.length, 2);
  assert.equal(reveal.groups[0].playerIds.length, 3, 'biggest herd first');
  assert.equal(reveal.groups[0].points, 3, '(3-1) + biggest-herd bonus');
  assert.equal(reveal.groups[0].answer, 'pepperoni', 'first-submitted raw form displays');
  assert.equal(reveal.groups[1].points, 1, '(2-1), no bonus for the smaller herd');
  assert.equal(reveal.doublePoints, false);

  const byId = Object.fromEntries(reveal.scores.map((s) => [s.id, s]));
  assert.equal(byId.a.roundScore, 3);
  assert.equal(byId.c.roundScore, 3);
  assert.equal(byId.d.roundScore, 1);
  assert.equal(byId.e.roundScore, 1);
  assert.equal(reveal.blackSheepId, null, 'no singleton at all');
});

test('herd-mind: tied biggest herds both take the bonus; the final round pays double', () => {
  const game = makeGame(['a', 'b', 'c', 'd']);
  game.currentRound = game.rounds; // the final round
  herd.submitAnswer(game, 'a', 'cheese');
  herd.submitAnswer(game, 'b', 'cheese');
  herd.submitAnswer(game, 'c', 'bacon');
  herd.submitAnswer(game, 'd', 'bacon');

  const reveal = herd.endRound(game);
  assert.equal(reveal.doublePoints, true);
  reveal.groups.forEach((g) => {
    assert.equal(g.points, 4, '((2-1) + 1 bonus) x2 final-round multiplier');
  });
});

test('herd-mind: the no-repeat rule blocks an answer key reused from an earlier round', () => {
  const game = makeGame(['a', 'b', 'c']);
  herd.submitAnswer(game, 'a', 'poop');
  herd.submitAnswer(game, 'b', 'cheese');
  herd.submitAnswer(game, 'c', 'cheese');
  herd.endRound(game);
  herd.startNextRound(game);

  const again = herd.submitAnswer(game, 'a', 'POOPS!'); // same key after folding
  assert.equal(again.accepted, false);
  assert.equal(again.reason, 'repeat_answer');
  assert.equal(herd.submitAnswer(game, 'a', 'onions').accepted, true, 'a fresh answer is fine');
});

test('herd-mind: the lone unique answer among herds is the black sheep', () => {
  const game = makeGame(['a', 'b', 'c', 'd']);
  herd.submitAnswer(game, 'a', 'cheese');
  herd.submitAnswer(game, 'b', 'cheese');
  herd.submitAnswer(game, 'c', 'cheese');
  herd.submitAnswer(game, 'd', 'pineapple');

  const reveal = herd.endRound(game);
  assert.equal(reveal.blackSheepId, 'd');
  assert.equal(game.players[3].sheepCount, 1);
  const d = reveal.scores.find((s) => s.id === 'd');
  assert.equal(d.roundScore, 0);
});

test('herd-mind: no black sheep when several answers are unique or no herd formed', () => {
  // Two singletons alongside a herd -> nobody is THE sheep.
  const game = makeGame(['a', 'b', 'c', 'd']);
  herd.submitAnswer(game, 'a', 'cheese');
  herd.submitAnswer(game, 'b', 'cheese');
  herd.submitAnswer(game, 'c', 'pineapple');
  herd.submitAnswer(game, 'd', 'anchovies');
  assert.equal(herd.endRound(game).blackSheepId, null);

  // All unique (no herd at all) -> also no sheep.
  const game2 = makeGame(['a', 'b', 'c']);
  herd.submitAnswer(game2, 'a', 'one');
  herd.submitAnswer(game2, 'b', 'two');
  herd.submitAnswer(game2, 'c', 'three');
  assert.equal(herd.endRound(game2).blackSheepId, null);
});

test('herd-mind: blanking scores zero and is never the sheep', () => {
  const game = makeGame(['a', 'b', 'c']);
  herd.submitAnswer(game, 'a', 'cheese');
  herd.submitAnswer(game, 'b', 'cheese');
  // c never answers.
  const reveal = herd.endRound(game);
  assert.deepEqual(reveal.noAnswerIds, ['c']);
  assert.equal(reveal.blackSheepId, null);
  const c = reveal.scores.find((s) => s.id === 'c');
  assert.equal(c.roundScore, 0);
});

/* ========================= rounds & final results ======================= */

test('herd-mind: startNextRound resets answers and never repeats a prompt', () => {
  const game = makeGame();
  herd.submitAnswer(game, 'p1', 'cheese');
  herd.endRound(game);

  const seen = new Set([game.currentPrompt]);
  const next = herd.startNextRound(game);
  assert.equal(next.round, 2);
  assert.equal(game.status, 'answering');
  assert.ok(!seen.has(game.currentPrompt), 'fresh prompt');
  assert.ok(game.players.every((p) => p.answer === null));
});

test('herd-mind: the game finishes after the last round; scores accumulate', () => {
  const game = makeGame(['a', 'b', 'c']);
  // Round 1: a+b herd (biggest, +1 bonus) -> 2 each; c alone -> 0.
  herd.submitAnswer(game, 'a', 'cheese');
  herd.submitAnswer(game, 'b', 'cheese');
  herd.submitAnswer(game, 'c', 'olives');
  herd.endRound(game);
  game.currentRound = game.rounds; // fast-forward to the final round
  game.status = 'answering';
  game.players.forEach((p) => {
    p.answer = null;
  });
  // Final round (double): a+c herd -> (1+1)x2 = 4 each; b alone -> 0.
  herd.submitAnswer(game, 'a', 'dog');
  herd.submitAnswer(game, 'b', 'cat');
  herd.submitAnswer(game, 'c', 'DOGS');
  herd.endRound(game);

  assert.equal(herd.startNextRound(game), null);
  assert.equal(game.status, 'finished');
  assert.equal(game.winnerId, 'a', 'a: 2+4 beats c: 0+4 and b: 2+0');

  const results = herd.getResults(game);
  assert.deepEqual(results.winnerIds, ['a']);
  assert.equal(results.finalScores[0].id, 'a');
  assert.equal(results.finalScores[0].score, 6);
  assert.equal(results.finalScores.at(-1).id, 'b');
});

test('herd-mind: a score tie is a shared win, never a join-order coin flip', () => {
  const game = makeGame(['a', 'b', 'c']);
  game.currentRound = game.rounds;
  herd.submitAnswer(game, 'a', 'cheese');
  herd.submitAnswer(game, 'b', 'cheese');
  herd.submitAnswer(game, 'c', 'olives');
  herd.endRound(game);
  herd.startNextRound(game);

  assert.equal(game.winnerId, null, 'no single winner on a tie');
  assert.deepEqual(game.winnerIds, ['a', 'b'], 'both leaders share the win');
  assert.deepEqual(herd.getResults(game).winnerIds, ['a', 'b']);
});

/* ==================== integration via roomManager ===================== */

const roomManager = require('./roomManager');

function makeConnection(id) {
  const messages = [];
  return {
    id,
    readyState: 1,
    send(raw) {
      messages.push(JSON.parse(raw));
    },
    messages,
  };
}

function makeStartedRoom(ids) {
  const conns = ids.map(makeConnection);
  const { room } = roomManager.createRoom(conns[0], ids[0].toUpperCase());
  conns.slice(1).forEach((c) => roomManager.joinRoom(room.code, c, c.id.toUpperCase()));
  room.gameType = 'herd-mind';
  roomManager.startGame(room);
  return { room, conns };
}

test('herd-mind: needs 3 players to start', () => {
  const a = makeConnection('a');
  const b = makeConnection('b');
  const { room } = roomManager.createRoom(a, 'A');
  roomManager.joinRoom(room.code, b, 'B');
  room.gameType = 'herd-mind';
  assert.equal(roomManager.startGame(room).error, 'not_enough_players');
  roomManager._resetRoomsForTesting();
});

test('herd-mind: startGame broadcasts the prompt; answers are private, counts public', async () => {
  const { room, conns } = makeStartedRoom(['a', 'b', 'c']);
  const [a, b] = conns;

  const roundStart = b.messages.find((m) => m.type === 'round_start');
  assert.ok(roundStart);
  assert.ok(herd.PROMPTS.includes(roundStart.payload.prompt));

  await roomManager.handleWordSubmission(room, 'a', 'cheese');
  assert.ok(a.messages.some((m) => m.type === 'answer_result' && m.payload.accepted));
  assert.ok(
    !b.messages.some((m) => m.type === 'answer_result'),
    'opponents never see your answer mid-round'
  );
  const count = b.messages.find((m) => m.type === 'answer_count');
  assert.deepEqual(count.payload, { answered: 1, total: 3 });

  roomManager._resetRoomsForTesting();
});

test('herd-mind: the round resolves early once everyone has locked in', async () => {
  const { room, conns } = makeStartedRoom(['a', 'b', 'c']);
  const [a] = conns;

  await roomManager.handleWordSubmission(room, 'a', 'cheese');
  await roomManager.handleWordSubmission(room, 'b', 'cheese');
  assert.ok(!a.messages.some((m) => m.type === 'round_reveal'), 'not yet');

  await roomManager.handleWordSubmission(room, 'c', 'olives');
  const reveal = a.messages.find((m) => m.type === 'round_reveal');
  assert.ok(reveal, 'reveal fires without waiting out the clock');
  assert.equal(reveal.payload.blackSheepId, 'c');
  assert.equal(room.game.status, 'reveal');

  roomManager._resetRoomsForTesting();
});

test('herd-mind: a leave that breaks the herd finishes the game on current scores', () => {
  const { room, conns } = makeStartedRoom(['a', 'b', 'c']);
  const [a] = conns;

  roomManager.removePlayer(room, 'b');
  assert.equal(room.game.status, 'answering', 'two players can still finish the round');

  roomManager.removePlayer(room, 'c');
  assert.equal(room.game.status, 'finished');
  assert.ok(a.messages.some((m) => m.type === 'game_over'));

  roomManager._resetRoomsForTesting();
});

test('herd-mind: a leaver who was the last hold-out resolves the round', async () => {
  const { room, conns } = makeStartedRoom(['a', 'b', 'c', 'd']);
  const [a] = conns;

  await roomManager.handleWordSubmission(room, 'a', 'cheese');
  await roomManager.handleWordSubmission(room, 'b', 'cheese');
  await roomManager.handleWordSubmission(room, 'c', 'olives');

  roomManager.removePlayer(room, 'd'); // the only player still typing leaves
  assert.ok(a.messages.some((m) => m.type === 'round_reveal'));
  assert.equal(room.game.status, 'reveal');

  roomManager._resetRoomsForTesting();
});
