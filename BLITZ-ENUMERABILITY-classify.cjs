const fs = require('fs');
const l = require('./categoryBlitzLogic');

// ENUMERABLE = the correct answers form a CLOSED set a list could hold in full, so a
// strict list-only judge would accept essentially every real answer.
// OPEN = the answer space keeps growing or has no agreed membership, so any list is a
// sample and strict judging would reject real answers.

const OPEN_PAT = [
  /^types? of /i, /\btypes$/i, /\bbrands?$/i, /\bshows?$/i, /\bseries$/i, /\bmovies$/i,
  /\bgames$/i, /\bnovels$/i, /\bsubgenres?$/i, /\bgenres?$/i, /\bstyles$/i, /\bdishes$/i,
  /\bfoods$/i, /\bdrinks$/i, /\bflavors$/i, /\bsnack/i, /\bcostumes$/i, /\bsitcoms?\b/i,
  /^popular /i, /^famous /i, /^wild animals/i, /\bspecies$/i, /\bbreeds$/i,
  /\bitems$/i, /\bthings\b/i, /\bwebsites$/i, /\bservices$/i, /\bplatforms$/i,
  /\bcompanies$/i, /\bterms$/i, /\btitles$/i, /\bawards$/i, /\bfigures$/i,
];
const ENUM_PAT = [
  /\bteams$/i, /\bclubs$/i, /\bconstructors$/i, /\bconferences$/i, /\bpositions$/i,
  /\bpresidents$/i, /\bmonarchs$/i, /\bemperors$/i, /\bpharaohs$/i, /\btsars$/i,
  /\bshoguns$/i, /\bfirst ladies$/i, /\bcapitals$/i, /\bprefectures$/i, /\bcounties$/i,
  /\bcountries$/i, /\bstates\b/i, /\belements$/i, /\bbones$/i, /\borgans$/i,
  /\borganelles$/i, /\bgods$/i, /\bdeities$/i, /\btitans$/i, /\bcharacters$/i,
  /\bvillains$/i, /\bbosses$/i, /\bheroes$/i, /\bchampions$/i, /\bvillagers$/i,
  /\bagents$/i, /\bfighters$/i, /\bspells$/i, /\bconsoles/i,
];

const FORCE_OPEN = new Set([
  'Superheroes', 'Mythical creatures', 'Birds', 'Insects', 'Trees', 'Flowers', 'Fruits',
  'Vegetables', 'Zoo animals', 'Ocean animals', 'Dinosaurs', 'Prehistoric creatures',
  'Constellations', 'Marsupials', 'Primates', 'Rodents', 'Arachnids', 'Marine mammals',
  'Cocktails', 'Coffee drinks', 'Gemstones', 'Sushi types', 'Weather phenomena',
  'Mythical creatures by culture', 'Mythical weapons and artifacts', 'Mythical birds',
  'Mythical swords and blades', 'Mythical horses and steeds', 'Mythological locations',
  'Japanese yokai', 'Greek monsters and beasts', 'Greek heroes', 'Roman gods',
  'Hindu deities', 'Literary characters', 'Literary devices', 'Fairy tales',
  'Classic novels', 'Famous poets', 'Ancient civilizations', 'Ancient Empires',
  'Historical Eras', 'Historical capitals', 'Historical peace treaties', 'Cold War events',
  'World War II battles', 'US Civil War Battles', 'US Civil War Generals',
  'Renaissance figures', 'Medieval titles', 'Scientific fields',
  'Scientific laws and principles', 'Human infectious diseases', 'Human muscles',
  'Lab equipment', 'Laboratory safety gear', 'Types of telescopes', 'Cybersecurity terms',
  'Programming languages', 'Programming frameworks', 'Database management systems',
  'Web development languages', 'File formats', 'Keyboard keys', 'Smart home devices',
  'Computer ports and connectors', 'Tech job titles', 'Tech input devices',
  'Art movements', 'Art mediums', 'Art periods', 'Architecture styles',
  'Sculpture materials', 'Photography terms', 'Painting tools', 'Drawing tools',
  'Famous sculptures', 'Major world rivers', 'World mountain ranges', 'Major world deserts',
  'World deserts', 'Major world islands', 'World seas', 'Natural landscape features',
  'Landforms', 'Farm crops', 'Nuts and seeds', 'Herbs and spices', 'Houseplants',
  'Succulents and cacti', 'Wildflowers', 'Aquarium fish', 'Nocturnal animals',
  'Extreme sports', 'Martial arts', 'Water sports', 'Bowling terms', 'Golf clubs',
  'Music awards', 'Boy bands', 'Classical composers', 'Famous explorers', 'Famous museums',
  'Famous paintings', 'Mexican food dishes', 'Indian food dishes', 'Breakfast pastries',
  'Bakery items', 'Dried fruits', 'Frozen treats', 'Frozen desserts', 'Breakfast meats',
  'Donut types', 'Internet top-level domains', 'Internet protocols', 'Computer components',
  'Cryptocurrencies', 'Video streaming services', 'E-commerce websites',
  'Social media platforms', 'Sports', 'Musical instruments', 'Board games', 'Video games',
  'Halloween costumes', 'Mythical monsters in pop culture', 'Famous dragons in myth and fiction',
  'Greek and Roman mythology figures', 'Literary Nobel Prize winners',
  // --- AUDIT PASS: a roster is only closed when it is scoped to ONE named property.
  // Scoped to a whole MEDIUM or GENRE the membership is effectively unbounded, however
  // large the list already is, so these come back to OPEN.
  'Video game villains', 'Anime Villains', 'Sitcom Characters', 'Horror Movie Characters',
  'Animated Movie Characters', 'Animated TV Shows', 'Horror Movie Monsters',
  'Marvel Superheroes', 'DC Comics Superheroes', 'Disney Animated Movie Characters',
  'Arthurian legend characters', 'Fortnite skins', 'Fortnite weapons',
  'Video game hardware', 'Fighting game franchises', 'Video Game Movies',
  'Famous TV Detectives', 'Ways to die in Minecraft', 'Mythical creatures in video games',
]);

const FORCE_ENUM = new Set([
  'Continents', 'US states', 'US state capitals', 'US state nicknames',
  'US states bordering Canada', 'US states by admission order', 'US National Parks',
  'Japanese prefectures', 'Irish counties', 'Greek City-States', 'Ancient Greek city-states',
  'Chemical elements', 'Human bones', 'Human organs', 'Human body systems',
  'Cell organelles', 'Parts of an atom', 'Types of blood vessels', 'Types of blood cells',
  'Human teeth', 'Greenhouse gases', 'SI derived units', 'Taxonomic domains and phyla',
  'Parts of a plant cell', 'Human digestive system parts', 'Parts of the human brain',
  'Human endocrine hormones', 'Types of vitamins', 'Subatomic particles', 'Parts of a flower',
  'Types of chemical reactions', 'Types of biomes', 'Olympic sports', 'Track and field events',
  'Boxing weight classes', 'Musical notes', 'Key signatures', 'Orchestra sections',
  'Standard drum kit components', 'Music notation symbols', 'Woodwind instruments',
  'Brass instruments', 'Percussion instruments', 'Keyboard instruments', 'String instruments',
  'Web browsers', 'Operating systems', 'Apple products', 'Shakespeare plays',
  'Sherlock Holmes stories', 'Knights of the Round Table', 'Greek Titans',
  'Pixar movies', 'Studio Ghibli Movies', 'Wonders of the World', 'Minecraft biomes',
  'Minecraft Ore Blocks', 'Minecraft potions', 'Among Us colors', 'Among Us tasks',
  'Among Us maps', 'Fall Guys rounds', 'Mario Kart Items', 'Skyrim races',
  'Harry Potter Spells', 'Fallout factions', 'Halo weapons', 'Half-Life weapons',
  'Half-Life enemies', 'Portal items and elements', 'Final Fantasy summons',
  'Street Fighter moves', 'Nintendo consoles and handhelds', 'Video game consoles',
  'Gaming Consoles', 'Angry Birds birds', 'Signers of the US Declaration of Independence',
  'US Founding Fathers', 'Heisman Trophy Winners', 'NASCAR Cup Series tracks',
  'Active Formula 1 tracks', 'Active NFL stadiums', 'Active NBA Arenas',
  'College football bowl games', 'Professional wrestling championships',
  'Football positions', 'Basketball positions', 'Ice hockey positions', 'Rugby positions',
  'Cricket fielding positions', 'Tennis equipment', 'Badminton equipment',
  'Professional tennis equipment', 'Professional tennis tournaments', 'Types of sports balls',
  'Greek gods', 'Norse gods', 'Egyptian gods', 'Aztec deities', 'Trojan War figures',
  // --- AUDIT PASS: single-property game/show content that fell through to OPEN by
  // default. Each of these is a fixed roster shipped by one title.
  'Minecraft mobs', 'Minecraft Mobs', 'Minecraft blocks', 'Minecraft tools and weapons',
  'Pokemon from Gen 1', 'Pokémon starters', 'Star Wars Planets', 'Star Wars Ships',
  'Dark Souls weapons', 'Call of Duty weapons', 'Fallout creatures', 'Girl Scout cookies',
  'Farm animals', 'Resident Evil games', 'Grand Theft Auto games', 'Call of Duty games',
  'PlayStation Exclusive Games', 'Nintendo Switch Games', 'Elden Ring bosses',
]);

function classify(name) {
  if (FORCE_ENUM.has(name)) return ['ENUMERABLE', 'judgement: closed named set'];
  if (FORCE_OPEN.has(name)) return ['OPEN', 'judgement: unbounded / no agreed membership'];
  for (const re of ENUM_PAT) if (re.test(name)) return ['ENUMERABLE', `pattern ${re}`];
  for (const re of OPEN_PAT) if (re.test(name)) return ['OPEN', `pattern ${re}`];
  return ['OPEN', 'default: unclassified treated as open'];
}

const rows = l.CATEGORIES.map((c) => {
  const [verdict, why] = classify(c);
  return { c, n: (l.answersFor(c) || { size: 0 }).size, t: l.CATEGORY_TIER[c], verdict, why };
});
const en = rows.filter((r) => r.verdict === 'ENUMERABLE');
const op = rows.filter((r) => r.verdict === 'OPEN');
const med = (a) => { const s = a.map((r) => r.n).sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

console.log(`ACTIVE       ${rows.length}`);
console.log(`ENUMERABLE   ${en.length}  (${(100 * en.length / rows.length).toFixed(0)}%)`);
console.log(`OPEN         ${op.length}  (${(100 * op.length / rows.length).toFixed(0)}%)`);
console.log('');
console.log(`median list size: ENUMERABLE ${med(en)} | OPEN ${med(op)}`);
console.log(`ENUMERABLE by tier: ${[1, 2, 3].map((t) => `T${t}=${en.filter((r) => r.t === t).length}`).join('  ')}`);
console.log(`unclassified (fell through to OPEN): ${rows.filter((r) => r.why.startsWith('default')).length}`);
console.log('');
console.log('ENUMERABLE sample (20):');
en.slice(0, 20).forEach((r) => console.log(`  ${String(r.n).padStart(3)}  ${r.c}`));

fs.writeFileSync(
  'enumerability.tmp.tsv',
  `verdict\tsize\ttier\tcategory\twhy\n${rows.map((r) => `${r.verdict}\t${r.n}\tT${r.t}\t${r.c}\t${r.why}`).join('\n')}`
);
