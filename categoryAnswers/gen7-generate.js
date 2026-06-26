// gen7-generate.js  [night/categories-generate — branch scratch, generator]
// Generates the gen7 Category Blitz batch and ENFORCES THE CATEGORY RULE with a
// machine filter before anything is written. Run:  node categoryAnswers/gen7-generate.js
//
// THE RULE (baked in here so future generation can't violate it):
//   A valid category has a BOUNDED, finite-ish answer space and almost every
//   valid answer is <=3 words. The answer is a NAMED THING (object, brand,
//   character, food, place, animal) — NOT a quote, excuse, reason, headline, or
//   open-ended action.
//   GOOD: "European capitals", "Marvel superheroes", "Pizza toppings", "NBA teams",
//         "Chess pieces", "Greek gods".
//   BAD (rejected): sentence/phrase answers ("Things teachers say"), open-ended /
//         infinite prompts ("Things you google at 3am"), or anything whose typical
//         answers run 4+ words.
//
// Each candidate ships a SEED accept-list of short example answers (lowercase) —
// enough to (a) prove the answer space is real + short for the filter, and (b)
// hit the fast offline lookup for the obvious answers. The Haiku judge covers the
// long tail (same pattern the existing gen* batches rely on).

const MAX_ANSWER_WORDS = 3;     // every example answer must be <= this many words
const MIN_EXAMPLES = 6;         // need a few real answers to prove the space exists
// Name shapes that signal a phrase/open-ended prompt — reject outright.
const BANNED_NAME_PATTERNS = [
  /^things (you|your|that|a|an|in a|teachers|moms?|dads?)/i,
  /\b(reasons|excuses|headlines|quotes?|things .* say|what .* says?)\b/i,
  /\bgoogle\b/i,
];

// ---------------------------------------------------------------------------
// 100 NEW candidates, spread across domains. Names are plain NOUN-SET prompts;
// every example answer is a short named thing (<=3 words).
// ---------------------------------------------------------------------------
const CANDIDATES = [
  // ---- Geography ----
  { name: 'European capitals', ex: ['paris', 'london', 'berlin', 'madrid', 'rome', 'vienna', 'oslo', 'athens', 'lisbon', 'warsaw', 'dublin', 'prague'] },
  { name: 'US state capitals', ex: ['austin', 'denver', 'boston', 'phoenix', 'albany', 'atlanta', 'sacramento', 'columbus', 'nashville', 'helena'] },
  { name: 'African countries', ex: ['egypt', 'kenya', 'nigeria', 'morocco', 'ghana', 'tanzania', 'algeria', 'angola', 'zambia', 'mali'] },
  { name: 'Asian countries', ex: ['japan', 'china', 'india', 'thailand', 'vietnam', 'nepal', 'korea', 'laos', 'mongolia', 'qatar'] },
  { name: 'Oceans and seas', ex: ['pacific', 'atlantic', 'indian', 'arctic', 'caribbean', 'mediterranean', 'baltic', 'red sea', 'black sea', 'coral sea'] },
  { name: 'Mountain ranges', ex: ['alps', 'andes', 'himalayas', 'rockies', 'urals', 'pyrenees', 'atlas', 'appalachians', 'cascades', 'caucasus'] },
  { name: 'World rivers', ex: ['nile', 'amazon', 'thames', 'danube', 'ganges', 'yangtze', 'mississippi', 'rhine', 'volga', 'mekong'] },
  { name: 'US states', ex: ['texas', 'ohio', 'maine', 'utah', 'nevada', 'georgia', 'florida', 'oregon', 'kansas', 'iowa'] },
  { name: 'Canadian provinces', ex: ['ontario', 'quebec', 'alberta', 'manitoba', 'nova scotia', 'yukon', 'nunavut', 'saskatchewan'] },
  { name: 'Famous landmarks', ex: ['eiffel tower', 'big ben', 'colosseum', 'taj mahal', 'pyramids', 'statue of liberty', 'great wall', 'stonehenge'] },

  // ---- Animals & nature ----
  { name: 'Jungle animals', ex: ['tiger', 'jaguar', 'monkey', 'gorilla', 'sloth', 'toucan', 'anaconda', 'leopard', 'parrot', 'panther'] },
  { name: 'Ocean animals', ex: ['shark', 'whale', 'dolphin', 'octopus', 'jellyfish', 'seahorse', 'stingray', 'clownfish', 'lobster', 'eel'] },
  { name: 'Birds', ex: ['eagle', 'robin', 'owl', 'penguin', 'parrot', 'flamingo', 'sparrow', 'crow', 'hawk', 'pelican'] },
  { name: 'Insects', ex: ['ant', 'bee', 'wasp', 'beetle', 'moth', 'dragonfly', 'ladybug', 'grasshopper', 'cricket', 'firefly'] },
  { name: 'Cat breeds', ex: ['siamese', 'persian', 'maine coon', 'bengal', 'ragdoll', 'sphynx', 'tabby', 'calico', 'scottish fold', 'munchkin'] },
  { name: 'Dinosaurs', ex: ['t rex', 'triceratops', 'stegosaurus', 'velociraptor', 'brontosaurus', 'pterodactyl', 'spinosaurus', 'raptor', 'ankylosaurus'] },
  { name: 'Reptiles', ex: ['snake', 'lizard', 'turtle', 'crocodile', 'alligator', 'iguana', 'gecko', 'chameleon', 'cobra', 'python'] },
  { name: 'Farm animals', ex: ['cow', 'pig', 'chicken', 'horse', 'sheep', 'goat', 'duck', 'turkey', 'donkey', 'rooster'] },
  { name: 'Trees', ex: ['oak', 'pine', 'maple', 'birch', 'willow', 'redwood', 'palm', 'cedar', 'spruce', 'aspen'] },
  { name: 'Flowers', ex: ['rose', 'tulip', 'daisy', 'sunflower', 'lily', 'orchid', 'daffodil', 'iris', 'poppy', 'marigold'] },

  // ---- Food & drink ----
  { name: 'Fruits', ex: ['apple', 'banana', 'mango', 'grape', 'kiwi', 'peach', 'plum', 'cherry', 'pear', 'papaya'] },
  { name: 'Vegetables', ex: ['carrot', 'broccoli', 'spinach', 'potato', 'onion', 'celery', 'pepper', 'kale', 'cucumber', 'beet'] },
  { name: 'Types of cheese', ex: ['cheddar', 'brie', 'gouda', 'feta', 'mozzarella', 'parmesan', 'swiss', 'blue cheese', 'gruyere', 'provolone'] },
  { name: 'Breakfast cereals', ex: ['cheerios', 'froot loops', 'lucky charms', 'corn flakes', 'frosted flakes', 'cap n crunch', 'chex', 'raisin bran'] },
  { name: 'Cocktails', ex: ['margarita', 'mojito', 'martini', 'cosmopolitan', 'daiquiri', 'old fashioned', 'negroni', 'mai tai', 'mimosa'] },
  { name: 'Coffee drinks', ex: ['latte', 'espresso', 'cappuccino', 'americano', 'mocha', 'macchiato', 'cold brew', 'flat white', 'cortado'] },
  { name: 'Sandwiches', ex: ['blt', 'club', 'reuben', 'grilled cheese', 'panini', 'sub', 'po boy', 'cuban', 'philly', 'monte cristo'] },
  { name: 'Sushi types', ex: ['california roll', 'spicy tuna', 'nigiri', 'sashimi', 'tempura roll', 'dragon roll', 'eel', 'salmon', 'tuna roll'] },
  { name: 'Spices and herbs', ex: ['basil', 'oregano', 'cumin', 'paprika', 'thyme', 'cinnamon', 'ginger', 'turmeric', 'rosemary', 'nutmeg'] },
  { name: 'Cake types', ex: ['chocolate', 'red velvet', 'carrot', 'cheesecake', 'pound cake', 'sponge', 'angel food', 'bundt', 'funfetti'] },
  { name: 'Mexican foods', ex: ['taco', 'burrito', 'quesadilla', 'enchilada', 'nachos', 'tamale', 'guacamole', 'churro', 'fajita', 'salsa'] },
  { name: 'Italian dishes', ex: ['lasagna', 'spaghetti', 'risotto', 'ravioli', 'gnocchi', 'carbonara', 'tiramisu', 'bruschetta', 'minestrone'] },
  { name: 'Cooking methods', ex: ['boiling', 'frying', 'grilling', 'baking', 'roasting', 'steaming', 'sauteing', 'poaching', 'broiling'] },
  { name: 'Tea types', ex: ['green tea', 'black tea', 'chamomile', 'earl grey', 'oolong', 'matcha', 'peppermint', 'chai', 'jasmine'] },

  // ---- Pop culture: screen ----
  { name: 'Marvel superheroes', ex: ['iron man', 'spider man', 'thor', 'hulk', 'captain america', 'black widow', 'doctor strange', 'wolverine', 'black panther'] },
  { name: 'DC superheroes', ex: ['batman', 'superman', 'wonder woman', 'flash', 'aquaman', 'green lantern', 'cyborg', 'robin', 'supergirl'] },
  { name: 'Disney princesses', ex: ['cinderella', 'ariel', 'belle', 'jasmine', 'mulan', 'elsa', 'aurora', 'tiana', 'moana', 'rapunzel'] },
  { name: 'Star Wars characters', ex: ['luke', 'yoda', 'vader', 'leia', 'han solo', 'chewbacca', 'r2d2', 'obi wan', 'kylo ren', 'rey'] },
  { name: 'Harry Potter characters', ex: ['harry', 'hermione', 'ron', 'dumbledore', 'snape', 'hagrid', 'voldemort', 'draco', 'sirius', 'dobby'] },
  { name: 'Simpsons characters', ex: ['homer', 'bart', 'lisa', 'marge', 'maggie', 'ned flanders', 'mr burns', 'milhouse', 'moe', 'krusty'] },
  { name: 'Sitcoms', ex: ['friends', 'seinfeld', 'the office', 'cheers', 'frasier', 'community', 'parks and rec', 'how i met your mother'] },
  { name: 'Horror movies', ex: ['halloween', 'scream', 'it', 'the shining', 'saw', 'jaws', 'psycho', 'the ring', 'hereditary', 'sinister'] },
  { name: 'Studio Ghibli movies', ex: ['spirited away', 'totoro', 'ponyo', 'howls moving castle', 'princess mononoke', 'kikis delivery service'] },
  { name: 'Pixar characters', ex: ['woody', 'buzz', 'nemo', 'dory', 'sulley', 'mike', 'lightning mcqueen', 'mr incredible', 'remy', 'wall e'] },
  { name: 'Action movie stars', ex: ['stallone', 'schwarzenegger', 'bruce willis', 'jason statham', 'keanu reeves', 'tom cruise', 'vin diesel'] },
  { name: 'Famous wizards', ex: ['gandalf', 'dumbledore', 'merlin', 'harry potter', 'saruman', 'voldemort', 'doctor strange', 'sabrina'] },

  // ---- Games & anime ----
  { name: 'Mario characters', ex: ['mario', 'luigi', 'peach', 'bowser', 'yoshi', 'toad', 'wario', 'daisy', 'donkey kong', 'koopa'] },
  { name: 'Zelda characters', ex: ['link', 'zelda', 'ganon', 'navi', 'impa', 'tingle', 'midna', 'sheik', 'epona'] },
  { name: 'Sonic characters', ex: ['sonic', 'tails', 'knuckles', 'amy', 'shadow', 'dr eggman', 'silver', 'cream', 'rouge'] },
  { name: 'Street Fighter characters', ex: ['ryu', 'ken', 'chun li', 'guile', 'blanka', 'dhalsim', 'zangief', 'm bison', 'cammy'] },
  { name: 'Pokemon types', ex: ['fire', 'water', 'grass', 'electric', 'psychic', 'ghost', 'dragon', 'fairy', 'rock', 'steel'] },
  { name: 'Naruto characters', ex: ['naruto', 'sasuke', 'sakura', 'kakashi', 'itachi', 'hinata', 'gaara', 'jiraiya', 'rock lee'] },
  { name: 'Dragon Ball characters', ex: ['goku', 'vegeta', 'gohan', 'piccolo', 'frieza', 'krillin', 'trunks', 'cell', 'bulma'] },
  { name: 'One Piece characters', ex: ['luffy', 'zoro', 'nami', 'sanji', 'chopper', 'robin', 'usopp', 'franky', 'brook'] },
  { name: 'Fighting games', ex: ['street fighter', 'tekken', 'mortal kombat', 'smash bros', 'guilty gear', 'soul calibur', 'injustice'] },
  { name: 'Among Us colors', ex: ['red', 'blue', 'green', 'pink', 'orange', 'yellow', 'black', 'white', 'purple', 'cyan'] },
  { name: 'Chess pieces', ex: ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'] },
  { name: 'Card games', ex: ['poker', 'blackjack', 'uno', 'solitaire', 'go fish', 'rummy', 'spades', 'hearts', 'bridge', 'euchre'] },

  // ---- Music ----
  { name: 'Music genres', ex: ['rock', 'jazz', 'hip hop', 'country', 'reggae', 'blues', 'pop', 'metal', 'techno', 'funk'] },
  { name: 'String instruments', ex: ['guitar', 'violin', 'cello', 'harp', 'banjo', 'ukulele', 'bass', 'mandolin', 'viola', 'sitar'] },
  { name: 'Boy bands', ex: ['nsync', 'backstreet boys', 'one direction', 'bts', 'jonas brothers', 'new kids on the block', 'westlife'] },
  { name: 'Beatles songs', ex: ['hey jude', 'let it be', 'yesterday', 'come together', 'help', 'something', 'in my life', 'blackbird'] },
  { name: 'Famous DJs', ex: ['calvin harris', 'david guetta', 'skrillex', 'marshmello', 'tiesto', 'avicii', 'deadmau5', 'zedd'] },
  { name: 'Rappers', ex: ['drake', 'eminem', 'jay z', 'kanye', 'kendrick', 'nicki minaj', 'travis scott', 'lil wayne', 'cardi b'] },

  // ---- Sports ----
  { name: 'Olympic sports', ex: ['swimming', 'gymnastics', 'fencing', 'archery', 'rowing', 'judo', 'diving', 'boxing', 'sprinting'] },
  { name: 'NFL teams', ex: ['cowboys', 'patriots', 'packers', 'eagles', 'giants', 'steelers', 'chiefs', 'raiders', 'bears', 'jets'] },
  { name: 'Soccer clubs', ex: ['barcelona', 'real madrid', 'manchester united', 'liverpool', 'chelsea', 'arsenal', 'juventus', 'bayern'] },
  { name: 'Tennis terms', ex: ['ace', 'serve', 'volley', 'deuce', 'love', 'fault', 'rally', 'backhand', 'forehand', 'lob'] },
  { name: 'Martial arts', ex: ['karate', 'judo', 'taekwondo', 'kung fu', 'jiu jitsu', 'muay thai', 'boxing', 'aikido', 'krav maga'] },
  { name: 'Things on a golf course', ex: ['tee', 'green', 'bunker', 'flag', 'cart', 'hole', 'fairway', 'rough', 'club', 'caddy'] },
  { name: 'Baseball positions', ex: ['pitcher', 'catcher', 'shortstop', 'first base', 'second base', 'third base', 'center field', 'left field'] },
  { name: 'Water sports', ex: ['surfing', 'kayaking', 'rowing', 'sailing', 'diving', 'snorkeling', 'water polo', 'wakeboarding', 'rafting'] },

  // ---- Science & space ----
  { name: 'Planets', ex: ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'] },
  { name: 'Chemical elements', ex: ['hydrogen', 'helium', 'oxygen', 'carbon', 'gold', 'iron', 'neon', 'sodium', 'silver', 'copper'] },
  { name: 'Body parts', ex: ['elbow', 'knee', 'liver', 'lung', 'spine', 'ankle', 'wrist', 'kidney', 'shoulder', 'thumb'] },
  { name: 'Bones in the body', ex: ['femur', 'skull', 'rib', 'spine', 'pelvis', 'jaw', 'tibia', 'collarbone', 'kneecap', 'sternum'] },
  { name: 'Weather phenomena', ex: ['rain', 'snow', 'hail', 'fog', 'thunder', 'lightning', 'tornado', 'hurricane', 'blizzard', 'drizzle'] },
  { name: 'Constellations', ex: ['orion', 'big dipper', 'cassiopeia', 'leo', 'scorpius', 'ursa major', 'gemini', 'aquarius', 'pegasus'] },
  { name: 'Branches of science', ex: ['biology', 'chemistry', 'physics', 'geology', 'astronomy', 'botany', 'zoology', 'ecology', 'genetics'] },
  { name: 'Gemstones', ex: ['diamond', 'ruby', 'emerald', 'sapphire', 'opal', 'topaz', 'amethyst', 'jade', 'pearl', 'garnet'] },
  { name: 'Shapes', ex: ['circle', 'square', 'triangle', 'hexagon', 'pentagon', 'octagon', 'rhombus', 'oval', 'trapezoid', 'cube'] },
  { name: 'Metals', ex: ['gold', 'silver', 'iron', 'copper', 'aluminum', 'titanium', 'zinc', 'nickel', 'platinum', 'bronze'] },

  // ---- History & myth ----
  { name: 'Greek gods', ex: ['zeus', 'hera', 'poseidon', 'athena', 'apollo', 'ares', 'hades', 'hermes', 'artemis', 'aphrodite'] },
  { name: 'Norse gods', ex: ['odin', 'thor', 'loki', 'freya', 'baldur', 'heimdall', 'tyr', 'frigg', 'njord'] },
  { name: 'Egyptian gods', ex: ['ra', 'anubis', 'osiris', 'isis', 'horus', 'set', 'thoth', 'bastet', 'sobek'] },
  { name: 'Mythical creatures', ex: ['dragon', 'unicorn', 'phoenix', 'griffin', 'mermaid', 'centaur', 'minotaur', 'kraken', 'cyclops'] },
  { name: 'US presidents', ex: ['lincoln', 'washington', 'roosevelt', 'kennedy', 'obama', 'reagan', 'jefferson', 'truman', 'nixon'] },
  { name: 'Ancient civilizations', ex: ['romans', 'greeks', 'egyptians', 'mayans', 'aztecs', 'incas', 'vikings', 'persians', 'babylonians'] },
  { name: 'Famous painters', ex: ['picasso', 'van gogh', 'da vinci', 'monet', 'rembrandt', 'dali', 'warhol', 'michelangelo', 'frida kahlo'] },
  { name: 'Roman numerals', ex: ['i', 'v', 'x', 'l', 'c', 'd', 'm'] },

  // ---- Everyday objects ----
  { name: 'Kitchen utensils', ex: ['spatula', 'whisk', 'ladle', 'tongs', 'peeler', 'grater', 'colander', 'rolling pin', 'spoon', 'fork'] },
  { name: 'Tools in a toolbox', ex: ['hammer', 'screwdriver', 'wrench', 'pliers', 'drill', 'level', 'tape measure', 'saw', 'chisel'] },
  { name: 'Office supplies', ex: ['stapler', 'paperclip', 'tape', 'pen', 'pencil', 'highlighter', 'binder', 'sticky notes', 'scissors'] },
  { name: 'Things in a bathroom', ex: ['toothbrush', 'towel', 'soap', 'mirror', 'razor', 'shampoo', 'toilet', 'sink', 'bathmat', 'comb'] },
  { name: 'Board games', ex: ['monopoly', 'clue', 'scrabble', 'risk', 'sorry', 'life', 'candy land', 'operation', 'battleship'] },
  { name: 'Musical genres of dance', ex: ['salsa', 'tango', 'waltz', 'ballet', 'hip hop', 'tap', 'breakdance', 'foxtrot', 'swing'] },
  { name: 'Things with wheels', ex: ['car', 'bike', 'skateboard', 'wheelchair', 'wagon', 'shopping cart', 'scooter', 'roller skates', 'truck'] },
  { name: 'Things in a first aid kit', ex: ['bandage', 'gauze', 'scissors', 'tweezers', 'antiseptic', 'tape', 'gloves', 'thermometer'] },
  { name: 'Camping gear', ex: ['tent', 'sleeping bag', 'lantern', 'compass', 'canteen', 'cooler', 'tarp', 'flashlight', 'matches'] },
  { name: 'Things at a beach', ex: ['umbrella', 'towel', 'sandcastle', 'cooler', 'surfboard', 'seashell', 'sunscreen', 'bucket', 'kite'] },

  // ---- Brands & misc ----
  { name: 'Car brands', ex: ['toyota', 'honda', 'ford', 'bmw', 'tesla', 'audi', 'kia', 'mazda', 'subaru', 'jeep'] },
  { name: 'Phone brands', ex: ['apple', 'samsung', 'google', 'motorola', 'nokia', 'oneplus', 'huawei', 'sony', 'lg'] },
  { name: 'Clothing brands', ex: ['nike', 'adidas', 'gucci', 'zara', 'levis', 'puma', 'gap', 'uniqlo', 'champion'] },
  { name: 'Airlines', ex: ['delta', 'united', 'american', 'southwest', 'jetblue', 'emirates', 'lufthansa', 'ryanair', 'qatar'] },
  { name: 'Streaming services', ex: ['netflix', 'hulu', 'disney plus', 'hbo max', 'prime video', 'peacock', 'paramount plus', 'apple tv'] },
  { name: 'Social media apps', ex: ['instagram', 'tiktok', 'twitter', 'snapchat', 'facebook', 'reddit', 'youtube', 'discord', 'pinterest'] },
  { name: 'Colors', ex: ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'teal', 'maroon', 'turquoise'] },
  { name: 'Languages', ex: ['english', 'spanish', 'french', 'mandarin', 'arabic', 'hindi', 'german', 'japanese', 'portuguese'] },
  { name: 'Zodiac signs', ex: ['aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo', 'libra', 'scorpio', 'pisces'] },
  { name: 'Months of the year', ex: ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september'] },
  // ---- a few intentional RULE-VIOLATORS to prove the filter bites ----
  { name: 'Things you say when you stub your toe', ex: ['ow that really hurt', 'why is that there', 'son of a biscuit'] },
  { name: 'Excuses for being late to work', ex: ['the traffic was insane today', 'my alarm did not go off'] },
];

// ---------------------------------------------------------------------------
// FILTER + DEDUPE + EMIT
// ---------------------------------------------------------------------------
const existing = Object.keys(require('../categoryAnswers'));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const existingNorm = new Set(existing.map(norm));

const kept = {};
const keptNorm = new Set();
const rejects = [];

for (const cand of CANDIDATES) {
  const reasons = [];
  if (BANNED_NAME_PATTERNS.some((re) => re.test(cand.name))) reasons.push('phrase/open-ended name');
  if (!Array.isArray(cand.ex) || cand.ex.length < MIN_EXAMPLES) reasons.push(`<${MIN_EXAMPLES} examples`);
  const longOnes = (cand.ex || []).filter((a) => a.trim().split(/\s+/).length > MAX_ANSWER_WORDS);
  if (longOnes.length) reasons.push(`answers >${MAX_ANSWER_WORDS} words: ${longOnes.slice(0, 2).join(', ')}`);
  const n = norm(cand.name);
  if (existingNorm.has(n) || keptNorm.has(n)) reasons.push('duplicate of existing/earlier');

  if (reasons.length) {
    rejects.push({ name: cand.name, reasons });
    continue;
  }
  kept[cand.name] = Array.from(new Set(cand.ex.map((a) => a.toLowerCase().trim())));
  keptNorm.add(n);
}

// Emit gen7.js
const fs = require('fs');
const path = require('path');
let out = '// gen7.js  [night/categories-generate]\n';
out += '// Auto-generated by gen7-generate.js — 100-candidate batch, machine-filtered to\n';
out += '// THE CATEGORY RULE (bounded set, answers <=3 words). Seed accept-lists; the\n';
out += '// Haiku judge covers the long tail. All entries lowercase. Keys MUST match the\n';
out += '// entries appended to CATEGORIES in categoryBlitzLogic.js exactly.\n';
out += 'module.exports = {\n';
for (const [name, arr] of Object.entries(kept)) {
  const key = JSON.stringify(name);
  const vals = arr.map((a) => JSON.stringify(a)).join(', ');
  out += `  ${key}: new Set([${vals}]),\n`;
}
out += '};\n';
fs.writeFileSync(path.join(__dirname, 'gen7.js'), out);

// Report
console.log('=== gen7 generation report ===');
console.log('existing categories (with lists):', existing.length);
console.log('candidates generated:', CANDIDATES.length);
console.log('auto-rejected:', rejects.length);
for (const r of rejects) console.log('  REJECT:', r.name, '—', r.reasons.join('; '));
console.log('added (kept):', Object.keys(kept).length);
console.log('new total (existing + added):', existing.length + Object.keys(kept).length);
console.log('\nNAMES TO APPEND to RAW_CATEGORIES:');
console.log(Object.keys(kept).map((k) => `  ${JSON.stringify(k)},`).join('\n'));
