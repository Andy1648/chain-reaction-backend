// logger.js
// Minimal structured logger for the game server. Zero dependencies: one JSON
// line per event, so Render's log viewer (and plain grep) can filter by field.
// Every call takes an event name (snake_case) plus whatever context pins down
// the blast radius — most importantly roomCode and playerId. logError also
// forwards the error to Sentry via the existing monitoring.captureError, so
// structured logs and Sentry stay in sync from a single call site.
//
// Deliberately tiny: no transports, no child loggers, no log levels config.
// If it ever needs more than this, reach for pino — don't grow this file.

const { captureError } = require('./monitoring');

function line(level, event, context, err) {
  const entry = { ts: new Date().toISOString(), level, event, ...context };
  if (err !== undefined && err !== null) {
    entry.error = err.message || String(err);
    if (err.stack) entry.stack = err.stack;
  }
  try {
    return JSON.stringify(entry);
  } catch {
    // Context held something unserializable (circular room object, socket...).
    // Never let the logger itself throw — emit what we safely can.
    return JSON.stringify({ ts: entry.ts, level, event, logNote: 'unserializable context' });
  }
}

function logInfo(event, context = {}) {
  console.log(line('info', event, context));
}

function logWarn(event, context = {}, err) {
  console.warn(line('warn', event, context, err));
}

function logError(event, context = {}, err) {
  console.error(line('error', event, context, err));
  if (err) {
    try {
      captureError(err, { event, ...context });
    } catch {
      /* reporting must never throw */
    }
  }
}

module.exports = { logInfo, logWarn, logError };
