// t8-harness/fleet.js
// The parent side: spawn a pool of roomWorker children, aggregate their IPC
// metrics, sample the server's stats side-port, and probe request latency with
// a client of the parent's own.
//
// Everything that reports a number in claude/TRUST.md comes through here, so
// the two things that would make those numbers a lie are measured explicitly:
//   - `lagMs` (worst drift of a worker's own 500ms send loop) says whether the
//     HARNESS is saturated. A latency number taken while lagMs is climbing is
//     measuring this laptop, not the server.
//   - `setupFail` says whether rooms we claim are up actually came up.
const { fork } = require('child_process');
const path = require('path');
const { FakeClient } = require('../t3-harness/client');
const { getStats, sleep } = require('../t3-harness/runner');

const WORKER = path.join(__dirname, 'roomWorker.js');

const mb = (b) => (b / 1048576).toFixed(1);
const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;

class Fleet {
  constructor(url, { workers = 4, roomSize = 4, gameType = 'category-blitz' } = {}) {
    this.url = url;
    this.workerCount = workers;
    this.roomSize = roomSize;
    this.gameType = gameType;
    this.procs = [];
    this.latest = new Map(); // workerId -> last metrics frame
  }

  /** Start `rooms` rooms spread over the worker pool; resolves when all report ready. */
  async start(rooms, opts = {}) {
    const per = Math.ceil(rooms / this.workerCount);
    let left = rooms;
    const readies = [];
    for (let w = 0; w < this.workerCount && left > 0; w += 1) {
      const mine = Math.min(per, left);
      left -= mine;
      const cfg = {
        url: this.url,
        workerId: w,
        rooms: mine,
        roomSize: this.roomSize,
        gameType: this.gameType,
        ...opts,
      };
      const proc = fork(WORKER, [JSON.stringify(cfg)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      this.procs.push(proc);
      proc.on('message', (m) => {
        if (m.kind === 'metrics') this.latest.set(m.workerId, m);
      });
      readies.push(
        new Promise((resolve) => {
          const onMsg = (m) => {
            if (m.kind === 'ready') {
              proc.off('message', onMsg);
              resolve(m);
            }
          };
          proc.on('message', onMsg);
        })
      );
    }
    await Promise.all(readies);
  }

  /** Sum of every worker's latest frame. */
  totals() {
    const t = {
      roomsUp: 0, clientsUp: 0, setupOk: 0, setupFail: 0, churnCycles: 0,
      received: 0, accepted: 0, sendErrors: 0, unexpectedClose: 0, serverErrors: 0, lagMs: 0,
    };
    for (const m of this.latest.values()) {
      for (const k of Object.keys(t)) {
        if (k === 'lagMs') t.lagMs = Math.max(t.lagMs, m.lagMs || 0);
        else t[k] += m[k] || 0;
      }
    }
    return t;
  }

  /** Politely close every room, then kill the workers. */
  async stop({ hard = false } = {}) {
    await Promise.all(
      this.procs.map(
        (p) =>
          new Promise((resolve) => {
            const onMsg = (m) => {
              if (m.kind === 'teardown-done') {
                p.off('message', onMsg);
                resolve();
              }
            };
            p.on('message', onMsg);
            try { p.send({ cmd: 'teardown', hard }); } catch { resolve(); }
            setTimeout(resolve, 15000).unref();
          })
      )
    );
    await sleep(500);
    this.procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } });
    this.procs = [];
    this.latest.clear();
  }
}

/** A single client whose only job is to time a real request/response round-trip. */
class Probe {
  constructor(url, everyMs = 250) {
    this.url = url;
    this.everyMs = everyMs;
    this.rtts = [];
    this.lost = 0;
    this.running = false;
  }

  async start() {
    this.client = new FakeClient(this.url, { name: 't8-probe' });
    await this.client.connect(30000);
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        const t0 = Date.now();
        try {
          this.client.send('list_public_rooms');
          await this.client.waitFor('public_rooms', { timeoutMs: 10000 });
          this.rtts.push(Date.now() - t0);
        } catch {
          this.lost += 1;
          this.rtts.push(10000);
          if (this.client.closed) {
            // Reconnect: a probe that died mid-run would silently stop measuring.
            try {
              this.client = new FakeClient(this.url, { name: 't8-probe' });
              await this.client.connect(30000);
            } catch { /* try again next tick */ }
          }
        }
        this.client.drainInbox();
        this.client.log.length = 0;
        await sleep(this.everyMs);
      }
    })();
  }

  /** Percentiles over the samples taken since the last call, then reset. */
  window() {
    const s = [...this.rtts].sort((a, b) => a - b);
    const out = { n: s.length, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s[s.length - 1] ?? null, lost: this.lost };
    this.rtts = [];
    this.lost = 0;
    return out;
  }

  async stop() {
    this.running = false;
    try { await this.loop; } catch { /* ignore */ }
    try { this.client.close(); } catch { /* gone */ }
  }
}

/** Server stats with CPU% of one core, computed against the previous sample. */
function makeSampler(statsUrl) {
  let last = null;
  return async function sample() {
    const s = await getStats(statsUrl);
    let cpuPct = null;
    if (last) {
      const dMs = s.at - last.at;
      const dCpuUs = s.cpuUser - last.cpuUser + (s.cpuSystem - last.cpuSystem);
      if (dMs > 0) cpuPct = (dCpuUs / 1000 / dMs) * 100;
    }
    last = s;
    return { ...s, cpuPct };
  };
}

module.exports = { Fleet, Probe, makeSampler, mb, pct, sleep };
