// classRoom.js
// FRENCH RUSH CLASS ROOM: a teacher hosts a code, students join from /french-rush, everyone plays the
// SAME words in lockstep and the HOST advances (word → review → next word).
//
// Deliberately SEPARATE from roomManager.js: its own Map, its own codes (6 chars — the arcade's are 5,
// so the two can never collide), its own lifecycle. None of the arcade room rules fit a class:
//   - arcade rooms cap at 8 players; a class holds up to MAX_STUDENTS
//   - an arcade host who drops is replaced by another player; a class PAUSES for its teacher instead
//   - an arcade socket close removes the player at once; a class keeps the seat for a grace window and
//     a reconnecting client re-binds it with its token (class_rejoin)
// server.js routes every `class_*` message here and calls onClose() on every socket close. Nothing
// else in the server knows this exists.
//
// State is a full SNAPSHOT per recipient (class_state): clients render off the latest snapshot, so a
// reconnect is just "send the snapshot again" — there is no incremental state to drift.
//
// Protocol (client → server):
//   class_create {name, set, rows}      host: the host's client builds the word rows and sends them all
//   class_join   {code, name, token}    student (token = per-tab random id the client keeps)
//   class_rejoin {code, token}          host or student, sent on every socket (re)open while in a class
//   class_start | class_reveal | class_next | class_end   host only
//   class_restart {set, rows}           host only: a NEW SET in the same class (replay the missed words,
//                                       or a fresh set) — students keep their seats, back to the lobby
//   class_kick   {studentId}            host only
//   class_result {index, outcome, hints} student, once per word ('clean' | 'hinted' | 'miss')
//   class_leave                         student leaves for good
// Server → client: class_created {code, hostToken}, class_joined {studentId}, class_state {…},
//   class_tally {…} (host only, debounced; a host's done snapshot adds summary + per-student totals), class_closed {reason}, class_error {code, message}.

const crypto = require('crypto');
const { sanitizeName } = require('./security');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // same alphabet as the arcade (no 0/O/1/I)
const CODE_LENGTH = 6;
const MAX_CLASSES = 200; // global backstop (DoS guard)
const MAX_STUDENTS = 40;
const MAX_ROWS = 30;
const MAX_ROW_BYTES = 1500; // the largest French Rush row is ~400 bytes of JSON
const MAX_SET_FIELD = 40;
const STUDENT_GRACE_MS = 2 * 60 * 1000; // an away student keeps their seat this long
const HOST_GRACE_MS = 5 * 60 * 1000; // the class waits this long for its teacher
const CLASS_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const CLASS_IDLE_MS = 30 * 60 * 1000; // a teacher may talk through one word for a while
const TALLY_DEBOUNCE_MS = 250;
const SWEEP_MS = 15 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
const OUTCOMES = new Set(['clean', 'hinted', 'miss']);
const VOICES = new Set(['projector', 'phones', 'off']); // where the word is read aloud

const ERRORS = {
  class_not_found: 'No class found with that code.',
  class_full: 'That class is full.',
  class_over: 'That class has finished.',
  class_kicked: 'The teacher removed you from this class.',
  class_rejoin_failed: 'Could not get back into that class — join again with the code.',
  not_host: 'Only the teacher can do that.',
  not_in_class: 'You are not in a class.',
  bad_rows: 'That word set could not be used.',
  bad_token: 'Bad session token.',
  bad_phase: 'Not right now.',
  server_busy: 'The server is at capacity right now. Please try again shortly.',
  rate_limited: 'Too many tries. Wait a moment and try again.',
};

/**
 * One hub = one set of classes. server.js uses the default hub below; tests build their own with a
 * fake `send` and clock.
 *   send(ws, type, payload)   deliver one frame (must swallow a dead socket itself)
 *   now()                     the clock
 *   log(event, fields)        structured info log
 */
function createClassHub({ send, now = Date.now, log = () => {} } = {}) {
  const classes = new Map(); // code -> class
  const conns = new Map(); // ws.id -> { code, role: 'host' | 'student', studentId? }

  // ---- helpers -----------------------------------------------------------------------------------
  function newCode() {
    for (let i = 0; i < 100; i += 1) {
      let code = '';
      for (let j = 0; j < CODE_LENGTH; j += 1) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!classes.has(code)) return code;
    }
    return null;
  }

  function err(ws, code, context) {
    send(ws, 'class_error', { code, message: ERRORS[code] || 'Something went wrong.', context });
  }

  function cleanSet(set, rows) {
    const s = set && typeof set === 'object' ? set : {};
    return {
      theme: cleanSetField(s.theme),
      level: cleanSetField(s.level),
      n: rows.length,
      mode: cleanSetField(s.mode),
      voice: VOICES.has(s.voice) ? s.voice : 'projector',
      replay: s.replay === true,
    };
  }

  function cleanSetField(v) {
    return typeof v === 'string' ? v.slice(0, MAX_SET_FIELD) : v == null ? null : String(v).slice(0, MAX_SET_FIELD);
  }

  // The rows are relayed verbatim to every student, so bound them hard: a plain object with a string
  // `word`, small once serialized. The client renders them as text (React escapes it).
  function cleanRows(rows) {
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS) return null;
    const out = [];
    for (const r of rows) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
      if (typeof r.word !== 'string' || !r.word.trim() || r.word.length > 40) return null;
      let json;
      try {
        json = JSON.stringify(r);
      } catch {
        return null;
      }
      if (json.length > MAX_ROW_BYTES) return null;
      out.push(JSON.parse(json)); // a detached, plain-JSON copy
    }
    return out;
  }

  function touch(c) {
    c.lastActivity = now();
  }

  function liveStudents(c) {
    return [...c.students.values()];
  }

  // Tally of word `i`: every seated student counts; no answer yet = still working.
  function tallyOf(c, i) {
    const res = c.results[i] || new Map();
    const t = { index: i, answered: 0, clean: 0, hinted: 0, miss: 0, total: c.students.size, away: 0, who: { clean: [], hinted: [], miss: [], waiting: [] } };
    for (const s of c.students.values()) {
      if (!s.ws) t.away += 1;
      const r = res.get(s.id);
      if (r) {
        t.answered += 1;
        t[r.outcome] += 1;
        t.who[r.outcome].push(s.name);
      } else {
        t.who.waiting.push(s.name);
      }
    }
    return t;
  }

  function summaryOf(c) {
    return c.rows.map((row, i) => {
      const res = c.results[i] || new Map();
      const s = { index: i, word: row.word, clean: 0, hinted: 0, miss: 0 };
      for (const r of res.values()) s[r.outcome] += 1;
      return s;
    });
  }

  // Per-student totals for the teacher's class report (host-only, done phase): every seated student,
  // in join order. A word with no result (joined late) counts as nothing, not as a miss.
  function studentsOf(c) {
    return liveStudents(c).map((s) => {
      const t = { id: s.id, name: s.name, clean: 0, hinted: 0, miss: 0, hints: 0 };
      for (let i = 0; i < c.rows.length; i += 1) {
        const r = c.results[i] && c.results[i].get(s.id);
        if (!r) continue;
        t[r.outcome] += 1;
        t.hints += r.hints || 0;
      }
      return t;
    });
  }

  function stateFor(c, role, student, withRows) {
    const base = {
      code: c.code,
      round: c.round, // bumps on every class_restart: a client's run belongs to one round
      role,
      phase: c.phase,
      index: c.index,
      total: c.rows.length,
      set: c.set,
      hostName: c.host.name,
      hostAway: !c.host.ws,
      studentCount: c.students.size,
    };
    if (withRows) base.rows = c.rows;
    if (role === 'host') {
      base.roster = liveStudents(c).map((s) => ({ id: s.id, name: s.name, away: !s.ws }));
      if (c.phase === 'word' || c.phase === 'review') base.tally = tallyOf(c, c.index);
      if (c.phase === 'done') {
        base.summary = summaryOf(c);
        base.students = studentsOf(c);
      }
    } else {
      base.you = student.id;
      base.name = student.name;
      base.mine = c.rows.map((_, i) => {
        const r = c.results[i] && c.results[i].get(student.id);
        return r ? r.outcome : null;
      });
    }
    return base;
  }

  function sendState(c, ws, role, student, withRows = false) {
    if (ws) send(ws, 'class_state', stateFor(c, role, student, withRows));
  }

  function broadcastState(c) {
    sendState(c, c.host.ws, 'host', null);
    for (const s of c.students.values()) sendState(c, s.ws, 'student', s);
  }

  function sendHostState(c) {
    sendState(c, c.host.ws, 'host', null);
  }

  function scheduleTally(c) {
    if (c.tallyTimer) return;
    c.tallyTimer = setTimeout(() => {
      c.tallyTimer = null;
      if (!classes.has(c.code) || !c.host.ws) return;
      if (c.phase !== 'word' && c.phase !== 'review') return;
      send(c.host.ws, 'class_tally', tallyOf(c, c.index));
    }, TALLY_DEBOUNCE_MS);
    if (typeof c.tallyTimer.unref === 'function') c.tallyTimer.unref();
  }

  function closeClass(c, reason) {
    if (!classes.has(c.code)) return;
    classes.delete(c.code);
    if (c.tallyTimer) clearTimeout(c.tallyTimer);
    c.tallyTimer = null;
    const sockets = [c.host.ws, ...liveStudents(c).map((s) => s.ws)];
    for (const ws of sockets) {
      if (!ws) continue;
      conns.delete(ws.id);
      send(ws, 'class_closed', { reason });
    }
    log('class_closed', { classCode: c.code, reason, students: c.students.size });
  }

  // Detach this socket from whatever class it is bound to (a socket is in at most one).
  function detach(ws, { leave = false } = {}) {
    const conn = conns.get(ws.id);
    if (!conn) return;
    conns.delete(ws.id);
    const c = classes.get(conn.code);
    if (!c) return;
    if (conn.role === 'host') {
      if (c.host.ws !== ws) return;
      if (leave) {
        closeClass(c, 'ended');
        return;
      }
      c.host.ws = null;
      c.host.awaySince = now();
      broadcastState(c); // students see TEACHER RECONNECTING
      return;
    }
    const s = c.students.get(conn.studentId);
    if (!s || s.ws !== ws) return;
    if (leave) {
      c.students.delete(s.id);
    } else {
      s.ws = null;
      s.awaySince = now();
    }
    sendHostState(c);
  }

  // Another tab took this seat over: unbind the old socket and tell it why it went quiet.
  function supersede(oldWs) {
    conns.delete(oldWs.id);
    send(oldWs, 'class_closed', { reason: 'superseded' });
  }

  function bind(ws, conn) {
    detach(ws); // never in two classes at once
    conns.set(ws.id, conn);
  }

  function hostClass(ws) {
    const conn = conns.get(ws.id);
    if (!conn) return { error: 'not_in_class' };
    const c = classes.get(conn.code);
    if (!c) return { error: 'not_in_class' };
    if (conn.role !== 'host' || c.host.ws !== ws) return { error: 'not_host' };
    return { c };
  }

  function reveal(c) {
    // Everyone still working when the word closes is logged as a miss.
    const res = c.results[c.index];
    for (const s of c.students.values()) {
      if (!res.has(s.id)) res.set(s.id, { outcome: 'miss', hints: 0, auto: true });
    }
    c.phase = 'review';
    broadcastState(c);
  }

  function startWord(c, i) {
    c.index = i;
    c.phase = 'word';
    c.results[i] = c.results[i] || new Map();
    broadcastState(c);
  }

  // ---- message handlers --------------------------------------------------------------------------
  const handlers = {
    class_create(ws, p, gates) {
      if (gates.allowCreate && !gates.allowCreate()) return err(ws, 'rate_limited', 'class_create');
      if (classes.size >= MAX_CLASSES) return err(ws, 'server_busy', 'class_create');
      const rows = cleanRows(p.rows);
      if (!rows) return err(ws, 'bad_rows', 'class_create');
      const code = newCode();
      if (!code) return err(ws, 'server_busy', 'class_create');
      detach(ws, { leave: true }); // a teacher who opens a new class ends the one they were running
      const set = p.set && typeof p.set === 'object' ? p.set : {};
      const c = {
        code,
        createdAt: now(),
        lastActivity: now(),
        host: { token: crypto.randomBytes(18).toString('base64url'), ws, awaySince: null, name: sanitizeName(p.name, 'Teacher') },
        set: cleanSet(set, rows),
        round: 1,
        rows,
        phase: 'lobby',
        index: 0,
        results: [],
        students: new Map(),
        kicked: new Set(),
        tallyTimer: null,
      };
      bind(ws, { code, role: 'host' });
      classes.set(code, c);
      log('class_created', { classCode: code, words: rows.length });
      send(ws, 'class_created', { code, hostToken: c.host.token });
      sendState(c, ws, 'host', null, true);
    },

    class_join(ws, p, gates) {
      if (gates.allowJoin && !gates.allowJoin()) return err(ws, 'rate_limited', 'class_join');
      const code = String(p.code || '').toUpperCase().trim();
      const token = p.token;
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return err(ws, 'bad_token', 'class_join');
      const c = classes.get(code);
      if (!c) return err(ws, 'class_not_found', 'class_join');
      if (c.kicked.has(token)) return err(ws, 'class_kicked', 'class_join');
      const existing = liveStudents(c).find((s) => s.token === token);
      if (existing) return rebindStudent(ws, c, existing);
      if (c.phase === 'done') return err(ws, 'class_over', 'class_join');
      if (c.students.size >= MAX_STUDENTS) return err(ws, 'class_full', 'class_join');
      const s = { id: crypto.randomBytes(6).toString('hex'), token, name: sanitizeName(p.name, 'Student'), ws, awaySince: null };
      bind(ws, { code, role: 'student', studentId: s.id });
      c.students.set(s.id, s);
      touch(c);
      send(ws, 'class_joined', { studentId: s.id });
      sendState(c, ws, 'student', s, true);
      sendHostState(c);
    },

    class_rejoin(ws, p, gates) {
      if (gates.allowJoin && !gates.allowJoin()) return err(ws, 'rate_limited', 'class_rejoin');
      const code = String(p.code || '').toUpperCase().trim();
      const token = p.token;
      const c = classes.get(code);
      if (!c || typeof token !== 'string') return err(ws, 'class_rejoin_failed', 'class_rejoin');
      if (token === c.host.token) {
        if (c.host.ws && c.host.ws !== ws) supersede(c.host.ws); // an older tab loses the console
        bind(ws, { code, role: 'host' });
        c.host.ws = ws;
        c.host.awaySince = null;
        touch(c);
        send(ws, 'class_created', { code, hostToken: c.host.token });
        sendState(c, ws, 'host', null, true);
        for (const s of c.students.values()) sendState(c, s.ws, 'student', s); // unpause
        return;
      }
      if (c.kicked.has(token)) return err(ws, 'class_kicked', 'class_rejoin');
      const s = liveStudents(c).find((x) => x.token === token);
      if (!s) return err(ws, 'class_rejoin_failed', 'class_rejoin');
      rebindStudent(ws, c, s);
    },

    class_start(ws) {
      const { c, error } = hostClass(ws);
      if (error) return err(ws, error, 'class_start');
      if (c.phase !== 'lobby') return err(ws, 'bad_phase', 'class_start');
      touch(c);
      startWord(c, 0);
    },

    class_reveal(ws) {
      const { c, error } = hostClass(ws);
      if (error) return err(ws, error, 'class_reveal');
      if (c.phase !== 'word') return err(ws, 'bad_phase', 'class_reveal');
      touch(c);
      reveal(c);
    },

    class_next(ws) {
      const { c, error } = hostClass(ws);
      if (error) return err(ws, error, 'class_next');
      if (c.phase === 'word') reveal(c); // NEXT straight from a word closes it first
      if (c.phase !== 'review') return err(ws, 'bad_phase', 'class_next');
      touch(c);
      if (c.index + 1 >= c.rows.length) {
        c.phase = 'done';
        broadcastState(c);
        return;
      }
      startWord(c, c.index + 1);
    },

    class_restart(ws, p) {
      const { c, error } = hostClass(ws);
      if (error) return err(ws, error, 'class_restart');
      const rows = cleanRows(p.rows);
      if (!rows) return err(ws, 'bad_rows', 'class_restart');
      c.rows = rows;
      c.set = cleanSet(p.set, rows);
      c.round += 1;
      c.phase = 'lobby';
      c.index = 0;
      c.results = [];
      touch(c);
      log('class_restarted', { classCode: c.code, round: c.round, words: rows.length });
      // the rows go to everyone again (a new set); seats, names and tokens are kept
      sendState(c, c.host.ws, 'host', null, true);
      for (const s of c.students.values()) sendState(c, s.ws, 'student', s, true);
    },

    class_end(ws) {
      const { c, error } = hostClass(ws);
      if (error) return err(ws, error, 'class_end');
      touch(c);
      if (c.phase === 'done') {
        closeClass(c, 'ended');
        return;
      }
      if (c.phase === 'word') reveal(c);
      c.phase = 'done';
      broadcastState(c);
    },

    class_kick(ws, p) {
      const { c, error } = hostClass(ws);
      if (error) return err(ws, error, 'class_kick');
      const s = c.students.get(p.studentId);
      if (!s) return;
      c.kicked.add(s.token);
      c.students.delete(s.id);
      for (const res of c.results) if (res) res.delete(s.id);
      if (s.ws) {
        conns.delete(s.ws.id);
        send(s.ws, 'class_closed', { reason: 'kicked' });
      }
      sendHostState(c);
    },

    class_result(ws, p) {
      const conn = conns.get(ws.id);
      const c = conn && classes.get(conn.code);
      if (!c || conn.role !== 'student') return err(ws, 'not_in_class', 'class_result');
      const s = c.students.get(conn.studentId);
      if (!s || s.ws !== ws) return err(ws, 'not_in_class', 'class_result');
      // Late or stale results (a word already closed, a replayed frame) are dropped silently.
      if (c.phase !== 'word' || p.index !== c.index || !OUTCOMES.has(p.outcome)) return;
      const res = c.results[c.index];
      if (res.has(s.id)) return; // first result wins
      const hints = Number.isInteger(p.hints) && p.hints >= 0 ? Math.min(p.hints, 99) : 0;
      res.set(s.id, { outcome: p.outcome, hints });
      touch(c);
      // Everyone seated AND connected has answered → reveal on their own. An away student does not
      // hold the class up (they are logged as a miss at the reveal).
      const present = liveStudents(c).filter((x) => x.ws);
      if (present.length && present.every((x) => res.has(x.id))) {
        reveal(c);
        return;
      }
      scheduleTally(c);
    },

    class_leave(ws) {
      detach(ws, { leave: true });
    },
  };

  function rebindStudent(ws, c, s) {
    if (s.ws && s.ws !== ws) supersede(s.ws); // the older tab is superseded
    bind(ws, { code: c.code, role: 'student', studentId: s.id });
    s.ws = ws;
    s.awaySince = null;
    touch(c);
    send(ws, 'class_joined', { studentId: s.id });
    sendState(c, ws, 'student', s, true);
    sendHostState(c);
  }

  /** Route one `class_*` message. `gates` = { allowCreate(), allowJoin() } throttles from server.js. */
  function handle(ws, type, payload, gates = {}) {
    const h = Object.prototype.hasOwnProperty.call(handlers, type) ? handlers[type] : null;
    if (!h) return err(ws, 'bad_phase', type);
    h(ws, payload && typeof payload === 'object' ? payload : {}, gates);
  }

  /** A socket closed: its seat goes "away" (kept for the grace window), never removed at once. */
  function onClose(ws) {
    detach(ws);
  }

  /** Drop expired seats and classes. Runs on an interval; tests call it with a clock. */
  function sweep(t = now()) {
    for (const c of [...classes.values()]) {
      if (t - c.createdAt >= CLASS_MAX_AGE_MS) {
        closeClass(c, 'expired');
        continue;
      }
      if (!c.host.ws && c.host.awaySince != null && t - c.host.awaySince >= HOST_GRACE_MS) {
        closeClass(c, 'host_gone');
        continue;
      }
      if (t - c.lastActivity >= CLASS_IDLE_MS) {
        closeClass(c, 'idle');
        continue;
      }
      let dropped = false;
      for (const s of liveStudents(c)) {
        if (!s.ws && s.awaySince != null && t - s.awaySince >= STUDENT_GRACE_MS) {
          c.students.delete(s.id); // their results stay in the tally
          dropped = true;
        }
      }
      if (dropped) sendHostState(c);
    }
  }

  let sweepTimer = null;
  function startSweeper() {
    if (sweepTimer) return sweepTimer;
    sweepTimer = setInterval(() => {
      try {
        sweep();
      } catch (e) {
        log('class_sweep_failed', { message: e && e.message });
      }
    }, SWEEP_MS);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
    return sweepTimer;
  }
  function stopSweeper() {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
  }

  function _reset() {
    for (const c of classes.values()) if (c.tallyTimer) clearTimeout(c.tallyTimer);
    classes.clear();
    conns.clear();
  }

  return {
    handle,
    onClose,
    sweep,
    startSweeper,
    stopSweeper,
    stats: () => ({ classes: classes.size, students: [...classes.values()].reduce((n, c) => n + c.students.size, 0) }),
    _getClass: (code) => classes.get(code),
    _reset,
  };
}

module.exports = {
  createClassHub,
  ERRORS,
  MAX_STUDENTS,
  MAX_ROWS,
  STUDENT_GRACE_MS,
  HOST_GRACE_MS,
  CLASS_IDLE_MS,
  CLASS_MAX_AGE_MS,
  TALLY_DEBOUNCE_MS,
};
