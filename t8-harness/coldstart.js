// t8-harness/coldstart.js — THE REAL COLD START, MEASURED AGAINST THE CRON.
//
// Render's free tier spins an idle instance down after ~15 minutes; waking it
// costs a full container start plus this app's boot (an-array-of-english-words
// is ~275k entries loaded at require time). `.github/workflows/keepalive.yml`
// pings /healthz every 5 minutes so that never happens. This script measures
// whether that is TRUE IN PRACTICE, not whether the YAML says so, because the
// two can differ for reasons the YAML cannot show:
//
//   - GitHub's scheduled workflows are best-effort. Under load the queue slips,
//     and a slipped `*/5` can become a 15-25 minute gap. A gap longer than the
//     spin-down window is a cold start for whoever arrives next.
//   - A workflow on a repo with no pushes for 60 days is disabled by GitHub
//     automatically. The cron then silently stops.
//
// So three things are measured, none of them destructive (every request is the
// same GET the cron already makes, at a far lower rate):
//
//   1. WARM LATENCY: /healthz, sampled repeatedly. This is what a player who
//      arrives while the cron is doing its job actually pays.
//   2. LOCAL BOOT COST: the same server booted here, timed from spawn to its
//      first served request. This isolates THIS APP's share of a cold start
//      from Render's container share — the part the code can do anything about.
//   3. THE CRON'S REAL CADENCE: the actual gaps between the last N keepalive
//      runs, from the GitHub API, against the ~15 min spin-down window. The
//      margin is what says whether a cold start is reachable at all.
//
// Run: node t8-harness/coldstart.js
const https = require('https');
const { spawnServer } = require('./spawn');
const { sleep } = require('../t3-harness/runner');

const PROD = 'https://chain-reaction-backend-i6kx.onrender.com';
const RUNS_API =
  'https://api.github.com/repos/Andy1648/chain-reaction-backend/actions/workflows/keepalive.yml/runs';
const SPINDOWN_MIN = 15; // Render free tier idle timeout
const SAMPLES = Number(process.env.T8_HEALTH_SAMPLES || 12);
const GAP_MS = Number(process.env.T8_HEALTH_GAP_MS || 5000);

function timedGet(url) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let firstByteAt = null;
    const req = https.get(url, { timeout: 90000 }, (res) => {
      res.on('data', () => {
        if (firstByteAt == null) firstByteAt = process.hrtime.bigint();
      });
      res.on('end', () => {
        const done = process.hrtime.bigint();
        resolve({
          status: res.statusCode,
          ttfbMs: firstByteAt ? Number(firstByteAt - t0) / 1e6 : null,
          totalMs: Number(done - t0) / 1e6,
        });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout', totalMs: 90000 }); });
    req.on('error', (e) => resolve({ status: 0, error: e.message, totalMs: Number(process.hrtime.bigint() - t0) / 1e6 }));
  });
}

const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : null);

async function measureWarm() {
  console.log(`\n=== 1. WARM LATENCY — ${SAMPLES} x GET ${PROD}/healthz ===`);
  const rows = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const r = await timedGet(`${PROD}/healthz`);
    rows.push(r);
    console.log(`  #${String(i + 1).padStart(2)} status=${r.status} total=${r.totalMs.toFixed(0)}ms ttfb=${r.ttfbMs == null ? '-' : r.ttfbMs.toFixed(0)}ms${r.error ? ` (${r.error})` : ''}`);
    if (i < SAMPLES - 1) await sleep(GAP_MS);
  }
  const ok = rows.filter((r) => r.status === 200).map((r) => r.totalMs);
  const summary = {
    n: rows.length,
    ok: ok.length,
    p50: ok.length ? Number(pct(ok, 50).toFixed(0)) : null,
    p95: ok.length ? Number(pct(ok, 95).toFixed(0)) : null,
    max: ok.length ? Number(Math.max(...ok).toFixed(0)) : null,
    min: ok.length ? Number(Math.min(...ok).toFixed(0)) : null,
  };
  console.log(`  warm: ${summary.ok}/${summary.n} ok, p50=${summary.p50}ms p95=${summary.p95}ms max=${summary.max}ms`);
  // A response over ~10s is the shape of a container wake, not a warm hit.
  const coldLooking = ok.filter((t) => t > 10000).length;
  console.log(`  responses >10s (the shape of a wake): ${coldLooking}`);
  return { ...summary, coldLooking, rows };
}

async function measureLocalBoot() {
  console.log('\n=== 2. LOCAL BOOT COST — this app, spawn -> first request served ===');
  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    const t0 = Date.now();
    const server = await spawnServer({ port: 4490 + i * 2 });
    const listeningMs = Date.now() - t0;
    // Time a real request, not just the listen: the dictionary is loaded at
    // require time, so "listening" and "able to answer" can differ.
    const t1 = Date.now();
    await new Promise((resolve) => {
      require('http').get(`${server.httpUrl}/healthz`, (res) => { res.resume(); res.on('end', resolve); }).on('error', resolve);
    });
    const firstServeMs = Date.now() - t1;
    runs.push({ listeningMs, firstServeMs, totalMs: listeningMs + firstServeMs });
    console.log(`  run ${i + 1}: listening in ${listeningMs}ms, first request served ${firstServeMs}ms later`);
    await server.kill();
    await sleep(500);
  }
  const avg = Math.round(runs.reduce((a, r) => a + r.totalMs, 0) / runs.length);
  console.log(`  app boot ~${avg}ms (this machine; Render's container start is ON TOP of this)`);
  return { runs, avgMs: avg };
}

function apiGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { timeout: 30000, headers: { 'user-agent': 't8-harness', accept: 'application/vnd.github+json' } },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// The repo is public, so the runs list reads WITHOUT a token. `gh` is not
// installed on this machine, and requiring it would have meant reporting the
// cadence as "not measured" — the one number that says whether a cold start is
// reachable at all.
async function measureCron() {
  console.log();
  console.log("=== 3. THE CRON'S REAL CADENCE (GitHub REST) ===");
  let data;
  try {
    data = await apiGet(`${RUNS_API}?per_page=100`);
  } catch (err) {
    console.log(`  runs unavailable (${err.message}) — cadence not measured`);
    return { available: false, error: err.message };
  }
  const runs = data.workflow_runs || [];
  const times = runs
    .filter((r) => r.event === 'schedule')
    .map((r) => new Date(r.created_at).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (times.length < 3) {
    console.log(`  only ${times.length} scheduled runs found — cadence not measurable`);
    return { available: true, runs: times.length };
  }
  const gaps = [];
  for (let i = 1; i < times.length; i += 1) gaps.push((times[i] - times[i - 1]) / 60000);
  const maxGap = Math.max(...gaps);
  const sinceLast = (Date.now() - times[times.length - 1]) / 60000;
  const failed = runs.filter((r) => r.conclusion && r.conclusion !== 'success').length;
  const spanHours = (times[times.length - 1] - times[0]) / 3600000;
  console.log(`  ${times.length} scheduled runs over ${spanHours.toFixed(1)}h`);
  console.log(`  gaps: p50=${pct(gaps, 50).toFixed(1)}m p95=${pct(gaps, 95).toFixed(1)}m max=${maxGap.toFixed(1)}m (schedule says 5m)`);
  console.log(`  last run ${sinceLast.toFixed(1)} min ago; non-success runs in window: ${failed}`);
  console.log(`  spin-down window ~${SPINDOWN_MIN}m -> worst observed margin ${(SPINDOWN_MIN - maxGap).toFixed(1)}m`);
  const gapsOverWindow = gaps.filter((g) => g >= SPINDOWN_MIN).length;
  if (gapsOverWindow) {
    console.log(`  WARNING: ${gapsOverWindow} gap(s) reached the spin-down window — a visitor arriving in one pays a full cold start`);
  }
  return {
    available: true,
    runs: times.length,
    spanHours: Number(spanHours.toFixed(2)),
    p50GapMin: Number(pct(gaps, 50).toFixed(2)),
    p95GapMin: Number(pct(gaps, 95).toFixed(2)),
    maxGapMin: Number(maxGap.toFixed(2)),
    sinceLastMin: Number(sinceLast.toFixed(2)),
    failedRuns: failed,
    gapsOverWindow,
    marginMin: Number((SPINDOWN_MIN - maxGap).toFixed(2)),
  };
}

async function main() {
  const warm = await measureWarm();
  const boot = await measureLocalBoot();
  const cron = await measureCron();
  console.log(`\nJSON ${JSON.stringify({ warm: { ...warm, rows: undefined }, boot, cron })}`);
}

main().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});
