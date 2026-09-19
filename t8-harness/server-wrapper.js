// t8-harness/server-wrapper.js
// Boots the REAL backend and serves a richer stats side-port than t3's.
//
// WHY A SECOND WRAPPER: the trust run asserts that SOCKETS return to baseline,
// not just rooms and timers. t3's wrapper discards server.js's exports, so it
// cannot see `wss.clients`. This one captures them. Production code is
// untouched — this file is the only thing that knows the stats port exists.
const http = require('http');
const v8 = require('v8');
const roomManager = require('../roomManager');

const { wss } = require('../server.js'); // starts express + wss on process.env.PORT

const statsPort = Number(process.env.T8_STATS_PORT || 0);
if (statsPort) {
  http
    .createServer((req, res) => {
      const mem = process.memoryUsage();
      let activeTimeouts = null;
      let activeSockets = null;
      try {
        const handles = process._getActiveHandles();
        const nameOf = (h) => (h && h.constructor && h.constructor.name) || '';
        activeTimeouts = handles.filter((h) => nameOf(h) === 'Timeout').length;
        // Every live TCP conn the process holds, listeners included. The delta
        // from baseline is what matters, so the two listeners cancel out.
        activeSockets = handles.filter((h) => nameOf(h) === 'Socket').length;
      } catch { /* fine — report null */ }
      let wsClients = null;
      let wsOpen = null;
      try {
        wsClients = wss.clients.size;
        wsOpen = [...wss.clients].filter((c) => c.readyState === 1).length;
      } catch { /* fine */ }
      // PROTOTYPE POLLUTION CANARIES. The fuzzer posts __proto__ / constructor
      // payloads through every message type; if any handler merged one into an
      // object, these markers appear on every plain object in the process.
      const markers = ['polluted', 't8pwn', 'isAdmin', 'isHost', 'toString2'];
      const empty = {};
      const polluted = markers.filter((k) => empty[k] !== undefined);
      const protoOwnKeys = Object.getOwnPropertyNames(Object.prototype).length;

      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          ...roomManager._getStatsForTesting(),
          polluted,
          protoOwnKeys,
          wsClients,
          wsOpen,
          activeSockets,
          activeTimeouts,
          rssBytes: mem.rss,
          heapUsedBytes: mem.heapUsed,
          // heapTotal is the COMMITTED V8 arena. Without it, a run can only say
          // "RSS grew" and not whether live objects grew with it — the whole
          // difference between a leak and an allocator holding onto its arena.
          heapTotalBytes: mem.heapTotal,
          heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
          externalBytes: mem.external,
          arrayBuffersBytes: mem.arrayBuffers,
          cpuUser: process.cpuUsage().user,
          cpuSystem: process.cpuUsage().system,
          uptimeSec: process.uptime(),
          at: Date.now(),
        })
      );
    })
    .listen(statsPort, () => {
      console.log(`[t8-stats] stats endpoint on port ${statsPort}`);
    });
}
