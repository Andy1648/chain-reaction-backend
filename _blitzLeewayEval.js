// TEMPORARY acceptance-gate harness for the Category Blitz leeway pass.
// Runs a fixture of should-pass (60) + should-fail (15) answers through the judge
// using the EXACT production prompt (haikuValidator.buildPrompt). Prefers the real
// Anthropic judge when ANTHROPIC_API_KEY is set; otherwise falls back to Gemini
// (GEMINI_API_KEY) as a documented proxy for the generous prompt. Not committed.
const { buildPrompt, MODEL } = require('./haikuValidator');

// 10 categories x 6 should-pass: misspellings, missing accents, partial/last-name,
// abbreviations, regional/colloquial/slang, brand nicknames.
const PASS = [
  ['Fruits', ['bananna', 'aple', 'watermellon', 'mango', 'pineaple', 'kiwi']],
  ['Countries', ['USA', 'UK', 'S. Korea', 'Brasil', 'Deutschland', 'Nederlands']],
  ['Famous soccer players', ['Ronaldo', 'Messi', 'Pele', 'Zidane', 'Neymar', 'Maradona']],
  ['Dog breeds', ['lab', 'german shepard', 'golden', 'pit bull', 'husky', 'dobermann']],
  ['Pizza toppings', ['peperoni', 'mushroom', 'extra cheese', 'jalapeno', 'onions', 'sausage']],
  ['NBA players', ['LeBron', 'Curry', 'Shaq', 'MJ', 'Giannis', 'Kobe']],
  ['Vegetables', ['tomatoe', 'brocoli', 'eggplant', 'corn', 'potatos', 'pepper']],
  ['Car brands', ['chevy', 'VW', 'Merc', 'Toyota', 'beemer', 'Volkswagon']],
  ['Musical instruments', ['guitar', 'piano', 'violin', 'saxaphone', 'drums', 'trumpet']],
  ['Ice cream flavors', ['vanila', 'choclate', 'strawbery', 'mint choc chip', 'cookie dough', 'pistachio']],
];
// 15 should-fail: clearly not a member of the stated category.
const FAIL = [
  ['Fruits', 'hammer'], ['Fruits', 'bulldozer'],
  ['Countries', 'banana'], ['Countries', 'Beyonce'],
  ['Famous soccer players', 'spaghetti'], ['Famous soccer players', 'the Eiffel Tower'],
  ['Dog breeds', 'goldfish'], ['Dog breeds', 'refrigerator'],
  ['Pizza toppings', 'car engine'],
  ['NBA players', 'broccoli'], ['NBA players', 'France'],
  ['Vegetables', 'iPhone'],
  ['Car brands', 'elephant'],
  ['Musical instruments', 'toaster'],
  ['Ice cream flavors', 'stapler'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (text) => {
  const t = (text || '').trim().toLowerCase();
  if (t.startsWith('yes')) return true;
  if (t.startsWith('no')) return false;
  return null; // unparseable
};

async function anthropicJudge(category, answer) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 10, messages: [{ role: 'user', content: buildPrompt(category, answer) }] }),
  });
  if (!res.ok) throw new Error('anthropic ' + res.status);
  const d = await res.json();
  return parse(d.content?.[0]?.text);
}

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
async function geminiJudge(category, answer) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: buildPrompt(category, answer) }] }], generationConfig: { maxOutputTokens: 5, temperature: 0 } }),
    });
    if (res.status === 429) { await sleep(20000); continue; } // quota/rate — back off and retry
    if (!res.ok) throw new Error('gemini ' + res.status + ' ' + (await res.text()).slice(0, 120));
    const d = await res.json();
    return parse(d.candidates?.[0]?.content?.parts?.[0]?.text);
  }
  throw new Error('gemini 429 after retries (quota)');
}

async function main() {
  let judge, judgeName;
  if (process.env.ANTHROPIC_API_KEY) { judge = anthropicJudge; judgeName = 'Anthropic ' + MODEL; }
  else if (process.env.GEMINI_API_KEY) { judge = geminiJudge; judgeName = 'Gemini ' + GEMINI_MODEL + ' (PROXY — no ANTHROPIC_API_KEY available)'; }
  else { console.error('No judge key available (ANTHROPIC_API_KEY or GEMINI_API_KEY).'); process.exit(2); }
  console.log('JUDGE:', judgeName, '\n');

  const passItems = PASS.flatMap(([c, arr]) => arr.map((a) => [c, a]));
  let passAccepted = 0; const passRejected = [];
  for (const [c, a] of passItems) {
    let v; try { v = await judge(c, a); } catch (e) { v = 'ERR:' + e.message; }
    if (v === true) passAccepted++; else passRejected.push(`${c} / "${a}" -> ${v}`);
    await sleep(1200);
  }
  let failRejected = 0; const failAccepted = [];
  for (const [c, a] of FAIL) {
    let v; try { v = await judge(c, a); } catch (e) { v = 'ERR:' + e.message; }
    if (v === false) failRejected++; else failAccepted.push(`${c} / "${a}" -> ${v}`);
    await sleep(1200);
  }

  const pPct = ((passAccepted / passItems.length) * 100).toFixed(1);
  console.log(`SHOULD-PASS accepted: ${passAccepted}/${passItems.length} (${pPct}%)  [target >=95%]`);
  if (passRejected.length) { console.log('  not accepted:'); passRejected.forEach((x) => console.log('   -', x)); }
  console.log(`SHOULD-FAIL rejected: ${failRejected}/${FAIL.length}  [target 15/15]`);
  if (failAccepted.length) { console.log('  leaked (accepted a should-fail):'); failAccepted.forEach((x) => console.log('   -', x)); }
  const ok = passAccepted / passItems.length >= 0.95 && failRejected === FAIL.length;
  console.log('\nGATE:', ok ? 'PASS' : 'FAIL');
}
main().catch((e) => { console.error(e); process.exit(1); });
