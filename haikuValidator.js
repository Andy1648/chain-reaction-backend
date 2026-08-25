// haikuValidator.js
// Stage-2 AI fallback for Category Blitz answer validation, using Anthropic's
// Claude Haiku. It is ONLY consulted on a list-miss (the pre-generated accept
// lists in categoryAnswers.js resolve the common answers first, instantly and
// for free); this judges the creative/uncommon-but-possibly-valid answers.
//
// Design decisions (per the product spec):
//   - FAIL OPEN. The ONLY thing that rejects an answer is a genuine model "no".
//     Every INFRA failure - timeout, network error, HTTP 429 (quota), 401/403
//     (bad key / billing), any other non-2xx, an unparseable/empty reply, or the
//     per-player rate cap - ACCEPTS the answer. Rationale: a false accept costs
//     nothing in a party game, but a false reject makes the game look broken (and
//     a dead key / spent quota would otherwise reject EVERY list-miss). This
//     reverses the earlier fail-closed contract.
//   - LOG THE ERROR TYPE. Each infra fail-open is logged (console.warn) with its
//     type, so a burst of them in the logs clearly distinguishes "the judge is
//     degraded and waving everything through" from real model "no" rejections.
//   - HARD 3s TIMEOUT. A slow API never blocks gameplay; past 3s we abort and
//     ACCEPT (fail open).
//   - PER-PLAYER RATE LIMIT (10 calls / rolling minute). Still protects API
//     credits by NOT calling the API over the cap - but now ACCEPTS rather than
//     rejects, so a fast player is never wrongly told a valid answer is wrong.
//   - KEY IS ENV-ONLY (ANTHROPIC_API_KEY). Never hardcoded. When it's unset the
//     whole fallback is disabled (see isEnabled) and the caller keeps the
//     list-only behaviour (which also ACCEPTS list-misses) instead of calling this.
//
// Uses the global fetch + AbortController (Node 18+, matching package.json
// engines and the existing aiValidator.js), so there's no SDK dependency.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 3000; // hard cap on the API call; slower than this -> reject
const MAX_TOKENS = 10; // we only need "yes"/"no"
const RATE_LIMIT_PER_MIN = 10; // max AI calls per player per rolling 60s
const RATE_WINDOW_MS = 60000;

// Log every INFRA fail-open with its error type, so the logs distinguish a
// degraded judge (dead key, spent quota, timeouts) from real model "no" verdicts.
// A genuine "no" and a healthy "yes" are NOT logged (normal outcomes) - only the
// fail-open paths, where each line names WHY we accepted without a real verdict.
// Always on (not DEBUG-gated): a burst of these IS the alarm that the judge is down.
function logInfraFailOpen(type, answer, extra = '') {
  console.warn(
    `[haikuValidator] FAIL-OPEN (${type}) - accepting "${answer}" without a model verdict${extra ? ` - ${extra}` : ''}`
  );
}

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
 * Judge one answer with Claude Haiku. Returns a boolean, FAIL OPEN:
 *   false -> reject: ONLY when the model gives a genuine "no".
 *   true  -> accept: the model said "yes", OR any infra failure (no key, rate
 *            cap, HTTP error / 429 quota / 401-403 billing, timeout, network
 *            error, unparseable reply). Infra fail-opens are logged with their type.
 *
 * `playerId` keys the per-player rate limit.
 */
async function validate(category, answer, playerId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  // Defensive: callers gate on isEnabled(). If somehow called without a key we
  // have no judge - fail open (accept) rather than reject a possibly-valid answer.
  if (!apiKey) {
    logInfraFailOpen('no_key', answer);
    return true;
  }

  if (!underRateLimit(playerId)) {
    // Over the per-player cap: skip the API (protects credits) but ACCEPT - a fast
    // player must never be told a valid answer is wrong just for answering quickly.
    logInfraFailOpen('rate_limited', answer, `player ${playerId}`);
    return true;
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
      // 429 = quota/rate, 401/403 = bad key / billing not set up, 5xx = outage.
      // None of these are the player's fault - fail open (accept).
      logInfraFailOpen(`http_${res.status}`, answer);
      return true;
    }

    const data = await res.json();
    const text = (data.content?.[0]?.text || '').trim().toLowerCase();
    // The ONE and only rejection path: a genuine model "no".
    if (text.startsWith('no')) return false;
    if (text.startsWith('yes')) return true;
    // Empty / refusal / garbled: not a real verdict - fail open (accept).
    logInfraFailOpen('unparseable', answer, `reply="${text}"`);
    return true;
  } catch (err) {
    logInfraFailOpen(err.name === 'AbortError' ? 'timeout' : 'network', answer, err.message);
    return true; // fail open on timeout / network error
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { validate, isEnabled, buildPrompt, MODEL, RATE_LIMIT_PER_MIN, TIMEOUT_MS };
