// errorHandling.test.js
// Run with: node --test errorHandling.test.js
// Failure-path coverage for the T10 hardening: errors injected into timer
// bodies, broadcasts, and live sockets must never crash the process — the
// affected room either recovers or closes cleanly (room_closed + teardown),
// and everything else keeps running. Unit tests drive roomManager directly
// with fake connections; the integration tests at the bottom spawn the REAL
// server as a child process and abuse it over HTTP + WebSocket.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const WebSocket = require('ws');

const {
  createRoom,
  joinRoom,
  startGame,
  getRoom,
  broadcastToRoom,
  startTurnTimer,
  failRoom,
  guardRoom,
  getRoomStats,
  addBot,
  reapIdleRooms,
  _resetRoomsForTesting,
} = require('./roomManager');

// Fake ws connection that RECORDS what it receives (parsed), so tests can
// assert on room_closed etc. Matches the conn() shape used across the suite.
let nextId = 0;
function recordingConn() {
  const c = {
    id: `e${nextId++}`,
    readyState: 1,
    received: [],
    send(raw) {
      c.received.push(JSON.parse(raw));
    },
  };
  return c;
}

// A connection whose send always throws — simulates the readyState-flipped-
// mid-send teardown race.
function explodingConn() {
  return {
    id: `x${nextId++}`,
    readyState: 1,
    send() {
      throw new Error('socket torn down mid-send');
    },
  };
}

function lastOfType(conn, type) {
  return [...conn.received].reverse().find((m) => m.type === type);
}

test.beforeEach(() => _resetRoomsForTesting());
test.after(() => _resetRoomsForTesting());

// ---- guardRoom / failRoom containment -------------------------------------

test('guardRoom: a throw closes ONLY that room, players get room_closed(server_error)', () => {
  const host = recordingConn();
  const guest = recordingConn();
  const { room } = createRoom(host, 'Host');
  joinRoom(room.code, guest, 'Guest');
  const other = createRoom(recordingConn(), 'Bystander').room;

  guardRoom(room, 'test_injected_error', () => {
    throw new Error('injected');
  });

  // The broken room is gone; the unrelated room is untouched; process alive.
  assert.equal(getRoom(room.code), undefined);
  assert.ok(getRoom(other.code), 'unrelated room must survive');
  for (const c of [host, guest]) {
    const closed = lastOfType(c, 'room_closed');
    assert.ok(closed, 'every player must be told the room closed');
    assert.equal(closed.payload.reason, 'server_error');
    assert.equal(closed.payload.code, room.code);
  }
});

test('guardRoom: no throw means no side effects', () => {
  const host = recordingConn();
  const { room } = createRoom(host, 'Host');
  guardRoom(room, 'test_event', () => {});
  assert.ok(getRoom(room.code), 'room must survive a clean run');
  assert.equal(lastOfType(host, 'room_closed'), undefined);
});

test('failRoom clears every live timer slot on the way down', () => {
  const host = recordingConn();
  const { room } = createRoom(host, 'Host');
  joinRoom(room.code, recordingConn(), 'Guest');
  startGame(room); // arms countdownTimeout (and later the turn timer)
  assert.ok(room.countdownTimeout, 'precondition: a timer is pending');

  failRoom(room, 'test_teardown', new Error('injected'));

  assert.equal(room.countdownTimeout, null);
  assert.equal(room.turnTimerInterval, null);
  assert.equal(room.roundTimerInterval, null);
  assert.equal(room.roundPauseTimeout, null);
  assert.equal(getRoom(room.code), undefined);
});

// ---- broadcast resilience --------------------------------------------------

test('broadcastToRoom: one throwing socket does not abort the rest of the broadcast', () => {
  const good = recordingConn();
  const { room } = createRoom(explodingConn(), 'Bomb');
  joinRoom(room.code, good, 'Good');

  // Must not throw, and the healthy player must still get the frame.
  broadcastToRoom(room, { type: 'timer_tick', payload: { secondsRemaining: 5 } });
  assert.ok(lastOfType(good, 'timer_tick'));
});

// ---- timer-body failure (real interval) ------------------------------------

test('turn timer: corrupted game state fails the room cleanly, not the process', async () => {
  const host = recordingConn();
  const guest = recordingConn();
  const { room } = createRoom(host, 'Host');
  joinRoom(room.code, guest, 'Guest');
  startGame(room);

  // Sabotage: handleTimeout iterates game.players, so the expiry tick throws.
  room.game.currentTimerSeconds = 1;
  room.game.players = null;
  startTurnTimer(room);

  // One real 1s tick hits remaining<=0 -> handleTimeout throws -> guardRoom.
  await new Promise((r) => setTimeout(r, 1300));

  assert.equal(getRoom(room.code), undefined, 'room must be torn down');
  assert.equal(room.turnTimerInterval, null, 'interval must not keep firing');
  const closed = lastOfType(guest, 'room_closed');
  assert.ok(closed, 'players must be told, not left on a frozen screen');
  assert.equal(closed.payload.reason, 'server_error');
});

// ---- idle reap notice --------------------------------------------------------

test('reapIdleRooms tells still-connected players why (reason idle)', () => {
  const host = recordingConn();
  const { room } = createRoom(host, 'Host');
  room.lastActivity = Date.now() - 21 * 60 * 1000; // idle past the 20min TTL
  const reaped = reapIdleRooms();
  assert.ok(reaped.includes(room.code));
  const closed = lastOfType(host, 'room_closed');
  assert.ok(closed);
  assert.equal(closed.payload.reason, 'idle');
});

// ---- getRoomStats (feeds /admin/status) -------------------------------------

test('getRoomStats counts rooms, humans, bots, and live games per mode', () => {
  const a = createRoom(recordingConn(), 'A', true).room; // public word-bomb lobby
  addBot(a, 'medium');
  const b = createRoom(recordingConn(), 'B').room;
  joinRoom(b.code, recordingConn(), 'B2');
  startGame(b); // in-progress word-bomb

  const stats = getRoomStats();
  assert.equal(stats.rooms, 2);
  assert.equal(stats.publicRooms, 1);
  assert.equal(stats.gamesInProgress, 1);
  assert.equal(stats.players, 3); // A host + B host + B2 (bot excluded)
  assert.equal(stats.bots, 1);
  assert.equal(stats.roomsByGameType['word-bomb'], 2);
});

/* ==========================================================================
   Integration: the REAL server as a child process. Asserts the process
   survives malformed input and abrupt socket death, and that /admin/status
   is properly gated. FAKE_DICTIONARY keeps everything offline.
   ========================================================================== */

function startServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: {
        ...process.env,
        PORT: '0', // ephemeral port; the boot line reports the real one
        FAKE_DICTIONARY: '1',
        ANTHROPIC_API_KEY: '',
        SENTRY_DSN: '',
        POSTHOG_KEY: '',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (chunk) => {
      out += chunk.toString();
      const m = out.match(/listening on port (\d+)/);
      if (m) {
        proc.stdout.off('data', onData);
        resolve({ proc, port: Number(m[1]) });
      }
    };
    proc.stdout.on('data', onData);
    proc.on('error', reject);
    proc.on('exit', (code) => reject(new Error(`server exited early (code ${code}): ${out}`)));
    setTimeout(() => reject(new Error(`server never reported its port: ${out}`)), 10000).unref();
  });
}

function stopServer(proc) {
  return new Promise((resolve) => {
    proc.removeAllListeners('exit'); // the early-exit rejecter above
    proc.on('exit', resolve);
    proc.kill();
    setTimeout(resolve, 2000).unref(); // belt and braces on Windows
  });
}

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

// Opens a ws client and resolves once the server's 'connected' hello arrives.
function wsClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      messages.push(msg);
      waiters.forEach((w) => w());
    });
    ws.on('error', reject);
    const waitFor = (type, timeoutMs = 5000) =>
      new Promise((res, rej) => {
        const scan = () => {
          const found = messages.find((m) => m.type === type);
          if (found) res(found);
        };
        waiters.push(scan);
        scan();
        setTimeout(() => rej(new Error(`timed out waiting for '${type}'`)), timeoutMs).unref();
      });
    ws.on('open', () => resolve({ ws, messages, waitFor }));
  });
}

test('integration: /admin/status is 404 when ADMIN_TOKEN is unset', async () => {
  const { proc, port } = await startServer({ ADMIN_TOKEN: '' });
  try {
    const res = await get(port, '/admin/status?token=anything');
    assert.equal(res.status, 404);
  } finally {
    await stopServer(proc);
  }
});

test('integration: /admin/status auth + payload, and the process survives socket abuse', async () => {
  const { proc, port } = await startServer({ ADMIN_TOKEN: 't10-test-token' });
  try {
    // -- auth gate
    assert.equal((await get(port, '/admin/status')).status, 403);
    assert.equal((await get(port, '/admin/status?token=wrong')).status, 403);
    const ok = await get(port, '/admin/status', { authorization: 'Bearer t10-test-token' });
    assert.equal(ok.status, 200);
    const before = JSON.parse(ok.body);
    assert.equal(before.status, 'ok');
    assert.equal(typeof before.uptimeSeconds, 'number');
    assert.equal(typeof before.memory.rssMb, 'number');
    assert.equal(before.rooms, 0);

    // -- malformed + unknown messages get graceful error replies
    const { ws, waitFor } = await wsClient(port);
    await waitFor('connected');
    ws.send('this is not json {{{');
    const malformed = await waitFor('error');
    assert.match(malformed.payload.message, /Malformed message/);
    ws.send(JSON.stringify({ type: 'no_such_thing', payload: {} }));

    // -- a real room, then the socket dies ABRUPTLY (no close frame)
    ws.send(JSON.stringify({ type: 'create_room', payload: { name: 'T10' } }));
    await waitFor('room_created');
    const during = JSON.parse(
      (await get(port, '/admin/status?token=t10-test-token')).body
    );
    assert.equal(during.rooms, 1);
    assert.equal(during.connections, 1);
    ws._socket.destroy(); // RST-style death mid-room, no clean close

    // The server must survive AND clean the dead player's room up.
    await new Promise((r) => setTimeout(r, 500));
    const after = JSON.parse(
      (await get(port, '/admin/status?token=t10-test-token')).body
    );
    assert.equal(after.status, 'ok', 'server must still be answering');
    assert.equal(after.rooms, 0, 'the dead connection\'s room must be reaped');
    assert.equal(after.connections, 0);

    // Health check still fine after all the abuse.
    assert.equal((await get(port, '/health')).status, 200);
  } finally {
    await stopServer(proc);
  }
});
