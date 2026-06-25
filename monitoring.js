// monitoring.js
// Backend error monitoring (Sentry) + product analytics (PostHog) wiring. Both are
// fully optional and GRACEFUL: if SENTRY_DSN / POSTHOG_KEY are unset, init is a
// no-op and every helper below silently does nothing. Nothing here can throw into
// or block game logic — all calls are wrapped, and the SDKs send asynchronously.
//
// NOTE on PostHog: the product events (room_created / room_joined / game_started /
// game_completed) are fired CLIENT-SIDE, where each has a single clean call site.
// The server's game-over is emitted from ~6 scattered places across three game-mode
// modules, so a server mirror would be both messier and a double-count risk. We
// therefore initialize posthog-node (per the task) and leave posthogTrack() ready
// for future server-only metrics, but do NOT mirror the client events here.

const Sentry = require('@sentry/node');
const { PostHog } = require('posthog-node');

let posthog = null;

// Init Sentry BEFORE the rest of the app is required (see server.js) so its
// auto-instrumentation + global uncaught-exception / unhandled-rejection handlers
// are in place. Those global handlers are what satisfy "capture unhandled
// exceptions" — they're registered automatically by Sentry.init.
function initSentry() {
  try {
    const dsn = process.env.SENTRY_DSN;
    if (!dsn) return;
    Sentry.init({ dsn, tracesSampleRate: 0, sendDefaultPii: false });
  } catch {
    // Monitoring must never block startup.
  }
}

function initAnalytics() {
  try {
    const key = process.env.POSTHOG_KEY;
    if (!key) return;
    // flushAt:1 / flushInterval:0 keeps memory tiny for the rare server-side event;
    // sends are still async (never block the event loop / game logic).
    posthog = new PostHog(key, {
      host: 'https://us.i.posthog.com',
      flushAt: 1,
      flushInterval: 0,
    });
  } catch {
    posthog = null;
  }
}

// Report a caught error to Sentry. Safe no-op if Sentry is dormant.
function captureError(err, context) {
  try {
    Sentry.captureException(err, context ? { extra: context } : undefined);
  } catch {
    // never let error reporting itself throw
  }
}

// Fire-and-forget a server-side product event. Currently unused for the client-owned
// game events (see NOTE above); available for future server-only metrics.
function posthogTrack(distinctId, event, properties) {
  try {
    if (posthog) posthog.capture({ distinctId, event, properties });
  } catch {
    // analytics must never affect game logic
  }
}

// Flush queued events on graceful shutdown (Render sends SIGTERM). Best-effort.
async function shutdownAnalytics() {
  try {
    if (posthog) await posthog.shutdown();
  } catch {
    // ignore
  }
}

module.exports = {
  Sentry,
  initSentry,
  initAnalytics,
  captureError,
  posthogTrack,
  shutdownAnalytics,
};
