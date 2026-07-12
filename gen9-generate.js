// gen9-generate.js
// OVERNIGHT generator for the Category Blitz pack rework. Produces, per pack, a
// batch of CATEGORIES (each following THE CATEGORY RULE) plus a seed accept-list
// of precise answers per category. Writes everything to ./gen9.raw.json as it
// goes, so an overnight crash keeps whatever it had already produced.
//
// This is the BREADTH pass: it deliberately over-generates so tomorrow's pass can
// cut down and fine-tune. Seed accept-lists are intentionally modest (~70) — the
// Haiku judge (haikuValidator.js) covers the long tail at play time, exactly like
// the gen7 seed lists already shipping.
//
// Run from the backend repo root:   node gen9-generate.js
// Requires:  GEMINI_API_KEY in env (same key haikuValidator.js uses), Node 18+.
//
// Tomorrow's step (NOT done here): cull the raw pool, then a converter writes
// categoryAnswers/gen9.js (new Set per category) + appends keys to CATEGORIES in
// categoryBlitzLogic.js with a `pack` tag.

const fs = require('fs');

const MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash-lite'];
const TEMPERATURE = 0.5; // some variety across categories; precision rule does the rest
const MAX_TOKENS = 20000;

// Tuning knobs. 6 packs x BATCHES_PER_PACK x CATS_PER_CALL categories total.
// Defaults -> ~24 categories/pack, ~144 total, a big pool to cull from tomorrow.
const CATS_PER_CALL = 2;
const BATCHES_PER_PACK = 6;
const ANSWERS_PER_CATEGORY = 150;
const MAX_RETRIES = 3;
const OUT_FILE = './gen9.raw.json';

// Persistent exclude-list: category names the generator must NEVER (re)produce,
// independent of raw.json. Retiring a category = add its name to gen9-exclude.json
// (see that file's _comment). Loaded once; applied to every pack's avoid-list below.
const EXCLUDE_NAMES = (() => {
  let names = [];
  try {
    names = JSON.parse(fs.readFileSync('./gen9-exclude.json', 'utf8')).names || [];
  } catch (err) {
    console.warn(`  (no gen9-exclude.json / unreadable: ${err.message}) — proceeding with none`);
  }
  try {
    const live = require('./categoryBlitzLogic').CATEGORIES;
    names = [...new Set([...names, ...live])];
  } catch (err) {
    console.warn(`  (couldn't load live CATEGORIES for dedupe: ${err.message})`);
  }
  return names;
})();

// ---- Pack definitions -------------------------------------------------------
// `scope` steers generation into the pack's lane. Note the sports scope steers
// AWAY from open-ended athlete lists toward bounded team/sport/position sets —
// the kind of design-fit guard we want baked in, not discovered later.
const PACKS = [
  {
    id: 'movies',
    name: 'Movies & TV',
    scope:
      'Films, TV shows, and the characters / villains / elements within them — ' +
      'animated and live-action franchises, character rosters, studios\' output. ' +
      'Good categories: Pixar movies, Disney villains, Marvel superheroes, Studio ' +
      'Ghibli movies, Star Wars characters, Anime shows, Harry Potter characters.',
  },
  {
    id: 'gaming',
    name: 'Gaming',
    scope:
      'Video games, game characters, in-game items / mobs / blocks / power-ups (as ' +
      'named things), and hardware. Good categories: Minecraft mobs, Mario characters, ' +
      'Pokemon from Gen 1, Fortnite skins, Video game consoles, Fighting games, ' +
      'Mario Kart items, Zelda characters.',
  },
  {
    id: 'food',
    name: 'Food & Drink',
    scope:
      'Foods, drinks, dishes, snack / candy / soda / cereal brands, ingredients, and ' +
      'cuisines. Good categories: Pizza toppings, Ice cream flavors, Candy bars, ' +
      'Starbucks drinks, Cereal brands, Types of pasta, Cocktails, Sushi types.',
  },
  {
    id: 'animals',
    name: 'Animals & Nature',
    scope:
      'Animals, breeds, and the natural world — wild and domestic animals, breeds, ' +
      'plants, and natural features as named things. Good categories: Dog breeds, ' +
      'Zoo animals, Dinosaurs, Birds, Ocean animals, Cat breeds, Trees, Gemstones.',
  },
  {
    id: 'sports',
    name: 'Sports',
    scope:
      'Sports, leagues, teams, positions, and equipment as BOUNDED named sets. Good ' +
      'categories: NBA teams, NFL teams, Olympic sports, Soccer clubs, Martial arts, ' +
      'Baseball positions, Water sports. AVOID open-ended "famous athletes / players" ' +
      'sets — they are effectively infinite; prefer bounded team / sport / position sets.',
  },
  {
    id: 'world',
    name: 'World & Myth',
    scope:
      'Geography, places, mythology, and history as bounded named sets. Good ' +
      'categories: European capitals, US states, African countries, Famous landmarks, ' +
      'Greek gods, Norse gods, US presidents, Planets, World rivers.',
  },
  {
    id: 'music',
    name: 'Music',
    scope:
      'Instruments, genres, bands, composers, and named musical things as BOUNDED ' +
      'sets. Good categories: Musical instruments, Music genres, String instruments, ' +
      'Woodwind instruments, Types of guitars, Orchestra sections, Boy bands, ' +
      'Classical composers, Beatles albums, Musical notes. Prefer bounded named sets ' +
      '— AVOID open-ended "famous singers / songs" lists.',
  },
  {
    id: 'science',
    name: 'Science',
    scope:
      'Chemistry, physics, biology, and earth science as BOUNDED named sets. Good ' +
      'categories: Chemical elements, Noble gases, Planets and moons, Human bones, ' +
      'Human organs, States of matter, SI units, Subatomic particles, Lab equipment, ' +
      'Cell organelles, Types of rock. Named finite things, not open-ended.',
  },
  {
    id: 'history',
    name: 'History',
    scope:
      'Empires, rulers, eras, and events as BOUNDED named sets. Good categories: ' +
      'Ancient empires, Roman emperors, Egyptian pharaohs, US founding fathers, ' +
      'Historical eras, Famous explorers, Ancient wonders, Medieval titles, World War ' +
      'II battles, Renaissance figures. Prefer bounded named sets — AVOID open-ended ' +
      '"famous people" lists.',
  },
  {
    id: 'geography',
    name: 'Geography',
    scope:
      'Places and physical features as BOUNDED named sets. Good categories: ' +
      'Continents, Oceans, Mountain ranges, Major rivers, Deserts, US states, African ' +
      'countries, Island nations, Great Lakes, Time zones. Prefer bounded named sets ' +
      'of named places / features.',
  },
  {
    id: 'mythology',
    name: 'Mythology',
    scope:
      'Mythology as BOUNDED named sets, but AVOID Greek / Norse / Egyptian / Roman / ' +
      'Hindu / Aztec / Inca gods (the World pack already owns those). Good categories: ' +
      'Mythical weapons and artifacts, Greek titans, Mythological locations (Olympus, ' +
      'Valhalla, underworld realms), Japanese yokai, Celtic myth figures, Arthurian ' +
      'relics, Mythical birds, Legendary creatures by culture, Constellations from ' +
      'myth. Named finite things, not open-ended.',
  },
  {
    id: 'literature',
    name: 'Literature',
    scope:
      'Literature as BOUNDED named sets. Good categories: Shakespeare plays, Classic ' +
      'novels, Literary genres, Famous poets, Greek epics, Fairy tales, Sherlock ' +
      'Holmes stories, Dickens novels, Literary devices, Roald Dahl books, Dystopian ' +
      'novels, Jane Austen novels. Named finite things, not open-ended.',
  },
  {
    id: 'tech',
    name: 'Tech',
    scope:
      'Tech and internet as BOUNDED named sets. Good categories: Programming ' +
      'languages, Social media platforms, Web browsers, Operating systems, Tech ' +
      'companies, Cryptocurrencies, Keyboard keys, Computer components, File formats, ' +
      'Video streaming services, Phone brands, Apple products. Named finite things, ' +
      'not open-ended.',
  },
  {
    id: 'art',
    name: 'Art',
    scope:
      'Art as BOUNDED named sets. Good categories: Art movements, Primary and ' +
      'secondary colors, Painting tools, Famous painters, Sculpture materials, Art ' +
      'mediums, Famous museums, Pottery types, Drawing tools, Photography terms, Dance ' +
      'styles, Architecture styles. Named finite things, not open-ended.',
  },
  {
    id: 'tv',
    name: 'TV',
    scope:
      'TV as BOUNDED named sets, but AVOID generic movie / sitcom / animated-show ' +
      'categories the Movies pack owns. Good categories: Reality TV shows, Game shows, ' +
      'TV networks, Streaming original series, Talk shows, TV award shows, Anime ' +
      'series, Cooking shows, HBO series, British sitcoms. Named finite things, not ' +
      'open-ended.',
  },
];

// ---- The megaprompt ---------------------------------------------------------
function buildPrompt(pack, numCats, answersPer, avoidList) {
  const avoidBlock = avoidList.length
    ? `\nDo NOT produce any of these already-generated categories (pick different ones):\n${avoidList
        .map((c) => `- ${c}`)
        .join('\n')}\n`
    : '';

  return `You are generating content for a fast party word game called Category Blitz. Players are shown a CATEGORY and race to type as many valid answers as they can in 20 seconds.

Your job: produce ${numCats} CATEGORIES for the "${pack.name}" pack, and for EACH category a seed list of valid answers.

PACK SCOPE — every category must clearly belong to this pack:
${pack.scope}

═══ WHAT MAKES A VALID CATEGORY ═══
A category must have a BOUNDED, finite-ish answer space where almost every valid answer is a NAMED THING of 3 words or fewer (an object, brand, character, place, food, team, animal, etc.).
GOOD: "Pixar movies", "NBA teams", "Dog breeds", "Minecraft mobs", "European capitals", "Mario characters", "Pizza toppings".
BAD — never produce these:
  - sentence / phrase answers ("Things teachers always say", "Lies on a dating profile")
  - open-ended or effectively-infinite prompts ("Things you google at 3am", "What the dog ate")
  - anything where valid answers are routinely 4+ words.
Favor categories a teenager instantly recognizes and could rattle off 10+ answers to. Span the pack's breadth — do NOT give several near-identical categories.
${avoidBlock}
═══ FOR EACH CATEGORY, A SEED ACCEPT-LIST ═══
Generate up to ${answersPer} valid answers per category — fewer if the real domain is genuinely smaller. NEVER invent members to hit a number.

ABSOLUTE PRECISION RULE (most important): in-game, every answer on this list is AUTO-ACCEPTED with no review. A single wrong entry scores points forever. Every answer MUST be an unambiguous, factually real member of that category. If you are not certain something genuinely belongs, OMIT IT. A short 100%-correct list beats a long one with any error in it.

WRITE THE FORMS PLAYERS ACTUALLY TYPE (this is where coverage comes from):
  - all lowercase
  - drop leading articles ("the", "a")
  - include common short forms / nicknames that clearly map to ONE member (e.g. "spongebob", "mr krabs", "la lakers")
  - include singular AND plural when both are natural ("creeper" / "creepers")
  - include common alternate / simplified spellings ("pokemon" / "pokémon", "donut" / "doughnut")
  - every answer 3 words or fewer; drop any answer needing 4+ words
  - no duplicates, no explanations, no numbering

═══ OUTPUT ═══
Return ONLY a JSON array. No prose, no markdown code fences. Each element is:
{"category": "<name as a player sees it, e.g. Pixar movies>", "answers": ["answer one","answer two", ...]}
Category names use normal casing; all answers are lowercase.`;
}

// ---- Gemini call (direct fetch) ---------------------------------------------
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

// Pull the JSON array out of a reply, tolerating stray fences/prose.
function parseJsonArray(text) {
  const t = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('no JSON array found in reply');
  return JSON.parse(t.slice(start, end + 1));
}

// Local hygiene pass so the raw file is already half-clean for tomorrow: lowercase
// + trim answers, drop 4+ word answers and empties, dedupe within a category.
function cleanCategory(entry) {
  const seen = new Set();
  const answers = [];
  for (const raw of entry.answers || []) {
    if (typeof raw !== 'string') continue;
    const a = raw.trim().toLowerCase();
    if (!a) continue;
    if (a.split(/\s+/).length > 3) continue; // enforce the <=3-word rule locally too
    if (seen.has(a)) continue;
    seen.add(a);
    answers.push(a);
  }
  return { category: String(entry.category || '').trim(), answers };
}

async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`  [retry ${attempt}/${MAX_RETRIES}] ${label}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

async function main() {
  const out = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : {};

  for (const pack of PACKS) {
    if (!out[pack.id]) out[pack.id] = [];
    // Seed the dedupe set with BOTH what we already have AND the persistent
    // exclude-list, so retired names are hard-dropped at insertion (line ~"have.has")
    // even if the model ignores the prompt avoid-block.
    const have = new Set(out[pack.id].map((c) => c.category.toLowerCase()));
    for (const n of EXCLUDE_NAMES) have.add(n.toLowerCase());
    console.log(`\n=== ${pack.name} (${pack.id}) — have ${out[pack.id].length} so far ===`);

    for (let batch = 1; batch <= BATCHES_PER_PACK; batch += 1) {
      // Prompt avoid-block = existing categories in this pack + the persistent
      // exclude-list, so the model is steered away from retired names too.
      const avoid = [...out[pack.id].map((c) => c.category), ...EXCLUDE_NAMES];
      const prompt = buildPrompt(pack, CATS_PER_CALL, ANSWERS_PER_CATEGORY, avoid);

      let entries;
      try {
        const reply = await withRetry(() => callGemini(prompt), `${pack.id} batch ${batch}`);
        entries = parseJsonArray(reply);
      } catch (err) {
        console.error(`  batch ${batch} failed permanently: ${err.message} — skipping`);
        continue;
      }

      let added = 0;
      for (const e of entries) {
        const cleaned = cleanCategory(e);
        if (!cleaned.category) continue;
        const key = cleaned.category.toLowerCase();
        if (have.has(key)) continue; // cross-batch dedupe
        if (cleaned.answers.length < 8) continue; // too thin to be worth keeping
        have.add(key);
        out[pack.id].push(cleaned);
        added += 1;
      }

      // Write after every call so an overnight crash never loses prior batches.
      fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
      console.log(
        `  batch ${batch}: +${added} categories (pack total ${out[pack.id].length})`
      );
    }
  }

  const totals = PACKS.map((p) => `${p.id}:${out[p.id].length}`).join('  ');
  const grand = PACKS.reduce((n, p) => n + out[p.id].length, 0);
  console.log(`\nDONE. ${grand} categories total -> ${OUT_FILE}`);
  console.log(totals);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
