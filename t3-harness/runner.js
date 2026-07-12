// t3-harness/runner.js
// Shared scenario infrastructure: spawn/kill the backend as a child process,
// tiny sequential test runner with assert helpers, and a stats poller.

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const BASE_PORT = Number(process.env.T3_PORT || 4310);

/**
 * Spawns the backend (via server-wrapper.js so the stats side-port exists) and
 * resolves once it logs its listening line. Returns { url, statsUrl, kill }.
 * FAKE_DICTIONARY=1 by default so Word Bomb submissions are deterministic and
 * offline. Pass env overrides via opts.env.
 */
function spawnServer(opts = {}) {
  const port = opts.port || BASE_PORT;
  const statsPort = port + 1;
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, 'server-wrapper.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        T3_STATS_PORT: String(statsPort),
        FAKE_DICTIONARY: '1',
        ANTHROPIC_API_KEY: '', // force Blitz list-only mode: no external AI calls
        ...(opts.env || {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const onFail = (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    proc.on('error', onFail);
    proc.on('exit', (code) => onFail(new Error(`server exited early (code ${code})`)));
    const errBuf = [];
    proc.stderr.on('data', (d) => errBuf.push(d.toString()));
    proc.stdout.on('data', (d) => {
      const line = d.toString();
      if (opts.echo) process.stdout.write(`[server] ${line}`);
      if (!settled && line.includes('listening on port')) {
        settled = true;
        resolve({
          proc,
          url: `ws://127.0.0.1:${port}`,
          statsUrl: `http://127.0.0.1:${statsPort}`,
          kill: () =>
            new Promise((res) => {
              proc.removeAllListeners('exit');
              proc.on('exit', () => res());
              proc.kill();
              setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch { /* already dead */ }
                res();
              }, 2000).unref();
            }),
          stderr: () => errBuf.join(''),
        });
      }
    });
  });
}

/** GET the stats side-port as parsed JSON. */
function getStats(statsUrl) {
  return new Promise((resolve, reject) => {
    http
      .get(statsUrl, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Minimal sequential test runner ----

const results = [];

async function scenario(name, fn) {
  const started = Date.now();
  process.stdout.write(`\n=== ${name} ===\n`);
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    process.stdout.write(`--- PASS (${Date.now() - started}ms)\n`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, error: err });
    process.stdout.write(`--- FAIL: ${err.message}\n${err.stack.split('\n').slice(1, 4).join('\n')}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function summarize() {
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  process.stdout.write(`\n========================================\n`);
  process.stdout.write(`RESULTS: ${pass} passed, ${fail} failed, ${results.length} total\n`);
  results.filter((r) => !r.ok).forEach((r) => process.stdout.write(`  FAIL ${r.name}: ${r.error.message}\n`));
  process.stdout.write(`========================================\n`);
  return fail === 0;
}

module.exports = { spawnServer, getStats, sleep, scenario, assert, assertEqual, summarize, results };
