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

// Diagnostics are opt-in. Every log below fires only on a FAILURE path (rate
// limit, API error, timeout, unparseable reply) - never on the happy path - so
// production is silent by default. Set VALIDATOR_DEBUG=1 to surface them when
// investigating why list-miss answers are being rejected. Logging only; the
// validation verdict is unaffected either way.
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

// Judge like the good-natured host of a casual PARTY game, NOT a strict teacher or
// quiz show. Players type short answers under time pressure, so the prompt is
// explicitly, deliberately GENEROUS: the bar is "would a reasonable group of friends
// count this?", and ties go to the player (when uncertain, ACCEPT). The response
// contract is unchanged — the model still replies with a single "yes"/"no", parsed
// by validate() below (startsWith 'yes'/'no').
function buildPrompt(category, answer) {
  return `You are the good-natured host of a fast, casual PARTY word game — NOT a strict teacher, quiz show, or fact-checker. Players type short answers under time pressure, so give them every reasonable benefit of the doubt.

Category: "${category}"
Player's answer: "${answer}"

Decide whether "${answer}" could reasonably count as a member of the category "${category}". BE VERY GENEROUS. You MUST accept:
- regional, colloquial, slang, and brand/nickname names for the same thing (e.g. "soccer" and "football", "cilantro" and "coriander", "chevy" for Chevrolet, "beemer" for BMW, "aubergine" and "eggplant")
- common misspellings, typos, phonetic spellings, and missing accents/punctuation whenever the intended answer is unmistakable (e.g. "bananna", "spagetti", "jalapeno" for jalapeño, "Pele" for Pelé)
- singular or plural forms, abbreviations, and partial or last-name-only / first-name-only answers when it is clear who or what is meant (e.g. "Ronaldo", "LeBron", "USA", "VW")
- anything a reasonable group of friends would happily let slide during a party game

Reject ONLY when the answer is clearly NOT a member of the category — an obvious non-fit, pure gibberish, or an entirely different kind of thing. Do not reject for being informal, misspelled, abbreviated, partial, or uncommon.

When you are unsure, ACCEPT. This is a party game, not a test.

Reply with only one word: "yes" to accept, or "no" to reject.`;
}

/**
 * Judge one answer with Claude Haiku. Returns a definitive boolean:
 *   true  -> accept (model said yes)
 *   false -> reject (model said no, OR any failure / timeout / rate-limit /
 *            unparseable reply - fail closed)
 *
 * `playerId` keys the per-player rate limit.
 */
async function validate(category, answer, playerId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  // Defensive: callers gate on isEnabled(), but never call the API without a key.
  if (!apiKey) return false;

  if (!underRateLimit(playerId)) {
    if (DEBUG) console.warn(
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
      if (DEBUG) console.warn(`[haikuValidator] Anthropic API error ${res.status} - rejecting "${answer}"`);
      return false;
    }

    const data = await res.json();
    const text = (data.content?.[0]?.text || '').trim().toLowerCase();
    if (text.startsWith('yes')) return true;
    if (text.startsWith('no')) return false;
    // Anything else (empty, refusal, garbled) -> fail closed.
    if (DEBUG) console.warn(`[haikuValidator] unparseable reply "${text}" - rejecting "${answer}"`);
    return false;
  } catch (err) {
    if (err.name === 'AbortError') {
      if (DEBUG) console.warn(`[haikuValidator] timeout (>${TIMEOUT_MS}ms) - rejecting "${answer}"`);
    } else {
      if (DEBUG) console.warn(`[haikuValidator] call failed: ${err.message} - rejecting "${answer}"`);
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { validate, isEnabled, buildPrompt, MODEL, RATE_LIMIT_PER_MIN, TIMEOUT_MS };
