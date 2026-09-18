// t8-harness/spawn.js — boot the real backend behind t8's richer stats port.
// Same contract as t3-harness/runner.spawnServer (which hard-codes t3's wrapper
// and therefore cannot see wss.clients).
const { spawn } = require('child_process');
const path = require('path');

function spawnServer(opts = {}) {
  const port = opts.port || 4410;
  const statsPort = opts.statsPort || port + 1;
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, 'server-wrapper.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        T8_STATS_PORT: String(statsPort),
        FAKE_DICTIONARY: '1',
        ANTHROPIC_API_KEY: '', // Blitz list-only: no external AI call in the hot path
        ...(opts.env || {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    proc.on('error', fail);
    proc.on('exit', (code) => fail(new Error(`server exited early (code ${code})`)));
    const errBuf = [];
    proc.stderr.on('data', (d) => {
      errBuf.push(d.toString());
      if (opts.echo) process.stderr.write(`[server] ${d}`);
    });
    proc.stdout.on('data', (d) => {
      const line = d.toString();
      if (opts.echo) process.stdout.write(`[server] ${line}`);
      if (!settled && line.includes('listening on port')) {
        settled = true;
        resolve({
          proc,
          pid: proc.pid,
          url: `ws://127.0.0.1:${port}`,
          httpUrl: `http://127.0.0.1:${port}`,
          statsUrl: `http://127.0.0.1:${statsPort}`,
          stderr: () => errBuf.join(''),
          kill: () =>
            new Promise((res) => {
              proc.removeAllListeners('exit');
              proc.on('exit', () => res());
              proc.kill();
              setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* dead */ } res(); }, 3000).unref();
            }),
        });
      }
    });
  });
}

module.exports = { spawnServer };
