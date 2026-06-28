// haikuValidator.js
// Stage-2 AI fallback for Category Blitz answer validation, using Anthropic's
// Claude Haiku. It is ONLY consulted on a list-miss (the pre-generated accept
// lists in categoryAnswers.js resolve the common answers first, instantly and
// for free); this judges the creative/uncommon-but-possibly-valid answers.
//
// Design decisions (per the product spec):
//   - HONOR REAL VERDICTS, FAIL OPEN ON OPERATIONAL FAILURES. A successful judge
//     call is obeyed exactly: a clear "yes" accepts, a clear "no" REJECTS. But a
//     purely OPERATIONAL failure - timeout, network/API error, rate-limit, an
//     unparseable reply - must NOT punish the player for our infrastructure, so
//     those ACCEPT (fail open). Only a confident judge "no" rejects an answer.
//     (Fail-closed killed valid answers whenever the API hiccuped.)
//   - HARD 5s TIMEOUT. A slow API never blocks gameplay; past 5s we abort and
//     fail open (accept).
//   - PER-PLAYER RATE LIMIT (30 calls / rolling minute). Stops a player from
//     spam-submitting gibberish to burn API credits: over the cap we skip the API
//     call entirely - and, failing open, ACCEPT rather than reject.
//   - KEY IS ENV-ONLY (ANTHROPIC_API_KEY). Never hardcoded. When it's unset the
//     whole fallback is disabled (see isEnabled) and the caller keeps the
//     list-only behaviour instead of calling this.
//
// Uses the global fetch + AbortController (Node 18+, matching package.json
// engines and the existing aiValidator.js), so there's no SDK dependency.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 5000; // hard cap on the API call; slower than this -> fail open
const MAX_TOKENS = 10; // we only need "yes"/"no"
const RATE_LIMIT_PER_MIN = 30; // max AI calls per player per rolling 60s
const RATE_WINDOW_MS = 60000;

// Diagnostics are opt-in. Every log below fires only on an OPERATIONAL-failure
// path (rate limit, API error, timeout, unparseable reply) - never on the happy
// path - so production is silent by default. Set VALIDATOR_DEBUG=1 to surface
// them when investigating why list-miss answers are being accepted-on-failure
// (fail open). Logging only; the validation verdict is unaffected either way.
const DEBUG = !!process.env.VALIDATOR_DEBUG;

// Per-player sliding window of recent AI-call timestamps (ms since epoch),
// keyed by playerId. Pruned on access; entries self-empty once a player stops
// submitting, so this stays bounded by the number of recently-active players.
const callTimes = new Map();

/**
 * Whether AI validation is configured. The caller checks this before invoking
 * validate(); when false, the fallback is skipped entirely and list-misses keep
 * the list-only behaviour (no API call, no rejection on the AI's behalf).
 */
function isEnabled() {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Sliding-window rate check. Returns true and records the call if the player is
 * UNDER the per-minute cap; returns false (and records nothing) if they've hit
 * it, so the caller skips the API entirely.
 */
function underRateLimit(playerId) {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const recent = (callTimes.get(playerId) || []).filter((t) => t > cutoff);
  if (recent.length >= RATE_LIMIT_PER_MIN) {
    callTimes.set(playerId, recent); // keep the pruned list
    return false;
  }
  recent.push(now);
  callTimes.set(playerId, recent);
  return true;
}

// Judge like a FUN PARTY-GAME HOST, not a strict teacher. Players type short
// 1-3 word answers under time pressure, often abbreviated/informal - be generous
// and accept anything a group of friends would let slide; only reject answers
// that genuinely make no sense for the category.
function buildPrompt(category, answer) {
  return `The player is in a fast-paced word game. The category is "${category}". They typed "${answer}". Is this a reasonable or creative answer to this category, even if abbreviated or informal? Be generous - accept anything that a group of friends would accept during a party game. Reply with only "yes" or "no".`;
}

/**
 * Judge one answer with Claude Haiku. Returns a boolean:
 *   true  -> accept (model said yes, OR an OPERATIONAL failure - timeout /
 *            rate-limit / network|API error / unparseable reply - failing open)
 *   false -> reject (model gave a confident "no")
 * Only a successful judge call returning a clear "no" rejects; every operational
 * failure accepts so infrastructure problems never kill a valid answer.
 *
 * `playerId` keys the per-player rate limit.
 */
async function validate(category, answer, playerId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  // Defensive: callers gate on isEnabled(), but never call the API without a key.
  if (!apiKey) return false;

  if (!underRateLimit(playerId)) {
    if (DEBUG) console.warn(
      `[haikuValidator] rate limit hit for player ${playerId} - accepting "${answer}" (fail open) without calling the API`
    );
    return true; // operational failure: rate-limit -> fail open (accept)
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: buildPrompt(category, answer) }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Operational failure: non-200 from the API -> fail open (accept).
      if (DEBUG) console.warn(`[haikuValidator] Anthropic API error ${res.status} - accepting "${answer}" (fail open)`);
      return true;
    }

    const data = await res.json();
    const text = (data.content?.[0]?.text || '').trim().toLowerCase();
    // A SUCCESSFUL call with a clear verdict is honored exactly:
    if (text.startsWith('yes')) return true;
    if (text.startsWith('no')) return false; // confident "no" -> the only reject
    // Anything else (empty, refusal, garbled) is an unparseable reply, an
    // operational failure -> fail open (accept).
    if (DEBUG) console.warn(`[haikuValidator] unparseable reply "${text}" - accepting "${answer}" (fail open)`);
    return true;
  } catch (err) {
    // Operational failure: timeout (AbortError) or any thrown network/API error
    // -> fail open (accept). Never reject a valid answer over infrastructure.
    if (err.name === 'AbortError') {
      if (DEBUG) console.warn(`[haikuValidator] timeout (>${TIMEOUT_MS}ms) - accepting "${answer}" (fail open)`);
    } else {
      if (DEBUG) console.warn(`[haikuValidator] call failed: ${err.message} - accepting "${answer}" (fail open)`);
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { validate, isEnabled, RATE_LIMIT_PER_MIN, TIMEOUT_MS };
