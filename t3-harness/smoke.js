// t3-harness/smoke.js
// Harness self-check: boots the server, plays a full 2-player Word Bomb game
// (via submit_word with FAKE_DICTIONARY, then skip_turn to finish), and a
// 1-round slice of Category Blitz. If this passes, the harness plumbing works.
// Run: node t3-harness/smoke.js

const { FakeClient } = require('./client');
const { spawnServer, getStats, scenario, assert, assertEqual, summarize, sleep } = require('./runner');

(async () => {
  const server = await spawnServer({ port: 4310 });
  console.log(`server up at ${server.url}`);

  await scenario('word bomb: create, join, play a word, skip to game over', async () => {
    const a = new FakeClient(server.url, { name: 'Alice' });
    const b = new FakeClient(server.url, { name: 'Bob' });
    await a.connect();
    await b.connect();

    const code = await a.createRoom();
    assert(/^[A-Z2-9]{5}$/.test(code), `room code shape (${code})`);
    assertEqual(await b.joinRoom(code), 'ok', 'join succeeds');

    a.send('start_game');
    const started = await a.waitFor('game_started');
    assertEqual(started.payload.gameType, 'word-bomb', 'game type');
    const turn = await a.waitFor('turn_update');
    const currentId = turn.payload.currentPlayerId;
    assert([a.id, b.id].includes(currentId), 'current player is one of ours');

    // The current player submits a word containing the combo (carried in
    // turn_update). With FAKE_DICTIONARY any alphabetic word is "real".
    const current = currentId === a.id ? a : b;
    const comboStr = turn.payload.combo;
    assert(typeof comboStr === 'string' && comboStr.length >= 2, `combo present (${comboStr})`);
    current.send('submit_word', { word: `${comboStr}abc` });
    const wr = await current.waitFor('word_result');
    assert(wr.payload.accepted, `word accepted (${JSON.stringify(wr.payload)})`);

    // Now skip turns until someone is eliminated and the game ends.
    // 2 players x 3 lives: at most 6 skips.
    let over = null;
    for (let i = 0; i < 12 && !over; i += 1) {
      const tu = await a.waitForAny(['turn_update', 'game_over'], { timeoutMs: 8000 });
      if (tu.type === 'game_over') {
        over = tu;
        break;
      }
      const cur = tu.payload.currentPlayerId === a.id ? a : b;
      cur.send('skip_turn');
      await a.waitFor('turn_skipped', { timeoutMs: 5000 });
    }
    assert(over, 'game reached game_over via skips');
    a.close();
    b.close();
  });

  await scenario('category blitz: round starts, answers accepted, progress broadcast', async () => {
    const a = new FakeClient(server.url, { name: 'Cara' });
    const b = new FakeClient(server.url, { name: 'Dan' });
    await a.connect();
    await b.connect();
    const code = await a.createRoom();
    assertEqual(await b.joinRoom(code), 'ok', 'join');
    a.drainInbox();
    b.drainInbox();
    a.send('set_game_type', { gameType: 'category-blitz' });
    await a.waitFor('room_update');
    a.send('start_game');
    await a.waitFor('game_started');
    const rs = await b.waitFor('round_start');
    assert(rs.payload.category, 'category announced');

    // List-only mode (no API key): any >=2-char answer is accepted.
    b.send('submit_answer', { answer: 'zebra' });
    const ar = await b.waitFor('answer_result');
    assert(ar.payload.accepted, `answer accepted (${JSON.stringify(ar.payload)})`);
    const prog = await a.waitFor('player_progress');
    assertEqual(prog.payload.playerId, b.id, 'progress names the submitter');
    assertEqual(prog.payload.answerCount, 1, 'count = 1');
    a.close();
    b.close();
  });

  await scenario('stats endpoint reports registry state', async () => {
    const c = new FakeClient(server.url, { name: 'Eve' });
    await c.connect();
    await c.createRoom();
    const stats = await getStats(server.statsUrl);
    assert(stats.rooms >= 1, `rooms tracked (${stats.rooms})`);
    assert(typeof stats.rssBytes === 'number', 'rss present');
    assert(typeof stats.activeTimeouts === 'number', 'timeout count present');
    c.close();
    await sleep(300);
    const after = await getStats(server.statsUrl);
    assert(after.rooms === stats.rooms - 1, `room destroyed on disconnect (${stats.rooms} -> ${after.rooms})`);
  });

  const ok = summarize();
  await server.kill();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('smoke run crashed:', err);
  process.exit(2);
});
