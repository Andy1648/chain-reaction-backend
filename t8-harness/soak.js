// t8-harness/soak.js — ONE HOUR OF CONTINUOUS PLAY WITH CHURN.
//
// A ramp answers "how much can it hold". A soak answers the different and more
// important question: "does holding it for an hour cost anything that is never
// given back". Rooms open and close all day in production — a player quits, a
// phone loses signal, a match ends — and the only way a slow leak shows itself
// is a long run with that churn in it.
//
// CHURN, not just load: every churn tick recycles a slice of the rooms. Half of
// the leavers send a close frame (the player tapped MENU); half are TCP resets
// with no close frame at all (the phone went into a tunnel), because those take
// different cleanup paths in server.js and only one of them is the polite one.
//
// WHAT IS ASSERTED AT THE END, after everything disconnects and the process is
// given time to settle:
//   rooms == 0, roomTimers == 0, playersTotal == 0, wsClients == 0
//   activeTimeouts and activeSockets back to their pre-load baseline
//   RSS back within tolerance of baseline, and no upward TREND across the hour
//
// The trend check is the one that catches a real leak: a process can end at a
// clean baseline and still have grown steadily while loaded. The slope is taken
// over the loaded samples only (least squares, MB per minute).
//
// Run: node t8-harness/soak.js [rooms] [minutes] [workers]
const fs = require('fs');
const path = require('path');
const { spawnServer } = require('./spawn');
const { Fleet, Probe, makeSampler, mb, sleep } = require('./fleet');

const ROOMS = Number(process.argv[2] || 50);
const MINUTES = Number(process.argv[3] || 60);
const WORKERS = Number(process.argv[4] || 6);
const ROOM_SIZE = 4;
const SAMPLE_EVERY_MS = 15000;
const CHURN_EVERY_MS = 20000;
// Rooms recycled per worker per churn tick. At 50 rooms over 6 workers that is
// roughly a fifth of the fleet every 20s — about 2.5 full fleet turnovers an
// hour, which is heavier than production and deliberately so.
const CHURN_ROOMS_PER_WORKER = 2;

const OUT = path.join(__dirname, '..', 'claude', 't8-soak-samples.json');

/** Least-squares slope of y over x, in y-units per x-unit. */
function slope(points) {
  const n = points.length;
  if (n < 3) return 0;
  const sx = points.reduce((a, p) => a + p.x, 0);
  const sy = points.reduce((a, p) => a + p.y, 0);
  const sxx = points.reduce((a, p) => a + p.x * p.x, 0);
  const sxy = points.reduce((a, p) => a + p.x * p.y, 0);
  const denom = n * sxx - sx * sx;
  return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

async function main() {
  const startedAt = new Date();
  console.log(`SOAK: ${ROOMS} rooms x ${ROOM_SIZE} = ${ROOMS * ROOM_SIZE} players, ${MINUTES} min, ${WORKERS} workers`);
  console.log(`started ${startedAt.toISOString()}`);

  const server = await spawnServer({ port: 4470 });
  const sample = makeSampler(server.statsUrl);
  await sample();
  await sleep(1000);
  const baseline = await sample();
  console.log(
    `baseline: rooms=${baseline.rooms} timers=${baseline.roomTimers} ws=${baseline.wsClients} ` +
      `sockets=${baseline.activeSockets} timeouts=${baseline.activeTimeouts} rss=${mb(baseline.rssBytes)}MB heap=${mb(baseline.heapUsedBytes)}MB`
  );

  const probe = new Probe(server.url, 500);
  await probe.start();

  const fleet = new Fleet(server.url, { workers: WORKERS, roomSize: ROOM_SIZE });
  const t0 = Date.now();
  await fleet.start(ROOMS, {
    churnEveryMs: CHURN_EVERY_MS,
    churnRooms: CHURN_ROOMS_PER_WORKER,
  });
  console.log(`fleet up in ${Date.now() - t0}ms; soaking for ${MINUTES} minutes`);

  const samples = [];
  const loadStart = Date.now();
  const endAt = loadStart + MINUTES * 60000;
  let worst = { rttP95: 0, cpuPct: 0 };

  while (Date.now() < endAt) {
    await sleep(SAMPLE_EVERY_MS);
    const s = await sample();
    const rtt = probe.window();
    const tot = fleet.totals();
    const minute = (Date.now() - loadStart) / 60000;
    const row = {
      minute: Number(minute.toFixed(2)),
      rooms: s.rooms,
      players: s.playersTotal,
      timers: s.roomTimers,
      ws: s.wsClients,
      sockets: s.activeSockets,
      timeouts: s.activeTimeouts,
      rssMB: Number(mb(s.rssBytes)),
      heapMB: Number(mb(s.heapUsedBytes)),
      externalMB: Number(mb(s.externalBytes)),
      cpuPct: s.cpuPct == null ? null : Number(s.cpuPct.toFixed(1)),
      rttP50: rtt.p50,
      rttP95: rtt.p95,
      rttMax: rtt.max,
      probeLost: rtt.lost,
      churnCycles: tot.churnCycles,
      setupFail: tot.setupFail,
      serverErrors: tot.serverErrors,
      drops: tot.unexpectedClose,
      lagMs: tot.lagMs,
    };
    samples.push(row);
    if ((rtt.p95 || 0) > worst.rttP95) worst.rttP95 = rtt.p95;
    if ((row.cpuPct || 0) > worst.cpuPct) worst.cpuPct = row.cpuPct;
    // One line a sample so a tail -f of the log is readable overnight.
    console.log(
      `t+${String(row.minute).padStart(6)}m rooms=${String(row.rooms).padStart(3)} players=${String(row.players).padStart(4)} ` +
        `timers=${row.timers} ws=${row.ws} sock=${row.sockets} to=${row.timeouts} ` +
        `rss=${row.rssMB}MB heap=${row.heapMB}MB cpu=${row.cpuPct}% ` +
        `rtt p50=${row.rttP50} p95=${row.rttP95} max=${row.rttMax} lost=${row.probeLost} ` +
        `churn=${row.churnCycles} fails=${row.setupFail} lag=${row.lagMs}ms`
    );
    fs.writeFileSync(OUT, JSON.stringify({ baseline, samples }, null, 1));
  }

  console.log('\nsoak window over — tearing down');
  await fleet.stop({ hard: false });
  await probe.stop();

  // Settle: sockets close asynchronously and V8 will not hand memory back on
  // demand. Sample a few times so a slow drain is not read as residue.
  const settle = [];
  for (let i = 0; i < 6; i += 1) {
    await sleep(5000);
    const s = await sample();
    settle.push({
      atSec: (i + 1) * 5,
      rooms: s.rooms, timers: s.roomTimers, players: s.playersTotal,
      ws: s.wsClients, sockets: s.activeSockets, timeouts: s.activeTimeouts,
      rssMB: Number(mb(s.rssBytes)), heapMB: Number(mb(s.heapUsedBytes)),
    });
    console.log(`settle +${(i + 1) * 5}s: ${JSON.stringify(settle[settle.length - 1])}`);
  }
  const after = settle[settle.length - 1];

  // --- verdict ---
  const loaded = samples.filter((s) => s.minute > 2); // skip the ramp-in
  const rssSlope = slope(loaded.map((s) => ({ x: s.minute, y: s.rssMB })));
  const heapSlope = slope(loaded.map((s) => ({ x: s.minute, y: s.heapMB })));
  const baseRssMB = Number(mb(baseline.rssBytes));

  const problems = [];
  if (after.rooms !== 0) problems.push(`rooms did not drain: ${after.rooms}`);
  if (after.timers !== 0) problems.push(`room timers left: ${after.timers}`);
  if (after.players !== 0) problems.push(`roster entries left: ${after.players}`);
  if (after.ws !== 0) problems.push(`ws clients left: ${after.ws}`);
  if (after.timeouts > baseline.activeTimeouts + 2) {
    problems.push(`timeout handles ${baseline.activeTimeouts} -> ${after.timeouts}`);
  }
  if (after.sockets > baseline.activeSockets + 2) {
    problems.push(`socket handles ${baseline.activeSockets} -> ${after.sockets}`);
  }
  // RSS is allowed to sit above baseline (V8 keeps its arena) but not to have
  // CLIMBED steadily while loaded: 0.5 MB/min is 30 MB an hour, which on a
  // 512 MB Render instance is a real leak, not allocator noise.
  if (Math.abs(rssSlope) > 0.5) problems.push(`RSS trend ${rssSlope.toFixed(3)} MB/min while loaded`);
  if (Math.abs(heapSlope) > 0.3) problems.push(`heap trend ${heapSlope.toFixed(3)} MB/min while loaded`);
  if (after.rssMB > baseRssMB * 2) problems.push(`RSS ended at ${after.rssMB}MB vs ${baseRssMB}MB baseline`);

  const totals = fleet.totals();
  console.log(`\n==== SOAK RESULT ====`);
  console.log(`samples=${samples.length} churnCycles=${samples[samples.length - 1]?.churnCycles ?? 0} setupFail=${totals.setupFail}`);
  console.log(`RSS trend ${rssSlope.toFixed(3)} MB/min, heap trend ${heapSlope.toFixed(3)} MB/min (loaded window)`);
  console.log(`worst rtt p95 ${worst.rttP95}ms, worst cpu ${worst.cpuPct}%`);
  console.log(`baseline rss ${baseRssMB}MB -> final ${after.rssMB}MB`);
  console.log(problems.length ? `LEAK/RESIDUE: ${problems.join('; ')}` : 'LEAK/RESIDUE: none — clean return to baseline');

  const stderr = server.stderr();
  const fatal = /UnhandledPromiseRejection|uncaughtException|FATAL ERROR/i.test(stderr);
  if (fatal) {
    problems.push('fatal in server stderr');
    console.log(stderr.slice(0, 1500));
  }

  fs.writeFileSync(
    OUT,
    JSON.stringify(
      { startedAt, rooms: ROOMS, minutes: MINUTES, workers: WORKERS, baseline, samples, settle, after, rssSlope, heapSlope, worst, problems },
      null,
      1
    )
  );
  console.log(`samples written to ${OUT}`);
  await server.kill();
  process.exit(problems.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});
