// gen9-verify.js
// PRECISION PASS over gen9.raw.json. For each category it sends the generated
// answers to the model and asks it to REMOVE any entry that isn't a genuine member
// (hallucinations, wrong items, >3-word entries, dupes). Only survivors are kept.
//
// Why this exists: accept-list entries are AUTO-ACCEPTED in-game with no live judge,
// so one hallucinated "Pixar movie" scores points forever. Generation (gen9-generate.js)
// optimized for breadth; this pass optimizes for correctness. It runs at low
// temperature and errs toward removing anything uncertain.
//
// Run from the backend repo root:   node gen9-verify.js
// Requires:  GEMINI_API_KEY in env (same key gen9-generate.js used), Node 18+.
//
// Reads  ./gen9.raw.json   (the culled file)
// Writes ./gen9.clean.json (same shape, cleaned answers + a per-category `removed` count)
// Resumable: re-running skips categories already present in gen9.clean.json.

const fs = require('fs');

// Newest-first, with the congested 2.5-flash-lite as last-resort fallback.
const MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash-lite'];
const TEMPERATURE = 0.1; // strict, deterministic-ish — this is an audit, not creativity
const MAX_TOKENS = 8000; // output is a subset of input, so this is plenty
const MAX_RETRIES = 3;
const IN_FILE = './gen9.raw.json';
const OUT_FILE = './gen9.clean.json';

// ---- The verify prompt ------------------------------------------------------
function buildVerifyPrompt(category, answers) {
  return `You are auditing an ACCEPT-LIST for a fast word game. Every answer on this list is AUTO-ACCEPTED in-game with no further review, so each surviving answer MUST be a genuine, factually real member of the category. Your job is to REMOVE bad entries. Do NOT add any new answers.

CATEGORY: ${category}

CANDIDATE ANSWERS (JSON array):
${JSON.stringify(answers)}

REMOVE an answer if ANY of these is true:
- it is NOT genuinely, factually a real member of this exact category (hallucinated, invented, or simply wrong)
- it is more than 3 words long
- it duplicates another entry in the list

KEEP an answer if it is a real member — INCLUDING the legitimate variants players actually type: lowercase forms, common nicknames / short forms, singular and plural, and common alternate spellings. Do not remove an entry just for being informal or a nickname, as long as it clearly maps to a real member of this category.

When you are UNSURE whether something is a real member, REMOVE it. Precision matters more than coverage here.

Output ONLY a JSON array of the surviving answers, all lowercase. No prose, no explanations, no markdown fences.`;
}

// ---- Gemini call (fallback chain, mirrors gen9-generate.js) ------------------
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  let lastErr;
  for (const model of MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: TEMPERATURE,
            maxOutputTokens: MAX_TOKENS,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      });
      if (res.status === 503 || res.status === 429) { lastErr = new Error(`${model} ${res.status} busy`); continue; }
      if (!res.ok) { const body = await res.text().catch(() => ''); throw new Error(`Gemini API ${res.status} (${model}): ${body.slice(0, 200)}`); }
      const data = await res.json();
      return (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('all Gemini models failed');
}

function parseJsonArray(text) {
  const t = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('no JSON array found in reply');
  return JSON.parse(t.slice(start, end + 1));
}

// Local hygiene on the survivors: lowercase, trim, drop 4+ word entries, dedupe.
function cleanList(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const a = raw.trim().toLowerCase();
    if (!a) continue;
    if (a.split(/\s+/).length > 3) continue;
    if (seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`  [retry ${attempt}/${MAX_RETRIES}] ${label}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

async function main() {
  if (!fs.existsSync(IN_FILE)) throw new Error(`${IN_FILE} not found — run gen9-generate.js first`);
  const raw = JSON.parse(fs.readFileSync(IN_FILE, 'utf8'));
  const clean = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : {};

  const removedByPack = {};

  for (const pack of Object.keys(raw)) {
    if (!clean[pack]) clean[pack] = [];
    const done = new Set(clean[pack].map((c) => c.category.toLowerCase()));
    removedByPack[pack] = 0;
    console.log(`\n=== ${pack} (${raw[pack].length} categories) ===`);

    for (const cat of raw[pack]) {
      if (done.has(cat.category.toLowerCase())) continue; // resume: already verified

      const original = cleanList(cat.answers || []);
      let survivors;
      try {
        const reply = await withRetry(
          () => callGemini(buildVerifyPrompt(cat.category, original)),
          `${pack} / ${cat.category}`
        );
        survivors = cleanList(parseJsonArray(reply));
      } catch (err) {
        // If verification fails entirely, keep the original list rather than losing
        // the category — flag it so it can be re-run.
        console.error(`  ${cat.category}: verify failed (${err.message}) — kept original, FLAG for re-run`);
        clean[pack].push({ category: cat.category, answers: original, removed: 0, verifyFailed: true });
        fs.writeFileSync(OUT_FILE, JSON.stringify(clean, null, 2));
        continue;
      }

      // Safety guard: if the model nuked almost everything (likely a bad response,
      // not a genuinely all-fake category), keep the original and flag it.
      if (survivors.length < Math.max(3, Math.floor(original.length * 0.2))) {
        console.warn(`  ${cat.category}: model returned only ${survivors.length}/${original.length} — suspicious, kept original, FLAG`);
        clean[pack].push({ category: cat.category, answers: original, removed: 0, suspiciousVerify: true });
        fs.writeFileSync(OUT_FILE, JSON.stringify(clean, null, 2));
        continue;
      }

      const removed = original.length - survivors.length;
      removedByPack[pack] += removed;
      clean[pack].push({ category: cat.category, answers: survivors, removed });
      fs.writeFileSync(OUT_FILE, JSON.stringify(clean, null, 2));
      console.log(`  ${cat.category}: ${original.length} -> ${survivors.length}  (-${removed})`);
      await new Promise(r=>setTimeout(r,2000));
    }
  }

  console.log(`\nDONE -> ${OUT_FILE}`);
  let grandCats = 0;
  let grandAnswers = 0;
  for (const pack of Object.keys(clean)) {
    const cats = clean[pack].length;
    const ans = clean[pack].reduce((n, c) => n + c.answers.length, 0);
    grandCats += cats;
    grandAnswers += ans;
    console.log(`  ${pack}: ${cats} categories, ${ans} answers (removed ~${removedByPack[pack] || 0})`);
  }
  console.log(`  TOTAL: ${grandCats} categories, ${grandAnswers} answers`);

  // Surface anything that needs a human eye.
  const flagged = [];
  for (const pack of Object.keys(clean)) {
    for (const c of clean[pack]) {
      if (c.verifyFailed || c.suspiciousVerify) flagged.push(`${pack} / ${c.category}`);
    }
  }
  if (flagged.length) {
    console.log(`\nFLAGGED for review (kept original, not verified):`);
    flagged.forEach((f) => console.log(`  - ${f}`));
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
