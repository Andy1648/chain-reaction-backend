// t8-harness/ramp.js — 1 -> 200 CONCURRENT ROOMS, in steps, on one server.
//
// Rooms, not clients: a room is the unit that costs the server something (a
// registry entry, 1-5 live timers, a broadcast fan-out per tick). 200 rooms of
// 4 is 800 live sockets, which is the number the ceiling has to be quoted in.
//
// Each step ADDS rooms to the ones already playing (it never tears down and
// re-forms), so the numbers are cumulative load, and holds for HOLD_MS with
// full traffic before anything is sampled — a step read during setup would
// measure the connect storm instead of steady state.
//
// THE HONESTY CHECK: every step also reports `lagMs`, the worst drift of a
// worker's own 500ms send loop. Latency that rises while lagMs rises is this
// laptop running out of CPU, not the server running out of headroom. The
// ceiling in TRUST.md is quoted only up to the last step where lagMs stayed
// small — anything past that is a harness measurement.
//
// Run: node t8-harness/ramp.js [maxRooms] [workers]
const { spawnServer } = require('./spawn');
const { Fleet, Probe, makeSampler, mb, sleep } = require('./fleet');

const MAX_ROOMS = Number(process.argv[2] || 200);
const WORKERS = Number(process.argv[3] || 6);
// Rooms hold up to MAX_PLAYERS_PER_ROOM (8). T8_ROOM_SIZE re-runs the ladder at
// a different size, which is how "the ceiling in PLAYERS" gets tested rather
// than assumed: if the cost were purely per-player, 150x8 and 300x4 (both 1200
// players) would land in the same place.
const ROOM_SIZE = Number(process.env.T8_ROOM_SIZE || 4);
const HOLD_MS = Number(process.env.T8_HOLD_MS || 20000);
// The default ladder. T8_STEPS overrides it (comma-separated) so the run that
// FINDS the ceiling can keep climbing past 200 without re-walking the bottom.
const STEPS = (process.env.T8_STEPS
  ? process.env.T8_STEPS.split(',').map((n) => Number(n.trim()))
  : [1, 5, 10, 25, 50, 100, 150, 200]
).filter((n) => n > 0 && n <= MAX_ROOMS);

async function main() {
  const server = await spawnServer({ port: 4410 });
  const sample = makeSampler(server.statsUrl);
  await sample(); // prime the CPU delta
  const baseline = await sample();
  console.log(
    `baseline: rooms=${baseline.rooms} timers=${baseline.roomTimers} ws=${baseline.wsClients} ` +
      `sockets=${baseline.activeSockets} timeouts=${baseline.activeTimeouts} rss=${mb(baseline.rssBytes)}MB`
  );

  const probe = new Probe(server.url, 250);
  await probe.start();

  const rows = [];
  let running = 0;
  const fleets = [];
  let stopped = false;

  for (const target of STEPS) {
    const add = target - running;
    const fleet = new Fleet(server.url, { workers: WORKERS, roomSize: ROOM_SIZE });
    const t0 = Date.now();
    await fleet.start(add, { churnEveryMs: 0 });
    const setupMs = Date.now() - t0;
    fleets.push(fleet);
    running = target;

    probe.window(); // discard the setup storm
    await sleep(HOLD_MS);

    const s = await sample();
    const rtt = probe.window();
    const tot = fleets.reduce(
      (acc, f) => {
        const t = f.totals();
        acc.setupFail += t.setupFail;
        acc.serverErrors += t.serverErrors;
        acc.unexpectedClose += t.unexpectedClose;
        acc.received += t.received;
        acc.accepted += t.accepted;
        acc.lagMs = Math.max(acc.lagMs, t.lagMs);
        return acc;
      },
      { setupFail: 0, serverErrors: 0, unexpectedClose: 0, received: 0, accepted: 0, lagMs: 0 }
    );

    const row = {
      rooms: target,
      players: target * ROOM_SIZE,
      setupMs,
      serverRooms: s.rooms,
      serverPlayers: s.playersTotal,
      roomTimers: s.roomTimers,
      ws: s.wsClients,
      timeouts: s.activeTimeouts,
      rssMB: Number(mb(s.rssBytes)),
      heapMB: Number(mb(s.heapUsedBytes)),
      cpuPct: s.cpuPct == null ? null : Number(s.cpuPct.toFixed(1)),
      rttP50: rtt.p50,
      rttP95: rtt.p95,
      rttP99: rtt.p99,
      rttMax: rtt.max,
      probeLost: rtt.lost,
      setupFail: tot.setupFail,
      serverErrors: tot.serverErrors,
      drops: tot.unexpectedClose,
      lagMs: tot.lagMs,
    };
    rows.push(row);
    console.log(
      `rooms=${String(target).padStart(3)} players=${String(row.players).padStart(4)} ` +
        `srvRooms=${row.serverRooms} srvPlayers=${row.serverPlayers} ws=${row.ws} timers=${row.roomTimers} ` +
        `rss=${row.rssMB}MB heap=${row.heapMB}MB cpu=${row.cpuPct}% ` +
        `rtt p50=${row.rttP50} p95=${row.rttP95} p99=${row.rttP99} max=${row.rttMax} lost=${row.probeLost} ` +
        `setupFail=${row.setupFail} drops=${row.drops} lag=${row.lagMs}ms (setup ${setupMs}ms)`
    );

    // Stop early if the server is genuinely unhealthy — a ceiling is the last
    // HEALTHY step, and pushing past a broken one just burns an hour.
    if (rtt.p95 != null && rtt.p95 > 2000) {
      console.log(`STOPPING: p95 ${rtt.p95}ms exceeded the 2000ms health bar at ${target} rooms`);
      stopped = true;
      break;
    }
  }

  // --- Teardown: everything must come back to the pre-load baseline. ---
  for (const f of fleets) await f.stop({ hard: false });
  await probe.stop();
  await sleep(5000);
  const after = await sample();
  console.log(
    `\nAFTER TEARDOWN: rooms=${after.rooms} timers=${after.roomTimers} players=${after.playersTotal} ` +
      `ws=${after.wsClients} sockets=${after.activeSockets} timeouts=${after.activeTimeouts} ` +
      `rss=${mb(after.rssBytes)}MB heap=${mb(after.heapUsedBytes)}MB`
  );

  const problems = [];
  if (after.rooms !== 0) problems.push(`rooms did not drain: ${after.rooms}`);
  if (after.roomTimers !== 0) problems.push(`room timers left: ${after.roomTimers}`);
  if (after.playersTotal !== 0) problems.push(`roster entries left: ${after.playersTotal}`);
  if (after.wsClients !== 0) problems.push(`ws clients left: ${after.wsClients}`);
  if (after.activeTimeouts > baseline.activeTimeouts + 2) {
    problems.push(`timeout handles ${baseline.activeTimeouts} -> ${after.activeTimeouts}`);
  }
  if (after.activeSockets > baseline.activeSockets + 2) {
    problems.push(`socket handles ${baseline.activeSockets} -> ${after.activeSockets}`);
  }

  console.log(problems.length ? `\nRESIDUE: ${problems.join('; ')}` : '\nRESIDUE: none — clean baseline');
  console.log(`\nJSON ${JSON.stringify({ baseline, rows, after, stoppedEarly: stopped })}`);
  await server.kill();
  process.exit(problems.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err.stack);
  process.exit(1);
});
