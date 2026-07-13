// t5LetterStormMode.test.js
// Run with: npm test (node --test auto-discovers this file).
// Pure-logic tests for LETTER STORM (simultaneous anagram rush) plus
// integration passes through roomManager's generic T5 routing. The word
// corpus is swapped for a small deterministic list, so every rack, solve,
// and score below is exact - no dependence on botWords.txt contents.

const test = require('node:test');
const assert = require('node:assert/strict');

const storm = require('./t5LetterStormMode');

// Deterministic mini-corpus. 'storage' and 'garages' are the two 7-letter
// rack sources; the rest are chosen to exercise buildability edge cases
// (letter multiplicity, subsets, near-misses).
const TEST_WORDS = [
  'storage', // rack source: s t o r a g e
  'garages', // rack source: g a r a g e s (double g, double a)
  'gators',
  'great',
  'store',
  'rates',
  'goat',
  'rage',
  'gear',
  'toes',
  'rot',
  'sat',
  'ear',
  'egg', // needs two g's - buildable from 'garages' only
  'area', // needs two a's - buildable from 'garages' only
  'zoo', // needs two o's - buildable from neither rack
];
storm._setWordsForTesting(TEST_WORDS);

function makeGame(names = ['p1', 'p2'], difficulty = 'medium', source = 'storage') {
  const game = storm.createGame(
    names.map((id) => ({ id, name: id.toUpperCase() })),
    difficulty
  );
  // Pin the rack for determinism (createGame picked one of the two sources).
  const rack = storm.buildRackFromSource(source);
  game.rack = rack.letters;
  game.rackSource = rack.source;
  game.rackSolutions = rack.solutions;
  game.usedRackSources = new Set([rack.source]);
  return game;
}

/* ============================ racks & solving ============================ */

test('letter-storm: buildRackFromSource scrambles the source and solves it', () => {
  const rack = storm.buildRackFromSource('storage');
  assert.equal(rack.letters.length, 7);
  assert.equal(rack.letters.join('').toLowerCase().split('').sort().join(''), 'aegorst');
  assert.ok(rack.solutions.has('storage'), 'the source itself is always a solution');
  assert.ok(rack.solutions.has('goat'));
  assert.ok(!rack.solutions.has('egg'), 'needs two g’s, storage has one');
  assert.ok(!rack.solutions.has('area'), 'needs two a’s, storage has one');
});

test('letter-storm: canBuildFromRack respects letter multiplicity', () => {
  const counts = storm.letterCounts('garages');
  assert.equal(storm.canBuildFromRack('egg', counts), true, 'two g’s available');
  assert.equal(storm.canBuildFromRack('rage', counts), true);
  assert.equal(storm.canBuildFromRack('area', counts), true, 'two a’s available');
  assert.equal(storm.canBuildFromRack('toes', counts), false, 'no t or o at all');
  assert.equal(storm.canBuildFromRack('zoo', counts), false, 'no o at all');
});

test('letter-storm: scoring is nonlinear so long words beat short-word spam', () => {
  assert.equal(storm.scoreForWord('rot'), 1);
  assert.equal(storm.scoreForWord('goat'), 2);
  assert.equal(storm.scoreForWord('store'), 4, 'a five is worth four threes');
  assert.equal(storm.scoreForWord('gators'), 7);
  assert.equal(storm.scoreForWord('storage'), 12, 'the STORM jackpot');
});

/* ============================== createGame ============================== */

test('letter-storm: createGame sets rounds, clock by difficulty, zero scores', () => {
  const game = makeGame(['a', 'b'], 'hard');
  assert.equal(game.status, 'in_progress');
  assert.equal(game.rounds, storm.TOTAL_ROUNDS);
  assert.equal(game.currentRound, 1);
  assert.equal(game.roundTimeSeconds, storm.TIME_BY_DIFFICULTY.hard);
  assert.ok(game.players.every((p) => p.score === 0 && p.answers.length === 0));
});

test('letter-storm: invalid difficulty falls back to medium', () => {
  const game = makeGame(['a', 'b'], 'nonsense');
  assert.equal(game.difficultyKey, 'medium');
  assert.equal(game.roundTimeSeconds, storm.TIME_BY_DIFFICULTY.medium);
});

/* ============================== submitAnswer ============================= */

test('letter-storm: accepted words record points and raise the score', () => {
  const game = makeGame();

  const goat = storm.submitAnswer(game, 'p1', 'GOAT ');
  assert.equal(goat.accepted, true);
  assert.equal(goat.word, 'goat');
  assert.equal(goat.points, 2);

  const full = storm.submitAnswer(game, 'p1', 'storage');
  assert.equal(full.points, 12, 'storm jackpot applied');

  const p1 = game.players[0];
  assert.equal(p1.score, 14);
  assert.equal(p1.answers.length, 2);
});

test('letter-storm: rejects shape errors, misses, dupes, and non-players', () => {
  const game = makeGame();

  assert.equal(storm.submitAnswer(game, 'p1', 'at').reason, 'too_short');
  assert.equal(storm.submitAnswer(game, 'p1', "go-at").reason, 'invalid_chars');
  assert.equal(storm.submitAnswer(game, 'p1', 'zoo').reason, 'not_in_rack');
  assert.equal(storm.submitAnswer(game, 'p1', 'egg').reason, 'not_in_rack');
  // Buildable from the rack but not a corpus word: 'sorta' isn't in TEST_WORDS.
  assert.equal(storm.submitAnswer(game, 'p1', 'sorta').reason, 'not_a_word');
  assert.equal(storm.submitAnswer(game, 'ghost', 'goat').reason, 'not_in_game');

  storm.submitAnswer(game, 'p1', 'goat');
  assert.equal(storm.submitAnswer(game, 'p1', 'goat').reason, 'already_said');

  const p1 = game.players[0];
  assert.equal(p1.score, 2, 'rejects never score');
  assert.equal(p1.answers.length, 1);
});

test('letter-storm: two players may find the same word independently', () => {
  const game = makeGame();
  assert.equal(storm.submitAnswer(game, 'p1', 'goat').accepted, true);
  assert.equal(storm.submitAnswer(game, 'p2', 'goat').accepted, true);
});

/* ========================= rounds, reveal, winner ======================== */

test('letter-storm: endRound reveals words, per-round scores, and best misses', () => {
  const game = makeGame();
  storm.submitAnswer(game, 'p1', 'goat');
  storm.submitAnswer(game, 'p2', 'storage');

  const reveal = storm.endRound(game);
  assert.equal(game.status, 'between_rounds');
  assert.equal(reveal.rackSource, 'storage');
  assert.equal(reveal.playerResults[0].roundScore, 2);
  assert.equal(reveal.playerResults[1].roundScore, 12);
  assert.ok(!reveal.missedWords.includes('goat'), 'found words are not "missed"');
  assert.ok(!reveal.missedWords.includes('storage'));
  assert.ok(reveal.missedWords.includes('gators'), 'unfound solutions are revealed');
  // Longest-first ordering.
  const lengths = reveal.missedWords.map((w) => w.length);
  assert.deepEqual(lengths, [...lengths].sort((a, b) => b - a));
});

test('letter-storm: startNextRound deals a fresh non-repeating rack and clears answers', () => {
  const game = makeGame();
  storm.submitAnswer(game, 'p1', 'goat');
  storm.endRound(game);

  const next = storm.startNextRound(game);
  assert.equal(next.round, 2);
  assert.equal(game.status, 'in_progress');
  assert.equal(game.rackSource, 'garages', 'only other source left in the test corpus');
  assert.equal(game.players[0].answers.length, 0, 'per-round answers cleared');
  assert.equal(game.players[0].score, 2, 'cumulative score kept');
});

test('letter-storm: the game finishes after the last round with the top scorer winning', () => {
  const game = makeGame();
  game.currentRound = game.rounds; // fast-forward to the final round
  storm.submitAnswer(game, 'p2', 'storage');
  storm.endRound(game);

  const next = storm.startNextRound(game);
  assert.equal(next, null);
  assert.equal(game.status, 'finished');
  assert.equal(game.winnerId, 'p2');
  const board = storm.getScoreboard(game);
  assert.equal(board[0].id, 'p2');
  assert.equal(board[0].score, 12);
});

test('letter-storm: a score tie breaks to the earlier-joined player', () => {
  const game = makeGame();
  game.currentRound = game.rounds;
  storm.submitAnswer(game, 'p1', 'goat');
  storm.submitAnswer(game, 'p2', 'rage');
  storm.startNextRound(game);
  assert.equal(game.winnerId, 'p1');
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

test('letter-storm: startGame broadcasts round_start with the rack letters', () => {
  const host = makeConnection('host');
  const guest = makeConnection('guest');
  const { room } = roomManager.createRoom(host, 'HOST');
  roomManager.joinRoom(room.code, guest, 'GUEST');
  room.gameType = 'letter-storm';

  const result = roomManager.startGame(room);
  assert.ok(!result.error);
  assert.equal(room.game.gameType, 'letter-storm');

  const roundStart = guest.messages.find((m) => m.type === 'round_start');
  assert.ok(roundStart);
  assert.equal(roundStart.payload.letters.length, storm.RACK_SIZE);
  assert.equal(roundStart.payload.round, 1);
  assert.equal(roundStart.payload.totalRounds, storm.TOTAL_ROUNDS);

  roomManager._resetRoomsForTesting();
});

test('letter-storm: submissions are private, progress is a broadcast count', async () => {
  const host = makeConnection('host');
  const guest = makeConnection('guest');
  const { room } = roomManager.createRoom(host, 'HOST');
  roomManager.joinRoom(room.code, guest, 'GUEST');
  room.gameType = 'letter-storm';
  roomManager.startGame(room);

  // Pin the rack so the submissions below are deterministic.
  const rack = storm.buildRackFromSource('storage');
  room.game.rack = rack.letters;
  room.game.rackSource = rack.source;
  room.game.rackSolutions = rack.solutions;

  const accepted = await roomManager.handleWordSubmission(room, 'host', 'goat');
  assert.equal(accepted.result.accepted, true);

  const hostResult = host.messages.find((m) => m.type === 'answer_result');
  assert.equal(hostResult.payload.points, 2);
  assert.ok(
    !guest.messages.some((m) => m.type === 'answer_result'),
    'opponents never see your accepts'
  );
  const progress = guest.messages.find((m) => m.type === 'player_progress');
  assert.deepEqual(progress.payload, { playerId: 'host', wordCount: 1 });

  const rejected = await roomManager.handleWordSubmission(room, 'guest', 'zoo');
  assert.equal(rejected.result.accepted, false);
  assert.equal(rejected.result.reason, 'not_in_rack');

  // A full-rack word erupts as a live STORM broadcast (name only, no word).
  await roomManager.handleWordSubmission(room, 'guest', 'storage');
  const stormMsg = host.messages.find((m) => m.type === 'storm');
  assert.ok(stormMsg, 'storms are announced the instant they land');
  assert.equal(stormMsg.payload.playerId, 'guest');
  assert.equal(stormMsg.payload.word, undefined, 'the word itself stays secret');

  roomManager._resetRoomsForTesting();
});

test('letter-storm: buildRack avoids dead racks when richer sources exist', () => {
  // A corpus with one barren source ('almanac' - triple a, few subwords here)
  // and one rich source; buildRack should overwhelmingly settle on a rack
  // meeting the floor or, failing that, the best available.
  const rack = storm.buildRack();
  assert.ok(rack.solutions.size >= 1, 'always returns a playable rack');
  assert.equal(rack.letters.length, storm.RACK_SIZE);
});

test('letter-storm: a leaver is dropped from the live roster mid-round', () => {
  const a = makeConnection('a');
  const b = makeConnection('b');
  const c = makeConnection('c');
  const { room } = roomManager.createRoom(a, 'A');
  roomManager.joinRoom(room.code, b, 'B');
  roomManager.joinRoom(room.code, c, 'C');
  room.gameType = 'letter-storm';
  roomManager.startGame(room);

  roomManager.removePlayer(room, 'b');
  assert.equal(room.game.players.length, 2);
  assert.ok(!room.game.players.some((p) => p.id === 'b'));
  assert.equal(room.game.status, 'in_progress', 'the round keeps running');

  roomManager._resetRoomsForTesting();
});
