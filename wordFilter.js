// wordFilter.js
// Single source of truth for words we never want to appear in Word Bomb:
// proper nouns (place names, nationalities/languages, brand names, calendar
// names) and common non-English entries. The public dictionary API
// (dictionaryapi.dev) happily returns definitions for things like MOROCCO and
// PAGINA, and the bundled botWords.txt frequency list contains hundreds of
// place/brand names because they're genuinely high-frequency tokens on the web.
//
// Both surfaces consume this filter so validation and the bot's word pool stay
// consistent: a word the bot could never legally play is also a word a human
// can't submit, and vice-versa.
//
// DESIGN NOTE — ambiguity: many place names double as ordinary English words
// (CHINA=porcelain, TURKEY=bird, POLISH=to polish, MARCH=to walk, JERSEY=shirt,
// SWEDE=vegetable, GUINEA=coin, CHILE=pepper, MOBILE=phone). Those are
// DELIBERATELY NOT in the blocklist — stripping them would break legitimate
// gameplay. We only block tokens whose overwhelmingly dominant sense is a
// proper noun / foreign word, so the filter fails toward keeping real words.

// Countries and clearly-proper-noun regions. (Ambiguous ones like CHINA,
// TURKEY, CHILE, GEORGIA, JORDAN, CHAD are intentionally omitted.)
const PLACES_COUNTRIES = [
  'afghanistan', 'albania', 'algeria', 'angola', 'argentina', 'armenia',
  'australia', 'austria', 'azerbaijan', 'bahamas', 'bahrain', 'bangladesh',
  'barbados', 'belarus', 'belgium', 'belize', 'bhutan', 'bolivia', 'botswana',
  'brazil', 'brunei', 'bulgaria', 'cambodia', 'cameroon', 'canada', 'colombia',
  'croatia', 'cuba', 'cyprus', 'czechia', 'denmark', 'djibouti', 'dominica',
  'ecuador', 'egypt', 'eritrea', 'estonia', 'ethiopia', 'finland', 'france',
  'gabon', 'gambia', 'germany', 'ghana', 'greece', 'grenada', 'guatemala',
  'guyana', 'haiti', 'honduras', 'hungary', 'iceland', 'india', 'indonesia',
  'iran', 'iraq', 'ireland', 'israel', 'italy', 'jamaica', 'japan', 'kazakhstan',
  'kenya', 'kiribati', 'kosovo', 'kuwait', 'kyrgyzstan', 'laos', 'latvia',
  'lebanon', 'lesotho', 'liberia', 'libya', 'lithuania', 'luxembourg',
  'madagascar', 'malawi', 'malaysia', 'maldives', 'mali', 'malta', 'mauritania',
  'mauritius', 'mexico', 'moldova', 'monaco', 'mongolia', 'montenegro',
  'morocco', 'mozambique', 'myanmar', 'namibia', 'nauru', 'nepal', 'netherlands',
  'nicaragua', 'niger', 'nigeria', 'norway', 'oman', 'pakistan', 'palau',
  'panama', 'paraguay', 'peru', 'philippines', 'poland', 'portugal', 'qatar',
  'romania', 'russia', 'rwanda', 'samoa', 'senegal', 'serbia', 'seychelles',
  'singapore', 'slovakia', 'slovenia', 'somalia', 'spain', 'sudan', 'suriname',
  'swaziland', 'sweden', 'switzerland', 'syria', 'taiwan', 'tajikistan',
  'tanzania', 'thailand', 'togo', 'tonga', 'tunisia', 'turkmenistan', 'tuvalu',
  'uganda', 'ukraine', 'uruguay', 'uzbekistan', 'vanuatu', 'venezuela',
  'vietnam', 'yemen', 'zambia', 'zimbabwe', 'europe', 'asia', 'africa',
  'antarctica', 'scandinavia', 'siberia', 'sahara', 'amazonia', 'patagonia',
];

// US states (minus ambiguous: GEORGIA — girl's name, VIRGINIA — name).
// We keep unambiguous state names; those that are common given-names are still
// clearly proper nouns in this context, so they're included.
const PLACES_US_STATES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'hawaii', 'idaho', 'illinois',
  'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland',
  'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri',
  'montana', 'nebraska', 'nevada', 'ohio', 'oklahoma', 'oregon',
  'pennsylvania', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
  'washington', 'wisconsin', 'wyoming',
];

// Major world/US cities. (Ambiguous ones like READING, MOBILE, NICE, BATH are
// intentionally omitted.)
const PLACES_CITIES = [
  'london', 'paris', 'berlin', 'madrid', 'barcelona', 'moscow', 'beijing',
  'shanghai', 'tokyo', 'osaka', 'kyoto', 'bangkok', 'mumbai', 'delhi',
  'kolkata', 'karachi', 'cairo', 'lagos', 'nairobi', 'dubai', 'istanbul',
  'athens', 'rome', 'milan', 'venice', 'naples', 'munich', 'hamburg',
  'frankfurt', 'vienna', 'prague', 'warsaw', 'budapest', 'amsterdam',
  'brussels', 'lisbon', 'dublin', 'edinburgh', 'glasgow', 'stockholm',
  'oslo', 'helsinki', 'copenhagen', 'zurich', 'geneva', 'toronto', 'montreal',
  'vancouver', 'ottawa', 'chicago', 'boston', 'seattle', 'denver', 'austin',
  'dallas', 'houston', 'atlanta', 'miami', 'philadelphia', 'phoenix',
  'detroit', 'minneapolis', 'baltimore', 'brooklyn', 'manhattan', 'sydney',
  'melbourne', 'brisbane', 'perth', 'auckland', 'wellington', 'johannesburg',
  'toronto', 'jakarta', 'manila', 'seoul', 'hanoi', 'saigon', 'lima',
  'bogota', 'santiago', 'caracas', 'havana',
];

// Nationalities / languages / demonyms. (Ambiguous ones like FRENCH=cut style,
// POLISH=to polish, TURKEY, CHINA are omitted; DUTCH, WELSH, etc. included as
// clearly proper adjectives.)
const NATIONALITIES = [
  'american', 'african', 'european', 'asian', 'canadian', 'mexican',
  'brazilian', 'argentine', 'peruvian', 'english', 'british', 'scottish',
  'irish', 'welsh', 'german', 'spanish', 'italian', 'portuguese', 'dutch',
  'belgian', 'swiss', 'austrian', 'swedish', 'norwegian', 'danish', 'finnish',
  'russian', 'ukrainian', 'romanian', 'bulgarian', 'greek',
  'croatian', 'serbian', 'hungarian', 'czech', 'japanese', 'chinese', 'korean',
  'vietnamese', 'thai', 'indonesian', 'malaysian', 'filipino', 'indian',
  'pakistani', 'egyptian', 'moroccan', 'nigerian', 'kenyan', 'ethiopian',
  'australian', 'israeli', 'iranian', 'iraqi', 'saudi', 'turkish',
];

// Calendar names (days, months). Ambiguous ones (MAY=modal, MARCH=to march,
// AUGUST=majestic) are omitted.
const CALENDAR = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'april', 'june', 'july', 'september', 'october',
  'november', 'december',
];

// Brand / company / product names. Deliberately excludes brands whose tokens
// are ordinary English words (APPLE=fruit, AMAZON=warrior/river, WINDOWS=panes,
// MARVEL=to marvel, ORACLE=seer, NESTLE=to nestle, FORD=to ford) so we don't
// strip legitimate vocabulary.
const BRANDS = [
  'google', 'facebook', 'microsoft', 'netflix', 'youtube',
  'twitter', 'instagram', 'tiktok', 'spotify', 'paypal', 'ebay', 'walmart',
  'costco', 'starbucks', 'mcdonalds', 'nike', 'adidas', 'gucci', 'toyota',
  'honda', 'nissan', 'chevrolet', 'ferrari', 'porsche', 'volkswagen',
  'samsung', 'nintendo', 'playstation', 'xbox', 'nvidia', 'intel',
  'reddit', 'linkedin', 'pinterest', 'snapchat', 'whatsapp', 'android',
  'iphone', 'ipad', 'macbook', 'pixar', 'disney',
  'pepsi', 'kellogg', 'verizon', 'comcast', 'boeing', 'airbus',
];

// Religious / mythological proper nouns commonly present in web frequency lists.
const PROPER_MISC = [
  'jesus', 'christ', 'christian', 'muhammad', 'buddha', 'allah', 'moses',
  'zeus', 'hades', 'poseidon', 'apollo', 'athena', 'thor', 'odin', 'loki',
];

// Common NON-ENGLISH tokens that the dictionary API nonetheless returns (Latin,
// Spanish, Italian, French, etc.). Kept small and only clearly-foreign words
// that don't collide with English.
const FOREIGN = [
  'pagina', 'gracias', 'senor', 'senora', 'senorita', 'hola', 'bueno',
  'bienvenido', 'ciao', 'grazie', 'prego', 'bonjour', 'merci', 'oui',
  'guten', 'danke', 'nein', 'hallo', 'pero', 'como', 'porque',
  'donde', 'cuando', 'siempre', 'mundo', 'agua', 'casa', 'nino', 'nina',
  'hombre', 'mujer', 'tiempo', 'dinero', 'trabajo', 'ipsum', 'lorem', 'dolor',
  'amet', 'quod', 'quia', 'sunt', 'esse', 'enim', 'unde', 'deine', 'meine',
];

// Build the master set once. Everything stored lowercase.
const BLOCKLIST = new Set(
  [].concat(
    PLACES_COUNTRIES,
    PLACES_US_STATES,
    PLACES_CITIES,
    NATIONALITIES,
    CALENDAR,
    BRANDS,
    PROPER_MISC,
    FOREIGN,
  ).map((w) => w.trim().toLowerCase()),
);

/**
 * True if `word` is a proper noun / place name / foreign entry we never want in
 * Word Bomb. Case-insensitive; whitespace-trimmed.
 */
function isDisallowedWord(word) {
  if (typeof word !== 'string') return false;
  return BLOCKLIST.has(word.trim().toLowerCase());
}

/**
 * Returns a new array with every disallowed word removed. Used to clean the
 * bot's word pool at load time.
 */
function filterWords(words) {
  return words.filter((w) => !isDisallowedWord(w));
}

module.exports = { isDisallowedWord, filterWords, BLOCKLIST };
