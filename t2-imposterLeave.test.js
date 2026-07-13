// t2-imposterLeave.test.js
// Run with: node --test t2-imposterLeave.test.js   (or `npm test` for the suite)
//
// [T2] Regression test for a stale-state hang in Imposter Word's vote phase.
// handleImposterVote ends the phase early once EVERYONE has voted
// (tally.voted >= tally.total) - but that check only ran when a VOTE arrived.
// If the last hold-out disconnected instead, the total shrank so that every
// remaining player HAD voted, yet nothing re-ran the check: the table sat
// staring at a dead clock for the rest of votePhaseSeconds (up to 30s) even
// though the result was already decided.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRoom,
  joinRoom,
  startGame,
  handleImposterVote,
  removePlayer,
  _resetRoomsForTesting,
} = require('./roomManager');

let nextId = 0;
function conn(sink) {
  const id = `t2i${nextId++}`;
  return {
    id,
    readyState: 1,
    send(raw) {
      if (sink) sink.push(JSON.parse(raw));
    },
  };
}

test.beforeEach(() => _resetRoomsForTesting());
test.after(() => _resetRoomsForTesting());

// A 3-player imposter room, advanced to the voting phase by hand (the real
// path gets there via the answer-phase timer; the state transition itself is
// what matters here, and endImposterVotePhase clears timers on entry).
function votingRoom() {
  const inbox = [];
  const c1 = conn(inbox);
  const c2 = conn(inbox);
  const c3 = conn(inbox);
  const { room } = createRoom(c1, 'P1');
  room.gameType = 'imposter-word';
  joinRoom(room.code, c2, 'P2');
  joinRoom(room.code, c3, 'P3');
  assert.equal(startGame(room).error, undefined);
  room.game.status = 'voting';
  return { room, c1, c2, c3, inbox };
}

test('the last non-voter disconnecting ends the vote phase for the survivors', () => {
  const { room, c1, c2, c3, inbox } = votingRoom();

  // Two of three vote; c3 is the hold-out.
  assert.equal(handleImposterVote(room, c1.id, c2.id).result.accepted, true);
  assert.equal(handleImposterVote(room, c2.id, c1.id).result.accepted, true);
  assert.equal(room.game.status, 'voting', 'phase still open while c3 has not voted');

  inbox.length = 0;
  removePlayer(room, c3.id); // the hold-out drops

  assert.notEqual(
    room.game.status,
    'voting',
    'with every remaining player voted, the phase must resolve instead of hanging'
  );
  assert.ok(
    inbox.some((m) => m.type === 'vote_results'),
    'survivors must receive the vote_results reveal'
  );
});

test('a voter disconnecting while others still deliberate does NOT end the phase', () => {
  const { room, c1, c2 } = votingRoom();

  // Only c1 votes, then c1 leaves: c2 and c3 remain, c2/c3 have not voted.
  assert.equal(handleImposterVote(room, c1.id, c2.id).result.accepted, true);
  removePlayer(room, c1.id);

  assert.equal(room.game.status, 'voting', 'the phase stays open for the undecided');
});
