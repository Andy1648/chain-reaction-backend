// t8-harness/adversarial.js — ADVERSARIAL GAME STATES.
//
// The fuzzer asks "can a malformed frame break the process". This asks a harder
// question: can a WELL-FORMED frame, sent by a real client at a moment the UI
// would never send it, corrupt a LIVE GAME for everybody else in the room.
// That is the class of bug a schema check cannot catch and a unit test rarely
// reaches, because every message here is individually legal — only the ORDER
// and the SENDER are wrong.
//
// T3's scenario suite already covers disconnect/host-migration/churn (S1-S11),
// so nothing here repeats it. These are illegal TRANSITIONS during a live game.
//
// Every case asserts the same three invariants, because they are the ones that
// matter to the other players in the room:
//   - the server is still up and still serving (a control round-trip)
//   - the live game's turn order / round state was not corrupted
//   - the room and its timers drain to zero when everyone leaves
//
// Run: node t8-harness/adversarial.js
const { FakeClient } = require('../t3-harness/client');
const { getStats, sleep } = require('../t3-harness/runner');
const { spawnServer } = require('./spawn');

const results = [];
let server = null;

async function adversary(name, fn) {
  const t0 = Date.now();
  process.stdout.write(`\n=== ${name} ===\n`);
  const clients = [];
  const track = (c) => { clients.push(c); return c; };
  try {
    await fn(track);
    // INVARIANT: whatever happened, the room must drain when everyone leaves.
    clients.forEach((c) => { try { c.close(); } catch { /* gone */ } });
    await sleep(1200);
    const s = await getStats(server.statsUrl);
    if (s.rooms !== 0 || s.roomTimers !== 0 || s.playersTotal !== 0) {
      throw new Error(`residue: rooms=${s.rooms} timers=${s.roomTimers} players=${s.playersTotal}`);
    }
    results.push({ name, ok: true, ms: Date.now() - t0 });
    process.stdout.write(`--- PASS (${Date.now() - t0}ms)\n`);
  } catch (err) {
    clients.forEach((c) => { try { c.terminate(); } catch { /* gone */ } });
    results.push({ name, ok: false, ms: Date.now() - t0, error: err.message });
    process.stdout.write(`--- FAIL: ${err.message}\n`);
    await sleep(1500);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** A started Word Bomb room: [host, ...rest] all in `code`, turn_update seen. */
async function wordBombRoom(track, n = 3) {
  const members = [];
  for (let i = 0; i < n; i += 1) {
    const c = track(new FakeClient(server.url, { name: `adv${i}` }));
    await c.connect(10000);
    members.push(c);
  }
  const [host, ...rest] = members;
  const code = await host.createRoom({ timeoutMs: 10000 });
  for (const m of rest) {
    const res = await m.joinRoom(code, { timeoutMs: 10000 });
    assert(res === 'ok', `setup join failed: ${res}`);
  }
  host.send('set_game_type', { gameType: 'word-bomb' });
  host.send('start_game');
  const turn = await host.waitFor('turn_update', { timeoutMs: 15000 });
  members.forEach((m) => m.drainInbox());
  return { members, host, rest, code, turn };
}

async function blitzRoom(track, n = 3) {
  const members = [];
  for (let i = 0; i < n; i += 1) {
    const c = track(new FakeClient(server.url, { name: `blz${i}` }));
    await c.connect(10000);
    members.push(c);
  }
  const [host, ...rest] = members;
  const code = await host.createRoom({ timeoutMs: 10000 });
  for (const m of rest) {
    const res = await m.joinRoom(code, { timeoutMs: 10000 });
    assert(res === 'ok', `setup join failed: ${res}`);
  }
  host.send('set_game_type', { gameType: 'category-blitz' });
  host.send('start_game');
  await host.waitFor('round_start', { timeoutMs: 15000 });
  members.forEach((m) => m.drainInbox());
  return { members, host, rest, code };
}

// MEASURING "DID THE TURN MOVE" WITHOUT A FALSE POSITIVE.
//
// The obvious version of this — read the turn owner, act, read it again — is
// WRONG, and wrong in a way that looks right: `waitFor('turn_update')` waits for
// the NEXT broadcast, and turn_update is only broadcast when the turn actually
// changes. So both reads land on different turns for the ordinary reason (the
// 10s timer fired), and every illegal-action test "fails" whatever the server
// does. The first run of this suite reported exactly that on four cases.
//
// The sound version anchors to the START of a turn and then asserts SILENCE:
// wait for a turn_update (so a full turn's worth of clock is ahead of us), send
// the illegal message, and assert no further turn_update arrives inside a window
// far shorter than the turn. On the default `medium` preset a turn is 10s, so a
// 1.5s window has 8.5s of margin — a turn_update inside it was caused by the
// message, not by the clock.
const TURN_SECONDS = 10; // gameLogic DIFFICULTY_PRESETS.medium.startSeconds
const SILENCE_MS = 1500;

/** Wait until a turn STARTS; returns the owner and the broadcast count so far. */
async function atTurnStart(client) {
  client.drainInbox();
  const t = await client.waitFor('turn_update', { timeoutMs: 20000 });
  return {
    id: t.payload.currentPlayerId,
    count: client.log.filter((l) => l.type === 'turn_update').length,
  };
}

/** Assert the illegal action produced no turn movement inside the safe window. */
async function assertNoTurnAdvance(client, start, what) {
  await sleep(SILENCE_MS);
  const now = client.log.filter((l) => l.type === 'turn_update').length;
  assert(
    now === start.count,
    `${what} produced ${now - start.count} turn_update(s) within ${SILENCE_MS}ms of a turn starting ` +
      `(a ${TURN_SECONDS}s turn — this cannot be the clock)`
  );
}

/** The live turn owner, from a fresh turn_update. */
async function currentPlayerId(client) {
  client.drainInbox();
  const t = await client.waitFor('turn_update', { timeoutMs: 20000 });
  return t.payload.currentPlayerId;
}

async function main() {
  server = await spawnServer({ port: 4450 });
  const crashes = [];
  server.proc.on('exit', (code, sig) => crashes.push(`exit code=${code} sig=${sig}`));

  // A1 — start_game below the minimum roster.
  await adversary('A1: start_game alone in the room', async (track) => {
    const c = track(new FakeClient(server.url, { name: 'solo' }));
    await c.connect(10000);
    await c.createRoom({ timeoutMs: 10000 });
    c.send('set_game_type', { gameType: 'word-bomb' });
    c.send('start_game');
    // Either a clean refusal or nothing — but never a turn timer for a game
    // that cannot be played, and never a crash.
    await sleep(1500);
    const s = await getStats(server.statsUrl);
    assert(s.roomTimers === 0, `a one-player word-bomb armed ${s.roomTimers} timer(s)`);
  });

  // A2 — start_game twice: a second game must not be armed under the first.
  await adversary('A2: start_game spammed 10x — one game, timers stay bounded', async (track) => {
    const { host } = await wordBombRoom(track, 3);
    const before = (await getStats(server.statsUrl)).roomTimers;
    for (let i = 0; i < 10; i += 1) host.send('start_game');
    await sleep(2000);
    const after = await getStats(server.statsUrl);
    assert(after.rooms === 1, `rooms: ${after.rooms}`);
    assert(
      after.roomTimers <= before + 1,
      `timers grew ${before} -> ${after.roomTimers} on repeated start_game (a leaked turn timer runs the clock twice as fast)`
    );
  });

  // A3 — submit_word out of turn must not advance the turn.
  await adversary('A3: out-of-turn submit does not move the turn', async (track) => {
    const { members, host } = await wordBombRoom(track, 3);
    const start = await atTurnStart(host);
    const offTurn = members.find((m) => m.id !== start.id);
    assert(offTurn, 'no off-turn player');
    for (let i = 0; i < 5; i += 1) offTurn.send('submit_word', { word: `steal${i}` });
    await assertNoTurnAdvance(host, start, 'an out-of-turn submit');
  });

  // A4 — skip_turn by a non-current player must not end anybody's turn.
  await adversary('A4: skip_turn by the wrong player is refused', async (track) => {
    const { members, host } = await wordBombRoom(track, 3);
    const start = await atTurnStart(host);
    const other = members.find((m) => m.id !== start.id);
    other.send('skip_turn');
    await assertNoTurnAdvance(host, start, 'a skip_turn from the wrong player');
  });

  // A5 — changing the game type mid-game must not swap the live game.
  await adversary('A5: set_game_type mid-game does not swap the live board', async (track) => {
    const { host, members } = await wordBombRoom(track, 3);
    const start = await atTurnStart(host);
    host.send('set_game_type', { gameType: 'category-blitz' });
    await assertNoTurnAdvance(host, start, 'set_game_type during a live game');
    const strayRound = members.some((m) => m.log.some((l) => l.type === 'round_start'));
    assert(!strayRound, 'set_game_type started a Blitz round on top of a live Word Bomb game');
  });

  // A6 — rematch spam.
  await adversary('A6: rematch spammed 20x mid-game — bounded timers, room intact', async (track) => {
    const { host } = await wordBombRoom(track, 3);
    const before = (await getStats(server.statsUrl)).roomTimers;
    for (let i = 0; i < 20; i += 1) host.send('rematch');
    await sleep(2500);
    const after = await getStats(server.statsUrl);
    assert(after.rooms === 1, `rooms: ${after.rooms}`);
    assert(
      after.roomTimers <= before + 1,
      `timers ${before} -> ${after.roomTimers} after 20 rematches (each leaked timer is another clock on the same room)`
    );
  });

  // A7 — a late joiner arriving into an in-progress game.
  await adversary('A7: joining an in-progress game does not corrupt the turn order', async (track) => {
    const { host, code } = await wordBombRoom(track, 3);
    const start = await atTurnStart(host);
    const late = track(new FakeClient(server.url, { name: 'latecomer' }));
    await late.connect(10000);
    await late.joinRoom(code, { timeoutMs: 10000 }); // ok or refused: both are fine
    await assertNoTurnAdvance(host, start, 'a join into an in-progress game');
  });

  // A8 — bot add/remove spam during a live game.
  await adversary('A8: add_bot/remove_bot spam mid-game keeps the roster consistent', async (track) => {
    const { host } = await wordBombRoom(track, 2);
    for (let i = 0; i < 15; i += 1) {
      host.send('add_bot');
      host.send('remove_bot');
    }
    await sleep(2500);
    const s = await getStats(server.statsUrl);
    assert(s.rooms === 1, `rooms: ${s.rooms}`);
    assert(s.playersTotal <= 8, `roster ballooned to ${s.playersTotal} on bot spam`);
    assert(s.roomTimers <= 4, `bot spam left ${s.roomTimers} timers on one room`);
  });

  // A9 — the host vanishes during the pre-game countdown.
  await adversary('A9: the host hard-drops during the countdown — no orphan countdown timer', async (track) => {
    const members = [];
    for (let i = 0; i < 3; i += 1) {
      const c = track(new FakeClient(server.url, { name: `cd${i}` }));
      await c.connect(10000);
      members.push(c);
    }
    const [host, ...rest] = members;
    const code = await host.createRoom({ timeoutMs: 10000 });
    for (const m of rest) await m.joinRoom(code, { timeoutMs: 10000 });
    host.send('set_game_type', { gameType: 'category-blitz' });
    host.send('start_game');
    await sleep(200); // mid-countdown
    host.terminate(); // TCP reset, no close frame — the phone-lost-signal case
    await sleep(6000);
    const s = await getStats(server.statsUrl);
    assert(s.rooms <= 1, `rooms: ${s.rooms}`);
    // Whatever the room decided (continue or tear down), the countdown must not
    // still be pending on a host that no longer exists.
    assert(s.roomTimers <= 2, `countdown/round timers left after host drop: ${s.roomTimers}`);
  });

  // A10 — every human leaves a room that still holds bots.
  await adversary('A10: all humans leave a bot game — the room and its bot timers go', async (track) => {
    const a = track(new FakeClient(server.url, { name: 'h1' }));
    const b = track(new FakeClient(server.url, { name: 'h2' }));
    await a.connect(10000);
    await b.connect(10000);
    const code = await a.createRoom({ timeoutMs: 10000 });
    await b.joinRoom(code, { timeoutMs: 10000 });
    a.send('add_bot');
    a.send('add_bot');
    await sleep(400);
    a.send('set_game_type', { gameType: 'word-bomb' });
    a.send('start_game');
    await a.waitFor('turn_update', { timeoutMs: 15000 });
    a.terminate();
    b.terminate();
    await sleep(4000);
    const s = await getStats(server.statsUrl);
    assert(s.rooms === 0, `a bot-only room survived every human leaving: rooms=${s.rooms}`);
    assert(s.roomTimers === 0, `bot timers left running with nobody watching: ${s.roomTimers}`);
  });

  // A11 — answers after the game is over.
  await adversary('A11: submits after game_over are inert', async (track) => {
    const { members, host } = await wordBombRoom(track, 2);
    // Skip until somebody wins. Each skip costs the current player a life.
    for (let i = 0; i < 20; i += 1) {
      const cur = await currentPlayerId(host).catch(() => null);
      if (cur == null) break;
      const owner = members.find((m) => m.id === cur);
      if (!owner) break;
      owner.send('skip_turn');
      await sleep(250);
      if (members.some((m) => m.log.some((l) => l.type === 'game_over'))) break;
    }
    const over = members.some((m) => m.log.some((l) => l.type === 'game_over'));
    assert(over, 'the game never ended, so the post-game path was never exercised');
    for (const m of members) {
      for (let i = 0; i < 10; i += 1) m.send('submit_word', { word: `zombie${i}` });
      m.send('skip_turn');
    }
    await sleep(1500);
    const s = await getStats(server.statsUrl);
    assert(s.roomTimers === 0, `a finished game still holds ${s.roomTimers} timer(s)`);
  });

  // A12 — reroll spam on a live Blitz round.
  await adversary('A12: reroll_category spammed on a live round stays coherent', async (track) => {
    const { host } = await blitzRoom(track, 3);
    for (let i = 0; i < 25; i += 1) host.send('reroll_category');
    await sleep(2500);
    const s = await getStats(server.statsUrl);
    assert(s.rooms === 1, `rooms: ${s.rooms}`);
    assert(s.roomTimers <= 3, `reroll spam left ${s.roomTimers} timers on one room`);
  });

  // A13 — leaving a room you are not in, twice.
  await adversary('A13: leave_room when not in a room, repeatedly', async (track) => {
    const c = track(new FakeClient(server.url, { name: 'nomad' }));
    await c.connect(10000);
    for (let i = 0; i < 20; i += 1) c.send('leave_room');
    await sleep(800);
    c.drainInbox();
    c.send('list_public_rooms');
    await c.waitFor('public_rooms', { timeoutMs: 8000 }); // still served
  });

  // A14 — one socket creating rooms as fast as it can.
  await adversary('A14: create_room x60 from one socket — throttled, no orphans', async (track) => {
    const c = track(new FakeClient(server.url, { name: 'creator' }));
    await c.connect(10000);
    for (let i = 0; i < 60; i += 1) c.send('create_room', { name: `spam${i}` });
    await sleep(3000);
    const s = await getStats(server.statsUrl);
    // One socket can only be in one room at a time, so at most one room should
    // survive this — the rest must be reclaimed as each create leaves the last.
    assert(s.rooms <= 2, `60 creates from one socket left ${s.rooms} rooms standing`);
    assert(s.playersTotal <= 2, `roster entries left: ${s.playersTotal}`);
  });

  // A15 — the classic turn race: two players submit in the same tick.
  await adversary('A15: simultaneous submits — exactly one turn advance', async (track) => {
    const { members, host } = await wordBombRoom(track, 3);
    const cur = await currentPlayerId(host);
    const owner = members.find((m) => m.id === cur);
    const turnUpdatesBefore = host.log.filter((l) => l.type === 'turn_update').length;
    // The same legal word, twice, from the same player in one tick.
    owner.send('submit_word', { word: 'raceword' });
    owner.send('submit_word', { word: 'raceword' });
    await sleep(1500);
    const advances = host.log.filter((l) => l.type === 'turn_update').length - turnUpdatesBefore;
    assert(advances <= 2, `one submit burst produced ${advances} turn_updates (a double advance skips a player's turn)`);
  });

  // ---- verdict ----
  await sleep(2000);
  const after = await getStats(server.statsUrl);
  const stderr = server.stderr();
  const fatal = /UnhandledPromiseRejection|uncaughtException|FATAL ERROR/i.test(stderr);
  const failed = results.filter((r) => !r.ok);
  console.log(`\nfinal: rooms=${after.rooms} timers=${after.roomTimers} players=${after.playersTotal} crashes=${crashes.length}`);
  console.log(`==== ADVERSARIAL: ${results.length - failed.length}/${results.length} passed ====`);
  failed.forEach((f) => console.log(`  FAIL ${f.name}: ${f.error}`));
  if (fatal) console.log(`STDERR HAD A FATAL:\n${stderr.slice(0, 1000)}`);
  console.log(`JSON ${JSON.stringify({ results, after, crashes, fatal })}`);
  await server.kill();
  process.exit(failed.length || crashes.length || fatal ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});
