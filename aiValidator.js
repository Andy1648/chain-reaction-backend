// aiValidator.js
// Hybrid AI fallback for Category Blitz answer validation. The pre-generated
// accept-lists in categoryAnswers.js handle the common cases instantly and for
// free; this module is the SECOND stage, only consulted when an answer isn't on
// the list (a creative/uncommon-but-possibly-valid answer).
//
// It stacks two providers for resilience: Groq first (fast + generous free
// tier), then Gemini as a fallback. Each provider returns:
//   true  -> the model said YES (valid)
//   false -> the model said NO  (invalid)
//   null  -> couldn't determine (no key, network/API error, unparseable reply)
//
// Only a null from one provider cascades to the next. If BOTH return null we
// fail OPEN (accept) — losing a third-party judge should never block gameplay,
// and with two stacked providers a double-failure is rare.

// NOTE: This module is currently RETIRED — categoryBlitzLogic.js uses
// haikuValidator.js (fail-closed) instead, and nothing requires this file (see
// categoryBlitzLogic.js: "aiValidator.js ... stay in the repo but are no longer
// [used]"). It's kept for reference / possible re-enable. Logging below is gated
// so that if it is ever rewired it stays quiet in production by default.

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

// Opt-in diagnostics. Set VALIDATOR_DEBUG=1 to surface provider skips, API
// errors, and per-verdict logs; silent otherwise. Logging only — verdicts are
// unaffected.
const DEBUG = !!process.env.VALIDATOR_DEBUG;

// The judge prompt is identical for both providers so their verdicts are
// directly comparable.
function buildPrompt(category, answer) {
  return `You are a strict game judge for a word game. The category is: "${category}". The player's answer is: "${answer}". Rules: The answer must be a specific, real thing that clearly and directly fits the category. Reject generic words, jokes, random text, abbreviations, slang that doesn't fit, or anything that requires a stretch to connect to the category. Reply with ONLY "YES" or "NO", nothing else.`;
}

/**
 * Judge via Groq's OpenAI-compatible chat completions endpoint.
 * Returns true/false on a parsed verdict, or null if it couldn't determine one.
 */
async function validateWithGroq(category, answer) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    if (DEBUG) console.warn('[aiValidator] No GROQ_API_KEY set — skipping Groq');
    return null;
  }

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: buildPrompt(category, answer) }],
        max_tokens: 5,
      }),
    });

    if (!response.ok) {
      if (DEBUG) console.warn('[aiValidator] Groq API error:', response.status);
      return null;
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim().toUpperCase();
    if (text === 'YES') return true;
    if (text === 'NO') return false;
    // Anything else (empty, garbled) is "couldn't determine".
    if (DEBUG) console.warn('[aiValidator] Groq unparseable reply:', text);
    return null;
  } catch (err) {
    if (DEBUG) console.warn('[aiValidator] Groq call failed:', err.message);
    return null;
  }
}

/**
 * Judge via Google Gemini. Mirrors the original gemini.js logic but returns
 * null (not true) on any failure, so the caller can cascade/decide.
 * Returns true/false on a parsed verdict, or null if it couldn't determine one.
 */
async function validateWithGemini(category, answer) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    if (DEBUG) console.warn('[aiValidator] No GEMINI_API_KEY set — skipping Gemini');
    return null;
  }

  try {
    const response = await fetch(GEMINI_API_URL + '?key=' + apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(category, answer) }] }],
      }),
    });

    if (!response.ok) {
      if (DEBUG) console.warn('[aiValidator] Gemini API error:', response.status);
      return null;
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase();
    if (text === 'YES') return true;
    if (text === 'NO') return false;
    if (DEBUG) console.warn('[aiValidator] Gemini unparseable reply:', text);
    return null;
  } catch (err) {
    if (DEBUG) console.warn('[aiValidator] Gemini call failed:', err.message);
    return null;
  }
}

/**
 * Hybrid validator: try Groq, then Gemini, then fail open.
 * Returns a definitive boolean (true = accept, false = reject).
 */
async function validateCategoryAnswer(category, answer) {
  const groqVerdict = await validateWithGroq(category, answer);
  if (groqVerdict !== null) {
    if (DEBUG) console.log(`[aiValidator] verdict by Groq: ${groqVerdict ? 'YES' : 'NO'} (${answer} / ${category})`);
    return groqVerdict;
  }

  const geminiVerdict = await validateWithGemini(category, answer);
  if (geminiVerdict !== null) {
    if (DEBUG) console.log(`[aiValidator] verdict by Gemini: ${geminiVerdict ? 'YES' : 'NO'} (${answer} / ${category})`);
    return geminiVerdict;
  }

  // Both providers failed to return a verdict — fail open so a third-party
  // outage never blocks the game.
  if (DEBUG) console.warn(`[aiValidator] both providers failed — failing open (accept) for "${answer}" / "${category}"`);
  return true;
}

module.exports = { validateCategoryAnswer };
