// security.js
// Input hardening + abuse throttles for the WebSocket server. Deliberately PURE
// and dependency-free (no ws, no timers, no globals beyond Date via the caller):
// every function takes its state in and returns a verdict, so the whole module
// is unit-testable offline (see security.test.js) and the networking layer in
// server.js just wires it to real sockets.

// ---- Display-name sanitization (vector R4: XSS via usernames) --------------
// Usernames are the only persistent, cross-player, free-text display string in
// the game (there is no chat). They're rebroadcast in room_update / turn_update
// / spectator_reaction / imposter answers. The frontend owns HTML-escaping at
// render time, but we strip server-side as defense-in-depth so a hostile name
// can never carry control characters, bidi/zero-width formatting tricks, or raw
// angle brackets into any client that renders a name less carefully.
const MAX_NAME_LENGTH = 20;
const DEFAULT_NAME = 'Player';

// Character classes to strip, built via RegExp() from escaped strings so this
// source file stays pure ASCII (no hidden control bytes on disk):
//   - C0 control chars (00-1F), DEL (7F), and C1 controls (80-9F)
//   - Arabic letter mark (061C), Mongolian vowel separator (180E), zero-width +
//     LTR/RTL marks (200B-200F), bidi overrides (202A-202E), word joiner (2060),
//     bidi isolates LRI/RLI/FSI/PDI (2066-2069), and ZWNBSP / BOM (FEFF).
//     The isolates and 061C are as effective for name-spoofing as the overrides,
//     so they must be stripped too.
// Matching control chars is the whole point here (we strip them), so the
// no-control-regex lint rule is intentionally disabled for this line.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'g');
const FORMAT_CHARS = new RegExp(
  '[\\u061C\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060\\u2066-\\u2069\\uFEFF]',
  'g'
);

function sanitizeName(raw, fallback = DEFAULT_NAME) {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    // NFKC-normalize FIRST so compatibility look-alikes fold to their canonical
    // form BEFORE we strip: fullwidth/small-form angle brackets (U+FF1C/FF1E,
    // U+FE64/FE65) become real '<'/'>' and are then removed — otherwise a client
    // that normalizes a name at render time would reconstitute the delimiters we
    // thought we'd stripped. normalize() never throws on content (only on a bad
    // form arg), so it's safe on any string.
    .normalize('NFKC')
    .replace(CONTROL_CHARS, '')
    .replace(FORMAT_CHARS, '')
    // Angle brackets: a display name never needs them, and dropping them
    // neutralizes the primary HTML/script-injection delimiters.
    .replace(/[<>]/g, '')
    // Collapse any run of whitespace to a single space, then trim.
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return fallback;
  return cleaned.slice(0, MAX_NAME_LENGTH);
}

// ---- Sliding-window rate limiter (vectors R1, R2, R5, R6) ------------------
// Generic rolling-window counter. `times` is a caller-owned array of past event
// timestamps (kept on the ws object so it's freed with the connection). Prunes
// entries older than `windowMs`, then allows the event iff fewer than `limit`
// remain in the window. On allow it records `now` and returns true; on deny it
// records nothing and returns false. Pure: all "current time" comes in via `now`.
function slidingWindowAllow(times, now, windowMs, limit) {
  // Drop timestamps that have aged out of the window. Timestamps are pushed in
  // increasing order, so the stale ones are always a prefix.
  let stale = 0;
  while (stale < times.length && now - times[stale] >= windowMs) stale += 1;
  if (stale > 0) times.splice(0, stale);

  if (times.length >= limit) return false;
  times.push(now);
  return true;
}

// ---- Tuned limits ----------------------------------------------------------
// GLOBAL per-socket inbound message cap. This is a SPEED-TYPING game, so it's
// tuned generously: typing_update fires ~once per keystroke, and even a very
// fast typer (~10-12 keystrokes/sec) plus submits peaks around 15 msgs/sec.
// 50 messages / rolling second is ~4x that headroom — a human never trips it,
// while a flood/replay script is capped hard.
const MESSAGE_WINDOW_MS = 1000;
const MESSAGE_LIMIT = 50;

// Per-socket join_room cap. A legit player joins a handful of rooms in a
// session; 30 attempts / minute leaves enormous headroom while turning
// room-code brute-forcing into a non-starter.
const JOIN_WINDOW_MS = 60 * 1000;
const JOIN_LIMIT = 30;

// Hard cap on a single inbound WebSocket frame (vector R3). Game messages are a
// few hundred bytes at most; 64 KiB is wildly generous yet stops a client from
// shipping a ~100 MiB frame (the ws default) that JSON.parse would allocate.
const MAX_WS_PAYLOAD_BYTES = 64 * 1024;

module.exports = {
  sanitizeName,
  slidingWindowAllow,
  MAX_NAME_LENGTH,
  DEFAULT_NAME,
  MESSAGE_WINDOW_MS,
  MESSAGE_LIMIT,
  JOIN_WINDOW_MS,
  JOIN_LIMIT,
  MAX_WS_PAYLOAD_BYTES,
};
