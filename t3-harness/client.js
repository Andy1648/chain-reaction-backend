// t3-harness/client.js
// FakeClient: a scriptable WebSocket game client for the Chain Reaction
// backend. Wraps `ws` with a typed inbox so scenarios read as straight-line
// async code:
//
//   const c = new FakeClient(url, { name: 'Alice' });
//   await c.connect();                     // resolves once the server assigns an id
//   const code = await c.createRoom();     // create_room -> room_created
//   await c.waitFor('room_update');        // consume the roster broadcast
//
// Every inbound message is appended to `c.log` (never pruned) AND to an
// unconsumed inbox that `waitFor()` drains. waitFor scans the inbox first, so
// a message that arrived *before* you awaited it is still found — no races
// between "server already sent it" and "I'm about to wait for it".
//
// Optional `latencyMs` simulates a slow link: outbound sends and inbound
// dispatch are each delayed by latencyMs (so RTT ~= 2 * latencyMs).

const WebSocket = require('ws');

let nextClientSeq = 1;

class FakeClient {
  constructor(url, opts = {}) {
    this.url = url;
    this.name = opts.name || `Fake${nextClientSeq++}`;
    this.latencyMs = opts.latencyMs || 0;
    this.id = null; // server-assigned connection/player id
    this.ws = null;
    this.log = []; // every message ever received: { type, payload, at }
    this.inbox = []; // received but not yet consumed by waitFor
    this.waiters = []; // pending waitFor calls: { match, resolve, timer }
    this.closed = false;
  }

  /** Opens the socket and resolves once the server sends `connected` (with our id). */
  connect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const to = setTimeout(() => reject(new Error(`${this.name}: connect timeout`)), timeoutMs);
      ws.on('error', (err) => {
        clearTimeout(to);
        reject(err);
      });
      ws.on('message', (raw) => {
        const deliver = () => this._dispatch(JSON.parse(raw.toString()));
        if (this.latencyMs > 0) setTimeout(deliver, this.latencyMs);
        else deliver();
      });
      ws.on('close', () => {
        this.closed = true;
        // Fail any still-pending waiters fast instead of letting them time out.
        this.waiters.splice(0).forEach((w) => {
          clearTimeout(w.timer);
          w.reject(new Error(`${this.name}: socket closed while waiting for ${w.desc}`));
        });
      });
      ws.on('open', () => {
        // The `connected` message may race the open event; waitFor handles both orders.
        this.waitFor('connected', { timeoutMs })
          .then((msg) => {
            clearTimeout(to);
            this.id = msg.payload.id;
            resolve(this);
          })
          .catch(reject);
      });
    });
  }

  _dispatch(msg) {
    msg.at = Date.now();
    this.log.push(msg);
    // Offer to the oldest matching waiter first; otherwise park in the inbox.
    const idx = this.waiters.findIndex((w) => w.match(msg));
    if (idx !== -1) {
      const [w] = this.waiters.splice(idx, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      this.inbox.push(msg);
    }
  }

  /** Raw send of { type, payload }. Applies simulated latency if configured. */
  send(type, payload = {}) {
    const doSend = () => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type, payload }));
      }
    };
    if (this.latencyMs > 0) setTimeout(doSend, this.latencyMs);
    else doSend();
  }

  /**
   * Resolves with the next unconsumed message of `type` (optionally also
   * matching `opts.where(msg)`). Scans the inbox first, then waits.
   * Rejects after opts.timeoutMs (default 5000).
   */
  waitFor(type, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 5000;
    const where = opts.where || (() => true);
    const match = opts._matchOverride || ((m) => m.type === type && where(m));

    const idx = this.inbox.findIndex(match);
    if (idx !== -1) {
      const [msg] = this.inbox.splice(idx, 1);
      return Promise.resolve(msg);
    }
    return new Promise((resolve, reject) => {
      const desc = type;
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i !== -1) this.waiters.splice(i, 1);
        const seen = this.log.slice(-8).map((m) => m.type).join(', ');
        reject(new Error(`${this.name}: timed out waiting for '${type}' after ${timeoutMs}ms (last seen: ${seen})`));
      }, timeoutMs);
      this.waiters.push({ match, resolve, reject, timer, desc });
    });
  }

  /**
   * Like waitFor but matches ANY of several types with ONE registered waiter.
   * Use this instead of Promise.race([waitFor(a), waitFor(b)]) — a race leaves
   * the losing waiter registered, and it would silently consume the next
   * matching message out from under later waits.
   */
  waitForAny(types, opts = {}) {
    const set = new Set(types);
    const inner = opts.where || (() => true);
    return this.waitFor(types.join('|'), {
      ...opts,
      where: () => true,
      _matchOverride: (m) => set.has(m.type) && inner(m),
    });
  }

  /**
   * Asserts that NO message matching `type` (+ optional where) arrives within
   * windowMs. Resolves true if quiet; rejects if one shows up. Consumes nothing
   * on success (inbox snapshot is checked non-destructively).
   */
  async expectSilence(type, windowMs = 1500, where = () => true) {
    if (this.inbox.some((m) => m.type === type && where(m))) {
      throw new Error(`${this.name}: expected silence but '${type}' already in inbox`);
    }
    try {
      const msg = await this.waitFor(type, { timeoutMs: windowMs, where });
      throw new Error(`${this.name}: expected NO '${type}' within ${windowMs}ms but got ${JSON.stringify(msg.payload).slice(0, 120)}`);
    } catch (err) {
      if (String(err.message).includes('timed out waiting')) return true;
      throw err;
    }
  }

  /** Drops all unconsumed messages (start a scenario step from a clean slate). */
  drainInbox() {
    this.inbox.length = 0;
  }

  // ---- Convenience flows (each returns useful payload data) ----

  /** create_room -> room_created; returns the room code. */
  async createRoom(opts = {}) {
    this.send('create_room', { name: this.name, isPublic: opts.isPublic === true });
    const msg = await this.waitFor('room_created', opts);
    return msg.payload.code;
  }

  /** join_room -> room_joined (or error). Returns 'ok' | error message. */
  async joinRoom(code, opts = {}) {
    this.send('join_room', { code, name: this.name });
    const msg = await this.waitForAny(['room_joined', 'error'], {
      timeoutMs: opts.timeoutMs ?? 5000,
      where: (m) => m.type === 'room_joined' || m.payload?.context === 'join_room',
    });
    return msg.type === 'room_joined' ? 'ok' : msg.payload.message;
  }

  close() {
    if (this.ws) this.ws.close();
  }

  /** Hard kill: destroys the TCP socket with no close frame (crash simulation). */
  terminate() {
    if (this.ws) this.ws.terminate();
  }
}

module.exports = { FakeClient };
