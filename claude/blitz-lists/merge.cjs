// Merge + verify the curated Blitz lists (agent outputs) into blitzLists.json. Run: node claude/blitz-lists/merge.cjs

const fs = require('fs');

const path = require('path');

const { answerKey } = (() => { // inline copy so this runs before blitzLists.json exists

  const answerKey = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').trim().replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');

  return { answerKey };

})();

const dir = path.join(__dirname);
// REVIEW PASS (Oct 2): agents marked these complete but flagged doubt about completeness/edges — a list-only
// round that rejects a real answer is the failure we're removing, so they go. Plus two overlaps.
const REVIEW_DROP = new Set([
  'Harry Potter spells & incantations', 'James Bond villains & henchmen (Eon films)', 'Final Fantasy summons (mainline I-XVI)',
  'Mortal Kombat fighters', 'Halo weapons', 'Beatrix Potter characters (the Peter Rabbit tales)', 'Breaking Bad main-cast characters',
  'Tracks that have hosted a NASCAR Cup race since 2020', 'Cricket fielding positions', 'US state nicknames', 'Woodwind instruments',
  'Brass instruments', 'Keyboard instruments', 'Drum kit parts',
  'English monarchs 1066-1485 (Harold II to Henry VII)', 'Nintendo consoles and handhelds',
  'Musical note names (letters and solfège)', // single letters: under the 2-char floor, and free points
]);
// The prompt players read — short, still a closed set.
const DISPLAY = {
  'Among Us tasks on The Skeld': 'Among Us tasks (The Skeld)', 'Clubs that have played in the Premier League': 'Premier League clubs (all-time)',
  'Counties of Ireland (all 32, island-wide)': 'Irish counties', 'Current NBA arenas (2026)': 'NBA arenas', 'Current NFL home stadiums (2026)': 'NFL stadiums',
  'English and British monarchs since 1066': 'English & British monarchs', 'Formula 1 circuits on the 2026 calendar': 'F1 circuits (2026 calendar)',
  'Formula 1 teams on the 2026 grid': 'F1 teams (2026 grid)', 'Girl Scout cookie varieties (past and present)': 'Girl Scout cookies',
  'Greek Titans (the Twelve and their Titan children)': 'Greek Titans', 'Inca emperors (Sapa Incas incl. Vilcabamba)': 'Inca emperors',
  'Kings and emperors of France from Hugh Capet (987-1870)': 'French kings & emperors', 'Kong family members (Donkey Kong series)': "Donkey Kong's Kong family",
  'Latin American countries (the 20 Spanish/Portuguese/French-speaking nations from Mexico south)': 'Latin American countries',
  'Middle Eastern countries (the 17 commonly listed)': 'Middle Eastern countries', 'Musical note names (letters and solfège)': 'Musical note names',
  'Note values (US or UK names)': 'Musical note values', 'Parts of a plant cell (organelles & structures)': 'Parts of a plant cell',
  'Roman emperors (Augustus to the fall of the West, 476)': 'Roman emperors', 'Russian tsars and emperors (1547-1917)': 'Russian tsars',
  'Seven Wonders of the World (Ancient or New 7)': 'Wonders of the World (Ancient & New 7)', 'Sherlock Holmes stories by Conan Doyle (the 60-story canon)': 'Sherlock Holmes stories',
  'Shoguns of the Kamakura, Ashikaga and Tokugawa shogunates': 'Japanese shoguns', 'Summer Olympic sports (2020–2028 Games)': 'Summer Olympic sports',
  'Tennis Grand Slams and ATP Masters 1000 tournaments': 'Tennis Slams & Masters 1000s', 'WNBA teams, past and present': 'WNBA teams',
  'Pokémon starters (main series)': 'Pokémon starters', 'Street Fighter playable fighters (mainline games)': 'Street Fighter fighters',
  'Mario Kart items (any game)': 'Mario Kart items', 'Minecraft handheld tools and weapons': 'Minecraft tools & weapons',
  'Portal test elements and gear': 'Portal test elements', 'Angry Birds playable birds': 'Angry Birds birds', 'Apex Legends playable legends': 'Apex Legends legends',
  'Skyrim playable races': 'Skyrim races', 'Stardew Valley giftable villagers': 'Stardew Valley villagers',
  'Signers of the US Declaration of Independence': 'Declaration of Independence signers', 'Major League Baseball teams': 'MLB teams',
};
const PACK_FIX = {
  'Minecraft mobs': 'gaming', 'Pixar feature films': 'movies', 'James Bond films': 'movies', 'Star Wars theatrical films': 'movies', 'Pokemon from Gen 1': 'gaming', 'Pokémon starters': 'gaming',
  'Wonders of the World (Ancient & New 7)': 'world', 'Greek Olympian gods': 'mythology', 'Norse gods and goddesses': 'mythology', 'US states': 'world',
};

const ins = {};

for (const sub of ['in', 'in6']) for (const f of fs.readdirSync(path.join(dir, sub))) for (const c of JSON.parse(fs.readFileSync(path.join(dir, sub, f), 'utf8'))) ins[c.category] = c;

const out = [];

const problems = [];

const drops = [];

const seen = new Set();

for (const f of fs.readdirSync(path.join(dir, 'out')).sort()) {

  let arr;

  try { arr = JSON.parse(fs.readFileSync(path.join(dir, 'out', f), 'utf8')); } catch (e) { problems.push(`${f}: bad JSON ${e.message}`); continue; }

  for (const c of arr) {

    if (c.verdict !== 'KEEP') { drops.push(`${c.category} â€” ${c.reason}`); continue; }

    const raw = (c.rename || c.category).trim();
    if (REVIEW_DROP.has(raw)) { drops.push(`${raw} — review pass: completeness doubt`); continue; }
    const name = DISPLAY[raw] || raw;

    const nk = name.toLowerCase();

    if (seen.has(nk)) { problems.push(`${name}: duplicate category, skipped`); continue; }

    const answers = [...new Set((c.answers || []).map((a) => String(a).trim().toLowerCase()).filter(Boolean))];

    // 2-letter postal codes ("ok", "hi", "in", "or") are free points on a US-states list — off.

    if (/^us state/i.test(name)) for (let i = answers.length - 1; i >= 0; i--) if (/^[a-z]{2}$/.test(answers[i])) answers.splice(i, 1);

    const keys = new Set(answers.map(answerKey));

    const good = (c.good || []).map(String).filter((g) => !(/^us state/i.test(name) && /^[a-z]{2}$/i.test(g.trim())));
    for (const a of answers) { if (good.length >= 8) break; if (!good.some((g) => answerKey(g) === answerKey(a))) good.push(a); }

    const junk = (c.junk || []).map(String);

    if (!junk.some((j) => answerKey(j) === 'zzzzzzzz')) junk.push('zzzzzzzz');

    const badGood = good.filter((g) => !keys.has(answerKey(g)));

    const badJunk = junk.filter((j) => keys.has(answerKey(j)));

    const issues = [];

    if (good.length < 8) issues.push(`only ${good.length} good`);

    if (junk.length < 8) issues.push(`only ${junk.length} junk`);

    if (badGood.length) issues.push(`good not on list: ${badGood.join(', ')}`);

    if (badJunk.length) issues.push(`junk ON list: ${badJunk.join(', ')}`);

    if (keys.size < 8) issues.push(`only ${keys.size} distinct answers`);

    if (Number(c.size) < 10) issues.push(`only ${c.size} members (a 30 s round needs 10+)`);

    if (issues.length) { problems.push(`${name}: ${issues.join('; ')}`); continue; }

    seen.add(nk);

    out.push({ name, pack: PACK_FIX[name] || (ins[c.category] && ins[c.category].pack) || null, size: c.size, answers: answers.sort(), good, junk });

  }

}

out.sort((a, b) => a.name.localeCompare(b.name));

fs.writeFileSync(path.join(dir, '..', '..', 'blitzLists.json'), JSON.stringify(out, null, 1) + '\n');

const packs = {};

for (const c of out) packs[c.pack || '-'] = (packs[c.pack || '-'] || 0) + 1;

console.log(`KEPT ${out.length}  DROPPED ${drops.length}  REJECTED-BY-CHECKS ${problems.length}`);

console.log('packs', JSON.stringify(packs));

fs.writeFileSync(path.join(dir, 'report.txt'), `KEPT ${out.length}\n${out.map((c) => `  ${c.name} [${c.pack}] ${c.size} members, ${c.answers.length} answers`).join('\n')}\n\nDROPPED ${drops.length}\n${drops.map((d) => '  ' + d).join('\n')}\n\nFAILED CHECKS ${problems.length}\n${problems.map((p) => '  ' + p).join('\n')}\n`);

if (problems.length) console.log(problems.join('\n'));

