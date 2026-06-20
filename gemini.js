// gemini.js
// Wraps the Google Gemini API to judge whether a free-text answer fits a
// category (for Category Blitz). Like dictionary.js, this fails OPEN: if no
// API key is configured or the API call fails for any reason, we accept the
// answer rather than blocking gameplay on a third-party outage.

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

async function validateCategoryAnswer(category, answer) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('No GEMINI_API_KEY set — accepting answer by default');
    return true; // fail open like dictionary.js does
  }

  const prompt = `You are a strict game judge for a word game. The category is: "${category}". The player's answer is: "${answer}". Rules: The answer must be a specific, real thing that clearly and directly fits the category. Reject generic words, jokes, random text, abbreviations, slang that doesn't fit, or anything that requires a stretch to connect to the category. Reply with ONLY "YES" or "NO", nothing else.`;

  try {
    const response = await fetch(GEMINI_API_URL + '?key=' + apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    if (!response.ok) {
      console.warn('Gemini API error:', response.status);
      return true; // fail open
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase();
    return text === 'YES';
  } catch (err) {
    console.warn('Gemini API call failed:', err.message);
    return true; // fail open
  }
}

module.exports = { validateCategoryAnswer };
