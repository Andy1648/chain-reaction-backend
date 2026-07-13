// t3-harness/server-wrapper.js
// Boots the REAL backend (../server.js, unmodified behavior) and, if
// T3_STATS_PORT is set, serves a JSON stats endpoint on that side port for the
// harness's leak/health checks. Kept out of server.js so production code stays
// untouched; roomManager is the same module instance the server uses, so
// _getStatsForTesting sees the live registry.

const http = require('http');
const roomManager = require('../roomManager');

require('../server.js'); // starts express + wss on process.env.PORT

const statsPort = Number(process.env.T3_STATS_PORT || 0);
if (statsPort) {
  http
    .createServer((req, res) => {
      const mem = process.memoryUsage();
      let activeTimeouts = null;
      try {
        // Undocumented but stable enough for a test harness: counts live libuv
        // handles. Timeout count is the canonical "did a timer leak" signal.
        const handles = process._getActiveHandles();
        activeTimeouts = handles.filter((h) => h && h.constructor && h.constructor.name === 'Timeout').length;
      } catch { /* fine - report null */ }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          ...roomManager._getStatsForTesting(),
          rssBytes: mem.rss,
          heapUsedBytes: mem.heapUsed,
          activeTimeouts,
          cpuUser: process.cpuUsage().user,
          cpuSystem: process.cpuUsage().system,
          uptimeSec: process.uptime(),
        })
      );
    })
    .listen(statsPort, () => {
      console.log(`[t3-stats] stats endpoint on port ${statsPort}`);
    });
}
