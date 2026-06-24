// haikuValidator.js
// Stage-2 AI fallback for Category Blitz answer validation, using Anthropic's
// Claude Haiku. It is ONLY consulted on a list-miss (the pre-generated accept
// lists in categoryAnswers.js resolve the common answers first, instantly and
// for free); this judges the creative/uncommon-but-possibly-valid answers.
//
// Design decisions (per the product spec):
//   - FAIL CLOSED. Any failure - timeout, network error, rate limit, bad key,
//     unparseable reply - REJECTS the answer. A flaky third-party judge must
//     never stall the round or wave garbage through. (This is the opposite of
//     the old Groq/Gemini aiValidator.js, which failed open.)
//   - HARD 3s TIMEOUT. A slow API never blocks gameplay; past 3s we reject.
//   - PER-PLAYER RATE LIMIT (10 calls / rolling minute). Stops a player from
//     spam-submitting gibberish to burn API credits; over the cap we reject
//     WITHOUT calling the API.
//   - KEY IS ENV-ONLY (ANTHROPIC_API_KEY). Never hardcoded. When it's unset the
//     whole fallback is disabled (see isEnabled) and the caller keeps the
//     list-only behaviour instead of calling this.
//
// Uses the global fetch + AbortController (Node 18+, matching package.json
// engines and the existing aiValidator.js), so there's no SDK dependency.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 3000; // hard cap on the API call; slower than this -> reject
const MAX_TOKENS = 10; // we only need "yes"/"no"
const RATE_LIMIT_PER_MIN = 10; // max AI calls per player per rolling 60s
const RATE_WINDOW_MS = 60000;

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

function buildPrompt(category, answer) {
  return `Is "${answer}" a valid/reasonable answer for the category "${category}"? Reply with only "yes" or "no".`;
}

/**
 * Judge one answer with Claude Haiku. Returns a definitive boolean:
 *   true  -> accept (model said yes)
 *   false -> reject (model said no, OR any failure / timeout / rate-limit /
 *            unparseable reply - fail closed)
 *
 * `playerId` keys the per-player rate limit.
 */
async function runValidate(category, answer, playerId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  // Defensive: callers gate on isEnabled(), but never call the API without a key.
  if (!apiKey) return false;

  if (!underRateLimit(playerId)) {
    console.warn(
      `[haikuValidator] rate limit hit for player ${playerId} - rejecting "${answer}" without calling the API`
    );
    return false;
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
      console.warn(`[haikuValidator] Anthropic API error ${res.status} - rejecting "${answer}"`);
      return false;
    }

    const data = await res.json();
    const text = (data.content?.[0]?.text || '').trim().toLowerCase();
    if (text.startsWith('yes')) return true;
    if (text.startsWith('no')) return false;
    // Anything else (empty, refusal, garbled) -> fail closed.
    console.warn(`[haikuValidator] unparseable reply "${text}" - rejecting "${answer}"`);
    return false;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`[haikuValidator] timeout (>${TIMEOUT_MS}ms) - rejecting "${answer}"`);
    } else {
      console.warn(`[haikuValidator] call failed: ${err.message} - rejecting "${answer}"`);
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// TEMP DEBUG (remove after confirming the fallback fires in prod): logs every
// Haiku fallback call and its verdict on EVERY path (yes/no/timeout/error/rate-
// limit). Pure logging - the returned verdict is unchanged, so game behavior is
// untouched. The fallback only runs on a list-MISS while a key is set, so seeing
// these lines proves it's being hit; their absence means every answer is either
// resolving on the accept-list or the key isn't set.
async function validate(category, answer, playerId) {
  console.log(
    `[haikuValidator] FALLBACK CALLED - category="${category}" answer="${answer}" player=${playerId}`
  );
  const verdict = await runValidate(category, answer, playerId);
  console.log(
    `[haikuValidator] FALLBACK RESULT - answer="${answer}" -> ${verdict ? 'ACCEPT (yes)' : 'REJECT (no / fail-closed)'}`
  );
  return verdict;
}

module.exports = { validate, isEnabled, RATE_LIMIT_PER_MIN, TIMEOUT_MS };
