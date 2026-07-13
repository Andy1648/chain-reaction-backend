// t3-harness/scenarios.js
// Phase 2 resilience scenario suite. Each scenario asserts the CORRECT
// behavior — scenarios that fail are real findings (see T3-FINDINGS.md).
// Run: node t3-harness/scenarios.js
//
// Most scenarios share one server; the stats-sensitive ones (leak checks)
// spawn their own on a different port so other scenarios' rooms can't skew
// the numbers.

const { FakeClient } = require('./client');
const { spawnServer, getStats, scenario, assert, assertEqual, summarize, sleep } = require('./runner');

const PORT_MAIN = 4310;
const PORT_LEAK = 4320;
const PORT_CHURN = 4330;

/** Connect n clients to url, names prefixed for readability. */
async function connectMany(url, n, prefix, opts = {}) {
  const clients = Array.from({ length: n }, (_, i) => new FakeClient(url, { ...opts, name: `${prefix}${i + 1}` }));
  await Promise.all(clients.map((c) => c.connect()));
  return clients;
}

function closeAll(clients) {
  clients.forEach((c) => {
    try { c.close(); } catch { /* already closed */ }
  });
}

(async () => {
  const server = await spawnServer({ port: PORT_MAIN });
  console.log(`main server at ${server.url}`);

  // ------------------------------------------------------------------
  await scenario('S1: current player disconnects mid-turn -> turn advances, game continues', async () => {
    const [a, b, c] = await connectMany(server.url, 3, 'S1-');
    try {
      const code = await a.createRoom();
      assertEqual(await b.joinRoom(code), 'ok', 'b joins');
      assertEqual(await c.joinRoom(code), 'ok', 'c joins');
      a.send('start_game');
      const turn = await b.waitFor('turn_update');
      const clients = { [a.id]: a, [b.id]: b, [c.id]: c };
      const current = clients[turn.payload.currentPlayerId];
      const observer = current === b ? c : b;
      observer.drainInbox();

      // Hard-kill the current player's socket mid-turn (crash, not clean leave).
      current.terminate();

      // The remaining players should promptly see a turn_update where the dead
      // player is eliminated and someone else has the turn.
      const next = await observer.waitFor('turn_update', {
        timeoutMs: 5000,
        where: (m) => m.payload.currentPlayerId !== current.id,
      });
      const deadEntry = next.payload.players.find((p) => p.id === current.id);
      assert(deadEntry && deadEntry.eliminated, 'disconnected player marked eliminated');

      // "Reconnect": same human, brand-new socket. In-progress rooms must
      // refuse the join with a clean error (no reconnect support by design).
      const re = new FakeClient(server.url, { name: 'S1-return' });
      await re.connect();
      const res = await re.joinRoom(code);
      assertEqual(res, 'That game has already started.', 'rejoin mid-game politely refused');
      re.close();

      // The game must still be playable for the survivors: current player skips,
      // life is lost, play continues (or ends) without a hang.
      const cur2 = clients[next.payload.currentPlayerId];
      cur2.send('skip_turn');
      await observer.waitFor('turn_skipped', { timeoutMs: 5000 });
    } finally {
      closeAll([a, b, c]);
      await sleep(200);
    }
  });

  // ------------------------------------------------------------------
  await scenario('S2: host leaves lobby -> host role passes to a HUMAN who can start the game', async () => {
    const [a, b, c] = await connectMany(server.url, 3, 'S2-');
    try {
      const code = await a.createRoom();
      await b.joinRoom(code);
      await c.joinRoom(code);
      b.drainInbox();
      a.send('leave_room');
      const update = await b.waitFor('room_update', {
        timeoutMs: 5000,
        where: (m) => m.payload.players.length === 2,
      });
      assert([b.id, c.id].includes(update.payload.hostId), 'host reassigned to a remaining player');
      // The new host can actually exercise host powers.
      const newHost = update.payload.hostId === b.id ? b : c;
      newHost.send('start_game');
      await newHost.waitFor('game_started', { timeoutMs: 5000 });
    } finally {
      closeAll([a, b, c]);
      await sleep(200);
    }
  });

  // ------------------------------------------------------------------
  await scenario('S3: host leaves a room containing a bot -> host passes to the HUMAN, not the bot', async () => {
    const [a, b] = await connectMany(server.url, 2, 'S3-');
    try {
      const code = await a.createRoom();
      a.send('add_bot', { difficulty: 'medium' });
      await a.waitFor('room_update', { where: (m) => m.payload.players.some((p) => p.isBot) });
      assertEqual(await b.joinRoom(code), 'ok', 'second human joins after bot');
      b.drainInbox();

      a.send('leave_room');
      const update = await b.waitFor('room_update', {
        timeoutMs: 5000,
        where: (m) => !m.payload.players.some((p) => p.id === a.id),
      });
      assertEqual(update.payload.hostId, b.id, 'host must be the remaining human, not the bot');

      // Host powers must actually work for the human. Match on the applied
      // difficulty so a stale roster room_update in the inbox can't false-fail.
      b.send('set_difficulty', { difficultyKey: 'hard' });
      const diff = await b.waitForAny(['room_update', 'error'], {
        timeoutMs: 3000,
        where: (m) => m.type === 'error' || m.payload.difficultyKey === 'hard',
      });
      assertEqual(diff.type, 'room_update', 'new host can change settings');
    } finally {
      closeAll([a, b]);
      await sleep(200);
    }
  });

  // ------------------------------------------------------------------
  await scenario('S4: all players vanish mid-game -> room destroyed, zero timers left (leak check)', async () => {
    const leak = await spawnServer({ port: PORT_LEAK });
    try {
      const base = await getStats(leak.statsUrl);
      assertEqual(base.rooms, 0, 'clean slate');

      // Word Bomb mid-game mass disconnect.
      const [a, b, c] = await connectMany(leak.url, 3, 'S4wb-');
      const code = await a.createRoom();
      await b.joinRoom(code);
      await c.joinRoom(code);
      a.send('start_game');
      await a.waitFor('turn_update');
      a.terminate();
      b.terminate();
      c.terminate();
      await sleep(400);
      let stats = await getStats(leak.statsUrl);
      assertEqual(stats.rooms, 0, 'word bomb room destroyed after mass disconnect');
      assertEqual(stats.roomTimers, 0, 'no room timers left (word bomb)');

      // Category Blitz mid-round mass disconnect (round + countdown timers live).
      const [d, e] = await connectMany(leak.url, 2, 'S4cb-');
      const code2 = await d.createRoom();
      await e.joinRoom(code2);
      d.send('set_game_type', { gameType: 'category-blitz' });
      d.send('start_game');
      await d.waitFor('round_start');
      await sleep(3500); // let the countdown hand off to the real round timer
      d.terminate();
      e.terminate();
      await sleep(400);
      stats = await getStats(leak.statsUrl);
      assertEqual(stats.rooms, 0, 'blitz room destroyed after mass disconnect');
      assertEqual(stats.roomTimers, 0, 'no room timers left (blitz)');
      assertEqual(stats.playersTotal, 0, 'no roster entries left');
    } finally {
      await leak.kill();
    }
  });

  // ------------------------------------------------------------------
  await scenario('S5: client with ~3s RTT plays a Blitz round without corrupting state', async () => {
    const a = new FakeClient(server.url, { name: 'S5-fast' });
    const slow = new FakeClient(server.url, { name: 'S5-slow', latencyMs: 1500 });
    await a.connect();
    await slow.connect();
    try {
      const code = await a.createRoom();
      assertEqual(await slow.joinRoom(code, { timeoutMs: 10000 }), 'ok', 'slow client joins');
      a.send('set_game_type', { gameType: 'category-blitz' });
      a.send('start_game');

      // The slow client keys off its OWN round_start (arrives ~1.5s late) and
      // submits immediately — lands ~3s into a 20s round even on a laggy link.
      await slow.waitFor('round_start', { timeoutMs: 15000 });
      slow.send('submit_answer', { answer: 'apple' });
      const res = await slow.waitFor('answer_result', { timeoutMs: 15000 });
      assert(res.payload.accepted, `slow client answer accepted (${JSON.stringify(res.payload)})`);

      // Fast client sees exactly one progress event, count 1 (state consistent).
      const prog = await a.waitFor('player_progress', { timeoutMs: 15000, where: (m) => m.payload.playerId === slow.id });
      assertEqual(prog.payload.answerCount, 1, 'progress count consistent');

      // Ride out the round; an answer sent AFTER round_end must be cleanly
      // refused (rejected result or round_not_active error), never scored.
      await slow.waitFor('round_end', { timeoutMs: 40000 });
      slow.drainInbox();
      slow.send('submit_answer', { answer: 'banana' });
      const late = await slow.waitForAny(['answer_result', 'error'], { timeoutMs: 15000 });
      assert(
        late.type === 'error' || !late.payload.accepted,
        `intermission answer refused (${JSON.stringify(late.payload)})`
      );
    } finally {
      closeAll([a, slow]);
      await sleep(200);
    }
  });

  // ------------------------------------------------------------------
  await scenario('S6: events from a client not in any room get clean errors, server stays up', async () => {
    const c = new FakeClient(server.url, { name: 'S6-lurker' });
    await c.connect();
    try {
      for (const [type, payload] of [
        ['submit_word', { word: 'test' }],
        ['skip_turn', {}],
        ['start_game', {}],
        ['submit_vote', { suspectId: 'nobody' }],
        ['typing_update', { text: 'hi' }],
        ['spectator_reaction', { emoji: '🔥' }],
        ['set_difficulty', { difficultyKey: 'hard' }],
        ['rematch', {}],
      ]) {
        c.drainInbox();
        c.send(type, payload);
        const err = await c.waitFor('error', { timeoutMs: 3000 });
        assert(err.payload.message.includes('not currently in a room'), `${type} -> not-in-room error`);
      }
      // Malformed JSON must not kill the connection or the server.
      c.ws.send('{{{not json');
      const err = await c.waitFor('error', { timeoutMs: 3000 });
      assert(err.payload.message.includes('Malformed'), 'malformed JSON handled');
      // Server still healthy.
      const probe = new FakeClient(server.url, { name: 'S6-probe' });
      await probe.connect();
      probe.close();
    } finally {
      c.close();
      await sleep(200);
    }
  });

  // ------------------------------------------------------------------
  await scenario('S7: joining a second room implicitly leaves the first (no ghost roster entries)', async () => {
    const [a, b, c, d] = await connectMany(server.url, 4, 'S7-');
    try {
      const code1 = await a.createRoom();
      await b.joinRoom(code1);
      const code2 = await c.createRoom();

      // A hops to room2 WITHOUT sending leave_room first.
      assertEqual(await a.joinRoom(code2), 'ok', 'a joins room2');

      // Room1 must no longer list A. Observe its roster via a fresh joiner.
      assertEqual(await d.joinRoom(code1), 'ok', 'd joins room1');
      const update = await d.waitFor('room_update', { timeoutMs: 3000 });
      const ids = update.payload.players.map((p) => p.id);
      assert(!ids.includes(a.id), `room1 roster must not contain the ghost of A (got ${update.payload.players.map((p) => p.name).join(', ')})`);
      assertEqual(ids.length, 2, 'room1 has exactly b and d');

      // A must not receive room1 broadcasts anymore.
      a.drainInbox();
      b.send('leave_room'); // triggers a room1 room_update broadcast
      await a.expectSilence('room_update', 1200);
    } finally {
      closeAll([a, b, c, d]);
      await sleep(200);
    }
  });

  // ------------------------------------------------------------------
  await scenario('S7b: create_room while already in a room also leaves the old room', async () => {
    const [a, b] = await connectMany(server.url, 2, 'S7b-');
    try {
      const code1 = await a.createRoom();
      await b.joinRoom(code1);
      b.drainInbox();
      await a.createRoom(); // hop by creating, not joining
      const update = await b.waitFor('room_update', {
        timeoutMs: 3000,
        where: (m) => !m.payload.players.some((p) => p.id === a.id),
      });
      assertEqual(update.payload.players.length, 1, 'old room down to just b');
      assertEqual(update.payload.hostId, b.id, 'b inherited host of old room');
    } finally {
      closeAll([a, b]);
      await sleep(200);
    }
  });

  // ------------------------------------------------------------------
  await scenario('S7c: joining the SAME room twice does not duplicate the roster entry', async () => {
    const [a, b] = await connectMany(server.url, 2, 'S7c-');
    try {
      const code = await a.createRoom();
      await b.joinRoom(code);
      assertEqual(await b.joinRoom(code), 'ok', 'double-join acked');
      // Read the roster off a freshly-triggered broadcast (matched by its
      // difficulty marker, so stale room_updates in the inbox can't be picked).
      a.send('set_difficulty', { difficultyKey: 'easy' });
      const update = await b.waitFor('room_update', {
        timeoutMs: 3000,
        where: (m) => m.payload.difficultyKey === 'easy',
      });
      const ids = update.payload.players.map((p) => p.id);
      assertEqual(ids.length, new Set(ids).size, 'no duplicate player ids');
      assertEqual(ids.length, 2, 'exactly two roster entries');
    } finally {
      closeAll([a, b]);
      await sleep(200);
    }
  });

  // ------------------------------------------------------------------
  await scenario('S7d: hopping OUT of an in-progress Word Bomb game leaves the old game clean', async () => {
    // Exercises leaveCurrentRoom's containment path: the old room has a live
    // game, so removePlayer runs turn-advance / game-over logic. The hop must
    // both (a) land the hopper cleanly in the new room and (b) resolve the old
    // game for its survivor without a hang, crash, or ghost entry.
    const [a, b, dest] = await connectMany(server.url, 3, 'S7d-');
    try {
      const oldCode = await a.createRoom();
      assertEqual(await b.joinRoom(oldCode), 'ok', 'b joins old room');
      const destCode = await dest.createRoom();

      a.send('start_game');
      await a.waitFor('turn_update', { timeoutMs: 5000 });
      b.drainInbox();

      // A abandons the live game by joining a different room (no leave_room).
      assertEqual(await a.joinRoom(destCode), 'ok', 'hopper lands in destination room');

      // Old room: A is eliminated, leaving B the lone active player, so the
      // game must finish with B as winner (containment path did the right thing).
      const over = await b.waitFor('game_over', { timeoutMs: 5000 });
      assertEqual(over.payload.winnerId, b.id, 'old game resolved to the survivor');

      // Destination room really contains A (roster membership, not just mapping).
      dest.send('set_difficulty', { difficultyKey: 'hard' });
      const destUpdate = await a.waitFor('room_update', {
        timeoutMs: 3000,
        where: (m) => m.payload.difficultyKey === 'hard',
      });
      assert(destUpdate.payload.players.some((p) => p.id === a.id), 'hopper is in destination roster');

      // The same-room ack now works for A in its NEW room.
      assertEqual(await a.joinRoom(destCode), 'ok', 're-ack in destination room');
    } finally {
      closeAll([a, b, dest]);
      await sleep(200);
    }
  });

  // ------------------------------------------------------------------
  await scenario('S8: two clients race for the last slot -> exactly one gets in', async () => {
    const filler = await connectMany(server.url, 7, 'S8-fill');
    const [r1, r2] = await connectMany(server.url, 2, 'S8-race');
    try {
      const code = await filler[0].createRoom();
      for (const f of filler.slice(1)) assertEqual(await f.joinRoom(code), 'ok', 'filler joins');
      // 7 in; both racers fire join_room in the same tick.
      const p1 = r1.joinRoom(code);
      const p2 = r2.joinRoom(code);
      const [res1, res2] = await Promise.all([p1, p2]);
      const oks = [res1, res2].filter((r) => r === 'ok').length;
      assertEqual(oks, 1, `exactly one racer admitted (got: "${res1}", "${res2}")`);
      const fulls = [res1, res2].filter((r) => r === 'That room is full.').length;
      assertEqual(fulls, 1, 'the other got room_full');
    } finally {
      closeAll([...filler, r1, r2]);
      await sleep(300);
    }
  });

  // ------------------------------------------------------------------
  await scenario('S9: non-current player disconnects leaving one survivor -> game ends promptly', async () => {
    const [a, b] = await connectMany(server.url, 2, 'S9-');
    try {
      const code = await a.createRoom();
      await b.joinRoom(code);
      a.send('start_game');
      const turn = await a.waitFor('turn_update');
      const current = turn.payload.currentPlayerId === a.id ? a : b;
      const other = current === a ? b : a;
      current.drainInbox();

      // The NON-current player vanishes: only one active player remains, so the
      // game should end (winner = survivor) without waiting out turn timers.
      other.terminate();
      const over = await current.waitFor('game_over', { timeoutMs: 4000 });
      assertEqual(over.payload.winnerId, current.id, 'survivor declared winner');
    } finally {
      closeAll([a, b]);
      await sleep(200);
    }
  });

  // ------------------------------------------------------------------
  await scenario('S10: imposter disconnects mid-round -> round resolves without crash or hang', async () => {
    const clients = await connectMany(server.url, 4, 'S10-');
    try {
      const code = await clients[0].createRoom();
      for (const c of clients.slice(1)) await c.joinRoom(code);
      clients[0].send('set_game_type', { gameType: 'imposter-word' });
      clients[0].send('start_game');

      // Every player gets a private round_start telling them if they're it.
      const starts = await Promise.all(clients.map((c) => c.waitFor('round_start', { timeoutMs: 5000 })));
      const imposterIdx = starts.findIndex((m) => m.payload.isImposter);
      assert(imposterIdx !== -1, 'an imposter was assigned');
      const imposter = clients[imposterIdx];
      const others = clients.filter((_, i) => i !== imposterIdx);

      // Everyone answers, then the imposter rage-quits mid-answering phase.
      others.forEach((c) => c.send('submit_answer', { answer: 'thing' }));
      imposter.terminate();

      // The answer phase must still close into voting for the remaining players.
      // Nominal phase is ~33s (30s + countdown); the huge margin absorbs event-
      // loop stretch when the host machine is busy (timer ticks arrive late).
      const votePhase = await others[0].waitFor('vote_phase_start', { timeoutMs: 120000 });
      assert(Array.isArray(votePhase.payload.answers), 'answers revealed');

      // Everyone votes for someone still present; phase should resolve.
      const suspect = others[1].id;
      others.forEach((c) => c.send('submit_vote', { suspectId: suspect }));
      const results = await others[0].waitFor('vote_results', { timeoutMs: 60000 });
      assert(results.payload, 'vote_results delivered — no hang, no crash');
    } finally {
      closeAll(clients);
      await sleep(200);
    }
  });

  // ------------------------------------------------------------------
  await scenario('S11: rapid join/leave churn -> registry returns to baseline, server responsive', async () => {
    const churn = await spawnServer({ port: PORT_CHURN });
    try {
      const base = await getStats(churn.statsUrl);
      for (let round = 0; round < 10; round += 1) {
        const clients = await connectMany(churn.url, 5, `S11r${round}-`);
        const code = await clients[0].createRoom({ isPublic: true });
        await Promise.all(clients.slice(1).map((c) => c.joinRoom(code)));
        // Half leave cleanly, half hard-kill, interleaved.
        clients.forEach((c, i) => {
          if (i % 2 === 0) c.send('leave_room');
          else c.terminate();
        });
        closeAll(clients);
      }
      await sleep(600);
      const after = await getStats(churn.statsUrl);
      assertEqual(after.rooms, base.rooms, `rooms back to baseline (${base.rooms} -> ${after.rooms})`);
      assertEqual(after.playersTotal, 0, 'no stranded roster entries');
      assertEqual(after.roomTimers, 0, 'no stranded room timers');
      // Server still snappy.
      const probe = new FakeClient(churn.url, { name: 'S11-probe' });
      await probe.connect();
      const t0 = Date.now();
      await probe.createRoom();
      assert(Date.now() - t0 < 1000, 'create_room still fast after churn');
      probe.close();
    } finally {
      await churn.kill();
    }
  });

  const ok = summarize();
  await server.kill();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('scenario run crashed:', err);
  process.exit(2);
});
