// t3-harness/load.js
// Phase 3 load driver. Runs waves of N concurrent clients (default 10, 50,
// 200) against one server instance. Each wave: rooms of 4 playing a real
// Category Blitz game (timer broadcasts every second), every client relaying
// typing_update twice a second and submitting an answer every 2s. Between
// waves everything disconnects, so registry/timer/memory leaks show up as a
// rising baseline from wave to wave.
//
// Measures, per wave:
//   - request RTT via a dedicated probe client (list_public_rooms round-trip),
//     sampled every 250ms -> p50 / p95 / max
//   - server rss / heapUsed / rooms / roomTimers / activeTimeouts every 2s
//   - CPU% of one core (cpuUser+cpuSystem deltas between samples)
//   - post-teardown residue (rooms / timers / roster entries left behind)
//
// Run: node t3-harness/load.js            # waves of 10, 50, 200
//      node t3-harness/load.js 50         # single wave of 50
//
// NOTE: client count per wave is capped by the harness process itself well
// before the server (one Node process drives every fake client); treat the
// numbers as "server under this many real message streams", not a max-capacity
// benchmark of the harness machine.

const { FakeClient } = require('./client');
const { spawnServer, getStats, sleep } = require('./runner');

const PORT = 4350;
const ROOM_SIZE = 4;
const WAVE_DURATION_MS = 75000; // < one full Blitz game (~85s) so rounds keep cycling
const TYPING_EVERY_MS = 500;
const ANSWER_EVERY_MS = 2000;
const STATS_EVERY_MS = 2000;
const PROBE_EVERY_MS = 250;

function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const mb = (bytes) => (bytes / 1048576).toFixed(1);

async function runWave(server, nClients, label) {
  console.log(`\n=== WAVE ${label}: ${nClients} clients ===`);
  const nRooms = Math.max(1, Math.floor(nClients / ROOM_SIZE));
  const clients = [];
  const intervals = [];
  let messagesReceived = 0;
  let answersAccepted = 0;

  // --- Setup: connect in batches, form rooms, start Blitz games ---
  const t0 = Date.now();
  for (let r = 0; r < nRooms; r += 1) {
    const members = [];
    for (let i = 0; i < ROOM_SIZE; i += 1) {
      const c = new FakeClient(server.url, { name: `w${label}r${r}p${i}` });
      await c.connect(15000);
      members.push(c);
      clients.push(c);
    }
    const [host, ...rest] = members;
    const code = await host.createRoom({ isPublic: true, timeoutMs: 15000 });
    for (const m of rest) {
      const res = await m.joinRoom(code, { timeoutMs: 15000 });
      if (res !== 'ok') throw new Error(`join failed in setup: ${res}`);
    }
    host.send('set_game_type', { gameType: 'category-blitz' });
    host.send('start_game');
    await host.waitFor('round_start', { timeoutMs: 15000 });
  }
  console.log(`setup: ${nRooms} rooms x ${ROOM_SIZE} players in ${Date.now() - t0}ms`);

  // --- Live traffic ---
  let answerSeq = 0;
  clients.forEach((c, ci) => {
    c.ws.on('message', () => { messagesReceived += 1; });
    intervals.push(setInterval(() => c.send('typing_update', { text: `typing ${ci}` }), TYPING_EVERY_MS));
    intervals.push(
      setInterval(() => {
        answerSeq += 1;
        c.send('submit_answer', { answer: `loadword${ci}x${answerSeq}` });
      }, ANSWER_EVERY_MS)
    );
    // Keep the harness's own memory flat: we never waitFor on these clients
    // again, so their logs/inboxes are dead weight.
    intervals.push(setInterval(() => { c.log.length = 0; c.inbox.length = 0; }, 5000));
    c.ws.on('message', (raw) => {
      if (raw.toString().includes('"accepted":true')) answersAccepted += 1;
    });
  });

  // --- Probe client: RTT of a real request/response every 250ms ---
  const probe = new FakeClient(server.url, { name: `probe-${label}` });
  await probe.connect();
  const rtts = [];
  let probing = true;
  const probeLoop = (async () => {
    while (probing) {
      const start = Date.now();
      probe.send('list_public_rooms');
      try {
        await probe.waitFor('public_rooms', { timeoutMs: 10000 });
        rtts.push(Date.now() - start);
      } catch {
        rtts.push(10000); // count a lost probe as worst-case
      }
      probe.drainInbox();
      await sleep(PROBE_EVERY_MS);
    }
  })();

  // --- Stats sampling ---
  const samples = [];
  let lastCpu = null;
  const sampler = setInterval(async () => {
    try {
      const s = await getStats(server.statsUrl);
      let cpuPct = null;
      if (lastCpu) {
        const dUser = s.cpuUser - lastCpu.user;
        const dSys = s.cpuSystem - lastCpu.system;
        const dWall = (Date.now() - lastCpu.at) * 1000; // usec
        cpuPct = Math.round(((dUser + dSys) / dWall) * 100);
      }
      lastCpu = { user: s.cpuUser, system: s.cpuSystem, at: Date.now() };
      samples.push({ ...s, cpuPct, at: Date.now() });
    } catch { /* server busy; skip sample */ }
  }, STATS_EVERY_MS);

  await sleep(WAVE_DURATION_MS);

  // --- Teardown ---
  clearInterval(sampler);
  intervals.forEach(clearInterval);
  probing = false;
  await probeLoop;
  probe.close();
  clients.forEach((c) => c.close());
  await sleep(2500); // let close frames drain and rooms tear down

  const residue = await getStats(server.statsUrl);

  // --- Report ---
  const sortedRtt = [...rtts].sort((a, b) => a - b);
  const cpuVals = samples.map((s) => s.cpuPct).filter((v) => v !== null);
  const rssPeak = Math.max(...samples.map((s) => s.rssBytes));
  const heapPeak = Math.max(...samples.map((s) => s.heapUsedBytes));
  const report = {
    label,
    clients: nClients,
    rooms: nRooms,
    durationSec: WAVE_DURATION_MS / 1000,
    rtt: {
      samples: rtts.length,
      p50: pct(sortedRtt, 50),
      p95: pct(sortedRtt, 95),
      max: sortedRtt[sortedRtt.length - 1],
    },
    cpuPct: { avg: cpuVals.length ? Math.round(cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length) : null, max: cpuVals.length ? Math.max(...cpuVals) : null },
    rssPeakMb: +mb(rssPeak),
    heapPeakMb: +mb(heapPeak),
    messagesReceivedByClients: messagesReceived,
    answersAccepted,
    residueAfterTeardown: {
      rooms: residue.rooms,
      roomTimers: residue.roomTimers,
      playersTotal: residue.playersTotal,
      activeTimeouts: residue.activeTimeouts,
      rssMb: +mb(residue.rssBytes),
      heapUsedMb: +mb(residue.heapUsedBytes),
    },
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

(async () => {
  const arg = Number(process.argv[2]);
  const waves = arg ? [arg] : [10, 50, 200];

  const server = await spawnServer({ port: PORT });
  console.log(`load server at ${server.url}`);
  const baseline = await getStats(server.statsUrl);
  console.log(`baseline: rss ${mb(baseline.rssBytes)}MB heap ${mb(baseline.heapUsedBytes)}MB timeouts ${baseline.activeTimeouts}`);

  const reports = [];
  for (const n of waves) {
    reports.push(await runWave(server, n, String(n)));
    await sleep(2000); // settle between waves
  }

  const final = await getStats(server.statsUrl);
  console.log(`\nfinal after all waves: rss ${mb(final.rssBytes)}MB heap ${mb(final.heapUsedBytes)}MB rooms ${final.rooms} roomTimers ${final.roomTimers} activeTimeouts ${final.activeTimeouts}`);
  console.log(`baseline was:          rss ${mb(baseline.rssBytes)}MB heap ${mb(baseline.heapUsedBytes)}MB activeTimeouts ${baseline.activeTimeouts}`);

  await server.kill();
})().catch((err) => {
  console.error('load run crashed:', err);
  process.exit(2);
});
