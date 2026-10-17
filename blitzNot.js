// blitzNot.js — the judge for Category Blitz "NOT" categories (Andy oct17: "YO I LOVE THE CATEGORIES THAT ARE LIKE
// 'things you should NOT microwave' ... like 99% of responses (nouns) should work ... something crazy like 'me' wont go
// through even though technically it works").
//
// A list with `mode: "not"` in blitzLists.json still scores its curated answers first (and bots only ever play those).
// On a list miss, this judge decides, in order:
//   1. SAFE — the answer fits the POSITIVE prompt (soup, popcorn, a mug for "shouldn't microwave") → reject `safe_item`,
//      with the list's own toast ("YOU CAN MICROWAVE THAT 🙄"). A curated answer is never safe.
//   2. PERSON — me / myself / you / him / her … → accept ("my little brother", "grandma" are plain nouns, step 3).
//   3. NOUN — the answer's HEAD noun ("my DOG", "a dead PHONE", "BOWL with gold trim") is a real noun → accept.
//   4. anything else (lol, quickly, happy, gibberish) → the usual `not_on_list`.
// Any word on the blocked list rejects the whole answer, so a crude modifier can't ride in on a real noun.
//
// THE NOUN SET is derived from the curated lists themselves (no new dependency): the head word of every answer on a
// THING list, counted only when it heads answers on 2+ different lists. Title / name / phrase lists are skipped — they
// teach names and chat-speak, not nouns ("Happy" the dwarf, "Dr. No", "lol"). ~9k nouns; measured oct17 on "Things you
// shouldn't microwave": 119/120 blind-probe guesses, 37/37 random nouns, 57/59 rarer nouns accepted; 1/20 non-words
// and 0/8 gibberish let through.
const BLITZ_LISTS = require('./blitzLists');
const { isBlockedForDisplay } = require('./blockedTerms');

// little words dropped before finding the head (determiners + the descriptors kids bolt on for the joke)
const STOP = new Set(['a', 'an', 'the', 'my', 'your', 'his', 'her', 'their', 'our', 'some', 'this', 'that', 'whole', 'entire',
  'big', 'small', 'little', 'giant', 'tiny', 'old', 'new', 'dead', 'live', 'living', 'used', 'raw', 'frozen', 'full', 'empty',
  'wet', 'hot', 'cold']);
// "X with/of/in … Y" → the head is X's last word ("bag of chips" → bag)
const PREP = new Set(['with', 'of', 'in', 'on', 'from', 'inside', 'full', 'made', 'without', 'covered', 'filled', 'and']);
// mild swears blockedTerms lets through (it only guards slurs + hard profanity) — still out of a school game here,
// where ANY noun can score and a modifier is never checked against a list
const MILD = new Set(['damn', 'damned', 'hell', 'crap', 'crappy', 'ass', 'asses', 'piss', 'pissy', 'sucks', 'freaking',
  'frickin', 'fricking', 'friggin']);
const PEOPLE = new Set(['me', 'myself', 'you', 'yourself', 'him', 'her', 'them', 'us', 'we', 'i', 'u']);
// closed-class words that are never "a thing"
const NEVER = new Set(('yes no yeah yep nope ok okay idk lol lmao bruh hello hi hey bye wow omg ugh hmm huh very really never '
  + 'always sometimes often quickly slowly fast happy sad beautiful pretty ugly good bad nice cool great awesome big small hot '
  + 'cold blue red green yellow because maybe please thanks thank and or but the a an is are was be to of in on at it this that '
  + 'these those what why how when where who just only also too not').split(' '));
const PHRASE_LISTS = /^(Things you do|Ways|Household chores|Sleepover activities|Dance styles|Hobbies|Internet slang|Things you call|Cute nicknames|Comic book sound|Animal sounds|Words |Rhymes|Excuses|Lies|Red flags|Reasons|Things kids get grounded|Things that get you sent|Things that can ruin|Things that cause emotional)/;
const TITLE_LISTS = /(films|movies|books|shows|games|characters|members|villains|heroes|celebrities|singers|rappers|athletes|YouTubers|streamers|bands|albums|songs|dwarfs|cats|dogs|robots|duos|presidents|monarchs|names|mascots|brainrot|costumes|2010s|send in a group chat|Superpowers|Olympic|legends|fighters|agents|champions|gods|Muppets|family|gang|team|princesses|animatronics)/i;

const word = (w) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/'s$/, '')
  .replace(/[^a-z0-9]/g, '');
const words = (s) => String(s == null ? '' : s).split(/\s+/).map(word).filter(Boolean);
function fold(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(sses|xes|zes|ches|shes|oes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
function headOf(ws) {
  const cut = ws.findIndex((w, i) => i > 0 && PREP.has(w));
  const core = (cut > 0 ? ws.slice(0, cut) : ws).filter((w) => !STOP.has(w));
  return core[core.length - 1] || null;
}

// LAZY: both sets are built on the first NOT-category judgement, never at require time — a server boot shouldn't pay
// ~0.2 s of list scanning for a category it may not deal (oct17: it tipped the integration boot test past 10 s).
let NOUNS = null;
let SAFE = null;
function buildNouns() {
  const seenIn = new Map();
  for (const [name, l] of BLITZ_LISTS.LISTS) {
    if (l.pack === 'wordplay' || PHRASE_LISTS.test(name) || TITLE_LISTS.test(name)) continue;
    for (const a of l.answers) {
      const h = headOf(words(a));
      if (!h || h.length < 2 || NEVER.has(h)) continue;
      const f = fold(h);
      if (!seenIn.has(f)) seenIn.set(f, new Set());
      seenIn.get(f).add(name);
    }
  }
  return new Set([...seenIn].filter(([, n]) => n.size >= 2).map(([w]) => w));
}
const nouns = () => NOUNS || (NOUNS = buildNouns());

// SAFE sets per NOT list: its own `safe` entries + every answer of the lists named in `safeFrom`, minus its curated answers
function buildSafe() {
  const m = new Map();
  for (const [name, l] of BLITZ_LISTS.LISTS) {
    if (l.mode !== 'not') continue;
    const s = new Set();
    for (const a of l.safe || []) s.add(BLITZ_LISTS.answerKey(a));
    for (const src of l.safeFrom || []) {
      const from = BLITZ_LISTS.listFor(src);
      if (from) for (const a of from.answers) s.add(BLITZ_LISTS.answerKey(a));
    }
    for (const k of l.keys) s.delete(k);
    s.delete('');
    m.set(name, s);
  }
  return m;
}
const safeSets = () => SAFE || (SAFE = buildSafe());

// cheap: just the flag on the list (no set building)
const isNotList = (category) => (BLITZ_LISTS.listFor(category) || {}).mode === 'not';

/**
 * Judge an answer that MISSED a NOT list's curated answers. → { ok, why, message? }
 * why: 'person' | 'noun' (ok) — 'safe_item' | 'blocked' | 'not_a_noun' (rejected)
 */
function judge(category, answer) {
  const l = BLITZ_LISTS.listFor(category);
  const safe = safeSets().get(category);
  if (!l || !safe) return { ok: false, why: 'not_a_noun' };
  const raw = String(answer == null ? '' : answer).trim().toLowerCase();
  const ws = words(raw);
  if (ws.length === 0) return { ok: false, why: 'not_a_noun' };
  if (isBlockedForDisplay(raw) || ws.some((w) => isBlockedForDisplay(w) || MILD.has(w))) return { ok: false, why: 'blocked' };
  const h = headOf(ws);
  if (!h) return { ok: false, why: 'not_a_noun' };
  // matched without the little words, so "a black suit" is the safe "black suit"
  const k = BLITZ_LISTS.answerKey(ws.filter((w) => !['a', 'an', 'the', 'my', 'your', 'some'].includes(w)).join(' '));
  const core = ws.filter((w) => !STOP.has(w));
  // the whole answer is safe ("leftover pizza" as typed), or it is one plain safe noun ("a mug", "soups")
  if (safe.has(k) || safe.has(fold(k)) || (core.length === 1 && (safe.has(core[0]) || safe.has(fold(core[0]))))) {
    return { ok: false, why: 'safe_item', message: l.safeMsg || null };
  }
  if (PEOPLE.has(h) || PEOPLE.has(ws[ws.length - 1])) return { ok: true, why: 'person' };
  if (nouns().has(fold(h))) return { ok: true, why: 'noun' };
  return { ok: false, why: 'not_a_noun' };
}

module.exports = {
  judge, isNotList, headOf,
  get NOUNS() { return nouns(); },
  get SAFE() { return safeSets(); },
};
