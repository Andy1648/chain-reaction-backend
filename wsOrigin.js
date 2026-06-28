// wsOrigin.js
// Single source of truth for which browser Origins may open a WebSocket to this
// backend. Wired into the ws server via `verifyClient` in server.js.
//
// Today the server accepts EVERY upgrade (no origin check). This adds an
// allowlist so portal embeds (itch.io, Newgrounds, CrazyGames) and our own
// origins are explicitly permitted while unknown browser origins are turned
// away — WITHOUT breaking anything that works now:
//   - an ABSENT Origin (non-browser clients: bots, server-to-server, health
//     pings) is ALWAYS allowed; we never reject on a missing Origin.
//   - typeaword.com, www.typeaword.com, Vercel previews and localhost stay
//     allowed exactly as before.
//
// Edit the live list with the ALLOWED_WS_ORIGINS env var (comma-separated). It
// REPLACES the defaults below, so adding a portal later is a one-line env change
// with no code edit and no redeploy logic. Entries are host patterns:
//   - "example.com"  -> exact host match only
//   - "*.example.com" -> example.com and any subdomain (suffix match)
// Port is ignored, so "localhost" covers localhost:5173 etc.

const DEFAULT_ALLOWED_WS_ORIGINS = [
  // Production
  'typeaword.com',
  'www.typeaword.com',
  // Vercel preview deploys
  '*.vercel.app',
  // Local dev
  'localhost',
  '127.0.0.1',
  // Portal embeds (editable — add more portals here or via ALLOWED_WS_ORIGINS):
  '*.itch.zone',
  '*.ungrounded.net',
  'newgrounds.com',
  '*.crazygames.com',
];

const ALLOWED_WS_ORIGINS = (
  process.env.ALLOWED_WS_ORIGINS
    ? process.env.ALLOWED_WS_ORIGINS.split(',')
    : DEFAULT_ALLOWED_WS_ORIGINS
)
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Match one Origin host against one allowlist pattern. A leading "*." matches
// the bare domain AND any subdomain; a plain pattern matches the exact host.
function hostMatchesPattern(host, pattern) {
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return host === base || host.endsWith('.' + base);
  }
  return host === pattern;
}

// Decide whether a WS upgrade carrying this Origin header may connect.
// `origin` is the raw Origin string (e.g. "https://html.itch.zone") or a
// falsy value when the client sent no Origin header.
function isOriginAllowed(origin) {
  // No Origin → non-browser client → always allow (never newly break these).
  if (!origin) return true;
  let host;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    // A browser sent a malformed Origin — not on any allowlist, so reject.
    return false;
  }
  return ALLOWED_WS_ORIGINS.some((pattern) => hostMatchesPattern(host, pattern));
}

module.exports = {
  ALLOWED_WS_ORIGINS,
  DEFAULT_ALLOWED_WS_ORIGINS,
  hostMatchesPattern,
  isOriginAllowed,
};
