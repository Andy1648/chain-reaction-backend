// t8-harness/roomWorker.js
// ONE CHILD PROCESS DRIVING A SHARE OF THE ROOMS.
//
// WHY CHILD PROCESSES AT ALL: the T3 load run carried an explicit caveat — one
// Node process drove every fake client, so at 200 clients the HARNESS was the
// bottleneck and the numbers read as "the server survived N streams", not as a
// capacity ceiling. This run has to report a ceiling in PLAYERS, so the load
// side is sharded across processes: each worker owns its own event loop, and
// the parent can tell a saturated server from a saturated harness by watching
// whether a worker's own send-loop drifts (`lagMs` below).
//
// Config arrives as one JSON argv. Metrics go back over IPC once a second.
const { FakeClient } = require('../t3-harness/client');

const cfg = JSON.parse(process.argv[2]);
const {
  url,
  workerId,
  rooms: roomCount,
  roomSize = 4,
  gameType = 'category-blitz',
  typingEveryMs = 500,
  answerEveryMs = 2000,
  churnEveryMs = 0, // 0 = no churn
  churnRooms = 0, // how many rooms to recycle per churn tick
  reportEveryMs = 1000,
} = cfg;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const metrics = {
  workerId,
  roomsUp: 0,
  clientsUp: 0,
  setupOk: 0,
  setupFail: 0,
  churnCycles: 0,
  received: 0,
  accepted: 0,
  sendErrors: 0,
  unexpectedClose: 0,
  serverErrors: 0, // `error` frames the server sent us
  lagMs: 0, // worst observed drift of our own 500ms send loop (harness saturation)
};

const live = new Map(); // roomIdx -> { clients: [], timers: [] }
let seq = 0;

function wire(c, idx) {
  c.ws.on('message', (raw) => {
    metrics.received += 1;
    const s = raw.toString();
    if (s.includes('"accepted":true')) metrics.accepted += 1;
    if (s.includes('"type":"error"')) metrics.serverErrors += 1;
  });
  c.ws.on('close', () => {
    if (live.has(idx)) metrics.unexpectedClose += 1;
  });
}

async function buildRoom(idx) {
  const clients = [];
  try {
    for (let i = 0; i < roomSize; i += 1) {
      const c = new FakeClient(url, { name: `w${workerId}r${idx}p${i}` });
      await c.connect(30000);
      clients.push(c);
    }
    const [host, ...rest] = clients;
    const code = await host.createRoom({ isPublic: true, timeoutMs: 30000 });
    for (const m of rest) {
      const res = await m.joinRoom(code, { timeoutMs: 30000 });
      if (res !== 'ok') throw new Error(`join: ${res}`);
    }
    host.send('set_game_type', { gameType });
    host.send('start_game');
    await host.waitFor(gameType === 'category-blitz' ? 'round_start' : 'turn_update', {
      timeoutMs: 30000,
    });

    const timers = [];
    clients.forEach((c, ci) => {
      wire(c, idx);
      let expected = Date.now() + typingEveryMs;
      timers.push(
        setInterval(() => {
          // Our own loop drifting is the harness saturating, not the server.
          const drift = Date.now() - expected;
          if (drift > metrics.lagMs) metrics.lagMs = drift;
          expected = Date.now() + typingEveryMs;
          try {
            c.send('typing_update', { text: `t${ci}` });
          } catch {
            metrics.sendErrors += 1;
          }
        }, typingEveryMs)
      );
      timers.push(
        setInterval(() => {
          seq += 1;
          try {
            if (gameType === 'category-blitz') c.send('submit_answer', { answer: `w${workerId}a${seq}` });
            else c.send('submit_word', { word: `loadword${seq}` });
          } catch {
            metrics.sendErrors += 1;
          }
        }, answerEveryMs)
      );
      // The harness's own memory must stay flat over an hour: these clients are
      // never awaited again, so their logs/inboxes are pure ballast.
      timers.push(
        setInterval(() => {
          c.log.length = 0;
          c.inbox.length = 0;
        }, 5000)
      );
    });

    live.set(idx, { clients, timers });
    metrics.setupOk += 1;
    metrics.roomsUp = live.size;
    metrics.clientsUp = live.size * roomSize;
    return true;
  } catch (err) {
    metrics.setupFail += 1;
    clients.forEach((c) => {
      try { c.terminate(); } catch { /* already gone */ }
    });
    if (metrics.setupFail <= 3) console.error(`[w${workerId}] room ${idx} setup failed: ${err.message}`);
    return false;
  }
}

function tearDownRoom(idx, { hard = false } = {}) {
  const room = live.get(idx);
  if (!room) return;
  live.delete(idx); // delete FIRST so the close handler doesn't count it as unexpected
  room.timers.forEach(clearInterval);
  room.clients.forEach((c) => {
    try {
      if (hard) c.terminate();
      else c.close();
    } catch { /* already gone */ }
  });
  metrics.roomsUp = live.size;
  metrics.clientsUp = live.size * roomSize;
}

async function main() {
  process.on('message', async (msg) => {
    if (msg.cmd === 'teardown') {
      for (const idx of [...live.keys()]) tearDownRoom(idx, { hard: !!msg.hard });
      process.send({ kind: 'teardown-done', workerId });
    }
  });

  const reporter = setInterval(() => {
    try { process.send({ kind: 'metrics', ...metrics }); } catch { /* parent gone */ }
  }, reportEveryMs);
  reporter.unref();

  // Build rooms with a small stagger: a thundering herd of 800 sockets in one
  // tick measures the accept backlog, not steady-state capacity.
  for (let i = 0; i < roomCount; i += 1) {
    await buildRoom(i);
    await sleep(20);
  }
  process.send({ kind: 'ready', workerId, roomsUp: live.size });

  // CHURN: recycle `churnRooms` rooms every churnEveryMs. Half leave politely
  // (close frame), half are hard-killed (TCP reset) — a phone losing signal is
  // the common case in production and exercises a different cleanup path.
  if (churnEveryMs > 0 && churnRooms > 0) {
    let cursor = 0;
    setInterval(async () => {
      metrics.churnCycles += 1;
      const picks = [];
      for (let n = 0; n < churnRooms; n += 1) {
        picks.push(cursor % roomCount);
        cursor += 1;
      }
      for (const idx of picks) tearDownRoom(idx, { hard: cursor % 2 === 0 });
      await sleep(250);
      for (const idx of picks) await buildRoom(idx);
    }, churnEveryMs);
  }
}

main().catch((err) => {
  console.error(`[w${workerId}] fatal: ${err.stack}`);
  process.exit(1);
});
