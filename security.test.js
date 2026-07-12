// security.test.js
// Run with: node --test security.test.js  (auto-discovered by `npm test`).
// Proves the input-hardening + throttle helpers that back the T7 security fixes:
//   - sanitizeName strips control / bidi-zero-width / angle-bracket chars,
//     collapses whitespace, caps length, and falls back on empty/non-string.
//   - slidingWindowAllow enforces a rolling-window cap and lets old events age
//     out — the primitive behind the per-socket message cap (R1/R2/R6) and the
//     join throttle (R5).
// Pure functions, no sockets/timers: `now` is passed in, so the window tests are
// deterministic without real time. Control / zero-width test inputs are built
// with String.fromCharCode so this source file stays pure ASCII.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeName,
  slidingWindowAllow,
  MESSAGE_LIMIT,
  MESSAGE_WINDOW_MS,
  JOIN_LIMIT,
  MAX_WS_PAYLOAD_BYTES,
} = require('./security');

const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const BELL = String.fromCharCode(7);
const ZWSP = String.fromCharCode(0x200b); // zero-width space
const RTL_OVERRIDE = String.fromCharCode(0x202e); // right-to-left override
const BOM = String.fromCharCode(0xfeff); // zero-width no-break space

// ---- sanitizeName (vector R4: XSS via usernames) --------------------------

test('sanitizeName passes an ordinary name through unchanged', () => {
  assert.equal(sanitizeName('Alice'), 'Alice');
});

test('sanitizeName strips angle brackets (defuses HTML/script injection)', () => {
  // The classic stored-XSS payload loses its tag delimiters server-side, so it
  // can never reach a client render as markup.
  assert.equal(sanitizeName('<script>x'), 'scriptx');
  assert.equal(sanitizeName('<b>hi</b>'), 'bhi/b');
  assert.equal(sanitizeName('a<img>b'), 'aimgb');
});

test('sanitizeName removes ASCII control characters outright', () => {
  // Control chars (incl. tab/newline/null/bell) are stripped before the
  // whitespace pass, so none survive into a broadcast display string.
  assert.equal(sanitizeName('a' + TAB + 'b' + LF + 'c'), 'abc');
  assert.equal(sanitizeName('null' + NUL + 'byte'), 'nullbyte');
  assert.equal(sanitizeName('bell' + BELL + 'char'), 'bellchar');
});

test('sanitizeName removes zero-width and bidi formatting characters', () => {
  // Zero-width space and RTL override are invisible name-spoofing tricks — both
  // are stripped, as is a stray BOM.
  assert.equal(sanitizeName('ab' + ZWSP + 'cd'), 'abcd');
  assert.equal(sanitizeName('evil' + RTL_OVERRIDE + 'eman'), 'evileman');
  assert.equal(sanitizeName('x' + BOM + 'y'), 'xy');
});

test('sanitizeName collapses internal whitespace and trims the ends', () => {
  assert.equal(sanitizeName('  hello   world  '), 'hello world');
});

test('sanitizeName caps length at 20 characters', () => {
  assert.equal(sanitizeName('x'.repeat(50)).length, 20);
});

test('sanitizeName falls back to Player for empty / whitespace / non-string', () => {
  assert.equal(sanitizeName(''), 'Player');
  assert.equal(sanitizeName('   '), 'Player');
  assert.equal(sanitizeName(' ' + ZWSP), 'Player'); // all-stripped -> empty
  assert.equal(sanitizeName(undefined), 'Player');
  assert.equal(sanitizeName(null), 'Player');
  assert.equal(sanitizeName(12345), 'Player');
  assert.equal(sanitizeName({}), 'Player');
});

test('sanitizeName honors a custom fallback', () => {
  assert.equal(sanitizeName('', 'Guest'), 'Guest');
});

// ---- slidingWindowAllow (vectors R1/R2/R5/R6: rate limiting) ---------------

test('slidingWindowAllow allows up to the limit, then denies within the window', () => {
  const times = [];
  const now = 1_000_000;
  for (let i = 0; i < 5; i += 1) {
    assert.equal(slidingWindowAllow(times, now, 1000, 5), true, `call ${i} should pass`);
  }
  // 6th call in the same window is over the cap.
  assert.equal(slidingWindowAllow(times, now, 1000, 5), false);
  // A denied call records nothing, so the recorded count stays exactly at the cap.
  assert.equal(times.length, 5);
});

test('slidingWindowAllow lets events age out of the window', () => {
  const times = [];
  const base = 0;
  for (let i = 0; i < 5; i += 1) slidingWindowAllow(times, base, 1000, 5);
  assert.equal(slidingWindowAllow(times, base, 1000, 5), false); // full at t=0

  // Exactly one window later, all five original stamps have aged out.
  assert.equal(slidingWindowAllow(times, base + 1000, 1000, 5), true);
  // Only the fresh stamp remains.
  assert.equal(times.length, 1);
});

test('slidingWindowAllow slides continuously (partial expiry)', () => {
  const times = [];
  // Two events at t=0, three at t=500 -> window full (5) at t=500.
  slidingWindowAllow(times, 0, 1000, 5);
  slidingWindowAllow(times, 0, 1000, 5);
  slidingWindowAllow(times, 500, 1000, 5);
  slidingWindowAllow(times, 500, 1000, 5);
  slidingWindowAllow(times, 500, 1000, 5);
  assert.equal(slidingWindowAllow(times, 500, 1000, 5), false);

  // At t=1000 the two t=0 events have expired (>=1000ms old), freeing 2 slots.
  assert.equal(slidingWindowAllow(times, 1000, 1000, 5), true);
  assert.equal(slidingWindowAllow(times, 1000, 1000, 5), true);
  // ...but the three t=500 events are still live, so the next is denied again.
  assert.equal(slidingWindowAllow(times, 1000, 1000, 5), false);
});

test('a realistic fast-typer burst stays under the message cap', () => {
  // 15 messages inside one second (a very fast typer + a submit) — must all pass
  // under the tuned MESSAGE_LIMIT, proving the cap never hits legit play.
  const times = [];
  const now = 42_000;
  for (let i = 0; i < 15; i += 1) {
    assert.equal(
      slidingWindowAllow(times, now, MESSAGE_WINDOW_MS, MESSAGE_LIMIT),
      true,
      'a fast typer must never be throttled'
    );
  }
});

test('a flood script is capped at MESSAGE_LIMIT per window', () => {
  const times = [];
  const now = 99_000;
  let allowed = 0;
  for (let i = 0; i < 500; i += 1) {
    if (slidingWindowAllow(times, now, MESSAGE_WINDOW_MS, MESSAGE_LIMIT)) allowed += 1;
  }
  assert.equal(allowed, MESSAGE_LIMIT); // 500 attempts, only MESSAGE_LIMIT get through
});

// ---- tuned constants sanity ------------------------------------------------

test('tuned limits are sane and generous', () => {
  assert.ok(MESSAGE_LIMIT >= 30, 'message cap must clear a fast typer with headroom');
  assert.ok(JOIN_LIMIT >= 10, 'join cap must clear normal lobby-hopping');
  assert.equal(MAX_WS_PAYLOAD_BYTES, 64 * 1024);
});
