// classRoom.test.js — FRENCH RUSH CLASS ROOM hub, driven with fake sockets and a fake clock.
// Run with: node --test classRoom.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createClassHub,
  MAX_STUDENTS,
  MAX_ROWS,
  STUDENT_GRACE_MS,
  HOST_GRACE_MS,
  CLASS_IDLE_MS,
  TALLY_DEBOUNCE_MS,
} = require('./classRoom');

let t = 1_000_000;
const clock = () => t;
let nextId = 0;

function setup() {
  t = 1_000_000;
  const inbox = new Map(); // ws.id -> frames
  const hub = createClassHub({
    send: (ws, type, payload) => inbox.get(ws.id).push({ type, payload }),
    now: clock,
  });
  const sock = () => {
    const ws = { id: `ws${(nextId += 1)}` };
    inbox.set(ws.id, []);
    return ws;
  };
  const frames = (ws) => inbox.get(ws.id);
  const last = (ws, type) => [...frames(ws)].reverse().find((f) => f.type === type);
  const clear = (ws) => inbox.set(ws.id, []);
  return { hub, sock, frames, last, clear };
}

const ROWS = [
  { word: 'famille', gloss: 'family', gender: 'f' },
  { word: 'ami', gloss: 'friend', gender: 'm' },
  { word: 'chanter', gloss: 'to sing' },
];
const tok = (n) => `token-${String(n).padStart(4, '0')}`;

function hostWithClass(env, rows = ROWS) {
  const host = env.sock();
  env.hub.handle(host, 'class_create', { name: 'Mme Dupont', set: { theme: 'familles', level: 'standard', mode: 'briefing' }, rows });
  const created = env.last(host, 'class_created');
  assert.ok(created, 'class_created sent');
  return { host, code: created.payload.code, hostToken: created.payload.hostToken };
}

function join(env, code, n, name = `S${n}`) {
  const ws = env.sock();
  env.hub.handle(ws, 'class_join', { code, name, token: tok(n) });
  return ws;
}

test('create: 6-char code, host snapshot carries the rows, lobby phase', () => {
  const env = setup();
  const { host, code } = hostWithClass(env);
  assert.match(code, /^[A-Z2-9]{6}$/);
  const st = env.last(host, 'class_state').payload;
  assert.equal(st.role, 'host');
  assert.equal(st.phase, 'lobby');
  assert.equal(st.total, 3);
  assert.deepEqual(st.rows.map((r) => r.word), ['famille', 'ami', 'chanter']);
  assert.equal(st.set.theme, 'familles');
  assert.deepEqual(st.roster, []);
});

test('create rejects bad rows (none, too many, no word, oversized)', () => {
  const env = setup();
  const bad = [[], Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ word: `w${i}` })), [{ gloss: 'x' }], [{ word: 'x', blob: 'y'.repeat(5000) }], 'nope'];
  for (const rows of bad) {
    const ws = env.sock();
    env.hub.handle(ws, 'class_create', { rows });
    assert.equal(env.last(ws, 'class_error').payload.code, 'bad_rows');
    assert.equal(env.last(ws, 'class_created'), undefined);
  }
});

test('create honours the create throttle', () => {
  const env = setup();
  const ws = env.sock();
  env.hub.handle(ws, 'class_create', { rows: ROWS }, { allowCreate: () => false });
  assert.equal(env.last(ws, 'class_error').payload.code, 'rate_limited');
});

test('join: student gets rows + id, host roster updates, students never see names of others', () => {
  const env = setup();
  const { host, code } = hostWithClass(env);
  const a = join(env, code, 1, 'Ana');
  join(env, code, 2, 'Ben');
  const st = env.last(a, 'class_state').payload;
  assert.equal(st.role, 'student');
  assert.equal(st.rows.length, 3);
  assert.equal(st.name, 'Ana');
  assert.equal(st.roster, undefined);
  assert.equal(st.studentCount, 1);
  assert.ok(env.last(a, 'class_joined').payload.studentId);
  const hs = env.last(host, 'class_state').payload;
  assert.deepEqual(hs.roster.map((s) => s.name), ['Ana', 'Ben']);
  assert.equal(hs.rows, undefined, 'phase updates do not resend the rows');
});

test('join errors: unknown code, bad token, full class, finished class', () => {
  const env = setup();
  const { host, code } = hostWithClass(env);
  const x = env.sock();
  env.hub.handle(x, 'class_join', { code: 'ZZZZZZ', token: tok(1) });
  assert.equal(env.last(x, 'class_error').payload.code, 'class_not_found');
  env.hub.handle(x, 'class_join', { code, token: 'short' });
  assert.equal(env.last(x, 'class_error').payload.code, 'bad_token');
  for (let i = 0; i < MAX_STUDENTS; i += 1) join(env, code, 100 + i);
  const late = join(env, code, 999);
  assert.equal(env.last(late, 'class_error').payload.code, 'class_full');
  env.hub.handle(host, 'class_end', {});
  const after = join(env, code, 998);
  assert.equal(env.last(after, 'class_error').payload.code, 'class_over');
});

test('host-only actions are refused for students', () => {
  const env = setup();
  const { code } = hostWithClass(env);
  const a = join(env, code, 1);
  for (const type of ['class_start', 'class_reveal', 'class_next', 'class_end', 'class_kick']) {
    env.hub.handle(a, type, {});
    assert.equal(env.last(a, 'class_error').payload.code, 'not_host', type);
  }
});

test('full lockstep run: start → result → reveal → next … → done with a summary', () => {
  const env = setup();
  const { host, code } = hostWithClass(env);
  const a = join(env, code, 1, 'Ana');
  const b = join(env, code, 2, 'Ben');
  env.hub.handle(host, 'class_start', {});
  assert.equal(env.last(a, 'class_state').payload.phase, 'word');
  assert.equal(env.last(a, 'class_state').payload.index, 0);

  // word 0: Ana clean, then the teacher reveals → Ben (no answer) is a miss
  env.hub.handle(a, 'class_result', { index: 0, outcome: 'clean', hints: 0 });
  env.hub.handle(host, 'class_reveal', {});
  let hs = env.last(host, 'class_state').payload;
  assert.equal(hs.phase, 'review');
  assert.equal(hs.tally.clean, 1);
  assert.equal(hs.tally.miss, 1);
  assert.deepEqual(hs.tally.who.miss, ['Ben']);
  assert.deepEqual(env.last(b, 'class_state').payload.mine, ['miss', null, null]);

  // a result for a closed word is ignored
  env.hub.handle(b, 'class_result', { index: 0, outcome: 'clean' });
  assert.equal(env.hub._getClass(code).results[0].get(env.last(b, 'class_joined').payload.studentId).outcome, 'miss');

  // word 1: both answer → reveals on its own
  env.hub.handle(host, 'class_next', {});
  assert.equal(env.last(a, 'class_state').payload.index, 1);
  env.hub.handle(a, 'class_result', { index: 1, outcome: 'hinted', hints: 2 });
  env.hub.handle(a, 'class_result', { index: 1, outcome: 'clean' }); // first one wins
  env.hub.handle(b, 'class_result', { index: 1, outcome: 'clean' });
  hs = env.last(host, 'class_state').payload;
  assert.equal(hs.phase, 'review');
  assert.equal(hs.tally.hinted, 1);
  assert.equal(hs.tally.clean, 1);

  // NEXT straight from a word closes it, then the last NEXT ends the class
  env.hub.handle(host, 'class_next', {});
  env.hub.handle(host, 'class_next', {});
  env.hub.handle(host, 'class_next', {});
  hs = env.last(host, 'class_state').payload;
  assert.equal(hs.phase, 'done');
  assert.deepEqual(hs.summary.map((s) => [s.word, s.clean, s.hinted, s.miss]), [
    ['famille', 1, 0, 1],
    ['ami', 1, 1, 0],
    ['chanter', 0, 0, 2],
  ]);
  assert.equal(env.last(a, 'class_state').payload.phase, 'done');
  env.hub.handle(host, 'class_end', {});
  assert.equal(env.last(a, 'class_closed').payload.reason, 'ended');
});

test('tally is debounced to the host only', async () => {
  const env = setup();
  const { host, code } = hostWithClass(env);
  const a = join(env, code, 1);
  join(env, code, 2);
  join(env, code, 3);
  env.hub.handle(host, 'class_start', {});
  env.hub.handle(a, 'class_result', { index: 0, outcome: 'clean' });
  assert.equal(env.last(host, 'class_tally'), undefined);
  await new Promise((r) => setTimeout(r, TALLY_DEBOUNCE_MS + 50));
  const tally = env.last(host, 'class_tally').payload;
  assert.equal(tally.answered, 1);
  assert.equal(tally.total, 3);
  assert.equal(env.last(a, 'class_tally'), undefined);
});

test('student reconnect: seat kept as away, rejoin by token restores it mid-word', () => {
  const env = setup();
  const { host, code } = hostWithClass(env);
  const a = join(env, code, 1, 'Ana');
  join(env, code, 2, 'Ben');
  env.hub.handle(host, 'class_start', {});
  const id = env.last(a, 'class_joined').payload.studentId;
  env.hub.onClose(a);
  assert.equal(env.last(host, 'class_state').payload.roster.find((s) => s.id === id).away, true);

  t += STUDENT_GRACE_MS - 1000;
  env.hub.sweep();
  const a2 = env.sock();
  env.hub.handle(a2, 'class_rejoin', { code, token: tok(1) });
  const st = env.last(a2, 'class_state').payload;
  assert.equal(st.you, id);
  assert.equal(st.phase, 'word');
  assert.equal(st.rows.length, 3, 'rejoin snapshot carries the rows');
  env.hub.handle(a2, 'class_result', { index: 0, outcome: 'clean' });
  assert.equal(env.hub._getClass(code).results[0].get(id).outcome, 'clean');
});

test('an away student does not hold up the auto-reveal, and drops after the grace window', () => {
  const env = setup();
  const { host, code } = hostWithClass(env);
  const a = join(env, code, 1);
  const b = join(env, code, 2);
  env.hub.handle(host, 'class_start', {});
  env.hub.onClose(b);
  env.hub.handle(a, 'class_result', { index: 0, outcome: 'clean' });
  assert.equal(env.last(host, 'class_state').payload.phase, 'review');
  t += STUDENT_GRACE_MS + 1;
  env.hub.sweep();
  assert.equal(env.last(host, 'class_state').payload.roster.length, 1);
  const b2 = env.sock();
  env.hub.handle(b2, 'class_rejoin', { code, token: tok(2) });
  assert.equal(env.last(b2, 'class_error').payload.code, 'class_rejoin_failed');
});

test('joining again with the same token is a rejoin, not a second seat', () => {
  const env = setup();
  const { host, code } = hostWithClass(env);
  const a = join(env, code, 1);
  const a2 = join(env, code, 1);
  assert.equal(env.last(host, 'class_state').payload.roster.length, 1);
  assert.equal(env.last(a, 'class_closed').payload.reason, 'superseded');
  assert.equal(env.last(a2, 'class_state').payload.role, 'student');
});

test('host drop pauses the class (no host migration); host token rejoin resumes', () => {
  const env = setup();
  const { host, code, hostToken } = hostWithClass(env);
  const a = join(env, code, 1);
  env.hub.handle(host, 'class_start', {});
  env.hub.onClose(host);
  assert.equal(env.last(a, 'class_state').payload.hostAway, true);
  // a student can never take the console
  env.hub.handle(a, 'class_next', {});
  assert.equal(env.last(a, 'class_error').payload.code, 'not_host');

  t += HOST_GRACE_MS - 1000;
  env.hub.sweep();
  const host2 = env.sock();
  env.hub.handle(host2, 'class_rejoin', { code, token: hostToken });
  const hs = env.last(host2, 'class_state').payload;
  assert.equal(hs.role, 'host');
  assert.equal(hs.phase, 'word');
  assert.equal(env.last(a, 'class_state').payload.hostAway, false);
  env.hub.handle(host2, 'class_reveal', {});
  assert.equal(env.last(a, 'class_state').payload.phase, 'review');
});

test('host gone past the grace window closes the class', () => {
  const env = setup();
  const { host, code } = hostWithClass(env);
  const a = join(env, code, 1);
  env.hub.onClose(host);
  t += HOST_GRACE_MS + 1;
  env.hub.sweep();
  assert.equal(env.last(a, 'class_closed').payload.reason, 'host_gone');
  assert.equal(env.hub._getClass(code), undefined);
});

test('an idle class is reaped', () => {
  const env = setup();
  const { host, code } = hostWithClass(env);
  t += CLASS_IDLE_MS + 1;
  env.hub.sweep();
  assert.equal(env.last(host, 'class_closed').payload.reason, 'idle');
  assert.equal(env.hub.stats().classes, 0);
  void code;
});

test('kick removes the seat, their results, and blocks their token', () => {
  const env = setup();
  const { host, code } = hostWithClass(env);
  const a = join(env, code, 1);
  env.hub.handle(host, 'class_start', {});
  const id = env.last(a, 'class_joined').payload.studentId;
  env.hub.handle(a, 'class_result', { index: 0, outcome: 'clean' });
  env.hub.handle(host, 'class_kick', { studentId: id });
  assert.equal(env.last(a, 'class_closed').payload.reason, 'kicked');
  assert.equal(env.last(host, 'class_state').payload.roster.length, 0);
  const a2 = env.sock();
  env.hub.handle(a2, 'class_rejoin', { code, token: tok(1) });
  assert.equal(env.last(a2, 'class_error').payload.code, 'class_kicked');
  env.hub.handle(a2, 'class_join', { code, token: tok(1) });
  assert.equal(env.last(a2, 'class_error').payload.code, 'class_kicked');
});

test('student leave frees the seat; a host creating a new class ends the old one', () => {
  const env = setup();
  const { host, code } = hostWithClass(env);
  const a = join(env, code, 1);
  env.hub.handle(a, 'class_leave', {});
  assert.equal(env.last(host, 'class_state').payload.roster.length, 0);
  const b = join(env, code, 2);
  env.hub.handle(host, 'class_create', { rows: ROWS });
  assert.equal(env.last(b, 'class_closed').payload.reason, 'ended');
  assert.equal(env.hub.stats().classes, 1);
});

test('a 40-student class: one phase change is one frame per seat', () => {
  const env = setup();
  const { host, code } = hostWithClass(env);
  const studs = [];
  for (let i = 0; i < MAX_STUDENTS; i += 1) studs.push(join(env, code, 200 + i));
  studs.forEach(env.clear);
  env.clear(host);
  env.hub.handle(host, 'class_start', {});
  for (const s of studs) assert.equal(env.frames(s).length, 1);
  assert.equal(env.frames(host).length, 1);
  for (const s of studs) env.hub.handle(s, 'class_result', { index: 0, outcome: 'clean' });
  assert.equal(env.last(host, 'class_state').payload.phase, 'review');
  assert.equal(env.last(host, 'class_state').payload.tally.clean, MAX_STUDENTS);
});

test('unknown class_ types and junk payloads never throw', () => {
  const env = setup();
  const ws = env.sock();
  env.hub.handle(ws, 'class_nope', null);
  env.hub.handle(ws, 'class_result', 'x');
  env.hub.handle(ws, 'class_join', 42);
  env.hub.handle(ws, 'constructor', {});
  env.hub.onClose(ws);
  assert.ok(env.frames(ws).every((f) => f.type === 'class_error'));
});
